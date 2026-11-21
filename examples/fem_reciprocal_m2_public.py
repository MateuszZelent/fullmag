"""Minimalny publiczny fixture FEM M2 z torque transportowym.

Fixture jest celowo mały: jednorodny prostopadłościan z przenośnym,
otagowanym meshem P1, elektrodami ``left``/``right`` i jednym krótkim stage
LLG. Meshuje wyłącznie przewodzącą bryłę; demagnetyzacja pozostaje wyłączona.
Nie jest to benchmark ani dowód zbieżności. Jego rolą jest przejście pełnej
ścieżki Python -> ProblemIR -> planner -> native FEM M2 bez ukrytego
fallbacku do FDM.

Mesh można odtworzyć poleceniem
``python -B examples/generate_fem_reciprocal_m2_public_mesh.py``.
"""

from __future__ import annotations

import fullmag as fm


NM = 1.0e-9
BODY_SIZE = (30.0 * NM, 20.0 * NM, 4.0 * NM)
M2_OPERATOR = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"


study = fm.study("fem_reciprocal_m2_public")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
# This transport-only fixture contains no air region. The production
# demagnetization and airbox path is qualified separately.
study.demag(enabled=False)

body = study.geometry(fm.Box(size=BODY_SIZE, name="m2_body"), name="m2_body")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(source="fem_reciprocal_m2_public_mesh.npz", order=1)
study.build_mesh()

region = fm.RegionRef("m2_body")
x_min = fm.SurfaceRef("m2_body", "left", (-1.0, 0.0, 0.0))
x_max = fm.SurfaceRef("m2_body", "right", (1.0, 0.0, 0.0))
side_surfaces = [
    fm.SurfaceRef("m2_body", "back", (0.0, -1.0, 0.0)),
    fm.SurfaceRef("m2_body", "front", (0.0, 1.0, 0.0)),
    fm.SurfaceRef("m2_body", "bottom", (0.0, 0.0, -1.0)),
    fm.SurfaceRef("m2_body", "top", (0.0, 0.0, 1.0)),
]

charge = study.current_transport(
    name="m2_charge",
    model="ohmic_poisson",
    coupling="bidirectional",
    domain=[region],
    materials=[
        fm.ChargeTransportMaterialAssignment(
            region,
            fm.ChargeTransportMaterial(
                sigma_Spm=4.0e6,
                sigma_parallel_Spm=4.0e6,
                sigma_perpendicular_Spm=4.0e6,
                sigma_AHE_Spm=0.0,
            ),
        )
    ],
    boundaries=[
        fm.VoltageElectrode("source", [x_min], potential_V=0.0),
        fm.VoltageElectrode("drain", [x_max], potential_V=1.0e-3),
        fm.ChargeInsulating("sidewalls", side_surfaces),
    ],
    gauge=fm.ChargePotentialGauge("dirichlet_reference"),
    solver=fm.ChargeSolverPolicy(
        engine="block_gmres",
        relative_tolerance=1.0e-8,
        absolute_tolerance=0.0,
        max_iterations=200,
        operator_version=M2_OPERATOR,
    ),
)

spin = study.spin_transport(
    fm.SpinDriftDiffusion(
        id="m2_spin",
        current_source_id=charge.name,
        domain=[region],
        materials=[
            fm.SpinTransportMaterialAssignment(
                region,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=3.0e6,
                    polarization_p=0.2,
                    theta_sh=0.1,
                    lambda_sf_m=4.0 * NM,
                    lambda_j_m=1.0 * NM,
                    lambda_phi_m=1.0 * NM,
                ),
            )
        ],
        solver=fm.SpinSolverPolicy(
            engine="gmres",
            relative_tolerance=1.0e-8,
            absolute_tolerance=0.0,
            max_iterations=200,
            operator_version=M2_OPERATOR,
        ),
        requested_execution=fm.TransportExecution(
            discretization="fem",
            device="cpu",
            precision="double",
            execution_mode="strict",
        ),
    )
)
study.spin_torque(fm.DriftDiffusionSpinTorque("m2_torque", spin.id, region))
study.oersted(fm.OerstedField(source=charge.name))

study.stages.add_run(1.0e-15, stage_id="m2_run")
