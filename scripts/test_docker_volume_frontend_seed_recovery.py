"""Fail-closed contract checks for one missing-freeze frontend seed recovery."""
from __future__ import annotations

import ast
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_frontend_seed_recovery as recovery
from docker_build_control import BuildControlError


SOURCE_BYTES = (
    b'/// <reference types="next" />\n'
    b'/// <reference types="next/image-types/global" />\n'
    b'import "./.next/types/routes.d.ts";\n'
    b'\n// NOTE: This file should not be edited\n'
    b'// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n'
)
SOURCE_HASH = hashlib.sha256(SOURCE_BYTES).hexdigest()
OLD_EMPTY_HASH = hashlib.sha256(b"").hexdigest()
SEED_RELATIVE = "apps/control-room/next-env.d.ts"
PACKAGE_BYTES = b"{}"
DOCKER_VOLUME_DEV = Path(__file__).with_name("docker_volume_dev.py")


def manifest(commit: str, *, next_env_hash: str = SOURCE_HASH) -> dict:
    return {
        "schema": "fullmag.docker-development-inputs.v1",
        "source_root": "/repo/worktrees/interactive-study",
        "source_commit": commit,
        "source_selection": "live_linux_selected_checkout",
        "source_volume": None,
        "host_port": 3243,
        "worktree_id": "interactive-study-0123456789abcdef",
        "dependency_seed_files": ["package.json", "pnpm-lock.yaml"],
        "dependency_seed_sha256": "a" * 64,
        "toolpins": {"node": "v24.18.0", "pnpm": "10.8.1"},
        "toolpins_sha256": "b" * 64,
        "workspace_root": "/state/development/workspace",
        "frontend_root": "/state/development/cache",
        "live_directories": ["app", "src", "public", "scripts"],
        "files": [
            {"relative": SEED_RELATIVE, "sha256": next_env_hash},
            {"relative": "apps/control-room/package.json",
             "sha256": hashlib.sha256(PACKAGE_BYTES).hexdigest()},
        ],
        "configuration_changes": "prepare_new_workspace",
        "backend_build": "explicit_request_only",
    }


def failure_fixture():
    attempt = "a" * 32
    frontend_id = "f" * 64
    receipt = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "development",
        "state": "failed-confirmed",
        "attempt": attempt,
        "compose_project": "own-group",
        "error": "DEV service exited before readiness: frontend",
        "frontend_container": frontend_id,
    }
    frontend = {
        "Id": frontend_id,
        "State": {
            "Status": "exited", "Running": False, "Pid": 0, "ExitCode": 1,
            "OOMKilled": False, "Dead": False, "Restarting": False,
            "Paused": False, "Error": "", "StartedAt": "2026-11-13T10:00:00Z",
            "FinishedAt": "2026-11-13T10:01:00Z",
        },
    }
    log = ("FrontendDevError: seed file hash changed: " + SEED_RELATIVE + "\n").encode()
    return receipt, frontend, log


