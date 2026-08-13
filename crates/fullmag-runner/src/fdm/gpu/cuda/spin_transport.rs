use fullmag_fdm_sys::gpu_transport_abi_v1 as ffi;
use fullmag_fdm_sys::gpu_transport_abi_v1::{
    fullmag_fdm_gpu_charge_snapshot_handle_v1, fullmag_fdm_gpu_charge_snapshot_info_v1,
    fullmag_fdm_gpu_charge_solve_request_v1, fullmag_fdm_gpu_charge_solve_result_v1,
    fullmag_fdm_gpu_steady_spin_solve_request_v1, fullmag_fdm_gpu_steady_spin_solve_result_v1,
    fullmag_fdm_gpu_transport_artifact_request_v1, fullmag_fdm_gpu_transport_buffer_view_v1,
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1,
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1,
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1,
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1,
    fullmag_fdm_gpu_transport_checkpoint_size_request_v1,
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1,
    fullmag_fdm_gpu_transport_context_create_request_v1,
    fullmag_fdm_gpu_transport_context_create_result_v1,
    fullmag_fdm_gpu_transport_context_handle_v1, fullmag_fdm_gpu_transport_static_descriptor_v1,
    gpu_prefix_v1, FULLMAG_FDM_GPU_TRANSPORT_ABI_V1,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::mem::size_of;

const BASE_STATIC_DESCRIPTOR_FEATURES: u64 = ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
    | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN;
const BASE_CHECKPOINT_FEATURES: u64 =
    BASE_STATIC_DESCRIPTOR_FEATURES | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1;

const CHECKPOINT_HOST_BYTES_PER_CELL_LIMIT: u64 = 4096;
const CHECKPOINT_HOST_FIXED_BYTES_LIMIT: u64 = 1 << 20;

fn static_descriptor_features(
    interfaces: &[ffi::fullmag_fdm_gpu_transport_spin_interface_v1],
) -> u64 {
    BASE_STATIC_DESCRIPTOR_FEATURES
        | if interfaces.iter().any(|interface| {
            interface.kind == ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
        }) {
            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
        } else {
            0
        }
}

fn prefix<T>() -> gpu_prefix_v1 {
    prefix_with_features::<T>(0)
}

fn prefix_with_features<T>(required_features: u64) -> gpu_prefix_v1 {
    gpu_prefix_v1 {
        abi_version: FULLMAG_FDM_GPU_TRANSPORT_ABI_V1,
        struct_version: 1,
        struct_size: size_of::<T>() as u32,
        required_features,
        ..Default::default()
    }
}

fn host_record_view<T>(
    values: &[T],
) -> Result<ffi::fullmag_fdm_gpu_transport_buffer_view_v1, GpuM1TransportError> {
    let byte_length = values
        .len()
        .checked_mul(size_of::<T>())
        .and_then(|bytes| u64::try_from(bytes).ok())
        .ok_or_else(|| invalid("GPU M1 host record view byte length overflows u64"))?;
    Ok(ffi::fullmag_fdm_gpu_transport_buffer_view_v1 {
        prefix: prefix::<ffi::fullmag_fdm_gpu_transport_buffer_view_v1>(),
        address: if values.is_empty() {
            0
        } else {
            values.as_ptr() as u64
        },
        element_count: values.len() as u64,
        byte_stride: size_of::<T>() as u64,
        byte_length,
        element_type: ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
        pointer_space: ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY,
        component_order: ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
        reserved1: 0,
    })
}

fn host_write_f64_view(
    values: &mut [f64],
    component_order: u32,
) -> Result<ffi::fullmag_fdm_gpu_transport_buffer_view_v1, GpuM1TransportError> {
    let byte_length = values
        .len()
        .checked_mul(size_of::<f64>())
        .and_then(|bytes| u64::try_from(bytes).ok())
        .ok_or_else(|| invalid("GPU M1 artifact readback byte length overflows u64"))?;
    Ok(ffi::fullmag_fdm_gpu_transport_buffer_view_v1 {
        prefix: prefix::<ffi::fullmag_fdm_gpu_transport_buffer_view_v1>(),
        address: if values.is_empty() {
            0
        } else {
            values.as_mut_ptr() as u64
        },
        element_count: values.len() as u64,
        byte_stride: size_of::<f64>() as u64,
        byte_length,
        element_type: ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
        pointer_space: ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY,
        component_order,
        reserved1: 0,
    })
}

fn context_handles_match(
    lhs: fullmag_fdm_gpu_transport_context_handle_v1,
    rhs: fullmag_fdm_gpu_transport_context_handle_v1,
) -> bool {
    lhs.registry_cookie == rhs.registry_cookie
        && lhs.slot == rhs.slot
        && lhs.generation == rhs.generation
        && lhs.type_tag == rhs.type_tag
}

fn snapshot_handles_match(
    lhs: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    rhs: fullmag_fdm_gpu_charge_snapshot_handle_v1,
) -> bool {
    lhs.registry_cookie == rhs.registry_cookie
        && lhs.slot == rhs.slot
        && lhs.generation == rhs.generation
        && lhs.type_tag == rhs.type_tag
}

fn context_handle_is_null(handle: fullmag_fdm_gpu_transport_context_handle_v1) -> bool {
    handle.registry_cookie == 0
        && handle.slot == 0
        && handle.generation == 0
        && handle.type_tag == 0
}

fn snapshot_handle_is_null(handle: fullmag_fdm_gpu_charge_snapshot_handle_v1) -> bool {
    handle.registry_cookie == 0
        && handle.slot == 0
        && handle.generation == 0
        && handle.type_tag == 0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DeviceIdentity {
    pub(crate) uuid: [u8; 16],
    pub(crate) ordinal: i32,
    pub(crate) build_digest: [u8; 32],
}

pub(crate) struct PreparedGpuM1Descriptor {
    context_request: fullmag_fdm_gpu_transport_context_create_request_v1,
    static_descriptor: fullmag_fdm_gpu_transport_static_descriptor_v1,
    charge_operator_revision: u64,
    spin_operator_revision: u64,
    charge_solver_policy: u32,
    charge_gauge_policy: u32,
    charge_relative_tolerance: f64,
    charge_max_iterations: u64,
    spin_solver_policy: u32,
    spin_relative_tolerance: f64,
    spin_max_iterations: u64,
    cell_count: u64,
    cells: Vec<ffi::fullmag_fdm_gpu_transport_spin_cell_v1>,
    materials: Vec<ffi::fullmag_fdm_gpu_transport_spin_material_v1>,
    interfaces: Vec<ffi::fullmag_fdm_gpu_transport_spin_interface_v1>,
    charge_faces: Vec<ffi::fullmag_fdm_gpu_transport_charge_face_v1>,
    spin_faces: Vec<ffi::fullmag_fdm_gpu_transport_spin_boundary_face_v1>,
    formula_ids: Vec<ffi::fullmag_fdm_gpu_transport_formula_ids_v1>,
}

impl PreparedGpuM1Descriptor {
    pub(crate) fn from_raw(
        context_request: fullmag_fdm_gpu_transport_context_create_request_v1,
        static_descriptor: fullmag_fdm_gpu_transport_static_descriptor_v1,
        charge_operator_revision: u64,
        spin_operator_revision: u64,
    ) -> Self {
        let formula_ids = vec![ffi::fullmag_fdm_gpu_transport_formula_ids_v1 {
            prefix: prefix_with_features::<ffi::fullmag_fdm_gpu_transport_formula_ids_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE,
            ),
            operator_revision: charge_operator_revision,
            spin_operator_revision,
            gmres_restart: 50,
            ..Default::default()
        }];
        Self {
            context_request,
            static_descriptor,
            charge_operator_revision,
            spin_operator_revision,
            charge_solver_policy:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1,
            charge_gauge_policy:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT,
            charge_relative_tolerance: 1.0e-10,
            charge_max_iterations: 4_000,
            spin_solver_policy:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1,
            spin_relative_tolerance: 1.0e-8,
            spin_max_iterations: 2_000,
            cell_count: static_descriptor.grid.into_iter().product(),
            cells: Vec::new(),
            materials: Vec::new(),
            interfaces: Vec::new(),
            charge_faces: Vec::new(),
            spin_faces: Vec::new(),
            formula_ids,
        }
    }

    pub(crate) fn from_plan(
        plan: &fullmag_ir::FdmPlanIR,
        device_ordinal: i32,
    ) -> Result<Self, GpuM1TransportError> {
        if device_ordinal < 0 {
            return Err(invalid("GPU M1 requires an explicit CUDA device ordinal"));
        }
        if !plan.fdm_gpu_charge_transports.is_empty() {
            return Err(invalid(
                "a GPU M1 spin plan cannot also carry the standalone charge-only descriptor",
            ));
        }
        let [transport_plan] = plan.spin_transport_plans.as_slice() else {
            return Err(invalid(
                "GPU M1 requires exactly one resolved spin transport plan",
            ));
        };
        let descriptor = transport_plan
            .fdm_gpu_double
            .as_ref()
            .ok_or_else(|| invalid("GPU M1 requires the resolved fdm_gpu_double descriptor"))?;
        if descriptor.descriptor_schema != "fullmag.fdm.spin_transport_descriptor.v1"
            || descriptor.realization != fullmag_ir::FdmCpuTransportRealizationIR::NativeM1V1
            || descriptor.enclosing_execution_mode != fullmag_ir::ExecutionMode::Strict
            || transport_plan.requested_execution.discretization != fullmag_ir::BackendTarget::Fdm
            || transport_plan.requested_execution.device != fullmag_ir::ExecutionDevice::Gpu
            || transport_plan.requested_execution.precision
                != fullmag_ir::ExecutionPrecision::Double
            || transport_plan.requested_execution.execution_mode
                != fullmag_ir::ExecutionMode::Strict
            || transport_plan.resolved_discretization != fullmag_ir::BackendTarget::Fdm
            || transport_plan.resolved_device != fullmag_ir::ExecutionDevice::Gpu
            || transport_plan.resolved_precision != fullmag_ir::ExecutionPrecision::Double
            || transport_plan.resolved_execution_mode != fullmag_ir::ExecutionMode::Strict
        {
            return Err(invalid(
                "resolved spin descriptor contradicts the bounded FDM/GPU/double/strict native_m1_v1 lane",
            ));
        }
        if descriptor.time_envelope.is_some()
            || descriptor.structured_current_closure.is_some()
            || descriptor.oersted_source_bound
        {
            return Err(invalid(
                "resolved GPU M1 descriptor contains a feature outside the bounded static lane",
            ));
        }
        validate_frozen_gpu_m1_contract(transport_plan, descriptor)?;

        let grid = plan.grid.cells.map(u64::from);
        let cell_count = checked_cell_count(grid)?;
        let arrays = [
            descriptor.charge_active_cells.len(),
            descriptor.charge_conductivity_spm.len(),
            descriptor.spin_active_cells.len(),
            descriptor.spin_conductivity_spm.len(),
            descriptor.polarization_p.len(),
            descriptor.theta_sh.len(),
            descriptor.reactions.len(),
            descriptor.region_ids.len(),
            descriptor.torque_target_cells.len(),
            descriptor.saturation_magnetization_apm.len(),
        ];
        if arrays.iter().any(|length| *length != cell_count)
            || plan.initial_magnetization.len() != cell_count
        {
            return Err(invalid(
                "resolved GPU M1 cell payloads must match the common FDM grid",
            ));
        }
        if descriptor.magnetic_active_mask.len() != cell_count {
            return Err(invalid(
                "resolved GPU M1 magnetic mask must match the common FDM grid",
            ));
        }
        if descriptor
            .magnetic_active_mask
            .iter()
            .zip(&descriptor.transport_active_mask)
            .any(|(magnetic, transport)| *magnetic && !*transport)
        {
            return Err(invalid(
                "GPU M1 magnetic cells must be a subset of the transport domain",
            ));
        }
        if descriptor
            .torque_target_cells
            .iter()
            .zip(&descriptor.magnetic_active_mask)
            .any(|(target, magnetic)| *target && !*magnetic)
        {
            return Err(invalid("GPU M1 torque targets must be magnetic cells"));
        }
        if plan
            .active_mask
            .as_ref()
            .is_some_and(|mask| mask.len() != cell_count)
            || descriptor.transport_active_mask.len() != cell_count
            || descriptor
                .transport_active_mask
                .iter()
                .any(|active| !*active)
            || descriptor.charge_active_cells.iter().any(|active| !*active)
            || descriptor.spin_active_cells.iter().any(|active| !*active)
        {
            return Err(invalid(
                "bounded GPU M1 requires one full rectangular transport-active grid; partial active masks are unsupported",
            ));
        }

        let canonical_payload = serde_json::to_vec(&(
            transport_plan,
            grid,
            plan.cell_size,
            &plan.initial_magnetization,
        ))
        .map_err(|error| invalid(format!("failed to serialize GPU M1 identity: {error}")))?;
        let digest: [u8; 32] = Sha256::digest(canonical_payload).into();
        let source_revision = 1;
        let descriptor_revision = 1;
        let charge_operator_revision = 1;
        let spin_operator_revision = 1;

        let mut material_lut = BTreeMap::<[u64; 8], u32>::new();
        let mut materials = Vec::new();
        let mut cells = Vec::with_capacity(cell_count);
        for cell in 0..cell_count {
            let charge_active = descriptor.charge_active_cells[cell];
            let spin_active = descriptor.spin_active_cells[cell];
            let reaction = descriptor.reactions[cell];
            let conductivity = descriptor.charge_conductivity_spm[cell];
            let spin_conductivity = descriptor.spin_conductivity_spm[cell];
            let polarization = descriptor.polarization_p[cell];
            let theta_sh = descriptor.theta_sh[cell];
            if [
                reaction.spin_flip_m,
                reaction.exchange_m,
                reaction.dephasing_m,
            ]
            .into_iter()
            .flatten()
            .any(|length| !length.is_finite() || length <= 0.0)
            {
                return Err(invalid(
                    "enabled GPU M1 reaction lengths must be finite and positive",
                ));
            }
            let spin_flip = reaction.spin_flip_m.unwrap_or(0.0);
            let exchange = reaction.exchange_m.unwrap_or(0.0);
            let dephasing = reaction.dephasing_m.unwrap_or(0.0);
            let material_index = if charge_active || spin_active {
                let values = [
                    conductivity,
                    spin_conductivity,
                    polarization,
                    theta_sh,
                    spin_flip,
                    exchange,
                    dephasing,
                ];
                if values.iter().any(|value| !value.is_finite())
                    || (charge_active && conductivity <= 0.0)
                    || (spin_active && spin_conductivity <= 0.0)
                    || !(-1.0..=1.0).contains(&polarization)
                {
                    return Err(invalid(
                        "active GPU M1 cells require finite positive transport coefficients",
                    ));
                }
                let key = [
                    u64::from(descriptor.region_ids[cell]),
                    conductivity.to_bits(),
                    spin_conductivity.to_bits(),
                    polarization.to_bits(),
                    theta_sh.to_bits(),
                    spin_flip.to_bits(),
                    exchange.to_bits(),
                    dephasing.to_bits(),
                ];
                if let Some(index) = material_lut.get(&key) {
                    *index
                } else {
                    let index = u32::try_from(materials.len() + 1)
                        .map_err(|_| invalid("GPU M1 material count exceeds u32"))?;
                    material_lut.insert(key, index);
                    materials.push(ffi::fullmag_fdm_gpu_transport_spin_material_v1 {
                        prefix: prefix_with_features::<
                            ffi::fullmag_fdm_gpu_transport_spin_material_v1,
                        >(
                            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                        ),
                        material_index: index,
                        reserved1: 0,
                        conductivity,
                        material_revision: source_revision,
                        spin_conductivity,
                        polarization,
                        spin_hall_angle: theta_sh,
                        spin_flip_length: spin_flip,
                        exchange_length: exchange,
                        dephasing_length: dephasing,
                        spin_revision: spin_operator_revision,
                    });
                    index
                }
            } else {
                0
            };
            let saturation_magnetization = descriptor.saturation_magnetization_apm[cell];
            if !saturation_magnetization.is_finite() || saturation_magnetization < 0.0 {
                return Err(invalid(
                    "GPU M1 saturation magnetization must be finite and non-negative",
                ));
            }
            if descriptor.torque_target_cells[cell] && saturation_magnetization <= 0.0 {
                return Err(invalid(
                    "GPU M1 torque targets require finite positive saturation magnetization",
                ));
            }
            cells.push(ffi::fullmag_fdm_gpu_transport_spin_cell_v1 {
                prefix: prefix_with_features::<ffi::fullmag_fdm_gpu_transport_spin_cell_v1>(
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE,
                ),
                active: u32::from(charge_active || spin_active),
                conductor: u32::from(charge_active),
                material_index,
                reserved1: 0,
                spin_active: u32::from(spin_active),
                torque_target: u32::from(descriptor.torque_target_cells[cell]),
                region_id: descriptor.region_ids[cell],
                reserved2: 0,
                saturation_magnetization,
            });
        }

        let charge_faces = super::charge_transport::expand_resolved_boundaries(
            &descriptor.charge_boundaries,
            &descriptor.charge_active_cells,
            grid,
            plan.cell_size,
        )
        .map_err(|error| invalid(error.to_string()))?
        .into_iter()
        .map(|face| ffi::fullmag_fdm_gpu_transport_charge_face_v1 {
            prefix: prefix_with_features::<ffi::fullmag_fdm_gpu_transport_charge_face_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE,
            ),
            kind: match face.kind {
                super::charge_transport::GpuChargeBoundaryKind::Voltage => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE
                }
                super::charge_transport::GpuChargeBoundaryKind::ExactCurrentDensity => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY
                }
                super::charge_transport::GpuChargeBoundaryKind::Insulating => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING
                }
            },
            axis: face.axis,
            side: face.side,
            outward_sign: face.outward_sign,
            adjacent_cell: face.adjacent_cell,
            canonical_face_index: face.canonical_face_index,
            area: face.area_m2,
            value: face.value,
            source_id: face.source_id,
        })
        .collect();
        let spin_faces = materialize_spin_boundaries(descriptor, grid, plan.cell_size)?;
        let interfaces = materialize_interfaces(
            descriptor,
            grid,
            plan.cell_size,
            &plan.initial_magnetization,
        )?;
        let formula_ids = vec![ffi::fullmag_fdm_gpu_transport_formula_ids_v1 {
            prefix: prefix_with_features::<ffi::fullmag_fdm_gpu_transport_formula_ids_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE,
            ),
            formula_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1,
            operator_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1,
            engine_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1,
            residual_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1,
            operator_revision: charge_operator_revision,
            reserved1: 0,
            spin_formula_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1,
            spin_operator_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1,
            electric_reconstruction_id:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1,
            interface_formula_id:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2,
            torque_operator_id:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1,
            spin_engine_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1,
            preconditioner_id:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1,
            spin_residual_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1,
            local_residual_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1,
            reserved2: 0,
            spin_operator_revision,
            preconditioner_revision: spin_operator_revision,
            gamma_e: descriptor.gamma_e_rad_per_s_t,
            gmres_restart: 50,
            reserved3: 0,
        }];
        let required_features = ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
            | if descriptor.interfaces.iter().any(|interface| {
                matches!(
                    interface.law,
                    fullmag_ir::ResolvedSpinInterfaceLawIR::MixingConductance { .. }
                )
            }) {
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
            } else {
                0
            };
        Ok(Self {
            context_request: ffi::fullmag_fdm_gpu_transport_context_create_request_v1 {
                prefix: prefix::<ffi::fullmag_fdm_gpu_transport_context_create_request_v1>(),
                device_uuid: [0; 16],
                device_ordinal,
                precision: ffi::FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE,
                strict_residency: ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE,
                deterministic: ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE,
                allocator_limit: 0,
                workspace_limit: 0,
                stream_policy:
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM,
                reserved1: 0,
                requested_device_features: required_features,
                reserved2: 0,
            },
            static_descriptor: ffi::fullmag_fdm_gpu_transport_static_descriptor_v1 {
                prefix: prefix::<ffi::fullmag_fdm_gpu_transport_static_descriptor_v1>(),
                grid,
                cell_size: plan.cell_size,
                descriptor_revision,
                source_revision,
                descriptor_digest: digest,
                ..Default::default()
            },
            charge_operator_revision,
            spin_operator_revision,
            charge_solver_policy:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1,
            charge_gauge_policy: match descriptor.charge_gauge {
                fullmag_ir::ChargePotentialGaugeIR::DirichletReference => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT
                }
                fullmag_ir::ChargePotentialGaugeIR::ZeroMean => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT
                }
            },
            charge_relative_tolerance: descriptor.charge_solver.linear.relative_tolerance,
            charge_max_iterations: u64::from(descriptor.charge_solver.linear.max_iterations),
            spin_solver_policy:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1,
            spin_relative_tolerance: descriptor.spin_solver.linear.relative_tolerance,
            spin_max_iterations: u64::from(descriptor.spin_solver.linear.max_iterations),
            cell_count: u64::try_from(cell_count)
                .map_err(|_| invalid("GPU M1 cell count exceeds u64"))?,
            cells,
            materials,
            interfaces,
            charge_faces,
            spin_faces,
            formula_ids,
        })
    }
}

