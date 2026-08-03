#!/usr/bin/env python3
"""Bind-host-aware port probes shared by the local Control Room launchers."""

from __future__ import annotations

import socket
import sys
from argparse import ArgumentParser
from collections.abc import Iterable


def _bind_address(host: str, port: int) -> tuple[int, tuple[object, ...]]:
    """Resolve a launcher hostname to the address family Node will bind."""

    addresses = socket.getaddrinfo(
        host,
        port,
        type=socket.SOCK_STREAM,
        flags=socket.AI_PASSIVE,
    )
    if not addresses:
        raise OSError(f"could not resolve bind host {host!r}")
    family, _, _, _, address = addresses[0]
    return family, address


def is_bindable(host: str, port: int) -> bool:
    """Return whether a listener can bind the exact host/port pair."""

    try:
        family, address = _bind_address(host, port)
    except OSError:
        return False

    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.bind(address)
    except OSError:
        return False
    finally:
        sock.close()
    return True


def first_bindable_port(host: str, ports: Iterable[int]) -> int:
    """Return the first port bindable on ``host`` or raise a useful error."""

    candidates = tuple(ports)
    for port in candidates:
        if is_bindable(host, port):
            return port
    formatted = ", ".join(str(port) for port in candidates)
    raise RuntimeError(f"no free Control Room port for {host}: {formatted}")


def main(argv: list[str] | None = None) -> int:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "pick"))
    parser.add_argument("host")
    parser.add_argument("ports", nargs="+", type=int)
    args = parser.parse_args(argv)

    if args.action == "check":
        return 0 if is_bindable(args.host, args.ports[0]) else 1

    try:
        print(first_bindable_port(args.host, args.ports))
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