class FailedSeedRecoveryTests(unittest.TestCase):
    def test_exact_failed_seed_and_input_manifest_are_admitted_with_distinct_commit_pins(self):
        previous = manifest("1" * 40)
        selected = manifest("2" * 40)
        pins = recovery.validate_seed_manifest(
            previous, selected, backend_app_commit="1" * 40,
            expected_backend_app_commit="1" * 40,
            input_manifest_commit="1" * 40,
            controller_commit="2" * 40,
            selected_seed_bytes={SEED_RELATIVE: SOURCE_BYTES,
                                 "apps/control-room/package.json": PACKAGE_BYTES},
        )
        self.assertEqual(pins["backend_app_commit"], "1" * 40)
        self.assertEqual(pins["input_manifest_commit"], "1" * 40)
        self.assertEqual(pins["controller_commit"], "2" * 40)
        self.assertEqual(pins["next_env_sha256"], SOURCE_HASH)

    def test_frontend_input_commit_can_differ_from_unchanged_backend_app_commit(self):
        previous = manifest("2" * 40)
        selected = manifest("3" * 40)
        pins = recovery.validate_seed_manifest(
            previous, selected, backend_app_commit="1" * 40,
            expected_backend_app_commit="1" * 40,
            input_manifest_commit="2" * 40, controller_commit="3" * 40,
            selected_seed_bytes={SEED_RELATIVE: SOURCE_BYTES,
                                 "apps/control-room/package.json": PACKAGE_BYTES},
        )
        self.assertEqual(pins["backend_app_commit"], "1" * 40)
        self.assertEqual(pins["input_manifest_commit"], "2" * 40)
        self.assertEqual(pins["controller_commit"], "3" * 40)

    def test_seed_manifest_must_match_completely_except_source_commit(self):
        previous = manifest("1" * 40)
        selected = copy.deepcopy(previous)
        selected["source_commit"] = "2" * 40
        selected["toolpins"]["pnpm"] = "changed"
        with self.assertRaisesRegex(BuildControlError, "source manifest"):
            recovery.validate_seed_manifest(
                previous, selected, backend_app_commit="1" * 40,
                expected_backend_app_commit="1" * 40,
                input_manifest_commit="1" * 40,
                controller_commit="2" * 40,
                selected_seed_bytes={SEED_RELATIVE: SOURCE_BYTES,
                                     "apps/control-room/package.json": PACKAGE_BYTES},
            )

    def test_seed_bytes_and_commit_roles_are_independently_pinned(self):
        previous = manifest("1" * 40)
        selected = manifest("2" * 40)
        with self.assertRaisesRegex(BuildControlError, "source seed hash"):
            recovery.validate_seed_manifest(
                previous, selected, backend_app_commit="1" * 40,
                expected_backend_app_commit="1" * 40,
                input_manifest_commit="1" * 40,
                controller_commit="2" * 40,
                selected_seed_bytes={SEED_RELATIVE: b"different bytes",
                                     "apps/control-room/package.json": PACKAGE_BYTES},
            )
        with self.assertRaisesRegex(BuildControlError, "backend app commit"):
            recovery.validate_seed_manifest(
                previous, selected, backend_app_commit="3" * 40,
                expected_backend_app_commit="1" * 40,
                input_manifest_commit="1" * 40,
                controller_commit="2" * 40,
                selected_seed_bytes={SEED_RELATIVE: SOURCE_BYTES,
                                     "apps/control-room/package.json": PACKAGE_BYTES},
            )

    def test_exact_exited_frontend_with_empty_seed_and_no_freeze_is_admitted(self):
        receipt, frontend, log = failure_fixture()
        evidence = recovery.validate_failed_seed(
            receipt, frontend, log, b"", expected_attempt="a" * 32, freeze_exists=False,
            frozen_root_exists=False,
        )
        self.assertEqual(evidence["attempt"], "a" * 32)
        self.assertEqual(evidence["old_seed_sha256"], OLD_EMPTY_HASH)

    def test_wrong_container_state_log_or_seed_is_refused(self):
        receipt, frontend, log = failure_fixture()
        bad_cases = []
        running = copy.deepcopy(frontend)
        running["State"].update(Status="running", Running=True, Pid=12)
        bad_cases.append((running, log, b""))
        wrong_pid = copy.deepcopy(frontend)
        wrong_pid["State"]["Pid"] = 12
        bad_cases.append((wrong_pid, log, b""))
        wrong_exit = copy.deepcopy(frontend)
        wrong_exit["State"]["ExitCode"] = 137
        bad_cases.append((wrong_exit, log, b""))
        bad_cases.append((frontend, b"different frontend error", b""))
        bad_cases.append((frontend, log, b"changed seed"))
        for state, output, seed in bad_cases:
            with self.subTest(state=state["State"], output=output[:20], seed=seed), self.assertRaises(BuildControlError):
                recovery.validate_failed_seed(
                    receipt, state, output, seed, expected_attempt="a" * 32, freeze_exists=False,
                    frozen_root_exists=False,
                )

    def test_any_freeze_artifact_or_nonexact_terminal_receipt_is_refused(self):
        receipt, frontend, log = failure_fixture()
        for freeze, frozen in ((True, False), (False, True)):
            with self.subTest(freeze=freeze, frozen=frozen), self.assertRaises(BuildControlError):
                recovery.validate_failed_seed(
                    receipt, frontend, log, b"", expected_attempt="a" * 32, freeze_exists=freeze,
                    frozen_root_exists=frozen,
                )
        for key, value in (("state", "succeeded"), ("phase", "resume"),
                           ("error", "different failure"), ("attempt", "b" * 32)):
            changed = {**receipt, key: value}
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_failed_seed(
                    changed, frontend, log, b"", expected_attempt="a" * 32, freeze_exists=False,
                    frozen_root_exists=False,
                )

    def test_backend_anchor_requires_same_ready_incarnation_and_process_observation(self):
        anchor = {
            "container_id": "b" * 64, "started_at": "2026-11-13T09:00:00Z",
            "fingerprint": "c" * 64, "container_pid": 2048,
            "owner_token": "d" * 32, "owner_start_token": "e" * 32,
            "state": {"running": True, "health": "healthy"},
            "certificate_identity": {"engine_id": "engine", "image_id": "image"},
            "processes": [{"pid": 301, "start_ticks": "123", "executable": "/fullmag-api"}],
            "api_instance_id": "api-instance", "active_session": False,
            "sampled_at": "first-observation",
        }
        self.assertEqual(recovery.validate_backend_anchor(anchor, copy.deepcopy(anchor)), anchor)
        heartbeat = {**anchor, "sampled_at": "later-observation"}
        self.assertEqual(recovery.validate_backend_anchor(anchor, heartbeat), anchor)
        for key, value in (("container_id", "f" * 64), ("container_pid", 4096),
                           ("fingerprint", "0" * 64), ("owner_token", "1" * 32),
                           ("owner_start_token", "2" * 32),
                           ("certificate_identity", {"engine_id": "other"}),
                           ("processes", [{"pid": 302, "start_ticks": "999",
                                           "executable": "/fullmag-api"}]),
                           ("active_session", True)):
            changed = {**anchor, key: value}
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_backend_anchor(anchor, changed)

    def test_refresh_mode_is_explicit_and_exclusive_with_frozen_resume_or_backend_restart(self):
        base = SimpleNamespace(
            failed_seed_new_generation=True, frontend_frozen_resume=None,
            frontend_frozen_resume_sha256=None, restart_backend=False,
        )
        self.assertTrue(recovery.validate_refresh_options(base))
        for key, value in (("frontend_frozen_resume", "a" * 32),
                           ("frontend_frozen_resume_sha256", "b" * 64),
                           ("restart_backend", True)):
            changed = copy.copy(base)
            setattr(changed, key, value)
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_refresh_options(changed)
        legacy = SimpleNamespace(
            failed_seed_new_generation=False, frontend_frozen_resume="a" * 32,
            frontend_frozen_resume_sha256="b" * 64, restart_backend=False,
        )
        self.assertFalse(recovery.validate_refresh_options(legacy))

    def test_active_generation_resolves_from_receipt_and_compose_while_legacy_stays_default(self):
        import docker_group_storage as group_storage

        control = SimpleNamespace(
            project="own-group", volume="fullmag-worktree-own-control", namespace="",
            subpath=lambda relative="": relative,
        )

        def document(subpath):
            return {
                "name": control.project,
                "services": {
                    "backend": {"volumes": []},
                    "frontend": {"volumes": [{"type": "volume", "source": "frontend-build",
                        "target": "/state/development", "volume": {"nocopy": True, "subpath": subpath}}]},
                },
                "volumes": {"frontend-build": {"name": control.volume, "external": True}},
            }

        legacy = recovery.resolve_active_generation(
            control, {"private_group_storage": "group-volume-v1",
                      "frontend_volume": control.volume, "compose_project": control.project},
            document(group_storage.role_subpath(control, "frontend")),
        )
        self.assertEqual(legacy, {"generation_id": None, "subpath": "private/frontend"})
        generation_id = "a" * 32
        path = group_storage.frontend_generation_subpath(control, generation_id)
        active = recovery.resolve_active_generation(
            control, {"private_group_storage": "group-volume-v1",
                      "frontend_volume": control.volume, "compose_project": control.project,
                      "frontend_generation_id": generation_id,
                      "frontend_generation_subpath": path},
            document(path),
        )
        self.assertEqual(active, {"generation_id": generation_id, "subpath": path})
        self.assertEqual(recovery.generation_receipt_fields(
            control, {"private_group_storage": "group-volume-v1",
                      "frontend_volume": control.volume, "compose_project": control.project,
                      "frontend_generation_id": generation_id,
                      "frontend_generation_subpath": path}, document(path)),
            {"frontend_generation_id": generation_id, "frontend_generation_subpath": path})
        for invalid in ("../" + generation_id, "A" * 32, "a" * 31, "a" * 33):
            with self.subTest(generation_id=invalid), self.assertRaises(BuildControlError):
                group_storage.frontend_generation_subpath(control, invalid)
        with self.assertRaisesRegex(BuildControlError, "Compose subpath"):
            recovery.resolve_active_generation(
                control, {"private_group_storage": "group-volume-v1",
                          "frontend_volume": control.volume, "compose_project": control.project,
                          "frontend_generation_id": generation_id,
                          "frontend_generation_subpath": path},
                document("private/frontend"),
            )

    def test_legacy_private_storage_pin_does_not_add_generation_shape_guards(self):
        import docker_volume_dev

        operation = {"root": "development/attempts/new", "receipt": {
            "private_group_storage": "group-volume-v1"}}
        control = SimpleNamespace(volume="fullmag-worktree-own-control",
            read=lambda *args, **kwargs: None, write=lambda *args: None)
        legacy = {"private_group_storage": "group-volume-v1"}
        self.assertTrue(docker_volume_dev._pin_private_group_storage(
            control, operation, new_render=False, previous=legacy, document={}))
        self.assertNotIn("frontend_generation_id", operation["receipt"])
        self.assertNotIn("frontend_generation_subpath", operation["receipt"])

    def test_normal_resume_refresh_carries_active_generation_without_backend_compose_change(self):
        import docker_group_storage as group_storage
        import docker_volume_dev

        control = SimpleNamespace(project="own-group", volume="fullmag-worktree-own-control",
            namespace="", subpath=lambda relative="": relative,
            read=lambda *args, **kwargs: None, write=lambda *args: None)
        generation_id = "e" * 32
        generation_path = group_storage.frontend_generation_subpath(control, generation_id)
        document = {
            "name": control.project,
            "services": {
                "backend": {"image": "sha256:" + "1" * 64, "environment": {"KEEP": "same"}, "volumes": []},
                "frontend": {"image": "sha256:" + "2" * 64, "environment": {"FULLMAG_SOURCE_COMMIT": "1" * 40},
                    "volumes": [{"type": "volume", "source": "frontend-build",
                        "target": "/state/development", "volume": {"nocopy": True,
                        "subpath": generation_path}}]},
            },
            "volumes": {"frontend-build": {"name": control.volume, "external": True}},
        }
        previous = {"private_group_storage": "group-volume-v1", "frontend_volume": control.volume,
            "compose_project": control.project, "frontend_generation_id": generation_id,
            "frontend_generation_subpath": generation_path}
        operation = {"root": "resume/attempts/new", "receipt": {}}
        self.assertTrue(docker_volume_dev._pin_private_group_storage(
            control, operation, new_render=False, previous=previous, document=document,
        ))
        self.assertEqual(operation["receipt"]["frontend_generation_id"], generation_id)
        refreshed = docker_volume_dev._frontend_refresh_document(
            document, control.volume, {"source_commit": "3" * 40},
            frontend_generation_subpath=generation_path)
        self.assertEqual(refreshed["services"]["backend"], document["services"]["backend"])
        self.assertEqual(refreshed["services"]["frontend"]["volumes"][0]["volume"]["subpath"],
                         generation_path)

    def test_generation_probe_is_exact_and_rejects_old_seed_or_freeze_drift(self):
        probe = {
            "mode": "created", "generation_id": "a" * 32,
            "old_generation_id": None, "old_seed_sha256": OLD_EMPTY_HASH,
            "inputs_freeze_absent": True, "frozen_root_absent": True,
        }
        self.assertEqual(recovery.validate_generation_probe(
            probe, generation_id="a" * 32, old_generation_id=None,
            old_seed_sha256=OLD_EMPTY_HASH), probe)
        for key, value in (("old_seed_sha256", SOURCE_HASH), ("inputs_freeze_absent", False),
                           ("frozen_root_absent", False), ("extra", True)):
            changed = {**probe, key: value}
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                recovery.validate_generation_probe(
                    changed, generation_id="a" * 32, old_generation_id=None,
                    old_seed_sha256=OLD_EMPTY_HASH)

    def test_full_generation_stage_guard_old_cas_publish_compose_order(self):
        import docker_group_storage as group_storage

        control = SimpleNamespace(
            project="own-group", volume="fullmag-worktree-own-control", namespace="",
            subpath=lambda relative="": relative,
        )
        generation_id = "c" * 32
        generation_path = group_storage.frontend_generation_subpath(control, generation_id)
        compose = {
            "name": control.project,
            "services": {"backend": {"volumes": []}, "frontend": {"volumes": [
                {"type": "volume", "source": "frontend-build", "target": "/state/development",
                 "volume": {"nocopy": True, "subpath": generation_path}}]}},
            "volumes": {"frontend-build": {"name": control.volume, "external": True}},
        }
        operation = {"root": "development/attempts/new", "receipt": {
            "frontend_generation_id": generation_id,
            "frontend_generation_subpath": generation_path,
        }}
        events = []

        class FakeControl:
            project = control.project
            volume = control.volume
            namespace = ""

            @staticmethod
            def subpath(relative=""):
                return relative

            def write(self, path, value):
                events.append("write:" + path)

        def stage():
            events.append("seed-generation")
            return {"inputs": {"source_commit": "2" * 40},
                    "compose": compose, "volume": control.volume}

        result = recovery.stage_and_publish_generation(
            FakeControl(), operation, stage_generation=stage,
            guard_prior_consumers=lambda: events.append("prior-consumer-guard"),
            guard_consumers=lambda staged: events.append("consumer-guard"),
            revalidate_prior=lambda staged: events.append("old-cas"),
            compose_apply=lambda document: events.append("compose-frontend-only"),
        )
        self.assertEqual(result["compose"], compose)
        self.assertEqual(events, [
            "prior-consumer-guard", "seed-generation", "consumer-guard", "old-cas",
            "write:development/attempts/new/compose.json",
            "write:frontend/development-inputs.json", "compose-frontend-only",
        ])

    def test_generation_guard_or_old_cas_failure_publishes_nothing(self):
        import docker_group_storage as group_storage

        control = SimpleNamespace(
            project="own-group", volume="fullmag-worktree-own-control", namespace="",
            subpath=lambda relative="": relative,
        )
        generation_id = "d" * 32
        path = group_storage.frontend_generation_subpath(control, generation_id)
        compose = {"services": {"backend": {"volumes": []}, "frontend": {"volumes": [
            {"type": "volume", "source": "frontend-build", "target": "/state/development",
             "volume": {"nocopy": True, "subpath": path}}]}},
            "volumes": {"frontend-build": {"name": control.volume, "external": True}}}
        operation = {"root": "development/attempts/new", "receipt": {
            "frontend_generation_id": generation_id, "frontend_generation_subpath": path}}
        for failed_phase in ("prior-consumer", "consumer", "cas"):
            events = []

            class FakeControl:
                project = control.project
                volume = control.volume
                namespace = ""

                @staticmethod
                def subpath(relative=""):
                    return relative

                def write(self, dest, value):
                    events.append("write")

            def fail(staged):
                raise BuildControlError("fence refused")

            def fail_prior():
                raise BuildControlError("fence refused")

            def stage():
                events.append("stage")
                return {"inputs": {}, "compose": compose, "volume": control.volume}

            with self.subTest(failed_phase=failed_phase), self.assertRaisesRegex(BuildControlError, "fence refused"):
                recovery.stage_and_publish_generation(
                    FakeControl(), operation,
                    stage_generation=stage,
                    guard_prior_consumers=(fail_prior if failed_phase == "prior-consumer"
                                           else lambda: events.append("prior-guard")),
                    guard_consumers=fail if failed_phase == "consumer" else lambda staged: events.append("guard"),
                    revalidate_prior=fail if failed_phase == "cas" else lambda staged: events.append("cas"),
                    compose_apply=lambda document: events.append("compose"),
                )
            self.assertNotIn("write", events)
            self.assertNotIn("compose", events)
            if failed_phase == "prior-consumer":
                self.assertNotIn("stage", events)
            else:
                self.assertIn("stage", events)


