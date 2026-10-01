"""Exact-byte consumer plan binding tests; these do not validate FemEigenPlanIR."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_fem_frequency_domain_eigen_artifacts as verifier


class ConsumerPlanExactReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = {}

    def sample(self, index, raw=b"{}"):
        prefix = f"eigen/metadata/sample_{index:04d}/"
        path = self.root / prefix
        path.mkdir(parents=True, exist_ok=True)
        plan = prefix + "consumer_plan_snapshot.v1.json"
        identity = prefix + "linearization_identity.v2.json"
        (self.root / plan).write_bytes(raw)
        (self.root / identity).write_text(json.dumps({
            "sample_index": index,
            "consumer_plan_snapshot_sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
        }), encoding="utf-8")
        self.artifacts.setdefault("consumer_plan_snapshot_v1_paths", []).append(plan)
        self.artifacts.setdefault(verifier.R4_IDENTITY_SIDECAR_KEY, []).append(identity)
        return self.root / plan, self.root / identity

    def replay(self, indices):
        return verifier.validate_consumer_plan_exact_replay(self.root, self.artifacts, set(indices))

    def test_absent_and_empty_legacy_sidecars_remain_unverified(self):
        for artifacts in ({}, {"consumer_plan_snapshot_v1_paths": [], "consumer_plan_snapshot_v1_path": None}):
            self.artifacts = artifacts
            self.assertEqual(self.replay([0])["status"], "NOT_VERIFIED")

    def test_literal_digest_and_noncontiguous_samples_do_not_qualify_plan_semantics(self):
        self.sample(7)
        self.sample(10000, b'{"b":2,"a":1}')
        report = self.replay([7, 10000])
        self.assertEqual(report["raw_sha256_by_sample"]["7"],
                         "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
        self.assertEqual(report["plan_semantics_status"], "NOT_VERIFIED")
        self.assertEqual(report["operator_replay_status"], "NOT_VERIFIED")

    def test_whitespace_and_key_order_are_not_reserialized(self):
        plan, _ = self.sample(7, b'{"b":2,"a":1}')
        for altered in (b'{"b":2,"a":1} ', b'{"a":1,"b":2}'):
            with self.subTest(raw=altered):
                plan.write_bytes(altered)
                with self.assertRaisesRegex(SystemExit, "raw digest"):
                    self.replay([7])

    def test_duplicate_keys_nonfinite_and_nonobject_json_are_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'[]', b'{"x":Infinity}'):
            with self.subTest(raw=raw):
                self.artifacts = {}
                self.sample(7, raw)
                with self.assertRaises(SystemExit):
                    self.replay([7])

    def test_wrong_identity_sample_and_framed_digest_are_rejected(self):
        _, identity = self.sample(7)
        for index in (8, 7.0, True):
            identity.write_text(json.dumps({"sample_index": index, "consumer_plan_snapshot_sha256": "sha256:" + "a" * 64}))
            with self.subTest(index=index), self.assertRaises(SystemExit):
                self.replay([7])
        raw = b"{}"
        framed = b"FemRelaxationProducerPlanSnapshot.v1\0" + len(raw).to_bytes(8, "little") + raw
        identity.write_text(json.dumps({
            "sample_index": 7,
            "consumer_plan_snapshot_sha256": "sha256:" + hashlib.sha256(framed).hexdigest(),
        }))
        with self.assertRaisesRegex(SystemExit, "raw digest"):
            self.replay([7])

    def test_missing_or_extra_sample_and_unordered_paths_are_rejected(self):
        self.sample(7)
        self.sample(2)
        with self.assertRaisesRegex(SystemExit, "ordered"):
            self.replay([2, 7])
        for key in self.artifacts:
            self.artifacts[key].reverse()
        with self.assertRaisesRegex(SystemExit, "computed spectrum"):
            self.replay([7])
        self.artifacts[verifier.R4_IDENTITY_SIDECAR_KEY].pop()
        with self.assertRaisesRegex(SystemExit, "linearization identities"):
            self.replay([2, 7])

    def test_alias_must_match_plural_and_file_must_exist(self):
        plan, _ = self.sample(7)
        self.artifacts["consumer_plan_snapshot_v1_path"] = self.artifacts["consumer_plan_snapshot_v1_paths"][0]
        self.replay([7])
        foreign, _ = self.sample(8)
        self.artifacts["consumer_plan_snapshot_v1_paths"].pop()
        self.artifacts[verifier.R4_IDENTITY_SIDECAR_KEY].pop()
        self.artifacts["consumer_plan_snapshot_v1_path"] = foreign.relative_to(self.root).as_posix()
        with self.assertRaisesRegex(SystemExit, "singular path"):
            self.replay([7])
        self.artifacts.pop("consumer_plan_snapshot_v1_path")
        plan.unlink()
        with self.assertRaises(SystemExit):
            self.replay([7])

    def test_missing_identity_and_singular_only_plan_fail_cleanly(self):
        self.sample(7)
        identities = self.artifacts.pop(verifier.R4_IDENTITY_SIDECAR_KEY)
        with self.assertRaisesRegex(SystemExit, "linearization identities"):
            self.replay([7])
        self.artifacts[verifier.R4_IDENTITY_SIDECAR_KEY] = identities
        paths = self.artifacts.pop("consumer_plan_snapshot_v1_paths")
        self.artifacts["consumer_plan_snapshot_v1_path"] = paths[0]
        with self.assertRaisesRegex(SystemExit, "singular path"):
            self.replay([7])


if __name__ == "__main__":
    unittest.main()
