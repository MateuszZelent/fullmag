use super::spin_transport::{
    execute_static_gpu_m1_with_abi, DeviceIdentity, DeviceVectorViews, GpuM1TransportAbi,
    GpuM1TransportError, GpuM1TransportSession, PreparedGpuM1Descriptor,
};
use fullmag_fdm_sys::gpu_transport_abi_v1 as ffi;
use fullmag_fdm_sys::gpu_transport_abi_v1::{
    fullmag_fdm_gpu_charge_snapshot_handle_v1, fullmag_fdm_gpu_charge_snapshot_info_v1,
    fullmag_fdm_gpu_charge_solve_request_v1, fullmag_fdm_gpu_charge_solve_result_v1,
    fullmag_fdm_gpu_steady_spin_solve_request_v1, fullmag_fdm_gpu_steady_spin_solve_result_v1,
    fullmag_fdm_gpu_transport_artifact_request_v1,
    fullmag_fdm_gpu_transport_buffer_view_v1, fullmag_fdm_gpu_transport_context_create_request_v1,
    fullmag_fdm_gpu_transport_context_create_result_v1,
    fullmag_fdm_gpu_transport_context_handle_v1, fullmag_fdm_gpu_transport_static_descriptor_v1,
    FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
};
use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionDevice, ExecutionMode, ExecutionPrecision, ProblemIR,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::mem::size_of;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct CapturedPayload {
    cells_view: fullmag_fdm_gpu_transport_buffer_view_v1,
    materials_view: fullmag_fdm_gpu_transport_buffer_view_v1,
    interfaces_view: fullmag_fdm_gpu_transport_buffer_view_v1,
    charge_faces_view: fullmag_fdm_gpu_transport_buffer_view_v1,
    spin_faces_view: fullmag_fdm_gpu_transport_buffer_view_v1,
    formula_ids_view: fullmag_fdm_gpu_transport_buffer_view_v1,
    first_cell: ffi::fullmag_fdm_gpu_transport_spin_cell_v1,
    first_material: ffi::fullmag_fdm_gpu_transport_spin_material_v1,
    first_interface: ffi::fullmag_fdm_gpu_transport_spin_interface_v1,
    first_charge_face: ffi::fullmag_fdm_gpu_transport_charge_face_v1,
    first_spin_face: ffi::fullmag_fdm_gpu_transport_spin_boundary_face_v1,
    formula_ids: ffi::fullmag_fdm_gpu_transport_formula_ids_v1,
    interfaces: Vec<ffi::fullmag_fdm_gpu_transport_spin_interface_v1>,
    spin_faces: Vec<ffi::fullmag_fdm_gpu_transport_spin_boundary_face_v1>,
}

#[derive(Default)]
struct FakeState {
    calls: Vec<&'static str>,
    create_request: Option<fullmag_fdm_gpu_transport_context_create_request_v1>,
    descriptor: Option<fullmag_fdm_gpu_transport_static_descriptor_v1>,
    payload: Option<CapturedPayload>,
    charge_request: Option<fullmag_fdm_gpu_charge_solve_request_v1>,
    spin_request: Option<fullmag_fdm_gpu_steady_spin_solve_request_v1>,
    artifact_requests: Vec<fullmag_fdm_gpu_transport_artifact_request_v1>,
    artifact_component_orders: Vec<u32>,
    fail_destroy_snapshot: Option<u32>,
    fail_destroy_context: Option<u32>,
    fail_upload: Option<u32>,
    fail_steady_spin: Option<u32>,
    supported_features: Option<u64>,
    corrupt_accepted_source_revision: bool,
    checkpoint_size_override: Option<ffi::fullmag_fdm_gpu_transport_checkpoint_size_result_v1>,
}

#[derive(Clone, Default)]
struct FakeAbi {
    state: Arc<Mutex<FakeState>>,
}

impl FakeAbi {
    fn calls(&self) -> Vec<&'static str> {
        self.state.lock().expect("fake ABI state").calls.clone()
    }

    fn record(&self, call: &'static str) {
        self.state.lock().expect("fake ABI state").calls.push(call);
    }

    fn with_destroy_failures(snapshot: Option<u32>, context: Option<u32>) -> Self {
        let abi = Self::default();
        {
            let mut state = abi.state.lock().expect("fake ABI state");
            state.fail_destroy_snapshot = snapshot;
            state.fail_destroy_context = context;
        }
        abi
    }

    fn fail_steady_spin(&self, status: u32) {
        self.state.lock().expect("fake ABI state").fail_steady_spin = Some(status);
    }

    fn fail_upload(&self, status: u32) {
        self.state.lock().expect("fake ABI state").fail_upload = Some(status);
    }

    fn support_only(&self, features: u64) {
        self.state
            .lock()
            .expect("fake ABI state")
            .supported_features = Some(features);
    }

    fn corrupt_accepted_source_revision(&self) {
        self.state
            .lock()
            .expect("fake ABI state")
            .corrupt_accepted_source_revision = true;
    }

    fn override_checkpoint_size(
        &self,
        result: ffi::fullmag_fdm_gpu_transport_checkpoint_size_result_v1,
    ) {
        self.state
            .lock()
            .expect("fake ABI state")
            .checkpoint_size_override = Some(result);
    }

    fn create_request(&self) -> fullmag_fdm_gpu_transport_context_create_request_v1 {
        self.state
            .lock()
            .expect("fake ABI state")
            .create_request
            .expect("captured context request")
    }

    fn payload(&self) -> CapturedPayload {
        self.state
            .lock()
            .expect("fake ABI state")
            .payload
            .clone()
            .expect("captured descriptor payload")
    }

    fn descriptor(&self) -> fullmag_fdm_gpu_transport_static_descriptor_v1 {
        self.state
            .lock()
            .expect("fake ABI state")
            .descriptor
            .expect("captured descriptor")
    }

    fn charge_request(&self) -> fullmag_fdm_gpu_charge_solve_request_v1 {
        self.state
            .lock()
            .expect("fake ABI state")
            .charge_request
            .expect("captured charge request")
    }

    fn spin_request(&self) -> fullmag_fdm_gpu_steady_spin_solve_request_v1 {
        self.state
            .lock()
            .expect("fake ABI state")
            .spin_request
            .expect("captured spin request")
    }

    fn artifact_requests(&self) -> Vec<fullmag_fdm_gpu_transport_artifact_request_v1> {
        self.state
            .lock()
            .expect("fake ABI state")
            .artifact_requests
            .clone()
    }

    fn artifact_component_orders(&self) -> Vec<u32> {
        self.state
            .lock()
            .expect("fake ABI state")
            .artifact_component_orders
            .clone()
    }
}

fn context_handle(slot: u64) -> fullmag_fdm_gpu_transport_context_handle_v1 {
    fullmag_fdm_gpu_transport_context_handle_v1 {
        registry_cookie: 11,
        slot,
        generation: 1,
        type_tag: 22,
    }
}

fn snapshot_handle(slot: u64) -> fullmag_fdm_gpu_charge_snapshot_handle_v1 {
    fullmag_fdm_gpu_charge_snapshot_handle_v1 {
        registry_cookie: 33,
        slot,
        generation: 1,
        type_tag: 44,
    }
}

