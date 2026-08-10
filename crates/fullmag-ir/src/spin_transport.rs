use crate::{ExecutionDevice, ExecutionMode, ExecutionPrecision, MeshIR, RegionRefIR};
use serde::{Deserialize, Serialize};

fn is_zero_f64(value: &f64) -> bool {
    *value == 0.0
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransportCouplingIR {
    #[default]
    OneWay,
    Bidirectional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SurfaceRefIR {
    pub object_id: String,
    pub surface_id: String,
    pub orientation: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinMemoryLossReservoirIR {
    #[serde(rename = "g_n_Spm2")]
    pub g_n_spm2: f64,
    #[serde(rename = "g_f_Spm2")]
    pub g_f_spm2: f64,
    #[serde(rename = "g_lattice_Spm2")]
    pub g_lattice_spm2: f64,
    pub formula_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeTransportDefinitionIR {
    pub domain: Vec<RegionRefIR>,
    pub materials: Vec<ChargeTransportMaterialAssignmentIR>,
    pub boundaries: Vec<ChargeBoundaryIR>,
    pub gauge: ChargePotentialGaugeIR,
    pub solver: ChargeSolverPolicyIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_view: Option<ResolvedFemConservativeCurrentViewIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeTransportMaterialAssignmentIR {
    pub region: RegionRefIR,
    pub material: ChargeTransportMaterialIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeTransportMaterialIR {
    #[serde(rename = "sigma_Spm")]
    pub sigma_spm: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_parallel_Spm"
    )]
    pub sigma_parallel_spm: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_perpendicular_Spm"
    )]
    pub sigma_perpendicular_spm: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_AHE_Spm"
    )]
    pub sigma_ahe_spm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChargeBoundaryIR {
    VoltageElectrode {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "potential_V")]
        potential_v: f64,
    },
    NormalCurrentElectrode {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "outward_current_density_Apm2")]
        outward_current_density_apm2: f64,
    },
    Insulating {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
    },
}

impl ChargeBoundaryIR {
    pub fn id(&self) -> &str {
        match self {
            Self::VoltageElectrode { id, .. }
            | Self::NormalCurrentElectrode { id, .. }
            | Self::Insulating { id, .. } => id,
        }
    }

