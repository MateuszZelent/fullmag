"""Exercise abandoned-guest pins through the real fresh-state caller and CLI."""
from contextlib import ExitStack, redirect_stderr
from copy import deepcopy
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import MappingProxyType, ModuleType, SimpleNamespace
import unittest
from unittest import mock

import docker_dev
import docker_volume_dev as dev
import test_docker_volume_pre_admission_integration as fixtures
from test_just_development_recovery_shell import DevelopmentRecoveryShellTests


class AbandonedDiagnosticCallerTests(unittest.TestCase):
    def harness(self):
        harness = fixtures._Harness()
        self.addCleanup(harness.close)
        harness.args.fresh_state = True
        harness.args.abandoned_diagnostic_proof = "verification/guest/fresh-proof.json"
        harness.args.abandoned_diagnostic_proof_sha256 = "f" * 64
        harness.previous["backend_container"] = "a" * 64
        harness.control.operation_value.value["helper_container_id"] = "e" * 64
        return harness

    def run_caller(self, harness, *, reject_at=None):
        original = deepcopy(harness.previous)
        replacement = deepcopy(harness.document)
        replacement["services"]["backend"].update(init=False, entrypoint=["diagnostic-guest"])
        metadata = {"schema": "fresh-guest-fixture", "proof_sha256": "f" * 64}
        context = SimpleNamespace(
            compose_document=replacement,
            expected_id=lambda service: harness.actual[service]["Id"],
            metadata=MappingProxyType(metadata),
        )
        module = ModuleType("docker_volume_succeeded_guest_abandon")
        def load(_control, _args, previous, document, _selected, **kwargs):
            self.assertEqual(previous, original)
            self.assertEqual(document, harness.document)
            self.assertTrue(kwargs["recreate_services"])
            return context
        calls = []
        def validate(_control, observed, actual, _selected, **kwargs):
            self.assertIs(observed, context)
            self.assertEqual(actual, harness.actual)
            calls.append(kwargs)
            event = "guest-proof-" + str(len(calls))
            harness.events.append(event)
            if len(calls) == 1:
                self.assertNotIn("lease-enter", harness.events)
                self.assertEqual(kwargs, {})
            else:
                self.assertIn("lease-enter", harness.events)
                self.assertEqual(kwargs["operation_helper_id"], "e" * 64)
            if len(calls) == reject_at:
                raise dev.BuildControlError("abandoned guest proof changed")
        module.load_fresh_context = load
        module.validate_context = validate
        helper = fixtures._helper_module(harness)
        with mock.patch.dict(sys.modules, {module.__name__: module}):
            result, started = fixtures.RetainedPreAdmissionIntegrationTests()._run(
                harness, helper=helper,
            )
        self.assertEqual(harness.previous, original)
        return result, started, calls, metadata

    def test_fresh_guest_pins_replace_only_the_current_incarnation_and_archive_old_state(self):
        harness = self.harness()
        result, started, calls, metadata = self.run_caller(harness)
        self.assertEqual(result, {"started": True})
        self.assertEqual(len(calls), 3)
        self.assertEqual(harness.control.image, harness.previous["inputs"]["image_id"])
        self.assertLess(harness.events.index("guest-proof-1"), harness.events.index("lease-enter"))
        self.assertLess(harness.events.index("guest-proof-2"), harness.events.index("rm"))
        self.assertLess(harness.events.index("guest-proof-3"), harness.events.index("rm"))
        harness.archive_runtime_control.assert_called_once()
        self.assertEqual(harness.control.operation_value.value["receipt"]["abandoned_diagnostic"], metadata)
        json.dumps(harness.control.operation_value.value["receipt"])
        self.assertEqual(started.call_args.kwargs["reuse_state"], None)
        self.assertFalse(any(path in {"development/current.json", "development/verified.json"}
                             for path, _ in harness.control.writes))

    def test_proof_drift_before_lease_or_at_either_mutation_boundary_prevents_removal(self):
        for boundary in (1, 2, 3):
            with self.subTest(boundary=boundary):
                harness = self.harness()
                with self.assertRaisesRegex(dev.BuildControlError, "proof changed"):
                    self.run_caller(harness, reject_at=boundary)
                self.assertNotIn("rm", harness.events)
                harness.archive_runtime_control.assert_not_called()

    def test_fresh_state_without_proof_keeps_the_original_recorded_incarnation_guard(self):
        harness = self.harness()
        harness.args.abandoned_diagnostic_proof = None
        harness.args.abandoned_diagnostic_proof_sha256 = None
        helper = fixtures._helper_module(harness)
        with self.assertRaisesRegex(dev.BuildControlError, "Recorded container incarnation differs"):
            fixtures.RetainedPreAdmissionIntegrationTests()._run(harness, helper=helper)
        self.assertNotIn("lease-enter", harness.events)
        self.assertNotIn("rm", harness.events)


