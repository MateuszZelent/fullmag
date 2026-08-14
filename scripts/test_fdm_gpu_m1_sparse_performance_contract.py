from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PERFORMANCE_SOURCE = (
    ROOT / "backends/fdm/tests/gpu_m1_spin_sparse_performance_v1_contract.cu"
)


class FdmGpuM1SparsePerformanceContractTests(unittest.TestCase):
    def test_direct_sparse_operators_receive_the_frozen_device_budget(self) -> None:
        source = PERFORMANCE_SOURCE.read_text(encoding="utf-8")
        operator_setups = re.findall(
            r"sparse::Operator input\{\};(?P<body>.*?)sparse::prepare\(input",
            source,
            flags=re.DOTALL,
        )

        self.assertEqual(2, len(operator_setups))
        for setup in operator_setups:
            self.assertRegex(
                setup,
                r"input\.resolved_device_budget_bytes\s*=\s*"
                r"UINT64_C\(2147483648\);",
            )


if __name__ == "__main__":
    unittest.main()
