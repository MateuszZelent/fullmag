from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = REPO_ROOT / "justfile"


def just_recipe_source(source: str, name: str) -> str:
    marker = f"{name}"
    start = source.index(marker)
    end = source.find("\n\n", start)
    return source[start:] if end < 0 else source[start:end]


def test_managed_fdm_gates_repair_only_missing_cached_make_programs() -> None:
    source = JUSTFILE.read_text(encoding="utf-8")
    repair = just_recipe_source(
        source,
        "repair-managed-native-cmake-build-tool build_key:",
    )
    endpoint = just_recipe_source(
        source,
        "verify-fdm-gpu-endpoint-cache-contract:",
    )
    parity = just_recipe_source(
        source,
        "verify-fdm-observable-materialization-parity:",
    )

    assert 'if [ ! -f "$cache" ]; then exit 0; fi' in repair
    assert 's/^CMAKE_MAKE_PROGRAM:[^=]*=//p' in repair
    assert '[ -x "$cached_program" ]' in repair
    assert 'command -v make || command -v gmake' in repair
    assert '-DCMAKE_MAKE_PROGRAM:FILEPATH="$replacement"' in repair
    assert "rm -f" not in repair
    assert "rm -rf" not in repair
    assert "cmake --fresh" not in repair
    assert 'rustc_identity="$(rustc -Vv | sha256sum' in endpoint
    assert 'cargo-targets/$rustc_identity' in endpoint
    assert 'rustc_identity="$(rustc -Vv | sha256sum' in parity
    assert 'cargo-targets/$rustc_identity' in parity
    assert (
        "just repair-managed-native-cmake-build-tool "
        "fdm-gpu-endpoint-cache/native"
    ) in endpoint
    assert (
        "just repair-managed-native-cmake-build-tool "
        "fdm-observable-materialization-parity/native"
    ) in parity
