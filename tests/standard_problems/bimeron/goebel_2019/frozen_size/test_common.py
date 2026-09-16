from __future__ import annotations

import math

import pytest

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    alpha_from_environment,
    contour_radius_from_preset,
    discrete_core_centres_m,
    material_from_environment,
)


def test_discrete_core_centres_follow_grid_extrema() -> None:
    preset = 1.7508881427972536e-9
    width = 3.0e-9
    cell = 0.5e-9
    centres = discrete_core_centres_m(
        preset,
        width,
        cell,
        helicity_rad=0.0,
        vorticity=-1,
        background_sign=1,
    )

    assert len(centres) == 2
    assert centres[0][0] * centres[1][0] < 0.0
    assert max(abs(point[1]) for point in centres) <= cell
    target = contour_radius_from_preset(preset, width)
    assert all(abs(abs(point[0]) - target) <= cell for point in centres)


def test_discrete_core_centres_track_helicity_and_background_sign() -> None:
    preset = 1.7508881427972536e-9
    width = 3.0e-9
    cell = 0.5e-9
    rotated = discrete_core_centres_m(
        preset,
        width,
        cell,
        helicity_rad=0.5 * math.pi,
        vorticity=-1,
        background_sign=1,
    )
    flipped = discrete_core_centres_m(
        preset,
        width,
        cell,
        helicity_rad=0.0,
        vorticity=-1,
        background_sign=-1,
    )

    assert max(abs(point[0]) for point in rotated) <= cell
    assert rotated[0][1] * rotated[1][1] < 0.0
    assert flipped[0][0] * flipped[1][0] < 0.0


def test_material_overrides_are_positive_and_metadata_is_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FULLMAG_BIMERON_D_J_PER_M2", "4.0e-3")
    monkeypatch.setenv("FULLMAG_BIMERON_MSAT_A_PER_M", "6.0e5")
    values = material_from_environment()

    assert values.d_Jpm2 == 4.0e-3
    assert values.msat_Apm == 6.0e5
    assert values.metadata()["Aex_Jpm"] == 15.0e-12


def test_material_overrides_reject_non_positive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FULLMAG_BIMERON_KU_J_PER_M3", "0")
    with pytest.raises(ValueError, match="must be positive"):
        material_from_environment()


def test_alpha_override_is_explicit_and_positive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FULLMAG_BIMERON_ALPHA", "1.0")
    assert alpha_from_environment() == 1.0


def test_alpha_override_rejects_non_positive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FULLMAG_BIMERON_ALPHA", "0")
    with pytest.raises(ValueError, match="must be positive"):
        alpha_from_environment()
