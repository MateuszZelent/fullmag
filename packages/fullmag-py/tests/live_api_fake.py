"""In-process fake of the Fullmag v2 HTTP API for live-client tests.

The fake runs a real ``ThreadingHTTPServer`` with HTTP/1.1 keep-alive, so the
tests exercise the production transport (sockets, headers, retries) instead of
a mocked function call.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlsplit

Reply = tuple[int, Any, dict[str, str]]
Handler = Callable[["RecordedRequest"], Optional[Reply]]


@dataclass
class RecordedRequest:
    method: str
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    body: bytes
    connection_id: int

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None


@dataclass
class FakeFullmagApi:
    routes: dict[tuple[str, str], Handler] = field(default_factory=dict)
    requests: list[RecordedRequest] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    server: Optional[ThreadingHTTPServer] = None
    thread: Optional[threading.Thread] = None
    _connections: int = 0

    def route(self, method: str, path: str, handler: Handler | Reply | Any) -> None:
        if not callable(handler):
            reply = handler if isinstance(handler, tuple) else (200, handler, {})
            self.routes[(method.upper(), path)] = lambda _request, reply=reply: reply
        else:
            self.routes[(method.upper(), path)] = handler

    @property
    def url(self) -> str:
        assert self.server is not None
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> "FakeFullmagApi":
        api = self

        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self) -> None:
                super().setup()
                with api.lock:
                    api._connections += 1
                    self.connection_id = api._connections

            def log_message(self, *_args: Any) -> None:  # keep test output clean
                return

            def _serve(self) -> None:
                parsed = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                request = RecordedRequest(
                    method=self.command,
                    path=parsed.path,
                    query={key: values[-1] for key, values in parse_qs(parsed.query).items()},
                    headers={key.lower(): value for key, value in self.headers.items()},
                    body=body,
                    connection_id=self.connection_id,
                )
                with api.lock:
                    api.requests.append(request)
                handler = api.routes.get((self.command, parsed.path))
                if handler is None:
                    status, payload, headers = 404, {"code": "not_found", "error": "no route", "message": "no route"}, {}
                else:
                    reply = handler(request)
                    if reply is None:
                        self.close_connection = True
                        return
                    status, payload, headers = reply
                if isinstance(payload, (bytes, bytearray)):
                    data = bytes(payload)
                    content_type = headers.pop("Content-Type", "application/octet-stream")
                elif payload is None:
                    data = b""
                    content_type = "application/json"
                else:
                    data = json.dumps(payload).encode("utf-8")
                    content_type = "application/json"
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _serve

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()

    def __enter__(self) -> "FakeFullmagApi":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def find(self, method: str, path: str) -> list[RecordedRequest]:
        with self.lock:
            return [request for request in self.requests if request.method == method and request.path == path]


def api_error(status: int, code: str, message: str) -> Reply:
    return status, {"code": code, "error": message, "message": message}, {}