fn valid_linear_policy(policy: &fullmag_ir::LinearTransportSolverPolicyIR) -> bool {
    policy.relative_tolerance.is_finite()
        && policy.relative_tolerance > 0.0
        && policy.relative_tolerance < 1.0
        && policy.absolute_tolerance == 0.0
        && policy.max_iterations > 0
}

fn validate_frozen_gpu_m1_contract(
    plan: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &fullmag_ir::ResolvedFdmSpinTransportIR,
) -> Result<(), GpuM1TransportError> {
    if plan.constitutive_version != "transport_constitutive.one_way.fullmag.v1"
        || plan.operator_version != "fv_spin_upwind_v1"
        || plan.physical_residual_version != "transport_balance_integrated_l2.v1"
        || descriptor.charge_solver.engine != "cg"
        || descriptor.charge_solver.operator_version != "fv_charge_harmonic_v1"
        || descriptor.charge_solver.physical_residual_version != "charge_balance_integrated_l2.v1"
        || descriptor.spin_solver.engine != "native_m1_v1"
        || descriptor.spin_solver.operator_version != "fv_spin_upwind_v1"
        || descriptor.spin_solver.physical_residual_version != "transport_balance_integrated_l2.v1"
        || descriptor.spin_solver.default_external_boundary != "spin_insulating"
        || descriptor.spin_solver.reciprocal_nonlinear.is_some()
        || descriptor.torque_formula_version.as_deref()
            != Some("transport_torque_angular_momentum.fullmag.v1")
        || !valid_linear_policy(&descriptor.charge_solver.linear)
        || !valid_linear_policy(&descriptor.spin_solver.linear)
    {
        return Err(invalid(
            "resolved GPU M1 solver/formula versions or linear policies do not match the frozen production registry",
        ));
    }
    if descriptor.torque_target_masks.len() != 1
        || descriptor.torque_target_masks[0].active_mask != descriptor.torque_target_cells
        || !descriptor.torque_target_cells.iter().any(|active| *active)
    {
        return Err(invalid(
            "bounded GPU M1 requires exactly one planner-owned transport torque target mask",
        ));
    }
    if !descriptor.gamma_e_rad_per_s_t.is_finite() || descriptor.gamma_e_rad_per_s_t <= 0.0 {
        return Err(invalid("GPU M1 requires finite positive gamma_e"));
    }
    for interface in &descriptor.interfaces {
        if let fullmag_ir::ResolvedSpinInterfaceLawIR::MixingConductance {
            g_up_spm2,
            g_down_spm2,
            g_r_spm2,
            g_i_spm2,
            g_sml_spm2,
            spin_memory_loss,
            formula_version,
            ..
        } = &interface.law
        {
            if formula_version != "magnetoelectronic.fullmag.v2"
                || !g_up_spm2.is_finite()
                || *g_up_spm2 < 0.0
                || !g_down_spm2.is_finite()
                || *g_down_spm2 < 0.0
                || !g_r_spm2.is_finite()
                || *g_r_spm2 < 0.0
                || !g_i_spm2.is_finite()
                || *g_sml_spm2 != 0.0
                || spin_memory_loss.is_some()
            {
                return Err(invalid(
                    "GPU M1 mixing interface violates the frozen magnetoelectronic v2 contract",
                ));
            }
        }
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> GpuM1TransportError {
    GpuM1TransportError::InvalidDescriptor(message.into())
}

fn digest_revision(bytes: &[u8]) -> u64 {
    let revision = u64::from_le_bytes(bytes.try_into().expect("revision uses eight digest bytes"));
    revision.max(1)
}

fn stable_id(value: &str) -> u64 {
    digest_revision(&Sha256::digest(value.as_bytes())[..8])
}

fn stable_interface_record_source_id(
    family_source_id: &str,
    axis: u32,
    canonical_face_index: u64,
    negative_cell: u64,
    positive_cell: u64,
) -> u64 {
    stable_id(&format!(
        "gpu_m1_interface_face_v1:{family_source_id}:{axis}:{canonical_face_index}:{negative_cell}:{positive_cell}"
    ))
}

fn checked_cell_count(grid: [u64; 3]) -> Result<usize, GpuM1TransportError> {
    grid.into_iter()
        .try_fold(1_u64, u64::checked_mul)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| invalid("GPU M1 grid cell count overflows usize"))
}

fn face_component_counts(grid: [u64; 3]) -> Result<[usize; 3], GpuM1TransportError> {
    let [nx, ny, nz] = grid;
    let count = |a: u64, b: u64, c: u64| {
        a.checked_mul(b)
            .and_then(|product| product.checked_mul(c))
            .and_then(|product| usize::try_from(product).ok())
    };
    Ok([
        count(
            nx.checked_add(1)
                .ok_or_else(|| invalid("GPU M1 x-face count overflows u64"))?,
            ny,
            nz,
        )
        .ok_or_else(|| invalid("GPU M1 x-face count overflows usize"))?,
        count(
            nx,
            ny.checked_add(1)
                .ok_or_else(|| invalid("GPU M1 y-face count overflows u64"))?,
            nz,
        )
        .ok_or_else(|| invalid("GPU M1 y-face count overflows usize"))?,
        count(
            nx,
            ny,
            nz.checked_add(1)
                .ok_or_else(|| invalid("GPU M1 z-face count overflows u64"))?,
        )
        .ok_or_else(|| invalid("GPU M1 z-face count overflows usize"))?,
    ])
}

fn boundary_geometry(
    face: fullmag_ir::StructuredBoundaryFaceIR,
    cell_size: [f64; 3],
) -> (u32, i32, f64) {
    use fullmag_ir::StructuredBoundaryFaceIR::*;
    match face {
        XMin => (0, -1, cell_size[1] * cell_size[2]),
        XMax => (0, 1, cell_size[1] * cell_size[2]),
        YMin => (1, -1, cell_size[0] * cell_size[2]),
        YMax => (1, 1, cell_size[0] * cell_size[2]),
        ZMin => (2, -1, cell_size[0] * cell_size[1]),
        ZMax => (2, 1, cell_size[0] * cell_size[1]),
    }
}

fn materialize_spin_boundaries(
    descriptor: &fullmag_ir::ResolvedFdmSpinTransportIR,
    grid: [u64; 3],
    cell_size: [f64; 3],
) -> Result<Vec<ffi::fullmag_fdm_gpu_transport_spin_boundary_face_v1>, GpuM1TransportError> {
    use fullmag_ir::{ResolvedSpinBoundaryConditionIR as Condition, StructuredBoundaryFaceIR::*};
    let [nx, ny, nz] = grid;
    let assigned_surfaces = descriptor
        .spin_boundaries
        .iter()
        .map(|boundary| boundary.face)
        .collect::<std::collections::BTreeSet<_>>();
    if descriptor.spin_boundaries.len() != 6 || assigned_surfaces.len() != 6 {
        return Err(invalid(
            "GPU M1 requires one assignment for every face of the complete external structured boundary",
        ));
    }
    let expected_count = ny
        .checked_mul(nz)
        .and_then(|yz| {
            nx.checked_mul(nz).and_then(|xz| {
                nx.checked_mul(ny)
                    .and_then(|xy| yz.checked_add(xz)?.checked_add(xy))
            })
        })
        .and_then(|half| half.checked_mul(2))
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| invalid("GPU M1 external boundary face count overflows usize"))?;
    let mut result = Vec::new();
    for boundary in &descriptor.spin_boundaries {
        let (kind, potential_xyz) = match boundary.condition {
            Condition::SpinInsulating => (
                ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING,
                [0.0; 3],
            ),
            Condition::SpinSink => (ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK, [0.0; 3]),
            Condition::SpecifiedPotential { value_v } => (
                ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL,
                value_v,
            ),
            Condition::SpecifiedOutwardFlux { .. } | Condition::PeriodicSpin => {
                return Err(invalid(
                    "GPU M1 does not support specified spin flux or periodic spin boundaries",
                ));
            }
        };
        let (axis, side, area) = boundary_geometry(boundary.face, cell_size);
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let on_face = match boundary.face {
                        XMin => x == 0,
                        XMax => x + 1 == nx,
                        YMin => y == 0,
                        YMax => y + 1 == ny,
                        ZMin => z == 0,
                        ZMax => z + 1 == nz,
                    };
                    if !on_face {
                        continue;
                    }
                    let cell = x + nx * (y + ny * z);
                    if !descriptor.spin_active_cells[cell as usize] {
                        return Err(invalid(
                            "GPU M1 complete external structured boundary touches a spin-inactive cell",
                        ));
                    }
                    let canonical_face_index = match boundary.face {
                        XMin => (nx + 1) * (y + ny * z),
                        XMax => nx + (nx + 1) * (y + ny * z),
                        YMin => x + nx * ((ny + 1) * z),
                        YMax => x + nx * (ny + (ny + 1) * z),
                        ZMin => x + nx * y,
                        ZMax => x + nx * (y + ny * nz),
                    };
                    result.push(ffi::fullmag_fdm_gpu_transport_spin_boundary_face_v1 {
                        prefix: prefix_with_features::<
                            ffi::fullmag_fdm_gpu_transport_spin_boundary_face_v1,
                        >(
                            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
                        ),
                        kind,
                        axis,
                        side,
                        outward_sign: side,
                        adjacent_cell: cell,
                        canonical_face_index,
                        area,
                        potential_xyz,
                        source_id: stable_id(&boundary.source_id),
                    });
                }
            }
        }
    }
    let unique_faces = result
        .iter()
        .map(|face| (face.axis, face.canonical_face_index))
        .collect::<std::collections::BTreeSet<_>>();
    if result.len() != expected_count || unique_faces.len() != expected_count {
        return Err(invalid(
            "GPU M1 spin boundaries must cover every external structured face exactly once",
        ));
    }
    Ok(result)
}

