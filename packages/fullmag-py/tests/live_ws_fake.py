"""Minimal RFC 6455 server for live event-stream tests (``fullmag.live.v1``)."""
from __future__ import annotations

import base64
import hashlib
import json
import socket
import struct
import threading
from typing import Any, Optional
from urllib.parse import parse_qs, urlsplit

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class FakeEventServer:
    """Accepts WebSocket upgrades on ``/v2/sessions/current/events/ws`` and replays scripted events."""

    def __init__(self, events: list[dict[str, Any]], *, close_after: Optional[int] = None) -> None:
        self.events = events
        self.close_after = close_after
        self.connections: list[dict[str, Any]] = []
        self._sock = socket.socket()
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self._stop = False
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self.pong_received = threading.Event()

    @property
    def url(self) -> str:
        host, port = self._sock.getsockname()
        return f"http://{host}:{port}"

    def __enter__(self) -> "FakeEventServer":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop = True
        self._sock.close()

    def _serve(self) -> None:
        while not self._stop:
            try:
                client, _ = self._sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client: socket.socket) -> None:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = client.recv(4096)
            if not chunk:
                return
            data += chunk
        request_line, *lines = data.split(b"\r\n\r\n", 1)[0].decode().split("\r\n")
        headers = {line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip() for line in lines if ":" in line}
        path = request_line.split(" ")[1]
        query = {key: values[-1] for key, values in parse_qs(urlsplit(path).query).items()}
        self.connections.append({"path": urlsplit(path).path, "query": query, "protocol": headers.get("sec-websocket-protocol")})
        if headers.get("sec-websocket-protocol") != "fullmag.live.v1":
            client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            client.close()
            return
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + _GUID).encode()).digest()).decode()
        client.sendall(
            (
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: fullmag.live.v1\r\n\r\n"
            ).encode()
        )
        after = int(query["after_seq"]) if "after_seq" in query else None
        sent = 0
        self._send(client, 0x9, b"ping")
        for event in self.events:
            if after is not None and event["seq"] <= after:
                continue
            text = json.dumps(event).encode()
            if len(text) > 40:
                # Exercise fragmentation: first half as text, rest as continuation.
                half = len(text) // 2
                self._send(client, 0x1, text[:half], fin=False)
                self._send(client, 0x0, text[half:])
            else:
                self._send(client, 0x1, text)
            sent += 1
            if self.close_after is not None and sent >= self.close_after and after is None:
                self._send(client, 0x8, struct.pack("!H", 1001))
                client.close()
                return
        try:
            client.settimeout(5)
            while True:
                header = client.recv(2)
                if len(header) < 2:
                    break
                opcode, length = header[0] & 0x0F, header[1] & 0x7F
                mask = client.recv(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(client.recv(length)))
                if opcode == 0xA and payload == b"ping":
                    self.pong_received.set()
                if opcode == 0x8:
                    break
        except OSError:
            pass
        finally:
            client.close()

    @staticmethod
    def _send(client: socket.socket, opcode: int, payload: bytes, *, fin: bool = True) -> None:
        first = (0x80 if fin else 0) | opcode
        if len(payload) < 126:
            header = struct.pack("!BB", first, len(payload))
        else:
            header = struct.pack("!BBH", first, 126, len(payload))
        client.sendall(header + payload)


def event(kind: str, seq: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": kind, "seq": seq, "ts": "2026-10-22T00:00:00Z", "session_id": "s1", "contract_version": "v1", "payload": payload}
