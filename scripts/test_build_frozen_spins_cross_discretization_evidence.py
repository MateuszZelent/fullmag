from __future__ import annotations

import copy
import hashlib
import json
import struct
import unittest

from scripts.build_frozen_spins_cross_discretization_evidence import (
    EvidenceError,
    build_evidence,
)


IDENTITY = "a" * 64
SECOND_IDENTITY = "b" * 64
REFINEMENTS = [("coarse", 8), ("medium", 13), ("fine", 23)]
MEASURES = {
    8: 0.375,
    13: 5.0 / 13.0,
    23: 9.0 / 23.0,
}
ANALYTIC = 0.4
DOMAIN_LENGTH = 1.0
SEMANTICS_VERSION = "frozen_spins.cross_discretization.selector_semantics.v1"
SEMANTICS_HASH_ENCODING = "fullmag.frozen_spins.semantics.f64_bits.v1"
TOPOLOGY_FINGERPRINT_SCHEMA = "fullmag.frozen_spins.cross_discretization.topology.v2"
CONSTRAINT_ID = "cross_discretization_slab"


def canonicalize_numbers(value):
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        bits = int.from_bytes(struct.pack(">d", float(value)), "big")
        return {"$fullmag_f64_bits": f"{bits:016x}"}
    if isinstance(value, list):
        return [canonicalize_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: canonicalize_numbers(item) for key, item in value.items()}
    raise TypeError(value)


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


CANONICAL_EXPRESSION = {
    "kind": "inside_geometry",
    "geometry": {
        "kind": "box",
        "center_m": [0.4, 0.5, 0.5],
        "size_m": [0.4, 1.0, 1.0],
    },
    "frame": {"kind": "world"},
    "sampling": {"kind": "dof_point"},
    "boundary": {
        "kind": "inclusive",
        "absolute_tolerance_m": 0.0,
        "relative_tolerance": 1.0e-12,
    },
}
ANALYTIC_CONTRACT = {
    "domain_length_m": DOMAIN_LENGTH,
    "value_m3": ANALYTIC,
    "bounds_m": [[0.2, 0.0, 0.0], [0.6, 1.0, 1.0]],
    "geometry": "box",
    "formula": "(x_upper-x_lower)*(y_upper-y_lower)*(z_upper-z_lower)",
}
PHYSICAL_CONTRACT = {
    "unit": "m^3",
    "method": "sum_selected_dof_control_volumes",
    "cross_lane_resolved_mask_sha256_comparison": "NOT_PERFORMED",
}
SEMANTICS_PAYLOAD = {
    "constraint": canonicalize_numbers(
        {
            "schema_version": "frozen_spins.v1",
            "id": CONSTRAINT_ID,
            "name": "Cross-discretization slab",
            "enabled": True,
            "selector": CANONICAL_EXPRESSION,
            "reference": {"kind": "capture_current_at_activation"},
            "membership": {"kind": "static"},
            "activation": {"kind": "all_stages"},
            "empty_selection": "error",
            "inactive_selection": "error",
        }
    ),
    "hash_encoding": SEMANTICS_HASH_ENCODING,
    "analytic_measure": canonicalize_numbers(ANALYTIC_CONTRACT),
    "physical_measure_contract": PHYSICAL_CONTRACT,
    "semantics_version": SEMANTICS_VERSION,
}
SEMANTICS_IDENTITY = hashlib.sha256(canonical_json(SEMANTICS_PAYLOAD)).hexdigest()


def hash_f64(hasher, value: float) -> None:
    bits = int.from_bytes(struct.pack(">d", value), "big")
    hasher.update(bits.to_bytes(8, "little"))


def fdm_grid_fingerprint(n: int) -> str:
    hasher = hashlib.sha256()
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fdm_grid.v1")
    hasher.update(n.to_bytes(4, "little"))
    hash_f64(hasher, DOMAIN_LENGTH)
    cell = DOMAIN_LENGTH / n
    for k in range(n):
        for j in range(n):
            for i in range(n):
                for index in (i, j, k):
                    hash_f64(hasher, (float(index) + 0.5) * cell)
    return hasher.hexdigest()


def fem_points_fingerprint(n: int) -> str:
    hasher = hashlib.sha256()
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fem_points.v1")
    hasher.update(((n + 1) ** 3).to_bytes(8, "little"))
    for k in range(n + 1):
        for j in range(n + 1):
            for i in range(n + 1):
                for index in (i, j, k):
                    hash_f64(hasher, float(index) * DOMAIN_LENGTH / float(n))
    return hasher.hexdigest()