class FreshLedgerComposeBoundaryTests(unittest.TestCase):
    def run_start(self, *, configured=None, refuse_claim=False,
                  initialized=False, both=False):
        control = SimpleNamespace(project="fullmag-master")
        operation = {"receipt": {"fresh_group_ledger_admission": {"generation": "a" * 32}},
                     "daemon_pending": False}
        if initialized:
            operation["receipt"] = {"initialized_group_ledger_readmission": {"schema": "fixture"}}
            if both:
                operation["receipt"]["fresh_group_ledger_admission"] = {"generation": "a" * 32}
        document = {"name": control.project, "services": {"backend": {}, "frontend": {}}}
        configured = document if configured is None else configured
        events = []
        def capture(_document, *args, **_kwargs):
            events.append(args[0])
            if args[0] == "config":
                return json.dumps(configured).encode()
            if args[0] == "ps":
                return ("b" if args[-1] == "backend" else "c").encode() * 64
            return b""
        def claim(_control, observed):
            self.assertIs(observed, operation)
            self.assertEqual(observed["receipt"]["compose_preflight"], "PASS")
            self.assertFalse(observed["daemon_pending"])
            events.append("claim")
            if refuse_claim:
                raise dev.BuildControlError("fresh ledger claim refused")
        module = ModuleType("docker_group_ledger_relocation")
        module.commit_fresh_ledger_admission = claim
        def initialized_check(_control, observed):
            self.assertIs(observed, operation)
            self.assertEqual(observed["receipt"]["compose_preflight"], "PASS")
            self.assertFalse(observed["daemon_pending"])
            events.append("initialized-check")
            if refuse_claim:
                raise dev.BuildControlError("initialized ledger proof refused")
        module.revalidate_initialized_ledger_readmission = initialized_check
        with mock.patch.dict(sys.modules, {module.__name__: module}), \
             mock.patch.object(dev, "compose_capture", side_effect=capture), \
             mock.patch.object(dev, "_record_service_pins"):
            try:
                result = dev._start_compose_services(control, operation, document)
            except dev.BuildControlError as error:
                return operation, events, error
        return operation, events, result

    def test_initialized_readmission_revalidates_after_config_before_create(self):
        operation, events, result = self.run_start(initialized=True)
        self.assertEqual(result, ("b" * 64, "c" * 64))
        self.assertEqual(events, ["config", "initialized-check", "create", "ps", "ps", "up"])
        self.assertFalse(operation["daemon_pending"])

    def test_initialized_refusal_prevents_all_daemon_mutations(self):
        operation, events, error = self.run_start(initialized=True, refuse_claim=True)
        self.assertIsInstance(error, dev.BuildControlError)
        self.assertEqual(events, ["config", "initialized-check"])
        self.assertFalse(operation["daemon_pending"])

    def test_fresh_and_initialized_proofs_are_mutually_exclusive(self):
        operation, events, error = self.run_start(initialized=True, both=True)
        self.assertIsInstance(error, dev.BuildControlError)
        self.assertEqual(events, ["config"])
        self.assertFalse(operation["daemon_pending"])

    def test_fresh_claim_commits_after_preflight_before_first_daemon_create(self):
        operation, events, result = self.run_start()
        self.assertEqual(result, ("b" * 64, "c" * 64))
        self.assertEqual(events, ["config", "claim", "create", "ps", "ps", "up"])
        self.assertFalse(operation["daemon_pending"])

    def test_invalid_compose_does_not_consume_fresh_claim(self):
        operation, events, error = self.run_start(configured={"name": "foreign", "services": {}})
        self.assertIn("preflight", str(error))
        self.assertEqual(events, ["config"])
        self.assertFalse(operation["daemon_pending"])

    def test_claim_refusal_prevents_all_daemon_mutations(self):
        operation, events, error = self.run_start(refuse_claim=True)
        self.assertIn("claim refused", str(error))
        self.assertEqual(events, ["config", "claim"])
        self.assertFalse(operation["daemon_pending"])


