from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import multiprocessing
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


try:
    from scripts.local_runner.build_entrypoint import materialize_capsule
    from scripts.local_runner import source_store, source_store_lock
    from scripts.local_runner.source import SourceError, capture_source
    from scripts.local_runner.worker_entrypoint import verify_source
except ModuleNotFoundError:
    from local_runner.build_entrypoint import materialize_capsule
    from local_runner import source_store, source_store_lock
    from local_runner.source import SourceError, capture_source
    from local_runner.worker_entrypoint import verify_source


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ("git", "-c", "core.filemode=false", *args),
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def _repository(root: Path, *, script: bool = False) -> Path:
    repo = root / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Local runner content-store tests")
    _git(repo, "config", "user.email", "local-runner-content-store@example.invalid")
    (repo / "tracked.txt").write_bytes(b"committed source\n")
    (repo / "deleted.txt").write_bytes(b"delete me\n")
    if script:
        (repo / "program.sh").write_bytes(b"#!/bin/sh\nprintf test\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "initial")
    return repo


def _capture(
    repo: Path,
    root: Path,
    name: str,
    *,
    store: Path | None,
    mode: str = "snapshot",
    ref: str | None = None,
    include_untracked: tuple[str, ...] = (),
):
    output = root / name
    output.mkdir()
    return output, capture_source(
        repo,
        output,
        mode=mode,
        ref=ref,
        include_untracked=include_untracked,
        **({"content_store": store} if store is not None else {}),
    )


def _object_path(store: Path, entry: dict[str, object]) -> Path:
    digest = str(entry["sha256"])
    mode = str(entry["mode"])
    return store / "sha256" / digest[:2] / f"{digest}-{mode}"


def _child_hold_content_lock(
    store_root: str,
    digest: str,
    ready,
) -> None:
    store = source_store.SourceContentStore(store_root)
    object_path = store._object_path(digest, "100644")
    store._prepare_object_parent(object_path)
    with store._publication_lock(object_path):
        ready.set()
        while True:
            time.sleep(1.0)


def _child_capture_pause_after_publish(
    repo: str,
    destination: str,
    store_root: str,
    expected_digest: str,
    ready,
) -> None:
    real_verify = source_store.SourceContentStore._verify_object

    def pause_after_verified_publish(self, object_path, *, digest, mode, size):
        metadata = real_verify(
            self,
            object_path,
            digest=digest,
            mode=mode,
            size=size,
        )
        if digest == expected_digest:
            ready.set()
            while True:
                time.sleep(1.0)
        return metadata

    with patch.object(
        source_store.SourceContentStore,
        "_verify_object",
        pause_after_verified_publish,
    ):
        capture_source(Path(repo), Path(destination), content_store=Path(store_root))


def _child_reclaim_lock_and_hold(
    store_root: str,
    digest: str,
    barrier,
    outcomes,
    active_reclaimers,
) -> None:
    try:
        store = source_store.SourceContentStore(store_root)
        object_path = store._object_path(digest, "100644")
        store._prepare_object_parent(object_path)
        barrier.wait(timeout=20.0)
        with store._publication_lock(object_path):
            counted_active = False
            try:
                with active_reclaimers.get_lock():
                    active_reclaimers.value += 1
                    counted_active = True
                    if active_reclaimers.value != 1:
                        raise AssertionError(
                            "two reclaimers held the same object lock concurrently"
                        )
                outcomes.put(("entered", os.getpid()))
                time.sleep(0.1)
            finally:
                if counted_active:
                    with active_reclaimers.get_lock():
                        active_reclaimers.value -= 1
        outcomes.put(("released", os.getpid()))
    except BaseException as error:
        outcomes.put(("error", f"{type(error).__name__}: {error}"))
        raise


def _child_warm_identity_then_fork_lock_owner(
    store_root: str,
    digest: str,
    ready_path: str,
    release_path: str,
    owner_pid_path: str,
) -> None:
    store = source_store.SourceContentStore(store_root)
    object_path = store._object_path(digest, "100644")
    store._prepare_object_parent(object_path)
    parent_identity, identity_error = store._owner_identity_provider.current()
    if parent_identity is None:
        Path(ready_path).write_text(f"ERROR {identity_error}\n", encoding="ascii")
        os._exit(2)
    parent_state = store._owner_identity_provider._states[
        (source_store_lock._PROCESS_FORK_EPOCH, os.getpid())
    ]
    gate_path = Path(store_root) / ".forked-process-local-gate"
    parent_thread_gate = source_store_lock._thread_gate(gate_path)
    thread_gate_registry = source_store_lock._THREAD_GATES_GUARD
    parent_state.lock.acquire()
    parent_thread_gate.acquire()
    thread_gate_registry.acquire()
    try:
        owner_pid = os.fork()
    except OSError as error:
        thread_gate_registry.release()
        parent_thread_gate.release()
        parent_state.lock.release()
        Path(ready_path).write_text(f"ERROR fork: {error.errno}\n", encoding="ascii")
        os._exit(3)

    if owner_pid == 0:
        try:
            child_thread_gate = source_store_lock._thread_gate(gate_path)
            if child_thread_gate is parent_thread_gate:
                raise AssertionError("forked child reused the parent thread-gate map")
            child_thread_gate.acquire()
            child_thread_gate.release()
            with store._publication_lock(object_path):
                lock_path = object_path.with_name(object_path.name + ".lock")
                record, _ = source_store_lock._read_lock_record(lock_path)
                owner = record["owner_identity"]
                if not isinstance(owner, dict):
                    raise AssertionError("forked owner record must carry a process identity")
                Path(ready_path).write_text(
                    f"READY {os.getpid()} {owner['pid']} {owner['generation']} "
                    f"{parent_identity['pid']}\n",
                    encoding="ascii",
                )
                release = Path(release_path)
                deadline = time.monotonic() + 30.0
                while not release.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                if not release.exists():
                    raise TimeoutError("test did not release forked lock owner")
            os._exit(0)
        except BaseException as error:
            try:
                Path(ready_path).write_text(
                    f"ERROR {type(error).__name__}: {error}\n",
                    encoding="ascii",
                )
            finally:
                os._exit(4)
    Path(owner_pid_path).write_text(str(owner_pid), encoding="ascii")
    thread_gate_registry.release()
    parent_thread_gate.release()
    parent_state.lock.release()
    os._exit(0)


def _write_owner_lock_for_test(
    lock_path: Path,
    identity: dict[str, object] | None,
    identity_error: str | None = None,
) -> bytes:
    token = source_store_lock.uuid.uuid4().hex
    record = source_store_lock._lock_record_bytes(token, identity, identity_error)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".pending-owner-{token}-",
        suffix=".tmp",
        dir=lock_path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(record)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name != "nt":
            temporary.chmod(0o400)
        os.link(temporary, lock_path, follow_symlinks=False)
        return record
    finally:
        if temporary.exists():
            temporary.chmod(0o600)
            temporary.unlink()


class LocalRunnerSourceStoreTests(unittest.TestCase):
    def test_killed_owner_before_object_publication_is_recovered(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            store_path = root / "store"
            source = root / "capture-stage"
            destination = root / "capsule-stage"
            content = b"recover before object publication\n"
            source.write_bytes(content)
            destination.write_bytes(content)
            digest = hashlib.sha256(content).hexdigest()
            store = source_store.SourceContentStore(store_path)
            object_path = store._object_path(digest, "100644")

            context = multiprocessing.get_context("spawn")
            ready = context.Event()
            child = context.Process(
                target=_child_hold_content_lock,
                args=(str(store_path), digest, ready),
            )
            child.start()
            try:
                self.assertTrue(ready.wait(20.0), "child did not acquire the canonical lock")
                lock_path = object_path.with_name(object_path.name + ".lock")
                record, _ = source_store_lock._read_lock_record(lock_path)
                self.assertEqual(record["schema"], "fullmag.source-content-lock.v2")
                self.assertEqual(record["owner_identity_status"], "available")
                child.terminate()
                child.join(20.0)
                self.assertFalse(child.is_alive(), "killed lock owner did not exit")

                store.link_file(
                    source,
                    destination,
                    digest=digest,
                    mode="100644",
                    size=len(content),
                )
                metadata = store._verify_object(
                    object_path,
                    digest=digest,
                    mode="100644",
                    size=len(content),
                )
                self.assertEqual(object_path.read_bytes(), content)
                self.assertTrue(source_store._is_readonly(object_path, metadata))
                self.assertTrue(os.path.samefile(object_path, destination))
                self.assertFalse(lock_path.exists())
            finally:
                if child.is_alive():
                    child.terminate()
                    child.join(20.0)

    def test_killed_owner_after_sealed_object_publication_is_recovered(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store_path = root / "store"
            output = root / "capsule"
            output.mkdir()
            digest = hashlib.sha256(b"committed source\n").hexdigest()
            store = source_store.SourceContentStore(store_path)
            object_path = store._object_path(digest, "100644")

            context = multiprocessing.get_context("spawn")
            ready = context.Event()
            child = context.Process(
                target=_child_capture_pause_after_publish,
                args=(str(repo), str(output), str(store_path), digest, ready),
            )
            child.start()
            try:
                self.assertTrue(
                    ready.wait(30.0),
                    "child did not reach the post-publication verified-object point",
                )
                lock_path = object_path.with_name(object_path.name + ".lock")
                record, _ = source_store_lock._read_lock_record(lock_path)
                self.assertEqual(record["owner_identity_status"], "available")
                self.assertEqual(object_path.read_bytes(), b"committed source\n")

                child.terminate()
                child.join(20.0)
                self.assertFalse(child.is_alive(), "killed post-publication owner did not exit")

                retry_output = root / "capsule-retry"
                retry_output.mkdir()
                manifest = capture_source(repo, retry_output, content_store=store_path)
                verified = verify_source(retry_output, manifest["source_digest"])
                self.assertEqual(verified["source_digest"], manifest["source_digest"])
                self.assertEqual(
                    (retry_output / "tree" / "tracked.txt").read_bytes(),
                    b"committed source\n",
                )
                metadata = store._verify_object(
                    object_path,
                    digest=digest,
                    mode="100644",
                    size=len(b"committed source\n"),
                )
                self.assertTrue(source_store._is_readonly(object_path, metadata))
                self.assertFalse(lock_path.exists())
            finally:
                if child.is_alive():
                    child.terminate()
                    child.join(20.0)

    def test_two_reclaimers_serialize_and_recheck_the_new_owner(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            store_path = root / "store"
            content = b"two stale-lock reclaimers\n"
            digest = hashlib.sha256(content).hexdigest()
            store = source_store.SourceContentStore(store_path)
            object_path = store._object_path(digest, "100644")

            context = multiprocessing.get_context("spawn")
            ready = context.Event()
            owner = context.Process(
                target=_child_hold_content_lock,
                args=(str(store_path), digest, ready),
            )
            owner.start()
            contenders = []
            try:
                self.assertTrue(ready.wait(20.0), "initial child did not acquire the lock")
                owner.terminate()
                owner.join(20.0)
                self.assertFalse(owner.is_alive())

                barrier = context.Barrier(3)
                outcomes = context.Queue()
                active_reclaimers = context.Value("i", 0)
                contenders = [
                    context.Process(
                        target=_child_reclaim_lock_and_hold,
                        args=(str(store_path), digest, barrier, outcomes, active_reclaimers),
                    )
                    for _ in range(2)
                ]
                for contender in contenders:
                    contender.start()
                barrier.wait(timeout=20.0)
                observations = [outcomes.get(timeout=20.0) for _ in range(4)]
                for contender in contenders:
                    contender.join(20.0)
                    self.assertEqual(contender.exitcode, 0)
                self.assertCountEqual(
                    [kind for kind, _ in observations],
                    ["entered", "entered", "released", "released"],
                )
                self.assertEqual(active_reclaimers.value, 0)
                self.assertFalse(object_path.with_name(object_path.name + ".lock").exists())
            finally:
                if owner.is_alive():
                    owner.terminate()
                    owner.join(20.0)
                for contender in contenders:
                    if contender.is_alive():
                        contender.terminate()
                        contender.join(20.0)

    def test_warmed_idle_store_after_fork_uses_live_child_identity(self) -> None:
        if not sys.platform.startswith("linux") or not hasattr(os, "fork"):
            self.skipTest("fork owner-generation proof is specific to Linux")
        if not callable(getattr(os, "pidfd_open", None)):
            self.skipTest("live-owner recovery requires Linux pidfd support")
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-fork-owner-test-") as raw:
            root = Path(raw)
            store_path = root / "store"
            digest = hashlib.sha256(b"forked idle source store\n").hexdigest()
            object_path = store_path / "sha256" / digest[:2] / f"{digest}-100644"
            object_path.parent.mkdir(parents=True)
            ready_path = root / "forked-owner-ready"
            release_path = root / "release-forked-owner"
            owner_pid_path = root / "forked-owner-pid"
            warm_parent_pid = os.fork()
            if warm_parent_pid == 0:
                _child_warm_identity_then_fork_lock_owner(
                    str(store_path),
                    digest,
                    str(ready_path),
                    str(release_path),
                    str(owner_pid_path),
                )
                os._exit(5)

            forked_owner_pid: int | None = None
            owner_pidfd: int | None = None
            lock_path = object_path.with_name(object_path.name + ".lock")
            try:
                waited_pid, warm_parent_status = os.waitpid(warm_parent_pid, 0)
                self.assertEqual(waited_pid, warm_parent_pid)
                self.assertEqual(os.waitstatus_to_exitcode(warm_parent_status), 0)

                deadline = time.monotonic() + 20.0
                while time.monotonic() < deadline:
                    try:
                        owner_pid_text = owner_pid_path.read_text(encoding="ascii").strip()
                        if owner_pid_text.isdigit():
                            forked_owner_pid = int(owner_pid_text)
                            owner_pidfd = os.pidfd_open(forked_owner_pid, 0)
                            break
                    except FileNotFoundError:
                        pass
                    select.select([], [], [], 0.01)
                self.assertIsNotNone(forked_owner_pid, "warm parent did not publish child PID")

                deadline = time.monotonic() + 20.0
                ready = ""
                while time.monotonic() < deadline:
                    try:
                        ready = ready_path.read_text(encoding="ascii")
                    except FileNotFoundError:
                        pass
                    if ready.endswith("\n"):
                        break
                    select.select([], [], [], 0.01)
                self.assertTrue(ready.endswith("\n"), "forked owner did not publish readiness")
                fields = ready.split()
                self.assertEqual(fields[0], "READY", ready)
                self.assertEqual(int(fields[1]), forked_owner_pid)
                recorded_owner_pid = int(fields[2])
                recorded_generation = fields[3]
                warmed_parent_identity_pid = int(fields[4])
                self.assertEqual(warmed_parent_identity_pid, warm_parent_pid)
                self.assertNotEqual(recorded_owner_pid, warmed_parent_identity_pid)
                self.assertEqual(recorded_owner_pid, forked_owner_pid)

                record, _ = source_store_lock._read_lock_record(lock_path)
                owner = record["owner_identity"]
                self.assertIsInstance(owner, dict)
                self.assertEqual(owner["pid"], forked_owner_pid)
                self.assertEqual(owner["generation"], recorded_generation)
                actual_generation, actual_namespace = source_store_lock._proc_starttime(
                    forked_owner_pid
                )
                self.assertEqual(recorded_generation, actual_generation)
                self.assertEqual(owner["pid_namespace"], actual_namespace)

                before = lock_path.read_bytes()
                store = source_store.SourceContentStore(store_path)
                with patch.object(source_store, "_LOCK_WAIT_SECONDS", 0.0):
                    with self.assertRaisesRegex(
                        source_store.SourceContentStoreError,
                        "owner_alive:",
                    ):
                        with store._publication_lock(object_path):
                            self.fail("the live forked owner lock must not be reclaimed")
                self.assertEqual(lock_path.read_bytes(), before)
                record_after, _ = source_store_lock._read_lock_record(lock_path)
                self.assertEqual(record_after["owner_identity"]["pid"], forked_owner_pid)
            finally:
                release_path.touch(exist_ok=True)
                cleanup_deadline = time.monotonic() + 5.0
                while lock_path.exists() and time.monotonic() < cleanup_deadline:
                    select.select([], [], [], 0.01)
                if owner_pidfd is not None:
                    poller = select.poll()
                    poller.register(owner_pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
                    if not poller.poll(5000) and forked_owner_pid is not None:
                        try:
                            os.kill(forked_owner_pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        poller.poll(5000)
                    os.close(owner_pidfd)
                elif lock_path.exists() and forked_owner_pid is not None:
                    try:
                        os.kill(forked_owner_pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass

    def test_fork_during_active_lock_fails_child_closed_without_releasing_parent(self) -> None:
        if not sys.platform.startswith("linux") or not hasattr(os, "fork"):
            self.skipTest("active-lock fork fence is specific to Linux")

        class _ExpectedForkedChildExit(Exception):
            pass

        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-active-fork-test-") as raw:
            root = Path(raw)
            store = source_store.SourceContentStore(root / "store")
            digest = hashlib.sha256(b"active fork fence\n").hexdigest()
            object_path = store._object_path(digest, "100644")
            store._prepare_object_parent(object_path)
            other_digest = hashlib.sha256(b"child publication must fail\n").hexdigest()
            other_path = store._object_path(other_digest, "100644")
            lock_path = object_path.with_name(object_path.name + ".lock")
            other_lock_path = other_path.with_name(other_path.name + ".lock")

            try:
                with store._publication_lock(object_path):
                    child_pid = os.fork()
                    if child_pid == 0:
                        try:
                            with store._publication_lock(other_path):
                                os._exit(10)
                        except source_store.SourceContentStoreError as error:
                            if "forked during an active lock operation" not in str(error):
                                os._exit(11)
                            raise _ExpectedForkedChildExit()
                        os._exit(12)

                    waited_pid, status = os.waitpid(child_pid, 0)
                    self.assertEqual(waited_pid, child_pid)
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                    self.assertTrue(lock_path.exists())
                    self.assertFalse(other_lock_path.exists())
            except _ExpectedForkedChildExit:
                os._exit(0 if lock_path.exists() and not other_lock_path.exists() else 13)

            self.assertFalse(lock_path.exists())

    def test_pid_reuse_reclaims_only_the_old_generation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            store = source_store.SourceContentStore(root / "store")
            object_path = store._object_path(hashlib.sha256(b"generation").hexdigest(), "100644")
            object_path.parent.mkdir(parents=True)
            provider = source_store_lock.OwnerIdentityProvider()
            identity, error = provider.current()
            if identity is None:
                self.skipTest(f"current OS process identity is unavailable: {error}")
            old_owner = copy.deepcopy(identity)
            old_generation = int(str(old_owner["generation"]))
            old_owner["generation"] = str(old_generation + 1)
            lock_path = object_path.with_name(object_path.name + ".lock")
            _write_owner_lock_for_test(lock_path, old_owner)

            with patch.object(source_store, "_LOCK_WAIT_SECONDS", 1.0):
                with store._publication_lock(object_path):
                    record, _ = source_store_lock._read_lock_record(lock_path)
                    self.assertEqual(record["owner_identity"]["generation"], identity["generation"])
            self.assertFalse(lock_path.exists())

    def test_foreign_boot_legacy_and_corrupt_records_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            store = source_store.SourceContentStore(root / "store")
            object_path = store._object_path(hashlib.sha256(b"foreign").hexdigest(), "100644")
            object_path.parent.mkdir(parents=True)
            provider = source_store_lock.OwnerIdentityProvider()
            identity, error = provider.current()
            if identity is None:
                self.skipTest(f"current OS process identity is unavailable: {error}")
            lock_path = object_path.with_name(object_path.name + ".lock")

            foreign = copy.deepcopy(identity)
            if foreign["platform"] == "linux":
                foreign["boot_id"] = "00000000-0000-0000-0000-000000000001"
            else:
                foreign["boot_id"] = str(int(str(foreign["boot_id"])) + 1)
            _write_owner_lock_for_test(lock_path, foreign)
            original = lock_path.read_bytes()
            with patch.object(source_store, "_LOCK_WAIT_SECONDS", 0.0):
                with self.assertRaisesRegex(
                    source_store.SourceContentStoreError,
                    "lock_owner_namespace_mismatch",
                ):
                    with store._publication_lock(object_path):
                        self.fail("foreign-boot lock must never be reclaimed")
            self.assertEqual(lock_path.read_bytes(), original)

            lock_path.unlink()
            lock_path.write_bytes(b"pid=1234\n")
            legacy = lock_path.read_bytes()
            with patch.object(source_store, "_LOCK_WAIT_SECONDS", 0.0):
                with self.assertRaisesRegex(
                    source_store.SourceContentStoreError,
                    "legacy_or_incomplete_lock_record",
                ):
                    with store._publication_lock(object_path):
                        self.fail("legacy PID-only lock must never be reclaimed")
            self.assertEqual(lock_path.read_bytes(), legacy)

            lock_path.unlink()
            valid = _write_owner_lock_for_test(lock_path, identity)
            checksum_start = valid.index(b'"record_sha256":"') + len(b'"record_sha256":"')
            replacement = b"0" if valid[checksum_start : checksum_start + 1] != b"0" else b"1"
            corrupted = valid[:checksum_start] + replacement + valid[checksum_start + 1 :]
            lock_path.chmod(0o600)
            lock_path.write_bytes(corrupted)
            with patch.object(source_store, "_LOCK_WAIT_SECONDS", 0.0):
                with self.assertRaisesRegex(
                    source_store.SourceContentStoreError,
                    "owner_record_integrity_mismatch",
                ):
                    with store._publication_lock(object_path):
                        self.fail("self-hash mismatch must never be reclaimed")
            self.assertEqual(lock_path.read_bytes(), corrupted)

            lock_path.unlink()
            unknown = _write_owner_lock_for_test(
                lock_path,
                None,
                "injected_owner_namespace_query_failure",
            )
            with patch.object(source_store, "_LOCK_WAIT_SECONDS", 0.0):
                with self.assertRaisesRegex(
                    source_store.SourceContentStoreError,
                    "lock_owner_identity_unavailable",
                ):
                    with store._publication_lock(object_path):
                        self.fail("unknown owner identity must never be reclaimed")
            self.assertEqual(lock_path.read_bytes(), unknown)

    def test_unknown_liveness_and_old_live_owner_preserve_lock(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            store_path = root / "store"
            store = source_store.SourceContentStore(store_path)
            object_path = store._object_path(hashlib.sha256(b"unknown-owner").hexdigest(), "100644")
            object_path.parent.mkdir(parents=True)
            identity, error = source_store_lock.OwnerIdentityProvider().current()
            if identity is None:
                self.skipTest(f"current OS process identity is unavailable: {error}")
            lock_path = object_path.with_name(object_path.name + ".lock")
            _write_owner_lock_for_test(lock_path, identity)
            before = lock_path.read_bytes()
            os.utime(lock_path, (1.0, 1.0))
            with patch.object(source_store, "_LOCK_WAIT_SECONDS", 0.0):
                with patch.object(
                    source_store_lock,
                    "_owner_liveness",
                    return_value=("unknown", "injected_process_query_failure"),
                ):
                    with self.assertRaisesRegex(
                        source_store.SourceContentStoreError,
                        "owner_unknown:injected_process_query_failure",
                    ):
                        with store._publication_lock(object_path):
                            self.fail("unknown process query must preserve the lock")
            self.assertEqual(lock_path.read_bytes(), before)

            context = multiprocessing.get_context("spawn")
            ready = context.Event()
            live_store = source_store.SourceContentStore(store_path)
            live_object = live_store._object_path(
                hashlib.sha256(b"live-owner").hexdigest(), "100644"
            )
            live_object.parent.mkdir(parents=True)
            child = context.Process(
                target=_child_hold_content_lock,
                args=(str(store_path), hashlib.sha256(b"live-owner").hexdigest(), ready),
            )
            child.start()
            try:
                self.assertTrue(ready.wait(20.0), "live owner did not acquire the lock")
                live_lock = live_object.with_name(live_object.name + ".lock")
                os.utime(live_lock, (1.0, 1.0))
                original = live_lock.read_bytes()
                with patch.object(source_store, "_LOCK_WAIT_SECONDS", 0.05):
                    with self.assertRaisesRegex(
                        source_store.SourceContentStoreError,
                        "owner_alive:owner_",
                    ):
                        with live_store._publication_lock(live_object):
                            self.fail("an old but live process must keep its lock")
                self.assertTrue(child.is_alive())
                self.assertEqual(live_lock.read_bytes(), original)
            finally:
                if child.is_alive():
                    child.terminate()
                    child.join(20.0)

    def test_fifo_replacement_before_owner_open_fails_closed_without_blocking(self) -> None:
        if os.name == "nt" or not hasattr(os, "mkfifo"):
            self.skipTest("FIFO open race is specific to POSIX")
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-fifo-test-") as raw:
            path = Path(raw) / "owner.lock"
            path.write_bytes(b"complete owner record\n")
            validated_metadata = path.lstat()
            original_metadata = source_store_lock._regular_path_metadata
            original_open = os.open
            swapped = False

            def replace_with_fifo_after_validation(
                candidate: Path,
                *,
                allow_missing: bool,
            ):
                nonlocal swapped
                if candidate == path and not swapped:
                    path.unlink()
                    os.mkfifo(path)
                    swapped = True
                    return validated_metadata
                return original_metadata(candidate, allow_missing=allow_missing)

            def require_nonblocking_open(candidate, flags, *args, **kwargs):
                if Path(candidate) == path:
                    self.assertTrue(
                        flags & getattr(os, "O_NONBLOCK", 0),
                        "owner metadata opens must not block on a raced FIFO",
                    )
                return original_open(candidate, flags, *args, **kwargs)

            try:
                with patch.object(
                    source_store_lock,
                    "_regular_path_metadata",
                    side_effect=replace_with_fifo_after_validation,
                ), patch.object(os, "open", side_effect=require_nonblocking_open):
                    with self.assertRaisesRegex(
                        source_store_lock.SourceStoreLockError,
                        "not a regular file",
                    ):
                        source_store_lock._open_regular_file(path, writable=False)
                self.assertTrue(swapped, "the test must replace the validated file before open")
            finally:
                if path.exists():
                    path.unlink()

    def test_recovery_gate_rejects_fifo_before_kernel_lock(self) -> None:
        if os.name == "nt" or not hasattr(os, "mkfifo"):
            self.skipTest("recovery gate FIFO check is specific to POSIX")
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-gate-fifo-test-") as raw:
            root = Path(raw)
            identity, error = source_store_lock.OwnerIdentityProvider().current()
            if identity is None:
                self.skipTest(f"current OS process identity is unavailable: {error}")
            namespace = {
                key: value
                for key, value in identity.items()
                if key not in {"pid", "generation"}
            }
            digest = hashlib.sha256(source_store_lock._canonical_json(namespace)).hexdigest()[:32]
            gate_directory = root / source_store_lock._RECOVERY_DIRECTORY
            gate_directory.mkdir()
            gate_path = gate_directory / f"recovery-{digest}.lock"
            os.mkfifo(gate_path)

            with patch.object(
                source_store_lock.fcntl,
                "flock",
                side_effect=AssertionError("a non-regular recovery gate must never be locked"),
            ):
                with self.assertRaisesRegex(
                    source_store_lock.SourceStoreLockError,
                    "regular file",
                ):
                    with source_store_lock._recovery_gate(root, identity):
                        self.fail("a FIFO must be rejected before kernel locking")

    def test_windows_wmi_boot_query_failure_is_unrecoverable_unknown(self) -> None:
        if os.name != "nt":
            self.skipTest("Windows boot identity query runs only on Windows GHA")
        provider = source_store_lock.OwnerIdentityProvider()
        with patch.object(
            source_store_lock,
            "_windows_boot_identity",
            side_effect=source_store_lock._OwnerRecordError("injected_wmi_query_failure"),
        ):
            identity, error = provider.current()
        self.assertIsNone(identity)
        self.assertEqual(error, "injected_wmi_query_failure")

    def test_unknown_current_identity_keeps_publication_available_and_explicit(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            object_path = root / "sha256" / "00" / f"{hashlib.sha256(b'unknown').hexdigest()}-100644"
            object_path.parent.mkdir(parents=True)
            lock_path = object_path.with_name(object_path.name + ".lock")
            provider = source_store_lock.OwnerIdentityProvider()
            with patch.object(
                provider,
                "current",
                return_value=(None, "injected_owner_namespace_unavailable"),
            ):
                with source_store_lock.publication_lock(
                    lock_path,
                    root,
                    wait_timeout_seconds=0.0,
                    identity_provider=provider,
                ):
                    record, _ = source_store_lock._read_lock_record(lock_path)
                    self.assertEqual(record["owner_identity_status"], "unknown")
                    self.assertEqual(
                        record["owner_identity_error"],
                        "injected_owner_namespace_unavailable",
                    )
            self.assertFalse(lock_path.exists())

    def test_windows_stage_unlink_reseals_shared_cas_object(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-lock-test-") as raw:
            root = Path(raw)
            store = source_store.SourceContentStore(root / "store")
            stage = root / "stage"
            stage.mkdir()
            source = root / "source"
            contents = b"re-seal after stage unlink\n"
            source.write_bytes(contents)
            stage_link = stage / "tracked.txt"
            stage_link.write_bytes(contents)
            digest = hashlib.sha256(contents).hexdigest()
            store.link_file(
                source,
                stage_link,
                digest=digest,
                mode="100644",
                size=len(contents),
            )
            object_path = store._object_path(digest, "100644")

            self.assertTrue(
                store.unlink_stage_link(
                    stage_link,
                    digest=digest,
                    mode="100644",
                    size=len(contents),
                )
            )
            self.assertFalse(stage_link.exists())
            metadata = store._verify_object(
                object_path,
                digest=digest,
                mode="100644",
                size=len(contents),
            )
            self.assertTrue(source_store._is_readonly(object_path, metadata))

    def test_parallel_captures_share_verified_objects_and_keep_v1_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            first = root / "capsule-one"
            second = root / "capsule-two"
            first.mkdir()
            second.mkdir()

            def capture(output: Path):
                return capture_source(repo, output, content_store=store)

            with ThreadPoolExecutor(max_workers=2) as executor:
                manifests = list(executor.map(capture, (first, second)))

            self.assertEqual(manifests[0]["schema_version"], "fullmag.source-capsule.v1")
            self.assertEqual(manifests[0]["source_digest"], manifests[1]["source_digest"])
            self.assertEqual(manifests[0]["files"], manifests[1]["files"])
            for output, manifest in ((first, manifests[0]), (second, manifests[1])):
                verified = verify_source(output, manifest["source_digest"])
                self.assertEqual(verified["source_digest"], manifest["source_digest"])

            entry = next(item for item in manifests[0]["files"] if item["path"] == "tracked.txt")
            first_file = first / "tree" / "tracked.txt"
            second_file = second / "tree" / "tracked.txt"
            object_file = _object_path(store, entry)
            self.assertTrue(os.path.samefile(first_file, second_file))
            self.assertTrue(os.path.samefile(first_file, object_file))
            if first_file.stat().st_nlink:
                self.assertGreaterEqual(first_file.stat().st_nlink, 3)
            self.assertFalse(object_file.with_name(object_file.name + ".lock").exists())

    def test_changed_bytes_get_a_distinct_object_and_execution_copy_is_private(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            first, first_manifest = _capture(repo, root, "capsule-one", store=store)
            first_entry = next(item for item in first_manifest["files"] if item["path"] == "tracked.txt")
            first_file = first / "tree" / "tracked.txt"
            object_file = _object_path(store, first_entry)
            original = first_file.read_bytes()

            execution = root / "execution"
            execution.mkdir()
            materialize_capsule(first_manifest, first, execution)
            execution_file = execution / "tracked.txt"
            self.assertFalse(os.path.samefile(execution_file, object_file))
            execution_file.write_bytes(b"private execution change\n")
            self.assertEqual(first_file.read_bytes(), original)
            self.assertEqual(object_file.read_bytes(), original)

            (repo / "tracked.txt").write_bytes(b"changed source\n")
            second, second_manifest = _capture(repo, root, "capsule-two", store=store)
            second_entry = next(item for item in second_manifest["files"] if item["path"] == "tracked.txt")
            second_file = second / "tree" / "tracked.txt"
            second_object = _object_path(store, second_entry)
            self.assertNotEqual(first_manifest["source_digest"], second_manifest["source_digest"])
            self.assertNotEqual(first_entry["sha256"], second_entry["sha256"])
            self.assertFalse(os.path.samefile(first_file, second_file))
            self.assertFalse(os.path.samefile(object_file, second_object))
            self.assertEqual(first_file.read_bytes(), original)
            self.assertEqual(second_file.read_bytes(), b"changed source\n")

    def test_store_and_legacy_capsules_preserve_dirty_snapshot_fidelity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            (repo / "tracked.txt").write_bytes(b"dirty tracked bytes\n")
            (repo / "deleted.txt").unlink()
            (repo / "input.txt").write_bytes(b"explicit untracked input\n")
            store = root / "storage" / "cache" / "source-content-v1"

            legacy, legacy_manifest = _capture(
                repo,
                root,
                "legacy-capsule",
                store=None,
                include_untracked=("input.txt",),
            )
            shared, shared_manifest = _capture(
                repo,
                root,
                "shared-capsule",
                store=store,
                include_untracked=("input.txt",),
            )

            self.assertEqual(legacy_manifest, shared_manifest)
            self.assertTrue(shared_manifest["dirty"])
            self.assertTrue(shared_manifest["working_tree_dirty"])
            self.assertEqual(shared_manifest["deleted"], ["deleted.txt"])
            self.assertEqual(shared_manifest["included_untracked"], ["input.txt"])
            self.assertEqual(
                (shared / "tree" / "tracked.txt").read_bytes(),
                b"dirty tracked bytes\n",
            )
            self.assertEqual(
                (shared / "tree" / "input.txt").read_bytes(),
                b"explicit untracked input\n",
            )
            self.assertFalse((shared / "tree" / "deleted.txt").exists())
            self.assertEqual(verify_source(legacy)["source_digest"], legacy_manifest["source_digest"])
            self.assertEqual(verify_source(shared)["source_digest"], shared_manifest["source_digest"])

    def test_zero_byte_and_executable_mode_have_separate_object_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root, script=True)
            (repo / "empty.txt").write_bytes(b"")
            _git(repo, "add", "empty.txt")
            _git(repo, "commit", "-qm", "empty input")
            store = root / "storage" / "cache" / "source-content-v1"

            first, first_manifest = _capture(repo, root, "capsule-one", store=store)
            empty = next(item for item in first_manifest["files"] if item["path"] == "empty.txt")
            self.assertEqual(empty["size"], 0)
            self.assertEqual(empty["sha256"], hashlib.sha256(b"").hexdigest())
            self.assertEqual(_object_path(store, empty).stat().st_size, 0)
            script_before = next(
                item for item in first_manifest["files"] if item["path"] == "program.sh"
            )

            _git(repo, "update-index", "--chmod=+x", "program.sh")
            _git(repo, "commit", "-qm", "mark script executable")
            second, second_manifest = _capture(
                repo,
                root,
                "capsule-two",
                store=store,
                mode="commit",
                ref="HEAD",
            )
            script_after = next(
                item for item in second_manifest["files"] if item["path"] == "program.sh"
            )
            self.assertEqual(script_before["sha256"], script_after["sha256"])
            self.assertEqual(script_before["mode"], "100644")
            self.assertEqual(script_after["mode"], "100755")
            self.assertNotEqual(
                _object_path(store, script_before),
                _object_path(store, script_after),
            )
            self.assertFalse(
                os.path.samefile(
                    _object_path(store, script_before),
                    _object_path(store, script_after),
                )
            )
            self.assertEqual(verify_source(first)["source_digest"], first_manifest["source_digest"])
            self.assertEqual(verify_source(second)["source_digest"], second_manifest["source_digest"])

    def test_corrupt_existing_object_is_rejected_without_replacing_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            first, first_manifest = _capture(repo, root, "capsule-one", store=store)
            entry = next(item for item in first_manifest["files"] if item["path"] == "tracked.txt")
            object_file = _object_path(store, entry)
            object_file.chmod(0o666)
            object_file.write_bytes(b"corrupt existing object\n")
            object_file.chmod(0o555 if entry["mode"] == "100755" else 0o444)

            output = root / "capsule-two"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "content object digest or size mismatch"):
                capture_source(repo, output, content_store=store)
            self.assertEqual(tuple(output.iterdir()), ())

    def test_reparse_object_and_store_overlap_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            digest = hashlib.sha256(b"committed source\n").hexdigest()
            object_parent = store / "sha256" / digest[:2]
            object_parent.mkdir(parents=True)
            outside = root / "outside-object"
            outside.write_bytes(b"committed source\n")
            object_file = object_parent / f"{digest}-100644"
            try:
                object_file.symlink_to(outside)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlinks unavailable: {error}")

            output = root / "capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "symlink or reparse point"):
                capture_source(repo, output, content_store=store)
            self.assertEqual(tuple(output.iterdir()), ())

            overlap_output = root / "overlap-capsule"
            overlap_output.mkdir()
            with self.assertRaisesRegex(SourceError, "overlaps the repository"):
                capture_source(repo, overlap_output, content_store=repo / "cache")
            self.assertEqual(tuple(overlap_output.iterdir()), ())

            dangling_target = root / "missing-target"
            dangling_store = root / "dangling-store"
            try:
                dangling_store.symlink_to(dangling_target, target_is_directory=True)
            except (OSError, NotImplementedError):
                pass
            else:
                escaped_output = root / "escaped-capsule"
                escaped_output.mkdir()
                with self.assertRaisesRegex(SourceError, "symlink or reparse point"):
                    capture_source(
                        repo,
                        escaped_output,
                        content_store=dangling_store / "source-content-v1",
                    )
                self.assertEqual(tuple(escaped_output.iterdir()), ())

    def test_atomic_publication_failure_does_not_fall_back_to_copy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            output = root / "capsule"
            output.mkdir()
            real_link = os.link

            def fail_object_link(source, destination, *args, **kwargs):
                if Path(destination).name.endswith(".lock"):
                    return real_link(source, destination, *args, **kwargs)
                raise OSError("simulated object publication failure")

            with patch.object(source_store.os, "link", side_effect=fail_object_link):
                with self.assertRaisesRegex(SourceError, "atomic content object publication failed"):
                    capture_source(repo, output, content_store=store)
            self.assertEqual(tuple(output.iterdir()), ())
            self.assertEqual(
                tuple(store.glob("sha256/*/*.lock")),
                (),
            )

    def test_failed_post_publication_verification_removes_readonly_object(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store_path = root / "storage" / "cache" / "source-content-v1"
            output = root / "capsule"
            output.mkdir()
            store = source_store.SourceContentStore(store_path)
            with patch.object(
                source_store.SourceContentStore,
                "_verify_object",
                side_effect=source_store.SourceContentStoreError("simulated mismatch"),
            ):
                with self.assertRaisesRegex(SourceError, "simulated mismatch"):
                    capture_source(repo, output, content_store=store_path)

            digest = hashlib.sha256(b"committed source\n").hexdigest()
            object_file = store._object_path(digest, "100644")
            self.assertFalse(object_file.exists())
            self.assertFalse(object_file.with_name(object_file.name + ".lock").exists())
            self.assertEqual(tuple(output.iterdir()), ())

    def test_partial_capture_failure_cleans_stage_link_and_keeps_cas_sealed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store_path = root / "storage" / "cache" / "source-content-v1"
            output = root / "capsule"
            output.mkdir()
            real_link = os.link
            link_calls = 0

            def fail_second_object_publication(source, destination, *args, **kwargs):
                nonlocal link_calls
                if Path(destination).name.endswith(".lock"):
                    return real_link(source, destination, *args, **kwargs)
                link_calls += 1
                if link_calls == 3:
                    raise OSError("simulated second-object publication failure")
                return real_link(source, destination, *args, **kwargs)

            with patch.object(
                source_store.os,
                "link",
                side_effect=fail_second_object_publication,
            ):
                with self.assertRaisesRegex(
                    SourceError,
                    "atomic content object publication failed",
                ):
                    capture_source(repo, output, content_store=store_path)

            first_digest = hashlib.sha256(b"delete me\n").hexdigest()
            first_object = store_path / "sha256" / first_digest[:2] / f"{first_digest}-100644"
            store = source_store.SourceContentStore(store_path)
            first_metadata = store._verify_object(
                first_object,
                digest=first_digest,
                mode="100644",
                size=len(b"delete me\n"),
            )
            self.assertEqual(first_object.read_bytes(), b"delete me\n")
            if first_object.stat().st_nlink:
                self.assertEqual(first_object.stat().st_nlink, 1)
            self.assertEqual(link_calls, 3)
            self.assertEqual(tuple(output.iterdir()), ())
            self.assertEqual(tuple(root.glob(".capsule.capture-*")), ())
            if os.name != "nt":
                self.assertEqual(first_metadata.st_mode & 0o777, 0o444)


class SourceCopyDiagnosticsTests(unittest.TestCase):
    def test_copy_failure_keeps_system_error_in_operator_message(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input"
            source.write_bytes(b"immutable source")
            original = source.read_bytes()
            store = source_store.SourceContentStore(root / "store")
            failure = OSError(5, "Input/output error")
            with patch.object(source_store.os, "fsync", side_effect=failure):
                with self.assertRaises(source_store.SourceContentStoreError) as raised:
                    store._copy_to_temporary(source, root / "temporary", digest=hashlib.sha256(original).hexdigest(), size=len(original))
            self.assertIn("errno=5", str(raised.exception))
            self.assertIn("Input/output error", str(raised.exception))
            self.assertIs(raised.exception.__cause__, failure)
            self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
