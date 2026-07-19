#!/usr/bin/env python3
"""Focused fail-closed tests for periodic-antidot LLG runtime validation."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate_fem_periodic_antidot_llg_qualification_runtime.py")
SPEC = importlib.util.spec_from_file_location("periodic_antidot_validator", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RuntimeValidatorTests(unittest.TestCase):
    def policy(self) -> dict:
        common = {
            "kind": "adaptive", "integrator": "rk45", "tolerance_mode": "max_error",
            "dt_initial_s": 1.0e-15, "dt_min_s": 1.0e-16, "dt_max_s": 1.0e-14,
            "atol": 1.0e-6, "rtol": 0.0,
        }
        return {
            "schema_version": "LLG-TD-SOLVER-CONFIG-V1",
            "execution_identity": {"device": "cpu"},
            "requested_policy": dict(common),
            "resolved_policy": {**common, "dt_initial_reason": "explicit", "estimator_order": 4},
        }

    def test_accepts_canonical_adaptive_policy(self) -> None:
        MODULE.validate_policy(self.policy(), "cpu")

    def test_rejects_hardcoded_large_initial_timestep(self) -> None:
        policy = self.policy()
        policy["requested_policy"]["dt_initial_s"] = 1.0e-13
        with self.assertRaisesRegex(MODULE.ValidationError, "dt_initial_s"):
            MODULE.validate_policy(policy, "cpu")

    def test_rejects_gpu_fallback_or_missing_cuda(self) -> None:
        metadata = {
            "requested_execution": {
                "backend": "fem", "device": "gpu", "precision": "double",
                "mode": "strict", "fallback_policy": "forbidden",
            },
            "execution_provenance": {
                "lossy_fallback_used": True, "precision": "double",
                "resolved_demag_realization": "fem_poisson_robin",
                "uses_gpu_poisson": False, "execution_engine": "fem_cpu_native",
                "uses_cuda_kernels": False, "fem_gpu_state_allocated": False,
            },
        }
        with self.assertRaisesRegex(MODULE.ValidationError, "fallback"):
            MODULE.validate_provenance(metadata, "gpu", "run")


if __name__ == "__main__":
    unittest.main()
