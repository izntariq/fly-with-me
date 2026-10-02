"""Runs the fly brain in real time and streams it to the browser over a WebSocket.

    python -m flybrain.server            # then open http://localhost:8765

Browser -> server   {"type": "drive", "levels": {channel_name: 0..1, ...}, "levels2": {...}}   (levels2: fly 2)
                    {"type": "reset"}
Server  -> browser  {"type": "hello", ...}  once, describes inputs/outputs and how many flies
                    {"type": "frame", ...}  every FRAME_MS of brain time; "outs": one spike list per fly

With --flies 2 there is one listener fly per deck: each hears its own deck in both ears (how it was trained).
With --flies 3 a third, DJ fly is chained after them: it hears the listeners, not the music. Twelve DJ-relevant
descending neurons of listener A drive the 12 Johnston's-organ bands of its LEFT ear, listener B's its RIGHT ear, so
(ears being ~30x ipsilateral) its left brain weighs deck A, its right brain deck B. The browser plays the DJ fly.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path

import numpy as np
from aiohttp import WSMsgType, web

from .brain import Brain
from .mapping import brain_xy, brain_xyz, build_inputs, build_outputs, load_annotations

WEB = Path(__file__).resolve().parent.parent / "web"
FRAME_MS = 20.0
VIZ_MAX = 2400              # spikes per frame sent for the brain pictures (split between the flies)
RUNAWAY_SPIKES = 12_000     # per frame (= 600k spikes/s); seizure-like state -> reset
# listener neurons wired into the DJ fly's ears (both sides averaged), one per Johnston's-organ band: the trained
# section neurons first (SPACE DNp55, MIX DNge145/DNge113/DNp12, PEAK DNg24/DNg29), then other music-driven DNs
LISTENER_TAPS = ["DNp55", "DNge145", "DNge113", "DNp12", "DNg24", "DNg29", "DNp01", "DNp02", "DNg84", "DNp11",
                 "DNg99", "DNb05"]
TAP_FULL_HZ = 40.0          # a tapped neuron firing this fast drives its band fully
log = logging.getLogger("flybrain")


def _fly_worker(conn, trained_file, threads, kernel):
    """One fly in its own process: flies step in parallel instead of one after another."""
    import os as _os
    _os.environ["FLYBRAIN_THREADS"] = str(threads)
    b = Brain()
    b.event = kernel == "event"
    if trained_file:
        b.load_trained(trained_file)
    b.set_stim(np.zeros(1, np.int64), np.zeros(1)); b.run(1); b.reset()
    conn.send("ready")
    while True:
        msg = conn.recv()
        if msg[0] == "run":
            b.set_stim(msg[1], msg[2])
            conn.send(b.run(msg[3]))
        elif msg[0] == "reset":
            b.reset()
        elif msg[0] == "stop":
            return


class GPUFly:
    """One fly inside a GPUBrains batch (flybrain/gpu.py), with the Brain-like surface the server uses.
    MLX GPU streams belong to the thread that made them, so every GPU call goes through one dedicated thread."""
    def __init__(self, gpu, k, thread):
        self.gpu, self.k, self.thread = gpu, k, thread
    def set_stim(self, idx, rates):
        self.gpu.set_stim(self.k, idx, rates)          # plain numpy, safe from any thread
    def reset(self):
        self.thread.submit(self.gpu.reset, self.k).result()
    @property
    def t_ms(self):
        return self.gpu.step * self.gpu.p.dt


class RemoteFly:
    """A fly running in a worker process, with the same run/set_stim/reset/t_ms surface as Brain."""
    def __init__(self, trained_file, threads):
        import multiprocessing as mp
        ctx = mp.get_context("spawn")
        self.conn, child = ctx.Pipe()
        self.proc = ctx.Process(target=_fly_worker, args=(child, trained_file, threads,
                                os.environ.get("FLYBRAIN_KERNEL", "dense")), daemon=True)
        self.proc.start()
        assert self.conn.recv() == "ready"
        self._stim = (np.zeros(0, np.int64), np.zeros(0))
        self.step_ms = 0.0
    def set_stim(self, idx, rates):
        self._stim = (np.ascontiguousarray(idx, np.int64), np.ascontiguousarray(rates, np.float64))
    def start_run(self, ms):
        self.conn.send(("run", self._stim[0], self._stim[1], ms))
    def finish_run(self, ms):
        si, st = self.conn.recv()
        self.step_ms += ms
        return si, st
    def reset(self):
        self.conn.send(("reset",))
    @property
    def t_ms(self):
        return self.step_ms


class FlyServer:
    def __init__(self, brain_mode: str = "auto", flies: int = 1, parallel: bool = True, gpu: bool | None = None):
        t = time.time()
        self.brain = Brain()
        # a trained brain (python -m flybrain.train) is used when present, unless --brain naive
        self.trained = None
        trained_file = Path(__file__).resolve().parent.parent / "brains" / "trained_brain.npz"
        # the trained synapses are FlyWire's; another connectome (--connectome malecns) runs untouched
        self.connectome = os.environ.get("FLYBRAIN_CONNECTOME", "flywire")
        if self.connectome == "flywire" and (brain_mode == "trained" or (brain_mode == "auto" and trained_file.exists())):
            self.trained = self.brain.load_trained(trained_file)
            ro = trained_file.parent / "readout.json"      # which trained neurons signal which section (flybrain/readout)
            if ro.exists():
                self.trained["readout"] = json.loads(ro.read_text())
            log.info("trained brain: %d learned synapses (epoch %d)", self.trained["synapses"], self.trained["epoch"])
        # section sense v2 for the listener flies (tools/train_sections.py --export), for this brain
        sec = Path(__file__).resolve().parent.parent / "brains" / f"sections_{'trained' if self.trained else 'naive'}.json"
        self.sections = json.loads(sec.read_text()) if self.connectome == "flywire" and sec.exists() else None
        ann = load_annotations()
        self.inputs = build_inputs(ann, self.brain.id2idx)
        self.out_idx, self.out_meta = build_outputs(ann, self.brain.ids)
        self.xy = brain_xy(ann, self.brain.ids)
        self.xyz = brain_xyz(ann, self.brain.ids)
        # brain index -> output slot (-1 if not an output neuron)
        self.out_slot = np.full(self.brain.n, -1, np.int64)
        self.out_slot[self.out_idx] = np.arange(len(self.out_idx))
        # the flies run on the GPU (all together, flybrain/gpu.py) if MLX is available; otherwise in parallel CPU
        # worker processes, or (--serial) sharing this process's wiring and stepped in turn
        self.gpu, self.executor = None, None
        if gpu is not False:
            try:
                from concurrent.futures import ThreadPoolExecutor
                from .gpu import GPUBrains
                self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
                self.gpu = self.executor.submit(GPUBrains, flies, weights=self.brain.weights).result()
            except Exception as e:                      # no MLX / not Apple silicon
                if gpu:
                    raise
                self.gpu, self.executor = None, None
                log.info("GPU not available (%s); using the CPU", e)
        self.parallel = self.gpu is None and parallel and flies > 1
        if self.gpu is not None:
            self.brains = [GPUFly(self.gpu, k, self.executor) for k in range(flies)]
            log.info("%d flies on the GPU (MLX)", flies)
        elif self.parallel:
            tf = str(trained_file) if self.trained else None
            # live: the all-neurons kernel with 3 threads per fly measured best (load ~1.04 vs 1.16 event-driven)
            os.environ.setdefault("FLYBRAIN_KERNEL", "dense")
            per = 1 if os.environ["FLYBRAIN_KERNEL"] == "event" else 3
            self.brains = [RemoteFly(tf, per) for _ in range(flies)]
            log.info("%d flies in parallel processes, %d threads each", flies, per)
        else:
            self.brains = [self.brain] + [self.brain.sibling() for _ in range(max(0, flies - 1))]
        self.levels = [{c.name: 0.0 for c in self.inputs} for _ in self.brains]
        # DJ fly (3rd): which listener neurons feed which of its ear bands
        ear_bands = [c.name for c in self.inputs if c.name.startswith("earL:")]
        self.taps = []                                  # (band index, brain indices of that type)
        for i, typ in enumerate(LISTENER_TAPS[:len(ear_bands)]):
            ids = [x for x in ann.index[(ann.cell_type == typ) & (ann.super_class == "descending")] if x in self.brain.id2idx]
            self.taps.append((ear_bands[i].split(":")[1], np.array([self.brain.id2idx[x] for x in ids], np.int64)))
        self.tap_rate = np.zeros((2, len(self.taps)))  # smoothed tap rates for listeners A and B
        self.clients: set[web.WebSocketResponse] = set()
        self.runaway = [0] * len(self.brains)
        self.pokes = [[] for _ in self.brains]          # (neuron idx, Hz, until) stimulation from the visualiser
        if self.gpu is None and not self.parallel:
            self.brain.set_stim(np.zeros(1, np.int64), np.zeros(1))
            self.brain.run(1)  # JIT warm-up
            for b in self.brains:
                b.reset()
        log.info("brain ready: %d fly/flies x %d neurons, %d synaptic connections, %d inputs, %d outputs (%.1fs)",
                 len(self.brains), self.brain.n, len(self.brain.indices), len(self.inputs), len(self.out_idx),
                 time.time() - t)

    def hello(self) -> dict:
        return {
            "type": "hello",
            "trained": self.trained,
            "flies": len(self.brains),
            "connectome": self.connectome,
            "sections": self.sections,
            "dj_taps": [t for t, _ in self.taps] if len(self.brains) == 3 else None,
            "dj_tap_types": LISTENER_TAPS[:len(self.taps)] if len(self.brains) == 3 else None,
            "n_neurons": self.brain.n,
            "n_connections": int(len(self.brain.indices)),
            "frame_ms": FRAME_MS,
            "inputs": [{"name": c.name, "n": len(c.idx), "max_hz": c.max_hz, "desc": c.desc, "idx": c.idx.tolist(), **c.meta}
                       for c in self.inputs],
            "outputs": self.out_meta,
            "in_idx": np.unique(np.concatenate([c.idx for c in self.inputs])).tolist(),
            "out_idx": self.out_idx.tolist(),
        }

    def apply_drive(self, k: int = 0):
        idx, rates = [], []
        for c in self.inputs:
            lvl = float(self.levels[k].get(c.name, 0.0))
            if lvl > 0.001:
                idx.append(c.idx)
                rates.append(np.full(len(c.idx), min(lvl, 1.0) * c.max_hz))
        now = time.perf_counter()
        self.pokes[k] = [p for p in self.pokes[k] if p[2] > now]
        for pidx, hz, _ in self.pokes[k]:
            idx.append(pidx)
            rates.append(np.full(len(pidx), hz))
        b = self.brains[k]
        if idx:
            b.set_stim(np.concatenate(idx), np.concatenate(rates))
        else:
            b.set_stim(np.zeros(0, np.int64), np.zeros(0))

    def run_all(self):
        """step every fly one frame: all together on the GPU, in parallel processes, or one after another"""
        if self.gpu is not None:
            return self.gpu.run(FRAME_MS)
        if self.parallel:
            for b in self.brains:
                b.start_run(FRAME_MS)
            return [b.finish_run(FRAME_MS) for b in self.brains]
        return [b.run(FRAME_MS) for b in self.brains]

    async def loop(self):
        ex = asyncio.get_running_loop()
        clock = self.brains[0]          # the brain-time clock (fly 1)
        wall0, brain0 = time.perf_counter(), clock.t_ms
        while True:
            if not self.clients:
                await asyncio.sleep(0.1)
                wall0, brain0 = time.perf_counter(), clock.t_ms
                continue
            for k in range(len(self.brains)):
                self.apply_drive(k)             # fly 3's levels were set from the listeners last frame
            t_start = clock.t_ms
            c0 = time.perf_counter()
            results = await ex.run_in_executor(self.executor, self.run_all)
            cost = time.perf_counter() - c0

            reset = False
            outs, vizs, total = [], [], 0
            for k, (si, st) in enumerate(results):
                n_k = int(self.gpu.last_counts[k]) if self.gpu is not None else len(si)
                if n_k > RUNAWAY_SPIKES:
                    self.runaway[k] += 1
                    if self.runaway[k] >= 3:
                        self.brains[k].reset()
                        self.runaway[k] = 0
                        reset = True
                else:
                    self.runaway[k] = 0
                slots = self.out_slot[si]
                m = slots >= 0
                outs.append([[int(s), round(float(t - t_start), 2)] for s, t in zip(slots[m], st[m])])
                cap = VIZ_MAX // len(self.brains)
                vizs.append((si if len(si) <= cap else si[np.random.choice(len(si), cap, replace=False)]).tolist())
                total += int(self.gpu.last_counts[k]) if self.gpu is not None else len(si)
            if len(self.brains) == 3:
                # listeners -> DJ fly: smoothed (100 ms) rates of the tapped neurons become its ear drive
                for k in (0, 1):
                    si = results[k][0]
                    cnt = np.bincount(si, minlength=self.brain.n)
                    hz = np.array([cnt[idx].mean() * 1000 / FRAME_MS if len(idx) else 0.0 for _, idx in self.taps])
                    self.tap_rate[k] += (hz - self.tap_rate[k]) * (FRAME_MS / 100)
                for i, (band, _) in enumerate(self.taps):
                    self.levels[2][f"earL:{band}"] = min(1.0, self.tap_rate[0, i] / TAP_FULL_HZ)
                    self.levels[2][f"earR:{band}"] = min(1.0, self.tap_rate[1, i] / TAP_FULL_HZ)
            msg = json.dumps({
                "type": "frame", "t": round(t_start, 1), "n": int(total), "out": outs[0], "outs": outs,
                "viz": vizs[0], "vizs": vizs, "load": round(cost * 1000 / FRAME_MS, 2), "reset": reset,
            })
            await asyncio.gather(*(self._send(ws, msg) for ws in list(self.clients)))

            # keep brain time locked to wall time; if we fall behind, don't try to catch up
            ahead = (clock.t_ms - brain0) / 1000 - (time.perf_counter() - wall0)
            if ahead > 0:
                await asyncio.sleep(ahead)
            elif ahead < -0.25:
                wall0, brain0 = time.perf_counter(), clock.t_ms

    async def _send(self, ws, msg):
        try:
            await ws.send_str(msg)
        except Exception:
            self.clients.discard(ws)

    async def ws_handler(self, request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
        await ws.prepare(request)
        await ws.send_str(json.dumps(self.hello()))
        self.clients.add(ws)
        log.info("client connected (%d)", len(self.clients))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                d = json.loads(msg.data)
                if d.get("type") == "drive":
                    for fk, key in enumerate(("levels", "levels2", "levels3")[:len(self.brains)]):
                        for k, v in d.get(key, {}).items():
                            if fk == 2 and k.startswith("ear"):
                                continue                # the DJ fly's ears are wired to the listeners
                            if k in self.levels[fk]:
                                self.levels[fk][k] = max(0.0, min(1.0, float(v)))
                elif d.get("type") == "poke":
                    # stimulate a few neurons of one fly for a moment (the visualiser: click a neuron)
                    k = int(d.get("fly", 0))
                    idx = np.asarray(d.get("idx", [])[:64], np.int64)
                    idx = idx[(idx >= 0) & (idx < self.brain.n)]
                    if 0 <= k < len(self.brains) and len(idx):
                        hz = max(0.0, min(300.0, float(d.get("hz", 150))))
                        ms = max(0.0, min(3000.0, float(d.get("ms", 800))))
                        self.pokes[k].append((idx, hz, time.perf_counter() + ms / 1000))
                        log.info("poke: fly %d, %d neurons at %.0f Hz for %.0f ms", k + 1, len(idx), hz, ms)
                elif d.get("type") == "reset":
                    for b in self.brains:
                        b.reset()
        finally:
            self.clients.discard(ws)
            if not self.clients:
                self.levels = [{k: 0.0 for k in lv} for lv in self.levels]
            log.info("client disconnected (%d)", len(self.clients))
        return ws

    async def xy_handler(self, request):
        return web.Response(body=self.xy, content_type="application/octet-stream")

    async def xyz_handler(self, request):
        return web.Response(body=self.xyz, content_type="application/octet-stream")


def versioned_page(name: str) -> str:
    """The page with every script / stylesheet URL stamped with its file's modification time, plus an import map that
    does the same for every module they import, so a browser never runs a stale copy after an update."""
    html = (WEB / name).read_text()
    stamp = lambda rel: f"/{rel}?v={(WEB / rel).stat().st_mtime_ns}"
    html = re.sub(r'(src|href)="((?:js/[\w.-]+\.js)|(?:style\.css))"', lambda m: f'{m.group(1)}="{stamp(m.group(2))}"', html)
    imports = {f"/js/{p.name}": f"/js/{p.name}?v={p.stat().st_mtime_ns}" for p in sorted((WEB / "js").glob("*.js"))}
    return html.replace("</head>", f'<script type="importmap">{json.dumps({"imports": imports})}</script>\n</head>', 1)


async def page(request):
    name = request.match_info.get("name", "index") + ".html"
    return web.Response(text=versioned_page(name), content_type="text/html", headers={"Cache-Control": "no-store"})


async def no_stale(request, response):
    # everything else: the browser may cache it but must check it's current before using it
    if "Cache-Control" not in response.headers and response.status != 101:
        response.headers["Cache-Control"] = "no-cache"


def make_app(server: FlyServer) -> web.Application:
    app = web.Application()
    app.router.add_get("/", page)
    app.router.add_get("/{name:index|viz}.html", page)
    app.on_response_prepare.append(no_stale)
    app.router.add_get("/ws", server.ws_handler)
    app.router.add_get("/brain_xy.bin", server.xy_handler)
    app.router.add_get("/brain_xyz.bin", server.xyz_handler)
    app.router.add_static("/", WEB)

    async def start(app):
        app["loop_task"] = asyncio.create_task(server.loop())

    async def stop(app):
        app["loop_task"].cancel()

    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    return app


def main():
    ap = argparse.ArgumentParser(description="Fly brain DJ server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--flies", type=int, default=3, choices=[1, 2, 3],
                    help="3: a listener fly per deck + a DJ fly chained after them; 2: listeners only; "
                         "1: a single fly, deck A left ear / B right")
    ap.add_argument("--serial", action="store_true", help="step all flies in this process, one after another")
    ap.add_argument("--cpu", action="store_true", help="don't use the GPU even if MLX is available")
    ap.add_argument("--brain", choices=["auto", "trained", "naive"], default="auto",
                    help="auto: use brains/trained_brain.npz if it exists; naive: the untouched connectome")
    ap.add_argument("--connectome", choices=["flywire", "malecns"], default=None,
                    help="flywire: the FlyWire v783 brain (default); malecns: the whole male CNS, brain + nerve cord "
                         "(Janelia male-cns v1.0, downloaded on first use, ~1.1 GB)")
    args = ap.parse_args()
    if args.connectome:
        os.environ["FLYBRAIN_CONNECTOME"] = args.connectome
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    server = FlyServer(args.brain, args.flies, parallel=not args.serial, gpu=False if args.cpu else None)
    print(f"\n  Fly brain DJ -> http://{args.host}:{args.port}\n")
    web.run_app(make_app(server), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