def fem_node_index(i: int, j: int, k: int, n: int) -> int:
    side = n + 1
    return (k * side + j) * side + i


def fem_connectivity_fingerprint(n: int) -> str:
    hasher = hashlib.sha256()
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fem_tet4_connectivity.v1")
    hasher.update(((n + 1) ** 3).to_bytes(8, "little"))
    element_count = 0
    for k in range(n):
        for j in range(n):
            for i in range(n):
                v000 = fem_node_index(i, j, k, n)
                v100 = fem_node_index(i + 1, j, k, n)
                v010 = fem_node_index(i, j + 1, k, n)
                v110 = fem_node_index(i + 1, j + 1, k, n)
                v001 = fem_node_index(i, j, k + 1, n)
                v101 = fem_node_index(i + 1, j, k + 1, n)
                v011 = fem_node_index(i, j + 1, k + 1, n)
                v111 = fem_node_index(i + 1, j + 1, k + 1, n)
                for tetra in (
                    (v000, v100, v110, v111),
                    (v000, v110, v010, v111),
                    (v000, v010, v011, v111),
                    (v000, v011, v001, v111),
                    (v000, v001, v101, v111),
                    (v000, v101, v100, v111),
                ):
                    hasher.update(element_count.to_bytes(8, "little"))
                    for node in tetra:
                        hasher.update(node.to_bytes(8, "little"))
                    element_count += 1
    return hasher.hexdigest()


def canonical_points_and_mask(backend: str, n: int):
    cell = DOMAIN_LENGTH / n
    if backend == "fdm":
        points = [
            ((float(i) + 0.5) * cell, (float(j) + 0.5) * cell, (float(k) + 0.5) * cell)
            for k in range(n)
            for j in range(n)
            for i in range(n)
        ]
    else:
        points = [
            (
                float(i) * DOMAIN_LENGTH / float(n),
                float(j) * DOMAIN_LENGTH / float(n),
                float(k) * DOMAIN_LENGTH / float(n),
            )
            for k in range(n + 1)
            for j in range(n + 1)
            for i in range(n + 1)
        ]
    center = CANONICAL_EXPRESSION["geometry"]["center_m"]
    size = CANONICAL_EXPRESSION["geometry"]["size_m"]
    mask = [
        all(
            abs(point[axis] - center[axis])
            <= 0.5 * size[axis] + 1.0e-12 * abs(0.5 * size[axis])
            for axis in range(3)
        )
        for point in points
    ]
    lower = [float("inf")] * 3
    upper = [float("-inf")] * 3
    for point, selected in zip(points, mask):
        if selected:
            for axis in range(3):
                lower[axis] = min(lower[axis], point[axis])
                upper[axis] = max(upper[axis], point[axis])
    return points, mask, [lower, upper]


def mask_sha256(mask) -> str:
    hasher = hashlib.sha256()
    hasher.update(len(mask).to_bytes(8, "little"))
    hasher.update(bytes(1 if selected else 0 for selected in mask))
    return hasher.hexdigest()


def reference_sha256(mask) -> str:
    hasher = hashlib.sha256()
    hasher.update(len(mask).to_bytes(8, "little"))
    reference = (
        int.from_bytes(struct.pack(">d", 1.0), "big").to_bytes(8, "little")
        + b"\x00" * 16
    )
    for selected in mask:
        hasher.update(bytes((1 if selected else 0,)))
        if selected:
            hasher.update(reference)
    return hasher.hexdigest()


def topology_fingerprint(backend: str, n: int) -> str:
    payload = {
        "backend": backend,
        "domain_length_f64_bits": "3ff0000000000000",
        "materialized_connectivity_fingerprint": (
            fem_connectivity_fingerprint(n) if backend == "fem" else None
        ),
        "materialized_grid_fingerprint": fdm_grid_fingerprint(n) if backend == "fdm" else None,
        "materialized_points_fingerprint": fem_points_fingerprint(n) if backend == "fem" else None,
        "n": n,
        "schema_version": TOPOLOGY_FINGERPRINT_SCHEMA,
    }
    return hashlib.sha256(canonical_json(payload)).hexdigest()


