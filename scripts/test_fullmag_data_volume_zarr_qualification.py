"""Regression tests for the saved FEM Zarr qualification reader."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
from unittest import mock

from docker_activation_history_policy import HistoryError
import fullmag_data_volume_zarr_qualification as qualification


TABLE_QUANTITIES = [
    "step", "t", "mx", "my", "mz", "e_ex", "e_demag", "e_ext", "e_drive",
    "e_ani", "e_rotated_dmi", "e_dmi", "e_total", "max_torque", "max_torque_T",
]
FIELD_QUANTITIES = ["m", "H_eff", "H_ex", "H_demag", "H_ext"]
ENERGY_TERMS = ["e_ex", "e_demag", "e_ext", "e_drive", "e_ani", "e_rotated_dmi", "e_dmi"]
IDENTITY = {"git_commit": "a" * 40, "source_snapshot_sha256": "b" * 64}


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_group(path: Path, attrs=None):
    write_json(path / ".zgroup", {"zarr_format": 2})
    if attrs is not None:
        write_json(path / ".zattrs", attrs)


def energy_row(step: int, *, total=None, torque_t=5e-9):
    energy = {"e_ex": 1e-19, "e_demag": 2e-19, "e_ext": 0.0, "e_drive": 0.0,
              "e_ani": 0.0, "e_rotated_dmi": 0.0, "e_dmi": 0.0}
    actual_total = sum(energy.values()) if total is None else total
    return [float(step), 0.0, 1.0, 0.0, 0.0,
            *(energy[name] for name in ENERGY_TERMS), actual_total, 0.004, torque_t]


class ZarrQualificationFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="fullmag-fem-zarr-qualification-")
        self.addCleanup(temporary.cleanup)
        self.temp = Path(temporary.name).resolve()
        self.root = self.temp / "sample.zarr"
        self.run_id = "run-live-" + "a" * 64
        self.run = self.root / self.run_id
        self.output = self.run / "relax-attempt-1"
        self.zarr = self.output / "relax.zarr"
        self.stage = self.zarr / "stages/stage_0000_relax"
        self.script = self.root.with_suffix(".py")
        self.script.write_text("# immutable fixture source\n", encoding="utf-8")
        self.script_sha256 = hashlib.sha256(self.script.read_bytes()).hexdigest()
        self.identity = dict(IDENTITY)
        self.provenance = {
            "execution_resolution": {
                "authored_request": {"backend": "fem", "device": "cpu", "mode": "strict",
                                     "precision": "double"},
                "effective_request": {"backend": "fem", "device": "cpu", "mode": "strict",
                                      "precision": "double"},
                "fallback_occurred": False,
                "fallback_reason": None,
                "resolution_mode": "exact",
                "resolved_execution": {"backend": "fem", "device": "cpu", "mode": "strict",
                                        "precision": "double"},
            },
            "execution_engine": "fem_cpu_native",
            "build_identity": {**self.identity, "built_at_utc": "2026-11-12T10:00:00Z"},
            "fem_poisson_demag": {
                "actual_iterations": 4,
                "final_residual": 5e-13,
                "max_iterations": 100,
                "rtol": 1e-12,
            },
        }
        self.completion = {
            "converged": True,
            "metric": "max_torque_apm",
            "metric_name": "max_torque_apm",
            "metric_value": 0.004,
            "reason": "torque",
            "status": "completed",
            "threshold": 0.005,
        }
        self.manifest = {
            "schema_version": "stage_autosave.v1",
            "target": "relax",
            "stage_id": "relax",
            "stage_index": 0,
            "layout": "continuous",
            "format": "zarr",
            "table_quantities": list(TABLE_QUANTITIES),
            "field_quantities": list(FIELD_QUANTITIES),
            "complete": True,
            "completion": dict(self.completion),
            "table_sample_count": 2,
            "field_sample_count": 2 * len(FIELD_QUANTITIES),
            "provenance": self.provenance,
        }
        self._build()

    def _build(self):
        write_group(self.root, {})
        write_group(self.run, {})
        output_dir = f"/user-data/{self.root.name}/{self.run_id}/relax-attempt-1"
        terminal_run_id = self.run_id + "-1"
        write_group(self.output, {"schema_version": "fullmag.project_results.v1"})
        resolved = {
            "cleanup": "never",
            "data_format": "zarr",
            "output_dir": output_dir,
            "run_id": terminal_run_id,
            "temp_dir": f"/user-data/scratch/{terminal_run_id}-fixture",
        }
        write_json(self.output / "run.json", {
            "schema": "fullmag.accepted_project_output.v1",
            "resolved_output_storage": resolved,
            "attempt_receipt_directory": (
                "/state/runs/docker-all/session-store/runs/" + self.run_id
                + "/worker-attempts/task-" + "c" * 64 + "/attempt-" + "d" * 32 + "/epoch-1"
            ),
        })
        write_json(self.output / "output-storage.json", {
            "schema": "fullmag.output_storage.resolved.v1", "state": "succeeded",
            "temp_cleaned": False, "resolved": resolved,
        })
        write_json(self.output / "fullmag-run.json", {
            "schema": "fullmag.run_manifest.v1",
            "run_id": terminal_run_id,
            "source": {"kind": "project", "path": "", "project_id": "project-fixture",
                       "revision": 1, "sha256": "e" * 64},
            "requested": {"backend": "fem", "device": "cpu", "mode": "strict", "precision": "double"},
            "resolved": {"backend": "fem", "device": "cpu", "mode": "strict", "precision": "double"},
            "started_at": "2026-11-12T10:00:00.000Z",
            "finished_at": "2026-11-12T10:01:00.000Z",
            "status": "completed", "exit_code": None, "error": None,
            "stages": [{"id": "relax-attempt-1", "kind": None, "steps": 2, "time_s": None}],
            "outputs": [
                {"path": "relax.autosave.json", "kind": "autosave_manifest"},
                {"path": "relax.zarr", "kind": "zarr_store"},
                {"path": "output-storage.json", "kind": "storage_receipt"},
            ],
            "fullmag_version": "0.1.0-test", "launched_by": "api", "session_id": None,
        })
        write_json(self.output / "relax.autosave.json", {
            "schema_version": "fullmag.stage_autosave.artifact.v1",
            "target": "relax", "format": "zarr", "layout": "continuous",
            "stages": [self.manifest],
        })
        write_group(self.zarr, {"schema_version": "fullmag.stage_autosave.v1", "target": "relax",
                                "provenance": self.provenance})
        write_group(self.zarr / "stages")
        write_group(self.stage, {"provenance": self.provenance})
        self._write_stage_manifest()
        self._write_table()
        self._write_fields()
        self._write_index()

    def _write_stage_manifest(self):
        write_json(self.stage / "manifest.json", self.manifest)
        write_json(self.output / "relax.autosave.json", {
            "schema_version": "fullmag.stage_autosave.artifact.v1",
            "target": "relax", "format": "zarr", "layout": "continuous",
            "stages": [self.manifest],
        })

    def _array_attrs(self, quantity, *, table=False):
        value = {
            "completion": self.completion,
            "completion_stage_identity": {"stage_id": "relax", "stage_index": 0, "target": "relax"},
            "dimension_order": ["sample", "quantity"] if table else ["sample", "value"],
            "provenance": self.provenance,
        }
        if table:
            value["quantities"] = list(self.manifest["table_quantities"])
        else:
            value["quantity"] = quantity
        return value

    @staticmethod
    def _write_array(path, rows, width, attrs):
        write_json(path / ".zarray", {
            "zarr_format": 2, "shape": [len(rows), width], "chunks": [1, width],
            "dtype": "<f8", "compressor": None, "fill_value": None,
            "order": "C", "filters": None, "dimension_separator": ".",
        })
        write_json(path / ".zattrs", attrs)
        for index, row in enumerate(rows):
            (path / f"{index}.0").write_bytes(struct.pack("<" + "d" * width, *row))

    def _write_table(self, rows=None):
        path = self.stage / "table"
        path.mkdir(parents=True, exist_ok=True)
        rows = rows or [energy_row(0), energy_row(1)]
        self._write_array(path, rows, len(self.manifest["table_quantities"]), self._array_attrs("table", table=True))

    def _write_fields(self):
        fields = self.stage / "fields"
        write_group(fields)
        for quantity in self.manifest["field_quantities"]:
            rows = [[1.0, 0.0, 0.0], [0.9, 0.1, 0.0]] if quantity == "m" else [[0.0, 0.0, 0.0], [0.1, 0.2, 0.3]]
            self._write_array(fields / quantity, rows, 3, self._array_attrs(quantity))

    def _write_index(self):
        continuous = self.zarr / "continuous"
        write_group(continuous, {"payload_policy": "references_only", "index": "index.jsonl"})
        entries = []
        for sample in range(self.manifest["table_sample_count"]):
            entries.append({
                "target_sample_index": len(entries), "stage_id": "relax", "stage_index": 0,
                "stage_sample_index": sample, "sample_kind": "table",
                "coordinate": {"kind": "accepted_step", "accepted_step": sample},
                "payload_ref": f"stages/stage_0000_relax/table/{sample}",
            })
        field_stage_sample = 0
        for quantity in self.manifest["field_quantities"]:
            for sample in range(2):
                entries.append({
                    "target_sample_index": len(entries), "stage_id": "relax", "stage_index": 0,
                    "stage_sample_index": field_stage_sample, "sample_kind": "field",
                    "coordinate": {"kind": "accepted_step", "accepted_step": sample},
                    "payload_ref": f"stages/stage_0000_relax/fields/{quantity}/{sample}",
                })
                field_stage_sample += 1
        (continuous / "index.jsonl").write_text(
            "".join(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n" for entry in entries),
            encoding="utf-8",
        )

    def rewrite_provenance(self):
        self.manifest["provenance"] = self.provenance
        self._write_stage_manifest()
        write_json(self.zarr / ".zattrs", {"schema_version": "fullmag.stage_autosave.v1",
                                            "target": "relax", "provenance": self.provenance})
        write_json(self.stage / ".zattrs", {"provenance": self.provenance})
        for path in [self.stage / "table/.zattrs"] + [self.stage / "fields" / q / ".zattrs"
                                                       for q in self.manifest["field_quantities"]]:
            attrs = read_json(path)
            attrs["provenance"] = self.provenance
            write_json(path, attrs)

    def mutate_provenance(self, callback):
        callback(self.provenance)
        self.rewrite_provenance()

    def configure_gpu(self):
        for request_name in ("authored_request", "effective_request", "resolved_execution"):
            self.provenance["execution_resolution"][request_name]["device"] = "gpu"
        self.provenance["execution_engine"] = "fem_native_gpu"
        self.provenance["fem_gpu_minimizer_execution_receipt"] = {
            "accounting": {
                "fallback_count": 0,
                "executed_host_operator_mask": 0,
                "executed_unknown_operator_mask": 0,
            },
        }
        self.rewrite_provenance()
        run_path = self.output / "fullmag-run.json"
        run_record = read_json(run_path)
        for name in ("requested", "resolved"):
            run_record[name]["device"] = "gpu"
        write_json(run_path, run_record)

    def remove_field(self, quantity):
        self.manifest["field_quantities"].remove(quantity)
        self.manifest["field_sample_count"] -= 2
        shutil.rmtree(self.stage / "fields" / quantity)
        self._write_stage_manifest()
        entries = [json.loads(line) for line in (self.zarr / "continuous/index.jsonl").read_text().splitlines()]
        entries = [row for row in entries if not row["payload_ref"].endswith(f"/{quantity}/0")
                   and not row["payload_ref"].endswith(f"/{quantity}/1")]
        field_no = 0
        for index, row in enumerate(entries):
            row["target_sample_index"] = index
            if row["sample_kind"] == "field":
                row["stage_sample_index"] = field_no
                field_no += 1
        (self.zarr / "continuous/index.jsonl").write_text(
            "".join(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n" for row in entries),
            encoding="utf-8",
        )

    def reorder_table(self, new_quantities):
        old_quantities = list(self.manifest["table_quantities"])
        source = self.stage / "table"
        old_rows = [struct.unpack("<" + "d" * len(old_quantities), (source / f"{i}.0").read_bytes())
                    for i in range(self.manifest["table_sample_count"])]
        index = {name: position for position, name in enumerate(old_quantities)}
        old_rows[-1] = list(old_rows[-1])
        old_rows[-1][index["t"]] = 0.25
        new_rows = [[row[index[name]] for name in new_quantities] for row in old_rows]
        self.manifest["table_quantities"] = list(new_quantities)
        self._write_stage_manifest()
        attrs = read_json(source / ".zattrs")
        attrs["quantities"] = list(new_quantities)
        write_json(source / ".zattrs", attrs)
        for sample, row in enumerate(new_rows):
            (source / f"{sample}.0").write_bytes(struct.pack("<" + "d" * len(row), *row))
        index_path = self.zarr / "continuous/index.jsonl"
        index_rows = [json.loads(line) for line in index_path.read_text(encoding="utf-8").splitlines()]
        for entry in index_rows:
            ref = entry["payload_ref"].split("/")
            if entry["sample_kind"] == "table":
                sample = int(ref[-1])
                entry["coordinate"] = {"kind": "physical_time", "time_s": old_rows[sample][index["t"]]}
        index_path.write_text(
            "".join(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n"
                    for entry in index_rows),
            encoding="utf-8",
        )

    def resize_field(self, quantity, width):
        path = self.stage / "fields" / quantity
        metadata = read_json(path / ".zarray")
        metadata["shape"][1] = width
        metadata["chunks"][1] = width
        write_json(path / ".zarray", metadata)
        for sample in range(metadata["shape"][0]):
            values = [float(sample + index + 1) for index in range(width)]
            (path / f"{sample}.0").write_bytes(struct.pack("<" + "d" * width, *values))

    def call(self, *, expected_device="cpu", identity=None):
        return qualification.qualify_completed_fem_zarr(
            self.root, self.run_id, script_sha256=self.script_sha256,
            expected_device=expected_device, native_build_identity=identity or self.identity,
        )


class ZarrQualificationTests(ZarrQualificationFixture):
    def test_qualifies_completed_fem_relaxation_and_reports_saved_scalars(self):
        report = self.call()
        self.assertEqual(report["state"], "completed-fem-zarr-qualified")
        self.assertEqual(report["run_id"], self.run_id)
        self.assertEqual(report["script_sha256"], self.script_sha256)
        self.assertEqual(report["device"], "cpu")
        self.assertEqual(report["native_build_identity"], self.identity)
        self.assertEqual(report["samples"]["table"], 2)
        self.assertEqual(report["samples"]["fields"], {name: 2 for name in FIELD_QUANTITIES})
        self.assertEqual(set(report["final"]["energies_j"]), set(ENERGY_TERMS) | {"e_total"})
        self.assertLessEqual(report["final"]["max_torque_T"], 1e-8)
        self.assertEqual(report["native_demag_certificate"]["rtol"], 1e-12)
        self.assertEqual(len(report["tree_sha256"]), 64)
        self.assertIn("not an independent Poisson postprocess", report["limitation"])

    def test_accepts_reordered_table_columns_using_manifest_mapping(self):
        reordered = list(TABLE_QUANTITIES)
        reordered[0], reordered[1], reordered[2] = reordered[1], reordered[2], reordered[0]
        self.reorder_table(reordered)
        report = self.call()
        self.assertEqual(report["final"]["step"], 1)
        self.assertEqual(report["final"]["time_s"], 0.25)
        self.assertEqual(report["final"]["m_avg"], [1.0, 0.0, 0.0])

    def test_accepts_gpu_lane_with_zero_fallback_and_operator_accounting(self):
        self.configure_gpu()
        report = self.call(expected_device="gpu")
        self.assertEqual(report["device"], "gpu")

    def test_refuses_gpu_lane_with_host_operator_fallback(self):
        self.configure_gpu()
        self.provenance["fem_gpu_minimizer_execution_receipt"]["accounting"][
            "executed_host_operator_mask"] = 1
        self.rewrite_provenance()
        with self.assertRaises(HistoryError):
            self.call(expected_device="gpu")

    def test_refuses_gpu_lane_without_minimizer_execution_receipt(self):
        self.configure_gpu()
        del self.provenance["fem_gpu_minimizer_execution_receipt"]
        self.rewrite_provenance()
        with self.assertRaises(HistoryError):
            self.call(expected_device="gpu")

    def test_refuses_mismatched_required_field_vector_widths(self):
        self.resize_field("H_ex", 6)
        with self.assertRaises(HistoryError):
            self.call()

    def test_refuses_required_field_width_not_divisible_by_three(self):
        for quantity in FIELD_QUANTITIES:
            self.resize_field(quantity, 4)
        with self.assertRaises(HistoryError):
            self.call()

    def test_refuses_incomplete_or_nonconverged_stage(self):
        self.manifest["complete"] = False
        self.manifest["completion"]["converged"] = False
        self.manifest["completion"]["status"] = "running"
        self._write_stage_manifest()
        with self.assertRaises(HistoryError):
            self.call()

    def test_refuses_build_identity_mismatch(self):
        with self.assertRaises(HistoryError):
            self.call(identity={"git_commit": "f" * 40, "source_snapshot_sha256": "b" * 64})

    def test_refuses_neighbor_script_sha_mismatch(self):
        with self.assertRaises(HistoryError):
            qualification.qualify_completed_fem_zarr(
                self.root, self.run_id, script_sha256="f" * 64,
                expected_device="cpu", native_build_identity=self.identity,
            )

    def test_refuses_wrong_execution_lane_or_device(self):
        with self.assertRaises(HistoryError):
            self.call(expected_device="gpu")
        self.mutate_provenance(lambda value: value["execution_resolution"]["resolved_execution"].update(
            backend="fdm"))
        with self.assertRaises(HistoryError):
            self.call()

    def test_refuses_fallback_even_when_execution_is_fem(self):
        self.mutate_provenance(lambda value: value["execution_resolution"].update(fallback_occurred=True))
        with self.assertRaises(HistoryError):
            self.call()

    def test_refuses_missing_required_field_array(self):
        self.remove_field("H_ex")
        with self.assertRaises(HistoryError):
            self.call()

    def test_reads_and_rejects_nonfinite_declared_field_chunk(self):
        chunk = self.stage / "fields/H_demag/1.0"
        chunk.write_bytes(struct.pack("<3d", 0.1, float("nan"), 0.3))
        with self.assertRaises(HistoryError):
            self.call()

    def test_rejects_energy_closure_error(self):
        rows = [energy_row(0), energy_row(1, total=4e-19)]
        shutil.rmtree(self.stage / "table")
        self._write_table(rows)
        with self.assertRaises(HistoryError):
            self.call()

    def test_rejects_final_torque_over_limit(self):
        rows = [energy_row(0), energy_row(1, torque_t=1.1e-8)]
        shutil.rmtree(self.stage / "table")
        self._write_table(rows)
        with self.assertRaises(HistoryError):
            self.call()

    def test_rejects_invalid_native_poisson_residual(self):
        self.mutate_provenance(lambda value: value["fem_poisson_demag"].update(final_residual=1.1e-12))
        with self.assertRaises(HistoryError):
            self.call()

    def test_rejects_field_initial_sample_not_bound_to_initial_table(self):
        index_path = self.zarr / "continuous/index.jsonl"
        rows = [json.loads(line) for line in index_path.read_text(encoding="utf-8").splitlines()]
        field = next(row for row in rows if row["payload_ref"].endswith("/fields/m/0"))
        field["coordinate"] = {"kind": "accepted_step", "accepted_step": 1}
        index_path.write_text(
            "".join(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n" for row in rows),
            encoding="utf-8",
        )
        with self.assertRaises(HistoryError):
            self.call()

    def test_rejects_tree_content_drift_during_qualification(self):
        original = qualification.validate_preserved_run

        def validate_then_drift(root, run_id):
            proof = original(root, run_id)
            path = self.stage / "fields/H_ex/1.0"
            path.write_bytes(struct.pack("<3d", 0.2, 0.3, 0.4))
            return proof

        with mock.patch.object(qualification, "validate_preserved_run", side_effect=validate_then_drift):
            with self.assertRaises(HistoryError):
                self.call()

    def test_rejects_adjacent_script_drift_during_qualification(self):
        original = qualification.validate_preserved_run

        def validate_then_change_script(root, run_id):
            proof = original(root, run_id)
            self.script.write_text("# changed source\n", encoding="utf-8")
            return proof

        with mock.patch.object(qualification, "validate_preserved_run", side_effect=validate_then_change_script):
            with self.assertRaises(HistoryError):
                self.call()


if __name__ == "__main__":
    unittest.main()
