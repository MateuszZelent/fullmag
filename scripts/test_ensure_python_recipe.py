from __future__ import annotations

import re
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def recipe_source(name: str) -> str:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")
    match = re.search(rf"^{re.escape(name)}(?:\s[^\n:]*)?:", justfile, re.MULTILINE)
    if match is None:
        raise AssertionError(f"missing just recipe {name}")
    following = justfile.find("\n\n", match.end())
    return justfile[match.start() :] if following == -1 else justfile[match.start() : following]


class EnsurePythonRecipeTests(unittest.TestCase):
    def test_existing_venv_without_pip_self_heals_or_fails_closed(self) -> None:
        recipe = recipe_source("ensure-python")

        pip_probe = recipe.find('"{{repo_python}}" -m pip --version')
        ensurepip = recipe.find('"{{repo_python}}" -m ensurepip --upgrade', pip_probe)
        fallback = recipe.find(
            'python3 scripts/bootstrap_fullmag_python_pip.py '
            '"{{repo_python}}" --wheel-dir /usr/share/python-wheels',
            ensurepip,
        )
        install = recipe.find('"{{repo_python}}" -m pip install', fallback)

        self.assertGreaterEqual(pip_probe, 0)
        self.assertGreater(ensurepip, pip_probe)
        self.assertGreater(fallback, ensurepip)
        self.assertGreater(install, fallback)
        self.assertIn("cannot bootstrap pip in the Fullmag Python environment", recipe)

    def test_offline_fallback_selects_one_verified_wheel_per_exact_package(self) -> None:
        from scripts.bootstrap_fullmag_python_pip import select_verified_wheels

        with tempfile.TemporaryDirectory() as directory:
            wheel_dir = Path(directory)
            expected = {
                "pip": "pip/__init__.py",
                "setuptools": "setuptools/__init__.py",
                "wheel": "wheel/__init__.py",
            }
            for package, member in expected.items():
                with zipfile.ZipFile(
                    wheel_dir / f"{package}-1.0-py3-none-any.whl", "w"
                ) as archive:
                    archive.writestr(member, "")

            selected = select_verified_wheels(wheel_dir)

        self.assertEqual([path.name for path in selected], [
            "pip-1.0-py3-none-any.whl",
            "setuptools-1.0-py3-none-any.whl",
            "wheel-1.0-py3-none-any.whl",
        ])

    def test_offline_fallback_fails_closed_for_missing_or_ambiguous_wheels(self) -> None:
        from scripts.bootstrap_fullmag_python_pip import BootstrapError, select_verified_wheels

        with tempfile.TemporaryDirectory() as directory:
            wheel_dir = Path(directory)
            with self.assertRaisesRegex(BootstrapError, "exactly one local pip wheel"):
                select_verified_wheels(wheel_dir)

            for name in ("pip-1.whl", "pip-2.whl"):
                with zipfile.ZipFile(wheel_dir / name, "w") as archive:
                    archive.writestr("pip/__init__.py", "")
            with self.assertRaisesRegex(BootstrapError, "exactly one local pip wheel"):
                select_verified_wheels(wheel_dir)


if __name__ == "__main__":
    unittest.main()
