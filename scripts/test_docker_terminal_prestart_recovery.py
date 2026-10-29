"""Interpreted terminal-prestart regressions; no native command or Docker is run."""
import contextlib
import copy
import io
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from docker_build_control import BuildControlError, canonical
import docker_volume_terminal_prestart_recovery as recovery
import docker_volume_reconcile as reconcile


def preflight():
    return {"schema": recovery.PREFLIGHT_SCHEMA, "api_instance_id": "instance",
            "session_id": "session", "session_epoch": "epoch", "request_scope_epoch": "scope",
            "run": {"run_id": "run-terminal", "session_id": "session", "status": "failed"},
            "compute_queue": {"schema_version": "compute_queue.v1",
                "items": [{"run_id": "run-held", "state": "accepted"}]},
            "held_run_intent_sha256": {"run-held": "a" * 64},
            "runtime_service": {"configured": True, "state": "ready"}}


def observation():
    return {"schema": recovery.OBSERVATION_SCHEMA, "run_id": "run-terminal",
            "held_run_intent_sha256": {"run-held": "a" * 64},
            **{key: "b" * 64 for key in ("terminal_evidence_sha256", "runtime_config_sha256",
               "package_receipt_sha256", "provenance_sha256", "released_snapshot_sha256",
               "recovery_store_sha256", "operator_baseline_projection_sha256", "storage_binding_sha256")}}


class TerminalContracts(unittest.TestCase):
    def test_exact_terminal_preflight_and_held_queue(self):
        self.assertEqual(recovery.validate_preflight(preflight()), ("run-terminal", {"run-held": "a" * 64}))

    def test_prepared_running_foreign_session_and_unpinned_queue_rejected(self):
        for change in (
            lambda p: p.update(schema="fullmag.docker-prepared-session-drain-preflight.v1"),
            lambda p: p["run"].update(status="running"),
            lambda p: p["run"].update(session_id="other"),
            lambda p: p["compute_queue"]["items"][0].update(state="running"),
            lambda p: p["held_run_intent_sha256"].update(other="b" * 64),
            lambda p: p["compute_queue"]["items"].append(p["compute_queue"]["items"][0]),
            lambda p: p["compute_queue"].update(next_cursor="more"),
        ):
            with self.subTest(change=change):
                value = preflight(); change(value)
                with self.assertRaises(BuildControlError): recovery.validate_preflight(value)

    def test_closed_observation_rejects_unknown_negative_and_boolean_digest(self):
        recovery.validate_observation(observation())
        for key, value in (("extra", False), ("terminal_evidence_sha256", True),
                           ("released_snapshot_sha256", "bad"), ("run_id", "..")):
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                obj = observation(); obj[key] = value; recovery.validate_observation(obj)

    def test_operator_baseline_is_separate_control_reference(self):
        valid = {"path": "verification/before.json", "sha256": "a" * 64, "run_id": "run-saved"}
        recovery.validate_history_baseline(valid)
        for path in ("/state/catalog.json", "../before.json", "verification/../before.json"):
            with self.subTest(path=path), self.assertRaises(BuildControlError):
                recovery.validate_history_baseline({**valid, "path": path})

    def test_new_request_never_accepts_an_authoring_checkpoint(self):
        request = {"schema": recovery.SCHEMA, "attempt": "a" * 32, "compose_project": "group",
            "source_root": "/source", "port": 3203, "config_sha256": "a" * 64,
            "unknown_receipt_sha256": "b" * 64, "controller_sha256": "c" * 64,
            "prestart_helper_sha256": "d" * 64,
            "containers": {name: {"id": letter * 64, "image": "sha256:" + "e" * 64,
                "started_at": "old", "fingerprint": "f" * 64}
                for name, letter in (("lease", "a"), ("backend", "b"), ("frontend", "c"))},
            "failure": {key: "f" * 64 for key in ("drain_sha256", "preflight_sha256",
                "backend_state_sha256", "frontend_state_sha256", "error_sha256", "previous_receipt_sha256")},
            "history_baseline": {"path": "verification/before.json", "sha256": "a" * 64, "run_id": "run-saved"},
            "prior_publication": {"attempt": "a" * 32, "sha256": "a" * 64},
            "observation": observation()}
        reconcile.validate_request(request)
        request["failure"]["checkpoint_sha256"] = "0" * 64
        with self.assertRaises(BuildControlError): reconcile.validate_request(request)

    def test_failure_only_claim_never_publishes_verified(self):
        control = types.SimpleNamespace(path=lambda x: "/control/" + x)
        request = {"schema": recovery.SCHEMA, "attempt": "a" * 32, "unknown_receipt_sha256": "b" * 64}
        script = reconcile.claim_script(control, "iteration/attempts/" + "a" * 32,
                                        request, "b" * 64, publish_verified=False)
        self.assertNotIn("verified.json", script)
        with self.assertRaises(BuildControlError):
            reconcile.claim_script(control, "iteration/attempts/" + "a" * 32,
                                   request, "b" * 64, publish_verified=True)

    def test_unpinned_continuation_is_noop(self):
        self.assertIsNone(recovery.continuation(None, types.SimpleNamespace(), {}, {}, {}, None))
        with self.assertRaises(BuildControlError):
            recovery.continuation(None, types.SimpleNamespace(prestart_reconciliation="a" * 32), {}, {}, {}, None)