fn materialize_interfaces(
    descriptor: &fullmag_ir::ResolvedFdmSpinTransportIR,
    grid: [u64; 3],
    cell_size: [f64; 3],
    initial_magnetization: &[[f64; 3]],
) -> Result<Vec<ffi::fullmag_fdm_gpu_transport_spin_interface_v1>, GpuM1TransportError> {
    let [nx, ny, _] = grid;
    let mut result = Vec::with_capacity(descriptor.interfaces.len());
    for interface in &descriptor.interfaces {
        let axis = u32::from(interface.face.axis);
        if axis > 2
            || interface.face.negative_cell as usize >= initial_magnetization.len()
            || interface.face.positive_cell as usize >= initial_magnetization.len()
        {
            return Err(invalid(
                "GPU M1 interface topology is outside the common grid",
            ));
        }
        let negative = interface.face.negative_cell;
        let positive = interface.face.positive_cell;
        let expected_positive = negative
            + match axis {
                0 => 1,
                1 => nx,
                _ => nx * ny,
            };
        if positive != expected_positive
            || !matches!(interface.from_cell, value if value == negative || value == positive)
            || !matches!(interface.to_cell, value if value == negative || value == positive)
            || interface.from_cell == interface.to_cell
        {
            return Err(invalid(
                "GPU M1 interface cells are not one canonical oriented face",
            ));
        }
        if !descriptor.spin_active_cells[negative as usize]
            || !descriptor.spin_active_cells[positive as usize]
        {
            return Err(invalid(
                "GPU M1 interface endpoints must both be spin-active",
            ));
        }
        let (kind, g_up, g_down, g_r, g_i) = match interface.law {
            fullmag_ir::ResolvedSpinInterfaceLawIR::Transparent => (
                ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT,
                0.0,
                0.0,
                0.0,
                0.0,
            ),
            fullmag_ir::ResolvedSpinInterfaceLawIR::MixingConductance {
                g_up_spm2,
                g_down_spm2,
                g_r_spm2,
                g_i_spm2,
                g_sml_spm2,
                ref spin_memory_loss,
                ..
            } => {
                if g_sml_spm2 != 0.0 || spin_memory_loss.is_some() {
                    return Err(invalid("GPU M1 mixing interface cannot degrade SML"));
                }
                (
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
                    g_up_spm2,
                    g_down_spm2,
                    g_r_spm2,
                    g_i_spm2,
                )
            }
        };
        let magnetization_xyz = if kind
            == ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
        {
            let from = interface.from_cell as usize;
            let to = interface.to_cell as usize;
            if descriptor.magnetic_active_mask[from]
                || descriptor.torque_target_cells[from]
                || !descriptor.magnetic_active_mask[to]
                || !descriptor.torque_target_cells[to]
            {
                return Err(invalid(
                    "GPU M1 mixing interface requires exactly to_cell to be the magnetic torque owner",
                ));
            }
            let magnetization = initial_magnetization[to];
            let norm = magnetization
                .iter()
                .map(|value| value * value)
                .sum::<f64>()
                .sqrt();
            if !norm.is_finite() || norm <= 0.0 {
                return Err(invalid(
                    "GPU M1 interface magnetization must be finite and non-zero",
                ));
            }
            magnetization.map(|value| value / norm)
        } else {
            [0.0; 3]
        };
        let coordinates = [negative % nx, (negative / nx) % ny, negative / (nx * ny)];
        let canonical_face_index = match axis {
            0 => coordinates[0] + 1 + (nx + 1) * (coordinates[1] + ny * coordinates[2]),
            1 => coordinates[0] + nx * (coordinates[1] + 1 + (ny + 1) * coordinates[2]),
            _ => coordinates[0] + nx * (coordinates[1] + ny * (coordinates[2] + 1)),
        };
        let area = match axis {
            0 => cell_size[1] * cell_size[2],
            1 => cell_size[0] * cell_size[2],
            _ => cell_size[0] * cell_size[1],
        };
        result.push(ffi::fullmag_fdm_gpu_transport_spin_interface_v1 {
            prefix: prefix_with_features::<ffi::fullmag_fdm_gpu_transport_spin_interface_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                    | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
                    | if kind == ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
                    {
                        ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
                    } else {
                        0
                    },
            ),
            kind,
            axis,
            orientation: if interface.from_cell == negative {
                1
            } else {
                -1
            },
            reserved1: 0,
            negative_cell: negative,
            positive_cell: positive,
            from_cell: interface.from_cell,
            to_cell: interface.to_cell,
            canonical_face_index,
            area,
            G_up: g_up,
            G_down: g_down,
            G_r: g_r,
            G_i: g_i,
            magnetization_xyz,
            source_id: stable_interface_record_source_id(
                &interface.source_id,
                axis,
                canonical_face_index,
                negative,
                positive,
            ),
            topology_id: stable_id(&format!(
                "{}:{}:{}:{}",
                axis, negative, positive, interface.source_id
            )),
            charge_edge_enabled: if kind
                == ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT
                || g_up > 0.0
                || g_down > 0.0
            {
                ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE
            } else {
                ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_FALSE
            },
            reserved2: 0,
        });
    }
    let unique_source_ids = result
        .iter()
        .map(|interface| interface.source_id)
        .collect::<std::collections::BTreeSet<_>>();
    if unique_source_ids.len() != result.len() {
        return Err(invalid(
            "GPU M1 interface face source identities must be unique",
        ));
    }
    Ok(result)
}