class FreshLedgerHelperImageCallerTests(unittest.TestCase):
    base_image = "sha256:" + "1" * 64
    dev_image = "sha256:" + "2" * 64
    backend_image = "sha256:" + "3" * 64

    def exercise_start(self, generation, *, archive_error=None, dev_image=None):
        import docker_volume_cancelled_activation_guard as cancelled
        import fullmag_docker_runtime as runtime

        class BeforeLease(RuntimeError):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary).resolve(strict=True)
            args = SimpleNamespace(repo_root=source, source_root=source, port=3203,
                port_explicit=True, profile="dev", image=None, toolchain_image=None,
                source_manifest=None, include_untracked=None, gpu_access="disabled",
                script=None, fresh_state=False)
            control = mock.Mock(project="fresh-ledger-group", image=self.base_image)
            control.read.return_value = generation
            images = {"dev": {"image_id": self.dev_image if dev_image is None else dev_image},
                      "backend": {"image_id": self.backend_image}}
            observed = []
            def before_lease(phase, inputs):
                observed.append((phase, control.image, deepcopy(inputs)))
                raise BeforeLease("Stopped before creating an operation helper")
            control.operation.side_effect = before_lease
            with ExitStack() as stack:
                for patch in (
                    mock.patch.object(dev, "require_host"),
                    mock.patch.object(dev, "_session_host"),
                    mock.patch.object(docker_dev, "_select_source", return_value=(source, {
                        "storage_root": str(source), "runtime_root": str(source)})),
                    mock.patch.object(docker_dev, "_compose_identity", return_value={
                        "project_name": control.project, "project_id": "project",
                        "worktree_id": "worktree", "checkout_kind": "worktree"}),
                    mock.patch.object(dev, "validate_host_path"),
                    mock.patch.object(dev, "local_volume"),
                    mock.patch.object(docker_dev, "_assert_no_running_fullmag"),
                    mock.patch.object(runtime, "assert_loopback_port_available"),
                    mock.patch.object(docker_dev, "_operator_probe_environment_from_host", return_value={}),
                    mock.patch.object(dev, "_operator_probe_record", return_value={}),
                    mock.patch.object(docker_dev, "_resolve_gpu_access", return_value="cpu"),
                    mock.patch.object(docker_dev, "_verify_docker_gpu_access", return_value="cpu"),
                    mock.patch.object(dev, "build_volume_toolchain", return_value={
                        "inputs": {"build_args": {"FULLMAG_CUDA_BASE_IMAGE": self.base_image}}}),
                    mock.patch.object(dev, "BuildControl", return_value=control),
                    mock.patch.object(dev, "build_volume_runtime_images", return_value=images),
                    mock.patch.object(dev, "_active_isolated_snapshot", return_value=None),
                    mock.patch.object(cancelled, "assert_start_allowed"),
                ):
                    stack.enter_context(patch)
                archive = stack.enter_context(mock.patch(
                    "docker_volume_fresh_runtime.pinned_group_archive", side_effect=archive_error))
                try:
                    dev.start(args)
                except (BeforeLease, dev.BuildControlError) as error:
                    return control, archive, observed, error
                self.fail("Real start caller did not reach the pre-lease boundary")

    def test_authenticated_fresh_archive_selects_dev_helper_before_lease(self):
        generation = {"generation": "a" * 32}
        control, archive, observed, error = self.exercise_start(generation)
        archive.assert_called_once_with(control, generation)
        self.assertEqual(observed[0][:2], ("development", self.dev_image))
        self.assertEqual(observed[0][2]["image_id"], self.backend_image)
        self.assertIn("before creating", str(error))

    def test_archive_drift_refuses_before_helper_image_change_or_operation(self):
        control, archive, observed, error = self.exercise_start(
            {"generation": "a" * 32}, archive_error=dev.BuildControlError("Archive CAS changed"))
        archive.assert_called_once()
        self.assertEqual(control.image, self.base_image)
        control.operation.assert_not_called()
        self.assertEqual(observed, [])
        self.assertIn("Archive CAS changed", str(error))

    def test_ordinary_start_without_generation_keeps_base_helper(self):
        control, archive, observed, _error = self.exercise_start(None)
        archive.assert_not_called()
        self.assertEqual(observed[0][:2], ("development", self.base_image))
        self.assertEqual(control.image, self.base_image)

    def test_mutable_dev_tag_cannot_create_first_admission_helper(self):
        control, _archive, observed, error = self.exercise_start(
            {"generation": "a" * 32}, dev_image="fullmag/development-dev:latest")
        self.assertEqual(control.image, self.base_image)
        control.operation.assert_not_called()
        self.assertEqual(observed, [])
        self.assertIn("not immutable", str(error))


