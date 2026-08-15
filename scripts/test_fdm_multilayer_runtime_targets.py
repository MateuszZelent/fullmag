"""Contract tests for the managed FDM multilayer runtime recipes."""

from __future__ import annotations

import json
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


def test_cpu_runtime_recipe_is_fresh_source_bound_and_fail_closed() -> None:
    recipe = recipe_source("verify-fdm-multilayer-demag-runtime")
    for required in (
        'lane="cpu-fp64"',
        "FULLMAG_FDM_EXECUTION=cpu",
        "measure_runtime.py",
        "runtime_verify.py",
        "scenario_l1.py",
        "scenario_identity.py",
        "scenario_unequal_small.py",
        "verify_fdm_multilayer_independent_oracle.py",
        "--max-target-cells 8192",
        "--max-energy-cells 8192",
        "verify_fdm_multilayer_transfer_parity.py",
        "independent_oracle_incomplete_without_transfer",
        "scientific-qualification.json",
        "capture_source_snapshot_identity.py",
        'hash_inputs "$run_root/input-sha256.txt"',
        'hash_inputs "$run_root/input-sha256-post.txt"',
        'cmp -s "$run_root/input-sha256.txt" "$run_root/input-sha256-post.txt"',
        '\\\"status\\\":\\\"qualified\\\"',
        "mktemp -d",
        "chmod -R a-w",
        "runtime_artifacts_missing",
    ):
        assert required in recipe
    assert "fixture" not in recipe.lower()
    assert "cpu_fp64_scientific_qualification_not_evaluated" not in recipe
    assert "write_status \"cpu_fp64_scientific" not in recipe


def test_repository_control_scenarios_are_distinct_real_inputs() -> None:
    a_only = ROOT / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_a_only.py"
    b_only = ROOT / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_b_only.py"
    assert a_only.is_file() and b_only.is_file()
    assert a_only.read_bytes() != b_only.read_bytes()
    assert "top.Ms = 1.0e-30" in a_only.read_text(encoding="utf-8")
    assert "bottom.Ms = 1.0e-30" in b_only.read_text(encoding="utf-8")


def test_airbox_runtime_requires_two_bound_carriers_and_convergence() -> None:
    recipe = recipe_source("verify-fdm-multilayer-airbox-runtime")
    for required in (
        'lane="cpu-fp64"',
        "scope_kind=airbox",
        "H_demag",
        "airbox_carrier",
        "FULLMAG_FDM_MULTILAYER_AIRBOX_CANDIDATE",
        'FULLMAG_FDM_MULTILAYER_AIRBOX_CARRIER_${lane_suffix}',
        'FULLMAG_FDM_MULTILAYER_AIRBOX_CANDIDATE_${lane_suffix}',
        "verify_fdm_multilayer_airbox_carrier.py",
        "verify_fdm_multilayer_airbox_convergence.py",
        "airbox-convergence.json",
        "airbox_report_carrier_build_identity_missing",
        "airbox_report_carrier_build_identity_mismatch",
        "source-snapshot-pre.v1.json",
        "source-snapshot-post.v1.json",
        'hash_inputs "$run_root/input-sha256.txt"',
        'hash_inputs "$run_root/input-sha256-post.txt"',
        'airbox_input_hash_drift_after_validation',
        "capture_source_snapshot_identity.py",
        "fdm_multilayer_airbox_source_runtime.v1",
        "candidate/artifacts/metadata.json",
        '.execution_provenance.execution_engine == "cuda_native_multilayer_convolution"',
        '.qualification_status == "qualified"',
        '\\\"status\\\":\\\"qualified\\\"',
        "runtime_verify.py",
    ):
        assert required in recipe
    assert "runtime.json" in recipe
    assert "airbox_carrier_identity_verified_but_science_not_qualified" not in recipe


def test_production_recipe_aggregates_explicit_child_reports_fail_closed() -> None:
    recipe = recipe_source("verify-fdm-multilayer-demag-production")
    for required in (
        "verify-fdm-multilayer-demag-runtime cpu-fp64",
        "verify-fdm-multilayer-airbox-runtime cpu-fp64",
        "verify-fdm-multilayer-cuda-runtime cuda-fp64",
        "verify-fdm-multilayer-cuda-runtime cuda-fp32",
        'child_report_root="$run_root/children"',
        'FULLMAG_FDM_MULTILAYER_REPORT_ROOT="$child_report_root"',
        'demag-cpu-fp64.run.*',
        'airbox-cpu-fp64.run.*',
        'cuda-fp64.run.*',
        'cuda-fp32.run.*',
        'airbox-cuda-fp64.run.*',
        'airbox-cuda-fp32.run.*',
        '.status == "qualified"',
        '.status == "verified"',
        'production-summary.json',
        'bounded_validation_status',
        'phase_e_production_matrix_incomplete',
        'missing_production_coverage',
        'managed CUDA FP64 L=1,2,4,8 identity/push_pull matrix',
        "cuda-fp64",
        "cuda-fp32",
        "reason_code",
        "cuda_managed_artifact_missing",
    ):
        assert required in recipe
    assert "verify-fdm-multilayer-demag-runtime cuda-" not in recipe
    assert "cuda_lane_not_qualified" not in recipe
    assert '\\\"status\\\":\\\"qualified\\\"' not in recipe


def test_multilayer_runtime_recipes_honor_and_normalize_report_root() -> None:
    for name in (
        "verify-fdm-multilayer-demag-runtime",
        "verify-fdm-multilayer-airbox-runtime",
        "verify-fdm-multilayer-demag-production",
    ):
        recipe = recipe_source(name)
        assert "FULLMAG_FDM_MULTILAYER_REPORT_ROOT" in recipe
        assert 'report_parent="$(realpath "$report_parent")"' in recipe

    production = recipe_source("verify-fdm-multilayer-demag-production")
    assert production.count(
        'FULLMAG_FDM_MULTILAYER_REPORT_ROOT="$child_report_root"'
    ) == 6


