"""Fixture regressions for accepted in-process FDM preparation recovery."""

from __future__ import annotations

import copy
import importlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
module = importlib.import_module("docker_volume_inprocess_fdm_cancel_probe")
docker_dev = importlib.import_module("docker_dev")


RUN_ID = "run-" + "1" * 40
TASK_ID = "task-" + "2" * 40
REQUEST_ID = "request-fdm-gpu-inprocess"
SOURCE_SHA256 = "a" * 64
API_INSTANCE_ID = "api-instance-1"
SESSION_ID = "session-1"


def _canon(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _write_json(path: Path, value: object) -> bytes:
    raw = _canon(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return raw


class _Response:
    def __init__(self, value: object, instance: str) -> None:
        self.status = 200
        self.headers = {"x-fullmag-api-instance": instance}
        self._raw = _canon(value)

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, maximum: int = -1) -> bytes:
        return self._raw if maximum < 0 else self._raw[:maximum]


class _ProbeFixture:
    """Small local SessionStore/API fixture for executing the generated probe."""

    def __init__(
        self,
        root: Path,
        *,
        problem_device: str = "gpu",
        claimed: bool = False,
        malformed_certificate: bool = False,
        certificate_fault: str | None = None,
        unsupported_fdm_family: bool = False,
    ) -> None:
        self.root = root
        self.store = root / "session-store"
        self.ledger = root / "host-ledger"
        self.store.mkdir(parents=True)
        self.ledger.mkdir(parents=True)
        (self.store / "WRITER.lock").touch()
        (self.ledger / "WRITER.lock").touch()
        self.run_id = RUN_ID
        self.step_id = "step:relax"
        self.task_id = "task-" + _sha((self.run_id + "\0" + self.step_id).encode("utf-8"))
        self.request_id = REQUEST_ID
        self.source_sha256 = SOURCE_SHA256
        self.session_id = SESSION_ID
        self.api_instance_id = API_INSTANCE_ID
        self.scene_revision = 5
        self.marker_path = str(root / "activation.json")
        self.run = self.store / "runs" / self.run_id
        self.run.mkdir(parents=True)

        definition_raw = b"accepted-project-definition"
        definition_ref = _sha(definition_raw)
        study = {
            "schema_version": "study_plan.v3",
            "study_id": "study-sp4",
            "revision": 1,
            "steps": [{
                "step_id": self.step_id,
                "enabled": True,
                "model": {"model_id": "model-sp4", "version": "1"},
                "solver_config": {"solver_config_id": "solver-fdm", "version": "1"},
                "discretization": {"discretization_id": "grid", "version": "1"},
                "execution_profile": {"profile_id": "exec:fdm-gpu", "version": "1"},
            }],
        }
        study_raw = _canon(study)
        study_ref = _sha(study_raw)
        problem = {
            "backend_policy": {
                "requested_backend": "fdm",
                "execution_precision": "double",
                "fdm_precision_policy": None,
            },
            "validation_profile": {"execution_mode": "strict"},
            "problem_meta": {"runtime_metadata": {
                "runtime_selection": {
                    "device": problem_device, "explicit_selection": True, "gpu_count": 1,
                },
                # Rust's canonical JSON emits 1e-7; Python's json.dumps emits
                # 1e-07. The probe must retain the CAS numeric token verbatim.
                "fixture_numeric_probe": 1e-7,
            }},
        }
        problem_raw = _canon(problem).replace(b"1e-07", b"1e-7")
        self.problem_fingerprint = "sha256:" + _sha(problem_raw)
        entry = {key: value for key, value in study["steps"][0].items() if key not in {"step_id", "enabled"}}
        entry["step_id"] = self.step_id
        entry["problem"] = problem
        catalog = {
            "schema_version": "study_problem_catalog.v1",
            "study_id": study["study_id"],
            "study_revision": study["revision"],
            "study_plan_sha256": study_ref,
            "entries": [entry],
        }
        catalog_raw = _canon(catalog).replace(b"1e-07", b"1e-7")
        catalog_ref = _sha(catalog_raw)

        self.live_workspace = {
            "api_instance_id": self.api_instance_id,
            "session_id": self.session_id,
            "session_epoch": 2,
            "scene_revision": self.scene_revision,
            "command_id": self.request_id,
            "request_idempotency_key": self.request_id,
            "startup_source_sha256": self.source_sha256,
            "command": {"kind": "startup_script", "request_id": self.request_id,
                        "source_sha256": self.source_sha256},
        }
        specification = {
            "schema_version": "run_spec.v2",
            "run_id": self.run_id,
            "snapshot": {"project_id": "project-sp4", "definition_revision": 1,
                         "definition_sha256": definition_ref},
            "study": {"study_id": study["study_id"], "plan_version": study["schema_version"],
                      "plan_sha256": study_ref},
            "study_catalog_sha256": catalog_ref,
            "parameters": {
                "live_workspace": self.live_workspace,
                "fullmag.accepted_run_start": {
                    "schema_version": "accepted_run_start_policy.v1", "mode": "manual",
                },
            },
            "seeds": {},
            "dependencies": [],
            "immutable_assets": [],
            "requested_execution": {
                "backend": "fdm", "device": "gpu", "precision": "double", "mode": "strict",
                "minimum_resources": {
                    "cpu_millis": 1000, "memory_bytes": 1024, "gpu_memory_bytes": 1024,
                    "storage_bytes": 1024,
                },
            },
        }
        specification_fingerprint = "sha256:" + _sha(_canon(specification))
        intent = {
            "schema_version": "run_intent.v1",
            "run_id": self.run_id,
            "idempotency_key": "live-http-" + _sha(self.request_id.encode("utf-8")),
            "payload_sha256": _sha(_canon(specification)),
            "specification": specification,
            "definition_object_ref": definition_ref,
            "study_object_ref": study_ref,
            "study_catalog_object_ref": catalog_ref,
        }
        self.intent_sha256 = _sha(_write_json(self.run / "run_intent.json", intent))
        cas_root = self.store / "objects" / "sha256"
        cas_root.mkdir(parents=True)
        for ref, raw in ((definition_ref, definition_raw), (study_ref, study_raw), (catalog_ref, catalog_raw)):
            (cas_root / ref).write_bytes(raw)

        self.input_fingerprint = "9" * 64
        self.catalog_revision = 3
        task = {
            "task_id": self.task_id,
            "input_fingerprint": self.input_fingerprint,
            "lifecycle": "cancelled",
            "attempt_id": "attempt-claimed" if claimed else None,
            "ownership_epoch": 1 if claimed else None,
            "resource_id": None,
            "resolved_input_fingerprint": None,
            "coordinator_watermark": None,
            "coordinator_genesis": None,
            "artifact_ids": [],
        }
        run_catalog = {
            "schema_version": "run_catalog.v1", "run_id": self.run_id,
            "revision": self.catalog_revision, "tasks": [task],
        }
        self.run_catalog_sha256 = _sha(_write_json(self.run / "run_catalog.json", run_catalog))
        cancellation = {
            "schema_version": "task_cancellation_intent.v1",
            "cancellation_id": "cancel-" + "3" * 40,
            "run_id": self.run_id,
            "expected_catalog_revision": self.catalog_revision,
            "task": {"task_id": self.task_id, "lifecycle": "accepted",
                     "input_fingerprint": self.input_fingerprint},
            "reason": "operator_cancelled_before_compute",
        }
        semantic = {key: cancellation[key] for key in (
            "schema_version", "cancellation_id", "run_id", "expected_catalog_revision", "task", "reason",
        )}
        cancellation["request_sha256"] = _sha(_canon(semantic))
        _write_json(self.run / "task_cancellation_intents" / (self.task_id + ".json"), cancellation)

        plan: dict[str, object] = {
            "schema_version": "preparation_plan.v2",
            "problem_fingerprint": self.problem_fingerprint,
            "source": {"kind": "accepted_run_step", "run_id": self.run_id,
                       "specification_fingerprint": specification_fingerprint, "step_id": self.step_id},
            "requested_backend": "fdm",
            "resolved_backend": "fdm",
        }
        output_fingerprints = {
            "geometry": "sha256:1dc24af21fc003c5bf18fac3d55e487878f6dadddfbbf9a3dc485dbc5dbf89e0",
            "display": "sha256:e74a28aa72937a6a36b7b37dba6ccc4d7af18187971f2060ba2ad34b789b7bd9",
            "grid": "sha256:3f8f08688491f99950eaf63dccc0a49520e1648932c6a6581ebfb30f5ce7fac0",
            "mesh": "sha256:b03fd73cffdb13cbdab8e4e45c570b5933c25045906bddbcf3f1ae70c2664989",
            "space": "sha256:e546466b8aa991735f44ffd53cb1460c22c013683b5df83ad9748b9613425144",
        }
        for kind in ("geometry", "display", "grid", "mesh", "space"):
            producer_ids = {
                "geometry": ("fullmag.geometry", "geometry_projection.v1", "1"),
                "display": ("fullmag.display", "display_projection.v1", "1"),
                "grid": ("fullmag.fdm.grid", "fdm_grid_certificate.v1", "fullmag-plan.fdm.v1"),
                "mesh": ("fullmag.fdm.cell_domain", "fdm_cell_domain.v1", "1"),
                "space": ("fullmag.fdm.grid_space", "fdm_grid_space.v1", "1"),
            }
            producer_id, schema_version, producer_version = producer_ids[kind]
            if (unsupported_fdm_family or certificate_fault == "unsupported_fdm_family") and kind == "mesh":
                producer_id = "fullmag.fdm.other_mesh"
            input_fingerprint = (
                self.problem_fingerprint if kind in {"geometry", "display", "grid"}
                else plan["grid"]["output_fingerprint"] if kind == "mesh"
                else plan["mesh"]["output_fingerprint"]
            )
            plan[kind] = {
                "kind": kind,
                "producer_id": producer_id,
                "schema_version": schema_version,
                "producer_version": producer_version,
                "input_fingerprint": input_fingerprint,
                "output_fingerprint": output_fingerprints[kind],
            }
        plan_ordered = {
            "schema_version": plan["schema_version"],
            "problem_fingerprint": plan["problem_fingerprint"],
            "source": plan["source"],
            "requested_backend": plan["requested_backend"],
            "resolved_backend": plan["resolved_backend"],
            **{kind: plan[kind] for kind in ("geometry", "display", "grid", "mesh", "space")},
        }
        plan_bytes = json.dumps(plan_ordered, ensure_ascii=False, sort_keys=False, separators=(",", ":")).encode("utf-8")
        plan_fingerprint = "sha256:" + _sha(plan_bytes)
        cell_count = 4096
        marker_fingerprint = "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        quality = {
            "cell_count": cell_count,
            "invalid_cell_count": 0,
            "min_quality": 1.0,
            "max_aspect_ratio": 1.3020833333333333,
            "quality_fingerprint": "sha256:fcfe306a34912341f40ca93a36f5e6e382a01a883c7c4f1483e6c7af324f7005",
        }
        marker_map = {"marker_map_fingerprint": marker_fingerprint, "marker_ids": [0]}
        certificates = [
            {"schema_version": "preparation_certificate.v1", "producer": plan["geometry"]},
            {"schema_version": "preparation_certificate.v1", "producer": plan["display"]},
            {"schema_version": "preparation_certificate.v1", "producer": plan["grid"],
             "cell_count": cell_count},
            {"schema_version": "preparation_certificate.v1", "producer": plan["mesh"],
             "cell_count": cell_count, "quality": dict(quality), "marker_map": dict(marker_map)},
            {"schema_version": "preparation_certificate.v1", "producer": plan["space"],
             "marker_map": dict(marker_map), "space": {
                 "mesh_fingerprint": plan["mesh"]["output_fingerprint"],
                 "marker_map_fingerprint": marker_fingerprint,
                 "dof_count": cell_count,
                 "space_fingerprint": plan["space"]["output_fingerprint"],
             }},
        ]
        if malformed_certificate or certificate_fault == "missing_certificate":
            certificates.pop()
        if certificate_fault is not None:
            by_kind = {row["producer"]["kind"]: row for row in certificates}
            grid_certificate = by_kind.get("grid")
            mesh_certificate = by_kind.get("mesh")
            space_certificate = by_kind.get("space")
            if certificate_fault == "missing_grid_cell_count" and grid_certificate:
                grid_certificate.pop("cell_count", None)
            elif certificate_fault == "zero_grid_cell_count" and grid_certificate:
                grid_certificate["cell_count"] = 0
            elif certificate_fault == "missing_mesh_cell_count" and mesh_certificate:
                mesh_certificate.pop("cell_count", None)
            elif certificate_fault == "zero_mesh_cell_count" and mesh_certificate:
                mesh_certificate["cell_count"] = 0
            elif certificate_fault == "missing_mesh_quality" and mesh_certificate:
                mesh_certificate.pop("quality", None)
            elif certificate_fault == "quality_cell_count_mismatch" and mesh_certificate:
                mesh_certificate["quality"]["cell_count"] = cell_count - 1
            elif certificate_fault == "zero_quality_cell_count" and mesh_certificate:
                mesh_certificate["quality"]["cell_count"] = 0
            elif certificate_fault == "quality_invalid_cell_count" and mesh_certificate:
                mesh_certificate["quality"]["invalid_cell_count"] = 1
            elif certificate_fault == "quality_min_quality_missing" and mesh_certificate:
                mesh_certificate["quality"].pop("min_quality", None)
            elif certificate_fault == "quality_min_quality_zero" and mesh_certificate:
                mesh_certificate["quality"]["min_quality"] = 0.0
            elif certificate_fault == "quality_aspect_missing" and mesh_certificate:
                mesh_certificate["quality"].pop("max_aspect_ratio", None)
            elif certificate_fault == "quality_aspect_below_one" and mesh_certificate:
                mesh_certificate["quality"]["max_aspect_ratio"] = 0.5
            elif certificate_fault == "quality_jacobian" and mesh_certificate:
                mesh_certificate["quality"]["jacobian"] = {"sample_count": 1}
            elif certificate_fault == "quality_mesh_source" and mesh_certificate:
                mesh_certificate["quality"]["mesh_source"] = {"schema_version": "fem_mesh_source_evidence.v1"}
            elif certificate_fault == "quality_fingerprint_invalid" and mesh_certificate:
                mesh_certificate["quality"]["quality_fingerprint"] = "bad"
            elif certificate_fault == "quality_unknown_field" and mesh_certificate:
                mesh_certificate["quality"]["unexpected"] = True
            elif certificate_fault == "missing_mesh_marker_map" and mesh_certificate:
                mesh_certificate.pop("marker_map", None)
            elif certificate_fault == "marker_ids_empty" and mesh_certificate:
                mesh_certificate["marker_map"]["marker_ids"] = []
            elif certificate_fault == "marker_ids_unsorted" and mesh_certificate:
                mesh_certificate["marker_map"]["marker_ids"] = [1, 0]
            elif certificate_fault == "marker_id_out_of_u32" and mesh_certificate:
                mesh_certificate["marker_map"]["marker_ids"] = [4294967296]
            elif certificate_fault == "marker_fingerprint_invalid" and mesh_certificate:
                mesh_certificate["marker_map"]["marker_map_fingerprint"] = "bad"
            elif certificate_fault == "mesh_marker_fingerprint_mismatch" and mesh_certificate:
                mesh_certificate["marker_map"]["marker_map_fingerprint"] = "sha256:" + "c" * 64
            elif certificate_fault == "missing_space" and space_certificate:
                space_certificate.pop("space", None)
            elif certificate_fault == "space_dof_zero" and space_certificate:
                space_certificate["space"]["dof_count"] = 0
            elif certificate_fault == "space_dof_mismatch" and space_certificate:
                space_certificate["space"]["dof_count"] = cell_count - 1
            elif certificate_fault == "space_mesh_fingerprint_mismatch" and space_certificate:
                space_certificate["space"]["mesh_fingerprint"] = "sha256:" + "c" * 64
            elif certificate_fault == "space_marker_fingerprint_mismatch" and space_certificate:
                space_certificate["space"]["marker_map_fingerprint"] = "sha256:" + "c" * 64
            elif certificate_fault == "space_certificate_marker_fingerprint_mismatch" and space_certificate:
                space_certificate["marker_map"]["marker_map_fingerprint"] = "sha256:" + "c" * 64
            elif certificate_fault == "space_fingerprint_mismatch" and space_certificate:
                space_certificate["space"]["space_fingerprint"] = "sha256:" + "c" * 64
            elif certificate_fault == "space_fe_metadata" and space_certificate:
                space_certificate["space"]["fe_family"] = "H1"
            elif certificate_fault == "space_evidence_on_grid" and grid_certificate and space_certificate:
                grid_certificate["space"] = dict(space_certificate["space"])
            elif certificate_fault == "grid_mesh_count_mismatch" and grid_certificate:
                grid_certificate["cell_count"] = cell_count - 1
        payload = {
            "schema_version": "preparation_receipt.v1",
            "preparation_id": "prep-" + self.task_id,
            "plan_fingerprint": plan_fingerprint,
            "plan": plan,
            "certificates": certificates,
            "reuse": [],
            "accepted_run_source": {
                "schema_version": "accepted_run_preparation_source.v1",
                "run_id": self.run_id,
                "specification_fingerprint": specification_fingerprint,
                "step_id": self.step_id,
                "problem_fingerprint": self.problem_fingerprint,
            },
        }
        payload_sha256 = _sha(_canon(payload))
        receipt = {
            "schema_version": "task_preparation_receipt.v1",
            "run_id": self.run_id,
            "task_id": self.task_id,
            "step_id": self.step_id,
            "input_fingerprint": self.input_fingerprint,
            "preparation_id": "prep-" + self.task_id,
            "plan_fingerprint": plan_fingerprint,
            "payload_sha256": payload_sha256,
            "payload": payload,
            "created_at": "2026-11-02T12:00:00Z",
        }
        _write_json(self.run / "task_preparation_receipts" / (self.task_id + ".json"), receipt)
        _write_json(self.ledger / "HOST_RESOURCE_LEDGER.json", {"policy": {}, "reservations": []})
        marker_request_hash = _sha(self.request_id.encode("utf-8"))
        marker = {
            "schema": "fullmag.docker-startup-activation-receipt.v1",
            "state": "started",
            "request_id": self.request_id,
            "source_sha256": self.source_sha256,
            "authorization": {"request_id": self.request_id, "source_sha256": self.source_sha256},
        }
        _write_json(Path(self.marker_path), marker)

        created_at = "1760000000"
        self.api = {
            "/v2/sessions/current/status": {
                "session": {
                    "session_id": self.session_id,
                    "created_at": created_at,
                    "session_epoch": self.session_id + "@" + created_at,
                    "request_scope_epoch": self.api_instance_id + ":2",
                },
                "solver": {"state": "idle"},
            },
            "/v2/sessions/current": {
                "current": True,
                "session_id": self.session_id,
                "script": {"sha256": self.source_sha256},
            },
            "/v2/sessions/current/simulation/runs/current": {
                "run_id": self.run_id,
                "session_id": self.session_id,
                "started_at": created_at,
                "status": "cancelled",
                "total_steps": 1,
            },
            "/v2/sessions/current/model/scene": {"revision": self.scene_revision},
            "/v2/platform/compute/queue": {"schema_version": "compute_queue.v1", "items": []},
            "/v2/platform/runtime-service": {
                "configured": True, "state": "ready", "reason": {"code": "service_ready"},
            },
            "/v2/platform/health": {"status": "ok", "active_session": True},
        }

    def execute(self) -> dict[str, object]:
        script = module._inprocess_fdm_probe_script()
        expected = 'expected_path="/opt/fullmag/control/backend/script-activation-"+expected_key+"/activation.json"'
        if expected not in script:
            raise AssertionError("marker path guard changed")
        script = script.replace(expected, "expected_path=marker_path")

        def urlopen(request: object, timeout: int = 5) -> _Response:
            url = getattr(request, "full_url", str(request))
            path = url.removeprefix("http://127.0.0.1:8081")
            value = self.api[path]
            return _Response(value, self.api_instance_id)

        argv = [
            "probe.py", self.run_id, self.task_id, self.request_id, self.source_sha256,
            self.marker_path, str(self.store), str(self.ledger), str(self.scene_revision),
        ]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), patch("urllib.request.urlopen", side_effect=urlopen), redirect_stdout(output):
            exec(compile(script, "<in-process-FDM-cancel-probe>", "exec"), {})
        return json.loads(output.getvalue())


