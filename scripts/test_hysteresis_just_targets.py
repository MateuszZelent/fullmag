from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_waveguide_headless_smoke_targets_do_not_require_static_ui() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")

    offending_lines = [
        line.strip()
        for line in justfile.splitlines()
        if "just fullmag build=False static fem" in line
        and "headless examples/hysteresis_waveguide_300x50x10nm.py" in line
    ]

    assert offending_lines == []


def test_managed_fem_staleness_check_prunes_generated_fullmag_dirs() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")

    assert r'-path \"*/.fullmag\"' in justfile
    assert r'-path \"*/__pycache__\"' in justfile
    assert "-path '*/.fullmag'" not in justfile
    assert "-path '*/__pycache__'" not in justfile
    assert "-prune -o -type f" in justfile
    assert '! -path "*/.fullmag/*"' not in justfile


def test_waveguide_headless_smoke_targets_use_managed_runtime_directly() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")

    assert "_run-hysteresis-waveguide-managed-headless" in justfile
    assert "{{gpu_runtime_bin}}" in justfile
    assert "examples/hysteresis_waveguide_300x50x10nm.py \\" in justfile
    assert "just fullmag build=False fem" not in justfile
