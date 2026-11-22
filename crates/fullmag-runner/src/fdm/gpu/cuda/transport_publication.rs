use crate::fdm::gpu::cuda::spin_transport::{
    AcceptedGpuM1TransportArtifacts, GPU_M1_TRANSPORT_OUTPUT_FIELDS,
};
use crate::types::{FieldSnapshot, RunError};

fn grid_counts(grid: [u32; 3]) -> Result<([usize; 3], usize), RunError> {
    let [nx, ny, nz] = grid;
    let (nx, ny, nz) = (
        usize::try_from(nx),
        usize::try_from(ny),
        usize::try_from(nz),
    );
    let (nx, ny, nz) = match (nx, ny, nz) {
        (Ok(nx), Ok(ny), Ok(nz)) => (nx, ny, nz),
        _ => {
            return Err(RunError {
                message: "GPU M1 publication grid size overflows usize".into(),
            })
        }
    };
    let cell_count = nx.checked_mul(ny).and_then(|value| value.checked_mul(nz));
    let face_counts = [
        nx.checked_add(1)
            .and_then(|value| value.checked_mul(ny))
            .and_then(|value| value.checked_mul(nz)),
        ny.checked_add(1)
            .and_then(|value| value.checked_mul(nx))
            .and_then(|value| value.checked_mul(nz)),
        nz.checked_add(1)
            .and_then(|value| value.checked_mul(nx))
            .and_then(|value| value.checked_mul(ny)),
    ];
    match (face_counts, cell_count) {
        ([Some(x), Some(y), Some(z)], Some(cells)) => Ok(([x, y, z], cells)),
        _ => Err(RunError {
            message: "GPU M1 publication grid size overflows usize".into(),
        }),
    }
}

fn face_pair(grid: [u32; 3], x: usize, y: usize, z: usize, axis: usize) -> (usize, usize) {
    let nx = grid[0] as usize;
    let ny = grid[1] as usize;
    match axis {
        0 => {
            let lower = x + (nx + 1) * (y + ny * z);
            (lower, lower + 1)
        }
        1 => {
            let lower = x + nx * (y + (ny + 1) * z);
            (lower, lower + nx)
        }
        _ => {
            let lower = x + nx * (y + ny * z);
            (lower, lower + nx * ny)
        }
    }
}

fn interleave_soa<const N: usize>(
    components: &[Vec<f64>; N],
    count: usize,
) -> Result<Vec<f64>, RunError> {
    if components.iter().any(|component| component.len() != count) {
        return Err(RunError {
            message: "GPU M1 cell field component lengths disagree with the grid".into(),
        });
    }
    Ok((0..count)
        .flat_map(|sample| components.iter().map(move |component| component[sample]))
        .collect())
}