@unittest.skipIf(os.name == "nt", "guest helper uses Linux flock; suite runs under WSL/Linux")
class FrontendGenerationGuestTests(unittest.TestCase):
    @staticmethod
    def _guest(root: Path) -> str:
        tree = ast.parse(DOCKER_VOLUME_DEV.read_text(encoding="utf-8"))
        function = next(node for node in tree.body
                        if isinstance(node, ast.FunctionDef) and node.name == "_frontend")
        script = next(node.value.value for node in ast.walk(function)
                      if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "script"
                              for target in node.targets))
        return script.replace("'/data", repr(str(root))[:-1])

    @staticmethod
    def _inputs(source_commit: str, seed_bytes: bytes) -> dict:
        return {
            "schema": "fullmag.docker-development-inputs.v1",
            "source_root": "/selected/source", "source_commit": source_commit,
            "source_selection": "live_linux_selected_checkout", "source_volume": None,
            "host_port": 3197, "worktree_id": "interactive-study-example",
            "dependency_seed_files": ["package.json", "pnpm-lock.yaml"],
            "dependency_seed_sha256": "a" * 64,
            "toolpins": {"node": "v24.18.0", "pnpm": "10.8.1"},
            "toolpins_sha256": "b" * 64,
            "workspace_root": "/state/development/workspace",
            "frontend_root": "/state/development/cache",
            "live_directories": ["app", "src", "public", "scripts"],
            "files": [
                {"relative": SEED_RELATIVE, "sha256": hashlib.sha256(seed_bytes).hexdigest()},
                {"relative": "apps/control-room/package.json",
                 "sha256": hashlib.sha256(PACKAGE_BYTES).hexdigest()},
            ],
            "configuration_changes": "prepare_new_workspace",
            "backend_build": "explicit_request_only",
        }

    def _run(self, root: Path, *, current_inputs: dict, old_inputs: dict,
             generation: dict | None):
        seed_bytes = SOURCE_BYTES
        files = [
            {"relative": SEED_RELATIVE, "data": base64.b64encode(seed_bytes).decode("ascii")},
            {"relative": "apps/control-room/package.json",
             "data": base64.b64encode(PACKAGE_BYTES).decode("ascii")},
        ]
        request = {"files": files, "inputs": current_inputs, "previous_inputs": old_inputs,
                   "group_storage": True, "frontend_generation": generation}
        return subprocess.run(
            [sys.executable, "-B", "-c", self._guest(root)],
            input=json.dumps(request).encode(), capture_output=True, check=False)

    def test_new_generation_preserves_failed_workspace_then_active_generation_is_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o750)
            old_workspace = root / "workspace/apps/control-room"
            old_workspace.mkdir(parents=True)
            old_seed = old_workspace / "next-env.d.ts"
            old_seed.write_bytes(b"")
            (root / "workspace/results.zarr").write_bytes(b"retained result")
            old_inputs = self._inputs("1" * 40, b"")
            current_inputs = self._inputs("2" * 40, SOURCE_BYTES)
            generation_id = "a" * 32
            result = self._run(root, current_inputs=current_inputs, old_inputs=old_inputs,
                generation={"mode": "create", "generation_id": generation_id,
                    "old_generation_id": None, "old_seed_sha256": OLD_EMPTY_HASH})
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            seeded = json.loads(result.stdout)
            self.assertEqual(seeded["frontend_generation_probe"], {
                "mode": "created", "generation_id": generation_id,
                "old_generation_id": None, "old_seed_sha256": OLD_EMPTY_HASH,
                "inputs_freeze_absent": True, "frozen_root_absent": True,
            })
            new_root = root / "generations" / generation_id
            self.assertEqual(stat.S_IMODE(new_root.stat().st_mode), 0o750)
            self.assertEqual((new_root.stat().st_uid, new_root.stat().st_gid),
                             (root.stat().st_uid, root.stat().st_gid))
            self.assertEqual((new_root / "workspace/apps/control-room/next-env.d.ts").read_bytes(), SOURCE_BYTES)
            self.assertEqual(old_seed.read_bytes(), b"")
            self.assertEqual((root / "workspace/results.zarr").read_bytes(), b"retained result")

            repeated = self._run(root, current_inputs=current_inputs, old_inputs=current_inputs,
                generation={"mode": "active", "generation_id": generation_id})
            self.assertEqual(repeated.returncode, 0, repeated.stderr.decode())
            self.assertEqual(json.loads(repeated.stdout)["frontend_generation"],
                             {"mode": "active", "generation_id": generation_id})
            self.assertEqual((new_root / "workspace/apps/control-room/next-env.d.ts").read_bytes(), SOURCE_BYTES)

    def test_generation_creation_rejects_collision_hash_drift_and_freeze_without_touching_old_data(self):
        for failure in ("collision", "hash", "freeze"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                root.chmod(0o750)
                old_workspace = root / "workspace/apps/control-room"
                old_workspace.mkdir(parents=True)
                (old_workspace / "next-env.d.ts").write_bytes(b"" if failure != "hash" else b"changed")
                (root / "workspace/results.zarr").write_bytes(b"retain")
                generation_id = "b" * 32
                if failure == "collision":
                    collided = root / "generations" / generation_id
                    collided.mkdir(parents=True)
                    (collided / "unknown.bin").write_bytes(b"retain collision")
                if failure == "freeze":
                    (root / "inputs-freeze.json").write_bytes(b"unknown freeze")
                old_inputs = self._inputs("1" * 40, b"")
                current_inputs = self._inputs("2" * 40, SOURCE_BYTES)
                request_seed_sha = OLD_EMPTY_HASH if failure != "hash" else OLD_EMPTY_HASH
                result = self._run(root, current_inputs=current_inputs, old_inputs=old_inputs,
                    generation={"mode": "create", "generation_id": generation_id,
                        "old_generation_id": None, "old_seed_sha256": request_seed_sha})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((root / "workspace/results.zarr").read_bytes(), b"retain")
                if failure == "collision":
                    self.assertEqual((root / "generations" / generation_id / "unknown.bin").read_bytes(),
                                     b"retain collision")

    def test_old_workspace_symlink_is_refused_without_touching_external_seed(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as external:
            root = Path(temporary)
            root.chmod(0o750)
            outside = Path(external)
            outside_seed = outside / "apps/control-room/next-env.d.ts"
            outside_seed.parent.mkdir(parents=True)
            outside_seed.write_bytes(b"")
            (root / "workspace").symlink_to(outside, target_is_directory=True)
            old_inputs = self._inputs("1" * 40, b"")
            current_inputs = self._inputs("2" * 40, SOURCE_BYTES)
            result = self._run(root, current_inputs=current_inputs, old_inputs=old_inputs,
                generation={"mode": "create", "generation_id": "f" * 32,
                    "old_generation_id": None, "old_seed_sha256": OLD_EMPTY_HASH})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(outside_seed.read_bytes(), b"")
            self.assertFalse((root / "generations").exists())


if __name__ == "__main__":
    unittest.main()
