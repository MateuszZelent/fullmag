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
