"""Closed 3-D GSG source with nominal cross-section based on Sushruth et al., PR Research 2, 043203 (2020).

Nominal cross-section: Sec. IV / Fig. 6, DOI 10.1103/PhysRevResearch.2.043203.
This is an input for static V/J/H inspection, not a reproduction of spin-wave
transmission or the zero-thickness, infinite-wire Fig. 1 model. Finite end crossbars close the circuit; an ideal inlet potential jump drives
the central neck. End geometry is an authored approximation, not published pads.
Native solve and full-circuit convergence remain unqualified.
See docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md.
"""

import fullmag as fm


# %% Nominal experimental cross-section (SI), not the fitted Fig. 6 parameters
conductor_width_m = 200e-9
gap_m = 250e-9
metal_thickness_m = 90e-9
insulator_thickness_m = 30e-9
# Contiguous magnetic Ni/Co stack: 21 * (0.6 + 0.2) + 0.6 nm.
magnetic_thickness_m = 17.4e-9
# Cu(2.5)/Ta(2.5) above the magnetic stack, below the SiO2.
cap_thickness_m = 5e-9

# Additional authored assumptions, not reported experimental source parameters:
# 20 um is the published conduit width; here it defines a finite source window.
source_length_m = 20e-6
connection_length_m = 2e-6
crossbar_length_m = 200e-9
source_cut_u_m = -1e-6
conductivity_s_per_m = 3.5e7
source_voltage_v = 1e-3
# Coarse preparation mesh only; quantitative comparison requires refinement.
mesh_size_m = 75e-9
local_mesh_size_m = 50e-9
corner_mesh_size_m = 25e-9
sampling_length_m = 4e-6
sampling_width_m = 100e-9
sampling_depth_m = magnetic_thickness_m
conductor_parts = ("signal", "ground_left", "ground_right")


# %% Explicit FEM CPU execution; no magnetic object, Relax or Run
study = fm.study("gsg_junction_prepare_corner25nm")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(
    maximum_element_size=mesh_size_m, minimum_element_size=corner_mesh_size_m, order=1,
)


