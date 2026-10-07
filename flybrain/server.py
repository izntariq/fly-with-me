"""Runs the fly brain in real time and streams it to the browser over a WebSocket.

    python -m flybrain.server            # then open http://localhost:8765

Browser -> server   {"type": "drive", "levels": {channel_name: 0..1, ...}, "levels2": {...}}   (levels2: fly 2)
                    {"type": "reset"}
Server  -> browser  {"type": "hello", ...}  once, describes inputs/outputs and how many flies
                    {"type": "frame", ...}  every FRAME_MS of brain time; "outs": one spike list per fly
GET  /analysis/<sha1>   200 the track's analysis; 202 {"status": "queued" | "indexing"}: ask again later;
                        404 unknown: upload it; 410 {"status": "failed"}: terminal, don't upload it again
POST /analysis/<sha1>   the audio file, analysed in the background: 202 queued; the GET answer if it needs no upload
                        (known, queued, indexing, failed); 400 hash mismatch; 413 over 400 MB; 503 no analyser installed

With --flies 2 there is one listener fly per deck: each hears its own deck in both ears (how it was trained).
With --flies 3 a third, DJ fly is chained after them: it hears the listeners, not the music. Twelve DJ-relevant
descending neurons of listener A drive the 12 Johnston's-organ bands of its LEFT ear, listener B's its RIGHT ear, so
(ears being ~30x ipsilateral) its left brain weighs deck A, its right brain deck B. The browser plays the DJ fly.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import ipaddress
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
import numpy as np
from aiohttp import WSMsgType, web

from .brain import Brain
from .mapping import brain_xy, brain_xyz, build_inputs, build_outputs, load_annotations

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
FRAME_MS = 20.0
VIZ_MAX = 2400              # spikes per frame sent for the brain pictures (split between the flies)
RUNAWAY_SPIKES = 12_000     # per frame (= 600k spikes/s); seizure-like state -> reset
# listener neurons wired into the DJ fly's ears (both sides averaged), one per Johnston's-organ band: the trained
# section neurons first (SPACE DNp55, MIX DNge145/DNge113/DNp12, PEAK DNg24/DNg29), then other music-driven DNs
LISTENER_TAPS = ["DNp55", "DNge145", "DNge113", "DNp12", "DNg24", "DNg29", "DNp01", "DNp02", "DNg84", "DNp11",
                 "DNg99", "DNb05"]
TAP_FULL_HZ = 40.0          # a tapped neuron firing this fast drives its band fully
SEND_QUEUE = 4              # frames waiting for one client; a client further behind loses its oldest frames
# a dropped track uploaded for analysis. The analyser takes tracks up to 20 min, and 20 min of 24-bit 48 kHz stereo WAV
# is ~350 MB, so the cap stays at 400 MB. Uploads stream to disk, so it bounds disk use, not memory
MAX_UPLOAD = 400 * 1024 * 1024
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
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
                self.executor.submit(self.gpu.run, 1.25).result()          # compile the Metal kernels now, not mid-set
                self.executor.submit(self.gpu.reset).result()
            except Exception as e:                      # no MLX / not Apple silicon
                if gpu:
                    raise
                self.gpu, self.executor = None, None
                log.warning("GPU not available (%s); using the CPU", e, exc_info=not isinstance(e, ImportError))
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
        self.clients: dict[web.WebSocketResponse, asyncio.Queue] = {}     # each client's outgoing frames
        self.driver = None                              # the client that last sent "drive"
        self.reset_pending = False                      # a page asked for a reset; done between frames
        self.runaway = [0] * len(self.brains)
        self.pokes = [[] for _ in self.brains]
        self.analyses = Analyses()          # (neuron idx, Hz, until) stimulation from the visualiser
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
        """Run the brain forever. A failing frame (a worker that died, a GPU error) is logged and retried, instead of
        silently stopping every frame while the page stays up."""
        failures = 0
        while True:
            try:
                await self._run_loop()
            except asyncio.CancelledError:
                raise
            except Exception:
                failures += 1
                log.exception("brain loop failed (%d); restarting it in 1 s", failures)
                await asyncio.sleep(1.0)

    async def _run_loop(self):
        ex = asyncio.get_running_loop()
        clock = self.brains[0]          # the brain-time clock (fly 1)
        wall0, brain0 = time.perf_counter(), clock.t_ms
        while True:
            if not self.clients:
                await asyncio.sleep(0.1)
                wall0, brain0 = time.perf_counter(), clock.t_ms
                continue
            if self.reset_pending:
                # here, between runs: resetting from the websocket handler could land in the middle of a serial-mode
                # run (it steps the same arrays in a worker thread) or interleave with a worker's pipe traffic
                self.reset_pending = False
                for b in self.brains:
                    b.reset()
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
            # each client's own sender task takes it from there: one that stops reading (a paused tab, a debugger)
            # can't hold up the brain, it just misses frames
            for q in self.clients.values():
                if q.full():
                    q.get_nowait()
                q.put_nowait(msg)

            # keep brain time locked to wall time; if we fall behind, don't try to catch up
            ahead = (clock.t_ms - brain0) / 1000 - (time.perf_counter() - wall0)
            if ahead > 0:
                await asyncio.sleep(ahead)
            elif ahead < -0.25:
                wall0, brain0 = time.perf_counter(), clock.t_ms

    async def _sender(self, ws, q):
        """One client's frames, sent in order; only this task waits when its socket backs up."""
        try:
            while True:
                await ws.send_str(await q.get())
        except Exception:                               # the socket is gone: stop queueing for it
            self.clients.pop(ws, None)

    async def ws_handler(self, request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
        await ws.prepare(request)
        await ws.send_str(json.dumps(self.hello()))
        q = asyncio.Queue(SEND_QUEUE)
        sender = asyncio.create_task(self._sender(ws, q))
        self.clients[ws] = q
        log.info("client connected (%d)", len(self.clients))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                d = json.loads(msg.data)
                if d.get("type") == "drive":
                    self.driver = ws
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
                    if 0 <= k < len(self.brains) and len(idx) and len(self.pokes[k]) < 16:
                        hz = max(0.0, min(300.0, float(d.get("hz", 150))))
                        ms = max(0.0, min(3000.0, float(d.get("ms", 800))))
                        self.pokes[k].append((idx, hz, time.perf_counter() + ms / 1000))
                        log.info("poke: fly %d, %d neurons at %.0f Hz for %.0f ms", k + 1, len(idx), hz, ms)
                elif d.get("type") == "reset":
                    self.reset_pending = True
        finally:
            sender.cancel()
            self.clients.pop(ws, None)
            if ws is self.driver or not self.clients:
                # the page that drove the flies has gone: they stop hearing its last spectrum, even while the
                # visualiser stays connected
                self.levels = [{k: 0.0 for k in lv} for lv in self.levels]
                self.driver = None
            log.info("client disconnected (%d)", len(self.clients))
        return ws

    async def xy_handler(self, request):
        return web.Response(body=self.xy, content_type="application/octet-stream")

    async def analysis_get(self, request):
        a = self.analyses.get(request.match_info["sha"])
        if a is None:
            raise web.HTTPNotFound()
        if a == "failed":                                  # terminal: the page shouldn't upload it again
            return web.json_response({"status": a}, status=410)
        if a in ("queued", "indexing"):                    # indexing: the library isn't hashed yet, ask again shortly
            return web.json_response({"status": a}, status=202)
        return web.json_response(a)

    async def analysis_post(self, request):
        sha, an = request.match_info["sha"], self.analyses
        if not an.py.exists():                             # nothing could analyse it: don't take the upload at all
            raise web.HTTPServiceUnavailable(text="no track analyser installed")
        if not an.submit(sha):                             # known, queued, failed or still indexing: no upload needed
            return await self.analysis_get(request)
        ext = "." + (re.sub(r"[^a-z0-9]", "", (request.headers.get("X-Ext") or "").lower())[:5] or "mp3")
        tmp, f, ok = an.up / f"{sha}.part", None, False
        try:
            if (request.content_length or 0) > MAX_UPLOAD:
                raise web.HTTPRequestEntityTooLarge(MAX_UPLOAD, request.content_length)
            # hashed and written a few MB at a time in a worker thread: on the event loop a 100-400 MB WAV stops the
            # frames for half a second, and whole uploads held in memory add up when a batch of files is dropped
            an.up.mkdir(parents=True, exist_ok=True)
            f, h, size, pend, held = open(tmp, "wb"), hashlib.sha1(), 0, [], 0
            try:
                async for chunk in request.content.iter_any():
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise web.HTTPRequestEntityTooLarge(MAX_UPLOAD, size)
                    pend.append(chunk)
                    held += len(chunk)
                    if held >= 1 << 22:
                        await asyncio.to_thread(_feed, f, h, pend)
                        pend, held = [], 0
            except (ConnectionResetError, aiohttp.ClientPayloadError):
                # the page went away mid-upload (a reload, a closed tab): normal, not an error with a traceback
                log.info("upload of %s cut off by the page", sha[:10])
                return web.Response(status=499)
            await asyncio.to_thread(_feed, f, h, pend)
            await asyncio.to_thread(f.close)
            if h.hexdigest() != sha:
                raise web.HTTPBadRequest(text="hash mismatch")
            path = an.up / f"{sha}{ext}"
            os.replace(tmp, path)
            an.start(sha, path)
            ok = True
        finally:
            if f is not None:
                f.close()
            if not ok:                                     # refused or cut off: the next upload may try again
                tmp.unlink(missing_ok=True)
                an.busy.discard(sha)
        return web.json_response({"status": "queued"}, status=202)

    async def xyz_handler(self, request):
        return web.Response(body=self.xyz, content_type="application/octet-stream")


class Analyses:
    """Beat grid and song structure for tracks the app plays: All-In-One results (tools/label_queue.py) for the user's
    library, found by the audio file's SHA-1, plus a gentle background queue that analyses unknown dropped files
    (one at a time, 4 threads, background priority) if the analyzer's environment (.venv-allin1) is installed."""

    def __init__(self):
        self.lib = ROOT / "data" / "realtracks"
        self.up = ROOT / "data" / "uploads"
        self.index_file = self.lib / "hash_index.json"
        self.index = json.loads(self.index_file.read_text()) if self.index_file.exists() else {}
        self.busy = set()
        self.indexing = True
        self.py = ROOT / ".venv-allin1" / "bin" / "python"
        self.idx_lock = threading.Lock()                  # the index (brief)
        self.run_lock = threading.Lock()                  # one analysis at a time (minutes)
        self._sweep()
        threading.Thread(target=self._index_library, daemon=True).start()

    def _sweep(self):
        # a server stopped mid-upload leaves <sha>.part, and one stopped with uploads waiting for their turn leaves
        # their audio. Only stale ones go (over 6 h old: no run takes over 15 min), since a second server (tests, on
        # another port) shares this folder and may be mid-upload itself
        if not self.up.exists():
            return
        cutoff = time.time() - 6 * 3600
        for p in self.up.iterdir():
            if p.is_file() and p.suffix not in (".json", ".failed") and p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)

    def _index_library(self):
        try:
            known = set(self.index.values())
            files = {}                                    # slug -> file: two different files must not share a slug
            for f in ("tracks.json", "tracks_more.json"):
                p = self.lib / f
                if not p.exists():
                    continue
                for t in json.loads(p.read_text()):
                    if files.setdefault(t["slug"], t["file"]) != t["file"]:
                        log.warning("track analyses: %s and %s share the slug %s; the second is left unindexed", files[t["slug"]], t["file"], t["slug"])
                        continue
                    if t["slug"] in known or not Path(t["file"]).exists():
                        continue
                    h = hashlib.sha1(Path(t["file"]).read_bytes()).hexdigest()
                    with self.idx_lock:
                        self.index[h] = t["slug"]
            with self.idx_lock:
                tmp = self.index_file.with_suffix(".tmp")
                tmp.write_text(json.dumps(self.index))
                os.replace(tmp, self.index_file)          # atomic: a crash mid-write can't leave half an index
        finally:
            self.indexing = False
        log.info("track analyses: %d library tracks indexed", len(self.index))

    @staticmethod
    def _read(p: Path):
        try:
            a = json.loads(p.read_text())
        except (OSError, ValueError):                     # missing, or cut short by a run that died writing it
            return None
        return {k: a.get(k) for k in ("bpm", "beats", "downbeats", "segments")} if isinstance(a, dict) else None

    def get(self, sha: str):
        """The analysis, or "queued" / "indexing" (ask again), "failed" (terminal), None (unknown: upload it)."""
        slug = self.index.get(sha)
        if slug and (a := self._read(self.lib / "allin1" / f"{slug}.json")):
            return a
        if sha in self.busy:                              # until its run has ended, its result may be half-written
            return "queued"
        if a := self._read(self.up / f"{sha}.json"):
            return a
        if (self.up / f"{sha}.failed").exists():
            return "failed"
        return "indexing" if self.indexing else None

    def submit(self, sha: str) -> bool:
        """Claim sha for analysis; the caller then stores the upload and calls start(), or drops it from busy. Refused
        with no analyser, or when sha is known, queued, failed before (never retried) or the library is indexing."""
        if not self.py.exists() or self.get(sha) is not None:
            return False
        self.busy.add(sha)
        return True

    def start(self, sha: str, path: Path):
        threading.Thread(target=self._analyse, args=(sha, path), daemon=True).start()

    def _analyse(self, sha: str, path: Path):
        out, why, killed = self.up / f"{sha}.json", "crashed", False
        try:
            try:
                with self.run_lock:                       # one analysis at a time
                    try:
                        r = subprocess.run(["nice", "-n", "12", str(self.py), str(ROOT / "tools" / "label_one.py"),
                                            str(path), str(self.up)], capture_output=True, timeout=15 * 60)
                        why = r.stderr.decode(errors="replace").strip()[-2000:] or f"exit code {r.returncode}"
                        # killed by a signal: Ctrl-C on the server reaches the analyser too (same process group), and
                        # macOS kills under memory pressure. Not the track's fault, so not marked failed for good
                        killed = r.returncode < 0
                    except subprocess.TimeoutExpired:
                        why = "timed out after 15 min"
                    except OSError as e:
                        why = f"could not start the analyser: {e}"
                    finally:
                        # the audio was only needed for this. label_one runs All-In-One in self.up, which keeps the
                        # stems (demix/htdemucs/<stem>/) and spectrogram (spec/<stem>.npy) if it dies or is killed
                        path.unlink(missing_ok=True)
                        shutil.rmtree(self.up / "demix" / "htdemucs" / path.stem, ignore_errors=True)
                        (self.up / "spec" / f"{path.stem}.npy").unlink(missing_ok=True)
                        for d in ("demix/htdemucs", "demix", "spec"):
                            with contextlib.suppress(OSError):
                                (self.up / d).rmdir()     # only if empty
            finally:
                ok = self._read(out) is not None
                if not ok and not killed:
                    # terminal: GET answers 410 and it is never analysed again (delete the marker to retry)
                    out.unlink(missing_ok=True)
                    (self.up / f"{sha}.failed").write_text(why + "\n")
        finally:
            self.busy.discard(sha)
        log.info("track analysis %s: %s", sha[:10], "done" if ok else "stopped" if killed else f"failed ({why.splitlines()[-1]})")


