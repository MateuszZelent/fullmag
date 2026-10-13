from dataclasses import replace

import pytest

import fullmag


def test_port_mode_is_a_thin_balanced_reference_contract() -> None:
    mode = fullmag.AntennaPortMode(
        id="cpw_common",
        source_object_id="antenna_1",
        current_transport_id="antenna_current",
        branches=(
            fullmag.AntennaPortBranch(
                id="signal",
                inlet_terminal_ref="signal_in",
                outlet_terminal_ref="signal_out",
                signed_weight=1.0,
            ),
            fullmag.AntennaPortBranch(
                id="left_ground",
                inlet_terminal_ref="left_ground_in",
                outlet_terminal_ref="left_ground_out",
                signed_weight=-0.5,
            ),
            fullmag.AntennaPortBranch(
                id="right_ground",
                inlet_terminal_ref="right_ground_in",
                outlet_terminal_ref="right_ground_out",
                signed_weight=-0.5,
            ),
        ),
    )

    payload = mode.to_ir()
    assert payload["schema_version"] == "antenna_port_mode.v2"
    assert payload["normalization_current_a"] == 1.0
    assert "geometry" not in payload
    assert "conductivity" not in payload
    assert sum(branch["signed_weight"] for branch in payload["branches"]) == 0.0


def test_port_mode_rejects_missing_return_current() -> None:
    with pytest.raises(ValueError, match="sum to zero"):
        fullmag.AntennaPortMode(
            id="invalid",
            source_object_id="antenna_1",
            current_transport_id="antenna_current",
            branches=(
                fullmag.AntennaPortBranch(
                    id="signal",
                    inlet_terminal_ref="signal_in",
                    outlet_terminal_ref="signal_out",
                    signed_weight=1.0,
                ),
                fullmag.AntennaPortBranch(
                    id="ground",
                    inlet_terminal_ref="ground_in",
                    outlet_terminal_ref="ground_out",
                    signed_weight=0.5,
                ),
            ),
        )


def test_port_mode_rejects_reused_terminal_reference() -> None:
    with pytest.raises(ValueError, match="terminal references must be unique"):
        fullmag.AntennaPortMode(
            id="invalid_terminals",
            source_object_id="antenna_1",
            current_transport_id="antenna_current",
            branches=(
                fullmag.AntennaPortBranch(
                    id="signal",
                    inlet_terminal_ref="signal_in",
                    outlet_terminal_ref="signal_out",
                    signed_weight=1.0,
                ),
                fullmag.AntennaPortBranch(
                    id="return",
                    inlet_terminal_ref="signal_in",
                    outlet_terminal_ref="return_out",
                    signed_weight=-1.0,
                ),
            ),
        )


def test_solved_drive_serializes_waveform_without_copying_field_basis() -> None:
    drive = fullmag.SolvedAntennaDrive(
        id="drive_1",
        name="1 GHz drive",
        projection_ref="antenna_1_to_magnet_1",
        port_mode_id="cpw_common",
        peak_current_a=0.01,
        waveform=fullmag.Sinusoidal(frequency_hz=1.0e9),
    )

    payload = drive.to_ir()
    assert payload["waveform"]["frequency_hz"] == 1.0e9
    assert payload["time_origin"] == "stage_local"
    assert "field" not in payload
    assert "current_density" not in payload


def test_solved_drive_serializes_explicit_sampled_bandwidth_declaration() -> None:
    drive = fullmag.SolvedAntennaDrive(
        id="drive_1",
        name="piecewise drive",
        projection_ref="antenna_1_to_magnet_1",
        port_mode_id="cpw_common",
        peak_current_a=1.0,
        waveform=fullmag.PiecewiseLinear([(0.0, 0.0), (1.0e-9, 1.0)]),
        bandwidth_declaration=fullmag.AntennaWaveformBandwidthDeclaration(6.0e9),
    )

    payload = drive.to_ir()
    assert payload["bandwidth_declaration"] == {"f_max_hz": 6.0e9}


