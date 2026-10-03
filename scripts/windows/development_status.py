"""Private status publication for a managed native development workspace."""

from __future__ import annotations

import hashlib
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

from fullmag_storage import atomic_json


SCHEMA = "fullmag.backend-watch.v2"
GENERATION_ID = re.compile(r"^[0-9a-f]{32}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
WORKTREE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
STATES = frozenset(("waiting", "building", "ready", "failed", "superseded", "stopped"))


class DevelopmentStatusError(RuntimeError):
    """A managed development status cannot be published or trusted."""


class DevelopmentStatusPublisher:
    """Serialize state changes and heartbeats into one atomic status file."""

    def __init__(
        self,
        path: str | Path,
        generation_id: str,
        worktree_id: str,
        *,
        clock_ms: Callable[[], int] | None = None,
        write_json: Callable[[Path, Mapping[str, Any]], None] = atomic_json,
    ):
        if not isinstance(generation_id, str) or not GENERATION_ID.fullmatch(generation_id):
            raise DevelopmentStatusError("Managed status requires a lowercase 32-character generation id")
        if not isinstance(worktree_id, str) or not WORKTREE_ID.fullmatch(worktree_id):
            raise DevelopmentStatusError("Managed status requires a valid worktree id")
        self.path = Path(path)
        self.generation_id = generation_id
        self.worktree_id = worktree_id
        self._clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self._write_json = write_json
        self._lock = threading.Lock()
        self._revision = 0
        self._event: tuple[Any, ...] | None = None
        self._document: dict[str, Any] | None = None
        self._failure: BaseException | None = None

    def _raise_if_failed(self) -> None:
        if self._failure is not None:
            raise DevelopmentStatusError("Development status publication failed; refusing further updates") from self._failure

    def _timestamp(self) -> int:
        now = self._clock_ms()
        if isinstance(now, bool) or not isinstance(now, int) or now < 0:
            raise DevelopmentStatusError("Development status clock must return a non-negative integer")
        previous = (self._document or {}).get("updated_unix_ms", -1)
        return max(now, previous + 1)

    def publish(self, update: Mapping[str, Any]) -> dict[str, Any]:
        """Publish a watcher state; unknown watcher details are never serialized."""
        with self._lock:
            self._raise_if_failed()
            try:
                state = update.get("state")
                if state not in STATES:
                    raise DevelopmentStatusError("Unknown backend watcher state")
                source_sha256 = update.get("source_sha256")
                if source_sha256 is not None and (
                    not isinstance(source_sha256, str) or not SHA256.fullmatch(source_sha256)
                ):
                    raise DevelopmentStatusError("Backend status source identity must be a SHA-256 digest")

                event_values: dict[str, Any] = {
                    "state": state,
                    "source_sha256": source_sha256,
                }
                if state == "ready":
                    ready_build_id = update.get("ready_build_id")
                    ready_source_sha256 = update.get("ready_source_sha256")
                    if (not isinstance(ready_build_id, str) or not SHA256.fullmatch(ready_build_id) or
                            not isinstance(ready_source_sha256, str) or
                            not SHA256.fullmatch(ready_source_sha256) or
                            ready_source_sha256 != source_sha256):
                        raise DevelopmentStatusError("Ready status requires a verified matching build identity")
                    event_values["ready_build_id"] = ready_build_id
                    event_values["ready_source_sha256"] = ready_source_sha256

                event = tuple(sorted(event_values.items()))
                if event != self._event:
                    self._revision += 1
                document: dict[str, Any] = {
                    "schema": SCHEMA,
                    "generation_id": self.generation_id,
                    "worktree_id": self.worktree_id,
                    **event_values,
                    "revision": self._revision,
                    "updated_unix_ms": self._timestamp(),
                }
                self._write_json(self.path, document)
            except BaseException as error:
                self._failure = error
                raise
            self._event = event
            self._document = document
            return dict(document)

    def heartbeat(self) -> dict[str, Any]:
        """Refresh liveness without changing the state revision."""
        with self._lock:
            self._raise_if_failed()
            if self._document is None:
                raise DevelopmentStatusError("Publish an initial backend state before starting heartbeats")
            document = dict(self._document)
            document["updated_unix_ms"] = self._timestamp()
            try:
                self._write_json(self.path, document)
            except BaseException as error:
                self._failure = error
                raise
            self._document = document
            return dict(document)


class StatusHeartbeat:
    """Keep a managed status fresh while the synchronous build route blocks."""

    def __init__(self, publisher: DevelopmentStatusPublisher, interval_seconds: float = 2.0):
        if interval_seconds <= 0:
            raise ValueError("Heartbeat interval must be positive")
        self.publisher = publisher
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._failure: BaseException | None = None

    def start(self) -> "StatusHeartbeat":
        if self._thread is not None:
            raise RuntimeError("Status heartbeat is already started")
        self._thread = threading.Thread(target=self._run, name="fullmag-development-status", daemon=True)
        self._thread.start()
        return self

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            try:
                self.publisher.heartbeat()
            except BaseException as error:
                self._failure = error
                self._stop.set()
                return

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()

    def raise_if_failed(self) -> None:
        if self._failure is not None:
            raise DevelopmentStatusError("Development status heartbeat failed") from self._failure
        self.publisher._raise_if_failed()


def verified_build_identity(
    build_root: str | Path,
    runtime_root: str | Path,
    manifest_path: str | Path,
    expected_source_sha256: str,
) -> dict[str, str]:
    """Return a build id only after the runtime-bundle validator verifies the manifest and binaries."""
    if not isinstance(expected_source_sha256, str) or not SHA256.fullmatch(expected_source_sha256):
        raise DevelopmentStatusError("Expected backend source identity is invalid")

    try:
        # This validator checks the complete bounded executable inventory and
        # every declared file hash without publishing another runtime bundle.
        from windows.runtime_bundle import _load_source_manifest

        _, _, _, manifest, raw_manifest, _, _, _ = _load_source_manifest(
            build_root, runtime_root, manifest_path, "dev"
        )
    except Exception as error:
        raise DevelopmentStatusError("Backend build manifest or binaries failed verification") from error

    if (
        manifest.get("compiler_profile") != "backend-dev"
        or manifest.get("frontend_mode") != "dev"
        or manifest.get("backend_source_sha256") != expected_source_sha256
        or manifest.get("source_identity_check") != "passed"
        or manifest.get("local_changes_check") != "enforced"
    ):
        raise DevelopmentStatusError("Backend build manifest does not match the attempted managed dev source")

    build_version = manifest.get("build_version")
    if not isinstance(build_version, dict) or not isinstance(build_version.get("product_version"), str) or not build_version["product_version"]:
        raise DevelopmentStatusError("Backend build manifest has no sealed product version")

    return {
        "ready_build_id": hashlib.sha256(raw_manifest).hexdigest(),
        "ready_source_sha256": expected_source_sha256,
    }


def make_publisher(
    path: str | Path,
    generation_id: str | None,
    worktree_id: str,
    **kwargs: Any,
) -> DevelopmentStatusPublisher | None:
    """Only the runtime manager's explicit generation can authorize API status."""
    if generation_id is None:
        return None
    return DevelopmentStatusPublisher(path, generation_id, worktree_id, **kwargs)
