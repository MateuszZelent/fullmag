"""Interpreted admission regressions for the offline BORIS context."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from local_runner import boris_toolchain as b


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_members_refuse_escape_and_normalization(self):
        (self.root/"good").write_bytes(b"abc")
        self.assertEqual(b.member(self.root, "good"), self.root/"good")
        for name in ("../good", "/good", "a/../good", "a//good", "C:good", "a\\good", "./good"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                b.member(self.root, name)

    def test_duplicate_json_and_tamper(self):
        path = self.root/"record.json"
        path.write_bytes(b'{"a":1,"a":2}')
        with self.assertRaises(ValueError):
            b.load(path)
        path.write_bytes(b"data")
        with self.assertRaises(ValueError):
            b.check_file(self.root, dict(path="record.json", size=4, sha256="0"*64))

    def test_symlink_refusal(self):
        path = self.root/"real"
        path.write_bytes(b"data")
        try:
            (self.root/"link").symlink_to(path)
        except OSError:
            self.skipTest("host does not allow creating test symlinks")
        with self.assertRaises(ValueError):
            b.member(self.root, "link")

    def fixture(self):
        packages = [dict(name=n, version="1", depends="libc6 (>= 1)", pre_depends="") for n in b.REQUESTED]
        graph = [dict(package=n, field="depends", requirement="libc6 (>= 1)", selected_provider=dict(owner="base", provider="libc6", version="2")) for n in b.REQUESTED]
        return dict(downloaded_packages=packages, dependency_graph=graph), [dict(name="libc6", version="2")]

    def test_dependency_closure_and_base_upgrade(self):
        lock, base = self.fixture()
        self.assertEqual(len(b.dependency_selection(lock, base)), 3)
        with self.assertRaises(ValueError):
            b.dependency_selection(lock, base+[dict(name=b.REQUESTED[0], version="0")])
        lock["dependency_graph"].pop()
        with self.assertRaises(ValueError):
            b.dependency_selection(lock, base)

    def test_apt_python_forbidden(self):
        lock, base = self.fixture()
        lock["downloaded_packages"].append(dict(name="python3-matplotlib", version="1", depends="", pre_depends=""))
        lock["downloaded_packages"][0]["depends"] = "python3-matplotlib"
        lock["dependency_graph"][0].update(requirement="python3-matplotlib", selected_provider=dict(owner="bundle", provider="python3-matplotlib", version="1"))
        with self.assertRaisesRegex(ValueError, "Python stack"):
            b.dependency_selection(lock, base)

    def test_simulation_checks_actual_transaction(self):
        selected = [dict(name="libx", version="1")]
        b.admit_simulation("Inst libx (1 Ubuntu [amd64])\nConf libx (1)", selected)
        for output in ("Inst libx [0] (1)", "Remv unrelated [1]", "Inst libx (2)", "Inst extra (1)\nInst libx (1)", "Inst libx (1)\nInst libx (1)", ""):
            with self.subTest(output=output), self.assertRaises(ValueError):
                b.admit_simulation(output, selected)

    def wheel(self, members):
        (self.root/"wheels").mkdir(exist_ok=True)
        path = self.root/"wheels/test.whl"
        with zipfile.ZipFile(path, "w") as archive:
            for name in members:
                archive.writestr(name, b"data")
        return dict(filename="test.whl", size=path.stat().st_size, sha256=b.sha(path))

    def test_wheel_escape_collision_and_numpy_refused(self):
        for members in (["../escape"], ["numpy/__init__.py"], ["a", "a/b"], ["safe.py", "safe.py"]):
            with self.subTest(members=members), self.assertRaises(ValueError):
                b.wheel_members(self.root, [self.wheel(members)])
        self.assertEqual(b.wheel_members(self.root, [self.wheel(["safe.py"])]), {"safe.py"})

    def test_wheel_symlink_refused(self):
        (self.root/"wheels").mkdir()
        path = self.root/"wheels/link.whl"
        entry = zipfile.ZipInfo("link")
        entry.create_system = 3
        entry.external_attr = (0o120777 << 16)
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(entry, "../outside")
        with self.assertRaisesRegex(ValueError, "unsafe"):
            b.wheel_members(self.root, [dict(filename=path.name, size=path.stat().st_size, sha256=b.sha(path))])

    def test_invalid_terminal_refused_before_copy(self):
        image = "sha256:"+"1"*64
        (self.root/"packages.lock.json").write_bytes(b.canonical(dict(schema="fullmag.boris.dependency-bundle.v1", base_image_id=image, architecture="amd64", apt_no_upgrade=True, apt_no_install_recommends=True)))
        (self.root/"terminal-receipt.json").write_bytes(b.canonical(dict(status="PREPARED_DOWNLOAD_ONLY", lock_sha256="0"*64)))
        (self.root/"download-source-freeze.json").write_bytes(b"{}")
        with self.assertRaisesRegex(ValueError, "terminal"):
            b.validate_bundle(self.root, image)

    def test_build_source_mismatch_refused_before_docker(self):
        context = self.root/"tmp"/"boris-toolchain-test"
        context.mkdir(parents=True)
        for name in ("packages.lock.json", "download-source-freeze.json"):
            (context/"bundle").mkdir(exist_ok=True)
            (context/"bundle"/name).write_bytes(b"{}")
        (context/"wheel-bundle").mkdir()
        (context/"wheel-bundle/manifest.json").write_bytes(b"{}")
        (context/"context.json").write_bytes(b"{}")
        manifest = dict(base_image_id="sha256:"+"1"*64, selected_packages=[],
                        lock_sha256="pin", download_freeze_sha256="pin",
                        wheel_manifest_sha256="pin", context_source_sha256={})
        with patch("fullmag_storage.resolve_layout", return_value=dict(storage_root=str(self.root))), patch.object(b, "load", return_value=manifest), patch.object(b, "sha", return_value="pin"), patch.object(b, "validate_bundle", return_value=({}, {}, [])), patch.object(b, "validate_wheels"), patch.object(b.subprocess, "check_output") as docker:
            with self.assertRaisesRegex(ValueError, "reviewed helper"):
                b.build_image(self.root, context, "fullmag/boris-toolchain:test")
            docker.assert_not_called()

    def test_build_tag_cannot_select_shared_image(self):
        context = self.root/"tmp"/"boris-toolchain-test"
        context.mkdir(parents=True)
        with patch("fullmag_storage.resolve_layout", return_value=dict(storage_root=str(self.root))), patch.object(b.subprocess, "check_output") as docker:
            with self.assertRaisesRegex(ValueError, "context/tag"):
                b.build_image(self.root, context, "fullmag/shared:current")
            docker.assert_not_called()

    def test_preflight_refuses_missing_matplotlib(self):
        import types
        numpy = types.SimpleNamespace(__version__="2.2.6", __file__=str(self.root/"numpy.py"))
        (self.root/"numpy.py").write_bytes(b"numpy")
        proof = dict(download_freeze_sha256="pin", lock_sha256="pin", wheel_manifest_sha256="pin", numpy_before=dict(version="2.2.6", path=numpy.__file__, sha256="pin"), modules=[dict(name="matplotlib", version="3.8.4")])
        with patch.object(b.shutil, "which", return_value="tool"), patch.object(b.subprocess, "check_output", side_effect=[b"-I"+str(self.root).encode(), b"-lpython3.10", str(self.root/"lib").encode(), str(self.root/"lib").encode(), str(self.root/"lib").encode()]), patch.object(b.subprocess, "run"), patch.object(b, "load", return_value=proof), patch.object(b, "sha", return_value="pin"), patch.dict("sys.modules", numpy=numpy), patch.object(b.sys, "version", "3.10.12"), patch.object(b.importlib, "import_module", side_effect=ModuleNotFoundError("matplotlib")):
            (self.root/"Python.h").write_bytes(b"header")
            (self.root/"lib").write_bytes(b"library")
            with self.assertRaises(ModuleNotFoundError):
                b.runtime_preflight(self.root, self.root/"output")
        self.assertFalse((self.root/"runtime-preflight.json").exists())


if __name__ == "__main__":
    unittest.main()
