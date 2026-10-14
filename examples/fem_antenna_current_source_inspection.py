"""Stage-first current-driven antenna inspection, without Relax or Run.

This meter-scale, 1 A fixture tests the accepted V/RT0/H producer. Two disjoint
rectangular conductors share one original MeshIR; four explicit leads carry
opposite signal/return currents. It is not a closed-circuit or RF qualification:
the external electrodes truncate the modeled source. The result remains
inspection_only, H in A/m, not a reusable H-per-ampere basis for LLG or FFT.
The separate magnetic probe supplies the session's existing mesh/m carrier;
this example does not establish a standalone session without any magnet.
"""

from collections import Counter
import json
from pathlib import Path

import fullmag as fm


# %% Explicit execution and independently authored sampling carrier
ROOT = Path(__file__).resolve().parent
SOURCE_MESH = ROOT / "assets" / "fem_antenna_current_source.mesh.json"
PROBE_MESH = ROOT / "assets" / "fem_antenna_current_probe.mesh.json"

study = fm.study("fem_antenna_current_source_inspection")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=1.0, order=1)

study.antenna_object(fm.ImportedGeometry(source=str(SOURCE_MESH)), name="antenna")
probe = study.geometry(fm.ImportedGeometry(source=str(PROBE_MESH)), name="probe")
probe.Ms = 8.0e5
probe.Aex = 13.0e-12
probe.alpha = 0.02
probe.m = fm.init.UniformMagnetization((0.0, 0.0, 1.0))


# %% Small geometry helper: four explicit volumetric leads, no mesh generator
def lead_cubes() -> dict:
    nodes, tets = [], []
    for x, y in ((-1.0, 0.0), (1.0, 0.0), (-1.0, 2.0), (1.0, 2.0)):
        offset = len(nodes)
        nodes.extend([[x, y, 0.0], [x + 1, y, 0.0], [x + 1, y + 1, 0.0], [x, y + 1, 0.0],
                      [x, y, 1.0], [x + 1, y, 1.0], [x + 1, y + 1, 1.0], [x, y + 1, 1.0]])
        tets.extend([[offset + v for v in tet] for tet in
                     ((0, 1, 2, 6), (0, 2, 3, 6), (0, 3, 7, 6),
                      (0, 7, 4, 6), (0, 4, 5, 6), (0, 5, 1, 6))])
    incidence = Counter()
    for tet in tets:
        for omitted in range(4):
            incidence[tuple(sorted(tet[:omitted] + tet[omitted + 1:]))] += 1
    faces = sorted(face for face, count in incidence.items() if count == 1)
    return {"mesh_name": "antenna_four_external_leads_v1", "nodes": nodes,
            "cells": {"types": ["tet4"] * len(tets), "offsets": list(range(0, 4 * len(tets) + 1, 4)),
                      "nodes": [v for tet in tets for v in tet]},
            "element_markers": [1] * len(tets),
            "facets": {"types": ["tri3"] * len(faces), "roles": ["exterior"] * len(faces),
                       "offsets": list(range(0, 3 * len(faces) + 1, 3)), "nodes": [v for face in faces for v in face]},
            "boundary_markers": [1] * len(faces)}


def plane_faces(mesh: dict, ids: list[int], x: float, y: float) -> list[list[int]]:
    facets = mesh["facets"]
    faces = [facets["nodes"][start:stop] for start, stop in zip(facets["offsets"], facets["offsets"][1:])]
    return [sorted(ids[v] for v in face) for face in faces
            if all(mesh["nodes"][v][0] == x and y <= mesh["nodes"][v][1] <= y + 1.0 for v in face)]


# %% Input-only current source: no caller-authored solution digest or RT0 view
device_mesh = json.loads(SOURCE_MESH.read_text(encoding="utf-8"))
lead_mesh = lead_cubes()
device_ids = list(range(1, len(device_mesh["nodes"]) + 1))
lead_ids = list(range(101, 101 + len(lead_mesh["nodes"])))
device_xyz = dict(zip(device_ids, device_mesh["nodes"]))
lead_xyz = dict(zip(lead_ids, lead_mesh["nodes"]))
interfaces, observations, terminals, currents = [], [], [], {}
for branch, y, direction in (("signal", 0.0, 1.0), ("return", 2.0, -1.0)):
    for end, x, outer_x, sign in (("in", 0.0, -1.0, -1.0), ("out", 1.0, 2.0, 1.0)):
        pair_ids = []
        for face in plane_faces(device_mesh, device_ids, x, y):
            lead_face = next(candidate for candidate in plane_faces(lead_mesh, lead_ids, x, y)
                             if {tuple(lead_xyz[v]) for v in candidate} == {tuple(device_xyz[v]) for v in face})
            pairs = [[v, next(w for w in lead_face if lead_xyz[w] == device_xyz[v])] for v in face]
            pair_id = f"{branch}-{end}-{len(pair_ids)}"
            pair_ids.append(pair_id)
            interfaces.append(fm.CurrentSourceInterfacePair(pair_id, face, lead_face, pairs))
        observations.append(fm.CurrentSourceTerminalObservation(f"{branch}-{end}", "antenna", pair_ids))
        terminal_id = f"outer-{branch}-{end}"
        terminals.append(fm.CurrentSourceOuterTerminal(terminal_id, plane_faces(lead_mesh, lead_ids, outer_x, y)))
        # Signed OUTWARD flux: inflow negative, outflow positive.
        currents[terminal_id] = sign * direction

source = fm.ExternalLeadCurrentSource(
    revision="antenna_signal_return_input_v1",
    device_stable_vertex_ids=device_ids,
    lead_mesh=lead_mesh,
    lead_stable_vertex_ids=lead_ids,
    lead_conductivity_spm_per_element=[8.0] * len(lead_mesh["cells"]["types"]),
    interface_pairs=interfaces,
    outer_terminals=terminals,
    terminal_observations=observations,
    drives=[fm.CurrentSourceDrive("drive", "port", currents)],
)
region = fm.RegionRef("antenna")
study.current_transport(
    name="antenna_charge", model="ohmic_poisson", coupling="one_way",
    domain=[region],
    materials=[fm.ChargeTransportMaterialAssignment(region, fm.ChargeTransportMaterial(4.0))],
    boundaries=[], gauge=fm.ChargePotentialGauge("terminal_reference"),
    solver=fm.ChargeSolverPolicy(operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
    conservative_current_source=source,
)
port = fm.AntennaPortMode(
    id="port", source_object_id="antenna", current_transport_id="antenna_charge",
    normalization_current_a=1.0,
    branches=[fm.AntennaPortBranch("signal", "signal-in", "signal-out", 1.0),
              fm.AntennaPortBranch("return", "return-in", "return-out", -1.0)],
)
study.add_antenna_port_mode(port_mode=port)


# %% Only the antenna solve; never attach this unqualified output to a consumer
study.stages.add_antenna_field_solve(
    id="inspect_antenna",
    definition=fm.AntennaFieldSolveStage(
        id="inspect_antenna", source_object_id="antenna", current_transport_id="antenna_charge",
        port_mode_ids=["port"], field_sampling_domain=fm.FieldTarget.object("probe"),
        target_refs=[fm.FieldTarget.object("probe")],
        # Existing stage schema uses this selector; the inspection publisher
        # emits raw H (A/m), NOT a qualified H_ant_basis (A/m/A) asset.
        outputs=[fm.AntennaNamedOutput("inspection", "H_ant_basis")],
    ),
)