def row(backend: str, refinement: str, level: int, n: int) -> dict:
    evaluator = {
        "fdm": "selection.fdm_cell_center.v1",
        "fem": "selection.fem_true_dof.any_incident_magnetic.v1",
    }[backend]
    function = {
        "fdm": "compile_fdm_frozen_spins",
        "fem": "compile_fem_frozen_spins",
    }[backend]
    active = n**3 if backend == "fdm" else (n + 1) ** 3
    measure = MEASURES[n]
    _, canonical_mask, canonical_bounds = canonical_points_and_mask(backend, n)
    frozen = sum(1 for selected in canonical_mask if selected)
    canonical_mask_sha256 = mask_sha256(canonical_mask)
    canonical_reference_sha256 = reference_sha256(canonical_mask)
    canonical_topology = topology_fingerprint(backend, n)
    resolved_plan = {
        "schema_version": "resolved_frozen_spins_plan.v1",
        "constraint_ids": [CONSTRAINT_ID],
        "active_dof_count": active,
        "frozen_dof_count": frozen,
        "free_dof_count": active - frozen,
        "grid_or_mesh_fingerprint": canonical_topology,
        "resolved_mask_sha256": canonical_mask_sha256,
        "source_state_revision": 1,
        "all_active_dofs_frozen": False,
        "certificate": {
            "schema_version": "selection_certificate.v1",
            "evaluator_id": evaluator,
            "constraint_ids": [CONSTRAINT_ID],
            "authored_fingerprints": [
                {"constraint_id": CONSTRAINT_ID, "selector_sha256": IDENTITY}
            ],
            "raw_candidate_dof_count": frozen,
            "inactive_candidate_dof_count": 0,
            "active_dof_count": active,
            "frozen_dof_count": frozen,
            "free_dof_count": active - frozen,
            "bounds_m": canonical_bounds,
            "grid_or_mesh_fingerprint": canonical_topology,
            "source_state_revision": 1,
            "mask_sha256": canonical_mask_sha256,
            "resolved_reference_sha256": canonical_reference_sha256,
        },
    }
    materialization = {
        "source_kind": "rust_production_planner_evaluator",
        "crate": "fullmag-plan",
        "function": function,
        "evaluator_id": evaluator,
        "domain_materialized": True,
        "measure_weights_materialized": True,
        "domain_length_m": DOMAIN_LENGTH,
    }
    if backend == "fdm":
        materialization.update(
            {
                "counts": [n, n, n],
                "cell_m": [1.0 / n, 1.0 / n, 1.0 / n],
                "grid_point_count": n**3,
                "grid_materialization_fingerprint": f"sha256:{fdm_grid_fingerprint(n)}",
                "weight_unit_m3": measure / frozen,
            }
        )
        mesh_element_count = None
        measure_definition = "fdm_cell_volume_sum"
    else:
        materialization.update(
            {
                "fe_order": 1,
                "mesh_family": "structured_cube_split_into_six_tet4",
                "point_count": (n + 1) ** 3,
                "points_fingerprint": f"sha256:{fem_points_fingerprint(n)}",
                "connectivity_fingerprint": f"sha256:{fem_connectivity_fingerprint(n)}",
                "element_count": 6 * n**3,
                "incident_element_records": 6 * n**3 * 4,
                "weight_definition": "lumped_p1_nodal_control_volume_sum_tet_volume_over_4",
            }
        )
        mesh_element_count = 6 * n**3
        measure_definition = "fem_p1_structured_tet4_nodal_control_volume_sum"
    return {
        "backend": backend,
        "refinement": refinement,
        "refinement_level": level,
        "evaluator_id": evaluator,
        "authored_selector_fingerprint": IDENTITY,
        "semantics_selector_fingerprint": SEMANTICS_IDENTITY,
        "topology_fingerprint": canonical_topology,
        "resolution": [n, n, n],
        "materialized_dof_count": active,
        "active_dof_count": active,
        "frozen_dof_count": frozen,
        "free_dof_count": active - frozen,
        "selected_measure_m3": measure,
        "selected_measure_error_abs_m3": abs(measure - ANALYTIC),
        "selected_measure_relative_error": abs(measure - ANALYTIC) / ANALYTIC,
        "domain_measure_m3": 1.0,
        "dof_measure_definition": measure_definition,
        "selected_measure_weight_count": frozen,
        "mesh_element_count": mesh_element_count,
        "resolved_plan": resolved_plan,
        "materialization": materialization,
    }


