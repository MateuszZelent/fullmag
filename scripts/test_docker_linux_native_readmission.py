"""Run the real readmission lock protocol on private, disposable evidence."""
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_linux_native_readmission as recovery


class ReadmissionRequestTests(unittest.TestCase):
    def request(self):
        return {"schema": recovery.SCHEMA, "source_revision": "a" * 40,
            "controller_inputs": {n: "b" * 64 for n in recovery.CONTROLLERS},
            "boot_id": "12345678-1234-1234-1234-123456789abc", "engine_id": "retained-engine",
            "compose_path": "development/attempts/" + "c" * 32 + "/compose.json",
            "compose_sha256": "d" * 64,
            "failed_resume_path": "resume/attempts/" + "e" * 32 + "/terminal.json",
            "failed_resume_sha256": "f" * 64,
            "containers": {s: {"id": n * 64, "fingerprint": "a" * 64,
                "state": {"Status": "exited", "Running": False, "Pid": 0, "OOMKilled": False}}
                for s, n in (("backend", "1"), ("frontend", "2"))},
            "native_pins": {n: "a" * 64 for n in recovery.NATIVE_PINS},
            "storage_pins": {"engine_id": "retained-engine"}}

    def test_closed_request_accepts_only_exact_stopped_services(self):
        r = self.request(); recovery.validate_request(r)
        for key, value in (("Running", True), ("Pid", 42), ("Status", "running"), ("OOMKilled", True)):
            with self.subTest(key=key):
                bad = copy.deepcopy(r); bad["containers"]["backend"]["state"][key] = value
                with self.assertRaises(recovery.BuildControlError): recovery.validate_request(bad)
        for field in ("controller_inputs", "native_pins"):
            bad = copy.deepcopy(r); bad[field].pop(next(iter(bad[field])))
            with self.assertRaises(recovery.BuildControlError): recovery.validate_request(bad)
        bad = copy.deepcopy(r); bad["permit_running"] = True
        with self.assertRaises(recovery.BuildControlError): recovery.validate_request(bad)

    def test_observe_uses_real_storage_resolver_and_rejects_changed_incarnation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "checkout"; (source / "scripts").mkdir(parents=True)
            state = root / "runtime/state"; state.mkdir(parents=True)
            r = self.request(); r["boot_id"] = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            r["storage_pins"].update(state_root=str(state), image_id="sha256:" + "b" * 64)
            for name in recovery.CONTROLLERS:
                (source / "scripts" / name).write_bytes(b"controller")
                r["controller_inputs"][name] = recovery.digest(b"controller")
            actuals = []
            for service, pin in r["containers"].items():
                mounts = ([{"Destination": "/state", "Source": str(state), "Type": "bind", "RW": True},
                    {"Destination": "/opt/fullmag/source", "Source": str(source), "Type": "bind", "RW": False}]
                    if service == "backend" else [])
                actual = {"Id": pin["id"], "Image": r["storage_pins"]["image_id"],
                    "Config": {"Labels": {"com.docker.compose.service": service}}, "HostConfig": {},
                    "Mounts": mounts, "State": copy.deepcopy(pin["state"])}
                pin["fingerprint"] = recovery.fingerprint(actual); actuals.append(actual)
            compose = recovery.canonical({"name": "our-group"})
            terminal = recovery.canonical({"compose_project": "our-group", "state": "failed-confirmed"})
            r["compose_sha256"] = recovery.digest(compose); r["failed_resume_sha256"] = recovery.digest(terminal)
            live = []
            def capture(*args):
                if args[0] == "info": raw = b"retained-engine\n"
                elif args[0] == "inspect": raw = json.dumps(actuals if set(args[1:]) == {a["Id"] for a in actuals} else live).encode()
                elif args[0] == "ps": raw = ("\n".join(a["Id"] for a in actuals).encode()
                                              if "--all" in args else "\n".join(a["Id"] for a in live).encode())
                else: self.fail("unexpected Docker operation: " + repr(args))
                return SimpleNamespace(stdout=raw)
            def host_run(args, **kwargs):
                if args[0] == "findmnt":
                    alias = Path(args[args.index("--target") + 1])
                    return SimpleNamespace(returncode=0, stdout=json.dumps({"filesystems": [
                        {"target": str(alias), "fsroot": str(alias.resolve())}]}).encode())
                return SimpleNamespace(stdout=(r["source_revision"] + "\n").encode())
            control = SimpleNamespace(namespace="", project="our-group", volume="our-control")
            with patch.object(recovery, "docker_capture", side_effect=capture), patch.object(
                    recovery, "read_raw", side_effect=lambda c,p: compose if p == r["compose_path"] else terminal), patch.object(
                    recovery.subprocess, "run", side_effect=host_run), patch(
                    "docker_volume_stop_unadmitted._runtime_control_volume_mount", return_value=("our-control", "runtime-control")):
                resolved = recovery.observe(control, source, {"runtime_root": str(root / "runtime")}, r)
                self.assertEqual(resolved[0], state)
                aliases = root / "aliases"; (aliases / "Ubuntu").mkdir(parents=True)
                for mount, target, token in zip(actuals[0]["Mounts"], (state, source), ("1", "2")):
                    (aliases / "Ubuntu" / (token * 64)).symlink_to(target, target_is_directory=True)
                    mount["Source"] = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/" + token * 64
                r["containers"]["backend"]["fingerprint"] = recovery.fingerprint(actuals[0])
                with patch("docker_dev_browser_qa.LOCAL_WSL_BIND_MOUNT_ROOT", aliases):
                    self.assertEqual(recovery.observe(control, source, {"runtime_root": str(root / "runtime")}, r)[0], state)
                    nested = state / "runs"; nested.mkdir()
                    (aliases / "Ubuntu" / ("3" * 64)).symlink_to(nested, target_is_directory=True)
                    live.append({"Id": "3" * 64, "Name": "/foreign-live", "Mounts": [{"Type": "bind",
                        "Source": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/" + "3" * 64}]})
                    with self.assertRaisesRegex(recovery.BuildControlError, "live container consumes"):
                        recovery.observe(control, source, {"runtime_root": str(root / "runtime")}, r)
                    live.clear()
                    alias = aliases / "Ubuntu" / ("2" * 64)
                    alias.unlink(); alias.symlink_to(state, target_is_directory=True)
                    with self.assertRaisesRegex(recovery.BuildControlError, "source/storage image differs"):
                        recovery.observe(control, source, {"runtime_root": str(root / "runtime")}, r)
                    alias.unlink(); alias.symlink_to(source, target_is_directory=True)
                actuals[0]["State"]["Running"] = True
                with self.assertRaisesRegex(recovery.BuildControlError, "incarnation changed"):
                    recovery.observe(control, source, {"runtime_root": str(root / "runtime")}, r)

    def test_foreign_windows_bind_requires_native_fixed_no_reparse_proof(self):
        proof = {"schema": "fullmag.windows-bind-disjoint.v1", "path": "D:\\foreign\\storage",
                 "filesystem": "NTFS", "fixed": True, "no_reparse": True}
        def observe(value):
            with patch.object(recovery.subprocess, "run", return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps(value).encode())) as call:
                result = recovery.live_bind_path("D:\\foreign\\storage")
                self.assertEqual(json.loads(call.call_args.kwargs["input"])["path"], "D:/foreign/storage")
                return result
        self.assertIsNone(observe(proof))
        for key, value in (("no_reparse", False), ("fixed", False), ("filesystem", "CIFS"),
                           ("path", "D:\\another\\storage")):
            with self.subTest(key=key), self.assertRaises(recovery.BuildControlError):
                observe(dict(proof, **{key: value}))
        with self.assertRaises(recovery.BuildControlError): recovery.live_bind_path("\\\\wsl.localhost\\Ubuntu\\home\\owner")

    def test_v2_requires_exact_original_request_and_preparation_authority(self):
        original = self.request(); previous = recovery.canonical(original) + b"\n"
        archive = b'{"exact":"original bytes"}\n'
        request = copy.deepcopy(original); request["schema"] = recovery.REPLAY_SCHEMA
        retained = {"request": "verification/original/request.json", "request_sha256": recovery.digest(previous),
                    "preparation_sha256": recovery.digest(archive), "marker_sha256": "a" * 64}
        request["retained_preparation"] = retained
        recovery.validate_request(request)
        files = {retained["request"]: previous,
                 "verification/linux-native-readmission/" + retained["request_sha256"] + "/preparation.json": archive}
        with patch.object(recovery, "read_raw", side_effect=lambda c,p: files[p]):
            self.assertEqual(recovery.retained_preparation_raw(None, request), archive)
            for field, value in (("boot_id", "00000000-1234-1234-1234-123456789abc"),
                                 ("native_pins", {n: "e" * 64 for n in recovery.NATIVE_PINS}),
                                 ("storage_pins", {"engine_id": "retained-engine", "foreign": True})):
                with self.subTest(field=field):
                    changed = copy.deepcopy(request); changed[field] = value
                    with self.assertRaisesRegex(recovery.BuildControlError, "authority differs"):
                        recovery.retained_preparation_raw(None, changed)
            files[retained["request"]] = previous + b" "
            with self.assertRaisesRegex(recovery.BuildControlError, "request CAS differs"):
                recovery.retained_preparation_raw(None, request)
            files[retained["request"]] = previous
            files[next(p for p in files if p != retained["request"])] = archive + b" "
            with self.assertRaisesRegex(recovery.BuildControlError, "preparation CAS differs"):
                recovery.retained_preparation_raw(None, request)
        legacy = copy.deepcopy(original); legacy["retained_preparation"] = retained
        with self.assertRaises(recovery.BuildControlError): recovery.validate_request(legacy)

    def test_archive_roundtrips_raw_bytes_and_rejects_invalid_encoding(self):
        p = {"original": {"first": b'\x00\xff\n\r'}, "candidate_raw": b'{"x":1}\n',
             "pins": {"unchanged": True}, "candidate_sha256": "a" * 64}
        encoded = recovery.archive_preparation(p)
        self.assertEqual(recovery.restore_preparation(json.loads(json.dumps(encoded))), p)
        encoded["candidate_raw"] = "!not-base64"
        with self.assertRaises(ValueError): recovery.restore_preparation(encoded)


@unittest.skipUnless(os.name == "posix", "Storage shell requires Bash")
class ReadmissionShellTests(unittest.TestCase):
    def test_actual_storage_shell_routes_exact_argv_without_host_resolver(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); scripts = root / "scripts"; scripts.mkdir()
            shell = scripts / "just_storage_shell.sh"
            shell.write_bytes((Path(__file__).parent / shell.name).read_bytes())
            (scripts / "fullmag_storage.py").write_text("raise RuntimeError('host resolver must not run')\n")
            controller = scripts / "docker_linux_native_readmission.py"
            controller.write_text("import json,sys; print(json.dumps(sys.argv[1:]))\n")
            args = ["--request", "verification/request.json", "--request-sha256", "a" * 64,
                    "--source-root", "/chosen/worktree", "--image-id", "sha256:" + "b" * 64]
            body = 'python3 "' + str(controller) + '" ' + " ".join(
                [args[i] + " '" + args[i + 1] + "'" for i in range(0, len(args), 2)])
            env = dict(os.environ, FULLMAG_STORAGE_PYTHON=sys.executable)
            for suffix in ("", " --apply"):
                p = subprocess.run(["bash", str(shell), body + suffix], env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
                self.assertEqual(p.returncode, 0, p.stderr.decode())
                self.assertEqual(json.loads(p.stdout), args + (["--apply"] if suffix else []))
            p = subprocess.run(["bash", str(shell), body + "; echo bypass"], env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            self.assertNotEqual(p.returncode, 0)
            self.assertNotIn(b"bypass", p.stdout)


@unittest.skipUnless(os.name == "posix", "Guard requires shared POSIX flock inodes")
class ReadmissionGuardTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.control = self.root / "control"
        self.ledger = self.root / "host-ledger/ledger"
        self.store = self.root / "retained"
        for d in (self.control / "runtime-control/runtime-services", self.ledger, self.store):
            d.mkdir(parents=True)
        self.locks = [self.control / "operation.lock", *[
            self.control / "runtime-control/runtime-services" / name
            for name in ("STARTUP-GATE.lock", "LAUNCH.lock", "OWNER.lock")],
            self.ledger / "WRITER.lock", self.store / "WRITER.lock"]
        for p in self.locks: p.write_bytes(b"")
        self.ledger_path = self.ledger / "HOST_RESOURCE_LEDGER.json"
        self.ledger_path.write_text(json.dumps({"reservations": [{"state": "released"}]}))
        self.evidence = self.control / "runtime-control/runtime-services/OWNER.json"
        self.evidence.write_text('{"state":"ready","preserve":true}')
        self.payload = {"control_pins": {self.evidence.relative_to(self.control).as_posix():
                                        recovery.digest(self.evidence.read_bytes())}}
        (self.store / "result.bin").write_bytes(b"scientific result")
        self.code = recovery.GUARD.replace("/control", str(self.control)).replace(
            "/host-ledger", str(self.root / "host-ledger")).replace("/retained", str(self.store))

    def launch(self):
        p = subprocess.Popen([sys.executable, "-I", "-B", "-c", self.code],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.close, p)
        p.stdin.write(json.dumps(self.payload).encode() + b"\n"); p.stdin.flush()
        return p

    @staticmethod
    def close(p):
        if p.stdin and not p.stdin.closed: p.stdin.close()
        p.wait(timeout=5)
        p.stdout.close(); p.stderr.close()

    def line(self, p):
        self.assertTrue(select.select([p.stdout], [], [], 5)[0], "guard handshake timed out")
        raw = p.stdout.readline()
        if not raw: self.fail(p.stderr.read().decode())
        return json.loads(raw)

    def test_protocol_holds_all_locks_and_preserves_all_science(self):
        before = (self.store / "result.bin").read_bytes()
        p = self.launch(); locked = self.line(p)
        self.assertEqual(locked["state"], "locked")
        for path in self.locks:
            with path.open("rb") as f:
                with self.assertRaises(BlockingIOError): fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        p.stdin.write(b"CHECK\n"); p.stdin.flush()
        self.assertEqual(self.line(p), {"state": "preserved", "snapshot": locked["snapshot"]})
        p.stdin.write(b"RELEASE\n"); p.stdin.flush(); p.stdin.close()
        self.assertEqual(p.wait(timeout=5), 0)
        self.assertEqual((self.store / "result.bin").read_bytes(), before)
        self.assertEqual(self.evidence.read_text(), '{"state":"ready","preserve":true}')

    def test_eof_before_publication_releases_locks_without_writes(self):
        p = self.launch(); self.line(p); p.stdin.close()
        self.assertNotEqual(p.wait(timeout=5), 0)
        for path in self.locks:
            with path.open("rb") as f: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertEqual((self.store / "result.bin").read_bytes(), b"scientific result")

    def test_busy_lock_active_operation_and_unreleased_ledger_refuse(self):
        for path in self.locks:
            with self.subTest(lock=path.name), path.open("rb") as f:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                p = self.launch(); p.stdin.close(); self.assertNotEqual(p.wait(timeout=5), 0)
        (self.control / "active").write_text("other-operation")
        p = self.launch(); p.stdin.close(); self.assertNotEqual(p.wait(timeout=5), 0)
        (self.control / "active").unlink()
        self.ledger_path.write_text('{"reservations":[{"state":"active"}]}')
        p = self.launch(); p.stdin.close(); self.assertNotEqual(p.wait(timeout=5), 0)

    def test_science_or_native_pin_drift_fails_recheck(self):
        for path in (self.store / "result.bin", self.evidence, self.ledger_path):
            with self.subTest(path=path.name):
                original = path.read_bytes(); p = self.launch(); self.line(p)
                path.write_bytes(original + b"drift")
                p.stdin.write(b"CHECK\n"); p.stdin.flush(); p.stdin.close()
                self.assertNotEqual(p.wait(timeout=5), 0)
                path.write_bytes(original)

    @unittest.skipIf(os.geteuid() == 0, "Permission regression requires the normal non-root helper")
    def test_unreadable_store_directory_refuses_incomplete_snapshot(self):
        hidden = self.store / "unreadable"
        hidden.mkdir(); (hidden / "retained.bin").write_bytes(b"must not be omitted")
        hidden.chmod(0)
        try:
            p = self.launch(); p.stdin.close()
            self.assertNotEqual(p.wait(timeout=5), 0)
            self.assertIn(b"PermissionError", p.stderr.read())
        finally:
            hidden.chmod(0o700)

    def test_more_than_64_files_supported_and_linked_science_refused(self):
        for i in range(70): (self.store / (str(i) + ".bin")).write_bytes(b"history")
        p = self.launch(); self.assertGreater(self.line(p)["snapshot"]["file_count"], 64)
        p.stdin.close(); p.wait(timeout=5)
        (self.store / "linked").symlink_to(self.evidence)
        p = self.launch(); p.stdin.close(); self.assertNotEqual(p.wait(timeout=5), 0)


if __name__ == "__main__": unittest.main()
