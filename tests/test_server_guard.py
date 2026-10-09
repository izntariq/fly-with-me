"""The server's request guard (flybrain/server.py host_guard): Host and Origin must name this machine. Called directly
on mocked requests (aiohttp.test_utils), so no port is opened and no brain is loaded. Kept to this stable, security-
relevant surface; the rest of the server is under active change."""
from __future__ import annotations

import logging
import unittest

try:
    from aiohttp import web
    from aiohttp.test_utils import make_mocked_request
    from flybrain import server
except ImportError:                       # aiohttp / numba missing
    server = None


async def ok(request):
    return web.Response(text="ok")


@unittest.skipIf(server is None, "aiohttp / flybrain.server not importable")
class HostGuard(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # refusals are logged as warnings: keep them out of the test output
        quiet = logging.NullHandler()
        logging.getLogger("flybrain").addHandler(quiet)
        self.addCleanup(logging.getLogger("flybrain").removeHandler, quiet)

    async def check(self, bind, host, origin=None):
        headers = {"Host": host} if host is not None else {}
        if origin is not None:
            headers["Origin"] = origin
        req = make_mocked_request("GET", "/ws", headers=headers)
        try:
            await server.host_guard(bind)(req, ok)
            return True
        except web.HTTPForbidden:
            return False

    async def test_localhost_binding(self):
        for host, origin in [("localhost:8765", None), ("127.0.0.1:8765", "http://localhost:8765"),
                             ("[::1]:8765", "http://[::1]:8765")]:
            with self.subTest(host=host, origin=origin):
                self.assertTrue(await self.check("127.0.0.1", host, origin))
        for host, origin in [(None, None),                                    # no Host
                             ("evil.example:8765", None),                     # DNS rebinding: the attacker's name
                             ("evil.example:8765", "http://evil.example:8765"),
                             ("192.168.1.5:8765", None),                      # an IP, but bound to localhost only
                             ("localhost:8765", "http://evil.example"),       # cross-site page
                             ("localhost:8765", "null"),                      # sandboxed / file:// page
                             ("user@localhost:8765", None),                   # userinfo trick
                             ("localhost:8765", "http://localhost@evil.example"),
                             ("[::1:8765", None)]:                            # malformed
            with self.subTest(host=host, origin=origin):
                self.assertFalse(await self.check("127.0.0.1", host, origin))

    async def test_lan_binding(self):
        self.assertTrue(await self.check("0.0.0.0", "192.168.1.5:8765"))
        self.assertTrue(await self.check("0.0.0.0", "192.168.1.5:8765", "http://192.168.1.5:8765"))
        self.assertFalse(await self.check("0.0.0.0", "192.168.1.5:8765", "http://192.168.1.9:8765"))
        self.assertFalse(await self.check("0.0.0.0", "mymac.local:8765"))
        self.assertTrue(await self.check("mymac.local", "mymac.local:8765", "http://mymac.local:8765"))


if __name__ == "__main__":
    unittest.main()