def artifact() -> dict:
    rows = []
    for level, (refinement, n) in enumerate(REFINEMENTS):
        rows.append(row("fdm", refinement, level, n))
        rows.append(row("fem", refinement, level, n))
    return {
        "schema_version": "fullmag.frozen_spins.cross_discretization.materialization.v1",
        "status": "PASS",
        "producer": {
            "kind": "rust_production_planner_evaluator",
            "crate": "fullmag-plan",
            "command": "cargo run -p fullmag-plan --example frozen_spins_cross_discretization -- --output <path>",
        },
        "selector": {
            "authored_fingerprint": IDENTITY,
            "semantics_fingerprint": SEMANTICS_IDENTITY,
            "semantics_version": SEMANTICS_VERSION,
            "root_constraint_id": CONSTRAINT_ID,
            "canonical_expression": CANONICAL_EXPRESSION,
            "semantics_payload": copy.deepcopy(SEMANTICS_PAYLOAD),
        },
        "analytic_measure": {
            "domain_length_m": DOMAIN_LENGTH,
            "value_m3": ANALYTIC,
            "bounds_m": [[0.2, 0.0, 0.0], [0.6, 1.0, 1.0]],
            "geometry": "box",
            "formula": "(x_upper-x_lower)*(y_upper-y_lower)*(z_upper-z_lower)",
        },
        "physical_measure_contract": copy.deepcopy(PHYSICAL_CONTRACT),
        "refinements": rows,
    }


def raw(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True) + "\n").encode()


