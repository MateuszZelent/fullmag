from __future__ import annotations

import math

from tests.standard_problems.bimeron.goebel_2019.verify import analyze_fdm_state


def _analytic_bimeron(nx: int, ny: int) -> list[list[float]]:
    values: list[list[float]] = []
    radius = 10.0
    width = 3.0
    for y_index in range(ny):
        y = y_index + 0.5 - ny / 2.0
        for x_index in range(nx):
            x = x_index + 0.5 - nx / 2.0
            distance = math.hypot(x, y)
            theta = math.asin(math.tanh((distance - radius) / width)) + math.asin(
                math.tanh((distance + radius) / width)
            )
            phase = math.atan2(y, x)
            values.append(
                [
                    -math.cos(theta),
                    -math.sin(theta) * math.sin(phase),
                    -math.sin(theta) * math.cos(phase),
                ]
            )
    return values


def test_analyze_fdm_state_recovers_bimeron_charge_and_two_cores() -> None:
    result = analyze_fdm_state(
        _analytic_bimeron(80, 40),
        grid_cells=(80, 40, 1),
        cell_size=(1e-9, 1e-9, 0.5e-9),
        origin=(-40e-9, -20e-9, -0.25e-9),
        periodic_x=True,
    )

    assert result["topological_charge"] > 0.99
    assert result["max_mz"] > 0.98
    assert result["min_mz"] < -0.98
    assert result["mean_mx"] > 0.78
    assert result["core_separation_m"] > 18e-9


def test_analyze_fdm_state_rejects_shape_mismatch() -> None:
    try:
        analyze_fdm_state(
            [[1.0, 0.0, 0.0]],
            grid_cells=(2, 2, 1),
            cell_size=(1.0, 1.0, 1.0),
            origin=(0.0, 0.0, 0.0),
            periodic_x=True,
        )
    except ValueError as exc:
        assert "value count" in str(exc)
    else:
        raise AssertionError("shape mismatch must fail closed")
