"""Unit tests for the trusted container Fullmag build entrypoint."""

from __future__ import annotations

import ast
import hashlib
import re
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from local_runner import build_entrypoint as entrypoint


class BuildEntryPointTests(unittest.TestCase):
    def test_runtime_startup_stamp_accepts_reported_current_and_legacy_formats(self) -> None:
        actual_snapshot = "2a932af34c40391797e1f9804e1d77b5b8c25c3fb454ce3459001d14c6d01b0c"
        actual_stamp = (
            "[fullmag] version: 0.1.0-dev.20261004.gbdb927fd2400+9773 | "
            "build: 2026-10-04T16:55:06Z | "
            "commit: bdb927fd2400cb2372d1fbeeff57e8c62f99016a | clean | "
            f"source snapshot: {actual_snapshot}"
        )
        self.assertEqual(
            entrypoint._validate_runtime_startup_stamp(actual_stamp + "\n", actual_snapshot),
            actual_stamp,
        )

        reported_legacy_snapshot = "2facba51b671a586a129d6271a41fd3281d66e0d8a66fde827ab516e1830da2f"
        reported_legacy_stamp = (
            "[fullmag] build: 2026-10-04T08:05:40Z | "
            "commit: 57182911c6e8e721b8ee9705aa7f70491c70fe94 | clean | "
            f"source snapshot: {reported_legacy_snapshot}"
        )
        self.assertEqual(
            entrypoint._validate_runtime_startup_stamp(
                reported_legacy_stamp, reported_legacy_snapshot
            ),
            reported_legacy_stamp,
        )

        legacy_snapshot = "a" * 64
        legacy_stamp = f"[fullmag] build: test | source snapshot: {legacy_snapshot}"
        self.assertEqual(
            entrypoint._validate_runtime_startup_stamp(legacy_stamp, legacy_snapshot),
            legacy_stamp,
        )

    def test_runtime_startup_stamp_rejects_missing_malformed_mismatched_and_ambiguous(self) -> None:
        expected_snapshot = "a" * 64
        valid_stamp = f"[fullmag] build: test | source snapshot: {expected_snapshot}"
        cases = (
            ("no marker", "", "lacks source snapshot identity"),
            (
                "unrelated marker",
                f"[fullmag] warning: source snapshot: {expected_snapshot}\n",
                "lacks source snapshot identity",
            ),
            (
                "malformed current stamp",
                "[fullmag] version: 0.1.0-dev | build: invalid | commit: nope | clean | "
                + "source snapshot: "
                + "g" * 64,
                "is malformed",
            ),
            (
                "known prefix missing source marker",
                "[fullmag] version: 0.1.0-dev | build: 2026-10-04T16:55:06Z | commit: "
                + "a" * 40
                + " | clean",
                "is malformed",
            ),
            (
                "short snapshot digest",
                f"[fullmag] build: test | source snapshot: {expected_snapshot[:-1]}",
                "is malformed",
            ),
            (
                "uppercase snapshot digest",
                f"[fullmag] build: test | source snapshot: {'A' * 64}",
                "is malformed",
            ),
            (
                "invalid current build timestamp",
                "[fullmag] version: 0.1.0-dev | build: 2026-99-99T16:55:06Z | "
                + "commit: "
                + "a" * 40
                + " | clean | source snapshot: "
                + expected_snapshot,
                "is malformed",
            ),
            (
                "mismatched snapshot",
                f"[fullmag] build: test | source snapshot: {'b' * 64}",
                "does not match the native source identity",
            ),
            (
                "current-format mismatched snapshot",
                "[fullmag] version: 0.1.0-dev.20261004.ga | "
                "build: 2026-10-04T16:55:06Z | "
                + "commit: "
                + "a" * 40
                + " | clean | source snapshot: "
                + "b" * 64,
                "does not match the native source identity",
            ),
            (
                "ambiguous stamps",
                valid_stamp + "\n" + valid_stamp,
                "is ambiguous",
            ),
        )
        for label, stderr, error in cases:
            with self.subTest(label=label):
                with self.assertRaisesRegex(entrypoint.BuildEntryPointError, error):
                    entrypoint._validate_runtime_startup_stamp(stderr, expected_snapshot)

    def test_specialized_profile_keeps_baseline_outputs_without_release_runtime(self) -> None:
        output = self.root / "specialized-output"
        output.mkdir()
        for relative in entrypoint.BASE_REQUIRED_OUTPUTS:
            path = output / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"artifact")
        (output / "launcher-build-mode").write_text("fem-cpu", encoding="utf-8")
        profile = entrypoint.Profile(name="fem-cpu-slepc-runtime-v2", lane="fem-cpu", environment={})
        with patch.dict(entrypoint.EXPECTED_BUILD_MARKER, {profile.name: "fem-cpu"}):
            entrypoint._validate_required_outputs(output, profile)

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="fullmag-build-entrypoint-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.workspace = self.root / "workspace"
        self.build = self.root / "build"
        self.artifacts = self.root / "artifacts"
        for path in (self.source, self.workspace, self.build, self.artifacts):
            path.mkdir()
        (self.workspace / ".fullmag-build").mkdir()
        (self.workspace / ".fullmag-cargo").mkdir()
        (self.workspace / ".fullmag-rustup").mkdir()
        self.job_id = "job-123"
        self.profile = "fem-cpu-release"
        self.image_digest = "sha256:" + "f" * 64
        self.manifest, self.source_digest = self._make_capsule()

    def _make_capsule(self) -> tuple[dict[str, object], str]:
        tree = self.source / "tree"
        tree.mkdir()
        source_file = tree / "README.txt"
        source_file.write_text("immutable source\n", encoding="utf-8")
        source_file.chmod(0o755)
        file_bytes = source_file.read_bytes()
        manifest: dict[str, object] = {
            "schema_version": entrypoint.CAPSULE_SCHEMA,
            "source_mode": "commit",
            "resolved_commit": "a" * 40,
            "files": [
                {
                    "path": "README.txt",
                    "type": "file",
                    "mode": "100755",
                    "size": len(file_bytes),
                    "sha256": hashlib.sha256(file_bytes).hexdigest(),
                }
            ],
            "deleted": [],
            "included_untracked": [],
            "excluded": [],
        }
        manifest["source_digest"] = hashlib.sha256(
            entrypoint.canonical(manifest)
        ).hexdigest()
        (self.source / "manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        return manifest, str(manifest["source_digest"])

    def _identity(self) -> dict[str, object]:
        identity: dict[str, object] = {
            "schema": entrypoint.IDENTITY_SCHEMA,
            "head_commit_full": "a" * 40,
            "head_tree_sha256": "1" * 64,
            "git_status_porcelain_v1": [],
            "dirty_path_content": [],
            "dirty_content_sha256": "2" * 64,
            "source_snapshot_dirty": False,
        }
        payload = dict(identity)
        for derived in ("source_snapshot_dirty", "dirty_content_sha256"):
            payload.pop(derived, None)
        identity["source_snapshot_sha256"] = hashlib.sha256(
            entrypoint.canonical(payload)
        ).hexdigest()
        return identity

    def _write_context(self, *, include_identity: bool = True) -> Path:
        context: dict[str, object] = {
            "schema": entrypoint.CONTEXT_SCHEMA,
            "job_id": self.job_id,
            "source_digest": self.source_digest,
            "profile": self.profile,
            "image_digest": self.image_digest,
        }
        if include_identity:
            context["native_source_identity"] = self._identity()
        path = self.root / "context.json"
        path.write_text(json.dumps(context), encoding="utf-8")
        return path

    def _argv(self, context: Path) -> list[str]:
        return [
            "--job-id",
            self.job_id,
            "--source-digest",
            self.source_digest,
            "--profile",
            self.profile,
            "--source",
            str(self.source),
            "--workspace",
            str(self.workspace),
            "--build",
            str(self.build),
            "--artifacts",
            str(self.artifacts),
            "--context",
            str(context),
            "--jobs",
            "2",
        ]

    def _write_outputs(
        self,
        marker: str = "fem-cpu",
        *,
        include_fem_library: bool = False,
        include_web: bool = True,
    ) -> Path:
        output = self.workspace / ".fullmag" / "local"
        (output / "bin").mkdir(parents=True)
        (output / "lib").mkdir()
        if include_web:
            (output / "web").mkdir()
        (output / "bin" / "fullmag-bin").write_bytes(b"cli")
        (output / "bin" / "fullmag-api").write_bytes(b"api")
        for name in (
            "fullmag-api-accepted-worker",
            "fullmag-api-accepted-supervisor",
            "fullmag-api-accepted-scheduler",
            "fullmag-runtime-service",
            "fullmag-api-resource-pool",
            "fullmag-api-accepted-fem-preparer",
            "fullmag-api-accepted-fem-preparation-supervisor",
            "fullmag-api-accepted-fem-preparation-scheduler",
            "fullmag-api-preparation-resource-pool",
            "fullmag-api-preparation-retry",
        ):
            (output / "bin" / name).write_bytes(b"accepted-runtime")
        (output / "_fullmag_core.so").write_bytes(b"core")
        (output / "launcher-build-mode").write_text(marker + "\n", encoding="utf-8")
        if include_web:
            (output / "web" / "index.html").write_text("<html />", encoding="utf-8")
        if include_fem_library:
            (output / "lib" / "libfullmag_fem.so.0").write_bytes(b"fem-native")
        return output

    def test_incomplete_accepted_runtime_package_is_rejected(self) -> None:
        output = self._write_outputs()
        binaries = sorted(output.joinpath("bin").glob("fullmag-api-*")) + [output / "bin" / "fullmag-runtime-service"]
        self.assertEqual(len(binaries), 10)
        for binary in binaries:
            with self.subTest(binary=binary.name):
                original = binary.read_bytes()
                binary.unlink()
                try:
                    with self.assertRaisesRegex(entrypoint.BuildEntryPointError, binary.name):
                        entrypoint._validate_required_outputs(output, entrypoint.profile_for(self.profile))
                finally:
                    binary.write_bytes(original)

    def test_empty_native_runtime_service_is_rejected(self) -> None:
        output = self._write_outputs()
        binary = output / "bin" / "fullmag-runtime-service"
        binary.write_bytes(b"")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, binary.name):
            entrypoint._validate_required_outputs(output, entrypoint.profile_for(self.profile))

    def test_empty_accepted_runtime_binary_is_rejected(self) -> None:
        output = self._write_outputs()
        binary = output / "bin" / "fullmag-api-accepted-fem-preparer"
        binary.write_bytes(b"")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, binary.name):
            entrypoint._validate_required_outputs(output, entrypoint.profile_for(self.profile))

    def test_profile_environment_cannot_silently_fallback(self) -> None:
        identity = self._identity()
        cpu = entrypoint.build_environment(
            entrypoint.profile_for("fem-cpu-release"),
            workspace=self.workspace,
            build=self.build,
            jobs=2,
            native_identity=identity,
        )
        self.assertEqual(cpu["FULLMAG_FORCE_LOCAL_FEM_CPU"], "1")
        self.assertEqual(cpu["FULLMAG_FORCE_LOCAL_FEM_GPU"], "0")
        self.assertEqual(cpu["FULLMAG_BUILD_CPU_ONLY"], "0")
        self.assertEqual(cpu["FULLMAG_FEM_WITH_SLEPC"], "OFF")
        self.assertEqual(cpu["CARGO_BUILD_JOBS"], "2")
        self.assertEqual(
            cpu["FULLMAG_SOURCE_SNAPSHOT_SHA256"],
            identity["source_snapshot_sha256"],
        )
        self.assertEqual(cpu["HOME"], "/workspace/.fullmag-build/home")
        self.assertEqual(cpu["TMPDIR"], "/workspace/.fullmag-build/tmp")
        self.assertTrue((self.build / "home").is_dir())
        self.assertTrue((self.build / "tmp").is_dir())
        gpu = entrypoint.profile_for("fem-gpu-release")
        self.assertTrue(gpu.needs_cuda_toolchain)
        self.assertEqual(gpu.environment["FULLMAG_FORCE_LOCAL_FEM_GPU"], "1")
        fdm = entrypoint.profile_for("fdm-cpu-release")
        self.assertEqual(fdm.environment["FULLMAG_BUILD_CPU_ONLY"], "1")

    def test_slepc_modal_profile_is_cpu_double_and_contract_only(self) -> None:
        profile = entrypoint.profile_for("fem-cpu-slepc-modal-v1")
        self.assertEqual(profile.lane, "fem-cpu")
        self.assertFalse(profile.needs_cuda_toolchain)
        self.assertEqual(profile.contract_scenarios, ("slepc-modal",))
        self.assertEqual(
            profile.contract_script,
            "scripts/run_fem_cpu_slepc_modal_contract.sh",
        )
        self.assertEqual(
            profile.contract_schema,
            "fullmag.fem.cpu.slepc_modal_contract_result.v1",
        )
        self.assertEqual(profile.environment["FULLMAG_FEM_WITH_SLEPC"], "ON")
        self.assertEqual(profile.environment["FULLMAG_FEM_MFEM_DEVICE"], "cpu")
        self.assertEqual(profile.environment["FULLMAG_FEM_REQUIRE_GPU"], "0")
        self.assertEqual(profile.environment["FULLMAG_FORCE_LOCAL_FEM_GPU"], "0")

    def test_slepc_runtime_profile_is_native_only_and_slepc_enabled(self) -> None:
        profile = entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
        self.assertEqual(profile.lane, "fem-cpu")
        self.assertTrue(profile.runtime_only)
        self.assertEqual(profile.contract_scenarios, ())
        self.assertEqual(
            profile.runtime_contract_schema,
            "fullmag.fem.cpu.slepc_runtime_contract.v1",
        )
        self.assertEqual(profile.environment["FULLMAG_FEM_WITH_SLEPC"], "ON")
        self.assertEqual(profile.environment["FULLMAG_USE_MFEM_STACK"], "ON")
        self.assertEqual(profile.environment["FULLMAG_FEM_MFEM_DEVICE"], "cpu")
        self.assertFalse(entrypoint._runtime_contract(profile)["unit_test_targets"])
        self.assertFalse(entrypoint._runtime_contract(profile)["frontend_stages"])

    def test_slepc_runtime_v2_uses_separate_cpu_mfem_abi(self) -> None:
        profile = entrypoint.profile_for("fem-cpu-slepc-runtime-v2")
        contract = entrypoint._runtime_contract(profile)
        self.assertTrue(profile.runtime_only)
        self.assertEqual(profile.environment["FULLMAG_FEM_NATIVE_CUDA"], "0")
        self.assertEqual(profile.environment["FULLMAG_FEM_ENABLE_CUDA"], "0")
        self.assertEqual(profile.environment["CMAKE_PREFIX_PATH"], "/opt/fullmag-mfem-cpu")
        self.assertEqual(profile.environment["LD_LIBRARY_PATH"], "/opt/fullmag-mfem-cpu/lib")
        self.assertEqual(profile.environment["PKG_CONFIG_PATH"],
                         "/opt/fullmag-mfem-cpu/lib/pkgconfig")
        self.assertEqual(profile.environment["PETSC_DIR"], "/opt/fullmag-mfem-cpu")
        self.assertEqual(profile.environment["SLEPC_DIR"], "/opt/fullmag-mfem-cpu")
        self.assertEqual(profile.environment["PETSC_ARCH"], "")
        self.assertEqual(contract["cmake_options"]["FULLMAG_ENABLE_CUDA"], "OFF")
        self.assertEqual(contract["cmake_options"]["FULLMAG_ENABLE_FEM_GPU"], "OFF")
        self.assertEqual(contract["schema"],
                         "fullmag.fem.cpu.slepc_runtime_contract.v2")

    def _cpu_modal_dependency_fixture(self) -> Path:
        prefix = self.root / "cpu-modal-stack"
        for relative in (
            "include/petscconf.h", "include/ceed.h", "include/slepceps.h",
            "lib/libpetsc.so", "lib/libslepc.so", "lib/libceed.so",
            "lib/libHYPRE.so", "lib/libmfem.so",
            "lib/pkgconfig/PETSc.pc", "lib/pkgconfig/SLEPc.pc",
        ):
            path = prefix / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        (prefix / "include/petscconf.h").write_text(
            "#define PETSC_USE_REAL_DOUBLE 1\n", encoding="utf-8"
        )
        return prefix

    def test_cpu_modal_preflight_rejects_missing_or_gpu_petsc(self) -> None:
        prefix = self._cpu_modal_dependency_fixture()
        entrypoint.require_cpu_modal_dependencies(prefix)
        config = prefix / "include/petscconf.h"
        for accelerator in ("CUDA", "HIP", "SYCL", "OPENCL"):
            with self.subTest(accelerator=accelerator):
                config.write_text("#define PETSC_USE_REAL_DOUBLE 1\n"
                                  f"#define PETSC_HAVE_{accelerator} 1\n",
                                  encoding="utf-8")
                with self.assertRaisesRegex(entrypoint.BuildEntryPointError,
                                            "accelerator support"):
                    entrypoint.require_cpu_modal_dependencies(prefix)
        config.write_text("#define PETSC_USE_REAL_DOUBLE 1\n" + "".join(
            f"#define PETSC_HAVE_{name} 0 /* disabled */\n"
            for name in ("CUDA", "HIP", "SYCL", "OPENCL")
        ), encoding="utf-8")
        entrypoint.require_cpu_modal_dependencies(prefix)
        config.write_text("#define PETSC_USE_REAL_DOUBLE 1\n", encoding="utf-8")
        (prefix / "lib/libslepc.so").unlink()
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "libslepc"):
            entrypoint.require_cpu_modal_dependencies(prefix)

    def test_cpu_modal_linkage_rejects_gpu_duplicate_and_missing_dependencies(self) -> None:
        prefix = self._cpu_modal_dependency_fixture()
        linkage = "\n".join(f"{stem}.so => {prefix / 'lib' / (stem + '.so')} (0x1234)"
                            for stem in entrypoint.CPU_MODAL_LIBRARY_STEMS.values())
        observed = entrypoint.observe_cpu_modal_linkage(linkage, prefix)
        self.assertEqual(set(observed), set(entrypoint.CPU_MODAL_LIBRARY_STEMS))
        for bad in (
            linkage + "\nlibcublasLt.so.12 => /usr/local/cuda/lib64/libcublasLt.so.12 (0x1)",
            linkage + f"\nlibHYPRE-3.1.0.so => {prefix / 'lib/libHYPRE.so'} (0x2)",
            linkage.replace("libpetsc.so =>", "libother.so =>"),
            linkage + "\nlibother.so => not found",
        ):
            with self.subTest(linkage=bad):
                with self.assertRaises(entrypoint.BuildEntryPointError):
                    entrypoint.observe_cpu_modal_linkage(bad, prefix)
        outside = self.root / "foreign-petsc.so"
        outside.write_bytes(b"foreign")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "escaped CPU prefix"):
            entrypoint.observe_cpu_modal_linkage(
                linkage.replace(str(prefix / 'lib/libpetsc.so'), str(outside)), prefix
            )

    def test_cpu_modal_resolution_binds_cmake_to_resolved_library(self) -> None:
        prefix = self._cpu_modal_dependency_fixture()
        modules = self.workspace / "backends/fem/cmake"
        modules.mkdir(parents=True)
        dependency = {}
        libraries = {}
        for family, module in (("petsc", "FindPETSc.cmake"), ("slepc", "FindSLEPc.cmake")):
            (modules / module).write_text("", encoding="utf-8")
            path = (prefix / "lib" / ("lib" + family + ".so")).resolve()
            libraries[family] = {"path": str(path)}
            dependency.update({family + "_library_path": str(path),
                               family + "_pkgconfig_dir": str(prefix / "lib/pkgconfig"),
                               family + "_find_module_file": str(modules / module)})
        entrypoint.bind_cpu_modal_resolution(dependency, libraries, prefix, self.workspace)
        self.assertEqual(dependency["petsc_library_realpath"], libraries["petsc"]["path"])
        dependency["petsc_pkgconfig_dir"] = str(self.root)
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "pkg-config"):
            entrypoint.bind_cpu_modal_resolution(dependency, libraries, prefix, self.workspace)

    def test_cpu_modal_preflight_rejects_wrong_precision(self) -> None:
        prefix = self._cpu_modal_dependency_fixture()
        for config in (
            "#define PETSC_USE_REAL_SINGLE 1\n",
            "#define PETSC_USE_REAL_DOUBLE 1\n#define PETSC_USE_COMPLEX 1\n",
        ):
            with self.subTest(config=config):
                (prefix / "include/petscconf.h").write_text(config, encoding="utf-8")
                with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "real/double"):
                    entrypoint.require_cpu_modal_dependencies(prefix)

    def test_slepc_runtime_profile_runs_only_native_build_and_publishes_identity(self) -> None:
        self.profile = "fem-cpu-slepc-runtime-v1"
        context = self._write_context()
        calls: list[tuple[str, list[str]]] = []

        def runtime_preflight(profile, *, release=True):
            self.assertEqual(profile.name, self.profile)
            self.assertFalse(release)
            return {"make": "/usr/bin/make"}

        def runtime_stage(name, command, *, workspace, artifacts, environment):
            calls.append((name, command))
            self.assertEqual(environment["FULLMAG_FEM_WITH_SLEPC"], "ON")
            self._write_outputs(include_fem_library=True, include_web=False)
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 0,
            }

        with patch.object(
            entrypoint,
            "preflight",
            side_effect=runtime_preflight,
        ), patch.object(
            entrypoint,
            "toolchain_versions",
            return_value={},
        ), patch.object(
            entrypoint,
            "_attest_slepc_runtime",
            return_value=None,
        ), patch.object(
            entrypoint,
            "run_stage",
            side_effect=runtime_stage,
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 0)
        self.assertEqual(calls, [("native-build", ["/usr/bin/make", "install-cli-dev"])])
        self.assertFalse((self.workspace / ".fullmag" / "local" / "web").exists())
        receipt = json.loads(
            (self.artifacts / "build-receipt.json").read_text(encoding="utf-8")
        )
        self.assertTrue(receipt["runtime_only"])
        self.assertEqual(
            receipt["runtime_contract"],
            entrypoint._runtime_contract(entrypoint.profile_for(self.profile)),
        )
        self.assertEqual(receipt["contract_scenarios"], [])
        self.assertIsNone(receipt["contract_schema"])
        self.assertEqual(
            json.loads((self.artifacts / "source-identity.json").read_text(encoding="utf-8")),
            self._identity(),
        )
        self.assertIn(
            "outputs/.fullmag/local/lib/libfullmag_fem.so.0",
            {entry["path"] for entry in receipt["artifacts"]},
        )

    def test_modal_contract_embedded_python_has_valid_syntax(self) -> None:
        script = Path(__file__).with_name("run_fem_cpu_slepc_modal_contract.sh").read_text(encoding="utf-8")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY", script, re.S)
        self.assertTrue(blocks)
        for index, block in enumerate(blocks):
            with self.subTest(block=index):
                ast.parse(block, filename=f"modal-contract-heredoc-{index}")

    def test_native_snapshot_binding_rejects_missing_malformed_and_stale_library(self) -> None:
        expected = "a" * 64
        for diagnostics in ({}, {"native_source_snapshot_sha256": ""},
                            {"native_source_snapshot_sha256": "A" * 64},
                            {"native_source_snapshot_sha256": "b" * 64}, "invalid", []):
            with self.subTest(diagnostics=diagnostics):
                with self.assertRaises(entrypoint.BuildEntryPointError):
                    entrypoint.validate_native_source_snapshot(diagnostics, expected)
        self.assertEqual(entrypoint.validate_native_source_snapshot(
            json.dumps({"native_source_snapshot_sha256": expected}), expected), expected)
        with self.assertRaises(entrypoint.BuildEntryPointError):
            entrypoint.validate_native_source_snapshot({"native_source_snapshot_sha256": expected}, None)

    def _prepare_slepc_runtime_probe(self) -> tuple[Path, Path]:
        output = self.workspace / ".fullmag" / "local"
        runtime_bin = output / "bin" / "fullmag-bin"
        runtime_library = output / "lib" / "libfullmag_fem.so.0"
        runtime_bin.parent.mkdir(parents=True)
        runtime_library.parent.mkdir(parents=True)
        runtime_bin.write_bytes(b"binary")
        runtime_library.write_bytes(b"library")
        cargo_target = self.build / "cargo-targets" / "fem-cpu"
        cmake_cache = (
            cargo_target
            / "release"
            / "build"
            / "fullmag-fem-sys"
            / "probe"
            / "out"
            / "native-build"
            / "CMakeCache.txt"
        )
        cmake_cache.parent.mkdir(parents=True)
        cmake_cache.write_text(
            "FULLMAG_ENABLE_CUDA:BOOL=ON\n"
            "FULLMAG_ENABLE_FEM_GPU:BOOL=ON\n"
            "FULLMAG_USE_MFEM_STACK:BOOL=ON\n"
            "FULLMAG_FEM_WITH_SLEPC:BOOL=ON\n",
            encoding="utf-8",
        )
        native_library = cmake_cache.parent / "backends" / "fem" / "libfullmag_fem.so.0"
        native_library.parent.mkdir(parents=True)
        native_library.write_bytes(b"library")
        return runtime_bin, cargo_target

    def test_slepc_runtime_probe_records_binary_and_dependency_attestations(self) -> None:
        output = self.workspace / ".fullmag" / "local"
        runtime_bin = output / "bin" / "fullmag-bin"
        runtime_library = output / "lib" / "libfullmag_fem.so.0"
        runtime_bin.parent.mkdir(parents=True)
        runtime_library.parent.mkdir(parents=True)
        runtime_bin.write_bytes(b"binary")
        runtime_library.write_bytes(b"library")
        cargo_target = self.build / "cargo-targets" / "fem-cpu"
        cmake_cache = (
            cargo_target
            / "release"
            / "build"
            / "fullmag-fem-sys"
            / "abc123"
            / "out"
            / "native-build"
            / "CMakeCache.txt"
        )
        cmake_cache.parent.mkdir(parents=True)
        cmake_cache.write_text(
            "\n".join(
                [
                    "FULLMAG_ENABLE_CUDA:BOOL=ON",
                    "FULLMAG_ENABLE_FEM_GPU:BOOL=ON",
                    "FULLMAG_USE_MFEM_STACK:BOOL=ON",
                    "FULLMAG_FEM_WITH_SLEPC:BOOL=ON",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        native_library = cmake_cache.parent / "backends" / "fem" / "libfullmag_fem.so.0"
        native_library.parent.mkdir(parents=True)
        native_library.write_bytes(b"library")

        identity = self._identity()
        expected_snapshot = str(identity["source_snapshot_sha256"])

        class FakeQuery:
            argtypes = None
            restype = None

            def __call__(self, pointer):
                info = pointer._obj
                info.petsc_available = 1
                info.slepc_available = 1
                info.modal_eigen_native_cpu_slepc_available = 1
                info.petsc_version = b"3.24.6"
                info.slepc_version = b"3.24.3"
                info.reason = b"available"
                info.diagnostics_json = json.dumps({"native_source_snapshot_sha256": expected_snapshot}).encode()
                return 0

        class FakeLibrary:
            fullmag_fem_get_frequency_domain_dependency_info = FakeQuery()

        cdll_calls: list[tuple[str, int]] = []

        def fake_cdll(path: str, *, mode: int = 0) -> FakeLibrary:
            cdll_calls.append((path, mode))
            return FakeLibrary()

        startup_stamp = (
            f"[fullmag] version: 0.1.0-dev.20261004.g{str(identity['head_commit_full'])[:12]}+1 | "
            "build: 2026-10-04T16:55:06Z | "
            f"commit: {identity['head_commit_full']} | clean | "
            f"source snapshot: {expected_snapshot}\n"
        )
        probe = entrypoint.subprocess.CompletedProcess(
            [str(runtime_bin)],
            0,
            '{"native_fem_cpu_available": true}',
            startup_stamp,
        )
        probe_environment: dict[str, str] = {}
        probe_options: dict[str, object] = {}

        def fake_probe(*args, **kwargs):
            probe_environment.update(kwargs["env"])
            probe_options.update({"timeout": kwargs["timeout"], "text": kwargs["text"]})
            return probe

        stale_artifacts = self.root / "stale-artifacts"
        stale_artifacts.mkdir()
        with patch.object(
            entrypoint.subprocess,
            "run",
            side_effect=fake_probe,
        ), patch.object(
            entrypoint,
            "_cuda_driver_compatibility_paths",
            return_value=("/usr/local/cuda/compat",),
        ), patch.object(
            entrypoint.os,
            "access",
            return_value=True,
        ), patch.object(
            entrypoint.ctypes,
            "CDLL",
            side_effect=fake_cdll,
        ):
            entrypoint._attest_slepc_runtime(
                self.workspace,
                self.artifacts,
                {
                    "LD_LIBRARY_PATH": "/opt/petsc/lib",
                    "FULLMAG_CARGO_TARGET_DIR": str(cargo_target),
                },
                identity,
                entrypoint._runtime_contract(
                    entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                ),
            )
            # Even a fresh Rust startup stamp and byte-matched CMake library
            # must not admit native code bound to another source capsule.
            expected_snapshot = "b" * 64
            with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "native library source snapshot"):
                entrypoint._attest_slepc_runtime(
                    self.workspace, stale_artifacts,
                    {"FULLMAG_CARGO_TARGET_DIR": str(cargo_target), "LD_LIBRARY_PATH": "/opt/petsc/lib"},
                    identity, entrypoint._runtime_contract(
                        entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                    ),
                )

        runtime_attestation = json.loads(
            (self.artifacts / "runtime-attestation.json").read_text(encoding="utf-8")
        )
        dependency_attestation = json.loads(
            (self.artifacts / "dependency-attestation.json").read_text(encoding="utf-8")
        )
        probe_state = json.loads(
            (self.artifacts / "logs" / "slepc-runtime-availability.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(runtime_attestation["status"], "pass")
        self.assertTrue(runtime_attestation["availability"]["native_fem_cpu_available"])
        self.assertEqual(probe_state["schema"], entrypoint.SLEPC_PROBE_SCHEMA)
        self.assertEqual(probe_state["status"], "exited_zero")
        self.assertEqual(probe_state["scope"], "subprocess_execution")
        self.assertEqual(probe_state["validation"], "not_assessed")
        self.assertEqual(probe_state["return_code"], 0)
        self.assertEqual(probe_options["timeout"], 120)
        self.assertTrue(probe_options["text"])
        self.assertFalse(probe_state["stdout_truncated"])
        self.assertFalse(probe_state["stderr_truncated"])
        self.assertEqual(
            (self.artifacts / "logs" / "slepc-runtime-availability.stdout.log").read_text(
                encoding="utf-8"
            ),
            '{"native_fem_cpu_available": true}',
        )
        self.assertEqual(
            (self.artifacts / "logs" / "slepc-runtime-availability.stderr.log").read_text(
                encoding="utf-8"
            ),
            startup_stamp,
        )
        self.assertNotIn("environment", probe_state)
        self.assertEqual(
            runtime_attestation["cuda_driver_compatibility_paths"],
            ["/usr/local/cuda/compat"],
        )
        self.assertEqual(
            runtime_attestation["cuda_driver_compatibility_libraries_preloaded"],
            ["/usr/local/cuda/compat/libcuda.so.1"],
        )
        self.assertEqual(
            cdll_calls[:2],
            [
                ("/usr/local/cuda/compat/libcuda.so.1", entrypoint.ctypes.RTLD_GLOBAL),
                (str(runtime_library), 0),
            ],
        )
        self.assertEqual(
            probe_environment["LD_LIBRARY_PATH"].split(os.pathsep)[:2],
            [str(runtime_library.parent), "/usr/local/cuda/compat"],
        )
        self.assertEqual(cdll_calls[2:], cdll_calls[:2])
        self.assertEqual(dependency_attestation["status"], "pass")
        self.assertTrue(
            dependency_attestation["dependency"]["modal_eigen_native_cpu_slepc_available"]
        )

    def test_slepc_runtime_probe_exit_zero_invalid_json_is_not_attestation_pass(self) -> None:
        runtime_bin, cargo_target = self._prepare_slepc_runtime_probe()
        artifacts = self.root / "artifacts-invalid-json"
        artifacts.mkdir()
        probe = entrypoint.subprocess.CompletedProcess(
            [str(runtime_bin)],
            0,
            b"not-json",
            b"probe completed\n",
        )
        with patch.object(entrypoint.subprocess, "run", return_value=probe), patch.object(
            entrypoint.os, "access", return_value=True
        ):
            with self.assertRaisesRegex(
                entrypoint.BuildEntryPointError,
                "returned invalid JSON",
            ):
                entrypoint._attest_slepc_runtime(
                    self.workspace,
                    artifacts,
                    {"FULLMAG_CARGO_TARGET_DIR": str(cargo_target)},
                    self._identity(),
                    entrypoint._runtime_contract(
                        entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                    ),
                )
        state = json.loads(
            (artifacts / "logs" / "slepc-runtime-availability.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(state["status"], "exited_zero")
        self.assertEqual(state["scope"], "subprocess_execution")
        self.assertEqual(state["validation"], "not_assessed")
        self.assertEqual(state["return_code"], 0)
        self.assertFalse((artifacts / "runtime-attestation.json").exists())

    def test_slepc_runtime_probe_records_nonzero_output(self) -> None:
        runtime_bin, cargo_target = self._prepare_slepc_runtime_probe()
        artifacts = self.root / "artifacts-nonzero"
        artifacts.mkdir()
        probe = entrypoint.subprocess.CompletedProcess(
            [str(runtime_bin)],
            17,
            b"partial-json",
            "native failure\n",
        )
        with patch.object(entrypoint.subprocess, "run", return_value=probe), patch.object(
            entrypoint.os, "access", return_value=True
        ):
            with self.assertRaisesRegex(
                entrypoint.BuildEntryPointError,
                "availability probe exited 17",
            ):
                entrypoint._attest_slepc_runtime(
                    self.workspace,
                    artifacts,
                    {"FULLMAG_CARGO_TARGET_DIR": str(cargo_target)},
                    self._identity(),
                    entrypoint._runtime_contract(
                        entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                    ),
                )
        state = json.loads(
            (artifacts / "logs" / "slepc-runtime-availability.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(state["status"], "nonzero")
        self.assertEqual(state["return_code"], 17)
        self.assertEqual(
            (artifacts / "logs" / "slepc-runtime-availability.stdout.log").read_text(
                encoding="utf-8"
            ),
            "partial-json",
        )
        self.assertEqual(
            (artifacts / "logs" / "slepc-runtime-availability.stderr.log").read_text(
                encoding="utf-8"
            ),
            "native failure\n",
        )

    def test_slepc_runtime_probe_records_timeout_bytes_and_text_bounded(self) -> None:
        runtime_bin, cargo_target = self._prepare_slepc_runtime_probe()
        cases = (
            (
                "bytes",
                b"x" * (entrypoint.SLEPC_PROBE_OUTPUT_LIMIT + 32),
                b"timeout-bytes",
            ),
            ("text", "timeout-text", "stderr-text"),
        )
        for label, stdout, stderr in cases:
            with self.subTest(label=label):
                artifacts = self.root / f"artifacts-timeout-{label}"
                artifacts.mkdir()
                timeout = entrypoint.subprocess.TimeoutExpired(
                    [str(runtime_bin)],
                    entrypoint.SLEPC_PROBE_TIMEOUT_SECONDS,
                    output=stdout,
                    stderr=stderr,
                )
                with patch.object(
                    entrypoint.subprocess,
                    "run",
                    side_effect=timeout,
                ), patch.object(entrypoint.os, "access", return_value=True):
                    with self.assertRaisesRegex(
                        entrypoint.BuildEntryPointError,
                        "availability probe timed out",
                    ):
                        entrypoint._attest_slepc_runtime(
                            self.workspace,
                            artifacts,
                            {"FULLMAG_CARGO_TARGET_DIR": str(cargo_target)},
                            self._identity(),
                            entrypoint._runtime_contract(
                                entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                            ),
                        )
                state = json.loads(
                    (artifacts / "logs" / "slepc-runtime-availability.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(state["status"], "timeout")
                self.assertIsNone(state["return_code"])
                stdout_log = (
                    artifacts / "logs" / "slepc-runtime-availability.stdout.log"
                ).read_text(encoding="utf-8")
                stderr_log = (
                    artifacts / "logs" / "slepc-runtime-availability.stderr.log"
                ).read_text(encoding="utf-8")
                self.assertLessEqual(
                    (artifacts / "logs" / "slepc-runtime-availability.stdout.log").stat().st_size,
                    entrypoint.SLEPC_PROBE_OUTPUT_LIMIT,
                )
                if label == "bytes":
                    self.assertTrue(state["stdout_truncated"])
                    self.assertIn("output truncated", stdout_log)
                    self.assertEqual(state["stdout_bytes"], entrypoint.SLEPC_PROBE_OUTPUT_LIMIT + 32)
                else:
                    self.assertFalse(state["stdout_truncated"])
                    self.assertEqual(stdout_log, "timeout-text")
                    self.assertEqual(stderr_log, "stderr-text")

    def test_slepc_runtime_probe_records_unavailable_oserror(self) -> None:
        runtime_bin, cargo_target = self._prepare_slepc_runtime_probe()
        artifacts = self.root / "artifacts-unavailable"
        artifacts.mkdir()
        with patch.object(
            entrypoint.subprocess,
            "run",
            side_effect=OSError("executable unavailable"),
        ), patch.object(entrypoint.os, "access", return_value=True):
            with self.assertRaisesRegex(
                entrypoint.BuildEntryPointError,
                "availability probe unavailable",
            ):
                entrypoint._attest_slepc_runtime(
                    self.workspace,
                    artifacts,
                    {"FULLMAG_CARGO_TARGET_DIR": str(cargo_target)},
                    self._identity(),
                    entrypoint._runtime_contract(
                        entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                    ),
                )
        state = json.loads(
            (artifacts / "logs" / "slepc-runtime-availability.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(state["status"], "unavailable")
        self.assertIsNone(state["return_code"])
        self.assertIn("OSError", state["error"])
        self.assertEqual(state["stdout_bytes"], 0)
        self.assertEqual(state["stderr_bytes"], 0)
        self.assertEqual(
            (artifacts / "logs" / "slepc-runtime-availability.stdout.log").read_text(
                encoding="utf-8"
            ),
            "",
        )
        self.assertEqual(
            (artifacts / "logs" / "slepc-runtime-availability.stderr.log").read_text(
                encoding="utf-8"
            ),
            "",
        )

    def test_cpu_attestation_uses_library_path_at_process_start(self) -> None:
        environment = {"LD_LIBRARY_PATH": "/opt/fullmag-mfem-cpu/lib"}
        result = entrypoint.subprocess.CompletedProcess([], 0, "", "")
        with patch.object(entrypoint.subprocess, "run", return_value=result) as run, \
             patch.object(entrypoint.ctypes, "CDLL", side_effect=AssertionError("parent loader must not load FEM")):
            entrypoint._attest_slepc_runtime(
                self.workspace, self.artifacts, environment, self._identity(),
                entrypoint._runtime_contract(entrypoint.profile_for("fem-cpu-slepc-runtime-v2")))
        command = run.call_args.args[0]
        self.assertEqual(command[-1], "--attest-slepc-runtime")
        child_env = run.call_args.kwargs["env"]
        self.assertEqual(child_env["LD_LIBRARY_PATH"].split(entrypoint.os.pathsep),
                         [str(self.workspace / ".fullmag/local/lib"), "/opt/fullmag-mfem-cpu/lib"])
        self.assertEqual(environment, {"LD_LIBRARY_PATH": "/opt/fullmag-mfem-cpu/lib"})
        payload = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(payload["native_identity"], self._identity())
        self.assertEqual(payload["runtime_contract"]["schema"], "fullmag.fem.cpu.slepc_runtime_contract.v2")

    def test_cpu_attestation_propagates_child_linkage_failure(self) -> None:
        result = entrypoint.subprocess.CompletedProcess([], 2, "", "libmfem.so.4.10.0 unavailable")
        with patch.object(entrypoint.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "libmfem.so.4.10.0"):
                entrypoint._attest_slepc_runtime(
                    self.workspace, self.artifacts, {"LD_LIBRARY_PATH": "/opt/fullmag-mfem-cpu/lib"},
                    self._identity(), entrypoint._runtime_contract(entrypoint.profile_for("fem-cpu-slepc-runtime-v2")))

    def test_cpu_attestation_child_runs_original_gates_with_startup_environment(self) -> None:
        import io
        payload = {"workspace": str(self.workspace), "artifacts": str(self.artifacts),
                   "native_identity": self._identity(), "runtime_contract":
                   entrypoint._runtime_contract(entrypoint.profile_for("fem-cpu-slepc-runtime-v2"))}
        environment = {"LD_LIBRARY_PATH": "/opt/fullmag-mfem-cpu/lib"}
        with patch.object(entrypoint.sys, "stdin", io.StringIO(json.dumps(payload))), \
             patch.dict(entrypoint.os.environ, environment, clear=True), \
             patch.object(entrypoint, "_attest_slepc_runtime_in_process") as query:
            self.assertEqual(entrypoint.main(["--attest-slepc-runtime"]), 0)
        query.assert_called_once_with(self.workspace, self.artifacts, environment,
                                      self._identity(), payload["runtime_contract"])
        with patch.object(entrypoint.sys, "stdin", io.StringIO(json.dumps(payload))), \
             patch.object(entrypoint.sys, "stderr", io.StringIO()) as stderr, \
             patch.object(entrypoint, "_attest_slepc_runtime_in_process",
                          side_effect=entrypoint.BuildEntryPointError("MFEM version mismatch")):
            self.assertEqual(entrypoint.main(["--attest-slepc-runtime"]), 2)
            self.assertIn("MFEM version mismatch", stderr.getvalue())
        payload["runtime_contract"]["schema"] = "legacy"
        with patch.object(entrypoint.sys, "stdin", io.StringIO(json.dumps(payload))), \
             patch.object(entrypoint.sys, "stderr", io.StringIO()), \
             patch.object(entrypoint, "_attest_slepc_runtime_in_process") as query:
            self.assertEqual(entrypoint.main(["--attest-slepc-runtime"]), 2)
            query.assert_not_called()

    def test_cpu_attestation_timeout_retains_partial_logs(self) -> None:
        error = entrypoint.subprocess.TimeoutExpired("query", 240,
                                                     output=b"partial output", stderr=b"partial error")
        with patch.object(entrypoint.subprocess, "run", side_effect=error):
            with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "subprocess unavailable"):
                entrypoint._attest_slepc_runtime(
                    self.workspace, self.artifacts, {"LD_LIBRARY_PATH": "/opt/fullmag-mfem-cpu/lib"},
                    self._identity(), entrypoint._runtime_contract(entrypoint.profile_for("fem-cpu-slepc-runtime-v2")))
        self.assertEqual((self.artifacts / "logs/slepc-runtime-attestation.stdout.log").read_bytes(),
                         b"partial output")
        self.assertEqual((self.artifacts / "logs/slepc-runtime-attestation.stderr.log").read_bytes(),
                         b"partial error")

    def test_cpu_modal_attestation_never_preloads_a_cuda_driver(self) -> None:
        with patch.object(entrypoint, "_cuda_driver_compatibility_paths") as paths, \
             patch.object(entrypoint, "_preload_cuda_driver_compatibility_libraries") as preload:
            self.assertEqual(entrypoint._modal_driver_compatibility(True), ((), ()))
            paths.assert_not_called()
            preload.assert_not_called()
            paths.return_value = ("/usr/local/cuda/compat",)
            preload.return_value = ("/usr/local/cuda/compat/libcuda.so.1",)
            self.assertEqual(entrypoint._modal_driver_compatibility(False),
                             (paths.return_value, preload.return_value))
            preload.assert_called_once_with(paths.return_value)

    def test_cuda_driver_compatibility_helper_requires_loadable_soname(self) -> None:
        compatibility = self.root / "cuda" / "compat"
        compatibility.mkdir(parents=True)
        (compatibility / "libcuda.so.1").write_bytes(b"driver")
        missing = self.root / "missing"

        self.assertEqual(
            entrypoint._cuda_driver_compatibility_paths((compatibility, missing)),
            (str(compatibility),),
        )

    def _write_mfem_installation(
        self,
        *,
        header_version: tuple[int, int, int] = (4, 10, 0),
        cmake_version: str = "4.10.0",
    ) -> tuple[Path, Path, Path]:
        prefix = self.root / "mfem-cpu"
        header = prefix / "include" / "mfem" / "config" / "config.hpp"
        header.parent.mkdir(parents=True)
        header.write_text(
            '#include "_config.hpp"\n',
            encoding="utf-8",
        )
        encoded_version = (
            header_version[0] * 10000
            + header_version[1] * 100
            + header_version[2]
        )
        (header.parent / "_config.hpp").write_text(
            "\n".join(
                (
                    f"#define MFEM_VERSION {encoded_version}",
                    f'#define MFEM_VERSION_STRING "{header_version[0]}.{header_version[1]}.{header_version[2]}"',
                    "#define MFEM_VERSION_MAJOR ((MFEM_VERSION)/10000)",
                    "#define MFEM_VERSION_MINOR (((MFEM_VERSION)/100)%100)",
                    "#define MFEM_VERSION_PATCH ((MFEM_VERSION)%100)",
                )
            )
            + "\n",
            encoding="utf-8",
        )
        cmake_dir = prefix / "lib" / "cmake" / "mfem"
        cmake_dir.mkdir(parents=True)
        version_file = cmake_dir / "MFEMConfigVersion.cmake"
        version_file.write_text(
            f'set(PACKAGE_VERSION "{cmake_version}")\n', encoding="utf-8"
        )
        library = prefix / "lib" / "libmfem.so.4.10.0"
        library.write_bytes(b"mfem")
        return cmake_dir, header, library

    def test_mfem_abi_attestation_records_observed_header_cmake_and_loaded_versions(self) -> None:
        cmake_dir, header, library = self._write_mfem_installation()
        observed = entrypoint._observe_mfem_abi(
            {"path": str(library), "sha256": hashlib.sha256(library.read_bytes()).hexdigest()},
            str(cmake_dir),
            "4.10",
            prefix=self.root / "mfem-cpu",
        )

        self.assertEqual(observed["version"], "4.10")
        self.assertEqual(observed["version_sources"]["header"]["version"], "4.10.0")
        self.assertEqual(observed["version_sources"]["header"]["path"], str(header))
        self.assertEqual(observed["version_sources"]["cmake"]["version"], "4.10.0")
        self.assertEqual(observed["version_sources"]["loaded_library"]["version"], "4.10")

    def test_mfem_abi_attestation_rejects_version_disagreement(self) -> None:
        cmake_dir, _, library = self._write_mfem_installation()
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "MFEM version mismatch"):
            entrypoint._observe_mfem_abi(
                {"path": str(library), "sha256": hashlib.sha256(library.read_bytes()).hexdigest()},
                str(cmake_dir),
                "4.9",
                prefix=self.root / "mfem-cpu",
            )

    def test_mfem_abi_attestation_rejects_header_and_cmake_disagreement(self) -> None:
        cmake_dir, _, library = self._write_mfem_installation(cmake_version="4.9.0")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "MFEM version mismatch"):
            entrypoint._observe_mfem_abi(
                {"path": str(library), "sha256": hashlib.sha256(library.read_bytes()).hexdigest()},
                str(cmake_dir),
                "4.10",
                prefix=self.root / "mfem-cpu",
            )

    def test_mfem_header_rejects_encoded_and_string_version_disagreement(self) -> None:
        cmake_dir, header, library = self._write_mfem_installation()
        header.with_name("_config.hpp").write_text(
            '#define MFEM_VERSION 41000\n'
            '#define MFEM_VERSION_STRING "4.9.0"\n',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(
            entrypoint.BuildEntryPointError,
            "header version sources disagree",
        ):
            entrypoint._observe_mfem_abi(
                {"path": str(library), "sha256": hashlib.sha256(library.read_bytes()).hexdigest()},
                str(cmake_dir),
                "4.10",
                prefix=self.root / "mfem-cpu",
            )

    def test_loaded_mfem_version_reads_runtime_build_info_v2(self) -> None:
        class Query:
            argtypes: object
            restype: object

            def __call__(self, pointer: object) -> int:
                info = pointer._obj  # type: ignore[attr-defined]
                info.abi_version = 2
                info.struct_size = entrypoint.ctypes.sizeof(info)
                info.mfem_version = b"4.10"
                info.hypre_version = b"2.31.0"
                return 0

        class Library:
            fullmag_fem_get_runtime_build_info_v2 = Query()

        self.assertEqual(
            entrypoint._loaded_mfem_version(
                Library(),
                lambda value: bytes(value).split(b"\x00", 1)[0].decode("utf-8"),
            ),
            "4.10",
        )

    def test_loaded_mfem_version_rejects_wrong_runtime_build_info_abi(self) -> None:
        class Query:
            argtypes: object
            restype: object

            def __call__(self, pointer: object) -> int:
                info = pointer._obj  # type: ignore[attr-defined]
                info.abi_version = 1
                info.struct_size = entrypoint.ctypes.sizeof(info)
                info.mfem_version = b"4.10"
                return 0

        class Library:
            fullmag_fem_get_runtime_build_info_v2 = Query()

        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "ABI v2"):
            entrypoint._loaded_mfem_version(
                Library(),
                lambda value: bytes(value).split(b"\x00", 1)[0].decode("utf-8"),
            )

    def test_slepc_runtime_probe_rejects_unavailable_native_fem(self) -> None:
        output = self.workspace / ".fullmag" / "local"
        runtime_bin = output / "bin" / "fullmag-bin"
        runtime_library = output / "lib" / "libfullmag_fem.so.0"
        runtime_bin.parent.mkdir(parents=True)
        runtime_library.parent.mkdir(parents=True)
        runtime_bin.write_bytes(b"binary")
        runtime_library.write_bytes(b"library")
        cargo_target = self.build / "cargo-targets" / "fem-cpu"
        cmake_cache = (
            cargo_target
            / "release"
            / "build"
            / "fullmag-fem-sys"
            / "abc123"
            / "out"
            / "native-build"
            / "CMakeCache.txt"
        )
        cmake_cache.parent.mkdir(parents=True)
        cmake_cache.write_text(
            "FULLMAG_ENABLE_CUDA:BOOL=ON\n"
            "FULLMAG_ENABLE_FEM_GPU:BOOL=ON\n"
            "FULLMAG_USE_MFEM_STACK:BOOL=ON\n"
            "FULLMAG_FEM_WITH_SLEPC:BOOL=ON\n",
            encoding="utf-8",
        )
        native_library = cmake_cache.parent / "backends" / "fem" / "libfullmag_fem.so.0"
        native_library.parent.mkdir(parents=True)
        native_library.write_bytes(b"library")
        probe = entrypoint.subprocess.CompletedProcess(
            [str(runtime_bin)],
            0,
            '{"native_fem_cpu_available": false}',
            "[fullmag] build: test | source snapshot: "
            + str(self._identity()["source_snapshot_sha256"])
            + "\n",
        )
        with patch.object(
            entrypoint.subprocess,
            "run",
            return_value=probe,
        ), patch.object(
            entrypoint.os,
            "access",
            return_value=True,
        ):
            with self.assertRaisesRegex(
                entrypoint.BuildEntryPointError,
                "native FEM CPU availability",
            ):
                entrypoint._attest_slepc_runtime(
                    self.workspace,
                    self.artifacts,
                    {"FULLMAG_CARGO_TARGET_DIR": str(cargo_target)},
                    self._identity(),
                    entrypoint._runtime_contract(
                        entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                    ),
                )

    def test_slepc_runtime_probe_rejects_stale_source_snapshot(self) -> None:
        output = self.workspace / ".fullmag" / "local"
        runtime_bin = output / "bin" / "fullmag-bin"
        runtime_library = output / "lib" / "libfullmag_fem.so.0"
        runtime_bin.parent.mkdir(parents=True)
        runtime_library.parent.mkdir(parents=True)
        runtime_bin.write_bytes(b"binary")
        runtime_library.write_bytes(b"library")
        cargo_target = self.build / "cargo-targets" / "fem-cpu"
        cmake_cache = (
            cargo_target
            / "release"
            / "build"
            / "fullmag-fem-sys"
            / "abc123"
            / "out"
            / "native-build"
            / "CMakeCache.txt"
        )
        cmake_cache.parent.mkdir(parents=True)
        cmake_cache.write_text(
            "FULLMAG_ENABLE_CUDA:BOOL=ON\n"
            "FULLMAG_ENABLE_FEM_GPU:BOOL=ON\n"
            "FULLMAG_USE_MFEM_STACK:BOOL=ON\n"
            "FULLMAG_FEM_WITH_SLEPC:BOOL=ON\n",
            encoding="utf-8",
        )
        native_library = cmake_cache.parent / "backends" / "fem" / "libfullmag_fem.so.0"
        native_library.parent.mkdir(parents=True)
        native_library.write_bytes(b"library")
        stale_snapshot = "0" * 64
        probe = entrypoint.subprocess.CompletedProcess(
            [str(runtime_bin)],
            0,
            '{"native_fem_cpu_available": true}',
            "[fullmag] build: test | source snapshot: " + stale_snapshot + "\n",
        )
        with patch.object(
            entrypoint.subprocess,
            "run",
            return_value=probe,
        ), patch.object(
            entrypoint.os,
            "access",
            return_value=True,
        ):
            with self.assertRaisesRegex(
                entrypoint.BuildEntryPointError,
                "does not match the native source identity",
            ):
                entrypoint._attest_slepc_runtime(
                    self.workspace,
                    self.artifacts,
                    {"FULLMAG_CARGO_TARGET_DIR": str(cargo_target)},
                    self._identity(),
                    entrypoint._runtime_contract(
                        entrypoint.profile_for("fem-cpu-slepc-runtime-v1")
                    ),
                )
    def test_slepc_modal_contract_script_is_explicit_and_unescaped(self) -> None:
        script = Path(__file__).with_name("run_fem_cpu_slepc_modal_contract.sh").read_text(encoding="utf-8")
        self.assertNotIn(r"\${", script)
        self.assertNotIn(r"\$(", script)
        self.assertNotIn("rm -rf", script)
        self.assertIn("runtime fem-availability --json", script)
        self.assertIn("fullmag_fem_get_frequency_domain_dependency_info", script)
        self.assertIn("CMakeCache.txt", script)
        self.assertIn("source snapshot:", script)
        self.assertIn("--output-junit", script)
        self.assertIn("testcase_count", script)
        self.assertIn("skipped_count", script)
        self.assertIn("/usr/local/cuda/compat", script)
        modal_test = Path(__file__).resolve().parents[1] / "backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp"
        modal_source = modal_test.read_text(encoding="utf-8")
        self.assertIn("PETSC_USE_REAL_DOUBLE", modal_source)
        self.assertIn("sizeof(PetscReal) == sizeof(double)", modal_source)
        for option in (
            "-DFULLMAG_ENABLE_CUDA=ON",
            "-DFULLMAG_ENABLE_FEM_GPU=OFF",
            "-DFULLMAG_USE_MFEM_STACK=ON",
            "-DFULLMAG_FEM_WITH_SLEPC=ON",
            "--no-tests=error",
        ):
            self.assertIn(option, script)
        for target in (
            "fem_poisson_airbox_modal_eigen_slepc_contract",
            "fem_floquet_magnetic_operator_contract",
            "fem_floquet_bloch_scalar_contract",
            "fem_floquet_airbox_operator_contract",
            "fem_floquet_dynamic_demag_k_contract",
            "fem_floquet_waveguide_demag_k_contract",
            "fem_floquet_waveguide_cross_section_contract",
            "fem_floquet_modal_solver_contract",
            "fem_poisson_airbox_shared_domain_contract",
        ):
            self.assertIn(target, script)

    def test_slepc_modal_profile_runs_fixed_contract_and_publishes_result(self) -> None:
        self.profile = "fem-cpu-slepc-modal-v1"
        context = self._write_context()
        calls: list[tuple[str, list[str]]] = []

        def contract_stage(name, command, *, workspace, artifacts, environment):
            calls.append((name, command))
            if name == "native-build":
                self._write_outputs(include_fem_library=True, include_web=False)
            self.assertEqual(
                environment["FULLMAG_FEM_SLEPC_MODAL_BUILD_ROOT"],
                str(self.build / "fem-slepc-modal"),
            )
            self.assertEqual(
                environment["FULLMAG_FEM_SLEPC_MODAL_REPORT_ROOT"],
                str(self.artifacts / "contracts"),
            )
            result_path = artifacts / "contracts" / "slepc-modal" / "result.json"
            result_path.parent.mkdir(parents=True, exist_ok=True)
            result_path.write_text(
                json.dumps(
                    {
                        "schema": "fullmag.fem.cpu.slepc_modal_contract_result.v1",
                        "scenario": "slepc-modal",
                        "status": "pass",
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
                            "ctest_completed": True,
                            "executed_targets": [
                                "fem_poisson_airbox_modal_eigen_slepc_contract",
                                "fem_floquet_magnetic_operator_contract",
                                "fem_floquet_bloch_scalar_contract",
                                "fem_floquet_airbox_operator_contract",
                                "fem_floquet_dynamic_demag_k_contract",
                                "fem_floquet_waveguide_demag_k_contract",
                                "fem_floquet_waveguide_cross_section_contract",
                                "fem_floquet_modal_solver_contract",
                                "fem_poisson_airbox_shared_domain_contract",
                            ],
                            "modal_target": "fem_poisson_airbox_modal_eigen_slepc_contract",
                            "shared_domain_target": "fem_poisson_airbox_shared_domain_contract",
                            "floquet_targets": [
                                "fem_floquet_magnetic_operator_contract",
                                "fem_floquet_bloch_scalar_contract",
                                "fem_floquet_airbox_operator_contract",
                                "fem_floquet_dynamic_demag_k_contract",
                                "fem_floquet_waveguide_demag_k_contract",
                                "fem_floquet_waveguide_cross_section_contract",
                                "fem_floquet_modal_solver_contract",
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
                                    "fem_floquet_magnetic_operator_contract",
                                    "fem_floquet_bloch_scalar_contract",
                                    "fem_floquet_airbox_operator_contract",
                                    "fem_floquet_dynamic_demag_k_contract",
                                    "fem_floquet_waveguide_demag_k_contract",
                                    "fem_floquet_waveguide_cross_section_contract",
                                    "fem_floquet_modal_solver_contract",
                                    "fem_poisson_airbox_shared_domain_contract",
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
                                    "diagnostics": {"native_source_snapshot_sha256": self._identity()["source_snapshot_sha256"]},
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
                ),
                encoding="utf-8",
            )
            logs = artifacts / "logs"
            logs.mkdir(exist_ok=True)
            (logs / f"{name}.stdout.log").write_text("pass\n", encoding="utf-8")
            (logs / f"{name}.stderr.log").write_text("", encoding="utf-8")
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 0,
                "stdout_log": f"logs/{name}.stdout.log",
                "stderr_log": f"logs/{name}.stderr.log",
                "stdout_tail": "pass",
                "stderr_tail": "",
            }

        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "bash": "/usr/bin/bash"},
        ), patch.object(
            entrypoint,
            "toolchain_versions",
            return_value={},
        ), patch.object(
            entrypoint,
            "run_stage",
            side_effect=contract_stage,
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 0)
        self.assertFalse(
            (self.workspace / ".fullmag" / "local" / "web").exists(),
            "headless SLEPc profile must not require or create web output",
        )
        self.assertEqual(
            calls,
            [
                (
                    "native-build",
                    ["/usr/bin/make", "install-cli-dev"],
                ),
                (
                    "contract-slepc-modal",
                    [
                        "/usr/bin/bash",
                        "scripts/run_fem_cpu_slepc_modal_contract.sh",
                        "slepc-modal",
                    ],
                )
            ],
        )
        receipt = json.loads(
            (self.artifacts / "build-receipt.json").read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["state"], "succeeded")
        self.assertEqual(receipt["contract_scenarios"], ["slepc-modal"])
        self.assertEqual(
            receipt["contract_schema"],
            "fullmag.fem.cpu.slepc_modal_contract_result.v1",
        )
        self.assertEqual(
            json.loads((self.artifacts / "source-identity.json").read_text(encoding="utf-8")),
            self._identity(),
        )
        self.assertIn(
            "outputs/.fullmag/local/lib/libfullmag_fem.so.0",
            {entry["path"] for entry in receipt["artifacts"]},
        )
        self.assertEqual(receipt["qualification"], "NOT VERIFIED")

    def test_slepc_modal_zero_exit_without_result_is_failure(self) -> None:
        self.profile = "fem-cpu-slepc-modal-v1"
        context = self._write_context()
        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "bash": "/usr/bin/bash"},
        ), patch.object(
            entrypoint,
            "toolchain_versions",
            return_value={},
        ), patch.object(
            entrypoint,
            "run_stage",
            return_value={"name": "contract-slepc-modal", "exit_code": 0},
        ):
            self.assertEqual(entrypoint.main(self._argv(context)), 2)
        receipt = json.loads(
            (self.artifacts / "build-receipt.json").read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["state"], "failed")
        self.assertIn("missing contract receipt", receipt["error"])

    def test_rust_inventory_and_versions_do_not_sync_project_override(self) -> None:
        installed = entrypoint.subprocess.CompletedProcess(
            ["/usr/bin/rustup", "run", "nightly", "rustc", "--version"], 0,
            "rustc 1.101.0-nightly (test fixture)\n", "")
        with patch.object(entrypoint.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), \
             patch.object(entrypoint.subprocess, "run", return_value=installed) as run, \
             patch.object(entrypoint, "require_cpu_modal_dependencies") as dependencies:
            entrypoint.preflight(entrypoint.profile_for("fem-cpu-slepc-runtime-v2"), release=False)
            dependencies.assert_called_once_with(Path("/opt/fullmag-mfem-cpu"))
            self.assertEqual(
                run.call_args.args[0],
                ["/usr/bin/rustup", "run", "nightly", "rustc", "--version"],
            )
            environment = run.call_args.kwargs.get("env", {})
            self.assertEqual(environment.get("RUSTUP_TOOLCHAIN"), "nightly")
            self.assertEqual(environment.get("RUSTUP_AUTO_INSTALL"), "0")
            entrypoint._command_version(["/usr/bin/rustc", "--version"])
            environment = run.call_args.kwargs.get("env", {})
            self.assertEqual(environment.get("RUSTUP_TOOLCHAIN"), "nightly")
            self.assertEqual(environment.get("RUSTUP_AUTO_INSTALL"), "0")

    def test_build_environment_pins_offline_nightly(self) -> None:
        environment = entrypoint.build_environment(
            entrypoint.profile_for(self.profile), workspace=self.workspace,
            build=self.build, jobs=2, native_identity=self._identity())
        self.assertEqual(environment.get("RUSTUP_TOOLCHAIN"), "nightly")
        self.assertEqual(environment.get("RUSTUP_AUTO_INSTALL"), "0")

    def test_materialization_refreshes_source_mtimes_for_persistent_build_caches(self) -> None:
        old_ns = 1_600_000_000_000_000_000
        cached_artifact_ns = old_ns + 10_000_000_000
        source_file = self.source / "tree" / "README.txt"
        nested = self.source / "tree" / "nested"
        nested.mkdir()
        nested_file = nested / "input.txt"
        nested_file.write_bytes(b"new input with old timestamp\n")
        entrypoint.os.utime(source_file, ns=(old_ns, old_ns))
        entrypoint.os.utime(nested_file, ns=(old_ns, old_ns))
        content = nested_file.read_bytes()
        manifest = {**self.manifest, "files": [*self.manifest["files"], {
            "path": "nested/input.txt", "type": "file", "mode": "100644",
            "size": len(content), "sha256": hashlib.sha256(content).hexdigest(),
        }]}

        entrypoint.materialize_capsule(manifest, self.source, self.workspace)

        for relative in ("README.txt", "nested/input.txt"):
            with self.subTest(path=relative):
                original = self.source / "tree" / relative
                copied = self.workspace / relative
                self.assertEqual(original.stat().st_mtime_ns, old_ns)
                self.assertEqual(copied.read_bytes(), original.read_bytes())
                self.assertGreater(copied.stat().st_mtime_ns, cached_artifact_ns)

    def test_preflight_requires_an_installed_nightly_toolchain(self) -> None:
        with patch.object(
            entrypoint.shutil,
            "which",
            side_effect=lambda name: f"/usr/bin/{name}",
        ), patch.object(
            entrypoint.subprocess,
            "run",
            return_value=entrypoint.subprocess.CompletedProcess(
                ["rustup", "run", "nightly", "rustc", "--version"],
                0, "rustc 1.99.0 (stable)\n", ""
            ),
        ):
            with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "nightly"):
                entrypoint.preflight(entrypoint.profile_for("fdm-cpu-release"), release=False)
        # A fresh host gets an operator-actionable remedy, but the trusted
        # runner must not turn a build into an implicit network/bootstrap step.
        with patch.object(
            entrypoint.shutil,
            "which",
            side_effect=lambda name: f"/usr/bin/{name}",
        ), patch.object(
            entrypoint.subprocess,
            "run",
            return_value=entrypoint.subprocess.CompletedProcess(
                ["rustup", "run", "nightly", "rustc", "--version"],
                1, "toolchain nightly is not installed\n", ""
            ),
        ):
            with self.assertRaisesRegex(
                entrypoint.BuildEntryPointError,
                r"rustup toolchain install nightly.*never downloads",
            ):
                entrypoint.preflight(entrypoint.profile_for("fdm-cpu-release"), release=False)

    def test_preflight_probes_the_exact_installed_channel_without_install(self) -> None:
        with patch.object(entrypoint.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), patch.object(
            entrypoint.subprocess, "run",
            return_value=entrypoint.subprocess.CompletedProcess(
                [], 0, "rustc 1.101.0-nightly (0abfedbc7 2026-10-02)\n", ""
            ),
        ) as run:
            entrypoint.preflight(entrypoint.profile_for("fdm-cpu-release"), release=False)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], [
            "/usr/bin/rustup", "run", "nightly", "rustc", "--version",
        ])
        self.assertEqual(run.call_args.kwargs["timeout"], 30)
        self.assertEqual(run.call_args.kwargs["stdin"], entrypoint.subprocess.DEVNULL)

    def test_receipt_observes_nightly_even_when_source_selects_stable(self) -> None:
        # A source override must never be queried by the receipt probes.
        (self.workspace / "rust-toolchain.toml").write_text(
            '[toolchain]\nchannel = "stable"\n', encoding="utf-8"
        )
        tools = {name: f"/usr/bin/{name}" for name in ("rustup", "rustc", "cargo", "make")}
        with patch.object(entrypoint, "_command_version", side_effect=lambda command: {
            "command": command, "exit_code": 0, "output": "installed tool version",
        }):
            versions = entrypoint.toolchain_versions(tools)
        for name in ("rustc", "cargo"):
            self.assertEqual(versions[name]["command"], [
                tools["rustup"], "run", "nightly", name, "--version",
            ])

    def test_failed_nightly_receipt_probe_is_not_accepted_as_build_evidence(self) -> None:
        tools = {name: name for name in ("rustup", "rustc", "cargo", "make")}
        for failed_tool in ("rustc", "cargo"):
            with self.subTest(failed_tool=failed_tool):
                def probe(command):
                    failed = command[1:4] == ["run", "nightly", failed_tool]
                    return {"command": command, "exit_code": 1 if failed else 0, "output": "probe"}
                with patch.object(entrypoint, "_command_version", side_effect=probe):
                    with self.assertRaisesRegex(entrypoint.BuildEntryPointError, failed_tool):
                        entrypoint.toolchain_versions(tools)

    def test_context_keeps_capsule_digest_separate_from_native_v2_identity(self) -> None:
        context_path = self._write_context()
        context = entrypoint.load_context(
            context_path,
            job_id=self.job_id,
            source_digest=self.source_digest,
            profile=self.profile,
        )
        self.assertEqual(
            context["native_source_identity"]["source_snapshot_sha256"],
            self._identity()["source_snapshot_sha256"],
        )

    def test_native_identity_accepts_sha256_git_commits(self) -> None:
        identity = self._identity()
        identity['head_commit_full'] = 'a' * 64
        payload = dict(identity)
        for key in ('source_snapshot_dirty', 'dirty_content_sha256', 'source_snapshot_sha256'):
            payload.pop(key, None)
        identity['source_snapshot_sha256'] = hashlib.sha256(entrypoint.canonical(payload)).hexdigest()
        self.assertEqual(identity, entrypoint._validate_native_identity(identity))

    def test_build_environment_excludes_ambient_credentials_and_command_overrides(self) -> None:
        ambient = {'PATH': '/tools/bin', 'CMAKE_PREFIX_PATH': '/opt/deps',
                   'GITHUB_TOKEN': 'private', 'HTTPS_PROXY': 'credential',
                   'DOCKER_HOST': 'remote', 'MAKEFLAGS': '--eval=unexpected',
                   'RUSTFLAGS': 'unexpected', 'BASH_ENV': '/injected'}
        with patch.dict(entrypoint.os.environ, ambient, clear=True):
            environment = entrypoint.build_environment(
                entrypoint.profile_for(self.profile), workspace=self.workspace,
                build=self.build, jobs=2, native_identity=self._identity())
        self.assertEqual('/tools/bin', environment['PATH'])
        self.assertEqual('/opt/deps', environment['CMAKE_PREFIX_PATH'])
        for key in set(ambient) - {'PATH', 'CMAKE_PREFIX_PATH'}:
            self.assertNotIn(key, environment)

    def test_context_rejects_tampered_native_v2_self_hash(self) -> None:
        context_path = self._write_context()
        context = json.loads(context_path.read_text(encoding="utf-8"))
        context["native_source_identity"]["head_tree_sha256"] = "4" * 64
        context_path.write_text(json.dumps(context), encoding="utf-8")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "does not match"):
            entrypoint.load_context(
                context_path,
                job_id=self.job_id,
                source_digest=self.source_digest,
                profile=self.profile,
            )

    def test_materialization_preserves_mode_and_does_not_create_git(self) -> None:
        original = self.source / "tree" / "README.txt"
        entrypoint.os.utime(original, (1000, 1000))
        manifest = entrypoint.verify_source(self.source, self.source_digest)
        entrypoint.materialize_capsule(manifest, self.source, self.workspace)
        source_mode = stat.S_IMODE((self.source / "tree" / "README.txt").stat().st_mode)
        target_mode = stat.S_IMODE((self.workspace / "README.txt").stat().st_mode)
        if entrypoint.os.name != "nt":
            self.assertEqual(target_mode, 0o755)
        self.assertEqual((self.workspace / "README.txt").read_text(encoding="utf-8"), "immutable source\n")
        self.assertFalse((self.workspace / ".git").exists())
        self.assertGreater((self.workspace / "README.txt").stat().st_mtime, 1000)
        self.assertEqual(original.stat().st_mtime, 1000)

    def test_materialization_makes_private_dirs_writable_without_changing_capsule(self) -> None:
        nested = self.source / "tree" / "readonly" / "nested"
        nested.mkdir(parents=True)
        nested_file = nested / "input.txt"
        nested_file.write_text("nested immutable input\n", encoding="utf-8")
        if entrypoint.os.name != "nt":
            (self.source / "tree" / "readonly").chmod(0o555)
            nested.chmod(0o555)
        nested_bytes = nested_file.read_bytes()
        files = list(self.manifest["files"])
        files.append(
            {
                "path": "readonly/nested/input.txt",
                "type": "file",
                "mode": "100644",
                "size": len(nested_bytes),
                "sha256": hashlib.sha256(nested_bytes).hexdigest(),
            }
        )
        manifest = {**self.manifest, "files": files}
        source_modes = {
            path: stat.S_IMODE(path.stat().st_mode)
            for path in (self.source / "tree" / "readonly", nested, nested_file)
        }
        mount_modes = {
            path: stat.S_IMODE(path.stat().st_mode)
            for path in (
                self.workspace / ".fullmag-build",
                self.workspace / ".fullmag-cargo",
                self.workspace / ".fullmag-rustup",
            )
        }
        if entrypoint.os.name != "nt":
            self.workspace.chmod(0o555)

        entrypoint.materialize_capsule(manifest, self.source, self.workspace)

        copied_root = self.workspace / "readonly"
        copied_nested = copied_root / "nested"
        if entrypoint.os.name != "nt":
            self.assertTrue(stat.S_IMODE(copied_root.stat().st_mode) & stat.S_IWUSR)
            self.assertTrue(stat.S_IMODE(copied_nested.stat().st_mode) & stat.S_IWUSR)
            self.assertTrue(
                stat.S_IMODE(self.workspace.stat().st_mode) & stat.S_IWUSR,
                "private workspace root must be owner-writable",
            )
            for path, mode in source_modes.items():
                self.assertEqual(mode, stat.S_IMODE(path.stat().st_mode))
            for path, mode in mount_modes.items():
                self.assertEqual(mode, stat.S_IMODE(path.stat().st_mode))
        self.assertEqual(nested_bytes, (copied_nested / "input.txt").read_bytes())

    def test_tail_text_reads_only_a_bounded_suffix(self) -> None:
        log = self.root / "large.log"
        log.write_text("a" * 10000 + "TAIL", encoding="utf-8")
        suffix = entrypoint._tail_text(log)
        self.assertEqual(len(suffix), 1024)
        self.assertTrue(suffix.endswith("TAIL"))

    def test_runtime_outputs_dereference_internal_library_links_only(self) -> None:
        output = self._write_outputs()
        library = output / "lib" / "libfullmag.so.1.0"
        library.write_bytes(b"library")
        try:
            (output / "lib" / "libfullmag.so.1").symlink_to(library.name)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlinks unavailable: {error}")
        destination_root = self.artifacts / "outputs" / ".fullmag" / "local"
        entrypoint._copy_outputs(self.workspace, self.artifacts)
        copied_link = destination_root / "lib" / "libfullmag.so.1"
        self.assertTrue(copied_link.is_file())
        self.assertFalse(copied_link.is_symlink())
        self.assertEqual(copied_link.read_bytes(), b"library")
        self.assertFalse((destination_root / "cache").exists())

    def test_runtime_outputs_reject_symlink_into_venv(self) -> None:
        output = self._write_outputs()
        venv = output / ".venv"
        venv.mkdir()
        (venv / "secret").write_bytes(b"secret")
        try:
            (output / "lib" / "secret.so").symlink_to(Path("..") / ".venv" / "secret")
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlinks unavailable: {error}")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "escapes output"):
            entrypoint._copy_outputs(self.workspace, self.artifacts)

    def test_workspace_allows_only_persistent_mountpoints(self) -> None:
        (self.workspace / ".fullmag-cargo" / "registry-cache").write_text("cache")
        entrypoint._workspace_is_empty(self.workspace)
        (self.workspace / "unexpected.txt").write_text("not a mount")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "workspace must be empty"):
            entrypoint._workspace_is_empty(self.workspace)

    def test_missing_native_identity_fails_and_publishes_receipt(self) -> None:
        context = self._write_context(include_identity=False)
        code = entrypoint.main(self._argv(context))
        self.assertEqual(code, 2)
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["qualification"], "NOT VERIFIED")
        self.assertIn("native_source_identity", receipt["error"])

    def test_success_runs_only_managed_fixed_stages_and_publishes_receipt(self) -> None:
        context = self._write_context()
        calls: list[tuple[str, list[str]]] = []

        def fake_stage(name, command, *, workspace, artifacts, environment):
            calls.append((name, command))
            if name == "native-build":
                self._write_outputs()
            logs = artifacts / "logs"
            logs.mkdir(exist_ok=True)
            (logs / f"{name}.stdout.log").write_text("ok\n", encoding="utf-8")
            (logs / f"{name}.stderr.log").write_text("", encoding="utf-8")
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 0,
                "stdout_log": f"logs/{name}.stdout.log",
                "stderr_log": f"logs/{name}.stderr.log",
                "stdout_tail": "ok",
                "stderr_tail": "",
            }

        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "pnpm": "/usr/bin/pnpm"},
        ), patch.object(entrypoint, "toolchain_versions", return_value={"make": {}}), patch.object(
            entrypoint, "run_stage", side_effect=fake_stage
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 0)
        self.assertEqual(
            calls,
            [
                ("native-build", ["/usr/bin/make", "install-cli-dev"]),
                (
                    "frontend-dependencies",
                    ["/usr/bin/pnpm", "install", "--dir", "apps/control-room", "--frozen-lockfile"],
                ),
                ("frontend-build", ["/usr/bin/make", "web-build-static"]),
            ],
        )
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "succeeded")
        self.assertEqual(receipt["source_digest"], self.source_digest)
        self.assertEqual(receipt["source_digest_kind"], "capsule")
        self.assertEqual(
            receipt["native_source_identity"]["source_snapshot_sha256"],
            self._identity()["source_snapshot_sha256"],
        )
        self.assertEqual(receipt["qualification"], "NOT VERIFIED")
        self.assertNotIn(".git", {path.name for path in self.workspace.iterdir()})

    def test_successful_commands_without_required_outputs_fail_receipt(self) -> None:
        context = self._write_context()

        def fake_stage(name, command, *, workspace, artifacts, environment):
            logs = artifacts / "logs"
            logs.mkdir(exist_ok=True)
            (logs / f"{name}.stdout.log").write_text("ok\n", encoding="utf-8")
            (logs / f"{name}.stderr.log").write_text("", encoding="utf-8")
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 0,
                "stdout_log": f"logs/{name}.stdout.log",
                "stderr_log": f"logs/{name}.stderr.log",
                "stdout_tail": "ok",
                "stderr_tail": "",
            }

        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "pnpm": "/usr/bin/pnpm"},
        ), patch.object(entrypoint, "toolchain_versions", return_value={}), patch.object(
            entrypoint, "run_stage", side_effect=fake_stage
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 2)
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "failed")
        self.assertIn("required Fullmag output is missing", receipt["error"])

    def test_failed_stage_keeps_failed_receipt_and_does_not_continue(self) -> None:
        context = self._write_context()
        calls: list[str] = []

        def failing_stage(name, command, *, workspace, artifacts, environment):
            calls.append(name)
            logs = artifacts / "logs"
            logs.mkdir(exist_ok=True)
            (logs / f"{name}.stdout.log").write_text("failed\n", encoding="utf-8")
            (logs / f"{name}.stderr.log").write_text("error\n", encoding="utf-8")
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 17,
                "stdout_log": f"logs/{name}.stdout.log",
                "stderr_log": f"logs/{name}.stderr.log",
                "stdout_tail": "failed",
                "stderr_tail": "error",
            }

        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "pnpm": "/usr/bin/pnpm"},
        ), patch.object(entrypoint, "toolchain_versions", return_value={}), patch.object(
            entrypoint, "run_stage", side_effect=failing_stage
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 2)
        self.assertEqual(calls, ["native-build"])
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["stages"][0]["exit_code"], 17)
        self.assertIn("managed stage failed", receipt["error"])


if __name__ == "__main__":
    unittest.main()
