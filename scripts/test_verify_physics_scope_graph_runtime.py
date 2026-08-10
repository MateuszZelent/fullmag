from __future__ import annotations

import copy
import unittest

from scripts.verify_physics_scope_graph_runtime import (
    QualificationError,
    _scope_key,
    load_fixture,
    validate_graph,
    validate_runtime_payload,
)


def _graph(fixture: dict[str, object]) -> dict[str, object]:
    scene = fixture["scene"]
    assert isinstance(scene, dict)
    modules = []
    for expected in fixture["expected_modules"]:
        assert isinstance(expected, dict)
        scope = expected.get("scope", {"kind": "global"})
        modules.append(
            {
                "id": expected["id"],
                "kind": expected["kind"],
                "applies_to": [scope],
                "solve_domain": [],
                "depends_on": expected.get("depends_on", []),
                "activation": expected["activation"],
                "authored_state": "authored",
                "capability": "semantic_only",
                "source_path": "/fixture",
            }
        )
    return {
        "schema_version": "physics_graph.v1",
        "scene_revision": scene["revision"],
        "modules": modules,
        "edges": copy.deepcopy(fixture["expected_edges"]),
    }


def _runtime(fixture: dict[str, object], lane: str) -> dict[str, object]:
    graph = _graph(fixture)
    modules = []
    executed = []
    for index, module in enumerate(graph["modules"]):
        status = module["activation"]
        record = {
            "module_id": module["id"],
            "status": status,
            "scope_key": _scope_key(module["applies_to"][0]),
            "depends_on": list(module["depends_on"]),
        }
        if status in {"active", "configured"}:
            executed.append(module["id"])
            if lane == "fem":
                record["fem_marker_ids"] = [index + 1]
            else:
                record["fdm_cell_mask_id"] = f"physics-mask.v1:{module['id']}"
        modules.append(record)
    revision = graph["scene_revision"]
    return {
        "schema_version": "fullmag.physics_scope_graph_runtime.v1",
        "graph": graph,
        "lanes": {
            lane: {
                "modules": modules,
                "executed_module_ids": executed,
                "provenance": {
                    "scene_revision": revision,
                    "requested_lane": lane,
                    "resolved_lane": lane,
                },
            }
        },
    }


class PhysicsScopeGraphRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.local = load_fixture("object_local_current_chain")
        cls.empty = load_fixture("no_current")
        cls.interface = load_fixture("cross_object_interface")

    def test_object_local_graph_matches_and_both_lanes_preserve_scope_and_dependencies(self) -> None:
        payload = _runtime(self.local, "fem")
        payload["lanes"]["fdm"] = _runtime(self.local, "fdm")["lanes"]["fdm"]
        validate_runtime_payload(self.local, payload)

    def test_no_current_has_no_runtime_modules_or_contributions(self) -> None:
        payload = _runtime(self.empty, "fem")
        payload["lanes"]["fdm"] = _runtime(self.empty, "fdm")["lanes"]["fdm"]
        validate_runtime_payload(self.empty, payload)

    def test_cross_object_interface_is_compared_as_one_scoped_module(self) -> None:
        graph = _graph(self.interface)
        self.assertEqual(len(graph["modules"]), 1)
        self.assertEqual(graph["modules"][0]["applies_to"][0]["kind"], "cross_object")
        payload = _runtime(self.interface, "fem")
        validate_runtime_payload(self.interface, payload, lanes=("fem",))

    def test_dependency_omission_fails_closed(self) -> None:
        payload = _runtime(self.local, "fem")
        executed = payload["lanes"]["fem"]["executed_module_ids"]
        payload["lanes"]["fem"]["executed_module_ids"] = [
            module_id for module_id in executed if module_id != "current:film"
        ]
        with self.assertRaisesRegex(QualificationError, "without dependency 'current:film'"):
            validate_runtime_payload(self.local, payload, lanes=("fem",))

    def test_scope_mismatch_fails_closed(self) -> None:
        payload = _runtime(self.local, "fdm")
        payload["lanes"]["fdm"]["modules"][0]["scope_key"] = "global"
        with self.assertRaisesRegex(QualificationError, "scope differs"):
            validate_runtime_payload(self.local, payload, lanes=("fdm",))

    def test_missing_graph_revision_in_provenance_is_not_runtime_evidence(self) -> None:
        payload = _runtime(self.local, "fem")
        del payload["lanes"]["fem"]["provenance"]["scene_revision"]
        with self.assertRaisesRegex(QualificationError, "scene_revision"):
            validate_runtime_payload(self.local, payload, lanes=("fem",))

    def test_graph_revision_alias_is_accepted_when_scene_revision_is_absent(self) -> None:
        payload = _runtime(self.local, "fem")
        provenance = payload["lanes"]["fem"]["provenance"]
        provenance["graph_revision"] = provenance.pop("scene_revision")
        validate_runtime_payload(self.local, payload, lanes=("fem",))

    def test_zero_drive_keeps_authored_modules_but_omits_execution(self) -> None:
        fixture = copy.deepcopy(self.local)
        for module in fixture["expected_modules"]:
            module["activation"] = "inactive"
        for edge in fixture["expected_edges"]:
            edge["status"] = "inactive"
        graph = _graph(fixture)
        payload = _runtime(fixture, "fem")
        validate_runtime_payload(fixture, payload, lanes=("fem",))
        self.assertEqual(len(graph["modules"]), 4)
        self.assertEqual(payload["lanes"]["fem"]["executed_module_ids"], [])

    def test_concrete_realization_distinguishes_resolved_and_executed(self) -> None:
        payload = _runtime(self.local, "fem")
        lane = payload["lanes"]["fem"]
        modules = []
        for module in lane["modules"]:
            module_id = module["module_id"]
            status = module["status"]
            state = "executed" if module_id in lane["executed_module_ids"] else "semantic_only"
            record = {
                "module_id": module_id,
                "state": state,
                "topology_fingerprint": "sha256:fem-topology",
                "realized_cell_count": 4 if state == "executed" else 0,
            }
            if state == "executed":
                record["realized_fem_marker_ids"] = [1]
            modules.append(record)
        lane["realization"] = {
            "schema_version": "physics_graph.realization.v1",
            "topology_fingerprint": "sha256:fem-topology",
            "resolved_module_ids": list(lane["executed_module_ids"]),
            "executed_module_ids": list(lane["executed_module_ids"]),
            "modules": modules,
        }
        validate_runtime_payload(self.local, payload, lanes=("fem",))

    def test_concrete_realization_rejects_semantic_marker_as_execution_proof(self) -> None:
        payload = _runtime(self.local, "fem")
        lane = payload["lanes"]["fem"]
        modules = []
        for module in lane["modules"]:
            modules.append({
                "module_id": module["module_id"],
                "state": "resolved" if module["status"] in {"active", "configured"} else "semantic_only",
                "topology_fingerprint": "sha256:fem-topology",
                "realized_cell_count": 4 if module["status"] in {"active", "configured"} else 0,
                "realized_fem_marker_ids": [module["module_id"]],
            })
        lane["realization"] = {
            "schema_version": "physics_graph.realization.v1",
            "topology_fingerprint": "sha256:fem-topology",
            "resolved_module_ids": [module["module_id"] for module in modules if module["state"] == "resolved"],
            "executed_module_ids": [],
            "modules": modules,
        }
        with self.assertRaisesRegex(QualificationError, "marker IDs"):
            validate_runtime_payload(self.local, payload, lanes=("fem",))


if __name__ == "__main__":
    unittest.main()
