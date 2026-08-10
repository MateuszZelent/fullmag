from __future__ import annotations

import contextlib
import io
import json
import unittest
from pathlib import Path

import fullmag as fm
from fullmag.runtime import script_builder
from fullmag.runtime import helper as runtime_helper
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)


def _lead_mesh() -> dict[str, object]:
    return {
        "mesh_name": "external_lead",
        "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        "cells": {
            "types": ["tet4"],
            "offsets": [0, 4],
            "nodes": [0, 1, 2, 3],
            "global_ordinals": [0],
        },
        "element_markers": [1],
        "facets": {
            "types": ["tri3"],
            "roles": ["exterior"],
            "offsets": [0, 3],
            "nodes": [0, 1, 2],
            "global_ordinals": [0],
        },
        "boundary_markers": [1],
    }


def _view() -> fm.ConservativeCurrentView:
    identity = fm.ConservativeCurrentIdentity(
        source_module_id="charge",
        source_state_revision="state-1",
        source_field_digest="field-1",
        conductivity_digest="sigma-1",
        mesh_revision="mesh-1",
        topology_revision="topology-1",
        geometry_digest="geometry-1",
        envelope_revision="envelope-1",
        envelope_digest="envelope-digest-1",
        evaluated_envelope_multiplier=1.0,
        evaluation_time_s=0.0,
        stage_identity=1,
    )
    return fm.ConservativeCurrentView(
        stable_vertex_ids=[10, 20, 30, 40],
        boundary_faces=[
            fm.ConservativeCurrentBoundaryFace([10, 20, 30], "insulating_outer")
        ],
        identity=identity,
        pins=fm.ConservativeCurrentPins(
            required_source_state_revision="state-1",
            required_source_field_digest="field-1",
            required_mesh_revision="mesh-1",
            required_topology_revision="topology-1",
        ),
        closure=fm.ConservativeCurrentExternalLead(
            operator_version="fem_closed_current_extension.v1",
            revision="lead-1",
            digest="lead-digest-1",
            drive_id="drive-1",
            outer_electrode_potential_drop_v=0.1,
            lead_mesh=_lead_mesh(),
            lead_conductivity_spm_per_element=[5.8e7],
            lead_stable_vertex_ids=[110, 120, 130, 140],
            interface_pairs=[
                fm.ConservativeCurrentLeadInterfacePair(
                    [10, 20, 30], [110, 120, 130]
                )
            ],
            minus_outer_electrode_face_vertex_ids=[[110, 120, 130]],
            plus_outer_electrode_face_vertex_ids=[[110, 120, 140]],
            lead_conductivity_digest="lead-sigma-1",
        ),
        algebraic_relative_tolerance=1e-10,
        physical_relative_gate=1e-8,
        physical_absolute_gate_a=1e-12,
    )


