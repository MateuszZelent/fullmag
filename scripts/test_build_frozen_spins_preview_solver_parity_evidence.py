import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_frozen_spins_preview_solver_parity_evidence import build_evidence


def receipt(lane: str) -> dict:
    identity = "a" * 64
    run_id = f"run-{lane}"
    render_path = {
        "fdm_cpu_reference": "fdm-cuboid-instance-colors",
        "fem_cpu_native": "fem-surface-vertex-colors",
    }[lane]
    constraint_id = "pin"
    rendered_ack = {
        "client_id": "browser-test",
        "client_label": "control-room",
        "viewport_id": "viewport-main",
        "revision": 1,
        "status": "rendered",
        "effective_render_mode": "surface",
        "received_at_unix_ms": 1,
    }
    return {
        "schema_version": "fullmag.frozen_spins.browser.quantity.evidence.v1",
        "status": "PASS",
        "run_id": run_id,
        "quantity": {
            "id": "frozen_spins",
            "shape": "spatial_scalar",
            "unit": "1",
            "location": "node",
        },
        "field_meta": {
            "quantity_id": "frozen_spins",
            "kind": "spatial_scalar",
            "components": 1,
            "location": "magnetic_only",
            "unit": "1",
            "field_revision": 1,
            "state": "complete",
            "resolved_capability": {
                "quantity_id": "frozen_spins",
                "provider": "available",
                "request": "field_vector",
                "materialization": "materialized",
                "render": "renderable",
                "publication": "interactive",
                "scope": "full",
                "lane": lane,
                "precision": "double",
                "carriers": [{
                    "carrier_id": f"{lane}:full",
                    "carrier_fingerprint": identity,
                    "scope": "full",
                    "scope_kind": "full",
                    "components": 1,
                    "indexing": "node",
                    "view": "magnitude",
                    "payload_state": "current",
                }],
            },
        },
        "authoring_workflow": {
            "constraint_id": constraint_id,
            "preview": {
                "preview_id": f"preview-{lane}",
                "authority": "speculative_authoring_preview",
                "solver_binding": "unbound",
                "source_state_revision": 7,
                "mask_sha256": f"sha256:{identity}",
                "reference_sha256": f"sha256:{identity}",
                "topology_fingerprint": f"sha256:{identity}",
                "frozen_site_count": 3,
                "free_site_count": 1,
            },
            "solve_command": {
                "command_id": f"command-{lane}",
                "kind": "solve",
                "status": "dispatched",
                "scene_revision": 3,
            },
            "solver_certificate": {
                "schema": "fullmag.frozen_spins.runtime-status.v1",
                "constraint_activation_epochs": {constraint_id: 1},
                "resolved_constraint_set_revision": 1,
                "source_state_revision": 7,
                "mask_sha256": identity,
                "reference_sha256": identity,
                "topology_fingerprint": f"sha256:{identity}",
                "active_site_count": 4,
                "frozen_site_count": 3,
                "free_site_count": 1,
                "active_constraint_ids": [constraint_id],
                "vector_dimension": 3,
                "scalar_component_dof_count": 12,
            },
            "rendered_ack": rendered_ack,
            "visualization_state": {
                "revision": 1,
                "active_quantity_id": "frozen_spins",
                "quantity": {
                    "active_quantity_id": "frozen_spins",
                    "field_component": "magnitude",
                },
                "diagnostics": {"warnings": [], "degraded_reasons": []},
            },
            "viewport": {
                "quantity_selected": True,
                "scalar_complete": True,
                "scalar_carrier_adopted": True,
                "degradation_none": True,
                "surface_ready": True,
                "render_path": render_path,
            },
        },
        "rendered_ack": rendered_ack,
        "webgl": {
            "found": True,
            "hasContext": True,
            "isContextLost": False,
            "width": 703,
            "height": 478,
        },
        "console_errors": [],
    }


