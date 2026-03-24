//! Safe Rust wrapper around the native FEM GPU backend scaffold.
//!
//! Current stage:
//! - stable C ABI and Rust wrapper
//! - availability probing
//! - exchange-only native step on MFEM builds
//! - demag/libCEED/hypre still pending

#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
use crate::types::{RunError, StepStats};

#[cfg(feature = "fem-gpu")]
use std::ffi::CStr;

pub(crate) fn is_gpu_available() -> bool {
    #[cfg(feature = "fem-gpu")]
    {
        unsafe { ffi::fullmag_fem_is_available() == 1 }
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        false
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) struct NativeFemBackend {
    handle: *mut ffi::fullmag_fem_backend,
}

#[cfg(feature = "fem-gpu")]
impl NativeFemBackend {
    pub fn create(plan: &fullmag_ir::FemPlanIR) -> Result<Self, RunError> {
        let nodes_flat: Vec<f64> = plan
            .mesh
            .nodes
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let elements_flat: Vec<u32> = plan
            .mesh
            .elements
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let boundary_flat: Vec<u32> = plan
            .mesh
            .boundary_faces
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let m_flat: Vec<f64> = plan
            .initial_magnetization
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();

        let mesh = ffi::fullmag_fem_mesh_desc {
            nodes_xyz: nodes_flat.as_ptr(),
            n_nodes: plan.mesh.nodes.len() as u32,
            elements: elements_flat.as_ptr(),
            n_elements: plan.mesh.elements.len() as u32,
            element_markers: plan.mesh.element_markers.as_ptr(),
            boundary_faces: boundary_flat.as_ptr(),
            n_boundary_faces: plan.mesh.boundary_faces.len() as u32,
            boundary_markers: plan.mesh.boundary_markers.as_ptr(),
        };

        let material = ffi::fullmag_fem_material_desc {
            saturation_magnetisation: plan.material.saturation_magnetisation,
            exchange_stiffness: plan.material.exchange_stiffness,
            damping: plan.material.damping,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
        };

        let precision = match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => {
                ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_SINGLE
            }
            fullmag_ir::ExecutionPrecision::Double => {
                ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE
            }
        };

        let plan_desc = ffi::fullmag_fem_plan_desc {
            mesh,
            material,
            fe_order: plan.fe_order,
            hmax: plan.hmax,
            precision,
            integrator: ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_HEUN,
            enable_exchange: if plan.enable_exchange { 1 } else { 0 },
            enable_demag: if plan.enable_demag { 1 } else { 0 },
            has_external_field: if plan.external_field.is_some() { 1 } else { 0 },
            external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),
            demag_solver: ffi::fullmag_fem_solver_config {
                solver: ffi::fullmag_fem_linear_solver::FULLMAG_FEM_LINEAR_SOLVER_CG,
                preconditioner: ffi::fullmag_fem_preconditioner::FULLMAG_FEM_PRECONDITIONER_AMG,
                relative_tolerance: 1e-8,
                max_iterations: 500,
            },
            air_box_factor: 0.0,
            initial_magnetization_xyz: m_flat.as_ptr(),
            initial_magnetization_len: m_flat.len() as u64,
            dt_seconds: plan.fixed_timestep.unwrap_or(1e-13),
        };

        let handle = unsafe { ffi::fullmag_fem_backend_create(&plan_desc) };
        if handle.is_null() {
            return Err(RunError {
                message: last_global_error_or(
                    "FEM GPU backend_create returned null without an error message",
                ),
            });
        }

        let err = unsafe { ffi::fullmag_fem_backend_last_error(handle) };
        if !err.is_null() {
            let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
            unsafe { ffi::fullmag_fem_backend_destroy(handle) };
            return Err(RunError { message: msg });
        }

        Ok(Self { handle })
    }

    pub fn step(&mut self, dt: f64) -> Result<StepStats, RunError> {
        let mut stats = ffi::fullmag_fem_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            demag_linear_iterations: 0,
            demag_linear_residual: 0.0,
            wall_time_ns: 0,
        };

        let rc = unsafe { ffi::fullmag_fem_backend_step(self.handle, dt, &mut stats) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU step failed"));
        }

        Ok(StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            wall_time_ns: stats.wall_time_ns,
        })
    }

    pub fn copy_field(
        &self,
        observable: ffi::fullmag_fem_observable,
        node_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = node_count * 3;
        let mut flat = vec![0.0f64; len];
        let rc = unsafe {
            ffi::fullmag_fem_backend_copy_field_f64(
                self.handle,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU copy_field failed"));
        }
        Ok(flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
    }

    pub fn copy_m(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
            node_count,
        )
    }

    pub fn copy_h_ex(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
            node_count,
        )
    }

    pub fn copy_h_demag(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG,
            node_count,
        )
    }

    pub fn copy_h_ext(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT,
            node_count,
        )
    }

    pub fn copy_h_eff(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EFF,
            node_count,
        )
    }

    pub fn device_info(&self) -> Result<DeviceInfo, RunError> {
        let mut info = ffi::fullmag_fem_device_info {
            name: [0; 128],
            is_gpu_enabled: 0,
            compute_capability_major: 0,
            compute_capability_minor: 0,
            driver_version: 0,
            runtime_version: 0,
        };

        let rc = unsafe { ffi::fullmag_fem_backend_get_device_info(self.handle, &mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU get_device_info failed"));
        }

        let name = unsafe { CStr::from_ptr(info.name.as_ptr()) }
            .to_string_lossy()
            .to_string();

        Ok(DeviceInfo {
            name,
            compute_capability: format!(
                "{}.{}",
                info.compute_capability_major, info.compute_capability_minor
            ),
            driver_version: info.driver_version,
            runtime_version: info.runtime_version,
        })
    }

    fn last_error_or(&self, fallback: &str) -> RunError {
        let err = unsafe { ffi::fullmag_fem_backend_last_error(self.handle) };
        let msg = if err.is_null() {
            fallback.to_string()
        } else {
            unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string()
        };
        RunError { message: msg }
    }
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeFemBackend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fem_backend_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug, Clone)]
pub(crate) struct DeviceInfo {
    pub name: String,
    pub compute_capability: String,
    pub driver_version: i32,
    pub runtime_version: i32,
}

