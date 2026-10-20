"""Regression checks for the hash-bound installer legal inventory."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import zipfile
from pathlib import Path
import unittest


HELPER_PATH = Path(__file__).with_name("generate_third_party_notices.py")
SPEC = importlib.util.spec_from_file_location("fullmag_third_party_notices", HELPER_PATH)
assert SPEC is not None and SPEC.loader is not None
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _archive(path: Path, members: dict[str, bytes]) -> str:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return _sha256(path.read_bytes())


def _request(notice: Path, archive: Path, archive_sha256: str, **archive_fields):
    return {
        "schema": "fullmag.windows-installer-legal-input.v1",
        "root_notice": {
            "path": str(notice),
            "sha256": _sha256(notice.read_bytes()),
        },
        "archives": [
            {
                "kind": "nuget",
                "id": "Synthetic.Package",
                "version": "1.2.3",
                "path": str(archive),
                "sha256": archive_sha256,
                **archive_fields,
            }
        ],
    }


class ThirdPartyNoticesTests(unittest.TestCase):
    def test_exact_archive_generates_package_mapping_and_notice_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(
                archive,
                {
                    "LICENSE.txt": b"Synthetic license\n",
                    "NOTICE.md": b"Synthetic notice\n",
                    "Synthetic.Package.nuspec": b'<license type="expression">MIT</license>',
                },
            )

            notices, inventory = HELPER.generate(_request(notice, archive, archive_sha256))

            self.assertIn("Synthetic.Package 1.2.3", notices)
            self.assertIn("Synthetic license", notices)
            self.assertIn("Synthetic notice", notices)
            self.assertEqual(inventory["schema"], "fullmag.windows-installer-third-party-inventory.v1")
            self.assertEqual(inventory["root_notice"]["sha256"], _sha256(notice.read_bytes()))
            self.assertEqual(len(inventory["archives"]), 1)
            self.assertEqual(len(inventory["archives"][0]["legal_files"]), 2)
            self.assertEqual(inventory["archives"][0]["archive_sha256"], archive_sha256)

    def test_tampered_archive_fails_closed_against_expected_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            expected_sha256 = _archive(archive, {"LICENSE.txt": b"Synthetic license\n"})
            archive.write_bytes(archive.read_bytes() + b"tampered")

            with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                HELPER.generate(_request(notice, archive, expected_sha256))

            self.assertIn("archive_sha256_mismatch", str(failure.exception))

    def test_archive_without_delivered_license_text_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(
                archive,
                {
                    "Synthetic.Package.nuspec": (
                        b'<package><metadata><id>Synthetic.Package</id><version>1.2.3</version>'
                        b'<license type="expression">MIT</license>'
                        b'<repository type="git" url="https://github.com/AvaloniaUI/Avalonia.git" '
                        b'commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" /></metadata></package>'
                    )
                },
            )

            with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                HELPER.generate(_request(notice, archive, archive_sha256))

            self.assertIn("missing_legal_text", str(failure.exception))
            self.assertNotIn("MIT", str(failure.exception))

    def test_form_feed_is_preserved_in_upstream_legal_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(archive, {"NOTICE.txt": b"Copyright\x0c2026\n"})

            notices, inventory = HELPER.generate(_request(notice, archive, archive_sha256))

            self.assertIn("Copyright\x0c2026", notices)
            self.assertEqual(
                inventory["archives"][0]["legal_files"][0]["text_sha256"],
                _sha256("Copyright\x0c2026\n".encode("utf-8")),
            )

    def test_expression_only_package_uses_hash_bound_upstream_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(
                archive,
                {
                    "Synthetic.Package.nuspec": (
                        b'<package><metadata><id>Synthetic.Package</id><version>1.2.3</version>'
                        b'<license type="expression">MIT</license>'
                        b'<repository type="git" url="https://github.com/AvaloniaUI/Avalonia.git" '
                        b'commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" /></metadata></package>'
                    )
                },
            )
            fallback_path = root / "Avalonia-LICENSE"
            fallback_bytes = b"Upstream license\n"
            fallback_path.write_bytes(fallback_bytes)
            request = _request(
                notice,
                archive,
                archive_sha256,
                fallback_license={
                    "path": str(fallback_path),
                    "sha256": _sha256(fallback_bytes),
                    "repository": "AvaloniaUI/Avalonia",
                    "commit": "a" * 40,
                    "source_file": "LICENSE",
                    "source_url": "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/LICENSE",
                    "license_expression": "MIT",
                },
            )
            request["fallback_manifest"] = {
                "schema": "fullmag.windows-installer-license-fallbacks.v1",
                "filename": "scripts/windows/installer/third_party_license_fallbacks.json",
                "sha256": "b" * 64,
            }

            notices, inventory = HELPER.generate(request)

            self.assertIn("Upstream license", notices)
            self.assertIn("License source repository: AvaloniaUI/Avalonia", notices)
            self.assertEqual(
                inventory["archives"][0]["legal_files"][0]["source"]["commit"],
                "a" * 40,
            )
            self.assertEqual(inventory["fallback_manifest"]["sha256"], "b" * 64)

    def test_fallback_requires_expression_nuspec_and_manifest_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            fallback_path = root / "LICENSE"
            fallback_bytes = b"Upstream license\n"
            fallback_path.write_bytes(fallback_bytes)
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(archive, {"README.txt": b"no expression\n"})
            request = _request(
                notice,
                archive,
                archive_sha256,
                fallback_license={
                    "path": str(fallback_path),
                    "sha256": _sha256(fallback_bytes),
                    "repository": "AvaloniaUI/Avalonia",
                    "commit": "a" * 40,
                    "source_file": "LICENSE",
                    "source_url": "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/LICENSE",
                    "license_expression": "MIT",
                },
            )
            with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                HELPER.generate(request)
            self.assertIn("no fallback_manifest", str(failure.exception))

    def test_fallback_rejects_metadata_and_source_mapping_mismatches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            fallback_path = root / "Avalonia-LICENSE"
            fallback_bytes = b"Upstream license\n"
            fallback_path.write_bytes(fallback_bytes)
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            cases = {
                "id": ("Other.Package", "1.2.3", "MIT", "AvaloniaUI/Avalonia", "a" * 40,
                       "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/LICENSE",
                       "nuspec_identity_mismatch"),
                "version": ("Synthetic.Package", "9.9.9", "MIT", "AvaloniaUI/Avalonia", "a" * 40,
                            "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/LICENSE",
                            "nuspec_identity_mismatch"),
                "expression": ("Synthetic.Package", "1.2.3", "Apache-2.0", "AvaloniaUI/Avalonia", "a" * 40,
                               "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/LICENSE",
                               "nuspec_license_expression_mismatch"),
                "repository": ("Synthetic.Package", "1.2.3", "MIT", "Other/Repo", "a" * 40,
                               "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/LICENSE",
                               "nuspec_repository_mapping_mismatch"),
                "commit": ("Synthetic.Package", "1.2.3", "MIT", "AvaloniaUI/Avalonia", "b" * 40,
                           "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/LICENSE",
                           "nuspec_repository_mapping_mismatch"),
                "source_url": ("Synthetic.Package", "1.2.3", "MIT", "AvaloniaUI/Avalonia", "a" * 40,
                               "https://raw.githubusercontent.com/AvaloniaUI/Avalonia/" + "a" * 40 + "/COPYING",
                               "invalid_fallback_license"),
            }
            for case, (package_id, version, expression, nuspec_repository, nuspec_commit, source_url, expected) in cases.items():
                with self.subTest(case=case):
                    nuspec = (
                        f'<package><metadata><id>{package_id}</id><version>{version}</version>'
                        f'<license type="expression">{expression}</license>'
                        f'<repository type="git" url="https://github.com/{nuspec_repository}.git" '
                        f'commit="{nuspec_commit}" /></metadata></package>'
                    ).encode("utf-8")
                    archive_sha256 = _archive(archive, {"Synthetic.Package.nuspec": nuspec})
                    request = _request(
                        notice,
                        archive,
                        archive_sha256,
                        fallback_license={
                            "path": str(fallback_path),
                            "sha256": _sha256(fallback_bytes),
                            "repository": "AvaloniaUI/Avalonia",
                            "commit": "a" * 40,
                            "source_file": "LICENSE",
                            "source_url": source_url,
                            "license_expression": "MIT",
                        },
                    )
                    request["fallback_manifest"] = {
                        "schema": "fullmag.windows-installer-license-fallbacks.v1",
                        "filename": "scripts/windows/installer/third_party_license_fallbacks.json",
                        "sha256": "b" * 64,
                    }

                    with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                        HELPER.generate(request)

                    self.assertIn(expected, str(failure.exception))

    def test_required_member_hash_is_bound_to_the_exact_archive_member(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "wix314-binaries.zip"
            archive_sha256 = _archive(archive, {"LICENSE.TXT": b"WiX license\n"})

            request = _request(
                notice,
                archive,
                archive_sha256,
                kind="wix",
                id="WiXToolset.WiX",
                version="3.14.1",
                required_member_sha256=_sha256(b"different license\n"),
            )
            with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                HELPER.generate(request)

            self.assertIn("required_member_hash_mismatch", str(failure.exception))

    def test_casefold_duplicate_archive_members_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(
                archive,
                {"LICENSE.txt": b"one\n", "license.txt": b"two\n"},
            )

            with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                HELPER.generate(_request(notice, archive, archive_sha256))

            self.assertIn("duplicate_archive_member", str(failure.exception))

    def test_cli_records_raw_input_manifest_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(archive, {"LICENSE.txt": b"Synthetic license\n"})
            request = _request(notice, archive, archive_sha256)
            request_path = root / "request.json"
            request_bytes = (json.dumps(request, indent=2) + "\n").encode("utf-8")
            request_path.write_bytes(request_bytes)
            notices_path = root / "THIRD_PARTY_NOTICES"
            inventory_path = root / "THIRD_PARTY_NOTICES.json"

            exit_code = HELPER.main(
                [
                    "--request",
                    str(request_path),
                    "--notices-output",
                    str(notices_path),
                    "--inventory-output",
                    str(inventory_path),
                    "--input-manifest-sha256",
                    _sha256(request_bytes),
                ]
            )

            self.assertEqual(exit_code, 0)
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            self.assertEqual(inventory["input_manifest_sha256"], _sha256(request_bytes))

    def test_archive_symlink_is_rejected_before_legal_file_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notice = root / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            archive = root / "Synthetic.Package.1.2.3.nupkg"
            with zipfile.ZipFile(archive, "w") as container:
                info = zipfile.ZipInfo("LICENSE.txt")
                info.create_system = 3
                info.external_attr = (0o120777 << 16) | 0xA000
                container.writestr(info, b"link-target")
            archive_sha256 = _sha256(archive.read_bytes())

            with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                HELPER.generate(_request(notice, archive, archive_sha256))

            self.assertIn("invalid_archive_member", str(failure.exception))

    def test_symlinked_input_ancestor_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.mkdir()
            notice = real / "NOTICE"
            notice.write_text("Fullmag notice\n", encoding="utf-8")
            linked = root / "linked"
            try:
                linked.symlink_to(real, target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")
            archive = real / "Synthetic.Package.1.2.3.nupkg"
            archive_sha256 = _archive(archive, {"LICENSE.txt": b"Synthetic license\n"})

            request = _request(linked / "NOTICE", linked / archive.name, archive_sha256)
            with self.assertRaises(HELPER.NoticeGenerationError) as failure:
                HELPER.generate(request)

            self.assertIn("reparse_path", str(failure.exception))

    def test_power_shell_and_wix_consumers_have_the_legal_payload_hooks(self) -> None:
        producer = (HELPER_PATH.parent.parent / "build_windows_installer_exe.ps1").read_text(
            encoding="utf-8"
        )
        source_producer = (HELPER_PATH.parent.parent / "build_installer_from_source.ps1").read_text(
            encoding="utf-8"
        )
        bundle = (HELPER_PATH.parent / "Fullmag.Bundle.wxs").read_text(encoding="utf-8")

        for marker in (
            "NoticeFile",
            "THIRD_PARTY_NOTICES",
            "generate_third_party_notices.py",
            "third_party",
            "third_party_license_fallbacks.json",
            "license_expression",
            "nuspec",
        ):
            self.assertIn(marker, producer)
        self.assertIn("-NoticeFile", source_producer)
        self.assertIn("$(var.ProductNoticeFile)", bundle)
        self.assertIn("$(var.ThirdPartyNoticesFile)", bundle)
        self.assertIn("$(var.ThirdPartyInventoryFile)", bundle)


if __name__ == "__main__":
    unittest.main()
