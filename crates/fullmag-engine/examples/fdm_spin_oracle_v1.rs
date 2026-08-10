use fullmag_engine::fdm::cpu::transport::{
    ChargeBoundaryCondition, ChargeBoundaryConditions, ChargeSolverConfig,
    OrientedChargeMixingInterface, OrientedSpinInterface, SpinBoundaryCondition,
    SpinBoundaryConditions, SpinDriftDiffusionProblem, SpinInterfaceLaw, SpinMaterialFields,
    SpinReactionLengths, SpinSolverConfig, SpinTorqueTargets, StructuredChargeFace,
    StructuredChargeProblem, StructuredSpinFace,
};
use fullmag_engine::{CellSize, GridShape};
use std::error::Error;
use std::fmt::Display;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::str::{FromStr, SplitWhitespace};

type Vector3 = [f64; 3];

struct Fixture {
    grid: GridShape,
    cell_size: CellSize,
    charge_sigma: f64,
    left_voltage: f64,
    right_voltage: f64,
    spin_sigma: f64,
    polarization: f64,
    theta: f64,
    lambda_sf: f64,
    lambda_j: f64,
    lambda_phi: f64,
    interface_split_x: usize,
    g_up: f64,
    g_down: f64,
    g_r: f64,
    g_i: f64,
    saturation_magnetization: f64,
    gamma_e: f64,
}

fn next<T>(tokens: &mut SplitWhitespace<'_>, name: &str) -> Result<T, Box<dyn Error>>
where
    T: FromStr,
    T::Err: Display,
{
    let token = tokens
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("missing {name}")))?;
    token.parse::<T>().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {name} {token:?}: {error}"),
        )
        .into()
    })
}

fn read_fixture(path: &Path) -> Result<Fixture, Box<dyn Error>> {
    let text = fs::read_to_string(path)?;
    let mut tokens = text.split_whitespace();
    let schema: String = next(&mut tokens, "schema")?;
    if schema != "fullmag.fdm.spin.parity_fixture.v2" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected fixture schema").into());
    }
    let grid = GridShape::new(
        next(&mut tokens, "nx")?,
        next(&mut tokens, "ny")?,
        next(&mut tokens, "nz")?,
    )?;
    let cell_size = CellSize::new(
        next(&mut tokens, "dx")?,
        next(&mut tokens, "dy")?,
        next(&mut tokens, "dz")?,
    )?;
    let fixture = Fixture {
        grid,
        cell_size,
        charge_sigma: next(&mut tokens, "charge_sigma")?,
        left_voltage: next(&mut tokens, "left_voltage")?,
        right_voltage: next(&mut tokens, "right_voltage")?,
        spin_sigma: next(&mut tokens, "spin_sigma")?,
        polarization: next(&mut tokens, "polarization")?,
        theta: next(&mut tokens, "theta")?,
        lambda_sf: next(&mut tokens, "lambda_sf")?,
        lambda_j: next(&mut tokens, "lambda_j")?,
        lambda_phi: next(&mut tokens, "lambda_phi")?,
        interface_split_x: next(&mut tokens, "interface_split_x")?,
        g_up: next(&mut tokens, "g_up")?,
        g_down: next(&mut tokens, "g_down")?,
        g_r: next(&mut tokens, "g_r")?,
        g_i: next(&mut tokens, "g_i")?,
        saturation_magnetization: next(&mut tokens, "saturation_magnetization")?,
        gamma_e: next(&mut tokens, "gamma_e")?,
    };
    if tokens.next().is_some() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "trailing fixture tokens").into());
    }
    Ok(fixture)
}

fn write_vector(writer: &mut impl Write, name: &str, values: &[f64]) -> io::Result<()> {
    write!(writer, "{name} {}", values.len())?;
    for value in values {
        write!(writer, " {value:.17e}")?;
    }
    writeln!(writer)
}

fn flatten(values: impl IntoIterator<Item = Vector3>) -> Vec<f64> {
    values.into_iter().flatten().collect()
}

