"""Interpreted contracts for same-container build behind the closed storage gate."""
import copy
from contextlib import contextmanager, ExitStack
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import docker_volume_dev as dev
import docker_volume_container_recovery as recovery
from docker_build_control import BuildControlError, canonical


def request():
    pins = {"request_id": "12345678-1234-1234-8234-123456789abc", "source_root": "/selected",
        "compose_project": "fullmag-master", "development_attempt": "a" * 32,
        "compose_config_sha256": "b" * 64, "backend_container_id": "c" * 64,
        "frontend_container_id": "d" * 64, "old_image_id": "sha256:" + "e" * 64,
        **{key: "f" * 64 for key in ("process_receipt_sha256", "config_sha256", "owner_sha256", "launch_sha256")}}
    return {"schema": dev._RECOVERY_BUILD_SCHEMA, "authorization_pins": pins,
        "retained_terminal_runs": [], "retained_held_manual_runs": [{"run_id": "held",
            "run_intent_sha256": "1" * 64, "run_catalog_sha256": "2" * 64, "start_release": "absent"}],
        "storage_proof_sha256": hashlib.sha256(canonical({"preserved": True})).hexdigest(),
        "certificate_sha256": "3" * 64, "source_commit": "4" * 40, "source_digest": "5" * 64,
        "source_snapshot_sha256": "6" * 64,
        "controller_sha256": hashlib.sha256(Path(dev.__file__).read_bytes()).hexdigest(),
        "baked_helpers": {name: "7" * 64 for name in dev._RECOVERY_BUILD_HELPERS}}


def publication(req):
    receipt = {"state": "succeeded", "source": {"resolved_commit": req["source_commit"],
        "source_digest": req["source_digest"], "source_snapshot_sha256": req["source_snapshot_sha256"]},
        "native_source_identity": {"head_commit_full": req["source_commit"], "source_snapshot_sha256": req["source_snapshot_sha256"]},
        "artifacts": [{"path": "bin/fullmag-bin", "sha256": "8" * 64}]}
    provenance = {"state": "succeeded", "commit": req["source_commit"], "source_digest": req["source_digest"],
        "source_snapshot_sha256": req["source_snapshot_sha256"], "build_receipt_sha256": "9" * 64,
        "binary_hashes": {"fullmag-bin": "8" * 64}}
    capabilities = {"schema_version": "runtime_service_container_recovery_capabilities.v1",
        "supported_recovery_schemas": ["runtime_service_container_recovery_request.v4"],
        "build_identity": {"version": "0.1", "built_at_utc": "2026-10-28T12:00:00Z", "worktree_state": "dirty",
            "git_commit": req["source_commit"], "source_snapshot_sha256": req["source_snapshot_sha256"]}}
    capability = {"binary_sha256": "8" * 64, "receipt_sha256": "9" * 64, "provenance_sha256": "0" * 64,
        "capabilities": capabilities, "raw_utf8": json.dumps(capabilities), "receipt": receipt, "provenance": provenance}
    return receipt, provenance, capability


START = "2026-10-28T12:00:00Z"
LOG = ("backend-dev: phase=start state=handoff\n"
       "backend-dev: phase=gate state=start profile=linux-native-v1\n"
       "backend-dev: Linux native host admission did not become ready\n")


def exited():
    return {"Id": "c" * 64, "State": {"Status": "exited", "Running": False, "Pid": 0,
        "StartedAt": START, "FinishedAt": "2026-10-28T12:04:01Z", "ExitCode": 2,
        "OOMKilled": False, "Error": ""}}


