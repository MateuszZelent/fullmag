use fullmag_engine::fdm::cpu::transport::{
    ChargeBoundaryCondition, ChargeBoundaryConditions, ChargeSolverConfig, StructuredChargeProblem,
};
use fullmag_engine::{CellSize, GridShape};
use std::error::Error;
use std::fmt::Display;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::str::{FromStr, SplitWhitespace};

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

fn read_fixture(path: &Path) -> Result<StructuredChargeProblem, Box<dyn Error>> {
    let text = fs::read_to_string(path)?;
    let mut tokens = text.split_whitespace();
    let schema: String = next(&mut tokens, "schema")?;
    if schema != "fullmag.fdm.charge.parity_fixture.v1" {
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
    let conductivity_count: usize = next(&mut tokens, "conductivity count")?;
    let conductivity_s_per_m = (0..conductivity_count)
        .map(|_| next(&mut tokens, "conductivity"))
        .collect::<Result<Vec<f64>, _>>()?;
    let active_count: usize = next(&mut tokens, "active count")?;
    let active_cells = (0..active_count)
        .map(|_| next::<u8>(&mut tokens, "active cell").map(|value| value != 0))
        .collect::<Result<Vec<bool>, _>>()?;
    let mut conditions = [ChargeBoundaryCondition::Insulating; 6];
    for condition in &mut conditions {
        let kind: String = next(&mut tokens, "boundary kind")?;
        let value: f64 = next(&mut tokens, "boundary value")?;
        *condition = match kind.as_str() {
            "insulating" => ChargeBoundaryCondition::Insulating,
            "voltage" => ChargeBoundaryCondition::Voltage(value),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported boundary kind {kind:?}"),
                )
                .into())
            }
        };
    }
    if tokens.next().is_some() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "trailing fixture tokens").into());
    }
    StructuredChargeProblem::new(
        grid,
        cell_size,
        conductivity_s_per_m,
        Some(active_cells),
        ChargeBoundaryConditions {
            x_min: conditions[0],
            x_max: conditions[1],
            y_min: conditions[2],
            y_max: conditions[3],
            z_min: conditions[4],
            z_max: conditions[5],
        },
    )
    .map_err(Into::into)
}

fn write_vector(writer: &mut impl Write, name: &str, values: &[f64]) -> Result<(), io::Error> {
    write!(writer, "{name} {}", values.len())?;
    for value in values {
        write!(writer, " {value:.17e}")?;
    }
    writeln!(writer)
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
    let problem = read_fixture(Path::new(&fixture_path))?;
    let solution = problem.solve(ChargeSolverConfig::default())?;
    let mut output = BufWriter::new(fs::File::create(output_path)?);
    writeln!(output, "fullmag.fdm.charge.rust_oracle_output.v1")?;
    write_vector(&mut output, "potential", &solution.potential_volts)?;
    write_vector(&mut output, "x", &solution.current_density.x)?;
    write_vector(&mut output, "y", &solution.current_density.y)?;
    write_vector(&mut output, "z", &solution.current_density.z)?;
    write_vector(
        &mut output,
        "boundary",
        &solution.balance.boundary_outward_current_a,
    )?;
    writeln!(
        output,
        "net {:.17e}",
        solution.balance.net_boundary_current_a
    )?;
    Ok(())
}
