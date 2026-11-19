"""Realtime event stream of a live session (spec python-live-client-v1 §7).

A minimal RFC 6455 client on the standard library reads the notify-only
``fullmag.live.v1`` channel (``/v2/sessions/current/events/ws``).  Events are
dispatched to subscribers from one background thread; a dropped connection is
resumed with ``after_seq`` and ``resync.required`` clears the cursor.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import socket
import ssl
import struct
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

__all__ = ["EventStream", "LiveEvent", "Subscription", "WebSocketConnection", "WebSocketError"]

SUBPROTOCOL = "fullmag.live.v1"
EVENTS_PATH = "/v2/sessions/current/events/ws"
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_LOG = logging.getLogger("fullmag.client.events")
_MAX_FRAME = 64 * 1024 * 1024


class WebSocketError(ConnectionError):
    """The WebSocket handshake or framing failed."""


@dataclass(frozen=True)
class LiveEvent:
    type: str
    seq: int
    payload: Mapping[str, Any]
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, document: Mapping[str, Any]) -> "LiveEvent":
        return cls(
            type=str(document.get("type", "")),
            seq=int(document.get("seq", 0)),
            payload=document.get("payload") or {},
            session_id=document.get("session_id"),
            run_id=document.get("run_id"),
            raw=document,
        )

    def changed_resources(self) -> set[str]:
        if self.type != "resource.batch_changed":
            return set()
        return {str(change.get("resource")) for change in self.payload.get("changes", [])}


class WebSocketConnection:
    """Client side of one WebSocket connection (text/binary/ping/pong/close)."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._buffer = b""
        self._send_lock = threading.Lock()

    @classmethod
    def connect(cls, base_url: str, path: str, *, subprotocol: str, timeout: float, headers: Optional[Mapping[str, str]] = None) -> "WebSocketConnection":
        parsed = urllib.parse.urlsplit(base_url)
        secure = parsed.scheme == "https"
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if secure else 80)
        raw = socket.create_connection((host, port), timeout=timeout)
        sock: socket.socket = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if secure else raw
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        target = parsed.path.rstrip("/") + path
        lines = [
            f"GET {target} HTTP/1.1",
            f"Host: {parsed.netloc}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            f"Sec-WebSocket-Protocol: {subprotocol}",
            "User-Agent: fullmag-python-live-client/1",
        ]
        for name, value in (headers or {}).items():
            lines.append(f"{name}: {value}")
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
        connection = cls(sock)
        head = connection._read_until(b"\r\n\r\n", limit=64 * 1024)
        status_line, *header_lines = head.decode("iso-8859-1").split("\r\n")
        parts = status_line.split(" ", 2)
        if len(parts) < 2 or parts[1] != "101":
            sock.close()
            raise WebSocketError(f"WebSocket upgrade refused: {status_line}")
        response_headers = {}
        for line in header_lines:
            if ":" in line:
                name, value = line.split(":", 1)
                response_headers[name.strip().lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode("ascii")).digest()).decode("ascii")
        if response_headers.get("sec-websocket-accept") != expected:
            sock.close()
            raise WebSocketError("WebSocket upgrade returned a wrong Sec-WebSocket-Accept")
        if response_headers.get("sec-websocket-protocol") != subprotocol:
            sock.close()
            raise WebSocketError(f"server did not select subprotocol {subprotocol}")
        return connection

    def settimeout(self, timeout: Optional[float]) -> None:
        self._sock.settimeout(timeout)

    def recv_message(self) -> tuple[int, bytes]:
        """Return the next complete text (1) or binary (2) message; answer pings."""
        message_opcode: Optional[int] = None
        chunks: list[bytes] = []
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                try:
                    self._send_frame(0x8, payload[:2])
                finally:
                    self.close()
                raise WebSocketError(f"WebSocket closed by server (code {code})")
            if opcode in (0x1, 0x2):
                if message_opcode is not None:
                    raise WebSocketError("new data frame inside a fragmented message")
                message_opcode = opcode
            elif opcode == 0x0:
                if message_opcode is None:
                    raise WebSocketError("continuation frame without a message")
            else:
                raise WebSocketError(f"unsupported WebSocket opcode {opcode}")
            chunks.append(payload)
            if fin:
                return message_opcode, b"".join(chunks)

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass

    def send_close(self) -> None:
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except OSError:
            pass
        self.close()

    # ---- framing ----------------------------------------------------------

    def _read_exact(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self._sock.recv(max(65536, count - len(self._buffer)))
            if not chunk:
                raise WebSocketError("WebSocket connection closed")
            self._buffer += chunk
        data, self._buffer = self._buffer[:count], self._buffer[count:]
        return data

    def _read_until(self, marker: bytes, *, limit: int) -> bytes:
        while marker not in self._buffer:
            if len(self._buffer) > limit:
                raise WebSocketError("WebSocket handshake response too large")
            chunk = self._sock.recv(4096)
            if not chunk:
                raise WebSocketError("connection closed during WebSocket handshake")
            self._buffer += chunk
        head, self._buffer = self._buffer.split(marker, 1)
        return head

    def _read_frame(self) -> tuple[bool, int, bytes]:
        first, second = self._read_exact(2)
        if first & 0x70:
            raise WebSocketError("reserved WebSocket bits set")
        fin, opcode = bool(first & 0x80), first & 0x0F
        if second & 0x80:
            raise WebSocketError("server frames must not be masked")
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        if length > _MAX_FRAME:
            raise WebSocketError(f"WebSocket frame of {length} bytes exceeds the limit")
        return fin, opcode, self._read_exact(length)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | length)
        elif length < 1 << 16:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        with self._send_lock:
            self._sock.sendall(header + mask + masked)


