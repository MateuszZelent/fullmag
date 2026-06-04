import pytest

import fullmag as fm


def test_table_autosave_lowers_default_columns_to_sampling_ir() -> None:
    study = fm.Relaxation(
        outputs=[fm.SaveScalar("E_total", every=1e-12)],
        table_autosave=fm.TableAutosave(t_sampl=2e-12),
    )

    assert study.to_ir()["sampling"]["table_autosave"] == {
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_s": 2e-12,
        "quantities": ["step", "t", "mx", "my", "mz", "e_total", "max_torque"],
    }


def test_table_autosave_accepts_custom_quantities_and_rejects_empty_lists() -> None:
    autosave = fm.TableAutosave(
        t_sampl=5e-13,
        quantities=["step", "t", "mx"],
        extra_quantities=["e_demag"],
    )

    assert autosave.to_ir()["quantities"] == ["step", "t", "mx", "e_demag"]

    with pytest.raises(ValueError, match="quantities must not be empty"):
        fm.TableAutosave(t_sampl=1e-12, quantities=[])


def test_time_evolution_accepts_study_table_autosave_helper() -> None:
    study = fm.TimeEvolution(
        dynamics=fm.LLG(),
        outputs=[fm.SaveScalar("E_total", every=1e-12)],
    ).table_autosave(t_sampl=1e-12, quantities=["step", "t"])

    assert study.to_ir()["sampling"]["table_autosave"]["quantities"] == ["step", "t"]


def test_table_autosave_rejects_non_positive_sample_period() -> None:
    with pytest.raises(ValueError, match="t_sampl must be positive"):
        fm.TableAutosave(t_sampl=0.0)