def test_field_solve_projection_and_spectrum_are_typed_thin_references() -> None:
    target = fullmag.FieldTarget.object("magnet_1")
    stage = fullmag.AntennaFieldSolveStage(
        id="solve_antenna_1",
        source_object_id="antenna_1",
        current_transport_id="antenna_current",
        port_mode_ids=("cpw_common",),
        conservative_current_view_ref="antenna_current:rt0",
        field_sampling_domain=fullmag.FieldTarget.global_domain(),
        target_refs=(target,),
        outputs=(fullmag.AntennaNamedOutput("solution_1", "H_ant_basis"),),
    )
    solution = fullmag.AntennaFieldSolutionRef(
        stage_id=stage.id,
        output_id="solution_1",
        asset_id="afs_01",
        content_digest="sha256:verified",
    )
    projection = fullmag.AntennaTargetProjection(
        id="antenna_1_to_magnet_1",
        solution=solution,
        target=target,
        output_id="projection_1",
    )
    spectrum = fullmag.AntennaSpectrumRequest(
        id="antenna_1_k",
        solution_ref=solution,
        port_mode_id="cpw_common",
        target=target,
        transform="nonuniform_spatial_fft",
        sampling_plane=fullmag.AntennaSpectrumSamplingPlane(
            origin_m=(0.0, 0.0, 0.0),
            axis_u=(1.0, 0.0, 0.0),
            axis_v=(0.0, 1.0, 0.0),
            extent_u_m=2.0e-6,
            extent_v_m=1.0e-6,
            sample_count_u=65,
            sample_count_v=33,
        ),
        window="hann",
        normalization="integral_si",
        nonuniform_k_grid=fullmag.AntennaSpectrumKGrid(
            k_u_rad_per_m=(-1.0e7, 0.0, 1.0e7),
            k_v_rad_per_m=(-2.0e7, 0.0, 2.0e7),
        ),
        component="x",
        output_id="k_spectrum_1",
    )

    assert stage.to_ir()["outputs"] == [
        {"id": "solution_1", "quantity": "H_ant_basis"}
    ]
    assert stage.to_ir()["conservative_current_view_ref"] == "antenna_current:rt0"
    source_stage = replace(stage, conservative_current_view_ref=None)
    assert "conservative_current_view_ref" not in source_stage.to_ir()
    with pytest.raises(ValueError, match="conservative_current_view_ref must not be empty"):
        replace(stage, conservative_current_view_ref="  ")
    assert projection.to_ir()["solution"]["asset_id"] == "afs_01"
    assert projection.to_ir()["solution"]["kind"] == "resolved_asset"
    assert spectrum.to_ir()["solution_ref"]["kind"] == "resolved_asset"
    assert spectrum.to_ir()["transform"] == "nonuniform_spatial_fft"
    assert spectrum.to_ir()["port_mode_id"] == "cpw_common"
    assert spectrum.to_ir()["sampling_plane"]["sample_count_u"] == 65
    assert spectrum.to_ir()["normalization"] == "integral_si"
    with pytest.raises(ValueError, match="equilibrium_ref is only valid"):
        replace(spectrum, equilibrium_ref="equilibrium_1")
    with pytest.raises(ValueError, match="transverse spectrum is unsupported"):
        replace(spectrum, component="transverse", equilibrium_ref="equilibrium_1")
    with pytest.raises(ValueError, match="mode_basis_ref is unsupported"):
        replace(spectrum, mode_basis_ref="modes_1")
    for payload in (stage.to_ir(), projection.to_ir(), spectrum.to_ir()):
        assert "geometry" not in payload
        assert "conductivity" not in payload


