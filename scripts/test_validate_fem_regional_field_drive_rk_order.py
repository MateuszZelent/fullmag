from scripts.validate_fem_regional_field_drive_rk_order import regression_slope, validate


def test_regression_slope_recovers_order() -> None:
    dt = [0.2, 0.1, 0.05, 0.025]
    assert abs(regression_slope(dt, [value**4 for value in dt]) - 4.0) < 1e-12


def test_validator_accepts_all_contracts() -> None:
    dt = [0.2, 0.1, 0.05]
    payload = {
        "integrators": {
            name: {"dt_s": dt, "error": [value**order for value in dt]}
            for name, order in {"heun": 2, "rk4": 4, "rk23": 3, "rk45": 5}.items()
        },
        "events": {
            "crossing_contamination": False,
            "fsal_invalidated_at_discontinuity": True,
        },
        "energy": {
            "measured_j": -2e-20,
            "minus_mu0_integral_j": -2e-20,
            "absolute_tolerance_j": 1e-30,
        },
    }
    assert validate(payload) == []


def test_validator_rejects_hidden_half_factor() -> None:
    dt = [0.2, 0.1, 0.05]
    payload = {
        "integrators": {
            name: {"dt_s": dt, "error": [value**order for value in dt]}
            for name, order in {"heun": 2, "rk4": 4, "rk23": 3, "rk45": 5}.items()
        },
        "events": {
            "crossing_contamination": False,
            "fsal_invalidated_at_discontinuity": True,
        },
        "energy": {
            "measured_j": -1e-20,
            "minus_mu0_integral_j": -2e-20,
            "absolute_tolerance_j": 1e-30,
        },
    }
    assert any("energy mismatch" in failure for failure in validate(payload))
