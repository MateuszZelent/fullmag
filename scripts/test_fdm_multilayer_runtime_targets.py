"""Contract tests for the managed FDM multilayer runtime recipes."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = ROOT / "justfile"


def recipe_source(name: str) -> str:
    text = JUSTFILE.read_text(encoding="utf-8")
    match = re.search(rf"^{re.escape(name)}(?:\s+[^:\n]+)?:", text, re.MULTILINE)
    assert match is not None, f"missing just recipe: {name}"
    remainder = text[match.start() :]
    next_recipe = remainder.find("\n\n")
    return remainder if next_recipe < 0 else remainder[:next_recipe]


def test_named_multilayer_runtime_recipes_exist() -> None:
    for name in (
        "verify-fdm-multilayer-demag-contract",
        "verify-fdm-multilayer-demag-runtime",
        "verify-fdm-multilayer-airbox-runtime",
        "verify-fdm-multilayer-demag-production",
    ):
        recipe_source(name)


def test_contract_recipe_runs_repository_contracts_without_fixtures() -> None:
    recipe = recipe_source("verify-fdm-multilayer-demag-contract")
    for required in (
        "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/verify.py",
        "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/test_runtime.py",
        "fdm_multilayer_abi_v2_contract",
        "fdm_multilayer_create_v2_contract",
        "fdm_batched_demag_fft_contract",
        "--output-on-failure",
    ):
        assert required in recipe
    assert "fixture" not in recipe.lower()
    assert "synthetic" not in recipe.lower()


def test_cpu_runtime_recipe_is_fresh_managed_and_fail_closed() -> None:
    recipe = recipe_source("verify-fdm-multilayer-demag-runtime")
    for required in (
        'lane="cpu-fp64"',
        "FULLMAG_FDM_EXECUTION=cpu",
        "measure_runtime.py",
        "runtime_verify.py",
        "mktemp -d",
        "chmod -R a-w",
        "runtime_artifacts_missing",
    ):
        assert required in recipe
    assert "fixture" not in recipe.lower()


def test_repository_control_scenarios_are_distinct_real_inputs() -> None:
    a_only = ROOT / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_a_only.py"
    b_only = ROOT / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_b_only.py"
    assert a_only.is_file() and b_only.is_file()
    assert a_only.read_bytes() != b_only.read_bytes()
    assert "top.Ms = 1.0e-30" in a_only.read_text(encoding="utf-8")
    assert "bottom.Ms = 1.0e-30" in b_only.read_text(encoding="utf-8")


def test_airbox_runtime_requires_separate_runtime_carrier() -> None:
    recipe = recipe_source("verify-fdm-multilayer-airbox-runtime")
    for required in (
        'lane="cpu-fp64"',
        "scope_kind=airbox",
        "H_demag",
        "airbox_carrier",
        "not_qualified",
        "runtime_verify.py",
    ):
        assert required in recipe
    assert "runtime.json" in recipe


def test_production_recipe_aggregates_lanes_and_records_gpu_reason_code() -> None:
    recipe = recipe_source("verify-fdm-multilayer-demag-production")
    for required in (
        "verify-fdm-multilayer-demag-runtime cpu-fp64",
        "verify-fdm-multilayer-airbox-runtime cpu-fp64",
        "verify-fdm-multilayer-cuda-runtime cuda-fp64",
        "verify-fdm-multilayer-cuda-runtime cuda-fp32",
        "cuda-fp64",
        "cuda-fp32",
        "reason_code",
        "cuda_managed_artifact_missing",
        "not_qualified",
    ):
        assert required in recipe
    assert "verify-fdm-multilayer-demag-runtime cuda-" not in recipe


def test_webgl_matrix_recipe_owns_a_strict_cpu_fp64_multilayer_session() -> None:
    recipe = recipe_source("run-fdm-multilayer-webgl-matrix-cpu")
    for required in (
        'web_port="" api_port=""',
        'run_root="$(mktemp -d "$report_parent/webgl-matrix-cpu.run.XXXXXXXX")"',
        "select_free_port()",
        "socket.AF_INET",
        'if [ -z "$web_port" ]; then web_port="$(select_free_port)"; fi',
        'if [ -z "$api_port" ]; then api_port="$(select_free_port)"; fi',
        'while [ "$api_port" = "$web_port" ]; do api_port="$(select_free_port)"; done',
        "setsid env",
        'sim_sid="$(ps -o sid= -p "$sim_pid" | tr -d " ")"',
        "assert_owned_listener()",
        'lsof -nP -t -iTCP:"$port" -sTCP:LISTEN',
        'listener_sid="$(ps -o sid= -p "$listener_pid" | tr -d " " || true)"',
        'assert_owned_listener "$api_port" "API status"',
        'assert_owned_listener "$api_port" "multilayer layout"',
        'assert_owned_listener "$web_port" "workspace UI"',
        "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario.py",
        "FULLMAG_FDM_EXECUTION=cpu",
        "--backend fdm",
        "--precision double",
        'FULLMAG_API_PORT="$api_port"',
        '--web-port "$web_port"',
        "/v2/sessions/current/status",
        "/v2/sessions/current/data/domain/fdm-multilayer-layout",
        'curl -fsS "$web_url" > "$run_root/workspace.html"',
        "CONTROL_ROOM_API_BASE_URL=\"$api_url\"",
        "CONTROL_ROOM_URL=\"$web_url\"",
        "CONTROL_ROOM_FDM_MULTILAYER_DIAGNOSTIC_READBACK_MODE=per-case",
        "CONTROL_ROOM_FDM_MULTILAYER_MATRIX_ARTIFACT_DIR=\"$run_root/screenshots\"",
        "CONTROL_ROOM_FDM_MULTILAYER_MATRIX_EVIDENCE=\"$evidence\"",
        "smoke:fdm-multilayer-webgl-matrix",
        "passed_cpu_fp64_browser_fallback",
        "manifest.json",
        "fullmag.log",
        "fdm-multilayer-layout.json",
        "sim_pid=$!",
        'kill "$sim_pid"',
        'wait "$sim_pid"',
        "trap finish EXIT INT TERM",
        "find \"$run_root/screenshots\" -name",
    ):
        assert required in recipe
    assert 'evidence.get("diagnostic_only") is not True' in recipe
    assert "--skip" not in recipe
    assert "scenario_airbox" not in recipe
    assert 'web_port="3297"' not in recipe
    assert 'api_port="18297"' not in recipe
    assert "pkill" not in recipe


def test_webgl_matrix_recipe_normalizes_named_port_overrides() -> None:
    recipe = recipe_source("run-fdm-multilayer-webgl-matrix-cpu")
    assert 'case "$web_port" in web_port=*) web_port="$(printf "%s" "$web_port" | cut -d= -f2-)" ;; esac' in recipe
    assert 'case "$api_port" in api_port=*) api_port="$(printf "%s" "$api_port" | cut -d= -f2-)" ;; esac' in recipe


def test_webgl_matrix_recipe_isolates_the_cpu_only_launcher_build() -> None:
    recipe = recipe_source("run-fdm-multilayer-webgl-matrix-cpu")

    for required in (
        'cargo_target_root="/tmp/fullmag-zfn2-build/cargo-targets"',
        'cargo_target_dir="$cargo_target_root/fdm-multilayer-webgl-matrix-cpu-$(basename "$run_root")"',
        'build_log="$run_root/fullmag-build.log"',
        'mkdir -p "$cargo_target_dir" > "$build_log" 2>&1',
        'just ensure-python >> "$build_log" 2>&1',
        'FULLMAG_CARGO_TARGET_DIR="$cargo_target_dir" just build fullmag 1 >> "$build_log" 2>&1',
    ):
        assert required in recipe

    assert recipe.index('run_root="$(mktemp -d') < recipe.index('build_log="$run_root/fullmag-build.log"')
    assert recipe.index("trap finish EXIT INT TERM") < recipe.index(
        'FULLMAG_CARGO_TARGET_DIR="$cargo_target_dir" just build fullmag 1 >> "$build_log" 2>&1'
    )
    assert recipe.index('FULLMAG_CARGO_TARGET_DIR="$cargo_target_dir" just build fullmag 1 >> "$build_log" 2>&1') < recipe.index(
        "setsid env"
    )
    assert recipe.count("just build fullmag") == 1