def _probe(**overrides: object) -> dict[str, object]:
    probe: dict[str, object] = {
        "schema": "fullmag.docker-activation-cancel-probe.v1",
        "run_id": RUN_ID,
        "task_id": TASK_ID,
        "request_id": REQUEST_ID,
        "source_sha256": SOURCE_SHA256,
        "catalog_revision": 3,
        "cancellation_id": "cancel-" + "3" * 40,
        "run_intent_sha256": "b" * 64,
        "run_catalog_sha256": "c" * 64,
        "cancellation_intent_sha256": "d" * 64,
        "activation_marker_sha256": "e" * 64,
        "matching_reservations": 0,
        "task_count": 1,
        "live_api_instance_id": API_INSTANCE_ID,
        "live_session_id": SESSION_ID,
        "live_session_epoch": 2,
        "live_scene_revision": 5,
        "live_workspace_sha256": "f" * 64,
        "retained_current_run_sha256": "1" * 64,
        "retained_current_run_task_count": 1,
        "compute_queue": {"schema_version": "compute_queue.v1", "items": []},
        "runtime_service": {
            "configured": True,
            "state": "ready",
            "reason": {"code": "service_ready"},
        },
        "health": {"status": "ok", "active_session": True},
        "preparation_evidence": [
            {"path": "task_preparation_receipts/" + TASK_ID + ".json", "sha256": "2" * 64}
        ],
        "preparation_host_reservations": [],
        "preparation_kind": "in-process-fdm",
        "in_process_fdm": {
            "schema_version": "fullmag.inprocess-fdm-preparation-evidence.v1",
            "step_id": "step:relax",
            "specification_fingerprint": "sha256:" + "3" * 64,
            "definition_sha256": "4" * 64,
            "study_plan_sha256": "5" * 64,
            "study_catalog_sha256": "6" * 64,
            "problem_fingerprint": "sha256:" + "7" * 64,
            "preparation_id": "prep-" + TASK_ID,
            "plan_fingerprint": "sha256:" + "8" * 64,
            "requested_execution": {
                "backend": "fdm",
                "device": "gpu",
                "precision": "double",
                "mode": "strict",
            },
            "resolved_backend": "fdm",
            "certificate_producers": ["geometry", "display", "grid", "mesh", "space"],
            "external_preparation_records": {
                "launches": 0,
                "exits": 0,
                "leases": 0,
                "retry_decisions": 0,
            },
            "start_gate_closed": True,
            "task_admissions": 0,
            "claims": 0,
            "worker_attempts": 0,
            "solver_leases": 0,
            "host_reservations": 0,
            "compute_queue_empty": True,
            "prepared_observation": None,
        },
    }
    probe.update(overrides)
    return probe