#[cfg(feature = "fem-gpu")]
fn last_global_error_or(fallback: &str) -> String {
    fallback.to_string()
}

#[cfg(all(test, feature = "fem-gpu"))]
mod tests {
    use super::*;
    use fullmag_engine::fem::{FemLlgProblem, FemLlgState, MeshTopology};
    use fullmag_engine::{EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator};
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FemPlanIR, IntegratorChoice, MaterialIR,
        MeshIR,
    };

    fn make_test_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "unit_tet".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: MeshIR {
                mesh_name: "unit_tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
            },
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
            },
            enable_exchange: true,
            enable_demag: true,
            external_field: Some([1.0, 2.0, 3.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
        }
    }

    fn make_exchange_only_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "two_tets".to_string(),
            mesh_source: Some("meshes/two_tets.msh".to_string()),
            mesh: MeshIR {
                mesh_name: "two_tets".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 0.0],
                ],
                elements: vec![[0, 1, 2, 3], [1, 4, 2, 3]],
                element_markers: vec![1, 1],
                boundary_faces: vec![
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 4, 2],
                    [1, 4, 3],
                    [4, 2, 3],
                ],
                boundary_markers: vec![1; 6],
            },
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [0.9992009587217894, 0.03996803834887158, 0.0],
                [0.996815278536125, 0.07974522228289, 0.0],
                [0.992876838486922, 0.11914522061843064, 0.0],
                [0.9874406319167053, 0.15799050110667284, 0.0],
            ],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
            },
            enable_exchange: true,
            enable_demag: false,
            external_field: Some([1.5e3, -2.0e3, 7.5e2]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(2.5e-13),
        }
    }

    fn assert_scalar_close(label: &str, actual: f64, expected: f64, rel_tol: f64, abs_tol: f64) {
        let diff = (actual - expected).abs();
        let scale = expected.abs().max(actual.abs()).max(1.0);
        assert!(
            diff <= abs_tol.max(rel_tol * scale),
            "{} mismatch: actual={} expected={} diff={}",
            label,
            actual,
            expected,
            diff
        );
    }

    fn assert_vector_field_close(
        label: &str,
        actual: &[[f64; 3]],
        expected: &[[f64; 3]],
        rel_tol: f64,
        abs_tol: f64,
    ) {
        assert_eq!(actual.len(), expected.len(), "{} length mismatch", label);
        for (index, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            for component in 0..3 {
                assert_scalar_close(
                    &format!("{}[{}][{}]", label, index, component),
                    a[component],
                    e[component],
                    rel_tol,
                    abs_tol,
                );
            }
        }
    }

    fn cpu_reference_single_step(
        plan: &FemPlanIR,
    ) -> (
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        fullmag_engine::StepReport,
    ) {
        let topology = MeshTopology::from_ir(&plan.mesh).expect("topology");
        let material = MaterialParameters::new(
            plan.material.saturation_magnetisation,
            plan.material.exchange_stiffness,
            plan.material.damping,
        )
        .expect("material");
        let dynamics =
            LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::Heun).expect("dynamics");
        let problem = FemLlgProblem::with_terms(
            topology,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                demag: plan.enable_demag,
                external_field: plan.external_field,
            },
        );
        let mut state =
            FemLlgState::new(&problem.topology, plan.initial_magnetization.clone()).expect("state");
        let report = problem
            .step(&mut state, plan.fixed_timestep.expect("fixed dt"))
            .expect("cpu fem step");
        let observables = problem.observe(&state).expect("observe");
        (
            state.magnetization().to_vec(),
            observables.exchange_field,
            observables.effective_field,
            report,
        )
    }

    #[test]
    fn native_fem_scaffold_exposes_initial_state_fields() {
        let plan = make_test_plan();
        let backend = NativeFemBackend::create(&plan).expect("native fem scaffold create");

        let m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
        let h_demag = backend
            .copy_h_demag(plan.mesh.nodes.len())
            .expect("copy H_demag");
        let h_ext = backend
            .copy_h_ext(plan.mesh.nodes.len())
            .expect("copy H_ext");
        let h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");
        let info = backend.device_info().expect("device info");

        assert_eq!(m, plan.initial_magnetization);
        assert!(h_ex.iter().all(|v| *v == [0.0, 0.0, 0.0]));
        assert!(h_demag.iter().all(|v| *v == [0.0, 0.0, 0.0]));
        assert!(h_ext.iter().all(|v| *v == [1.0, 2.0, 3.0]));
        assert_eq!(h_eff, h_ext);
        assert!(
            info.name == "native_fem_scaffold" || info.name.starts_with("mfem_"),
            "unexpected device info name: {}",
            info.name
        );
    }

    #[test]
    fn native_fem_scaffold_step_is_honestly_unavailable() {
        let plan = make_test_plan();
        let mut backend = NativeFemBackend::create(&plan).expect("native fem scaffold create");
        let err = backend.step(1e-13).expect_err("step should be unavailable");
        assert!(
            err.message.contains("MFEM")
                || err.message.contains("scaffold")
                || err.message.contains("demag"),
            "unexpected unavailable message: {}",
            err.message
        );
    }

    #[test]
    fn native_fem_exchange_only_matches_cpu_reference_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!(
                "skipping native FEM parity test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
            return;
        }

        let plan = make_exchange_only_plan();
        let (expected_m, expected_h_ex, expected_h_eff, expected_report) =
            cpu_reference_single_step(&plan);

        let mut backend = NativeFemBackend::create(&plan).expect("native fem create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native exchange-only fem step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");

        assert_vector_field_close("m", &actual_m, &expected_m, 5e-8, 1e-10);
        assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-8, 1e-6);
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);

        assert_scalar_close(
            "time_seconds",
            stats.time,
            expected_report.time_seconds,
            1e-12,
            1e-18,
        );
        assert_scalar_close(
            "exchange_energy_joules",
            stats.e_ex,
            expected_report.exchange_energy_joules,
            5e-8,
            1e-18,
        );
        assert_scalar_close(
            "external_energy_joules",
            stats.e_ext,
            expected_report.external_energy_joules,
            5e-8,
            1e-18,
        );
        assert_scalar_close(
            "total_energy_joules",
            stats.e_total,
            expected_report.total_energy_joules,
            5e-8,
            1e-18,
        );
        assert_scalar_close(
            "max_effective_field_amplitude",
            stats.max_h_eff,
            expected_report.max_effective_field_amplitude,
            5e-8,
            1e-9,
        );
        assert_scalar_close(
            "max_rhs_amplitude",
            stats.max_dm_dt,
            expected_report.max_rhs_amplitude,
            5e-8,
            1e-9,
        );
    }
}
