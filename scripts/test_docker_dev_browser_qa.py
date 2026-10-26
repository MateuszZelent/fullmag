"""Contract and pure-validator regressions for the managed Docker DEV browser proof."""
from copy import deepcopy
from contextlib import ExitStack, contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import re
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


def _airbox_inspector_result_fixture(qa):
    public_url = "http://127.0.0.1:3269"
    browser_url = "http://frontend:8080"
    script_sha256 = "a" * 64
    expected_panels = [
        ("root", "model:airbox", "airbox.root", "Airbox", "Airbox Overview"),
        ("mesh", "model:airbox:mesh", "airbox.mesh", "Mesh", "Airbox Mesh Overview"),
        ("parameters", "model:airbox:mesh:parameters", "airbox.mesh.parameters", "Parameters", "Canonical Authored Parameters"),
        ("quality-gates", "model:airbox:mesh:quality-gates", "airbox.mesh.quality-gates", "Quality Gates", "Airbox Quality Gates"),
        ("statistics", "model:airbox:mesh:statistics", "airbox.mesh.statistics", "Statistics", "Airbox Mesh Statistics"),
        ("topology", "model:airbox:mesh:topology", "airbox.mesh.topology", "Topology", "Airbox Mesh Topology"),
        ("build", "model:airbox:mesh:build", "airbox.mesh.build", "Build & Provenance", "Airbox Mesh Build"),
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
        self.assertNotIn('port="32871"', recipe)
        self.assertNotIn("pnpm", recipe)
        self.assertNotIn("node ", recipe)
        shell = (ROOT / "scripts/just_storage_shell.sh").read_text(encoding="utf-8")
        self.assertIn('scripts/docker_dev_browser_qa.py', shell)
        self.assertIn('browser_qa_pattern=', shell)
        self.assertIn('--pull-timeout', shell)
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

    def test_control_volume_preflight_is_read_only_and_fail_closed_when_absent(self):
        qa = self.qa

        class FakeControl:
            volume = "fullmag-control-fixture"
            shared_labels = {"com.fullmag.compose.project": "fullmag-worktree-fixture"}

        missing = SimpleNamespace(returncode=1, stdout=b"", stderr=b"no such volume")
        with patch.object(qa, "docker_capture", return_value=missing) as daemon:
            with self.assertRaises(qa.BuildControlError):
                qa._validate_existing_control_volume(FakeControl())
        daemon.assert_called_once_with(
            "volume", "inspect", "fullmag-control-fixture", allow_failure=True, timeout=60
        )

    def test_frontend_volume_preflight_requires_deterministic_owned_labels(self):
        qa = self.qa
        inputs = {
            "schema": "fullmag.docker-development-inputs.v1",
            "dependency_seed_sha256": "a" * 64,
            "toolpins_sha256": "b" * 64,
        }
        key = hashlib.sha256(
            qa.canonical({"project": "fullmag-worktree-fixture", "dependencies": "a" * 64, "tools": "b" * 64})
        ).hexdigest()
        volume_name = "fullmag-dev-frontend-v1-" + key[:24]

        class FakeControl:
            project = "fullmag-worktree-fixture"
            labels = {
                "org.fullmag.compose.project": project,
                "org.fullmag.source.worktree-id": "fixture",
            }

        labels = {
            **FakeControl.labels,
            "org.fullmag.build.role": "frontend",
            "org.fullmag.build.cache-key": key,
        }
        observed = {"Name": volume_name, "Driver": "local", "Options": {}, "Labels": labels}
        with patch.object(
            qa,
            "docker_capture",
            return_value=SimpleNamespace(returncode=0, stdout=json.dumps([observed]).encode(), stderr=b""),
        ):
            qa._validate_frontend_volume(FakeControl(), volume_name, inputs)
        drifted = deepcopy(observed)
        drifted["Labels"]["org.fullmag.build.cache-key"] = "c" * 64
        with patch.object(
            qa,
            "docker_capture",
            return_value=SimpleNamespace(returncode=0, stdout=json.dumps([drifted]).encode(), stderr=b""),
        ):
            with self.assertRaises(qa.BuildControlError):
                qa._validate_frontend_volume(FakeControl(), volume_name, inputs)

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
        observed = {"Id": browser_id}
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
                    {"services": {}},
                    {"project_name": "fullmag-worktree-fixture"},
                    ROOT,
                    "fullmag-frontend-state",
                    browser_id,
                    "http://127.0.0.1:32871",
                    "http://frontend:8080",
                    180,
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
            "page_errors": 0,
            "console_errors": 0,
            "request_failures": 0,
            "http_errors": [],
            "viewport_dom_observations": {
                "field_data_proven": False,
                "note": self.qa.VIEWPORT_DOM_OBSERVATIONS_NOTE,
                "before_home": {
                    "dataset": {},
                    "quantity_labels": [],
                    "dataset_entry_count": 0,
                    "quantity_label_count": 0,
                    "dataset_truncated": False,
                    "quantity_labels_truncated": False,
                },
                "after_home": {
                    "dataset": {},
                    "quantity_labels": [],
                    "dataset_entry_count": 0,
                    "quantity_label_count": 0,
                    "dataset_truncated": False,
                    "quantity_labels_truncated": False,
                },
            },
            "resource_responses": [],
        }
        encoded = lambda value: (json.dumps(value) + "\n").encode("utf-8")
        self.assertEqual(self.qa._parse_result(encoded(payload), payload["public_url"], payload["probe_url"]), payload)
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
            'name: "Start"',
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
        self.assertIn("const captureCanvasScreenshot = async", text)
        live_field_result = text.split("...(expectedLiveField ? {", 1)[1].split("} : {}),", 1)[0]
        self.assertIn("canvas_screenshot: await captureCanvasScreenshot(page, after)", live_field_result)
        self.assertNotIn('http://127.0.0.1:32871', text.split("const publicUrl", 1)[1].split("const probeUrl", 1)[0])
        self.assertNotIn("CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION", text)

    def test_lock_and_managed_check_registration_are_pinned(self):
        lock = (ROOT / "pnpm-lock.yaml").read_text(encoding="utf-8")
        self.assertRegex(lock, r"playwright:\n\s+specifier: \^1\.60\.0\n\s+version: 1\.62\.1")
        self.assertIn("test_docker_dev_browser_qa", (ROOT / "scripts/docker_volume_checks.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
