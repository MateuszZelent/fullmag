"""Test bundle routing and source/operator gate separation, not physics replay."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_fem_frequency_domain_eigen_artifacts as verifier

SOURCE_SNAPSHOT = "b6511df906eb213ffe5f820985c202cfc6cc5364c68becd569611de8bad506a5"

class ProducerPayloadRoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = {}
        self.prefix = "eigen/metadata/sample_0007/"

    def publish(self, key, filename, value):
        relative = self.prefix + filename
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        self.artifacts[key] = [relative]
        return relative

    def bundle(self):
        self.publish("producer_provenance_v1_paths", "producer_provenance.v1.json", {})
        self.publish(verifier.R4_IDENTITY_PREIMAGE_KEY, "linearization_identity_preimage.v1.json", {})
        eq = {"schema_version": "equilibrium_artifact.v7", "content_sha256": "eq-content"}
        state = {"schema_version": "LinearizationState.v6", "content_sha256": "state-content"}
        eq_path = self.publish("equilibrium_artifact_v7_paths", "equilibrium_artifact.v7.json", eq)
        state_path = self.publish("linearization_state_v6_paths", "linearization_state.v6.json", state)
        identity = {
            "sample_index": 7, "equilibrium_artifact_path": eq_path,
            "equilibrium_artifact_sha256": eq["content_sha256"],
            "equilibrium_artifact_schema": eq["schema_version"],
            "linearization_state_path": state_path,
            "linearization_state_sha256": state["content_sha256"],
            "linearization_state_schema": state["schema_version"],
            "source_run_id": "run-source", "source_stage_id": "stage-source",
            "source_stage_kind": "relaxation", "consumer_source_snapshot_sha256": SOURCE_SNAPSHOT,
        }
        for name in ("accepted_fields", "certified_fields", "recomputed_certificate"):
            identity[name + "_path"] = self.publish(name, name + ".json", {})
        self.identity_path = self.publish(verifier.R4_IDENTITY_SIDECAR_KEY, "linearization_identity.v2.json", identity)
        return identity

    def validate(self):
        return verifier.validate_producer_payload_replay(self.root, {"artifacts": self.artifacts})

    def test_absent_and_nonshared_routes_stay_unverified(self):
        self.assertEqual(self.validate()["status"], "NOT_VERIFIED")
        self.publish("producer_provenance_v1_paths", "producer_provenance.v1.json", {})
        self.assertIn("nonshared", self.validate()["reason"])

    def test_exact_sample_paths_are_forwarded_without_qualifying_operator(self):
        self.bundle()
        result = SimpleNamespace(status="qualified_payload_replay", identity_content_sha256="identity",
                                 sidecar_raw_sha256="producer", scientific_qualification="NOT_VERIFIED")
        with patch("fem_producer_provenance_replay.replay_producer_provenance", return_value=result) as replay:
            report = self.validate()
        paths = replay.call_args.args[0]
        self.assertEqual(paths.equilibrium_magnetization_path, self.root / self.prefix / "equilibrium_artifact.v7.json")
        self.assertIsNone(paths.producer_plan_path)
        self.assertEqual(replay.call_args.kwargs["expected_source_run_id"], "run-source")
        self.assertEqual(report["operator_replay_status"], "NOT_VERIFIED")
        self.assertEqual(set(report["samples"]), {"7"})

    def test_foreign_state_binding_is_rejected_before_adapter(self):
        for field in ("sample_index", "linearization_state_path", "equilibrium_artifact_sha256", "linearization_state_schema"):
            with self.subTest(field=field):
                identity = self.bundle()
                identity[field] = 8 if field == "sample_index" else "foreign"
                (self.root / self.identity_path).write_text(json.dumps(identity), encoding="utf-8")
                with patch("fem_producer_provenance_replay.replay_producer_provenance") as replay:
                    with self.assertRaises(SystemExit):
                        self.validate()
                    replay.assert_not_called()

    def test_nonshared_assembly_with_explicit_identity_gets_source_only_report(self):
        self.bundle()
        result = SimpleNamespace(status="qualified_payload_replay", identity_content_sha256="identity",
                                 sidecar_raw_sha256="producer", scientific_qualification="NOT_VERIFIED")
        manifest = {"artifacts": self.artifacts, "diagnostics": {"assembly": "nonshared_floquet"}}
        with patch("fem_producer_provenance_replay.replay_producer_provenance", return_value=result):
            report = verifier.validate_producer_payload_replay(self.root, manifest)
        self.assertEqual(report["operator_replay_status"], "NOT_VERIFIED")
        self.assertEqual(report["samples"]["7"]["scientific_qualification"], "NOT_VERIFIED")

    def test_float_and_boolean_sample_indices_are_rejected(self):
        for value in (7.0, True):
            with self.subTest(value=value):
                identity = self.bundle()
                identity["sample_index"] = value
                (self.root / self.identity_path).write_text(json.dumps(identity), encoding="utf-8")
                with self.assertRaisesRegex(SystemExit, "must be an integer"):
                    self.validate()

    def test_adapter_rejection_is_not_downgraded_to_missing_evidence(self):
        from fem_producer_provenance_replay import ProducerProvenanceReplayError
        self.bundle()
        with patch("fem_producer_provenance_replay.replay_producer_provenance", side_effect=ProducerProvenanceReplayError("foreign payload")):
            with self.assertRaisesRegex(SystemExit, "foreign payload"):
                self.validate()


if __name__ == "__main__":
    unittest.main()
