"""Full-volume microstrip loop with a separate nonmagnetic Tet4 H carrier.

The inlet bridge contains one ideal coincident potential jump. This stage
publishes raw inspection V/J/H; it does not qualify a reusable antenna basis.
See docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md.
"""

import fullmag as fm


# %% Explicit execution: the only stage solves charge and inspects its field
study = fm.study("fem_antenna_closed_loop_nonmagnetic")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=0.15e-6, minimum_element_size=0.15e-6, order=1)


# %% Signal taper, wide return plate and two fully conducting bridges
study.antenna_object(
    fm.MicrostripAntennaLayout(
        name="antenna", length_m=2.0e-6, thickness_m=0.2e-6,
        conductivity_s_per_m=5.8e7,
        stations=[fm.MicrostripWidthStation(0.0, 0.3e-6),
                  fm.MicrostripWidthStation(0.5, 0.1e-6),
                  fm.MicrostripWidthStation(1.0, 0.3e-6)],
        return_width_m=1.0e-6, return_offset_m=0.4e-6,
        signal_part_id="signal", return_part_id="return", closed_loop=True,
        inlet_connection_length_m=0.2e-6, inlet_connection_width_m=0.4e-6,
        inlet_connection_offset_v_m=0.0, inlet_connection_part_id="inlet",
        inlet_connection_conductivity_s_per_m=3.0e7,
        outlet_connection_length_m=0.2e-6, outlet_connection_width_m=0.4e-6,
        outlet_connection_offset_v_m=0.0, outlet_connection_part_id="outlet",
        outlet_connection_conductivity_s_per_m=3.0e7,
    ), name="antenna", object_id="antenna",
)
# A small field-only volume above the signal, without magnetic material/state.
study.geometry_object(
    fm.Box(0.08e-6, 0.08e-6, 0.08e-6, name="sampling").translate((1.0e-6, 0.0, 0.3e-6)),
    name="sampling", object_id="sampling", type="geometry",
)


# %% One static ideal voltage source; conductivity is owned by these assignments
study.current_transport(
    name="antenna_charge", model="ohmic_poisson", coupling="one_way",
    domain=[fm.RegionRef("antenna")],
    materials=[
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "signal"), fm.ChargeTransportMaterial(5.8e7)),
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "return"), fm.ChargeTransportMaterial(5.8e7)),
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "inlet"), fm.ChargeTransportMaterial(3.0e7)),
        fm.ChargeTransportMaterialAssignment(fm.RegionRef("antenna", "outlet"), fm.ChargeTransportMaterial(3.0e7)),
    ],
    boundaries=[], gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(relative_tolerance=1.0e-12, absolute_tolerance=0.0,
        max_iterations=10000, operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
    structured_current_closure=fm.StructuredCurrentClosure(
        "antenna_loop", [fm.StructuredCurrentSourceCut(
            "inlet_cut", "antenna_circuit", fm.RegionRef("antenna", "inlet"),
            fm.StructuredCutPlane("z", -0.3e-6, coordinate_frame="object"),
            fm.ImpressedPotentialJump("inlet_voltage", 0.25),
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
        port_mode_ids=["loop_port"], field_sampling_domain=fm.FieldTarget.object("sampling"),
        target_refs=[fm.FieldTarget.object("sampling")],
        # The stage selector is existing API vocabulary; publication remains inspection_only.
        outputs=[fm.AntennaNamedOutput("loop_inspection", "H_ant_basis")],
    ),
)
