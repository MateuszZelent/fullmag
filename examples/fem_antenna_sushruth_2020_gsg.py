"""Finite 3-D GSG source based on Sushruth et al., PR Research 2, 043203 (2020).

Nominal cross-section: Sec. IV / Fig. 6, DOI 10.1103/PhysRevResearch.2.043203.
This is an input for static V/J/H inspection, not a reproduction of spin-wave
transmission or the zero-thickness, infinite-wire Fig. 1 model. External leads
end at current-controlled electrodes; the omitted feed circuit is unqualified.
See docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md.
"""

import fullmag as fm


# %% Nominal experimental cross-section (SI), not the fitted Fig. 6 parameters
conductor_width_m = 200e-9
gap_m = 250e-9
metal_thickness_m = 90e-9
insulator_thickness_m = 30e-9

# Additional authored assumptions, not reported experimental source parameters:
# 20 um is the published conduit width; here it defines a finite source window.
source_length_m = 20e-6
lead_length_m = 2e-6
lead_layers = 20
conductivity_s_per_m = 3.5e7
signal_current_a = 1e-3
# Coarse preparation mesh only; quantitative comparison requires refinement.
mesh_size_m = 100e-9
sampling_length_m = 4e-6
sampling_width_m = 100e-9
sampling_depth_m = 10e-9
branch_weights = (("signal", 1.0), ("ground_left", -0.5), ("ground_right", -0.5))


# %% Explicit FEM CPU execution; no magnetic object, Relax or Run
study = fm.study("fem_antenna_sushruth_2020_gsg")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(
    maximum_element_size=mesh_size_m, minimum_element_size=mesh_size_m, order=1,
)


# %% World x follows propagation; the signal current follows world +y
# z=0 is the nominal magnetic surface. Metal occupies z=30..120 nm.
# Local u -> world +y, local v -> world -x is a proper rotation.
study.antenna_object(
    fm.CPWAntennaLayout(
        name="antenna", length_m=source_length_m, thickness_m=metal_thickness_m,
        conductivity_s_per_m=conductivity_s_per_m,
        stations=[
            fm.CPWWidthStation(s, conductor_width_m, gap_m=gap_m, ground_width_m=conductor_width_m)
            for s in (0.0, 1.0)
        ],
        transform=fm.RigidTransform(
            rotation_matrix=((0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
            translation_m=(0.0, -0.5 * source_length_m, insulator_thickness_m + 0.5 * metal_thickness_m),
        ),
    ), name="GSG antenna", object_id="antenna",
)
# A field-only volume just below z=0; this is not a Co/Ni material model.
study.geometry_object(
    fm.Box(sampling_length_m, sampling_width_m, sampling_depth_m, name="sampling").translate(
        (0.0, 0.0, -0.5 * sampling_depth_m)
    ), name="Field sampling", object_id="sampling", type="geometry",
)


# %% Six explicit terminal caps; the return conductors each carry -I/2
extensions = []
currents = {}
for part, weight in branch_weights:
    for end, selector, sign in (("in", "local_u_min", -1.0), ("out", "local_u_max", 1.0)):
        terminal_id = f"{part}_{end}"
        extensions.append(fm.TerminalLeadExtension.from_antenna_terminal(
            id=terminal_id, observation_id=terminal_id, object_id="antenna",
            conductor_part_id=part, selector=selector, length_m=lead_length_m,
            outward_direction_xyz=(0.0, sign, 0.0),
            conductivity_spm=conductivity_s_per_m, layers=lead_layers,
        ))
        # The source contract uses signed outward flux at each outer electrode.
        currents[terminal_id] = sign * weight * signal_current_a

study.current_transport(
    name="gsg_charge", model="ohmic_poisson", coupling="one_way",
    domain=[fm.RegionRef("antenna")],
    materials=[fm.ChargeTransportMaterialAssignment(
        fm.RegionRef("antenna"), fm.ChargeTransportMaterial(conductivity_s_per_m),
    )],
    boundaries=[], gauge=fm.ChargePotentialGauge("terminal_reference"),
    solver=fm.ChargeSolverPolicy(operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
    external_lead_preparation=fm.ExternalLeadPreparation(
        revision="sushruth_2020_nominal_gsg_inspection_v1",
        extensions=extensions, drives=[fm.CurrentSourceDrive("gsg_current", "gsg_port", currents)],
    ),
)
study.add_antenna_port_mode(port_mode=fm.AntennaPortMode(
    id="gsg_port", source_object_id="antenna", current_transport_id="gsg_charge",
    normalization_current_a=1.0,
    branches=[fm.AntennaPortBranch(part, f"{part}_in", f"{part}_out", weight)
              for part, weight in branch_weights],
))


# %% Raw inspection fields only; no qualified basis, source FFT or LLG consumer
study.stages.add_antenna_field_solve(
    id="inspect_gsg", definition=fm.AntennaFieldSolveStage(
        id="inspect_gsg", source_object_id="antenna", current_transport_id="gsg_charge",
        port_mode_ids=["gsg_port"], field_sampling_domain=fm.FieldTarget.object("sampling"),
        target_refs=[fm.FieldTarget.object("sampling")],
        # Existing stage vocabulary; publication is raw H (A/m), inspection_only.
        outputs=[fm.AntennaNamedOutput("gsg_inspection", "H_ant_basis")],
    ),
)