# %% World x follows propagation; the signal current follows world +y
# z=0 is the top of the capped multilayer, not the magnetic surface.
# Metal occupies z=30..120 nm; magnetic Ni/Co occupies z=-22.4..-5 nm.
# Local u -> world +y, local v -> world -x is a proper rotation.
study.antenna_object(
    fm.CPWAntennaLayout(
        name="antenna", length_m=source_length_m, thickness_m=metal_thickness_m,
        conductivity_s_per_m=conductivity_s_per_m,
        stations=[
            fm.CPWWidthStation(s, conductor_width_m, gap_m=gap_m, ground_width_m=conductor_width_m)
            for s in (0.0, 1.0)
        ],
        closed_loop=True,
        inlet_connection_length_m=connection_length_m,
        inlet_crossbar_length_m=crossbar_length_m,
        inlet_connection_part_id="inlet",
        inlet_connection_conductivity_s_per_m=conductivity_s_per_m,
        outlet_connection_length_m=connection_length_m,
        outlet_crossbar_length_m=crossbar_length_m,
        outlet_connection_part_id="outlet",
        outlet_connection_conductivity_s_per_m=conductivity_s_per_m,
        transform=fm.RigidTransform(
            rotation_matrix=((0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
            translation_m=(0.0, -0.5 * source_length_m, insulator_thickness_m + 0.5 * metal_thickness_m),
        ),
    ), name="GSG antenna", object_id="antenna",
)
# %% Local junction mesh sizes in world SI; preparation candidates only
antenna_mesh = study.objects.mesh.by_id("antenna")
antenna_mesh.size_field(
    "AxisAlignedBoxDistanceThreshold",
    BoundsMin=(-550e-9, -12e-6, 30e-9), BoundsMax=(550e-9, -9.8e-6, 120e-9),
    SizeMin=local_mesh_size_m, SizeMax=mesh_size_m, DistMin=0.0, DistMax=200e-9,
)
antenna_mesh.size_field(
    "AxisAlignedBoxDistanceThreshold",
    BoundsMin=(-550e-9, 9.8e-6, 30e-9), BoundsMax=(550e-9, 12e-6, 120e-9),
    SizeMin=local_mesh_size_m, SizeMax=mesh_size_m, DistMin=0.0, DistMax=200e-9,
)

# The eight re-entrant vertical edges dominate the retained current correction.
# Degenerate analytic boxes measure distance to the edge; they add no geometry.
for corner_x_m in (
    -0.5 * conductor_width_m - gap_m, -0.5 * conductor_width_m,
    0.5 * conductor_width_m, 0.5 * conductor_width_m + gap_m,
):
    for corner_y_m in (
        -0.5 * source_length_m - connection_length_m + crossbar_length_m,
        0.5 * source_length_m + connection_length_m - crossbar_length_m,
    ):
        antenna_mesh.size_field(
            "AxisAlignedBoxDistanceThreshold",
            BoundsMin=(corner_x_m, corner_y_m, insulator_thickness_m),
            BoundsMax=(corner_x_m, corner_y_m, insulator_thickness_m + metal_thickness_m),
            SizeMin=corner_mesh_size_m, SizeMax=mesh_size_m,
            DistMin=100e-9, DistMax=200e-9,
        )

# Central observation window spanning the actual magnetic thickness.
# The 4 um x 100 nm window is authored, not the full 20 um-wide conduit.
# No material/LLG is activated by this field-sampling geometry.
study.geometry_object(
    fm.Box(sampling_length_m, sampling_width_m, sampling_depth_m, name="sampling").translate(
        (0.0, 0.0, -cap_thickness_m - 0.5 * sampling_depth_m)
    ), name="Co/Ni field sampling", object_id="sampling", type="geometry",
)


# %% Closed circuit: one inlet voltage source, no prescribed return currents
study.current_transport(
    name="gsg_charge", model="ohmic_poisson", coupling="one_way",
    domain=[fm.RegionRef("antenna")],
    materials=[fm.ChargeTransportMaterialAssignment(
        fm.RegionRef("antenna", part), fm.ChargeTransportMaterial(conductivity_s_per_m),
    ) for part in (*conductor_parts, "inlet", "outlet")],
    boundaries=[], gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(relative_tolerance=1e-12, absolute_tolerance=0.0,
        max_iterations=10000, operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
    structured_current_closure=fm.StructuredCurrentClosure(
        "gsg_loop", [fm.StructuredCurrentSourceCut(
            "inlet_cut", "gsg_circuit", fm.RegionRef("antenna", "inlet"),
            fm.StructuredCutPlane("x", source_cut_u_m, coordinate_frame="object"),
            fm.ImpressedPotentialJump("inlet_voltage", source_voltage_v),
        )], schema_version="structured_current_closure.v2",
    ),
)
study.add_antenna_port_mode(port_mode=fm.AntennaPortMode(
    id="gsg_port", source_object_id="antenna", current_transport_id="gsg_charge",
    schema_version="antenna_port_mode.v3",
    normalization=fm.AntennaSourceCutRt0("inlet_cut", orientation="minus_outward"),
    # These are observation branches, not current boundary conditions.
    branches=[fm.AntennaPortBranch(part, f"{part}_in", f"{part}_out", 0.0)
              for part in conductor_parts],
))


# %% Explicit all-air diagnostic carrier, not an LLG or demag domain
study.domain_mesh("gsg-convergence-targets.fullmag-mesh", region_markers=[])


# %% Raw inspection fields only; no qualified basis, source FFT or LLG consumer
study.stages.add_antenna_field_solve(
    id="inspect_gsg", definition=fm.AntennaFieldSolveStage(
        id="inspect_gsg", source_object_id="antenna", current_transport_id="gsg_charge",
        # 14,329 source cells x 246 field nodes exceeds the default pair budget.
        solver_policy="volume_inspection_v1",
        port_mode_ids=["gsg_port"], field_sampling_domain=fm.FieldTarget.global_domain(),
        target_refs=[fm.FieldTarget.global_domain()],
        # Existing stage vocabulary; publication is raw H (A/m), inspection_only.
        outputs=[fm.AntennaNamedOutput("gsg_inspection", "H_ant_basis")],
    ),
)
