"""Interpreted bootstrap controller tests; Docker calls are observation/lifecycle doubles."""
import argparse
import ast
from contextlib import contextmanager
from copy import deepcopy
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import docker_group_ledger_bootstrap_host as host
from docker_build_control import BuildControlError
from test_docker_group_ledger_bootstrap import request_fixture


def document_fixture():
    mounts = [{"type": "volume", "source": name, "target": target, "volume": {"nocopy": True, "subpath": subpath}}
        for name, target, subpath in (("build", "/build", ""), ("ledger", "/host-ledger", ""),
            ("control", "/opt/fullmag/control", ""), ("control", "/opt/fullmag/runtime-control", "runtime-control"),
            ("packages", "/opt/fullmag/package", "groups/unit"))]
    mounts.append({"type": "bind", "source": "/home/user/git/worktree", "target": "/opt/fullmag/source", "read_only": True})
    return {"name": "own", "services": {"backend": {"image": "sha256:" + "a" * 64,
        "environment": {"EXISTING": "preserved"}, "volumes": mounts, "entrypoint": ["original"],
        "command": ["start"], "networks": ["private"], "gpus": [{"count": "all"}], "ports": []},
        "frontend": {"image": "sha256:" + "a" * 64, "environment": {}, "volumes": []}},
        "volumes": {name: {"name": name + "-volume", "external": True} for name in ("build", "ledger", "control", "packages")}}


