import pytest

import fullmag as fm


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
