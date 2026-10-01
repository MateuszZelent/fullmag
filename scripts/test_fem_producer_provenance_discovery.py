"""Mutation regressions for modal producer provenance discovery only."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_fem_frequency_domain_eigen_artifacts as verifier


class ProducerDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def artifact_paths(self, indices):
        paths = []
        for index in indices:
            relative = f"eigen/metadata/sample_{index:04d}/producer_provenance.v1.json"
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"opaque producer payload; discovery cannot certify it")
            paths.append(relative)
        return {"producer_provenance_v1_paths": paths}

    def validate(self, artifacts, indices):
        return verifier.validate_producer_provenance_discovery(self.root, artifacts, set(indices))

    def test_historical_and_empty_records_remain_unverified(self):
        for artifacts in ({}, {"producer_provenance_v1_paths": [], "producer_provenance_v1_path": None}):
            result = self.validate(artifacts, [0])
            self.assertEqual(result["status"], "unverified_missing_producer_provenance")
            self.assertEqual(result["payload_replay_status"], "NOT_VERIFIED")

    def test_complete_noncontiguous_samples_are_bound_without_payload_qualification(self):
        result = self.validate(self.artifact_paths([2, 7, 10000]), [2, 7, 10000])
        self.assertEqual(result["sample_indices"], [2, 7, 10000])
        self.assertEqual(result["status"], "producer_paths_bound")
        self.assertEqual(result["payload_replay_status"], "NOT_VERIFIED")

    def test_missing_or_foreign_sample_is_rejected(self):
        for produced in ([0], [0, 2, 7]):
            with self.subTest(produced=produced), self.assertRaisesRegex(SystemExit, "computed spectrum"):
                self.validate(self.artifact_paths(produced), [0, 2])

    def test_singular_alias_must_match_published_plural_path(self):
        artifacts = self.artifact_paths([2])
        artifacts["producer_provenance_v1_path"] = artifacts["producer_provenance_v1_paths"][0]
        self.assertEqual(self.validate(artifacts, [2])["sample_indices"], [2])
        other = self.artifact_paths([7])["producer_provenance_v1_paths"][0]
        artifacts["producer_provenance_v1_path"] = other
        with self.assertRaisesRegex(SystemExit, "singular path"):
            self.validate(artifacts, [2])

    def test_singular_only_cannot_bypass_sample_coverage(self):
        path = self.artifact_paths([0])["producer_provenance_v1_paths"][0]
        with self.assertRaisesRegex(SystemExit, "singular path"):
            self.validate({"producer_provenance_v1_path": path}, [0])

    def test_unordered_and_duplicate_paths_are_rejected(self):
        artifacts = self.artifact_paths([7, 2])
        with self.assertRaisesRegex(SystemExit, "ordered"):
            self.validate(artifacts, [2, 7])
        artifacts = self.artifact_paths([2])
        artifacts["producer_provenance_v1_paths"] *= 2
        with self.assertRaisesRegex(SystemExit, "duplicate"):
            self.validate(artifacts, [2])

    def test_padded_alias_and_missing_file_are_rejected(self):
        artifacts = self.artifact_paths([2])
        relative = artifacts["producer_provenance_v1_paths"][0]
        alias = relative.replace("sample_0002", "sample_00002")
        alias_path = self.root / alias
        alias_path.parent.mkdir(parents=True)
        alias_path.write_bytes(b"alias")
        with self.assertRaisesRegex(SystemExit, "canonical|sample"):
            self.validate({"producer_provenance_v1_paths": [alias]}, [2])
        (self.root / relative).unlink()
        with self.assertRaisesRegex(SystemExit, "missing required artifact"):
            self.validate(artifacts, [2])

    def test_nonarray_paths_and_traversal_are_rejected(self):
        for value in (None, "eigen/metadata/sample_0000/producer_provenance.v1.json", ["../producer_provenance.v1.json"]):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                self.validate({"producer_provenance_v1_paths": value}, [0])


if __name__ == "__main__":
    unittest.main()