unsafe fn copied_view(pointer: u64) -> fullmag_fdm_gpu_transport_buffer_view_v1 {
    assert_ne!(pointer, 0);
    // SAFETY: the production adapter keeps every stack view alive for the
    // duration of this synchronous fake upload call.
    unsafe { *(pointer as *const fullmag_fdm_gpu_transport_buffer_view_v1) }
}

unsafe fn first_record<T: Copy + Default>(view: fullmag_fdm_gpu_transport_buffer_view_v1) -> T {
    if view.element_count == 0 {
        assert_eq!(view.address, 0);
        return T::default();
    }
    assert_ne!(view.address, 0);
    assert_eq!(view.byte_stride, size_of::<T>() as u64);
    // SAFETY: the view points into a typed Vec retained by PreparedGpuM1Descriptor
    // for the complete synchronous upload call.
    unsafe { *(view.address as *const T) }
}

unsafe fn copied_records<T: Copy>(view: fullmag_fdm_gpu_transport_buffer_view_v1) -> Vec<T> {
    if view.element_count == 0 {
        assert_eq!(view.address, 0);
        return Vec::new();
    }
    assert_ne!(view.address, 0);
    assert_eq!(view.byte_stride, size_of::<T>() as u64);
    let count = usize::try_from(view.element_count).expect("test payload count must fit usize");
    // SAFETY: the view points into a typed Vec retained by PreparedGpuM1Descriptor
    // for the complete synchronous upload call.
    unsafe { std::slice::from_raw_parts(view.address as *const T, count).to_vec() }
}

impl GpuM1TransportAbi for FakeAbi {
    fn create_context(
        &self,
        request: &fullmag_fdm_gpu_transport_context_create_request_v1,
    ) -> Result<fullmag_fdm_gpu_transport_context_create_result_v1, u32> {
        self.record("create");
        let mut state = self.state.lock().expect("fake ABI state");
        state.create_request = Some(*request);
        let supported_features = state.supported_features.unwrap_or(u64::MAX);
        drop(state);
        Ok(fullmag_fdm_gpu_transport_context_create_result_v1 {
            context_handle: context_handle(7),
            device_uuid: [5; 16],
            build_digest: [6; 32],
            supported_features,
            ..Default::default()
        })
    }

    fn upload_static_descriptor(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        descriptor: &fullmag_fdm_gpu_transport_static_descriptor_v1,
    ) -> Result<(), u32> {
        self.record("upload");
        assert_eq!(context.slot, 7);
        if let Some(status) = self
            .state
            .lock()
            .expect("fake ABI state")
            .fail_upload
            .take()
        {
            return Err(status);
        }
        let cells_view = unsafe { copied_view(descriptor.masks_view_ptr) };
        let materials_view = unsafe { copied_view(descriptor.materials_view_ptr) };
        let interfaces_view = unsafe { copied_view(descriptor.interfaces_view_ptr) };
        let charge_faces_view = unsafe { copied_view(descriptor.charge_faces_view_ptr) };
        let spin_faces_view = unsafe { copied_view(descriptor.spin_faces_view_ptr) };
        let formula_ids_view = unsafe { copied_view(descriptor.formula_ids_view_ptr) };
        let payload = CapturedPayload {
            cells_view,
            materials_view,
            interfaces_view,
            charge_faces_view,
            spin_faces_view,
            formula_ids_view,
            first_cell: unsafe { first_record(cells_view) },
            first_material: unsafe { first_record(materials_view) },
            first_interface: unsafe { first_record(interfaces_view) },
            first_charge_face: unsafe { first_record(charge_faces_view) },
            first_spin_face: unsafe { first_record(spin_faces_view) },
            formula_ids: unsafe { first_record(formula_ids_view) },
            interfaces: unsafe { copied_records(interfaces_view) },
            spin_faces: unsafe { copied_records(spin_faces_view) },
        };
        let mut state = self.state.lock().expect("fake ABI state");
        let has_mixing = payload.interfaces.iter().any(|record| {
            record.kind == ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
        });
        let expected_descriptor_features = ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
            | if has_mixing {
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
            } else {
                0
            };
        assert_eq!(
            descriptor.prefix.required_features, expected_descriptor_features,
            "static descriptor must carry the exact native-compatible feature mask"
        );
        let requested = state
            .create_request
            .expect("captured context request")
            .requested_device_features;
        assert_eq!(
            descriptor.prefix.required_features & !requested,
            0,
            "the context must request every static-descriptor feature"
        );
        state.descriptor = Some(*descriptor);
        state.payload = Some(payload);
        Ok(())
    }

    fn solve_charge(
        &self,
        request: &fullmag_fdm_gpu_charge_solve_request_v1,
    ) -> Result<fullmag_fdm_gpu_charge_solve_result_v1, u32> {
        self.record("charge");
        self.state.lock().expect("fake ABI state").charge_request = Some(*request);
        Ok(fullmag_fdm_gpu_charge_solve_result_v1 {
            provisional_generation: 9,
            reason: FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            candidate_digest: [7; 32],
            ..Default::default()
        })
    }

    fn accept_charge_snapshot(
        &self,
        context: fullmag_fdm_gpu_transport_context_handle_v1,
        provisional_generation: u64,
    ) -> Result<fullmag_fdm_gpu_charge_snapshot_info_v1, u32> {
        self.record("accept");
        assert_eq!(provisional_generation, 9);
        let state = self.state.lock().expect("fake ABI state");
        let descriptor = state.descriptor.expect("uploaded descriptor");
        let formula = state
            .payload
            .as_ref()
            .expect("uploaded payload")
            .formula_ids;
        Ok(fullmag_fdm_gpu_charge_snapshot_info_v1 {
            snapshot_handle: snapshot_handle(8),
            context_handle: context,
            accepted_sequence: 13,
            local_generation: provisional_generation,
            source_revision: if state.corrupt_accepted_source_revision {
                descriptor.source_revision + 1
            } else {
                descriptor.source_revision
            },
            operator_revision: formula.operator_revision,
            snapshot_content_digest: [8; 32],
            ..Default::default()
        })
    }

    fn solve_steady_spin(
        &self,
        request: &fullmag_fdm_gpu_steady_spin_solve_request_v1,
    ) -> Result<fullmag_fdm_gpu_steady_spin_solve_result_v1, u32> {
        self.record("spin");
        let mut state = self.state.lock().expect("fake ABI state");
        state.spin_request = Some(*request);
        if let Some(status) = state.fail_steady_spin.take() {
            return Err(status);
        }
        drop(state);
        if request.accepted_sequence != 13 {
            return Err(ffi::FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT);
        }
        Ok(fullmag_fdm_gpu_steady_spin_solve_result_v1 {
            reason: FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            snapshot_content_digest: [8; 32],
            deterministic_compute_digest: [9; 32],
            ..Default::default()
        })
    }

    fn readback_artifact(
        &self,
        request: &fullmag_fdm_gpu_transport_artifact_request_v1,
    ) -> Result<(), u32> {
        self.record("readback");
        let destination = unsafe {
            &*(request.destination_view_ptr as *const fullmag_fdm_gpu_transport_buffer_view_v1)
        };
        let mut state = self.state.lock().expect("fake ABI state");
        state.artifact_requests.push(*request);
        state
            .artifact_component_orders
            .push(destination.component_order);
        drop(state);
        let values = unsafe {
            std::slice::from_raw_parts_mut(
                destination.address as *mut f64,
                destination.element_count as usize,
            )
        };
        for (index, value) in values.iter_mut().enumerate() {
            *value = f64::from(request.field_id) * 100.0 + index as f64;
        }
        Ok(())
    }

