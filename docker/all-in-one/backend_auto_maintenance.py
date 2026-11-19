"""Supervised, bounded-output housekeeping after a DEV backend becomes ready."""
from __future__ import annotations

import datetime
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import uuid

ENABLE_ENV = "FULLMAG_AUTO_CACHE_MAINTENANCE"
SCHEMA = "fullmag.automatic-cache-maintenance.v1"
MAX_OUTPUT = 1024 * 1024


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class Maintenance:
    """Own exactly one child; failures never replace the API/native drain."""

    def __init__(self, receipt_path, writer, ready_receipt):
        if ready_receipt.get("state") != "ready" or not isinstance(ready_receipt.get("api_pid"), int):
            raise RuntimeError("Automatic maintenance requires the ready API receipt")
        unit = os.environ.get("FULLMAG_BACKEND_CACHE_UNIT_KEY", "")
        if re.fullmatch(r"[a-f0-9]{64}", unit) is None:
            raise RuntimeError("Automatic maintenance requires the managed cache unit")
        self.path = Path(receipt_path).with_name("cache-maintenance.json")
        self.writer = writer
        self.process = None
        self.tail = bytearray()
        self.done = False
        self.receipt = {"schema": SCHEMA, "state": "scheduled", "attempt": uuid.uuid4().hex,
                        "started_at": now(), "api_pid": ready_receipt["api_pid"], "unit_key": unit,
                        "trigger": "container-ready"}

    def publish(self):
        self.writer(self.path, self.receipt, "automatic cache maintenance receipt")

    def start(self):
        self.publish()
        try:
            self.process = subprocess.Popen(
                [sys.executable, "-B", "/opt/fullmag/backend_auto_maintenance.py", "--worker"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                close_fds=True, start_new_session=True,
            )
            os.set_blocking(self.process.stdout.fileno(), False)
            self.receipt.update(state="running", pid=self.process.pid)
            self.publish()
        except Exception:
            # Never orphan a child when durable publication or pipe setup fails.
            if self.process is not None:
                try:
                    self.stop()
                except Exception:
                    pass
            raise
        return self

    def read_output(self):
        for _ in range(16):
            try:
                chunk = os.read(self.process.stdout.fileno(), 65536)
            except BlockingIOError:
                break
            if not chunk:
                break
            self.tail.extend(chunk)
            if len(self.tail) > MAX_OUTPUT:
                del self.tail[:-MAX_OUTPUT]

    def finish(self, code, *, interrupted=False):
        self.done = True
        self.receipt.update(exit_code=code, finished_at=now())
        if code == 75:
            self.receipt.update(state="deferred-busy", reason="group build lock is held")
        elif code != 0:
            self.receipt.update(state="interrupted" if interrupted else "failed",
                                diagnostic=bytes(self.tail[-4096:]).decode(errors="replace"))
        else:
            try:
                result = json.loads(bytes(self.tail).splitlines()[-1])
                if not isinstance(result, dict) or result.get("schema") != "fullmag.package-maintenance.v1" or result.get("state") != "succeeded":
                    raise ValueError("maintenance result is not a success receipt")
                self.receipt.update(state="succeeded", result=result)
            except (ValueError, IndexError) as error:
                self.receipt.update(state="failed", diagnostic=str(error))
        self.process.stdout.close()
        self.publish()

    def poll(self):
        if self.done or self.process is None:
            return
        self.read_output()
        code = self.process.poll()
        if code is not None:
            self.read_output()
            self.finish(code)

    def stop(self):
        if self.done or self.process is None:
            return
        # Pipe/receipt errors must never prevent terminating our child.
        if self.process.poll() is not None:
            try:
                self.read_output()
            finally:
                self.finish(self.process.returncode)
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            code = self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                code = self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.receipt.update(state="shutdown-unconfirmed", finished_at=now())
                self.publish()
                raise RuntimeError("Automatic maintenance child termination is unconfirmed")
        try:
            self.read_output()
        finally:
            self.finish(code, interrupted=True)


def start(receipt_path, writer, ready_receipt):
    if os.environ.get(ENABLE_ENV, "0") != "1" or os.environ.get("FULLMAG_DOCKER_ROLE") != "backend":
        return None
    return Maintenance(receipt_path, writer, ready_receipt).start()


if __name__ == "__main__":
    if sys.argv[1:] != ["--worker"]:
        raise SystemExit("Only the image-owned maintenance worker is supported")
    os.nice(19)
    os.execv(sys.executable, [sys.executable, "-B", "/opt/fullmag/backend_dev.py", "maintain-packages"])