pub(crate) struct DeviceVectorViews {
    magnetization: fullmag_fdm_gpu_transport_buffer_view_v1,
    torque: fullmag_fdm_gpu_transport_buffer_view_v1,
    device_identity: DeviceIdentity,
}

impl DeviceVectorViews {
    pub(crate) fn from_raw(
        magnetization: fullmag_fdm_gpu_transport_buffer_view_v1,
        torque: fullmag_fdm_gpu_transport_buffer_view_v1,
        device_identity: DeviceIdentity,
    ) -> Self {
        Self {
            magnetization,
            torque,
            device_identity,
        }
    }
}

fn validate_device_vector_view(
    view: &fullmag_fdm_gpu_transport_buffer_view_v1,
    pointer_space: u32,
    cell_count: u64,
) -> Result<(), GpuM1TransportError> {
    let element_count = cell_count
        .checked_mul(3)
        .ok_or_else(|| invalid("GPU M1 device vector element count overflows u64"))?;
    let byte_length = element_count
        .checked_mul(size_of::<f64>() as u64)
        .ok_or_else(|| invalid("GPU M1 device vector byte length overflows u64"))?;
    let address_end = view
        .address
        .checked_add(view.byte_length)
        .ok_or_else(|| invalid("GPU M1 device vector address range overflows u64"))?;
    if view.address == 0
        || view.address % std::mem::align_of::<f64>() as u64 != 0
        || address_end <= view.address
        || view.element_count != element_count
        || view.byte_stride != size_of::<f64>() as u64
        || view.byte_length != byte_length
        || view.element_type != ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64
        || view.pointer_space != pointer_space
        || view.component_order != ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ
        || view.reserved1 != 0
    {
        return Err(invalid(
            "GPU M1 m_stage/torque views must be exact FP64 SoA device views on the common grid",
        ));
    }
    Ok(())
}

