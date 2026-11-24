"""Interpreted migration bootstrap admission; no native build or service mutation."""
import ast
from contextlib import contextmanager, ExitStack
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import docker_group_ledger_bootstrap as boot


def request_fixture():
    token = "1" * 32
    root = boot.CONTROL / "iteration/attempts" / token
    paths = {"stop_terminal": root / "terminal.json", "backend_drain": root / "backend-drain.json",
             "containers": root / "idle-stop-containers.json", "process": boot.CONTROL / "runtime-service/process-tree.json",
             "owner": boot.CONTROL / "runtime-services/OWNER.json", "config": boot.CONTROL / "runtime-config.json"}
    containers = {"backend": {"Id": "b" * 64, "State": {"Running": False, "StartedAt": "old-incarnation"}},
                  "frontend": {"Id": "f" * 64, "State": {"Running": False}}}
    process = {"schema": "fullmag.docker-process-tree.v1", "state": "drained"}
    rows = {"process": process, "owner": {"state": "drained"}, "config": {"generation": "old"},
            "containers": containers,
            "backend_drain": {"schema": "fullmag.docker-idle-restart-drain.v1", "backend_container_id": "b" * 64,
                              "process_receipt_sha256": boot.digest(boot.canonical(process)), "process_receipt": process},
            "stop_terminal": {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration", "state": "succeeded",
                "attempt": token, "compose_project": "own", "control_volume": "own-volume", "idle_backend_stopped": True,
                "backend_container": "b" * 64, "frontend_container": "f" * 64, "config_sha256": "c" * 64,
                "inputs": {"attempt": "d" * 32}, "idle_stop_containers_sha256": boot.digest(boot.canonical(containers) + b"\n")}}
    raw = {str(paths[role]): boot.canonical(value) for role, value in rows.items()}
    request = {"schema": boot.SCHEMA, "request_id": "e" * 32, "compose_project": "own", "control_volume": "own-volume",
        "source_root": "/home/user/git/worktree", "source_commit": "a" * 40, "source_manifest_sha256": "a" * 64,
        "source_snapshot_sha256": "0" * 64, "bootstrap_script_sha256": "a" * 64,
        "old_backend_container_id": "b" * 64, "old_backend_started_at": "old-incarnation", "development_attempt": "d" * 32,
        "config_sha256": "c" * 64, "ledger_inventory_sha256": "a" * 64,
        "current_package": {"receipt_sha256": "a" * 64, "inventory_sha256": "b" * 64, "cli_sha256": "c" * 64},
        "records": {role: {"path": str(path), "sha256": boot.digest(raw[str(path)])} for role, path in paths.items()},
        "result_path": str(boot.CONTROL / "group-ledger-bootstrap/attempts" / ("e" * 32) / "result.json")}
    return request, rows, raw