class RecoveryBuildTests(unittest.TestCase):
    def test_history_build_requires_explicit_version_and_complete_history(self):
        value = request()
        value["schema"] = dev._RECOVERY_HISTORY_BUILD_SCHEMA
        value["retained_terminal_runs"] = [{"run_id": "terminal", "run_intent_sha256": "a" * 64,
            "run_catalog_sha256": "b" * 64, "artifact_catalog_sha256": None}]
        value["retained_attempt_histories"] = [{"run_id": "terminal", "run_evidence_sha256": "c" * 64,
            "attempts": [{"task_id": "task-old", "attempt_id": "attempt-old", "ownership_epoch": 1,
                "resource_id": "docker-all.compute.cpu"}]}]
        self.assertEqual(dev._recovery_build_request(json.dumps(value)), value)
        for change in (lambda x: x.update(schema=dev._RECOVERY_BUILD_SCHEMA),
                       lambda x: x.pop("retained_attempt_histories"),
                       lambda x: x.update(retained_attempt_histories=[]),
                       lambda x: x["retained_attempt_histories"][0].update(run_id="unlisted"),
                       lambda x: x["retained_attempt_histories"][0].update(run_evidence_sha256="invalid")):
            wrong = copy.deepcopy(value); change(wrong)
            with self.subTest(value=wrong), self.assertRaises((BuildControlError, ValueError)):
                dev._recovery_build_request(json.dumps(wrong))

    def test_history_build_rejects_v4_only_native_package(self):
        value = request()
        value["schema"] = dev._RECOVERY_HISTORY_BUILD_SCHEMA
        receipt, provenance, capability = publication(value)
        with self.assertRaisesRegex(BuildControlError, "v5 recovery capability"):
            dev._recovery_build_publication(receipt, provenance, capability, value)
        capability["capabilities"]["supported_recovery_schemas"].append(recovery.ATTEMPT_HISTORY_REQUEST_SCHEMA)
        capability["raw_utf8"] = json.dumps(capability["capabilities"])
        dev._recovery_build_publication(receipt, provenance, capability, value)

    def test_closed_request_requires_all_pins_and_canonical_held_policy(self):
        value = request()
        self.assertEqual(dev._recovery_build_request(json.dumps(value)), value)
        for name in value:
            wrong = copy.deepcopy(value)
            del wrong[name]
            with self.subTest(missing=name), self.assertRaises((BuildControlError, ValueError)):
                dev._recovery_build_request(json.dumps(wrong))
        for change in (lambda x: x.update(extra=True), lambda x: x["baked_helpers"].pop("linux_native_probe.py"),
                       lambda x: x["retained_held_manual_runs"][0].update(start_release="present")):
            wrong = copy.deepcopy(value); change(wrong)
            with self.assertRaises((BuildControlError, ValueError)):
                dev._recovery_build_request(json.dumps(wrong))

    def test_prepared_certificate_requires_false_matching_marker_and_exact_hash(self):
        import linux_native_host as host
        value = request()
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            for name in host.READMISSION_FILES:
                (state / name).write_bytes(b"retained")
            value["certificate_sha256"] = hashlib.sha256(b"retained").hexdigest()
            for verified in (True, None, False):
                cert = {"storage_profile": "linux-native-v1", "restart_verified": verified}
                with self.subTest(verified=verified), patch.object(dev, "_retained_certificate", return_value=cert):
                    if verified is False:
                        self.assertEqual(len(dev._recovery_build_certificate(state, {}, value)), 5)
                        (state / host.CERTIFICATE_NAME).write_bytes(b"different")
                        with self.assertRaisesRegex(BuildControlError, "SHA differs"):
                            dev._recovery_build_certificate(state, {}, value)
                    else:
                        with self.assertRaisesRegex(BuildControlError, "prepared"):
                            dev._recovery_build_certificate(state, {}, value)
        with patch.object(dev, "_retained_certificate", side_effect=BuildControlError("ownership differs")):
            with self.assertRaisesRegex(BuildControlError, "ownership"):
                dev._recovery_build_certificate(Path("/state"), {}, value)

    def test_baked_gate_requires_both_whole_file_hash_and_reviewed_function(self):
        root = Path(__file__).resolve().parents[1]
        value = request()
        def archive(name, raw):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w") as stream:
                info = tarfile.TarInfo(name); info.size = len(raw)
                stream.addfile(info, io.BytesIO(raw))
            return SimpleNamespace(stdout=buffer.getvalue())
        files = {name: (root / "docker/all-in-one" / name).read_bytes() for name in dev._RECOVERY_BUILD_HELPERS}
        value["baked_helpers"] = {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}
        def capture(*args):
            name = args[1].rsplit("/", 1)[1]
            return archive(name, files[name])
        with patch.object(dev, "docker_capture", side_effect=capture):
            dev._recovery_build_helpers("c" * 64, value, root)
            value["baked_helpers"]["backend_dev.py"] = "0" * 64
            with self.assertRaisesRegex(BuildControlError, "SHA differs"):
                dev._recovery_build_helpers("c" * 64, value, root)
            files["backend_dev.py"] = files["backend_dev.py"].replace(b"def _serve(extra:", b"def _unsafe_serve(extra:")
            value["baked_helpers"]["backend_dev.py"] = hashlib.sha256(files["backend_dev.py"]).hexdigest()
            with self.assertRaisesRegex(BuildControlError, "ambiguous"):
                dev._recovery_build_helpers("c" * 64, value, root)

    def test_publication_refuses_stale_source_binary_and_missing_v4(self):
        value = request()
        dev._recovery_build_publication(*publication(value), value)
        for change in (lambda r,p,c: r["source"].update(source_digest="0" * 64),
                       lambda r,p,c: c.update(binary_sha256="0" * 64),
                       lambda r,p,c: c["capabilities"].update(supported_recovery_schemas=["runtime_service_container_recovery_request.v3"]),
                       lambda r,p,c: c["capabilities"]["build_identity"].update(git_commit="0" * 40),
                       lambda r,p,c: c.update(receipt={})):
            r,p,c = copy.deepcopy(publication(value)); change(r,p,c)
            # Keep stdout evidence coherent to exercise semantic validation too.
            c["raw_utf8"] = json.dumps(c["capabilities"])
            with self.assertRaises(BuildControlError):
                dev._recovery_build_publication(r,p,c,value)

    def test_timeout_requires_authentic_duration_exit_and_closed_gate(self):
        dev._recovery_build_timeout(exited(), START, LOG)
        for fields in ({"ExitCode": 0}, {"ExitCode": 137}, {"Running": True}, {"OOMKilled": True},
                       {"StartedAt": "foreign"}, {"FinishedAt": "2026-10-28T12:00:30Z"}, {"Error": "unknown"}):
            wrong = exited(); wrong["State"].update(fields)
            with self.subTest(fields=fields), self.assertRaises(BuildControlError):
                dev._recovery_build_timeout(wrong, START, LOG)
        for logs in ("", LOG + "phase=api state=exec", LOG + "phase=gate state=complete profile=linux-native-v1"):
            with self.assertRaises(BuildControlError):
                dev._recovery_build_timeout(exited(), START, logs)

    @contextmanager
    def route(self, *, mutation=None, unknown_exit=False):
        import docker_backend_volume_cache as cache
        value = request()
        backend = exited()
        backend["State"]["StartedAt"] = "2026-10-27T12:00:00Z"
        backend["Config"] = {"Entrypoint": ["/usr/local/bin/python3", "/opt/fullmag/backend_dev.py"],
            "Cmd": ["start", "--source-root", "/opt/fullmag/source", "--git-common-root", "/opt/fullmag/source-git",
                    "--output", "/opt/fullmag/package", "--build-root", "/build"],
            "Env": ["FULLMAG_SESSION_STORAGE_PROFILE=linux-native-v1", "FULLMAG_DOCKER_ROLE=backend"]}
        proof = {"raw_records": {"owner": {"raw_utf8": '{"state":"ready"}'}},
            "storage_proof": {"preserved": True}, "containers": {"backend": backend, "frontend": {"Id": "d" * 64}}}
        if mutation: mutation(value, proof)
        raw = json.dumps(value).encode()
        args = SimpleNamespace(build_for_recovery="verification/request.json", build_for_recovery_sha256=hashlib.sha256(raw).hexdigest(),
            restart_backend=True, attempt="a" * 32, config_sha256="b" * 64)
        previous = {"state_root": "/state", "inputs": {"image_id": "sha256:" + "e" * 64, "source_root": "/selected"}}
        operation = {"root": "recovery-build/attempts/" + "a" * 32, "receipt": {"backend_started_at": START}, "daemon_pending": False, "helper_container_id": "a" * 64}
        control = Mock(project="fullmag-master")
        control.read.return_value = {"volume_names": {"build": "build", "package": "package", "control": "control"}}
        @contextmanager
        def operation_context(*args, **kwargs): yield operation
        control.operation.side_effect = operation_context
        receipt, provenance, capability = publication(value)
        def published(*a, publication_pins=None, **kwargs):
            publication_pins.update(receipt_sha256="9" * 64, provenance_sha256="0" * 64)
            return receipt, provenance
        actual = exited()
        if unknown_exit: actual["State"]["ExitCode"] = 137
        with ExitStack() as stack:
            for target, name, kwargs in (
                (dev, "_read_cancelled_activation_bytes", {"return_value": raw}),
                (dev.storage, "validate_path", {"return_value": Path("/state")}),
                (dev.storage, "git", {"return_value": value["source_commit"]}),
                (recovery, "prepare_abrupt_stop_proof", {"return_value": proof}),
                (cache, "validate_container", {}),
                (cache, "_assert_no_active_consumers", {}),
                (dev, "_recovery_build_certificate", {"return_value": {"exact": "original"}}),
                (dev, "_recovery_build_helpers", {}),
                (dev, "_wait_for_publication", {"side_effect": published}),
                (dev, "docker_text", {"side_effect": lambda *a, **k: json.dumps([actual]) if a[0] == "inspect"
                    else json.dumps([{"Name": name} for name in ("build", "package", "control")]) if a[0] == "volume"
                    else "" if a[0] == "ps" else json.dumps(capability) if a[0] == "exec" else LOG}),
                (dev, "_finish", {"side_effect": AssertionError("must not admit/serve")}),
                (dev, "_frontend", {"side_effect": AssertionError("must not start frontend")}),
            ):
                stack.enter_context(patch.object(target, name, **kwargs))
            start = stack.enter_context(patch.object(dev, "compose_capture"))
            yield args, control, previous, operation, start

    def test_only_fixed_backend_starts_then_preserves_timeout_without_finish(self):
        with self.route() as (args, control, previous, operation, start):
            dev._retained_recovery_build(args, control, previous, {}, Path("/selected"), {"runtime_root": Path("/")})
            start.assert_called_once_with({}, "start", "backend", timeout=90)
            self.assertEqual(operation["receipt"]["state"], "succeeded")
            self.assertIs(operation["receipt"]["runtime_started"], False)
            self.assertIs(operation["receipt"]["storage_admitted"], False)
            self.assertIs(operation["daemon_pending"], False)

    def test_foreign_identity_and_owner_refuse_before_start(self):
        for mutation in (lambda v,p: v["authorization_pins"].update(source_root="/foreign"),
                         lambda v,p: p["raw_records"]["owner"].update(raw_utf8='{"state":"unknown"}'),
                         lambda v,p: p["containers"]["backend"]["Config"].update(Cmd=["serve"])):
            with self.route(mutation=mutation) as (args, control, previous, operation, start):
                with self.assertRaises(BuildControlError):
                    dev._retained_recovery_build(args, control, previous, {}, Path("/selected"), {"runtime_root": Path("/")})
                start.assert_not_called()

    def test_old_handoff_cannot_qualify_the_new_start(self):
        with self.route() as (args, control, previous, operation, start):
            operation["receipt"]["backend_started_at"] = "2026-10-27T12:00:00Z"
            with self.assertRaisesRegex(BuildControlError, "fresh backend start"):
                dev._retained_recovery_build(args, control, previous, {}, Path("/selected"), {"runtime_root": Path("/")})
            self.assertIs(operation["daemon_pending"], True)

    def test_unknown_exit_retains_daemon_pending(self):
        with self.route(unknown_exit=True) as (args, control, previous, operation, start):
            with self.assertRaisesRegex(BuildControlError, "outcome retained"):
                dev._retained_recovery_build(args, control, previous, {}, Path("/selected"), {"runtime_root": Path("/")})
            self.assertIs(operation["daemon_pending"], True)

    def test_missing_cli_pair_refuses_without_start(self):
        with self.route() as (args, control, previous, operation, start):
            args.build_for_recovery_sha256 = None
            with self.assertRaisesRegex(BuildControlError, "paired pins"):
                dev._retained_recovery_build(args, control, previous, {}, Path("/selected"), {"runtime_root": Path("/")})
            start.assert_not_called()



    @contextmanager
    def capability_fixture(self):
        # Prefer the actual retained-image interpreter; the fallback still removes
        # the post-3.10 API so this executable regression is portable in CI.
        interpreter = shutil.which("python3.10") or sys.executable
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"; (package / "bin").mkdir(parents=True)
            receipt = package / "backend-build-receipt.json"
            provenance = root / "runtime-provenance.json"
            receipt.write_text('{"state":"succeeded","preserved":"receipt"}')
            provenance.write_text('{"state":"succeeded","preserved":"provenance"}')
            binary = package / "bin/fullmag-bin"
            binary.write_text("#!" + interpreter + "\nimport json,sys\n"
                "assert sys.argv[1:]==['runtime','service-container-recovery-capabilities']\n"
                "print(json.dumps({'python_version':list(sys.version_info[:2]),'fixture':True}))\n")
            binary.chmod(0o755)
            code = dev._RECOVERY_BUILD_CAPABILITY.replace("Path('/opt/fullmag/package')", "Path(" + repr(str(package)) + ")").replace(
                "Path('/opt/fullmag/control/backend/runtime-provenance.json')", "Path(" + repr(str(provenance)) + ")")
            # This makes a regression using file_digest fail on Python >=3.11 too.
            bootstrap = "import hashlib\nif hasattr(hashlib,'file_digest'): del hashlib.file_digest\n" + code
            expected = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "receipt_sha256": hashlib.sha256(receipt.read_bytes()).hexdigest(),
                "provenance_sha256": hashlib.sha256(provenance.read_bytes()).hexdigest()}
            def run(expected_overrides=None):
                pins = dict(expected, **(expected_overrides or {}))
                return subprocess.run([interpreter, "-B", "-c", bootstrap, json.dumps(pins)], capture_output=True,
                    timeout=15, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
            yield root, binary, receipt, provenance, run

    def test_actual_embedded_command_executes_without_post_python310_hash_api(self):
        with self.capability_fixture() as (root, binary, receipt, provenance, run):
            original = [path.read_bytes() for path in (binary, receipt, provenance)]
            result = run()
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            observed = json.loads(result.stdout)
            self.assertEqual(observed["binary_sha256"], hashlib.sha256(original[0]).hexdigest())
            self.assertEqual(observed["receipt_sha256"], hashlib.sha256(original[1]).hexdigest())
            self.assertEqual(observed["provenance_sha256"], hashlib.sha256(original[2]).hexdigest())
            self.assertEqual(observed["receipt"], json.loads(original[1]))
            self.assertEqual(observed["provenance"], json.loads(original[2]))
            self.assertEqual([path.read_bytes() for path in (binary, receipt, provenance)], original)
            if shutil.which("python3.10") or sys.version_info[:2] == (3, 10):
                self.assertEqual(observed["capabilities"]["python_version"], [3, 10])

    def test_embedded_command_accepts_sealed_shared_payload_but_refuses_mutable_links(self):
        with self.capability_fixture() as (root, binary, receipt, provenance, run):
            os.link(binary, root / "sealed-copy")
            binary.chmod(0o555)
            result = run()
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(binary.stat().st_nlink, 2)
            binary.chmod(0o755)
            result = run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"sealed regular", result.stderr)
            binary.chmod(0o555)
            os.link(receipt, root / "unowned-receipt")
            result = run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"sealed regular", result.stderr)

    def test_embedded_command_refuses_symlink_oversize_and_incoherent_publication(self):
        with self.capability_fixture() as (root, binary, receipt, provenance, run):
            target = root / "target"
            binary.rename(target); binary.symlink_to(target)
            result = run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"contains a link", result.stderr)
        with self.capability_fixture() as (root, binary, receipt, provenance, run):
            with receipt.open("r+b") as stream: stream.truncate(8*1024**2+1)
            result = run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"bounded", result.stderr)
        with self.capability_fixture() as (root, binary, receipt, provenance, run):
            original = binary.read_text()
            binary.write_text(original.replace("print(json.dumps", "open(" + repr(str(receipt)) + ",'w').write('{}')\nprint(json.dumps"))
            result = run({"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"publication changed", result.stderr)


    def test_changed_binary_or_stale_raw_publication_never_executes_native_command(self):
        for changed in ("binary", "receipt", "provenance"):
            with self.subTest(changed=changed), self.capability_fixture() as (root, binary, receipt, provenance, run):
                marker = root / "native-command-executed"
                program = binary.read_text()
                binary.write_text(program.replace("print(json.dumps", "open(" + repr(str(marker)) + ",'w').write('executed')\nprint(json.dumps"))
                if changed == "binary":
                    overrides = None
                else:
                    overrides = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
                    path = receipt if changed == "receipt" else provenance
                    path.write_text('{"state":"stale"}')
                result = run(overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"native command not executed", result.stderr)
                self.assertFalse(marker.exists())

    def test_stale_source_is_rejected_before_the_capability_exec(self):
        with self.route() as (args, control, previous, operation, start):
            original = dev.docker_text
            with patch.object(dev, "_wait_for_publication") as wait, patch.object(dev, "docker_text", wraps=original) as docker:
                receipt, provenance, capability = publication(request())
                receipt["source"]["source_digest"] = "0" * 64
                def published(*a, publication_pins=None, **kwargs):
                    publication_pins.update(receipt_sha256="9" * 64, provenance_sha256="0" * 64)
                    return receipt, provenance
                wait.side_effect = published
                with self.assertRaisesRegex(BuildControlError, "stale"):
                    dev._retained_recovery_build(args, control, previous, {}, Path("/selected"), {"runtime_root": Path("/")})
                self.assertFalse(any(call.args[0] == "exec" for call in docker.call_args_list))
                self.assertIs(operation["daemon_pending"], True)

    def test_cli_preserves_explicit_paired_pins(self):
        import docker_dev
        arguments = ["resume-volume", "--attempt", "a" * 32, "--config-sha256", "b" * 64,
            "--source-root", "/selected", "--port", "3197", "--restart-backend",
            "--build-for-recovery", "verification/request.json", "--build-for-recovery-sha256", "c" * 64]
        with patch.object(dev, "resume") as resume:
            self.assertEqual(docker_dev.main(arguments), 0)
        args = resume.call_args.args[0]
        self.assertEqual(args.build_for_recovery, "verification/request.json")
        self.assertEqual(args.build_for_recovery_sha256, "c" * 64)
        self.assertTrue(args.restart_backend)

    def test_full_storage_shell_forwards_closed_argv_and_rejects_composite_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); scripts = root / "scripts"; scripts.mkdir()
            shell = scripts / "just_storage_shell.sh"
            shell.write_bytes((Path(__file__).parent / shell.name).read_bytes())
            (scripts / "fullmag_storage.py").write_text("raise RuntimeError('host resolver must not run')\n")
            controller = scripts / "docker_dev.py"
            controller.write_text("import json,sys; print(json.dumps(sys.argv[1:]))\n")
            args = ["--repo-root", str(root), "resume-volume", "--attempt", "a" * 32,
                "--config-sha256", "b" * 64, "--source-root", "/selected", "--port", "3197",
                "--restart-backend", "--build-for-recovery", "verification/request.json",
                "--build-for-recovery-sha256", "c" * 64]
            body = ('python3 "' + str(controller) + '" --repo-root "' + str(root)
                + '" resume-volume --attempt ' + "'" + "a" * 32 + "' --config-sha256 '" + "b" * 64
                + "' --source-root '/selected' --port '3197' --restart-backend"
                + " --build-for-recovery 'verification/request.json' --build-for-recovery-sha256 '" + "c" * 64 + "'")
            env = dict(os.environ, FULLMAG_STORAGE_PYTHON=sys.executable)
            result = subprocess.run(["bash", str(shell), body], env=env, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(json.loads(result.stdout), args)
            for suffix in ("; echo bypass", " --prestart-reconciliation '" + "a" * 32 + "'", " --unknown"):
                result = subprocess.run(["bash", str(shell), body + suffix], env=env, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b"bypass", result.stdout)



if __name__ == "__main__":
    unittest.main()
