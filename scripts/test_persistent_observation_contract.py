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
SOURCE_MAP = (
    ROOT
    / "docs/physics/interactive-observation-and-restart-semantics.source-map.json"
)

CANONICAL_LANES = {
    "fdm_cpu_reference",
    "fdm_gpu_production",
    "fem_cpu_public",
    "fem_gpu_public",
}
OBSERVATION_FEATURE_IDS = {
    "runtime.live_residency",
    "runtime.historical_observation",
    "runtime.logical_resume",
    "runtime.exact_resume",
}
ACCEPTED_STATE_ID_FIELDS = {
    "run_id",
    "stage_id",
    "accepted_step",
    "clock_digest",
    "state_digest",
    "domain_digest",
    "plan_digest",
}
PUBLIC_API_PARAMETERS = {
    "TableAutosave.t_sampl",
    "TableAutosave.every_steps",
    "TableAutosave.quantities",
    "TableAutosave.extra_quantities",
    "TableAutosave.expressions",
    "TableAutosave.table_id",
    "FieldAutosave.quantity",
    "FieldAutosave.every",
    "FieldAutosave.every_steps",
    "StageAutosave.target",
    "StageAutosave.layout",
    "StageAutosave.format",
    "StageAutosave.table",
    "StageAutosave.fields",
}


class PersistentObservationContractTest(unittest.TestCase):
    def test_canonical_terms_and_on_demand_materialization_are_documented(self) -> None:
        owners = [PHYSICS_NOTE, ADR]
        for owner in owners:
            self.assertTrue(owner.is_file(), f"missing canonical contract owner: {owner}")
            owner_text = owner.read_text(encoding="utf-8")
            for term in (
                "AcceptedStateId",
                "AcceptedStateGeneration",
                "AcceptedStateRef",
                "ObservationSource",
                "LogicalResume",
                "ExactResume",
            ):
                self.assertIn(term, owner_text, f"{owner}: missing {term}")

        adr = ADR.read_text(encoding="utf-8")
        for decision in range(1, 9):
            self.assertIn(f"D-{decision:02d}.", adr)

        for owner in owners:
            owner_text = owner.read_text(encoding="utf-8")
            for field in ACCEPTED_STATE_ID_FIELDS:
                self.assertIn(
                    f"`{field}`",
                    owner_text,
                    f"{owner}: incomplete AcceptedStateId",
                )
            for field in ("runtime_epoch", "accepted_revision"):
                self.assertIn(
                    f"`{field}`",
                    owner_text,
                    f"{owner}: incomplete AcceptedStateGeneration",
                )
            self.assertIn("bitwise", owner_text)

        design = OBSERVABLE_DESIGN.read_text(encoding="utf-8")
        self.assertIn("ComputeQuantities", design)
        self.assertIn("on-demand", design)
        self.assertNotIn("pełny aktywny zestaw terminalny musi", design)
        normalized_design = " ".join(design.split())
        self.assertIn(
            "Eager terminal-all-fields może istnieć wyłącznie jako jawna "
            "optymalizacja prefetch",
            normalized_design,
        )

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
                "GET /v2/sessions/current/data/observation-results/{observation_id}",
                "GET /v2/sessions/current/data/observation-results/{observation_id}/scalars",
                "GET /v2/sessions/current/data/fields/{quantity_id}/availability",
                "data/fields/{quantity_id}/meta",
                "data/fields/{quantity_id}/samples/vector",
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

        api = API_V2.read_text(encoding="utf-8")
        api_lower = " ".join(api.lower().split())
        self.assertIn("http v2 pozostaje źródłem prawdy", api_lower)
        self.assertIn("websocket nie niesie pól", api_lower)
        self.assertNotIn("websocket jest źródłem prawdy", api_lower)
        self.assertNotIn("websocket niesie pola", api_lower)
        self.assertNotIn(
            "wszystkie payloady przechodzą przez jeden `ComputeQuantities` i jeden "
            "field data plane",
            api,
        )
        self.assertIn("pola korzystają z kanonicznego field data plane", api_lower)
        self.assertIn("skalary należą do zasobu observation-results", api_lower)

    def test_capability_matrix_has_four_independent_unpromoted_features(self) -> None:
        matrix = json.loads(CAPABILITY_JSON.read_text(encoding="utf-8"))
        self.assertEqual(matrix["updated_at"], "2026-08-18")
        self.assertNotIn("observation_runtime_contract", matrix)
        features = {
            feature["id"]: feature
            for feature in matrix["features"]
            if feature["id"] in OBSERVATION_FEATURE_IDS
        }
        self.assertEqual(set(features), OBSERVATION_FEATURE_IDS)

        status_vocabulary = set(matrix["status_vocabulary"])
        for feature_id, feature in features.items():
            self.assertEqual(set(feature["lanes"]), CANONICAL_LANES)
            self.assertEqual(
                set(feature["execution_mode_scope"]),
                {"strict", "extended", "hybrid"},
            )
            self.assertEqual(feature["validation_state"], "unvalidated")
            self.assertEqual(feature["validated_workloads"], [])
            self.assertEqual(set(feature["lane_evidence"]), CANONICAL_LANES)
            for lane_id, evidence in feature["lane_evidence"].items():
                self.assertEqual(
                    set(evidence),
                    {
                        "source_presence",
                        "executability",
                        "validation",
                        "production_qualification",
                        "receipts",
                    },
                    f"{feature_id}/{lane_id}: incomplete evidence axes",
                )
                for axis in (
                    "source_presence",
                    "executability",
                    "validation",
                    "production_qualification",
                ):
                    self.assertIn(evidence[axis], status_vocabulary)
                self.assertEqual(evidence["receipts"], [])
                self.assertNotIn(
                    evidence["production_qualification"],
                    {"production_executable", "validated"},
                )

    def test_source_map_uses_planned_contract_anchors_and_complete_public_api(self) -> None:
        source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))
        equations = {equation["id"]: equation for equation in source_map["equations"]}
        sources = {source["id"]: source for source in source_map["sources"]}

        self.assertIn("F_i", equations["eq-observation-functional"]["symbols"])
        for equation in equations.values():
            self.assertTrue(equation["sources"], f"{equation['id']}: no sources")
            for source_id in equation["sources"]:
                source = sources[source_id]
                self.assertTrue(
                    source["symbol"].startswith("DOC-ANCHOR:"),
                    f"{equation['id']}: executable gap source used as proof",
                )
                self.assertEqual(source["evidence_status"], "planned_contract")

        backend_statuses = {
            entry["status"] for entry in source_map["backend_matrix"]
        }
        self.assertEqual(backend_statuses, {"unqualified"})

        parameters = {
            parameter["python"] for parameter in source_map["public_api"]["parameters"]
        }
        self.assertEqual(parameters, PUBLIC_API_PARAMETERS)
        class_symbols = {source["symbol"] for source in source_map["sources"]}
        self.assertTrue(
            {
                "class StageAutosave",
                "class TableAutosave",
                "class FieldAutosave",
            }.issubset(class_symbols)
        )


if __name__ == "__main__":
    unittest.main()