@dataclass
class Subscription:
    stream: "EventStream"
    event_type: str
    callback: Callable[[LiveEvent], None]

    def cancel(self) -> None:
        self.stream._unsubscribe(self)


class EventStream:
    """Background reader of the session's realtime events."""

    def __init__(self, base_url: str, *, connect_timeout: float = 10.0, reconnect_max_s: float = 5.0) -> None:
        self.base_url = base_url
        self.connect_timeout = connect_timeout
        self.reconnect_max_s = reconnect_max_s
        self.last_seq: Optional[int] = None
        self.hello: Optional[LiveEvent] = None
        self._subscriptions: list[Subscription] = []
        self._lock = threading.Lock()
        self._changed = threading.Condition()
        self._generation = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._connection: Optional[WebSocketConnection] = None
        self.connected = threading.Event()

    # ---- lifecycle ---------------------------------------------------------

    def start(self) -> "EventStream":
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="fullmag-live-events", daemon=True)
            self._thread.start()
        return self

    def close(self) -> None:
        self._stop.set()
        connection = self._connection
        if connection is not None:
            connection.send_close()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=2.0)

    # ---- subscriptions -----------------------------------------------------

    def subscribe(self, event_type: str, callback: Callable[[LiveEvent], None]) -> Subscription:
        """Call ``callback(event)`` for events of ``event_type`` (``"*"`` for all)."""
        subscription = Subscription(self, event_type, callback)
        with self._lock:
            self._subscriptions.append(subscription)
        return subscription

    def _unsubscribe(self, subscription: Subscription) -> None:
        with self._lock:
            if subscription in self._subscriptions:
                self._subscriptions.remove(subscription)

    def wait_for_change(self, timeout: float) -> bool:
        """Block until any event arrives or ``timeout`` passes; True when woken by an event."""
        with self._changed:
            generation = self._generation
            self._changed.wait_for(lambda: self._generation != generation or self._stop.is_set(), timeout=timeout)
            return self._generation != generation

    # ---- reader thread -------------------------------------------------------

    def _run(self) -> None:
        delay = 0.1
        while not self._stop.is_set():
            query = "" if self.last_seq is None else "?" + urllib.parse.urlencode({"after_seq": self.last_seq})
            try:
                self._connection = WebSocketConnection.connect(
                    self.base_url, EVENTS_PATH + query, subprotocol=SUBPROTOCOL, timeout=self.connect_timeout
                )
                self._connection.settimeout(None)
                self.connected.set()
                delay = 0.1
                while not self._stop.is_set():
                    opcode, data = self._connection.recv_message()
                    if opcode == 0x1:
                        self._dispatch(LiveEvent.from_json(json.loads(data.decode("utf-8"))))
            except (OSError, ValueError) as error:
                self.connected.clear()
                if self._stop.is_set():
                    break
                _LOG.debug("live event stream dropped (%s); reconnecting", error)
                self._stop.wait(delay)
                delay = min(delay * 2, self.reconnect_max_s)
            finally:
                if self._connection is not None:
                    self._connection.close()
                    self._connection = None

    def _dispatch(self, event: LiveEvent) -> None:
        if event.type == "hello":
            self.hello = event
        if event.type == "resync.required":
            self.last_seq = None
        else:
            self.last_seq = max(self.last_seq or 0, event.seq)
        with self._lock:
            targets = [s for s in self._subscriptions if s.event_type in {event.type, "*"}]
        for subscription in targets:
            try:
                subscription.callback(event)
            except Exception:  # a subscriber must not kill the stream
                _LOG.exception("live event callback failed for %s", event.type)
        with self._changed:
            self._generation += 1
            self._changed.notify_all()