class FrozenSpinsCrossDiscretizationEvidenceTests(unittest.TestCase):
    def test_valid_two_backend_three_level_materialization_passes(self) -> None:
        materialized = raw(artifact())
        evidence = build_evidence(materialized, "fixture.json")
        self.assertEqual(evidence, build_evidence(materialized, "fixture.json"))
        self.assertEqual(evidence["status"], "PASS")
        self.assertEqual(evidence["implementation_status"], "EXECUTED_PLANNER_MATERIALIZATION")
        self.assertEqual(evidence["qualification_status"], "UNQUALIFIED")
        self.assertEqual(evidence["test_case_ids"], ["FS-P15-CROSS-DISCRETIZATION"])
        self.assertEqual(evidence["contracts"]["resolved_mask_sha256_cross_discretization_comparison"], "NOT_PERFORMED")
        self.assertEqual(evidence["convergence"]["fdm"]["resolutions"], [8, 13, 23])
        self.assertEqual(evidence["convergence"]["fem"]["resolutions"], [8, 13, 23])

    def test_row_local_mask_hashes_are_not_compared_across_discretizations(self) -> None:
        # The independently regenerated canonical masks are valid per lane,
        # yet their hashes differ because FDM and FEM have different DOF
        # orderings.  The builder must compare each hash only to its own
        # canonical lane mask, never cross-lane.
        value = artifact()
        evidence = build_evidence(raw(value), "fixture.json")
        self.assertEqual(evidence["status"], "PASS")
        fdm_mask = next(
            item["resolved_plan"]["resolved_mask_sha256"]
            for item in value["refinements"]
            if item["backend"] == "fdm" and item["refinement"] == "coarse"
        )
        fem_mask = next(
            item["resolved_plan"]["resolved_mask_sha256"]
            for item in value["refinements"]
            if item["backend"] == "fem" and item["refinement"] == "coarse"
        )
        self.assertNotEqual(fdm_mask, fem_mask)

    def test_missing_backend_refinement_fails_closed(self) -> None:
        value = artifact()
        value["refinements"] = [
            item for item in value["refinements"] if not (item["backend"] == "fem" and item["refinement"] == "fine")
        ]
        with self.assertRaisesRegex(EvidenceError, "six refinement rows"):
            build_evidence(raw(value), "fixture.json")

    def test_selector_identity_and_materialization_source_are_required(self) -> None:
        mutations = []
        selector = artifact()
        selector["refinements"][0]["resolved_plan"]["certificate"]["authored_fingerprints"][0]["selector_sha256"] = SECOND_IDENTITY
        mutations.append(selector)
        source = artifact()
        source["refinements"][0]["materialization"]["source_kind"] = "synthetic_fixture"
        mutations.append(source)
        row_selector = artifact()
        row_selector["refinements"][0]["semantics_selector_fingerprint"] = IDENTITY
        mutations.append(row_selector)
        semantics = artifact()
        semantics["physical_measure_contract"]["cross_lane_resolved_mask_sha256_comparison"] = "COMPARE"
        mutations.append(semantics)
        for mutated in mutations:
            with self.subTest(mutated=mutated):
                with self.assertRaises(EvidenceError):
                    build_evidence(raw(mutated), "fixture.json")

    def test_full_semantics_payload_hash_and_topology_binding_are_verified(self) -> None:
        semantics = copy.deepcopy(artifact())
        semantics["selector"]["semantics_payload"]["constraint"]["name"] = "tampered"
        with self.assertRaisesRegex(EvidenceError, "semantics fingerprint"):
            build_evidence(raw(semantics), "fixture.json")

        semantics_hash = copy.deepcopy(artifact())
        semantics_hash["selector"]["semantics_fingerprint"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "semantics fingerprint"):
            build_evidence(raw(semantics_hash), "fixture.json")

        policy = copy.deepcopy(artifact())
        policy["selector"]["semantics_payload"]["constraint"]["reference"] = {
            "kind": "manual"
        }
        policy["selector"]["semantics_fingerprint"] = hashlib.sha256(
            canonical_json(policy["selector"]["semantics_payload"])
        ).hexdigest()
        with self.assertRaisesRegex(EvidenceError, "reference/membership/activation"):
            build_evidence(raw(policy), "fixture.json")

        topology = copy.deepcopy(artifact())
        topology["refinements"][1]["materialization"]["connectivity_fingerprint"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "deterministic six-tet connectivity"):
            build_evidence(raw(topology), "fixture.json")

        grid = copy.deepcopy(artifact())
        grid["refinements"][0]["materialization"]["grid_materialization_fingerprint"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "deterministic materialized cell centers"):
            build_evidence(raw(grid), "fixture.json")

        points = copy.deepcopy(artifact())
        points["refinements"][1]["materialization"]["points_fingerprint"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "deterministic node coordinates"):
            build_evidence(raw(points), "fixture.json")

        topology_identity = copy.deepcopy(artifact())
        topology_identity["refinements"][1]["topology_fingerprint"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "topology fingerprint"):
            build_evidence(raw(topology_identity), "fixture.json")

    def test_plan_certificate_mask_counts_measure_and_revision_are_recomputed(self) -> None:
        count = copy.deepcopy(artifact())
        count["refinements"][0]["frozen_dof_count"] += 1
        with self.assertRaisesRegex(EvidenceError, "frozen/free counts"):
            build_evidence(raw(count), "fixture.json")

        mask = copy.deepcopy(artifact())
        mask["refinements"][0]["resolved_plan"]["resolved_mask_sha256"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "resolved plan mask hash"):
            build_evidence(raw(mask), "fixture.json")

        measure = copy.deepcopy(artifact())
        measure["refinements"][0]["selected_measure_m3"] += 0.01
        with self.assertRaisesRegex(EvidenceError, "selected physical measure"):
            build_evidence(raw(measure), "fixture.json")

        revision = copy.deepcopy(artifact())
        revision["refinements"][0]["resolved_plan"]["source_state_revision"] = 2
        with self.assertRaisesRegex(EvidenceError, "identity/count flags"):
            build_evidence(raw(revision), "fixture.json")

        certificate_revision = copy.deepcopy(artifact())
        certificate_revision["refinements"][0]["resolved_plan"]["certificate"]["source_state_revision"] = 2
        with self.assertRaisesRegex(EvidenceError, "certificate source state revision"):
            build_evidence(raw(certificate_revision), "fixture.json")

        certificate_mask = copy.deepcopy(artifact())
        certificate_mask["refinements"][0]["resolved_plan"]["certificate"]["mask_sha256"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "certificate mask hash"):
            build_evidence(raw(certificate_mask), "fixture.json")

        reference = copy.deepcopy(artifact())
        reference["refinements"][0]["resolved_plan"]["certificate"]["resolved_reference_sha256"] = "f" * 64
        with self.assertRaisesRegex(EvidenceError, "reference hash"):
            build_evidence(raw(reference), "fixture.json")

    def test_non_monotone_or_above_analytic_refinement_fails_closed(self) -> None:
        non_monotone = artifact()
        non_monotone["refinements"][4]["selected_measure_m3"] = 0.37
        non_monotone["refinements"][4]["selected_measure_error_abs_m3"] = 0.03
        non_monotone["refinements"][4]["selected_measure_relative_error"] = 0.075
        non_monotone["refinements"][4]["materialization"]["weight_unit_m3"] = 0.37 / non_monotone["refinements"][4]["frozen_dof_count"]
        with self.assertRaisesRegex(EvidenceError, "strictly increasing|FDM cell weight|selected physical measure"):
            build_evidence(raw(non_monotone), "fixture.json")

        above = copy.deepcopy(artifact())
        above["refinements"][4]["selected_measure_m3"] = 0.41
        above["refinements"][4]["selected_measure_error_abs_m3"] = 0.01
        above["refinements"][4]["selected_measure_relative_error"] = 0.025
        above["refinements"][4]["materialization"]["weight_unit_m3"] = 0.41 / above["refinements"][4]["frozen_dof_count"]
        with self.assertRaisesRegex(EvidenceError, "strictly decreasing|crossed above|FDM cell weight|selected physical measure"):
            build_evidence(raw(above), "fixture.json")


if __name__ == "__main__":
    unittest.main()
