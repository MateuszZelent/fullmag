#!/usr/bin/env python3
"""Bind-host-aware port probes shared by the local Control Room launchers."""

from __future__ import annotations

import socket
import sys
from argparse import ArgumentParser
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import zip_longest


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
    """Return whether a listener can bind host/port without a wildcard clash."""

    try:
        family, address = _bind_address(host, port)
    except OSError:
        return False

    addresses = [(family, address)]
    if host not in {"0.0.0.0", "::", ""}:
        # A wildcard listener owned by another instance also occupies a
        # loopback listener on Windows when the real server creates its
        # socket.  Probe the wildcard address as well; this avoids the
        # SO_REUSEADDR bind-only false positive.
        wildcard = "0.0.0.0" if family == socket.AF_INET else "::"
        try:
            wildcard_family, wildcard_address = _bind_address(wildcard, port)
            addresses.append((wildcard_family, wildcard_address))
        except OSError:
            return False
    for candidate_family, candidate_address in addresses:
        sock = socket.socket(candidate_family, socket.SOCK_STREAM)
        try:
            sock.bind(candidate_address)
            # A launcher creates a listening socket.  Binding alone can report
            # a false free result when another process owns a wildcard
            # listener but SO_REUSEADDR still permits a loopback bind probe.
            sock.listen(1)
        except OSError:
            return False
        finally:
            sock.close()
    return True


def _can_bind_pair(api_host: str, api_port: int, web_host: str, web_port: int) -> bool:
    """Probe both listeners while both probe sockets are held.

    Releasing these sockets before the caller starts its servers leaves the
    normal operating-system race window.  Callers that cannot pass listener
    handles into their children must therefore retry after a bind/start
    failure; this helper deliberately does not claim to reserve ports.
    """

    sockets: list[socket.socket] = []
    try:
        for host, port in ((api_host, api_port), (web_host, web_port)):
            family, address = _bind_address(host, port)
            addresses = [(family, address)]
            if host not in {"0.0.0.0", "::", ""}:
                wildcard = "0.0.0.0" if family == socket.AF_INET else "::"
                wildcard_family, wildcard_address = _bind_address(wildcard, port)
                # Probe the wider listener first, then release it before
                # holding the actual address.  Holding both would conflict
                # with a valid specific-host listener on an otherwise free
                # port.
                sock = socket.socket(wildcard_family, socket.SOCK_STREAM)
                try:
                    sock.bind(wildcard_address)
                    sock.listen(1)
                except OSError:
                    sock.close()
                    return False
                sock.close()
            for candidate_family, candidate_address in addresses:
                sock = socket.socket(candidate_family, socket.SOCK_STREAM)
                try:
                    sock.bind(candidate_address)
                    sock.listen(1)
                except OSError:
                    sock.close()
                    return False
                sockets.append(sock)
        return True
    except OSError:
        return False
    finally:
        for sock in sockets:
            sock.close()


def first_bindable_port(host: str, ports: Iterable[int]) -> int:
    """Return the first port bindable on ``host`` or raise a useful error."""

    candidates = tuple(ports)
    for port in candidates:
        if is_bindable(host, port):
            return port
    formatted = ", ".join(str(port) for port in candidates)
    raise RuntimeError(f"no free Control Room port for {host}: {formatted}")


@dataclass(frozen=True)
class PortPair:
    """The selected host-side listeners for one Fullmag instance."""

    api_port: int
    web_port: int


def first_bindable_pair(
    api_host: str,
    api_ports: Iterable[int],
    web_host: str,
    web_ports: Iterable[int],
) -> PortPair:
    """Pick a pair using the same candidate rank for both services.

    Keeping the candidate rank together is intentional: when either preferred
    listener is occupied, the caller receives a fresh API *and* UI pair rather
    than reusing the one port that happened to remain free.  The pair is
    checked with both sockets held, but the sockets are released before this
    function returns.  Process launchers must still verify the actual child
    listeners and retry on a race.
    """

    api_candidates = tuple(api_ports)
    web_candidates = tuple(web_ports)
    if not api_candidates or not web_candidates:
        raise RuntimeError("API and Control Room port candidates must not be empty")
    if any(not 1 <= int(port) <= 65535 for port in (*api_candidates, *web_candidates)):
        raise RuntimeError("API and Control Room ports must be between 1 and 65535")

    # Candidate lists normally have equal length.  zip_longest gives a clear
    # failure when a caller accidentally omits a paired fallback instead of
    # silently mixing an old API port with a new UI port.
    missing = object()
    for api_port, web_port in zip_longest(api_candidates, web_candidates, fillvalue=missing):
        if api_port is missing or web_port is missing:
            continue
        if api_port == web_port and api_host == web_host:
            continue
        if _can_bind_pair(api_host, int(api_port), web_host, int(web_port)):
            return PortPair(int(api_port), int(web_port))

    api_formatted = ", ".join(str(port) for port in api_candidates)
    web_formatted = ", ".join(str(port) for port in web_candidates)
    raise RuntimeError(
        f"no free Fullmag API/UI port pair for {api_host}/{web_host}: "
        f"API [{api_formatted}], UI [{web_formatted}]"
    )


def main(argv: list[str] | None = None) -> int:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "pick", "pair"))
    parser.add_argument("host", nargs="?")
    parser.add_argument("ports", nargs="*", type=int)
    parser.add_argument("--api-host", default="0.0.0.0")
    parser.add_argument("--web-host", default="0.0.0.0")
    parser.add_argument("--api-ports", nargs="+", type=int)
    parser.add_argument("--web-ports", nargs="+", type=int)
    parser.add_argument("--format", choices=("json", "shell"), default="json")
    args = parser.parse_args(argv)

    if args.action == "check":
        if args.host is None or not args.ports:
            parser.error("check requires HOST PORT")
        return 0 if is_bindable(args.host, args.ports[0]) else 1

    if args.action == "pair":
        if not args.api_ports or not args.web_ports:
            parser.error("pair requires --api-ports and --web-ports")
        try:
            pair = first_bindable_pair(
                args.api_host, args.api_ports, args.web_host, args.web_ports
            )
        except RuntimeError as error:
            print(error, file=sys.stderr)
            return 1
        if args.format == "shell":
            print(f"{pair.api_port} {pair.web_port}")
        else:
            print(f'{{"api_port": {pair.api_port}, "web_port": {pair.web_port}}}')
        return 0

    if args.host is None or not args.ports:
        parser.error("pick requires HOST PORT ...")

    try:
        print(first_bindable_port(args.host, args.ports))
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
