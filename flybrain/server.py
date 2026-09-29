"""Runs the fly brain in real time and streams it to the browser over a WebSocket.

    python -m flybrain.server            # then open http://localhost:8765

Browser -> server   {"type": "drive", "levels": {channel_name: 0..1, ...}}
                    {"type": "reset"}
Server  -> browser  {"type": "hello", ...}  once, describes inputs/outputs
                    {"type": "frame", ...}  every FRAME_MS of brain time
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from pathlib import Path

import numpy as np
from aiohttp import WSMsgType, web

from .brain import Brain
from .mapping import brain_xy, build_inputs, build_outputs, load_annotations

WEB = Path(__file__).resolve().parent.parent / "web"
FRAME_MS = 20.0
VIZ_MAX = 1500              # spikes per frame sent for the brain picture
RUNAWAY_SPIKES = 12_000     # per frame (= 600k spikes/s); seizure-like state -> reset
log = logging.getLogger("flybrain")


class FlyServer:
    def __init__(self):
        t = time.time()
        self.brain = Brain()
        ann = load_annotations()
        self.inputs = build_inputs(ann, self.brain.id2idx)
        self.out_idx, self.out_meta = build_outputs(ann, self.brain.ids)
        self.xy = brain_xy(ann, self.brain.ids)
        # brain index -> output slot (-1 if not an output neuron)
        self.out_slot = np.full(self.brain.n, -1, np.int64)
        self.out_slot[self.out_idx] = np.arange(len(self.out_idx))
        self.levels = {c.name: 0.0 for c in self.inputs}
        self.clients: set[web.WebSocketResponse] = set()
        self.runaway = 0
        self.brain.set_stim(np.zeros(1, np.int64), np.zeros(1))
        self.brain.run(1)  # JIT warm-up
        self.brain.reset()
        log.info("brain ready: %d neurons, %d synaptic connections, %d inputs, %d outputs (%.1fs)",
                 self.brain.n, len(self.brain.indices), len(self.inputs), len(self.out_idx), time.time() - t)

    def hello(self) -> dict:
        return {
            "type": "hello",
            "n_neurons": self.brain.n,
            "n_connections": int(len(self.brain.indices)),
            "frame_ms": FRAME_MS,
            "inputs": [{"name": c.name, "n": len(c.idx), "max_hz": c.max_hz, "desc": c.desc, **c.meta}
                       for c in self.inputs],
            "outputs": self.out_meta,
            "in_idx": np.unique(np.concatenate([c.idx for c in self.inputs])).tolist(),
            "out_idx": self.out_idx.tolist(),
        }

    def apply_drive(self):
        idx, rates = [], []
        for c in self.inputs:
            lvl = float(self.levels.get(c.name, 0.0))
            if lvl > 0.001:
                idx.append(c.idx)
                rates.append(np.full(len(c.idx), min(lvl, 1.0) * c.max_hz))
        if idx:
            self.brain.set_stim(np.concatenate(idx), np.concatenate(rates))
        else:
            self.brain.set_stim(np.zeros(0, np.int64), np.zeros(0))

    async def loop(self):
        ex = asyncio.get_running_loop()
        wall0, brain0 = time.perf_counter(), self.brain.t_ms
        while True:
            if not self.clients:
                await asyncio.sleep(0.1)
                wall0, brain0 = time.perf_counter(), self.brain.t_ms
                continue
            self.apply_drive()
            t_start = self.brain.t_ms
            c0 = time.perf_counter()
            si, st = await ex.run_in_executor(None, self.brain.run, FRAME_MS)
            cost = time.perf_counter() - c0

            reset = False
            if len(si) > RUNAWAY_SPIKES:
                self.runaway += 1
                if self.runaway >= 3:
                    self.brain.reset()
                    self.runaway = 0
                    reset = True
            else:
                self.runaway = 0

            slots = self.out_slot[si]
            m = slots >= 0
            out = [[int(s), round(float(t - t_start), 2)] for s, t in zip(slots[m], st[m])]
            viz = si if len(si) <= VIZ_MAX else si[np.random.choice(len(si), VIZ_MAX, replace=False)]
            msg = json.dumps({
                "type": "frame", "t": round(t_start, 1), "n": int(len(si)), "out": out,
                "viz": viz.tolist(), "load": round(cost * 1000 / FRAME_MS, 2), "reset": reset,
            })
            await asyncio.gather(*(self._send(ws, msg) for ws in list(self.clients)))

            # keep brain time locked to wall time; if we fall behind, don't try to catch up
            ahead = (self.brain.t_ms - brain0) / 1000 - (time.perf_counter() - wall0)
            if ahead > 0:
                await asyncio.sleep(ahead)
            elif ahead < -0.25:
                wall0, brain0 = time.perf_counter(), self.brain.t_ms

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
                    for k, v in d.get("levels", {}).items():
                        if k in self.levels:
                            self.levels[k] = max(0.0, min(1.0, float(v)))
                elif d.get("type") == "reset":
                    self.brain.reset()
        finally:
            self.clients.discard(ws)
            if not self.clients:
                self.levels = {k: 0.0 for k in self.levels}
            log.info("client disconnected (%d)", len(self.clients))
        return ws

    async def xy_handler(self, request):
        return web.Response(body=self.xy, content_type="application/octet-stream")


async def index(request):
    return web.FileResponse(WEB / "index.html")


def make_app(server: FlyServer) -> web.Application:
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", server.ws_handler)
    app.router.add_get("/brain_xy.bin", server.xy_handler)
    app.router.add_static("/", WEB)

    async def start(app):
        app["loop_task"] = asyncio.create_task(server.loop())

    async def stop(app):
        app["loop_task"].cancel()

    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    return app


def main():
    ap = argparse.ArgumentParser(description="Fly With Me: fly brain server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    server = FlyServer()
    print(f"\n  Fly With Me -> http://{args.host}:{args.port}\n")
    web.run_app(make_app(server), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