class ExternalLeadRoundTripTests(unittest.TestCase):
    def test_public_external_lead_example_exports_canonical_run_config(self) -> None:
        example = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_external_lead_oersted_public.py"
        )
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(
                [
                    "export-run-config",
                    "--script",
                    str(example),
                    "--backend",
                    "fem",
                    "--mode",
                    "strict",
                    "--precision",
                    "double",
                ]
            )
        self.assertEqual(exit_code, 0)
        config = json.loads(stdout.getvalue())
        self.assertEqual(len(config["stages"]), 1)
        stage = config["stages"][0]
        self.assertEqual(stage["entrypoint_kind"], "flat_run")
        self.assertEqual(stage["default_until_seconds"], 3.0e-13)
        ir = stage["ir"]
        self.assertEqual(ir["backend_policy"]["requested_backend"], "fem")
        self.assertEqual(ir["backend_policy"]["execution_precision"], "double")
        runtime = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
        self.assertEqual(runtime["device"], "cpu")
        self.assertEqual(runtime["execution_mode"], "strict")
        self.assertEqual(ir["current_modules"][0]["name"], "external_lead_charge")
        closure = ir["current_modules"][0]["conservative_current_view"]["closure"]
        self.assertEqual(closure["kind"], "external_lead")
        self.assertEqual(len(closure["lead_mesh"]["cells"]["types"]), 12)
        self.assertEqual(ir["spin_transport_modules"][0]["current_source_id"], "external_lead_charge")
        self.assertEqual(ir["energy_terms"][0]["source"], "external_lead_charge")
        self.assertEqual(
            [edge["kind"] for edge in ir["physics_graph"]["edges"]],
            ["current_to_oersted", "current_to_spin_transport"],
        )

    def test_public_external_lead_example_lowers_complete_stage_contract(self) -> None:
        example = (
            Path(__file__).resolve().parents[3]
            / "examples"
            / "fem_external_lead_oersted_public.py"
        )
        loaded = fm.load_problem_from_script(example, lightweight_assets=False)
        ir = loaded.problem.to_ir(
            script_source=loaded.script_source,
            source_root=example.parent,
        )

        self.assertEqual(loaded.entrypoint_kind, "flat_workspace")
        self.assertEqual(len(loaded.stages), 1)
        self.assertEqual(len(ir["current_modules"]), 1)
        self.assertEqual(len(ir["spin_transport_modules"]), 1)
        self.assertEqual(
            [term["kind"] for term in ir["energy_terms"]],
            ["oersted_field"],
        )
        closure = ir["current_modules"][0]["conservative_current_view"]["closure"]
        self.assertEqual(closure["kind"], "external_lead")
        self.assertEqual(closure["lead_mesh"]["cells"]["types"], ["tet4"] * 12)
        self.assertEqual(len(closure["interface_pairs"]), 4)

    def test_external_lead_is_typed_and_serializes_complete_mesh_contract(self) -> None:
        view = _view()
        closure = view.to_ir()["closure"]
        self.assertEqual(closure["kind"], "external_lead")
        self.assertEqual(closure["lead_mesh"]["cells"]["types"], ["tet4"])
        self.assertEqual(closure["lead_conductivity_spm_per_element"], [5.8e7])
        self.assertEqual(closure["interface_pairs"], [[[10, 20, 30], [110, 120, 130]]])

    def test_external_lead_rejects_zero_drive_and_invalid_operator(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be non-zero"):
            fm.ConservativeCurrentExternalLead(
                operator_version="fem_closed_current_extension.v1",
                revision="lead-1",
                digest="lead-digest-1",
                drive_id="drive-1",
                outer_electrode_potential_drop_v=0.0,
                lead_mesh=_lead_mesh(),
                lead_conductivity_spm_per_element=[5.8e7],
                lead_stable_vertex_ids=[110, 120, 130, 140],
                interface_pairs=[[[10, 20, 30], [110, 120, 130]]],
                minus_outer_electrode_face_vertex_ids=[[110, 120, 130]],
                plus_outer_electrode_face_vertex_ids=[[110, 120, 140]],
                lead_conductivity_digest="lead-sigma-1",
            )

        with self.assertRaisesRegex(ValueError, "operator_version"):
            fm.ConservativeCurrentExternalLead(
                operator_version="fem_charge_rt0.v1",
                revision="lead-1",
                digest="lead-digest-1",
                drive_id="drive-1",
                outer_electrode_potential_drop_v=0.1,
                lead_mesh=_lead_mesh(),
                lead_conductivity_spm_per_element=[5.8e7],
                lead_stable_vertex_ids=[110, 120, 130, 140],
                interface_pairs=[[[10, 20, 30], [110, 120, 130]]],
                minus_outer_electrode_face_vertex_ids=[[110, 120, 130]],
                plus_outer_electrode_face_vertex_ids=[[110, 120, 140]],
                lead_conductivity_digest="lead-sigma-1",
            )

        with self.assertRaisesRegex(ValueError, r"interface_pairs\[0\]"):
            fm.ConservativeCurrentExternalLead(
                operator_version="fem_closed_current_extension.v1",
                revision="lead-1",
                digest="lead-digest-1",
                drive_id="drive-1",
                outer_electrode_potential_drop_v=0.1,
                lead_mesh=_lead_mesh(),
                lead_conductivity_spm_per_element=[5.8e7],
                lead_stable_vertex_ids=[110, 120, 130, 140],
                interface_pairs=[[[10, 20, 30]]],
                minus_outer_electrode_face_vertex_ids=[[110, 120, 130]],
                plus_outer_electrode_face_vertex_ids=[[110, 120, 140]],
                lead_conductivity_digest="lead-sigma-1",
            )

    def test_external_lead_round_trips_through_script_and_scene_document(self) -> None:
        region = fm.RegionRef("layer")
        module = fm.CurrentTransport(
            name="charge",
            model="ohmic_poisson",
            domain=[region],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    region, fm.ChargeTransportMaterial(4.0e6)
                )
            ],
            boundaries=[
                fm.ChargeInsulating(
                    "outer", [fm.SurfaceRef("layer", "outer", (1.0, 0.0, 0.0))]
                )
            ],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(),
            conservative_current_view=_view(),
        )
        expected = module.to_ir()
        rendered = script_builder._render_current_transport_payload(  # type: ignore[attr-defined]
            expected, surface="flat"
        )
        fm.reset()
        rebuilt = eval(rendered, {"fm": fm})
        self.assertEqual(rebuilt.to_ir(), expected)

        scene = build_scene_document_from_builder(
            {"revision": 1, "geometries": [], "current_modules": [expected]}
        )
        self.assertEqual(
            build_builder_from_scene_document(scene)["current_modules"], [expected]
        )


if __name__ == "__main__":
    unittest.main()
