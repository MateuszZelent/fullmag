"""Public FEM CPU fixture for volumetric external-lead Oersted coupling.

The imported device MeshIR owns the stable vertex ordering used by the
conservative RT0 view.  Two disjoint volumetric leads close the circuit outside
the magnetic cube.  This is a bounded execution fixture, not a convergence or
production qualification case.
"""

from __future__ import annotations

from pathlib import Path

import fullmag as fm


ROOT = Path(__file__).resolve().parent
DEVICE_MESH = ROOT / "assets" / "fem_external_lead_device.mesh.json"


def cube_parts(x_min: float) -> tuple[list[list[float]], list[list[int]], list[list[int]]]:
    nodes = [
        [x_min, 0.0, 0.0],
        [x_min + 1.0, 0.0, 0.0],
        [x_min + 1.0, 1.0, 0.0],
        [x_min, 1.0, 0.0],
        [x_min, 0.0, 1.0],
        [x_min + 1.0, 0.0, 1.0],
        [x_min + 1.0, 1.0, 1.0],
        [x_min, 1.0, 1.0],
    ]
    cells = [
        [0, 1, 2, 6],
        [0, 2, 3, 6],
        [0, 3, 7, 6],
        [0, 7, 4, 6],
        [0, 4, 5, 6],
        [0, 5, 1, 6],
    ]
    faces = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [3, 7, 6],
        [3, 6, 2],
        [0, 4, 7],
        [0, 7, 3],
        [1, 2, 6],
        [1, 6, 5],
    ]
    return nodes, cells, faces


left_nodes, left_cells, left_faces = cube_parts(-1.0)
right_nodes, right_cells, right_faces = cube_parts(1.0)
lead_cells = left_cells + [[node + 8 for node in cell] for cell in right_cells]
lead_faces = left_faces + [[node + 8 for node in face] for face in right_faces]
lead_mesh = {
    "mesh_name": "fem_external_leads_v1",
    "nodes": left_nodes + right_nodes,
    "cells": {
        "types": ["tet4"] * len(lead_cells),
        "offsets": [4 * index for index in range(len(lead_cells) + 1)],
        "nodes": [node for cell in lead_cells for node in cell],
        "global_ordinals": list(range(len(lead_cells))),
    },
    "element_markers": [1] * 6 + [2] * 6,
    "facets": {
        "types": ["tri3"] * len(lead_faces),
        "roles": ["exterior"] * len(lead_faces),
        "offsets": [3 * index for index in range(len(lead_faces) + 1)],
        "nodes": [node for face in lead_faces for node in face],
        "global_ordinals": list(range(len(lead_faces))),
    },
    "boundary_markers": [1] * 12 + [2] * 12,
}

