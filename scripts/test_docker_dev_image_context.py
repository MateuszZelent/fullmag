#!/usr/bin/env python3
"""Focused regressions for direct Docker development-image admission."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_ROOT.parent
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

import docker_dev  # noqa: E402


class RuntimeImageContextTests(unittest.TestCase):
    def _copy_runtime_context(self, destination: Path) -> None:
        for _name, relative_source in docker_dev.RUNTIME_IMAGE_CONTEXT_FILES:
            source = REPO_ROOT / relative_source
            target = destination / relative_source
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def _image_document(self, toolchain_id: str) -> dict[str, object]:
        return {
            "Config": {
                "Labels": {
                    "org.fullmag.runtime": "docker-all-gpu-v1",
                    "org.fullmag.development": "source-bind-v1",
                    "org.fullmag.toolchain.image-id": toolchain_id,
                },
            },
        }

    def test_backend_helper_change_changes_runtime_context_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            self._copy_runtime_context(checkout)

            before = docker_dev._runtime_image_context(checkout)
            backend_helper = checkout / "docker/all-in-one/backend_dev.py"
            backend_helper.write_bytes(backend_helper.read_bytes() + b"\n# context regression\n")
            after = docker_dev._runtime_image_context(checkout)

        self.assertNotEqual(before["context_sha256"], after["context_sha256"])
        self.assertNotEqual(
            before["files"]["backend_dev.py"],
            after["files"]["backend_dev.py"],
        )

    def test_stale_backend_context_receipt_is_rejected(self) -> None:
        image_id = "sha256:" + "a" * 64
        toolchain_id = "sha256:" + "b" * 64
        stale_receipt = {
            "image_id": image_id,
            "toolchain_image_id": toolchain_id,
            "base_image_id": "sha256:" + "c" * 64,
            "context_sha256": "current-base-context",
            "backend_context_sha256": "old-backend-context",
            "runtime_context_sha256": "old-runtime-context",
        }

        with patch.object(
            docker_dev,
            "_inspect_image",
            return_value=(image_id, self._image_document(toolchain_id)),
        ), patch.object(docker_dev, "_image_file", return_value=b"backend"), patch.object(
            docker_dev,
            "_read_image_metadata",
            return_value=stale_receipt,
        ):
            with self.assertRaises(docker_dev.DirectDockerError):
                docker_dev._validate_runtime_image(
                    "fullmag/fullmag-dev:direct-runtime",
                    toolchain_id,
                    {},
                    "current-base-context",
                    "sha256:" + "c" * 64,
                    expected_backend_context_sha256="new-backend-context",
                    expected_runtime_context_sha256="new-runtime-context",
                )

    def test_cold_build_without_receipt_is_not_reusable(self) -> None:
        image_id = "sha256:" + "e" * 64
        toolchain_id = "sha256:" + "f" * 64
        image = "fullmag/fullmag-dev:direct-runtime-cold"

        with patch.object(
            docker_dev,
            "_inspect_image",
            return_value=(image_id, self._image_document(toolchain_id)),
        ), patch.object(docker_dev, "_image_file", return_value=b"backend"), patch.object(
            docker_dev,
            "_read_image_metadata",
            return_value=None,
        ):
            docker_dev._validate_runtime_image(
                image,
                toolchain_id,
                {},
                None,
                image_id,
                require_receipt=False,
            )
            with self.assertRaises(docker_dev.DirectDockerError):
                docker_dev._validate_runtime_image(
                    image,
                    toolchain_id,
                    {},
                    None,
                    image_id,
                )


class BackendBuildReceiptProfileTests(unittest.TestCase):
    def test_build_profile_aliases_are_explicit(self):
        self.assertEqual(docker_dev._cargo_profile_for_build("dev"), "backend-dev")
        self.assertEqual(docker_dev._cargo_profile_for_build("release"), "release")
        with self.assertRaises(docker_dev.DirectDockerError):
            docker_dev._cargo_profile_for_build("backend-dev")

    def test_build_parser_defaults_to_dev_and_accepts_release(self):
        self.assertEqual(docker_dev._parser().parse_args(["build"]).profile, "dev")
        self.assertEqual(
            docker_dev._parser().parse_args(["up", "--profile", "release"]).profile,
            "release",
        )

    @staticmethod
    def _fixture(profile="backend-dev", target_profile_dir=None):
        temporary = tempfile.TemporaryDirectory()
        package = Path(temporary.name) / "package"
        package.mkdir()
        source_bundle = {
            "source_digest": "d" * 64,
            "resolved_commit": "e" * 40,
            "archive_sha256": "f" * 64,
            "native_source_identity": {
                "head_commit_full": "e" * 40,
                "source_snapshot_dirty": False,
                "source_snapshot_sha256": "a" * 64,
            },
        }
        toolchain_id = "sha256:" + "1" * 64
        receipt = {
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "state": "succeeded",
            "operation": "direct-compose-build",
            "source": {
                "source_digest": source_bundle["source_digest"],
                "resolved_commit": source_bundle["resolved_commit"],
                "source_tar_sha256": source_bundle["archive_sha256"],
            },
            "native_source_identity": source_bundle["native_source_identity"],
            "toolchain": {"image_id": toolchain_id},
            "execution_lanes": {
                lane: {"status": "compiled"} for lane in docker_dev.REQUIRED_LANES
            },
            "build": {
                "cargo_profile": profile,
                "cargo_target_profile_dir": target_profile_dir or profile,
            },
        }
        (package / "backend-build-receipt.json").write_bytes(
            json.dumps(receipt, sort_keys=True).encode("utf-8")
        )
        return temporary, package, source_bundle, toolchain_id

    def test_backend_dev_profile_is_required_by_prepare_receipt(self):
        temporary, package, source_bundle, toolchain_id = self._fixture()
        try:
            receipt, raw = docker_dev._validate_prepare_receipt(
                package, source_bundle, toolchain_id, "backend-dev"
            )
            self.assertEqual(receipt["build"]["cargo_profile"], "backend-dev")
            self.assertEqual(receipt["build"]["cargo_target_profile_dir"], "backend-dev")
            self.assertTrue(raw)
        finally:
            temporary.cleanup()

    def test_release_profile_is_accepted_when_requested(self):
        temporary, package, source_bundle, toolchain_id = self._fixture(
            profile="release", target_profile_dir="release"
        )
        try:
            receipt, raw = docker_dev._validate_prepare_receipt(
                package, source_bundle, toolchain_id, "release"
            )
            self.assertEqual(receipt["build"]["cargo_profile"], "release")
            self.assertTrue(raw)
        finally:
            temporary.cleanup()

    def test_release_profile_is_rejected_when_dev_was_requested(self):
        temporary, package, source_bundle, toolchain_id = self._fixture(
            profile="release", target_profile_dir="release"
        )
        try:
            with self.assertRaisesRegex(
                docker_dev.DirectDockerError, "backend-dev cargo profile"
            ):
                docker_dev._validate_prepare_receipt(
                    package, source_bundle, toolchain_id, "backend-dev"
                )
        finally:
            temporary.cleanup()

    def test_mismatched_profile_directory_is_rejected_by_prepare_receipt(self):
        temporary, package, source_bundle, toolchain_id = self._fixture(
            profile="backend-dev", target_profile_dir="release"
        )
        try:
            with self.assertRaisesRegex(
                docker_dev.DirectDockerError, "backend-dev cargo profile"
            ):
                docker_dev._validate_prepare_receipt(
                    package, source_bundle, toolchain_id, "backend-dev"
                )
        finally:
            temporary.cleanup()


class DevelopmentBaseContextTests(unittest.TestCase):
    def _copy_base_context(self, destination: Path) -> None:
        for _name, relative_source in docker_dev.BASE_CONTEXT_FILES:
            source = REPO_ROOT / relative_source
            target = destination / relative_source
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def _context(self, root: Path, toolchain_id: str) -> dict[str, object]:
        manifest_sha256 = "m" * 64
        helper_hashes: dict[str, str] = {}
        identity = {
            "schema": docker_dev.DEVELOPMENT_BASE_CONTEXT_SCHEMA,
            "toolchain_image_id": toolchain_id,
            "toolchain_manifest_sha256": manifest_sha256,
            "files": helper_hashes,
        }
        return {
            "root": str(root),
            "toolchain_image_id": toolchain_id,
            "context_sha256": docker_dev._sha256_bytes(docker_dev._canonical_json(identity)),
            "toolchain_manifest_sha256": manifest_sha256,
            "helper_hashes": helper_hashes,
        }

    def _base(self, reference: str, image_id: str, toolchain_id: str,
              context: dict[str, object]) -> dict[str, object]:
        return {
            "reference": reference,
            "image_id": image_id,
            "labels": {
                "org.fullmag.runtime": "docker-all-gpu-v1",
                "org.fullmag.development": "source-bind-v1",
                "org.fullmag.toolchain.image-id": toolchain_id,
                "org.fullmag.direct-development.context-sha256": context["context_sha256"],
            },
            "toolchain_image_id": toolchain_id,
            "toolchain_manifest": {"schema": docker_dev.TOOLCHAIN_MANIFEST_SCHEMA},
            "toolchain_manifest_sha256": context["toolchain_manifest_sha256"],
            "context_sha256": context["context_sha256"],
            "built": False,
        }

    def test_frontend_helper_change_changes_development_base_context_digest(self) -> None:
        toolchain_id = "sha256:" + "0" * 64
        manifest = {"schema": docker_dev.TOOLCHAIN_MANIFEST_SCHEMA}
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary) / "checkout"
            checkout.mkdir()
            self._copy_base_context(checkout)
            first = docker_dev._development_base_context(
                checkout, Path(temporary) / "first", toolchain_id, manifest,
            )
            frontend_helper = checkout / "docker/all-in-one/frontend_dev.py"
            frontend_helper.write_bytes(frontend_helper.read_bytes() + b"\n# context regression\n")
            second = docker_dev._development_base_context(
                checkout, Path(temporary) / "second", toolchain_id, manifest,
            )

        self.assertNotEqual(first["context_sha256"], second["context_sha256"])
        self.assertNotEqual(
            first["helper_hashes"]["frontend_dev.py"],
            second["helper_hashes"]["frontend_dev.py"],
        )

    def test_stale_requested_base_derives_current_context_from_selected_toolchain(self) -> None:
        toolchain_id = "sha256:" + "1" * 64
        old_base_id = "sha256:" + "2" * 64
        new_base_id = "sha256:" + "3" * 64
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_root = root / "run"
            context_root = root / "context"
            run_root.mkdir()
            context_root.mkdir()
            context = self._context(context_root, toolchain_id)
            requested = docker_dev.DEFAULT_BASE_IMAGE
            derived = docker_dev._direct_image_tag(
                requested, "base", str(context["context_sha256"]),
            )
            stale_context = {**context, "context_sha256": "old-context"}
            old_base = self._base(requested, old_base_id, toolchain_id, stale_context)
            old_base["context_sha256"] = "old-context"
            current_base = self._base(derived, new_base_id, toolchain_id, context)
            metadata = {
                "schema": docker_dev.DEVELOPMENT_IMAGE_SCHEMA,
                "kind": "development-base",
                "image_id": new_base_id,
                "base_image_id": toolchain_id,
                "toolchain_image_id": toolchain_id,
                "toolchain_manifest_sha256": context["toolchain_manifest_sha256"],
                "context_sha256": context["context_sha256"],
                "context": context,
            }
            inspect_document = {
                "Config": {
                    "Labels": {
                        "org.fullmag.runtime": "docker-all-gpu-v1",
                        "org.fullmag.development": "source-bind-v1",
                        "org.fullmag.toolchain.image-id": toolchain_id,
                    },
                },
            }
            inspect_calls: list[str] = []

            def inspect(reference: str):
                inspect_calls.append(reference)
                if reference == toolchain_id or reference.startswith("fullmag/direct-toolchain:"):
                    return toolchain_id, inspect_document
                if reference == requested:
                    return old_base_id, inspect_document
                if reference == derived:
                    return new_base_id, inspect_document
                raise AssertionError(reference)

            def image_present(reference: str) -> bool:
                return reference in {requested, derived}

            with patch.object(docker_dev, "_inspect_image", side_effect=inspect), \
                    patch.object(docker_dev, "_preflight_dependency_image", return_value=(
                        {"schema": docker_dev.TOOLCHAIN_MANIFEST_SCHEMA},
                        context["toolchain_manifest_sha256"],
                    )), \
                    patch.object(docker_dev, "_development_base_context", return_value=context), \
                    patch.object(
                        docker_dev, "_image_reference_present", side_effect=image_present
                    ), \
                    patch.object(docker_dev, "_validate_development_base",
                                 side_effect=lambda reference, **_kwargs:
                                 {requested: old_base, derived: current_base}[reference]), \
                    patch.object(
                        docker_dev,
                        "_read_image_metadata",
                        side_effect=lambda _layout, reference: (
                            None if reference == requested else metadata
                        ),
                    ), \
                    patch.object(docker_dev, "_docker_capture", return_value="") as docker_capture, \
                    patch.object(docker_dev, "_write_image_metadata"):
                result = docker_dev._ensure_development_base(
                    argparse.Namespace(toolchain_image=toolchain_id),
                    root,
                    {"storage_root": str(root), "build_storage_root": str(root)},
                    run_root,
                )

            self.assertIs(result, current_base)
            self.assertEqual(result["context_sha256"], context["context_sha256"])
            self.assertEqual(
                [call.args[:2] for call in docker_capture.call_args_list],
                [("tag", toolchain_id)],
            )

    def test_matching_requested_base_receipt_is_reused(self) -> None:
        toolchain_id = "sha256:" + "4" * 64
        base_id = "sha256:" + "5" * 64
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_root = root / "run"
            context_root = root / "context"
            run_root.mkdir()
            context_root.mkdir()
            context = self._context(context_root, toolchain_id)
            requested = docker_dev.DEFAULT_BASE_IMAGE
            base = self._base(requested, base_id, toolchain_id, context)
            metadata = {
                "schema": docker_dev.DEVELOPMENT_IMAGE_SCHEMA,
                "kind": "development-base",
                "image_id": base_id,
                "base_image_id": toolchain_id,
                "toolchain_image_id": toolchain_id,
                "toolchain_manifest_sha256": context["toolchain_manifest_sha256"],
                "context_sha256": context["context_sha256"],
                "context": context,
            }
            with patch.object(
                    docker_dev, "_inspect_image", return_value=(toolchain_id, {"Config": {}})), \
                    patch.object(docker_dev, "_preflight_dependency_image", return_value=(
                        {"schema": docker_dev.TOOLCHAIN_MANIFEST_SCHEMA},
                        context["toolchain_manifest_sha256"],
                    )), \
                    patch.object(docker_dev, "_development_base_context", return_value=context), \
                    patch.object(docker_dev, "_image_reference_present", return_value=True), \
                    patch.object(docker_dev, "_validate_development_base", return_value=base), \
                    patch.object(docker_dev, "_read_image_metadata", return_value=metadata), \
                    patch.object(docker_dev, "_docker_capture") as docker_capture, \
                    patch.object(docker_dev, "_docker_live") as docker_live:
                result = docker_dev._ensure_development_base(
                    argparse.Namespace(toolchain_image=toolchain_id),
                    root,
                    {"storage_root": str(root), "build_storage_root": str(root)},
                    run_root,
                )

            self.assertIs(result, base)
            self.assertFalse(result["built"])
            docker_capture.assert_not_called()
            docker_live.assert_not_called()


if __name__ == "__main__":
    unittest.main()
