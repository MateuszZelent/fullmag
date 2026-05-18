"""Unit checks for FEM demag runtime-validation acceptance helpers."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    ValidationFailure,
    require_finite_metrics,
    require_grouped_error_improvement,
    require_relative_error_below,
)


class DemagValidationAcceptanceTests(unittest.TestCase):
    def test_finite_metrics_reject_nan_rows(self) -> None:
        rows = [{"case": "bad", "n_rel_error": math.nan}]

        with self.assertRaisesRegex(ValidationFailure, "bad.*n_rel_error"):
            require_finite_metrics(rows, ["n_rel_error"], label_key="case")

    def test_relative_error_threshold_rejects_failure(self) -> None:
        row = {"case": "sphere", "n_rel_error": 0.051}

        with self.assertRaisesRegex(ValidationFailure, "sphere.*5.00%"):
            require_relative_error_below(
                row,
                error_key="n_rel_error",
                threshold=0.05,
                label="sphere",
            )

    def test_grouped_error_improvement_rejects_non_convergent_group(self) -> None:
        rows = [
            {"bc": "poisson_robin", "scale": 1.2, "n_rel_error": 0.08},
            {"bc": "poisson_robin", "scale": 4.0, "n_rel_error": 0.09},
        ]

        with self.assertRaisesRegex(ValidationFailure, "poisson_robin.*not convergent"):
            require_grouped_error_improvement(
                rows,
                group_key="bc",
                order_key="scale",
                error_key="n_rel_error",
            )


if __name__ == "__main__":
    unittest.main()
