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
}
