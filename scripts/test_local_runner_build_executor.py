import tempfile
import unittest
from unittest.mock import Mock, patch
from contextlib import nullcontext
from pathlib import Path

from local_runner import build_executor as executor


class BuildExecutorTests(unittest.TestCase):
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
            with patch.object(executor, 'JobQueue', return_value=queue), \
                 patch.object(executor, 'file_lock', return_value=nullcontext()), \
                 patch.object(executor.shutil, 'disk_usage', return_value=Mock(free=1024)):
                result = executor.execute_build({'storage_root': str(root), 'container_coordinator': True}, owner='test')
            self.assertEqual('waiting_for_disk', result['state'])
            queue.claim.assert_not_called()

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
                    "ctest_completed": True,
                    "executed_targets": [
                        "fem_poisson_airbox_modal_eigen_slepc_contract",
                        *executor.PROFILE_CONTRACTS["fem-cpu-slepc-modal-v1"]["floquet_targets"],
                    ],
                },
                "runtime_library": "/workspace/.fullmag/local/lib/libfullmag_fem.so.0",
                "attestation": {
                    "ctest_junit": {
                        "status": "pass",
                        "testcase_count": 8,
                        "skipped_count": 0,
                        "failure_count": 0,
                        "testcases": [
                            "fem_poisson_airbox_modal_eigen_slepc_contract",
                            *executor.PROFILE_CONTRACTS["fem-cpu-slepc-modal-v1"]["floquet_targets"],
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
