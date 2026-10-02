"""Interpreted regression for independent live Control Room proxy processes."""
import http.server
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import pytest

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

@pytest.mark.skipif(NODE is None, reason="Node is required")
def test_two_live_frontends_keep_api_identity_and_foreign_listener():
    processes, servers = [], []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(self.server.marker.encode())
        def log_message(self, *_): pass
    def fetch(port, path="/"):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
            return response.headers.get("x-fullmag-instance-id"), response.read().decode()
    def ready(port, child):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert child.poll() is None, "owned frontend exited during startup"
            try: return fetch(port)
            except OSError: time.sleep(0.05)
        raise AssertionError("frontend did not become ready")
    try:
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "index.html").write_text("instance UI")
            ports = []
            for marker in ("first", "second"):
                backend = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                backend.marker = marker
                servers.append(backend)
                threading.Thread(target=backend.serve_forever, daemon=True).start()
                port = free_port()
                ports.append(port)
                env = os.environ.copy()
                env.pop("FULLMAG_WEB_LISTENER_FD", None)
                env["FULLMAG_INSTANCE_ID"] = marker
                child = subprocess.Popen([NODE, str(ROOT / "apps/control-room/dev-server.mjs"),
                    "--hostname", "127.0.0.1", "--port", str(port), "--static-root", temp,
                    "--api-target", f"http://127.0.0.1:{backend.server_port}"], env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                processes.append(child)
                assert ready(port, child) == (marker, "instance UI")
            assert fetch(ports[0], "/v2/identity")[1] == "first"
            assert fetch(ports[1], "/v2/identity")[1] == "second"
            # An occupied listener must not be adopted, terminated or overwritten.
            conflicting = subprocess.Popen([NODE, str(ROOT / "apps/control-room/dev-server.mjs"),
                "--hostname", "127.0.0.1", "--port", str(ports[0]), "--static-root", temp],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(conflicting)
            assert conflicting.wait(timeout=10) != 0
            assert fetch(ports[0])[0] == "first"
            processes[0].terminate()
            processes[0].wait(timeout=10)
            assert fetch(ports[1], "/v2/identity") == ("second", "second")
    finally:
        for child in processes:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
        for server in servers:
            server.shutdown()
            server.server_close()
