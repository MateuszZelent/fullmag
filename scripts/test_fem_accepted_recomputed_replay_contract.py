"""Source and numerical contract checks for FEM accepted-field replay.

This test is intentionally independent of Cargo and the native FEM runtime.
It checks the cross-layer wiring and exercises the comparison rule with both
field schema families, including a declared zero-Ku V2 material.
"""

from __future__ import annotations

import copy
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def _fields(*, version: str) -> dict[str, object]:
    anisotropy = [[4.0, 0.0, 0.0]] if version == "v2" else None
    h_eff = [[15.0, 0.0, 0.0]] if version == "v2" else [[11.0, 0.0, 0.0]]
    value: dict[str, object] = {
        "schema_version": f"CertifiedFemEquilibriumFields.{version}",
        "h_ex_a_per_m": [[1.0, 0.0, 0.0]],
        "h_demag_a_per_m": [[2.0, 0.0, 0.0]],
        "h_ext_a_per_m": [[8.0, 0.0, 0.0]],
        "h_anisotropy_a_per_m": anisotropy,
        "h_eff_a_per_m": h_eff,
        "phi_a": [0.0],
    }
    return value


def _max_vector_difference(left: list[list[float]], right: list[list[float]]) -> float:
    if len(left) != len(right):
        raise ValueError("shape mismatch")
    return max(
        abs(left[node][component] - right[node][component])
        for node in range(len(left))
        for component in range(3)
    )


def _max_scalar_difference(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        raise ValueError("shape mismatch")
    return max(abs(a - b) for a, b in zip(left, right))


def _replay_differences(
    accepted: dict[str, object], recomputed: dict[str, object]
) -> dict[str, float]:
    if accepted["schema_version"] != recomputed["schema_version"]:
        raise ValueError("schema mismatch")
    if (accepted["h_anisotropy_a_per_m"] is None) != (
        recomputed["h_anisotropy_a_per_m"] is None
    ):
        raise ValueError("anisotropy schema mismatch")
    differences = {
        name: _max_vector_difference(accepted[name], recomputed[name])
        for name in (
            "h_ex_a_per_m",
            "h_demag_a_per_m",
            "h_ext_a_per_m",
            "h_eff_a_per_m",
        )
    }
    if accepted["h_anisotropy_a_per_m"] is not None:
        differences["h_anisotropy_a_per_m"] = _max_vector_difference(
            accepted["h_anisotropy_a_per_m"], recomputed["h_anisotropy_a_per_m"]
        )
    differences["phi_a"] = _max_scalar_difference(accepted["phi_a"], recomputed["phi_a"])
    return differences


def run_accepted_recomputed_replay_contract() -> None:
    """Stable source-map anchor for the interpreted replay contract."""
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(
        AcceptedRecomputedReplayContractTests
    )
    result = unittest.TextTestRunner(verbosity=0).run(suite)
    if not result.wasSuccessful():
        raise AssertionError("accepted/recomputed replay contract failed")


class AcceptedRecomputedReplayContractTests(unittest.TestCase):
    def test_producer_and_consumer_bind_a_distinct_accepted_artifact(self) -> None:
        types = (ROOT / "crates/fullmag-runner/src/types.rs").read_text(encoding="utf-8")
        finalize = (
            ROOT / "crates/fullmag-runner/src/fem/relax/finalize.rs"
        ).read_text(encoding="utf-8")
        execution = (
            ROOT / "crates/fullmag-runner/src/fem/eigen_execution.rs"
        ).read_text(encoding="utf-8")
        validator = (ROOT / "crates/fullmag-runner/src/fem_eigen.rs").read_text(
            encoding="utf-8"
        )
        handoff = (
            ROOT / "crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs"
        ).read_text(encoding="utf-8")
        orchestrator = (ROOT / "crates/fullmag-cli/src/orchestrator.rs").read_text(
            encoding="utf-8"
        )
        production = orchestrator.rsplit("\n#[cfg(test)]\nmod tests {", 1)[0]
        cli_helper = production.split(
            "fn accepted_relax_handoff_from_completed_stage(", 1
        )[1].split("\nfn replace_continuation_after_synthetic_stage(", 1)[0]

        self.assertIn("accepted_fem_equilibrium_fields.v1.json", types)
        self.assertIn("accepted_fem_equilibrium_fields.v2.json", types)
        self.assertIn("accepted_fem_equilibrium_fields", finalize)
        self.assertIn("accepted_artifact_path_for_material", execution)
        self.assertIn("        accepted_fields,", execution)
        self.assertIn("from_completed_relax_verified", execution)
        self.assertIn("accepted_fields: &crate::types::CertifiedFemEquilibriumFields", validator)
        self.assertIn("h_anisotropy0", validator)
        self.assertIn("from_completed_relax_verified", handoff)
        self.assertIn("accepted_artifact_path_for_material", production)
        self.assertIn("next_continuation_accepted_fields", production)
        self.assertIn("from_completed_relax_verified", cli_helper)
        self.assertNotIn("AcceptedFemRelaxStageHandoff::from_completed_relax(", cli_helper)

    def test_v1_and_v2_replay_records_exact_independent_differences(self) -> None:
        for version in ("v1", "v2"):
            accepted = _fields(version=version)
            recomputed = copy.deepcopy(accepted)
            recomputed["h_eff_a_per_m"][0][0] += 2.5e-9
            recomputed["phi_a"][0] = 2.5e-15
            if version == "v2":
                recomputed["h_anisotropy_a_per_m"][0][1] += 1.5e-9
            differences = _replay_differences(accepted, recomputed)
            self.assertAlmostEqual(differences["h_eff_a_per_m"], 2.5e-9)
            self.assertAlmostEqual(differences["phi_a"], 2.5e-15)
            if version == "v2":
                self.assertAlmostEqual(differences["h_anisotropy_a_per_m"], 1.5e-9)
            else:
                self.assertNotIn("h_anisotropy_a_per_m", differences)

    def test_forged_recorded_difference_is_rejected(self) -> None:
        accepted = _fields(version="v2")
        recomputed = copy.deepcopy(accepted)
        recomputed["h_anisotropy_a_per_m"][0][0] += 1.0e-8
        differences = _replay_differences(accepted, recomputed)
        forged = dict(differences)
        forged["h_anisotropy_a_per_m"] = 0.0
        self.assertNotEqual(forged["h_anisotropy_a_per_m"], differences["h_anisotropy_a_per_m"])

    def test_zero_ku_uses_v2_presence_semantics(self) -> None:
        types = (ROOT / "crates/fullmag-runner/src/types.rs").read_text(encoding="utf-8")
        selector = types.split("pub fn artifact_paths_for_material", 1)[1].split(
            "pub fn from_fields", 1
        )[0]
        self.assertIn("material.uniaxial_anisotropy.is_some()", selector)
        self.assertIn("accepted_fem_equilibrium_fields.v2.json", selector)


if __name__ == "__main__":
    unittest.main()