    fn checkpoint_query_size(
        &self,
        request: &ffi::fullmag_fdm_gpu_transport_checkpoint_size_request_v1,
    ) -> Result<ffi::fullmag_fdm_gpu_transport_checkpoint_size_result_v1, u32> {
        self.record("checkpoint_size");
        assert_eq!(
            request.prefix.required_features,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1
        );
        if let Some(result) = self
            .state
            .lock()
            .expect("fake ABI state")
            .checkpoint_size_override
        {
            return Ok(result);
        }
        Ok(ffi::fullmag_fdm_gpu_transport_checkpoint_size_result_v1 {
            required_bytes: 4,
            section_count: 20,
            alignment: 64,
            schema_version: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1,
            inclusion_mask: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_ALL_V1,
            snapshot_content_digest: [8; 32],
            ..Default::default()
        })
    }

    fn checkpoint_export(
        &self,
        request: &ffi::fullmag_fdm_gpu_transport_checkpoint_export_request_v1,
    ) -> Result<ffi::fullmag_fdm_gpu_transport_checkpoint_export_result_v1, u32> {
        self.record("checkpoint_export");
        assert_eq!(
            request.prefix.required_features,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1
        );
        let destination = unsafe {
            &*(request.destination_view_ptr as *const ffi::fullmag_fdm_gpu_transport_buffer_view_v1)
        };
        let bytes = unsafe { std::slice::from_raw_parts_mut(destination.address as *mut u8, 4) };
        bytes.copy_from_slice(&[1, 2, 3, 4]);
        let payload_sha256: [u8; 32] = Sha256::digest(bytes).into();
        Ok(ffi::fullmag_fdm_gpu_transport_checkpoint_export_result_v1 {
            committed_bytes: 4,
            payload_sha256,
            snapshot_digest: [8; 32],
            spin_digest: [11; 32],
            warm_start_digest: [12; 32],
            snapshot_lineage_id: [10; 16],
            accepted_sequence: 13,
            operation_audit_digest: [14; 32],
            ..Default::default()
        })
    }

    fn checkpoint_import(
        &self,
        request: &ffi::fullmag_fdm_gpu_transport_checkpoint_import_request_v1,
    ) -> Result<ffi::fullmag_fdm_gpu_transport_checkpoint_restore_result_v1, u32> {
        self.record("checkpoint_import");
        assert_eq!(
            request.prefix.required_features,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1
        );
        assert_eq!(
            request.expected_payload_sha256,
            Sha256::digest([1, 2, 3, 4]).as_slice()
        );
        assert_eq!(request.device_uuid, [5; 16]);
        assert_eq!(request.build_digest, [6; 32]);
        assert_eq!(
            request.restore_policy,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD
        );
        assert_eq!(request.expected_bytes, 4);
        assert_eq!(request.audit_parent_digest, [14; 32]);
        let source = unsafe {
            &*(request.source_view_ptr as *const ffi::fullmag_fdm_gpu_transport_buffer_view_v1)
        };
        assert_eq!(
            source.pointer_space,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY
        );
        let payload = unsafe {
            std::slice::from_raw_parts(source.address as *const u8, source.byte_length as usize)
        };
        assert_eq!(payload, [1, 2, 3, 4]);
        Ok(
            ffi::fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 {
                snapshot_handle: snapshot_handle(18),
                snapshot_lineage_id: [10; 16],
                accepted_sequence: 13,
                snapshot_content_digest: [8; 32],
                spin_digest: [11; 32],
                warm_start_digest: [12; 32],
                restored_state:
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_SPIN_ACCEPTED,
                operation_audit_digest: [15; 32],
                ..Default::default()
            },
        )
    }

    fn destroy_snapshot(
        &self,
        _snapshot: fullmag_fdm_gpu_charge_snapshot_handle_v1,
    ) -> Result<(), u32> {
        self.record("destroy_snapshot");
        self.state
            .lock()
            .expect("fake ABI state")
            .fail_destroy_snapshot
            .take()
            .map_or(Ok(()), Err)
    }

    fn destroy_context(
        &self,
        _context: fullmag_fdm_gpu_transport_context_handle_v1,
    ) -> Result<(), u32> {
        self.record("destroy_context");
        self.state
            .lock()
            .expect("fake ABI state")
            .fail_destroy_context
            .take()
            .map_or(Ok(()), Err)
    }
}

fn raw_descriptor(device_ordinal: i32) -> PreparedGpuM1Descriptor {
    PreparedGpuM1Descriptor::from_raw(
        fullmag_fdm_gpu_transport_context_create_request_v1 {
            device_ordinal,
            ..Default::default()
        },
        fullmag_fdm_gpu_transport_static_descriptor_v1 {
            descriptor_revision: 303,
            source_revision: 101,
            grid: [1, 1, 1],
            ..Default::default()
        },
        202,
        404,
    )
}

fn views(identity: DeviceIdentity, cells: u64) -> DeviceVectorViews {
    let byte_length = 3 * cells * size_of::<f64>() as u64;
    views_with_addresses(identity, cells, 0x1000, 0x2000 + byte_length)
}

fn views_with_addresses(
    identity: DeviceIdentity,
    cells: u64,
    magnetization_address: u64,
    torque_address: u64,
) -> DeviceVectorViews {
    let vector_values = 3 * cells;
    DeviceVectorViews::from_raw(
        fullmag_fdm_gpu_transport_buffer_view_v1 {
            address: magnetization_address,
            element_count: vector_values,
            byte_stride: size_of::<f64>() as u64,
            byte_length: vector_values * size_of::<f64>() as u64,
            element_type: ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
            pointer_space: ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY,
            component_order: ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ,
            ..Default::default()
        },
        fullmag_fdm_gpu_transport_buffer_view_v1 {
            address: torque_address,
            element_count: vector_values,
            byte_stride: size_of::<f64>() as u64,
            byte_length: vector_values * size_of::<f64>() as u64,
            element_type: ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
            pointer_space: ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY,
            component_order: ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ,
            ..Default::default()
        },
        identity,
    )
}

fn planned_public_gpu_m1() -> fullmag_ir::FdmPlanIR {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
    ))
    .expect("racetrack fixture must be valid JSON");
    let lowering = fixture
        .get("normalized_problem_ir_contract")
        .and_then(|value| value.get("expected_lowering"))
        .expect("racetrack fixture must contain expected_lowering");
    let mut problem: ProblemIR =
        serde_json::from_value(lowering.clone()).expect("fixture lowering must parse");
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.backend_policy.execution_precision = ExecutionPrecision::Double;
    problem.validation_profile.execution_mode = ExecutionMode::Strict;
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({
            "backend": "fdm",
            "device": "gpu",
            "gpu_count": 1,
            "device_index": 0,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
        }),
    );
    let module = &mut problem.spin_transport_modules[0];
    module.requested_execution.discretization = BackendTarget::Fdm;
    module.requested_execution.device = ExecutionDevice::Gpu;
    module.requested_execution.precision = ExecutionPrecision::Double;
    module.requested_execution.execution_mode = ExecutionMode::Strict;
    module.solver.engine = "native_m1_v1".into();

    match fullmag_plan::plan(&problem)
        .expect("bounded public GPU M1 problem must plan")
        .backend_plan
    {
        BackendPlanIR::Fdm(plan) => plan,
        other => panic!("expected FDM plan, got {other:?}"),
    }
}

