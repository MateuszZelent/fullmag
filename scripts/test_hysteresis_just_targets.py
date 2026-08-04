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


def test_fullmag_recipe_accepts_long_form_runtime_aliases() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")

    for alias in (
        "--dev|dev)",
        "--static|static)",
        "--interactive|-i|interactive)",
        "--headless|headless)",
        "--fdm|fdm)",
        "--fem|fem)",
        "--gpu|gpu)",
        "--cpu|cpu)",
    ):
        assert alias in justfile


def test_makefile_default_cargo_target_is_worktree_scoped() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")

    assert "FULLMAG_CARGO_TARGET_ROOT" in makefile
    assert "FULLMAG_WORKTREE_KEY" in makefile
    assert "sha256sum" in makefile
    assert "FULLMAG_CARGO_TARGET_DIR ?= /tmp/fullmag-zfn2-build/cargo-targets/fullmag-cli\n" not in makefile


def test_waveguide_headless_smoke_targets_use_managed_runtime_directly() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")

    assert "_run-hysteresis-waveguide-managed-headless" in justfile
    assert "{{gpu_runtime_bin}}" in justfile
    assert "examples/hysteresis_waveguide_300x50x10nm.py \\" in justfile
    assert "just fullmag build=False fem" not in justfile
