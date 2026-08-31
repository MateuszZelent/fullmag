"""Serve the sinc-layer scalar monitor with no-cache headers."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Static-file handler suitable for polling live scalar artifacts."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"[live] {format % args}")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    default_directory = repo_root / "tests" / "fem_fdm_mumax3_sinc_layer"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--directory", type=Path, default=default_directory)
    args = parser.parse_args()

    directory = args.directory.resolve()
    if not directory.is_dir():
        parser.error(f"directory does not exist: {directory}")
    handler = partial(NoCacheHandler, directory=str(directory))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Live scalar monitor: http://{args.host}:{args.port}/live-results.html")
    print(f"Serving: {directory}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping live scalar monitor")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