fn prepared_plan() -> (fullmag_ir::FdmPlanIR, PreparedGpuM1Descriptor) {
    let plan = planned_public_gpu_m1();
    let prepared = PreparedGpuM1Descriptor::from_plan(&plan, 0)
        .expect("runner must materialize the planner-owned combined GPU M1 descriptor");
    (plan, prepared)
}

#[test]
fn from_plan_accepts_planner_embedded_charge_spin_descriptor() {
    let plan = planned_public_gpu_m1();
    assert!(plan.fdm_gpu_charge_transports.is_empty());
    assert!(plan.spin_transport_plans[0].fdm_gpu_double.is_some());
    PreparedGpuM1Descriptor::from_plan(&plan, 0)
        .expect("runner must materialize the planner-owned combined GPU M1 descriptor");
}

#[test]
fn accepted_charge_snapshot_materializes_the_exact_public_llg_binding() {
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi, raw_descriptor(2)).unwrap();
    let charge = session.solve_charge(7, 11).unwrap();

    let binding = session.llg_binding().unwrap();

    assert_eq!(binding.transport_context.slot, 7);
    assert_eq!(binding.transport_context.generation, 1);
    assert_eq!(binding.charge_snapshot.slot, charge.handle.slot);
    assert_eq!(binding.charge_snapshot.generation, charge.handle.generation);
    assert_eq!(binding.accepted_sequence, charge.accepted_sequence);
    assert_eq!(binding.source_revision, charge.source_revision);
    assert_eq!(binding.operator_revision, 404);
    assert_eq!(binding.relative_tolerance, 1.0e-8);
    assert_eq!(binding.max_iterations, 2_000);
    assert_eq!(
        binding.prefix.required_features,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
    );
}

#[test]
fn accepted_spin_snapshot_readback_publishes_one_typed_complete_transport_artifact_set() {
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
    let charge = session.solve_charge(7, 11).unwrap();

    assert_eq!(
        session.readback_accepted_artifacts(),
        Err(GpuM1TransportError::SpinSnapshotRequired)
    );
    assert!(abi.artifact_requests().is_empty());

    session
        .solve_spin_static(Some(&charge), views(session.device_identity(), 1), 7, 11)
        .unwrap();
    let artifacts = session.readback_accepted_artifacts().unwrap();

    assert_eq!(artifacts.potential_v, vec![100.0]);
    assert_eq!(
        artifacts.charge_current_j_c,
        [vec![200.0, 201.0], vec![202.0, 203.0], vec![204.0, 205.0]]
    );
    assert_eq!(
        artifacts.spin_accumulation_mu_s,
        [vec![300.0], vec![301.0], vec![302.0]]
    );
    assert_eq!(
        artifacts.spin_current_q_ia,
        [
            [vec![400.0, 401.0], vec![402.0, 403.0], vec![404.0, 405.0]],
            [vec![406.0, 407.0], vec![408.0, 409.0], vec![410.0, 411.0]],
            [vec![412.0, 413.0], vec![414.0, 415.0], vec![416.0, 417.0]],
        ]
    );
    assert_eq!(
        artifacts.torque_stt,
        [vec![500.0], vec![501.0], vec![502.0]]
    );

    let requests = abi.artifact_requests();
    assert_eq!(requests.len(), 5);
    assert_eq!(
        requests
            .iter()
            .map(|request| request.field_id)
            .collect::<Vec<_>>(),
        vec![
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_Q_IA,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_TORQUE_STT,
        ]
    );
    assert_eq!(
        requests
            .iter()
            .zip(abi.artifact_component_orders())
            .map(|(_, component_order)| component_order)
            .collect::<Vec<_>>(),
        vec![
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ,
        ]
    );
    assert_eq!(
        requests
            .iter()
            .map(|request| request.range_count)
            .collect::<Vec<_>>(),
        vec![1, 6, 3, 18, 3]
    );
    for request in requests {
        assert_eq!(
            request.prefix.required_features,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK
        );
        assert_eq!(
            request.cadence,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_ACCEPTED_STEP
        );
        assert_eq!(request.accepted_sequence, charge.accepted_sequence);
    }
}

#[test]
fn accepted_bound_llg_step_enables_readback_without_a_second_spin_solve() {
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
    session.solve_charge(7, 11).unwrap();

    session.observe_bound_llg_accepted_step().unwrap();
    let artifacts = session.readback_accepted_artifacts().unwrap();

    assert_eq!(artifacts.potential_v, vec![100.0]);
    assert_eq!(abi.artifact_requests().len(), 5);
}

#[test]
fn from_plan_rejects_partial_transport_active_masks_before_abi() {
    let mut plan = planned_public_gpu_m1();
    let descriptor = plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor");
    descriptor.transport_active_mask[0] = false;
    descriptor.charge_active_cells[0] = false;
    assert!(matches!(
        PreparedGpuM1Descriptor::from_plan(&plan, 0),
        Err(GpuM1TransportError::InvalidDescriptor(message))
            if message.contains("full rectangular")
    ));

    let mut plan = planned_public_gpu_m1();
    plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor")
        .spin_active_cells[0] = false;
    assert!(matches!(
        PreparedGpuM1Descriptor::from_plan(&plan, 0),
        Err(GpuM1TransportError::InvalidDescriptor(message))
            if message.contains("full rectangular")
    ));
}

#[test]
fn from_plan_rejects_invalid_magnetic_mask_and_nonmagnetic_torque_target() {
    let mut plan = planned_public_gpu_m1();
    plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor")
        .magnetic_active_mask
        .pop();
    assert!(matches!(
        PreparedGpuM1Descriptor::from_plan(&plan, 0),
        Err(GpuM1TransportError::InvalidDescriptor(message))
            if message.contains("magnetic mask")
    ));

    let mut plan = planned_public_gpu_m1();
    let descriptor = plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor");
    let target = descriptor
        .torque_target_cells
        .iter()
        .position(|active| *active)
        .expect("fixture must contain a torque target");
    descriptor.magnetic_active_mask[target] = false;
    assert!(matches!(
        PreparedGpuM1Descriptor::from_plan(&plan, 0),
        Err(GpuM1TransportError::InvalidDescriptor(message))
            if message.contains("torque targets must be magnetic")
    ));
}

#[test]
fn from_plan_rejects_enabled_reaction_lengths_that_are_not_finite_positive() {
    for invalid_length in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let mut plan = planned_public_gpu_m1();
        let descriptor = plan.spin_transport_plans[0]
            .fdm_gpu_double
            .as_mut()
            .expect("GPU descriptor");
        descriptor.reactions[0].spin_flip_m = Some(invalid_length);
        assert!(matches!(
            PreparedGpuM1Descriptor::from_plan(&plan, 0),
            Err(GpuM1TransportError::InvalidDescriptor(message))
                if message.contains("reaction lengths")
        ));
    }
}

