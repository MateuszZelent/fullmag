from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parent / "analysis" / "calibrate_fem_relaxation_torque_default.py"


def load_module():
    spec = importlib.util.spec_from_file_location("relax_torque_calibration", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def row(
    *,
    backend: str,
    scenario: str,
    mesh: str,
    policy: str,
    steps: int,
    torque: float,
) -> dict[str, str]:
    return {
        "status": "ok",
        "backend": backend,
        "scenario": scenario,
        "solver_mesh_signature": mesh,
        "integrator": "rk23",
        "relaxation_algorithm": "llg_overdamped",
        "timestep_policy": policy,
        "steps": str(steps),
        "executed_steps": str(steps),
        "final_torque_apm": repr(torque),
        "stop_reason": "max_steps",
        "demag_model": "airbox" if "demag" in scenario else "",
    }


def qualified_matrix() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for mesh, scale in (("mesh-a", 1.0), ("mesh-b", 1.2)):
        for scenario in ("exchange_only", "exchange_demag"):
            for policy in ("fixed", "adaptive"):
                for backend, skew in (("fem_cpu", 1.0), ("fem_gpu", 1.02)):
                    rows.append(
                        row(
                            backend=backend,
                            scenario=scenario,
                            mesh=mesh,
                            policy=policy,
                            steps=128,
                            torque=20.0 * scale * skew,
                        )
                    )
                    rows.append(
                        row(
                            backend=backend,
                            scenario=scenario,
                            mesh=mesh,
                            policy=policy,
                            steps=256,
                            torque=4.0 * scale * skew,
                        )
                    )
                    rows.append(
                        row(
                            backend=backend,
                            scenario=scenario,
                            mesh=mesh,
                            policy=policy,
                            steps=512,
                            torque=3.9 * scale * skew,
                        )
                    )
    return rows


def test_recommends_rounded_fail_closed_default_from_complete_matrix() -> None:
    module = load_module()

    result = module.analyze_rows(qualified_matrix())

    assert result["qualified"] is True
    assert result["recommended_torque_tolerance_apm"] == pytest.approx(10.0)
    assert result["recommended_torque_tolerance_t"] == pytest.approx(10.0 * module.MU0)
    assert result["case_count"] == 8
    assert result["failures"] == []


def test_rejects_early_transient_even_when_final_value_is_finite() -> None:
    module = load_module()
    rows = qualified_matrix()
    for item in rows:
        if item["solver_mesh_signature"] == "mesh-a" and item["scenario"] == "exchange_demag":
            if item["steps"] == "256":
                item["final_torque_apm"] = "1000"
            elif item["steps"] == "512":
                item["final_torque_apm"] = "800"

    result = module.analyze_rows(rows)

    assert result["qualified"] is False
    assert any("not plateaued" in failure for failure in result["failures"])


def test_rejects_missing_gpu_or_missing_required_matrix_axis() -> None:
    module = load_module()
    rows = [item for item in qualified_matrix() if item["backend"] != "fem_gpu"]

    result = module.analyze_rows(rows)

    assert result["qualified"] is False
    assert any("CPU and GPU" in failure for failure in result["failures"])


def test_rejects_candidate_above_physical_cap() -> None:
    module = load_module()
    rows = qualified_matrix()
    for item in rows:
        item["final_torque_apm"] = "70"
        if item["steps"] == "128":
            item["final_torque_apm"] = "400"
        elif item["steps"] == "256":
            item["final_torque_apm"] = "72"

    result = module.analyze_rows(rows)

    assert result["qualified"] is False
    assert any("physical cap" in failure for failure in result["failures"])


def test_just_recipe_owns_fixed_mesh_cpu_gpu_calibration_matrix() -> None:
    justfile = (SCRIPT.parents[2] / "justfile").read_text(encoding="utf-8")

    assert "calibrate-fem-relaxation-torque-default:" in justfile
    recipe = justfile.split("calibrate-fem-relaxation-torque-default:", 1)[1]
    assert "just ensure-managed-fem-runtime" in recipe
    assert "--reuse-generated-domain-mesh" in recipe
    assert "--generated-domain-mesh-cache-dir" in recipe
    assert 'FULLMAG_CALIBRATION_BACKENDS:-cpu,gpu' in recipe
    assert 'FULLMAG_CALIBRATION_TIMESTEP_POLICIES:-fixed,adaptive' in recipe
    assert 'FULLMAG_CALIBRATION_SCENARIOS:-relax_exchange_only,relax_exchange_demag' in recipe
    assert 'bench_box_200x50x10nm.mesh.json,examples/assets/bench_box_fine.mesh.json' in recipe
    assert 'FULLMAG_CALIBRATION_THREAD_COUNTS:-4' in recipe
    assert '--thread-counts "$FULLMAG_CALIBRATION_THREAD_COUNTS"' in recipe
    assert 'FULLMAG_CALIBRATION_DT_S:-1e-14' in recipe
    assert '--dt "$FULLMAG_CALIBRATION_DT_S"' in recipe
    assert "box500_airbox_exchange_demag" in recipe
    assert "calibrate_fem_relaxation_torque_default.py" in recipe
    assert 'calibration_inputs="$calibration_inputs $report_dir/raw-${label}-${steps}.csv"' in recipe
    assert '"$report_dir"/raw-*.csv' not in recipe


def test_writes_dependency_free_png_plot(tmp_path: Path) -> None:
    module = load_module()
    rows = qualified_matrix()
    result = module.analyze_rows(rows)
    output = tmp_path / "torque.png"

    module.write_plot(rows, result, output)

    assert output.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert output.stat().st_size > 1_000
