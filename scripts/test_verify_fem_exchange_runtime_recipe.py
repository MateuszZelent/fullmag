from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_exchange_runtime_recipe_mounts_resolved_managed_runtime() -> None:
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    start = justfile.index("verify-fem-exchange-runtime:")
    end = justfile.index("\nverify-fem-frequency-domain-checked-extents:", start)
    recipe = justfile[start:end]

    assert 'runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"' in recipe
    assert 'test -x "$runtime_root/bin/fullmag-fem-gpu"' in recipe
    assert 'test -f "$runtime_root/manifest.json"' in recipe
    assert '-v "$runtime_root:/workspace/.fullmag/runtime:ro"' in recipe
    assert "FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime" in recipe


def test_exchange_runtime_script_honours_explicit_runtime_root() -> None:
    script = (REPO_ROOT / "scripts/verify_fem_exchange_runtime.sh").read_text(
        encoding="utf-8"
    )

    assert (
        'RUNTIME_ROOT="${FULLMAG_FEM_RUNTIME_ROOT:-${REPO_ROOT}/.fullmag/runtimes/fem-gpu-host}"'
        in script
    )
