"""Structural proof tests for preserved project-run Zarr output."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest

from docker_activation_history_policy import HistoryError
from docker_activation_history_output import validate_preserved_run


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")


class PreservedRunOutputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="fullmag-preserved-run-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.zarr = self.root / "results.zarr"
        self.run_id = "run-live-" + "a" * 64
        self.run = self.zarr / self.run_id
        self.output = self.run / "reversal-attempt-1"
        self.main_zarr = self.output / "main.zarr"
        self.stage = self.main_zarr / "stages/stage_0000_reversal"
        self.manifest = self._stage_manifest()
        self._build()

    @staticmethod
    def _stage_manifest():
        return {
            "schema_version": "stage_autosave.v1",
            "target": "main",
            "stage_id": "reversal",
            "stage_index": 0,
            "layout": "continuous",
            "format": "zarr",
            "table_quantities": ["step", "mx"],
            "field_quantities": [],
            "complete": True,
            "table_sample_count": 1,
            "field_sample_count": 0,
            "provenance": {"execution_resolution": {"resolution_mode": "exact"}},
        }

    def _build(self):
        self.zarr.mkdir(parents=True, exist_ok=True)
        write_json(self.zarr / ".zgroup", {"zarr_format": 2})
        write_json(self.zarr / ".zattrs", {})
        self.run.mkdir(parents=True, exist_ok=True)
        write_json(self.run / ".zgroup", {"zarr_format": 2})
        write_json(self.run / ".zattrs", {})
        self.output.mkdir(parents=True, exist_ok=True)
        write_json(self.output / ".zgroup", {"zarr_format": 2})
        write_json(self.output / ".zattrs", {"schema_version": "fullmag.project_results.v1"})

        self.run_execution_id = self.run_id + "-1"
        output_directory = f"/user-data/{self.zarr.name}/{self.run_id}/reversal-attempt-1"
        resolved = {
            "cleanup": "never",
            "data_format": "zarr",
            "output_dir": output_directory,
            "run_id": self.run_execution_id,
            "temp_dir": f"/user-data/scratch/{self.run_execution_id}-fixture",
        }
        attempt_receipt = (
            "/state/runs/docker-all/session-store/runs/" + self.run_id
            + "/worker-attempts/task-" + "b" * 64 + "/attempt-" + "c" * 32 + "/epoch-1"
        )
        write_json(self.output / "run.json", {
            "schema": "fullmag.accepted_project_output.v1",
            "resolved_output_storage": resolved,
            "attempt_receipt_directory": attempt_receipt,
        })
        write_json(self.output / "output-storage.json", {
            "schema": "fullmag.output_storage.resolved.v1",
            "state": "succeeded",
            "temp_cleaned": False,
            "resolved": resolved,
        })
        write_json(self.output / "fullmag-run.json", {
            "schema": "fullmag.run_manifest.v1",
            "run_id": self.run_execution_id,
            "source": {"kind": "project", "path": "", "project_id": "project-test",
                       "revision": 1, "sha256": "d" * 64},
            "requested": {"backend": "fem", "device": "gpu", "mode": "strict", "precision": "double"},
            "resolved": {"backend": "fem", "device": "gpu", "mode": "strict", "precision": "double"},
            "started_at": "2026-11-04T18:40:55.137Z",
            "finished_at": "2026-11-04T18:41:26.829Z",
            "status": "completed",
            # Accepted project workers do not own a process exit code.
            "exit_code": None,
            "error": None,
            "stages": [{"id": "reversal-attempt-1", "kind": None, "steps": 1, "time_s": None}],
            "outputs": [
                {"kind": "autosave_manifest", "path": "main.autosave.json"},
                {"kind": "zarr_store", "path": "main.zarr"},
                {"kind": "storage_receipt", "path": "output-storage.json"},
            ],
            "fullmag_version": "0.1.0-test",
            "launched_by": "api",
            "session_id": None,
        })

        write_json(self.output / "main.autosave.json", {
            "schema_version": "fullmag.stage_autosave.artifact.v1",
            "target": "main",
            "format": "zarr",
            "layout": "continuous",
            "stages": [self.manifest],
        })
        write_json(self.main_zarr / ".zgroup", {"zarr_format": 2})
        write_json(self.main_zarr / ".zattrs", {
            "schema_version": "fullmag.stage_autosave.v1",
            "target": "main",
            "provenance": self.manifest["provenance"],
        })
        write_json(self.main_zarr / "stages/.zgroup", {"zarr_format": 2})
        write_json(self.stage / ".zgroup", {"zarr_format": 2})
        write_json(self.stage / "manifest.json", self.manifest)
        table = self.stage / "table"
        table.mkdir(parents=True, exist_ok=True)
        write_json(table / ".zarray", {
            "zarr_format": 2, "shape": [1, 2], "chunks": [1, 2], "dtype": "<f8",
            "compressor": None, "fill_value": None, "order": "C", "filters": None,
            "dimension_separator": ".",
        })
        write_json(table / ".zattrs", {"quantities": ["step", "mx"],
                                        "dimension_order": ["sample", "quantity"]})
        (table / "0.0").write_bytes(struct.pack("<2d", 0.0, 1.0))
        continuous = self.main_zarr / "continuous"
        write_json(continuous / ".zgroup", {"zarr_format": 2})
        write_json(continuous / ".zattrs", {"payload_policy": "references_only", "index": "index.jsonl"})
        (continuous / "index.jsonl").write_text(json.dumps({
            "target_sample_index": 0,
            "stage_id": "reversal",
            "stage_index": 0,
            "stage_sample_index": 0,
            "sample_kind": "table",
            "coordinate": {"kind": "physical_time", "time_s": 0.0},
            "payload_ref": "stages/stage_0000_reversal/table/0",
        }, separators=(",", ":")) + "\n", encoding="utf-8")

    def rebuild(self):
        shutil.rmtree(self.zarr, ignore_errors=True)
        self.manifest = self._stage_manifest()
        self._build()

    def test_qualifies_terminal_table_only_output_without_field_tree(self):
        proof = validate_preserved_run(self.zarr, self.run_id)
        self.assertEqual(proof["run_id"], self.run_id)
        self.assertEqual(proof["terminal_run_id"], self.run_execution_id)
        self.assertEqual(proof["autosave"]["table_sample_count"], 1)
        self.assertEqual(proof["autosave"]["field_sample_count"], 0)
        self.assertFalse((self.stage / "fields").exists())
        self.assertEqual(proof["declared_outputs"], 3)

    def test_rejects_empty_run_and_missing_metadata_manifest_or_payload(self):
        for relative in (".zgroup", ".zattrs", "reversal-attempt-1/fullmag-run.json",
                         "reversal-attempt-1/output-storage.json",
                         "reversal-attempt-1/.zgroup",
                         "reversal-attempt-1/.zattrs",
                         "reversal-attempt-1/main.autosave.json",
                         "reversal-attempt-1/main.zarr/.zgroup",
                         "reversal-attempt-1/main.zarr/.zattrs",
                         "reversal-attempt-1/main.zarr/stages/.zgroup",
                         "reversal-attempt-1/main.zarr/stages/stage_0000_reversal/manifest.json",
                         "reversal-attempt-1/main.zarr/stages/stage_0000_reversal/table/.zarray",
                         "reversal-attempt-1/main.zarr/stages/stage_0000_reversal/table/0.0"):
            with self.subTest(missing=relative):
                self.rebuild()
                path = self.run / relative
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
                with self.assertRaises(HistoryError):
                    validate_preserved_run(self.zarr, self.run_id)

        self.rebuild()
        shutil.rmtree(self.output)
        self.output.mkdir()
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, self.run_id)

    def test_rejects_wrong_run_identity_or_nonterminal_status(self):
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, "run-live-" + "e" * 64)
        fullmag_run_path = self.output / "fullmag-run.json"
        fullmag_run = json.loads(fullmag_run_path.read_text(encoding="utf-8"))
        fullmag_run["status"] = "running"
        write_json(fullmag_run_path, fullmag_run)
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, self.run_id)

    def test_rejects_sample_count_larger_than_the_bounded_tree(self):
        oversized = 10 ** 12
        self.manifest["table_sample_count"] = oversized
        write_json(self.output / "main.autosave.json", {
            "schema_version": "fullmag.stage_autosave.artifact.v1",
            "target": "main", "format": "zarr", "layout": "continuous",
            "stages": [self.manifest],
        })
        write_json(self.stage / "manifest.json", self.manifest)
        array_path = self.stage / "table/.zarray"
        array = json.loads(array_path.read_text(encoding="utf-8"))
        array["shape"][0] = oversized
        write_json(array_path, array)
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, self.run_id)

    def test_rejects_output_paths_outside_run_and_mismatched_storage_binding(self):
        fullmag_run_path = self.output / "fullmag-run.json"
        fullmag_run = json.loads(fullmag_run_path.read_text(encoding="utf-8"))
        fullmag_run["outputs"][0]["path"] = "../outside/main.autosave.json"
        write_json(fullmag_run_path, fullmag_run)
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, self.run_id)

        self.rebuild()
        run_path = self.output / "run.json"
        run_record = json.loads(run_path.read_text(encoding="utf-8"))
        run_record["resolved_output_storage"]["output_dir"] = "/user-data/other.zarr/other/reversal-attempt-1"
        write_json(run_path, run_record)
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, self.run_id)

    def test_rejects_symlinked_run_or_payload(self):
        external = self.root / "external"
        external.mkdir()
        (external / "0.0").write_bytes(b"x" * 16)
        chunk = self.stage / "table/0.0"
        chunk.unlink()
        try:
            chunk.symlink_to(external / "0.0")
        except OSError:
            self.skipTest("Host cannot create symlinks")
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, self.run_id)

        self.rebuild()
        run_link = self.zarr / ("run-live-" + "f" * 64)
        run_link.symlink_to(self.run, target_is_directory=True)
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, run_link.name)

    def test_rejects_an_additional_unqualified_output_attempt(self):
        extra = self.run / "failed-attempt-2"
        extra.mkdir()
        with self.assertRaises(HistoryError):
            validate_preserved_run(self.zarr, self.run_id)


if __name__ == "__main__":
    unittest.main()