class InProcessFdmProbeTests(unittest.TestCase):
    def _validate(self, probe: dict[str, object]) -> dict[str, object]:
        return module._validate_inprocess_fdm_probe(
            probe,
            request_id=REQUEST_ID,
            source_sha256=SOURCE_SHA256,
            expected_run_id=RUN_ID,
            expected_task_id=TASK_ID,
            expected_session_id=SESSION_ID,
            expected_api_instance_id=API_INSTANCE_ID,
        )

    def test_accepts_only_a_cancelled_unclaimed_fdm_gpu_strict_double_preparation(self) -> None:
        proof = self._validate(_probe())

        self.assertEqual(proof["run_id"], RUN_ID)
        self.assertEqual(proof["preparation_kind"], "in-process-fdm")
        self.assertNotIn("failed_preparation", proof)
        self.assertEqual(proof["preparation_host_reservations"], [])
        self.assertEqual(proof["in_process_fdm"]["requested_execution"]["device"], "gpu")

    def test_rejects_changed_cas_pin(self) -> None:
        changed = copy.deepcopy(_probe())
        changed["in_process_fdm"]["study_catalog_sha256"] = "bad-digest"
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

    def test_rejects_wrong_fdm_lane_or_cpu_fallback(self) -> None:
        changed = copy.deepcopy(_probe())
        changed["in_process_fdm"]["requested_execution"]["device"] = "cpu"
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

        changed = copy.deepcopy(_probe())
        changed["in_process_fdm"]["resolved_backend"] = "fem"
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

    def test_rejects_incomplete_or_malformed_certificates(self) -> None:
        changed = copy.deepcopy(_probe())
        changed["in_process_fdm"]["certificate_producers"] = ["geometry", "display"]
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

        changed = copy.deepcopy(_probe())
        changed["in_process_fdm"]["plan_fingerprint"] = "not-a-fingerprint"
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

    def test_rejects_external_preparation_claims_leases_and_reservations(self) -> None:
        for field, value in (
            ("launches", 1),
            ("retry_decisions", 1),
        ):
            with self.subTest(field=field):
                changed = copy.deepcopy(_probe())
                changed["in_process_fdm"]["external_preparation_records"][field] = value
                with self.assertRaises(module.BuildControlError):
                    self._validate(changed)

        for field in ("task_admissions", "claims", "worker_attempts", "solver_leases", "host_reservations"):
            with self.subTest(field=field):
                changed = copy.deepcopy(_probe())
                changed["in_process_fdm"][field] = 1
                with self.assertRaises(module.BuildControlError):
                    self._validate(changed)

    def test_rejects_open_start_gate_or_nonempty_compute_queue(self) -> None:
        changed = copy.deepcopy(_probe())
        changed["in_process_fdm"]["start_gate_closed"] = False
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

        changed = copy.deepcopy(_probe())
        changed["compute_queue"] = {"schema_version": "compute_queue.v1", "items": [{"run_id": RUN_ID}]}
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

    def test_rejects_missing_cancellation_and_changed_live_incarnation(self) -> None:
        changed = copy.deepcopy(_probe())
        changed["cancellation_id"] = None
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

        changed = copy.deepcopy(_probe())
        changed["live_api_instance_id"] = "api-instance-restarted"
        with self.assertRaises(module.BuildControlError):
            self._validate(changed)

    def test_generated_script_is_guarded_and_never_fabricates_failed_preparation(self) -> None:
        script = module._inprocess_fdm_probe_script()

        compile(script, "<in-process-FDM-cancel-probe>", "exec")
        self.assertIn("study_catalog_object_ref", script)
        self.assertIn("start_release.json", script)
        self.assertIn('ensure_empty_tree(run/"worker-attempts"', script)
        self.assertIn('plan.get("resolved_backend")!="fdm"', script)
        self.assertNotIn('probe["failed_preparation"]', script)
        self.assertEqual(script.count("print(json.dumps(probe,sort_keys=True))"), 1)

    def test_locked_probe_accepts_a_consistent_accepted_gpu_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            probe = fixture.execute()

        proof = module._validate_inprocess_fdm_probe(
            probe,
            request_id=REQUEST_ID,
            source_sha256=SOURCE_SHA256,
            expected_run_id=RUN_ID,
            expected_task_id=fixture.task_id,
            expected_session_id=SESSION_ID,
            expected_api_instance_id=API_INSTANCE_ID,
        )
        self.assertEqual(proof["task_id"], fixture.task_id)
        self.assertEqual(proof["in_process_fdm"]["requested_execution"]["device"], "gpu")
        self.assertNotIn("failed_preparation", probe)

    def test_locked_probe_rejects_a_cas_object_changed_after_acceptance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            intent = json.loads((fixture.run / "run_intent.json").read_bytes())
            catalog_ref = intent["study_catalog_object_ref"]
            (fixture.store / "objects" / "sha256" / catalog_ref).write_bytes(b"changed catalog")
            with self.assertRaises(RuntimeError):
                fixture.execute()

    def test_locked_probe_rejects_wrong_device_and_malformed_certificates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory), problem_device="cpu")
            with self.assertRaises(RuntimeError):
                fixture.execute()

    def test_locked_probe_rejects_noncanonical_fdm_certificate_evidence(self) -> None:
        faults = (
            "missing_certificate",
            "unsupported_fdm_family",
            "missing_grid_cell_count",
            "zero_grid_cell_count",
            "missing_mesh_cell_count",
            "zero_mesh_cell_count",
            "missing_mesh_quality",
            "quality_cell_count_mismatch",
            "zero_quality_cell_count",
            "quality_invalid_cell_count",
            "quality_min_quality_missing",
            "quality_min_quality_zero",
            "quality_aspect_missing",
            "quality_aspect_below_one",
            "quality_fingerprint_invalid",
            "quality_jacobian",
            "quality_mesh_source",
            "quality_unknown_field",
            "missing_mesh_marker_map",
            "marker_ids_empty",
            "marker_ids_unsorted",
            "marker_id_out_of_u32",
            "marker_fingerprint_invalid",
            "mesh_marker_fingerprint_mismatch",
            "missing_space",
            "space_dof_zero",
            "space_dof_mismatch",
            "space_mesh_fingerprint_mismatch",
            "space_marker_fingerprint_mismatch",
            "space_certificate_marker_fingerprint_mismatch",
            "space_fingerprint_mismatch",
            "space_fe_metadata",
            "space_evidence_on_grid",
            "grid_mesh_count_mismatch",
        )
        for fault in faults:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                fixture = _ProbeFixture(Path(directory), certificate_fault=fault)
                with self.assertRaises(RuntimeError):
                    fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory), malformed_certificate=True)
            with self.assertRaises(RuntimeError):
                fixture.execute()

    def test_locked_probe_rejects_external_preparation_and_claim_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            _write_json(fixture.run / "preparation_process_launches" / "launch.json", {})
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            _write_json(fixture.run / "preparation_retry_decisions" / "retry.json", {})
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory), claimed=True)
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            _write_json(fixture.run / "coordinator_journal" / "event" / "claim.json", {})
            with self.assertRaises(RuntimeError):
                fixture.execute()

    def test_locked_probe_rejects_worker_lease_reservation_or_open_gate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            _write_json(fixture.run / "worker-attempts" / "attempt" / "epoch-1" / "started.json", {})
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            _write_json(fixture.run / "resource_leases" / "solver.json", {
                "run_id": fixture.run_id, "task_id": fixture.task_id, "state": "released",
            })
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            _write_json(fixture.ledger / "HOST_RESOURCE_LEDGER.json", {
                "policy": {}, "reservations": [{"state": "released", "identity": {
                    "run_id": fixture.run_id, "task_id": fixture.task_id,
                }}],
            })
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            _write_json(fixture.run / "task_admissions" / fixture.task_id / "attempt.json", {})
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            (fixture.run / "start_release.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                fixture.execute()

    def test_locked_probe_rejects_nonempty_queue_missing_cancellation_and_changed_api(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            fixture.api["/v2/platform/compute/queue"]["items"] = [{"run_id": fixture.run_id}]
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            (fixture.run / "task_cancellation_intents" / (fixture.task_id + ".json")).unlink()
            with self.assertRaises(RuntimeError):
                fixture.execute()

        with tempfile.TemporaryDirectory() as directory:
            fixture = _ProbeFixture(Path(directory))
            fixture.api_instance_id = "api-instance-restarted"
            with self.assertRaises(RuntimeError):
                fixture.execute()

    def test_parser_keeps_failed_external_as_default_and_requires_explicit_fdm_kind(self) -> None:
        common = [
            "--repo-root", "/repo", "recover-cancelled-activation",
            "--attempt", "a" * 32, "--iteration-attempt", "b" * 32,
            "--activation-attempt", "c" * 32, "--config-sha256", "d" * 64,
            "--source-root", "/repo", "--port", "3197",
        ]
        legacy = docker_dev._parser().parse_args(common)
        inprocess = docker_dev._parser().parse_args(common + ["--preparation-kind", "in-process-fdm"])

        self.assertEqual(legacy.preparation_kind, "failed-external")
        self.assertEqual(inprocess.preparation_kind, "in-process-fdm")


if __name__ == "__main__":
    unittest.main()
