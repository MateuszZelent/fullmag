"""Full-volume microstrip loop with a graded nonmagnetic Universe H carrier.

The inlet bridge contains one ideal coincident potential jump. This stage
authors raw inspection V/J/H and waits for Compute. It explicitly selects the
bounded volume_inspection_v1 work profile without changing quadrature tolerances.
Runtime H verification is pending; this script
does not qualify a reusable antenna basis.
See docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md.
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
universe_padding_m = (0.5e-6, 0.5e-6, 0.5e-6)
airbox_minimum_element_size_m = 0.15e-6
airbox_maximum_element_size_m = 0.5e-6
airbox_growth_rate = 1.6
charge_relative_tolerance = 1.0e-12
charge_max_iterations = 10000


# %% Explicit execution: the only stage solves charge and inspects its field
study = fm.study("fem_antenna_closed_loop_universe")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.wait_for_solve(True)
study.universe(mode="auto", padding=universe_padding_m)
study.universe.mesh(
    minimum_element_size=airbox_minimum_element_size_m,
    maximum_element_size=airbox_maximum_element_size_m,
    growth_rate=airbox_growth_rate, grading="geometric",
)
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


# %% Prepare a pure Tet4 domain, then inspect H throughout the Universe
study.build_domain_mesh()
study.stages.add_antenna_field_solve(
    id="inspect_loop", definition=fm.AntennaFieldSolveStage(
        id="inspect_loop", source_object_id="antenna", current_transport_id="antenna_charge",
        port_mode_ids=["loop_port"], field_sampling_domain=fm.FieldTarget.global_domain(),
        target_refs=[fm.FieldTarget.global_domain()],
        solver_policy="volume_inspection_v1",
        # The stage selector is existing API vocabulary; publication remains inspection_only.
        outputs=[fm.AntennaNamedOutput("loop_inspection", "H_ant_basis")],
    ),
)