#[test]
fn from_plan_rejects_missing_or_duplicate_spin_boundary_assignment() {
    let mut missing = planned_public_gpu_m1();
    missing.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor")
        .spin_boundaries
        .pop();
    assert!(matches!(
        PreparedGpuM1Descriptor::from_plan(&missing, 0),
        Err(GpuM1TransportError::InvalidDescriptor(message))
            if message.contains("complete external structured boundary")
    ));

    let mut duplicate = planned_public_gpu_m1();
    let boundaries = &mut duplicate.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor")
        .spin_boundaries;
    let first = boundaries[0].clone();
    let last = boundaries.len() - 1;
    boundaries[last] = first;
    assert!(matches!(
        PreparedGpuM1Descriptor::from_plan(&duplicate, 0),
        Err(GpuM1TransportError::InvalidDescriptor(message))
            if message.contains("complete external structured boundary")
    ));
}

#[test]
fn from_plan_rejects_non_frozen_solver_versions_and_absolute_tolerances() {
    let mut plan = planned_public_gpu_m1();
    plan.spin_transport_plans[0].constitutive_version = "unknown".into();
    assert!(PreparedGpuM1Descriptor::from_plan(&plan, 0).is_err());

    let mut plan = planned_public_gpu_m1();
    let descriptor = plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor");
    descriptor.charge_solver.linear.absolute_tolerance = 1.0e-30;
    assert!(PreparedGpuM1Descriptor::from_plan(&plan, 0).is_err());

    let mut plan = planned_public_gpu_m1();
    plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor")
        .spin_solver
        .physical_residual_version = "unknown".into();
    assert!(PreparedGpuM1Descriptor::from_plan(&plan, 0).is_err());
}

#[test]
fn from_plan_preserves_frozen_payload_features_and_solver_policies() {
    let (plan, prepared) = prepared_plan();
    let descriptor = plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_ref()
        .expect("GPU descriptor");
    let cells = u64::try_from(descriptor.charge_active_cells.len()).unwrap();
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), prepared).unwrap();
    let charge = session.solve_charge(17, 19).unwrap();
    session
        .solve_spin_static(
            Some(&charge),
            views(session.device_identity(), cells),
            17,
            19,
        )
        .unwrap();
    session.close().unwrap();

    let payload = abi.payload();
    assert_eq!(
        abi.descriptor().prefix.required_features,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
    );
    assert_eq!(payload.first_cell.prefix.required_features, 0x04);
    assert_eq!(payload.first_material.prefix.required_features, 0x04);
    assert_eq!(payload.first_interface.prefix.required_features, 0x1c);
    assert_eq!(payload.first_charge_face.prefix.required_features, 0x04);
    assert_eq!(payload.first_spin_face.prefix.required_features, 0x08);
    assert_eq!(payload.formula_ids.prefix.required_features, 0x04);
    assert_eq!(payload.formula_ids.gmres_restart, 50);
    assert_eq!(payload.formula_ids.formula_id, 1);
    assert_eq!(payload.formula_ids.operator_id, 1);
    assert_eq!(payload.formula_ids.spin_formula_id, 1);
    assert_eq!(payload.formula_ids.spin_operator_id, 1);
    assert_eq!(payload.formula_ids.electric_reconstruction_id, 1);
    assert_eq!(payload.formula_ids.interface_formula_id, 1);
    assert_eq!(payload.formula_ids.torque_operator_id, 1);
    assert_eq!(payload.formula_ids.spin_engine_id, 1);
    assert_eq!(payload.formula_ids.preconditioner_id, 1);
    assert_eq!(payload.formula_ids.spin_residual_id, 1);
    assert_eq!(payload.formula_ids.local_residual_id, 1);

    for view in [
        payload.cells_view,
        payload.materials_view,
        payload.interfaces_view,
        payload.charge_faces_view,
        payload.spin_faces_view,
        payload.formula_ids_view,
    ] {
        assert_eq!(
            view.element_type,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES
        );
        assert_eq!(
            view.pointer_space,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY
        );
        assert_eq!(
            view.component_order,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR
        );
        assert_eq!(view.byte_length, view.element_count * view.byte_stride);
    }

    let charge_request = abi.charge_request();
    assert_eq!(
        charge_request.gauge_policy,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT
    );
    assert_eq!(
        charge_request.solver_policy,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1
    );
    assert_eq!(
        charge_request.relative_tolerance,
        descriptor.charge_solver.linear.relative_tolerance
    );
    assert_eq!(
        charge_request.max_iterations,
        u64::from(descriptor.charge_solver.linear.max_iterations)
    );
    let spin_request = abi.spin_request();
    assert_eq!(
        spin_request.solver_policy,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1
    );
    assert_eq!(
        spin_request.relative_tolerance,
        descriptor.spin_solver.linear.relative_tolerance
    );
    assert_eq!(
        spin_request.max_iterations,
        u64::from(descriptor.spin_solver.linear.max_iterations)
    );
    assert_eq!(spin_request.source_revision, charge.source_revision);
    assert_eq!(
        spin_request.operator_revision,
        payload.formula_ids.spin_operator_revision
    );
    let create = abi.create_request();
    assert_eq!(create.device_ordinal, 0);
    assert_eq!(
        create.requested_device_features,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK
    );

    let [nx, ny, nz] = plan.grid.cells.map(u64::from);
    let expected_boundary_faces = 2 * (ny * nz + nx * nz + nx * ny);
    assert_eq!(payload.spin_faces.len() as u64, expected_boundary_faces);
    let unique_faces = payload
        .spin_faces
        .iter()
        .map(|face| (face.axis, face.canonical_face_index))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique_faces.len(), payload.spin_faces.len());
    for face in &payload.spin_faces {
        assert!(face.axis <= 2);
        assert!(matches!(face.side, -1 | 1));
        assert_eq!(face.outward_sign, face.side);
        let x = face.adjacent_cell % nx;
        let yz = face.adjacent_cell / nx;
        let y = yz % ny;
        let z = yz / ny;
        let expected = match (face.axis, face.side) {
            (0, -1) => x == 0 && face.canonical_face_index == (nx + 1) * (y + ny * z),
            (0, 1) => x + 1 == nx && face.canonical_face_index == nx + (nx + 1) * (y + ny * z),
            (1, -1) => y == 0 && face.canonical_face_index == x + nx * ((ny + 1) * z),
            (1, 1) => y + 1 == ny && face.canonical_face_index == x + nx * (ny + (ny + 1) * z),
            (2, -1) => z == 0 && face.canonical_face_index == x + nx * y,
            (2, 1) => z + 1 == nz && face.canonical_face_index == x + nx * (y + ny * nz),
            _ => false,
        };
        assert!(expected, "invalid structured boundary record");
    }
}

