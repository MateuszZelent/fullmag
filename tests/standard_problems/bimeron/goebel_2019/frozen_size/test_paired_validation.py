from __future__ import annotations

from types import SimpleNamespace

from tests.standard_problems.bimeron.goebel_2019.frozen_size import paired_validation


def _namespace(**overrides: object) -> SimpleNamespace:
    values = {
        "device": "gpu",
        "cell_nm": 0.5,
        "pin_radius_nm": 0.5,
        "ring_width_nm": 0.5,
        "helicity_rad": 0.0,
        "vorticity": -1,
        "background_sign": 1,
        "relax_time_s": 2e-11,
        "hold_time_s": 2e-12,
        "release_time_s": 2e-11,
        "relax_max_steps": 8000,
        "release_max_steps": 8000,
        "field_every_steps": 100,
        "track_x_nm": None,
        "track_y_nm": None,
        "tol_t": 5e-3,
        "table_every_steps": 10,
        "run_mode": "interactive",
        "web_port": 3114,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_args_forwards_complete_interactive_sweep_contract() -> None:
    args = paired_validation._args(_namespace())

    assert args.run_mode == "interactive"
    assert args.web_port == 3114
    assert args.track_x_nm > 0.0
    assert args.track_y_nm > 0.0
    assert args.tol_t == 5e-3
    assert args.table_every_steps == 10


def test_case_records_ring_geometry_and_relaxation_contract() -> None:
    args = paired_validation._args(_namespace())
    case = paired_validation._case(
        target_radius_nm=6.0,
        wall_width_nm=1.5,
        protocol="ring",
        args=args,
        release=True,
    )

    assert case["protocol"] == "ring"
    assert case["track_x_nm"] == args.track_x_nm
    assert case["track_y_nm"] == args.track_y_nm
    assert case["cell_size_nm"] == [0.5, 0.5, 0.5]
    assert case["track_size_nm"] == [args.track_x_nm, args.track_y_nm, 0.5]
    assert case["relax_tol_T"] == args.tol_t
    assert case["table_every_steps"] == args.table_every_steps
    assert case["pin_centres_nm"] is None


def test_persist_and_embed_contract_keep_sidecar_and_analysis_in_sync(tmp_path) -> None:
    args = paired_validation._args(_namespace())
    case = paired_validation._case(
        target_radius_nm=6.0,
        wall_width_nm=1.5,
        protocol="ring",
        args=args,
        release=True,
    )
    contract = {
        "schema_version": "bimeron_frozen_size.case_contract.v1",
        "contract_sha256": "abc",
        "request": {"case_id": case["case_id"]},
    }

    paired_validation._persist_contract(
        tmp_path,
        case=case,
        contract=contract,
        kind="frozen_from_baseline",
    )
    embedded = paired_validation._embed_contract(
        tmp_path,
        {"status": "measured", "protocol": {"protocol": "ring"}},
        contract,
    )

    assert (tmp_path / "request_contract.json").is_file()
    request = (tmp_path / "request.json").read_text(encoding="utf-8")
    assert "track_size_nm" in request
    assert embedded["provenance_contract"] == contract


def test_compare_state_vectors_reports_full_field_transfer(monkeypatch) -> None:
    values = {
        "baseline": [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)],
        "same": [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)],
        "changed": [(1.0, 0.0, 0.0), (0.0, 0.0, 1.0)],
    }
    monkeypatch.setattr(
        paired_validation,
        "_state_values",
        lambda path: values[path.name],
    )

    same = paired_validation._compare_state_vectors(
        type("PathLike", (), {"name": "baseline"})(),
        type("PathLike", (), {"name": "same"})(),
        transfer_tolerance=1e-12,
    )
    changed = paired_validation._compare_state_vectors(
        type("PathLike", (), {"name": "baseline"})(),
        type("PathLike", (), {"name": "changed"})(),
        transfer_tolerance=1e-12,
    )

    assert same["status"] == "compared"
    assert same["within_transfer_tolerance"] is True
    assert same["max_component_abs"] == 0.0
    assert changed["within_transfer_tolerance"] is False
    assert changed["max_component_abs"] > 0.0
    assert changed["max_angular_difference_rad"] > 0.0


def test_compare_state_vectors_rejects_mismatched_grid(monkeypatch) -> None:
    monkeypatch.setattr(
        paired_validation,
        "_state_values",
        lambda path: [(1.0, 0.0, 0.0)] if path.name == "short" else [(1.0, 0.0, 0.0)] * 2,
    )

    result = paired_validation._compare_state_vectors(
        type("PathLike", (), {"name": "short"})(),
        type("PathLike", (), {"name": "long"})(),
        transfer_tolerance=1e-12,
    )

    assert result["status"] == "incompatible_vector_count"
    assert result["within_transfer_tolerance"] is False


def test_state_preservation_gate_rejects_changed_hold_after_exact_transfer() -> None:
    thresholds = {
        "maximum_paired_hold_energy_delta_J": 1e-21,
        "maximum_paired_hold_rms_delta_m": 0.01,
        "maximum_paired_hold_max_delta_m": 0.1,
        "maximum_paired_hold_radius_delta_nm": 0.25,
    }
    result = paired_validation._state_preservation_gates(
        baseline_hold={"R_area_nm": 6.0},
        frozen_hold={"R_area_nm": 6.4},
        baseline_analysis={"profile_energy": {"E_total_J": -1.0e-18}},
        frozen_analysis={"profile_energy": {"E_total_J": -1.0e-18 + 2.0e-21}},
        full_state={
            "baseline_vs_frozen_initial": {
                "within_transfer_tolerance": True,
            },
            "baseline_vs_frozen_hold": {
                "rms_vector_l2": 0.02,
                "max_vector_l2": 0.2,
            },
        },
        thresholds=thresholds,
    )

    assert result["status"] == "failed"
    assert set(result["failures"]) == {
        "energy_delta_J",
        "rms_delta_m",
        "max_delta_m",
        "radius_delta_nm",
    }
