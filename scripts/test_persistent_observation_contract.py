from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PHYSICS_NOTE = ROOT / "docs/physics/interactive-observation-and-restart-semantics.md"
ADR = ROOT / "docs/adr/0025-persistent-runtime-and-observation-sources.md"
OBSERVABLE_DESIGN = (
    ROOT
    / "docs/superpowers/specs/2026-08-15-fdm-fem-observable-materialization-parity-design.md"
)
BACKEND_MASTERPLAN = ROOT / "docs/architecture/backend-golden-masterplan.md"
API_V2 = ROOT / "docs/specs/resource-first-control-room-api-v2.md"
CAPABILITY_MD = ROOT / "docs/specs/capability-matrix-v0.md"
CAPABILITY_JSON = ROOT / "docs/specs/capability-matrix-v0.json"


class PersistentObservationContractTest(unittest.TestCase):
    def test_canonical_terms_and_on_demand_materialization_are_documented(self) -> None:
        owners = [PHYSICS_NOTE, ADR]
        for owner in owners:
            self.assertTrue(owner.is_file(), f"missing canonical contract owner: {owner}")

        combined = "\n".join(path.read_text(encoding="utf-8") for path in owners)
        for term in (
            "AcceptedStateId",
            "AcceptedStateRef",
            "ObservationSource",
            "LogicalResume",
            "ExactResume",
        ):
            self.assertIn(term, combined)

        design = OBSERVABLE_DESIGN.read_text(encoding="utf-8")
        self.assertIn("ComputeQuantities", design)
        self.assertIn("on-demand", design)
        self.assertNotIn("pełny aktywny zestaw terminalny musi", design)

    def test_cross_layer_contracts_share_runtime_and_transport_invariants(self) -> None:
        required_fragments = {
            BACKEND_MASTERPLAN: (
                "LiveRuntime",
                "ObservationRuntime",
                "bez silent fallbacku",
            ),
            API_V2: (
                "HTTP v2",
                "websocket",
                "ObservationSource",
                "jeden field data plane",
            ),
            CAPABILITY_MD: (
                "source presence",
                "executability",
                "validation",
                "production qualification",
            ),
        }
        for path, fragments in required_fragments.items():
            text = path.read_text(encoding="utf-8")
            for fragment in fragments:
                self.assertIn(fragment, text, f"{path}: missing {fragment!r}")

    def test_capability_matrix_has_four_unpromoted_runtime_lanes(self) -> None:
        matrix = json.loads(CAPABILITY_JSON.read_text(encoding="utf-8"))
        contract = matrix["observation_runtime_contract"]
        self.assertEqual(contract["schema"], "observation-runtime-capability.v1")
        self.assertEqual(
            set(contract["lanes"]),
            {"fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu"},
        )
        for lane in contract["lanes"].values():
            self.assertEqual(
                set(lane),
                {
                    "source_presence",
                    "executability",
                    "validation",
                    "production_qualification",
                },
            )
            self.assertEqual(lane["production_qualification"], "not_qualified")


if __name__ == "__main__":
    unittest.main()