def test_problem_ir_keeps_antenna_as_a_physics_object_and_transport_region() -> None:
    magnet_geometry = fullmag.Box(size=(200e-9, 100e-9, 10e-9), name="magnet_1")
    antenna_geometry = fullmag.Box(size=(500e-9, 50e-9, 20e-9), name="antenna_1")
    magnet = fullmag.Ferromagnet(
        name="magnet_1",
        geometry=magnet_geometry,
        material=fullmag.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01),
    )
    conductor = fullmag.RegionRef("antenna_1")
    transport = fullmag.CurrentTransport(
        name="antenna_current",
        model="ohmic_poisson",
        domain=(conductor,),
        materials=(
            fullmag.ChargeTransportMaterialAssignment(
                conductor,
                fullmag.ChargeTransportMaterial(sigma_Spm=5.8e7),
            ),
        ),
        boundaries=(
            fullmag.VoltageElectrode(
                "signal_in",
                (fullmag.SurfaceRef("antenna_1", "left", (-1.0, 0.0, 0.0)),),
                potential_V=0.1,
            ),
            fullmag.VoltageElectrode(
                "signal_out",
                (fullmag.SurfaceRef("antenna_1", "right", (1.0, 0.0, 0.0)),),
                potential_V=0.0,
            ),
            fullmag.VoltageElectrode(
                "return_in",
                (fullmag.SurfaceRef("antenna_1", "bottom", (0.0, 0.0, -1.0)),),
                potential_V=0.1,
            ),
            fullmag.VoltageElectrode(
                "return_out",
                (fullmag.SurfaceRef("antenna_1", "top", (0.0, 0.0, 1.0)),),
                potential_V=0.0,
            ),
            fullmag.ChargeInsulating(
                "insulating_outer",
                (
                    fullmag.SurfaceRef("antenna_1", "front", (0.0, -1.0, 0.0)),
                    fullmag.SurfaceRef("antenna_1", "back", (0.0, 1.0, 0.0)),
                ),
            ),
        ),
        gauge=fullmag.ChargePotentialGauge("dirichlet_reference"),
        solver=fullmag.ChargeSolverPolicy(
            operator_version="fem_charge_conforming_h1_p1.transparent.v1"
        ),
    )
    port = fullmag.AntennaPortMode(
        id="antenna_1_port",
        source_object_id="antenna_1",
        current_transport_id=transport.name,
        branches=(
            fullmag.AntennaPortBranch(
                id="signal",
                inlet_terminal_ref="signal_in",
                outlet_terminal_ref="signal_out",
                signed_weight=1.0,
            ),
            fullmag.AntennaPortBranch(
                id="return",
                inlet_terminal_ref="return_in",
                outlet_terminal_ref="return_out",
                signed_weight=-1.0,
            ),
        ),
    )
    target = fullmag.FieldTarget.object("magnet_1")
    field_stage = fullmag.AntennaFieldSolveStage(
        id="solve_antenna_1",
        source_object_id="antenna_1",
        current_transport_id=transport.name,
        port_mode_ids=(port.id,),
        conservative_current_view_ref="antenna_current:rt0",
        field_sampling_domain=fullmag.FieldTarget.global_domain(),
        target_refs=(target,),
        outputs=(fullmag.AntennaNamedOutput("antenna_solution_1", "H_ant_basis"),),
    )
    solution = fullmag.AntennaFieldSolutionRef(
        stage_id=field_stage.id,
        output_id="antenna_solution_1",
        asset_id="antenna_solution_asset_1",
        content_digest="sha256:verified",
    )
    projection = fullmag.AntennaTargetProjection(
        id="antenna_1_to_magnet_1",
        solution=solution,
        target=target,
        output_id="antenna_projection_1",
    )
    drive = fullmag.SolvedAntennaDrive(
        id="antenna_drive_1",
        name="Antenna drive",
        projection_ref=projection.id,
        port_mode_id=port.id,
        peak_current_a=0.01,
        waveform=fullmag.Sinusoidal(frequency_hz=1.0e9),
    )
    spectrum = fullmag.AntennaSpectrumRequest(
        id="antenna_spectrum_1",
        solution_ref=solution,
        port_mode_id=port.id,
        target=target,
        transform="spatial_fft",
        sampling_plane=fullmag.AntennaSpectrumSamplingPlane(
            origin_m=(0.0, 0.0, 0.0),
            axis_u=(1.0, 0.0, 0.0),
            axis_v=(0.0, 1.0, 0.0),
            extent_u_m=200e-9,
            extent_v_m=100e-9,
            sample_count_u=33,
            sample_count_v=17,
        ),
        window="hann",
        normalization="integral_si",
        component="x",
        output_id="antenna_spectrum_output_1",
    )
    problem = fullmag.Problem(
        name="antenna_composition",
        magnets=(magnet,),
        energy=(fullmag.Exchange(), fullmag.Demag()),
        study=fullmag.TimeEvolution(dynamics=fullmag.LLG(), outputs=()),
        auxiliary_geometries=(antenna_geometry,),
        auxiliary_geometry_roles={"antenna_1": "antenna"},
        current_modules=(transport,),
        antenna_port_modes=(port,),
        antenna_field_solve_stages=(field_stage,),
        antenna_target_projections=(projection,),
        solved_antenna_drives=(drive,),
        antenna_spectrum_requests=(spectrum,),
    )

    payload = problem.to_ir(include_geometry_assets=False)

    assert any(region["name"] == "antenna_1" for region in payload["regions"])
    assert payload["physics_objects"] == [
        {
            "schema_version": "physics_object.v1",
            "object_id": "antenna_1",
            "name": "antenna_1",
            "type": "antenna",
            "geometry_id": "antenna_1",
            "material_assignment_ids": [],
        }
    ]
    assert payload["physics_graph"]["objects"] == payload["physics_objects"]
    assert payload["antenna_port_modes"] == [port.to_ir()]
    assert payload["antenna_field_solve_stages"] == [field_stage.to_ir()]
    assert payload["antenna_target_projections"] == [projection.to_ir()]
    assert payload["solved_antenna_drives"] == [drive.to_ir()]
    assert payload["antenna_spectrum_requests"] == [spectrum.to_ir()]
