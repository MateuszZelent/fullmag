"""Unit checks for FEM exchange runtime-validation acceptance helpers."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    MU0,
    ValidationFailure,
    analytical_helical_exchange_amplitude,
    analytical_helical_exchange_energy,
    exchange_amplitude_from_energy,
    exchange_field_scale,
    require_error_decreases_with_refinement,
    require_finite_metrics,
    require_relative_error_below,
)


class ExchangeValidationAcceptanceTests(unittest.TestCase):
    def test_exchange_field_scale_uses_mu0_ms_units(self) -> None:
        scale = exchange_field_scale(aex=13e-12, ms=800e3)

        self.assertAlmostEqual(scale, 2.0 * 13e-12 / (MU0 * 800e3))

    def test_helical_exchange_amplitude_matches_laplacian_reference(self) -> None:
        wavelength = 100e-9
        amplitude = analytical_helical_exchange_amplitude(
            aex=13e-12,
            ms=800e3,
            wavelength=wavelength,
        )
        k = 2.0 * math.pi / wavelength

        self.assertAlmostEqual(amplitude, (2.0 * 13e-12 / (MU0 * 800e3)) * k * k)

    def test_helical_exchange_energy_matches_continuum_reference(self) -> None:
        wavelength = 100e-9
        volume = 200e-9 * 20e-9 * 10e-9
        energy = analytical_helical_exchange_energy(
            aex=13e-12,
            wavelength=wavelength,
            volume=volume,
        )
        k = 2.0 * math.pi / wavelength

        self.assertAlmostEqual(energy, 13e-12 * k * k * volume)

    def test_exchange_amplitude_from_energy_matches_helical_reference(self) -> None:
        wavelength = 100e-9
        volume = 200e-9 * 20e-9 * 10e-9
        energy = analytical_helical_exchange_energy(
            aex=13e-12,
            wavelength=wavelength,
            volume=volume,
        )

        self.assertAlmostEqual(
            exchange_amplitude_from_energy(
                exchange_energy=energy,
                ms=800e3,
                volume=volume,
            ),
            analytical_helical_exchange_amplitude(
                aex=13e-12,
                ms=800e3,
                wavelength=wavelength,
            ),
        )

    def test_finite_metrics_reject_nan_rows(self) -> None:
        rows = [{"case": "bad", "h_ex_rel_error": math.nan}]

        with self.assertRaisesRegex(ValidationFailure, "bad.*h_ex_rel_error"):
            require_finite_metrics(rows, ["h_ex_rel_error"], label_key="case")

    def test_relative_error_threshold_rejects_failure(self) -> None:
        row = {"case": "sinusoidal", "h_ex_rel_error": 0.151}

        with self.assertRaisesRegex(ValidationFailure, "sinusoidal.*15.00%"):
            require_relative_error_below(
                row,
                error_key="h_ex_rel_error",
                threshold=0.15,
                label="sinusoidal",
            )

    def test_sinusoidal_laplacian_threshold_accepts_runtime_artifact(self) -> None:
        row = {"case": "sinusoidal", "h_ex_rel_error": 0.24}

        require_relative_error_below(
            row,
            error_key="h_ex_rel_error",
            threshold=0.25,
            label="sinusoidal",
        )

    def test_refinement_requires_error_decrease(self) -> None:
        rows = [
            {"hmax_m": 16e-9, "h_ex_rel_error": 0.10},
            {"hmax_m": 8e-9, "h_ex_rel_error": 0.12},
        ]

        with self.assertRaisesRegex(ValidationFailure, "not convergent"):
            require_error_decreases_with_refinement(
                rows,
                hmax_key="hmax_m",
                error_key="h_ex_rel_error",
            )


if __name__ == "__main__":
    unittest.main()
