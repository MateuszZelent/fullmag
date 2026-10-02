"""Exercise stale project metadata rejection without dependency installation."""

from copy import deepcopy
import subprocess
import sys

import pytest

import check_python_dependency_lock as guard


PROJECT = {
    "project": {"name": "fullmag", "version": "0.1.0", "requires-python": ">=3.10",
                "dependencies": ["numpy>=1.24,<3"],
                "optional-dependencies": {"meshing": ["manifold3d>=3,<4"], "figures": ["Pillow>=10,<13"]}},
    "dependency-groups": {"dev": ["pytest>=9,<10"]},
}
LOCK = {
    "requires-python": ">=3.10",
    "package": [{"name": "fullmag", "version": "0.1.0", "metadata": {
        "provides-extras": ["meshing", "figures"],
        "requires-dist": [
            {"name": "numpy", "specifier": "<3,>=1.24"},
            {"name": "manifold3d", "specifier": "<4,>=3", "marker": "extra == 'meshing'"},
            {"name": "pillow", "specifier": "<13,>=10", "marker": "extra == 'figures'"}],
        "requires-dev": {"dev": [{"name": "pytest", "specifier": ">=9,<10"}]}}}],
}


def check_fixture(monkeypatch, project, lock):
    class FixturePath:
        def __init__(self, value):
            self.value = value
        def read_text(self, **kwargs):
            return self.value
    monkeypatch.setattr(guard.tomllib, "loads", lambda value: value)
    guard.check_lock(FixturePath(project), FixturePath(lock))


def test_matching_contract_accepts_reordered_specifiers(monkeypatch):
    check_fixture(monkeypatch, PROJECT, LOCK)


@pytest.mark.parametrize("case", ["python", "version", "extra", "dependency", "marker", "dev", "duplicate"])
def test_contract_drift_is_rejected(monkeypatch, case):
    lock = deepcopy(LOCK)
    package = lock["package"][0]
    if case == "python":
        lock["requires-python"] = ">=3.12"
    elif case == "version":
        package["version"] = "0.2.0"
    elif case == "extra":
        package["metadata"]["provides-extras"].remove("figures")
    elif case == "dependency":
        package["metadata"]["requires-dist"].pop()
    elif case == "marker":
        package["metadata"]["requires-dist"][1]["marker"] = "extra == 'figures'"
    elif case == "dev":
        package["metadata"]["requires-dev"] = {}
    else:
        lock["package"].append(deepcopy(package))
    with pytest.raises(ValueError):
        check_fixture(monkeypatch, PROJECT, lock)


@pytest.mark.parametrize("stale", [False, True])
def test_cli_parses_real_toml_and_returns_actionable_status(tmp_path, stale):
    project = tmp_path / "pyproject.toml"
    lock = tmp_path / "uv.lock"
    project.write_text('[project]\nname="fixture"\nversion="0.1.0"\nrequires-python=">=3.10"\ndependencies=[]\n', encoding="utf-8")
    minimum = "3.12" if stale else "3.10"
    lock.write_text(f'requires-python=">={minimum}"\n[[package]]\nname="fixture"\nversion="0.1.0"\n[package.metadata]\nrequires-dist=[]\nprovides-extras=[]\n', encoding="utf-8")
    result = subprocess.run([sys.executable, guard.__file__, "--project", str(project), "--lock", str(lock)],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == (1 if stale else 0)
    if stale:
        assert "stale requires-python" in result.stderr
        assert "Refresh uv.lock" in result.stderr
    else:
        assert "PASS" in result.stdout


@pytest.mark.parametrize("value", ["package @ https://example.invalid/file.whl", "package[extra]>=1", "package>=1; sys_platform == 'win32'"])
def test_new_requirement_forms_cannot_silently_bypass_guard(value):
    with pytest.raises(ValueError):
        guard.requirement(value)