identity = fm.ConservativeCurrentIdentity(
    source_module_id="external_lead_charge",
    source_state_revision="external-lead-state-v1",
    source_field_digest="external-lead-field-v1",
    conductivity_digest="external-lead-device-sigma-v1",
    mesh_revision="fem-external-lead-device-v1",
    topology_revision="fem-external-lead-topology-v1",
    geometry_digest="fem-external-lead-geometry-v1",
    envelope_revision="constant-envelope-v1",
    envelope_digest="constant-envelope-digest-v1",
    evaluated_envelope_multiplier=1.0,
    evaluation_time_s=0.0,
    stage_identity=1,
)
boundary_faces = [
    fm.ConservativeCurrentBoundaryFace(face, "insulating_outer")
    for face in [
        [1, 2, 3],
        [1, 3, 4],
        [5, 6, 7],
        [5, 7, 8],
        [1, 2, 6],
        [1, 5, 6],
        [4, 7, 8],
        [3, 4, 7],
    ]
]
boundary_faces.extend(
    fm.ConservativeCurrentBoundaryFace(face, "closure_interface", "lead-interface")
    for face in [[1, 5, 8], [1, 4, 8], [2, 3, 7], [2, 6, 7]]
)
view = fm.ConservativeCurrentView(
    stable_vertex_ids=list(range(1, 9)),
    boundary_faces=boundary_faces,
    identity=identity,
    pins=fm.ConservativeCurrentPins(
        required_source_state_revision=identity.source_state_revision,
        required_source_field_digest=identity.source_field_digest,
        required_mesh_revision=identity.mesh_revision,
        required_topology_revision=identity.topology_revision,
    ),
    closure=fm.ConservativeCurrentExternalLead(
        operator_version="fem_closed_current_extension.v1",
        revision="external-leads-v1",
        digest="external-leads-digest-v1",
        drive_id="external-lead-voltage-drop",
        outer_electrode_potential_drop_v=-1.0,
        lead_mesh=lead_mesh,
        lead_conductivity_spm_per_element=[1.0] * 12,
        lead_stable_vertex_ids=list(range(101, 109)) + list(range(201, 209)),
        interface_pairs=[
            fm.ConservativeCurrentLeadInterfacePair([1, 5, 8], [102, 106, 107]),
            fm.ConservativeCurrentLeadInterfacePair([1, 4, 8], [102, 103, 107]),
            fm.ConservativeCurrentLeadInterfacePair([2, 3, 7], [201, 204, 208]),
            fm.ConservativeCurrentLeadInterfacePair([2, 6, 7], [201, 205, 208]),
        ],
        minus_outer_electrode_face_vertex_ids=[[101, 105, 108], [101, 104, 108]],
        plus_outer_electrode_face_vertex_ids=[[202, 203, 207], [202, 206, 207]],
        lead_conductivity_digest="external-leads-sigma-v1",
    ),
    algebraic_relative_tolerance=1.0e-10,
    physical_relative_gate=1.0e-8,
    physical_absolute_gate_a=1.0e-12,
)

study = fm.study("fem_external_lead_oersted_public")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(1.0, 1.0, 1.0), center=(0.5, 0.5, 0.5))
study.domain_mesh(DEVICE_MESH, region_markers={"device": 1})
study.exchange(enabled=False)
study.demag(enabled=False)

device = study.geometry(fm.Box(size=(1.0, 1.0, 1.0), name="device"), name="device")
device.Ms = 8.0e5
device.Aex = 13.0e-12
device.alpha = 0.02
device.m = fm.init.UniformMagnetization((0.0, 0.0, 1.0))

region = fm.RegionRef("device")
device_surfaces = [
    fm.SurfaceRef("device", "x_min", (-1.0, 0.0, 0.0)),
    fm.SurfaceRef("device", "x_max", (1.0, 0.0, 0.0)),
    fm.SurfaceRef("device", "y_min", (0.0, -1.0, 0.0)),
    fm.SurfaceRef("device", "y_max", (0.0, 1.0, 0.0)),
    fm.SurfaceRef("device", "z_min", (0.0, 0.0, -1.0)),
    fm.SurfaceRef("device", "z_max", (0.0, 0.0, 1.0)),
]
charge = study.current_transport(
    name="external_lead_charge",
    model="ohmic_poisson",
    coupling="one_way",
    domain=[region],
    materials=[
        fm.ChargeTransportMaterialAssignment(region, fm.ChargeTransportMaterial(1.0))
    ],
    # The scalar charge solve remains well-posed and explicitly insulating;
    # the conservative RT0 closure below owns the external voltage drive.
    boundaries=[fm.ChargeInsulating("device_outer", device_surfaces)],
    gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(),
    conservative_current_view=view,
)
study.spin_transport(
    fm.SpinDriftDiffusion(
        id="external_lead_spin",
        current_source_id=charge.name,
        domain=[region],
        materials=[
            fm.SpinTransportMaterialAssignment(
                region,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=1.0,
                    polarization_p=0.0,
                    theta_sh=0.0,
                    lambda_sf_m=1.0,
                ),
            )
        ],
        requested_execution=fm.TransportExecution(
            discretization="fem",
            device="cpu",
            precision="double",
            execution_mode="strict",
        ),
    )
)
study.oersted(fm.OerstedField(source=charge.name))
study.stages.add_run(3.0e-13, stage_id="external_lead_oersted_run")