def _feed(f, h, chunks):
    for c in chunks:
        h.update(c)
        f.write(c)


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


def _hostname(value: str | None) -> str | None:
    """The host name in a Host header ("localhost:8765", "[::1]:8765") or an Origin ("http://localhost:8765")."""
    if not value or "@" in value:
        return None
    try:
        return urlparse(value if "://" in value else "//" + value).hostname
    except ValueError:                                     # e.g. an unclosed [IPv6 bracket
        return None


def host_guard(host: str):
    """Requests must name this machine in Host, and in Origin when a page sends one. Comparing Origin with Host alone
    isn't enough: a page on another site whose name is re-pointed at 127.0.0.1 (DNS rebinding) sends its own name in
    both. Bound to every interface, Host may also be any IP address (a page can't rebind an IP literal), so a phone can
    use http://<this Mac's IP>:8765; reaching it by a name (mymac.local) needs --host <that name>."""
    own = host.strip("[]").lower()
    anywhere = own in ("", "0.0.0.0", "::")

    def allowed(name):
        if name is None:
            return False
        if name in LOCAL_HOSTS or name == own:
            return True
        try:
            ipaddress.ip_address(name)
        except ValueError:
            return False
        return anywhere

    # the page's Origin: this machine by name, or the very host the request went to (a phone on http://192.168.1.5:8765
    # sends that in both). Never just "any IP": bound to every interface, a page served from some other IP address
    # could otherwise open ws://127.0.0.1:8765 (websockets have no CORS)
    def origin_ok(name, hostname):
        return name is not None and (name in LOCAL_HOSTS or name == own or name == hostname)

    @web.middleware
    async def guard(request, handler):
        h, origin = request.headers.get("Host"), request.headers.get("Origin")
        hn = _hostname(h)
        if not allowed(hn) or (origin is not None and not origin_ok(_hostname(origin), hn)):
            log.warning("refused %s %s (Host %s, Origin %s)", request.method, request.path, h, origin)
            raise web.HTTPForbidden()
        return await handler(request)
    return guard


def make_app(server: FlyServer, host: str = "127.0.0.1") -> web.Application:
    # every route: the websocket drives and pokes the flies and streams them, /analysis takes uploads
    app = web.Application(middlewares=[host_guard(host)])
    app.router.add_get("/", page)
    app.router.add_get("/{name:index|viz}.html", page)
    app.on_response_prepare.append(no_stale)
    app.router.add_get("/ws", server.ws_handler)
    app.router.add_get("/brain_xy.bin", server.xy_handler)
    app.router.add_get("/brain_xyz.bin", server.xyz_handler)
    app.router.add_get("/analysis/{sha:[0-9a-f]{40}}", server.analysis_get)
    app.router.add_post("/analysis/{sha:[0-9a-f]{40}}", server.analysis_post)
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
    web.run_app(make_app(server, args.host), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