fn validate_disjoint_device_vector_views(
    magnetization: &fullmag_fdm_gpu_transport_buffer_view_v1,
    torque: &fullmag_fdm_gpu_transport_buffer_view_v1,
) -> Result<(), GpuM1TransportError> {
    let magnetization_end = magnetization
        .address
        .checked_add(magnetization.byte_length)
        .ok_or_else(|| invalid("GPU M1 magnetization device range overflows u64"))?;
    let torque_end = torque
        .address
        .checked_add(torque.byte_length)
        .ok_or_else(|| invalid("GPU M1 torque device range overflows u64"))?;
    if magnetization.address < torque_end && torque.address < magnetization_end {
        return Err(invalid(
            "GPU M1 magnetization and torque device ranges must be disjoint",
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct AcceptedChargeSnapshot {
    pub(crate) handle: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    context_handle: fullmag_fdm_gpu_transport_context_handle_v1,
    pub(crate) accepted_sequence: u64,
    pub(crate) source_revision: u64,
    pub(crate) operator_revision: u64,
    content_digest: [u8; 32],
    pub(crate) device_identity: DeviceIdentity,
}

pub(crate) struct AcceptedSpinSnapshot {
    pub(crate) accepted_sequence: u64,
    pub(crate) source_revision: u64,
    pub(crate) operator_revision: u64,
    pub(crate) snapshot_content_digest: [u8; 32],
    pub(crate) deterministic_compute_digest: [u8; 32],
    pub(crate) device_identity: DeviceIdentity,
}

#[derive(Debug, PartialEq)]
pub(crate) struct AcceptedGpuM1TransportArtifacts {
    pub(crate) potential_v: Vec<f64>,
    pub(crate) charge_current_j_c: [Vec<f64>; 3],
    pub(crate) spin_accumulation_mu_s: [Vec<f64>; 3],
    pub(crate) spin_current_q_ia: [[Vec<f64>; 3]; 3],
    pub(crate) torque_stt: [Vec<f64>; 3],
}

pub(crate) struct AcceptedGpuM1Publication {
    pub(crate) accepted_sequence: u64,
    pub(crate) source_revision: u64,
    pub(crate) charge_operator_revision: u64,
    pub(crate) static_descriptor_revision: u64,
    pub(crate) spin_operator_revision: u64,
    pub(crate) device_identity: DeviceIdentity,
    pub(crate) charge_snapshot_content_digest: [u8; 32],
    pub(crate) spin_deterministic_compute_digest: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TransportStageCheckpointV1 {
    pub(crate) schema: String,
    pub(crate) accepted_step: u64,
    pub(crate) charge_sequence: u64,
    pub(crate) spin_accepted_sequence: u64,
    pub(crate) source_revision: u64,
    pub(crate) charge_operator_revision: u64,
    pub(crate) spin_operator_revision: u64,
    pub(crate) static_descriptor_revision: u64,
    pub(crate) device_uuid: [u8; 16],
    pub(crate) device_ordinal: i32,
    pub(crate) build_digest: [u8; 32],
    pub(crate) static_descriptor_digest: [u8; 32],
    pub(crate) payload_sha256: [u8; 32],
    pub(crate) snapshot_digest: [u8; 32],
    pub(crate) spin_digest: [u8; 32],
    pub(crate) warm_start_digest: [u8; 32],
    pub(crate) snapshot_lineage_id: [u8; 16],
    pub(crate) operation_audit_digest: [u8; 32],
    pub(crate) payload: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GpuM1TransportError {
    InvalidDescriptor(String),
    AbiFailure {
        operation: &'static str,
        status: u32,
    },
    InvalidContextIdentity,
    MissingDeviceFeatures {
        requested: u64,
        available: u64,
    },
    ChargeDidNotConverge {
        reason: u32,
    },
    ChargeSnapshotRequired,
    SpinSnapshotRequired,
    ChargeSnapshotAlreadyAccepted,
    SnapshotIdentityMismatch {
        expected_device: DeviceIdentity,
        actual_device: DeviceIdentity,
    },
    SnapshotRevisionMismatch,
    SpinDidNotConverge {
        reason: u32,
    },
    SpinSnapshotDigestMismatch,
    CleanupFailures(Vec<(&'static str, u32)>),
    OperationAndCleanup {
        operation: Box<GpuM1TransportError>,
        cleanup: Box<GpuM1TransportError>,
    },
}

impl fmt::Display for GpuM1TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for GpuM1TransportError {}

pub(crate) trait GpuM1TransportAbi {
    fn create_context(
        &self,
        request: &fullmag_fdm_gpu_transport_context_create_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_context_create_result_v1, u32>;

    fn upload_static_descriptor(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        descriptor: &fullmag_fdm_gpu_transport_static_descriptor_v1,
    ) -> Result<(), u32>;

    fn solve_charge(
        &self,
        request: &fullmag_fdm_gpu_charge_solve_request_v1,
    ) -> Result<fullmag_fdm_gpu_charge_solve_result_v1, u32>;

    fn accept_charge_snapshot(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        provisional_generation: u64,
    ) -> Result<fullmag_fdm_gpu_charge_snapshot_info_v1, u32>;

    fn solve_steady_spin(
        &self,
        request: &fullmag_fdm_gpu_steady_spin_solve_request_v1,
    ) -> Result<fullmag_fdm_gpu_steady_spin_solve_result_v1, u32>;

    fn readback_artifact(
        &self,
        request: &fullmag_fdm_gpu_transport_artifact_request_v1,
    ) -> Result<(), u32>;

    fn checkpoint_query_size(
        &self,
        request: &fullmag_fdm_gpu_transport_checkpoint_size_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_checkpoint_size_result_v1, u32>;

    fn checkpoint_export(
        &self,
        request: &fullmag_fdm_gpu_transport_checkpoint_export_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_checkpoint_export_result_v1, u32>;

    fn checkpoint_import(
        &self,
        request: &fullmag_fdm_gpu_transport_checkpoint_import_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_checkpoint_restore_result_v1, u32>;

    fn destroy_snapshot(
        &self,
        snapshot: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    ) -> Result<(), u32>;

    fn destroy_context(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
    ) -> Result<(), u32>;
}

struct ContextGuard<'a, A: GpuM1TransportAbi> {
    abi: &'a A,
    handle: Option<fullmag_fdm_gpu_transport_context_handle_v1>,
}

impl<'a, A: GpuM1TransportAbi> ContextGuard<'a, A> {
    fn new(abi: &'a A, handle: fullmag_fdm_gpu_transport_context_handle_v1) -> Self {
        Self {
            abi,
            handle: Some(handle),
        }
    }

    fn close(&mut self) -> Result<(), GpuM1TransportError> {
        let Some(handle) = self.handle else {
            return Ok(());
        };
        match self.abi.destroy_context(handle) {
            Ok(()) => {
                self.handle = None;
                Ok(())
            }
            Err(status) => Err(GpuM1TransportError::CleanupFailures(vec![(
                "destroy_context",
                status,
            )])),
        }
    }

    fn error_with_cleanup(&mut self, primary: GpuM1TransportError) -> GpuM1TransportError {
        match self.close() {
            Ok(()) => primary,
            Err(cleanup) => GpuM1TransportError::OperationAndCleanup {
                operation: Box::new(primary),
                cleanup: Box::new(cleanup),
            },
        }
    }

    fn disarm(&mut self) {
        self.handle = None;
    }
}

impl<A: GpuM1TransportAbi> Drop for ContextGuard<'_, A> {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

pub(crate) struct GpuM1TransportSession<A: GpuM1TransportAbi> {
    abi: A,
    context_handle: Option<fullmag_fdm_gpu_transport_context_handle_v1>,
    device_identity: DeviceIdentity,
    source_revision: u64,
    static_descriptor_revision: u64,
    charge_operator_revision: u64,
    spin_operator_revision: u64,
    static_descriptor_digest: [u8; 32],
    charge_solver_policy: u32,
    charge_gauge_policy: u32,
    charge_relative_tolerance: f64,
    charge_max_iterations: u64,
    spin_solver_policy: u32,
    spin_relative_tolerance: f64,
    spin_max_iterations: u64,
    llg_binding_features: u64,
    grid: [u64; 3],
    cell_count: u64,
    accepted_snapshot: Option<AcceptedChargeSnapshot>,
    accepted_spin_sequence: Option<u64>,
}

impl<A: GpuM1TransportAbi> GpuM1TransportSession<A> {
    pub(crate) fn create(
        abi: A,
        mut prepared: PreparedGpuM1Descriptor,
    ) -> Result<Self, GpuM1TransportError> {
        let static_features = static_descriptor_features(&prepared.interfaces);
        prepared.context_request.requested_device_features |= static_features
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
        let required_features = prepared.context_request.requested_device_features;
        let charge_solver_policy = prepared.charge_solver_policy;
        let charge_gauge_policy = prepared.charge_gauge_policy;
        let charge_relative_tolerance = prepared.charge_relative_tolerance;
        let charge_max_iterations = prepared.charge_max_iterations;
        let spin_solver_policy = prepared.spin_solver_policy;
        let spin_relative_tolerance = prepared.spin_relative_tolerance;
        let spin_max_iterations = prepared.spin_max_iterations;
        let grid = prepared.static_descriptor.grid;
        let cell_count = prepared.cell_count;
        prepared.context_request.prefix = prefix_with_features::<
            fullmag_fdm_gpu_transport_context_create_request_v1,
        >(required_features);
        prepared.static_descriptor.prefix =
            prefix_with_features::<fullmag_fdm_gpu_transport_static_descriptor_v1>(static_features);
        let cell_view = host_record_view(&prepared.cells)?;
        let material_view = host_record_view(&prepared.materials)?;
        let interface_view = host_record_view(&prepared.interfaces)?;
        let charge_face_view = host_record_view(&prepared.charge_faces)?;
        let spin_face_view = host_record_view(&prepared.spin_faces)?;
        let formula_view = host_record_view(&prepared.formula_ids)?;
        prepared.static_descriptor.masks_view_ptr = (&cell_view as *const _) as u64;
        prepared.static_descriptor.materials_view_ptr = (&material_view as *const _) as u64;
        prepared.static_descriptor.interfaces_view_ptr = (&interface_view as *const _) as u64;
        prepared.static_descriptor.charge_faces_view_ptr = (&charge_face_view as *const _) as u64;
        prepared.static_descriptor.spin_faces_view_ptr = (&spin_face_view as *const _) as u64;
        prepared.static_descriptor.formula_ids_view_ptr = (&formula_view as *const _) as u64;
        let context_result = abi
            .create_context(&prepared.context_request)
            .map_err(|status| GpuM1TransportError::AbiFailure {
                operation: "context_create",
                status,
            })?;
        if context_handle_is_null(context_result.context_handle) {
            return Err(GpuM1TransportError::InvalidContextIdentity);
        }
        let mut context_guard = ContextGuard::new(&abi, context_result.context_handle);
        if context_result.supported_features & required_features != required_features {
            return Err(context_guard.error_with_cleanup(
                GpuM1TransportError::MissingDeviceFeatures {
                    requested: required_features,
                    available: context_result.supported_features,
                },
            ));
        }
        if let Err(status) =
            abi.upload_static_descriptor(context_result.context_handle, &prepared.static_descriptor)
        {
            return Err(
                context_guard.error_with_cleanup(GpuM1TransportError::AbiFailure {
                    operation: "static_descriptor_upload",
                    status,
                }),
            );
        }
        context_guard.disarm();
        drop(context_guard);
        Ok(Self {
            abi,
            context_handle: Some(context_result.context_handle),
            device_identity: DeviceIdentity {
                uuid: context_result.device_uuid,
                ordinal: prepared.context_request.device_ordinal,
                build_digest: context_result.build_digest,
            },
            source_revision: prepared.static_descriptor.source_revision,
            static_descriptor_revision: prepared.static_descriptor.descriptor_revision,
            charge_operator_revision: prepared.charge_operator_revision,
            spin_operator_revision: prepared.spin_operator_revision,
            static_descriptor_digest: prepared.static_descriptor.descriptor_digest,
            charge_solver_policy,
            charge_gauge_policy,
            charge_relative_tolerance,
            charge_max_iterations,
            spin_solver_policy,
            spin_relative_tolerance,
            spin_max_iterations,
            llg_binding_features: static_features,
            grid,
            cell_count,
            accepted_snapshot: None,
            accepted_spin_sequence: None,
        })
    }

    fn context_handle(&self) -> fullmag_fdm_gpu_transport_context_handle_v1 {
        self.context_handle
            .expect("a live GPU M1 session owns one context")
    }

    pub(crate) fn device_identity(&self) -> DeviceIdentity {
        self.device_identity
    }

    pub(crate) fn llg_binding(
        &self,
    ) -> Result<ffi::fullmag_fdm_gpu_transport_llg_binding_v1, GpuM1TransportError> {
        let snapshot = self
            .accepted_snapshot
            .as_ref()
            .ok_or(GpuM1TransportError::ChargeSnapshotRequired)?;
        Ok(ffi::fullmag_fdm_gpu_transport_llg_binding_v1 {
            prefix: prefix_with_features::<ffi::fullmag_fdm_gpu_transport_llg_binding_v1>(
                self.llg_binding_features,
            ),
            transport_context: self.context_handle(),
            charge_snapshot: snapshot.handle,
            accepted_sequence: snapshot.accepted_sequence,
            source_revision: self.source_revision,
            operator_revision: self.spin_operator_revision,
            relative_tolerance: self.spin_relative_tolerance,
            max_iterations: self.spin_max_iterations,
            reserved1: 0,
        })
    }

    pub(crate) fn solve_charge(
        &mut self,
        attempt_id: u64,
        stage_id: u64,
    ) -> Result<AcceptedChargeSnapshot, GpuM1TransportError> {
        if self.accepted_snapshot.is_some() {
            return Err(GpuM1TransportError::ChargeSnapshotAlreadyAccepted);
        }
        let request = fullmag_fdm_gpu_charge_solve_request_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_charge_solve_request_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE,
            ),
            context_handle: self.context_handle(),
            solver_policy: self.charge_solver_policy,
            gauge_policy: self.charge_gauge_policy,
            attempt_id,
            stage_id,
            source_revision: self.source_revision,
            static_revision: self.static_descriptor_revision,
            relative_tolerance: self.charge_relative_tolerance,
            max_iterations: self.charge_max_iterations,
        };
        let charge =
            self.abi
                .solve_charge(&request)
                .map_err(|status| GpuM1TransportError::AbiFailure {
                    operation: "solve_charge",
                    status,
                })?;
        if charge.reason != FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED {
            return Err(GpuM1TransportError::ChargeDidNotConverge {
                reason: charge.reason,
            });
        }
        let accepted = self
            .abi
            .accept_charge_snapshot(self.context_handle(), charge.provisional_generation)
            .map_err(|status| GpuM1TransportError::AbiFailure {
                operation: "accept_charge_snapshot",
                status,
            })?;
        if snapshot_handle_is_null(accepted.snapshot_handle) {
            return Err(GpuM1TransportError::InvalidContextIdentity);
        }
        let snapshot = AcceptedChargeSnapshot {
            handle: accepted.snapshot_handle,
            context_handle: accepted.context_handle,
            accepted_sequence: accepted.accepted_sequence,
            source_revision: accepted.source_revision,
            operator_revision: accepted.operator_revision,
            content_digest: accepted.snapshot_content_digest,
            device_identity: self.device_identity,
        };
        self.accepted_snapshot = Some(snapshot.clone());
        let validation_error =
            if !context_handles_match(accepted.context_handle, self.context_handle()) {
                Some(GpuM1TransportError::InvalidContextIdentity)
            } else if accepted.local_generation != charge.provisional_generation
                || accepted.source_revision != self.source_revision
                || accepted.operator_revision != self.charge_operator_revision
            {
                Some(GpuM1TransportError::SnapshotRevisionMismatch)
            } else {
                None
            };
        if let Some(error) = validation_error {
            return match self.destroy_accepted_snapshot() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(GpuM1TransportError::OperationAndCleanup {
                    operation: Box::new(error),
                    cleanup: Box::new(cleanup),
                }),
            };
        }
        Ok(snapshot)
    }

    pub(crate) fn solve_spin_static(
        &mut self,
        snapshot: Option<&AcceptedChargeSnapshot>,
        mut views: DeviceVectorViews,
        attempt_id: u64,
        stage_id: u64,
    ) -> Result<AcceptedSpinSnapshot, GpuM1TransportError> {
        let snapshot = snapshot.ok_or(GpuM1TransportError::ChargeSnapshotRequired)?;
        let accepted = self
            .accepted_snapshot
            .as_ref()
            .ok_or(GpuM1TransportError::ChargeSnapshotRequired)?;
        if views.device_identity != self.device_identity
            || snapshot.device_identity != self.device_identity
        {
            return Err(GpuM1TransportError::SnapshotIdentityMismatch {
                expected_device: self.device_identity,
                actual_device: snapshot.device_identity,
            });
        }
        if !context_handles_match(snapshot.context_handle, self.context_handle())
            || !snapshot_handles_match(snapshot.handle, accepted.handle)
            || snapshot.accepted_sequence != accepted.accepted_sequence
            || snapshot.source_revision != self.source_revision
            || snapshot.operator_revision != self.charge_operator_revision
        {
            return Err(GpuM1TransportError::SnapshotRevisionMismatch);
        }
        validate_device_vector_view(
            &views.magnetization,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY,
            self.cell_count,
        )?;
        validate_device_vector_view(
            &views.torque,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY,
            self.cell_count,
        )?;
        validate_disjoint_device_vector_views(&views.magnetization, &views.torque)?;
        views.magnetization.prefix = prefix::<fullmag_fdm_gpu_transport_buffer_view_v1>();
        views.torque.prefix = prefix::<fullmag_fdm_gpu_transport_buffer_view_v1>();
        let request = fullmag_fdm_gpu_steady_spin_solve_request_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_steady_spin_solve_request_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN,
            ),
            context_handle: self.context_handle(),
            snapshot_handle: snapshot.handle,
            accepted_sequence: snapshot.accepted_sequence,
            m_stage_view_ptr: (&views.magnetization as *const _) as u64,
            torque_view_ptr: (&views.torque as *const _) as u64,
            solver_policy: self.spin_solver_policy,
            reserved1: 0,
            attempt_id,
            stage_id,
            source_revision: self.source_revision,
            operator_revision: self.spin_operator_revision,
            relative_tolerance: self.spin_relative_tolerance,
            max_iterations: self.spin_max_iterations,
        };
        let spin = self.abi.solve_steady_spin(&request).map_err(|status| {
            GpuM1TransportError::AbiFailure {
                operation: "solve_steady_spin",
                status,
            }
        })?;
        if spin.reason != FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED {
            return Err(GpuM1TransportError::SpinDidNotConverge {
                reason: spin.reason,
            });
        }
        if spin.snapshot_content_digest != snapshot.content_digest {
            return Err(GpuM1TransportError::SpinSnapshotDigestMismatch);
        }
        let accepted_spin = AcceptedSpinSnapshot {
            accepted_sequence: snapshot.accepted_sequence,
            source_revision: snapshot.source_revision,
            operator_revision: self.spin_operator_revision,
            snapshot_content_digest: spin.snapshot_content_digest,
            deterministic_compute_digest: spin.deterministic_compute_digest,
            device_identity: self.device_identity,
        };
        self.accepted_spin_sequence = Some(snapshot.accepted_sequence);
        Ok(accepted_spin)
    }

    fn readback_accepted_field(
        &self,
        snapshot: &AcceptedChargeSnapshot,
        field_id: u32,
        component_order: u32,
        values: &mut [f64],
    ) -> Result<(), GpuM1TransportError> {
        let destination = host_write_f64_view(values, component_order)?;
        let request = fullmag_fdm_gpu_transport_artifact_request_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_transport_artifact_request_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                    | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK,
            ),
            context_handle: self.context_handle(),
            snapshot_handle: snapshot.handle,
            field_id,
            cadence: ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_ACCEPTED_STEP,
            range_begin: 0,
            range_count: values.len() as u64,
            destination_view_ptr: (&destination as *const _) as u64,
            expected_bytes: destination.byte_length,
            accepted_sequence: snapshot.accepted_sequence,
        };
        self.abi
            .readback_artifact(&request)
            .map_err(|status| GpuM1TransportError::AbiFailure {
                operation: "readback_artifact",
                status,
            })
    }

    pub(crate) fn readback_accepted_artifacts(
        &self,
    ) -> Result<AcceptedGpuM1TransportArtifacts, GpuM1TransportError> {
        let snapshot = self
            .accepted_snapshot
            .as_ref()
            .ok_or(GpuM1TransportError::ChargeSnapshotRequired)?;
        self.accepted_spin_sequence
            .filter(|sequence| *sequence == snapshot.accepted_sequence)
            .ok_or(GpuM1TransportError::SpinSnapshotRequired)?;

        let cell_count = usize::try_from(self.cell_count)
            .map_err(|_| invalid("GPU M1 artifact cell count overflows usize"))?;
        let face_counts = face_component_counts(self.grid)?;
        let charge_count = face_counts.iter().try_fold(0_usize, |total, count| {
            total
                .checked_add(*count)
                .ok_or_else(|| invalid("GPU M1 charge artifact count overflows usize"))
        })?;
        let spin_vector_count = cell_count
            .checked_mul(3)
            .ok_or_else(|| invalid("GPU M1 spin vector artifact count overflows usize"))?;
        let q_count = charge_count
            .checked_mul(3)
            .ok_or_else(|| invalid("GPU M1 spin-current artifact count overflows usize"))?;

        let mut potential_v = vec![0.0; cell_count];
        let mut charge_current = vec![0.0; charge_count];
        let mut spin_accumulation = vec![0.0; spin_vector_count];
        let mut spin_current = vec![0.0; q_count];
        let mut torque = vec![0.0; spin_vector_count];
        self.readback_accepted_field(
            snapshot,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
            &mut potential_v,
        )?;
        self.readback_accepted_field(
            snapshot,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ,
            &mut charge_current,
        )?;
        self.readback_accepted_field(
            snapshot,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ,
            &mut spin_accumulation,
        )?;
        self.readback_accepted_field(
            snapshot,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ,
            &mut spin_current,
        )?;
        self.readback_accepted_field(
            snapshot,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ,
            &mut torque,
        )?;

        let [x_faces, y_faces, z_faces] = face_counts;
        let charge_current_j_c = [
            charge_current[..x_faces].to_vec(),
            charge_current[x_faces..x_faces + y_faces].to_vec(),
            charge_current[x_faces + y_faces..x_faces + y_faces + z_faces].to_vec(),
        ];
        let spin_accumulation_mu_s = [
            spin_accumulation[..cell_count].to_vec(),
            spin_accumulation[cell_count..2 * cell_count].to_vec(),
            spin_accumulation[2 * cell_count..].to_vec(),
        ];
        let torque_stt = [
            torque[..cell_count].to_vec(),
            torque[cell_count..2 * cell_count].to_vec(),
            torque[2 * cell_count..].to_vec(),
        ];
        let mut q_offset = 0;
        let spin_current_q_ia = std::array::from_fn(|axis| {
            let component_count = face_counts[axis];
            let axis_end = q_offset + 3 * component_count;
            let components = [
                spin_current[q_offset..q_offset + component_count].to_vec(),
                spin_current[q_offset + component_count..q_offset + 2 * component_count].to_vec(),
                spin_current[q_offset + 2 * component_count..axis_end].to_vec(),
            ];
            q_offset = axis_end;
            components
        });

        Ok(AcceptedGpuM1TransportArtifacts {
            potential_v,
            charge_current_j_c,
            spin_accumulation_mu_s,
            spin_current_q_ia,
            torque_stt,
        })
    }

    pub(crate) fn export_stage_checkpoint(
        &self,
        accepted_step: u64,
    ) -> Result<TransportStageCheckpointV1, GpuM1TransportError> {
        let snapshot = self
            .accepted_snapshot
            .as_ref()
            .ok_or(GpuM1TransportError::ChargeSnapshotRequired)?;
        let spin_accepted_sequence = self
            .accepted_spin_sequence
            .filter(|sequence| *sequence == snapshot.accepted_sequence)
            .ok_or(GpuM1TransportError::SpinSnapshotRequired)?;
        let size_request = fullmag_fdm_gpu_transport_checkpoint_size_request_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_transport_checkpoint_size_request_v1>(
                BASE_CHECKPOINT_FEATURES,
            ),
            context_handle: self.context_handle(),
            snapshot_handle: snapshot.handle,
            accepted_sequence: snapshot.accepted_sequence,
            schema_version: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1,
            inclusion_mask: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_ALL_V1,
            static_descriptor_digest: self.static_descriptor_digest,
        };
        let size = self
            .abi
            .checkpoint_query_size(&size_request)
            .map_err(|status| GpuM1TransportError::AbiFailure {
                operation: "checkpoint_query_size",
                status,
            })?;
        if size.schema_version != ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1
            || size.inclusion_mask != ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_ALL_V1
            || size.snapshot_content_digest != snapshot.content_digest
            || size.section_count != 20
            || size.alignment != 64
            || size.required_bytes == 0
        {
            return Err(GpuM1TransportError::SnapshotRevisionMismatch);
        }
        let maximum_checkpoint_bytes = self
            .cell_count
            .checked_mul(CHECKPOINT_HOST_BYTES_PER_CELL_LIMIT)
            .and_then(|bytes| bytes.checked_add(CHECKPOINT_HOST_FIXED_BYTES_LIMIT))
            .ok_or_else(|| invalid("GPU M1 checkpoint capacity calculation overflowed"))?;
        if size.required_bytes > maximum_checkpoint_bytes {
            return Err(invalid(format!(
                "GPU M1 checkpoint requires {} bytes but the descriptor-derived limit is {} bytes",
                size.required_bytes, maximum_checkpoint_bytes
            )));
        }
        let payload_len = usize::try_from(size.required_bytes)
            .map_err(|_| invalid("GPU M1 checkpoint size exceeds host address space"))?;
        let mut payload = Vec::new();
        payload
            .try_reserve_exact(payload_len)
            .map_err(|_| invalid("GPU M1 checkpoint allocation failed"))?;
        payload.resize(payload_len, 0);
        let destination = fullmag_fdm_gpu_transport_buffer_view_v1 {
            prefix: prefix::<fullmag_fdm_gpu_transport_buffer_view_v1>(),
            address: payload.as_mut_ptr() as u64,
            element_count: size.required_bytes,
            byte_stride: 1,
            byte_length: size.required_bytes,
            element_type: ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
            pointer_space: ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY,
            component_order: ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
            reserved1: 0,
        };
        let request = fullmag_fdm_gpu_transport_checkpoint_export_request_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_transport_checkpoint_export_request_v1>(
                BASE_CHECKPOINT_FEATURES,
            ),
            context_handle: self.context_handle(),
            snapshot_handle: snapshot.handle,
            accepted_sequence: snapshot.accepted_sequence,
            cadence_id: accepted_step,
            destination_view_ptr: (&destination as *const _) as u64,
            exact_capacity: size.required_bytes,
            expected_size: size.required_bytes,
            inclusion_mask: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_ALL_V1,
            reserved1: 0,
        };
        let exported = self.abi.checkpoint_export(&request).map_err(|status| {
            GpuM1TransportError::AbiFailure {
                operation: "checkpoint_export",
                status,
            }
        })?;
        if exported.committed_bytes != size.required_bytes
            || exported.accepted_sequence != snapshot.accepted_sequence
            || exported.snapshot_digest != snapshot.content_digest
            || Sha256::digest(&payload).as_slice() != exported.payload_sha256
        {
            return Err(GpuM1TransportError::SnapshotRevisionMismatch);
        }
        Ok(TransportStageCheckpointV1 {
            schema: "fullmag.fdm.transport_stage_checkpoint.v1".into(),
            accepted_step,
            charge_sequence: snapshot.accepted_sequence,
            spin_accepted_sequence,
            source_revision: self.source_revision,
            charge_operator_revision: self.charge_operator_revision,
            spin_operator_revision: self.spin_operator_revision,
            static_descriptor_revision: self.static_descriptor_revision,
            device_uuid: self.device_identity.uuid,
            device_ordinal: self.device_identity.ordinal,
            build_digest: self.device_identity.build_digest,
            static_descriptor_digest: self.static_descriptor_digest,
            payload_sha256: exported.payload_sha256,
            snapshot_digest: exported.snapshot_digest,
            spin_digest: exported.spin_digest,
            warm_start_digest: exported.warm_start_digest,
            snapshot_lineage_id: exported.snapshot_lineage_id,
            operation_audit_digest: exported.operation_audit_digest,
            payload,
        })
    }

    pub(crate) fn restore_stage_checkpoint(
        &mut self,
        checkpoint: &TransportStageCheckpointV1,
    ) -> Result<AcceptedChargeSnapshot, GpuM1TransportError> {
        if self.accepted_snapshot.is_some() {
            return Err(GpuM1TransportError::ChargeSnapshotAlreadyAccepted);
        }
        let maximum_checkpoint_bytes = self
            .cell_count
            .checked_mul(CHECKPOINT_HOST_BYTES_PER_CELL_LIMIT)
            .and_then(|bytes| bytes.checked_add(CHECKPOINT_HOST_FIXED_BYTES_LIMIT))
            .ok_or_else(|| invalid("GPU M1 checkpoint capacity calculation overflowed"))?;
        let payload_bytes = u64::try_from(checkpoint.payload.len())
            .map_err(|_| invalid("GPU M1 checkpoint payload exceeds u64"))?;
        let payload_digest: [u8; 32] = Sha256::digest(&checkpoint.payload).into();
        if checkpoint.schema != "fullmag.fdm.transport_stage_checkpoint.v1"
            || checkpoint.charge_sequence == 0
            || checkpoint.charge_sequence != checkpoint.spin_accepted_sequence
            || checkpoint.source_revision != self.source_revision
            || checkpoint.charge_operator_revision != self.charge_operator_revision
            || checkpoint.spin_operator_revision != self.spin_operator_revision
            || checkpoint.static_descriptor_revision != self.static_descriptor_revision
            || checkpoint.device_uuid != self.device_identity.uuid
            || checkpoint.device_ordinal != self.device_identity.ordinal
            || checkpoint.build_digest != self.device_identity.build_digest
            || checkpoint.static_descriptor_digest != self.static_descriptor_digest
            || payload_bytes == 0
            || payload_bytes > maximum_checkpoint_bytes
            || payload_digest != checkpoint.payload_sha256
        {
            return Err(GpuM1TransportError::SnapshotRevisionMismatch);
        }
        let source = fullmag_fdm_gpu_transport_buffer_view_v1 {
            prefix: prefix::<fullmag_fdm_gpu_transport_buffer_view_v1>(),
            address: checkpoint.payload.as_ptr() as u64,
            element_count: payload_bytes,
            byte_stride: 1,
            byte_length: payload_bytes,
            element_type: ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
            pointer_space: ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY,
            component_order: ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
            reserved1: 0,
        };
        let request = fullmag_fdm_gpu_transport_checkpoint_import_request_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_transport_checkpoint_import_request_v1>(
                BASE_CHECKPOINT_FEATURES,
            ),
            context_handle: self.context_handle(),
            source_view_ptr: (&source as *const _) as u64,
            expected_payload_sha256: checkpoint.payload_sha256,
            device_uuid: checkpoint.device_uuid,
            build_digest: checkpoint.build_digest,
            static_descriptor_digest: checkpoint.static_descriptor_digest,
            restore_policy:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD,
            reserved1: 0,
            expected_bytes: payload_bytes,
            audit_parent_digest: checkpoint.operation_audit_digest,
        };
        let restored = self.abi.checkpoint_import(&request).map_err(|status| {
            GpuM1TransportError::AbiFailure {
                operation: "checkpoint_import",
                status,
            }
        })?;
        let validation_error = if snapshot_handle_is_null(restored.snapshot_handle) {
            Some(GpuM1TransportError::InvalidContextIdentity)
        } else if restored.restored_state
            != ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_SPIN_ACCEPTED
            || restored.accepted_sequence != checkpoint.charge_sequence
            || restored.snapshot_lineage_id != checkpoint.snapshot_lineage_id
            || restored.snapshot_content_digest != checkpoint.snapshot_digest
            || restored.spin_digest != checkpoint.spin_digest
            || restored.warm_start_digest != checkpoint.warm_start_digest
        {
            Some(GpuM1TransportError::SnapshotRevisionMismatch)
        } else {
            None
        };
        if let Some(error) = validation_error {
            if snapshot_handle_is_null(restored.snapshot_handle) {
                return Err(error);
            }
            return match self.abi.destroy_snapshot(restored.snapshot_handle) {
                Ok(()) => Err(error),
                Err(status) => Err(GpuM1TransportError::OperationAndCleanup {
                    operation: Box::new(error),
                    cleanup: Box::new(GpuM1TransportError::CleanupFailures(vec![(
                        "destroy_snapshot",
                        status,
                    )])),
                }),
            };
        }
        let snapshot = AcceptedChargeSnapshot {
            handle: restored.snapshot_handle,
            context_handle: self.context_handle(),
            accepted_sequence: restored.accepted_sequence,
            source_revision: self.source_revision,
            operator_revision: self.charge_operator_revision,
            content_digest: restored.snapshot_content_digest,
            device_identity: self.device_identity,
        };
        self.accepted_snapshot = Some(snapshot.clone());
        self.accepted_spin_sequence = Some(restored.accepted_sequence);
        Ok(snapshot)
    }

    fn destroy_accepted_snapshot(&mut self) -> Result<(), GpuM1TransportError> {
        let Some(snapshot) = self.accepted_snapshot.as_ref() else {
            return Ok(());
        };
        match self.abi.destroy_snapshot(snapshot.handle) {
            Ok(()) => {
                self.accepted_snapshot = None;
                self.accepted_spin_sequence = None;
                Ok(())
            }
            Err(status) => Err(GpuM1TransportError::CleanupFailures(vec![(
                "destroy_snapshot",
                status,
            )])),
        }
    }

    fn cleanup(&mut self) -> Result<(), GpuM1TransportError> {
        self.destroy_accepted_snapshot()?;
        let Some(context) = self.context_handle else {
            return Ok(());
        };
        match self.abi.destroy_context(context) {
            Ok(()) => {
                self.context_handle = None;
                Ok(())
            }
            Err(status) => Err(GpuM1TransportError::CleanupFailures(vec![(
                "destroy_context",
                status,
            )])),
        }
    }

    pub(crate) fn close(&mut self) -> Result<(), GpuM1TransportError> {
        self.cleanup()
    }
}

impl<A: GpuM1TransportAbi> Drop for GpuM1TransportSession<A> {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn operation_error_with_cleanup<A: GpuM1TransportAbi>(
    session: &mut GpuM1TransportSession<A>,
    operation: GpuM1TransportError,
) -> GpuM1TransportError {
    match session.close() {
        Ok(()) => operation,
        Err(cleanup) => GpuM1TransportError::OperationAndCleanup {
            operation: Box::new(operation),
            cleanup: Box::new(cleanup),
        },
    }
}

pub(crate) fn execute_static_gpu_m1_with_abi<A, F>(
    abi: A,
    prepared: PreparedGpuM1Descriptor,
    attempt_id: u64,
    stage_id: u64,
    make_views: F,
) -> Result<AcceptedGpuM1Publication, GpuM1TransportError>
where
    A: GpuM1TransportAbi,
    F: FnOnce(DeviceIdentity) -> DeviceVectorViews,
{
    let static_descriptor_revision = prepared.static_descriptor.descriptor_revision;
    let spin_operator_revision = prepared.spin_operator_revision;
    let mut session = GpuM1TransportSession::create(abi, prepared)?;
    let charge = match session.solve_charge(attempt_id, stage_id) {
        Ok(charge) => charge,
        Err(operation) => return Err(operation_error_with_cleanup(&mut session, operation)),
    };
    let views = make_views(session.device_identity());
    let spin = match session.solve_spin_static(Some(&charge), views, attempt_id, stage_id) {
        Ok(spin) => spin,
        Err(operation) => return Err(operation_error_with_cleanup(&mut session, operation)),
    };
    let publication = AcceptedGpuM1Publication {
        accepted_sequence: charge.accepted_sequence,
        source_revision: charge.source_revision,
        charge_operator_revision: charge.operator_revision,
        static_descriptor_revision,
        spin_operator_revision,
        device_identity: spin.device_identity,
        charge_snapshot_content_digest: charge.content_digest,
        spin_deterministic_compute_digest: spin.deterministic_compute_digest,
    };
    session.close()?;
    Ok(publication)
}

#[cfg(feature = "cuda")]
pub(crate) struct NativeGpuM1TransportAbi;

#[cfg(feature = "cuda")]
impl GpuM1TransportAbi for NativeGpuM1TransportAbi {
    fn create_context(
        &self,
        request: &fullmag_fdm_gpu_transport_context_create_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_context_create_result_v1, u32> {
        let mut result = fullmag_fdm_gpu_transport_context_create_result_v1 {
            prefix: prefix::<fullmag_fdm_gpu_transport_context_create_result_v1>(),
            ..Default::default()
        };
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_transport_context_create_v1(
                request,
                &mut result,
            )
        };
        (status == 0).then_some(result).ok_or(status)
    }

    fn upload_static_descriptor(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        descriptor: &fullmag_fdm_gpu_transport_static_descriptor_v1,
    ) -> Result<(), u32> {
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                context, descriptor,
            )
        };
        (status == 0).then_some(()).ok_or(status)
    }

    fn solve_charge(
        &self,
        request: &fullmag_fdm_gpu_charge_solve_request_v1,
    ) -> Result<fullmag_fdm_gpu_charge_solve_result_v1, u32> {
        let mut result = fullmag_fdm_gpu_charge_solve_result_v1 {
            prefix: prefix::<fullmag_fdm_gpu_charge_solve_result_v1>(),
            ..Default::default()
        };
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_transport_solve_charge_v1(
                request,
                &mut result,
            )
        };
        (status == 0).then_some(result).ok_or(status)
    }

    fn accept_charge_snapshot(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        provisional_generation: u64,
    ) -> Result<fullmag_fdm_gpu_charge_snapshot_info_v1, u32> {
        let mut result = fullmag_fdm_gpu_charge_snapshot_info_v1 {
            prefix: prefix::<fullmag_fdm_gpu_charge_snapshot_info_v1>(),
            ..Default::default()
        };
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                context,
                provisional_generation,
                &mut result,
            )
        };
        (status == 0).then_some(result).ok_or(status)
    }

    fn solve_steady_spin(
        &self,
        request: &fullmag_fdm_gpu_steady_spin_solve_request_v1,
    ) -> Result<fullmag_fdm_gpu_steady_spin_solve_result_v1, u32> {
        let mut result = fullmag_fdm_gpu_steady_spin_solve_result_v1 {
            prefix: prefix::<fullmag_fdm_gpu_steady_spin_solve_result_v1>(),
            ..Default::default()
        };
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_transport_solve_steady_spin_v1(
                request,
                &mut result,
            )
        };
        (status == 0).then_some(result).ok_or(status)
    }

    fn readback_artifact(
        &self,
        request: &fullmag_fdm_gpu_transport_artifact_request_v1,
    ) -> Result<(), u32> {
        let status = unsafe { ffi::fullmag_fdm_gpu_transport_readback_artifact_v1(request) };
        (status == 0).then_some(()).ok_or(status)
    }

    fn checkpoint_query_size(
        &self,
        request: &fullmag_fdm_gpu_transport_checkpoint_size_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_checkpoint_size_result_v1, u32> {
        let mut result = fullmag_fdm_gpu_transport_checkpoint_size_result_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_transport_checkpoint_size_result_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1,
            ),
            ..Default::default()
        };
        let status = unsafe {
            ffi::fullmag_fdm_gpu_transport_checkpoint_query_size_v1(request, &mut result)
        };
        (status == 0).then_some(result).ok_or(status)
    }

    fn checkpoint_export(
        &self,
        request: &fullmag_fdm_gpu_transport_checkpoint_export_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_checkpoint_export_result_v1, u32> {
        let mut result = fullmag_fdm_gpu_transport_checkpoint_export_result_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_transport_checkpoint_export_result_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1,
            ),
            ..Default::default()
        };
        let status =
            unsafe { ffi::fullmag_fdm_gpu_transport_checkpoint_export_v1(request, &mut result) };
        (status == 0).then_some(result).ok_or(status)
    }

    fn checkpoint_import(
        &self,
        request: &fullmag_fdm_gpu_transport_checkpoint_import_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_checkpoint_restore_result_v1, u32> {
        let mut result = fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 {
            prefix: prefix_with_features::<fullmag_fdm_gpu_transport_checkpoint_restore_result_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1,
            ),
            ..Default::default()
        };
        let status =
            unsafe { ffi::fullmag_fdm_gpu_transport_checkpoint_import_v1(request, &mut result) };
        (status == 0).then_some(result).ok_or(status)
    }

    fn destroy_snapshot(
        &self,
        snapshot: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    ) -> Result<(), u32> {
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_charge_snapshot_destroy_v1(
                snapshot,
            )
        };
        (status == 0).then_some(()).ok_or(status)
    }

    fn destroy_context(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
    ) -> Result<(), u32> {
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_transport_context_destroy_v1(
                context,
            )
        };
        (status == 0).then_some(()).ok_or(status)
    }
}