def test_bounded_status_is_written_only_after_the_scientific_validators() -> None:
    cpu = recipe_source("verify-fdm-multilayer-demag-runtime")
    assert cpu.index('--output "$run_root/independent-oracle.json"') < cpu.index(
        'write_qualified; echo "qualified real CPU FP64'
    )
    assert cpu.index('--json-output "$run_root/transfer-parity.json"') < cpu.index(
        'write_qualified; echo "qualified real CPU FP64'
    )

    airbox = recipe_source("verify-fdm-multilayer-airbox-runtime")
    assert airbox.index(
        'scripts/verify_fdm_multilayer_airbox_convergence.py "$carrier" "$candidate"'
    ) < airbox.index(
        'write_qualified; echo "qualified runtime-origin Airbox H_demag convergence'
    )

    production = recipe_source("verify-fdm-multilayer-demag-production")
    summary = production.index('> "$run_root/production-summary.json"')
    bounded_status = production.index("write_bounded_status; echo")
    assert production.index(
        "verify-fdm-multilayer-airbox-runtime cuda-fp32"
    ) < summary < bounded_status
    assert bounded_status < production.rindex("exit 3")


def test_capability_matrix_does_not_promote_unqualified_multilayer_cuda() -> None:
    matrix = json.loads(
        (ROOT / "docs/specs/capability-matrix-v0.json").read_text(encoding="utf-8")
    )
    feature = next(
        item
        for item in matrix["features"]
        if item["id"] == "fdm_multilayer_fixed_explicit_rk"
    )
    assert feature["lanes"]["fdm_gpu_production"] == "implemented"
    assert feature["validated_workloads"] == []
    assert "no current managed source-bound CUDA runtime/parity receipt" in feature[
        "notes"
    ]
    assert "Do not expose this row as production_executable or validated" in feature[
        "notes"
    ]


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
        "source-snapshot.v1.json",
        "source-snapshot-post.v1.json",
        "capture_source_snapshot_identity.py",
        "FULLMAG_SOURCE_GIT_COMMIT=",
        "FULLMAG_SOURCE_WORKTREE_STATE=",
        "FULLMAG_SOURCE_SNAPSHOT_SHA256=",
        "CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_GIT_COMMIT=",
        "CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_WORKTREE_STATE=",
        "CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_SOURCE_SNAPSHOT_SHA256=",
        "CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_SOURCE_SNAPSHOT_PATH=",
        "runtime_binary_sha256=",
        "sha256sum \"$runtime_binary\"",
        "CONTROL_ROOM_FDM_MULTILAYER_EXPECTED_RUNTIME_BINARY_SHA256=",
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


def test_webgl_matrix_recipe_waits_for_completed_airbox_runtime() -> None:
    recipe = recipe_source("run-fdm-multilayer-webgl-matrix-cpu")
    readiness = recipe.index('status.get("solver", {}).get("state") == "completed"')
    smoke = recipe.index("smoke:fdm-multilayer-webgl-matrix")

    assert 'airbox.get("carrier_available") is True' in recipe
    assert 'airbox.get("h_demag_available") is True' in recipe
    assert 'airbox.get("carrier_fingerprint")' in recipe
    assert readiness < smoke


def test_webgl_matrix_recipe_escapes_port_bind_address_for_nested_bash() -> None:
    recipe = recipe_source("run-fdm-multilayer-webgl-matrix-cpu")
    assert 'sock.bind((\\"127.0.0.1\\", 0))' in recipe
    assert "sock.bind(('127.0.0.1', 0))" not in recipe


def test_webgl_matrix_recipe_keeps_nested_jq_expression_inside_outer_bash() -> None:
    recipe = recipe_source("run-fdm-multilayer-webgl-matrix-cpu")
    assert (
        'source_worktree_state="$(jq -er "if .source_snapshot_dirty then '
        '\\"dirty\\" else \\"clean\\" end" "$source_snapshot")"'
    ) in recipe
    assert "source_worktree_state=\"$(jq -er '" not in recipe


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


def test_webgl_matrix_recipe_records_stable_failure_status_and_seals_evidence() -> None:
    recipe = recipe_source("run-fdm-multilayer-webgl-matrix-cpu")

    for required in (
        'reason_code="webgl_matrix_unclassified_failure"',
        'reason_code="source_drift_after_runtime"',
        'reason_code="runtime_binary_changed_after_build"',
        'reason_code="webgl_receipt_package_failed"',
        '\\"reason_code\\":\\"%s\\"',
        'receipt_inputs="$run_root/receipt-inputs-sha256.txt"',
        'receipt_index="$run_root/receipt-index.v1.json"',
        'receipt_index_sha256="$run_root/receipt-index.v1.json.sha256"',
        'sha256sum "$evidence"',
        'sha256sum "$manifest"',
        'sha256sum "$receipt_inputs"',
        'sha256sum "$receipt_index" > "$receipt_index_sha256"',
        'fdm_multilayer_webgl_receipt.v1',
        'chmod -R a-w "$run_root"',
    ):
        assert required in recipe

    manifest_write = recipe.index('\\"reason_code\\":%s,\\"exit_code\\":%s')
    receipt_inputs_write = recipe.index('> "$receipt_inputs"')
    receipt_index_write = recipe.index('fdm_multilayer_webgl_receipt.v1')
    receipt_index_hash = recipe.index('sha256sum "$receipt_index" > "$receipt_index_sha256"')
    seal = recipe.index('chmod -R a-w "$run_root"')

    assert manifest_write < receipt_inputs_write < receipt_index_write < receipt_index_hash < seal