class HostBootstrapTests(unittest.TestCase):
    def test_bootstrap_replaces_only_backend_command_image_and_closed_gate(self):
        document = document_fixture()
        before = deepcopy(document)
        updated = host.bootstrap_document(document, "/request", "b" * 64, "sha256:" + "c" * 64, ["native.rs"])
        self.assertEqual(document, before)
        self.assertEqual(updated["services"]["frontend"], before["services"]["frontend"])
        backend = updated["services"]["backend"]
        self.assertEqual(backend["volumes"], before["services"]["backend"]["volumes"])
        self.assertEqual(backend["entrypoint"][-1], "/opt/fullmag/source/scripts/docker_group_ledger_bootstrap.py")
        self.assertEqual(backend["command"], ["--request", "/request", "--request-sha256", "b" * 64])
        self.assertEqual(backend["restart"], "no")
        self.assertEqual(backend["healthcheck"], {"disable": True})
        self.assertEqual(json.loads(backend["environment"]["FULLMAG_DEV_INCLUDE_UNTRACKED"]), ["native.rs"])

    def test_metadata_helper_has_no_network_or_app_entrypoint_and_ledger_is_readonly(self):
        document = document_fixture()
        updated = host.diagnostic_document(document, "sha256:" + "c" * 64, "/seed", [])
        self.assertEqual(set(updated["services"]), {"build-control"})
        helper = updated["services"]["build-control"]
        self.assertEqual(helper["network_mode"], "none")
        self.assertNotIn("gpus", helper)
        self.assertNotIn("networks", helper)
        for mount in helper["volumes"]:
            if mount["target"] in {"/host-ledger", "/opt/fullmag/package", "/opt/fullmag/source"}:
                self.assertTrue(mount["read_only"])
        ast.parse(host.PREPARE_REQUEST)
        calls = {node.func.attr for node in ast.walk(ast.parse(host.PREPARE_REQUEST))
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertIn("_capture_start_manifest", calls)
        self.assertFalse(calls & {"_prepare_locked", "_prepare_with_shared_package", "_serve", "prepare_storage",
                                  "initialize_host_configuration", "_rotate_package"})

    def test_stopped_identity_requires_exit_zero_and_exact_incarnation(self):
        before = {key: {"Id": key, "Image": "image", "State": {"StartedAt": "old"}}
                  for key in ("backend", "frontend")}
        stopped = deepcopy(before)
        for row in stopped.values(): row["State"].update(Running=False, OOMKilled=False, ExitCode=0)
        host.assert_stopped(stopped, before)
        for field, value in (("Running", True), ("StartedAt", "new"), ("ExitCode", 1), ("OOMKilled", True)):
            changed = deepcopy(stopped); changed["backend"]["State"][field] = value
            with self.subTest(field=field), self.assertRaises(BuildControlError): host.assert_stopped(changed, before)

    def test_package_and_ledger_subpaths_are_preserved_in_native_program_handoff(self):
        document = document_fixture()
        backend = {"Mounts": [{"Destination": mount["target"], "Name": document["volumes"][mount["source"]]["name"]}
                   for mount in document["services"]["backend"]["volumes"] if mount["type"] == "volume"]}
        binding = host.mount_binding(document, backend)
        self.assertEqual(binding["/opt/fullmag/package"], {"volume": "packages-volume", "subpath": "groups/unit"})
        backend["Mounts"][0]["Name"] = "foreign"
        with self.assertRaises(BuildControlError): host.mount_binding(document, backend)

    def test_image_validation_checks_source_lineage_and_toolchain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "backend.py").write_bytes(b"backend"); (root / "runtime.py").write_bytes(b"runtime")
            base_id, backend_id = "sha256:" + "b" * 64, "sha256:" + "a" * 64
            base_inputs = {"parent_image_id": "sha256:" + "c" * 64,
                           "files": [{"path": "runtime.py", "sha256": host.guest.digest(b"runtime")}]}
            backend_inputs = {"parent_image_id": base_id,
                              "files": [{"path": "backend.py", "sha256": host.guest.digest(b"backend")}]}
            receipts = {"image-dev/verified.json": {"state": "succeeded", "compose_project": "own", "image_id": base_id, "inputs": base_inputs},
                        "image-backend/verified.json": {"state": "succeeded", "compose_project": "own", "image_id": backend_id, "inputs": backend_inputs}}
            def image(identifier):
                inputs = base_inputs if identifier == base_id else backend_inputs
                return {"Config": {"Env": ["FULLMAG_TOOLCHAIN_IMAGE_ID=toolchain"],
                    "Labels": {"org.fullmag.build.input-digest": host.guest.digest(host.canonical(inputs))}}}
            control = SimpleNamespace(project="own", read=lambda key: receipts[key])
            backend = {"Config": {"Env": ["FULLMAG_TOOLCHAIN_IMAGE_ID=toolchain"]}}
            with patch.object(host, "image", side_effect=image):
                host.verify_bootstrap_image(control, root, backend_id, backend)
                (root / "runtime.py").write_bytes(b"changed")
                with self.assertRaises(BuildControlError): host.verify_bootstrap_image(control, root, backend_id, backend)

    def test_preview_does_not_prepare_stop_or_acquire_operation_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in host.REQUIRED_UNTRACKED:
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"source")
            document = document_fixture()
            before = {key: {"Id": ("b" if key == "backend" else "f") * 64, "Image": "image",
                            "State": {"Running": True, "StartedAt": "old", "Health": {"Status": "healthy"}}, "Mounts": []}
                      for key in ("backend", "frontend")}
            control = SimpleNamespace(project="own", identity={}, prepare=Mock(), operation=Mock(),
                read=Mock(return_value={"schema": "fullmag.docker-group-ledger.v1", "compose_project": "own",
                                       "volume_name": "ledger-volume", "host_id": "a" * 64}))
            args = SimpleNamespace(repo_root=str(root), source_root=str(root), image_id="sha256:" + "a" * 64,
                attempt="d" * 32, config_sha256="c" * 64, apply=False)
            with patch.object(host, "require_host"), patch.object(host, "_select_source", return_value=(root, {})), \
                    patch.object(host, "_compose_identity", return_value={}), patch.object(host, "BuildControl", return_value=control), \
                    patch.object(host, "retained", return_value=({}, document, before, {})), \
                    patch.object(host, "verify_bootstrap_image"), patch.object(host, "mount_binding", return_value={"/host-ledger": {"volume": "ledger-volume"}}), \
                    patch.object(host, "include_untracked_from_compose", return_value=[]), patch.object(host, "_assert_private_restart_network"), \
                    patch.object(host, "docker_capture", return_value=SimpleNamespace(stdout=b"daemon")), \
                    patch.object(host, "stop_idle") as stop:
                preview = host.run(args)
                self.assertFalse(preview["apply"])
                stop.assert_not_called(); control.prepare.assert_not_called(); control.operation.assert_not_called()

    def shell_recipe(self):
        return ('python "/ignored/scripts/docker_group_ledger_bootstrap_host.py" --repo-root "/ignored" '
                "--attempt '" + 'a' * 32 + "' --config-sha256 '" + 'b' * 64
                + "' --source-root '/selected/$(printf injected);worktree' --image-id 'sha256:" + 'c' * 64
                + "' --port '3203'")

    def test_closed_shell_dispatch_uses_literal_argv_and_no_generic_storage(self):
        from test_just_development_recovery_shell import DevelopmentRecoveryShellTests
        shell = DevelopmentRecoveryShellTests()
        marker = '  *"scripts/docker_group_ledger_bootstrap_host.py"*)\n'
        for suffix in ('', ' --apply', ' --apply --allow-prepared-session'):
            result = shell.dispatch(self.shell_recipe() + suffix, marker)
            self.assertEqual(result.returncode, 0, result.stderr)
            argv = result.stdout.split(b'\0')[:-1]
            self.assertEqual(argv[:4], [b'/recorded/python', b'-B',
                b'/registered/checkout/scripts/docker_group_ledger_bootstrap_host.py', b'--repo-root'])
            self.assertIn(b'/selected/$(printf injected);worktree', argv)
            self.assertEqual(argv[-len(suffix.split()):] if suffix else [], [x.encode() for x in suffix.split()])

    def test_closed_shell_dispatch_rejects_injection_extra_flags_and_bad_pins(self):
        from test_just_development_recovery_shell import DevelopmentRecoveryShellTests
        shell = DevelopmentRecoveryShellTests()
        marker = '  *"scripts/docker_group_ledger_bootstrap_host.py"*)\n'
        for text in (self.shell_recipe() + '; printf injected', self.shell_recipe() + ' && printf injected',
                     self.shell_recipe() + '\nprintf injected', self.shell_recipe() + ' --fresh-state',
                     self.shell_recipe() + ' --apply --apply', self.shell_recipe().replace('a' * 32, 'short')):
            result = shell.dispatch(text, marker)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(result.stdout)

    def test_controller_opens_bootstrap_lease_after_established_stop(self):
        tree = ast.parse(Path(host.__file__).read_text())
        run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run")
        stop = next(node for node in ast.walk(run) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name) and node.func.id == "stop_idle")
        operation = next(node for node in ast.walk(run) if isinstance(node, ast.Call)
                         and isinstance(node.func, ast.Attribute) and node.func.attr == "operation")
        self.assertLess(stop.lineno, operation.lineno)
        calls = {node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse(calls & {"_group_ledger", "initialize_host_configuration", "_rotate_package", "_serve", "unlink", "rmtree"})


if __name__ == "__main__":
    unittest.main()


class RuntimeIdentityTests(unittest.TestCase):
    def test_mount_order_alone_is_not_container_identity(self):
        original={'Id':'container','State':{'StartedAt':'exact'},'Mounts':[
            {'Destination':'/source','Source':'/host/source','RW':False},
            {'Destination':'/build','Name':'cache','RW':True}]}
        reversed_mounts={**original,'Mounts':list(reversed(original['Mounts']))}
        self.assertEqual(host.normalize_container(original),host.normalize_container(reversed_mounts))
        self.assertEqual(original['Mounts'][0]['Destination'],'/source')
        changed={**original,'Mounts':[dict(mount) for mount in original['Mounts']]}
        changed['Mounts'][0]['RW']=True
        self.assertNotEqual(host.normalize_container(original),host.normalize_container(changed))
        changed={**original,'State':{'StartedAt':'different'}}
        self.assertNotEqual(host.normalize_container(original),host.normalize_container(changed))

    def test_duplicate_mount_destination_refuses(self):
        with self.assertRaisesRegex(BuildControlError,'Duplicate Docker mount destination'):
            host.normalize_container({'Mounts':[{'Destination':'/build','Name':'one'},
                                            {'Destination':'/build','Name':'two'}]})

    def test_bind_alias_repin_changes_only_daemon_spellings_after_inode_proof(self):
        import docker_dev_browser_qa as qa
        with tempfile.TemporaryDirectory() as root:
            path=Path(root);source=path/'source';source.mkdir();local=path/'aliases'/'Ubuntu';local.mkdir(parents=True)
            token='a'*64;(local/token).symlink_to(source,target_is_directory=True)
            daemon='/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/'+token
            document={'services':{'backend':{'environment':{'PIN':'exact'},'volumes':[
                {'type':'bind','target':'/state','source':str(source),'read_only':False}],
                'x-fullmag-daemon-binds':{'/state':str(source)}}}}
            actual={'Mounts':[{'Type':'bind','Source':daemon,'Destination':'/state','RW':True}]}
            with patch.object(qa,'LOCAL_WSL_BIND_MOUNT_ROOT',path/'aliases'):
                updated,proof=host.repin_daemon_binds(document,actual)
                self.assertEqual(updated['services']['backend']['x-fullmag-daemon-binds'],{'/state':daemon})
                restored=deepcopy(updated)
                restored['services']['backend']['x-fullmag-daemon-binds']={'/state':str(source)}
                self.assertEqual(restored,document)
                self.assertEqual(proof['/state']['inode'],source.stat().st_ino)
                other=path/'other';other.mkdir();(local/token).unlink();(local/token).symlink_to(other,target_is_directory=True)
                with self.assertRaisesRegex(ValueError,'inode differs'):
                    host.repin_daemon_binds(document,actual)

    def test_certificate_alias_requires_same_regular_file(self):
        import docker_dev_browser_qa as qa
        with tempfile.TemporaryDirectory() as root:
            path=Path(root);source=path/'certificate.json';source.write_text('{}')
            local=path/'aliases'/'Ubuntu';local.mkdir(parents=True);token='b'*64;(local/token).symlink_to(source)
            daemon='/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/'+token
            target='/run/fullmag/linux-native-host.json'
            document={'services':{'backend':{'volumes':[{'type':'bind','target':target,'source':str(source),'read_only':True}]}}}
            actual={'Mounts':[{'Type':'bind','Source':daemon,'Destination':target,'RW':False}]}
            with patch.object(qa,'LOCAL_WSL_BIND_MOUNT_ROOT',path/'aliases'):
                updated,proof=host.repin_daemon_binds(document,actual)
                self.assertEqual(proof[target]['inode'],source.stat().st_ino)
                self.assertEqual(updated['services']['backend']['volumes'],document['services']['backend']['volumes'])
                actual['Mounts'][0]['Type']='volume'
                with self.assertRaisesRegex(ValueError,'inventory differs'):
                    host.repin_daemon_binds(document,actual)
