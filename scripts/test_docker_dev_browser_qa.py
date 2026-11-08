"""Contract and pure-validator regressions for the managed Docker DEV browser proof."""
from copy import deepcopy
from contextlib import ExitStack, contextmanager
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def _load_qa_module():
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("docker_dev_browser_qa_draft", ROOT / "scripts" / "docker_dev_browser_qa.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load browser QA wrapper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _planar_airbox_observation_fixture(qa):
    session = {
        "session_id": "session-1",
        "session_epoch": "session-1@1",
        "request_scope_epoch": "api:1",
        "run_id": "run-1",
    }
    png = (
        b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
        + (4).to_bytes(4, "big") + (3).to_bytes(4, "big") + b"\x08\x02\x00\x00\x00"
    )
    return {
        "schema": qa.PLANAR_AIRBOX_OBSERVATION_SCHEMA,
        "state": "passed",
        "quantity_id": "H_demag",
        "source_kind": "default",
        "source_id": "default",
        "scope_kind": "airbox",
        "scope_id": None,
        "session_before": deepcopy(session),
        "session_after": deepcopy(session),
        "meta_request": {
            "method": "GET",
            "path": "/v2/sessions/current/data/fields/H_demag/planar-default/meta",
            "scope_kind": "airbox",
            "scope_id_present": False,
            "status": 200,
        },
        "meta": {
            "etag": "etag-1",
            "sample_token": "planar-sample-v1:current",
            "field_revision": 7,
            "scope_kind": "airbox",
            "source": {
                "kind": "default",
                "default_slice_hash": "default-hash",
                "default_slice_revision": "4",
            },
            "operator": {"kind": "plane_sample"},
            "frame": {
                "origin_m": [11.0, 22.0, 32.0],
                "bounds_uv_m": [-1.0, 1.0, -2.0, 2.0],
                "u_axis": [1.0, 0.0, 0.0],
                "v_axis": [0.0, 1.0, 0.0],
                "normal": [0.0, 0.0, 1.0],
            },
        },
        "evidence": {
            "status": "ready",
            "quantityId": "H_demag",
            "sourceKind": "default",
            "sourceId": "default",
            "operatorKind": "plane_sample",
            "component": "magnitude",
            "metaIdentity": "etag-1",
            "scalarIdentity": "etag-1",
            "fieldRevision": 7,
            "sourceRevision": "4",
            "sourceHash": "default-hash",
            "operatorRevision": "4",
            "domainGenerationId": "generation-1",
            "defaultPlane": "xy",
            "positionFraction": 0.5,
            "resolvedCoordinateM": 32.0,
            "sampleToken": "planar-sample-v1:current",
            "glyphCount": 0,
            "raster": {
                "checksum": "fnv1a32:deadbeef",
                "min": -1.0,
                "max": 1.0,
                "sampleCount": 4,
            },
        },
        "domain_layout": {
            "schema_version": "fdm-multilayer-layout.v1",
            "available": True,
            "backend": "fdm_multilayer",
            "domain_generation_id": "generation-1",
            "layout_fingerprint": "sha256:" + "a" * 64,
            "airbox": {
                "carrier_available": True,
                "h_demag_available": True,
                "target_only": True,
                "cells": [2, 2, 2],
                "origin_m": [10.0, 20.0, 30.0],
                "cell_size_m": [1.0, 2.0, 4.0],
            },
        },
        "canvas": {"visible": True, "non_transparent": True, "width": 4, "height": 3},
        "screenshot": {
            "state": "captured",
            "image_proof": True,
            "media_type": "image/png",
            "width": 4,
            "height": 3,
            "byte_length": len(png),
            "png_base64": base64.b64encode(png).decode("ascii"),
        },
        "display_state_patch_count": 4,
        "visualization_client_ack_request_count": 2,
        "blocked_mutation_count": 0,
        "no_computation_or_monitor_mutations": True,
        "presentation_restored": True,
    }


def _airbox_inspector_result_fixture(qa):
    public_url = "http://127.0.0.1:3269"
    browser_url = "http://frontend:8080"
    script_sha256 = "a" * 64
    expected_panels = [
        ("root", "model:airbox", "airbox.root", "Airbox Overview", "Domain policy"),
        ("mesh", "model:airbox:mesh", "airbox.mesh", "Airbox Mesh Overview", "Airbox Mesh Overview"),
        ("parameters", "model:airbox:mesh:parameters", "airbox.mesh.parameters", "Airbox Mesh Parameters", "Canonical Authored Parameters"),
        ("quality-gates", "model:airbox:mesh:quality-gates", "airbox.mesh.quality-gates", "Airbox Mesh Quality Gates", "Airbox Quality Gates"),
        ("statistics", "model:airbox:mesh:statistics", "airbox.mesh.statistics", "Airbox Mesh Statistics", "Airbox Mesh Statistics"),
        ("topology", "model:airbox:mesh:topology", "airbox.mesh.topology", "Airbox Mesh Topology", "Airbox Mesh Topology"),
        ("build", "model:airbox:mesh:build", "airbox.mesh.build", "Airbox Mesh Build", "Airbox Mesh Build"),
    ]
    synthetic_pass = {
        "requests": 1,
        "revision": 7,
        "rendered_pass": True,
        "revision_matches_live": True,
    }
    proof = {
        "schema": "fullmag.airbox-inspector-browser-proof.v1",
        "script_sha256": script_sha256,
        "authored_method": "fem",
        "published_fem_with_unresolved_runtime": True,
        "generic_unknown_header_rejected": True,
        "no_authoring_mutations": True,
        "no_solve_commands": True,
        "visualization_client_acknowledgements": [],
        "unresolved_status_probe": {
            "only_active_lane_resolved_changed": True,
            "domain_discretization": "fem",
            "domain_generation_id": "generation-1",
            "mesh_revision": 11,
            "topology_revision": 12,
        },
        "canvas": {
            "visible": True,
            "context_lost": False,
            "drawing_buffer_width": 1440,
            "drawing_buffer_height": 1000,
        },
        "panels": [
            {
                "id": panel_id,
                "node_id": node_id,
                "selection_kind": selection_kind,
                "header": header,
                "group": group,
                "required_group": group,
                "verified": True,
            }
            for panel_id, node_id, selection_kind, header, group in expected_panels
        ],
        "api_comparisons": {
            "airbox_carrier_count": 2,
            "node_count": 100,
            "element_count": 80,
            "boundary_face_count": 120,
            "surface_face_count": 80,
            "mixed_element_families": ["tet4", "prism6", "pyramid5"],
            "counts_verified": True,
            "length_units_verified": True,
            "quality_scope": "airbox",
            "quality_marker": 0,
            "quality_source_verified": True,
            "length_units": ["m"],
        },
        "initial_quality_loading": {
            "resource_status": "loading",
            "panel_status": "loading",
            "gate_result": "unknown",
            "live_response_preserved": True,
            "recovered_to_ready": True,
        },
        "synthetic_quality_fault_injection": {
            "live_baseline": {"resource_status": "ready", "gate_result": "unknown", "revision": 7},
            "evidence_kind": "fault-injected-ui-only-not-scientific",
            "synthetic_pass_control": deepcopy(synthetic_pass),
            "delayed_live_get": {
                "cached_synthetic_gate_status": "pass",
                "resource_status": "stale",
                "panel_status": "stale",
                "gate_result": "unknown",
                "live_response_preserved": True,
                "live_response_status": 200,
                "requests": 1,
                "restored_to_live_unknown": True,
            },
            "synthetic_pass_control_for_error": deepcopy(synthetic_pass),
            "synthetic_error_get": {
                "cached_synthetic_gate_status": "pass",
                "http_status": 503,
                "resource_status": "error",
                "resource_error_observed": True,
                "panel_resource_status": "refresh error",
                "panel_reason_reports_failed_load": True,
                "gate_result": "unknown",
                "refresh_error_visible_in_statistics": True,
                "cached_quality_withheld": True,
                "requests": 1,
                "restored_to_live_unknown": True,
            },
            "final_live_state": {
                "resource_status": "ready",
                "gate_result": "unknown",
                "revision_matches_live": True,
            },
        },
        "resource_refresh": {
            "resource_path": "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
            "same_root": True,
            "live_response_preserved": True,
            "status": 200,
            "request_count": 1,
            "delay_ms": 350,
        },
    }
    payload = {
        "schema": qa.AIRBOX_INSPECTOR_RESULT_SCHEMA,
        "state": "passed",
        "scenario": "airbox-inspector",
        "public_url": public_url,
        "probe_url": browser_url,
        "playwright_version": qa.PLAYWRIGHT_VERSION,
        "browser_gpu_mode": "swiftshader-webgl-requested",
        "page_errors": 0,
        "console_errors": 0,
        "request_failures": 0,
        "http_errors": [],
        "startup_request_events": [],
        "startup_unmount_cancellation_probes": [],
        "synthetic_http_errors": [
            "503 GET /v2/sessions/current/meshing/meshes/universe/quality",
        ],
        "synthetic_console_errors": [],
        "resource_responses": [
            {"url": browser_url + "/v2/sessions/current/status", "status": 200},
        ],
        "inspector_proof": proof,
    }
    return payload, public_url, browser_url, script_sha256


def _recovery_fixture(qa):
    selected = ROOT.resolve()
    identity = {
        "project_id": "fullmag",
        "worktree_id": "fixture",
        "checkout_kind": "worktree",
    }
    project = "fullmag-worktree-fixture"
    attempt = "a" * 32
    runtime_attempt = "b" * 32
    image = "sha256:" + "c" * 64
    document = {"name": project, "services": {"backend": {}, "frontend": {}}}
    config_sha256 = hashlib.sha256(qa.canonical(document)).hexdigest()
    original_inputs = {
        "schema": "fullmag.docker-development-inputs.v1",
        "source_root": str(selected),
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "image_id": image,
        "source_commit": "1" * 40,
    }
    original = {
        "state": "failed-confirmed",
        "phase": "development",
        "attempt": attempt,
        "compose_project": project,
        "config_sha256": config_sha256,
        "inputs": original_inputs,
        "source_commit": original_inputs["source_commit"],
        "frontend_volume": "fullmag-frontend-state",
    }
    recovered = {
        "state": "succeeded",
        "phase": "resume",
        "attempt": runtime_attempt,
        "compose_project": project,
        "config_sha256": config_sha256,
        "inputs": {
            "attempt": attempt,
            "config_sha256": config_sha256,
            "source_root": str(selected),
            "image_id": image,
        },
        "backend_container": "d" * 64,
        "frontend_container": "e" * 64,
        "finished_at": 42,
    }

    class FakeControl:
        def __init__(self):
            self.project = project
            self.documents = {
                "development/current.json": deepcopy(original),
                f"development/attempts/{attempt}/terminal.json": deepcopy(original),
                f"development/attempts/{attempt}/compose.json": deepcopy(document),
                "frontend/development-inputs.json": {
                    "source_root": str(selected),
                    "worktree_id": identity["worktree_id"],
                    "host_port": "3199",
                },
            }
            self.reads = []

        def read(self, path, optional=False):
            self.reads.append((path, optional))
            if path not in self.documents:
                if optional:
                    return None
                raise AssertionError(f"unexpected control-volume read: {path}")
            return deepcopy(self.documents[path])

    return {
        "selected": selected,
        "identity": identity,
        "project": project,
        "attempt": attempt,
        "runtime_attempt": runtime_attempt,
        "image": image,
        "document": document,
        "config_sha256": config_sha256,
        "original_inputs": original_inputs,
        "original": original,
        "recovered": recovered,
        "control": FakeControl(),
    }


def _browser_qa_reconciliation_fixture(
    qa,
    *,
    active_values=None,
    browser_running=False,
    browser_absent=False,
    retain_evidence=False,
    retain_terminal=False,
    browser_exit_code=23,
):
    selected = ROOT.resolve()
    identity = {"project_id": "fullmag", "worktree_id": "fixture", "checkout_kind": "worktree"}
    attempt = "a" * 32
    helper_id = "b" * 64
    browser_id = "c" * 64
    image_id = "sha256:" + "d" * 64
    project = "fullmag-worktree-fixture"
    volume = "fullmag-control-fixture"
    helper_name = "fullmag-control-" + attempt
    browser_name = "fullmag-browser-qa-" + attempt[:12]
    browser_image = qa.DEFAULT_BROWSER_IMAGE
    frontend_volume = "fullmag-frontend-state"
    receipt = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "browser-qa",
        "attempt": attempt,
        "compose_project": project,
        "control_volume": volume,
        "state": "outcome-unknown-resources-retained",
        "inputs": {
            "source_root": str(selected),
            "worktree_id": identity["worktree_id"],
            "browser_image": browser_image,
            "frontend_volume": frontend_volume,
            "browser_runtime_timeout": 180,
        },
        "helper_container": helper_name,
        "browser_container_name": browser_name,
        "browser_image_id": image_id,
    }
    document = {
        "name": project,
        "services": {
            "browser-qa": {
                "command": ["node", "/qa/run.mjs"],
            },
        },
    }
    receipt_raw = qa.canonical(receipt)
    compose_raw = qa.canonical(document)
    observed = {
        "Name": "/" + browser_name,
        "Id": browser_id,
        "State": {
            "Status": "running" if browser_running else "exited",
            "Running": browser_running,
            "OOMKilled": False,
            "ExitCode": 0 if browser_running else browser_exit_code,
            "FinishedAt": "" if browser_running else "2026-10-20T10:00:00Z",
        },
        "RestartCount": 0,
        "Config": {
            "Cmd": document["services"]["browser-qa"]["command"],
            "Entrypoint": ["/bin/sh"],
        },
    }
    image_document = {"Id": image_id, "Config": {"Entrypoint": ["/bin/sh"]}}
    helper_log = "authenticated control helper log"
    absence_sha256 = "e" * 64
    reconciled_at = 1_792_491_600.0
    retained = None
    terminal = None
    if retain_evidence:
        retained = {
            "schema": "fullmag.browser-qa-reconciliation.v1",
            "state": "failed-confirmed",
            "attempt": attempt,
            "compose_project": project,
            "output_lost": True,
            "observed_exit_code": observed["State"]["ExitCode"],
            "browser_container_id": browser_id,
            "receipt_sha256": hashlib.sha256(receipt_raw).hexdigest(),
            "compose_sha256": hashlib.sha256(compose_raw).hexdigest(),
            "helper_id": helper_id,
            "helper_log": helper_log,
            "browser_inspect": observed,
            "verification": "NOT VERIFIED",
            "reconciled_at": reconciled_at,
        }
    if retain_terminal:
        if retained is None:
            raise AssertionError("a retained terminal requires retained reconciliation evidence")
        terminal = {
            **receipt,
            "state": "failed-confirmed",
            "output_lost": True,
            "error": "Browser QA failed; output lost after client timeout",
            "exit_code": observed["State"]["ExitCode"],
            "browser_container_id": browser_id,
            "browser_absence_sha256": absence_sha256,
            "reconciliation_evidence_sha256": hashlib.sha256(
                qa.canonical(retained) + b"\n"
            ).hexdigest(),
            "finished_at": reconciled_at,
            "verification": "NOT VERIFIED",
        }

    class FakeControl:
        def __init__(self):
            self.project = project
            self.volume = volume
            self.events = []
            self.writes = []
            self.active_values = list(active_values or [attempt + "\n"])
            self.active_observations = []
            self.byte_reads = []
            self.helper_scripts = []
            self.documents = {
                "browser-qa/attempts/" + attempt + "/receipt.json": receipt_raw,
                "browser-qa/attempts/" + attempt + "/compose.json": compose_raw,
            }
            root = "browser-qa/attempts/" + attempt
            if retained is not None:
                self.documents[root + "/reconciliation-evidence.json"] = deepcopy(retained)
            if terminal is not None:
                self.documents[root + "/terminal.json"] = deepcopy(terminal)

        def read_control_bytes(self, relative, optional=False):
            self.byte_reads.append((relative, optional))
            self.events.append(("control-bytes", relative))
            if relative == "active":
                if len(self.active_values) > 1:
                    value = self.active_values.pop(0)
                else:
                    value = self.active_values[0] if self.active_values else None
                self.active_observations.append(value)
                return value.encode("utf-8") if isinstance(value, str) else value
            if relative not in self.documents:
                if optional:
                    return None
                raise AssertionError("unexpected control byte read: " + relative)
            return self.documents[relative]

        def read(self, relative, optional=False):
            self.events.append(("read", relative))
            if relative not in self.documents:
                if optional:
                    return None
                raise AssertionError("unexpected control read: " + relative)
            return deepcopy(self.documents[relative])

        def write(self, relative, value):
            snapshot = deepcopy(value)
            self.events.append(("write", relative, snapshot))
            self.writes.append((relative, snapshot))
            self.documents[relative] = snapshot

        @staticmethod
        def path(relative):
            return "/control/" + relative

        def helper_args(self, script):
            self.events.append(("helper-args", script))
            self.helper_scripts.append(script)
            return ("mock-control-helper", script)

    control = FakeControl()
    args = SimpleNamespace(
        reconcile_attempt=attempt,
        expected_receipt_sha256=hashlib.sha256(receipt_raw).hexdigest(),
        expected_compose_sha256=hashlib.sha256(compose_raw).hexdigest(),
        expected_browser_id=browser_id,
        expected_helper_id=helper_id,
        port=3199,
    )
    calls = {
        "probes": [],
        "docker": [],
        "inspect": [],
        "cas": [],
        "helper_validation": [],
        "wait": [],
        "console": [],
    }
    return {
        "selected": selected,
        "identity": identity,
        "attempt": attempt,
        "helper_id": helper_id,
        "helper_name": helper_name,
        "browser_id": browser_id,
        "browser_name": browser_name,
        "image_id": image_id,
        "image_document": image_document,
        "receipt": receipt,
        "document": document,
        "observed": observed,
        "helper_log": helper_log,
        "absence_sha256": absence_sha256,
        "retained": retained,
        "terminal": terminal,
        "args": args,
        "control": control,
        "calls": calls,
        "browser_absent": browser_absent,
    }


@contextmanager
def _mock_browser_qa_reconciliation(qa, case):
    import docker_build_control
    import docker_volume_activation_reconcile as activation_reconcile

    control = case["control"]
    calls = case["calls"]

    def probe_absence(identifier):
        calls["probes"].append(identifier)
        control.events.append(("probe-absence", identifier))
        if identifier == case["browser_id"]:
            if case["browser_absent"] or any(
                event[0] == "docker-rm" for event in control.events
            ):
                return case["absence_sha256"]
            return None
        return case["absence_sha256"]

    def inspect_browser(identifier):
        calls["inspect"].append(identifier)
        control.events.append(("inspect-browser", identifier))
        if case["browser_absent"]:
            raise AssertionError("an absent browser must be replayed from retained evidence")
        return deepcopy(case["observed"])

    def docker_capture(*args, **kwargs):
        calls["docker"].append((args, kwargs))
        control.events.append(("docker", args))
        if args == ("rm", case["browser_id"]):
            control.events.append(("docker-rm", case["browser_id"]))
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        raise AssertionError("unexpected Docker command in reconciliation test: " + repr(args))

    def bounded_capture(args, *, data, timeout):
        calls["cas"].append((args, data, timeout))
        control.events.append(("bounded-capture", args))
        control.active_values = [None]
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    def validate_helper(*args, **kwargs):
        calls["helper_validation"].append((args, kwargs))
        control.events.append(("validate-control-helper", args))
        return {}, case["helper_id"]

    def validate_browser_helper(*args, **kwargs):
        control.events.append(("validate-browser-helper", args))

    with ExitStack() as stack:
        stack.enter_context(patch.object(activation_reconcile, "_control_bytes",
                                         side_effect=lambda _control, relative, optional=False:
                                         control.read_control_bytes(relative, optional)))
        stack.enter_context(patch.object(activation_reconcile, "_probe_helper_absence",
                                         side_effect=probe_absence))
        stack.enter_context(patch.object(activation_reconcile, "_validate_helper",
                                         side_effect=validate_helper))
        stack.enter_context(patch.object(activation_reconcile, "_validate_helper_logged",
                                         return_value=case["helper_log"]))
        stack.enter_context(patch.object(
            activation_reconcile, "_wait_for_helper_exit",
            side_effect=lambda helper_id: calls["wait"].append(helper_id),
        ))
        stack.enter_context(patch.object(qa, "_compose_document",
                                         return_value=case["document"]))
        stack.enter_context(patch.object(qa, "_inspect", side_effect=inspect_browser))
        stack.enter_context(patch.object(qa, "_inspect_image",
                                         return_value=case["image_document"]))
        stack.enter_context(patch.object(qa, "_validate_browser_image_reference"))
        stack.enter_context(patch.object(qa, "_validate_browser_image_document",
                                         return_value=(case["image_id"], "pinned-image-digest")))
        stack.enter_context(patch.object(qa, "_validate_browser_helper",
                                         side_effect=validate_browser_helper))
        stack.enter_context(patch.object(qa, "docker_capture", side_effect=docker_capture))
        stack.enter_context(patch.object(qa, "mirror_console",
                                         side_effect=lambda value: calls["console"].append(value)))
        stack.enter_context(patch.object(docker_build_control, "bounded_capture",
                                         side_effect=bounded_capture))
        yield