pub(crate) fn accepted_transport_field_snapshots(
    grid: [u32; 3],
    artifacts: AcceptedGpuM1TransportArtifacts,
    requested_fields: &[String],
    step: u64,
    time: f64,
    solver_dt: f64,
    accepted_revision: u64,
    scope: &str,
) -> Result<Vec<FieldSnapshot>, RunError> {
    let (face_counts, cell_count) = grid_counts(grid)?;
    if accepted_revision == 0 {
        return Err(RunError {
            message: "GPU M1 accepted publication has an invalid revision".into(),
        });
    }
    if requested_fields
        .iter()
        .any(|name| !GPU_M1_TRANSPORT_OUTPUT_FIELDS.contains(&name.as_str()))
    {
        return Err(RunError {
            message: "GPU M1 accepted publication requested an unsupported field".into(),
        });
    }
    if requested_fields.is_empty() {
        return Ok(Vec::new());
    }
    let requested = |name: &str| requested_fields.iter().any(|field| field == name);
    if requested("V_electric") && artifacts.potential_v.len() != cell_count {
        return Err(RunError {
            message: "GPU M1 accepted potential field disagrees with the grid".into(),
        });
    }
    if requested("J_charge")
        && artifacts
            .charge_current_j_c
            .iter()
            .zip(face_counts)
            .any(|(values, count)| values.len() != count)
    {
        return Err(RunError {
            message: "GPU M1 accepted charge-current fields disagree with the grid".into(),
        });
    }
    if requested("spin_potential")
        && artifacts
            .spin_accumulation_mu_s
            .iter()
            .any(|values| values.len() != cell_count)
    {
        return Err(RunError {
            message: "GPU M1 accepted spin-potential field disagrees with the grid".into(),
        });
    }
    if requested("spin_current_tensor")
        && artifacts
            .spin_current_q_ia
            .iter()
            .zip(face_counts)
            .any(|(axis, count)| axis.iter().any(|values| values.len() != count))
    {
        return Err(RunError {
            message: "GPU M1 accepted spin-current fields disagree with the grid".into(),
        });
    }
    if requested("torque_stt")
        && artifacts
            .torque_stt
            .iter()
            .any(|values| values.len() != cell_count)
    {
        return Err(RunError {
            message: "GPU M1 accepted STT field disagrees with the grid".into(),
        });
    }
    let [nx, ny, nz] = grid.map(|value| value as usize);
    let current = if requested("J_charge") {
        let mut current = Vec::with_capacity(cell_count * 3);
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    for axis in 0..3 {
                        let (lower, upper) = face_pair(grid, x, y, z, axis);
                        current.push(
                            0.5 * (artifacts.charge_current_j_c[axis][lower]
                                + artifacts.charge_current_j_c[axis][upper]),
                        );
                    }
                }
            }
        }
        current
    } else {
        Vec::new()
    };
    let spin_current = if requested("spin_current_tensor") {
        let mut spin_current = Vec::with_capacity(cell_count * 9);
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    for flow_axis in 0..3 {
                        let (lower, upper) = face_pair(grid, x, y, z, flow_axis);
                        for spin_axis in 0..3 {
                            spin_current.push(
                                0.5 * (artifacts.spin_current_q_ia[flow_axis][spin_axis][lower]
                                    + artifacts.spin_current_q_ia[flow_axis][spin_axis][upper]),
                            );
                        }
                    }
                }
            }
        }
        spin_current
    } else {
        Vec::new()
    };
    let spin_potential = if requested("spin_potential") {
        interleave_soa(&artifacts.spin_accumulation_mu_s, cell_count)?
    } else {
        Vec::new()
    };
    let torque = if requested("torque_stt") {
        interleave_soa(&artifacts.torque_stt, cell_count)?
    } else {
        Vec::new()
    };

    let mut fields = Vec::with_capacity(requested_fields.len());
    for (name, ncomp, order, values) in [
        ("V_electric", 1, "scalar", artifacts.potential_v),
        ("J_charge", 3, "xyz", current),
        ("spin_potential", 3, "xyz", spin_potential),
        ("spin_current_tensor", 9, "row_major_Q_ia", spin_current),
        ("torque_stt", 3, "xyz", torque),
    ] {
        if requested(name) {
            fields.push(
                FieldSnapshot::new(
                    name,
                    step,
                    time,
                    solver_dt,
                    ncomp,
                    order,
                    "cell",
                    scope,
                    accepted_revision,
                    values,
                )
                .map_err(|message| RunError { message })?,
            );
        }
    }
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_face_fields_are_reconstructed_at_cells_with_canonical_component_order() {
        let artifacts = AcceptedGpuM1TransportArtifacts {
            potential_v: vec![1.0, 2.0],
            charge_current_j_c: [
                vec![0.0, 2.0, 4.0],
                vec![10.0, 12.0, 20.0, 22.0],
                vec![30.0, 32.0, 40.0, 42.0],
            ],
            spin_accumulation_mu_s: [vec![3.0, 4.0], vec![5.0, 6.0], vec![7.0, 8.0]],
            spin_current_q_ia: std::array::from_fn(|flow| {
                std::array::from_fn(|spin| {
                    let count = [3, 4, 4][flow];
                    (0..count)
                        .map(|index| (100 * flow + 10 * spin + index) as f64)
                        .collect()
                })
            }),
            torque_stt: [vec![9.0, 10.0], vec![11.0, 12.0], vec![13.0, 14.0]],
        };

        let fields = accepted_transport_field_snapshots(
            [2, 1, 1],
            artifacts,
            &[
                "V_electric".into(),
                "J_charge".into(),
                "spin_potential".into(),
                "spin_current_tensor".into(),
                "torque_stt".into(),
            ],
            4,
            2.0e-12,
            1.0e-13,
            7,
            "transport_module:spin:full_solve_domain",
        )
        .unwrap();

        assert_eq!(
            fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            [
                "V_electric",
                "J_charge",
                "spin_potential",
                "spin_current_tensor",
                "torque_stt"
            ]
        );
        assert_eq!(fields[1].component_order, "xyz");
        assert_eq!(fields[1].values, vec![1.0, 15.0, 35.0, 3.0, 17.0, 37.0]);
        assert_eq!(fields[2].values, vec![3.0, 5.0, 7.0, 4.0, 6.0, 8.0]);
        assert_eq!(fields[3].component_order, "row_major_Q_ia");
        assert_eq!(fields[3].values.len(), 18);
        assert_eq!(fields[4].values, vec![9.0, 11.0, 13.0, 10.0, 12.0, 14.0]);
        assert!(fields.iter().all(|field| field.location == "cell"));
        assert!(fields.iter().all(|field| field.revision == 7));
        assert!(fields.iter().all(|field| field.step == 4));
        assert!(fields.iter().all(|field| field.time == 2.0e-12));
        assert!(fields.iter().all(|field| field.solver_dt == 1.0e-13));
    }

    #[test]
    fn accepted_transport_publication_emits_only_requested_fields_from_a_partial_bundle() {
        let artifacts = AcceptedGpuM1TransportArtifacts {
            potential_v: Vec::new(),
            charge_current_j_c: std::array::from_fn(|_| Vec::new()),
            spin_accumulation_mu_s: std::array::from_fn(|_| Vec::new()),
            spin_current_q_ia: std::array::from_fn(|axis| {
                std::array::from_fn(|spin| {
                    (0..2)
                        .map(|index| (100 * axis + 10 * spin + index) as f64)
                        .collect()
                })
            }),
            torque_stt: [vec![9.0], vec![11.0], vec![13.0]],
        };

        let fields = accepted_transport_field_snapshots(
            [1, 1, 1],
            artifacts,
            &["spin_current_tensor".into(), "torque_stt".into()],
            12,
            2.75e-12,
            2.5e-13,
            13,
            "transport_module:spin:full_solve_domain",
        )
        .unwrap();

        assert_eq!(
            fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            ["spin_current_tensor", "torque_stt"]
        );
        assert_eq!(fields[0].component_count, 9);
        assert_eq!(fields[0].values.len(), 9);
        assert_eq!(fields[1].component_order, "xyz");
        assert_eq!(fields[1].values, vec![9.0, 11.0, 13.0]);
        assert!(fields.iter().all(|field| field.step == 12));
        assert!(fields.iter().all(|field| field.time == 2.75e-12));
        assert!(fields.iter().all(|field| field.solver_dt == 2.5e-13));
    }
}