class BootstrapTests(unittest.TestCase):
    def test_request_is_closed_and_paths_are_scoped(self):
        request, _, _ = request_fixture()
        self.assertIs(boot.validate_request(request), request)
        for field, value in (("schema", "other"), ("source_commit", "a" * 7), ("old_backend_container_id", "b" * 63),
                             ("request_id", "../escape"), ("result_path", "/tmp/result.json")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                boot.validate_request(dict(request, **{field: value}))
        with self.assertRaises(ValueError):
            boot.validate_request(dict(request, extra=True))
        for invalid in ("/opt/fullmag/control/../secret", "/opt/fullmag/control//record", "/tmp/record"):
            changed = deepcopy(request)
            changed["records"]["owner"]["path"] = invalid
            with self.subTest(path=invalid), self.assertRaises(ValueError):
                boot.validate_request(changed)

    def test_request_main_uses_actual_backend_lf_serialization_and_raw_pin(self):
        from test_docker_backend_dev import backend
        request, _, _ = request_fixture()
        raw = backend._canonical(request)
        with patch.object(boot, "regular", return_value=raw), \
                patch.object(boot, "build", return_value={"state": "candidate-ready"}) as build:
            self.assertEqual(boot.main(["--request", "/opt/fullmag/control/request.json", "--request-sha256", boot.digest(raw)]), 0)
            build.assert_called_once()
        without_lf = boot.canonical(request)
        with patch.object(boot, "regular", return_value=without_lf), self.assertRaises(ValueError):
            boot.main(["--request", "/opt/fullmag/control/request.json", "--request-sha256", boot.digest(without_lf)])

    def test_duplicate_keys_are_rejected_at_any_depth(self):
        with self.assertRaises(ValueError):
            boot.strict_json(b'{"pin":{"sha256":"a","sha256":"b"}}')

    def read(self, request, raw):
        with patch.object(boot, "regular", side_effect=lambda path: raw[str(path)]):
            return boot.read_records(request)

    def test_real_stop_receipt_shapes_are_bound_together(self):
        request, rows, raw = request_fixture()
        self.assertEqual(self.read(request, raw), rows)
        for role in boot.ROLES:
            damaged = dict(raw)
            damaged[request["records"][role]["path"]] += b" "
            with self.subTest(role=role), self.assertRaises(ValueError):
                self.read(request, damaged)

    def changed_record(self, role, mutate):
        request, rows, raw = request_fixture()
        mutate(rows[role])
        path = request["records"][role]["path"]
        raw[path] = boot.canonical(rows[role])
        request["records"][role]["sha256"] = boot.digest(raw[path])
        return request, raw

    def test_even_rehashed_forged_stop_authority_is_refused(self):
        cases = [("stop_terminal", "state", "failed-confirmed"), ("stop_terminal", "idle_backend_stopped", False),
                 ("stop_terminal", "compose_project", "foreign"), ("stop_terminal", "backend_container", "x" * 64),
                 ("stop_terminal", "config_sha256", "0" * 64), ("stop_terminal", "attempt", "2" * 32),
                 ("backend_drain", "process_receipt_sha256", "0" * 64),
                 ("backend_drain", "backend_container_id", "0" * 64)]
        for role, key, value in cases:
            request, raw = self.changed_record(role, lambda row: row.update({key: value}))
            with self.subTest(role=role, key=key), self.assertRaises(ValueError):
                self.read(request, raw)
        for key, value in (("Running", True), ("StartedAt", "new-incarnation")):
            request, raw = self.changed_record("containers", lambda row: row["backend"]["State"].update({key: value}))
            # Also rehash the container manifest in the stop record: incarnation/status must still reject.
            stop_path = request["records"]["stop_terminal"]["path"]
            stop = boot.strict_json(raw[stop_path])
            stop["idle_stop_containers_sha256"] = boot.digest(raw[request["records"]["containers"]["path"]] + b"\n")
            raw[stop_path] = boot.canonical(stop)
            request["records"]["stop_terminal"]["sha256"] = boot.digest(raw[stop_path])
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.read(request, raw)

    def test_evidence_rejects_symlinks_hardlinks_devices_and_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            good = root / "good"
            good.write_bytes(b"data")
            self.assertEqual(boot.regular(good), b"data")
            link = root / "link"
            link.symlink_to(good)
            with self.assertRaises(ValueError): boot.regular(link)
            os.link(good, root / "hardlink")
            with self.assertRaises(ValueError): boot.regular(good)
            (root / "large").write_bytes(b"12345")
            with self.assertRaises(ValueError): boot.regular(root / "large", 4)
            with self.assertRaises(ValueError): boot.regular(Path("/dev/null"))

    def test_ledger_inventory_detects_content_drift_and_rejects_linked_trees(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ledger").mkdir()
            leaf = root / "ledger/HOST_RESOURCE_LEDGER.json"
            leaf.write_bytes(b"history")
            before = boot.ledger_inventory(root)
            self.assertEqual(before[0]["path"], "ledger/HOST_RESOURCE_LEDGER.json")
            leaf.write_bytes(b"changed")
            self.assertNotEqual(before, boot.ledger_inventory(root))
            (root / "escape").symlink_to(root / "ledger", target_is_directory=True)
            with self.assertRaises(ValueError): boot.ledger_inventory(root)

    def mountinfo(self):
        return "\n".join(f"{i} 1 0:1 / {target} {options} - ext4 /dev/test rw" for i, (target, options) in enumerate([
            (str(boot.SOURCE), "ro"), (str(boot.CONTROL), "rw"), (str(boot.LEDGER), "rw"),
            ("/build", "rw"), ("/opt/fullmag/package", "rw")], 10))

    def test_source_must_be_readonly_and_all_managed_mounts_present(self):
        text = self.mountinfo()
        boot.check_mounts(text)
        for damaged in (text.replace(str(boot.SOURCE) + " ro", str(boot.SOURCE) + " rw"),
                        "\n".join(text.splitlines()[:-1]), text + "\n" + text.splitlines()[0]):
            with self.assertRaises(ValueError): boot.check_mounts(damaged)

    def test_live_api_or_compiler_is_refused_but_zombies_are_not_live(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "999991"
            child.mkdir()
            (child / "stat").write_text("999991 (program) R 1 1")
            for program in ("fullmag-api", "fullmag-bin", "cargo", "rustc", "nvcc"):
                (child / "cmdline").write_bytes(program.encode() + b"\0")
                with self.subTest(program=program), self.assertRaises(ValueError): boot.no_native_processes(root)
            (child / "stat").write_text("999991 (program) Z 1 1")
            boot.no_native_processes(root)

    def test_actual_drain_authenticator_and_kernel_gates_reject_unknown_or_busy(self):
        from test_fullmag_docker_runtime import DockerRuntimeContract
        fixture = DockerRuntimeContract()
        runtime = fixture.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = SimpleNamespace(store=root / "store", state_root=root / "state", runtime_services=None)
            _, _, owner_lock = fixture._write_authenticated_drain_fixture(runtime, paths)
            service_root = runtime.runtime_services_root(paths)
            for name in ("STARTUP-GATE.lock", "LAUNCH.lock"):
                (service_root / name).write_bytes(b"")
            with boot.runtime_guards(runtime, paths) as unchanged:
                unchanged()
                with owner_lock.open("r+") as lock, self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            raw = (service_root / "OWNER.json").read_bytes()
            owner = json.loads(raw)
            owner["state"] = "unknown"
            (service_root / "OWNER.json").write_bytes(boot.canonical(owner))
            with self.assertRaises(runtime.RuntimeServiceError):
                with boot.runtime_guards(runtime, paths): pass
            (service_root / "OWNER.json").write_bytes(raw)
            with owner_lock.open("r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(runtime.RuntimeServiceError):
                    with boot.runtime_guards(runtime, paths): pass

    def test_source_capture_checks_actual_deterministic_fields(self):
        request, _, _ = request_fixture()
        document = {"resolved_commit": request["source_commit"], "source_manifest_sha256": request["source_manifest_sha256"],
                    "source_snapshot_sha256": request["source_snapshot_sha256"], "capture_id": "random"}
        backend = SimpleNamespace(_capture_start_manifest=Mock(return_value=Path("/build/manifest")),
                                  _read_json=Mock(side_effect=lambda *args: (document, b"random envelope")))
        self.assertEqual(boot.capture(backend, request).manifest, Path("/build/manifest"))
        for key in ("resolved_commit", "source_manifest_sha256", "source_snapshot_sha256"):
            old = document[key]
            document[key] = "different"
            with self.subTest(key=key), self.assertRaises(ValueError): boot.capture(backend, request)
            document[key] = old

    def test_package_uses_canonical_artifact_hashing_including_shared_hardlinks(self):
        request, _, _ = request_fixture()
        receipt = {"artifacts": [{"path": "bin/fullmag-bin", "sha256": "cli"}]}
        request["current_package"] = {"receipt_sha256": boot.digest(b"receipt"),
            "inventory_sha256": boot.digest(boot.canonical(receipt["artifacts"])), "cli_sha256": "c" * 64}
        backend = SimpleNamespace(PACKAGE_ROOT=Path("/opt/fullmag/package"),
            _validated_package=Mock(return_value=(receipt, b"receipt", {})), _sha256_file=Mock(return_value=("c" * 64, None)))
        boot.package_pin(backend, request)
        self.assertTrue(backend._sha256_file.call_args.kwargs["package_artifact"])
        request["current_package"]["inventory_sha256"] = "0" * 64
        with self.assertRaises(ValueError): boot.package_pin(backend, request)

    def test_capability_probe_has_only_closed_help_commands_and_candidate_libraries(self):
        def probe(argv, **kwargs):
            self.assertEqual(argv[0], "/candidate/bin/fullmag-bin")
            self.assertEqual(argv[-1], "--help")
            self.assertEqual(kwargs["env"]["LD_LIBRARY_PATH"], "/candidate/lib")
            return SimpleNamespace(returncode=0, stdout=argv[2].encode(), stderr=b"")
        with patch.object(boot.subprocess, "run", side_effect=probe):
            self.assertEqual(set(boot.probe_capabilities(Path("/candidate"))),
                             {"ledger-relocation-inspect", "ledger-relocation-preview"})
        with patch.object(boot.subprocess, "run", return_value=SimpleNamespace(returncode=2, stdout=b"", stderr=b"")):
            with self.assertRaises(ValueError): boot.probe_capabilities(Path("/candidate"))

    def test_runtime_control_alias_requires_same_inode_and_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native, alias = root / "runtime", root / "control"
            native.mkdir(); alias.mkdir(); (alias / "runtime-control").mkdir()
            request = {"records": {}}
            for role in ("process", "owner", "config"):
                path = native / role
                path.write_bytes(role.encode())
                os.link(path, alias / "runtime-control" / role)
                request["records"][role] = {"path": str(alias / "runtime-control" / role), "sha256": boot.digest(role.encode())}
            runtime = SimpleNamespace(process_receipt_path=lambda _: native / "process",
                                      runtime_services_root=lambda _: native)
            # OWNER.json is the canonical runtime owner filename.
            (native / "owner").rename(native / "OWNER.json")
            (alias / "runtime-control" / "owner").rename(alias / "runtime-control" / "OWNER.json")
            request["records"]["owner"]["path"] = str(alias / "runtime-control" / "OWNER.json")
            paths = SimpleNamespace(config=native / "config")
            # Bind-mounted aliases have identical inode without an additional hardlink count.
            def alias_regular(path):
                with Path(path).open("rb") as stream:
                    return stream.read()
            with patch.object(boot, "CONTROL", alias), patch.object(boot, "RUNTIME_CONTROL", native), \
                    patch.object(boot, "regular", side_effect=alias_regular):
                boot.check_native_aliases(request, runtime, paths)
                (alias / "runtime-control" / "config").unlink()
                (alias / "runtime-control" / "config").write_bytes(b"config")
                with self.assertRaises(ValueError): boot.check_native_aliases(request, runtime, paths)

    def exercise_build(self, drift=False):
        request, _, _ = request_fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            control = root / "development"
            candidates = control / "candidates"
            candidates.mkdir(parents=True)
            artifacts = [{"path": "bin/fullmag-bin", "sha256": "a" * 64}]
            receipt = {"artifacts": artifacts, "source": {"resolved_commit": request["source_commit"]}}
            backend = SimpleNamespace(PACKAGE_ROOT=root / "package", PACKAGE_CANDIDATES_DIRNAME="candidates",
                PACKAGE_ROTATION_JOURNAL_NAME="rotation.pending.json",
                _canonical=lambda value: boot.canonical(value) + b"\n",
                _runtime_build_lock=lambda _: __import__("contextlib").nullcontext(),
                _ensure_package_development_root=lambda _: control,
                _preflight_candidate_storage=Mock(), _toolchain_identity=lambda: (None, {}),
                _write_candidate_marker=Mock(), _prepare_with_shared_package=Mock(return_value=0),
                _validate_candidate_marker=Mock(return_value={"artifact_inventory_sha256": boot.digest(boot.canonical(artifacts) + b"\n")}),
                _validated_package=Mock(return_value=(receipt, b"candidate-receipt", {})),
                _sha256_file=Mock(return_value=("a" * 64, None)), _write_json=Mock())
            runtime = SimpleNamespace(canonical_paths=lambda: None)
            inventory = [{"path": "ledger/history", "size": 4, "sha256": "b" * 64}]
            request["ledger_inventory_sha256"] = boot.digest(boot.canonical(inventory))
            request["bootstrap_script_sha256"] = boot.digest(b"script")
            @contextmanager
            def guards(*_):
                yield Mock()
            environment = {"FULLMAG_COMPOSE_PROJECT": request["compose_project"],
                "FULLMAG_SOURCE_HOST_ROOT": request["source_root"], "FULLMAG_BUILD_CONTROL_VOLUME": request["control_volume"],
                "FULLMAG_DOCKER_ROLE": "backend", "CARGO_BUILD_JOBS": "2"}
            with ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, environment))
                stack.enter_context(patch.object(Path, "read_text", return_value=self.mountinfo()))
                for name, value in {"regular": lambda _: b"script", "check_native_aliases": lambda *_: None,
                    "runtime_guards": guards, "read_records": lambda _: None, "no_native_processes": lambda: None,
                    "package_pin": lambda *_: ("current", b"current", {}), "capture": lambda *_: SimpleNamespace(),
                    "probe_capabilities": lambda _: {"inspect": "help"}}.items():
                    stack.enter_context(patch.object(boot, name, side_effect=value))
                stack.enter_context(patch.object(boot, "ledger_inventory", side_effect=[inventory, [] if drift else inventory]))
                if drift:
                    with self.assertRaisesRegex(ValueError, "Ledger changed"):
                        boot.build(request, backend, runtime)
                    backend._write_json.assert_not_called()
                else:
                    result = boot.build(request, backend, runtime)
                    self.assertEqual(result["state"], "candidate-ready")
                    self.assertFalse(result["runtime_started"])
                    self.assertFalse(result["package_promoted"])
                    backend._write_json.assert_called_once()
                self.assertEqual(len(list(candidates.iterdir())), 1)
                backend._prepare_with_shared_package.assert_called_once()
                args = backend._prepare_with_shared_package.call_args.args
                self.assertEqual(args[2], args[5])

    def test_build_path_produces_only_unpromoted_candidate_receipt(self):
        self.exercise_build()

    def test_post_build_ledger_drift_withholds_result_and_preserves_candidate(self):
        self.exercise_build(drift=True)

    def test_candidate_build_never_calls_publication_or_runtime_initialization(self):
        tree = ast.parse(Path(boot.__file__).read_text())
        calls = {node.func.attr for node in ast.walk(tree)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertIn("_prepare_with_shared_package", calls)
        self.assertIn("_authenticated_terminal_drain", calls)
        self.assertFalse(calls & {"_serve", "_rotate_package", "_publish_runtime_provenance", "prepare_storage",
                                  "initialize_host_configuration", "initialize_accepted_store", "ensure_configuration"})


if __name__ == "__main__":
    unittest.main()
