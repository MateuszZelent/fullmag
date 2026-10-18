#!/usr/bin/env python3
"""Focused interpreted checks for the FEM/GPU dependency manifest writer."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


WRITER_PATH = Path(__file__).resolve().parents[1] / "docker" / "fem-gpu" / "write_dependency_versions.py"
SPEC = importlib.util.spec_from_file_location("fullmag_write_dependency_versions", WRITER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - protects an invalid checkout
    raise ImportError(f"cannot load dependency manifest writer: {WRITER_PATH}")
WRITER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = WRITER
SPEC.loader.exec_module(WRITER)


SYNTHETIC_COMMITS = {
    "mfem": "a" * 40,
    "libceed": "b" * 40,
    "hypre": "c" * 40,
    "petsc": "d" * 40,
    "slepc": "e" * 40,
    "umpire": "f" * 40,
}


def _source_environment(*, variant: str = "baseline") -> dict[str, str]:
    environment = {"FULLMAG_HYPRE_MEMORY_VARIANT": variant}
    for name, _ref_env, commit_env, _relative, _optional in WRITER.SOURCE_SPECS:
        environment[commit_env] = SYNTHETIC_COMMITS[name]
    return environment


class SourceCommitChecks(unittest.TestCase):
    def _source_root(self, root: Path, *, include_umpire: bool = False) -> Path:
        for name, _ref_env, _commit_env, relative, optional in WRITER.SOURCE_SPECS:
            if optional and not include_umpire:
                continue
            (root / relative).mkdir(parents=True, exist_ok=True)
        return root

    def _commit_reader(self, path: Path) -> str:
        name = "libceed" if path.name == "libCEED" else path.name
        return SYNTHETIC_COMMITS[name]

    def test_verified_source_commit_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-dependency-pins-") as directory:
            source_root = self._source_root(Path(directory), include_umpire=True)
            wrong_commit = "1" * 40
            environment = _source_environment()
            environment["MFEM_SOURCE_COMMIT"] = wrong_commit
            with mock.patch.dict(os.environ, environment, clear=True):
                with mock.patch.object(WRITER, "_commit", side_effect=self._commit_reader):
                    with self.assertRaisesRegex(RuntimeError, "mfem source commit mismatch"):
                        WRITER._source_commits(source_root, required=True)

    def test_missing_required_source_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-dependency-source-") as directory:
            source_root = self._source_root(Path(directory), include_umpire=True)
            (source_root / "petsc").rmdir()
            with mock.patch.dict(os.environ, _source_environment(), clear=True):
                with mock.patch.object(WRITER, "_commit", side_effect=self._commit_reader):
                    with self.assertRaisesRegex(RuntimeError, "dependency source tree is missing"):
                        WRITER._source_commits(source_root, required=True)

    def test_baseline_without_optional_umpire_source_records_null(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-dependency-baseline-") as directory:
            source_root = self._source_root(Path(directory), include_umpire=False)
            with mock.patch.dict(os.environ, _source_environment(), clear=True):
                with mock.patch.object(WRITER, "_commit", side_effect=self._commit_reader):
                    commits = WRITER._source_commits(source_root, required=True)
        expected = dict(SYNTHETIC_COMMITS)
        expected["umpire"] = None
        self.assertEqual(commits, expected)


class BaseImagePinChecks(unittest.TestCase):
    def _base_image(self, reference: str, digest: str = "") -> dict[str, str | None]:
        with mock.patch.dict(
            os.environ,
            {
                "FULLMAG_CUDA_BASE_IMAGE": reference,
                "FULLMAG_CUDA_BASE_IMAGE_DIGEST": digest,
            },
            clear=True,
        ):
            return WRITER._base_image()

    def test_tag_without_digest_is_explicitly_unresolved(self) -> None:
        value = self._base_image("registry.invalid/fullmag/cuda:synthetic")
        self.assertEqual(
            value,
            {"reference": "registry.invalid/fullmag/cuda:synthetic", "digest": None},
        )

    def test_tag_plus_digest_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "requires FULLMAG_CUDA_BASE_IMAGE to use"):
            self._base_image("registry.invalid/fullmag/cuda:synthetic", "a" * 64)

    def test_mismatched_digest_is_rejected(self) -> None:
        reference = "registry.invalid/fullmag/cuda:synthetic@sha256:" + "a" * 64
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            self._base_image(reference, "b" * 64)

    def test_matching_digest_is_accepted(self) -> None:
        digest = "c" * 64
        reference = "registry.invalid/fullmag/cuda:synthetic@sha256:" + digest
        self.assertEqual(
            self._base_image(reference, "sha256:" + digest),
            {"reference": reference, "digest": digest},
        )


class RuntimeAugmentationChecks(unittest.TestCase):
    def test_runtime_augmentation_preserves_existing_source_commits(self) -> None:
        source_commits = dict(SYNTHETIC_COMMITS)
        source_commits["umpire"] = None
        manifest = {
            "schema": WRITER.SCHEMA,
            "declared": {"base_image": {"reference": "old", "digest": None}},
            "actual": {"source_commits": source_commits, "tool_versions": {"old": "kept"}},
            "latest": {"status": "not-queried"},
            "build": {"phase": "deps"},
        }
        with tempfile.TemporaryDirectory(prefix="fullmag-dependency-runtime-") as directory:
            output = Path(directory) / "dependency-versions.json"
            output.write_text(json.dumps(manifest), encoding="utf-8")
            environment = {
                "FULLMAG_CUDA_BASE_IMAGE": "registry.invalid/fullmag/cuda:synthetic",
                "FULLMAG_CUDA_BASE_IMAGE_DIGEST": "",
                "CMAKE_VERSION": "synthetic-cmake",
                "NODE_VERSION": "synthetic-node",
                "PYTHON_VERSION": "synthetic-python",
                "PNPM_VERSION": "synthetic-pnpm",
                "RUST_TOOLCHAIN": "synthetic-rust",
            }
            with mock.patch.dict(os.environ, environment, clear=True):
                with mock.patch.object(
                    WRITER,
                    "_tool_versions",
                    return_value={"python": "synthetic-python-runtime"},
                ):
                    with mock.patch.object(
                        sys,
                        "argv",
                        [
                            str(WRITER_PATH),
                            "--phase",
                            "runtime",
                            "--output",
                            str(output),
                        ],
                    ):
                        self.assertEqual(WRITER.main(), 0)
            augmented = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(augmented["actual"]["source_commits"], source_commits)
        self.assertEqual(augmented["actual"]["tool_versions"], {"python": "synthetic-python-runtime"})
        self.assertEqual(augmented["build"], {"phase": "runtime"})
        self.assertEqual(augmented["declared"]["base_image"], {
            "reference": "registry.invalid/fullmag/cuda:synthetic",
            "digest": None,
        })


if __name__ == "__main__":
    unittest.main()
