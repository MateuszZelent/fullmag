"""Interpreted launcher admission regressions; no Docker/native execution."""
import copy
import hashlib
import json
import tempfile
import subprocess
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import launch_accepted_closed_loop_runtime as gate


class Admission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = "sha256:" + "a" * 64
        self.command = ["-i", "/usr/bin/python3", "/probe/input/driver"]
        self.mounts = [(str(self.root), "/probe/input", True)]
        self.observed = {
            "Image": self.image,
            "Config": {"User": "65532:65532", "Entrypoint": ["/usr/bin/env"],
                       "Cmd": self.command, "WorkingDir": gate.PROJECT,
                       "Env": [key + "=" for key in gate.LOADER_ENV]},
            "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True,
                           "Privileged": False, "CapAdd": None, "CapDrop": ["ALL"],
                           "PidsLimit": 256, "NanoCpus": 2000000000,
                           "Memory": 4 << 30, "MemorySwap": 4 << 30,
                           "PortBindings": {}, "Devices": [], "DeviceRequests": None,
                           "RestartPolicy": {"Name": "no"}, "SecurityOpt": ["no-new-privileges:true"],
                           "Binds": [str(self.root) + ":/probe/input:ro"], "Tmpfs": {"/tmp": "rw,nosuid,nodev,noexec,size=64m,mode=1777"}},
            "Mounts": [{"Type": "bind", "Destination": "/probe/input", "RW": False}]}

    def test_created_container_policy(self):
        gate.attest(self.observed, self.image, self.command, self.mounts)
        for section, key, replacement in [
                ("HostConfig", "NetworkMode", "bridge"),
                ("HostConfig", "ReadonlyRootfs", False),
                ("HostConfig", "CapAdd", ["SYS_ADMIN"]),
                ("HostConfig", "PidsLimit", 0),
                ("HostConfig", "Memory", 0),
                ("HostConfig", "NanoCpus", 0),
                ("HostConfig", "PortBindings", {"80/tcp": [{}]}),
                ("HostConfig", "Binds", ["/:/probe/input:ro"]),
                ("Config", "User", "0"),
                ("Config", "Entrypoint", ["bash"])]:
            with self.subTest(key=key):
                bad = copy.deepcopy(self.observed)
                bad[section][key] = replacement
                with self.assertRaises(ValueError):
                    gate.attest(bad, self.image, self.command, self.mounts)
        bad = copy.deepcopy(self.observed)
        bad["Mounts"].append({"Destination": "/var/run/docker.sock", "RW": True})
        with self.assertRaises(ValueError):
            gate.attest(bad, self.image, self.command, self.mounts)

    def test_image_config_rejects_implicit_volume_and_preload(self):
        image = {"Id": self.image, "Os": "linux", "Architecture": "amd64", "Config": {"Env": ["PATH=/usr/bin", "RUST_BACKTRACE=1", "NUMPY_EXPERIMENTAL_ARRAY_FUNCTION=1"]}}
        gate.image_admission(image, self.image)
        for key, value in [("Volumes", {"/data": {}}), ("Env", ["LD_PRELOAD=/evil.so"]), ("Env", ["LD_AUDIT=/evil.so"]),
                           ("Env", ["LD_LIBRARY_PATH=/unverified"]),
                           ("Healthcheck", {"Test": ["CMD", "evil"]}), ("OnBuild", ["RUN evil"])]:
            bad = copy.deepcopy(image)
            bad["Config"][key] = value
            with self.assertRaises(ValueError):
                gate.image_admission(bad, self.image)
        for key, value in [("Id", "sha256:" + "b" * 64), ("Os", "windows"), ("Architecture", "arm64")]:
            bad = copy.deepcopy(image)
            bad[key] = value
            with self.assertRaises(ValueError):
                gate.image_admission(bad, self.image)

    def test_image_allows_only_known_library_path_and_refuses_loader_duplicates(self):
        image = {"Id": self.image, "Os": "linux", "Architecture": "amd64",
                 "Config": {"Env": ["LD_LIBRARY_PATH=/opt/fullmag-deps/lib:"]}}
        gate.image_admission(image, self.image)
        for environment in [["LD_LIBRARY_PATH=/another/lib"],
                            ["LD_PRELOAD=/evil.so", "LD_LIBRARY_PATH=/opt/fullmag-deps/lib:"],
                            ["LD_AUDIT=/evil.so", "LD_LIBRARY_PATH=/opt/fullmag-deps/lib:"],
                            ["LD_LIBRARY_PATH=", "LD_LIBRARY_PATH=/opt/fullmag-deps/lib:"],
                            ["LD_PRELOAD=", "LD_PRELOAD="],
                            ["LD_AUDIT=", "LD_AUDIT="], None, ["LD_LIBRARY_PATH"], [None]]:
            with self.subTest(environment=environment):
                bad = copy.deepcopy(image)
                bad["Config"]["Env"] = environment
                with self.assertRaises(ValueError):
                    gate.image_admission(bad, self.image)

    def test_created_loader_environment_must_be_present_empty_and_unique(self):
        gate.attest(self.observed, self.image, self.command, self.mounts)
        for key in gate.LOADER_ENV:
            good = [item for item in self.observed["Config"]["Env"] if not item.startswith(key + "=")]
            for environment in [good, good + [key + "=/evil"],
                                good + [key + "=", key + "="],
                                good + [key + "=/evil", key + "="]]:
                with self.subTest(key=key, environment=environment):
                    bad = copy.deepcopy(self.observed)
                    bad["Config"]["Env"] = environment
                    with self.assertRaises(ValueError):
                        gate.attest(bad, self.image, self.command, self.mounts)
        for environment in [None, ["LD_PRELOAD"], [None]]:
            bad = copy.deepcopy(self.observed)
            bad["Config"]["Env"] = environment
            with self.assertRaises(ValueError):
                gate.attest(bad, self.image, self.command, self.mounts)

    def test_bad_request_never_invokes_docker(self):
        path = self.root / "request.json"
        path.write_bytes(b'{}')
        with patch.object(gate, "docker") as docker:
            for digest in ["0" * 64, hashlib.sha256(b'{}').hexdigest()]:
                with self.assertRaises(ValueError):
                    gate.launch(path, digest)
            docker.assert_not_called()

    def test_json_rejects_duplicates_nonfinite_and_size(self):
        path = self.root / "record.json"
        for raw in [b'{"a":1,"a":2}', b'{"a":NaN}', b'\xff']:
            path.write_bytes(raw)
            with self.assertRaises(ValueError):
                gate.json_file(path)
        path.write_bytes(b'{}')
        with self.assertRaises(ValueError):
            gate.json_file(path, limit=1)

    def test_bounded_handle_read_and_copy_refuse_growth_or_replacement(self):
        path = self.root / "bytes"
        path.write_bytes(b"abcd")
        with self.assertRaises(ValueError):
            gate.bounded_bytes(path, 3)
        self.assertEqual(gate.bounded_bytes(path, 4), b"abcd")
        expected = hashlib.sha256(b"abcd").hexdigest()
        gate.bounded_copy(path, self.root / "copy", expected, 4, limit=4)
        self.assertEqual((self.root / "copy").read_bytes(), b"abcd")
        path.write_bytes(b"abcde")
        with self.assertRaises(ValueError):
            gate.bounded_copy(path, self.root / "oversized", expected, 4, limit=4)
        path.write_bytes(b"wxyz")
        with self.assertRaises(ValueError):
            gate.bounded_copy(path, self.root / "replaced", expected, 4, limit=4)
        original_identity = gate.file_identity
        seen = []
        def changed_identity(info):
            seen.append(info)
            value = original_identity(info)
            return value if len(seen) == 1 else (*value[:-1], value[-1] + 1)
        with patch.object(gate, "file_identity", side_effect=changed_identity):
            with self.assertRaises(ValueError):
                gate.bounded_bytes(path, 4)
    def test_symlinks_are_refused_if_supported(self):
        target = self.root / "target"
        target.write_bytes(b'x')
        link = self.root / "link"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("Host has no symlink privilege")
        with self.assertRaises(ValueError):
            gate.path_checked(link)

    def test_timeout_retains_only_exact_owned_container(self):
        storage = self.root / "storage"
        storage.mkdir()
        capsule = storage / "capsule"
        capsule.mkdir()
        build = storage / "runs" / "job"
        build.mkdir(parents=True)
        (build / "trusted").mkdir()
        context = {"job_id": "job", "source_digest": "d" * 64, "image_digest": self.image, "profile": "fem-cpu-release"}
        gate.save(build / "trusted/context.json", context)
        gate.save(build / "receipt.json", {**context, "state": "succeeded", "phase": "terminal", "exit_code": 0,
                  "trusted_hashes": {"context.json": gate.sha(build / "trusted/context.json")}})
        output = storage / "builds" / "wt" / "fresh"
        request = {"schema": gate.SCHEMA, "repo_root": str(self.root),
                   "source_capsule": str(capsule), "managed_build_run_root": str(build),
                   "output_root": str(output), "image": self.image,
                   "commit": "b" * 40, "snapshot": "c" * 64,
                   "source_digest": "d" * 64, "solve_timeout_seconds": 1}
        for name in ("driver", "project", "execution_profile", "resources"):
            path = capsule / "tree/scripts/verify_accepted_closed_loop_runtime.py" if name == "driver" else self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic input; never executed")
            request[name] = {"path": str(path), "sha256": gate.sha(path)}
        gate.save(capsule / "manifest.json", {"files": [{"path": "scripts/verify_accepted_closed_loop_runtime.py",
                  "sha256": request["driver"]["sha256"], "size": Path(request["driver"]["path"]).stat().st_size}]})
        request_path = self.root / "request.json"
        gate.save(request_path, request)
        cid = "e" * 64
        calls = []
        def control(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("image", "inspect"):
                return json.dumps([{"Id": self.image, "Os": "linux", "Architecture": "amd64", "Config": {}}])
            if args[0] == "create":
                Path(args[args.index("--cidfile") + 1]).write_text(cid, encoding="ascii")
                return cid
            if args[0] == "wait":
                raise subprocess.TimeoutExpired("synthetic Docker wait", kwargs["timeout"])
            return ""
        layout = {"storage_root": str(storage), "worktree_id": "wt"}
        modules = {
            "fullmag_storage": types.SimpleNamespace(resolve_layout=lambda repo: layout),
            "managed_fem_runtime_package": types.SimpleNamespace(load_package=lambda *args:
                ({}, {"managed_package": {"source_digest": "d" * 64, "image_digest": self.image}}, {}, None))}
        frozen = types.SimpleNamespace(verify_source=lambda *args: None)
        with patch.dict("sys.modules", modules), patch.object(gate, "frozen_source", return_value=frozen), \
                patch.object(gate, "docker", side_effect=control), \
                patch.object(gate, "inspect_owned", return_value={"State": {"Running": True}}), \
                patch.object(gate, "attest"):
            original_driver = request["driver"]["path"]
            forged = self.root / "caller-driver.py"
            forged.write_bytes(Path(original_driver).read_bytes())
            request["driver"]["path"] = str(forged)
            gate.save(request_path, request)
            with self.assertRaisesRegex(ValueError, "exact verified capsule entry"):
                gate.launch(request_path, gate.sha(request_path))
            self.assertEqual(calls, [])
            request["driver"]["path"] = original_driver
            gate.save(request_path, request)
            with self.assertRaises(subprocess.TimeoutExpired):
                gate.launch(request_path, gate.sha(request_path))
        receipt = gate.json_file(output / "terminal-receipt.json")
        self.assertEqual(receipt["container_id"], cid)
        self.assertEqual(receipt["state"], "retained")
        self.assertEqual(receipt["cleanup"], "retained-running-no-stop")
        self.assertFalse(receipt["runtime_verified"])
        self.assertFalse(any(call[0] in {"rm", "stop", "kill", "pull", "build"} for call in calls))
        create = next(call for call in calls if call[0] == "create")
        self.assertIn("--pull=never", create)
        environment = [create[index + 1] for index, value in enumerate(create) if value == "--env"]
        self.assertEqual(environment, [key + "=" for key in gate.LOADER_ENV])
        self.assertIn(gate.KEEPER, create)
        self.assertIn("--project-sha256", create)
        self.assertFalse((output / "proof" / "run").exists())
        compile(gate.KEEPER, "synthetic-keeper-parse-only", "exec")
    def test_owned_id_must_be_full_and_owner_exact(self):
        with patch.object(gate, "docker") as docker:
            with self.assertRaises(ValueError):
                gate.inspect_owned("abc", "owner")
            docker.assert_not_called()
            docker.return_value = json.dumps([{"Id": "a" * 64, "Config": {"Labels": {gate.OWNER: "other"}}}])
            with self.assertRaises(ValueError):
                gate.inspect_owned("a" * 64, "owner")


if __name__ == "__main__":
    unittest.main()