class FrontendGeneratedSeedReconciliationTests(unittest.TestCase):
    def seed_workspace(self, *, frozen=False, generated=True, unknown=False):
        import base64
        import hashlib
        import shlex
        import docker_development_inputs
        import docker_group_storage
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            relative = "apps/control-room/next-env.d.ts" if generated else "package.json"
            canonical_seed = b'/// <reference types="next" />\nimport "./.next/types/routes.d.ts";\n'
            generated_seed = canonical_seed.replace(b".next/types/", b".next-control-room-3203/dev/types/")
            old_bytes = b"unexpected user content" if unknown else generated_seed
            target = root / "workspace" / relative
            target.parent.mkdir(parents=True)
            target.write_bytes(old_bytes)
            manifest = {"files": [{"relative": relative,
                                  "sha256": hashlib.sha256(canonical_seed).hexdigest()}]}
            if frozen:
                freeze = {"schema": "fullmag.docker-development-inputs-freeze.v1",
                          "frozen_root": "/state/development/frozen-inputs",
                          "manifest": manifest, "manifest_digest": hashlib.sha256((json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest(),
                          "files": manifest["files"]}
                (root / "inputs-freeze.json").write_bytes(dev.canonical(freeze))
            control = mock.Mock(project="fullmag-master", volume="private-volume", image="helper-image")
            control.read.return_value = manifest
            control.helper_args.side_effect = lambda command: ["--entrypoint", "bash", control.image, "-c", command]
            operation = {"root": "development/attempts/test", "receipt": {}}
            def seed(_selected, _state, _port, *, write_file):
                write_file(relative, canonical_seed)
                return deepcopy(manifest)
            def capture(args, *, data, **_kwargs):
                script = shlex.split(args[-1])[-1].replace("/data", str(root))
                return subprocess.run([sys.executable, "-I", "-c", script], input=data, capture_output=True)
            with mock.patch.object(docker_development_inputs, "seed", side_effect=seed), \
                 mock.patch.object(docker_development_inputs, "metadata_cache_key", return_value="key"), \
                 mock.patch.object(dev, "_uses_private_group_storage", return_value=True), \
                 mock.patch.object(docker_group_storage, "cli_mount_args", return_value=[]), \
                 mock.patch.object(dev, "bounded_capture", side_effect=capture):
                try:
                    dev._frontend(control, operation, Path("/source"), Path("/state"), 3203, control.image)
                    error = None
                except dev.BuildControlError as observed:
                    error = observed
            return target.read_bytes(), canonical_seed, old_bytes, error

    def test_generated_seed_is_canonical_before_a_new_freeze(self):
        actual, canonical_seed, _old, error = self.seed_workspace()
        self.assertIsNone(error)
        self.assertEqual(actual, canonical_seed)

    def test_existing_freeze_preserves_next_generated_bytes(self):
        actual, _canonical, old_bytes, error = self.seed_workspace(frozen=True)
        self.assertIsNone(error)
        self.assertEqual(actual, old_bytes)

    def test_unknown_dependency_file_still_refuses_and_preserves_bytes(self):
        actual, _canonical, old_bytes, error = self.seed_workspace(generated=False, unknown=True)
        self.assertIn("unknown changes", str(error))
        self.assertEqual(actual, old_bytes)


class PrivateLayoutResumeCallerTests(unittest.TestCase):
    def exercise_resume(self, *, seed_failure=False, private=True, invalid_layout=False):
        import hashlib
        import docker_build_control
        import docker_backend_volume_cache
        import docker_development_inputs
        import docker_group_storage
        import docker_volume_cancelled_activation_guard as cancelled

        harness = fixtures._Harness()
        self.addCleanup(harness.close)
        harness.args.restart_backend = True
        harness.document["services"]["backend"]["environment"].update(
            FULLMAG_SOURCE_GIT_COMMON=str(harness.source), FULLMAG_TOOLCHAIN_IMAGE_ID=fixtures.IMAGE)
        harness.args.config_sha256 = hashlib.sha256(dev.canonical(harness.document)).hexdigest()
        if private:
            harness.previous["private_group_storage"] = "bad-layout" if invalid_layout else "group-volume-v1"
        operation = harness.control.operation_value.value
        operation["root"] = "resume/attempts/" + "1" * 32
        operation["receipt"]["phase"] = "resume"
        original_read = harness.control.read
        def read(relative, *, optional=False):
            if relative == "private/.owner.json":
                return {"schema": "fullmag.docker-group-storage-owner.v1"} if private else None
            if relative.endswith("/backend-cache.json"):
                return {"cache": "retained"}
            return original_read(relative, optional=optional)
        harness.control.read = read
        harness.control.operation = lambda phase, _inputs: harness.control.operation_value if phase == "resume" else self.fail(phase)
        harness.control.image = "sha256:" + "e" * 64
        harness.control.helper_args = lambda command: ["--entrypoint", "bash", harness.control.image, "-c", command]
        events = []
        def compose(document, *arguments, **kwargs):
            if arguments[0] == "start":
                self.assertTrue(operation["daemon_pending"])
                events.append(("start", arguments[-1]))
                return b""
            return harness.compose_capture(document, *arguments, **kwargs)
        def docker_text(*arguments, **kwargs):
            if arguments[0] == "inspect" and len(arguments) > 2:
                by_id = {row["Id"]: row for row in harness.actual.values()}
                return json.dumps([by_id[identifier] for identifier in arguments[1:]])
            return harness.docker_text(*arguments, **kwargs)
        def seed(*_args, write_file):
            write_file("package.json", b"{}")
            return {"files": [], "live_directories": []}
        def frontend_capture(_args, *, data, **_kwargs):
            self.assertFalse(operation["daemon_pending"])
            request = json.loads(data)
            self.assertEqual(request["group_storage"], private)
            events.append(("seed", private))
            return subprocess.CompletedProcess([], 1 if seed_failure else 0,
                b"" if seed_failure else dev.canonical({"state": "seeded", "inputs": request["inputs"]}),
                b"controlled seed failure" if seed_failure else b"")
        configuration = {"services": {"fem-gpu-toolchain": {"build": {"args": {
            "FULLMAG_CUDA_BASE_IMAGE": harness.control.image}}}}}
        with ExitStack() as stack:
            for patch in (
                mock.patch.object(dev, "require_host"),
                mock.patch.object(docker_dev, "_select_source", return_value=(harness.source, {"runtime_root": str(harness.state)})),
                mock.patch.object(docker_dev, "_compose_identity", return_value=harness.identity),
                mock.patch.object(docker_build_control, "toolchain_configuration", return_value=configuration),
                mock.patch.object(dev, "BuildControl", return_value=harness.control),
                mock.patch.object(dev, "_operator_probe_record_from_retained", return_value={}),
                mock.patch.object(cancelled, "_read_control_bytes", return_value=None),
                mock.patch.object(dev, "compose_capture", side_effect=compose),
                mock.patch.object(dev, "docker_text", side_effect=docker_text),
                mock.patch.object(dev, "docker_capture", side_effect=AssertionError("Unexpected runtime call")),
                mock.patch.object(dev, "_validate_retained_service"),
                mock.patch.object(dev, "_retained_certificate", return_value=harness.certificate),
                mock.patch.object(dev, "_certificate_path", return_value=harness.state / "certificate.json"),
                mock.patch.object(dev.storage, "validate_path", side_effect=lambda value, *_args: Path(value)),
                mock.patch.object(dev, "_retained_startup_enabled", return_value=False),
                mock.patch.object(docker_backend_volume_cache, "validate_container"),
                mock.patch.object(dev, "_retained_ledger_profile", return_value={"profile": "group-ledger-v1"}),
                mock.patch.object(docker_development_inputs, "seed", side_effect=seed),
                mock.patch.object(docker_development_inputs, "metadata_cache_key", return_value="seed-key"),
                mock.patch.object(docker_group_storage, "cli_mount_args", return_value=[]),
                mock.patch.object(dev, "bounded_capture", side_effect=frontend_capture),
                mock.patch.object(dev, "_finish"),
            ):
                stack.enter_context(patch)
            legacy = stack.enter_context(mock.patch.object(dev, "_owned_volume", return_value="legacy-frontend"))
            try:
                dev._retained_operation(harness.args, recreate_services=False)
                error = None
            except dev.BuildControlError as observed:
                error = observed
        return harness, operation, events, error, legacy

    def test_real_resume_carries_private_layout_into_real_frontend_before_service_start(self):
        harness, operation, events, error, legacy = self.exercise_resume()
        self.assertIsNone(error)
        self.assertEqual(operation["receipt"]["private_group_storage"], "group-volume-v1")
        self.assertEqual(events, [("seed", True), ("start", "frontend"), ("start", "backend")])
        legacy.assert_not_called()
        self.assertEqual(harness.previous["private_group_storage"], "group-volume-v1")

    def test_frontend_seed_failure_before_any_start_leaves_daemon_outcome_known(self):
        _harness, operation, events, error, legacy = self.exercise_resume(seed_failure=True)
        self.assertIn("controlled seed failure", str(error))
        self.assertFalse(operation["daemon_pending"])
        self.assertEqual(events, [("seed", True)])
        legacy.assert_not_called()

    def test_invalid_previous_layout_refuses_before_frontend_or_service_start(self):
        _harness, operation, events, error, legacy = self.exercise_resume(invalid_layout=True)
        self.assertIn("Unknown previous private group storage layout", str(error))
        self.assertFalse(operation["daemon_pending"])
        self.assertEqual(events, [])
        legacy.assert_not_called()

    def test_legacy_resume_without_private_owner_keeps_legacy_frontend_path(self):
        _harness, operation, events, error, legacy = self.exercise_resume(private=False)
        self.assertIsNone(error)
        self.assertNotIn("private_group_storage", operation["receipt"])
        self.assertEqual(events, [("seed", False), ("start", "frontend"), ("start", "backend")])
        legacy.assert_called_once()


class AbandonedDiagnosticCliTests(unittest.TestCase):
    base = ["recreate-volume", "--attempt", "9" * 32, "--config-sha256", "a" * 64,
            "--source-root", "/source", "--port", "3203"]
    pins = ["--abandoned-diagnostic-proof", "verification/guest/fresh-proof.json",
            "--abandoned-diagnostic-proof-sha256", "f" * 64]

    def test_paired_proof_reaches_only_the_plain_fresh_state_caller(self):
        with mock.patch.object(dev, "recreate") as recreate:
            self.assertEqual(docker_dev.main(self.base + self.pins + ["--fresh-state"]), 0)
        recreate.assert_called_once()
        self.assertTrue(recreate.call_args.args[0].fresh_state)
        self.assertEqual(recreate.call_args.args[0].abandoned_diagnostic_proof,
                         "/opt/fullmag/control/verification/guest/fresh-proof.json")

    def test_incomplete_or_mixed_authorities_refuse_before_recreate_dispatch(self):
        cases = [self.pins[:2] + ["--fresh-state"], self.pins,
                 self.pins + ["--fresh-state", "--retire-only"],
                 self.pins + ["--fresh-state", "--recovery-authorization", "verification/other"],
                 self.pins + ["--fresh-state", "--resume-recreation", "1" * 32],
                 self.pins + ["--fresh-state", "--completed-recreation-attempt", "1" * 32],
                 self.pins + ["--fresh-state", "--drained-successor-proof", "verification/other"],
                 self.pins + ["--fresh-state", "--pending-recovery-successor", "verification/other"],
                 self.pins + ["--fresh-state", "--terminal-observation-proof", "verification/other"],
                 self.pins + ["--fresh-state", "--offline-reconciliation", "1" * 32]]
        for options in cases:
            with self.subTest(options=options), mock.patch.object(dev, "recreate") as recreate:
                with redirect_stderr(io.StringIO()):
                    self.assertNotEqual(docker_dev.main(self.base + options), 0)
                recreate.assert_not_called()


class AbandonedDiagnosticShellTests(unittest.TestCase):
    def dry_recipe(self, recipe, *arguments):
        just = shutil.which("just")
        if just is None:
            self.skipTest("just is required for real recipe rendering")
        repo = Path(__file__).resolve().parents[1]
        result = subprocess.run([just, "--justfile", str(repo / "justfile"), "--dry-run",
                                 recipe, *arguments], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stderr.strip()

    def dispatch(self, recipe, marker):
        return DevelopmentRecoveryShellTests().dispatch(recipe, marker=marker)

    def test_abandon_recipe_preserves_exact_preview_and_apply_arguments(self):
        source = "/selected/worktree with spaces/$(printf injected);literal"
        marker = '  *"scripts/docker_volume_succeeded_guest_abandon.py"*)\n'
        for apply in (False, True):
            with self.subTest(apply=apply):
                recipe = self.dry_recipe("docker-dev-abandon-diagnostic", source,
                    "sha256:" + "d" * 64, "verification/guest/request.json", "a" * 64,
                    "true" if apply else "false")
                result = self.dispatch(recipe, marker)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = [b"/recorded/python", b"-B",
                    b"/registered/checkout/scripts/docker_volume_succeeded_guest_abandon.py",
                    b"--source-root", source.encode(), b"--image-id", ("sha256:" + "d" * 64).encode(),
                    b"--request", b"verification/guest/request.json", b"--request-sha256", b"a" * 64]
                if apply:
                    expected.append(b"--apply")
                self.assertEqual(result.stdout.split(b"\0")[:-1], expected)

    def test_abandon_dispatch_rejects_unpinned_and_composite_commands(self):
        marker = '  *"scripts/docker_volume_succeeded_guest_abandon.py"*)\n'
        recipe = self.dry_recipe("docker-dev-abandon-diagnostic", "/source", "sha256:" + "d" * 64,
                                 "verification/guest/request.json", "a" * 64)
        for invalid in (recipe.replace("a" * 64, "short"), recipe + "; printf injected",
                        recipe + " && printf injected", recipe + "\nprintf injected",
                        recipe + " --apply --apply"):
            with self.subTest(invalid=invalid):
                result = self.dispatch(invalid, marker)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(result.stdout)

    def test_fresh_recreation_forwards_only_the_paired_abandon_proof(self):
        recipe = self.dry_recipe("docker-dev-recreate-volume", "a" * 32, "b" * 64, "/source", "3203",
            "true", "", "", "", "", "", "", "", "", "verification/guest/proof.json", "f" * 64)
        marker = '  *"scripts/docker_dev.py"*)\n'
        result = self.dispatch(recipe, marker)
        self.assertEqual(result.returncode, 0, result.stderr)
        words = result.stdout.split(b"\0")[:-1]
        self.assertIn(b"--fresh-state", words)
        self.assertEqual(words[-4:], [b"--abandoned-diagnostic-proof", b"verification/guest/proof.json",
                                      b"--abandoned-diagnostic-proof-sha256", b"f" * 64])
        for invalid in (recipe.replace(" --abandoned-diagnostic-proof-sha256 '" + "f" * 64 + "'", ""),
                        recipe + "; printf injected", recipe + "\nprintf injected"):
            with self.subTest(invalid=invalid):
                rejected = self.dispatch(invalid, marker)
                self.assertEqual(rejected.returncode, 2)
                self.assertFalse(rejected.stdout)


if __name__ == "__main__":
    unittest.main()
