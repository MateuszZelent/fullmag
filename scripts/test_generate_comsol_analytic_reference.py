#!/usr/bin/env python3
"""Tests for the COMSOL thin-film analytical dispersion reference generator."""

from __future__ import annotations

import csv
import importlib.util
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
GENERATOR = REPO_ROOT / "scripts" / "generate_comsol_analytic_reference.py"


def load_generator_module():
    spec = importlib.util.spec_from_file_location(
        "generate_comsol_analytic_reference", GENERATOR
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_p00_is_zero_at_gamma_and_stable_for_small_k() -> None:
    module = load_generator_module()

    assert module.p00_demag_factor(0.0, module.FILM_THICKNESS_M) == 0.0
    assert module.p00_demag_factor(1.0e-9, module.FILM_THICKNESS_M) == pytest.approx(
        5.0e-18, rel=2.0e-2, abs=1.0e-19
    )
    assert module.p00_demag_factor(module.K_X_RAD_PER_M, module.FILM_THICKNESS_M) == pytest.approx(
        0.074584, rel=2.0e-5
    )


def test_c1_gamma_and_bv_de_values_include_dynamic_demag() -> None:
    module = load_generator_module()

    gamma = module.frequency_hz(0.0, "backward_volume")
    assert gamma == pytest.approx(9.309813711433355e9, rel=1.0e-12)
    assert module.frequency_hz(0.0, "damon_eshbach") == pytest.approx(gamma, rel=1.0e-12)

    bv_x = module.frequency_hz(module.K_X_RAD_PER_M, "backward_volume")
    de_x = module.frequency_hz(module.K_X_RAD_PER_M, "damon_eshbach")
    assert bv_x == pytest.approx(9.378228224e9, rel=2.0e-6)
    assert de_x == pytest.approx(12.206610505e9, rel=2.0e-6)
    assert de_x > bv_x > gamma


def test_reference_rows_have_both_orientations_and_physical_columns(tmp_path: Path) -> None:
    module = load_generator_module()

    rows = module.reference_rows(max_k_rad_per_m=module.K_X_RAD_PER_M, samples=3)
    assert len(rows) == 6
    assert {row["geometry"] for row in rows} == {
        "backward_volume",
        "damon_eshbach",
    }
    assert rows[0]["k_rad_per_m"] == 0.0
    assert rows[0]["p00"] == 0.0
    assert rows[0]["demag_enabled"] is True
    assert rows[-1]["k_rad_per_m"] == module.K_X_RAD_PER_M
    assert all(row["frequency_hz"] > 0.0 for row in rows)
    assert all(0.0 <= row["p00"] < 1.0 for row in rows)

    output = tmp_path / "reference.csv"
    module.write_reference_csv(output, rows)
    with output.open(newline="", encoding="utf-8") as stream:
        written = list(csv.DictReader(stream))
    assert len(written) == 6
    assert written[0]["analytic_model"] == "kalinikos_slab_n0"
    assert written[0]["demag_model"] == "dynamic_thin_film_P00"


def test_main_writes_deterministic_csv(tmp_path: Path) -> None:
    module = load_generator_module()
    output = tmp_path / "nested" / "reference.csv"

    assert module.main(["--output", str(output), "--samples", "2"]) == 0
    assert output.is_file()
    rows = list(csv.DictReader(output.read_text(encoding="utf-8").splitlines()))
    assert len(rows) == 4
    assert {row["geometry"] for row in rows} == {
        "backward_volume",
        "damon_eshbach",
    }


@pytest.mark.parametrize("geometry", ["backward_volume", "damon_eshbach"])
@pytest.mark.parametrize("k", [1e-12, 1e-9, 1e-6])
def test_frequency_is_continuous_at_gamma(geometry: str, k: float) -> None:
    module = load_generator_module()
    assert module.frequency_hz(k, geometry) == pytest.approx(
        module.frequency_hz(0.0, geometry), rel=1e-12
    )


@pytest.mark.parametrize("kd", [1e-18, 1e-10, 9.999e-5, 1e-4, 1.001e-4, 0.15707963267948966, 1.0])
def test_p00_matches_high_precision_direct_formula(kd: float) -> None:
    from decimal import Decimal, localcontext
    module = load_generator_module()
    with localcontext() as context:
        context.prec = 80
        x = Decimal(str(kd))
        expected = float(1 - (1 - (-x).exp()) / x)
    assert module.p00_demag_factor(kd / module.FILM_THICKNESS_M, module.FILM_THICKNESS_M) == pytest.approx(
        expected, rel=4e-12, abs=0.0
    )


@pytest.mark.parametrize("geometry", ["backward_volume", "damon_eshbach"])
@pytest.mark.parametrize("k", [1e-9, 1e-6, 9999., 10000., 1.5707963267948966e7])
def test_frequency_matches_high_precision_slab_formula(k: float, geometry: str) -> None:
    from decimal import Decimal, localcontext
    module = load_generator_module()
    with localcontext() as context:
        context.prec = 80
        wave = Decimal(str(k))
        thickness = Decimal(str(module.FILM_THICKNESS_M))
        ms = Decimal(str(module.MS_A_PER_M))
        x = wave * thickness
        p = 1 - (1 - (-x).exp()) / x
        h = Decimal(str(module.BIAS_FIELD_A_PER_M)) + 2 * Decimal(str(module.AEX_J_PER_M)) * wave**2 / (Decimal(str(module.MU0_H_PER_M)) * ms)
        product = (h + ms * (1 - p)) * (h + ms * p) if geometry == "damon_eshbach" else h * (h + ms * (1 - p))
        expected = float(Decimal(str(module.GAMMA_M_PER_A_S)) * product.sqrt() / Decimal(str(2 * module.math.pi)))
    assert module.frequency_hz(k, geometry) == pytest.approx(expected, rel=1e-12)
