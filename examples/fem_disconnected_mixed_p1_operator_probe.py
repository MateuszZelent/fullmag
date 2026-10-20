"""Bounded mixed-P1 FEM operator probe with two separated magnetic bodies.

The probe is deliberately smaller than the public CoFeB-ring study.  It has
one exact swept prism layer and one independently meshed tetrahedral annulus,
with a positive air gap.  The two bodies own different material fields and
initial states; no coefficient is interpolated through air or across the gap.

This source only requests the probe contract.  The verifier consumes the
ordinary native run artifacts: typed mesh connectivity and the v2 certificate
from ``metadata.json``, ``m_initial.json``, ``scalars.csv`` and persisted Zarr
fields.  It computes the body P1 masses independently from the persisted mesh;
there is no probe-specific result JSON or generated body-mass sidecar.

Run through the selected Docker Compose development group, for example:

    $env:FULLMAG_ARTIFACT_FIELD_STORAGE = "zarr"
    $env:FULLMAG_MIXED_P1_DEVICE = "gpu"
    just docker-dev "<checkout>" 3197 "examples/fem_disconnected_mixed_p1_operator_probe.py"

For the CPU comparison, run the same source in a separate artifact directory
with ``FULLMAG_MIXED_P1_DEVICE=cpu``.  The environment choice is recorded in
runtime provenance; it is not an implicit launcher override.  A forced GPU
lane must never fall back to CPU.
"""

from __future__ import annotations

import fullmag as fm
import os


NM = 1e-9
PROBE_SCHEMA_VERSION = "fem_disconnected_mixed_p1_operator_probe.v1"

# The prism body is one exact layer along z.  The ring starts after an 8 nm
# vacuum gap and is tetrahedral; it is not an interfacial/shared-node body.
BOX_SIZE_M = (60.0 * NM, 30.0 * NM, 4.0 * NM)
RING_OUTER_RADIUS_M = 10.0 * NM
RING_INNER_RADIUS_M = 4.0 * NM
RING_THICKNESS_M = 4.0 * NM
BODY_GAP_M = 8.0 * NM
RING_CENTER_Z_M = BOX_SIZE_M[2] / 2.0 + BODY_GAP_M + RING_THICKNESS_M / 2.0
UNIVERSE_SIZE_M = (100.0 * NM, 80.0 * NM, 80.0 * NM)

# A non-zero uniform B field makes the per-body Zeeman oracle observable.
B_EXT_T = (0.020, 0.010, 0.015)

REQUESTED_DEVICE = os.environ.get("FULLMAG_MIXED_P1_DEVICE", "gpu").strip().lower()
if REQUESTED_DEVICE not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_MIXED_P1_DEVICE must be exactly 'cpu' or 'gpu'")

BOX_OBJECT_ID = "mixed_p1_box_prism"
RING_OBJECT_ID = "mixed_p1_tet_ring"


def ring_geometry() -> object:
    """Return an annulus whose axis is z and whose thickness is along z."""

    outer = fm.Cylinder(
        radius=RING_OUTER_RADIUS_M,
        height=RING_THICKNESS_M,
        axis=(0.0, 0.0, 1.0),
        name="mixed_p1_ring_outer",
    )
    inner = fm.Cylinder(
        radius=RING_INNER_RADIUS_M,
        height=RING_THICKNESS_M,
        axis=(0.0, 0.0, 1.0),
        name="mixed_p1_ring_inner",
    )
    return (outer - inner).translate((0.0, 0.0, RING_CENTER_Z_M))


