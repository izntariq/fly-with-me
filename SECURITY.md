# Security

Fly With Me runs a local web server (`flybrain/server.py`) that your browser talks to. By default it listens on
127.0.0.1 only and refuses requests that don't name this machine; LAN mode (`--host`) adds a start-up token. The
README's [Security and LAN mode](README.md#security-and-lan-mode) section describes what is and isn't protected.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on
https://github.com/izntariq/fly-with-me (a private security advisory). Don't open a public issue for it.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an answer within a
week. Fixes go into the next release, and you'll be credited in the changelog unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## In scope

- the server: request handling, the Host / Origin / token checks, uploads, the websocket
- anything that lets a web page, or another device on the network, reach the server without permission
- the setup scripts (`run.sh`, `scripts/`) downloading or running something they shouldn't

Out of scope: running the server in LAN mode on a network you don't trust (its traffic is plain HTTP, as documented),
and the third-party packages themselves (report those upstream).