class RetainedMounts(unittest.TestCase):
    def fixture(self):
        identity = {"project_name": "fullmag-test", "project_id": "project",
                    "worktree_id": "worktree", "checkout_kind": "worktree"}
        control = types.SimpleNamespace(project="fullmag-test", identity=identity, volume="volume-2")
        volumes = {"/host-ledger": "", "/opt/fullmag/package": "", "/opt/fullmag/control": "",
                   "/opt/fullmag/runtime-control": "runtime-control",
                   "/state/runs/docker-all/session-store/runtime-services": "runtime-control/runtime-services"}
        binds = {"/state", "/opt/fullmag/source", "/run/fullmag/linux-native-host.json"}
        mounts = [{"Type": "volume", "Name": "volume-" + str(i), "Destination": p, "RW": True}
                  for i, p in enumerate(volumes)]
        mounts += [{"Type": "bind", "Source": "/host" + p, "Destination": p, "RW": True} for p in binds]
        environment = {
            "FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1", "FULLMAG_DOCKER_HOST_ID": "a" * 64,
            "FULLMAG_RUNTIME_IMAGE_ID": "sha256:" + "f" * 64, "FULLMAG_TOOLCHAIN_IMAGE_ID": "sha256:" + "e" * 64,
            "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev", "FULLMAG_COMPOSE_PROJECT": "fullmag-test"}
        actual = {"Image": "sha256:" + "f" * 64, "Mounts": mounts, "Config": {
                  "Env": [k + "=" + v for k, v in environment.items()], "Labels": {
                      "org.fullmag.source.project-id": "project", "org.fullmag.source.worktree-id": "worktree",
                      "org.fullmag.source.checkout-kind": "worktree", "org.fullmag.compose.project": "fullmag-test"}},
                  "HostConfig": {"Mounts": [{"Target": p, "VolumeOptions": {"Subpath": v}}
                                            for p, v in volumes.items()]}}
        return control, actual

    def test_exact_mount_subpaths_and_no_candidate_build_gpu_or_network(self):
        control, actual = self.fixture()
        doc = recovery.diagnostic_document(control, actual, {}, evidence_root="verification/terminal-prestart-recovery-20261027/probes/" + "a" * 32)
        service = doc["services"]["terminal-prestart-proof"]
        mounts = {v["target"]: v for v in service["volumes"]}
        volume_names = {mount["source"] for mount in service["volumes"] if mount["type"] == "volume"}
        self.assertEqual(set(doc["volumes"]), volume_names)
        for name in volume_names:
            self.assertEqual(doc["volumes"][name], {"external": True, "name": name})
        self.assertEqual(mounts["/opt/fullmag/runtime-control"]["volume"]["subpath"], "runtime-control")
        self.assertEqual(mounts["/state/runs/docker-all/session-store/runtime-services"]["volume"]["subpath"],
                         "runtime-control/runtime-services")
        self.assertTrue(mounts["/opt/fullmag/package"]["read_only"])
        self.assertFalse(mounts["/state"]["read_only"])
        self.assertEqual(service["runtime"], "runc")
        self.assertEqual(service["cpus"], 1)
        self.assertEqual(service["healthcheck"], {"disable": True})
        self.assertTrue(mounts["/retained-state"]["read_only"])
        self.assertEqual(mounts["/retained-state"]["source"], mounts["/state"]["source"])
        self.assertTrue(mounts["/state/.linux-native-probe.json"]["read_only"])
        self.assertFalse(mounts["/evidence"]["read_only"])
        self.assertEqual(mounts["/evidence"]["source"], mounts["/state/.linux-native-probe.json"]["source"])
        self.assertEqual(mounts["/evidence"]["volume"]["subpath"] + "/linux-native-probe.json",
                         mounts["/state/.linux-native-probe.json"]["volume"]["subpath"])
        self.assertEqual(service["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"], "cpu")
        self.assertEqual(service["network_mode"], "none")
        self.assertNotIn("gpus", service)
        self.assertNotIn("/build", mounts)
        self.assertNotIn("/user-data", mounts)
        self.assertTrue(mounts["/opt/fullmag/source"]["read_only"])
        self.assertNotIn("candidate", json.dumps(service["volumes"]))

    def test_retained_storage_environment_is_exact_and_never_copies_capabilities(self):
        control, actual = self.fixture()
        expected = recovery.retained_storage_environment(control, actual)
        actual["Config"]["Env"].append("FULLMAG_LOCAL_COMPUTE_OPERATOR_TOKEN=private")
        self.assertEqual(recovery.retained_storage_environment(control, actual), expected)
        for key in recovery.STORAGE_ENVIRONMENT:
            for replacement in (None, "foreign"):
                with self.subTest(key=key, replacement=replacement):
                    changed = copy.deepcopy(actual)
                    changed["Config"]["Env"] = [item for item in changed["Config"]["Env"]
                                               if not item.startswith(key + "=")]
                    if replacement is not None: changed["Config"]["Env"].append(key + "=" + replacement)
                    with self.assertRaises(BuildControlError):
                        recovery.retained_storage_environment(control, changed)
        actual["Config"]["Env"].append("FULLMAG_SESSION_STORAGE_PROFILE=linux-native-v1")
        with self.assertRaises(BuildControlError):
            recovery.retained_storage_environment(control, actual)

    def test_unknown_timeout_preserves_helper_handle_and_never_returns_terminal_success(self):
        from docker_build_control import ControlOutcomeUnknown
        control, actual = self.fixture()
        writes = []
        control.write = lambda path, value: writes.append((path, copy.deepcopy(value)))
        baseline = {"path": "verification/before.json", "run_id": "run-saved",
                    "sha256": recovery.digest(b"{}")}
        with patch.object(reconcile, "read_raw", return_value=b"{}"),                 patch("docker_volume_pre_ack_retry._released_snapshot", return_value={"active_count": 0}),                 patch("docker_build_control.compose_capture", side_effect=ControlOutcomeUnknown("client timeout")) as observe:
            with self.assertRaises(ControlOutcomeUnknown):
                recovery.build_observation(control, actual, preflight(), baseline)
        self.assertEqual(writes[-1][1]["state"], "outcome-unknown-resources-retained")
        self.assertTrue(writes[-1][1]["helper_name"].startswith("fullmag-terminal-proof-"))
        self.assertNotIn("observation", writes[-1][1])
        self.assertEqual(observe.call_args.kwargs["timeout"], 600)
        self.assertIn("--name", observe.call_args.args)
        self.assertEqual(sum(path.endswith("/linux-native-probe.json") for path, _ in writes), 1)

    def test_unsupported_released_snapshot_subpath_is_rejected(self):
        control, actual = self.fixture()
        actual["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = "foreign"
        with self.assertRaises(BuildControlError): recovery.diagnostic_document(control, actual, {}, evidence_root="verification/terminal-prestart-recovery-20261027/probes/" + "a" * 32)

    def test_missing_duplicate_and_unsafe_volume_paths_rejected(self):
        control, actual = self.fixture()
        for change in (
            lambda a: a["Mounts"].pop(),
            lambda a: a["Mounts"].append(a["Mounts"][0]),
            lambda a: a["HostConfig"]["Mounts"][2]["VolumeOptions"].update(Subpath="../other"),
        ):
            with self.subTest(change=change):
                value = copy.deepcopy(actual); change(value)
                with self.assertRaises(BuildControlError): recovery.diagnostic_document(control, value, {}, evidence_root="verification/terminal-prestart-recovery-20261027/probes/" + "a" * 32)


class NativeProofAdapter(unittest.TestCase):
    """Run the real Python proof body against files and a mocked native CLI."""
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.state = self.base / "state"; self.state.mkdir()
        self.root = self.state / "runs/docker-all/session-store"; self.root.mkdir(parents=True)
        self.private = self.base / "private"; self.private.mkdir()
        self.private_probe = self.private / "linux-native-probe.json"
        self.certificate = self.base / "certificate.json"
        host = {"schema": "fullmag.linux-native-host.v1", "storage_profile": "linux-native-v1",
                "role": "session", "owner_scope": "docker-linux", "owner_token": "a" * 32,
                "engine_id": "engine", "image_id": "sha256:" + "f" * 64, "restart_verified": True}
        sentinel = (host["owner_token"] + ":" + host["image_id"]).encode()
        host["restart_expected_sha256"] = recovery.digest(sentinel)
        self.certificate.write_bytes(canonical(host))
        (self.state / ".fullmag-linux-native-owner.json").write_bytes(canonical(host))
        (self.state / ".linux-native-sentinel").write_bytes(sentinel)
        (self.state / ".linux-native-restart").write_bytes(sentinel)
        (self.state / ".linux-native-probe.json").write_bytes(b"original admission probe")
        self.probe_source_path = self.base / "linux_native_probe.py"
        probe_source = (Path(__file__).resolve().parents[1] / "docker/all-in-one/linux_native_probe.py").read_text()
        probe_source = probe_source.replace('Path("/state")', repr(self.state))
        probe_source = probe_source.replace('Path("/run/fullmag/linux-native-host.json")', repr(self.certificate))
        probe_source = probe_source.replace("PosixPath(", "Path(").replace("WindowsPath(", "Path(")
        self.probe_source_path.write_text(probe_source)
        self.storage_environment = {
            "FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1", "FULLMAG_DOCKER_HOST_ID": recovery.digest(b"engine"),
            "FULLMAG_RUNTIME_IMAGE_ID": host["image_id"], "FULLMAG_TOOLCHAIN_IMAGE_ID": "sha256:" + "e" * 64,
            "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev", "FULLMAG_COMPOSE_PROJECT": "fullmag-test"}
        self.config = self.base / "config.json"; self.config.write_bytes(b"configuration")
        self.provenance = self.base / "provenance.json"
        self.receipt = {"state": "succeeded", "source": {"resolved_commit": "a" * 40,
            "source_mode": "live-shadow-v1", "source_digest": "b" * 64},
            "native_source_identity": {"source_snapshot_sha256": "c" * 64},
            "native_source_identity_sha256": "d" * 64, "toolchain": {"image_id": "sha256:" + "e" * 64},
            "artifacts": [{"path": "bin/fullmag-bin", "sha256": "f" * 64}], "execution_lanes": {}}
        self.receipt_raw = canonical(self.receipt)
        self.published = {"schema": "fullmag.docker-all-image.v1", "state": "succeeded",
            "image_id": "sha256:" + "f" * 64, "build_receipt_sha256": recovery.digest(self.receipt_raw),
            "package_root": "/opt/fullmag/package", "backend_build_receipt": "/opt/fullmag/package/backend-build-receipt.json",
            "commit": "a" * 40, "source_mode": "live-shadow-v1", "source_digest": "b" * 64,
            "source_snapshot_sha256": "c" * 64, "native_source_identity": self.receipt["native_source_identity"],
            "native_source_identity_sha256": "d" * 64, "toolchain": self.receipt["toolchain"],
            "toolchain_image_id": "sha256:" + "e" * 64, "artifacts": self.receipt["artifacts"],
            "execution_lanes": {}, "binary_hashes": {"fullmag-bin": "f" * 64}}
        self.provenance.write_bytes(canonical(self.published))
        intent = {"run_id": "run-held", "specification": {"parameters": {
            "fullmag.accepted_run_start": {"schema_version": "accepted_run_start_policy.v1", "mode": "manual"}}}}
        self.write("runs/run-held/run_intent.json", canonical(intent))
        self.write("runs/run-held/run_catalog.json", b"held catalog")
        self.write("runs/run-terminal/run_catalog.json", b"terminal catalog")
        self.write("runs/run-saved/run_catalog.json", b"saved catalog")
        self.write("runs/run-saved/data.bin", b"scientific vector payload")
        self.write("solutions/solution/manifest.json", b"manifest")
        self.write("solutions/solution/data.bin", b"solution")
        records = {str(p.relative_to(self.root)): recovery.digest(p.read_bytes())
                   for p in self.root.rglob("*") if p.is_file()}
        self.baseline = {
            "all_run_catalogs": {k: v for k, v in records.items() if k.endswith("/run_catalog.json")},
            "full_run_files": {k.removeprefix("runs/run-saved/"): v for k, v in records.items()
                               if k.startswith("runs/run-saved/")},
            "recovered_solution_files": {k.removeprefix("solutions/solution/"): v for k, v in records.items()
                                        if k.startswith("solutions/solution/")}}
        self.payload = {"run_id": "run-terminal", "image_id": "sha256:" + "f" * 64,
            "storage_environment": self.storage_environment, "storage_probe_sha256": recovery.digest(self.probe_source_path.read_bytes()),
            "held": {"run-held": recovery.digest((self.root / "runs/run-held/run_intent.json").read_bytes())},
            "history_baseline": {"path": "verification/baseline.json",
                "sha256": recovery.digest(canonical(self.baseline))}, "history_run_id": "run-saved"}
        baseline_path = self.base / "control/verification/baseline.json"
        baseline_path.parent.mkdir(parents=True); baseline_path.write_bytes(canonical(self.baseline))
        self.writer = {"schema": "fullmag.writer.v1", "token": "11111111-1111-4111-8111-111111111111",
                       "process_start_token": "22222222-2222-4222-8222-222222222222", "host": "host", "pid": 12,
                       "acquired_at": "2026-10-27T10:00:00Z", "heartbeat_at": "2026-10-27T10:00:01Z", "released": True}
        self.native = {"schema_version": "runtime_service_terminal_run_evidence.v1", "run_id": "run-terminal",
                       "terminal_evidence_sha256": "a" * 64, "mutations_applied": False, "solve_replayed": False}

    def write(self, path, raw):
        target = self.root / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(raw)

    def run_probe(self, callback=None, *, overlay_path=None, private_mode=0o600, private_uid=65532):
        self.private_probe.write_bytes(b"{}"); self.private_probe.chmod(private_mode)
        fake = types.ModuleType("backend_dev")
        fake._validated_package = lambda *a, **kw: (self.receipt, self.receipt_raw, {})
        image_entrypoint = types.ModuleType("entrypoint")
        image_entrypoint._configure_device_access = lambda: "cpu"
        source = recovery.PROBE.replace('Path("/state/runs/docker-all/session-store")', repr(self.root))
        source = source.replace('Path("/opt/fullmag/runtime-control/runtime-service/docker-all.json")', repr(self.config))
        source = source.replace('Path("/opt/fullmag/control/backend/runtime-provenance.json")', repr(self.provenance))
        source = source.replace('Path("/opt/fullmag/control")', repr(self.base / "control"))
        source = source.replace('Path("/retained-state")', repr(self.state))
        source = source.replace('Path("/run/fullmag/linux-native-host.json")', repr(self.certificate))
        source = source.replace('Path("/opt/fullmag/source/docker/all-in-one/linux_native_probe.py")', repr(self.probe_source_path))
        source = source.replace('Path("/evidence/linux-native-probe.json")', repr(self.private_probe))
        source = source.replace('Path("/state/.linux-native-probe.json")', repr(overlay_path or self.private_probe))
        source = source.replace('Path("/evidence/namespace-observation.json")', repr(self.private / "namespace-observation.json"))
        # Path repr needs Path in the embedded namespace, not a platform class.
        source = source.replace("PosixPath(", "Path(").replace("WindowsPath(", "Path(")
        output = io.StringIO()
        real_run = subprocess.run
        real_stat = Path.stat
        class PrivateOwnerStat:
            # Model the managed file owner independently of the CI runner UID.
            def __init__(self, observed):
                self.observed = observed
                self.st_uid = private_uid

            def __getattr__(self, name):
                return getattr(self.observed, name)

        def private_stat(path, *args, **kwargs):
            observed = real_stat(path, *args, **kwargs)
            return PrivateOwnerStat(observed) if path == self.private_probe else observed

        def cli(argv, **kwargs):
            if argv[0] != "/opt/fullmag/package/bin/fullmag-bin":
                self.assertTrue(argv[:3] == ["stat", "-f", "-c"] or argv[:2] == [sys.executable, "-c"])
                return real_run(argv, **kwargs)
            self.assertEqual(argv[:3], ["/opt/fullmag/package/bin/fullmag-bin", "runtime", "service-inspect-terminal-run"])
            self.assertEqual(argv[-2:], ["--run-id", "run-terminal"])
            if callback: callback()
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(self.native), stderr="")
        with patch.dict(os.environ, self.storage_environment), patch.dict(sys.modules, {"backend_dev": fake, "entrypoint": image_entrypoint}), patch.object(sys, "path", list(sys.path)),                 patch.object(sys, "argv", ["proof", json.dumps(self.payload)]),                 patch("subprocess.run", side_effect=cli), patch.object(Path, "stat", private_stat), contextlib.redirect_stdout(output):
            exec(compile(source, "<terminal-proof-fixture>", "exec"), {})
        return json.loads(output.getvalue())

    def test_real_adapter_preserves_files_and_calls_only_native_terminal_inspection(self):
        value = self.run_probe(lambda: self.write("WRITER.owner.json", canonical(self.writer)))
        self.assertEqual(value["held_run_intent_sha256"], self.payload["held"])
        self.assertEqual(value["terminal_evidence_sha256"], "a" * 64)
        self.assertEqual(value["runtime_config_sha256"], recovery.digest(b"configuration"))

    def test_genuine_private_probe_preserves_original_admission_and_only_reports_volatile_namespace_locally(self):
        original = (self.state / ".linux-native-probe.json").read_bytes()
        first = self.run_probe()
        second = self.run_probe()
        self.assertEqual(first["storage_binding_sha256"], second["storage_binding_sha256"])
        self.assertEqual((self.state / ".linux-native-probe.json").read_bytes(), original)
        report = json.loads((self.private / "namespace-observation.json").read_bytes())
        self.assertEqual(report["stage"], "native-inspected")
        self.assertEqual(report["original_admission_before"], report["original_admission_after"])
        self.assertEqual(report["private_probe"]["mount_namespace_inode"], Path("/proc/self/ns/mnt").stat().st_ino)
        self.assertNotIn("mount_namespace_inode", first)
        self.assertNotIn("private_probe", first)

    def test_private_managed_uid_is_enforced_without_changing_the_host_file_owner(self):
        host_uid = os.getuid()
        accepted = self.run_probe(private_uid=65532)
        self.assertEqual(accepted["terminal_evidence_sha256"], self.native["terminal_evidence_sha256"])
        self.assertEqual(os.stat(self.private_probe).st_uid, host_uid)
        with self.assertRaisesRegex(RuntimeError, "inode/owner/permissions"):
            self.run_probe(private_uid=1001)
        self.assertEqual(os.stat(self.private_probe).st_uid, host_uid)

    def test_private_inode_permissions_and_source_pin_fail_closed(self):
        other = self.private / "other.json"; other.write_bytes(b"{}"); other.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, "inode/owner/permissions"):
            self.run_probe(overlay_path=other)
        with self.assertRaisesRegex(RuntimeError, "inode/owner/permissions"):
            self.run_probe(private_mode=0o644)
        original = self.probe_source_path.read_bytes()
        self.probe_source_path.write_bytes(original + b" ")
        with self.assertRaisesRegex(RuntimeError, "source changed"): self.run_probe()

    def test_original_probe_owner_sentinel_and_source_rewrites_during_native_proof_are_rejected(self):
        for path in (self.state / ".linux-native-probe.json", self.state / ".fullmag-linux-native-owner.json",
                     self.state / ".linux-native-sentinel", self.probe_source_path):
            with self.subTest(path=path):
                original = path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, "source or original storage"):
                    self.run_probe(lambda: path.write_bytes(original + b" "))
                path.write_bytes(original)

    def test_manual_gate_release_even_dangling_symlink_rejected(self):
        target = self.root / "runs/run-held/start_release.json"
        for link in (False, True):
            with self.subTest(link=link):
                if link: target.symlink_to(self.base / "missing")
                else: target.write_bytes(b"released")
                with self.assertRaises(RuntimeError): self.run_probe()
                target.unlink()

    def test_changed_history_manifest_and_manual_intent_rejected(self):
        for target in ("runs/run-saved/data.bin", "solutions/solution/manifest.json",
                       "runs/run-held/run_intent.json", "runs/run-terminal/run_catalog.json"):
            with self.subTest(target=target):
                p = self.root / target; old = p.read_bytes(); p.write_bytes(old + b" ")
                with self.assertRaises(RuntimeError): self.run_probe()
                p.write_bytes(old)

    def test_unverified_foreign_provenance_source_receipt_or_binary_inventory_rejected(self):
        for key, value in (("schema", "foreign"), ("state", "failed"), ("image_id", "sha256:" + "0" * 64),
                           ("commit", "0" * 40), ("build_receipt_sha256", "0" * 64),
                           ("binary_hashes", {"fullmag-bin": "0" * 64})):
            with self.subTest(key=key):
                self.provenance.write_bytes(canonical({**self.published, key: value}))
                with self.assertRaisesRegex(RuntimeError, "provenance"): self.run_probe()
        self.provenance.write_bytes(b"not-json")
        with self.assertRaises(ValueError): self.run_probe()

    def test_native_wrong_owner_solve_flag_or_publication_changed_rejected(self):
        for key, value in (("run_id", "foreign"), ("solve_replayed", True), ("mutations_applied", True)):
            with self.subTest(key=key):
                old = self.native[key]; self.native[key] = value
                with self.assertRaisesRegex(RuntimeError, "identity"): self.run_probe()
                self.native[key] = old
        with self.assertRaisesRegex(RuntimeError, "retained files"):
            self.run_probe(lambda: self.write("runs/run-terminal/changed.json", b"mutation"))

    def test_malformed_writer_schema_identity_and_timestamps_rejected(self):
        for value in ({"released": True}, {**self.writer, "schema": "foreign"},
                      {**self.writer, "pid": True}, {**self.writer, "token": "invalid"},
                      {**self.writer, "heartbeat_at": "2026-10-26T10:00:00Z"}):
            with self.subTest(value=value), self.assertRaises((RuntimeError, ValueError)):
                self.run_probe(lambda: self.write("WRITER.owner.json", canonical(value)))

    def test_native_nanosecond_writer_timestamps_preserve_precision_and_timezone(self):
        cases = (
            ("2026-10-27T21:18:59.543852682+00:00", "2026-10-27T21:18:59.543852683+00:00"),
            ("2026-10-27T21:18:59.543852682Z", "2026-10-27T21:18:59.543852683Z"),
            ("2026-10-27T23:18:59.543852682+02:00", "2026-10-27T21:18:59.543852683Z"),
            ("2026-10-27T19:48:59.543852682-01:30", "2026-10-27T21:18:59.543852683Z"),
        )
        for acquired, heartbeat in cases:
            with self.subTest(acquired=acquired, heartbeat=heartbeat):
                owner = {**self.writer, "acquired_at": acquired, "heartbeat_at": heartbeat}
                value = self.run_probe(lambda: self.write("WRITER.owner.json", canonical(owner)))
                self.assertEqual(value["terminal_evidence_sha256"], self.native["terminal_evidence_sha256"])

    def test_writer_order_reversed_within_one_microsecond_is_rejected(self):
        owner = {**self.writer, "acquired_at": "2026-10-27T21:18:59.543852683+00:00",
                 "heartbeat_at": "2026-10-27T21:18:59.543852682Z"}
        with self.assertRaisesRegex(RuntimeError, "timestamps are malformed"):
            self.run_probe(lambda: self.write("WRITER.owner.json", canonical(owner)))

    def test_writer_timestamp_requires_valid_calendar_offset_and_at_most_nine_digits(self):
        malformed = (None, 123, "2026-10-27T21:18:59.543852683",
                     "2026-10-27T21:18:59.5438526830Z", "2026-10-27T21:18:59.Z",
                     "2026-10-27T21:18:59+24:00", "2026-10-27T21:18:59+00:60",
                     "2026-02-30T21:18:59Z", "2026-10-27T21:18:60Z",
                     "2026-10-27 21:18:59Z", "2026-10-27T21:18:59Z trailing")
        for value in malformed:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "timestamps are malformed"):
                owner = {**self.writer, "heartbeat_at": value}
                self.run_probe(lambda: self.write("WRITER.owner.json", canonical(owner)))

    def test_post_native_manual_release_and_unreleased_writer_rejected(self):
        with self.assertRaises(RuntimeError):
            self.run_probe(lambda: self.write("runs/run-held/start_release.json", b"new release"))
        (self.root / "runs/run-held/start_release.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "not released"):
            self.run_probe(lambda: self.write("WRITER.owner.json", canonical({**self.writer, "released": False})))


class LifecycleDelegation(unittest.TestCase):
    def fixture(self):
        from contextlib import ExitStack
        stack = ExitStack(); self.addCleanup(stack.close)
        probe = preflight()
        owner = {"children": [], "owner_token": "old", "process_start_token": "process"}
        receipt = {"schema": "fullmag.docker-process-tree.v1", "state": "drained",
                   "service_owner": owner, "terminal_service_owner": dict(owner)}
        raw = canonical(receipt)
        state = {"Status": "exited", "Pid": 0, "Running": False, "Paused": False,
                 "Restarting": False, "OOMKilled": False, "Dead": False, "ExitCode": 0, "Error": ""}
        actual = {"backend": {"Id": "backend", "State": dict(state)},
                  "frontend": {"Id": "frontend", "State": dict(state)}}
        actual["backend"]["State"].update(ExitCode=128, Error="error running prestart hook #0: "
            "nvidia-container-cli: ldcache error: process /sbin/ldconfig terminated with signal 9")
        drain = {"schema": "fullmag.docker-idle-restart-drain.v1", "backend_container_id": "backend",
                 "process_receipt_sha256": recovery.digest(raw), "process_receipt": receipt}
        previous = {"state": "failed-confirmed", "attempt": "a" * 32}
        docs = {"root/terminal-session-preflight.json": canonical(probe), "root/backend-drain.json": canonical(drain),
                "development/attempts/" + "a" * 32 + "/terminal.json": canonical(previous)}
        failure = {"drain_sha256": recovery.digest(canonical(drain)), "preflight_sha256": recovery.digest(canonical(probe)),
                   "error_sha256": recovery.digest(actual["backend"]["State"]["Error"].encode()),
                   "previous_receipt_sha256": recovery.digest(canonical(previous)),
                   **{name + "_state_sha256": recovery.digest(canonical(actual[name]["State"])) for name in actual}}
        request = {"failure": failure, "prestart_helper_sha256": recovery.digest(Path(recovery.__file__).read_bytes()),
                   "observation": observation(), "history_baseline": {}}
        original = {"terminal_session_preflight_sha256": recovery.digest(canonical(probe)),
                    "inputs": {"attempt": "a" * 32}}
        stack.enter_context(patch.object(reconcile, "read_raw", side_effect=lambda c, p, **kw: docs.get(p)))
        stack.enter_context(patch.object(recovery, "prior_publication",
            return_value={"backend_build_receipt_sha256": observation()["package_receipt_sha256"]}))
        native = stack.enter_context(patch("docker_volume_stop_unadmitted._read_terminal_process_receipt",
                                           return_value=(raw, receipt)))
        observed = stack.enter_context(patch.object(recovery, "build_observation", return_value=observation()))
        return types.SimpleNamespace(), request, original, actual, docs, native, observed

    def test_failure_checks_authenticated_drain_original_package_and_fresh_evidence(self):
        control, request, original, actual, docs, native, observed = self.fixture()
        self.assertEqual(recovery.validate_failure(control, "root", request, original, actual, None), request["failure"])
        native.assert_called_once_with(actual["backend"], control)
        observed.assert_called_once()

    def test_recomputed_state_pins_do_not_authorize_new_pid_oom_or_build(self):
        control, request, original, actual, docs, native, observed = self.fixture()
        for key, value in (("Pid", 2), ("OOMKilled", True), ("ExitCode", 2)):
            with self.subTest(key=key):
                changed = copy.deepcopy(actual); changed["backend"]["State"][key] = value
                pinned = copy.deepcopy(request)
                pinned["failure"]["backend_state_sha256"] = recovery.digest(canonical(changed["backend"]["State"]))
                with self.assertRaises(BuildControlError):
                    recovery.validate_failure(control, "root", pinned, original, changed, None)
        for key, value in (("backend_started_at", "new"), ("saved_authoring_restore_required", {"archive": "foreign"})):
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_failure(control, "root", request, {**original, key: value}, actual, None)
        docs["root/backend-build-receipt.json"] = b"new publication"
        with self.assertRaises(BuildControlError):
            recovery.validate_failure(control, "root", request, original, actual, None)
        observed.assert_not_called()

    def test_original_receipt_or_fresh_observation_mismatch_rejected(self):
        control, request, original, actual, docs, native, observed = self.fixture()
        observed.return_value = {**observation(), "terminal_evidence_sha256": "c" * 64}
        with self.assertRaises(BuildControlError):
            recovery.validate_failure(control, "root", request, original, actual, None)
        docs["development/attempts/" + "a" * 32 + "/terminal.json"] += b" "
        observed.reset_mock()
        with self.assertRaises(BuildControlError):
            recovery.validate_failure(control, "root", request, original, actual, None)
        observed.assert_not_called()

    def test_completion_accepts_only_finish_qualified_new_generation_and_unchanged_science(self):
        context = {"request": {"observation": observation(), "history_baseline": {},
                              "containers": {"backend": {"image": "sha256:" + "f" * 64}}}, "probe": preflight()}
        operation = {"root": "resume/attempt", "daemon_pending": True}
        writes = []
        control = types.SimpleNamespace(write=lambda *args: writes.append(args))
        actual = [{"Id": "backend", "Image": "sha256:" + "f" * 64,
                   "State": {"Running": True, "StartedAt": "new"}}]
        qualified = {"backend_container_id": "backend", "backend_started_at": "new",
            "image_id": actual[0]["Image"], "package_receipt_sha256": "c" * 64,
            "provenance_sha256": "d" * 64, "runtime_config_sha256": "e" * 64}
        updated = {**observation(), **{k: qualified[k] for k in
                    ("package_receipt_sha256", "provenance_sha256", "runtime_config_sha256")}}
        with patch("docker_build_control.docker_text", return_value=json.dumps(actual)),                 patch.object(recovery, "build_observation", return_value=updated) as observed:
            for changed in ({**updated, "recovery_store_sha256": "0" * 64},
                            {**updated, "package_receipt_sha256": "0" * 64},
                            {**updated, "held_run_intent_sha256": {}}):
                observed.return_value = changed
                with self.assertRaises(BuildControlError):
                    recovery.complete(control, operation, "backend", context, qualified)
                self.assertTrue(operation["daemon_pending"])
                self.assertEqual(writes, [])
            with self.assertRaises(BuildControlError):
                recovery.complete(control, operation, "backend", context, {})
            observed.return_value = updated
            recovery.complete(control, operation, "backend", context, qualified)
        self.assertFalse(operation["daemon_pending"])
        self.assertFalse(writes[0][1]["solve_replayed"])
        self.assertFalse(writes[0][1]["authoring_restored"])
        self.assertEqual(writes[0][1]["observation"]["package_receipt_sha256"], "c" * 64)


class PublicationAndContinuation(unittest.TestCase):
    def test_exact_successful_iteration_witness_and_not_failed_base_is_package_authority(self):
        original = {"inputs": {"attempt": "a" * 32}, "control_volume": "owned", "state_root": "/state", "backend_volumes": ["v"], "frontend_volume": "f"}
        pins = {"backend": {"id": "backend", "image": "sha256:" + "b" * 64, "started_at": "old"},
                "frontend": {"id": "frontend"}}
        published = {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration", "state": "succeeded",
            "attempt": "c" * 32, "compose_project": "group", "control_volume": "owned", "config_sha256": "d" * 64,
            "inputs": {"attempt": "a" * 32, "source_root": "/source", "config_sha256": "d" * 64,
                       "image_id": pins["backend"]["image"]},
            "backend_container": "backend", "frontend_container": "frontend", "backend_started_at": "old",
            "backend_build_receipt_sha256": "e" * 64, **{k: original[k] for k in
                ("state_root", "backend_volumes", "frontend_volume")}}
        raw = canonical(published)
        request = {"prior_publication": {"attempt": "c" * 32, "sha256": recovery.digest(raw)},
                   "compose_project": "group", "source_root": "/source", "config_sha256": "d" * 64, "containers": pins}
        docs = {"iteration/attempts/" + "c" * 32 + "/terminal.json": raw, "iteration/verified.json": raw}
        with patch.object(reconcile, "read_raw", side_effect=lambda c, p: docs[p]):
            self.assertEqual(recovery.prior_publication(types.SimpleNamespace(volume="owned", namespace=""), request, original), published)
            with self.assertRaises(BuildControlError):
                recovery.prior_publication(types.SimpleNamespace(volume="owned", namespace="namespaces/foreign"),
                                           request, original)
            for key, value in (("state", "failed-confirmed"), ("phase", "resume"),
                               ("backend_started_at", "different"), ("backend_container", "foreign"), ("control_volume", "foreign")):
                changed = canonical({**published, key: value})
                docs["iteration/attempts/" + "c" * 32 + "/terminal.json"] = changed
                docs["iteration/verified.json"] = changed
                repinned = {**request, "prior_publication": {"attempt": "c" * 32, "sha256": recovery.digest(changed)}}
                with self.subTest(key=key), self.assertRaises(BuildControlError):
                    recovery.prior_publication(types.SimpleNamespace(volume="owned", namespace=""), repinned, original)
            docs["iteration/attempts/" + "c" * 32 + "/terminal.json"] = raw
            docs["iteration/verified.json"] = b"new verified witness"
            with self.assertRaises(BuildControlError): recovery.prior_publication(types.SimpleNamespace(volume="owned", namespace=""), request, original)

    def test_terminal_request_and_terminal_cas_fences_precede_proof_and_old_v1_stays_separate(self):
        import docker_volume_prestart_recovery as legacy
        reference = "a" * 32
        root = "iteration/attempts/" + reference
        original_raw = b"{}"
        request = {"schema": recovery.SCHEMA, "attempt": reference, "config_sha256": "b" * 64,
                   "source_root": "/source", "compose_project": "group", "failure": {"proof": "pin"},
                   "unknown_receipt_sha256": recovery.digest(original_raw), "containers": {}}
        actual = {}
        for name in ("backend", "frontend"):
            actual[name] = {"Id": name, "Image": "image", "State": {"StartedAt": "old"},
                            "Config": {}, "HostConfig": {}, "Mounts": []}
            request["containers"][name] = {"id": name, "image": "image", "started_at": "old",
                                          "fingerprint": reconcile.fingerprint(actual[name])}
        request_raw = canonical(request)
        terminal = {"state": "failed-confirmed", "phase": "iteration", "attempt": reference,
                    "inputs": {"attempt": "c" * 32, "config_sha256": "b" * 64, "source_root": "/source"},
                    "state_root": "/state", "compose_project": "group", "terminal_prestart_failure_proof": request["failure"],
                    "reconciliation": {"request": "verification/request.json", "request_sha256": recovery.digest(request_raw),
                                       "evidence": request["failure"]}}
        terminal_raw = canonical(terminal)
        docs = {root + "/terminal.json": terminal_raw, "verification/request.json": request_raw,
                root + "/unknown-receipt.json": original_raw, root + "/terminal-session-preflight.json": canonical(preflight())}
        args = types.SimpleNamespace(prestart_reconciliation=reference,
            prestart_reconciliation_sha256=recovery.digest(terminal_raw), restart_backend=True,
            attempt="c" * 32, config_sha256="b" * 64)
        control = types.SimpleNamespace(project="group")
        document = {"services": {"backend": {"environment": {}}}}
        with patch.object(reconcile, "read_raw", side_effect=lambda c, p, **kw: docs[p]),                 patch.object(reconcile, "validate_request"), patch.object(recovery, "validate_failure") as proof:
            context = recovery.continuation(control, args, {"state_root": "/state"}, document, actual, None)
            self.assertEqual(context["kind"], "terminal_history"); proof.assert_called_once()
            for path in (root + "/terminal.json", "verification/request.json"):
                old = docs[path]; docs[path] += b" "
                proof.reset_mock()
                with self.subTest(path=path), self.assertRaises(BuildControlError):
                    recovery.continuation(control, args, {"state_root": "/state"}, document, actual, None)
                proof.assert_not_called(); docs[path] = old
            old_request = canonical({"schema": legacy.SCHEMA})
            docs["verification/request.json"] = old_request
            terminal["reconciliation"]["request_sha256"] = recovery.digest(old_request)
            docs[root + "/terminal.json"] = canonical(terminal)
            args.prestart_reconciliation_sha256 = recovery.digest(docs[root + "/terminal.json"])
            self.assertIsNone(recovery.continuation(control, args, {}, {}, {}, None))
            proof.assert_not_called()


if __name__ == "__main__":
    unittest.main()