class PreviewSolverParityEvidenceTests(unittest.TestCase):
    def write(self, root: Path, name: str, value: dict) -> Path:
        path = root / f"{value['run_id']}.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_builds_two_lane_positive_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [
                self.write(root, "fdm.json", receipt("fdm_cpu_reference")),
                self.write(root, "fem.json", receipt("fem_cpu_native")),
            ]
            evidence = build_evidence(paths)
        self.assertEqual(evidence["status"], "PASS")
        self.assertEqual(evidence["test_case_ids"], ["FS-P15-PREVIEW-SOLVER-PARITY"])
        self.assertEqual({lane["lane"] for lane in evidence["lanes"]}, {
            "fdm_cpu_reference", "fem_cpu_native"
        })

    def test_rejects_missing_or_mismatched_source_revision(self) -> None:
        for bad_value in (None, 0, 8):
            with self.subTest(bad_value=bad_value), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                fdm = receipt("fdm_cpu_reference")
                fdm["authoring_workflow"]["solver_certificate"]["source_state_revision"] = bad_value
                paths = [
                    self.write(root, "fdm.json", fdm),
                    self.write(root, "fem.json", receipt("fem_cpu_native")),
                ]
                with self.assertRaisesRegex(ValueError, "source_state_revision"):
                    build_evidence(paths)

    def test_rejects_identity_count_webgl_and_lane_substitution(self) -> None:
        mutations = []
        identity = receipt("fdm_cpu_reference")
        identity["authoring_workflow"]["solver_certificate"]["mask_sha256"] = "b" * 64
        mutations.append(identity)
        counts = receipt("fdm_cpu_reference")
        counts["authoring_workflow"]["solver_certificate"]["frozen_site_count"] = 2
        mutations.append(counts)
        webgl = receipt("fdm_cpu_reference")
        webgl["webgl"]["isContextLost"] = True
        mutations.append(webgl)
        for mutated in mutations:
            with self.subTest(mutated=mutated), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                paths = [
                    self.write(root, "fdm.json", mutated),
                    self.write(root, "fem.json", receipt("fem_cpu_native")),
                ]
                with self.assertRaises(ValueError):
                    build_evidence(paths)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            duplicate = receipt("fdm_cpu_reference")
            paths = [self.write(root, "a.json", duplicate), self.write(root, "b.json", copy.deepcopy(duplicate))]
            with self.assertRaisesRegex(ValueError, "required lanes"):
                build_evidence(paths)

    def test_rejects_weakened_browser_solver_and_render_proof(self) -> None:
        mutations = []
        schema = receipt("fdm_cpu_reference")
        schema["schema_version"] = "unknown"
        mutations.append(schema)
        ack = receipt("fdm_cpu_reference")
        ack["rendered_ack"]["status"] = "pending"
        ack["authoring_workflow"]["rendered_ack"]["status"] = "pending"
        mutations.append(ack)
        zero_webgl = receipt("fdm_cpu_reference")
        zero_webgl["webgl"]["width"] = 0
        mutations.append(zero_webgl)
        carrier = receipt("fdm_cpu_reference")
        carrier["field_meta"]["resolved_capability"]["carriers"][0]["payload_state"] = "stale"
        mutations.append(carrier)
        solver = receipt("fdm_cpu_reference")
        solver["authoring_workflow"]["solver_certificate"]["constraint_activation_epochs"] = {}
        mutations.append(solver)
        render_path = receipt("fdm_cpu_reference")
        render_path["authoring_workflow"]["viewport"]["render_path"] = "test"
        mutations.append(render_path)
        boolean_count = receipt("fdm_cpu_reference")
        boolean_count["authoring_workflow"]["preview"]["frozen_site_count"] = True
        mutations.append(boolean_count)

        for mutated in mutations:
            with self.subTest(mutated=mutated), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                paths = [
                    self.write(root, "fdm.json", mutated),
                    self.write(root, "fem.json", receipt("fem_cpu_native")),
                ]
                with self.assertRaises(ValueError):
                    build_evidence(paths)


if __name__ == "__main__":
    unittest.main()
