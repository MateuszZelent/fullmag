import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from local_runner.archive_receipt import validate_archive_receipt
from local_runner.build_executor import validate_build_receipt
from local_runner.worker_entrypoint import canonical


class ArchiveReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        native = {"head_commit_full": "a" * 40, "source_snapshot_sha256": "b" * 64}
        self.job = {"job_id": "c" * 32, "source_digest": "d" * 64,
                    "profile": "fem-cpu-slepc-runtime-v2", "payload": {"native_source_identity": native}}
        self.journal = {"image_digest": "sha256:" + "e" * 64}
        self.receipt = {"schema": "fullmag.local-runner.build-receipt.v1",
                        "job_id": self.job["job_id"], "source_digest": self.job["source_digest"],
                        "profile": self.job["profile"], "state": "succeeded", "qualification": "NOT VERIFIED",
                        "image_digest": self.journal["image_digest"], "native_source_identity": native,
                        "native_source_identity_sha256": hashlib.sha256(canonical(native)).hexdigest(),
                        "runtime_only": True, "runtime_contract": {"cmake_options": {"FULLMAG_ENABLE_FEM_GPU": "ON"}},
                        "stages": [{"name": "native-build", "exit_code": 0}], "artifacts": []}
        self.add_artifact("source-identity.json", json.dumps(native).encode())
        self.add_artifact("outputs/result.bin", b"archived bytes")
        self.save()

    def add_artifact(self, name, data):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        self.receipt["artifacts"].append({"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})

    def save(self):
        (self.root / "build-receipt.json").write_text(json.dumps(self.receipt))

    def test_historical_contract_integrity_is_not_runtime_compatibility(self):
        self.assertEqual(validate_archive_receipt(self.root, self.job, self.journal), self.receipt)
        with self.assertRaisesRegex(ValueError, "runtime contract mismatch"):
            validate_build_receipt(self.root, self.job, self.journal)

    def test_corrupt_artifact_is_rejected(self):
        (self.root / "outputs/result.bin").write_bytes(b"changed bytes!")
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)

    def test_identity_schema_stages_and_members_are_fail_closed(self):
        baseline = copy.deepcopy(self.receipt)
        for mutate in (
            lambda r: r.update(schema="unknown"),
            lambda r: r.update(job_id="wrong"),
            lambda r: r.update(image_digest="wrong"),
            lambda r: r.update(native_source_identity_sha256="wrong"),
            lambda r: r.update(stages=[]),
            lambda r: r["stages"][0].update(exit_code=1),
            lambda r: r["artifacts"].append(dict(r["artifacts"][0])),
            lambda r: r["artifacts"][1].update(path="../escape"),
            lambda r: r["artifacts"][1].update(path="C:/escape"),
            lambda r: r["artifacts"][1].update(size=True),
            lambda r: r["artifacts"][1].update(sha256="wrong"),
        ):
            with self.subTest(mutate=mutate):
                self.receipt = copy.deepcopy(baseline)
                mutate(self.receipt)
                self.save()
                with self.assertRaises(ValueError):
                    validate_archive_receipt(self.root, self.job, self.journal)

    def test_symlink_artifact_is_rejected(self):
        p = self.root / "outputs/result.bin"
        p.unlink()
        try:
            p.symlink_to(self.root / "source-identity.json")
        except OSError:
            self.skipTest("host does not permit symlinks")
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)


if __name__ == "__main__":
    unittest.main()
