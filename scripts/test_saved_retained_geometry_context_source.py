"""Interpreted structural regression; no Rust compilation or scientific qualification."""
from hashlib import sha256
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = "crates/fullmag-runtime-control/src/study_retained_current_tensor.rs"
API = "crates/fullmag-api/src/router_v2/handlers/persistence/solutions/saved_geometry.rs"
SCHEMA = "crates/fullmag-api/src/schemas/saved_field_geometry.rs"
# Frozen from the legacy producer preimage 1ef6023b55c557d20b377250d42840d75f858b031efc26703158daf059f0bdbd.
GOLDEN = {'owner': 'f58144511e7b54b2e3a6ee3f5999a72b4c4950c2bf726b43ffb4d72559f89426', 'layout_descriptor': 'fac7fd38e30aeeaaf4d2ebb11c58dec805f024854930f40620c94becc65c810e', 'chunks': 'aacca35669c9dfaccc04953e7b212b3a462f6d7d5b6a3ee187ad066b6bb99c69'}


def tokens(source):
    values = re.findall(r'"(?:\\.|[^"\\])*"|//[^\n]*|[A-Za-z_][A-Za-z_0-9]*|\d+|::|->|=>|==|!=|&&|\|\||[^\s]', source)
    return [value for value in values if not value.startswith("//")]


def index(values, sequence):
    for offset in range(len(values) - len(sequence) + 1):
        if values[offset:offset + len(sequence)] == sequence:
            return offset
    raise AssertionError("Missing Rust token sequence: " + " ".join(sequence))


def function(source, name):
    values = tokens(source)
    start = index(values, ["fn", name])
    begin = values.index("{", start)
    depth = 1
    for end in range(begin + 1, len(values)):
        depth += (values[end] == "{") - (values[end] == "}")
        if depth == 0:
            return values[begin + 1:end]
    raise AssertionError("Unclosed Rust function " + name)


def digest(values):
    return sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


class SavedRetainedGeometrySourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = (ROOT / RUNTIME).read_text()
        cls.api = (ROOT / API).read_text()
        cls.schema = (ROOT / SCHEMA).read_text()

    def test_owner_and_serialized_metadata_construction_are_legacy_identical(self):
        self.assertEqual(digest(function(self.runtime, "owner")), GOLDEN["owner"])
        body = function(self.runtime, "metadata_descriptor")
        body = body[index(body, ["let", "layout"]):index(body, ["Ok", "(", "tensor", ")"])]
        self.assertEqual(digest(body), GOLDEN["layout_descriptor"], "Field/layout construction changed from the actual legacy producer")
        self.assertEqual(self.runtime.count("fullmag.retained_current_sample_layout.v1"), 1)
        producer = function(self.runtime, "descriptor")
        self.assertIn("metadata_descriptor", producer)
        suffix = producer[index(producer, ["let", "mut", "offset"]):]
        self.assertEqual(digest(suffix), GOLDEN["chunks"], "Chunk construction or serializer validation changed")

    def test_reader_uses_shared_metadata_and_exact_historical_owner(self):
        body = function(self.runtime, "read_saved_retained_current_geometry_parent")
        for sequence in (["resolve_solution_tensor", "(", "store", ",", "pinned", ")"],
                         ["read_revision", "("], ["source_contract", "("],
                         ["metadata_descriptor", "("], ["actual", ".", "chunks", ".", "clear", "("],
                         ["validate_retained_current_parent_evidence", "("]):
            index(body, sequence)
        for forbidden in ("write_transaction", "publish_solution_set", "claim_task", "decode_retained_current_field_bundle", "load_saved_retained_current_field_inspection"):
            self.assertNotIn(forbidden, body)

    def test_project_and_streamed_cas_pins_are_not_optional(self):
        body = function(self.runtime, "read_saved_retained_current_geometry_parent")
        for sequence in (["specification", ".", "snapshot", ".", "project_id", "!=", "project"],
                         ["specification", ".", "fingerprint", "(", ")", "?", "!=", "intent", ".", "payload_sha256"],
                         ["manifest", ".", "parent", ".", "owner", ".", "project_id", "!=", "project", ".", "as_str", "(", ")"],
                         ["header", ".", "object_length", "!=", "source", ".", "byte_length"],
                         ["bytes", ".", "object_length", "!=", "source", ".", "byte_length"]):
            index(body, sequence)

    def test_default_and_false_query_cannot_reach_context_helper(self):
        body = function(self.api, "get_saved_field_geometry")
        guard = ["if", "query", ".", "include_antenna_source_context", ".", "unwrap_or", "(", "false", ")", "&&", "resource", ".", "producer_id", "==", '"fullmag.retained-current-field"', "{"]
        begin = index(body, guard) + len(guard)
        depth = 1
        end = begin
        while depth:
            depth += (body[end] == "{") - (body[end] == "}")
            end += 1
        self.assertEqual(body.count("read_saved_retained_current_geometry_parent"), 1)
        self.assertIn("read_saved_retained_current_geometry_parent", body[begin:end])
        self.assertIn("pub include_antenna_source_context: Option<bool>", self.schema)

    def test_base_geometry_planar_and_binary_remain_context_free(self):
        base = function(self.api, "saved_geometry_resource")
        index(base, ["antenna_source_context", ":", "None"])
        self.assertIn('#[serde(skip_serializing_if = "Option::is_none")]\n    pub antenna_source_context: Option<', self.schema)
        for name in ("resolve_saved_geometry", "get_saved_field_geometry_topology", "get_saved_field_geometry_support"):
            self.assertNotIn("read_saved_retained_current_geometry_parent", function(self.api, name))
        self.assertNotIn("read_saved_retained_current_geometry_parent", (ROOT / "crates/fullmag-api/src/router_v2/handlers/persistence/solutions/saved_planar.rs").read_text())

    def test_public_context_is_concrete_and_registered(self):
        self.assertNotIn("serde_json::Value", self.schema)
        self.assertIn("HistoricalGeometryOnly", self.schema)
        doc = (ROOT / "crates/fullmag-api/src/openapi_v2.rs").read_text()
        for name in ("SavedFieldGeometryQuery", "SavedAntennaGeometrySourceContextResource", "SavedAntennaGeometrySourcePurposeResource", "SavedAntennaGeometryParentResource"):
            self.assertIn("crate::schemas::saved_field_geometry::" + name, doc)


if __name__ == "__main__":
    unittest.main()
