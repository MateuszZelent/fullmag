"""Regression checks for the independent archived binary readback verifier."""
import copy
import hashlib
import json
import struct
import unittest

from verify_archived_solution_http import Client, MAX_METADATA, verify_slice


class ArchivedSliceVerificationTests(unittest.TestCase):
    def setUp(self):
        self.payload = struct.pack("<6d", 1, -2, 3, 4, -5, 6)
        digest = hashlib.sha256(self.payload).hexdigest()
        source = dict(run_id="run-a", solution_set_id="solution-a", solution_revision=1,
                      member_id="member-a", artifact_id="tensor-a", tensor_object_ref="a" * 64,
                      run_spec_digest="sha256:" + "b" * 64)
        self.run = dict(project_id="project-a", run_id="run-a", solution_set_id="solution-a", revision="2")
        self.expected = dict(member_id="member-a", artifact_id="dataset-artifact-a", manifest_object_ref="c" * 64,
                             source=source, unit="A/m", dataset_id="dataset-a", dataset_revision="1", sample_id="default",
                             item_id="item-a", field_id="field:H_ant", elements=2, components=3, payload_bytes=48,
                             payload_sha256=digest, parts=[dict(object_ref=digest, bytes=48)])
        self.meta = dict(self.run, containing_solution_revision="2", member_id="member-a",
                         artifact_id="dataset-artifact-a", manifest_object_ref="c" * 64,
                         source=dict(source, solution_revision="1"), descriptor=dict(unit="A/m"),
                         slice=dict(dataset_id="dataset-a", dataset_revision="1", sample_id="default", item_id="item-a",
                                    field_id="field:H_ant", element_offset="0", element_count="2", total_elements="2",
                                    component_count="3", precision="f64", byte_order="little_endian", payload_bytes="48",
                                    parts=[dict(object_ref=digest, plane="values", object_offset_bytes="0",
                                                plane_offset_bytes="0", byte_length="48", range_sha256="sha256:" + digest)]))

    def body(self, meta=None, payload=None):
        raw = json.dumps(self.meta if meta is None else meta).encode()
        return b"FMDS\x01\x00\x00\x00" + struct.pack("<I", len(raw)) + raw + (self.payload if payload is None else payload)

    def test_accepts_historical_owner_inside_later_solution_revision(self):
        result = verify_slice(self.body(), self.expected, self.run)
        self.assertEqual(result["bytes"], 48)
        self.assertEqual(result["payload_sha256"], hashlib.sha256(self.payload).hexdigest())

    def test_rejects_wrong_owner_or_source(self):
        for key in ("project_id", "run_id", "member_id", "containing_solution_revision"):
            with self.subTest(key=key):
                meta = copy.deepcopy(self.meta)
                meta[key] = "other"
                with self.assertRaisesRegex(ValueError, "owner mismatch"):
                    verify_slice(self.body(meta), self.expected, self.run)
        meta = copy.deepcopy(self.meta)
        meta["source"]["solution_revision"] = "2"
        with self.assertRaisesRegex(ValueError, "source differs"):
            verify_slice(self.body(meta), self.expected, self.run)

    def test_rejects_layout_reinterpretation_and_truncation(self):
        for key, value in (("precision", "f32"), ("component_count", "1"), ("byte_order", "big_endian")):
            with self.subTest(key=key):
                meta = copy.deepcopy(self.meta)
                meta["slice"][key] = value
                with self.assertRaisesRegex(ValueError, "layout mismatch"):
                    verify_slice(self.body(meta), self.expected, self.run)
        with self.assertRaisesRegex(ValueError, "length mismatch"):
            verify_slice(self.body()[:-1], self.expected, self.run)

    def test_rejects_changed_values_even_with_consistent_transport_hash(self):
        payload = struct.pack("<6d", 1, -2, 3, 4, -5, 7)
        meta = copy.deepcopy(self.meta)
        meta["slice"]["parts"][0]["range_sha256"] = "sha256:" + hashlib.sha256(payload).hexdigest()
        with self.assertRaisesRegex(ValueError, "archived bytes"):
            verify_slice(self.body(meta, payload), self.expected, self.run)

    def test_rejects_bad_range_or_incomplete_coverage(self):
        for key, value in (("range_sha256", "sha256:" + "0" * 64), ("plane_offset_bytes", "8")):
            with self.subTest(key=key):
                meta = copy.deepcopy(self.meta)
                meta["slice"]["parts"][0][key] = value
                with self.assertRaises(ValueError):
                    verify_slice(self.body(meta), self.expected, self.run)

    def test_rejects_nonfinite_values_even_if_all_hashes_match(self):
        payload = struct.pack("<6d", 1, -2, 3, 4, -5, float("nan"))
        digest = hashlib.sha256(payload).hexdigest()
        meta, expected = copy.deepcopy(self.meta), copy.deepcopy(self.expected)
        meta["slice"]["parts"][0].update(range_sha256="sha256:" + digest, object_ref=digest)
        expected.update(payload_sha256=digest, parts=[dict(object_ref=digest, bytes=48)])
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            verify_slice(self.body(meta, payload), expected, self.run)

    def test_rejects_unbounded_or_truncated_metadata(self):
        for raw in (b"FMDS\x01\x00\x00\x00" + struct.pack("<I", MAX_METADATA + 1), self.body()[:20], b"wrong"):
            with self.subTest(length=len(raw)), self.assertRaises(ValueError):
                verify_slice(raw, self.expected, self.run)

    def test_http_origin_cannot_redirect_to_remote_authority(self):
        for origin in ("https://127.0.0.1", "http://example.com", "http://user@127.0.0.1", "http://127.0.0.1/path"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                Client(origin)


if __name__ == "__main__":
    unittest.main()
