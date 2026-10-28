"""Interpreted recovery fences, real flock/CAS and partial-publication fault tests."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import docker_volume_reconcile as recovery


class RawControlReadTests(unittest.TestCase):
    def read(self, root, relative):
        control = type('Control', (), {
            'path': staticmethod(lambda path: '/control/' + path),
            'helper_args': staticmethod(lambda script: ['bash', '-euo', 'pipefail', '-c',
                                                        script.replace('/control', str(root))]),
        })()
        def capture(arguments, *, data):
            return subprocess.run(arguments, input=data, capture_output=True, timeout=5)
        with patch.object(recovery, 'bounded_capture', side_effect=capture):
            return recovery.read_raw(control, relative, optional=True)

    def test_optional_read_distinguishes_genuine_absence_and_regular_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'attempt').mkdir()
            self.assertIsNone(self.read(root, 'attempt/receipt.json'))
            (root/'attempt'/'receipt.json').write_bytes(b'exact retained bytes\n')
            self.assertEqual(self.read(root, 'attempt/receipt.json'), b'exact retained bytes\n')

    def test_dangling_leaf_or_parent_is_integrity_failure_and_is_preserved(self):
        for parent_link in (False, True):
            with self.subTest(parent_link=parent_link), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if parent_link:
                    link = root/'attempt'
                    link.symlink_to(root/'missing-directory', target_is_directory=True)
                else:
                    (root/'attempt').mkdir()
                    link = root/'attempt'/'receipt.json'
                    link.symlink_to(root/'missing-receipt')
                with self.assertRaises(recovery.BuildControlError):
                    self.read(root, 'attempt/receipt.json')
                self.assertTrue(link.is_symlink())
                self.assertFalse(link.exists())


class RequestFences(unittest.TestCase):
    def request(self):
        return {"schema": recovery.SCHEMA, "attempt": "1"*32, "compose_project": "fullmag-test", "source_root": "/source",
            "port": 3202, "config_sha256": "2"*64, "unknown_receipt_sha256": "3"*64, "controller_sha256": "4"*64,
            "containers": {n: {"id": str(j+5)*64, "image": "sha256:"+"6"*64, "started_at": "start", "fingerprint": "7"*64}
                for j, n in enumerate(("lease", "backend", "frontend"))}, "package_documents": {"receipt": "8"*64, "provenance": "9"*64}}

    def test_closed_request_schema(self):
        recovery.validate_request(self.request())
        for key, value in (("schema", "unknown"), ("attempt", "../other"), ("port", True), ("port", 80),
                           ("unknown_receipt_sha256", "short"), ("controller_sha256", None),
                           ("containers", {}), ("package_documents", {"receipt": "8"*64})):
            with self.subTest(key=key), self.assertRaises(recovery.BuildControlError):
                request = self.request(); request[key] = value; recovery.validate_request(request)
        request = self.request(); request["restart"] = True
        with self.assertRaises(recovery.BuildControlError): recovery.validate_request(request)

    def test_incarnation_config_mount_and_ownership_fences(self):
        actual = {"Id": "1"*64, "Image": "sha256:"+"2"*64,
            "State": {"Running": True, "StartedAt": "exact"},
            "Config": {"Labels": {"com.docker.compose.project": "fullmag-test"}},
            "HostConfig": {"ReadonlyRootfs": True}, "Mounts": [{"Name": "owned", "Destination": "/build"}]}
        pin = {"id": actual["Id"], "image": actual["Image"], "started_at": "exact", "fingerprint": recovery.fingerprint(actual)}
        recovery.validate_incarnation(actual, pin, "fullmag-test")
        for field, value in (("Id", "3"*64), ("Image", "sha256:"+"4"*64), ("Mounts", []),
                             ("Config", {"Labels": {"com.docker.compose.project": "foreign"}}),
                             ("State", {"Running": True, "StartedAt": "restarted"}),
                             ("State", {"Running": False, "StartedAt": "exact"})):
            with self.subTest(field=field), self.assertRaises(recovery.BuildControlError):
                changed = copy.deepcopy(actual); changed[field] = value
                recovery.validate_incarnation(changed, pin, "fullmag-test")


class MountFingerprintFences(unittest.TestCase):
    def container(self):
        return {"Id": "1"*64, "Image": "sha256:"+"2"*64,
            "State": {"Running": True, "StartedAt": "exact"},
            "Config": {"Labels": {"com.docker.compose.project": "fullmag-test"}},
            "HostConfig": {"ReadonlyRootfs": True},
            "Mounts": [{"Type": "volume", "Name": "owned", "Source": "/volume", "Driver": "local",
                "Mode": "rw", "RW": True, "Propagation": "", "Destination": "/build"},
                {"Type": "bind", "Source": "/checkout", "Mode": "ro", "RW": False,
                 "Propagation": "rprivate", "Destination": "/source"},
                {"Type": "volume", "Name": "package", "Source": "/package", "RW": True, "Destination": "/package"}]}

    def test_every_mount_permutation_preserves_fingerprint_and_incarnation(self):
        import itertools
        actual = self.container(); before = copy.deepcopy(actual)
        pin = {"id": actual["Id"], "image": actual["Image"], "started_at": "exact", "fingerprint": recovery.fingerprint(actual)}
        for order in itertools.permutations(actual["Mounts"]):
            candidate = {**actual, "Mounts": list(order)}
            self.assertEqual(recovery.fingerprint(candidate), pin["fingerprint"])
            recovery.validate_incarnation(candidate, pin, "fullmag-test")
        self.assertEqual(actual, before)

    def test_every_mount_field_remains_part_of_exact_fence(self):
        actual = self.container()
        pin = {"id": actual["Id"], "image": actual["Image"], "started_at": "exact", "fingerprint": recovery.fingerprint(actual)}
        for key, value in (("Type", "bind"), ("Name", "foreign"), ("Source", "/other"), ("Driver", "other"),
                           ("Mode", "ro"), ("RW", False), ("Propagation", "shared"), ("Destination", "/other"),
                           ("NewDockerMountField", "must-retain")):
            with self.subTest(key=key):
                changed = copy.deepcopy(actual); changed["Mounts"][0][key] = value
                self.assertNotEqual(recovery.fingerprint(changed), pin["fingerprint"])
                with self.assertRaises(recovery.BuildControlError):
                    recovery.validate_incarnation(changed, pin, "fullmag-test")

    def test_malformed_or_duplicate_destinations_are_rejected(self):
        actual = self.container()
        for destination in (None, 12, "", "relative", "/build/../source", "/build/.", "/build/", "//build", "/nul\x00path"):
            with self.subTest(destination=destination), self.assertRaises(recovery.BuildControlError):
                changed = copy.deepcopy(actual); changed["Mounts"][0]["Destination"] = destination
                recovery.fingerprint(changed)
        for mounts in (None, {}, "bad", [False], [{"Name": "missing-destination"}],
                       [{"Destination": "/same"}, {"Destination": "/same"}]):
            with self.subTest(mounts=mounts), self.assertRaises(recovery.BuildControlError):
                recovery.fingerprint({**actual, "Mounts": mounts})


class JournalAndOwnerFences(unittest.TestCase):
    def test_multiple_interrupted_retries_keep_each_prior_receipt_admissible(self):
        entries = {}
        control = type("Control", (), {"read": staticmethod(lambda path: entries[path])})()
        original_sha = "a"*64; request_sha = "b"*64
        root = "iteration/attempts/"+"1"*32+"/reconciliation"
        previous = []
        for number in range(4):
            raw = json.dumps({"state": "succeeded", "observer": number}).encode()
            result_sha = recovery.digest(raw)
            # A crash after preparing retryN cannot invalidate any older receipt.
            entries[root+"/"+result_sha+"/prepared.json"] = {"request_sha256": request_sha,
                "unknown_receipt_sha256": original_sha, "result_sha256": result_sha}
            previous.append(raw)
            for old in previous:
                recovery.validate_partial_journal(control, root, old, original_sha, request_sha)
        altered = copy.deepcopy(entries)
        key = root+"/"+recovery.digest(previous[0])+"/prepared.json"
        entries[key]["request_sha256"] = "c"*64
        with self.assertRaises(recovery.BuildControlError):
            recovery.validate_partial_journal(control, root, previous[0], original_sha, request_sha)

    def test_backend_cannot_substitute_original_lease_owner(self):
        actual = {"Name": "/fullmag-control-"+"1"*32, "Image": "sha256:"+"2"*64,
            "Config": {"User": "65532:65532", "Labels": {"com.docker.compose.service": "build-control"}},
            "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False},
            "Mounts": [{"Type": "volume", "Destination": "/control", "Name": "owned", "RW": True}]}
        original = {"helper_container": "fullmag-control-"+"1"*32}
        control = type("Control", (), {"volume": "owned"})()
        recovery.validate_original_owner(actual, original, control, actual["Image"])
        for changed in ({**actual, "Name": "/backend"}, {**actual, "Mounts": []},
                        {**actual, "Config": {"User": "65532:65532", "Labels": {"com.docker.compose.service": "backend"}}}):
            with self.assertRaises(recovery.BuildControlError):
                recovery.validate_original_owner(changed, original, control, actual["Image"])
        request = RequestFences().request(); request["containers"]["lease"] = request["containers"]["backend"]
        with self.assertRaises(recovery.BuildControlError): recovery.validate_request(request)


class ShellTransactions(unittest.TestCase):
    def setUp(self):
        self.owner = Path(tempfile.gettempdir()) / "reconcile-test-artifacts"
        self.owner.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.owner)
        self.base = Path(self.temporary.name)
        self.root = "iteration/attempts/" + "1"*32
        self.attempt_root = self.base / self.root
        self.attempt_root.mkdir(parents=True)
        self.original = b'{"state":"outcome-unknown-resources-retained"}\n'
        (self.attempt_root / "receipt.json").write_bytes(self.original)
        (self.attempt_root / "unknown-receipt.json").write_bytes(self.original)
        (self.base / "active").write_text("1"*32+"\n")
        (self.base / "operation.lock").touch()
        self.request = {"attempt": "1"*32, "unknown_receipt_sha256": recovery.digest(self.original)}
        self.control = type("Control", (), {"path": staticmethod(lambda p: "/control/"+p)})()
        self.children = []

    def tearDown(self):
        for child in reversed(self.children):
            if child.stdin and not child.stdin.closed: child.stdin.close()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
            for stream in (child.stdout, child.stderr):
                if stream: stream.close()
        self.temporary.cleanup()

    def script(self, text): return text.replace("/control", str(self.base))

    def original_lease(self):
        child = subprocess.Popen(["flock", "-x", str(self.base / "operation.lock"), "bash", "-c", "printf 'READY\\n'; cat >/dev/null"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(child); self.assertEqual(child.stdout.readline(), b"READY\n"); return child

    def claim(self):
        return self.script(recovery.claim_script(self.control, self.root, self.request, recovery.digest(self.original)))

    def test_no_original_lease_refuses_and_preserves_unknown(self):
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", self.claim()], input=b"", capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 72)
        self.assertNotIn(b"READY", result.stdout)
        self.assertEqual((self.base / "active").read_text().strip(), "1"*32)
        self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), self.original)

    def test_concurrent_reconciler_cannot_claim(self):
        self.original_lease()
        child = subprocess.Popen(["bash", "-euo", "pipefail", "-c", self.claim()], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(child); self.assertEqual(child.stdout.readline(), b"READY\n")
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", self.claim()], input=b"", capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b"READY", result.stdout)
        self.assertEqual((self.base / "active").read_text().strip(), "1"*32)

    def test_false_active_or_changed_receipt_refuses(self):
        self.original_lease()
        for path, changed in ((self.base / "active", b"2"*32), (self.attempt_root / "receipt.json", b"changed")):
            old = path.read_bytes(); path.write_bytes(changed)
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", self.claim()], input=b"", capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0); self.assertNotIn(b"READY", result.stdout)
            path.write_bytes(old)

    def result(self):
        journal = self.root+"/reconciliation"
        result = b'{"state":"succeeded","gates":"completed"}\n'
        folder = self.base / journal; folder.mkdir(exist_ok=True)
        (folder / "result.json").write_bytes(result)
        return journal, result

    def assert_failure_publication(self, schema):
        self.original_lease()
        verified = self.base / "iteration/verified.json"
        verified.write_bytes(b"previous verified package")
        result = b'{"state":"failed-confirmed"}\n'
        journal = self.root + "/reconciliation/" + recovery.digest(result)
        folder = self.base / journal; folder.mkdir(parents=True)
        (folder / "result.json").write_bytes(result)
        request = {**self.request, "schema": schema}
        script = self.script(recovery.claim_script(self.control, self.root, request,
            recovery.digest(self.original), publish_verified=False))
        outcome = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
            input=b"BEGIN\nCOMMIT " + recovery.digest(result).encode() + b"\n",
            capture_output=True, timeout=5)
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        self.assertEqual((self.attempt_root / "terminal.json").read_bytes(), result)
        self.assertEqual((self.base / "iteration/current.json").read_bytes(), result)
        self.assertEqual(verified.read_bytes(), b"previous verified package")
        self.assertEqual((self.base / "active").read_text().strip(), "1"*32)
        self.assertIsNone(self.children[0].poll())

    def test_failed_build_publication_preserves_previous_verified_and_active_owner(self):
        self.assert_failure_publication(recovery.FAILED_BUILD_SCHEMA)

    def test_cgroup_failure_publication_preserves_previous_verified_and_active_owner(self):
        self.assert_failure_publication(recovery.CGROUP_FAILURE_SCHEMA)

    def activation_case(self):
        self.root = "activation/attempts/" + "1"*32
        self.attempt_root = self.base / self.root
        self.attempt_root.mkdir(parents=True)
        for name in ("receipt.json", "unknown-receipt.json"):
            (self.attempt_root / name).write_bytes(self.original)
        marker_relative = "backend/script-activation-" + "2"*64 + "/activation.json"
        marker = self.base / marker_relative
        marker.parent.mkdir(parents=True)
        marker.write_bytes(b'{"state":"started"}\n')
        terminal_marker = b'{"state":"rejected"}\n'
        result = b'{"state":"failed-confirmed","activation_state":"rejected"}\n'
        journal = self.root + "/reconciliation/" + recovery.digest(result)
        folder = self.base / journal
        folder.mkdir(parents=True)
        (folder / "result.json").write_bytes(result)
        (folder / "marker.json").write_bytes(terminal_marker)
        request = {**self.request, "schema": recovery.ACTIVATION_PREFLIGHT_SCHEMA,
                   "marker_relative": marker_relative, "started_marker_sha256": recovery.digest(marker.read_bytes()),
                   "prepared_marker_sha256": recovery.digest(terminal_marker)}
        script = self.script(recovery.commit_script(self.control, self.root, request, journal,
            recovery.digest(result), recovery.digest(self.original), phase="activation", publish_verified=False))
        return marker, terminal_marker, result, folder, script

    def test_activation_commit_publishes_marker_before_terminal_and_preserves_original(self):
        marker, terminal_marker, result, folder, script = self.activation_case()
        outcome = subprocess.run(["bash", "-euo", "pipefail", "-c", script], capture_output=True, timeout=5)
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        self.assertEqual(marker.read_bytes(), terminal_marker)
        self.assertEqual((self.attempt_root / "terminal.json").read_bytes(), result)
        self.assertEqual((self.attempt_root / "unknown-receipt.json").read_bytes(), self.original)
        self.assertEqual((self.base / "active").read_text().strip(), "1"*32)
        self.assertFalse((self.base / "activation/verified.json").exists())

    def test_activation_partial_marker_publication_resumes_same_prepared_transaction(self):
        marker, terminal_marker, result, folder, script = self.activation_case()
        interrupted = script.replace("for p in ", "exit 74; for p in ", 1)
        first = subprocess.run(["bash", "-euo", "pipefail", "-c", interrupted], capture_output=True, timeout=5)
        self.assertEqual(first.returncode, 74, first.stderr)
        self.assertEqual(marker.read_bytes(), terminal_marker)
        self.assertFalse((self.attempt_root / "terminal.json").exists())
        second = subprocess.run(["bash", "-euo", "pipefail", "-c", script], capture_output=True, timeout=5)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((self.attempt_root / "terminal.json").read_bytes(), result)

    def test_activation_changed_or_tampered_prepared_marker_refuses_without_terminal(self):
        marker, terminal_marker, result, folder, script = self.activation_case()
        for target in (marker, folder / "marker.json"):
            original = target.read_bytes()
            target.write_bytes(b'changed')
            outcome = subprocess.run(["bash", "-euo", "pipefail", "-c", script], capture_output=True, timeout=5)
            self.assertNotEqual(outcome.returncode, 0)
            self.assertFalse((self.attempt_root / "terminal.json").exists())
            self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), self.original)
            target.write_bytes(original)

    def test_commit_cas_refuses_changed_receipt(self):
        journal, result = self.result()
        (self.attempt_root / "receipt.json").write_bytes(b"foreign")
        command = self.script(recovery.commit_script(self.control, self.root, self.request, journal,
            recovery.digest(result), recovery.digest(self.original)))
        outcome = subprocess.run(["bash", "-euo", "pipefail", "-c", command], input=b"", capture_output=True, timeout=5)
        self.assertNotEqual(outcome.returncode, 0)
        self.assertFalse((self.attempt_root / "terminal.json").exists())
        self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), b"foreign")

    def test_same_observer_lock_blocks_new_finish_while_commit_runs_after_client_eof(self):
        self.original_lease()
        result = b'{"state":"succeeded","gates":"completed"}\n'
        result_sha = recovery.digest(result)
        transaction = self.attempt_root / "reconciliation" / result_sha
        transaction.mkdir(parents=True); (transaction / "result.json").write_bytes(result)
        wrapper = self.base / "blocking-observer-bin"; wrapper.mkdir()
        entered = self.base / "observer-commit-entered"; release = self.base / "observer-commit-release"
        (wrapper / "mv").write_text("#!/bin/bash\ntouch '"+str(entered)+"'; while test ! -e '"+str(release)+"'; do sleep .02; done; exec /bin/mv \"$@\"\n")
        (wrapper / "mv").chmod(0o755)
        environment = {**os.environ, "PATH": str(wrapper)+":"+os.environ["PATH"]}
        first = subprocess.Popen(["bash", "-euo", "pipefail", "-c", self.claim()], env=environment,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(first); self.assertEqual(first.stdout.readline(), b"READY\n")
        first.stdin.write(b"BEGIN\n"); first.stdin.flush()
        self.assertEqual(first.stdout.readline(), b"OBSERVING\n")
        first.stdin.write(("COMMIT "+result_sha+"\n").encode()); first.stdin.flush()
        first.stdin.close()  # Host input disappeared after full command; daemon commit still owns the SAME flock.
        import time
        try:
            deadline = time.monotonic()+5
            while not entered.exists() and time.monotonic()<deadline: time.sleep(.02)
            self.assertTrue(entered.exists())
            self.assertIsNone(first.poll())
            self.assertIsNone(self.children[0].poll())
            second = subprocess.run(["bash", "-euo", "pipefail", "-c", self.claim()], input=b"", capture_output=True, timeout=5)
            self.assertNotEqual(second.returncode, 0)
            self.assertNotIn(b"READY", second.stdout)
            self.assertFalse((self.attempt_root / "terminal.json").exists())
            self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), self.original)
        finally:
            release.touch()
        self.assertEqual(first.wait(timeout=5), 0)
        self.assertEqual(first.stdout.read(), b"COMMITTED\n")
        self.assertEqual((self.attempt_root / "terminal.json").read_bytes(), result)

    def test_begin_then_client_eof_retains_fence_against_new_finish(self):
        self.original_lease()
        observer = subprocess.Popen(["bash", "-euo", "pipefail", "-c", self.claim()], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(observer); self.assertEqual(observer.stdout.readline(), b"READY\n")
        observer.stdin.write(b"BEGIN\n"); observer.stdin.flush()
        self.assertEqual(observer.stdout.readline(), b"OBSERVING\n")
        observer.stdin.close()
        self.assertEqual(observer.stdout.readline(), b"RETAINED\n")
        self.assertIsNone(observer.poll())
        second = subprocess.run(["bash", "-euo", "pipefail", "-c", self.claim()], input=b"", capture_output=True, timeout=5)
        self.assertNotEqual(second.returncode, 0); self.assertNotIn(b"READY", second.stdout)
        self.assertFalse((self.attempt_root / "terminal.json").exists())
        self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), self.original)
        # This is only our private fixture, not an operation against the real Docker owner.
        observer.terminate(); observer.wait(timeout=5)

    def test_begin_with_invalid_commit_retains_unknown_fence(self):
        self.original_lease()
        observer = subprocess.Popen(["bash", "-euo", "pipefail", "-c", self.claim()], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(observer); self.assertEqual(observer.stdout.readline(), b"READY\n")
        observer.stdin.write(b"BEGIN\n"); observer.stdin.flush()
        self.assertEqual(observer.stdout.readline(), b"OBSERVING\n")
        observer.stdin.write(b"COMMIT invalid\n"); observer.stdin.flush()
        self.assertEqual(observer.stdout.readline(), b"RETAINED\n")
        self.assertIsNone(observer.poll())
        second = subprocess.run(["bash", "-euo", "pipefail", "-c", self.claim()], input=b"", capture_output=True, timeout=5)
        self.assertNotEqual(second.returncode, 0); self.assertNotIn(b"READY", second.stdout)
        self.assertFalse((self.attempt_root / "terminal.json").exists())
        observer.terminate(); observer.wait(timeout=5)

    def test_eof_before_begin_releases_observer_without_finalization(self):
        self.original_lease()
        for unused in range(2):
            observer = subprocess.Popen(["bash", "-euo", "pipefail", "-c", self.claim()], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.children.append(observer); self.assertEqual(observer.stdout.readline(), b"READY\n")
            observer.stdin.close(); self.assertEqual(observer.wait(timeout=5), 0)
            self.assertFalse((self.attempt_root / "terminal.json").exists())
            self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), self.original)

    def test_commit_protocol_rejects_non_digest_and_extra_arguments(self):
        self.original_lease()
        for command in (b"COMMIT invalid\n", b"COMMIT "+b"a"*64+b" extra\n", b"RESTART "+b"a"*64+b"\n"):
            observer = subprocess.Popen(["bash", "-euo", "pipefail", "-c", self.claim()], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.children.append(observer); self.assertEqual(observer.stdout.readline(), b"READY\n")
            observer.stdin.write(command); observer.stdin.close()
            self.assertNotEqual(observer.wait(timeout=5), 0)
            self.assertFalse((self.attempt_root / "terminal.json").exists())
            self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), self.original)

    def test_commit_helper_owns_lock_until_last_publication_even_without_observer(self):
        journal, result = self.result()
        command = self.script(recovery.commit_script(self.control, self.root, self.request, journal,
            recovery.digest(result), recovery.digest(self.original)))
        wrapper = self.base / "blocking-bin"; wrapper.mkdir()
        entered = self.base / "commit-entered"; release = self.base / "commit-release"
        (wrapper / "mv").write_text("#!/bin/bash\ntouch '"+str(entered)+"'; while test ! -e '"+str(release)+"'; do sleep .02; done; exec /bin/mv \"$@\"\n")
        (wrapper / "mv").chmod(0o755)
        environment = {**os.environ, "PATH": str(wrapper)+":"+os.environ["PATH"]}
        first = subprocess.Popen(["bash", "-euo", "pipefail", "-c", command], env=environment,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(first)
        import time
        try:
            deadline = time.monotonic()+5
            while not entered.exists() and time.monotonic() < deadline: time.sleep(.02)
            self.assertTrue(entered.exists())
            # No observer exists in this fixture. The committing daemon helper alone must serialize all mv steps.
            second = subprocess.run(["bash", "-euo", "pipefail", "-c", command], input=b"", capture_output=True, timeout=5)
            self.assertNotEqual(second.returncode, 0)
            self.assertFalse((self.attempt_root / "terminal.json").exists())
            self.assertEqual((self.attempt_root / "receipt.json").read_bytes(), self.original)
        finally:
            release.touch()
        self.assertEqual(first.wait(timeout=5), 0)
        self.assertEqual((self.attempt_root / "terminal.json").read_bytes(), result)

    def test_each_partial_atomic_publication_retains_unknown_history_and_can_complete(self):
        for failed_move in range(1, 5):
            with self.subTest(failed_move=failed_move):
                (self.attempt_root / "receipt.json").write_bytes(self.original)
                terminal = self.attempt_root / "terminal.json"
                if terminal.exists(): terminal.unlink()
                journal, result = self.result()
                command = self.script(recovery.commit_script(self.control, self.root, self.request, journal,
                    recovery.digest(result), recovery.digest(self.original)))
                wrapper = self.base / "bin"; wrapper.mkdir(exist_ok=True)
                counter = self.base / "mv-count"; counter.write_text("0")
                (wrapper / "mv").write_text("#!/bin/bash\nn=$(cat '$COUNT'); n=$((n+1)); printf '%s' \"$n\" > '$COUNT'; "
                    "test \"$n\" -ne '$FAIL' || exit 83; exec /bin/mv \"$@\"\n".replace("$COUNT", str(counter)).replace("$FAIL", str(failed_move)))
                (wrapper / "mv").chmod(0o755)
                environment = {**os.environ, "PATH": str(wrapper)+":"+os.environ["PATH"]}
                outcome = subprocess.run(["bash", "-euo", "pipefail", "-c", command], env=environment,
                                         input=b"", capture_output=True, timeout=5)
                self.assertEqual(outcome.returncode, 83)
                self.assertFalse(terminal.exists())
                self.assertEqual((self.base / "active").read_text().strip(), "1"*32)
                self.assertEqual((self.attempt_root / "unknown-receipt.json").read_bytes(), self.original)
                current_sha = recovery.digest((self.attempt_root / "receipt.json").read_bytes())
                retry = self.script(recovery.commit_script(self.control, self.root, self.request, journal,
                                                           recovery.digest(result), current_sha))
                retried = subprocess.run(["bash", "-euo", "pipefail", "-c", retry], input=b"", capture_output=True, timeout=5)
                self.assertEqual(retried.returncode, 0, retried.stderr)
                self.assertEqual(terminal.read_bytes(), result)
                for path in (self.attempt_root / "receipt.json", self.base / "iteration/current.json", self.base / "iteration/verified.json"):
                    self.assertEqual(path.read_bytes(), result)
                # The controller never clears the original active marker itself.
                self.assertEqual((self.base / "active").read_text().strip(), "1"*32)


class RecipeBoundary(unittest.TestCase):
    def test_exact_fixed_argv_and_injection_refusal(self):
        shell = (Path(__file__).parent / "just_storage_shell.sh").read_text()
        marker = '  *"scripts/docker_volume_reconcile.py"*)'
        branch = marker + shell.split(marker, 1)[1].split('\n  *', 1)[0]
        owner = Path(tempfile.gettempdir()) / "reconcile-test-artifacts"
        owner.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="shell-", dir=owner) as directory:
            stub = Path(directory) / "python"
            stub.write_text('#!/bin/bash\nprintf "%s\\0" "$@"\n'); stub.chmod(0o755)
            harness = 'case "${recipe}" in\n'+branch+'\nesac\n'
            recipe = 'C:/Python/python "D:/repo/scripts/docker_volume_reconcile.py" --request \'verification/request.json\' --request-sha256 \''+'a'*64+'\' --source-root \'D:/git/fullmag/worktrees/antenna work\' --port \'3202\''
            environment = {**os.environ, "recipe": recipe, "python_cmd": str(stub), "script_dir": "/trusted/scripts"}
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", harness], env=environment, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.split(b"\0")[:-1], [b"-B", b"/trusted/scripts/docker_volume_reconcile.py",
                b"--request", b"verification/request.json", b"--request-sha256", b"a"*64,
                b"--source-root", b"D:/git/fullmag/worktrees/antenna work", b"--port", b"3202"])
            for changed in (recipe+'; echo injected', recipe+' --restart-backend',
                            recipe.replace("'3202'", "'bad'"), recipe.replace("verification/request.json", "verification/r;evil.json")):
                environment["recipe"] = changed
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", harness], env=environment, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")





class BorisPreproducerRefusalTests(unittest.TestCase):
    def test_closed_phase_never_writes_verified_success(self):
        control=type('Control',(),{'path':staticmethod(lambda p:'/control/'+p)})()
        request={'attempt':'a'*32,'unknown_receipt_sha256':'b'*64}
        script=recovery.commit_script(control,'boris-reference/attempts/'+request['attempt'],request,'proof','c'*64,'d'*64,phase='boris-reference',publish_verified=False)
        self.assertIn('/boris-reference/current.json',script)
        self.assertNotIn('/boris-reference/verified.json',script)
        with self.assertRaises(recovery.BuildControlError):
            recovery.commit_script(control,'x',request,'proof','c'*64,'d'*64,phase='boris-reference',publish_verified=True)

    def test_stopped_frontend_requires_exact_incarnation(self):
        actual=MountFingerprintFences().container()
        actual['State']['Running']=False
        pin={'id':actual['Id'],'image':actual['Image'],'started_at':actual['State']['StartedAt'],'fingerprint':recovery.fingerprint(actual)}
        recovery.validate_incarnation(actual,pin,'fullmag-test',running=False)
        with self.assertRaises(recovery.BuildControlError):recovery.validate_incarnation(actual,pin,'fullmag-test')


    def test_only_exact_source_guard_and_host_exit_are_recoverable(self):
        import docker_boris_volume as boris
        attempt='a'*32
        request={'attempt':attempt,'compose_project':'fullmag-test','source_root':'D:/source','config_sha256':'d'*64,'refused_controller_sha256':boris.REFUSED_CONTROLLER_SHA256,
            'containers':{'backend':{'id':'b'*64,'image':'sha256:'+'e'*64},'frontend':{'id':'f'*64}}}
        original={'schema':'fullmag.docker-build-operation.v1','phase':'boris-reference','state':'outcome-unknown-resources-retained','error':boris.PREPRODUCER_ERROR,'attempt':attempt,'compose_project':'fullmag-test','helper_container':'fullmag-control-'+attempt,
            'inputs':{'backend_container':'b'*64,'frontend_container':'f'*64,'source_root':'D:/source','config_sha256':'d'*64,'image_id':'sha256:'+'e'*64}}
        host={'attempt':attempt,'controller_sha256':boris.REFUSED_CONTROLLER_SHA256,'exit_code':1,'schema':'fullmag.boris.preproducer-host-exit-attestation.v1','observation_kind':'operator-factual-attestation','exec_session_id':37116,'observed_error':boris.PREPRODUCER_ERROR}
        absence={'schema':'fullmag.boris.preproducer-absence.v1','attempt':attempt,'prefix_absent':True,'accepted_runs_empty':True,'transient_files':[],'reservation_states':[],'health':{'active_session':False}}
        boris.validate_preproducer_refusal(original,request,host,absence)
        for field,value in [('error','different refusal'),('phase','iteration'),('worker_receipt_sha256','a'*64)]:
            bad=copy.deepcopy(original);bad[field]=value
            with self.assertRaises(boris.BuildControlError):boris.validate_preproducer_refusal(bad,request,host,absence)
        for field,value in [('prefix_absent',False),('accepted_runs_empty',False)]:
            bad=copy.deepcopy(absence);bad[field]=value
            with self.assertRaises(boris.BuildControlError):boris.validate_preproducer_refusal(original,request,host,bad)
        bad=copy.deepcopy(host);bad['exit_code']=0
        with self.assertRaises(boris.BuildControlError):boris.validate_preproducer_refusal(original,request,bad,absence)

    def test_actual_run_source_refusal_restores_only_frontend_and_timeout_stays_unknown(self):
        import contextlib
        from types import SimpleNamespace
        from unittest.mock import patch
        import docker_boris_volume as boris
        import docker_dev, docker_volume_activate, docker_volume_dev, docker_dev_codegen, docker_backend_volume_cache
        source_root=Path(__file__).resolve().parents[1]
        for restore_fails in (False,True):
            document={'name':'fullmag-test'}
            original={'compose_project':'fullmag-test','inputs':{'source_root':str(source_root),'image_id':'image'}}
            operation={'receipt':{'attempt':'b'*32},'root':'boris-reference/attempts/'+'b'*32}
            class Control:
                project='fullmag-test'
                def prepare(self):pass
                def read(self,path):
                    if path.endswith('/terminal.json'):return original
                    if path.endswith('/compose.json'):return document
                    return {}
                @contextlib.contextmanager
                def operation(self,*args):yield operation
            observed=[]
            def capture(*argv,**kwargs):
                observed.append(argv)
                if argv[0]=='start' and restore_fails:raise boris.ControlOutcomeUnknown('injected restore timeout')
                return SimpleNamespace(stdout=b'',returncode=0)
            args=SimpleNamespace(attempt='a'*32,config_sha256=boris.hashlib.sha256(boris.canonical(document)).hexdigest(),reference_asset_image_id=boris.ASSET,maximum_build_seconds=1,repo_root=source_root,source_root=source_root)
            replacements=[(docker_dev,'_require_native_windows',lambda:None),(docker_dev,'_select_source',lambda *a:(source_root,{})),(docker_dev,'_compose_identity',lambda *a:{}),
                (docker_volume_activate,'_linked_runtime_terminals',lambda *a,**k:[{}]),(docker_volume_activate,'_validate_running_group',lambda *a,**k:('backend','frontend')),
                (docker_volume_dev,'_assert_private_restart_network',lambda *a:None),(docker_volume_dev,'_retained_startup_enabled',lambda *a:False),
                (docker_dev_codegen,'_backend_documents',lambda *a:({}, {}, 'sha',None)),(docker_dev_codegen,'_validate_backend',lambda *a:({},None,None)),(docker_dev_codegen,'_probe_source',lambda *a:({},None)),(docker_dev_codegen,'_source_matches',lambda *a:False),
                (docker_backend_volume_cache,'validate_container',lambda *a:None),(boris,'BuildControl',lambda *a:Control()),(boris,'toolchain_configuration',lambda *a:{'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':'image'}}}}}),
                (boris,'inspect',lambda value:{'Id':value,'Image':'image','State':{'Running':True}}),(boris,'_asset',lambda:None),(boris,'_module_inputs',lambda *a:{}),(boris,'_same_services',lambda *a,**k:None),(boris,'docker_capture',capture)]
            with contextlib.ExitStack() as stack:
                for module,name,value in replacements:stack.enter_context(patch.object(module,name,value))
                expected=boris.ControlOutcomeUnknown if restore_fails else boris.BuildControlError
                with self.assertRaises(expected):boris.run(args)
            self.assertEqual([row for row in observed if row[0]=='start'],[('start','frontend')])
            self.assertEqual(operation['daemon_pending'],restore_fails)
            self.assertEqual(operation['receipt']['refusal_phase'],'preproducer-source-guard')
            self.assertFalse(operation['receipt']['producer_started'])
            self.assertFalse(any(row[0] in ('run','cp') for row in observed))


class FailedBuildFences(unittest.TestCase):
    def request(self):
        request = RequestFences().request()
        request["schema"] = recovery.FAILED_BUILD_SCHEMA
        del request["package_documents"]
        request["failure"] = {"checkpoint_sha256": "a"*64, "drain_sha256": "b"*64,
            "log_sha256": "c"*64, "finished_at": "end", "exit_code": 2}
        return request

    def test_closed_failure_schema(self):
        recovery.validate_request(self.request())
        for key, value in (("exit_code", 0), ("exit_code", True), ("finished_at", ""),
                           ("log_sha256", "bad"), ("checkpoint_sha256", None)):
            request = self.request(); request["failure"][key] = value
            with self.subTest(key=key), self.assertRaises(recovery.BuildControlError):
                recovery.validate_request(request)
        request = self.request(); request["package_documents"] = {}
        with self.assertRaises(recovery.BuildControlError): recovery.validate_request(request)

    def test_terminal_make_failure_not_oom_restart_or_runtime_exit(self):
        log = b"backend-dev: phase=make state=complete exit_code=2 duration_ms=10\nbackend-dev: canonical Make target failed with exit code 2\n"
        proof = {**self.request()["failure"], "log_sha256": recovery.digest(log)}
        state = {"Status": "exited", "Running": False, "OOMKilled": False, "Dead": False,
            "Restarting": False, "ExitCode": 2, "FinishedAt": "end", "Error": ""}
        recovery.validate_failed_build_state({"State": state}, proof, log)
        for key, value in (("Running", True), ("OOMKilled", True), ("Dead", True),
                           ("Restarting", True), ("ExitCode", 0), ("FinishedAt", "other"), ("Error", "daemon error")):
            with self.subTest(key=key), self.assertRaises(recovery.BuildControlError):
                recovery.validate_failed_build_state({"State": {**state, key: value}}, proof, log)
        for changed in (b"", log + b"runtime started\n", log.replace(b"exit_code=2", b"exit_code=0")):
            with self.assertRaises(recovery.BuildControlError):
                recovery.validate_failed_build_state({"State": state}, {**proof, "log_sha256": recovery.digest(changed)}, changed)

    def test_failure_commit_excludes_verified_and_requires_explicit_request(self):
        control = type("Control", (), {"path": staticmethod(lambda p: "/control/"+p)})()
        request = self.request()
        script = recovery.commit_script(control, "iteration/attempts/"+"1"*32, request,
            "journal", "d"*64, "e"*64, publish_verified=False)
        self.assertNotIn("/verified.json", script)
        self.assertIn("/terminal.json", script)
        with self.assertRaises(recovery.BuildControlError):
            recovery.commit_script(control, "iteration/attempts/"+"1"*32, RequestFences().request(),
                "journal", "d"*64, "e"*64, publish_verified=False)

class CgroupFailureFences(unittest.TestCase):
    def request(self):
        request = RequestFences().request()
        request["schema"] = recovery.CGROUP_FAILURE_SCHEMA
        request["failure"] = {key: "a"*64 for key in ("checkpoint_sha256", "drain_sha256",
            "helper_source_sha256", "helper_compose_sha256", "helper_log_sha256",
            "cgroup_request_sha256", "verified_sha256", "recovery_helper_sha256")}
        request["failure"].update(checkpoint_relative="verification/cgroup/current-checkpoint.json",
            original_checkpoint_relative="verification/cgroup/original-checkpoint.json",
            helper={"id": "b"*64, "name": "fullmag-cgroup-"+request["attempt"],
                "image": "sha256:"+"6"*64, "started_at": "start", "finished_at": "finish",
                "exit_code": 1, "fingerprint": "c"*64})
        return request

    def test_closed_failure_request_requires_completed_package_and_all_proofs(self):
        recovery.validate_request(self.request())
        for key in self.request()["failure"]:
            with self.subTest(key=key), self.assertRaises(recovery.BuildControlError):
                request = self.request(); del request["failure"][key]
                recovery.validate_request(request)
        for change in ({}, {"receipt": "8"*64}):
            with self.subTest(package=change), self.assertRaises(recovery.BuildControlError):
                request = self.request(); request["package_documents"] = change
                recovery.validate_request(request)

    def test_invalid_or_foreign_helper_and_checkpoint_cannot_be_admitted(self):
        for key, value in (("id", None), ("image", []), ("fingerprint", 1),
                ("name", "fullmag-cgroup-"+"2"*32), ("exit_code", 0), ("exit_code", True),
                ("started_at", ""), ("finished_at", None)):
            with self.subTest(key=key), self.assertRaises(recovery.BuildControlError):
                request = self.request(); request["failure"]["helper"][key] = value
                recovery.validate_request(request)
        for relative in ("../verification/proof", "verification/../proof", "/verification/proof",
                "verification//proof", "verification/./proof", "verification/proof\x00"):
            with self.subTest(path=relative), self.assertRaises(recovery.BuildControlError):
                request = self.request(); request["failure"]["checkpoint_relative"] = relative
                recovery.validate_request(request)

    def test_failure_schema_never_allows_success_publication(self):
        request = self.request()
        control = type("Control", (), {"path": staticmethod(lambda p: "/control/"+p)})()
        with self.assertRaises(recovery.BuildControlError):
            recovery.commit_script(control, "iteration/attempts/"+request["attempt"], request,
                "journal", "d"*64, request["unknown_receipt_sha256"], publish_verified=True)


class CgroupCpuEnableRace(unittest.TestCase):
    @staticmethod
    def module():
        import importlib.util
        path = Path(__file__).parent / "lib/docker_worker_cgroup.py"
        spec = importlib.util.spec_from_file_location("delegation_gate", path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module

    def exercise(self, errors):
        import errno
        from unittest.mock import Mock
        module = self.module(); state = {"processes": "101", "enabled": "", "writes": 0, "moved": []}
        root, controls = Path('/selected-backend'), Path('/selected-backend/fullmag-control')
        def read(path, *args, **kwargs):
            if path == root/'cgroup.procs': return state['processes']
            if path == root/'cgroup.subtree_control': return state['enabled']
            raise AssertionError('Unexpected read: '+str(path))
        def write(path, value, *args, **kwargs):
            if path == controls/'cgroup.procs':
                state['moved'].append(value.strip()); state['processes'] = ''; return len(value)
            if path != root/'cgroup.subtree_control': raise AssertionError('Unexpected write: '+str(path))
            state['writes'] += 1
            error = errors(state['writes'])
            if error is not None:
                # New process arrived precisely after the empty check/fence.
                state['processes'] = str(101+state['writes'])
                raise OSError(error, 'injected enable error')
            self.assertEqual(state['processes'], ''); state['enabled'] = 'cpu'; return len(value)
        fence = Mock()
        with patch.object(Path, 'read_text', read), patch.object(Path, 'write_text', write):
            try: module.enable_cpu(root, controls, fence)
            except BaseException as error: return state, fence, error
        return state, fence, None

    def test_process_between_empty_read_and_enable_is_drained_on_retry(self):
        import errno
        state, fence, error = self.exercise(lambda n: errno.EBUSY if n == 1 else None)
        self.assertIsNone(error); self.assertEqual(state['writes'], 2)
        self.assertEqual(state['moved'], ['101', '102']); self.assertEqual(state['enabled'], 'cpu')
        self.assertEqual(fence.call_count, 5)

    def test_continuous_contention_is_bounded_and_never_returns_ready(self):
        import errno
        state, fence, error = self.exercise(lambda n: errno.EBUSY)
        self.assertIsInstance(error, RuntimeError); self.assertEqual(state['writes'], 32)
        self.assertEqual(state['enabled'], ''); self.assertIn('32 fenced attempts', str(error))

    def test_non_busy_errors_are_not_retried(self):
        import errno
        for code in (errno.EPERM, errno.ENOENT, errno.EINVAL):
            with self.subTest(code=code):
                state, fence, error = self.exercise(lambda n: code)
                self.assertIsInstance(error, OSError); self.assertEqual(error.errno, code)
                self.assertEqual(state['writes'], 1); self.assertEqual(state['enabled'], '')


if __name__ == "__main__": unittest.main(verbosity=2)