#[test]
fn polyfaceted_interface_family_gets_unique_stable_record_source_ids() {
    let (plan, prepared) = prepared_plan();
    let descriptor = plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_ref()
        .expect("GPU descriptor");
    assert!(descriptor.interfaces.len() > 1);
    assert!(
        descriptor
            .interfaces
            .windows(2)
            .any(|pair| pair[0].source_id == pair[1].source_id),
        "fixture must exercise multiple faces from one interface family"
    );

    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), prepared).unwrap();
    session.close().unwrap();
    let first = abi.payload().interfaces;
    let unique = first
        .iter()
        .map(|record| record.source_id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), first.len());
    assert!(first.iter().all(|record| record.source_id != 0));

    let second_abi = FakeAbi::default();
    let mut second = GpuM1TransportSession::create(
        second_abi.clone(),
        PreparedGpuM1Descriptor::from_plan(&plan, 0).unwrap(),
    )
    .unwrap();
    second.close().unwrap();
    assert_eq!(
        first
            .iter()
            .map(|record| { (record.axis, record.canonical_face_index, record.source_id,) })
            .collect::<Vec<_>>(),
        second_abi
            .payload()
            .interfaces
            .iter()
            .map(|record| { (record.axis, record.canonical_face_index, record.source_id,) })
            .collect::<Vec<_>>()
    );
}

#[test]
fn transverse_only_mixing_disables_charge_edge_but_keeps_mixing_feature() {
    let mut plan = planned_public_gpu_m1();
    let descriptor = plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor");
    let fullmag_ir::ResolvedSpinInterfaceLawIR::MixingConductance {
        g_up_spm2,
        g_down_spm2,
        ..
    } = &mut descriptor.interfaces[0].law
    else {
        panic!("expected mixing interface")
    };
    *g_up_spm2 = 0.0;
    *g_down_spm2 = 0.0;
    let prepared = PreparedGpuM1Descriptor::from_plan(&plan, 0).unwrap();
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), prepared).unwrap();
    session.close().unwrap();
    let interface = abi.payload().first_interface;
    assert_eq!(interface.prefix.required_features, 0x1c);
    assert_eq!(
        interface.charge_edge_enabled,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_FALSE
    );
}

#[test]
fn static_descriptor_features_are_exact_for_transparent_and_mixing_plans() {
    let mixing_plan = planned_public_gpu_m1();
    let mixing_abi = FakeAbi::default();
    let mut mixing_session = GpuM1TransportSession::create(
        mixing_abi.clone(),
        PreparedGpuM1Descriptor::from_plan(&mixing_plan, 0).unwrap(),
    )
    .unwrap();
    mixing_session.close().unwrap();
    assert_eq!(
        mixing_abi.descriptor().prefix.required_features,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN
            | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2
    );

    let mut transparent_plan = planned_public_gpu_m1();
    let descriptor = transparent_plan.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor");
    for interface in &mut descriptor.interfaces {
        interface.law = fullmag_ir::ResolvedSpinInterfaceLawIR::Transparent;
    }
    let transparent_abi = FakeAbi::default();
    let mut transparent_session = GpuM1TransportSession::create(
        transparent_abi.clone(),
        PreparedGpuM1Descriptor::from_plan(&transparent_plan, 0).unwrap(),
    )
    .unwrap();
    transparent_session.close().unwrap();
    let exact_transparent_features = ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
        | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN;
    assert_eq!(
        transparent_abi.descriptor().prefix.required_features,
        exact_transparent_features
    );
    assert_eq!(
        transparent_abi
            .payload()
            .first_interface
            .prefix
            .required_features,
        exact_transparent_features
    );
    assert_eq!(
        transparent_abi.create_request().requested_device_features & exact_transparent_features,
        exact_transparent_features
    );
    assert_eq!(
        transparent_abi.create_request().requested_device_features
            & ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2,
        0
    );
}

#[test]
fn create_guard_retries_failed_destroy_after_upload_failure() {
    let abi = FakeAbi::with_destroy_failures(None, Some(62));
    abi.fail_upload(61);
    let error = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2))
        .err()
        .expect("upload failure must reject session creation");
    assert!(matches!(
        error,
        GpuM1TransportError::OperationAndCleanup { ref operation, ref cleanup }
            if matches!(operation.as_ref(), GpuM1TransportError::AbiFailure {
                operation: "static_descriptor_upload",
                status: 61,
            }) && matches!(cleanup.as_ref(), GpuM1TransportError::CleanupFailures(failures)
                if failures.as_slice() == [("destroy_context", 62)])
    ));
    assert_eq!(
        abi.calls(),
        ["create", "upload", "destroy_context", "destroy_context"]
    );
}

#[test]
fn create_guard_retries_failed_destroy_after_missing_features() {
    let abi = FakeAbi::with_destroy_failures(None, Some(64));
    abi.support_only(0);
    let error = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2))
        .err()
        .expect("missing features must reject session creation");
    assert!(matches!(
        error,
        GpuM1TransportError::OperationAndCleanup { ref operation, ref cleanup }
            if matches!(operation.as_ref(), GpuM1TransportError::MissingDeviceFeatures { .. })
                && matches!(cleanup.as_ref(), GpuM1TransportError::CleanupFailures(failures)
                    if failures.as_slice() == [("destroy_context", 64)])
    ));
    assert_eq!(
        abi.calls(),
        ["create", "destroy_context", "destroy_context"]
    );
}

#[test]
fn mixing_interface_requires_exact_to_cell_magnetic_torque_owner() {
    for ownership in ["from_only", "both", "none"] {
        let mut plan = planned_public_gpu_m1();
        let descriptor = plan.spin_transport_plans[0]
            .fdm_gpu_double
            .as_mut()
            .expect("GPU descriptor");
        let interface = descriptor.interfaces[0].clone();
        let from = interface.from_cell as usize;
        let to = interface.to_cell as usize;
        let fm_ms = descriptor.saturation_magnetization_apm[to];
        match ownership {
            "from_only" => {
                descriptor.magnetic_active_mask[from] = true;
                descriptor.magnetic_active_mask[to] = false;
                descriptor.torque_target_cells[from] = true;
                descriptor.torque_target_cells[to] = false;
                descriptor.saturation_magnetization_apm[from] = fm_ms;
            }
            "both" => {
                descriptor.magnetic_active_mask[from] = true;
                descriptor.torque_target_cells[from] = true;
                descriptor.saturation_magnetization_apm[from] = fm_ms;
            }
            "none" => {
                descriptor.magnetic_active_mask[from] = false;
                descriptor.magnetic_active_mask[to] = false;
                descriptor.torque_target_cells[from] = false;
                descriptor.torque_target_cells[to] = false;
            }
            _ => unreachable!(),
        }
        descriptor.torque_target_masks[0].active_mask = descriptor.torque_target_cells.clone();
        assert!(matches!(
            PreparedGpuM1Descriptor::from_plan(&plan, 0),
            Err(GpuM1TransportError::InvalidDescriptor(message))
                if message.contains("mixing interface requires exactly to_cell")
        ));
    }

    let mut reversed = planned_public_gpu_m1();
    let descriptor = reversed.spin_transport_plans[0]
        .fdm_gpu_double
        .as_mut()
        .expect("GPU descriptor");
    let interface = &mut descriptor.interfaces[0];
    std::mem::swap(&mut interface.from_cell, &mut interface.to_cell);
    assert!(matches!(
        PreparedGpuM1Descriptor::from_plan(&reversed, 0),
        Err(GpuM1TransportError::InvalidDescriptor(message))
            if message.contains("mixing interface requires exactly to_cell")
    ));
}

