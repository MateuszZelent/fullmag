use crate::{ExecutionDevice, ExecutionMode, ExecutionPrecision, RegionRefIR};
use serde::{Deserialize, Serialize};

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
pub struct ChargeTransportDefinitionIR {
    pub domain: Vec<RegionRefIR>,
    pub materials: Vec<ChargeTransportMaterialAssignmentIR>,
    pub boundaries: Vec<ChargeBoundaryIR>,
    pub gauge: ChargePotentialGaugeIR,
    pub solver: ChargeSolverPolicyIR,
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
        #[serde(rename = "g_sml_Spm2")]
        g_sml_spm2: f64,
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
    pub charge_conductivity_spm_per_element: Vec<f64>,
    pub charge_gauge: ChargePotentialGaugeIR,
    pub charge_solver: ChargeSolverPolicyIR,
    pub charge_dirichlet: Vec<(u32, f64)>,
    pub spin_dirichlet: Vec<(u32, [f64; 3])>,
    #[serde(rename = "sigma_s_Spm")]
    pub sigma_s_spm: f64,
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
    pub implementation_state: String,
    pub validation_state: String,
    pub validation_scope: String,
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
        #[serde(rename = "g_sml_Spm2")]
        g_sml_spm2: f64,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmSpinTransportIR {
    pub descriptor_schema: String,
    pub charge_active_cells: Vec<bool>,
    #[serde(rename = "charge_conductivity_Spm")]
    pub charge_conductivity_spm: Vec<f64>,
    pub charge_boundaries: Vec<ResolvedChargeBoundaryFaceIR>,
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
