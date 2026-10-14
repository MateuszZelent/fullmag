from __future__ import annotations

import copy
from dataclasses import FrozenInstanceError, replace
import unittest
from unittest.mock import patch

import fullmag as fm
from fullmag.runtime.scene_document import (
    _decode_conservative_current_source,
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import _render_current_transport_payload


def source_input() -> dict:
    nodes = []
    connectivity = []
    cube_tets = ((0, 1, 3, 7), (0, 3, 2, 7), (0, 2, 6, 7),
                 (0, 6, 4, 7), (0, 4, 5, 7), (0, 5, 1, 7))
    for cube, start in enumerate((-1, 1)):
        nodes.extend([[start + (i & 1), (i >> 1) & 1, (i >> 2) & 1] for i in range(8)])
        connectivity.extend(i + 8 * cube for tet in cube_tets for i in tet)
    mesh = {"nodes": nodes, "cells": {"types": ["tet4"] * 12,
            "offsets": list(range(0, 49, 4)), "nodes": connectivity}}
    incidence = {}
    for start in range(0, len(connectivity), 4):
        tet = connectivity[start:start + 4]
        for omitted in range(4):
            face = tuple(sorted(tet[:omitted] + tet[omitted + 1:]))
            incidence[face] = incidence.get(face, 0) + 1
    exterior = [f for f, count in incidence.items() if count == 1]
    mesh.update(mesh_name="two-leads", element_markers=[1] * 12,
                boundary_markers=[1] * len(exterior), facets={"types": ["tri3"] * len(exterior),
                "roles": ["exterior"] * len(exterior), "offsets": list(range(0, 3 * len(exterior) + 1, 3)),
                "nodes": [i for f in exterior for i in f]})
    pairs = [
        fm.CurrentSourceInterfacePair("left-a", [1, 2, 4], [102, 104, 108], [[4, 108], [1, 102], [2, 104]]),
        fm.CurrentSourceInterfacePair("left-b", [1, 3, 4], [102, 106, 108], [[1, 102], [3, 106], [4, 108]]),
        fm.CurrentSourceInterfacePair("right-a", [5, 6, 8], [109, 111, 115], [[5, 109], [6, 111], [8, 115]]),
        fm.CurrentSourceInterfacePair("right-b", [5, 7, 8], [109, 113, 115], [[5, 109], [7, 113], [8, 115]]),
    ]
    return dict(
        revision="source-1", device_stable_vertex_ids=list(range(1, 9)), lead_mesh=mesh,
        lead_stable_vertex_ids=list(range(101, 117)), lead_conductivity_spm_per_element=[1.] * 12,
        interface_pairs=pairs,
        outer_terminals=[fm.CurrentSourceOuterTerminal("left", [[101, 103, 107], [101, 105, 107]]),
                         fm.CurrentSourceOuterTerminal("right", [[110, 112, 116], [110, 114, 116]])],
        terminal_observations=[fm.CurrentSourceTerminalObservation("in", "device", ["left-a", "left-b"]),
                               fm.CurrentSourceTerminalObservation("out", "device", ["right-a", "right-b"])],
        drives=[fm.CurrentSourceDrive("active", "port-1", {"left": -1., "right": 1.}),
                fm.CurrentSourceDrive("zero", "port-zero", {"left": 0., "right": 0.})],
    )


def transport_input(source) -> dict:
    region = fm.RegionRef("device")
    return dict(name="antenna", model="ohmic_poisson", domain=[region],
                materials=[fm.ChargeTransportMaterialAssignment(region, fm.ChargeTransportMaterial(1.))],
                boundaries=[], gauge=fm.ChargePotentialGauge("terminal_reference"),
                solver=fm.ChargeSolverPolicy(operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
                conservative_current_source=source)


class CurrentSourceTests(unittest.TestCase):
    def test_exact_typed_source_and_signed_zero_drives_round_trip(self):
        source = fm.ExternalLeadCurrentSource(**source_input())
        entry = fm.CurrentTransport(**transport_input(source)).to_ir()
        self.assertEqual(entry["boundaries"], [])
        self.assertEqual(source.to_ir()["kind"], "external_lead_current")
        self.assertNotIn("source_field_digest", source.to_ir())
        scene = build_scene_document_from_builder({"revision": 1, "geometries": [], "current_modules": [entry]})
        self.assertEqual(build_builder_from_scene_document(scene)["current_modules"], [entry])
        rendered = _render_current_transport_payload(entry, surface="flat")
        restored = eval(rendered, {"fm": fm})
        self.assertEqual(restored.to_ir(), entry)
        self.assertIn("fm.CurrentSourceInterfacePair", rendered)
        self.assertIn("vertex_pairs=", rendered)
        self.assertEqual(_decode_conservative_current_source(source.to_ir()).to_ir(), source.to_ir())

    def test_input_and_output_snapshots_are_immutable_and_independent(self):
        values = source_input()
        source = fm.ExternalLeadCurrentSource(**values)
        before = source.to_ir()
        values["lead_mesh"]["nodes"][0][0] = 1000
        values["device_stable_vertex_ids"][0] = 999
        values["interface_pairs"].clear()
        result = source.to_ir()
        result["lead_mesh"]["nodes"][0][0] = 2000
        self.assertEqual(source.to_ir(), before)
        self.assertIs(copy.deepcopy(source), source)
        with self.assertRaises(TypeError):
            source.lead_mesh["nodes"][0][0] = 7
        with self.assertRaises(TypeError):
            source.drives[0].outer_terminal_currents_a["left"] = 8
        with self.assertRaises(FrozenInstanceError):
            source.revision = "changed"

    def test_study_current_transport_forwards_current_source_without_losing_maps(self):
        source = fm.ExternalLeadCurrentSource(**source_input())
        study = fm.study("current-source-authoring")
        module = study.current_transport(**transport_input(source))
        self.assertIs(module.conservative_current_source, source)
        self.assertEqual(module.to_ir(), fm.CurrentTransport(**transport_input(source)).to_ir())

    def test_unknown_or_missing_nested_fields_schema_and_kind_fail_closed(self):
        entry = fm.ExternalLeadCurrentSource(**source_input()).to_ir()
        changes = [(None, "unknown", 1), (None, "schema_version", "future"), (None, "kind", "external_lead"),
                   ("interface_pairs", "unknown", 1), ("outer_terminals", "unknown", 1),
                   ("terminal_observations", "unknown", 1), ("drives", "unknown", 1)]
        for group, key, value in changes:
            with self.subTest(group=group, key=key):
                bad = copy.deepcopy(entry)
                (bad if group is None else bad[group][0])[key] = value
                with self.assertRaises(ValueError):
                    _decode_conservative_current_source(bad)
        del entry["revision"]
        with self.assertRaises(ValueError):
            _decode_conservative_current_source(entry)

    def test_source_specific_charge_contract_and_exclusivity(self):
        source = fm.ExternalLeadCurrentSource(**source_input())
        base = transport_input(source)
        for key, value in [("model", "prescribed_density"), ("coupling", "bidirectional"),
                           ("domain", []), ("materials", []), ("gauge", fm.ChargePotentialGauge("zero_mean")),
                           ("solver", fm.ChargeSolverPolicy()), ("boundaries", [fm.ChargeInsulating("wall", [fm.SurfaceRef("device", "wall", (1., 0., 0.))])]),
                           ("time_envelope", fm.ConstantEnvelope(1.)),
                           ("conservative_current_view", object()), ("structured_current_closure", object())]:
            with self.subTest(key=key), self.assertRaises((ValueError, TypeError)):
                fm.CurrentTransport(**(base | {key: value}))

    def test_explicit_bijection_u64_text_and_finite_currents(self):
        for pairs in ([[1, 102], [2, 102], [4, 108]], [[1, 102], [2, 104], [3, 108]]):
            with self.assertRaises(ValueError):
                fm.CurrentSourceInterfacePair("p", [1, 2, 4], [102, 104, 108], pairs)
        for value in (True, 0, 1 << 64):
            with self.assertRaises((ValueError, TypeError)):
                fm.CurrentSourceInterfacePair("p", [value, 2, 4], [102, 104, 108], [[value, 102], [2, 104], [4, 108]])
        for name in ("", "x\x00y", "ą" * 2049):
            with self.assertRaises(ValueError):
                fm.CurrentSourceDrive(name, "p", {"left": 0.})
        for value in (True, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                fm.CurrentSourceDrive("d", "p", {"left": value})

    def test_source_map_ownership_partition_and_coverage(self):
        base = source_input()
        cases = [
            {"lead_stable_vertex_ids": list(range(1, 17))},
            {"lead_conductivity_spm_per_element": [1.]},
            {"interface_pairs": [base["interface_pairs"][0]] * 2},
            {"terminal_observations": [base["terminal_observations"][0]]},
            {"terminal_observations": [base["terminal_observations"][0], fm.CurrentSourceTerminalObservation("other", "device", ["left-a", "right-a", "right-b"])]},
            {"outer_terminals": [base["outer_terminals"][0], fm.CurrentSourceOuterTerminal("overlap", [[102, 104, 108]])]},
            {"drives": [fm.CurrentSourceDrive("partial", "p", {"left": -1.})]},
            {"drives": [base["drives"][0], replace(base["drives"][0], id="duplicate-port")]},
            {"interface_pairs": base["interface_pairs"][:2] + [replace(base["interface_pairs"][2],
                device_face_vertex_ids=(1, 6, 8), vertex_pairs=((1, 109), (6, 111), (8, 115)))] + base["interface_pairs"][3:]},
        ]
        for change in cases:
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                fm.ExternalLeadCurrentSource(**(base | change))

    def test_known_mesh_metadata_and_empty_periodic_lists_are_preserved(self):
        values = source_input()
        mesh = values["lead_mesh"]
        mesh["periodic_node_pairs"] = []
        mesh["periodic_boundary_pairs"] = []
        mesh["cells"]["global_ordinals"] = list(range(12))
        mesh["cells"]["mesh_parts"] = ["magnetic"] * 12
        mesh["facets"]["global_ordinals"] = list(range(len(mesh["facets"]["types"])))
        mesh["per_domain_quality"] = {"1": dict(n_elements=12, sicn_min=.2, sicn_max=1., sicn_mean=.5,
            sicn_p5=.2, gamma_min=.2, gamma_mean=.5, volume_min=.1, volume_max=.2,
            volume_mean=.15, volume_std=.02, avg_quality=.5, sicn_histogram=[2, 10])}
        source = fm.ExternalLeadCurrentSource(**values)
        self.assertEqual(source.to_ir()["lead_mesh"], mesh)
        self.assertEqual(_decode_conservative_current_source(source.to_ir()).to_ir()["lead_mesh"], mesh)
        for change in ("quality", "ordinal", "part", "bool-offset"):
            bad = copy.deepcopy(values)
            if change == "quality": bad["lead_mesh"]["per_domain_quality"]["1"]["unknown"] = 1
            if change == "ordinal": bad["lead_mesh"]["cells"]["global_ordinals"][0] = True
            if change == "part": bad["lead_mesh"]["cells"]["mesh_parts"][0] = "unknown"
            if change == "bool-offset": bad["lead_mesh"]["facets"]["offsets"][0] = False
            with self.subTest(change=change), self.assertRaises(ValueError):
                fm.ExternalLeadCurrentSource(**bad)

    def test_native_marker_and_aggregate_bounds_without_large_buffers(self):
        for field in ("element_markers", "boundary_markers"):
            for value in (0, 1 << 31, True):
                values = source_input()
                values["lead_mesh"][field][0] = value
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "int32 marker"):
                    fm.ExternalLeadCurrentSource(**values)
        values = source_input()
        for field in ("element_markers", "boundary_markers"):
            values["lead_mesh"][field][0] = (1 << 31) - 1
        fm.ExternalLeadCurrentSource(**values)
        with patch("fullmag.model.current_transport._CURRENT_SOURCE_MAX_ITEMS", 32):
            values = source_input()
            values["drives"] = [fm.CurrentSourceDrive(f"drive-{i}", f"port-{i}", {"left": 0., "right": 0.}) for i in range(17)]
            with self.assertRaisesRegex(ValueError, "aggregate drive current entries"):
                fm.ExternalLeadCurrentSource(**values)
            values = source_input()
            ids = [p.id for p in values["interface_pairs"]]
            values["terminal_observations"] = [fm.CurrentSourceTerminalObservation(f"observation-{i}", "device", ids) for i in range(9)]
            with self.assertRaisesRegex(ValueError, "aggregate observation pair references"):
                fm.ExternalLeadCurrentSource(**values)
            values = source_input()
            facets = values["lead_mesh"]["facets"]["nodes"]
            faces = [[101 + i for i in facets[start:start + 3]] for start in range(0, 54, 3)]
            values["outer_terminals"] = [fm.CurrentSourceOuterTerminal("a", faces), fm.CurrentSourceOuterTerminal("b", faces)]
            with self.assertRaisesRegex(ValueError, "aggregate outer terminal faces"):
                fm.ExternalLeadCurrentSource(**values)

    def test_lead_mesh_rejects_nonfinite_bad_csr_indices_and_singular_tets(self):
        for mutation in ("finite", "offset", "index", "repeated", "singular", "type", "facet", "marker", "facet-offset", "unknown", "cell-unknown", "facet-unknown", "periodic", "role"):
            values = source_input()
            mesh = values["lead_mesh"]
            if mutation == "finite": mesh["nodes"][0][0] = float("nan")
            if mutation == "offset": mesh["cells"]["offsets"][1] = 3
            if mutation == "index": mesh["cells"]["nodes"][0] = len(mesh["nodes"])
            if mutation == "repeated": mesh["cells"]["nodes"][1] = mesh["cells"]["nodes"][0]
            if mutation == "singular": mesh["nodes"][7] = mesh["nodes"][0].copy()
            if mutation == "type": mesh["cells"]["types"][0] = "hex8"
            if mutation == "facet": mesh["facets"]["nodes"][0] = mesh["facets"]["nodes"][1]
            if mutation == "marker": mesh["element_markers"] = [1]
            if mutation == "facet-offset": mesh["facets"]["offsets"][1] = 4
            if mutation == "unknown": mesh["unknown"] = 1
            if mutation == "cell-unknown": mesh["cells"]["unknown"] = 1
            if mutation == "facet-unknown": mesh["facets"]["unknown"] = 1
            if mutation == "periodic": mesh["periodic_node_pairs"] = [{"slave": 1, "master": 2}]
            if mutation == "role": mesh["facets"]["roles"][0] = "material_interface"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                fm.ExternalLeadCurrentSource(**values)


if __name__ == "__main__":
    unittest.main()
