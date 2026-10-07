"""Source regression for the signed fifteen-point DE smoke model."""

from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm


SIGNED_FIFTEEN_K_UM = (
    -25, -20, -15, -10, -7, -5, -2, 0, 2, 5, 7, 10, 15, 20, 25
)
SIGNED_FIFTEEN_KY_RAD_PER_M = [k * 1.0e6 for k in SIGNED_FIFTEEN_K_UM]
SIGNED_FIFTEEN_VECTORS = [[0.0, ky, 0.0] for ky in SIGNED_FIFTEEN_KY_RAD_PER_M]
SIGNED_FIFTEEN_NAMES = [
    "Gamma" if k == 0 else f"DE-{k * 1.0e6:g}"
    for k in SIGNED_FIFTEEN_K_UM
]
EXPECTED_PARALLEL_EXECUTION = {
    "mode": "serial",
    "max_cpu_percent": 90.0,
    "max_memory_percent": 80.0,
    "memory_reserve_bytes": 1_073_741_824,
    "max_workers": None,
    "threads_per_worker": 1,
}


def _load_signed_fifteen(monkeypatch, *, parallel_mode="serial", frequency_window=None):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "signed-fifteen")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_PARALLEL_MODE", parallel_mode)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_MODAL_TARGET", raising=False)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", raising=False)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_SOLVER_RTOL", raising=False)
    if frequency_window is None:
        monkeypatch.delenv("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ", raising=False)
        monkeypatch.delenv("FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ", raising=False)
    else:
        monkeypatch.setenv("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ", str(frequency_window[0]))
        monkeypatch.setenv("FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ", str(frequency_window[1]))
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(
            ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True
        )
        return [
            stage.problem.to_ir(
                requested_backend="fem",
                execution_mode="strict",
                execution_precision="double",
                include_geometry_assets=False,
            )
            for stage in loaded.stages
        ]
    finally:
        fm.reset()


def test_signed_fifteen_preserves_physics_path_and_serial_default(monkeypatch):
    stages = _load_signed_fifteen(monkeypatch)
    assert len(stages) == 2
    relax, eigen = stages

    geometry = eigen["geometry"]["entries"]
    assert geometry == [{
        "kind": "box",
        "name": "film_geom",
        "size": [40e-9, 40e-9, 10e-9],
    }]
    material = eigen["materials"][0]
    assert material["saturation_magnetisation"] == 800000.0
    assert material["exchange_stiffness"] == 13e-12
    assert next(t for t in eigen["energy_terms"] if t["kind"] == "zeeman")["B"] == [0.1, 0, 0]
    assert sorted(t["kind"] for t in eigen["energy_terms"]) == [
        "demag", "exchange", "zeeman"
    ]
    assert next(t for t in eigen["energy_terms"] if t["kind"] == "demag")["realization"] == "poisson_dirichlet"
    assert eigen["pbc"]["demag"] == "periodic_airbox_k0"
    assert eigen["study"]["dynamics"]["gyromagnetic_ratio"] == 2.211e5
    assert relax["study"]["algorithm"] == "llg_overdamped"

    metadata = eigen["problem_meta"]["runtime_metadata"]
    model = metadata["de_smoke"]
    assert model["sampling"] == "signed-fifteen"
    assert model["requested_mode_count"] == 1
    assert model["ky_rad_per_m"] == SIGNED_FIFTEEN_KY_RAD_PER_M
    assert model["kx_rad_per_m"] == [0.0] * len(SIGNED_FIFTEEN_KY_RAD_PER_M)
    assert model["k_vectors_rad_per_m"] == SIGNED_FIFTEEN_VECTORS
    assert model["frequency_window_hz"] == [8.5e9, 16e9]
    assert model["dispersion_geometry"] == "damon_eshbach"

    assert metadata["runtime_selection"]["parallel_execution"] == EXPECTED_PARALLEL_EXECUTION
    assert metadata["study_universe"]["size"] == pytest.approx([40e-9, 40e-9, 4010e-9])
    workflow = metadata["mesh_workflow"]
    assert workflow["mesh_options"]["periodic_pair_ids"] == ["x_faces", "y_faces"]
    assert workflow["per_geometry"][0]["through_thickness_elements"] == 3
    assert workflow["per_geometry"][0]["hmax"] == 10e-9

    study = eigen["study"]
    assert study["operator"] == {"kind": "full_2x2", "include_demag": True}
    assert study["count"] == 1
    assert study["target"] == {
        "kind": "frequency_window",
        "frequency_min_hz": 8.5e9,
        "frequency_max_hz": 16e9,
    }
    assert study["magnetostatic_bc"] == "floquet_airbox"
    assert study["spin_wave_bc"] == {
        "kind": "floquet",
        "pair_ids": ["x_faces", "y_faces"],
        "phase_convention": "exp_minus_i_k_dot_delta_r",
    }
    assert [point["label"] for point in study["k_sampling"]["points"]] == SIGNED_FIFTEEN_NAMES
    assert [point["k_vector"] for point in study["k_sampling"]["points"]] == SIGNED_FIFTEEN_VECTORS
    assert study["k_sampling"]["samples_per_segment"] == [1] * 14
    mode = next(output for output in study["sampling"]["outputs"] if output["kind"] == "eigen_mode")
    assert mode["indices"] == [0]
    assert mode["sample_selector"]["sample_indices"] == list(range(15))


def test_signed_fifteen_adaptive_policy_is_explicit(monkeypatch):
    stages = _load_signed_fifteen(monkeypatch, parallel_mode="adaptive")
    policy = stages[-1]["problem_meta"]["runtime_metadata"]["runtime_selection"]["parallel_execution"]
    assert policy == {**EXPECTED_PARALLEL_EXECUTION, "mode": "adaptive"}


def test_signed_fifteen_frequency_window_accepts_explicit_override(monkeypatch):
    stages = _load_signed_fifteen(monkeypatch, frequency_window=(10.5, 11.5))
    eigen = stages[-1]
    assert eigen["study"]["target"] == {
        "kind": "frequency_window",
        "frequency_min_hz": 10.5e9,
        "frequency_max_hz": 11.5e9,
    }
    assert eigen["problem_meta"]["runtime_metadata"]["de_smoke"]["frequency_window_hz"] == [
        10.5e9, 11.5e9
    ]


def test_signed_fifteen_rejects_invalid_parallel_mode(monkeypatch):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "signed-fifteen")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_PARALLEL_MODE", "unsupported")
    fm.reset()
    try:
        with pytest.raises(ValueError, match="FULLMAG_DE_SMOKE_PARALLEL_MODE"):
            fm.load_problem_from_script(
                ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True
            )
    finally:
        fm.reset()
