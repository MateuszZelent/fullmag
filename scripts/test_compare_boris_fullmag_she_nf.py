from __future__ import annotations

import json
from pathlib import Path

import pytest

from compare_boris_fullmag_she_nf import (
    NormalizedTransportArtifact,
    compare_transport_artifacts,
    load_fullmag_m2_artifact,
)


def _artifact(
    *,
    shape: tuple[int, int, int] = (1, 1, 1),
    mu_s: tuple[tuple[float, float, float], ...] = ((1.0, 2.0, 3.0),),
    normal_axis: str = "z",
    normal_sign: int = 1,
    conventions: dict[str, object] | None = None,
) -> NormalizedTransportArtifact:
    count = shape[0] * shape[1] * shape[2]
    if len(mu_s) == 1 and count != 1:
        mu_s = mu_s * count
    return NormalizedTransportArtifact(
        source="fixture",
        shape=shape,
        origin_m=(0.0, 0.0, 0.0),
        step_m=(1.0e-9, 1.0e-9, 1.0e-9),
        potential_v=tuple(float(index) for index in range(count)),
        mu_s_v=mu_s,
        charge_current_apm2=tuple((1.0, 0.0, 0.0) for _ in range(count)),
        spin_current_qia_apm2=tuple(
            tuple(float(index + component) for component in range(9))
            for index in range(count)
        ),
        torque_per_s=tuple((0.0, 1.0, 0.0) for _ in range(count)),
        residuals={"charge": 1.0e-8, "spin": 2.0e-8},
        interface_balances={
            "absorbed_spin_flux": [1.0, 2.0, 3.0],
            "torque": [0.0, 1.0, 0.0],
            "charge_closure": 1.0e-8,
        },
        formula_version="fullmag.fdm.m2.transport.v1",
        normal_axis=normal_axis,
        normal_sign=normal_sign,
        conventions=conventions or {"component_order": "row_major_Q_ia"},
    )


def test_comparison_reports_zero_for_identical_normalized_fields() -> None:
    result = compare_transport_artifacts(_artifact(), _artifact())
    assert result["status"] == "diagnostic_match"
    assert result["observables"]["mu_s"]["max_relative_error"] == 0.0
    assert result["observables"]["spin_current_qia"]["normalized_l2_error"] == 0.0


def test_comparison_rejects_mesh_and_convention_mismatch() -> None:
    with pytest.raises(ValueError, match="incomparable"):
        compare_transport_artifacts(_artifact(), _artifact(shape=(2, 1, 1)))
    with pytest.raises(ValueError, match="incomparable"):
        compare_transport_artifacts(_artifact(normal_sign=1), _artifact(normal_sign=-1))


def test_comparison_reports_diagnostic_mismatch_without_validation_claim() -> None:
    altered = _artifact(mu_s=((1.1, 2.0, 3.0),))
    result = compare_transport_artifacts(_artifact(), altered)
    assert result["status"] == "diagnostic_mismatch"
    assert result["qualification"]["status"] == "diagnostic"
    assert "validated" not in json.dumps(result)


def test_torque_unit_mismatch_is_reported_without_comparing_incompatible_units() -> None:
    result = compare_transport_artifacts(
        _artifact(conventions={"component_order": "row_major_Q_ia", "torque_unit": "boris_tsi_A_per_m_s"}),
        _artifact(conventions={"component_order": "row_major_Q_ia", "torque_unit": "gilbert_source_per_s"}),
    )
    assert result["status"] == "incomparable"
    assert result["observables"]["mu_s"]["max_relative_error"] == 0.0
    assert result["incomparable_observables"]["interface_torque"]["status"] == "incomparable"


def test_fullmag_loader_requires_explicit_tensor_order_and_formula(tmp_path: Path) -> None:
    payload = {
        "schema": "fullmag.fdm.spin_transport.accepted.v1",
        "mesh": {
            "shape": [1, 1, 1],
            "origin_m": [0.0, 0.0, 0.0],
            "step_m": [1.0e-9, 1.0e-9, 1.0e-9],
        },
        "component_order": "row_major_Q_ia",
        "formula_version": "fullmag.fdm.m2.transport.v1",
        "normal_axis": "z",
        "normal_sign": 1,
        "potential_volts": [0.0],
        "spin_potential_volts": [[1.0, 2.0, 3.0]],
        "current_density_apm2": [[1.0, 0.0, 0.0]],
        "spin_current_tensor_apm2": [[0.0] * 9],
        "transport_torque_per_s": [[0.0, 1.0, 0.0]],
        "residuals": {"charge": 0.0, "spin": 0.0},
        "interface_balances": {
            "absorbed_spin_flux": [0.0, 0.0, 0.0],
            "torque": [0.0, 1.0, 0.0],
            "charge_closure": 0.0,
        },
    }
    path = tmp_path / "transport.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    artifact = load_fullmag_m2_artifact(path)
    assert artifact.shape == (1, 1, 1)
    assert artifact.spin_current_qia_apm2 == ((0.0,) * 9,)

    payload.pop("component_order")
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="component_order"):
        load_fullmag_m2_artifact(path)


def test_fullmag_loader_rejects_flattened_spin_tensor(tmp_path: Path) -> None:
    payload = {
        "schema": "fullmag.fdm.spin_transport.accepted.v1",
        "mesh": {"shape": [1, 1, 1], "step_m": [1.0, 1.0, 1.0]},
        "component_order": "row_major_Q_ia",
        "formula_version": "fullmag.fdm.m2.transport.v1",
        "normal_axis": "z",
        "normal_sign": 1,
        "potential_volts": [0.0],
        "spin_potential_volts": [[0.0, 0.0, 0.0]],
        "current_density_apm2": [[0.0, 0.0, 0.0]],
        "spin_current_tensor_apm2": [[0.0, 0.0, 0.0]],
        "transport_torque_per_s": [[0.0, 0.0, 0.0]],
        "residuals": {"charge": 0.0, "spin": 0.0},
        "interface_balances": {
            "absorbed_spin_flux": [0.0, 0.0, 0.0],
            "torque": [0.0, 0.0, 0.0],
            "charge_closure": 0.0,
        },
    }
    path = tmp_path / "flattened.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="nine-component"):
        load_fullmag_m2_artifact(path)