#[test]
fn device_views_reject_overflow_unaligned_and_overlapping_ranges_before_abi() {
    let cases = [
        (0x1001, 0x2000),
        (u64::MAX - 7, 0x2000),
        (0x1000, 0x1000),
        (0x1000, 0x1010),
    ];
    for (magnetization_address, torque_address) in cases {
        let abi = FakeAbi::default();
        let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
        let snapshot = session.solve_charge(1, 2).unwrap();
        let result = session.solve_spin_static(
            Some(&snapshot),
            views_with_addresses(
                session.device_identity(),
                1,
                magnetization_address,
                torque_address,
            ),
            1,
            2,
        );
        assert!(matches!(
            result,
            Err(GpuM1TransportError::InvalidDescriptor(_))
        ));
        assert!(!abi.calls().contains(&"spin"));
    }
}

#[test]
fn spin_requires_accepted_charge_snapshot() {
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
    let result = session.solve_spin_static(None, views(session.device_identity(), 1), 1, 2);

    assert!(matches!(
        result,
        Err(GpuM1TransportError::ChargeSnapshotRequired)
    ));
    assert_eq!(abi.calls(), vec!["create", "upload"]);
}

#[test]
fn spin_rejects_stale_sequence_source_operator_and_device_before_abi() {
    let mutations: [fn(&mut super::spin_transport::AcceptedChargeSnapshot); 4] = [
        |snapshot| snapshot.accepted_sequence += 1,
        |snapshot| snapshot.source_revision += 1,
        |snapshot| snapshot.operator_revision += 1,
        |snapshot| snapshot.device_identity.ordinal += 1,
    ];
    for mutate in mutations {
        let abi = FakeAbi::default();
        let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
        let snapshot = session.solve_charge(1, 2).unwrap();
        let mut stale = snapshot.clone();
        mutate(&mut stale);
        let result =
            session.solve_spin_static(Some(&stale), views(session.device_identity(), 1), 1, 2);
        assert!(matches!(
            result,
            Err(GpuM1TransportError::SnapshotRevisionMismatch)
                | Err(GpuM1TransportError::SnapshotIdentityMismatch { .. })
        ));
        assert!(!abi.calls().contains(&"spin"));
    }
}

#[test]
fn spin_rejects_foreign_snapshot_before_abi() {
    let abi_a = FakeAbi::default();
    let abi_b = FakeAbi::default();
    let mut session_a = GpuM1TransportSession::create(abi_a, raw_descriptor(2)).unwrap();
    let snapshot_a = session_a.solve_charge(1, 2).unwrap();
    let mut session_b = GpuM1TransportSession::create(abi_b.clone(), raw_descriptor(3)).unwrap();
    let _snapshot_b = session_b.solve_charge(1, 2).unwrap();
    let result = session_b.solve_spin_static(
        Some(&snapshot_a),
        views(session_b.device_identity(), 1),
        1,
        2,
    );

    assert!(matches!(
        result,
        Err(GpuM1TransportError::SnapshotIdentityMismatch { .. })
    ));
    assert!(!abi_b.calls().contains(&"spin"));
}

#[test]
fn accepted_snapshot_guard_destroys_invalid_snapshot_immediately() {
    let abi = FakeAbi::default();
    abi.corrupt_accepted_source_revision();
    let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
    assert!(matches!(
        session.solve_charge(1, 2),
        Err(GpuM1TransportError::SnapshotRevisionMismatch)
    ));
    assert_eq!(
        abi.calls(),
        vec!["create", "upload", "charge", "accept", "destroy_snapshot"]
    );
    session.close().unwrap();
}

#[test]
fn session_sequence_continues_from_accepted_charge_to_spin() {
    let abi = FakeAbi::default();
    let result = execute_static_gpu_m1_with_abi(abi.clone(), raw_descriptor(2), 1, 2, |identity| {
        views(identity, 1)
    })
    .unwrap();

    assert_eq!(
        abi.calls(),
        [
            "create",
            "upload",
            "charge",
            "accept",
            "spin",
            "destroy_snapshot",
            "destroy_context"
        ]
    );
    assert_eq!(result.accepted_sequence, 13);
}

#[test]
fn accepted_snapshot_revisions_are_published_together() {
    let abi = FakeAbi::default();
    let result =
        execute_static_gpu_m1_with_abi(abi, raw_descriptor(2), 1, 2, |identity| views(identity, 1))
            .unwrap();

    assert_eq!(result.source_revision, 101);
    assert_eq!(result.charge_operator_revision, 202);
    assert_eq!(result.static_descriptor_revision, 303);
    assert_eq!(result.spin_operator_revision, 404);
    assert_eq!(result.device_identity.ordinal, 2);
}

#[test]
fn explicit_close_retains_failed_snapshot_and_context_handles_for_retry() {
    let abi = FakeAbi::with_destroy_failures(Some(71), None);
    let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
    session.solve_charge(1, 2).unwrap();
    let error = session
        .close()
        .expect_err("explicit cleanup must be observable");
    assert!(matches!(
        error,
        GpuM1TransportError::CleanupFailures(ref failures)
            if failures == &vec![("destroy_snapshot", 71)]
    ));
    assert_eq!(
        abi.calls(),
        ["create", "upload", "charge", "accept", "destroy_snapshot"]
    );
    session
        .close()
        .expect("retry must release both retained handles");
    assert!(abi
        .calls()
        .ends_with(&["destroy_snapshot", "destroy_context"]));

    let context_abi = FakeAbi::with_destroy_failures(None, Some(72));
    let mut context_session =
        GpuM1TransportSession::create(context_abi.clone(), raw_descriptor(2)).unwrap();
    let error = context_session
        .close()
        .expect_err("failed context destroy must retain the context handle");
    assert!(matches!(
        error,
        GpuM1TransportError::CleanupFailures(ref failures)
            if failures == &vec![("destroy_context", 72)]
    ));
    context_session
        .close()
        .expect("retry must release the retained context handle");
    assert!(context_abi
        .calls()
        .ends_with(&["destroy_context", "destroy_context"]));

    let fallback = FakeAbi::default();
    {
        let mut session =
            GpuM1TransportSession::create(fallback.clone(), raw_descriptor(2)).unwrap();
        session.solve_charge(1, 2).unwrap();
    }
    assert!(fallback
        .calls()
        .ends_with(&["destroy_snapshot", "destroy_context"]));
}

#[test]
fn lifecycle_helper_combines_spin_and_cleanup_failures() {
    let abi = FakeAbi::with_destroy_failures(Some(73), None);
    abi.fail_steady_spin(74);
    let result = execute_static_gpu_m1_with_abi(abi.clone(), raw_descriptor(2), 1, 2, |identity| {
        views(identity, 1)
    });
    assert!(matches!(
        result,
        Err(GpuM1TransportError::OperationAndCleanup { ref operation, ref cleanup })
            if matches!(operation.as_ref(), GpuM1TransportError::AbiFailure {
                operation: "solve_steady_spin",
                status: 74,
            }) && matches!(cleanup.as_ref(), GpuM1TransportError::CleanupFailures(failures)
                if failures.as_slice() == [("destroy_snapshot", 73)])
    ));
    assert!(abi.calls().ends_with(&[
        "spin",
        "destroy_snapshot",
        "destroy_snapshot",
        "destroy_context"
    ]));
}