def build_study() -> fm.StudyBuilder:
    """Author the two-body FEM study consumed by the managed probe gate."""

    study = fm.study("fem_disconnected_mixed_p1_operator_probe")
    study.engine("fem")
    study.device(REQUESTED_DEVICE, precision="double")
    study.mode("strict")
    study.universe(
        mode="manual",
        size=UNIVERSE_SIZE_M,
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(
        minimum_element_size=2.0 * NM,
        maximum_element_size=12.0 * NM,
        growth_rate=1.5,
    )

    box = study.geometry(
        fm.Box(size=BOX_SIZE_M, name="mixed_p1_box"),
        name=BOX_OBJECT_ID,
        object_id=BOX_OBJECT_ID,
    )
    box.Ms = 800e3
    box.Aex = 13e-12
    box.alpha = 0.02
    box.Ku1 = 2.5e4
    box.anisU = (0.0, 0.0, 1.0)
    box.m = fm.texture.uniform(0.0, 0.0, 1.0)
    box.mesh(
        minimum_element_size=2.0 * NM,
        maximum_element_size=8.0 * NM,
        order=1,
        mesh_strategy="swept_prism",
        topology="prismatic",
        through_thickness_elements=1,
        through_thickness_distribution="fixed",
        sweep_face_meshing="triangular",
        sweep_direction="z",
        element_family="prism",
        transition_policy="pyramid_to_tetrahedra",
        exact_layer_count=True,
    )

    ring = study.geometry(
        ring_geometry(),
        name=RING_OBJECT_ID,
        object_id=RING_OBJECT_ID,
    )
    ring.Ms = 1.1e6
    ring.Aex = 21e-12
    ring.alpha = 0.1
    ring.Ku1 = 7.0e4
    ring.anisU = (1.0, 0.0, 0.0)
    ring.m = fm.texture.uniform(1.0, 0.0, 0.0)
    ring.mesh(
        minimum_element_size=2.0 * NM,
        maximum_element_size=6.0 * NM,
        order=1,
    )

    study.runtime_metadata(
        "mixed_p1_operator_probe",
        {
            "schema_version": PROBE_SCHEMA_VERSION,
            "status": "requested_not_verified",
            "source_role": "disconnected_box_prism_plus_tet_ring",
            "body_object_ids": [BOX_OBJECT_ID, RING_OBJECT_ID],
            "positive_body_gap_m": BODY_GAP_M,
            "requested_device": REQUESTED_DEVICE,
            "required_native_artifacts": [
                "metadata.json",
                "m_initial.json",
                "scalars.csv",
                "fields/H_ex.zarr",
                "fields/H_demag.zarr",
                "fields/H_eff.zarr",
            ],
            "optional_native_artifacts": ["fields/H_ext.zarr", "fields/H_ani.zarr"],
            "required_scalar_observables": ["E_ex", "E_ext", "E_ani", "E_total"],
            "analytic_energy_units": {"zeeman": "J", "uniaxial": "J"},
            "exchange_gap_contract": {
                "contact_state": "separated",
                "cross_body_exchange": "forbidden",
                "coefficient_smoothing": "forbidden",
                "cpu_gpu_fallback": "forbidden",
            },
            "uniform_external_field_B_T": list(B_EXT_T),
            "body_material_contract": {
                BOX_OBJECT_ID: {
                    "Ms_A_per_m": 800e3,
                    "Aex_J_per_m": 13e-12,
                    "alpha": 0.02,
                    "Ku1_J_per_m3": 2.5e4,
                    "anisotropy_axis": [0.0, 0.0, 1.0],
                    "m_unit": [0.0, 0.0, 1.0],
                },
                RING_OBJECT_ID: {
                    "Ms_A_per_m": 1.1e6,
                    "Aex_J_per_m": 21e-12,
                    "alpha": 0.1,
                    "Ku1_J_per_m3": 7.0e4,
                    "anisotropy_axis": [1.0, 0.0, 0.0],
                    "m_unit": [1.0, 0.0, 0.0],
                },
            },
        },
    )

    study.b_ext(*B_EXT_T)
    study.exchange()
    study.demag(realization="poisson_robin")
    study.objects.mesh.defaults(
        algorithm_2d=6,
        algorithm_3d=10,
        smoothing_steps=1,
        optimize_iterations=1,
        compute_quality=True,
        per_element_quality=True,
    )
    study.build_domain_mesh()

    # The accepted step-0 row and fields are the operator oracle.  One bounded
    # PG-BB step exercises the same assembled operators without claiming a
    # converged physical study.
    study.tableautosave(
        every_steps=1,
        quantities=[
            "time",
            "step",
            "e_ex",
            "e_ext",
            "e_ani",
            "e_total",
            "max_torque",
        ],
        table_id="mixed_p1_operator_probe",
    )
    for quantity in ("m", "H_ex", "H_demag", "H_ext", "H_ani", "H_eff"):
        study.save(quantity, every=1e-15)

    study.stages.add_minimize(
        stage_id="operator_probe",
        method="bb",
        max_steps=1,
        tolA=1e-3,
    )
    # This probe is a bounded batch run; it must not silently become a
    # workspace wait-for-solve session.
    study.interactive(False)
    study.wait_for_solve(False)
    return study


study = build_study()
