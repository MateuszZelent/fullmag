"""Source-only checks; no Rust/native test compilation or Docker mutation."""
import importlib.util
import json
import tempfile
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import nullcontext

import fullmag_docker_runtime as runtime
import run_managed_browser as managed


class DockerRuntimeContract(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("FULLMAG_TEST_COMPOSE_CONFIG") == "1", "Read-only Compose CLI integration gate")
    def test_workspace_uses_one_loopback_port_and_explicit_gpu(self):
        service = runtime.compose_spec("sha256:" + "a" * 64, Path("/state-host"), 3197,
                                       Path("/owned/host.json"))["services"]["backend"]
        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(service["ports"][0]["published"], "3197")
        self.assertEqual(service["ports"][0]["target"], 8081)
        self.assertEqual(service["gpus"][0]["count"], -1)
        self.assertTrue(service["read_only"])
        self.assertEqual([m["target"] for m in service["volumes"]],
                         ["/state", "/run/fullmag/windows-folder-host.json"])

    @unittest.skipUnless(os.environ.get("FULLMAG_TEST_COMPOSE_CONFIG") == "1", "Read-only Compose CLI integration gate")
    def test_development_separates_live_frontend_from_session_writer(self):
        inputs = {"source_root": "/checkout"}
        spec = runtime.compose_spec("sha256:" + "a" * 64, Path("/owned/state"), 3197,
                                    Path("/owned/host.json"), inputs=inputs,
                                    inputs_path=Path("/owned/inputs.json"),
                                    package=Path("/owned/package"), provenance=Path("/owned/assembly.json"))
        self.assertEqual(set(spec["services"]), {"backend", "frontend"})
        backend, frontend = spec["services"]["backend"], spec["services"]["frontend"]
        self.assertFalse(backend.get("ports"))
        self.assertEqual(backend["gpus"][0]["count"], -1)
        self.assertNotIn("gpus", frontend)
        self.assertEqual(frontend["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(frontend["ports"][0]["target"], 8080)
        self.assertEqual(frontend["environment"]["FULLMAG_API_PROXY_TARGET"], "http://backend:8081")
        self.assertEqual(frontend["depends_on"]["backend"]["condition"], "service_healthy")
        self.assertEqual([m["target"] for m in frontend["volumes"] if not m.get("read_only")],
                         ["/state/development"])
        self.assertNotIn("/state", [m["target"] for m in frontend["volumes"]])
        source = next(m for m in backend["volumes"] if m["target"] == "/opt/fullmag/source")
        self.assertTrue(source["read_only"])
        self.assertEqual(source["source"], "/checkout")
        self.assertFalse(source["bind"]["create_host_path"])
        self.assertEqual(set(backend["networks"]), {"fullmag"})
        self.assertEqual(set(frontend["networks"]), {"fullmag"})
        self.assertFalse(spec["networks"]["fullmag"].get("external", False))
        self.assertNotIn("volumes", spec)

    def test_docker_timeout_preserves_unknown_operation_without_retry(self):
        with patch.object(runtime.subprocess, "run", side_effect=subprocess.TimeoutExpired(["docker"], 3)) as run:
            with self.assertRaises(runtime.DockerOutcomeUnknown) as caught:
                runtime.docker("wait", "owned-container", timeout=3)
            self.assertEqual(caught.exception.operation, ["wait", "owned-container"])
            self.assertEqual(caught.exception.timeout_seconds, 3)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.kwargs["timeout"], 3)

    def test_artifact_digest_handles_empty_and_multiblock_files_on_python_310(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact"
            for data in (b"", b"abc", b"artifact-block" * 100000):
                path.write_bytes(data)
                self.assertEqual(runtime.digest(path), hashlib.sha256(data).hexdigest())

    def test_development_image_context_contains_no_application_sources_or_binaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helpers = root / "capsule/tree/docker/all-in-one"
            helpers.mkdir(parents=True)
            for name in ("Dockerfile", "Dockerfile.dev", "entrypoint.py", "windows_folder_probe.py",
                         "runtime_service.py", "frontend_dev.py", "healthcheck.py"):
                (helpers / name).write_text(name)
            (root / "capsule/tree/application-secret-sentinel").write_text("source")
            package = root / "package"
            (package / "bin").mkdir(parents=True)
            (package / "bin/fullmag-bin").write_bytes(b"immutable compiled backend")
            stage = root / "development-context"
            stage.mkdir()
            hashes = runtime.stage_image_context(root / "capsule", package, stage, development=True)
            self.assertFalse((stage / "source").exists())
            self.assertFalse((stage / "package").exists())
            self.assertEqual((stage / "Dockerfile").read_text(), "Dockerfile.dev")
            self.assertEqual(hashes["fullmag-bin"], __import__("hashlib").sha256(b"immutable compiled backend").hexdigest())
            release = root / "release-context"
            release.mkdir()
            runtime.stage_image_context(root / "capsule", package, release, development=False)
            self.assertEqual((release / "source/application-secret-sentinel").read_text(), "source")
            self.assertEqual((release / "package/bin/fullmag-bin").read_bytes(), b"immutable compiled backend")

    def test_source_selection_accepts_main_or_registered_worktree_and_rejects_foreign(self):
        from docker_development_inputs import select_checkout
        with tempfile.TemporaryDirectory() as directory:
            main, task, foreign = [Path(directory) / name for name in ("main", "task", "foreign")]
            for path in (main, task, foreign):
                path.mkdir()
            records = [{"worktree": str(main)}, {"worktree": str(task)}]
            with patch("docker_development_inputs.main_checkout", return_value=main), \
                    patch.object(runtime.storage, "worktree_records", return_value=records), \
                    patch("docker_development_inputs.local_volume"), \
                    patch.dict(os.environ, {"FULLMAG_SOURCE_ROOT": ""}):
                self.assertEqual(select_checkout(task), main.resolve())
                self.assertEqual(select_checkout(main, task), task.resolve())
                with self.assertRaisesRegex(ValueError, "registered checkout"):
                    select_checkout(main, foreign)

    def test_package_requires_every_runtime_service_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            artifacts = [*("bin/" + name for name in runtime.REQUIRED_BINARIES),
                         "web/index.html", "_fullmag_core.so"]
            for relative in artifacts:
                path = package / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            runtime.validate_runtime_artifacts(package)
            for name in runtime.REQUIRED_BINARIES:
                path = package / "bin" / name
                path.unlink()
                with self.assertRaisesRegex(ValueError, "Missing runtime artifact"):
                    runtime.validate_runtime_artifacts(package)
                path.touch()

    def load_service(self):
        import sys
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py"
        spec = importlib.util.spec_from_file_location("all_docker_service_test", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def test_service_budget_is_cpu_only_and_fits_container(self):
        service = self.load_service()
        config = service.build_configuration(service.RuntimePaths(), {})
        self.assertEqual(config["schema_version"], "runtime_service_config.v1")
        self.assertIsNone(config["host_execution"])
        compute = config["compute_resources"][0]
        self.assertEqual(compute["kind"], "cpu")
        prep = config["preparation_resources"][0]
        self.assertEqual(compute["budget"]["gpu_memory_bytes"], 0)
        self.assertLessEqual(compute["budget"]["cpu_millis"] + prep["budget"]["cpu_millis"], 4000)
        for env in ({"FULLMAG_RUNTIME_COMPUTE_CPU_MILLIS": "4001"},
                    {"FULLMAG_RUNTIME_COMPUTE_MEMORY_BYTES": str(8 * 1024**3)},
                    {"FULLMAG_RUNTIME_PREPARATION_CPU_MILLIS": "0"}):
            with self.assertRaises(service.RuntimeServiceError):
                service.build_configuration(service.RuntimePaths(), env)

    def test_service_shutdown_rejects_changed_owner_without_drain(self):
        service = self.load_service()
        owner = {"owner_token": "old", "children": [{"role": "compute", "pid": 3},
                                                      {"role": "preparation", "pid": 4}]}
        changed = {**owner, "owner_token": "new"}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081)
        with patch.object(service, "_wait_api_closed"), \
                patch.object(service, "_service_status", return_value=changed), \
                patch.object(service, "_run_cli") as cli:
            with self.assertRaises(service.RuntimeServiceUnknown):
                service.stop(handle)
            cli.assert_not_called()

    def test_service_stop_delegates_terminal_proof_to_canonical_rust(self):
        service = self.load_service()
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3},
                                                        {"role": "preparation", "pid": 4}]}
        terminal = {**owner, "children": [{**child, "status": "exited_success"} for child in owner["children"]]}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081)
        with patch.object(service, "_wait_api_closed"), \
                patch.object(service, "_service_status", return_value=owner), \
                patch.object(service, "_pin_owner", return_value=Path("/state/pinned-owner.json")), \
                patch.object(service, "_run_cli", return_value={"schema_version": "runtime_service_discovery.v1",
                             "status": "drained", "owner": terminal}) as cli:
            self.assertEqual(service.stop(handle), terminal)
            self.assertIn("service-drain-confirmed", cli.call_args.args[1])
            cli.side_effect = service.RuntimeServiceUnknown("unconfirmed outcome")
            with self.assertRaises(service.RuntimeServiceUnknown):
                service.stop(handle)
            self.assertEqual(cli.call_count, 2)

    def test_start_retains_confirmed_owner_when_later_observation_fails(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0",
                    "build_identity": {"git_commit": "commit"},
                    "runtime_store_binding": {"binding": "a" * 64}}
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3}]}
        for failure_at in ("_pin_owner", "_service_status"):
            with patch.object(service, "prepare_storage"), \
                    patch.object(service, "ensure_configuration", return_value={}), \
                    patch.object(service, "wait_for_api", return_value=identity), \
                    patch.object(service, "_run_cli", return_value={"schema_version": "runtime_service_discovery.v1",
                                 "status": "ready", "owner": owner}), \
                    patch.object(service, "_pin_owner"), \
                    patch.object(service, "_service_status", return_value=owner), \
                    patch.object(service, failure_at, side_effect=OSError("lost observation")):
                with self.assertRaises(Exception) as caught:
                    service.start(service.RuntimePaths(), expected_binding="a" * 64)
                self.assertEqual(caught.exception.pinned_handle.owner, owner)

    def test_supervision_rejects_api_binding_change(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0",
                    "build_identity": {"git_commit": "commit"},
                    "runtime_store_binding": {"binding": "a" * 64}}
        owner = {"owner_token": "known", "children": []}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        changed = {**identity, "runtime_store_binding": {"binding": "b" * 64}}
        with patch.object(service, "_probe_api_liveness"), \
                patch.object(service, "_probe_api_identity", return_value=(changed, {})), \
                patch.object(service, "_service_status", return_value=owner):
            with self.assertRaises(service.RuntimeServiceUnknown):
                service.check(handle)

    @unittest.skipIf(os.name == "nt", "Container metadata fsync/no-follow is tested on Linux")
    def test_service_config_preserves_existing_operator_profile(self):
        service = self.load_service()
        from dataclasses import replace
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory).resolve() / "runtime.json"
            paths = replace(service.RuntimePaths(), config=config)
            first = service.ensure_configuration(paths)
            original = config.read_bytes()
            changed = {**first, "startup_timeout_seconds": 61}
            config.write_text(json.dumps(changed))
            retained = config.read_bytes()
            with self.assertRaises(service.RuntimeServiceError):
                service.ensure_configuration(paths)
            self.assertEqual(config.read_bytes(), retained)
            target = config.with_name("target.json")
            target.write_bytes(original)
            config.unlink()
            config.symlink_to(target)
            with self.assertRaises((service.RuntimeServiceError, OSError)):
                service.ensure_configuration(paths)
            self.assertEqual(target.read_bytes(), original)

    def test_runtime_rejects_toolchain_policy_that_overrides_model_requests(self):
        valid = {"Env": ['FULLMAG_FEM_REQUIRE_GPU=0', 'FULLMAG_FEM_MFEM_DEVICE=']}
        runtime.validate_workspace_environment(valid)
        for assignment in ('FULLMAG_FDM_EXECUTION=gpu', 'FULLMAG_FEM_EXECUTION=auto',
                           'FULLMAG_FEM_REQUIRE_GPU=1', 'FULLMAG_FEM_MFEM_DEVICE=cuda'):
            config = {"Env": [*valid["Env"], assignment]}
            with self.assertRaisesRegex(ValueError, "overrides model execution"):
                runtime.validate_workspace_environment(config)

    @unittest.skipUnless(os.environ.get("FULLMAG_TEST_COMPOSE_CONFIG") == "1", "Read-only Compose CLI integration gate")
    def test_windows_certificate_is_read_only_and_profile_is_explicit(self):
        service = runtime.compose_spec("sha256:" + "a" * 64, Path("C:/owned/state"), 3197,
                                       Path("C:/owned/host.json"))["services"]["backend"]
        self.assertEqual(service["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"], "windows-folder-v1")
        self.assertTrue(service["volumes"][1]["read_only"])
        self.assertEqual(service["volumes"][1]["target"], "/run/fullmag/windows-folder-host.json")

    @unittest.skipIf(os.name == "nt", "Guest probes require Linux no-follow and flock")
    def test_guest_probes_require_restart_before_grant_and_reject_junction(self):
        import hashlib
        import uuid
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/windows_folder_probe.py"
        spec = importlib.util.spec_from_file_location("windows_folder_probe_test", path)
        guest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guest)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / ".windows-folder-probe"
            directory.mkdir()
            target = directory / "junction-target"
            target.mkdir()
            (directory / "host-junction").symlink_to(target, target_is_directory=True)
            image = "sha256:" + "a" * 64
            owner = str(uuid.uuid4())
            host = {"schema": "fullmag.windows-folder-host.v1", "storage_profile": "windows-folder-v1",
                    "role": "session", "owner_scope": "docker-desktop-linux", "host_root_no_reparse": True,
                    "host_drive_type": 3, "host_filesystem": "NTFS", "image_id": image,
                    "owner_token": owner, "restart_verified": False,
                    "restart_expected_sha256": hashlib.sha256((owner + ":" + image).encode()).hexdigest()}
            certificate = root / "host.json"
            marker = root / ".fullmag-windows-folder-owner.json"
            certificate.write_text(json.dumps(host))
            marker.write_text(json.dumps(host))
            with patch.object(guest, "ROOT", root), patch.object(guest, "HOST", certificate), \
                    patch.dict(os.environ, {"FULLMAG_RUNTIME_IMAGE_ID": image}):
                first = guest.run(False)
                self.assertFalse(first["checks"]["restart_readback"])
                with self.assertRaisesRegex(RuntimeError, "Native host has not confirmed"):
                    guest.run(True)
                self.assertFalse((root / ".fullmag-windows-folder-grant.json").exists())
                restart = guest.run(False)
                self.assertTrue(all(restart["checks"].values()))
                host["restart_verified"] = True
                certificate.write_text(json.dumps(host))
                marker.write_text(json.dumps(host))
                grant = guest.run(True)
                self.assertTrue(all(grant["checks"].values()))
                self.assertEqual(grant["host_attestation_sha256"], hashlib.sha256(certificate.read_bytes()).hexdigest())
                self.assertTrue((root / ".fullmag-windows-folder-grant.json").is_file())
                (directory / "host-junction").unlink()
                (directory / "host-junction").mkdir()
                with self.assertRaisesRegex(RuntimeError, "Guest did not expose"):
                    guest.run(True)

    def test_rejects_mutable_image_and_invalid_port(self):
        for image, port in (("fullmag:latest", 3197), ("sha256:" + "a" * 64, 80)):
            with self.assertRaises(ValueError):
                runtime.compose_spec(image, Path("/state-host"), port)

    @unittest.skipIf(os.name == "nt", "Bash shell admission is checked on Linux")
    def test_just_shell_admits_quoted_recipe_and_rejects_composite(self):
        repo = Path(__file__).resolve().parents[1]
        recipe = (f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" '
                  "build-image --job-id '" + "a" * 32 + "' --commit '" + "b" * 40 + "'")
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "python-probe"
            probe.write_text('#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\nprintf "%s\\n" "$@"\n')
            probe.chmod(0o755)
            env = {**os.environ, "FULLMAG_STORAGE_PYTHON": str(probe)}
            command = ["bash", str(repo / "scripts/just_storage_shell.sh")]
            recipes = [recipe, recipe + " --development", recipe + " --development --source-root '/checkout'",
                       f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" submit-development' + " --source-root '/checkout'",
                       f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" submit-development',
                       recipe + " --source-digest '" + "c" * 64 + "' --native-snapshot-sha256 '" + "d" * 64 + "'",
                       f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" '
                       "start --assembly-receipt '/owned/receipt.json' --port '3197' --frontend 'dev'",
                       f'python3 "{repo}/scripts/verify_docker_all_runtime.py" --repo-root "{repo}" '
                       "'/owned/receipt.json'"]
            for candidate in recipes:
                accepted = subprocess.run([*command, candidate], env=env, text=True, capture_output=True)
                self.assertEqual(accepted.returncode, 0, accepted.stderr)
                self.assertIn("docker-all-gpu", accepted.stdout)
                rejected = subprocess.run([*command, candidate + "; true"], env=env,
                                          text=True, capture_output=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("invalid all-in-Docker", rejected.stderr)

    def test_gpu_release_keeps_receipt_profile(self):
        commit = "b" * 40
        context = {"job_id": "a" * 32, "source_digest": "c" * 64,
                   "profile": "fem-gpu-release", "image_digest": "sha256:" + "d" * 64,
                   "native_source_identity": {"head_commit_full": commit,
                                              "source_snapshot_dirty": False}}
        journal = {**context, "phase": "terminal", "state": "succeeded", "exit_code": 0,
                   "trusted_hashes": {name: "e" * 64 for name in
                                      ("context.json", "build_entrypoint.py", "worker_entrypoint.py")}}
        with patch.object(managed, "read_json", side_effect=[journal, context]), \
                patch.object(managed, "digest", return_value="e" * 64), \
                patch.object(managed, "validate_build_receipt", return_value={}) as validate:
            managed.validate_managed_build(Path(tempfile.gettempdir()).resolve() / context["job_id"], commit,
                                           expected_profile="fem-gpu-release")
            self.assertEqual(validate.call_args.args[1]["profile"], "fem-gpu-release")

    def test_default_cpu_validator_rejects_gpu_release(self):
        with patch.object(managed, "read_json", side_effect=[
            {"phase": "terminal", "state": "succeeded", "exit_code": 0,
             "profile": "fem-gpu-release"}, {}]):
            with self.assertRaisesRegex(ValueError, "terminal and successful"):
                managed.validate_managed_build(Path(tempfile.gettempdir()).resolve() / "job", "b" * 40)

    def test_submission_uses_gpu_queue_and_independent_source_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            layout = {"storage_root": str(root), "runs_root": str(root / "runs" / "test-worktree"),
                      "worktree_id": "test-worktree", "repo_root": str(root / "repo")}
            commit = "b" * 40
            manifest = {"resolved_commit": commit, "source_digest": "c" * 64}
            with patch.object(runtime.storage, "resolve_layout", return_value=layout), \
                    patch.object(runtime, "read_json", return_value={"worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"]}), \
                    patch.object(runtime.storage, "initialize"), \
                    patch.object(runtime.storage, "build_lock", return_value=nullcontext()), \
                    patch("local_runner.build_executor.configured_build"), \
                    patch("local_runner.build_source.native_identity", return_value={}), \
                    patch("local_runner.build_source.bind_identity", return_value={}), \
                    patch("local_runner.source.capture_source", return_value=manifest) as capture, \
                    patch("local_runner.container_client.request", side_effect=[
                        {"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]},
                        {"job_id": "d" * 32, "state": "queued"}]) as request, \
                    patch("builtins.print"):
                runtime.submit_build(root / "repo", commit)
                self.assertIsNone(capture.call_args.kwargs["content_store"])
                self.assertEqual(capture.call_args.kwargs["ref"], commit)
                payload = request.call_args.kwargs["payload"]
                self.assertEqual(payload["profile"], "fem-gpu-release")
                self.assertEqual(payload["operation"], "build")
                self.assertEqual(payload["source_digest"], manifest["source_digest"])
                self.assertEqual(payload["payload"]["source_mode"], "commit")
                self.assertEqual(payload["payload"]["capture_id"], payload["request_key"])
                self.assertEqual(payload["payload"]["capsule_relative"],
                                 "runs/test-worktree/" + payload["request_key"] + "/source")
                self.assertEqual(request.call_args_list[0].kwargs["method"], "GET")
                self.assertEqual(request.call_args_list[1].kwargs["method"], "POST")
                accepted = json.loads(next((root / "runs/test-worktree").glob("*/submission.json")).read_text())
                self.assertEqual(accepted["state"], "submitted")
                self.assertEqual(accepted["queue_state_at_submission"], "queued")
                self.assertFalse(accepted["build_claimed_at_submission"])
                self.assertEqual(accepted["build_qualification"], "NOT VERIFIED")
                self.assertIn("never stops or restarts", accepted["queue_policy"])
                request.reset_mock()
                request.side_effect = [{"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]},
                                       TimeoutError("response lost after POST")]
                with self.assertRaises(TimeoutError):
                    runtime.submit_build(root / "repo", commit)
                receipts = [json.loads(path.read_text()) for path in (root / "runs/test-worktree").glob("*/submission.json")]
                pending = [value for value in receipts if value["state"] == "submission_unconfirmed"]
                self.assertEqual(len(pending), 1)
                self.assertEqual(pending[0]["request_key"], pending[0]["submission"]["request_key"])
                self.assertEqual(pending[0]["capture_id"], pending[0]["request_key"])
                self.assertEqual(request.call_count, 2)

    def test_development_image_uses_the_selected_worktree_for_snapshot_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "worktree"
            selected.mkdir()
            with patch("docker_development_inputs.select_checkout", return_value=selected) as choose, \
                    patch.object(runtime.storage, "resolve_layout", return_value={}) as resolve, \
                    patch.object(runtime, "runtime_package_use", return_value=nullcontext()), \
                    patch.object(runtime, "prepare_gpu_release", side_effect=ValueError("stop before outputs")):
                with self.assertRaisesRegex(ValueError, "stop before outputs"):
                    runtime.build_image(root / "client", "a" * 32, "b" * 40, development=True,
                                        source_digest="c" * 64, native_snapshot_sha256="d" * 64,
                                        source_root=selected)
                choose.assert_called_once_with(root / "client", selected)
                resolve.assert_called_once_with(selected, runtime.PROFILE)

    def test_development_build_captures_main_and_rejects_capture_races(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            layout = {"storage_root": str(root), "runs_root": str(root / "runs/task"),
                      "worktree_id": "task", "repo_root": str(root / "main")}
            main = root / "main"
            manifest = {"resolved_commit": "b" * 40, "source_digest": "c" * 64}
            native = {"source_snapshot_sha256": "e" * 64}
            with patch.object(runtime.storage, "git", side_effect=lambda repo, *args: args[-1]), \
                    patch.object(runtime.storage, "resolve_layout", return_value=layout), \
                    patch.object(runtime, "read_json", return_value={"worktree_id": "task", "repo_root": layout["repo_root"]}), \
                    patch.object(runtime.storage, "initialize"), \
                    patch.object(runtime.storage, "build_lock", return_value=nullcontext()), \
                    patch("docker_development_inputs.main_checkout", return_value=main), \
                    patch.object(runtime.storage, "worktree_records", return_value=[{"worktree": str(main)}]), \
                    patch("local_runner.build_executor.configured_build"), \
                    patch("local_runner.build_source.native_identity", return_value=native) as identity, \
                    patch("local_runner.build_source.bind_identity", return_value=native), \
                    patch("local_runner.source.capture_source", return_value=manifest) as capture, \
                    patch("local_runner.container_client.request", side_effect=[
                        {"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]},
                        {"job_id": "d" * 32}]) as request, patch("builtins.print"):
                runtime.submit_build(root / "task", development=True)
                self.assertEqual(capture.call_args.args[0], main)
                self.assertEqual(capture.call_args.kwargs["mode"], "snapshot")
                self.assertIsNone(capture.call_args.kwargs["ref"])
                self.assertIsNone(capture.call_args.kwargs["content_store"])
                payload = request.call_args.kwargs["payload"]["payload"]
                self.assertEqual(payload["origin_repo"], str(main))
                self.assertEqual(payload["source_mode"], "snapshot")
                request.reset_mock()
                request.side_effect = [{"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]}]
                identity.side_effect = [native, {"source_snapshot_sha256": "f" * 64}]
                with self.assertRaisesRegex(ValueError, "changed during backend snapshot"):
                    runtime.submit_build(root / "task", development=True)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args.kwargs["method"], "GET")

    def test_entrypoint_rejects_windows_9p_before_cuda_or_writes(self):
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/entrypoint.py"
        spec = importlib.util.spec_from_file_location("all_docker_entrypoint", path)
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        with patch.object(entry.subprocess, "check_output", return_value="1021997\n"), \
                patch.object(entry.ctypes, "CDLL") as load, \
                patch.object(entry.Path, "mkdir") as mkdir:
            with self.assertRaisesRegex(RuntimeError, "Unsupported durable session filesystem"):
                entry.preflight()
            load.assert_not_called()
            mkdir.assert_not_called()


if __name__ == "__main__":
    unittest.main()