#[test]
fn stage_checkpoint_wraps_exact_native_spin_payload_and_revision_identity() {
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
    let charge = session.solve_charge(1, 2).unwrap();
    session
        .solve_spin_static(Some(&charge), views(session.device_identity(), 1), 1, 2)
        .unwrap();
    let checkpoint = session.export_stage_checkpoint(7).unwrap();

    assert_eq!(
        checkpoint.schema,
        "fullmag.fdm.transport_stage_checkpoint.v1"
    );
    assert_eq!(checkpoint.accepted_step, 7);
    assert_eq!(checkpoint.charge_sequence, 13);
    assert_eq!(checkpoint.spin_accepted_sequence, 13);
    assert_eq!(checkpoint.source_revision, 101);
    assert_eq!(checkpoint.charge_operator_revision, 202);
    assert_eq!(checkpoint.static_descriptor_revision, 303);
    assert_eq!(checkpoint.spin_operator_revision, 404);
    assert_eq!(checkpoint.device_uuid, [5; 16]);
    assert_eq!(checkpoint.device_ordinal, 2);
    assert_eq!(checkpoint.build_digest, [6; 32]);
    assert_eq!(
        checkpoint.payload_sha256,
        Sha256::digest([1, 2, 3, 4]).as_slice()
    );
    assert_eq!(checkpoint.snapshot_digest, [8; 32]);
    assert_eq!(checkpoint.spin_digest, [11; 32]);
    assert_eq!(checkpoint.warm_start_digest, [12; 32]);
    assert_eq!(checkpoint.snapshot_lineage_id, [10; 16]);
    assert_eq!(checkpoint.operation_audit_digest, [14; 32]);
    assert_eq!(checkpoint.payload, [1, 2, 3, 4]);
    assert!(abi
        .calls()
        .ends_with(&["checkpoint_size", "checkpoint_export"]));
}

#[test]
fn stage_checkpoint_requires_an_accepted_spin_solve_not_only_charge() {
    let abi = FakeAbi::default();
    let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
    session.solve_charge(1, 2).unwrap();

    assert_eq!(
        session.export_stage_checkpoint(7),
        Err(GpuM1TransportError::SpinSnapshotRequired)
    );
    assert!(!abi.calls().contains(&"checkpoint_size"));
}

#[test]
fn stage_checkpoint_rejects_untrusted_size_identity_before_allocation() {
    for mutation in [
        "zero",
        "oversized",
        "schema",
        "mask",
        "digest",
        "sections",
        "alignment",
    ] {
        let abi = FakeAbi::default();
        let mut result = ffi::fullmag_fdm_gpu_transport_checkpoint_size_result_v1 {
            required_bytes: 4,
            section_count: 20,
            alignment: 64,
            schema_version: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1,
            inclusion_mask: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUDE_ALL_V1,
            snapshot_content_digest: [8; 32],
            ..Default::default()
        };
        match mutation {
            "zero" => result.required_bytes = 0,
            "oversized" => result.required_bytes = (1 << 20) + 2 * 4096 + 1,
            "schema" => result.schema_version = 2,
            "mask" => result.inclusion_mask = 0x33,
            "digest" => result.snapshot_content_digest[0] ^= 1,
            "sections" => result.section_count = 19,
            "alignment" => result.alignment = 32,
            _ => unreachable!(),
        }
        abi.override_checkpoint_size(result);
        let mut session = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2)).unwrap();
        let charge = session.solve_charge(1, 2).unwrap();
        session
            .solve_spin_static(Some(&charge), views(session.device_identity(), 1), 1, 2)
            .unwrap();
        let error = session
            .export_stage_checkpoint(7)
            .expect_err("untrusted checkpoint size identity must fail closed");
        if mutation == "oversized" {
            assert!(matches!(error, GpuM1TransportError::InvalidDescriptor(_)));
        } else {
            assert_eq!(error, GpuM1TransportError::SnapshotRevisionMismatch);
        }
        assert!(!abi.calls().contains(&"checkpoint_export"));
    }
}

#[test]
fn checkpoint_feature_is_required_during_context_negotiation() {
    let abi = FakeAbi::default();
    abi.support_only(u64::MAX ^ ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    let error = GpuM1TransportSession::create(abi.clone(), raw_descriptor(2))
        .err()
        .expect("missing checkpoint capability must reject session creation");
    assert!(matches!(
        error,
        GpuM1TransportError::MissingDeviceFeatures { .. }
    ));
    assert_eq!(abi.calls(), ["create", "destroy_context"]);
}

#[test]
fn stage_checkpoint_restores_exact_accepted_spin_snapshot_into_fresh_session() {
    let source_abi = FakeAbi::default();
    let mut source = GpuM1TransportSession::create(source_abi, raw_descriptor(2)).unwrap();
    let charge = source.solve_charge(1, 2).unwrap();
    source
        .solve_spin_static(Some(&charge), views(source.device_identity(), 1), 1, 2)
        .unwrap();
    let checkpoint = source.export_stage_checkpoint(7).unwrap();

    let restored_abi = FakeAbi::default();
    let mut restored =
        GpuM1TransportSession::create(restored_abi.clone(), raw_descriptor(2)).unwrap();
    let snapshot = restored.restore_stage_checkpoint(&checkpoint).unwrap();

    assert_eq!(snapshot.accepted_sequence, checkpoint.charge_sequence);
    assert_eq!(snapshot.source_revision, checkpoint.source_revision);
    assert_eq!(
        snapshot.operator_revision,
        checkpoint.charge_operator_revision
    );
    assert_eq!(snapshot.device_identity, restored.device_identity());
    assert!(restored_abi.calls().ends_with(&["checkpoint_import"]));
}

#[test]
fn stage_checkpoint_rejects_foreign_identity_before_native_import() {
    for mutation in ["schema", "device", "build", "descriptor", "payload"] {
        let source_abi = FakeAbi::default();
        let mut source = GpuM1TransportSession::create(source_abi, raw_descriptor(2)).unwrap();
        let charge = source.solve_charge(1, 2).unwrap();
        source
            .solve_spin_static(Some(&charge), views(source.device_identity(), 1), 1, 2)
            .unwrap();
        let mut checkpoint = source.export_stage_checkpoint(7).unwrap();
        match mutation {
            "schema" => checkpoint.schema.push_str(".foreign"),
            "device" => checkpoint.device_uuid[0] ^= 1,
            "build" => checkpoint.build_digest[0] ^= 1,
            "descriptor" => checkpoint.static_descriptor_digest[0] ^= 1,
            "payload" => checkpoint.payload[0] ^= 1,
            _ => unreachable!(),
        }

        let restored_abi = FakeAbi::default();
        let mut restored =
            GpuM1TransportSession::create(restored_abi.clone(), raw_descriptor(2)).unwrap();
        assert!(matches!(
            restored.restore_stage_checkpoint(&checkpoint),
            Err(GpuM1TransportError::SnapshotRevisionMismatch)
                | Err(GpuM1TransportError::InvalidDescriptor(_))
        ));
        assert!(!restored_abi.calls().contains(&"checkpoint_import"));
    }
}
