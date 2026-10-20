"""Keep hash-bound installer inputs identical across Windows EOL modes.

The fixture clones the exact committed HEAD bytes with core.autocrlf both
false and true. A hash-bound working file must match HEAD before the check;
normalization or content changes must first be committed. The final CRLF
mutation checks hash drift detection without invoking Burn or claiming GUI
or runtime qualification.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
TARGETS = (
    ".env.example",
    "windows_build_requirements.json",
    "scripts/fullmag_storage.py",
    "scripts/windows/installer_env.ps1",
    "scripts/windows/setup_build_environment.ps1",
)


def _git(*args: str, cwd: Path = ROOT) -> bytes:
    completed = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        command_text = "git " + " ".join(args)
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise AssertionError(f"{command_text} failed: {detail}")
    return completed.stdout


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _working_hashes(root: Path) -> dict[str, str]:
    return {relative: _sha256((root / relative).read_bytes()) for relative in TARGETS}


class WindowsInstallerEolContract(unittest.TestCase):
    def test_pinned_inputs_survive_autocrlf_modes(self) -> None:
        blobs = {}
        for relative in TARGETS:
            _git("ls-files", "--error-unmatch", "--", relative)
            head_blob = _git("show", f"HEAD:{relative}")
            working_blob = (ROOT / relative).read_bytes()
            self.assertNotIn(b"\r", head_blob, relative)
            self.assertEqual(working_blob, head_blob, relative)
            blobs[relative] = head_blob
        expected_hashes = {relative: _sha256(blob) for relative, blob in blobs.items()}

        with tempfile.TemporaryDirectory(prefix="fullmag-installer-eol-") as temporary:
            fixture = Path(temporary)
            seed = fixture / "seed"
            seed.mkdir()
            _git("init", "--quiet", cwd=seed)
            _git("config", "core.autocrlf", "false", cwd=seed)
            _git("config", "user.name", "Fullmag EOL fixture", cwd=seed)
            _git("config", "user.email", "fullmag-eol@example.invalid", cwd=seed)

            (seed / ".gitattributes").write_bytes((ROOT / ".gitattributes").read_bytes())
            for relative, blob in blobs.items():
                target = seed / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(blob)
            _git("add", "--", ".gitattributes", *TARGETS, cwd=seed)
            _git("commit", "--quiet", "-m", "EOL fixture", cwd=seed)
            expected_revision = _git("rev-parse", "HEAD", cwd=seed).strip()

            clones = {}
            for name, autocrlf in (("lf", "false"), ("windows", "true")):
                clone = fixture / name
                _git(
                    "clone",
                    "--config",
                    f"core.autocrlf={autocrlf}",
                    "--quiet",
                    str(seed),
                    str(clone),
                    cwd=fixture,
                )
                self.assertEqual(
                    _git("config", "--get", "core.autocrlf", cwd=clone).decode().strip(),
                    autocrlf,
                )
                self.assertEqual(_git("rev-parse", "HEAD", cwd=clone).strip(), expected_revision)
                clones[name] = clone

            self.assertEqual(_working_hashes(clones["lf"]), expected_hashes)
            self.assertEqual(_working_hashes(clones["windows"]), expected_hashes)

            attributes = {}
            for line in _git("check-attr", "eol", "--", *TARGETS).decode("utf-8").splitlines():
                relative, name, value = line.split(": ", 2)
                self.assertEqual(name, "eol")
                attributes[relative] = value
            self.assertEqual(attributes, {relative: "lf" for relative in TARGETS})
            for clone in clones.values():
                fixture_attributes = {}
                for line in _git("check-attr", "eol", "--", *TARGETS, cwd=clone).decode().splitlines():
                    relative, name, value = line.split(": ", 2)
                    self.assertEqual(name, "eol")
                    fixture_attributes[relative] = value
                self.assertEqual(fixture_attributes, {relative: "lf" for relative in TARGETS})
            for clone in clones.values():
                for relative in TARGETS:
                    self.assertNotIn(b"\r\n", (clone / relative).read_bytes(), relative)

            tampered_relative = "scripts/windows/setup_build_environment.ps1"
            tampered = clones["windows"] / tampered_relative
            tampered_bytes = tampered.read_bytes().replace(b"\n", b"\r\n")
            tampered.write_bytes(tampered_bytes)
            self.assertIn(b"\r\n", tampered_bytes)
            self.assertNotEqual(_sha256(tampered_bytes), expected_hashes[tampered_relative])


if __name__ == "__main__":
    unittest.main()
