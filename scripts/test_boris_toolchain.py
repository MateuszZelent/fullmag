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



class PrefixDebFormatTests(unittest.TestCase):
    def setUp(self):
        import docker_boris_prefix as supplier
        self.supplier = supplier
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def deb(self, rows):
        out = bytearray(b'!<arch>\n')
        for name, data in rows:
            header = ((name + '/').ljust(16) + '0'.ljust(12) + '0'.ljust(6) + '0'.ljust(6)
                      + '100644'.ljust(8) + str(len(data)).ljust(10) + '`\n').encode()
            self.assertEqual(len(header), 60)
            out += header + data + (b'\n' if len(data) % 2 else b'')
        path = self.root/'input.deb';path.write_bytes(out)
        return path

    def tar(self, entries):
        import io, tarfile
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode='w') as archive:
            for entry in entries:
                if isinstance(entry, tuple):
                    info = tarfile.TarInfo(entry[0]);info.size = len(entry[1]);info.mode = 0o644
                    archive.addfile(info, io.BytesIO(entry[1]))
                else: archive.addfile(entry)
        return out.getvalue()

    def test_legacy_tar_gzip_xz_and_zstd_members_keep_exact_order_and_no_extras(self):
        import gzip, lzma
        from subprocess import CompletedProcess
        payload = self.tar([('usr/include/tbb.h', b'header')])
        for suffix, data in (('', payload), ('.gz', gzip.compress(payload)), ('.xz', lzma.compress(payload)),
                             ('.zst', b'\x28\xb5\x2f\xfdsynthetic-frame')):
            with self.subTest(suffix=suffix):
                path = self.deb([('debian-binary', b'2.0\n'), ('control.tar' + suffix, b'not executed'), ('data.tar' + suffix, data)])
                calls = []
                def decode(p):
                    calls.append(p);return CompletedProcess(['/usr/bin/dpkg-deb', '--fsys-tarfile', str(p)], 0, payload, b'')
                self.assertEqual(self.supplier.deb_data(path, decode), payload if suffix == '.zst' else data)
                self.assertEqual(calls, [path] if suffix == '.zst' else [])
        for rows in (
            [('debian-binary', b'2.0\n'), ('control.tar.zst', b'c'), ('data.tar.zst', b'd'), ('_extra', b'x')],
            [('debian-binary', b'2.0\n'), ('data.tar.zst', b'd'), ('control.tar.zst', b'c')],
            [('debian-binary', b'2.0\n'), ('control.tar.zst', b'c'), ('data.tar.zst', b'd'), ('data.tar', b'd')],
        ):
            path = self.deb(rows)
            with patch('subprocess.run') as external, self.assertRaises(ValueError): self.supplier.deb_data(path)
            external.assert_not_called()

    def test_decoder_requires_successful_completed_binary_output_and_bound(self):
        from subprocess import CompletedProcess
        path = self.deb([('debian-binary', b'2.0\n'), ('control.tar.zst', b'c'), ('data.tar.zst', b'd')])
        with self.assertRaisesRegex(ValueError, 'pinned bounded decoder'): self.supplier.deb_data(path)
        for value in (b'raw-only', CompletedProcess([], 1, b'tar', b'failed'), CompletedProcess([], 0, 'decoded text', '')):
            with self.subTest(value=value), self.assertRaises(ValueError): self.supplier.deb_data(path, lambda _: value)
        with patch.object(self.supplier, 'MAX_DEB_TAR_BYTES', 2), self.assertRaisesRegex(ValueError, 'tar byte bound'):
            self.supplier.deb_data(path, lambda _: CompletedProcess([], 0, b'abc', b''))
        def tamper(p):
            p.write_bytes(p.read_bytes() + b'changed')
            return CompletedProcess([], 0, b'tar', b'')
        with self.assertRaisesRegex(ValueError, 'changed during decode'): self.supplier.deb_data(path, tamper)

    def test_rejects_truncated_ar_duplicate_names_padding_and_deb_size(self):
        good = [('debian-binary', b'2.0\n'), ('control.tar.zst', b'c'), ('data.tar.zst', b'd')]
        path = self.deb(good);raw = path.read_bytes()
        for changed in (raw[:-1], raw[:10], raw.replace(b'c\n', b'cX', 1)):
            path.write_bytes(changed)
            with self.assertRaises(ValueError): self.supplier.deb_data(path)
        path = self.deb(good + [('data.tar.zst', b'd')])
        with self.assertRaises(ValueError): self.supplier.deb_data(path)
        path = self.deb(good)
        with patch.object(self.supplier, 'MAX_DEB_BYTES', 5), self.assertRaises(ValueError): self.supplier.deb_data(path)

    def test_zstd_tar_uses_existing_manual_extractor_and_internal_symlinks(self):
        import tarfile
        from subprocess import CompletedProcess
        link = tarfile.TarInfo('usr/lib/libtbb.so');link.type = tarfile.SYMTYPE;link.linkname = 'libtbb.so.1'
        payload = self.tar([('usr/lib/libtbb.so.1', b'ELF-payload'), link])
        path = self.deb([('debian-binary', b'2.0\n'), ('control.tar.zst', b'never execute'), ('data.tar.zst', b'zstd')])
        target = self.root/'sdk'
        rows = self.supplier.unpack_debs([path], target, lambda _: CompletedProcess([], 0, payload, b''))
        self.assertEqual((target/'usr/lib/libtbb.so').read_bytes(), b'ELF-payload')
        self.assertEqual(len(rows), 2)
        self.assertFalse((target/'DEBIAN').exists())

    def test_decoder_does_not_bypass_tar_escape_hardlink_privilege_or_collisions(self):
        import tarfile
        from subprocess import CompletedProcess
        link = tarfile.TarInfo('usr/lib/escape');link.type = tarfile.SYMTYPE;link.linkname = '../../../../outside'
        absolute = tarfile.TarInfo('usr/lib/absolute');absolute.type = tarfile.SYMTYPE;absolute.linkname = '/outside'
        hard = tarfile.TarInfo('hard');hard.type = tarfile.LNKTYPE;hard.linkname = 'safe'
        privileged = tarfile.TarInfo('setuid');privileged.size = 0;privileged.mode = 0o4755
        for number, entries in enumerate((
            [('../outside', b'x')], [('/absolute', b'x')], [('a//b', b'x')], [link], [absolute], [hard],
            [privileged], [('same', b'one'), ('same', b'two')], [('parent', b'file'), ('parent/child', b'x')],
        )):
            payload = self.tar(entries)
            path = self.deb([('debian-binary', b'2.0\n'), ('control.tar.zst', b'c'), ('data.tar.zst', b'd')])
            with self.subTest(entries=entries), self.assertRaises((ValueError, OSError)):
                self.supplier.unpack_debs([path], self.root/('sdk-' + str(number)),
                    lambda _: CompletedProcess([], 0, payload, b''))
        self.assertFalse((self.root/'outside').exists())

    def test_tar_expansion_and_all_member_count_remain_bounded(self):
        import tarfile
        from subprocess import CompletedProcess
        large = tarfile.TarInfo('too-large');large.size = 256*1024**2 + 1
        payload = large.tobuf() + bytes(1024)
        path = self.deb([('debian-binary', b'2.0\n'), ('control.tar.zst', b'c'), ('data.tar.zst', b'd')])
        with self.assertRaisesRegex(ValueError, 'expansion bound'):
            self.supplier.unpack_debs([path], self.root/'large', lambda _: CompletedProcess([], 0, payload, b''))
        directories = [tarfile.TarInfo(name) for name in ('a', 'b', 'c')]
        for entry in directories: entry.type = tarfile.DIRTYPE
        payload = self.tar(directories)
        with patch.object(self.supplier, 'MAX_FILES', 2), self.assertRaisesRegex(ValueError, 'member count'):
            self.supplier.unpack_debs([path], self.root/'many', lambda _: CompletedProcess([], 0, payload, b''))



    def prefix_until_sdk(self, *, tampered_decoder=False):
        import contextlib
        from subprocess import CompletedProcess
        from types import SimpleNamespace
        supplier = self.supplier
        prefix = self.root/'prefix';prefix.mkdir()
        artifacts = self.root/'artifacts';artifacts.mkdir()
        payload = {'schema': 'fullmag.boris.prefix-payload.v1', 'retained_asset_image_id': supplier.ASSET_IMAGE,
                   'files': [], 'files_sha256': hashlib.sha256(supplier.canonical([])).hexdigest()}
        (prefix/'payload-receipt.json').write_bytes(supplier.canonical(payload))
        bundle = prefix/'toolchain/bundle';bundle.mkdir(parents=True)
        path = self.deb([('debian-binary', b'2.0\n'), ('control.tar.zst', b'never execute'), ('data.tar.zst', b'zstd')])
        (bundle/'input.deb').write_bytes(path.read_bytes())
        decoded = self.tar([('usr/include/tbb.h', b'header')])
        real_sha = supplier.sha
        calls = []
        class AfterSDK(Exception): pass
        def digest(path):
            name = str(path)
            if name in supplier.CURRENT_LIBRARIES: return supplier.CURRENT_LIBRARIES[name]
            if name in supplier.DEB_DECODER_PINS:
                return '0' * 64 if tampered_decoder else supplier.DEB_DECODER_PINS[name]
            if name == '/opt/fullmag-deps/share/fullmag/dependency-versions.json': return 'sdk-before'
            return real_sha(path)
        def run_probe(command, **options):
            calls.append((command, options))
            if command[0] == '/usr/bin/dpkg-deb':
                self.assertEqual(command, ['/usr/bin/dpkg-deb', '--fsys-tarfile', str(bundle/'input.deb')])
                self.assertIs(options['text'], False)
                self.assertIs(options['check'], True)
                self.assertEqual(options['timeout'], 30)
                for name in ('LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT', 'PYTHONPATH', 'PYTHONHOME'):
                    self.assertNotIn(name, options['environment'])
                return CompletedProcess(command, 0, decoded, b'')
            self.assertTrue(options['text'])
            baseline = {'python': {'version': '3.10.12 test', 'pointer_bits': 64}, 'numpy': {'version': '2.2.6'}}
            return CompletedProcess(command, 0, json.dumps(baseline), '')
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(supplier, 'sha', side_effect=digest))
            stack.enter_context(patch.object(supplier, 'inventory', return_value=[]))
            stack.enter_context(patch.object(supplier, 'verify_payload', return_value=(
                SimpleNamespace(member=lambda root, name: root/name), {}, {}, [], {}, [])))
            stack.enter_context(patch.object(supplier, 'tbb_packages', return_value=[{'filename': 'input.deb'}]))
            stack.enter_context(patch.object(supplier, 'unpack_wheels', side_effect=AfterSDK))
            expected = ValueError if tampered_decoder else AfterSDK
            with self.assertRaises(expected):
                supplier.prepare_prefix(prefix, run_probe, artifacts=artifacts,
                    environment={'LD_LIBRARY_PATH': '/foreign', 'LD_PRELOAD': '/foreign',
                                 'LD_AUDIT': '/foreign', 'PYTHONPATH': '/foreign', 'PYTHONHOME': '/foreign'})
        return calls, prefix

    def test_prepare_prefix_wires_fixed_binary_stage_and_pins_without_text_conversion(self):
        calls, prefix = self.prefix_until_sdk()
        self.assertEqual(len(calls), 2)
        self.assertEqual((prefix/'sdk/usr/include/tbb.h').read_bytes(), b'header')
        self.assertFalse((prefix/'receipt.json').exists())

    def test_prepare_prefix_refuses_decoder_pin_before_executing_it(self):
        calls, prefix = self.prefix_until_sdk(tampered_decoder=True)
        self.assertEqual(len(calls), 1)
        self.assertFalse((prefix/'sdk').exists())

    def test_existing_stage_runner_preserves_binary_stdout_reaps_child_and_bounds_log(self):
        import sys, time
        from docker_boris_reference import stage_runner
        for number, bound in enumerate((128, 16)):
            receipt = {'stages': []};artifacts = self.root/('stage-' + str(number));artifacts.mkdir()
            _, run_probe = stage_runner(time.monotonic() + 10, bound, receipt)
            command = [sys.executable, '-B', '-c', 'import sys;sys.stdout.buffer.write(bytes(range(32)))']
            if bound == 128:
                outcome = run_probe(command, workspace=self.root, artifacts=artifacts, environment=dict(os.environ), text=False)
                self.assertEqual(outcome.stdout, bytes(range(32)))
                self.assertEqual(outcome.returncode, 0)
            else:
                with self.assertRaisesRegex(ValueError, 'shared log bound'):
                    run_probe(command, workspace=self.root, artifacts=artifacts, environment=dict(os.environ), text=False)
            self.assertEqual(len(receipt['stages']), 1)
            stage = receipt['stages'][0]
            self.assertIs(stage['child_reaped'], True)
            self.assertLessEqual(sum(stage['log_bytes'].values()), bound)
            self.assertLessEqual(sum(p.stat().st_size for p in (artifacts/'logs').iterdir()), bound)


if __name__ == "__main__":
    unittest.main()
