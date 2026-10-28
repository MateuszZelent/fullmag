"""Accepted 3D current with bounded RT0 surface field inspection.

This is an explicit caller-owned experiment, not a qualified antenna basis.
The CPU/RAM container limits are unchanged. No Relax, Run, FFT or LLG is enabled.
"""

import fullmag as fm


# %% Editable parameters (SI): geometry, source and observation volume
length_m = 2.0e-6
thickness_m = 0.2e-6
signal_end_width_m = 0.3e-6
signal_neck_width_m = 0.1e-6
return_width_m = 1.0e-6
return_offset_m = 0.4e-6
connection_length_m = 0.2e-6
connection_width_m = 0.4e-6
conductor_conductivity_s_per_m = 5.8e7
connection_conductivity_s_per_m = 3.0e7
source_voltage_v = 0.25
# Object-frame z: the source plane must remain inside the inlet bridge.
source_cut_z_m = -0.3e-6
mesh_size_m = 0.15e-6
sampling_size_m = 0.08e-6
sampling_center_m = (0.5 * length_m, 0.0, 0.3e-6)
charge_relative_tolerance = 1.0e-12
charge_max_iterations = 10000


# Explicit caller-owned inspection budgets; these are not qualification receipts.
surface_total_pairs = 40_000
surface_target_pairs = 4_000
surface_policy = fm.AntennaSurfaceFieldPolicy(
    policy_version="caller_supplied_rt0_surface.inspection.v1",
    limits={
        # Ordered categories: pairs, face passes, whole faces, fans, fraction,
        # integer, comparison, division, input/output bytes, sqrt/log/log1p/atan2.
        "total": (surface_total_pairs, 12 * surface_total_pairs,
            12 * surface_total_pairs, 36 * surface_total_pairs,
            50_000 * surface_total_pairs, 200_000 * surface_total_pairs,
            50_000 * surface_total_pairs, 5_000 * surface_total_pairs,
            16 * 1024**2, 16 * 1024**2,
            1_000 * surface_total_pairs, 1_000 * surface_total_pairs,
            1_000 * surface_total_pairs, 1_000 * surface_total_pairs),
        "per_target": (surface_target_pairs, 12 * surface_target_pairs,
            12 * surface_target_pairs, 36 * surface_target_pairs,
            50_000 * surface_target_pairs, 200_000 * surface_target_pairs,
            50_000 * surface_target_pairs, 5_000 * surface_target_pairs,
            4 * 1024**2, 4 * 1024**2,
            1_000 * surface_target_pairs, 1_000 * surface_target_pairs,
            1_000 * surface_target_pairs, 1_000 * surface_target_pairs),
        "maximum_raw_integer_bits": 8192,
        "maximum_reduced_fraction_bits": 8192,
        "maximum_lifetime_peak_rss_bytes": 6 * 1024**3,
        "guard_interval_events": 256,
        "maximum_total_seconds": 600.0,
        "maximum_target_seconds": 90.0,
    },
    tolerances={
        "absolute_field_apm": 1e-9, "relative_field": 1e-5,
        "cancellation_floor_apm": 1e-6,
        "scalar_relative_80": 1e-45, "scalar_relative_120": 1e-55,
        "angle_relative_80": 1e-45, "angle_relative_120": 1e-55,
        "binary_scalar_epsilon_factor": 64.0,
        "binary_roundoff_epsilon_factor": 64.0,
        "binary_cancellation_limit": 1e8,
        "highprecision_cancellation_limit": 1e40,
    },
)


# %% Explicit execution: the only stage solves charge and inspects its field
study = fm.study("fem_antenna_surface_nonmagnetic")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.wait_for_solve(True)
study.objects.mesh.defaults(maximum_element_size=mesh_size_m, minimum_element_size=mesh_size_m, order=1)