fn cell_index(grid: GridShape, x: usize, y: usize, z: usize) -> usize {
    x + grid.nx * (y + grid.ny * z)
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let fixture_path = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing fixture path"))?;
    let output_path = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing output path"))?;
    if args.next().is_some() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unexpected arguments").into());
    }
    let fixture = read_fixture(Path::new(&fixture_path))?;
    let count = fixture.grid.cell_count();
    let mut charge_interfaces = Vec::new();
    for z in 0..fixture.grid.nz {
        for y in 0..fixture.grid.ny {
            let lower = cell_index(fixture.grid, fixture.interface_split_x - 1, y, z);
            let upper = cell_index(fixture.grid, fixture.interface_split_x, y, z);
            charge_interfaces.push(OrientedChargeMixingInterface {
                face: StructuredChargeFace {
                    axis: 0,
                    negative_cell: lower,
                    positive_cell: upper,
                },
                from_cell: lower,
                to_cell: upper,
                g_up_s_per_m2: fixture.g_up,
                g_down_s_per_m2: fixture.g_down,
            });
        }
    }
    let charge = StructuredChargeProblem::new(
        fixture.grid,
        fixture.cell_size,
        vec![fixture.charge_sigma; count],
        None,
        ChargeBoundaryConditions {
            x_min: ChargeBoundaryCondition::Voltage(fixture.left_voltage),
            x_max: ChargeBoundaryCondition::Voltage(fixture.right_voltage),
            ..Default::default()
        },
    )?
    .with_interfaces(charge_interfaces)?;
    let charge_solution = charge.solve(ChargeSolverConfig::default())?;
    let mut region_ids = vec![0_u32; count];
    let mut interfaces = Vec::new();
    for z in 0..fixture.grid.nz {
        for y in 0..fixture.grid.ny {
            for x in 0..fixture.grid.nx {
                region_ids[cell_index(fixture.grid, x, y, z)] =
                    if x < fixture.interface_split_x { 1 } else { 2 };
            }
            let lower = cell_index(fixture.grid, fixture.interface_split_x - 1, y, z);
            let upper = cell_index(fixture.grid, fixture.interface_split_x, y, z);
            interfaces.push(OrientedSpinInterface {
                face: StructuredSpinFace {
                    axis: 0,
                    negative_cell: lower,
                    positive_cell: upper,
                },
                from_cell: lower,
                to_cell: upper,
                law: SpinInterfaceLaw::MixingConductance {
                    g_up_s_per_m2: fixture.g_up,
                    g_down_s_per_m2: fixture.g_down,
                    g_r_s_per_m2: fixture.g_r,
                    g_i_s_per_m2: fixture.g_i,
                    g_sml_s_per_m2: 0.0,
                    sml_reservoir: None,
                    magnetization: [0.0, 0.0, 1.0],
                },
            });
        }
    }
    let spin = SpinDriftDiffusionProblem::new(
        charge,
        charge_solution.potential_volts.clone(),
        SpinMaterialFields {
            spin_conductivity_s_per_m: vec![fixture.spin_sigma; count],
            polarization: vec![fixture.polarization; count],
            spin_hall_angle: vec![fixture.theta; count],
            magnetization: vec![[0.0, 0.0, 1.0]; count],
            reactions: vec![
                SpinReactionLengths {
                    spin_flip_m: Some(fixture.lambda_sf),
                    exchange_m: Some(fixture.lambda_j),
                    dephasing_m: Some(fixture.lambda_phi),
                };
                count
            ],
        },
        None,
        SpinBoundaryConditions {
            x_min: SpinBoundaryCondition::SpecifiedPotential([0.2, -0.1, 0.05]),
            x_max: SpinBoundaryCondition::SpinSink,
            ..Default::default()
        },
    )?
    .with_interfaces(region_ids, interfaces)?
    .with_accepted_charge_solution(&charge_solution)?
    .with_torque_targets(SpinTorqueTargets {
        target_cells: vec![true; count],
        saturation_magnetization_a_per_m: vec![fixture.saturation_magnetization; count],
        gamma_e_rad_per_s_t: fixture.gamma_e,
    })?;
    let solution = spin.solve(SpinSolverConfig::default())?;

    let mut output = BufWriter::new(fs::File::create(output_path)?);
    writeln!(output, "fullmag.fdm.spin.rust_oracle_output.v1")?;
    write_vector(&mut output, "mu", &flatten(solution.spin_potential_volts))?;
    write_vector(&mut output, "qx", &flatten(solution.spin_current_density.x))?;
    write_vector(&mut output, "qy", &flatten(solution.spin_current_density.y))?;
    write_vector(&mut output, "qz", &flatten(solution.spin_current_density.z))?;
    write_vector(
        &mut output,
        "spin_flip",
        &flatten(solution.reaction_channels.spin_flip),
    )?;
    write_vector(
        &mut output,
        "exchange",
        &flatten(solution.reaction_channels.exchange),
    )?;
    write_vector(
        &mut output,
        "dephasing",
        &flatten(solution.reaction_channels.dephasing),
    )?;
    write_vector(
        &mut output,
        "magnetic",
        &flatten(solution.reaction_channels.magnetic_torque_sink),
    )?;
    write_vector(
        &mut output,
        "torque",
        &flatten(solution.transport_gilbert_torque_per_s),
    )?;
    let mut interfaces =
        Vec::with_capacity(15 * solution.spin_current_density.interface_observations.len());
    for observation in &solution.spin_current_density.interface_observations {
        for value in [
            observation.incoming_longitudinal_a_per_m2,
            observation.backflow_longitudinal_a_per_m2,
            observation.absorbed_transverse_a_per_m2,
            observation.negative_cell_flux_positive_axis_a_per_m2,
            observation.positive_cell_flux_positive_axis_a_per_m2,
        ] {
            interfaces.extend(value);
        }
    }
    write_vector(&mut output, "interfaces", &interfaces)?;
    write_vector(
        &mut output,
        "boundary",
        &flatten(solution.balance.boundary_outward_current_a),
    )?;
    let balance = [
        solution.balance.net_boundary_current_a,
        solution.balance.spin_flip_sink_a,
        solution.balance.magnetic_torque_sink_a,
        solution.balance.closure_a,
    ];
    write_vector(&mut output, "balance", &flatten(balance))?;
    Ok(())
}
