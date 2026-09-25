"""Executable COMSOL-aligned FEM modal-dispersion benchmark.

Run one control from the repository root with::

    FULLMAG_COMSOL_DISPERSION_CASE=c0 fullmag --dev -i \
      tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py
    FULLMAG_COMSOL_DISPERSION_CASE=c1 fullmag --dev -i \
      tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py
    FULLMAG_COMSOL_DISPERSION_CASE=a1 fullmag --dev -i \
      tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py

The default is A1.  This file only authors the public Fullmag DSL.  The
native shared-domain artifact writer reconstructs physical potential fields
for selected modes. Runtime qualification remains separate from authoring.
"""

from __future__ import annotations

import fullmag as fm

from tests.standard_problems.mumag.comsol_nonzero_k_dispersion.config import (
    AIRBOX_GROWTH_RATE,
    AIRBOX_HMAX_M,
    A_LAT_M,
    AEX_J_PER_M,
    BIAS_FIELD_T,
    DEMAG_SOLVER_MAX_ITERATIONS,
    DEMAG_SOLVER_RTOL,
    EIGEN_SOLVER_MAX_LINEAR_ITERATIONS,
    EIGEN_SOLVER_MAX_OUTER_ITERATIONS,
    EIGEN_SOLVER_RTOL,
    FILM_THICKNESS_M,
    FREQUENCY_WINDOW_HZ,
    GAMMA_M_PER_A_S,
    HOLE_RADIUS_M,
    INTERFACE_HMAX_M,
    INTERFACE_THICKNESS_M,
    INTERFACE_TRANSITION_DISTANCE_M,
    MS_A_PER_M,
    RELAX_ALPHA,
    RELAX_DT_S,
    RELAX_MAX_STEPS,
    RELAX_TORQUE_TOLERANCE_A_PER_M,
    THIN_FILM_LAYERS,
    THIN_FILM_ORDER,
    UNIVERSE_SIZE_M,
    build_k_sampling,
    case_from_environment,
    guide_metadata,
    mode_field_selection,
    requested_mode_count,
)


CASE = case_from_environment()

study = fm.study(CASE.study_name)
study.engine("fem")
# Floquet dynamic demagnetization is currently a strict CPU lane.
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.wait_for_solve(True)

study.universe(
    mode="manual",
    size=UNIVERSE_SIZE_M,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=AIRBOX_HMAX_M,
    maximum_element_growth_rate=AIRBOX_GROWTH_RATE,
    grading="geometric",
)
study.pbc(
    x=True,
    y=True,
    demag="periodic_airbox_k0" if CASE.include_demag else "open",
)
# pbc() synchronizes these matching source/destination mesh pairs. Keep the
# declaration visible in the authored workflow for reviewers and exporters.
study.objects.mesh.defaults(periodic_pair_ids=["x_faces", "y_faces"])

film = fm.Box(
    size=(A_LAT_M, A_LAT_M, FILM_THICKNESS_M),
    name="full_film",
)
if CASE.has_hole:
    hole = fm.Cylinder(
        radius=HOLE_RADIUS_M,
        height=FILM_THICKNESS_M,
        name="air_hole",
    )
    magnetic_shape = film - hole
    body_name = "antidot_film"
else:
    magnetic_shape = film
    body_name = "full_film"

body = study.geometry(magnetic_shape, name=body_name)
body.Ms = MS_A_PER_M
body.Aex = AEX_J_PER_M
# The relaxation stage overrides alpha with the guide value; the eigen stage
# requests damping_policy="ignore", which represents alpha_eig=0.
body.alpha = RELAX_ALPHA
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=INTERFACE_HMAX_M,
    maximum_element_size=INTERFACE_HMAX_M,
    interface_maximum_element_size=INTERFACE_HMAX_M,
    interface_thickness=INTERFACE_THICKNESS_M,
    transition_distance=INTERFACE_TRANSITION_DISTANCE_M,
    edge_maximum_element_size=INTERFACE_HMAX_M,
    edge_thickness=INTERFACE_THICKNESS_M,
    edge_transition_distance=INTERFACE_TRANSITION_DISTANCE_M,
    layers=THIN_FILM_LAYERS,
    topology="tetrahedral",
    order=THIN_FILM_ORDER,
)

study.b_ext(*BIAS_FIELD_T)
study.exchange()
if CASE.include_demag:
    # Explicit Dirichlet top/bottom airbox semantics from the COMSOL guide.
    study.demag(model="airbox", variant="dirichlet")
else:
    study.disable_demag()
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=DEMAG_SOLVER_RTOL,
    max_iterations=DEMAG_SOLVER_MAX_ITERATIONS,
)
study.solver(gamma=GAMMA_M_PER_A_S, fix_dt=RELAX_DT_S)
study.build_domain_mesh()

# Retain the spectrum and selected physical fields for comparison. The native
# shared-domain writer also reconstructs the scalar potential and its gradient.
study.save("spectrum")
study.save("dispersion", include_branch_table=True)
study.save("diagnostics")
mode_field_indices, mode_field_samples = mode_field_selection(CASE)
study.save(
    "mode",
    field="mode",
    indices=mode_field_indices,
    sample_indices=mode_field_samples,
)

study.runtime_metadata(
    "comsol_nonzero_k_dispersion",
    {
        **guide_metadata(CASE),
        "public_workflow": {
            "script": "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py",
            "case_selector": "FULLMAG_COMSOL_DISPERSION_CASE",
            "default_case": "a1",
            "requested_backend": "fem",
            "requested_device": "cpu",
            "requested_precision": "double",
            "execution_mode": "strict",
        },
        "controls": {
            "airbox_size_m": list(UNIVERSE_SIZE_M),
            "frequency_window_hz": list(FREQUENCY_WINDOW_HZ),
            "relax_max_steps": RELAX_MAX_STEPS,
            "relax_dt_s": RELAX_DT_S,
            "relax_torque_tolerance_A_per_m": RELAX_TORQUE_TOLERANCE_A_PER_M,
        },
    },
)

study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    dt=RELAX_DT_S,
    relax_alpha=RELAX_ALPHA,
    max_steps=RELAX_MAX_STEPS,
    tolA=RELAX_TORQUE_TOLERANCE_A_PER_M,
)

sampling = build_k_sampling(CASE)
if CASE.use_floquet:
    spin_bc = fm.FloquetBC(
        ["x_faces", "y_faces"],
        phase_convention="exp_minus_i_k_dot_delta_r",
    )
    dynamic_demag_bc = "floquet_airbox"
else:
    spin_bc = fm.PeriodicBC(["x_faces", "y_faces"])
    dynamic_demag_bc = "open"

study.stages.add_eigenmodes(
    count=requested_mode_count(CASE),
    target="frequency_window",
    frequency_min=FREQUENCY_WINDOW_HZ[0],
    frequency_max=FREQUENCY_WINDOW_HZ[1],
    operator="full_2x2",
    include_demag=CASE.include_demag,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    solver_rtol=EIGEN_SOLVER_RTOL,
    k_sampling=sampling,
    bc=spin_bc,
    magnetostatic_bc=dynamic_demag_bc,
    solver_max_outer_iterations=EIGEN_SOLVER_MAX_OUTER_ITERATIONS,
    solver_max_linear_iterations=EIGEN_SOLVER_MAX_LINEAR_ITERATIONS,
)