# %% Signal taper, wide return plate and two fully conducting bridges
study.antenna_object(
    fm.MicrostripAntennaLayout(
        name="antenna", length_m=length_m, thickness_m=thickness_m,
        conductivity_s_per_m=conductor_conductivity_s_per_m,
        stations=[fm.MicrostripWidthStation(0.0, signal_end_width_m),
                  fm.MicrostripWidthStation(0.5, signal_neck_width_m),
                  fm.MicrostripWidthStation(1.0, signal_end_width_m)],
        return_width_m=return_width_m, return_offset_m=return_offset_m,
        signal_part_id="signal", return_part_id="return", closed_loop=True,
        inlet_connection_length_m=connection_length_m, inlet_connection_width_m=connection_width_m,
        inlet_connection_offset_v_m=0.0, inlet_connection_part_id="inlet",
        inlet_connection_conductivity_s_per_m=connection_conductivity_s_per_m,
        outlet_connection_length_m=connection_length_m, outlet_connection_width_m=connection_width_m,
        outlet_connection_offset_v_m=0.0, outlet_connection_part_id="outlet",
        outlet_connection_conductivity_s_per_m=connection_conductivity_s_per_m,
    ), name="antenna", object_id="antenna",
)
# A small field-only volume above the signal, without magnetic material/state.
study.geometry_object(
    fm.Box(sampling_size_m, sampling_size_m, sampling_size_m, name="sampling").translate(sampling_center_m),
    name="sampling", object_id="sampling", type="geometry",
)


# %% One static ideal voltage source; conductivity is owned by these assignments
study.current_transport(
    name="antenna_charge", model="ohmic_poisson", coupling="one_way",
    domain=[fm.RegionRef("antenna")],
    materials=[
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "signal"), fm.ChargeTransportMaterial(conductor_conductivity_s_per_m)),
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "return"), fm.ChargeTransportMaterial(conductor_conductivity_s_per_m)),
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "inlet"), fm.ChargeTransportMaterial(connection_conductivity_s_per_m)),
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "outlet"), fm.ChargeTransportMaterial(connection_conductivity_s_per_m)),
    ],
    boundaries=[], gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(relative_tolerance=charge_relative_tolerance, absolute_tolerance=0.0,
        max_iterations=charge_max_iterations, operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
    structured_current_closure=fm.StructuredCurrentClosure(
        "antenna_loop", [fm.StructuredCurrentSourceCut(
            "inlet_cut", "antenna_circuit", fm.RegionRef("antenna", "inlet"),
            fm.StructuredCutPlane("z", source_cut_z_m, coordinate_frame="object"),
            fm.ImpressedPotentialJump("inlet_voltage", source_voltage_v),
        )], schema_version="structured_current_closure.v2",
    ),
)
study.add_antenna_port_mode(port_mode=fm.AntennaPortMode(
    id="loop_port", source_object_id="antenna", current_transport_id="antenna_charge",
    schema_version="antenna_port_mode.v3",
    normalization=fm.AntennaSourceCutRt0("inlet_cut", orientation="minus_outward"),
    branches=[fm.AntennaPortBranch("signal", "signal_in", "signal_out", 1.0),
              fm.AntennaPortBranch("return", "return_in", "return_out", -1.0)],
))


# %% Observe the accepted current and H on the independent sampling mesh
study.stages.add_antenna_field_solve(
    id="inspect_loop", definition=fm.AntennaFieldSolveStage(
        id="inspect_loop", source_object_id="antenna", current_transport_id="antenna_charge",
        oersted_realization="analytic_rt0_surface", surface_field_policy=surface_policy,
        port_mode_ids=["loop_port"], field_sampling_domain=fm.FieldTarget.object("sampling"),
        target_refs=[fm.FieldTarget.object("sampling")],
        # The stage selector is existing API vocabulary; publication remains inspection_only.
        outputs=[fm.AntennaNamedOutput("loop_inspection", "H_ant_basis")],
    ),
)