class DockerDevBrowserQaContractTests(unittest.TestCase):
    def test_prestart_probe_refuses_exec_browser_presence_and_host_controller(self):
        qa=self.qa
        import docker_volume_activation_reconcile as reconcile
        args=SimpleNamespace(reconcile_attempt='a'*32,port=3199)
        current={'attempt':'development','config_sha256':'digest','backend_started_at':'start',
                 'development_fence_sha256':'fence'}
        inputs={'development_attempt':'development','development_config_sha256':'digest',
                'frontend_container':'front','frontend_volume':'volume',
                'frontend_inputs_sha256':hashlib.sha256(qa.canonical({})).hexdigest()}
        receipt={'inputs':inputs}
        observed={key:{'Id':key,'Image':'image','State':{'Running':True,'StartedAt':'start','Pid':1},
                       'Config':{},'HostConfig':{},'Mounts':[]} for key in ('back','front','helper')}
        control=SimpleNamespace(project='project',read=lambda *args,**kw:{})
        with patch.object(qa,'_assert_no_qa_controller') as controller, \
             patch.object(qa,'_read_live_development',return_value=(current,'back','front','volume',{})), \
             patch.object(qa,'_inspect',side_effect=lambda key:observed[key]), \
             patch.object(qa,'_inspect_image',return_value={'Config':{}}), \
             patch.object(qa,'_validate_frontend') as validate_frontend,patch.object(qa,'validate_source_labels'), \
             patch('docker_volume_dev._validate_retained_service'), \
             patch.object(reconcile,'_control_bytes',return_value=None), \
             patch.object(reconcile,'_probe_helper_absence',return_value='absent') as absence, \
             patch.object(qa,'docker_capture',return_value=SimpleNamespace(stdout=b'back\nfront\nhelper\n')):
            qa._probe_prestart_browser_qa(control,Path('/source'),{},args,receipt,'helper',cache_project_id='resolver-cache-id')
            self.assertEqual(validate_frontend.call_args.kwargs['cache_project_id'],'resolver-cache-id')
            observed['back']['ExecIDs']=['live-exec']
            with self.assertRaisesRegex(qa.BuildControlError,'active Docker exec'):
                qa._probe_prestart_browser_qa(control,Path('/source'),{},args,receipt,'helper',cache_project_id='resolver-cache-id')
            observed['back'].pop('ExecIDs')
            absence.return_value=None
            with self.assertRaisesRegex(qa.BuildControlError,'browser name exists'):
                qa._probe_prestart_browser_qa(control,Path('/source'),{},args,receipt,'helper',cache_project_id='resolver-cache-id')
            controller.side_effect=qa.BuildControlError('host controller alive')
            with self.assertRaisesRegex(qa.BuildControlError,'host controller alive'):
                qa._probe_prestart_browser_qa(control,Path('/source'),{},args,receipt,'helper',cache_project_id='resolver-cache-id')

    def test_prestart_reconciliation_refuses_session_drift_before_publication(self):
        qa=self.qa
        case=_browser_qa_reconciliation_fixture(qa)
        case['args'].reconcile_prestart=True
        with _mock_browser_qa_reconciliation(qa,case), \
             patch.object(qa,'_probe_prestart_browser_qa',side_effect=[{'pins':'before'},{'pins':'changed'}]):
            with self.assertRaisesRegex(qa.BuildControlError,'proof changed'):
                qa._reconcile_prestart_qa(case['control'],case['selected'],case['identity'],case['args'],case['receipt'],case['helper_id'],case['helper_log'],cache_project_id='resolver-cache-id')
        self.assertEqual(case['calls']['cas'],[])
        self.assertEqual(case['calls']['docker'],[])

    def test_prestart_reconciliation_publishes_not_run_without_browser_removal(self):
        qa=self.qa
        case=_browser_qa_reconciliation_fixture(qa)
        case['receipt']['state']='starting'
        case['receipt'].pop('browser_container_name')
        raw=qa.canonical(case['receipt'])
        root='browser-qa/attempts/'+case['attempt']
        case['control'].documents[root+'/receipt.json']=raw
        case['args'].expected_receipt_sha256=hashlib.sha256(raw).hexdigest()
        case['args'].expected_browser_id=None
        case['args'].reconcile_prestart=True
        with _mock_browser_qa_reconciliation(qa,case), \
             patch.object(qa,'_probe_prestart_browser_qa',return_value={'browser_state':'NOT RUN'}) as probe:
            qa.reconcile_browser_qa(case['control'],case['selected'],case['identity'],case['args'],cache_project_id='resolver-cache-id')
        self.assertEqual(probe.call_count,2)
        self.assertTrue(all(call.kwargs['cache_project_id']=='resolver-cache-id' for call in probe.call_args_list))
        self.assertEqual(case['calls']['docker'],[])
        self.assertEqual(case['calls']['inspect'],[])
        terminal=json.loads(case['calls']['cas'][0][1])
        self.assertEqual(terminal['state'],'failed-confirmed')
        self.assertEqual(terminal['browser_state'],'NOT RUN')
        self.assertEqual(terminal['verification'],'NOT VERIFIED')
        self.assertNotIn('browser_container_id',terminal)
        self.assertNotIn('rm /control/active',case['control'].helper_scripts[0])

    @classmethod
    def setUpClass(cls):
        cls.qa = _load_qa_module()

    def test_failed_development_resolves_only_verified_linked_runtime_and_keeps_original_provenance(self):
        qa = self.qa
        case = _recovery_fixture(qa)
        activation = importlib.import_module("docker_volume_activate")
        original_before = deepcopy(case["original"])
        resolved_ids = ("backend-runtime", "frontend-runtime")
        stale_candidate = {**deepcopy(case["recovered"]), "attempt": "f" * 32, "finished_at": 99}
        with patch.object(
            activation, "_linked_runtime_terminals", return_value=[stale_candidate, case["recovered"]],
        ) as linked, \
             patch.object(
                 activation,
                 "_validate_running_group",
                 side_effect=[qa.BuildControlError("stale candidate is no longer running"), resolved_ids],
             ) as validate:
            result = qa._read_live_development(
                case["control"], case["selected"], case["identity"], 3199,
            )

        current, backend_id, frontend_id, frontend_volume, frontend_inputs = result
        self.assertEqual(current["state"], "succeeded")
        self.assertEqual(current["development_terminal_state"], "failed-confirmed")
        self.assertEqual(current["attempt"], case["attempt"])
        self.assertEqual(current["phase"], "development")
        self.assertEqual(current["inputs"], case["original_inputs"])
        self.assertEqual(current["runtime_attempt"], case["runtime_attempt"])
        self.assertEqual(current["runtime_phase"], "resume")
        self.assertEqual(
            current["development_fence_sha256"],
            hashlib.sha256(qa.canonical(original_before)).hexdigest(),
        )
        self.assertEqual(
            current["runtime_terminal_sha256"],
            hashlib.sha256(qa.canonical(case["recovered"])).hexdigest(),
        )
        self.assertEqual(backend_id, case["recovered"]["backend_container"])
        self.assertEqual(frontend_id, case["recovered"]["frontend_container"])
        self.assertEqual(frontend_volume, "fullmag-frontend-state")
        self.assertEqual(frontend_inputs["worktree_id"], case["identity"]["worktree_id"])
        self.assertEqual(case["original"], original_before)
        linked.assert_called_once_with(
            case["control"], case["attempt"], case["original"],
            source_root=str(case["selected"]), image=case["image"],
            config_sha256=case["config_sha256"],
        )
        self.assertEqual(validate.call_count, 2)
        self.assertEqual(validate.call_args_list[0].args[3], stale_candidate)
        self.assertEqual(validate.call_args_list[1].args[3], case["recovered"])

    def test_failed_development_rejects_stale_terminal_config_source_missing_link_and_ambiguous_live_ids(self):
        qa = self.qa
        activation = importlib.import_module("docker_volume_activate")

        with self.subTest(reason="current differs from its terminal"), \
             patch.object(activation, "_linked_runtime_terminals") as linked, \
             patch.object(activation, "_validate_running_group"):
            case = _recovery_fixture(qa)
            case["control"].documents[
                f"development/attempts/{case['attempt']}/terminal.json"
            ]["state"] = "failed"
            with self.assertRaisesRegex(qa.BuildControlError, "differs from its terminal"):
                qa._read_recovered_development(
                    case["control"], case["original"], case["selected"], case["identity"],
                )
            linked.assert_not_called()

        with self.subTest(reason="configuration pin differs"), \
             patch.object(activation, "_linked_runtime_terminals") as linked, \
             patch.object(activation, "_validate_running_group"):
            case = _recovery_fixture(qa)
            case["original"]["config_sha256"] = "f" * 64
            case["control"].documents[
                f"development/attempts/{case['attempt']}/terminal.json"
            ] = deepcopy(case["original"])
            with self.assertRaisesRegex(qa.BuildControlError, "original/config pin differs"):
                qa._read_recovered_development(
                    case["control"], case["original"], case["selected"], case["identity"],
                )
            linked.assert_not_called()

        with self.subTest(reason="source differs from selected checkout"), \
             patch.object(activation, "_linked_runtime_terminals") as linked, \
             patch.object(activation, "_validate_running_group"):
            case = _recovery_fixture(qa)
            case["original"]["inputs"]["source_root"] = str(case["selected"].parent)
            case["control"].documents[
                f"development/attempts/{case['attempt']}/terminal.json"
            ] = deepcopy(case["original"])
            with self.assertRaisesRegex(qa.BuildControlError, "recovery source differs"):
                qa._read_recovered_development(
                    case["control"], case["original"], case["selected"], case["identity"],
                )
            linked.assert_not_called()

        with self.subTest(reason="no succeeded linked runtime"), \
             patch.object(activation, "_linked_runtime_terminals", return_value=[]) as linked, \
             patch.object(activation, "_validate_running_group") as validate:
            case = _recovery_fixture(qa)
            with self.assertRaisesRegex(qa.BuildControlError, "exactly one live group"):
                qa._read_recovered_development(
                    case["control"], case["original"], case["selected"], case["identity"],
                )
            linked.assert_called_once()
            validate.assert_not_called()

        with self.subTest(reason="linked receipts resolve to distinct live groups"), \
             patch.object(
                 activation,
                 "_linked_runtime_terminals",
                 side_effect=lambda _control, _attempt, _original, **_kwargs: [
                     {**_recovery_fixture(qa)["recovered"], "attempt": "b" * 32},
                     {**_recovery_fixture(qa)["recovered"], "attempt": "c" * 32, "phase": "iteration"},
                 ],
             ) as linked, \
             patch.object(
                 activation,
                 "_validate_running_group",
                 side_effect=[("backend-one", "frontend-one"), ("backend-two", "frontend-two")],
             ) as validate:
            case = _recovery_fixture(qa)
            with self.assertRaisesRegex(qa.BuildControlError, "exactly one live group"):
                qa._read_recovered_development(
                    case["control"], case["original"], case["selected"], case["identity"],
                )
            linked.assert_called_once()
            self.assertEqual(validate.call_count, 2)

    def test_succeeded_development_receipt_keeps_direct_read_path(self):
        qa = self.qa
        selected = ROOT.resolve()
        identity = {
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
        }
        current = {
            "state": "succeeded",
            "compose_project": "fullmag-worktree-fixture",
            "inputs": {
                "source_root": str(selected),
                "source_project_id": identity["project_id"],
                "source_worktree_id": identity["worktree_id"],
                "source_checkout_kind": identity["checkout_kind"],
            },
            "backend_container": "backend-current",
            "frontend_container": "frontend-current",
            "frontend_volume": "fullmag-frontend-state",
        }
        frontend_inputs = {
            "source_root": str(selected),
            "worktree_id": identity["worktree_id"],
            "host_port": "3199",
        }

        class FakeControl:
            project = "fullmag-worktree-fixture"

            def read(self, path):
                if path == "development/current.json":
                    return current
                if path == "frontend/development-inputs.json":
                    return frontend_inputs
                raise AssertionError(f"unexpected control-volume read: {path}")

        with patch.object(qa, "_read_recovered_development") as recover:
            result = qa._read_live_development(FakeControl(), selected, identity, 3199)

        self.assertEqual(result[0]["state"], current["state"])
        self.assertEqual(result[0]["inputs"], current["inputs"])
        self.assertEqual(
            result[0]["development_fence_sha256"],
            hashlib.sha256(qa.canonical(current)).hexdigest(),
        )
        self.assertEqual(result[1:], (
            "backend-current", "frontend-current", "fullmag-frontend-state", frontend_inputs,
        ))
        recover.assert_not_called()

    def test_reconcile_browser_qa_refuses_another_active_token_before_destructive_actions(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(
            qa, active_values=["f" * 32 + "\n"],
        )
        with _mock_browser_qa_reconciliation(qa, case):
            with self.assertRaisesRegex(qa.BuildControlError, "active fence differs"):
                qa.reconcile_browser_qa(
                    case["control"], case["selected"], case["identity"], case["args"],
                )

        root = "browser-qa/attempts/" + case["attempt"]
        byte_paths = [path for path, _optional in case["control"].byte_reads]
        self.assertEqual(byte_paths, ["active"])
        self.assertNotIn(root + "/receipt.json", byte_paths)
        self.assertEqual(case["control"].writes, [])
        self.assertEqual(case["calls"]["docker"], [])
        self.assertEqual(case["calls"]["cas"], [])
        self.assertEqual(case["calls"]["helper_validation"], [])

    def test_reconcile_browser_qa_rejects_bad_receipt_hash_before_helper_or_removal(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(qa)
        case["args"].expected_receipt_sha256 = "f" * 64
        with _mock_browser_qa_reconciliation(qa, case):
            with self.assertRaisesRegex(qa.BuildControlError, "evidence CAS differs"):
                qa.reconcile_browser_qa(
                    case["control"], case["selected"], case["identity"], case["args"],
                )

        self.assertIn(
            "browser-qa/attempts/" + case["attempt"] + "/receipt.json",
            [path for path, _optional in case["control"].byte_reads],
        )
        self.assertEqual(case["control"].writes, [])
        self.assertEqual(case["calls"]["helper_validation"], [])
        self.assertEqual(case["calls"]["docker"], [])
        self.assertEqual(case["calls"]["cas"], [])

    def test_reconcile_browser_qa_refuses_running_browser_without_persisting_or_removing(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(qa, browser_running=True)
        with _mock_browser_qa_reconciliation(qa, case):
            with self.assertRaisesRegex(qa.BuildControlError, "exact stopped browser"):
                qa.reconcile_browser_qa(
                    case["control"], case["selected"], case["identity"], case["args"],
                )

        self.assertEqual(case["calls"]["inspect"], [case["browser_id"]])
        self.assertEqual(case["control"].writes, [])
        self.assertEqual(case["calls"]["docker"], [])
        self.assertEqual(case["calls"]["cas"], [])

    def test_reconcile_browser_qa_persists_evidence_before_remove_and_publishes_terminal_by_cas(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(qa)
        with _mock_browser_qa_reconciliation(qa, case):
            qa.reconcile_browser_qa(
                case["control"], case["selected"], case["identity"], case["args"],
            )

        events = case["control"].events
        evidence_path = (
            "browser-qa/attempts/" + case["attempt"] + "/reconciliation-evidence.json"
        )
        evidence_write = next(
            index for index, event in enumerate(events)
            if event[0] == "write" and event[1] == evidence_path
        )
        browser_remove = next(
            index for index, event in enumerate(events)
            if event[0] == "docker-rm" and event[1] == case["browser_id"]
        )
        cas_publication = next(
            index for index, event in enumerate(events) if event[0] == "bounded-capture"
        )
        self.assertLess(evidence_write, browser_remove)
        self.assertLess(browser_remove, cas_publication)
        self.assertEqual(case["calls"]["docker"], [(
            ("rm", case["browser_id"]), {},
        )])
        self.assertEqual(len(case["calls"]["cas"]), 1)
        helper_args, payload, timeout = case["calls"]["cas"][0]
        script = case["control"].helper_scripts[0]
        self.assertEqual(helper_args, ("mock-control-helper", script))
        self.assertEqual(timeout, 90)
        self.assertIn(
            "test \"$(cat /control/active)\" = '" + case["attempt"] + "'",
            script,
        )
        self.assertIn(
            "sha256sum '/control/browser-qa/attempts/" + case["attempt"] + "/receipt.json'",
            script,
        )
        self.assertIn(
            "sha256sum '/control/browser-qa/attempts/" + case["attempt"] + "/compose.json'",
            script,
        )
        self.assertIn(
            "mv -T -- \"$t\" '/control/browser-qa/attempts/"
            + case["attempt"] + "/terminal.json'",
            script,
        )
        self.assertNotIn("rm -f -- '/control/active'", script)
        self.assertNotIn("unlink", script.lower())
        self.assertFalse(any(
            path.endswith("/terminal.json") for path, _value in case["control"].writes
        ))
        published = json.loads(payload)
        self.assertEqual(published["state"], "failed-confirmed")
        self.assertEqual(published["output_lost"], True)
        self.assertEqual(published["browser_container_id"], case["browser_id"])
        self.assertEqual(case["control"].active_values, [None])
        self.assertEqual(case["calls"]["wait"], [case["helper_id"]])

    def test_reconcile_browser_qa_accepts_terminal_zero_exit_as_lost_output(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(qa, browser_exit_code=0)
        with _mock_browser_qa_reconciliation(qa, case):
            qa.reconcile_browser_qa(
                case["control"], case["selected"], case["identity"], case["args"],
            )

        published = json.loads(case["calls"]["cas"][0][1])
        self.assertEqual(published["state"], "failed-confirmed")
        self.assertTrue(published["output_lost"])
        self.assertEqual(published["exit_code"], 0)
        self.assertEqual(published["verification"], "NOT VERIFIED")
        self.assertNotEqual(published["state"], "succeeded")

    def test_reconcile_browser_qa_released_replay_requires_active_marker_to_stay_absent(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(
            qa,
            active_values=[None, "a" * 32 + "\n"],
            browser_absent=True,
            retain_evidence=True,
            retain_terminal=True,
        )
        with _mock_browser_qa_reconciliation(qa, case):
            with self.assertRaisesRegex(
                qa.BuildControlError, "Completed QA reconciliation terminal/fence differs",
            ):
                qa.reconcile_browser_qa(
                    case["control"], case["selected"], case["identity"], case["args"],
                )

        active_reads = case["control"].active_observations
        self.assertEqual(active_reads, [None, "a" * 32 + "\n"])
        self.assertEqual(case["control"].writes, [])
        self.assertEqual(case["calls"]["docker"], [])
        self.assertEqual(case["calls"]["cas"], [])

    def test_reconcile_browser_qa_accepts_released_replay_only_with_active_absent(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(
            qa,
            active_values=[None],
            browser_absent=True,
            retain_evidence=True,
            retain_terminal=True,
        )
        with _mock_browser_qa_reconciliation(qa, case):
            qa.reconcile_browser_qa(
                case["control"], case["selected"], case["identity"], case["args"],
            )

        self.assertEqual(case["control"].active_observations, [None, None])
        self.assertEqual(case["control"].writes, [])
        self.assertEqual(case["calls"]["docker"], [])
        self.assertEqual(case["calls"]["cas"], [])
        self.assertEqual(len(case["calls"]["console"]), 1)
        self.assertIn('"lease_released": true', case["calls"]["console"][0])

    def test_reconcile_browser_qa_absent_browser_replay_uses_retained_inspect_evidence(self):
        qa = self.qa
        case = _browser_qa_reconciliation_fixture(
            qa, browser_absent=True, retain_evidence=True,
        )
        with _mock_browser_qa_reconciliation(qa, case):
            qa.reconcile_browser_qa(
                case["control"], case["selected"], case["identity"], case["args"],
            )

        self.assertEqual(case["calls"]["inspect"], [])
        self.assertFalse(any(
            event[0] == "docker-rm" for event in case["control"].events
        ))
        self.assertEqual(case["control"].writes, [])
        self.assertEqual(len(case["calls"]["cas"]), 1)
        published = json.loads(case["calls"]["cas"][0][1])
        self.assertEqual(published["state"], "failed-confirmed")
        self.assertEqual(published["browser_container_id"], case["browser_id"])
        self.assertEqual(
            published["reconciliation_evidence_sha256"],
            hashlib.sha256(qa.canonical(case["retained"]) + b"\n").hexdigest(),
        )

    def test_just_recipe_stays_on_managed_python_route(self):
        text = (ROOT / "justfile").read_text(encoding="utf-8")
        match = re.search(r"(?ms)^docker-dev-browser-qa .*?(?=^\S|\Z)", text)
        self.assertIsNotNone(match)
        recipe = match.group(0)
        self.assertIn("docker_dev_browser_qa.py", recipe)
        self.assertIn('source_root="" port=""', recipe)
        self.assertIn("--port", recipe)
        self.assertIn('pull_timeout="1800"', recipe)
        self.assertIn("--pull-timeout", recipe)
        self.assertIn('saved_playback_item_id=""', recipe)
        self.assertIn("--saved-playback-item-id", recipe)
        self.assertNotIn('port="32871"', recipe)
        self.assertNotIn("pnpm", recipe)
        self.assertNotIn("node ", recipe)
        shell = (ROOT / "scripts/just_storage_shell.sh").read_text(encoding="utf-8")
        self.assertIn('scripts/docker_dev_browser_qa.py', shell)
        self.assertIn('browser_qa_pattern=', shell)
        self.assertIn('--pull-timeout', shell)
        self.assertIn('--saved-playback-item-id', shell)
        self.assertIn('exec "${python_cmd}" -B "${script_dir}/docker_dev_browser_qa.py"', shell)

    def test_browser_service_has_no_host_writes_or_published_ports(self):
        identity = {
            "project_name": "fullmag-worktree-fixture",
            "network_name": "fullmag-worktree-fixture_fullmag",
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        document = self.qa._compose_document(
            ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE,
            "fullmag-frontend-state", 3199, 180,
        )
        self.assertEqual(document["name"], identity["project_name"])
        self.assertEqual(document["volumes"], {
            "frontend-state": {"name": "fullmag-frontend-state", "external": True},
        })
        self.assertEqual(document["networks"], {
            "fullmag": {"name": identity["network_name"], "external": True},
        })
        service = document["services"]["browser-qa"]
        self.assertNotIn("ports", service)
        self.assertNotIn("network_mode", service)
        self.assertNotIn("extra_hosts", service)
        self.assertEqual(service["pull_policy"], "never")
        self.assertEqual(service["logging"], {"driver": "none"})
        self.assertEqual(service["environment"]["CONTROL_ROOM_URL"], "http://frontend:8080")
        self.assertTrue(all(mount["read_only"] for mount in service["volumes"]))
        self.assertEqual({mount["target"] for mount in service["volumes"]}, {
            "/state/development",
            "/state/development/workspace/apps/control-room/scripts",
        })

    def test_planar_airbox_compose_reuses_the_managed_readonly_runner(self):
        identity = {
            "project_name": "fullmag-worktree-fixture",
            "network_name": "fullmag-worktree-fixture_fullmag",
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        standard = self.qa._compose_document(
            ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3199, 180,
        )
        planar = self.qa._compose_document(
            ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3199, 180,
            canvas_only=True,
            expect_live_field="m",
            expect_airbox_vectors=False,
            expect_ambiguous_compute_fields=False,
            expect_planar_airbox=True,
        )
        standard_service = standard["services"]["browser-qa"]
        service = planar["services"]["browser-qa"]
        self.assertEqual(service["command"], standard_service["command"])
        self.assertEqual(service["command"][-1],
                         "/state/development/workspace/apps/control-room/scripts/docker-dev-browser-qa.mjs")
        self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_SCENARIO"], "planar-airbox")
        self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_EXPECT_PLANAR_AIRBOX"], "1")
        self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_EXPECT_LIVE_FIELD"], "m")
        self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS"], "0")
        self.assertTrue(service["read_only"])
        self.assertNotIn("ports", service)
        self.assertTrue(all(mount["read_only"] for mount in service["volumes"]))
        for invalid in (
            {"canvas_only": False},
            {"canvas_only": True, "expect_live_field": "H_demag"},
            {"canvas_only": True, "expect_live_field": "m", "expect_airbox_vectors": True},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(self.qa.BuildControlError):
                self.qa._compose_document(
                    ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3199, 180,
                    expect_planar_airbox=True,
                    expect_ambiguous_compute_fields=False,
                    **invalid,
                )

    def test_planar_airbox_observation_checks_scope_physical_frame_and_identity(self):
        qa = self.qa
        session = {
            "session_id": "session-1",
            "session_epoch": "session-1@1",
            "request_scope_epoch": "api:1",
        }
        observation = _planar_airbox_observation_fixture(qa)
        qa._validate_planar_airbox_observation(observation, session)

        cases = (
            ("sample token", lambda item: item["evidence"].update(sampleToken="stale-token")),
            ("scope id", lambda item: item["meta_request"].update(scope_id_present=True)),
            # This is the small ferromagnet-sized frame, not the 2 x 2 x 2
            # authoritative Universe/Airbox grid in the layout fixture.
            ("magnetic bounds", lambda item: item["meta"]["frame"].update(
                bounds_uv_m=[-0.05, 0.05, -0.05, 0.05],
            )),
            # At z=0.5 the requested midpoint is a cell edge; the target grid
            # must resolve it to the lower native cell center at z=32.
            ("snapped normal coordinate", lambda item: item["meta"]["frame"].update(
                origin_m=[11.0, 22.0, 34.0],
            )),
            ("run identity", lambda item: item["session_after"].update(run_id="run-2")),
            ("presentation restoration", lambda item: item.update(presentation_restored=False)),
            ("forbidden mutation", lambda item: item.update(blocked_mutation_count=1)),
            ("computation mutation", lambda item: item.update(no_computation_or_monitor_mutations=False)),
            ("invisible canvas", lambda item: item["canvas"].update(visible=False)),
            ("empty raster", lambda item: item["evidence"]["raster"].update(sampleCount=0)),
        )
        for name, mutate in cases:
            with self.subTest(reason=name):
                invalid = deepcopy(observation)
                mutate(invalid)
                with self.assertRaises(qa.BuildControlError):
                    qa._validate_planar_airbox_observation(invalid, session)

    def test_inspector_ack_compose_is_standalone_and_attests_its_exact_command_and_sources(self):
        qa = self.qa
        identity = {"project_name": "fullmag-worktree-fixture", "network_name": "fullmag-worktree-fixture_fullmag",
                    "project_id": "fullmag", "worktree_id": "fixture", "checkout_kind": "worktree", "source_root": str(ROOT)}
        sources = {key: "a" * 64 for key in qa.INSPECTOR_ACK_SOURCES}
        document = qa._compose_document(
            ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3242, 180,
            inspector_ack=True, inspector_ack_source_sha256=sources,
        )
        service = document["services"]["browser-qa"]
        self.assertEqual(service["command"], [
            "node", "/state/development/workspace/apps/control-room/scripts/check-inspector-ack-browser.mjs",
        ])
        self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_SCENARIO"], "inspector-ack")
        self.assertEqual(json.loads(service["environment"]["CONTROL_ROOM_INSPECTOR_ACK_SOURCE_SHA256"]), sources)
        self.assertTrue(all(mount["read_only"] for mount in service["volumes"]))
        for options in ({"airbox_inspector": True}, {"canvas_only": False}, {"expect_run_performance": True},
                        {"saved_playback_item_id": "123"}, {"expect_planar_airbox": True}):
            with self.subTest(options=options), self.assertRaises(qa.BuildControlError):
                qa._compose_document(
                    ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3242, 180,
                    inspector_ack=True, inspector_ack_source_sha256=sources, **options,
                )
        helper = {
            "Image": "sha256:" + "c" * 64,
            "Config": {
                "User": "65532:65532", "Cmd": service["command"],
                "Env": [f"{key}={value}" for key, value in service["environment"].items()],
                "Labels": {**qa.source_labels(identity), "com.docker.compose.project": identity["project_name"],
                           "com.docker.compose.service": "browser-qa"},
            },
            "HostConfig": {
                "GroupAdd": qa._script_bind_groups(ROOT), "ReadonlyRootfs": True,
                "NetworkMode": identity["network_name"], "PortBindings": None,
                "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=256m"}, "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"], "ExtraHosts": None,
            },
            "State": {"Running": False, "ExitCode": 0},
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}, "Ports": {}},
            "Mounts": [
                {"Type": "volume", "Name": "fullmag-frontend-state", "Destination": "/state/development", "RW": False},
                {"Type": "bind", "Source": str(ROOT / "apps/control-room/scripts"),
                 "Destination": "/state/development/workspace/apps/control-room/scripts", "RW": False},
            ],
        }
        control = SimpleNamespace(project=identity["project_name"])
        qa._validate_browser_helper(helper, control, identity, "fullmag-frontend-state", helper["Image"], 0, ROOT,
                                    inspector_ack=True, inspector_ack_source_sha256=sources)
        for change in ("command", "source", "unrequested"):
            altered = deepcopy(helper)
            if change == "command":
                altered["Config"]["Cmd"][-1] = "/tmp/untrusted.mjs"
            if change == "source":
                altered["Config"]["Env"].append("CONTROL_ROOM_INSPECTOR_ACK_SOURCE_SHA256={}")
            with self.subTest(change=change), self.assertRaises(qa.ControlOutcomeUnknown):
                qa._validate_browser_helper(
                    altered, control, identity, "fullmag-frontend-state", helper["Image"], 0, ROOT,
                    inspector_ack=change != "unrequested", inspector_ack_source_sha256=sources,
                )

    def test_inspector_ack_validator_requires_restoration_and_nonvacuous_bounded_proof(self):
        qa = self.qa
        sources = {key: "a" * 64 for key in qa.INSPECTOR_ACK_SOURCES}
        fields = [{"label": "Name", "disabled": False, "opacity": "1"}]
        payload = {
            "schema": qa.INSPECTOR_ACK_RESULT_SCHEMA, "scenario": "inspector-ack", "state": "passed", "failure": None,
            "public_url": "http://127.0.0.1:3242", "probe_url": "http://frontend:8080",
            "playwright_version": qa.PLAYWRIGHT_VERSION, "browser_gpu_mode": "swiftshader-webgl-requested",
            "source_sha256_before": sources, "source_sha256_after": sources,
            "session": {"name": "airbox_inspector_mixed", "session_id": "owned", "session_epoch": "owned@1",
                        "request_scope_epoch": "api:1"},
            "object_id": "box", "original_name": "mixed_p1_box_prism",
            "generated_name": "mixed_p1_box_prism_ui_ack_00000000-0000-4000-8000-000000000001",
            "baseline": {"fields": fields, "opacity_animations": 0, "scroll": 0},
            "pending": {"fields": fields, "opacity_animations": 0, "scroll": 90},
            "ack": {"fields": fields, "opacity_animations": 0, "scroll": 90},
            "node_preserved": True, "focus_preserved": True,
            "receipts": [{"phase": "commit", "status": 200, "revision": 5},
                         {"phase": "restore", "status": 200, "revision": 6}],
            "restoration": {"state": "restored", "name": "mixed_p1_box_prism", "revision": 6},
            "request_counts": {"PATCH /v2/sessions/current/model/objects/box": 2,
                               "GET /v2/sessions/current/model/scene": 3},
            "measured_requests": 5, "total_requests": 25, "request_limit": 128, "per_path_read_limit": 16,
            "errors": [], "violations": [], "proxy_failures": [],
        }

        payload["session_after"] = dict(payload["session"])

        def parse(value):
            return qa._parse_inspector_ack_result(json.dumps(value).encode(), payload["public_url"],
                                                  payload["probe_url"], sources)

        self.assertEqual(parse(payload), payload)
        cases = [
            ("foreign session", lambda value: value["session"].update(name="unrelated")),
            ("foreign command", lambda value: value["request_counts"].update({"POST /v2/sessions/current/simulation/commands": 1})),
            ("unknown restoration", lambda value: value["restoration"].update(state="unknown")),
            ("source drift", lambda value: value.update(source_sha256_after={**sources, "runner": "b" * 64})),
            ("focus lost", lambda value: value.update(focus_preserved=False)),
            ("scroll reset", lambda value: value["ack"].update(scroll=0)),
            ("disabled pending input", lambda value: value["pending"].update(fields=[{"label": "Name", "disabled": True, "opacity": "1"}])),
            ("duplicate object write", lambda value: value["request_counts"].update({"PATCH /v2/sessions/current/model/objects/box": 3})),
            ("non-ACK", lambda value: value["receipts"][0].update(status=409)),
            ("reused revision", lambda value: value["receipts"][1].update(revision=5)),
            ("vacuous fields", lambda value: value["baseline"].update(fields=[])),
        ]
        for reason, change in cases:
            with self.subTest(reason=reason), self.assertRaises(qa.BuildControlError):
                altered = deepcopy(payload)
                change(altered)
                parse(altered)

    def test_inspector_ack_cleanup_refuses_foreign_session_or_concurrent_name(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node is required for the existing browser harness pure cleanup contract")
        source = (ROOT / "apps/control-room/scripts/check-inspector-ack-browser.mjs").as_uri()
        javascript = """
import assert from 'node:assert/strict';
const { inspectorAckSession, inspectorAckRestoreDecision } = await import(process.argv[1]);
const status = {
 session: { name: 'airbox_inspector_mixed', session_id: 'owned', session_epoch: 'owned@1', request_scope_epoch: 'api:1' },
 solver: { state: 'awaiting_command' },
 lifecycle: { commandability: 'allowed', connectivity: 'connected', session_resource: 'active' },
};
const session = inspectorAckSession(status);
for (const changed of [
 {...status, session: {...status.session, name:'foreign'}},
 {...status, solver: {state:'running'}},
 {...status, solver: {state:'waiting'}},
]) assert.throws(() => inspectorAckSession(changed));
const options = {
 expectedSession: session, actualSession: session, objectId: 'box', originalName: 'original',
 generatedName: 'unique-attempt-name', scene: {revision: 8, objects:[{id:'box', name:'unique-attempt-name', notes:'concurrent note'}]},
};
assert.deepEqual(inspectorAckRestoreDecision(options), {state:'restore', patch:{name:'original', base_revision:8}});
assert.equal(inspectorAckRestoreDecision({...options, actualSession:{...session, request_scope_epoch:'new'}}).state,'unknown');
assert.equal(inspectorAckRestoreDecision({...options, scene:{revision:9,objects:[{id:'box',name:'third-party'}]}}).state,'conflict');
assert.equal(inspectorAckRestoreDecision({...options, scene:{revision:9,objects:[{id:'box',name:'original'}]}}).state,'original');
assert.throws(() => inspectorAckRestoreDecision({...options, scene:{revision:9,objects:[]}}));
"""
        result = subprocess.run([node, "--input-type=module", "-e", javascript, source],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_airbox_inspector_compose_is_opt_in_and_uses_the_managed_readonly_runner(self):
        identity = {
            "project_name": "fullmag-worktree-fixture",
            "network_name": "fullmag-worktree-fixture_fullmag",
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        standard = self.qa._compose_document(
            ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3269, 180,
        )
        self.assertNotIn("CONTROL_ROOM_BROWSER_QA_SCENARIO", standard["services"]["browser-qa"]["environment"])
        self.assertEqual(standard["services"]["browser-qa"]["command"][-1],
                         "/state/development/workspace/apps/control-room/scripts/docker-dev-browser-qa.mjs")

        inspector = self.qa._compose_document(
            ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3269, 180,
            airbox_inspector=True,
        )
        service = inspector["services"]["browser-qa"]
        self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_SCENARIO"], "airbox-inspector")
        self.assertEqual(service["command"], [
            "node",
            "/state/development/workspace/apps/control-room/scripts/verify-airbox-inspector.mjs",
        ])
        self.assertTrue(service["read_only"])
        self.assertNotIn("ports", service)
        self.assertTrue(all(mount["read_only"] for mount in service["volumes"]))
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._compose_document(
                ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3269, 180,
                canvas_only=False,
                airbox_inspector=True,
            )

        class FakeControl:
            project = identity["project_name"]

        browser_id = "sha256:" + "c" * 64
        inspect_document = {
            "Id": browser_id,
            "Image": browser_id,
            "Config": {
                "User": "65532:65532",
                "Cmd": service["command"],
                "Env": [f"{key}={value}" for key, value in service["environment"].items()],
                "Labels": {
                    **self.qa.source_labels(identity),
                    "com.docker.compose.project": identity["project_name"],
                    "com.docker.compose.service": "browser-qa",
                },
            },
            "HostConfig": {
                "GroupAdd": self.qa._script_bind_groups(ROOT),
                "ReadonlyRootfs": True,
                "NetworkMode": identity["network_name"],
                "PortBindings": None,
                "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=256m"},
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "ExtraHosts": None,
            },
            "State": {"Running": False, "ExitCode": 0},
            "NetworkSettings": {
                "Networks": {identity["network_name"]: {}},
                "Ports": {},
            },
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": "fullmag-frontend-state",
                    "Destination": "/state/development",
                    "RW": False,
                },
                {
                    "Type": "bind",
                    "Source": str(ROOT / "apps/control-room/scripts"),
                    "Destination": "/state/development/workspace/apps/control-room/scripts",
                    "RW": False,
                },
            ],
        }
        self.qa._validate_browser_helper(
            inspect_document, FakeControl(), identity, "fullmag-frontend-state",
            browser_id, 0, ROOT, airbox_inspector=True,
        )
        wrong_command = deepcopy(inspect_document)
        wrong_command["Config"]["Cmd"][-1] = "/state/development/workspace/apps/control-room/scripts/docker-dev-browser-qa.mjs"
        with self.assertRaises(self.qa.ControlOutcomeUnknown):
            self.qa._validate_browser_helper(
                wrong_command, FakeControl(), identity, "fullmag-frontend-state",
                browser_id, 0, ROOT, airbox_inspector=True,
            )

    def test_saved_playback_compose_and_helper_are_opt_in_and_read_only(self):
        identity = {
            "project_name": "fullmag-worktree-fixture",
            "network_name": "fullmag-worktree-fixture_fullmag",
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        item_id = "12345678901234567890"
        script_sha256 = "a" * 64
        document = self.qa._compose_document(
            ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3298, 180,
            saved_playback_item_id=item_id,
            source_script_sha256=script_sha256,
        )
        service = document["services"]["browser-qa"]
        self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_SCENARIO"], "saved-playback")
        self.assertEqual(
            service["environment"]["CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_SCRIPT_SHA256"],
            script_sha256,
        )
        self.assertEqual(service["command"], [
            "node",
            "/state/development/workspace/apps/control-room/scripts/check-saved-playback-browser.mjs",
            "http://frontend:8080",
            item_id,
        ])
        self.assertTrue(service["read_only"])
        self.assertNotIn("ports", service)
        self.assertTrue(all(mount["read_only"] for mount in service["volumes"]))
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._compose_document(
                ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3298, 180,
                canvas_only=False,
                saved_playback_item_id=item_id,
                source_script_sha256=script_sha256,
            )
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._compose_document(
                ROOT, identity, self.qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3298, 180,
                airbox_inspector=True,
                saved_playback_item_id=item_id,
                source_script_sha256=script_sha256,
            )

        class FakeControl:
            project = identity["project_name"]

        browser_id = "sha256:" + "c" * 64
        inspect_document = {
            "Id": browser_id,
            "Image": browser_id,
            "Config": {
                "User": "65532:65532",
                "Cmd": service["command"],
                "Env": [f"{key}={value}" for key, value in service["environment"].items()],
                "Labels": {
                    **self.qa.source_labels(identity),
                    "com.docker.compose.project": identity["project_name"],
                    "com.docker.compose.service": "browser-qa",
                },
            },
            "HostConfig": {
                "GroupAdd": self.qa._script_bind_groups(ROOT),
                "ReadonlyRootfs": True,
                "NetworkMode": identity["network_name"],
                "PortBindings": None,
                "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=256m"},
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "ExtraHosts": None,
            },
            "State": {"Running": False, "ExitCode": 0},
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}, "Ports": {}},
            "Mounts": [
                {"Type": "volume", "Name": "fullmag-frontend-state",
                 "Destination": "/state/development", "RW": False},
                {"Type": "bind", "Source": str(ROOT / "apps/control-room/scripts"),
                 "Destination": "/state/development/workspace/apps/control-room/scripts", "RW": False},
            ],
        }
        self.qa._validate_browser_helper(
            inspect_document, FakeControl(), identity, "fullmag-frontend-state",
            browser_id, 0, ROOT,
            canvas_only=None,
            expect_ambiguous_compute_fields=None,
            saved_playback_item_id=item_id,
            source_script_sha256=script_sha256,
        )
        wrong_script_pin = deepcopy(inspect_document)
        wrong_script_pin["Config"]["Env"] = [
            value.replace(script_sha256, "b" * 64)
            for value in wrong_script_pin["Config"]["Env"]
        ]
        with self.assertRaises(self.qa.ControlOutcomeUnknown):
            self.qa._validate_browser_helper(
                wrong_script_pin, FakeControl(), identity, "fullmag-frontend-state",
                browser_id, 0, ROOT, saved_playback_item_id=item_id,
                source_script_sha256=script_sha256,
            )

    def test_saved_playback_result_parser_checks_frame_and_render_evidence(self):
        public_url = "http://127.0.0.1:3298"
        browser_url = "http://frontend:8080"
        item_id = "73"
        script_sha256 = "a" * 64
        screenshot = (
            b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR"
            + (32).to_bytes(4, "big") + (24).to_bytes(4, "big")
        )
        payload = {
            "schema": self.qa.SAVED_PLAYBACK_RESULT_SCHEMA,
            "state": "passed",
            "scenario": "saved-playback",
            "item_id": item_id,
            "public_url": public_url,
            "probe_url": browser_url,
            "playwright_version": self.qa.PLAYWRIGHT_VERSION,
            "browser_gpu_mode": "swiftshader-webgl-requested",
            "script_sha256": script_sha256,
            "frame_indices": [0, 400, 800],
            "frame_sha256": ["b" * 64, "c" * 64, "d" * 64],
            "canvas_visible": True,
            "context_lost": False,
            "drawing_buffer": [1440, 900],
            "field_payloads_verified": True,
            "changed_canvas": True,
            "inspector_stable": True,
            "camera_stable": True,
            "hook_errors": [],
            "errors": [],
            "screenshot_base64": base64.b64encode(screenshot).decode("ascii"),
        }
        encoded = lambda value: (json.dumps(value) + "\n").encode("utf-8")
        parsed = self.qa._parse_saved_playback_result(
            encoded(payload), public_url, browser_url, item_id, script_sha256,
        )
        self.assertEqual(parsed["frame_sha256"], payload["frame_sha256"])
        fem = {**payload, "geometry_kind": "fem", "frame_count": 3, "frame_indices": [0, 1, 2]}
        self.assertEqual(self.qa._parse_saved_playback_result(
            encoded(fem), public_url, browser_url, item_id, script_sha256,
        )["frame_indices"], [0, 1, 2])
        for change in ({"frame_count": True}, {"frame_count": 2}, {"frame_count": 100001},
                       {"frame_indices": [0, 0, 2]}, {"geometry_kind": "unknown"}):
            with self.assertRaises(self.qa.BuildControlError):
                self.qa._parse_saved_playback_result(
                    encoded({**fem, **change}), public_url, browser_url, item_id, script_sha256,
                )


        for key, value in (
            ("item_id", "74"),
            ("frame_indices", [0, 399, 800]),
            ("field_payloads_verified", False),
            ("changed_canvas", False),
            ("camera_stable", False),
            ("hook_errors", ["unexpected fetch"]),
            ("frame_sha256", ["invalid", "c" * 64, "d" * 64]),
            ("screenshot_base64", base64.b64encode(b"not a PNG").decode("ascii")),
            ("screenshot_base64", base64.b64encode(screenshot + b"x" * self.qa.MAX_CANVAS_SCREENSHOT_BYTES).decode("ascii")),
        ):
            invalid = deepcopy(payload)
            invalid[key] = value
            with self.subTest(key=key), self.assertRaises(self.qa.BuildControlError):
                self.qa._parse_saved_playback_result(
                    encoded(invalid), public_url, browser_url, item_id, script_sha256,
                )

    def test_airbox_inspector_result_parser_requires_specific_routes_and_nonvacuous_quality_control(self):
        payload, public_url, browser_url, script_sha256 = _airbox_inspector_result_fixture(self.qa)
        encoded = lambda value: (json.dumps(value) + "\n").encode("utf-8")
        parsed = self.qa._parse_airbox_inspector_result(
            encoded(payload), public_url, browser_url, script_sha256,
        )
        self.assertEqual(parsed["inspector_proof"]["synthetic_quality_fault_injection"]["evidence_kind"],
                         "fault-injected-ui-only-not-scientific")

        cancelled_path = "/v2/sessions/current/diagnostics/cpu"
        startup_cancelled = deepcopy(payload)
        startup_cancelled["startup_request_events"] = [
            {
                "request_id": 1,
                "method": "GET",
                "path": cancelled_path,
                "resource_type": "fetch",
                "same_origin": True,
                "started_phase": "workspace-navigation",
                "started_elapsed_ms": 2600,
                "outcome": "request-failed",
                "response_status": None,
                "finished": False,
                "finished_elapsed_ms": None,
                "error": "net::ERR_ABORTED",
                "failure_phase": "workspace-navigation",
                "failure_elapsed_ms": 3000,
                "failure_message": "GET " + cancelled_path + ": net::ERR_ABORTED",
            },
            {
                "request_id": 2,
                "method": "GET",
                "path": cancelled_path,
                "resource_type": "fetch",
                "same_origin": True,
                "started_phase": "quality-state-probes",
                "started_elapsed_ms": 3900,
                "outcome": "finished",
                "response_status": 200,
                "finished": True,
                "finished_elapsed_ms": 4200,
                "error": None,
                "failure_phase": None,
                "failure_elapsed_ms": None,
                "failure_message": None,
            },
        ]
        startup_cancelled["startup_unmount_cancellation_probes"] = [{
            "classification": "startup-unmount-cancellation-followed-by-read-probe",
            "cancelled_request_id": 1,
            "probe_request_id": 2,
            "method": "GET",
            "path": cancelled_path,
            "cancellation_error": "net::ERR_ABORTED",
            "cancellation_phase": "workspace-navigation",
            "cancellation_started_elapsed_ms": 2600,
            "cancellation_failed_elapsed_ms": 3000,
            "probe_started_elapsed_ms": 3900,
            "probe_finished_elapsed_ms": 4200,
            "probe_response_status": 200,
            "probe_body_bytes": 128,
            "probe_resource_type": "fetch",
            "workspace_ready": True,
            "home_overlay_visible": False,
        }]
        self.qa._parse_airbox_inspector_result(
            encoded(startup_cancelled), public_url, browser_url, script_sha256,
        )

        missing_followup = deepcopy(startup_cancelled)
        missing_followup["startup_unmount_cancellation_probes"] = []
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(missing_followup), public_url, browser_url, script_sha256,
            )

        followup_before_cancel = deepcopy(startup_cancelled)
        followup_before_cancel["startup_request_events"][1]["started_elapsed_ms"] = 2900
        followup_before_cancel["startup_unmount_cancellation_probes"][0]["probe_started_elapsed_ms"] = 2900
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(followup_before_cancel), public_url, browser_url, script_sha256,
            )

        acknowledged = deepcopy(payload)
        acknowledgement = {
            "method": "POST",
            "path": "/v2/sessions/current/visualization/client-acks",
            "outcome": "recorded", "response_status": 200,
            "payload": {"body_valid_json": True, "client_id_present": True,
                        "viewport_id_present": True, "status": "rendered",
                        "error_present": False, "revision": 7},
        }
        acknowledged["inspector_proof"]["visualization_client_acknowledgements"] = [acknowledgement]
        self.qa._parse_airbox_inspector_result(
            encoded(acknowledged), public_url, browser_url, script_sha256,
        )
        for invalid in (
            {**acknowledgement, "path": "/v2/sessions/current/simulation/commands"},
            {**acknowledgement, "outcome": "pending", "response_status": None},
            {**acknowledgement, "payload": {**acknowledgement["payload"], "status": "failed"}},
        ):
            acknowledged["inspector_proof"]["visualization_client_acknowledgements"] = [invalid]
            with self.assertRaises(self.qa.BuildControlError):
                self.qa._parse_airbox_inspector_result(
                    encoded(acknowledged), public_url, browser_url, script_sha256,
                )

        generic_header = deepcopy(payload)
        generic_header["inspector_proof"]["panels"][0]["header"] = "Inspector"
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(generic_header), public_url, browser_url, script_sha256,
            )

        stale_control = deepcopy(payload)
        stale_control["inspector_proof"]["synthetic_quality_fault_injection"]["synthetic_pass_control"]["revision"] += 1
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(stale_control), public_url, browser_url, script_sha256,
            )

        for field, invalid_value in (
            ("resource_error_observed", False),
            ("panel_resource_status", "stale"),
            ("panel_reason_reports_failed_load", False),
            ("cached_quality_withheld", False),
            ("refresh_error_visible_in_statistics", False),
        ):
            with self.subTest(field=field, invalid="false"):
                invalid_error_proof = deepcopy(payload)
                invalid_error_proof["inspector_proof"]["synthetic_quality_fault_injection"]["synthetic_error_get"][field] = invalid_value
                with self.assertRaises(self.qa.BuildControlError):
                    self.qa._parse_airbox_inspector_result(
                        encoded(invalid_error_proof), public_url, browser_url, script_sha256,
                    )
            with self.subTest(field=field, invalid="missing"):
                invalid_error_proof = deepcopy(payload)
                del invalid_error_proof["inspector_proof"]["synthetic_quality_fault_injection"]["synthetic_error_get"][field]
                with self.assertRaises(self.qa.BuildControlError):
                    self.qa._parse_airbox_inspector_result(
                        encoded(invalid_error_proof), public_url, browser_url, script_sha256,
                    )

        over_budget_error_get = deepcopy(payload)
        over_budget_error_get["inspector_proof"]["synthetic_quality_fault_injection"]["synthetic_error_get"]["requests"] = 7
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(over_budget_error_get), public_url, browser_url, script_sha256,
            )

        over_budget_http_errors = deepcopy(payload)
        over_budget_http_errors["synthetic_http_errors"] = [
            "503 GET /v2/sessions/current/meshing/meshes/universe/quality"
        ] * 7
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(over_budget_http_errors), public_url, browser_url, script_sha256,
            )

        over_budget_console_errors = deepcopy(payload)
        over_budget_console_errors["synthetic_console_errors"] = [
            "http://frontend:8080/v2/sessions/current/meshing/meshes/universe/quality: Failed to load resource: 503",
        ] * 7
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(over_budget_console_errors), public_url, browser_url, script_sha256,
            )

        scoped_console = deepcopy(payload)
        scoped_console["synthetic_console_errors"] = [
            "http://frontend:8080/v2/sessions/current/meshing/meshes/universe/quality: Failed to load resource: 503",
        ]
        parsed_scoped_console = self.qa._parse_airbox_inspector_result(
            encoded(scoped_console), public_url, browser_url, script_sha256,
        )
        self.assertEqual(parsed_scoped_console["synthetic_console_errors"], scoped_console["synthetic_console_errors"])

        unrelated_console = deepcopy(payload)
        unrelated_console["synthetic_console_errors"] = [
            "http://frontend:8080/v2/sessions/current/status: Failed to load resource: 503",
        ]
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_airbox_inspector_result(
                encoded(unrelated_console), public_url, browser_url, script_sha256,
            )

    def test_compose_fixture_keeps_owned_volume_readonly_to_matching_uid(self):
        identity = {
            "project_name": "fullmag-worktree-fixture",
            "network_name": "fullmag-worktree-fixture_fullmag",
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        image = "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:" + "a" * 64
        document = self.qa._compose_document(ROOT, identity, image, "fullmag-frontend-state", 32871, 180)
        service = document["services"]["browser-qa"]
        self.assertEqual(service["user"], "65532:65532")
        self.assertTrue(service["read_only"])
        self.assertEqual(service["environment"]["CONTROL_ROOM_URL"], "http://frontend:8080")
        self.assertEqual(service["environment"]["NVIDIA_VISIBLE_DEVICES"], "void")
        self.assertNotIn("extra_hosts", service)
        self.assertEqual(service["volumes"][0]["read_only"], True)
        self.assertEqual(service["volumes"][1]["read_only"], True)
        self.assertEqual(document["networks"]["fullmag"]["name"], identity["network_name"])

    def test_desktop_wsl_file_alias_requires_the_exact_selected_regular_file(self):
        qa = self.qa
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            expected = root / "fixture.py"
            expected.write_text("fixture")
            aliases = root / "aliases"
            local = aliases / "Ubuntu2" / ("a" * 64)
            local.parent.mkdir(parents=True)
            local.symlink_to(expected)
            wire = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/" + "a" * 64
            with patch.object(qa, "LOCAL_WSL_BIND_MOUNT_ROOT", aliases):
                self.assertTrue(qa._source_mount_matches_selected(wire, expected))
                foreign = root / "other.py"
                foreign.write_text("fixture")
                self.assertFalse(qa._source_mount_matches_selected(wire, foreign))
                self.assertFalse(qa._source_mount_matches_selected(wire, expected.parent))

    def test_runner_output_survives_failed_helper_identity_validation_without_parsing(self):
        qa = self.qa
        writes = []
        control = SimpleNamespace(project="fullmag-worktree-fixture",
                                  write=lambda path, value: writes.append((path, deepcopy(value))))
        operation = {"root": "browser-qa/attempts/" + "a" * 32,
                     "receipt": {"attempt": "a" * 32}, "daemon_pending": False}
        result = SimpleNamespace(returncode=1, stdout=b'{"possible_dispatch":true}', stderr=b'failure')
        with patch.object(qa, "_probe_public_loopback", return_value={"state": "passed"}), \
             patch.object(qa, "docker_capture", return_value=result) as daemon, \
             patch.object(qa, "_inspect", return_value={"Id": "b" * 64}), \
             patch.object(qa, "_validate_browser_helper", side_effect=qa.ControlOutcomeUnknown("mount mismatch")), \
             patch.object(qa, "_parse_study_stage_rerun_result") as parse:
            with self.assertRaises(qa.ControlOutcomeUnknown):
                qa._run(operation, control, {"services": {"browser-qa": {"command": ["node"]}}},
                        {"project_name": control.project}, ROOT, "frontend-volume", "sha256:" + "c" * 64,
                        "http://127.0.0.1:3242", "http://frontend:8080", 180)
        saved = [value for path, value in writes if path.endswith('/runner-output.json')]
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["stdout"], result.stdout.decode())
        self.assertEqual(saved[0]["exit_code"], 1)
        parse.assert_not_called()
        self.assertTrue(operation["daemon_pending"])
        self.assertEqual([call.args[0] for call in daemon.call_args_list], ["compose"])

    def test_browser_helper_inspect_enforces_uid_environment_and_mount_boundary(self):
        qa = self.qa
        identity = {
            "project_name": "fullmag-worktree-fixture",
            "network_name": "fullmag-worktree-fixture_fullmag",
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        class FakeControl:
            project = "fullmag-worktree-fixture"
            volume = "fullmag-control-fixture"

        browser_id = "sha256:" + "c" * 64
        document = {
            "Id": browser_id,
            "Image": browser_id,
            "Config": {
                "User": "65532:65532",
                "Env": [
                    "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
                    "CONTROL_ROOM_URL=http://frontend:8080",
                    "NVIDIA_VISIBLE_DEVICES=void",
                ],
                "Labels": {
                    "org.fullmag.source.project-id": "fullmag",
                    "org.fullmag.source.worktree-id": "fixture",
                    "org.fullmag.source.checkout-kind": "worktree",
                    "org.fullmag.compose.project": identity["project_name"],
                    "com.docker.compose.project": identity["project_name"],
                    "com.docker.compose.service": "browser-qa",
                },
            },
            "HostConfig": {
                "ReadonlyRootfs": True,
                "GroupAdd": qa._script_bind_groups(ROOT),
                "NetworkMode": identity["network_name"],
                "PortBindings": None,
                "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=256m"},
                "CapDrop": ["ALL"],
                "GroupAdd": qa._script_bind_groups(ROOT),
                "SecurityOpt": ["no-new-privileges:true"],
                "ExtraHosts": None,
            },
            "State": {"Running": False, "ExitCode": 0},
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}},
            "Mounts": [
                {"Type": "volume", "Name": "fullmag-frontend-state", "Destination": "/state/development", "RW": False},
                {
                    "Type": "bind",
                    "Source": str(ROOT / "apps/control-room/scripts"),
                    "Destination": "/state/development/workspace/apps/control-room/scripts",
                    "RW": False,
                },
            ],
        }
        qa._validate_browser_helper(document, FakeControl(), identity, "fullmag-frontend-state", browser_id, 0, ROOT)

        with tempfile.TemporaryDirectory() as temporary:
            local_alias_root = Path(temporary) / "docker-desktop-bind-mounts"
            selected_scripts = (ROOT / "apps/control-room/scripts").resolve(strict=True)
            valid_alias = local_alias_root / "Ubuntu2" / ("a" * 64)
            valid_alias.parent.mkdir(parents=True)
            valid_alias.symlink_to(selected_scripts, target_is_directory=True)
            alias_source = (
                "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"
                "Ubuntu2/" + "a" * 64
            )
            alias_document = deepcopy(document)
            alias_document["Mounts"][1]["Source"] = alias_source
            with patch.object(qa, "LOCAL_WSL_BIND_MOUNT_ROOT", local_alias_root):
                self.assertTrue(valid_alias.samefile(selected_scripts))
                qa._validate_browser_helper(
                    alias_document, FakeControl(), identity,
                    "fullmag-frontend-state", browser_id, 0, ROOT,
                )

                different_target = Path(temporary) / "different-selected-source"
                different_target.mkdir()
                different_alias = local_alias_root / "Ubuntu2" / ("b" * 64)
                different_alias.symlink_to(different_target, target_is_directory=True)
                rejected_sources = [
                    "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"
                    "Ubuntu2/" + "c" * 64,  # local alias is missing
                    "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"
                    "Ubuntu2/" + "b" * 64,  # local alias points to another inode
                    "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"
                    "Ubuntu2/../Ubuntu2/" + "a" * 64,
                    "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"
                    "Ubuntu2/" + "a" * 64 + "/extra",
                    "/run/desktop/mnt/host/windows/docker-desktop-bind-mounts/"
                    "Ubuntu2/" + "a" * 64,
                ]
                for source in rejected_sources:
                    rejected = deepcopy(document)
                    rejected["Mounts"][1]["Source"] = source
                    with self.subTest(source=source), self.assertRaises(
                        qa.ControlOutcomeUnknown
                    ):
                        qa._validate_browser_helper(
                            rejected, FakeControl(), identity,
                            "fullmag-frontend-state", browser_id, 0, ROOT,
                        )

        wrong_group = deepcopy(document)
        wrong_group["HostConfig"]["GroupAdd"] = ["123456789"]
        with self.assertRaisesRegex(qa.ControlOutcomeUnknown, "source read group differs"):
            qa._validate_browser_helper(wrong_group, FakeControl(), identity, "fullmag-frontend-state", browser_id, 0, ROOT)
        wrong_user = deepcopy(document)
        wrong_user["Config"]["User"] = "0:0"
        with self.assertRaises(qa.ControlOutcomeUnknown):
            qa._validate_browser_helper(wrong_user, FakeControl(), identity, "fullmag-frontend-state", browser_id, 0, ROOT)
        writable_mount = deepcopy(document)
        writable_mount["Mounts"][0]["RW"] = True
        with self.assertRaises(qa.ControlOutcomeUnknown):
            qa._validate_browser_helper(writable_mount, FakeControl(), identity, "fullmag-frontend-state", browser_id, 0, ROOT)
        wrong_read_group = deepcopy(document)
        wrong_read_group["HostConfig"]["GroupAdd"] = qa._script_bind_groups(ROOT) + ["99999999"]
        with self.assertRaises(qa.ControlOutcomeUnknown):
            qa._validate_browser_helper(wrong_read_group, FakeControl(), identity, "fullmag-frontend-state", browser_id, 0, ROOT)

    def test_frontend_image_uses_exact_per_service_compose_pin(self):
        qa = self.qa
        backend_image = "sha256:" + "a" * 64
        frontend_image = "sha256:" + "b" * 64
        identity = {
            "project_name": "fullmag-worktree-fixture", "project_id": "fullmag",
            "worktree_id": "fixture", "checkout_kind": "worktree",
            "source_root": str(ROOT), "network_name": "fullmag-worktree-fixture_fullmag",
        }
        compose = {"name": identity["project_name"], "services": {
            "backend": {"image": backend_image}, "frontend": {"image": frontend_image},
        }}
        current = {"attempt": "c" * 32, "inputs": {"image_id": backend_image}}
        document = {
            "Image": frontend_image, "State": {"Running": True},
            "Config": {"Labels": {
                **qa.source_labels(identity),
                "com.docker.compose.project": identity["project_name"],
                "com.docker.compose.service": "frontend",
            }},
            "HostConfig": {"NetworkMode": identity["network_name"],
                "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3202"}]}},
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}},
            "Mounts": [
                {"Type": "volume", "Name": "frontend-fixture", "Destination": "/state/development", "RW": True},
                {"Type": "volume", "Name": "control-fixture", "Destination": "/opt/fullmag/control", "RW": False},
            ],
        }
        reads = []
        class FakeControl:
            project = identity["project_name"]
            volume = "control-fixture"
            def read(self, path):
                reads.append(path)
                return deepcopy(compose)
        control = FakeControl()
        def check(observed, receipt):
            qa._validate_frontend(observed, control, identity, "frontend-fixture", receipt, 3202)
        for image in (backend_image, frontend_image):
            with self.subTest(valid_frontend_image=image):
                compose["services"]["frontend"]["image"] = image
                current["config_sha256"] = hashlib.sha256(qa.canonical(compose)).hexdigest()
                document["Image"] = image
                check(document, current)
        self.assertEqual(reads, ["development/attempts/" + "c" * 32 + "/compose.json"] * 2)
        base_compose = deepcopy(compose)
        for case in ("digest", "attempt", "project", "backend-image", "mutable-image", "observed-image", "missing-service"):
            with self.subTest(rejected=case):
                compose = deepcopy(base_compose)
                bad_current = deepcopy(current)
                bad_document = deepcopy(document)
                if case == "attempt": bad_current["attempt"] = "../other"
                elif case == "project": compose["name"] = "fullmag-other"
                elif case == "backend-image": compose["services"]["backend"]["image"] = frontend_image
                elif case == "mutable-image": compose["services"]["frontend"]["image"] = "fullmag:latest"
                elif case == "observed-image": bad_document["Image"] = backend_image
                elif case == "missing-service": del compose["services"]["frontend"]
                bad_current["config_sha256"] = hashlib.sha256(qa.canonical(compose)).hexdigest()
                if case == "digest": bad_current["config_sha256"] = "d" * 64
                with self.assertRaises(qa.BuildControlError):
                    check(bad_document, bad_current)

    def test_control_volume_preflight_is_read_only_and_fail_closed_when_absent(self):
        qa = self.qa
        from docker_build_control import BuildControl

        identity = {
            "project_name": "fullmag-worktree-control-fixture",
            "project_id": "fullmag-fixture",
            "worktree_id": "fixture",
        }
        with patch("docker_control_namespace.resolve_namespace", return_value=None):
            control = BuildControl(identity, "sha256:" + "d" * 64)

        missing = SimpleNamespace(returncode=1, stdout=b"", stderr=b"no such volume")
        with patch.object(qa, "docker_capture", return_value=missing) as daemon:
            with self.assertRaises(qa.BuildControlError):
                qa._validate_existing_control_volume(control)
        daemon.assert_called_once_with(
            "volume", "inspect", control.volume, allow_failure=True, timeout=60
        )


    def test_historical_root_source_label_requires_receipt_bound_current_namespace(self):
        qa = self.qa
        from docker_build_control import BuildControl
        from docker_control_namespace import REGISTRY_SCHEMA

        identity = {"project_name": "fullmag-worktree-control-fixture",
                    "project_id": "fullmag-fixture", "worktree_id": "current-fixture"}
        with patch("docker_control_namespace.resolve_namespace", return_value=None):
            control = BuildControl(identity, "sha256:" + "d" * 64)
        retirement = {"schema": "test-retirement", "data_preserved": True}
        token = "a" * 32
        registry = {"schema": REGISTRY_SCHEMA, "recovery_id": token,
                    "namespace": "namespaces/" + token,
                    "receipt_path": "namespace-recovery/" + token + "/terminal.json",
                    "compose_project": control.project, "control_volume": control.volume,
                    "source_project_id": identity["project_id"],
                    "source_worktree_id": identity["worktree_id"],
                    "receipt_sha256": hashlib.sha256(qa.canonical(retirement) + b"\n").hexdigest()}
        control.namespace = registry["namespace"]
        control.namespace_registry = {**registry, "retirement": retirement}
        control.namespace_registry_sha256 = hashlib.sha256(qa.canonical(registry)).hexdigest()
        volume = {"Name": control.volume, "Driver": "local", "Options": {},
                  "Mountpoint": "/var/lib/docker/volumes/" + control.volume + "/_data",
                  "Labels": {**control.labels, "org.fullmag.source.worktree-id": "historical-fixture"}}
        with patch.object(qa, "_inspect_existing_volume", return_value=volume):
            for ending in (b"", b"\n"):
                control.namespace_registry_sha256 = hashlib.sha256(qa.canonical(registry) + ending).hexdigest()
                self.assertIs(qa._validate_existing_control_volume(control), volume)
            original = deepcopy(control.namespace_registry)
            for key, value in (("source_worktree_id", "foreign"), ("source_project_id", "foreign"),
                               ("compose_project", "foreign"), ("control_volume", "foreign"),
                               ("retirement", {"data_preserved": False})):
                with self.subTest(binding=key):
                    control.namespace_registry = {**original, key: value}
                    with self.assertRaises(qa.BuildControlError):
                        qa._validate_existing_control_volume(control)
            control.namespace_registry = original
            for key, value in (("namespace", ""), ("namespace_registry", None),
                               ("namespace_registry_sha256", "invalid")):
                previous = getattr(control, key)
                setattr(control, key, value)
                with self.subTest(proof=key), self.assertRaises(qa.BuildControlError):
                    qa._validate_existing_control_volume(control)
                setattr(control, key, previous)
            for key, value in (("Driver", "nfs"), ("Options", {"device": "/foreign"})):
                previous = volume[key]
                volume[key] = value
                with self.subTest(backing=key), self.assertRaises(qa.BuildControlError):
                    qa._validate_existing_control_volume(control)
                volume[key] = previous
            volume["Labels"]["org.fullmag.build.role"] = "foreign"
            with self.assertRaises(qa.BuildControlError):
                qa._validate_existing_control_volume(control)

    def test_shared_cache_project_uses_the_renderer_root_fallback(self):
        project_root=str(ROOT.resolve())
        self.assertEqual(self.qa.cache_project_id_for_layout({"project_root":project_root}),
                         hashlib.sha256(project_root.encode()).hexdigest()[:16])

    def test_frontend_shared_pnpm_requires_project_identity_and_exact_mount(self):
        qa=self.qa
        import docker_shared_build_storage as shared
        identity={"project_id":"fullmag-fixture"}
        descriptor=shared.volume_descriptors(identity["project_id"])[shared.PNPM_ROLE]
        document={"Config":{"Env":["FULLMAG_SHARED_PNPM_STORE="+shared.SHARED_PNPM_TARGET]},
                  "HostConfig":{"Mounts":[{"Type":"volume","Source":descriptor["name"],"Target":shared.SHARED_PNPM_TARGET,"VolumeOptions":{"NoCopy":True,"Subpath":"store"}}]},
                  "Mounts":[{"Type":"volume","Name":descriptor["name"],
                             "Destination":shared.SHARED_PNPM_TARGET,"RW":True}]}
        volume={"Name":descriptor["name"],"Driver":"local","Options":{},
                "Mountpoint":"/var/lib/docker/volumes/"+descriptor["name"]+"/_data",
                "Labels":descriptor["labels"]}
        with patch.object(qa,"_inspect_existing_volume",return_value=volume):
            self.assertEqual(qa._validate_shared_frontend_pnpm(document,identity),{descriptor["name"]})
            with self.assertRaises(qa.BuildControlError):
                qa._validate_shared_frontend_pnpm(document,{"project_id":"foreign"})
            for field,value in (("Name","foreign"),("Destination","/foreign"),("RW",False)):
                changed=deepcopy(document);changed["Mounts"][0][field]=value
                with self.subTest(field=field),self.assertRaises(qa.BuildControlError):
                    qa._validate_shared_frontend_pnpm(changed,identity)
            for options in ({"NoCopy":True,"Subpath":"foreign"},{"NoCopy":False,"Subpath":"store"}):
                changed=deepcopy(document);changed["HostConfig"]["Mounts"][0]["VolumeOptions"]=options
                with self.assertRaises(qa.BuildControlError):
                    qa._validate_shared_frontend_pnpm(changed,identity)
            changed=deepcopy(document);changed["Mounts"].append(deepcopy(changed["Mounts"][0]))
            with self.assertRaises(qa.BuildControlError):
                qa._validate_shared_frontend_pnpm(changed,identity)
        for field,value in (("Labels",{}),("Labels",{**descriptor["labels"],"foreign":"owner"}),("Driver","foreign"),("Options",{"type":"nfs","device":"/foreign"})):
            changed=deepcopy(volume);changed[field]=value
            with patch.object(qa,"_inspect_existing_volume",return_value=changed),self.subTest(field=field),self.assertRaises(qa.BuildControlError):
                qa._validate_shared_frontend_pnpm(document,identity)
        self.assertEqual(qa._validate_shared_frontend_pnpm({"Config":{"Env":[]},"Mounts":[]},identity),set())

    def test_frontend_volume_preflight_requires_deterministic_owned_labels(self):
        qa = self.qa
        from docker_build_control import BuildControl
        from docker_development_inputs import metadata_cache_key

        identity = {
            "project_name": "fullmag-worktree-fixture",
            "project_id": "fullmag-fixture",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
        }
        with patch("docker_control_namespace.resolve_namespace", return_value=None):
            control = BuildControl(identity, "sha256:" + "d" * 64)
        inputs = {
            "schema": "fullmag.docker-development-inputs.v1",
            "dependency_seed_sha256": "a" * 64,
            "toolpins_sha256": "b" * 64,
            "files": [
                {"relative": "apps/control-room/next.config.mjs", "sha256": "c" * 64},
            ],
        }
        key = metadata_cache_key(inputs, control.project)
        volume_name = "fullmag-dev-frontend-v1-" + key[:24]

        labels = {
            **{key: value for key, value in control.labels.items() if key.startswith("org.fullmag.")},
            "org.fullmag.build.role": "frontend",
            "org.fullmag.build.cache-key": key,
        }
        observed = {"Name": volume_name, "Driver": "local", "Options": {}, "Labels": labels}
        with patch.object(
            qa,
            "docker_capture",
            return_value=SimpleNamespace(returncode=0, stdout=json.dumps([observed]).encode(), stderr=b""),
        ):
            qa._validate_frontend_volume(control, volume_name, inputs)
        drifted = deepcopy(observed)
        drifted["Labels"]["org.fullmag.build.cache-key"] = "c" * 64
        with patch.object(
            qa,
            "docker_capture",
            return_value=SimpleNamespace(returncode=0, stdout=json.dumps([drifted]).encode(), stderr=b""),
        ):
            with self.assertRaises(qa.BuildControlError):
                qa._validate_frontend_volume(control, volume_name, inputs)

    def _private_group_fixture(self):
        qa = self.qa
        from docker_build_control import BuildControl
        import docker_backend_volume_cache as backend_cache
        import docker_group_ledger as group_ledger
        import docker_group_storage as group_storage

        identity = {
            "project_name": "fullmag-worktree-private-group",
            "project_id": "fullmag-fixture",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT.resolve()),
            "network_name": "fullmag-worktree-private-group_fullmag",
        }
        with patch("docker_control_namespace.resolve_namespace", return_value=None):
            control = BuildControl(identity, "sha256:" + "d" * 64)
        backend_image = "sha256:" + "a" * 64
        frontend_image = "sha256:" + "b" * 64
        ledger_subpath = group_storage.role_subpath(control, "ledger")
        ledger = group_ledger.profile(
            "e" * 64, control.project, control.volume, backend_image,
            ledger_subpath=ledger_subpath,
        )
        frontend_mount = group_storage.compose_mount_descriptor(
            control, "frontend", "/state/development", compose_name="frontend-build",
        )
        frontend_control_mount = {
            "type": "volume",
            "source": "build-control",
            "target": "/opt/fullmag/control",
            "read_only": True,
            "volume": {"nocopy": True, "subpath": control.subpath("frontend")},
        }
        backend_mount = group_storage.compose_mount_descriptor(
            control, "backend", backend_cache.BUILD_TARGET,
            compose_name=backend_cache.COMPOSE_BUILD_VOLUME,
        )
        compose = {
            "name": control.project,
            "services": {
                "backend": {
                    "image": backend_image,
                    "environment": dict(ledger["environment"]),
                    "volumes": [backend_mount, *ledger["backend"]["volumes"]],
                },
                "frontend": {
                    "image": frontend_image,
                    "environment": {
                        "FULLMAG_PRIVATE_GROUP_STORAGE": "group-volume-v1",
                        "FULLMAG_DEVELOPMENT_INPUTS_PATH": "/opt/fullmag/control/development-inputs.json",
                    },
                    "volumes": [frontend_mount, frontend_control_mount],
                },
            },
            "volumes": {
                "frontend-build": {"name": control.volume, "external": True},
                "build-control": {"name": control.volume, "external": True},
                backend_cache.COMPOSE_BUILD_VOLUME: {"name": control.volume, "external": True},
                group_ledger.COMPOSE_VOLUME: {"name": control.volume, "external": True},
            },
        }
        attempt = "c" * 32
        current = {
            "attempt": attempt,
            "private_group_storage": "group-volume-v1",
            "config_sha256": hashlib.sha256(qa.canonical(compose)).hexdigest(),
            "inputs": {"image_id": backend_image},
        }
        frontend_inputs = {
            "schema": "fullmag.docker-development-inputs.v1",
            "dependency_seed_sha256": "1" * 64,
            "toolpins_sha256": "2" * 64,
            "source_root": str(ROOT.resolve()),
            "worktree_id": identity["worktree_id"],
            "host_port": 3202,
        }
        marker = group_storage.owner_manifest(control, ROOT)
        volume = {
            "Name": control.volume,
            "Driver": "local",
            "Options": {},
            "Labels": control.shared_labels,
            "Mountpoint": "/var/lib/docker/volumes/" + control.volume + "/_data",
        }
        return {
            "qa": qa,
            "control": control,
            "identity": identity,
            "compose": compose,
            "current": current,
            "frontend_inputs": frontend_inputs,
            "frontend_volume": control.volume,
            "frontend_image": frontend_image,
            "backend_image": backend_image,
            "marker": marker,
            "volume": volume,
            "mountpoint": volume["Mountpoint"],
        }

    def test_group_volume_profile_is_pinned_and_frontend_mounts_only_role_subpaths(self):
        case = self._private_group_fixture()
        qa, control, identity = case["qa"], case["control"], case["identity"]
        from docker_group_storage import role_subpath

        def read(path, *, optional=False):
            if path == "private/.owner.json":
                return deepcopy(case["marker"])
            if path == f"development/attempts/{case['current']['attempt']}/compose.json":
                return deepcopy(case["compose"])
            raise AssertionError("unexpected control read: " + path)

        with patch.object(control, "read", side_effect=read), \
             patch.object(qa, "_inspect_existing_volume", return_value=case["volume"]):
            qa._validate_frontend_volume(
                control, case["frontend_volume"], case["frontend_inputs"], case["current"],
            )

        state = role_subpath(control, "frontend")
        control_subpath = control.subpath("frontend")
        mountpoint = case["mountpoint"]
        frontend = {
            "Image": case["frontend_image"],
            "State": {"Running": True},
            "Config": {"Labels": {
                **qa.source_labels(identity),
                "com.docker.compose.project": control.project,
                "com.docker.compose.service": "frontend",
            }},
            "HostConfig": {
                "NetworkMode": identity["network_name"],
                "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3202"}]},
                "Mounts": [
                    {"Type": "volume", "Source": control.volume, "Target": "/state/development",
                     "VolumeOptions": {"NoCopy": True, "Subpath": state}},
                    {"Type": "volume", "Source": control.volume, "Target": "/opt/fullmag/control",
                     "ReadOnly": True, "VolumeOptions": {"NoCopy": True, "Subpath": control_subpath}},
                ],
            },
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}},
            "Mounts": [
                {"Type": "volume", "Name": control.volume, "Destination": "/state/development",
                 "RW": True, "Driver": "local", "Source": mountpoint},
                {"Type": "volume", "Name": control.volume, "Destination": "/opt/fullmag/control",
                 "RW": False, "Driver": "local", "Source": mountpoint},
            ],
        }
        with patch.object(control, "read", side_effect=read), \
             patch.object(qa, "_inspect_existing_volume", return_value=case["volume"]):
            qa._validate_frontend(
                frontend, control, identity, case["frontend_volume"], case["current"], 3202,
                cache_project_id=None,
            )

        document = qa._compose_document(
            ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, control.volume, 3202, 180,
            control=control, private_group_storage=True,
        )
        helper = document["services"]["browser-qa"]
        self.assertEqual(document["volumes"]["frontend-state"], {
            "name": control.volume, "external": True,
        })
        self.assertEqual(helper["volumes"][0]["volume"], {"nocopy": True, "subpath": state})
        self.assertEqual(helper["volumes"][0]["target"], "/state/development")
        self.assertEqual(
            {mount["target"] for mount in helper["volumes"]},
            {"/state/development", "/state/development/workspace/apps/control-room/scripts"},
        )
        self.assertNotIn("/opt/fullmag/control", {mount["target"] for mount in helper["volumes"]})

    def test_group_volume_frontend_validator_rejects_profile_mount_and_exposure_drift(self):
        case = self._private_group_fixture()
        qa, control, identity = case["qa"], case["control"], case["identity"]
        attempt = case["current"]["attempt"]
        compose = case["compose"]
        current = case["current"]
        state_subpath = "private/frontend"
        control_subpath = "frontend"
        mountpoint = case["mountpoint"]
        document = {
            "Image": case["frontend_image"],
            "State": {"Running": True},
            "Config": {"Labels": {
                **qa.source_labels(identity),
                "com.docker.compose.project": control.project,
                "com.docker.compose.service": "frontend",
            }},
            "HostConfig": {
                "NetworkMode": identity["network_name"],
                "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3202"}]},
                "Mounts": [
                    {"Type": "volume", "Source": control.volume, "Target": "/state/development",
                     "VolumeOptions": {"NoCopy": True, "Subpath": state_subpath}},
                    {"Type": "volume", "Source": control.volume, "Target": "/opt/fullmag/control",
                     "ReadOnly": True, "VolumeOptions": {"NoCopy": True, "Subpath": control_subpath}},
                ],
            },
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}},
            "Mounts": [
                {"Type": "volume", "Name": control.volume, "Destination": "/state/development",
                 "RW": True, "Driver": "local", "Source": mountpoint},
                {"Type": "volume", "Name": control.volume, "Destination": "/opt/fullmag/control",
                 "RW": False, "Driver": "local", "Source": mountpoint},
            ],
        }

        def validate(actual=document, retained=compose, receipt=current):
            pinned = {**receipt, "config_sha256": hashlib.sha256(qa.canonical(retained)).hexdigest()}
            with patch.object(control, "read", side_effect=lambda path, **kwargs: deepcopy(retained)), \
                 patch.object(qa, "_inspect_existing_volume", return_value=case["volume"]):
                return qa._validate_frontend(actual, control, identity, control.volume, pinned, 3202)

        validate()
        mismatch = deepcopy(current)
        mismatch["private_group_storage"] = "group-volume-v2"
        with self.assertRaises(qa.BuildControlError):
            validate(receipt=mismatch)
        for kind in ("wrong-volume", "wrong-subpath", "missing-hostconfig", "extra-mount", "root-exposure"):
            with self.subTest(rejected=kind):
                bad = deepcopy(document)
                if kind == "wrong-volume":
                    bad["HostConfig"]["Mounts"][0]["Source"] = "fullmag-foreign-volume"
                    bad["Mounts"][0]["Name"] = "fullmag-foreign-volume"
                elif kind == "wrong-subpath":
                    bad["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = "private/backend"
                elif kind == "missing-hostconfig":
                    del bad["HostConfig"]["Mounts"]
                elif kind == "extra-mount":
                    bad["HostConfig"]["Mounts"].append({
                        "Type": "volume", "Source": control.volume, "Target": "/backend",
                        "ReadOnly": True, "VolumeOptions": {"NoCopy": True, "Subpath": "private/backend"},
                    })
                    bad["Mounts"].append({
                        "Type": "volume", "Name": control.volume, "Destination": "/backend",
                        "RW": False, "Driver": "local", "Source": mountpoint + "/private/backend",
                    })
                else:
                    bad["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = ""
                    bad["Mounts"][0]["Source"] = mountpoint
                with self.assertRaises(qa.BuildControlError):
                    validate(actual=bad)

    def test_private_group_browser_helper_mounts_are_subpath_scoped_and_legacy_stays_supported(self):
        case = self._private_group_fixture()
        qa, control, identity = case["qa"], case["control"], case["identity"]
        document = qa._compose_document(
            ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, control.volume, 3202, 180,
            control=control, private_group_storage=True,
        )
        service = document["services"]["browser-qa"]
        browser_id = "sha256:" + "c" * 64
        state = service["volumes"][0]
        mountpoint = case["mountpoint"]
        actual = {
            "Id": browser_id,
            "Image": browser_id,
            "Config": {
                "User": "65532:65532",
                "Cmd": service["command"],
                "Env": [f"{key}={value}" for key, value in service["environment"].items()],
                "Labels": {
                    **qa.source_labels(identity),
                    "com.docker.compose.project": control.project,
                    "com.docker.compose.service": "browser-qa",
                },
            },
            "HostConfig": {
                "GroupAdd": qa._script_bind_groups(ROOT),
                "ReadonlyRootfs": True,
                "NetworkMode": identity["network_name"],
                "PortBindings": None,
                "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=256m"},
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "ExtraHosts": None,
                "Mounts": [
                    {"Type": "volume", "Source": control.volume, "Target": "/state/development",
                     "ReadOnly": True, "VolumeOptions": {"NoCopy": True, "Subpath": "private/frontend"}},
                    {"Type": "bind", "Source": str(ROOT / "apps/control-room/scripts"),
                     "Target": "/state/development/workspace/apps/control-room/scripts", "ReadOnly": True},
                ],
            },
            "State": {"Running": False, "ExitCode": 0},
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}, "Ports": {}},
            "Mounts": [
                {"Type": "volume", "Name": control.volume, "Destination": "/state/development",
                 "RW": False, "Driver": "local", "Source": mountpoint},
                {"Type": "bind", "Source": str(ROOT / "apps/control-room/scripts"),
                 "Destination": "/state/development/workspace/apps/control-room/scripts", "RW": False},
            ],
        }
        with patch.object(qa, "_inspect_existing_volume", return_value=case["volume"]):
            qa._validate_browser_helper(
                actual, control, identity, control.volume, browser_id, 0, ROOT,
                private_group_storage=True,
            )
            missing = deepcopy(actual)
            del missing["HostConfig"]["Mounts"]
            with self.assertRaises(qa.ControlOutcomeUnknown):
                qa._validate_browser_helper(
                    missing, control, identity, control.volume, browser_id, 0, ROOT,
                    private_group_storage=True,
                )
            root_mount = deepcopy(actual)
            root_mount["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = ""
            root_mount["Mounts"][0]["Source"] = mountpoint
            with self.assertRaises(qa.ControlOutcomeUnknown):
                qa._validate_browser_helper(
                    root_mount, control, identity, control.volume, browser_id, 0, ROOT,
                    private_group_storage=True,
                )
            extra = deepcopy(actual)
            extra["HostConfig"]["Mounts"].append({
                "Type": "volume", "Source": control.volume, "Target": "/backend",
                "ReadOnly": True, "VolumeOptions": {"NoCopy": True, "Subpath": "private/backend"},
            })
            extra["Mounts"].append({
                "Type": "volume", "Name": control.volume, "Destination": "/backend",
                "RW": False, "Driver": "local", "Source": mountpoint + "/private/backend",
            })
            with self.assertRaises(qa.ControlOutcomeUnknown):
                qa._validate_browser_helper(
                    extra, control, identity, control.volume, browser_id, 0, ROOT,
                    private_group_storage=True,
                )

        legacy = qa._compose_document(
            ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, "fullmag-dev-frontend-v1-legacy", 3202, 180,
        )
        self.assertEqual(legacy["volumes"]["frontend-state"]["name"], "fullmag-dev-frontend-v1-legacy")
        self.assertEqual(legacy["services"]["browser-qa"]["volumes"][0]["volume"], {"nocopy": True})

    def test_browser_image_reuses_compatible_local_digest_without_pull(self):
        qa = self.qa
        image = qa.DEFAULT_BROWSER_IMAGE
        operation = {"root": "browser-qa/attempts/" + "c" * 32,
                     "receipt": {"attempt": "c" * 32}, "daemon_pending": False}
        writes = []

        class FakeControl:
            project = "fullmag-worktree-fixture"

            def write(self, path, value):
                writes.append((path, deepcopy(value)))

        image_document = {
            "Id": "sha256:" + "d" * 64,
            "RepoDigests": [qa._canonical_repo_digest(image)],
        }
        with patch.object(qa, "_inspect_image", return_value=image_document) as inspect, \
             patch.object(qa, "docker_capture") as daemon:
            image_id, observed = qa._ensure_browser_image(
                operation, FakeControl(), {"services": {"browser-qa": {"pull_policy": "never"}}}, image, 180,
            )

        inspect.assert_called_once_with(image)
        daemon.assert_not_called()
        self.assertIs(observed, image_document)
        self.assertEqual(image_id, image_document["Id"])
        self.assertEqual(operation["receipt"]["browser_image_source"], "local-reuse")
        self.assertEqual(operation["receipt"]["browser_image_pull_state"], "reused")
        self.assertEqual(operation["receipt"]["browser_image_pull_timeout"], 180)
        self.assertTrue(any(path.endswith("/browser-image-pull.json") for path, _value in writes))

    def test_browser_image_absent_uses_same_group_compose_pull_and_inspects_pin(self):
        qa = self.qa
        image = qa.DEFAULT_BROWSER_IMAGE
        operation = {"root": "browser-qa/attempts/" + "e" * 32,
                     "receipt": {"attempt": "e" * 32}, "daemon_pending": False}
        writes = []
        daemon_calls = []
        image_document = {
            "Id": "sha256:" + "f" * 64,
            "RepoDigests": [qa._canonical_repo_digest(image)],
        }
        preflight = {"available_bytes": 40 * 1024**3,
                     "minimum_free_bytes": qa.MIN_FREE_BUILD_BYTES}

        class FakeControl:
            project = "fullmag-worktree-fixture"

            def space(self):
                return preflight

            def write(self, path, value):
                writes.append((path, deepcopy(value)))

        def fake_daemon(*args, **kwargs):
            daemon_calls.append((args, kwargs))
            return SimpleNamespace(returncode=0, stdout=b"pulled", stderr=b"")

        with patch.object(qa, "_inspect_image", side_effect=[None, image_document]), \
             patch.object(qa, "docker_capture", side_effect=fake_daemon):
            image_id, observed = qa._ensure_browser_image(
                operation,
                FakeControl(),
                {"services": {"browser-qa": {"pull_policy": "never"}}},
                image,
                180,
            )

        self.assertEqual(image_id, image_document["Id"])
        self.assertIs(observed, image_document)
        self.assertFalse(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["browser_image_source"], "compose-pull")
        self.assertEqual(operation["receipt"]["browser_image_pull_state"], "succeeded")
        self.assertEqual(operation["receipt"]["browser_image_pull_timeout"], 180)
        self.assertEqual(daemon_calls[0][0][:9], ("compose", "--project-name", "fullmag-worktree-fixture", "--ansi", "never", "-f", "-", "pull", "browser-qa"))
        pull_manifest = json.loads(daemon_calls[0][1]["data"])
        self.assertEqual(pull_manifest["services"]["browser-qa"]["pull_policy"], "missing")
        self.assertTrue(any(path.endswith("/receipt.json") and value.get("browser_image_id") == image_document["Id"] for path, value in writes))

    def test_browser_image_pull_timeout_retains_daemon_pending_and_receipt(self):
        qa = self.qa
        image = qa.DEFAULT_BROWSER_IMAGE
        operation = {"root": "browser-qa/attempts/" + "1" * 32,
                     "receipt": {"attempt": "1" * 32}, "daemon_pending": False}
        writes = []
        preflight = {"available_bytes": 40 * 1024**3,
                     "minimum_free_bytes": qa.MIN_FREE_BUILD_BYTES}

        class FakeControl:
            project = "fullmag-worktree-fixture"

            def space(self):
                return preflight

            def write(self, path, value):
                writes.append((path, deepcopy(value)))

        def timed_out(*_args, **_kwargs):
            raise qa.ControlOutcomeUnknown("Docker observation exceeded its time/output budget; daemon resources retained")

        with patch.object(qa, "_inspect_image", return_value=None), \
             patch.object(qa, "docker_capture", side_effect=timed_out):
            with self.assertRaises(qa.ControlOutcomeUnknown):
                qa._ensure_browser_image(
                    operation,
                    FakeControl(),
                    {"services": {"browser-qa": {"pull_policy": "never"}}},
                    image,
                    1,
                )

        self.assertTrue(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["browser_image_pull_state"], "outcome-unknown-resources-retained")
        self.assertTrue(any(path.endswith("/browser-image-pull.json") and value["state"] == "outcome-unknown-resources-retained" for path, value in writes))
        self.assertTrue(any(path.endswith("/receipt.json") and value["browser_image_pull_state"] == "outcome-unknown-resources-retained" for path, value in writes))

    def test_run_keeps_control_lease_helper_separate_from_browser_helper_on_error(self):
        qa = self.qa
        operation = {
            "root": "browser-qa/attempts/" + "a" * 32,
            "receipt": {
                "attempt": "a" * 32,
                "helper_container": "fullmag-control-" + "a" * 32,
            },
            "daemon_pending": False,
        }
        writes = []
        daemon_calls = []

        class FakeControl:
            project = "fullmag-worktree-fixture"

            def write(self, path, value):
                writes.append((path, deepcopy(value)))

        browser_id = "sha256:" + "b" * 64
        browser_command = ["node", "browser-qa.mjs"]
        observed = {"Id": browser_id, "Config": {"Cmd": browser_command}}
        compose_result = SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

        def fake_daemon(*args, **_kwargs):
            daemon_calls.append(args)
            if args[0] == "compose":
                return compose_result
            if args[0] == "rm":
                return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
            if args[0] == "inspect":
                return SimpleNamespace(returncode=1, stdout=b"", stderr=b"not found")
            raise AssertionError(f"unexpected daemon command: {args!r}")

        def fake_parse(*_args, **_kwargs):
            raise qa.BuildControlError("invalid canvas evidence")

        with patch.object(qa, "_probe_public_loopback", return_value={"state": "passed"}), \
             patch.object(qa, "docker_capture", side_effect=fake_daemon), \
             patch.object(qa, "_inspect", return_value=observed), \
             patch.object(qa, "_validate_browser_helper"), \
             patch.object(qa, "_parse_result", side_effect=fake_parse):
            with self.assertRaises(qa.BuildControlError):
                qa._run(
                    operation,
                    FakeControl(),
                    {"services": {"browser-qa": {"command": browser_command}}},
                    {"project_name": "fullmag-worktree-fixture"},
                    ROOT,
                    "fullmag-frontend-state",
                    browser_id,
                    "http://127.0.0.1:32871",
                    "http://frontend:8080",
                    180,
                    canvas_only=False,
                    expect_live_field=None,
                    expect_airbox_vectors=False,
                    expect_ambiguous_compute_fields=False,
                )

        self.assertEqual(operation["receipt"]["helper_container"], "fullmag-control-" + "a" * 32)
        self.assertEqual(operation["receipt"]["browser_container_name"], "fullmag-browser-qa-" + "a" * 12)
        self.assertEqual(operation["receipt"]["browser_container_id"], browser_id)
        self.assertEqual(operation["receipt"]["state"], "failed-confirmed")
        self.assertEqual(operation["receipt"]["error"], "invalid canvas evidence")
        self.assertEqual([call[:2] for call in daemon_calls if call[0] in {"rm", "inspect"}], [("rm", browser_id), ("inspect", browser_id)])
        self.assertTrue(any(path.endswith("/result.json") for path, _value in writes))
        receipts = [value for path, value in writes if path.endswith("/receipt.json")]
        self.assertTrue(any(value.get("browser_container_id") == browser_id for value in receipts))

    def test_result_validator_rejects_invalid_buffers_and_recorded_errors(self):
        canvas = {
            "rect": {"width": 1440, "height": 900},
            "width": 1440,
            "height": 900,
            "context_type": "WebGL2RenderingContext",
            "context_lost": False,
            "drawing_buffer_width": 1440,
            "drawing_buffer_height": 900,
        }
        payload = {
            "schema": self.qa.RESULT_SCHEMA,
            "state": "passed",
            "public_url": "http://127.0.0.1:32871",
            "probe_url": "http://frontend:8080",
            "playwright_version": "1.62.1",
            "browser_gpu_mode": "swiftshader-webgl-requested",
            "canvas_only": False,
            "expect_live_field": None,
            "expect_airbox_vectors": False,
            "expect_ambiguous_compute_fields": False,
            "qa_scope": "full-browser-qa",
            "skipped_areas": [],
            "home_round_trip": True,
            "session": {
                "session_id": "session-1",
                "session_epoch": "session-1@1",
                "request_scope_epoch": "api:1",
            },
            "workspace": {"visible": True, "canvas_dom_stable": True},
            "canvas_before": canvas,
            "canvas_after": deepcopy(canvas),
            "viewport_dom_observations": {
                "field_data_proven": False,
                "note": self.qa.VIEWPORT_DOM_OBSERVATIONS_NOTE,
                **{
                    key: {
                        "dataset": {}, "quantity_labels": [],
                        "dataset_entry_count": 0, "quantity_label_count": 0,
                        "dataset_truncated": False, "quantity_labels_truncated": False,
                    }
                    for key in ("before_home", "after_home")
                },
            },
            "page_errors": 0,
            "console_errors": 0,
            "request_failures": 0,
            "http_errors": [],
            "resource_responses": [],
        }
        encoded = lambda value: (json.dumps(value) + "\n").encode("utf-8")
        self.assertEqual(self.qa._parse_result(encoded(payload), payload["public_url"], payload["probe_url"]), payload)
        for field, bad_value in (
            ("canvas_only", True),
            ("qa_scope", "canvas-home-only"),
            ("skipped_areas", ["viewport-appearance"]),
            ("expect_live_field", "H_Oersted"),
            ("expect_airbox_vectors", True),
            ("expect_ambiguous_compute_fields", True),
            ("viewport_dom_observations", None),
            ("http_errors", [{"status": 400}]),
            ("resource_responses", None),
            ("canvas_screenshot", {"state": "captured"}),
        ):
            with self.subTest(rejected_field=field):
                invalid = deepcopy(payload)
                invalid[field] = bad_value
                with self.assertRaises(self.qa.BuildControlError):
                    self.qa._parse_result(encoded(invalid), payload["public_url"], payload["probe_url"])
        invalid_buffer = deepcopy(payload)
        invalid_buffer["canvas_after"]["drawing_buffer_width"] = 0
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_result(encoded(invalid_buffer), payload["public_url"], payload["probe_url"])
        invalid_errors = deepcopy(payload)
        invalid_errors["console_errors"] = 1
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_result(encoded(invalid_errors), payload["public_url"], payload["probe_url"])
        invalid_session = deepcopy(payload)
        invalid_session["session"]["request_scope_epoch"] = ""
        with self.assertRaises(self.qa.BuildControlError):
            self.qa._parse_result(encoded(invalid_session), payload["public_url"], payload["probe_url"])

    def test_browser_flow_proves_existing_session_home_and_webgl(self):
        text = (ROOT / "apps/control-room/scripts/docker-dev-browser-qa.mjs").read_text(encoding="utf-8")
        for required in (
            'require("playwright/package.json")',
            "1.62.1",
            '.fm-home-overlay[data-state="home-overlay"]',
            'name: "Home"',
            'name: "Back to simulation"',
            '"/v2/sessions/current/status"',
            'elementHandle()',
            'canvasHandle.evaluate',
            '"--enable-unsafe-swiftshader"',
            '"--use-angle=swiftshader-webgl"',
            '"--no-sandbox"',
            'getContext("webgl2")',
            "isContextLost",
            "drawingBufferWidth",
            "drawingBufferHeight",
            "browser_gpu_mode",
            "canvas_dom_stable",
        ):
            self.assertIn(required, text)
        for required in (
            'page.locator(".fm-viewport-3d canvas").first().screenshot',
            "maxCanvasScreenshotBytes",
            'state: "omitted-size-limit", image_proof: false',
            'state: "omitted-capture-failed", image_proof: false',
            "canvas_screenshot: await captureCanvasScreenshot(page, after)",
        ):
            self.assertIn(required, text)
        self.assertIn("const captureCanvasScreenshot = async", text)
        live_field_result = text.split("...(expectedLiveField ? {", 1)[1].split("} : {}),", 1)[0]
        self.assertIn("canvas_screenshot: await captureCanvasScreenshot(page, after)", live_field_result)
        self.assertNotIn('http://127.0.0.1:32871', text.split("const publicUrl", 1)[1].split("const probeUrl", 1)[0])
        self.assertNotIn("CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION", text)

    def test_lock_and_managed_check_registration_are_pinned(self):
        lock = (ROOT / "pnpm-lock.yaml").read_text(encoding="utf-8")
        self.assertRegex(lock, r"playwright:\n\s+specifier: \^1\.60\.0\n\s+version: 1\.62\.1")
        self.assertIn("test_docker_dev_browser_qa", (ROOT / "scripts/docker_volume_checks.py").read_text(encoding="utf-8"))


class StudyStageRerunContractTests(unittest.TestCase):
    SOURCE_KEYS = (
        "runner", "loopback_proxy", "fixture", "scene_adapter", "tree_view", "study_nodes",
        "stage_builder", "command_adapter", "command_contributions", "study_compute_input", "tab_routes",
    )

    @classmethod
    def setUpClass(cls):
        cls.qa = _load_qa_module()

    @staticmethod
    def sources(qa):
        return qa._study_stage_rerun_source_sha256(ROOT)

    def test_material_stage_a_guard_pins_one_material_patch_and_preserves_scene_state(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        source = ROOT / "apps/control-room/scripts/check-study-stage-rerun-browser.mjs"
        javascript = r"""
import assert from 'node:assert/strict';
const runner = await import(process.argv[1]);
assert.deepEqual(runner.studyStageCommandForMode('material-stage-a'), {
  kind:'relax', target:{kind:'stage_id',stage_id:'relax-a'},
  initial_state:{kind:'default_for_target'},
});
assert.deepEqual(runner.studyStageExpectedStageIds('material-stage-a','before'),
  ['relax-a','relax-b','relax-c']);
assert.deepEqual(runner.studyStageExpectedStageIds('material-stage-a','after'), ['relax-a']);
const session = {session_id:'s',session_epoch:'s@1',request_scope_epoch:'api:1'};
const scope = 'session=s&epoch=s%401&request_scope_epoch=api%3A1';
const sceneBefore = {
  revision:31,
  objects:[{id:'film',name:'film',material_ref:'material-film',magnetization_ref:'mag-film'}],
  materials:[{id:'material-film',name:'film',properties:{Ms:800000,Aex:13e-12,alpha:0.5,Dind:null,Dbulk:null},
    references:[{label:'fixture'}]}],
  magnetization_assets:[{id:'mag-film',kind:'uniform',value:[1,0,0]}],
};
const before = runner.studyStageMaterialState(sceneBefore);
assert.deepEqual(before, {
  object_id:'film', material_id:'material-film', material_name:'film',
  properties:{Ms:800000,Aex:13e-12,alpha:0.5,Dind:null,Dbulk:null},
  magnetization_ref:'mag-film',magnetization_asset_sha256:'9f5b7db421041ddbe7884ecb073a3dd6221e40e01a5e4e0f71ecb1acf8bc988b',
});
const request = {method:'POST',path:'/v2/sessions/current/model/transactions',scope,body:{
  kind:'patch_material',material_id:'material-film',base_revision:31,
  patch:{name:'film',properties:{Aex:1e-11,Dind:null,Dbulk:null,Ms:600000,alpha:0.5}},
}};
const context = {phase:'material-submit',materialCount:0,session,beforeRevision:31,before};
assert.equal(runner.studyStageMaterialRequestAllowed(request,context),true);
assert.equal(runner.studyStageMaterialRequestAllowed(request,{...context,phase:'ui-submit'}),false);
assert.equal(runner.studyStageMaterialRequestAllowed(request,{...context,materialCount:1}),false);
assert.equal(runner.studyStageMaterialRequestAllowed({...request,body:{...request.body,base_revision:30}},context),false);
assert.equal(runner.studyStageMaterialRequestAllowed({...request,body:{...request.body,patch:{...request.body.patch,properties:{...request.body.patch.properties,alpha:0.7}}}},context),false);
assert.equal(runner.studyStageMaterialRequestAllowed({...request,body:{...request.body,patch:{...request.body.patch,properties:{...request.body.patch.properties,texture:'bad'}}}},context),false);
const sceneAfter = structuredClone(sceneBefore);
sceneAfter.revision = 32;
sceneAfter.materials[0].properties.Ms = 600000;
sceneAfter.materials[0].properties.Aex = 1e-11;
assert.equal(runner.studyStageMaterialSceneMatches(sceneBefore,sceneAfter),true);
const withoutOptionalDmi = structuredClone(sceneBefore);
delete withoutOptionalDmi.materials[0].properties.Dind;
delete withoutOptionalDmi.materials[0].properties.Dbulk;
assert.equal(runner.studyStageMaterialSceneMatches(withoutOptionalDmi,sceneAfter),true);
const changedDmi = structuredClone(sceneAfter);
changedDmi.materials[0].properties.Dind = 1e-3;
assert.equal(runner.studyStageMaterialSceneMatches(withoutOptionalDmi,changedDmi),false);

const changedM0 = structuredClone(sceneAfter);
changedM0.magnetization_assets[0].value = [0,1,0];
assert.equal(runner.studyStageMaterialSceneMatches(sceneBefore,changedM0),false);
const changedAlpha = structuredClone(sceneAfter);
changedAlpha.materials[0].properties.alpha = 0.7;
assert.equal(runner.studyStageMaterialSceneMatches(sceneBefore,changedAlpha),false);
const accepted = runner.studyStageMaterialTransactionOutcome(200, {
  transaction_kind:'patch_material',scene_revision:32,committed_scene:sceneAfter,
}, sceneBefore);
assert.deepEqual(accepted,{outcome:'accepted',scene_revision:32,material: {
  object_id:'film',material_id:'material-film',material_name:'film',
  properties:{Ms:600000,Aex:1e-11,alpha:0.5,Dind:null,Dbulk:null},magnetization_ref:'mag-film',
  magnetization_asset_sha256:'9f5b7db421041ddbe7884ecb073a3dd6221e40e01a5e4e0f71ecb1acf8bc988b',
}});
assert.equal(runner.studyStageMaterialTransactionOutcome(409, {
  transaction_kind:'patch_material',scene_revision:32,committed_scene:sceneAfter,
}, sceneBefore).outcome,'unknown');
const foreignAck = structuredClone(sceneAfter); foreignAck.objects[0].name = 'other';
assert.equal(runner.studyStageMaterialTransactionOutcome(200, {
  transaction_kind:'patch_material',scene_revision:32,committed_scene:foreignAck,
}, sceneBefore).outcome,'unknown');
"""
        result = subprocess.run(
            [node, "--input-type=module", "-e", javascript, source.as_uri()],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fdm_cell_study_guards_one_exact_merge_patch_and_automatic_grid_refresh(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        source = ROOT / "apps/control-room/scripts/check-study-stage-rerun-browser.mjs"
        javascript = r"""
import assert from 'node:assert/strict';
const runner = await import(process.argv[1]);
assert.deepEqual(runner.studyStageCommandForMode('fdm-cell-study'), {kind:'solve',target:{kind:'study'}});
assert.deepEqual(runner.studyStageExpectedStageIds('fdm-cell-study','before'), ['relax-a']);
assert.deepEqual(runner.studyStageExpectedStageIds('fdm-cell-study','after'), ['relax-a','relax-b','relax-c']);
const session = {session_id:'s',session_epoch:'s@1',request_scope_epoch:'api:1'};
const scope = 'session=s&epoch=s%401&request_scope_epoch=api%3A1';
const before = {revision:9,study:{requested_backend:'fdm',fdm:{default_cell:[2e-9,1e-9,2e-9],demag:{mode:'auto'}}},objects:[]};
const after = structuredClone(before); after.revision=10; after.study.fdm.default_cell=[1e-9,2e-9,2e-9];
const patch = {method:'POST',path:'/v2/sessions/current/model/transactions',scope,body:{
  kind:'merge_patch',base_revision:9,merge_patch:{study:{fdm:{default_cell:[1e-9,2e-9,2e-9]}}},
}};
assert.deepEqual(runner.studyStageFdmCellState(before),{cell:[2e-9,1e-9,2e-9]});
const context={phase:'fdm-cell-submit',transactionCount:0,session,beforeRevision:9,beforeScene:before};
assert.equal(runner.studyStageFdmCellRequestAllowed(patch,context),true);
assert.equal(runner.studyStageFdmCellRequestAllowed(patch,{...context,phase:'ui-submit'}),false);
assert.equal(runner.studyStageFdmCellRequestAllowed(patch,{...context,transactionCount:1}),false);
assert.equal(runner.studyStageFdmCellRequestAllowed({...patch,body:{...patch.body,base_revision:8}},context),false);
assert.equal(runner.studyStageFdmCellRequestAllowed({...patch,body:{...patch.body,merge_patch:{study:{fdm:{default_cell:[1e-9,2e-9,2e-9],per_magnet:{other:{cell:[1,1,1]}}}}}}},context),false);
assert.equal(runner.studyStageFdmCellRequestAllowed({...patch,body:{...patch.body,merge_patch:{study:{fdm:{default_cell:[1e-9,2e-9,2e-9]},solver:{integrator:'same'}}}}},context),false);
assert.deepEqual(runner.studyStageFdmCellTransactionOutcome(200,{transaction_kind:'merge_patch',scene_revision:10,committed_scene:after},before),{
  outcome:'accepted',scene_revision:10,before_cell:[2e-9,1e-9,2e-9],after_cell:[1e-9,2e-9,2e-9],
});
const changedSolver=structuredClone(after); changedSolver.study.solver={integrator:'bad'};
assert.equal(runner.studyStageFdmCellTransactionOutcome(200,{transaction_kind:'merge_patch',scene_revision:10,committed_scene:changedSolver},before).outcome,'unknown');
const request={method:'POST',path:'/v2/sessions/current/simulation/commands',scope,body:{
  client_intent_id:'fdm-grid-refresh-123-1',kind:'fdm_grid_refresh',precondition:{scene_revision:10},reason:'study_global_commit',
}};
const gridContext={phase:'fdm-grid-submit',refreshCount:0,session,sceneRevision:10,existingIntentIds:new Set(['fdm-grid-refresh-old'])};
const wait = runner.studyStageObserveResponse(Promise.reject(new Error('page closed')), 'grid: ');
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(await wait, {response:null,error:'grid: page closed'});
const response = {status:200};
assert.deepEqual(await runner.studyStageObserveResponse(Promise.resolve(response),'grid: '),
  {response,error:null});

assert.equal(runner.studyStageFdmGridRefreshRequestAllowed(request,gridContext),true);
assert.equal(runner.studyStageFdmGridRefreshRequestAllowed(request,{...gridContext,refreshCount:1}),false);
assert.equal(runner.studyStageFdmGridRefreshRequestAllowed({...request,body:{...request.body,reason:'explicit_build_grid'}},gridContext),false);
assert.equal(runner.studyStageFdmGridRefreshRequestAllowed({...request,body:{...request.body,mesh_target:{kind:'study_domain'}}},gridContext),false);
assert.equal(runner.studyStageFdmGridRefreshRequestAllowed({...request,body:{...request.body,client_intent_id:'fdm-grid-refresh-old'}},gridContext),false);
assert.equal(runner.studyStageShouldReadTerminalResources({run:{run_id:'new'},solver:{state:'running'}},'new'),false);
assert.equal(runner.studyStageShouldReadTerminalResources({run:{run_id:'old'},solver:{state:'awaiting_command'}},'new'),false);
assert.equal(runner.studyStageShouldReadTerminalResources({run:{run_id:'new'},solver:{state:'awaiting_command'}},'new'),true);
""";
        result = subprocess.run(
            [node, "--input-type=module", "-e", javascript, source.as_uri()],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_texture_profiles_pin_B_local_v2_recipe_source_catalog_and_authored_stage_command(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        source = ROOT / "apps/control-room/scripts/check-study-stage-rerun-browser.mjs"
        javascript = r"""
import assert from 'node:assert/strict';
const runner = await import(process.argv[1]);
const baseline = () => ({
  revision: 41,
  objects: [{id:'film',name:'film',role:'magnet',material_ref:'mat-film',magnetization_ref:'mag-film'}],
  materials: [{id:'mat-film',name:'film material',properties:{Ms:600000,Aex:1e-11,alpha:0.5}}],
  magnetization_assets: [{id:'mag-film',kind:'preset_texture',preset_kind:'uniform',
    preset_params:{direction:[1,0,0]}}],
  study: {requested_backend:'fdm',requested_device:'cpu',requested_precision:'double',
    fdm:{default_cell:[1e-9,2e-9,2e-9]},study_pipeline:{version:'study_pipeline.v1',nodes:[
      {enabled:true,id:'relax-a',label:'Relax 1',node_kind:'primitive',source:'script_imported',stage_kind:'relax',
       payload:{adaptive_timestep:null,demag_interval_s:'',energy_tolerance:'',entrypoint_kind:'flat_relax',
        fixed_timestep:'1e-13',integrator:'rk23',kind:'relax',max_relaxation_time_s:'',max_steps:'10',
        relax_algorithm:'llg_overdamped',stage_id:'relax-a',torque_tolerance:'0.0001',until_seconds:''}},
      {enabled:true,id:'relax-b',label:'Relax 2',node_kind:'primitive',source:'script_imported',stage_kind:'relax',
       payload:{energy_tolerance:'',entrypoint_kind:'flat_relax',kind:'relax',max_steps:'1',
        relax_algorithm:'projected_gradient_bb',stage_id:'relax-b',torque_tolerance:'0.0001',until_seconds:''}},
      {enabled:true,id:'relax-c',label:'Relax 3',node_kind:'primitive',source:'script_imported',stage_kind:'relax',
       payload:{energy_tolerance:'',entrypoint_kind:'flat_relax',kind:'relax',max_steps:'1',
        relax_algorithm:'nonlinear_cg',stage_id:'relax-c',torque_tolerance:'0.0001',until_seconds:''}},
    ]}},
});
assert.deepEqual(runner.studyStageCommandForMode('texture-stage-b',42), {
  kind:'relax',target:{kind:'stage_id',stage_id:'relax-b'},
  initial_state:{kind:'authored_initial_state',source:{kind:'stage',scene_revision:42,stage_id:'relax-b'}},
});
assert.deepEqual(runner.studyStageCommandForMode('texture-study'),{kind:'solve',target:{kind:'study'}});
assert.deepEqual(runner.studyStageExpectedStageIds('texture-stage-b','before'),['relax-a','relax-b','relax-c']);
assert.deepEqual(runner.studyStageExpectedStageIds('texture-stage-b','after'),['relax-b']);
assert.deepEqual(runner.studyStageExpectedStageIds('texture-study','before'),['relax-b']);
assert.deepEqual(runner.studyStageExpectedStageIds('texture-study','after'),['relax-a','relax-b','relax-c']);
const original = baseline();
runner.studyStageTextureSceneProfile(original,{allowUnedited:true});
assert.throws(()=>runner.studyStageTextureSceneProfile(original),/acknowledged/i);
const tx = (await import(new URL('./lib/study-texture-browser-qa.mjs',process.argv[1]))).buildStageBUniformXResetTransaction({
  scene:original,sceneRevision:41,statusSceneRevision:41,objectId:'film',
});
const saved = structuredClone(original); saved.study.study_pipeline=tx.merge_patch.study.study_pipeline;
const profile=runner.studyStageTextureSceneProfile(saved);
assert.deepEqual(profile.stage_b_texture_reset,{stage_id:'relax-b',object_id:'film',scope:'object',initializer:null});
assert.deepEqual(runner.studyStageTextureBaselineState(saved).global_m0.direction,[1,0,0]);
for (const mutate of [
  (scene)=>{scene.study.study_pipeline.nodes[0].payload.stage_magnetization_assignments={};},
  (scene)=>{scene.study.study_pipeline.nodes[1].payload.stage_magnetization_assignments.assignments[0].region_id='core';},
  (scene)=>{scene.study.fdm.default_cell=[2e-9,1e-9,2e-9];},
]) {
  const bad=structuredClone(saved); mutate(bad); assert.throws(()=>runner.studyStageTextureSceneProfile(bad));
}
const sourceIdentity={project_id:'p',study_id:'s',source:{run_id:'run-a',task_id:'t',step_id:'relax-a',case_id:'c',attempt_id:'a',ownership_epoch:1},
  authored_stage_id:'relax-a',artifact_id:'artifact-a',artifact_sha256:'a'.repeat(64),codec_id:'magnetization',codec_version:'1',accepted_at:'now'};
const catalog={next_cursor:null,results:[{...sourceIdentity,authored_relation:'matching_authored_input',
  domain_relation:'matching_published_layout',supports_magnetization_input:true}]};
assert.equal(runner.studyStageTextureCatalogProof(catalog,'run-a','relax-a',sourceIdentity,'film').artifact_id,'artifact-a');
for (const change of [
  (item)=>item.authored_relation='authored_input_changed',
  (item)=>item.domain_relation='different_published_layout',
  (item)=>item.supports_magnetization_input=false,
]) {
  const bad=structuredClone(catalog); change(bad.results[0]);
  assert.throws(()=>runner.studyStageTextureCatalogProof(bad,'run-a','relax-a',sourceIdentity,'film'));
}
const session={session_id:'s',session_epoch:'s@1',request_scope_epoch:'api:1'};
const precondition={scene_revision:42};
const command=runner.studyStageCommandForMode('texture-stage-b',42);
const request={method:'POST',path:'/v2/sessions/current/simulation/commands',scope:'session=s&epoch=s%401&request_scope_epoch=api%3A1',body:{
  ...command,precondition:{...precondition},client_intent_id:'study:relax:texture-b',reason:'user_requested',requested_at_unix_ms:1799000000000,
}};
const context={mode:'texture-stage-b',session,expectedPrecondition:precondition,commandCount:0,phase:'ui-submit',
  idempotencyKey:'study:relax:texture-b'};
assert.equal(runner.studyStageRerunRequestAllowed(request,context),true);
assert.equal(runner.studyStageRerunRequestAllowed(request,{...context,idempotencyKey:'foreign'}),false);
assert.equal(runner.studyStageRerunRequestAllowed(request,{...context,phase:'texture-ready'}),false);
assert.equal(runner.studyStageRerunRequestAllowed({...request,body:{...request.body,initial_state:{kind:'default_for_target'}}},context),false);
assert.equal(runner.studyStageRerunRequestAllowed({...request,body:{...request.body,precondition:{scene_revision:41}}},context),false);
assert.equal(runner.studyStageExecutionBindingMatches({run_id:'new',requested_target:{kind:'stage_id',stage_id:'relax-b'},step_id:'relax-b'},'texture-stage-b','new'),true);
assert.equal(runner.studyStageExecutionBindingMatches({run_id:'new',requested_target:{kind:'study'},step_id:null},'texture-stage-b','new'),false);
""";
        result = subprocess.run(
            [node, "--input-type=module", "-e", javascript, source.as_uri()],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_mode_specific_source_pins_leave_legacy_profiles_unchanged(self):
        qa = self.qa
        stage_b = qa._study_stage_rerun_source_sha256(ROOT, "stage-b")
        material = qa._study_stage_rerun_source_sha256(ROOT, "material-stage-a")
        fdm_cell = qa._study_stage_rerun_source_sha256(ROOT, "fdm-cell-study")
        texture_stage = qa._study_stage_rerun_source_sha256(ROOT, "texture-stage-b")
        texture_study = qa._study_stage_rerun_source_sha256(ROOT, "texture-study")
        self.assertEqual(set(stage_b), set(self.SOURCE_KEYS))
        self.assertEqual(set(material), set(self.SOURCE_KEYS) | set(qa.STUDY_STAGE_MATERIAL_SOURCES))
        self.assertEqual(set(fdm_cell), set(self.SOURCE_KEYS) | set(qa.STUDY_STAGE_FDM_CELL_SOURCES))
        self.assertEqual(set(texture_stage), set(self.SOURCE_KEYS) | set(qa.STUDY_STAGE_TEXTURE_SOURCES))
        self.assertEqual(texture_stage, texture_study)
        qa._validate_study_stage_rerun_hashes(stage_b, "stage-b")
        qa._validate_study_stage_rerun_hashes(material, "material-stage-a")
        qa._validate_study_stage_rerun_hashes(fdm_cell, "fdm-cell-study")
        qa._validate_study_stage_rerun_hashes(texture_stage, "texture-stage-b")
        qa._validate_study_stage_rerun_hashes(texture_study, "texture-study")
        with self.assertRaises(qa.BuildControlError):
            qa._validate_study_stage_rerun_hashes(material, "stage-b")

    def test_texture_profiles_accept_exact_terminal_proofs_and_reject_scope_drift(self):
        qa = self.qa
        for mode in ("texture-stage-b", "texture-study"):
            sources = qa._study_stage_rerun_source_sha256(ROOT, mode)
            payload = self.texture_result_fixture(mode, sources)
            encoded = (json.dumps(payload) + "\n").encode()
            with self.subTest(mode=mode):
                parsed = qa._parse_study_stage_rerun_result(
                    encoded, payload["public_url"], payload["probe_url"], sources, mode,
                )
                self.assertEqual(parsed["texture_source_proof"]["authored_relation"], "matching_authored_input")
                self.assertFalse(parsed["native_execution_proven"])
                for mutate in (
                    lambda item: item["texture_source_proof"].update(domain_relation="different_published_layout"),
                    lambda item: item["texture_source_proof"].update(artifact_sha256="f" * 64),
                    lambda item: item["before"]["texture_state"].update(scope="region"),
                    lambda item: item["before"]["profile"].update(domain_cell_count=8),
                    lambda item: item["command_receipt"]["payload"].update(target={"kind": "stage_id", "stage_id": "relax-a"}),
                    lambda item: item["after"]["scene_profile"].update(pipeline_version="study_pipeline.v1"),
                ):
                    bad = deepcopy(payload)
                    mutate(bad)
                    with self.assertRaises(qa.BuildControlError):
                        qa._parse_study_stage_rerun_result(
                            (json.dumps(bad) + "\n").encode(), bad["public_url"], bad["probe_url"], sources, mode,
                        )
                if mode == "texture-stage-b":
                    for mutate in (
                        lambda item: item["texture_receipt"]["payload"].__setitem__("base_revision", 38),
                        lambda item: item["texture_receipt"]["acknowledgement"]["committed_scene"].__setitem__("revision", 41),
                        lambda item: item["texture_receipt"]["payload"]["merge_patch"]["study"]["study_pipeline"]["nodes"][0]["payload"].update(
                            stage_magnetization_assignments={"schema_version": "fullmag.magnetization-assignments.v1",
                                                             "assignments": []}),
                        lambda item: item["command_receipt"].update(idempotency_key="foreign"),
                    ):
                        bad = deepcopy(payload)
                        mutate(bad)
                        with self.assertRaises(qa.BuildControlError):
                            qa._parse_study_stage_rerun_result(
                                (json.dumps(bad) + "\n").encode(), bad["public_url"], bad["probe_url"], sources, mode,
                            )
                else:
                    bad = deepcopy(payload)
                    bad["texture_transaction_count"] = 1
                    with self.assertRaises(qa.BuildControlError):
                        qa._parse_study_stage_rerun_result(
                            (json.dumps(bad) + "\n").encode(), bad["public_url"], bad["probe_url"], sources, mode,
                        )

    def test_texture_unknown_profiles_retain_possible_writes_without_terminal_claims(self):
        qa = self.qa
        for mode in ("texture-stage-b", "texture-study"):
            sources = qa._study_stage_rerun_source_sha256(ROOT, mode)
            payload = self.texture_result_fixture(mode, sources)
            payload.update({
                "state": "outcome-unknown", "outcome": "unknown",
                "failure": "bounded observation ended after a possible dispatch",
                "after": None, "reload_proof": None, "history_identity_preserved": None,
                "public_terminal_proven": False, "native_execution_proven": False, "field_data_proven": False,
            })
            if mode == "texture-stage-b":
                payload["command_receipt"] = None
                payload["command_count"] = 0
                payload["command_attempt_count"] = 0
                payload["ui_command_proven"] = False
                payload["request_counts"].pop("POST /v2/sessions/current/simulation/commands")
            payload["total_requests"] = sum(payload["request_counts"].values())
            parsed = qa._parse_study_stage_rerun_result(
                (json.dumps(payload) + "\n").encode(), payload["public_url"], payload["probe_url"], sources, mode,
            )
            self.assertEqual(parsed["outcome"], "unknown")
            self.assertIsNone(parsed["after"])
            self.assertFalse(parsed["public_terminal_proven"])
            bad = deepcopy(payload)
            bad["command_attempt_count"] = 2
            with self.assertRaises(qa.BuildControlError):
                qa._parse_study_stage_rerun_result(
                    (json.dumps(bad) + "\n").encode(), bad["public_url"], bad["probe_url"], sources, mode,
                )

    @staticmethod
    def result_identity(run_id, stage_id, index):
        return {
            "project_id": "project-p22",
            "study_id": "study-p22",
            "source": {
                "run_id": run_id,
                "task_id": f"task-{index}",
                "step_id": stage_id,
                "case_id": f"case-{index}",
                "attempt_id": f"attempt-{index}",
                "ownership_epoch": index,
            },
            "authored_stage_id": stage_id,
            "artifact_id": f"artifact-{run_id}-{stage_id}",
            "artifact_sha256": f"{index:064x}",
            "codec_id": "fullmag.scalar-series.v1",
            "codec_version": "1",
            "accepted_at": "2026-11-07T10:00:00Z",
        }

    def result_fixture(self, mode, sources):
        qa = self.qa
        session = {
            "name": "P22 three Relax stages",
            "session_id": "session-p22",
            "session_epoch": "session-p22@1",
            "request_scope_epoch": "api:p22:1",
        }
        previous_run = "run-before"
        new_run = "run-after"
        before_ids = (["relax-b"] if mode == "study" else ["relax-a"] if mode == "fdm-cell-study"
                      else ["relax-a", "relax-b", "relax-c"])
        after_ids = (["relax-b"] if mode == "stage-b" else ["relax-a"] if mode == "material-stage-a"
                     else ["relax-a", "relax-b", "relax-c"])
        before_results = [self.result_identity(previous_run, stage_id, index + 1)
                          for index, stage_id in enumerate(before_ids)]
        new_results = [self.result_identity(new_run, stage_id, index + 4)
                       for index, stage_id in enumerate(after_ids)]
        precondition = {
            "scene_revision": 32 if mode in {"material-stage-a", "fdm-cell-study"} else 31,
            "mesh_revision": 19 if mode == "fdm-cell-study" else 18,
            "domain_generation_id": "fdm-domain-16" if mode == "fdm-cell-study" else "fdm-domain-8",
            "region_topology_revision": 3,
            "region_membership_revision": 4,
            "region_coefficients_revision": 5,
            "region_initial_state_revision": 6,
            "current_run": {"kind": "run", "run_id": previous_run},
            "runtime_state": "awaiting_command",
            "command_revision": 0,
        }
        if mode in {"stage-b", "material-stage-a"}:
            selected_stage = "relax-b" if mode == "stage-b" else "relax-a"
            command = {
                "kind": "relax",
                "target": {"kind": "stage_id", "stage_id": selected_stage},
                "initial_state": {"kind": "default_for_target"},
                "precondition": deepcopy(precondition),
                "client_intent_id": "study:relax:p22-stage-b",
                "reason": "user_requested",
                "requested_at_unix_ms": 1_799_000_000_000,
            }
        else:
            command = {
                "kind": "solve",
                "target": {"kind": "study"},
                "precondition": deepcopy(precondition),
                "client_intent_id": "study:solve:p22-study",
                "reason": "user_requested",
                "requested_at_unix_ms": 1_799_000_000_000,
            }
        scope = "session=session-p22&epoch=session-p22%401&request_scope_epoch=api%3Ap22%3A1"
        execution_binding = {"requested_target": command["target"], "run_id": new_run}
        if mode in {"stage-b", "material-stage-a"}:
            execution_binding["step_id"] = command["target"]["stage_id"]
        payload = {
            "schema": qa.STUDY_STAGE_RERUN_RESULT_SCHEMA,
            "scenario": "study-stage-rerun",
            "state": "passed",
            "mode": mode,
            "failure": None,
            "public_url": "http://127.0.0.1:3242",
            "probe_url": "http://frontend:8080",
            "playwright_version": qa.PLAYWRIGHT_VERSION,
            "browser_gpu_mode": "swiftshader-webgl-requested",
            "source_sha256_before": sources,
            "source_sha256_after": sources,
            "session_before": session,
            "session_after": dict(session),
            "before": {
                "run_id": previous_run,
                "run_status": "completed",
                "solver_state": "awaiting_command",
                "execution_state": "completed",
                "stage_ids": before_ids,
                "authored_stage_ids": ["relax-a", "relax-b", "relax-c"],
                "stage_statuses": ["completed" if stage in before_ids else "pending"
                                   for stage in ("relax-a", "relax-b", "relax-c")],
                "completed_stage_indexes": [i for i, stage in enumerate(("relax-a", "relax-b", "relax-c"))
                                            if stage in before_ids],
                "scene_profile": qa._expected_study_stage_scene_profile(),
                "profile": {"domain_discretization": "fdm",
                            "domain_cell_count": 16 if mode == "fdm-cell-study" else 8,
                            "domain_generation_id": "fdm-domain-16" if mode == "fdm-cell-study" else "fdm-domain-8",
                            "requested_backend": "fdm", "requested_device": "cpu", "requested_precision": "double",
                            "script_path": "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py",
                            "script_sha256": sources["fixture"]},
                "result_identities": before_results,
                "precondition": precondition,
            },
            "command_receipt": {
                "method": "POST",
                "path": "/v2/sessions/current/simulation/commands",
                "status": 202,
                "scope_header": scope,
                "payload": command,
                "execution_binding": execution_binding,
            },
            "phase": "await-terminal",
            "material_receipt": None,
            "material_count": 0,
            "material_attempt_count": 0,
            "ui_material_proven": False,
            "command_count": 1,
            "command_attempt_count": 1,
            "ui_command_proven": True,
            "after": {
                "run_id": new_run,
                "run_status": "completed",
                "solver_state": "awaiting_command",
                "execution_state": "completed",
                "stage_ids": after_ids,
                "authored_stage_ids": ["relax-a", "relax-b", "relax-c"],
                "stage_statuses": ["completed" if stage in after_ids else "pending"
                                   for stage in ("relax-a", "relax-b", "relax-c")],
                "completed_stage_indexes": [i for i, stage in enumerate(("relax-a", "relax-b", "relax-c"))
                                            if stage in after_ids],
                "scene_profile": qa._expected_study_stage_scene_profile(),
                "profile": {"domain_discretization": "fdm",
                            "domain_cell_count": 16 if mode == "fdm-cell-study" else 8,
                            "domain_generation_id": "fdm-domain-16" if mode == "fdm-cell-study" else "fdm-domain-8",
                            "requested_backend": "fdm", "requested_device": "cpu", "requested_precision": "double",
                            "script_path": "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py",
                            "script_sha256": sources["fixture"]},
                "result_identities": new_results,
                "preserved_prior_result_identities": deepcopy(before_results),
            },
            "reload_proof": {"status": 200, "path": "/session/p22-three-relax-stages", "run_id": new_run,
                "command_count": 1, "command_attempt_count": 1,
                "stable_projection": True, "history_identity_preserved": True,
                "canvas": {"visible": True, "context_type": "WebGL2RenderingContext", "context_lost": False,
                    "drawing_buffer_width": 600, "drawing_buffer_height": 500,
                    "quantity_id": "m", "label_visible": True, "field_state": "data-ready",
                    "fdm_model_count": 16 if mode == "fdm-cell-study" else 8}},
            "history_identity_preserved": True,
            "public_terminal_proven": True,
            "native_execution_proven": False,
            "field_data_proven": False,
            "outcome": "terminal-confirmed",
            "read_counts": {
                "status": 2,
                "current_session": 2,
                "scene": 2,
                "commands": 2,
                "current_run": 2,
                "stage_execution": 2,
                "solver_status": 2,
                "stage_results": 3,
                "command_details": 1 if mode == "fdm-cell-study" else 0,
            },
            "request_counts": {
                "GET /v2/sessions/current/status": 3 if mode == "fdm-cell-study" else 2,
                "GET /v2/sessions/current": 2,
                "GET /v2/sessions/current/model/scene": 3 if mode == "fdm-cell-study" else 2,
                "GET /v2/sessions/current/simulation/commands": 2,
                "GET /v2/sessions/current/simulation/runs/current": 2,
                "GET /v2/sessions/current/simulation/stages/execution": 2,
                "GET /v2/sessions/current/simulation/solver/status": 2,
                f"GET /v2/sessions/current/simulation/stages/results?run_id={previous_run}&limit=100": 2,
                f"GET /v2/sessions/current/simulation/stages/results?run_id={new_run}&limit=100": 1,
                **({"GET /v2/sessions/current/simulation/commands/grid-refresh-1": 1}
                   if mode == "fdm-cell-study" else {}),
                "POST /v2/sessions/current/simulation/commands": 2 if mode == "fdm-cell-study" else 1,
            },
            "total_requests": 18 + (1 + 1 + 1 + 1 + 1 if mode == "fdm-cell-study" else 0),
            "request_limit": 512,
            "request_path_limit": 128,
            "per_path_read_limit": 128,
            "violations": [],
            "errors": [],
            "proxy_failures": [],
        }
        if mode == "material-stage-a":
            magnetization_hash = "d" * 64
            material_before = {
                "object_id": "film", "material_id": "mat-film", "material_name": "film material",
                "properties": {"Ms": 800000, "Aex": 13e-12, "alpha": 0.5, "Dind": None, "Dbulk": None},
                "magnetization_ref": "mag-film", "magnetization_asset_sha256": magnetization_hash,
            }
            material_after = {
                **deepcopy(material_before),
                "properties": {"Ms": 600000, "Aex": 1e-11, "alpha": 0.5, "Dind": None, "Dbulk": None},
            }
            material_payload = {
                "base_revision": 31,
                "kind": "patch_material",
                "material_id": "mat-film",
                "patch": {"name": "film material", "properties": {
                    "Aex": 1e-11, "Dind": None, "Dbulk": None, "Ms": 600000, "alpha": 0.5,
                }},
            }
            payload["material_count"] = 1
            payload["material_attempt_count"] = 1
            payload["ui_material_proven"] = True
            payload["material_receipt"] = {
                "method": "POST",
                "path": "/v2/sessions/current/model/transactions",
                "status": 200,
                "scope_header": scope,
                "payload": material_payload,
                "before_scene_revision": 31,
                "material_before": material_before,
                "acknowledged": True,
                "transaction_kind": "patch_material",
                "scene_revision": 32,
                "material_after": material_after,
                "unmodified_scene_sha256_before": "e" * 64,
                "unmodified_scene_sha256_after": "e" * 64,
            }
            payload["request_counts"]["POST /v2/sessions/current/model/transactions"] = 1
            payload["total_requests"] += 1
        if mode == "fdm-cell-study":
            material_hash = "d" * 64
            material_state = {
                "object_id": "film", "material_id": "mat-film", "material_name": "film material",
                "properties": {"Ms": 600000, "Aex": 1e-11, "alpha": 0.5, "Dind": None, "Dbulk": None},
                "magnetization_ref": "mag-film", "magnetization_asset_sha256": material_hash,
            }
            payload["before"]["material_state"] = deepcopy(material_state)
            payload["after"]["material_state"] = deepcopy(material_state)
            payload["fdm_material_initial_state"] = deepcopy(material_state)
            before_cell = [2e-9, 1e-9, 2e-9]
            payload["fdm_cell_count"] = 1
            payload["fdm_cell_attempt_count"] = 1
            payload["ui_fdm_cell_proven"] = True
            payload["fdm_cell_receipt"] = {
                "method": "POST", "path": "/v2/sessions/current/model/transactions", "status": 200,
                "scope_header": scope,
                "payload": {"base_revision": 31, "kind": "merge_patch",
                    "merge_patch": {"study": {"fdm": {"default_cell": [1e-9, 2e-9, 2e-9]}}}},
                "before_scene_revision": 31, "before_cell": before_cell, "acknowledged": True,
                "transaction_kind": "merge_patch", "scene_revision": 32,
                "after_cell": [1e-9, 2e-9, 2e-9],
                "unmodified_scene_sha256_before": "e" * 64,
                "unmodified_scene_sha256_after": "e" * 64,
            }
            payload["grid_refresh_count"] = 1
            payload["grid_refresh_attempt_count"] = 1
            payload["ui_grid_refresh_proven"] = True
            payload["grid_refresh_receipt"] = {
                "method": "POST", "path": "/v2/sessions/current/simulation/commands", "status": 202,
                "scope_header": scope,
                "payload": {"client_intent_id": "fdm-grid-refresh-1799000000000-1",
                    "kind": "fdm_grid_refresh", "precondition": {"scene_revision": 32},
                    "reason": "study_global_commit"},
                "accepted": True, "command_id": "grid-refresh-1",
                "terminal_detail": {"command_id": "grid-refresh-1", "kind": "fdm_grid_refresh",
                    "status": "completed", "completion_status": "completed",
                    "client_intent_id": "fdm-grid-refresh-1799000000000-1",
                    "reason": "study_global_commit", "seq": 17},
                "domain_transition": {"before_domain_cell_count": 8,
                    "before_domain_generation_id": "fdm-domain-8",
                    "ready_domain_cell_count": 16, "ready_domain_generation_id": "fdm-domain-16",
                    "scene_revision": 32, "preserved_run_id": previous_run,
                    "preserved_result_identities": deepcopy(before_results)},
            }
            payload["request_counts"]["POST /v2/sessions/current/model/transactions"] = 1
            payload["request_counts"]["GET /v2/sessions/current/simulation/commands/grid-refresh-1"] = 1
            payload["total_requests"] = sum(payload["request_counts"].values())
        return payload

    def texture_result_fixture(self, mode, sources):
        if mode not in {"texture-stage-b", "texture-study"}:
            raise ValueError(mode)
        base_mode = "stage-b" if mode == "texture-stage-b" else "study"
        payload = self.result_fixture(base_mode, sources)
        qa = self.qa
        payload["mode"] = mode
        scene_revision = 40
        domain_id = "fdm-domain-16"
        precondition = payload["before"]["precondition"]
        precondition["scene_revision"] = scene_revision
        precondition["mesh_revision"] = 19
        precondition["domain_generation_id"] = domain_id
        payload["command_receipt"]["payload"]["precondition"] = deepcopy(precondition)
        for snapshot in (payload["before"], payload["after"]):
            snapshot["profile"]["domain_cell_count"] = 16
            snapshot["profile"]["domain_generation_id"] = domain_id
            snapshot["scene_profile"] = qa._expected_study_stage_scene_profile(
                pipeline_version="study_pipeline.v2", texture_object_id="film")
        payload["reload_proof"]["canvas"]["fdm_model_count"] = 16

        baseline = {
            "material": {
                "object_id": "film", "material_id": "mat-film", "material_name": "film material",
                "properties": {"Ms": 600000, "Aex": 1e-11, "alpha": 0.5, "Dind": None, "Dbulk": None},
                "magnetization_ref": "mag-film", "magnetization_asset_sha256": "d" * 64,
            },
            "default_cell": [1e-9, 2e-9, 2e-9],
            "global_m0": {"object_id": "film", "magnetization_ref": "mag-film", "asset_sha256": "d" * 64,
                           "preset_kind": "uniform", "direction": [1, 0, 0]},
        }
        source_stage = "relax-a" if mode == "texture-stage-b" else "relax-b"
        source_identity = next(item for item in payload["before"]["result_identities"]
                               if item["authored_stage_id"] == source_stage)
        source_proof = {
            "authored_stage_id": source_stage, "object_id": "film", "run_id": "run-before",
            "artifact_id": source_identity["artifact_id"], "artifact_sha256": source_identity["artifact_sha256"],
            "codec_id": source_identity["codec_id"], "codec_version": source_identity["codec_version"],
            "authored_relation": "matching_authored_input", "domain_relation": "matching_published_layout",
            "supports_magnetization_input": True,
        }
        reset = {"stage_id": "relax-b", "object_id": "film", "scope": "object", "initializer": None}
        for snapshot in (payload["before"], payload["after"]):
            snapshot["texture_state"] = deepcopy(reset)
            snapshot["texture_baseline_state"] = deepcopy(baseline)
            snapshot["texture_source_proof"] = deepcopy(source_proof)
        payload["texture_source_proof"] = source_proof
        payload["texture_baseline_state"] = baseline

        command = payload["command_receipt"]["payload"]
        if mode == "texture-stage-b":
            command["initial_state"] = {"kind": "authored_initial_state", "source": {
                "kind": "stage", "scene_revision": scene_revision, "stage_id": "relax-b"}}
            payload["command_receipt"]["idempotency_key"] = command["client_intent_id"]
        else:
            payload["command_receipt"]["idempotency_key"] = command["client_intent_id"]

        payload["texture_transaction_count"] = 0
        payload["texture_transaction_attempt_count"] = 0
        payload["texture_receipt"] = None
        payload["ui_texture_proven"] = False
        if mode == "texture-stage-b":
            pipeline = {
                "version": "study_pipeline.v1",
                "nodes": [
                    {"enabled": True, "id": "relax-a", "label": "Relax 1", "node_kind": "primitive",
                     "source": "script_imported", "stage_kind": "relax", "payload": {
                        "adaptive_timestep": None, "demag_interval_s": "", "energy_tolerance": "",
                        "entrypoint_kind": "flat_relax", "fixed_timestep": "1e-13", "integrator": "rk23",
                        "kind": "relax", "max_relaxation_time_s": "", "max_steps": "10",
                        "relax_algorithm": "llg_overdamped", "stage_id": "relax-a",
                        "torque_tolerance": "0.0001", "until_seconds": ""}},
                    {"enabled": True, "id": "relax-b", "label": "Relax 2", "node_kind": "primitive",
                     "source": "script_imported", "stage_kind": "relax", "payload": {
                        "energy_tolerance": "", "entrypoint_kind": "flat_relax", "kind": "relax",
                        "max_steps": "1", "relax_algorithm": "projected_gradient_bb", "stage_id": "relax-b",
                        "torque_tolerance": "0.0001", "until_seconds": ""}},
                    {"enabled": True, "id": "relax-c", "label": "Relax 3", "node_kind": "primitive",
                     "source": "script_imported", "stage_kind": "relax", "payload": {
                        "energy_tolerance": "", "entrypoint_kind": "flat_relax", "kind": "relax",
                        "max_steps": "1", "relax_algorithm": "nonlinear_cg", "stage_id": "relax-c",
                        "torque_tolerance": "0.0001", "until_seconds": ""}},
                ],
            }
            scene_before = {
                "revision": scene_revision - 1,
                "objects": [{"id": "film", "name": "film", "role": "magnet", "material_ref": "mat-film",
                             "magnetization_ref": "mag-film"}],
                "materials": [{"id": "mat-film", "name": "film material", "properties": deepcopy(baseline["material"]["properties"])}],
                "magnetization_assets": [{"id": "mag-film", "kind": "preset_texture", "preset_kind": "uniform",
                                          "preset_params": {"direction": [1, 0, 0]}}],
                "study": {"requested_backend": "fdm", "requested_device": "cpu", "requested_precision": "double",
                          "fdm": {"default_cell": [1e-9, 2e-9, 2e-9]}, "study_pipeline": pipeline},
            }
            expected_pipeline = deepcopy(pipeline)
            expected_pipeline["version"] = "study_pipeline.v2"
            expected_pipeline["nodes"][1]["payload"]["stage_magnetization_assignments"] = {
                "schema_version": "fullmag.magnetization-assignments.v1",
                "assignments": [{"object_id": "film", "region_id": None, "initializer": None}],
            }
            tx_request = {"kind": "merge_patch", "base_revision": scene_revision - 1,
                          "merge_patch": {"study": {"study_pipeline": expected_pipeline}}}
            committed = deepcopy(scene_before)
            committed["revision"] = scene_revision
            committed["study"]["study_pipeline"] = expected_pipeline
            payload["texture_transaction_count"] = 1
            payload["texture_transaction_attempt_count"] = 1
            payload["ui_texture_proven"] = True
            payload["texture_receipt"] = {
                "method": "POST", "path": "/v2/sessions/current/model/transactions",
                "scope_header": payload["command_receipt"]["scope_header"], "status": 200,
                "payload": tx_request, "scene_before": scene_before,
                "acknowledgement": {"transaction_kind": "merge_patch", "scene_revision": scene_revision,
                                    "committed_scene": committed},
                "helper_ack": {"sceneRevision": scene_revision, "stageId": "relax-b", "objectId": "film"},
                "ui_saved_ack_proven": True, "ui_saved_ack_text": "Saved stage relax-b.",
            }
            payload["request_counts"]["POST /v2/sessions/current/model/transactions"] = 1

        old_results_path = "GET /v2/sessions/current/simulation/stages/results?run_id=run-before&limit=100"
        new_results_path = "GET /v2/sessions/current/simulation/stages/results?run_id=run-after&limit=100"
        payload["request_counts"][old_results_path] = 8 if mode == "texture-stage-b" else 6
        payload["request_counts"][new_results_path] = 2
        payload["read_counts"]["stage_results"] = 10 if mode == "texture-stage-b" else 8
        payload["total_requests"] = sum(payload["request_counts"].values())
        return payload

    def test_terminal_scope_keeps_authored_rows_but_requires_only_selected_execution(self):
        import shutil
        node = shutil.which("node")
        self.assertIsNotNone(node)
        source = ROOT / "apps/control-room/scripts/check-study-stage-rerun-browser.mjs"
        javascript = """
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {studyStageTerminalScope: scope} = await import(process.argv[1]);
const ids=['relax-a','relax-b','relax-c'];
const e={total_stages:3,stage_statuses:['pending','completed','pending'],completed_stage_indexes:[1],
  stages:ids.map((stage_id,index)=>({stage_id,index,status:index===1?'completed':'pending'}))};
assert.deepEqual(scope(e,ids,['relax-b']),['relax-b']);
const extra=structuredClone(e); extra.stage_statuses[0]='completed';
assert.throws(()=>scope(extra,ids,['relax-b']));
const metadata=structuredClone(e); metadata.stages[0].started_at_unix_ms=42;
assert.throws(()=>scope(metadata,ids,['relax-b']));
const wrong=structuredClone(e); wrong.completed_stage_indexes=[0];
assert.throws(()=>scope(wrong,ids,['relax-b']));
"""
        result = subprocess.run([node, "--input-type=module", "-e", javascript, source.as_uri()],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_managed_compose_pins_one_fixed_stage_or_study_runner(self):
        qa = self.qa
        identity = {
            "project_name": "fullmag-worktree-fixture",
            "network_name": "fullmag-worktree-fixture_fullmag",
            "project_id": "fullmag",
            "worktree_id": "fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        sources = self.sources(qa)
        for mode in ("stage-b", "study"):
            document = qa._compose_document(
                ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3242, 180,
                study_stage_rerun=mode, study_stage_rerun_source_sha256=sources,
            )
            service = document["services"]["browser-qa"]
            self.assertEqual(service["command"], [
                "node", "/state/development/workspace/apps/control-room/scripts/check-study-stage-rerun-browser.mjs",
                mode,
            ])
            self.assertEqual(service["environment"]["CONTROL_ROOM_BROWSER_QA_SCENARIO"], "study-stage-rerun")
            self.assertEqual(service["environment"]["CONTROL_ROOM_STUDY_STAGE_RERUN_MODE"], mode)
            self.assertEqual(json.loads(service["environment"]["CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256"]), sources)
            self.assertTrue(service["read_only"])
            self.assertTrue(all(mount["read_only"] for mount in service["volumes"]))
            mounts = {mount["target"]: mount for mount in service["volumes"]}
            self.assertEqual(set(mounts), {
                "/state/development",
                "/state/development/workspace/apps/control-room/scripts",
                qa.STUDY_STAGE_RERUN_SRC_TARGET,
                qa.STUDY_STAGE_RERUN_FIXTURE_TARGET,
            })
            self.assertEqual(mounts[qa.STUDY_STAGE_RERUN_SRC_TARGET]["source"], str(ROOT / "apps/control-room/src"))
            self.assertEqual(mounts[qa.STUDY_STAGE_RERUN_FIXTURE_TARGET]["source"],
                             str(ROOT / qa.STUDY_STAGE_RERUN_SOURCES["fixture"]))
            self.assertNotIn("ports", service)
        with self.assertRaises(qa.BuildControlError):
            qa._compose_document(
                ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3242, 180,
                study_stage_rerun="compute-anything", study_stage_rerun_source_sha256=sources,
            )
        for options in (
            {"canvas_only": False},
            {"prepare_viewport_fixture": True},
            {"airbox_inspector": True},
            {"inspector_ack": True},
            {"saved_playback_item_id": "4", "source_script_sha256": "b" * 64},
            {"expect_run_performance": True},
        ):
            with self.subTest(options=options), self.assertRaises(qa.BuildControlError):
                qa._compose_document(
                    ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3242, 180,
                    study_stage_rerun="stage-b", study_stage_rerun_source_sha256=sources, **options,
                )

    def test_result_validator_requires_exact_target_terminal_scope_and_old_history(self):
        qa = self.qa
        for mode in ("stage-b", "study", "material-stage-a", "fdm-cell-study"):
            sources = qa._study_stage_rerun_source_sha256(ROOT, mode)
            payload = self.result_fixture(mode, sources)
            parsed = qa._parse_study_stage_rerun_result(
                json.dumps(payload).encode(), payload["public_url"], payload["probe_url"], sources, mode,
            )
            self.assertEqual(parsed, payload)
            bad_cases = (
                ("mode", lambda item: item.update(mode="study" if mode == "stage-b" else "stage-b")),
                ("source drift", lambda item: item.update(source_sha256_after={**sources, "runner": "b" * 64})),
                ("collapsed authored rows", lambda item: item["after"].update(authored_stage_ids=["relax-b"])),
                ("missing public statuses", lambda item: item["after"].pop("stage_statuses")),
                ("wrong completed index", lambda item: item["after"].update(
                    completed_stage_indexes=[1] if mode == "material-stage-a" else [0])),
                ("missing reload", lambda item: item.pop("reload_proof")),
                ("reload foreign run", lambda item: item["reload_proof"].update(run_id="foreign")),
                ("reload foreign route", lambda item: item["reload_proof"].update(path="/session/foreign-session")),
                ("reload generic route", lambda item: item["reload_proof"].update(path="/workspace")),
                ("reload duplicate submit", lambda item: item["reload_proof"].update(command_attempt_count=2)),
                ("reload history lost", lambda item: item["reload_proof"].update(history_identity_preserved=False)),
                ("reload context lost", lambda item: item["reload_proof"]["canvas"].update(context_lost=True)),
                ("reload empty canvas", lambda item: item["reload_proof"]["canvas"].update(drawing_buffer_width=0)),
                ("reload wrong domain", lambda item: item["reload_proof"]["canvas"].update(
                    fdm_model_count=8 if mode == "fdm-cell-study" else 16)),
                ("duplicate command", lambda item: item.update(command_count=2)),
                ("duplicate command attempt", lambda item: item.update(command_attempt_count=2)),
                ("background command", lambda item: item.update(ui_command_proven=False)),
                ("wrong target", lambda item: item["command_receipt"]["payload"]["target"].update(
                    stage_id="relax-a" if mode == "stage-b" else "relax-b")),
                ("foreign run binding", lambda item: item["command_receipt"]["execution_binding"].update(
                    run_id="foreign-run")),
                ("wrong step binding", lambda item: item["command_receipt"]["execution_binding"].update(
                    step_id="relax-a" if mode == "stage-b" else "relax-b")),
                ("edited requested scene", lambda item: item["before"]["scene_profile"].update(
                    requested_device="cuda")),
                ("wrong scope", lambda item: item["command_receipt"].update(scope_header="session=foreign")),
                ("stale precondition", lambda item: item["command_receipt"]["payload"]["precondition"].update(mesh_revision=17)),
                ("changed old history", lambda item: item["after"]["preserved_prior_result_identities"][0].update(
                    artifact_sha256="f" * 64)),
                ("incomplete terminal", lambda item: item["after"].update(run_status="running")),
                ("unexpected stage-control precondition", lambda item: (
                    item["before"]["precondition"].update(stage_execution_revision=27),
                    item["command_receipt"]["payload"]["precondition"].update(stage_execution_revision=27),
                )),
                ("native claim", lambda item: item.update(native_execution_proven=True)),
                ("field claim", lambda item: item.update(field_data_proven=True)),
                ("result shape", lambda item: item["after"]["result_identities"].pop()),
            )
            if mode == "material-stage-a":
                bad_cases += (
                    ("material edit missing", lambda item: item.update(material_receipt=None)),
                    ("material duplicate", lambda item: item.update(material_attempt_count=2)),
                    ("material target changed", lambda item: item["material_receipt"]["material_after"].update(
                        material_id="foreign-material")),
                    ("material alpha changed", lambda item: item["material_receipt"]["material_after"]
                     ["properties"].update(alpha=0.7)),
                    ("material texture changed", lambda item: item["material_receipt"].update(
                        unmodified_scene_sha256_after="f" * 64)),
                )
            if mode == "fdm-cell-study":
                bad_cases += (
                    ("missing FDM cell receipt", lambda item: item.update(fdm_cell_receipt=None)),
                    ("wrong FDM cell target", lambda item: item["fdm_cell_receipt"]["payload"]
                     ["merge_patch"]["study"]["fdm"].update(default_cell=[2e-9, 2e-9, 2e-9])),
                    ("extra FDM scene field", lambda item: item["fdm_cell_receipt"]["payload"]
                     ["merge_patch"]["study"].update(title="unexpected")),
                    ("wrong FDM base revision", lambda item: item["fdm_cell_receipt"]["payload"]
                     .update(base_revision=30)),
                    ("missing grid refresh receipt", lambda item: item.update(grid_refresh_receipt=None)),
                    ("wrong refresh reason", lambda item: item["grid_refresh_receipt"]["payload"]
                     .update(reason="user_requested")),
                    ("duplicate refresh attempt", lambda item: item.update(grid_refresh_attempt_count=2)),
                    ("wrong ready domain", lambda item: item["grid_refresh_receipt"]["domain_transition"]
                     .update(ready_domain_cell_count=8)),
                    ("lost A history at refresh", lambda item: item["grid_refresh_receipt"]["domain_transition"]
                     .update(preserved_result_identities=[])),
                    ("wrong material baseline", lambda item: item["before"]["material_state"]
                     ["properties"].update(Ms=800000)),
                    ("wrong reload domain", lambda item: item["reload_proof"]["canvas"]
                     .update(fdm_model_count=8)),
                )
            for name, mutate in bad_cases:
                with self.subTest(mode=mode, reason=name):
                    invalid = deepcopy(payload)
                    mutate(invalid)
                    with self.assertRaises(qa.BuildControlError):
                        qa._parse_study_stage_rerun_result(
                            json.dumps(invalid).encode(), payload["public_url"], payload["probe_url"], sources, mode,
                        )

    def test_fdm_cell_study_unknown_outcomes_retain_receipts_without_replaying_compute(self):
        qa = self.qa
        mode = "fdm-cell-study"
        sources = qa._study_stage_rerun_source_sha256(ROOT, mode)
        payload = self.result_fixture(mode, sources)
        payload.update(
            state="outcome-unknown", outcome="unknown",
            failure="Grid is ready but the Compute Study action was not observed",
            phase="fdm-grid-ready", command_receipt=None, command_count=0,
            command_attempt_count=0, ui_command_proven=False, after=None,
            reload_proof=None, history_identity_preserved=None, public_terminal_proven=False,
            client_ack_count=0,
        )
        payload["request_counts"]["POST /v2/sessions/current/simulation/commands"] = 1
        payload["request_counts"].pop(
            "GET /v2/sessions/current/simulation/stages/results?run_id=run-after&limit=100")
        payload["total_requests"] = sum(payload["request_counts"].values())
        self.assertEqual(qa._parse_study_stage_rerun_result(
            json.dumps(payload).encode(), payload["public_url"], payload["probe_url"], sources, mode), payload)
        for name, mutate in (
            ("compute secretly dispatched", lambda item: item["request_counts"].update(
                {qa.STUDY_FDM_GRID_REFRESH_KEY: 2})),
            ("cell transaction duplicated", lambda item: item.update(fdm_cell_attempt_count=2)),
            ("grid refresh duplicated", lambda item: item.update(grid_refresh_attempt_count=2)),
            ("A history not preserved", lambda item: item["grid_refresh_receipt"]["domain_transition"]
             .update(preserved_result_identities=[])),
            ("wrong ready generation", lambda item: item["before"]["profile"]
             .update(domain_generation_id="foreign-domain")),
        ):
            invalid = deepcopy(payload)
            mutate(invalid)
            invalid["total_requests"] = sum(invalid["request_counts"].values())
            with self.subTest(name=name), self.assertRaises(qa.BuildControlError):
                qa._parse_study_stage_rerun_result(
                    json.dumps(invalid).encode(), invalid["public_url"], invalid["probe_url"], sources, mode)

        dispatched = self.result_fixture(mode, sources)
        dispatched.update(
            state="outcome-unknown", outcome="unknown",
            failure="Compute Study response timed out after dispatch",
            after=None, reload_proof=None, history_identity_preserved=None,
            public_terminal_proven=False,
        )
        dispatched["command_receipt"]["status"] = 503
        dispatched["command_receipt"].pop("execution_binding")
        dispatched["read_counts"].update({
            "status": 3, "current_session": 3, "scene": 3, "commands": 3,
            "current_run": 3, "stage_execution": 3, "solver_status": 3,
        })
        dispatched["request_counts"].pop(
            "GET /v2/sessions/current/simulation/stages/results?run_id=run-after&limit=100")
        dispatched["total_requests"] = sum(dispatched["request_counts"].values())
        self.assertEqual(qa._parse_study_stage_rerun_result(
            json.dumps(dispatched).encode(), dispatched["public_url"], dispatched["probe_url"], sources, mode),
            dispatched)

    def test_camera_autosave_is_scoped_bounded_and_cannot_carry_model_edits(self):
        qa = self.qa
        sources = self.sources(qa)
        payload = self.result_fixture("stage-b", sources)
        camera = {"fov_degrees": 45, "orthographic_scale": None, "position": [1, 2, 3],
                  "projection": "perspective", "target": [0, 0, 0], "up": [0, 1, 0]}
        receipt = {"method": "PATCH", "path": "/v2/sessions/current/visualization/state",
                   "scope_header": payload["command_receipt"]["scope_header"], "payload": {"camera": camera}}
        key = "PATCH /v2/sessions/current/visualization/state"
        payload["camera_patch_receipts"] = [receipt]
        payload["request_counts"][key] = 1
        payload["total_requests"] += 1
        self.assertEqual(qa._parse_study_stage_rerun_result(
            json.dumps(payload).encode(), payload["public_url"], payload["probe_url"], sources, "stage-b"), payload)
        for name, change in (
            ("foreign scope", lambda x: x["camera_patch_receipts"][0].update(scope_header="foreign")),
            ("material smuggled", lambda x: x["camera_patch_receipts"][0]["payload"].update(material={})),
            ("unknown camera field", lambda x: x["camera_patch_receipts"][0]["payload"]["camera"].update(extra=1)),
            ("nonfinite coordinate", lambda x: x["camera_patch_receipts"][0]["payload"]["camera"].update(up=[0, float("nan"), 0])),
            ("invalid projection", lambda x: x["camera_patch_receipts"][0]["payload"]["camera"].update(projection="invalid")),
            ("unreported write", lambda x: x.update(camera_patch_receipts=[])),
            ("over budget", lambda x: x.update(camera_patch_receipts=[receipt] * 5,
                request_counts={**x["request_counts"], key: 5}, total_requests=x["total_requests"] + 4)),
        ):
            value = deepcopy(payload)
            change(value)
            with self.subTest(name=name), self.assertRaises(qa.BuildControlError):
                qa._parse_study_stage_rerun_result(json.dumps(value).encode(), value["public_url"],
                    value["probe_url"], sources, "stage-b")

    def test_post_dispatch_unknown_is_retained_without_claiming_terminal_or_history(self):
        qa = self.qa
        sources = self.sources(qa)
        payload = self.result_fixture("stage-b", sources)
        payload.update(
            state="outcome-unknown",
            failure="The command response timed out after dispatch",
            outcome="unknown",
            after=None,
            history_identity_preserved=None,
            public_terminal_proven=False,
        )
        payload["command_receipt"]["status"] = 503
        payload["command_receipt"].pop("execution_binding")
        for key in ("status", "current_session", "scene", "commands", "current_run", "stage_execution", "solver_status"):
            payload["read_counts"][key] = 3
        payload["request_counts"] = {
            "GET /v2/sessions/current/status": 3,
            "GET /v2/sessions/current": 3,
            "GET /v2/sessions/current/model/scene": 3,
            "GET /v2/sessions/current/simulation/commands": 3,
            "GET /v2/sessions/current/simulation/runs/current": 3,
            "GET /v2/sessions/current/simulation/stages/execution": 3,
            "GET /v2/sessions/current/simulation/solver/status": 3,
            "GET /v2/sessions/current/simulation/stages/results?run_id=run-before&limit=100": 3,
            "POST /v2/sessions/current/simulation/commands": 1,
        }
        payload["total_requests"] = sum(payload["request_counts"].values())
        self.assertEqual(
            qa._parse_study_stage_rerun_result(
                json.dumps(payload).encode(), payload["public_url"], payload["probe_url"], sources, "stage-b",
            ),
            payload,
        )
        for name, mutate in (
            ("fabricated after state", lambda value: value.update(after={})),
            ("claimed public terminal", lambda value: value.update(public_terminal_proven=True)),
            ("claimed history preservation", lambda value: value.update(history_identity_preserved=True)),
            ("missing UI proof", lambda value: value.update(ui_command_proven=False)),
            ("duplicate POST", lambda value: value["request_counts"].update(
                {"POST /v2/sessions/current/simulation/commands": 2})),
            ("foreign target binding", lambda value: value["command_receipt"].update(execution_binding={
                "requested_target": {"kind": "stage_id", "stage_id": "relax-a"},
                "run_id": "possible-run", "step_id": "relax-b",
            })),
        ):
            with self.subTest(rejected=name):
                invalid = deepcopy(payload)
                mutate(invalid)
                invalid["total_requests"] = sum(invalid["request_counts"].values())
                with self.assertRaises(qa.BuildControlError):
                    qa._parse_study_stage_rerun_result(
                        json.dumps(invalid).encode(), payload["public_url"], payload["probe_url"], sources, "stage-b",
                    )

    def test_parse_error_is_unknown_unless_complete_pinned_output_proves_no_dispatch(self):
        qa = self.qa
        sources = self.sources(qa)
        result = {
            "schema": qa.STUDY_STAGE_RERUN_RESULT_SCHEMA,
            "scenario": "study-stage-rerun",
            "mode": "stage-b",
            "state": "failed",
            "outcome": "not-dispatched",
            "failure": "Preflight stopped before opening the command menu",
            "public_url": "http://127.0.0.1:3242",
            "probe_url": "http://frontend:8080",
            "playwright_version": qa.PLAYWRIGHT_VERSION,
            "browser_gpu_mode": "swiftshader-webgl-requested",
            "source_sha256_before": sources,
            "source_sha256_after": sources,
            "session_before": None,
            "session_after": None,
            "before": None,
            "command_receipt": None,
            "command_count": 0,
            "command_attempt_count": 0,
            "client_ack_count": 0,
            "ui_command_proven": False,
            "after": None,
            "history_identity_preserved": None,
            "public_terminal_proven": False,
            "native_execution_proven": False,
            "field_data_proven": False,
            "read_counts": {
                "status": 0, "current_session": 0, "scene": 0, "commands": 0, "current_run": 0,
                "stage_execution": 0, "solver_status": 0, "stage_results": 0, "command_details": 0,
            },
            "request_counts": {},
            "total_requests": 0,
            "request_limit": 512,
            "request_path_limit": 128,
            "per_path_read_limit": 128,
            "violations": [],
            "errors": [],
            "proxy_failures": [],
        }
        encoded = (json.dumps(result) + "\n").encode()
        self.assertTrue(qa._study_stage_no_dispatch_proven(encoded, sources, "stage-b"))
        fdm_sources = qa._study_stage_rerun_source_sha256(ROOT, "fdm-cell-study")
        fdm_no_dispatch = deepcopy(result)
        fdm_no_dispatch.update(mode="fdm-cell-study", source_sha256_before=fdm_sources,
                               source_sha256_after=fdm_sources, fdm_cell_receipt=None,
                               fdm_cell_count=0, fdm_cell_attempt_count=0, ui_fdm_cell_proven=False,
                               material_receipt=None, material_count=0, material_attempt_count=0,
                               ui_material_proven=False, fdm_material_initial_state=None,
                               grid_refresh_receipt=None, grid_refresh_count=0,
                               grid_refresh_attempt_count=0, ui_grid_refresh_proven=False)
        self.assertTrue(qa._study_stage_no_dispatch_proven(
            (json.dumps(fdm_no_dispatch) + "\n").encode(), fdm_sources, "fdm-cell-study"))
        fdm_dispatched = deepcopy(fdm_no_dispatch)
        fdm_dispatched.update(fdm_cell_count=1, fdm_cell_attempt_count=1,
                              ui_fdm_cell_proven=True, fdm_cell_receipt={"acknowledged": False})
        self.assertFalse(qa._study_stage_no_dispatch_proven(
            (json.dumps(fdm_dispatched) + "\n").encode(), fdm_sources, "fdm-cell-study"))
        for name, raw in (
            ("missing output", b""),
            ("truncated JSON", encoded[:len(encoded) // 2]),
            ("malformed JSON", b"{not-json}\n"),
            ("oversized output", b" " * (qa.MAX_RESULT_BYTES + 1)),
        ):
            with self.subTest(incomplete=name):
                self.assertFalse(qa._study_stage_no_dispatch_proven(raw, sources, "stage-b"))
        for name, mutate in (
            ("source drift", lambda value: value.update(source_sha256_after={**sources, "runner": "b" * 64})),
            ("wrong mode", lambda value: value.update(mode="study")),
            ("command count", lambda value: value.update(command_count=1)),
            ("UI dispatch marker", lambda value: value.update(ui_command_proven=True)),
            ("command receipt", lambda value: value.update(command_receipt={"method": "POST"})),
            ("forwarded command inventory", lambda value: value.update(request_counts={
                "POST /v2/sessions/current/simulation/commands": 1,
            }, total_requests=1)),
        ):
            with self.subTest(rejected=name):
                invalid = deepcopy(result)
                mutate(invalid)
                self.assertFalse(
                    qa._study_stage_no_dispatch_proven(
                        (json.dumps(invalid) + "\n").encode(), sources, "stage-b",
                    )
                )

    def test_new_mode_helper_inspect_refuses_command_or_pin_substitution(self):
        qa = self.qa
        identity = {"project_name": "fullmag-worktree-fixture", "network_name": "fullmag-worktree-fixture_fullmag",
                    "project_id": "fullmag", "worktree_id": "fixture", "checkout_kind": "worktree", "source_root": str(ROOT)}
        sources = self.sources(qa)
        document = qa._compose_document(
            ROOT, identity, qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-state", 3242, 180,
            study_stage_rerun="stage-b", study_stage_rerun_source_sha256=sources,
        )
        service = document["services"]["browser-qa"]
        helper = {
            "Image": "sha256:" + "c" * 64,
            "Config": {
                "User": "65532:65532", "Cmd": service["command"],
                "Env": [f"{key}={value}" for key, value in service["environment"].items()],
                "Labels": {**qa.source_labels(identity), "com.docker.compose.project": identity["project_name"],
                           "com.docker.compose.service": "browser-qa"},
            },
            "HostConfig": {"GroupAdd": qa._script_bind_groups(ROOT), "ReadonlyRootfs": True,
                           "NetworkMode": identity["network_name"], "PortBindings": None,
                           "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=256m"}, "CapDrop": ["ALL"],
                           "SecurityOpt": ["no-new-privileges:true"], "ExtraHosts": None,
                           "Mounts": [
                               {"Type": "volume", "Source": "fullmag-frontend-state", "Target": "/state/development",
                                "ReadOnly": True},
                               {"Type": "bind", "Source": str(ROOT / "apps/control-room/scripts"),
                                "Target": "/state/development/workspace/apps/control-room/scripts", "ReadOnly": True},
                               {"Type": "bind", "Source": str(ROOT / "apps/control-room/src"),
                                "Target": qa.STUDY_STAGE_RERUN_SRC_TARGET, "ReadOnly": True},
                               {"Type": "bind", "Source": str(ROOT / qa.STUDY_STAGE_RERUN_SOURCES["fixture"]),
                                "Target": qa.STUDY_STAGE_RERUN_FIXTURE_TARGET, "ReadOnly": True},
                           ]},
            "State": {"Running": False, "ExitCode": 0},
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}, "Ports": {}},
            "Mounts": [
                {"Type": "volume", "Name": "fullmag-frontend-state", "Destination": "/state/development", "RW": False},
                {"Type": "bind", "Source": str(ROOT / "apps/control-room/scripts"),
                 "Destination": "/state/development/workspace/apps/control-room/scripts", "RW": False},
                {"Type": "bind", "Source": str(ROOT / "apps/control-room/src"),
                 "Destination": qa.STUDY_STAGE_RERUN_SRC_TARGET, "RW": False},
                {"Type": "bind", "Source": str(ROOT / qa.STUDY_STAGE_RERUN_SOURCES["fixture"]),
                 "Destination": qa.STUDY_STAGE_RERUN_FIXTURE_TARGET, "RW": False},
            ],
        }
        control = SimpleNamespace(project=identity["project_name"])
        qa._validate_browser_helper(
            helper, control, identity, "fullmag-frontend-state", helper["Image"], 0, ROOT,
            study_stage_rerun="stage-b", study_stage_rerun_source_sha256=sources,
        )
        for changed in ("command", "source-pin", "missing-src", "foreign-fixture", "writable-src", "unrequested"):
            altered = deepcopy(helper)
            if changed == "command":
                altered["Config"]["Cmd"][-1] = "study"
            if changed == "source-pin":
                altered["Config"]["Env"].append("CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256={}")
            if changed == "missing-src":
                altered["HostConfig"]["Mounts"].pop(2)
                altered["Mounts"].pop(2)
            if changed == "foreign-fixture":
                altered["HostConfig"]["Mounts"][3]["Source"] = "/foreign/p22-fixture.py"
                altered["Mounts"][3]["Source"] = "/foreign/p22-fixture.py"
            if changed == "writable-src":
                altered["HostConfig"]["Mounts"][2]["ReadOnly"] = False
                altered["Mounts"][2]["RW"] = True
            with self.subTest(changed=changed), self.assertRaises(qa.ControlOutcomeUnknown):
                qa._validate_browser_helper(
                    altered, control, identity, "fullmag-frontend-state", helper["Image"], 0, ROOT,
                    study_stage_rerun="stage-b" if changed != "unrequested" else None,
                    study_stage_rerun_source_sha256=sources if changed != "unrequested" else None,
                )

    def test_javascript_guard_allows_only_one_scoped_exact_command(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node is required for the study-stage-rerun pure guard contract")
        source = (ROOT / "apps/control-room/scripts/check-study-stage-rerun-browser.mjs").as_uri()
        javascript = r"""
import assert from 'node:assert/strict';
const runner = await import(process.argv[1]);
assert.deepEqual(runner.studyStageCommandForMode('stage-b'), {
  kind: 'relax', target: {kind:'stage_id', stage_id:'relax-b'},
  initial_state: {kind:'default_for_target'},
});
assert.deepEqual(runner.studyStageCommandForMode('study'), {
  kind: 'solve', target: {kind:'study'},
});
assert.throws(() => runner.studyStageCommandForMode('script'));
assert.deepEqual(runner.studyStageExpectedStageIds('stage-b', 'before'), ['relax-a','relax-b','relax-c']);
assert.deepEqual(runner.studyStageExpectedStageIds('stage-b', 'after'), ['relax-b']);
assert.deepEqual(runner.studyStageExpectedStageIds('study', 'before'), ['relax-b']);
assert.deepEqual(runner.studyStageExpectedStageIds('study', 'after'), ['relax-a','relax-b','relax-c']);
assert.deepEqual(runner.studyStageCommandResponseOutcome(202, {accepted:true,command_id:'cmd-1'}),
  {outcome:'accepted',command_id:'cmd-1'});
assert.deepEqual(runner.studyStageCommandResponseOutcome(503, {accepted:true,command_id:'cmd-1'}),
  {outcome:'unknown',command_id:null});
assert.deepEqual(runner.studyStageCommandResponseOutcome(202, {accepted:true}),
  {outcome:'unknown',command_id:null});
assert.equal(runner.studyStageExecutionBindingMatches({requested_target:{kind:'stage_id',stage_id:'relax-b'},
  run_id:'new',step_id:'relax-b'}, 'stage-b', 'new'), true);
assert.equal(runner.studyStageExecutionBindingMatches({requested_target:{kind:'stage_id',stage_id:'relax-b'},
  run_id:'foreign',step_id:'relax-b'}, 'stage-b', 'new'), false);
assert.equal(runner.studyStageExecutionBindingMatches({requested_target:{kind:'study'},run_id:'new'}, 'study', 'new'), true);
assert.equal(runner.studyStageExecutionBindingMatches({requested_target:{kind:'study'},run_id:'new',step_id:'relax-b'},
  'study', 'new'), false);
const node = (id, label, algorithm, maxSteps, first=false) => ({
  enabled:true,id,label,node_kind:'primitive',source:'script_imported',stage_kind:'relax',
  payload:{...(first ? {adaptive_timestep:null,demag_interval_s:'',fixed_timestep:'1e-13',integrator:'rk23',
    max_relaxation_time_s:''} : {}),energy_tolerance:'',entrypoint_kind:'flat_relax',kind:'relax',
    max_steps:maxSteps,relax_algorithm:algorithm,stage_id:id,torque_tolerance:'0.0001',until_seconds:''}
});
const makeScene = () => ({study:{requested_backend:'fdm',requested_device:'cpu',requested_precision:'double',
  study_pipeline:{version:'study_pipeline.v1',nodes:[node('relax-a','Relax 1','llg_overdamped','10',true),
    node('relax-b','Relax 2','projected_gradient_bb','1'),node('relax-c','Relax 3','nonlinear_cg','1')]}}});
assert.equal(runner.validateStudyStageScene(makeScene()).stages.length, 3);
const editedSteps = makeScene(); editedSteps.study.study_pipeline.nodes[1].payload.max_steps = '1000000000000';
assert.throws(() => runner.validateStudyStageScene(editedSteps));
const editedDevice = makeScene(); editedDevice.study.requested_device = 'cuda';
assert.throws(() => runner.validateStudyStageScene(editedDevice));
const extraNode = makeScene(); extraNode.study.study_pipeline.nodes.push(node('relax-d','Relax 4','nonlinear_cg','1'));
assert.throws(() => runner.validateStudyStageScene(extraNode));
const session = {name:'P22 three Relax stages', session_id:'s', session_epoch:'s@1', request_scope_epoch:'api:1'};
const scope = 'session=s&epoch=s%401&request_scope_epoch=api%3A1';
const precondition = {scene_revision:31, mesh_revision:18, domain_generation_id:'fdm-domain-8',
  current_run:{kind:'run',run_id:'old'}, runtime_state:'awaiting_command', command_revision:0,
  region_topology_revision:3, region_membership_revision:4,
  region_coefficients_revision:5, region_initial_state_revision:6};
const computeStatus = {run:{run_id:'old'},resources:{scene_revision:31,mesh_revision:18,
  domain_generation_id:'fdm-domain-8',region_topology_revision:3,region_membership_revision:4,
  region_coefficients_revision:5,region_initial_state_revision:6}};
assert.deepEqual(runner.studyStageComputePrecondition(computeStatus,{run_id:'old'},
  {runtime_state:'awaiting_command'},{commands:[]}),precondition);
assert.throws(() => runner.studyStageComputePrecondition(computeStatus,{run_id:'foreign'},
  {runtime_state:'awaiting_command'},{commands:[]}));
assert.throws(() => runner.studyStageComputePrecondition(computeStatus,{run_id:'old'},
  {runtime_state:'paused'},{commands:[]}));
const request = {method:'POST', path:'/v2/sessions/current/simulation/commands', scope,
  body:{...runner.studyStageCommandForMode('stage-b'), precondition, client_intent_id:'study:relax:test',
    reason:'user_requested', requested_at_unix_ms:1000}};
const context = {mode:'stage-b', session, expectedPrecondition:precondition, commandCount:0, phase:'ui-submit'};
assert.equal(runner.studyStageShouldReadTerminalResources({run:{run_id:'new'},solver:{state:'running'}}, 'new'), false);
assert.equal(runner.studyStageShouldReadTerminalResources({run:{run_id:'old'},solver:{state:'awaiting_command'}}, 'new'), false);
assert.equal(runner.studyStageShouldReadTerminalResources({run:{run_id:'new'},solver:{state:'awaiting_command'}}, 'new'), true);
const activeStatus = {session,lifecycle:{connectivity:'connected',session_resource:'active',commandability:'allowed'}};
assert.deepEqual(runner.readStudyStageSessionIdentity(activeStatus), session);
const runningStatus = {...activeStatus,lifecycle:{...activeStatus.lifecycle,commandability:'forbidden'}};
assert.throws(() => runner.readStudyStageSessionIdentity(runningStatus));
assert.deepEqual(runner.readStudyStageSessionIdentity(runningStatus,{requireCommandable:false}), session);
for (const invalid of [
  {...runningStatus,lifecycle:{...runningStatus.lifecycle,connectivity:'disconnected'}},
  {...runningStatus,lifecycle:{...runningStatus.lifecycle,session_resource:'inactive'}},
  {...runningStatus,session:{...session,request_scope_epoch:''}},
]) assert.throws(() => runner.readStudyStageSessionIdentity(invalid,{requireCommandable:false}));
const cameraRequest = {method:'PATCH',path:'/v2/sessions/current/visualization/state',scope,
  body:{camera:{fov_degrees:45,orthographic_scale:null,position:[1,2,3],projection:'perspective',
    target:[0,0,0],up:[0,1,0]}}};
assert.equal(runner.studyStageCameraPatchAllowed(cameraRequest, session), true);
for (const invalid of [
  {...cameraRequest, scope:'foreign'}, {...cameraRequest,method:'POST'},
  {...cameraRequest,path:cameraRequest.path+'?extra=1'},
  {...cameraRequest,body:{...cameraRequest.body,material:{}}},
  {...cameraRequest,body:{camera:{...cameraRequest.body.camera,extra:1}}},
  {...cameraRequest,body:{camera:{...cameraRequest.body.camera,position:[NaN,0,0]}}},
  {...cameraRequest,body:{camera:{...cameraRequest.body.camera,projection:'invalid'}}},
]) assert.equal(runner.studyStageCameraPatchAllowed(invalid, session), false);
assert.equal(runner.studyStageRerunRequestAllowed(request, context), true);
assert.equal(runner.studyStageRerunRequestAllowed(request, {...context, phase:'preflight'}), false);
assert.equal(runner.studyStageRerunRequestAllowed(request, {...context, commandCount:1}), false);
assert.equal(runner.studyStageRerunRequestAllowed({...request, scope:'session=other'}, context), false);
assert.equal(runner.studyStageRerunRequestAllowed({...request, body:{...request.body, target:{kind:'stage_id',stage_id:'relax-a'}}}, context), false);
assert.equal(runner.studyStageRerunRequestAllowed({...request, body:{...request.body, precondition:{...precondition, mesh_revision:17}}}, context), false);
assert.equal(runner.studyStageRerunRequestAllowed({...request, body:{...request.body, precondition:{...precondition, stage_execution_revision:27}}}, context), false);
"""
        result = subprocess.run(
            [node, "--input-type=module", "-e", javascript, source],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_just_dispatches_an_enum_and_quotes_source_without_executing_it(self):
        just = shutil.which("just")
        if just is None:
            self.skipTest("just is required for fixed managed dispatch coverage")
        source = "/tmp/p22 source;$(touch /tmp/should-not-run)"
        justfile = str(ROOT / "justfile")
        result = subprocess.run(
            [just, "--justfile", justfile, "--dry-run", "--verbose", "docker-dev-browser-qa",
             source, "", "", "180", "1800", "", "stage-b"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        rendered = result.stdout + result.stderr
        self.assertIn("--study-stage-rerun stage-b", rendered)
        self.assertIn("p22 source;$(touch /tmp/should-not-run)", rendered)
        self.assertFalse(Path("/tmp/should-not-run").exists())

        omitted = subprocess.run(
            [just, "--justfile", justfile, "--dry-run", "--verbose", "docker-dev-browser-qa",
             source, "", "", "180", "1800", ""],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(omitted.returncode, 0, omitted.stderr)
        self.assertNotIn("--study-stage-rerun", omitted.stdout + omitted.stderr)

        malformed = subprocess.run(
            [just, "--justfile", justfile, "--dry-run", "--verbose", "docker-dev-browser-qa",
             source, "", "", "180", "1800", "", "arbitrary"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(malformed.returncode, 0)


if __name__ == "__main__":
    unittest.main()
