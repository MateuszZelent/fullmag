import tempfile
import hashlib
import json
import unittest
from unittest.mock import Mock, patch
from contextlib import nullcontext
from pathlib import Path

from local_runner import build_executor as executor


class BuildExecutorTests(unittest.TestCase):
    def test_daemon_mount_identity_survives_json_and_host_platform(self):
        mounts = [{'Type': 'bind', 'Source': '/run/desktop/mnt/host/c/storage/run',
                   'Destination': '/workspace', 'RW': True}]
        identity = executor.mount_identity(mounts)
        self.assertEqual(identity, json.loads(json.dumps(identity)))
        self.assertEqual(identity[0][1], mounts[0]['Source'])

    def test_cpu_mfem_abi_attestation_rejects_missing_or_wrong_prefix(self):
        valid = {
            'mfem_abi': {
                'path': '/opt/fullmag-mfem-cpu/lib/libmfem.so.4.9.0',
                'sha256': 'a' * 64,
            },
            'mfem_cmake_dir': '/opt/fullmag-mfem-cpu/lib/cmake/mfem',
        }
        self.assertTrue(executor.valid_cpu_mfem_abi_attestation(valid))
        self.assertFalse(executor.valid_cpu_mfem_abi_attestation({}))
        self.assertFalse(executor.valid_cpu_mfem_abi_attestation({
            **valid, 'mfem_abi': {
                **valid['mfem_abi'],
                'path': '/opt/fullmag-deps/lib/libmfem.so.4.9.0',
            },
        }))
        self.assertFalse(executor.valid_cpu_mfem_abi_attestation({
            **valid,
            'mfem_cmake_dir': '/opt/fullmag-mfem-cpu/../fullmag-deps/lib/cmake/mfem',
        }))

    def test_cpu_modal_dependency_binding_rejects_mixed_or_incomplete_receipts(self):
        libraries = {name: {'path': '/opt/fullmag-mfem-cpu/lib/lib' + name + '.so',
                            'sha256': 'a' * 64}
                     for name in ('mfem', 'hypre', 'ceed', 'petsc', 'slepc')}
        cmake = {'cpu_dependency_abi': libraries, 'mfem_abi': libraries['mfem']}
        dependency = {}
        for name, module in (('petsc', 'FindPETSc.cmake'), ('slepc', 'FindSLEPc.cmake')):
            dependency.update({name + '_library_path': libraries[name]['path'],
                               name + '_library_realpath': libraries[name]['path'],
                               name + '_pkgconfig_dir': '/opt/fullmag-mfem-cpu/lib/pkgconfig',
                               name + '_find_module_file': '/workspace/backends/fem/cmake/' + module})
        self.assertTrue(executor.valid_cpu_modal_dependency_attestation(cmake, dependency))
        self.assertFalse(executor.valid_cpu_modal_dependency_attestation({}, dependency))
        self.assertFalse(executor.valid_cpu_modal_dependency_attestation(
            {**cmake, 'mfem_abi': None}, dependency))
        self.assertFalse(executor.valid_cpu_modal_dependency_attestation(cmake, {
            **dependency, 'petsc_library_realpath': '/opt/fullmag-deps/lib/libpetsc.so'}))
        self.assertFalse(executor.valid_cpu_modal_dependency_attestation(cmake, {
            **dependency, 'petsc_pkgconfig_dir': '/opt/fullmag-deps/lib/pkgconfig'}))
        for bad_path in ('/opt/fullmag-deps/lib/libpetsc.so',
                         '/opt/fullmag-mfem-cpu/lib/../foreign/libpetsc.so'):
            bad = {**libraries, 'petsc': {**libraries['petsc'], 'path': bad_path}}
            self.assertFalse(executor.valid_cpu_modal_dependency_attestation(
                {**cmake, 'cpu_dependency_abi': bad}, dependency))

    def test_cpu_modal_runtime_requires_explicit_empty_cuda_compatibility(self):
        names = ('cuda_driver_compatibility_paths', 'cuda_driver_compatibility_libraries_preloaded')
        valid = {name: [] for name in names}
        self.assertTrue(executor.valid_cpu_modal_driver_attestation(valid))
        self.assertFalse(executor.valid_cpu_modal_driver_attestation(None))
        for name in names:
            for bad in (None, '', ['/opt/cuda/compat/libcuda.so']):
                self.assertFalse(executor.valid_cpu_modal_driver_attestation({**valid, name: bad}))
            self.assertFalse(executor.valid_cpu_modal_driver_attestation({key: value for key, value in valid.items() if key != name}))

    def test_runtime_v2_receipt_contract_disables_cuda_and_fem_gpu(self):
        v1 = executor.RUNTIME_PROFILE_CONTRACTS['fem-cpu-slepc-runtime-v1']['cmake_options']
        v2 = executor.RUNTIME_PROFILE_CONTRACTS['fem-cpu-slepc-runtime-v2']['cmake_options']
        self.assertEqual(v1['FULLMAG_ENABLE_CUDA'], 'ON')
        self.assertEqual(v1['FULLMAG_ENABLE_FEM_GPU'], 'ON')
        self.assertEqual(v2['FULLMAG_ENABLE_CUDA'], 'OFF')
        self.assertEqual(v2['FULLMAG_ENABLE_FEM_GPU'], 'OFF')
        self.assertEqual(v2['FULLMAG_USE_MFEM_STACK'], 'ON')
        self.assertEqual(v2['FULLMAG_FEM_WITH_SLEPC'], 'ON')

    def test_extended_profile_registry_keeps_producer_output_contracts(self):
        from local_runner import build_entrypoint as entrypoint

        for profile_name, profile in entrypoint.PROFILES.items():
            output_names = (
                entrypoint.HEADLESS_REQUIRED_OUTPUTS
                if profile.build_runtime or profile.runtime_only
                else entrypoint.required_outputs_for_profile(profile_name)
            )
            expected = {
                'outputs/.fullmag/local/' + name for name in output_names
            }
            with self.subTest(profile=profile_name):
                self.assertEqual(
                    executor.required_output_artifact_paths(profile_name),
                    expected,
                )
                self.assertEqual(
                    entrypoint.required_outputs_for_profile(profile_name),
                    (
                        entrypoint.REQUIRED_OUTPUTS
                        if profile_name in entrypoint.RELEASE_PROFILE_NAMES
                        else entrypoint.BASE_REQUIRED_OUTPUTS
                    ),
                )
        self.assertNotIn(
            'outputs/.fullmag/local/web/index.html',
            executor.required_output_artifact_paths('fem-cpu-slepc-runtime-v2'),
        )

    def _write_contract_receipt(self, root, profile):
        from local_runner import build_entrypoint as entrypoint
        from local_runner.worker_entrypoint import canonical

        contract = executor.PROFILE_CONTRACTS[profile]
        image = 'sha256:' + 'e' * 64
        native = {
            'head_commit_full': 'c' * 40,
            'source_snapshot_sha256': 'd' * 64,
            'source_snapshot_dirty': False,
        }
        job = {
            'job_id': 'a' * 32,
            'source_digest': 'b' * 64,
            'profile': profile,
            'payload': {'native_source_identity': native},
        }
        journal = {'image_digest': image}
        artifacts = []

        def add_artifact(relative, data):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            artifacts.append({
                'path': relative,
                'size': len(data),
                'sha256': hashlib.sha256(data).hexdigest(),
            })

        for relative in entrypoint.required_outputs_for_profile(profile):
            data = (
                entrypoint.EXPECTED_BUILD_MARKER[profile].encode('utf-8') + b'\n'
                if relative == 'launcher-build-mode'
                else b'build-output'
            )
            add_artifact('outputs/.fullmag/local/' + relative, data)
        for scenario in contract['scenarios']:
            data = json.dumps({
                'schema': contract['schema'],
                'scenario': scenario,
                'status': 'pass',
            }).encode('utf-8')
            add_artifact(f'contracts/{scenario}/result.json', data)

        receipt = {
            **job,
            'image_digest': image,
            'native_source_identity': native,
            'native_source_identity_sha256': hashlib.sha256(canonical(native)).hexdigest(),
            'qualification': 'NOT VERIFIED',
            'state': 'succeeded',
            'contract_scenarios': list(contract['scenarios']),
            'contract_schema': contract['schema'],
            'stages': [
                {'name': 'contract-' + scenario, 'exit_code': 0}
                for scenario in contract['scenarios']
            ],
            'artifacts': artifacts,
        }
        (root / 'build-receipt.json').write_text(
            json.dumps(receipt), encoding='utf-8'
        )
        return job, journal, receipt

    def test_contract_receipts_require_all_producer_outputs(self):
        from local_runner import build_entrypoint as entrypoint

        profiles = (
            'fem-cpu-current-contracts-v1',
            'fem-gpu-current-contracts-v1',
        )
        for profile in profiles:
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                job, journal, receipt = self._write_contract_receipt(root, profile)
                validated = executor.validate_build_receipt(root, job, journal)
                self.assertEqual(validated['state'], 'succeeded')

                missing_file_relative = (
                    'outputs/.fullmag/local/' + entrypoint.BASE_REQUIRED_OUTPUTS[0]
                )
                missing_file = root / missing_file_relative
                missing_file.unlink()
                with self.assertRaisesRegex(ValueError, 'Artifact size mismatch'):
                    executor.validate_build_receipt(root, job, journal)
                missing_file.write_bytes(b'build-output')

                missing_entry_relative = (
                    'outputs/.fullmag/local/' + entrypoint.BASE_REQUIRED_OUTPUTS[1]
                )
                receipt['artifacts'] = [
                    entry for entry in receipt['artifacts']
                    if entry['path'] != missing_entry_relative
                ]
                (root / 'build-receipt.json').write_text(
                    json.dumps(receipt), encoding='utf-8'
                )
                with self.assertRaisesRegex(ValueError, 'Required build outputs missing'):
                    executor.validate_build_receipt(root, job, journal)

                job, journal, receipt = self._write_contract_receipt(root, profile)
                self.assertEqual(
                    executor.validate_build_receipt(root, job, journal)['state'],
                    'succeeded',
                )

    def _write_release_receipt(self, root, *, profile='fem-cpu-release', empty=None, accepted=True):
        outputs = ['bin/fullmag-bin', 'bin/fullmag-api', '_fullmag_core.so',
                   'web/index.html', 'launcher-build-mode']
        if accepted:
            outputs += ['bin/' + name for name in (
                'fullmag-api-accepted-worker', 'fullmag-api-accepted-supervisor',
                'fullmag-api-accepted-scheduler', 'fullmag-runtime-service', 'fullmag-api-resource-pool',
                'fullmag-api-accepted-fem-preparer',
                'fullmag-api-accepted-fem-preparation-supervisor',
                'fullmag-api-accepted-fem-preparation-scheduler',
                'fullmag-api-preparation-resource-pool', 'fullmag-api-preparation-retry')]
        native = {'head_commit_full': 'c' * 40, 'source_snapshot_sha256': 'd' * 64,
                  'source_snapshot_dirty': False}
        job = dict(job_id='a' * 32, source_digest='b' * 64, profile=profile,
                   payload={'native_source_identity': native})
        journal = {'image_digest': 'sha256:' + 'e' * 64}
        entries = []
        for relative in outputs:
            path = root / 'outputs/.fullmag/local' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            data = b'' if relative == empty else b'production-artifact'
            path.write_bytes(data)
            entries.append({'path': path.relative_to(root).as_posix(), 'size': len(data),
                            'sha256': hashlib.sha256(data).hexdigest()})
        from local_runner.worker_entrypoint import canonical
        receipt = {**job, 'state': 'succeeded', 'qualification': 'NOT VERIFIED',
                   'image_digest': journal['image_digest'], 'native_source_identity': native,
                   'native_source_identity_sha256': hashlib.sha256(canonical(native)).hexdigest(),
                   'artifacts': entries, 'stages': [{'name': name, 'exit_code': 0} for name in
                       ('native-build', 'frontend-dependencies', 'frontend-build')]}
        (root / 'build-receipt.json').write_text(json.dumps(receipt))
        return job, journal

    def test_release_receipts_reject_missing_accepted_runtime(self):
        for profile in ('fem-cpu-release', 'fem-gpu-release', 'fdm-cpu-release'):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                job, journal = self._write_release_receipt(root, profile=profile, accepted=False)
                with self.assertRaisesRegex(ValueError, 'Required build outputs missing'):
                    executor.validate_build_receipt(root, job, journal)

    def test_release_receipts_require_each_accepted_binary_record(self):
        for profile in ('fem-cpu-release', 'fem-gpu-release', 'fdm-cpu-release'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                job, journal = self._write_release_receipt(root, profile=profile)
                path = root / 'build-receipt.json'
                receipt = json.loads(path.read_text())
                binaries = [entry for entry in receipt['artifacts']
                            if '/bin/fullmag-api-' in entry['path']
                            or entry['path'].endswith('/bin/fullmag-runtime-service')]
                self.assertEqual(len(binaries), 10)
                for binary in binaries:
                    with self.subTest(profile=profile, binary=binary['path']):
                        missing = {**receipt, 'artifacts': [entry for entry in receipt['artifacts']
                                                          if entry != binary]}
                        path.write_text(json.dumps(missing))
                        with self.assertRaisesRegex(ValueError, 'Required build outputs missing'):
                            executor.validate_build_receipt(root, job, journal)

    def test_required_empty_artifact_is_rejected_even_with_matching_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            job, journal = self._write_release_receipt(root, empty='bin/fullmag-bin')
            with self.assertRaisesRegex(ValueError, 'Required build output is empty'):
                executor.validate_build_receipt(root, job, journal)

    def test_complete_release_receipts_and_empty_optional_logs_are_accepted(self):
        for profile in ('fem-cpu-release', 'fem-gpu-release', 'fdm-cpu-release'):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                job, journal = self._write_release_receipt(root, profile=profile)
                log = root / 'stderr.log'
                log.write_bytes(b'')
                path = root / 'build-receipt.json'
                receipt = json.loads(path.read_text())
                receipt['artifacts'].append({'path': 'stderr.log', 'size': 0,
                                            'sha256': hashlib.sha256(b'').hexdigest()})
                path.write_text(json.dumps(receipt))
                self.assertEqual(executor.validate_build_receipt(root, job, journal)['state'], 'succeeded')

    def test_mutable_caches_do_not_reuse_legacy_root_owned_trees(self):
        root = Path('/storage')
        paths = executor.dependency_cache_paths(root, 'fem-cpu-release')
        legacy = root / 'cache' / 'windows' / 'fem-cpu'
        self.assertEqual(legacy / 'runner-uid-65532' / 'cargo', paths['cargo'])
        self.assertEqual(legacy / 'runner-uid-65532' / 'pnpm', paths['pnpm'])
        self.assertEqual(legacy / 'rustup', paths['rustup'])
        self.assertNotEqual(paths, executor.dependency_cache_paths(root, 'fem-gpu-release'))
        with self.assertRaises(ValueError):
            executor.dependency_cache_paths(root, '../untrusted')

    def test_new_cache_is_worker_owned_but_existing_cache_is_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cache = root / 'cache'
            with patch.object(executor.os, 'chown', create=True) as chown:
                executor.prepare_cache_directory(cache, root)
                chown.assert_called_once_with(cache, 65532, 65532, follow_symlinks=False)
                chown.reset_mock()
                (cache / 'keep').write_text('existing')
                executor.prepare_cache_directory(cache, root)
                chown.assert_not_called()
                self.assertEqual('existing', (cache / 'keep').read_text())

    def test_empty_private_mount_is_assigned_to_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'execution'
            target.mkdir()
            with patch.object(executor.os, 'chown', create=True) as chown:
                executor.prepare_worker_directory(target, root)
            chown.assert_called_once_with(target, 65532, 65532, follow_symlinks=False)

    def test_existing_foreign_content_is_not_reowned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'execution'
            target.mkdir()
            (target / 'keep').write_text('preserve')
            with patch.object(executor.os, 'chown', create=True) as chown:
                with self.assertRaisesRegex(ValueError, 'nonempty'):
                    executor.prepare_worker_directory(target, root)
            chown.assert_not_called()
            self.assertEqual('preserve', (target / 'keep').read_text())

    def test_disk_pressure_preserves_queued_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            queue = Mock()
            queue.active.return_value = []
            queue.next_queued.return_value = {'job_id': 'a' * 32}
            on_claim = Mock()
            with patch.object(executor, 'JobQueue', return_value=queue), \
                 patch.object(executor, 'file_lock', return_value=nullcontext()), \
                 patch.object(executor.shutil, 'disk_usage', return_value=Mock(free=1024)):
                result = executor.execute_build({'storage_root': str(root), 'container_coordinator': True}, owner='test', on_claim=on_claim)
            self.assertEqual('waiting_for_disk', result['state'])
            queue.claim.assert_not_called()
            on_claim.assert_not_called()

    def test_claim_notification_follows_actual_lease_and_omits_private_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            queue = Mock()
            queue.active.return_value = []
            queue.next_queued.return_value = {'job_id': 'a' * 32}
            claimed = {'job_id': 'a' * 32, 'profile': 'fem-cpu-release',
                       'operation': 'verify-source', 'lease_token': 'private'}
            queue.claim.return_value = claimed
            notifications = []
            def on_claim(record):
                queue.claim.assert_called_once()
                notifications.append(record)
            with patch.object(executor, 'JobQueue', return_value=queue), \
                 patch.object(executor, 'file_lock', return_value=nullcontext()), \
                 patch.object(executor.shutil, 'disk_usage', return_value=Mock(free=16 * 1024**3)):
                with self.assertRaisesRegex(executor.CoordinatorError, 'Expected a build job'):
                    executor.execute_build(
                        {'storage_root': str(root), 'container_coordinator': True},
                        owner='test', call=Mock(return_value=''), on_claim=on_claim,
                        expected_job_id=claimed['job_id'],
                    )
            self.assertEqual([{'job_id': claimed['job_id'], 'profile': claimed['profile']}], notifications)
            queue.finish.assert_called_once_with(claimed['job_id'], 'private', 'blocked', None)

    def test_profiles_are_closed(self):
        with self.assertRaises(ValueError):
            executor.profile_lane('shell-command')

    def test_build_command_has_only_scoped_mounts_and_no_socket(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = {}
            for name in ('source', 'workspace', 'build', 'artifacts', 'trusted', 'cargo', 'rustup', 'pnpm'):
                paths[name] = root / name
                paths[name].mkdir()
            command = executor.build_command('a' * 32, 'b' * 64, 'fem-cpu-release',
                {'image_digest': 'sha256:' + 'c' * 64, 'cpus': 2, 'memory_bytes': 8 * 1024**3}, paths, root)
            self.assertEqual('create', command[0])
            self.assertNotIn('--privileged', command)
            self.assertNotIn('--gpus', command)
            self.assertNotIn('docker.sock', ' '.join(command))
            self.assertIn('type=bind,source=' + str(paths['source']) + ',target=/source,readonly', command)
            self.assertEqual(8, command.count('--mount'))
            modal_command = executor.build_command(
                'a' * 32,
                'b' * 64,
                'fem-cpu-slepc-modal-v1',
                {
                    'image_digest': 'sha256:' + 'c' * 64,
                    'cpus': 2,
                    'memory_bytes': 8 * 1024**3,
                },
                paths,
                root,
            )
            self.assertNotIn('--gpus', modal_command)
            self.assertIn('fem-cpu-slepc-modal-v1', modal_command)

    def test_reject_mount_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = {name: root for name in ('source', 'workspace', 'build', 'artifacts', 'trusted', 'cargo', 'rustup', 'pnpm')}
            with self.assertRaises(ValueError):
                executor.build_command('a' * 32, 'b' * 64, 'fem-cpu-release',
                    {'image_digest': 'sha256:' + 'c' * 64, 'cpus': 2, 'memory_bytes': 8 * 1024**3}, paths, root)

    def test_mount_order_does_not_change_identity(self):
        mounts = [{'Type': 'bind', 'Source': 'C:/a', 'Destination': '/source', 'RW': False},
                  {'Type': 'bind', 'Source': 'C:/b', 'Destination': '/build', 'RW': True}]
        self.assertEqual(executor.mount_identity(mounts), executor.mount_identity(list(reversed(mounts))))

    def test_changed_mount_is_rejected(self):
        with self.assertRaises(executor.CoordinatorError):
            executor.attest_build_container({'Image': 'image', 'Mounts': []},
                {'image_digest': 'image', 'mounts': [('bind', 'unexpected', '/source', False)]})

    def test_missing_artifacts_cannot_be_success(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            job = dict(job_id='a' * 32, source_digest='b' * 64, profile='fem-cpu-release')
            (root / 'build-receipt.json').write_text(json.dumps({**job, 'state': 'succeeded', 'qualification': 'NOT VERIFIED', 'artifacts': []}))
            with self.assertRaises(ValueError):
                executor.validate_build_receipt(root, job, {})

    def test_slepc_modal_receipt_accepts_contract_artifacts_and_cpu_provenance(self):
        import hashlib
        import json
        from local_runner import build_entrypoint as entrypoint
        from local_runner.worker_entrypoint import canonical

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            image = "sha256:" + "c" * 64
            native = {"head_commit_full": "a" * 40, "source_snapshot_sha256": "3" * 64}
            job = {
                "job_id": "a" * 32,
                "source_digest": "b" * 64,
                "profile": "fem-cpu-slepc-modal-v1",
                "payload": {"native_source_identity": native},
            }
            result = {
                "schema": "fullmag.fem.cpu.slepc_modal_contract_result.v1",
                "scenario": "slepc-modal",
                "status": "pass",
                "source": {
                    "commit": native["head_commit_full"],
                    "snapshot_sha256": native["source_snapshot_sha256"],
                },
                "requested": {
                    "backend": "fem",
                    "device": "cpu",
                    "precision": "double",
                    "slepc": True,
                },
                "resolved": {
                    "backend": "fem",
                    "device": "cpu",
                    "precision": "double",
                    "slepc": True,
                    "fallback_used": False,
                },
                "build": {
                    "options": [
                        "-DFULLMAG_ENABLE_CUDA=ON",
                        "-DFULLMAG_ENABLE_FEM_GPU=OFF",
                        "-DFULLMAG_USE_MFEM_STACK=ON",
                        "-DFULLMAG_FEM_WITH_SLEPC=ON",
                    ],
                    "modal_target": "fem_poisson_airbox_modal_eigen_slepc_contract",
                    "floquet_targets": list(
                        executor.PROFILE_CONTRACTS["fem-cpu-slepc-modal-v1"][
                            "floquet_targets"
                        ]
                    ),
                    "shared_domain_target": executor.PROFILE_CONTRACTS[
                        "fem-cpu-slepc-modal-v1"
                    ]["shared_domain_target"],
                    "ctest_completed": True,
                    "executed_targets": [
                        "fem_poisson_airbox_modal_eigen_slepc_contract",
                        *executor.PROFILE_CONTRACTS["fem-cpu-slepc-modal-v1"]["floquet_targets"],
                        executor.PROFILE_CONTRACTS["fem-cpu-slepc-modal-v1"]["shared_domain_target"],
                    ],
                },
                "runtime_library": "/workspace/.fullmag/local/lib/libfullmag_fem.so.0",
                "attestation": {
                    "ctest_junit": {
                        "status": "pass",
                        "testcase_count": 9,
                        "skipped_count": 0,
                        "failure_count": 0,
                        "testcases": [
                            "fem_poisson_airbox_modal_eigen_slepc_contract",
                            *executor.PROFILE_CONTRACTS["fem-cpu-slepc-modal-v1"]["floquet_targets"],
                            executor.PROFILE_CONTRACTS["fem-cpu-slepc-modal-v1"]["shared_domain_target"],
                        ],
                    },
                    "cmake": {
                        "status": "pass",
                        "options": {
                            "FULLMAG_ENABLE_CUDA": {"value": "ON"},
                            "FULLMAG_ENABLE_FEM_GPU": {"value": "OFF"},
                            "FULLMAG_USE_MFEM_STACK": {"value": "ON"},
                            "FULLMAG_FEM_WITH_SLEPC": {"value": "ON"},
                        },
                    },
                    "runtime": {
                        "status": "pass",
                        "availability": {"native_fem_cpu_available": True},
                        "startup_stamp": "[fullmag] build: test | source snapshot: test",
                    },
                    "dependency": {
                        "status": "pass",
                        "dependency": {
                            "petsc_available": True,
                            "slepc_available": True,
                            "modal_eigen_native_cpu_slepc_available": True,
                            "petsc_version": "3.24.6",
                            "slepc_version": "3.24.3",
                            "diagnostics": {"native_source_snapshot_sha256": native["source_snapshot_sha256"]},
                        },
                    },
                    "resolution": {
                        "status": "pass",
                            "resolved": {
                            "backend": "fem",
                            "device": "cpu",
                            "precision": "double",
                            "slepc": True,
                                "fallback_used": False,
                            },
                            "precision": {
                                "value": "double",
                                "basis": "modal CTest compiled with PETSC_USE_REAL_DOUBLE and static_assert(sizeof(PetscReal) == sizeof(double))",
                            },
                        },
                },
            }
            result_path = root / "contracts" / "slepc-modal" / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(json.dumps(result), encoding="utf-8")
            result_bytes = result_path.read_bytes()
            native_library = root / "outputs" / ".fullmag" / "local" / "lib" / "libfullmag_fem.so.0"
            native_library.parent.mkdir(parents=True)
            native_library.write_bytes(b"native fem library")
            identity_path = root / "source-identity.json"
            identity_path.write_text(json.dumps(native), encoding="utf-8")
            native_library_bytes = native_library.read_bytes()
            identity_bytes = identity_path.read_bytes()
            headless_outputs = {}
            headless_output_entries = []
            for relative in entrypoint.HEADLESS_REQUIRED_OUTPUTS:
                output_path = root / "outputs" / ".fullmag" / "local" / relative
                output_path.parent.mkdir(parents=True, exist_ok=True)
                data = (
                    entrypoint.EXPECTED_BUILD_MARKER[job["profile"]].encode("utf-8") + b"\n"
                    if relative == "launcher-build-mode"
                    else b"headless-output"
                )
                output_path.write_bytes(data)
                headless_outputs[relative] = data
                headless_output_entries.append({
                    "path": "outputs/.fullmag/local/" + relative,
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                })
            receipt = {
                **job,
                "image_digest": image,
                "native_source_identity": native,
                "native_source_identity_sha256": hashlib.sha256(
                    canonical(native)
                ).hexdigest(),
                "qualification": "NOT VERIFIED",
                "state": "succeeded",
                "contract_scenarios": ["slepc-modal"],
                "contract_schema": "fullmag.fem.cpu.slepc_modal_contract_result.v1",
                "stages": [
                    {
                        "name": "contract-slepc-modal",
                        "exit_code": 0,
                    }
                ],
                "artifacts": [
                    {
                        "path": "contracts/slepc-modal/result.json",
                        "size": len(result_bytes),
                        "sha256": hashlib.sha256(result_bytes).hexdigest(),
                    },
                    *headless_output_entries,
                    {
                        "path": "outputs/.fullmag/local/lib/libfullmag_fem.so.0",
                        "size": len(native_library_bytes),
                        "sha256": hashlib.sha256(native_library_bytes).hexdigest(),
                    },
                    {
                        "path": "source-identity.json",
                        "size": len(identity_bytes),
                        "sha256": hashlib.sha256(identity_bytes).hexdigest(),
                    },
                ],
            }
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            validated = executor.validate_build_receipt(
                root,
                job,
                {"image_digest": image},
            )
            self.assertEqual(validated["state"], "succeeded")

            # The modal producer requires the headless package, not web/index.html.
            required_output_path = (
                "outputs/.fullmag/local/" + entrypoint.HEADLESS_REQUIRED_OUTPUTS[0]
            )
            valid_artifacts = list(receipt["artifacts"])
            receipt["artifacts"] = [
                entry for entry in valid_artifacts
                if entry["path"] != required_output_path
            ]
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "Required build outputs missing"):
                executor.validate_build_receipt(root, job, {"image_digest": image})

            receipt["artifacts"] = valid_artifacts
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            required_output_file = root / required_output_path
            required_output_file.unlink()
            with self.assertRaisesRegex(ValueError, "Artifact size mismatch"):
                executor.validate_build_receipt(root, job, {"image_digest": image})
            required_output_file.write_bytes(
                headless_outputs[entrypoint.HEADLESS_REQUIRED_OUTPUTS[0]]
            )

            dependency_values = result["attestation"]["dependency"]["dependency"]
            for diagnostics in ({}, {"native_source_snapshot_sha256": "4" * 64}):
                with self.subTest(native_diagnostics=diagnostics):
                    dependency_values["diagnostics"] = diagnostics
                    result_path.write_text(json.dumps(result), encoding="utf-8")
                    changed = result_path.read_bytes()
                    receipt["artifacts"][0].update(
                        size=len(changed), sha256=hashlib.sha256(changed).hexdigest()
                    )
                    (root / "build-receipt.json").write_text(
                        json.dumps(receipt), encoding="utf-8"
                    )
                    # Rehashing every changed artifact does not turn a stale
                    # dependency query into evidence of the current native code.
                    with self.assertRaisesRegex(ValueError, "native source binding"):
                        executor.validate_build_receipt(root, job, {"image_digest": image})
            dependency_values["diagnostics"] = {
                "native_source_snapshot_sha256": native["source_snapshot_sha256"]
            }

            result["source"]["snapshot_sha256"] = "4" * 64
            result_path.write_text(json.dumps(result), encoding="utf-8")
            result_bytes = result_path.read_bytes()
            receipt["artifacts"][0].update(
                size=len(result_bytes),
                sha256=hashlib.sha256(result_bytes).hexdigest(),
            )
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "source identity mismatch"):
                executor.validate_build_receipt(
                    root,
                    job,
                    {"image_digest": image},
                )

            result["source"]["snapshot_sha256"] = native["source_snapshot_sha256"]
            result_path.write_text(json.dumps(result), encoding="utf-8")
            result_bytes = result_path.read_bytes()
            receipt["artifacts"][0].update(
                size=len(result_bytes),
                sha256=hashlib.sha256(result_bytes).hexdigest(),
            )
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )

            result["resolved"]["fallback_used"] = True
            result_path.write_text(json.dumps(result), encoding="utf-8")
            result_bytes = result_path.read_bytes()
            receipt["artifacts"][0].update(
                size=len(result_bytes),
                sha256=hashlib.sha256(result_bytes).hexdigest(),
            )
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "implicit fallback"):
                executor.validate_build_receipt(
                    root,
                    job,
                    {"image_digest": image},
                )

    def test_slepc_runtime_receipt_requires_native_only_stage_and_runtime_attestations(self):
        import hashlib
        import json
        from local_runner.worker_entrypoint import canonical

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            image = "sha256:" + "c" * 64
            native = {
                "head_commit_full": "a" * 40,
                "source_snapshot_sha256": "3" * 64,
            }
            source = {
                "commit": native["head_commit_full"],
                "snapshot_sha256": native["source_snapshot_sha256"],
            }
            job = {
                "job_id": "a" * 32,
                "source_digest": "b" * 64,
                "profile": "fem-cpu-slepc-runtime-v1",
                "payload": {"native_source_identity": native},
            }
            runtime_attestation = {
                "schema": "fullmag.fem.slepc_runtime.attestation.v1",
                "status": "pass",
                "binary": "outputs/.fullmag/local/bin/fullmag-bin",
                "availability": {"native_fem_cpu_available": True},
                "startup_stamp": "[fullmag] build: test | source snapshot: "
                + native["source_snapshot_sha256"],
                "source": source,
            }
            dependency_attestation = {
                "schema": "fullmag.fem.slepc_runtime.dependency_attestation.v1",
                "status": "pass",
                "library": "outputs/.fullmag/local/lib/libfullmag_fem.so.0",
                "dependency": {
                    "petsc_available": True,
                    "slepc_available": True,
                    "modal_eigen_native_cpu_slepc_available": True,
                    "petsc_version": "3.24.6",
                    "slepc_version": "3.24.3",
                    "diagnostics_json": json.dumps({"native_source_snapshot_sha256": native["source_snapshot_sha256"]}),
                },
                "source": source,
            }
            cmake_attestation = {
                "schema": "fullmag.fem.slepc_runtime.cmake_attestation.v1",
                "status": "pass",
                "cache_path": "/workspace/.fullmag-build/cargo-targets/fem-cpu/release/build/fullmag-fem-sys-test/out/native-build/CMakeCache.txt",
                "options": {
                    name: {"type": "BOOL", "value": value}
                    for name, value in executor.RUNTIME_PROFILE_CONTRACTS[
                        "fem-cpu-slepc-runtime-v1"
                    ]["cmake_options"].items()
                },
                "runtime_library_sha256": hashlib.sha256(b"fem-native").hexdigest(),
                "native_library_sha256": hashlib.sha256(b"fem-native").hexdigest(),
                "source": source,
            }
            files = {
                "outputs/.fullmag/local/bin/fullmag-bin": b"cli",
                "outputs/.fullmag/local/bin/fullmag-api": b"api",
                "outputs/.fullmag/local/_fullmag_core.so": b"core",
                "outputs/.fullmag/local/launcher-build-mode": b"fem-cpu\n",
                "outputs/.fullmag/local/lib/libfullmag_fem.so.0": b"fem-native",
                "source-identity.json": json.dumps(native).encode("utf-8"),
                "cmake-attestation.json": json.dumps(cmake_attestation).encode("utf-8"),
                "runtime-attestation.json": json.dumps(runtime_attestation).encode("utf-8"),
                "dependency-attestation.json": json.dumps(dependency_attestation).encode("utf-8"),
            }
            for relative, content in files.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            receipt = {
                **job,
                "image_digest": image,
                "native_source_identity": native,
                "native_source_identity_sha256": hashlib.sha256(
                    canonical(native)
                ).hexdigest(),
                "qualification": "NOT VERIFIED",
                "state": "succeeded",
                "contract_scenarios": [],
                "contract_schema": None,
                "runtime_only": True,
                "runtime_contract": executor.RUNTIME_PROFILE_CONTRACTS[
                    "fem-cpu-slepc-runtime-v1"
                ],
                "stages": [
                    {
                        "name": "native-build",
                        "command": ["/usr/bin/make", "install-cli-dev"],
                        "exit_code": 0,
                    }
                ],
                "artifacts": [
                    {
                        "path": relative,
                        "size": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                    for relative, content in files.items()
                ],
            }
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            validated = executor.validate_build_receipt(
                root,
                job,
                {"image_digest": image},
            )
            self.assertEqual(validated["state"], "succeeded")

            # Rehashing a valid receipt cannot disguise a stale/unbound native library.
            for diagnostic in ({}, {"native_source_snapshot_sha256": "0" * 64}):
                dependency_attestation["dependency"]["diagnostics_json"] = json.dumps(diagnostic)
                changed = json.dumps(dependency_attestation).encode("utf-8")
                (root / "dependency-attestation.json").write_bytes(changed)
                for entry in receipt["artifacts"]:
                    if entry["path"] == "dependency-attestation.json":
                        entry.update(size=len(changed), sha256=hashlib.sha256(changed).hexdigest())
                (root / "build-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "native source binding"):
                    executor.validate_build_receipt(root, job, {"image_digest": image})
            dependency_attestation["dependency"]["diagnostics_json"] = json.dumps({
                "native_source_snapshot_sha256": native["source_snapshot_sha256"]})
            changed = json.dumps(dependency_attestation).encode("utf-8")
            (root / "dependency-attestation.json").write_bytes(changed)
            for entry in receipt["artifacts"]:
                if entry["path"] == "dependency-attestation.json":
                    entry.update(size=len(changed), sha256=hashlib.sha256(changed).hexdigest())

            runtime_attestation["startup_stamp"] = (
                "[fullmag] build: test | source snapshot: " + "0" * 64
            )
            stale_runtime_bytes = json.dumps(runtime_attestation).encode("utf-8")
            (root / "runtime-attestation.json").write_bytes(stale_runtime_bytes)
            for entry in receipt["artifacts"]:
                if entry["path"] == "runtime-attestation.json":
                    entry["size"] = len(stale_runtime_bytes)
                    entry["sha256"] = hashlib.sha256(stale_runtime_bytes).hexdigest()
                    break
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "native CPU availability"):
                executor.validate_build_receipt(
                    root,
                    job,
                    {"image_digest": image},
                )

            runtime_attestation["startup_stamp"] = (
                "[fullmag] build: test | source snapshot: "
                + native["source_snapshot_sha256"]
            )
            valid_runtime_bytes = json.dumps(runtime_attestation).encode("utf-8")
            (root / "runtime-attestation.json").write_bytes(valid_runtime_bytes)
            for entry in receipt["artifacts"]:
                if entry["path"] == "runtime-attestation.json":
                    entry["size"] = len(valid_runtime_bytes)
                    entry["sha256"] = hashlib.sha256(valid_runtime_bytes).hexdigest()
                    break

            receipt["stages"].append(
                {
                    "name": "contract-slepc-modal",
                    "command": ["/usr/bin/ctest"],
                    "exit_code": 0,
                }
            )
            (root / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "only native-build"):
                executor.validate_build_receipt(
                    root,
                    job,
                    {"image_digest": image},
                )

    def test_worker_isolation_is_attested(self):
        inspected = {'Image': 'image', 'Mounts': [], 'Config': {'User': '65532:65532'},
                     'HostConfig': {'Privileged': False, 'ReadonlyRootfs': True,
                                    'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'],
                                    'NetworkMode': 'bridge'}}
        journal = {'image_digest': 'image', 'mounts': []}
        executor.attest_build_container(inspected, journal)
        inspected['HostConfig']['Privileged'] = True
        with self.assertRaises(executor.CoordinatorError):
            executor.attest_build_container(inspected, journal)

    def test_supported_profiles_include_current_contracts_and_slepc(self):
        self.assertEqual(('fem', 'cpu'), executor.profile_lane('fem-cpu-current-contracts-v1'))
        self.assertEqual(('fem', 'gpu'), executor.profile_lane('fem-gpu-current-contracts-v1'))
        self.assertEqual(('fem', 'cpu'), executor.profile_lane('fem-cpu-slepc-modal-v1'))
        with self.assertRaises(ValueError):
            executor.profile_lane('nonexistent-profile')


if __name__ == '__main__':
    unittest.main()
