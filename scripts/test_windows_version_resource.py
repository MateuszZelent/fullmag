"""Source contract checks for the Windows VERSIONINFO build helper."""

from __future__ import annotations

from pathlib import Path
import unittest


SOURCE = Path(__file__).parent / "rust" / "windows_version_resource.rs"


class WindowsVersionResourceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = SOURCE.read_text(encoding="utf-8")

    def test_public_build_script_signature_and_target_gate(self) -> None:
        self.assertIn(
            "pub fn compile_version_resource(product_name: &str)", self.source
        )
        self.assertIn('CARGO_CFG_TARGET_OS', self.source)
        self.assertIn('CARGO_CFG_TARGET_ENV', self.source)
        self.assertIn('Ok("windows")', self.source)
        self.assertIn('Ok("msvc")', self.source)

    def test_identity_and_file_version_inputs_are_rebuild_inputs(self) -> None:
        for variable in (
            "FULLMAG_BUILD_VERSION",
            "FULLMAG_WINDOWS_FILE_VERSION",
            "CARGO_PKG_VERSION",
        ):
            self.assertIn(f'"{variable}"', self.source)
        self.assertIn("cargo:rerun-if-env-changed={variable}", self.source)
        self.assertIn("validate_semver", self.source)
        self.assertIn("parse_windows_file_version", self.source)

    def test_resource_is_compiled_directly_and_linked(self) -> None:
        for token in (
            'fullmag-version.rc',
            'fullmag-version.res',
            '.arg("/nologo")',
            '.arg("/fo")',
            'cargo:rustc-link-arg=',
            'resolve_rc_exe',
        ):
            self.assertIn(token, self.source)

    def test_resource_contains_expected_version_fields(self) -> None:
        for token in (
            '1 VERSIONINFO',
            'FILEVERSION',
            'PRODUCTVERSION',
            'VALUE \\"FileVersion\\"',
            'VALUE \\"ProductVersion\\"',
            'VALUE \\"OriginalFilename\\"',
        ):
            self.assertIn(token, self.source)


if __name__ == "__main__":
    unittest.main()
