//! Closed, explicitly requested diagnostic control; never inferred from labels.
use fullmag_ir::{
    BackendTarget, EnergyTermIR, ExecutionPrecision, FemGpuPcgControlExperimentIR, ProblemIR,
    RequestedFemDemagIR, StudyIR,
};

use crate::{util::runtime_requests_cuda, PlanError};

pub(crate) fn request(
    problem: &ProblemIR,
) -> Result<Option<FemGpuPcgControlExperimentIR>, PlanError> {
    let key = FemGpuPcgControlExperimentIR::METADATA_KEY;
    let Some(raw) = problem.problem_meta.runtime_metadata.get(key) else {
        return Ok(None);
    };
    let reject = |reason: String| PlanError {
        reasons: vec![format!("runtime_metadata.{key}: {reason}; fallback=none")],
    };
    let request: FemGpuPcgControlExperimentIR = serde_json::from_value(raw.clone())
        .map_err(|error| reject(format!("invalid diagnostic object: {error}")))?;
    request.validate().map_err(reject)?;
    if problem.backend_policy.requested_backend != BackendTarget::Fem
        || !runtime_requests_cuda(problem)
        || problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || !matches!(
            problem.study,
            StudyIR::TimeEvolution { .. } | StudyIR::Relaxation { .. }
        )
        || problem
            .pbc
            .as_ref()
            .is_some_and(|pbc| pbc.has_any_periodic())
    {
        return Err(reject(
            "requires explicit FEM/GPU/double time-domain execution without PBC".into(),
        ));
    }
    if !problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            EnergyTermIR::Demag {
                realization: RequestedFemDemagIR::Auto
                    | RequestedFemDemagIR::PoissonDirichlet
                    | RequestedFemDemagIR::PoissonRobin
            }
        )
    }) {
        return Err(reject(
            "requires active Poisson Robin/Dirichlet demag".into(),
        ));
    }
    if !problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fem.as_ref())
        .and_then(|fem| fem.demag_solver_policy.as_ref())
        .is_some_and(|policy| policy.solver == "CG" && policy.preconditioner == "AMG")
    {
        return Err(reject(
            "requires an explicit CG policy with retained AMG".into(),
        ));
    }
    Ok(Some(request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn carrier() -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem
            .problem_meta
            .runtime_metadata
            .insert("runtime_selection".into(), json!({"device":"gpu"}));
        problem.energy_terms.push(EnergyTermIR::Demag {
            realization: RequestedFemDemagIR::PoissonRobin,
        });
        problem
            .backend_policy
            .discretization_hints
            .as_mut()
            .unwrap()
            .fem
            .as_mut()
            .unwrap()
            .demag_solver_policy = Some(fullmag_ir::FemLinearSolverPolicy::default());
        problem.problem_meta.runtime_metadata.insert(FemGpuPcgControlExperimentIR::METADATA_KEY.into(),
            json!({"schema_version":FemGpuPcgControlExperimentIR::SCHEMA_VERSION,"status_batch_stride":4}));
        problem
    }

    #[test]
    fn pcg_control_metadata_round_trip_and_absence() {
        let problem = carrier();
        let restored: ProblemIR =
            serde_json::from_slice(&serde_json::to_vec(&problem).unwrap()).unwrap();
        assert_eq!(request(&restored).unwrap().unwrap().status_batch_stride, 4);
        assert_eq!(
            restored.problem_meta.runtime_metadata,
            problem.problem_meta.runtime_metadata
        );
        let mut absent = problem;
        absent
            .problem_meta
            .runtime_metadata
            .remove(FemGpuPcgControlExperimentIR::METADATA_KEY);
        assert!(request(&absent).unwrap().is_none());
    }

    #[test]
    fn pcg_control_rejects_unsupported_execution_before_planning() {
        for change in [
            "cpu",
            "override_cpu",
            "auto_device",
            "fdm",
            "auto_backend",
            "single",
            "no_demag",
            "bem",
            "gmres",
            "jacobi",
            "implicit_policy",
            "pbc",
            "field_only",
        ] {
            let mut problem = carrier();
            match change {
                "cpu" | "auto_device" => {
                    problem.problem_meta.runtime_metadata.insert(
                        "runtime_selection".into(),
                        json!({"device":if change=="cpu" {"cpu"} else {"auto"}}),
                    );
                }
                "override_cpu" => {
                    problem
                        .problem_meta
                        .runtime_metadata
                        .insert("runtime_device_override".into(), json!({"device":"cpu"}));
                }
                "fdm" => problem.backend_policy.requested_backend = BackendTarget::Fdm,
                "auto_backend" => problem.backend_policy.requested_backend = BackendTarget::Auto,
                "single" => problem.backend_policy.execution_precision = ExecutionPrecision::Single,
                "no_demag" => problem
                    .energy_terms
                    .retain(|term| !matches!(term, EnergyTermIR::Demag { .. })),
                "bem" => {
                    problem
                        .energy_terms
                        .retain(|term| !matches!(term, EnergyTermIR::Demag { .. }));
                    problem.energy_terms.push(EnergyTermIR::Demag {
                        realization: RequestedFemDemagIR::FredkinKoehler,
                    });
                }
                "gmres" | "jacobi" => {
                    let fem = problem
                        .backend_policy
                        .discretization_hints
                        .as_mut()
                        .unwrap()
                        .fem
                        .as_mut()
                        .unwrap();
                    let mut policy = fullmag_ir::FemLinearSolverPolicy::default();
                    if change == "gmres" {
                        policy.solver = "GMRES".into();
                    } else {
                        policy.preconditioner = "JACOBI".into();
                    }
                    fem.demag_solver_policy = Some(policy);
                }
                "implicit_policy" => {
                    problem
                        .backend_policy
                        .discretization_hints
                        .as_mut()
                        .unwrap()
                        .fem
                        .as_mut()
                        .unwrap()
                        .demag_solver_policy = None
                }
                "pbc" => {
                    problem.pbc = Some(fullmag_ir::FdmPeriodicityIR {
                        axes: [
                            fullmag_ir::AxisBoundary::Periodic,
                            fullmag_ir::AxisBoundary::Open,
                            fullmag_ir::AxisBoundary::Open,
                        ],
                        demag: fullmag_ir::FdmDemagPeriodicityIR::default(),
                        image_counts: None,
                    })
                }
                "field_only" => {
                    problem.study = StudyIR::FieldOnly {
                        sampling: fullmag_ir::SamplingIR {
                            outputs: Vec::new(),
                            table_autosave: None,
                            stage_autosave: None,
                        },
                    }
                }
                _ => unreachable!(),
            }
            let error = crate::plan(&problem).unwrap_err();
            assert!(
                error
                    .reasons
                    .iter()
                    .any(|reason| reason.contains(FemGpuPcgControlExperimentIR::METADATA_KEY)),
                "{change}: {error:?}"
            );
        }
    }

    #[test]
    fn pcg_control_null_and_unknown_keys_are_never_ignored() {
        for value in [
            json!(null),
            json!({}),
            json!({"schema_version":FemGpuPcgControlExperimentIR::SCHEMA_VERSION,"status_batch_stride":4,"unknown":true}),
        ] {
            let mut problem = carrier();
            problem
                .problem_meta
                .runtime_metadata
                .insert(FemGpuPcgControlExperimentIR::METADATA_KEY.into(), value);
            let error = crate::plan(&problem).unwrap_err();
            assert!(error
                .reasons
                .iter()
                .any(|reason| reason.contains(FemGpuPcgControlExperimentIR::METADATA_KEY)));
        }
    }

    #[test]
    fn pcg_control_reaches_fem_plan_without_changing_physical_inputs() {
        let mut problem = carrier();
        problem.air_box_policy = Some(fullmag_ir::AirBoxPolicyIR {
            boundary_marker: Some(99),
            ..Default::default()
        });
        let mesh = fullmag_ir::MeshIR {
            mesh_name: "strip".into(),
            nodes: vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [0., 1., 0.],
                [0., 0., 1.],
                [-2., -2., -2.],
                [2., -2., -2.],
                [-2., 2., -2.],
                [-2., -2., 2.],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
            element_markers: vec![1, 0],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
            boundary_markers: vec![1, 99],
            periodic_boundary_pairs: vec![],
            periodic_node_pairs: vec![],
            per_domain_quality: Default::default(),
        };
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![],
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(mesh),
                region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip".into(),
                    marker: 1,
                }],
                object_region_markers: vec![],
                build_report: None,
            }),
        });
        let fullmag_ir::BackendPlanIR::Fem(mut experiment) =
            crate::plan(&problem).unwrap().backend_plan
        else {
            panic!("expected FEM")
        };
        assert_eq!(
            experiment
                .gpu_pcg_control_experiment
                .take()
                .unwrap()
                .status_batch_stride,
            4
        );
        problem
            .problem_meta
            .runtime_metadata
            .remove(FemGpuPcgControlExperimentIR::METADATA_KEY);
        let fullmag_ir::BackendPlanIR::Fem(baseline) = crate::plan(&problem).unwrap().backend_plan
        else {
            panic!("expected FEM")
        };
        assert_eq!(experiment, baseline);
    }
}
