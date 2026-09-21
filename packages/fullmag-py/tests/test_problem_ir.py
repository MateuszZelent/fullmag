import math

import pytest

import fullmag as fm
from fullmag.model.canonical import canonical_json_bytes, canonical_json_sha256


def test_problem_ir_canonical_json_is_order_independent_and_strict() -> None:
    first = {"b": [1, 2], "a": {"unit": "A/m", "value": 800000.0}}
    second = {"a": {"value": 800000.0, "unit": "A/m"}, "b": [1, 2]}

    assert canonical_json_bytes(first) == b'{"a":{"unit":"A/m","value":800000.0},"b":[1,2]}'
    assert canonical_json_sha256(first) == canonical_json_sha256(second)
    with pytest.raises(ValueError, match="Out of range float values are not JSON compliant"):
        canonical_json_bytes({"value": float("nan")})


def test_eigenmodes_periodic_airbox_k0_serializes_canonical_intent() -> None:
    study = fm.Eigenmodes(
        outputs=[fm.SaveSpectrum()],
        count=2,
        target="frequency_window",
        frequency_min=1.0e9,
        frequency_max=2.0e9,
        include_demag=True,
        magnetostatic_bc="periodic_airbox_k0",
        k_vector=(0.0, 0.0, 0.0),
        spin_wave_bc="periodic",
    )

    ir = study.to_ir()

    assert ir["magnetostatic_bc"] == "periodic_airbox_k0"
    assert ir["operator"]["include_demag"] is True
    assert ir["k_sampling"] == {"kind": "single", "k_vector": [0.0, 0.0, 0.0]}


def test_eigenmodes_bias_field_sweep_serializes_declared_si_samples() -> None:
    study = fm.Eigenmodes(
        outputs=[fm.SaveSpectrum()],
        include_demag=True,
        magnetostatic_bc="periodic_airbox_k0",
        k_vector=(0.0, 0.0, 0.0),
        spin_wave_bc="periodic",
        bias_field_sweep=fm.BiasFieldSweep(
            samples_a_per_m=[
                (12_500.0, 0.0, 0.0),
                (25_000.0, 0.0, 0.0),
                (50_000.0, 0.0, 0.0),
            ],
            equilibrium_policy="continuation",
            continuation_seed="previous_accepted_equilibrium",
        ),
    )

    assert study.to_ir()["bias_field_sweep"] == {
        "samples_a_per_m": [
            [12_500.0, 0.0, 0.0],
            [25_000.0, 0.0, 0.0],
            [50_000.0, 0.0, 0.0],
        ],
        "equilibrium_policy": "continuation",
        "ordering": "declared",
        "continuation_seed": "previous_accepted_equilibrium",
    }


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"include_demag": False}, "include_demag"),
        ({"spin_wave_bc": "free"}, "spin_wave_bc"),
        ({"k_vector": (1.0, 0.0, 0.0)}, "k_vector"),
        ({"damping_policy": "include"}, "damping_policy"),
    ],
)
def test_eigenmodes_periodic_airbox_k0_rejects_invalid_public_contract(kwargs, message) -> None:
    base = {
        "outputs": [fm.SaveSpectrum()],
        "target": "frequency_window",
        "frequency_min": 1.0e9,
        "frequency_max": 2.0e9,
        "include_demag": True,
        "magnetostatic_bc": "periodic_airbox_k0",
        "k_vector": (0.0, 0.0, 0.0),
        "spin_wave_bc": "periodic",
    }
    base.update(kwargs)

    with pytest.raises(ValueError, match=message):
        fm.Eigenmodes(**base)


@pytest.mark.parametrize("axes", [(True, False, False), (True, True, True)])
def test_periodic_airbox_k0_requires_xy_periodic_open_z(axes) -> None:
    with pytest.raises(ValueError, match="x/y periodic axes and open z"):
        fm.FdmPbc(axes=axes, demag="periodic_airbox_k0")


def test_eigenmodes_rejects_conflicting_legacy_k_vector() -> None:
    with pytest.raises(ValueError, match="either k_sampling or k_vector"):
        fm.Eigenmodes(
            outputs=[fm.SaveSpectrum()], k_vector=(0.0, 0.0, 0.0),
            k_sampling=fm.KPoint("X", (1.0, 0.0, 0.0)),
        )


@pytest.mark.parametrize(
    "vector",
    [
        (1.0, 2.0),
        (1.0, 2.0, math.nan),
        (1.0, 2.0, math.inf),
        "123",
    ],
)
def test_k_point_and_single_k_sampling_require_finite_xyz(vector) -> None:
    with pytest.raises(ValueError, match="exactly three|finite"):
        fm.KPoint("X", vector)
    with pytest.raises(ValueError, match="exactly three|finite"):
        fm.Eigenmodes(outputs=[fm.SaveSpectrum()], k_sampling=vector)


def test_k_path_requires_k_point_control_points() -> None:
    with pytest.raises(ValueError, match="KPoint"):
        fm.KPath(
            points=[(0.0, 0.0, 0.0), fm.KPoint("X", (1.0, 0.0, 0.0))],
            samples_per_segment=[1],
        )


@pytest.mark.parametrize("value", [1.5, True, "1", 2**32])
def test_k_path_samples_per_segment_requires_positive_u32_integers(value) -> None:
    points = [
        fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
        fm.KPoint("X", (1.0, 0.0, 0.0)),
    ]

    with pytest.raises(ValueError, match="positive integers"):
        fm.KPath(points=points, samples_per_segment=[value])


@pytest.mark.parametrize("value", [1, 2**32 - 1])
def test_k_path_samples_per_segment_accepts_positive_u32_boundaries(value) -> None:
    path = fm.KPath(
        points=[
            fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (1.0, 0.0, 0.0)),
        ],
        samples_per_segment=[value],
    )

    assert path.to_ir()["samples_per_segment"] == [value]


def test_save_mode_preserves_branch_and_sample_selectors_in_python_ir() -> None:
    output = fm.SaveMode(
        field="mode",
        branches=[2, 0],
        sample_indices=[3, 1],
        sample_labels=["X", "M"],
    )

    assert output.to_ir() == {
        "kind": "eigen_mode",
        "field": "mode",
        "indices": [],
        "branches": [2, 0],
        "sample_selector": {
            "sample_indices": [3, 1],
            "sample_labels": ["X", "M"],
        },
    }


def test_save_dispersion_preserves_branch_table_option_in_python_ir() -> None:
    assert fm.SaveDispersion(
        name="band", include_branch_table=False
    ).to_ir() == {
        "kind": "dispersion_curve",
        "name": "band",
        "include_branch_table": False,
    }


@pytest.mark.parametrize("value", [1.5, True, "1", 2**32])
def test_save_mode_selectors_require_integer_ids(value) -> None:
    with pytest.raises(ValueError, match="integers"):
        fm.SaveMode(field="mode", indices=[value])
    with pytest.raises(ValueError, match="integers"):
        fm.SaveMode(field="mode", branches=[value])
    with pytest.raises(ValueError, match="integers"):
        fm.SaveMode(field="mode", indices=[0], sample_indices=[value])