    pub fn surfaces(&self) -> &[SurfaceRefIR] {
        match self {
            Self::VoltageElectrode { surfaces, .. }
            | Self::NormalCurrentElectrode { surfaces, .. }
            | Self::Insulating { surfaces, .. } => surfaces,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChargePotentialGaugeIR {
    DirichletReference,
    ZeroMean,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeSolverPolicyIR {
    pub engine: String,
    pub linear: LinearTransportSolverPolicyIR,
    pub physical_residual_version: String,
    pub operator_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinTransportModuleIR {
    pub schema_version: String,
    pub id: String,
    pub current_source_id: String,
    pub mode: SpinTransportModeIR,
    pub domain: Vec<RegionRefIR>,
    pub materials: Vec<SpinTransportMaterialAssignmentIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<SpinInterfaceIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundaries: Vec<SpinBoundaryIR>,
    pub solver: SpinSolverPolicyIR,
    pub requested_execution: RequestedTransportExecutionIR,
    pub constitutive_version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpinTransportModeIR {
    Steady,
    Transient,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoupledSpinIntegratorIR {
    CoupledImexArk2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinTransportMaterialAssignmentIR {
    pub region: RegionRefIR,
    pub material: SpinTransportMaterialIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinTransportMaterialIR {
    #[serde(rename = "sigma_s_Spm")]
    pub sigma_s_spm: f64,
    pub polarization_p: f64,
    pub theta_sh: f64,
    pub lambda_sf_m: f64,
    pub lambda_j_m: ReactionLengthIR,
    pub lambda_phi_m: ReactionLengthIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "spin_capacitance_As_per_V_m3")]
    pub spin_capacitance_as_per_v_m3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacitance_formula_version: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "density_of_states_per_spin_Jinv_m3"
    )]
    pub density_of_states_per_spin_j_inv_m3: Option<f64>,
}

impl SpinTransportMaterialIR {
    pub fn resolved_spin_capacitance_as_per_v_m3(&self) -> Option<f64> {
        self.spin_capacitance_as_per_v_m3.or_else(|| {
            self.density_of_states_per_spin_j_inv_m3
                .map(crate::spin_capacitance_from_density_of_states)
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ReactionLengthIR {
    Enabled(f64),
    Disabled(DisabledReactionIR),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DisabledReactionIR {
    #[serde(rename = "disabled")]
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpinInterfaceIR {
    Transparent {
        id: String,
        side_a: RegionRefIR,
        side_b: RegionRefIR,
        normal_a_to_b: [f64; 3],
    },
    MixingConductance {
        id: String,
        normal_to_ferromagnet: [f64; 3],
        normal_side: RegionRefIR,
        ferromagnet_side: RegionRefIR,
        #[serde(rename = "g_up_Spm2")]
        g_up_spm2: f64,
        #[serde(rename = "g_down_Spm2")]
        g_down_spm2: f64,
        #[serde(rename = "g_r_Spm2")]
        g_r_spm2: f64,
        #[serde(rename = "g_i_Spm2")]
        g_i_spm2: f64,
        #[serde(default, skip_serializing_if = "is_zero_f64", rename = "g_sml_Spm2")]
        g_sml_spm2: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spin_memory_loss: Option<SpinMemoryLossReservoirIR>,
        absorption: String,
        formula_version: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpinBoundaryIR {
    SpinInsulating {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
    },
    SpinSink {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
    },
    SpecifiedSpinPotential {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "spin_potential_V")]
        spin_potential_v: [f64; 3],
    },
    SpecifiedSpinFlux {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "normal_spin_flux_Apm2")]
        normal_spin_flux_apm2: [f64; 3],
    },
    PeriodicSpin {
        id: String,
        minus_surface: SurfaceRefIR,
        plus_surface: SurfaceRefIR,
        translation_m: [f64; 3],
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinearTransportSolverPolicyIR {
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinSolverPolicyIR {
    pub engine: String,
    pub linear: LinearTransportSolverPolicyIR,
    pub physical_residual_version: String,
    pub operator_version: String,
    pub default_external_boundary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reciprocal_nonlinear: Option<ReciprocalNonlinearSolverPolicyIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReciprocalNonlinearSolverPolicyIR {
    pub gmres_restart: u32,
    pub max_picard_iterations: u32,
    pub relative_update_tolerance: f64,
    pub eta_transport: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestedTransportExecutionIR {
    pub discretization: crate::BackendTarget,
    pub device: ExecutionDevice,
    pub precision: ExecutionPrecision,
    pub execution_mode: ExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinTransportPlanIR {
    pub module_id: String,
    pub current_source_id: String,
    pub resolved_coupling: TransportCouplingIR,
    pub requested_execution: RequestedTransportExecutionIR,
    pub resolved_discretization: crate::BackendTarget,
    pub resolved_device: ExecutionDevice,
    pub resolved_precision: ExecutionPrecision,
    pub constitutive_version: String,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub capabilities: Vec<String>,
    pub inserted_default_boundaries: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_double: Option<ResolvedFdmSpinTransportIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_double_reciprocal: Option<ResolvedFdmCoupledSpinTransportIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_double_transient: Option<ResolvedFdmTransientSpinTransportIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_cpu_double: Option<ResolvedFemSpinTransportIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemSpinTransportIR {
    pub descriptor_schema: String,
    pub charge_definition: ChargeTransportDefinitionIR,
    /// Authored charge-source envelope copied from the owning current module.
    /// It is evaluated at every native stage; it is not a solver tolerance or
    /// a post-hoc field scaling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_envelope: Option<crate::TimeEnvelopeIR>,
    pub charge_domain: ResolvedFemTransportDomainIR,
    pub spin_domain: ResolvedFemTransportDomainIR,
    pub charge_insulating_boundaries: Vec<ResolvedFemBoundaryMarkerSetIR>,
    pub spin_insulating_boundaries: Vec<ResolvedFemBoundaryMarkerSetIR>,
    pub interfaces: Vec<ResolvedFemTransportInterfaceIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torque_target: Option<ResolvedFemTorqueTargetIR>,
    pub charge_conductivity_spm_per_element: Vec<f64>,
    pub charge_gauge: ChargePotentialGaugeIR,
    pub charge_solver: ChargeSolverPolicyIR,
    pub charge_dirichlet: Vec<(u32, f64)>,
    pub spin_dirichlet: Vec<(u32, [f64; 3])>,
    #[serde(rename = "sigma_s_Spm")]
    pub sigma_s_spm: f64,
    /// Present only for the bounded reciprocal FEM M2 reference lane.  The
    /// native FEM ABI currently accepts one uniform anisotropic charge tensor
    /// over the conforming solve domain; elementwise `sigma_spm` remains in
    /// `charge_conductivity_spm_per_element`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reciprocal_material: Option<ResolvedReciprocalMaterialIR>,
    pub polarization_p: f64,
    pub theta_sh: f64,
    pub lambda_sf_m: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lambda_j_m: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lambda_phi_m: Option<f64>,
    pub saturation_magnetization_apm: f64,
    pub gamma_e_rad_per_s_t: f64,
    pub spin_solver: SpinSolverPolicyIR,
    pub resolved_charge_engine: String,
    pub resolved_spin_engine: String,
    pub interface_law: String,
    pub interface_realization: String,
    pub stage_coupling: String,
    pub capability_status: String,
    pub implementation_state: String,
    pub validation_state: String,
    pub validation_scope: String,
    /// The named steady charge solution is consumed by a bounded FEM
    /// midpoint-Biot--Savart Oersted realization.  This is deliberately a
    /// descriptor bit rather than a copied current field: the runtime must
    /// solve charge first and derive the magnetic field from that result.
    #[serde(default)]
    pub oersted_source_bound: bool,
    /// Optional closure-aware solved-current request.  `None` is the legacy
    /// H1/P1 nodal reference lane; it must never be interpreted as an RT0
    /// view by the runner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_view: Option<ResolvedFemConservativeCurrentViewIR>,
}

/// Stable identity pinned to one accepted/stage charge solve.  These values
/// are semantic inputs to the native RT0 adapter and are deliberately kept in
/// the resolved plan rather than reconstructed by the runner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentIdentityIR {
    pub source_module_id: String,
    pub source_state_revision: String,
    pub source_field_digest: String,
    pub conductivity_digest: String,
    pub mesh_revision: String,
    pub topology_revision: String,
    pub geometry_digest: String,
    pub envelope_revision: String,
    pub envelope_digest: String,
    pub evaluated_envelope_multiplier: f64,
    pub evaluation_time_s: f64,
    pub stage_identity: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentPinsIR {
    pub required_source_state_revision: String,
    pub required_source_field_digest: String,
    pub required_mesh_revision: String,
    pub required_topology_revision: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConservativeCurrentBoundaryRoleIR {
    InsulatingOuter,
    SourceCut,
    ClosureInterface,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentBoundaryFaceIR {
    pub face_vertex_ids: [u64; 3],
    pub role: ConservativeCurrentBoundaryRoleIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circuit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentSourceCutFacePairIR {
    pub minus_face_vertex_ids: [u64; 3],
    pub plus_face_vertex_ids: [u64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentSourceCutIR {
    pub id: String,
    pub translation_m: [f64; 3],
    pub potential_drop_v: f64,
    pub face_pairs: Vec<ConservativeCurrentSourceCutFacePairIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConservativeCurrentClosureIR {
    ClosedGeometry {
        operator_version: String,
        revision: String,
        digest: String,
        source_cuts: Vec<ConservativeCurrentSourceCutIR>,
    },
    ExternalLead {
        operator_version: String,
        revision: String,
        digest: String,
        drive_id: String,
        outer_electrode_potential_drop_v: f64,
        lead_mesh: MeshIR,
        lead_conductivity_spm_per_element: Vec<f64>,
        lead_stable_vertex_ids: Vec<u64>,
        interface_pairs: Vec<([u64; 3], [u64; 3])>,
        minus_outer_electrode_face_vertex_ids: Vec<[u64; 3]>,
        plus_outer_electrode_face_vertex_ids: Vec<[u64; 3]>,
        lead_conductivity_digest: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemConservativeCurrentViewIR {
    pub stable_vertex_ids: Vec<u64>,
    pub boundary_faces: Vec<ConservativeCurrentBoundaryFaceIR>,
    pub identity: ConservativeCurrentIdentityIR,
    pub pins: ConservativeCurrentPinsIR,
    pub closure: ConservativeCurrentClosureIR,
    pub algebraic_relative_tolerance: f64,
    pub physical_relative_gate: f64,
    pub physical_absolute_gate_a: f64,
    #[serde(default)]
    pub reference_mpi_gather_broadcast: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemTransportDomainIR {
    pub regions: Vec<RegionRefIR>,
    pub element_mask: Vec<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedFemBoundaryMarkerSetIR {
    pub id: String,
    pub boundary_attributes: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemTransportInterfaceIR {
    pub id: String,
    pub side_a: RegionRefIR,
    pub side_b: RegionRefIR,
    pub normal_a_to_b: [f64; 3],
    pub law: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemTorqueTargetIR {
    pub torque_module_id: String,
    pub target: RegionRefIR,
    pub element_mask: Vec<bool>,
    pub formula_version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum StructuredBoundaryFaceIR {
    XMin,
    XMax,
    YMin,
    YMax,
    ZMin,
    ZMax,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StructuredInternalFaceIR {
    pub axis: u8,
    pub negative_cell: u64,
    pub positive_cell: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedChargeBoundaryConditionIR {
    Voltage {
        #[serde(rename = "potential_V")]
        potential_v: f64,
    },
    OutwardNormalCurrentDensity {
        #[serde(rename = "current_density_Apm2")]
        current_density_apm2: f64,
    },
    Insulating,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedChargeBoundaryFaceIR {
    pub source_id: String,
    pub face: StructuredBoundaryFaceIR,
    pub condition: ResolvedChargeBoundaryConditionIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpecifiedCurrentFaceIR {
    pub source_id: String,
    pub axis: u8,
    pub face_index: u64,
    pub adjacent_cell: u64,
    pub outward_normal_sign: i8,
    pub area_m2: f64,
    #[serde(rename = "outward_current_density_Apm2")]
    pub outward_current_density_apm2: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedSpinBoundaryConditionIR {
    SpinInsulating,
    SpinSink,
    SpecifiedPotential {
        #[serde(rename = "value_V")]
        value_v: [f64; 3],
    },
    SpecifiedOutwardFlux {
        #[serde(rename = "value_Apm2")]
        value_apm2: [f64; 3],
    },
    PeriodicSpin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinBoundaryFaceIR {
    pub source_id: String,
    pub face: StructuredBoundaryFaceIR,
    pub condition: ResolvedSpinBoundaryConditionIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedSpinInterfaceLawIR {
    Transparent,
    MixingConductance {
        #[serde(rename = "g_up_Spm2")]
        g_up_spm2: f64,
        #[serde(rename = "g_down_Spm2")]
        g_down_spm2: f64,
        #[serde(rename = "g_r_Spm2")]
        g_r_spm2: f64,
        #[serde(rename = "g_i_Spm2")]
        g_i_spm2: f64,
        #[serde(default, skip_serializing_if = "is_zero_f64", rename = "g_sml_Spm2")]
        g_sml_spm2: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spin_memory_loss: Option<SpinMemoryLossReservoirIR>,
        formula_version: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinInterfaceFaceIR {
    pub source_id: String,
    pub face: StructuredInternalFaceIR,
    pub from_cell: u64,
    pub to_cell: u64,
    pub law: ResolvedSpinInterfaceLawIR,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinReactionLengthsIR {
    pub spin_flip_m: Option<f64>,
    pub exchange_m: Option<f64>,
    pub dephasing_m: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FdmCpuTransportRealizationIR {
    #[default]
    RustReferenceV1,
    NativeM1V1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmSpinTransportIR {
    pub descriptor_schema: String,
    #[serde(default)]
    pub realization: FdmCpuTransportRealizationIR,
    /// Global validation/execution profile enclosing this resolved module.
    /// Missing legacy data defaults to `extended`, so strict native lanes fail closed.
    #[serde(default = "default_transport_enclosing_execution_mode")]
    pub enclosing_execution_mode: ExecutionMode,
    /// Authored dimensionless charge-source multiplier evaluated at each FDM
    /// transport stage.  `None` means the source is constant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_envelope: Option<crate::TimeEnvelopeIR>,
    pub charge_active_cells: Vec<bool>,
    #[serde(rename = "charge_conductivity_Spm")]
    pub charge_conductivity_spm: Vec<f64>,
    pub charge_boundaries: Vec<ResolvedChargeBoundaryFaceIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub specified_current_faces: Vec<ResolvedSpecifiedCurrentFaceIR>,
    pub charge_gauge: ChargePotentialGaugeIR,
    pub charge_solver: ChargeSolverPolicyIR,
    pub spin_active_cells: Vec<bool>,
    #[serde(rename = "spin_conductivity_Spm")]
    pub spin_conductivity_spm: Vec<f64>,
    pub polarization_p: Vec<f64>,
    pub theta_sh: Vec<f64>,
    pub reactions: Vec<ResolvedSpinReactionLengthsIR>,
    pub region_ids: Vec<u32>,
    pub spin_boundaries: Vec<ResolvedSpinBoundaryFaceIR>,
    pub interfaces: Vec<ResolvedSpinInterfaceFaceIR>,
    pub torque_target_cells: Vec<bool>,
    #[serde(rename = "saturation_magnetization_Apm")]
    pub saturation_magnetization_apm: Vec<f64>,
    #[serde(rename = "gamma_e_rad_per_s_T")]
    pub gamma_e_rad_per_s_t: f64,
    pub spin_solver: SpinSolverPolicyIR,
    pub torque_formula_version: Option<String>,
    pub oersted_source_bound: bool,
}

fn default_transport_enclosing_execution_mode() -> ExecutionMode {
    ExecutionMode::Extended
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmTransientSpinTransportIR {
    pub descriptor_schema: String,
    pub steady_operator: ResolvedFdmSpinTransportIR,
    #[serde(rename = "spin_capacitance_As_per_V_m3")]
    pub spin_capacitance_as_per_v_m3: Vec<f64>,
    pub capacitance_formula_versions: Vec<String>,
    pub transient_formula_version: String,
    pub integrator: CoupledSpinIntegratorIR,
    pub integrator_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedReciprocalMaterialIR {
    #[serde(rename = "sigma_Spm")]
    pub sigma_spm: f64,
    #[serde(rename = "sigma_spin_Spm")]
    pub sigma_spin_spm: f64,
    #[serde(rename = "sigma_parallel_Spm")]
    pub sigma_parallel_spm: f64,
    #[serde(rename = "sigma_perpendicular_Spm")]
    pub sigma_perpendicular_spm: f64,
    #[serde(rename = "sigma_AHE_Spm")]
    pub sigma_ahe_spm: f64,
    pub polarization_p: f64,
    pub theta_sh: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmCoupledSpinTransportIR {
    pub descriptor_schema: String,
    /// Authored charge-source envelope evaluated at each coupled transport
    /// stage.  It scales only prescribed charge drives; the reciprocal
    /// constitutive solve still uses the stage magnetization to determine
    /// `J_c(m_stage)` and the resulting spin torque.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_envelope: Option<crate::TimeEnvelopeIR>,
    pub active_cells: Vec<bool>,
    pub reciprocal_materials: Vec<ResolvedReciprocalMaterialIR>,
    pub reactions: Vec<ResolvedSpinReactionLengthsIR>,
    pub region_ids: Vec<u32>,
    pub charge_boundaries: Vec<ResolvedChargeBoundaryFaceIR>,
    pub spin_boundaries: Vec<ResolvedSpinBoundaryFaceIR>,
    pub interfaces: Vec<ResolvedSpinInterfaceFaceIR>,
    pub torque_target_cells: Vec<bool>,
    #[serde(rename = "saturation_magnetization_Apm")]
    pub saturation_magnetization_apm: Vec<f64>,
    #[serde(rename = "gamma_e_rad_per_s_T")]
    pub gamma_e_rad_per_s_t: f64,
    pub linear_solver: LinearTransportSolverPolicyIR,
    pub nonlinear_solver: ReciprocalNonlinearSolverPolicyIR,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub constitutive_version: String,
    pub torque_formula_version: Option<String>,
    pub oersted_source_bound: bool,
}
