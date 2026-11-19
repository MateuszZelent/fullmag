"""Host-device reattestation regression tests, without Docker or application builds."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import docker_volume_host_device as recovery
import linux_native_host as host
from docker_build_control import BuildControlError

IMAGE = "sha256:" + "a" * 64

@unittest.skipUnless(os.name == "posix", "Linux/WSL host recovery")
class HostDeviceTests(unittest.TestCase):
    def fixture(self, state):
        payload = ("b" * 32 + ":" + IMAGE).encode()
        native = {"host_root": str(state), "host_filesystem": "ext4", "host_platform": "linux",
                  "host_root_no_reparse": True, "host_device": 22}
        certificate = {"schema": host.HOST_SCHEMA, "storage_profile": host.PROFILE,
                       "role": "session", "owner_scope": "docker-linux", **native,
                       "host_device": 11, "host_inode": state.stat().st_ino,
                       "engine_id": "engine", "image_id": IMAGE, "owner_token": "b" * 32,
                       "restart_expected_sha256": hashlib.sha256(payload).hexdigest(),
                       "restart_verified": True}
        host.publish_bytes(state / ".linux-native-sentinel", payload)
        host.publish_bytes(state / ".linux-native-restart", payload)
        return certificate, native

    def invoke(self, state, old, native, **changes):
        raw = (json.dumps(old, indent=2) + "\n").encode()
        arguments = {"engine": "engine", "image": IMAGE,
                     "expected_sha": recovery.sha(raw), "expected_device": 22, **changes}
        with patch.object(host, "local_volume", return_value=native):
            return raw, recovery.replacement(state, raw, **arguments)

    def test_renumbering_changes_only_device_and_retains_bound_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old, native = self.fixture(state)
            raw, new = self.invoke(state, old, native)
            expected = {**old, "host_device": 22}
            self.assertEqual(json.loads(new), expected)
            for name in (host.CERTIFICATE_NAME, host.OWNER_NAME):
                host.publish_bytes(state / name, raw)
            inode = (state / host.CERTIFICATE_NAME).stat().st_ino
            recovery.publish(state, raw, new)
            self.assertEqual((state / host.CERTIFICATE_NAME).stat().st_ino, inode)
            self.assertEqual(host.read_owned_regular(state / host.CERTIFICATE_NAME), new)
            self.assertEqual(host.read_owned_regular(state / host.OWNER_NAME), new)

    def test_wrong_pins_engine_inode_path_and_sentinel_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old, native = self.fixture(state)
            for changes in ({"expected_sha": "0"*64}, {"engine": "foreign"},
                            {"image": "sha256:"+"c"*64}, {"expected_device": 99}):
                with self.subTest(changes=changes), self.assertRaises(BuildControlError):
                    self.invoke(state, old, native, **changes)
            for key, value in (("host_inode", old["host_inode"]+1), ("host_root", "/foreign"),
                               ("owner_scope", "foreign"), ("restart_verified", False)):
                with self.subTest(key=key), self.assertRaises(BuildControlError):
                    self.invoke(state, {**old,key:value}, native)
            host.publish_bytes(state / ".linux-native-sentinel", b"foreign")
            with self.assertRaises(BuildControlError):
                self.invoke(state, old, native)

    def test_partial_apply_is_resumable_but_foreign_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old, native = self.fixture(state)
            raw, new = self.invoke(state, old, native)
            for cert, marker in ((raw,raw),(new,raw),(raw,new),(new,new)):
                host.publish_bytes(state / host.CERTIFICATE_NAME, cert)
                host.publish_bytes(state / host.OWNER_NAME, marker)
                recovery.publish(state, raw, new)
                self.assertEqual(host.read_owned_regular(state / host.CERTIFICATE_NAME), new)
            host.publish_bytes(state / host.OWNER_NAME, b"foreign")
            with self.assertRaises(BuildControlError):
                recovery.publish(state, raw, new)
            self.assertEqual(host.read_owned_regular(state / host.OWNER_NAME), b"foreign")

    def test_symlink_and_hardlinked_certificate_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old, native = self.fixture(state)
            raw, new = self.invoke(state, old, native)
            target=state / "foreign"
            target.write_bytes(raw)
            (state / host.CERTIFICATE_NAME).symlink_to(target)
            host.publish_bytes(state / host.OWNER_NAME, raw)
            with self.assertRaises(host.storage.StorageError):
                recovery.publish(state, raw, new)
            self.assertEqual(target.read_bytes(),raw)
            (state / host.CERTIFICATE_NAME).unlink()
            import os
            os.link(target, state / host.CERTIFICATE_NAME)
            with self.assertRaises(ValueError):
                recovery.publish(state, raw, new)
            self.assertEqual(target.read_bytes(),raw)


    def test_desktop_state_alias_resolves_only_through_observed_filesystem(self):
        from types import SimpleNamespace
        state = Path("/owned/state")
        alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/" + "a" * 64
        with patch.object(Path, "stat", return_value=SimpleNamespace(st_dev=22)), \
             patch.object(recovery.subprocess, "run", side_effect=[
                 SimpleNamespace(stdout="/\n"), SimpleNamespace(stdout=str(state) + "\n")]):
            self.assertEqual(recovery.bind_host_path(alias, state), state)
        with patch.object(Path, "stat", side_effect=[SimpleNamespace(st_dev=11), SimpleNamespace(st_dev=22)]):
            self.assertIsNone(recovery.bind_host_path(alias, state))
        with patch.object(Path, "stat", return_value=SimpleNamespace(st_dev=22)), \
             patch.object(recovery.subprocess, "run", return_value=SimpleNamespace(stdout="relative\n")):
            with self.assertRaises(BuildControlError):
                recovery.bind_host_path(alias, state)
        self.assertEqual(recovery.bind_host_path("/foreign/state", state), Path("/foreign/state"))

    def test_command_rejects_running_foreign_and_changed_groups_before_write(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        from unittest.mock import Mock
        import docker_volume_dev as dev
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old, native = self.fixture(state)
            raw = (json.dumps(old, indent=2) + "\n").encode()
            for name in (host.CERTIFICATE_NAME, host.OWNER_NAME):
                host.publish_bytes(state / name, raw)
            document={"name":"owned","services":{}}
            config_sha=recovery.sha(recovery.canonical(document))
            previous={"schema":"fullmag.docker-build-operation.v1","phase":"development",
                      "attempt":"c"*32,"state":"succeeded","compose_project":"owned","state_root":str(state),
                      "inputs":{"source_root":str(state),"image_id":IMAGE},
                      "backend_container":"d"*64,"frontend_container":"e"*64}
            args=SimpleNamespace(attempt="c"*32,config_sha256=config_sha,
                                 certificate_sha256=recovery.sha(raw),expected_host_device=22,apply=True)
            control=Mock(project="owned")
            records={}
            def read(path, optional=False):
                if path.endswith("/terminal.json"): return previous
                if path.endswith("/compose.json"): return document
                return records.get(path)
            control.read_bytes.return_value=None
            control.read.side_effect=read
            control.write.side_effect=lambda path,value:records.__setitem__(path,value)
            control.operation.side_effect=lambda *a,**k:nullcontext({"receipt":{}})
            def row(service):
                return {"Id":previous[service+"_container"],"Image":IMAGE,
                        "Config":{"Labels":{"com.docker.compose.project":"owned","com.docker.compose.service":service}},
                        "State":{"Running":False,"Pid":0,"Status":"exited","Restarting":False,"OOMKilled":False,"Dead":False},
                        "Mounts":[{"Destination":"/state","Source":str(state),"Type":"bind"}]}
            rows={"backend":row("backend"),"frontend":row("frontend")}
            extra=[]
            def docker(*argv):
                if argv[:2]==("image","inspect"): return json.dumps([{"Config":{}}])
                if argv[0]=="inspect":
                    if len(argv)==2:
                        return json.dumps([next(r for r in rows.values() if r["Id"]==argv[1])])
                    return json.dumps([*rows.values(),*extra])
                if argv[0]=="ps": return " ".join([r["Id"] for r in rows.values()]+[r["Id"] for r in extra])
                if argv[0]=="info": return "engine"
                raise AssertionError(argv)
            with patch.object(Path,"read_text",return_value="microsoft-standard-WSL2"), \
                 patch("docker_dev_up._selected_context",return_value=(state,state,{"runtime_root":state},{},control)), \
                 patch.object(host,"local_volume",return_value=native), \
                 patch.object(dev,"docker_text",side_effect=docker), \
                 patch.object(dev,"_validate_retained_service"):
                rows["backend"]["State"]["Running"]=True
                with self.assertRaisesRegex(BuildControlError,"stopped services"):
                    recovery.run(args)
                self.assertEqual(records,{})
                rows["backend"]["State"]["Running"]=False
                rows["frontend"]["Image"]="sha256:"+"f"*64
                with self.assertRaisesRegex(BuildControlError,"frontend image differs"):
                    recovery.run(args)
                self.assertEqual(records,{})
                rows["frontend"]["Image"]=IMAGE
                extra.append({"Id":"f"*64,"Mounts":[{"Type":"bind","Source":str(state.parent)}]})
                with self.assertRaisesRegex(BuildControlError,"Another container"):
                    recovery.run(args)
                self.assertEqual(records,{})
                extra.clear()
                self.assertEqual(recovery.run(args)["state"],"succeeded")
                # Repeating the exact journaled operation remains safe/idempotent.
                self.assertEqual(recovery.run(args)["state"],"succeeded")
                self.assertEqual(json.loads(host.read_owned_regular(state/host.CERTIFICATE_NAME))["host_device"],22)


    def test_iteration_recovery_real_lock_cas_and_receipt_preservation(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            token="a"*32
            path=root/"iteration/attempts"/token
            path.mkdir(parents=True)
            (root/"operation.lock").touch()
            original=b'{"state":"starting"}\n'
            (path/"receipt.json").write_bytes(original)
            terminal={"state":"failed-confirmed","reason":"test"}
            script=recovery.iteration_recovery_script(str(root),token,recovery.sha(original),terminal)
            (root/"active").write_text("b"*32+"\n")
            refused=subprocess.run(["bash","-c",script],capture_output=True)
            self.assertNotEqual(refused.returncode,0)
            self.assertTrue((root/"active").exists())
            self.assertFalse((path/"terminal.json").exists())
            (root/"active").write_text(token+"\n")
            applied=subprocess.run(["bash","-c",script],capture_output=True)
            self.assertEqual(applied.returncode,0,applied.stderr)
            self.assertFalse((root/"active").exists())
            self.assertEqual((path/"receipt.json").read_bytes(),original)
            self.assertEqual(json.loads((path/"terminal.json").read_bytes()),terminal)
            # Recreate only the marker to model a crash after terminal publish.
            (root/"active").write_text(token+"\n")
            self.assertEqual(subprocess.run(["bash","-c",script],capture_output=True).returncode,0)

    def test_iteration_recovery_refuses_held_lock_and_foreign_terminal(self):
        import fcntl
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            token="a"*32
            path=root/"iteration/attempts"/token
            path.mkdir(parents=True)
            original=b"original"
            (path/"receipt.json").write_bytes(original)
            (root/"active").write_text(token+"\n")
            script=recovery.iteration_recovery_script(str(root),token,recovery.sha(original),{"state":"failed-confirmed"})
            with (root/"operation.lock").open("w") as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertNotEqual(subprocess.run(["bash","-c",script],capture_output=True).returncode,0)
                self.assertTrue((root/"active").exists())
            (path/"terminal.json").write_bytes(b"foreign")
            self.assertNotEqual(subprocess.run(["bash","-c",script],capture_output=True).returncode,0)
            self.assertTrue((root/"active").exists())
            self.assertEqual((path/"terminal.json").read_bytes(),b"foreign")


    def test_iteration_recovery_rejects_symlinked_run_directory(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            state=root/"state"
            state.mkdir()
            parent=state/"runs/docker-all/session-store"
            parent.mkdir(parents=True)
            outside=root/"outside"
            outside.mkdir()
            (parent/"runs").symlink_to(outside,target_is_directory=True)
            token="a"*32
            pins={"attempt":"b"*32,"config_sha256":"c"*64,"source_root":"/source"}
            receipt={"schema":"fullmag.docker-build-operation.v1","phase":"iteration",
                     "attempt":token,"state":"starting","compose_project":"owned",
                     "control_volume":"control","helper_container":"fullmag-control-"+token,
                     "inputs":pins}
            control=Mock(project="owned",volume="control",namespace="")
            control.read_bytes.side_effect=[(token+"\n").encode(),json.dumps(receipt).encode()]
            with self.assertRaises(host.storage.StorageError):
                recovery.reconcile_iteration(control,pins,{"state_root":str(state)},token)
            control.helper_args.assert_not_called()

if __name__ == "__main__":
    unittest.main()
