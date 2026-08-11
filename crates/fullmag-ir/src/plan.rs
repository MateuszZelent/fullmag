#[allow(unused_imports)]
use crate::{
    AdaptiveTimeStepIR, AntennaSpatialProfileIR, BackendTarget, CurrentModuleIR, DomainFrameIR,
    EigenDampingPolicyIR, EigenNormalizationIR, EigenOperatorConfigIR, EigenTargetIR,
    EquilibriumSourceIR, ExchangeBoundaryCondition, ExecutionMode, ExecutionPrecision,
    FdmDemagPeriodicityIR, FdmMultilayerPlanIR, FdmPeriodicityIR, FemDomainMeshAssetIR,
    FemLinearSolverPolicy, FemSharedDomainBuildReportIR, FieldRefreshPolicyIR,
    FrequencyExcitationIR, FrequencyResponseNormalizationIR, FrequencySweepIR, GeometryEntryIR,
    IntegratorChoice, KSamplingIR, MagnetostrictionLawIR, MaterialFieldLocationIR, MaterialIR,
    MaterialParameterNameIR, MechanicalBoundaryConditionIR, MechanicalLoadIR, MeshIR,
    ModeTrackingIR, OerstedRealization, OutputIR, PrescribedSotV1DriveIR, RegionRefIR,
    RegionalFieldDriveIR, RelaxStopIR, RelaxationAlgorithmIR, ResolvedFdmGpuChargeTransportIR,
    ResolvedPeriodicImagesIR, ResolvedSpinTransportPlanIR, SeedPolicy, SpinWaveBoundaryConditionIR,
    ThermalSeedConfig, TimeDependenceIR, TimeEnvelopeIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionPlanSummary {
    pub requested_backend: BackendTarget,
    pub resolved_backend: BackendTarget,
    pub execution_mode: ExecutionMode,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionPlanIR {
    pub common: CommonPlanMeta,
    pub backend_plan: BackendPlanIR,
    pub output_plan: OutputPlanIR,
    pub provenance: ProvenancePlanIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommonPlanMeta {
    pub ir_version: String,
    pub requested_backend: BackendTarget,
    pub resolved_backend: BackendTarget,
    pub execution_mode: ExecutionMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_field_plans: Vec<MaterialFieldPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendPlanIR {
    Fdm(FdmPlanIR),
    FdmMultilayer(FdmMultilayerPlanIR),
    Fem(FemPlanIR),
    FemEigen(FemEigenPlanIR),
    FemFrequencyResponse(FemFrequencyResponsePlanIR),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct GridDimensions {
    pub cells: [u32; 3],
}

/// Immutable description of one resolved FDM grid realization.
///
/// The certificate records resolved geometry-to-grid facts.  It is deliberately
/// separate from the requested discretization hints and from any PBC policy;
/// PBC, when present, is part of the identity of this same grid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGridCertificateIR {
    /// Lower world-space corner of the grid [m].
    pub origin_m: [f64; 3],
    /// Number of cells in each axis.
    pub counts: [u32; 3],
    /// Cell edge lengths [m].
    pub cell_m: [f64; 3],
    /// Realized extent `L_i = N_i d_i` [m].
    pub extent_m: [f64; 3],
    /// Number of active magnetic cells in the realized mask.
    pub active_cells: u64,
    /// Planner memory estimate [bytes].
    pub estimated_bytes: u64,
    /// SHA-256 of the canonical resolved grid payload, lowercase hex.
    pub grid_fingerprint: String,
    /// Deterministic legend for numeric region IDs in `FdmPlanIR.region_mask`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_legend: Vec<FdmRegionLegendEntryIR>,
    /// Canonical object identities represented by this single-grid realization.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_ids: Vec<String>,
    /// SHA-256 of the canonical region legend, when a realized region mask exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_legend_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmRegionLegendEntryIR {
    pub numeric_id: u32,
    pub object_id: String,
    pub region_id: String,
    pub priority: i32,
}

impl FdmGridCertificateIR {
    /// Build and validate a certificate from resolved planner facts.
    pub fn new(
        origin_m: [f64; 3],
        counts: [u32; 3],
        cell_m: [f64; 3],
        active_cells: u64,
        estimated_bytes: u64,
    ) -> Result<Self, String> {
        Self::new_with_masks(
            origin_m,
            counts,
            cell_m,
            active_cells,
            estimated_bytes,
            None,
            &[],
        )
    }

    /// Build a certificate including the resolved active/region topology.
    pub fn new_with_masks(
        origin_m: [f64; 3],
        counts: [u32; 3],
        cell_m: [f64; 3],
        active_cells: u64,
        estimated_bytes: u64,
        active_mask: Option<&[bool]>,
        region_mask: &[u32],
    ) -> Result<Self, String> {
        crate::validate_fdm_region_lut_indices(region_mask, &[])?;
        Self::new_with_payload(
            origin_m,
            counts,
            cell_m,
            active_cells,
            estimated_bytes,
            active_mask,
            region_mask,
        )
    }

    /// Build a certificate fingerprinting multilayer topology tokens rather than
    /// the bounded native FDM region LUT payload.
    pub fn new_with_topology_tokens(
        origin_m: [f64; 3],
        counts: [u32; 3],
        cell_m: [f64; 3],
        active_cells: u64,
        estimated_bytes: u64,
        active_mask: Option<&[bool]>,
        topology_tokens: &[u32],
    ) -> Result<Self, String> {
        Self::new_with_payload(
            origin_m,
            counts,
            cell_m,
            active_cells,
            estimated_bytes,
            active_mask,
            topology_tokens,
        )
    }

    fn new_with_payload(
        origin_m: [f64; 3],
        counts: [u32; 3],
        cell_m: [f64; 3],
        active_cells: u64,
        estimated_bytes: u64,
        active_mask: Option<&[bool]>,
        payload: &[u32],
    ) -> Result<Self, String> {
        let extent_m: [f64; 3] = std::array::from_fn(|axis| counts[axis] as f64 * cell_m[axis]);
        let grid_fingerprint = Self::fingerprint_for(
            origin_m,
            counts,
            cell_m,
            extent_m,
            active_mask.unwrap_or(&[]),
            payload,
        )?;
        let certificate = Self {
            origin_m,
            counts,
            cell_m,
            extent_m,
            active_cells,
            estimated_bytes,
            grid_fingerprint,
            region_legend: Vec::new(),
            object_ids: Vec::new(),
            region_legend_fingerprint: None,
        };
        certificate.validate()?;
        Ok(certificate)
    }

    /// Attach a canonical realized-region legend without changing the grid
    /// topology fingerprint. The legend has its own identity so membership
    /// edits cannot be mistaken for a geometry-only cache hit.
    pub fn with_region_legend(mut self, legend: Vec<FdmRegionLegendEntryIR>) -> Self {
        let payload = serde_json::to_vec(&legend).unwrap_or_default();
        self.region_legend_fingerprint = Some(format!("sha256:{:x}", Sha256::digest(payload)));
        self.region_legend = legend;
        self
    }

    /// Attach the canonical object aliases represented by the active-cell mask.
    pub fn with_object_ids(mut self, mut object_ids: Vec<String>) -> Self {
        object_ids.sort();
        object_ids.dedup();
        self.object_ids = object_ids;
        self
    }

    /// Validate intrinsic consistency before a runner consumes the certificate.
    pub fn validate(&self) -> Result<(), String> {
        if self
            .origin_m
            .iter()
            .chain(self.cell_m.iter())
            .chain(self.extent_m.iter())
            .any(|value| !value.is_finite())
        {
            return Err("FDM grid certificate contains a non-finite coordinate".to_string());
        }
        if self.counts.iter().any(|count| *count == 0) {
            return Err(format!(
                "FDM grid certificate counts must be positive, got {:?}",
                self.counts
            ));
        }
        if self.cell_m.iter().any(|cell| *cell <= 0.0) {
            return Err(format!(
                "FDM grid certificate cell sizes must be positive, got {:?}",
                self.cell_m
            ));
        }
        let total_cells = (self.counts[0] as u64)
            .checked_mul(self.counts[1] as u64)
            .and_then(|value| value.checked_mul(self.counts[2] as u64))
            .ok_or_else(|| "FDM grid certificate cell count overflows u64".to_string())?;
        if self.active_cells > total_cells {
            return Err(format!(
                "FDM grid certificate active_cells={} exceeds total_cells={total_cells}",
                self.active_cells
            ));
        }
        if self.estimated_bytes == 0 {
            return Err("FDM grid certificate estimated_bytes must be positive".to_string());
        }
        for axis in 0..3 {
            let expected = self.counts[axis] as f64 * self.cell_m[axis];
            let tolerance = 1.0e-12 * expected.abs().max(1.0e-30);
            if (self.extent_m[axis] - expected).abs() > tolerance {
                return Err(format!(
                    "FDM grid certificate extent_m[{axis}]={} disagrees with N*d={expected}",
                    self.extent_m[axis]
                ));
            }
        }
        if self.grid_fingerprint.len() != 64
            || !self
                .grid_fingerprint
                .chars()
                .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
        {
            return Err(format!(
                "FDM grid certificate fingerprint must be 64 lowercase hexadecimal characters, got {}",
                self.grid_fingerprint
            ));
        }
        Ok(())
    }

    /// Validate the certificate against the exact resolved topology payload.
    pub fn validate_against_masks(
        &self,
        active_mask: Option<&[bool]>,
        region_mask: &[u32],
    ) -> Result<(), String> {
        crate::validate_fdm_region_lut_indices(region_mask, &[])?;
        self.validate_region_legend(region_mask)?;
        self.validate_against_payload(active_mask, region_mask)
    }

    /// Ensure realized numeric region IDs can be decoded without relying on
    /// planner-local ordering or an implicit fallback.  ID zero is reserved
    /// for the unassigned/background cell state; authored regions are
    /// represented by contiguous IDs starting at one.
    pub fn validate_region_legend(&self, region_mask: &[u32]) -> Result<(), String> {
        let max_id = region_mask.iter().copied().max().unwrap_or(0);
        if max_id == 0 && self.region_legend.is_empty() {
            return Ok(());
        }
        if self.region_legend.is_empty() {
            return Err(
                "FDM region mask contains authored numeric IDs but region legend is missing"
                    .to_string(),
            );
        }
        for (index, entry) in self.region_legend.iter().enumerate() {
            let expected_id = u32::try_from(index + 1)
                .map_err(|_| "FDM region legend exceeds u32 numeric ID space".to_string())?;
            if entry.numeric_id != expected_id {
                return Err(format!(
                    "FDM region legend numeric IDs must be contiguous starting at 1, expected {}, got {}",
                    expected_id, entry.numeric_id
                ));
            }
            if entry.object_id.is_empty() || entry.region_id.is_empty() {
                return Err(format!(
                    "FDM region legend entry {} must include object_id and region_id",
                    entry.numeric_id
                ));
            }
            if self.region_legend[..index].iter().any(|previous| {
                previous.object_id == entry.object_id && previous.region_id == entry.region_id
            }) {
                return Err(format!(
                    "FDM region legend contains duplicate authored region {}:{}",
                    entry.object_id, entry.region_id
                ));
            }
        }
        if max_id > self.region_legend.len() as u32 {
            return Err(format!(
                "FDM region mask numeric ID {} has no legend entry (legend_len={})",
                max_id,
                self.region_legend.len()
            ));
        }
        Ok(())
    }

    /// Validate a certificate against multilayer topology tokens.
    pub fn validate_against_topology_tokens(
        &self,
        active_mask: Option<&[bool]>,
        topology_tokens: &[u32],
    ) -> Result<(), String> {
        self.validate_against_payload(active_mask, topology_tokens)
    }

    fn validate_against_payload(
        &self,
        active_mask: Option<&[bool]>,
        payload: &[u32],
    ) -> Result<(), String> {
        self.validate()?;
        let expected_fingerprint = Self::fingerprint_for(
            self.origin_m,
            self.counts,
            self.cell_m,
            self.extent_m,
            active_mask.unwrap_or(&[]),
            payload,
        )?;
        if self.grid_fingerprint != expected_fingerprint {
            return Err(format!(
                "FDM grid certificate fingerprint mismatch: expected {expected_fingerprint}, got {}",
                self.grid_fingerprint
            ));
        }
        if let Some(mask) = active_mask {
            let active_cells = mask.iter().filter(|active| **active).count() as u64;
            if self.active_cells != active_cells {
                return Err(format!(
                    "FDM grid certificate active count mismatch: certificate={} resolved={active_cells}",
                    self.active_cells
                ));
            }
        }
        Ok(())
    }

    fn fingerprint_for(
        origin_m: [f64; 3],
        counts: [u32; 3],
        cell_m: [f64; 3],
        extent_m: [f64; 3],
        active_mask: &[bool],
        region_mask: &[u32],
    ) -> Result<String, String> {
        let payload = serde_json::json!({
            "origin_m": origin_m,
            "counts": counts,
            "cell_m": cell_m,
            "extent_m": extent_m,
            "active_mask": active_mask,
            "region_mask": region_mask,
        });
        let encoded = serde_json::to_vec(&payload).map_err(|error| {
            format!("FDM grid certificate fingerprint serialization failed: {error}")
        })?;
        Ok(Sha256::digest(encoded)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedAntennaZeemanMaskIR {
    pub source: String,
    pub object: String,
    pub amplitude_b_t: f64,
    pub direction: [f64; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial_profile: Option<AntennaSpatialProfileIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<TimeDependenceIR>,
    /// Resolved antenna Zeeman field in A/m at backend sample locations.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_xyz: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedRegionalFieldDriveBasisIR {
    pub drive: RegionalFieldDriveIR,
    /// Immutable cell-wise field basis in A/m. The waveform is evaluated by
    /// the integrator at every RK stage and never folded into this vector.
    pub field_xyz: Vec<[f64; 3]>,
    pub projection_signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TimeStageContextIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_stage_id: Option<String>,
    #[serde(default)]
    pub start_time_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FdmPlanIR {
    /// Physical world-space origin of the resolved FDM grid (lower corner), in metres.
    ///
    /// The planner owns this value; runners and artifacts must consume it rather
    /// than reconstructing an origin from the grid extent.
    #[serde(default)]
    pub origin_m: [f64; 3],
    pub grid: GridDimensions,
    pub cell_size: [f64; 3],
    /// Validated certificate for this resolved geometry-to-grid realization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_certificate: Option<FdmGridCertificateIR>,
    pub region_mask: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mask: Option<Vec<bool>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spin_transport_plans: Vec<ResolvedSpinTransportPlanIR>,
    /// Bounded standalone FDM CUDA charge-only realizations. The public M1
    /// slice currently permits at most one entry; a vector keeps the resolved
    /// plan aligned with module-owned current semantics.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fdm_gpu_charge_transports: Vec<ResolvedFdmGpuChargeTransportIR>,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub material: FdmMaterialIR,
    pub enable_exchange: bool,
    pub enable_demag: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub antenna_zeeman_masks: Vec<ResolvedAntennaZeemanMaskIR>,
    /// Canonical regional time-domain magnetic drives. Legacy antenna masks
    /// remain migration-only and must not be populated for the same source.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_drives: Vec<RegionalFieldDriveIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regional_field_drive_bases: Vec<ResolvedRegionalFieldDriveBasisIR>,
    #[serde(default)]
    pub time_stage: TimeStageContextIR,
    /// Explicit inter-region exchange coupling overrides.
    /// Each entry `(region_i, region_j, A_ij)` sets the exchange stiffness [J/m]
    /// between regions i and j (symmetric: A_ij = A_ji). When a region mask is
    /// present and this list is empty, native FDM uses the backend default
    /// exchange-pair mode. Current region-owned semantics require harmonic mean
    /// by default; free surfaces must be explicit disabled/zero-scale pair
    /// semantics in the resolved runtime contract.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inter_region_exchange: Vec<(u32, u32, f64)>,
    pub gyromagnetic_ratio: f64,
    pub precision: ExecutionPrecision,
    pub exchange_bc: ExchangeBoundaryCondition,
    /// Periodic boundary conditions configuration.
    /// `None` means fully open (no PBC), equivalent to `axes: [Open, Open, Open]`.
    /// See `docs/physics/0600-periodic-boundary-conditions.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub periodicity: Option<FdmPeriodicityIR>,
    /// Planner-resolved periodic image/padding budget consumed by runtime
    /// allocators; requested periodicity remains in `periodicity` above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_periodic_images: Option<ResolvedPeriodicImagesIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrator: Option<IntegratorChoice>,
    pub fixed_timestep: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_timestep: Option<AdaptiveTimeStepIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_refresh: Option<FieldRefreshPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaxation: Option<RelaxationControlIR>,
    /// Boundary correction tier: "none" | "volume" (T0) | "full" (T1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_correction: Option<String>,
    /// Minimum volume fraction for numerical stability (clamps φ_eff >= phi_floor).
    /// Default in backend: 0.05.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_phi_floor: Option<f64>,
    /// Minimum intersection distance δ for T1 ECB stencil stability [cells].
    /// Default in backend: 0.0 (no clamping).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_delta_min: Option<f64>,
    /// Sub-cell geometry data (computed by planner when boundary_correction is set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_geometry: Option<BoundaryGeometryIR>,
    /// Global current density for Zhang-Li STT [A/m^2]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_density: Option<[f64; 3]>,
    /// Spin polarization degree for Zhang-Li STT (P)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_degree: Option<f64>,
    /// Non-adiabaticity parameter for Zhang-Li STT (beta)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_beta: Option<f64>,
    /// Versioned Zhang-Li formula selected by the planner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zhang_li_formula_version: Option<String>,
    /// Versioned Zhang-Li spatial/operator realization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zhang_li_operator_version: Option<String>,
    /// Authored Zhang-Li target retained for execution provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zhang_li_target: Option<RegionRefIR>,
    /// Explicit Landé factor for canonical Zhang-Li formulas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zhang_li_lande_g: Option<f64>,

    /// Fixed spin polarization vector for Slonczewski STT (p)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_spin_polarization: Option<[f64; 3]>,
    /// Slonczewski asymmetry parameter (Lambda)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_lambda: Option<f64>,
    /// Slonczewski secondary spin-transfer term (epsilon')
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_epsilon_prime: Option<f64>,
    /// Slonczewski free-layer thickness [m]. When None, engine defaults to cell_dz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_thickness: Option<f64>,
    /// Slonczewski fixed-layer position: "top" or "bottom". Controls current sign.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_fixed_layer_position: Option<String>,
    /// Versioned Slonczewski evaluator identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slonczewski_formula_version: Option<String>,
    /// Independent signed-current stack normal for canonical Slonczewski v1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slonczewski_stack_normal: Option<[f64; 3]>,
    /// Canonical authored target retained in the execution plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slonczewski_target: Option<RegionRefIR>,
    /// Resolved FDM cells selected by the canonical target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slonczewski_active_mask: Option<Vec<bool>>,

    // ── Spin-Orbit Torque (SOT) ────────────────────────
    /// Prescribed-SOT source current density [A/m²]: signed for v1, raw legacy scalar for v0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_current_density: Option<f64>,
    /// Damping-like efficiency ξ_DL (≈ spin Hall angle θ_SH)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_xi_dl: Option<f64>,
    /// Field-like efficiency ξ_FL (Rashba term, often ~0)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_xi_fl: Option<f64>,
    /// Spin polarisation unit vector σ̂ (normalised at runtime)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_sigma: Option<[f64; 3]>,
    /// FM layer thickness t_F [m] (for SOT amplitude)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_thickness: Option<f64>,
    /// Versioned prescribed-SOT formula selected by the planner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_formula_version: Option<String>,
    /// Authored target retained for provenance and runtime inspection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_target: Option<crate::RegionRefIR>,
    /// Per-cell target mask for prescribed SOT, intersected with `active_mask`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_active_mask: Option<Vec<bool>>,
    /// Exact authored dimensionless source envelope; source amplitude remains in `sot_current_density`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_envelope: Option<crate::TimeEnvelopeIR>,
    /// Exact canonical v1 authored drive identity and axes retained for provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_drive: Option<crate::PrescribedSotV1DriveIR>,

    // ── Oersted field (cylindrical conductor) ──
    /// Whether to include the Oersted field from a cylindrical conductor.
    #[serde(default)]
    pub has_oersted_cylinder: bool,
    /// DC current [A] for Oersted computation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_current: Option<f64>,
    /// Cylinder radius [m].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_radius: Option<f64>,
    /// Cross-section centre [m].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_center: Option<[f64; 3]>,
    /// Current-flow axis (unit vector).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_axis: Option<[f64; 3]>,
    /// Plan-only per-cell Oersted field used by generalized FDM lowering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_field_xyz: Option<Vec<[f64; 3]>>,
    /// Time-dependence kind: 0=constant, 1=sinusoidal, 2=pulse
    #[serde(default)]
    pub oersted_time_dep_kind: u32,
    /// Sinusoidal: frequency [Hz]
    #[serde(default)]
    pub oersted_time_dep_freq: f64,
    /// Sinusoidal: phase [rad]
    #[serde(default)]
    pub oersted_time_dep_phase: f64,
    /// Sinusoidal: offset
    #[serde(default)]
    pub oersted_time_dep_offset: f64,
    /// Pulse: t_on [s]
    #[serde(default)]
    pub oersted_time_dep_t_on: f64,
    /// Pulse: t_off [s]
    #[serde(default)]
    pub oersted_time_dep_t_off: f64,
    /// Oersted field realization model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_realization: Option<OerstedRealization>,

    /// Temperature in Kelvin for Brown thermal field (sLLG). None or 0 = no thermal noise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Resolved stochastic seed policy for Brown thermal noise.
    ///
    /// A missing value means thermal noise is disabled.  When temperature is
    /// enabled without an explicit `ThermalNoise` term, the planner records
    /// `SystemEntropy` here so the requested policy remains observable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thermal_seed_config: Option<ThermalSeedConfig>,

    // ── Dzyaloshinskii-Moriya interaction ──
    /// Interfacial DMI constant D [J/m²]. None = disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfacial_dmi: Option<f64>,
    /// Bulk (Bloch) DMI constant D [J/m³]. None = disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dind_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dbulk_field: Option<Vec<f64>>,

    // ── Magnetoelastic coupling (prescribed strain) ──
    /// First magnetoelastic coupling constant B₁ [Pa]. None = disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mel_b1: Option<f64>,
    /// Second magnetoelastic coupling constant B₂ [Pa].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mel_b2: Option<f64>,
    /// Uniform prescribed strain tensor in Voigt order [ε₁₁, ε₂₂, ε₃₃, 2ε₂₃, 2ε₁₃, 2ε₁₂].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mel_uniform_strain: Option<[f64; 6]>,
}

/// Sub-cell boundary geometry arrays computed from SDF during planning.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BoundaryGeometryIR {
    /// Per-cell volume fraction φ ∈ [0,1], length = cell_count.
    pub volume_fraction: Vec<f64>,
    /// Face-link fractions per direction, each length = cell_count.
    pub face_link_xp: Vec<f64>,
    pub face_link_xm: Vec<f64>,
    pub face_link_yp: Vec<f64>,
    pub face_link_ym: Vec<f64>,
    pub face_link_zp: Vec<f64>,
    pub face_link_zm: Vec<f64>,
    /// Intersection distances per direction (T1 only), each length = cell_count.
    pub delta_xp: Vec<f64>,
    pub delta_xm: Vec<f64>,
    pub delta_yp: Vec<f64>,
    pub delta_ym: Vec<f64>,
    pub delta_zp: Vec<f64>,
    pub delta_zm: Vec<f64>,
    /// Sparse demag correction data (T0+T1).
    #[serde(default)]
    pub demag_corr_target_idx: Vec<i32>,
    #[serde(default)]
    pub demag_corr_source_idx: Vec<i32>,
    #[serde(default)]
    pub demag_corr_tensor: Vec<f64>,
    #[serde(default)]
    pub demag_corr_stencil_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FdmMaterialIR {
    pub name: String,
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha_field: Option<Vec<f64>>,
    // ── Uniaxial anisotropy ──
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uniaxial_anisotropy_ku1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uniaxial_anisotropy_ku2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anisotropy_axis: Option<[f64; 3]>,
    // ── Cubic anisotropy ──
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_kc3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_axis1: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cubic_anisotropy_axis2: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemObjectSegmentIR {
    pub object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    pub node_start: u32,
    pub node_count: u32,
    pub element_start: u32,
    pub element_count: u32,
    pub boundary_face_start: u32,
    pub boundary_face_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemMeshPartRole {
    Air,
    MagneticObject,
    Interface,
    OuterBoundary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FemMeshPartSelector {
    ElementMarkerSet { markers: Vec<u32> },
    ElementRange { start: u32, count: u32 },
    BoundaryFaceRange { start: u32, count: u32 },
    NodeRange { start: u32, count: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMeshPartIR {
    pub id: String,
    pub label: String,
    pub role: FemMeshPartRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_id: Option<String>,
    pub element_selector: FemMeshPartSelector,
    pub boundary_face_selector: FemMeshPartSelector,
    pub node_selector: FemMeshPartSelector,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_face_indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facet_global_ordinals: Vec<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemRegionMaterialIR {
    pub object_id: String,
    pub material: MaterialIR,
    pub element_marker: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemSpinTorquePlanIR {
    pub formula_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RegionRefIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_normal: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lande_g: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_node_mask: Option<Vec<bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_element_mask: Option<Vec<bool>>,
    /// Prescribed-SOT signed source current density [A/m²]. These fields are
    /// populated when `formula_version` is `prescribed_sot.fullmag.v1`; STT
    /// contracts leave them empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_current_density: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_xi_dl: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_xi_fl: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_sigma: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_thickness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_envelope: Option<TimeEnvelopeIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sot_drive: Option<PrescribedSotV1DriveIR>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemDomainMeshModeIR {
    #[default]
    MergedMagneticMesh,
    SharedDomainMeshWithAir,
}

/// What the user/script requested for FEM demagnetization realization.
///
/// `Auto` lets the planner choose a Poisson realization based on
/// shared-domain mesh metadata and explicit boundary policy.
///
/// Phase-1A: extended to multi-model hierarchy. The serde representation
/// stays as simple strings for backward compatibility with existing Python
/// scripts. The model concept (airbox/BEM/FK/FMM) is expressed through the
/// variant names. Fredkin-Koehler is the executable body-only FEM/BEM path;
/// generic BEM/FMM remain future variants rejected by the planner.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestedFemDemagIR {
    #[default]
    Auto,
    /// Airbox Poisson with u=0 BC (COMSOL Dirichlet style).
    #[serde(alias = "airbox_dirichlet")]
    PoissonDirichlet,
    /// Airbox Poisson with Robin BC (default airbox variant).
    #[serde(alias = "poisson_airbox", alias = "airbox_robin", alias = "airbox")]
    PoissonRobin,
    /// Boundary Element Method (tetmag-style). Body-only mesh.
    /// Not yet implemented — planner will reject.
    Bem,
    /// Fredkin–Koehler FEM/BEM hybrid (TetraX-style). Body-only mesh.
    /// Executable through the native FEM dense-reference FEM/BEM path.
    FredkinKoehler,
    /// Fast Multipole Method. Body-only mesh.
    /// Not yet implemented — planner will reject.
    Fmm,
}

impl RequestedFemDemagIR {
    /// Whether this request requires a shared-domain mesh with air elements.
    pub fn requires_airbox(&self) -> bool {
        match self {
            Self::Auto | Self::PoissonDirichlet | Self::PoissonRobin => true,
            Self::Bem | Self::FredkinKoehler | Self::Fmm => false,
        }
    }

    /// Whether this demag model is currently implemented.
    pub fn is_implemented(&self) -> bool {
        match self {
            Self::Auto | Self::PoissonDirichlet | Self::PoissonRobin | Self::FredkinKoehler => true,
            Self::Bem | Self::Fmm => false,
        }
    }

    /// User-facing model name.
    pub fn model_name(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::PoissonDirichlet | Self::PoissonRobin => "airbox",
            Self::Bem => "bem",
            Self::FredkinKoehler => "fredkin_koehler",
            Self::Fmm => "fmm",
        }
    }

    /// Normalize: identity (no legacy aliases to collapse in the flat enum).
    pub fn normalized(self) -> Self {
        self
    }
}

/// Planner-resolved FEM demagnetization realization. No `Auto` variant —
/// must be concrete before reaching the runner.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedFemDemagIR {
    #[serde(alias = "airbox_dirichlet")]
    PoissonDirichlet,
    #[serde(alias = "poisson_airbox", alias = "airbox_robin")]
    PoissonRobin,
    /// Future: BEM-resolved (not yet implemented).
    Bem,
    /// Fredkin–Koehler FEM/BEM-resolved body-only demag.
    FredkinKoehler,
    /// Future: FMM-resolved (not yet implemented).
    Fmm,
}

impl ResolvedFemDemagIR {
    /// Canonical provenance name for artifact metadata.
    pub fn provenance_name(&self) -> &'static str {
        match self {
            Self::PoissonDirichlet => "fem_poisson_dirichlet",
            Self::PoissonRobin => "fem_poisson_robin",
            Self::Bem => "fem_bem",
            Self::FredkinKoehler => "fem_fredkin_koehler",
            Self::Fmm => "fem_fmm",
        }
    }

    /// Whether this realization uses a Poisson-based airbox solver.
    pub fn is_poisson(&self) -> bool {
        matches!(self, Self::PoissonDirichlet | Self::PoissonRobin)
    }

    /// Whether this realization uses Robin boundary conditions.
    pub fn is_robin(&self) -> bool {
        matches!(self, Self::PoissonRobin)
    }

    /// Whether this realization requires a shared-domain mesh with air.
    pub fn requires_airbox(&self) -> bool {
        matches!(self, Self::PoissonDirichlet | Self::PoissonRobin)
    }

    /// Whether this realization is currently implemented in the backend.
    pub fn is_implemented(&self) -> bool {
        matches!(
            self,
            Self::PoissonDirichlet | Self::PoissonRobin | Self::FredkinKoehler
        )
    }

    /// User-facing model name.
    pub fn model_name(&self) -> &'static str {
        match self {
            Self::PoissonDirichlet | Self::PoissonRobin => "airbox",
            Self::Bem => "bem",
            Self::FredkinKoehler => "fredkin_koehler",
            Self::Fmm => "fmm",
        }
    }
}

/// Canonical FEM mesh-topology family preserved in plan provenance.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemMeshTopologyFamilyIR {
    MixedP1,
}

/// Capability status of a requested mixed-P1 FEM execution lane.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemMixedTopologyCapabilityStatusIR {
    Unsupported,
    SourceVisible,
    SemanticOnly,
    ReferenceExecutable,
    DevelopmentExecutable,
    PartialProductionExecutable,
    Implemented,
    ProductionExecutable,
    Validated,
}

/// Requested and resolved execution identity bound to an accepted mixed-mesh certificate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FemMixedTopologyProvenanceIR {
    pub requested_topology: FemMeshTopologyFamilyIR,
    pub resolved_topology: FemMeshTopologyFamilyIR,
    pub accepted_certificate_fingerprint: String,
    pub requested_device: crate::ExecutionDevice,
    pub precision: ExecutionPrecision,
    pub capability_status: FemMixedTopologyCapabilityStatusIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemPlanIR {
    pub mesh_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    pub mesh: MeshIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_segments: Vec<FemObjectSegmentIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_parts: Vec<FemMeshPartIR>,
    /// Immutable report describing the requested and realized mesh build.
    /// This is scoped to this plan's mesh generation and is not session status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_build_report: Option<FemSharedDomainBuildReportIR>,
    #[serde(default)]
    pub domain_mesh_mode: FemDomainMeshModeIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_frame: Option<DomainFrameIR>,
    pub fe_order: u32,
    pub hmax: f64,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub material: MaterialIR,
    /// FEM-only realized nodal uniaxial anisotropy axes. Empty means use
    /// `material.anisotropy_axis` as a uniform axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anisotropy_axis_field: Option<Vec<[f64; 3]>>,
    /// FEM-only discontinuous per-element saturation magnetization coefficients [A/m].
    /// Used for conformal authored regions that share one magnetization field but need
    /// sharp material jumps across domain markers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms_element_field: Option<Vec<f64>>,
    /// FEM-only discontinuous per-element exchange stiffness coefficients [J/m].
    /// Used for conformal authored regions that share one magnetization field but need
    /// sharp material jumps across domain markers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a_element_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_materials: Vec<FemRegionMaterialIR>,
    pub enable_exchange: bool,
    pub enable_demag: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub antenna_zeeman_masks: Vec<ResolvedAntennaZeemanMaskIR>,
    /// Canonical regional time-domain magnetic drives. Native FEM resolves
    /// their spatial basis against the realized mesh.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_drives: Vec<RegionalFieldDriveIR>,
    /// Closed geometry trees referenced by regional-drive geometry masks.
    /// Native FEM consumes these descriptors and owns spatial projection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_drive_geometry_masks: Vec<GeometryEntryIR>,
    #[serde(default)]
    pub time_stage: TimeStageContextIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub current_modules: Vec<CurrentModuleIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spin_transport_plans: Vec<ResolvedSpinTransportPlanIR>,
    pub gyromagnetic_ratio: f64,
    pub precision: ExecutionPrecision,
    pub exchange_bc: ExchangeBoundaryCondition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrator: Option<IntegratorChoice>,
    pub fixed_timestep: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_timestep: Option<AdaptiveTimeStepIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_refresh: Option<FieldRefreshPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaxation: Option<RelaxationControlIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_realization: Option<ResolvedFemDemagIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_box_config: Option<AirBoxConfigIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfacial_dmi: Option<f64>,
    /// Interface normal direction for interfacial DMI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dmi_interface_normal: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dind_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dbulk_field: Option<Vec<f64>>,
    /// Temperature in Kelvin for thermal noise (0 = no thermal noise)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,

    /// Global current density for Zhang-Li STT [A/m^2]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_density: Option<[f64; 3]>,
    /// Spin polarization degree for Zhang-Li STT (P)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_degree: Option<f64>,
    /// Non-adiabaticity parameter for Zhang-Li STT (beta)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_beta: Option<f64>,

    /// Fixed spin polarization vector for Slonczewski STT (p)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_spin_polarization: Option<[f64; 3]>,
    /// Slonczewski asymmetry parameter (Lambda)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_lambda: Option<f64>,
    /// Slonczewski secondary spin-transfer term (epsilon')
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_epsilon_prime: Option<f64>,
    /// Slonczewski free-layer thickness [m]. When None, engine defaults to cell_dz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_thickness: Option<f64>,
    /// Slonczewski fixed-layer position: "top" or "bottom". Controls current sign.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_fixed_layer_position: Option<String>,
    /// Versioned FEM spin-torque formula, target and discrete realization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spin_torque_contract: Option<FemSpinTorquePlanIR>,

    /// Oersted field from cylindrical conductor
    #[serde(default)]
    pub has_oersted_cylinder: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_current: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_axis: Option<[f64; 3]>,
    /// Plan-only per-node Oersted field used by generalized FEM lowering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_field_xyz: Option<Vec<f64>>,
    #[serde(default)]
    pub oersted_time_dep_kind: u32,
    #[serde(default)]
    pub oersted_time_dep_freq: f64,
    #[serde(default)]
    pub oersted_time_dep_phase: f64,
    #[serde(default)]
    pub oersted_time_dep_offset: f64,
    #[serde(default)]
    pub oersted_time_dep_t_on: f64,
    #[serde(default)]
    pub oersted_time_dep_t_off: f64,

    /// Prescribed-strain magnetoelastic coupling
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetoelastic: Option<FemMagnetoelasticPlanIR>,

    /// Mechanics contract for magnetoelastic execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mechanics: Option<FemMechanicalPlanIR>,

    /// Policy for the demag linear solver (CG+AMG etc.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_solver_policy: Option<FemLinearSolverPolicy>,

    /// Seed/stochastic policy for thermal noise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thermal_seed_config: Option<ThermalSeedConfig>,

    /// Oersted field realization model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_realization: Option<OerstedRealization>,

    /// FEM-029 fix: explicit GPU device index. `None` means use env / default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_device_index: Option<i32>,

    /// FEM-030 fix: explicit MFEM device string (e.g. "ceed-cuda:/gpu/cuda/shared", "cuda", "cpu").
    /// `None` means use env var `FULLMAG_FEM_MFEM_DEVICE` or compiled-in default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mfem_device_string: Option<String>,

    /// FND-013: use consistent (full) mass matrix for exchange instead of lumped.
    /// `None` or `false` = lumped (default), `true` = consistent (CG solve).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_consistent_mass: Option<bool>,
}

/// Prescribed-strain magnetoelastic coupling plan for FEM backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMagnetoelasticPlanIR {
    /// First magnetoelastic coupling constant B₁ [Pa].
    pub b1: f64,
    /// Second magnetoelastic coupling constant B₂ [Pa].
    pub b2: f64,
    /// Prescribed strain in Voigt notation [ε₁₁, ε₂₂, ε₃₃, 2ε₂₃, 2ε₁₃, 2ε₁₂].
    /// If Some, treated as uniform strain across the entire body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prescribed_strain: Option<[f64; 6]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemMechanicalModeIR {
    PrescribedStrain,
    QuasistaticElasticity,
    Elastodynamics,
}

/// Self-contained native FEM mechanics contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMechanicalPlanIR {
    pub mode: FemMechanicalModeIR,
    pub body: crate::ElasticBodyIR,
    pub elastic_material: crate::ElasticMaterialIR,
    pub magnetostriction_law: MagnetostrictionLawIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_conditions: Vec<MechanicalBoundaryConditionIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loads: Vec<MechanicalLoadIR>,
    #[serde(default)]
    pub same_mesh_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_picard_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picard_tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mechanical_dt: Option<f64>,
}

fn default_de_bv_dispersion_max_relative_error() -> f64 {
    0.10
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemEigenDispersionValidationWindowIR {
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemEigenDispersionValidationScenarioIR {
    pub geometry: String,
    pub branch_id: String,
    pub sample_indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemEigenDispersionValidationIR {
    pub kind: String,
    pub analytic_model: String,
    pub film_thickness_m: f64,
    pub equilibrium_magnetization: [f64; 3],
    pub film_normal: [f64; 3],
    pub frequency_window_hz: FemEigenDispersionValidationWindowIR,
    pub max_k_rad_per_m: f64,
    #[serde(default = "default_de_bv_dispersion_max_relative_error")]
    pub max_relative_error: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scenarios: Vec<FemEigenDispersionValidationScenarioIR>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FemEigenK0KittelValidationMaterialIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_magnetisation: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemEigenK0KittelValidationSampleIR {
    pub sample_index: u32,
    pub bias_field: [f64; 3],
}

fn default_k0_kittel_relative_tolerance() -> f64 {
    0.05
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemEigenK0KittelValidationIR {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_kind: Option<String>,
    pub model: String,
    pub field_units: String,
    #[serde(default = "default_k0_kittel_relative_tolerance")]
    pub relative_tolerance: f64,
    #[serde(default)]
    pub material: FemEigenK0KittelValidationMaterialIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub samples: Vec<FemEigenK0KittelValidationSampleIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemEigenPlanIR {
    pub mesh_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    pub mesh: MeshIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_segments: Vec<FemObjectSegmentIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_parts: Vec<FemMeshPartIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_build_report: Option<FemSharedDomainBuildReportIR>,
    #[serde(default)]
    pub domain_mesh_mode: FemDomainMeshModeIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_frame: Option<DomainFrameIR>,
    pub fe_order: u32,
    pub hmax: f64,
    pub equilibrium_magnetization: Vec<[f64; 3]>,
    pub material: MaterialIR,
    pub operator: EigenOperatorConfigIR,
    pub count: u32,
    pub target: EigenTargetIR,
    pub equilibrium: EquilibriumSourceIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k_sampling: Option<KSamplingIR>,
    pub normalization: EigenNormalizationIR,
    pub damping_policy: EigenDampingPolicyIR,
    pub enable_exchange: bool,
    pub enable_demag: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfacial_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dmi_interface_normal: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_dmi: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    pub gyromagnetic_ratio: f64,
    pub precision: ExecutionPrecision,
    pub exchange_bc: ExchangeBoundaryCondition,
    /// Spin-wave boundary condition. Legacy values (`free`, `pinned`, `periodic`)
    /// remain supported for backward compatibility; structured configs enable
    /// richer boundary metadata such as periodic pair ids and surface terms.
    #[serde(default)]
    pub spin_wave_bc: SpinWaveBoundaryConditionIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_realization: Option<ResolvedFemDemagIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_box_config: Option<AirBoxConfigIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_tracking: Option<ModeTrackingIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispersion_validation: Option<FemEigenDispersionValidationIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k0_kittel_validation: Option<FemEigenK0KittelValidationIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemFrequencyResponsePlanIR {
    pub mesh_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    pub mesh: MeshIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_segments: Vec<FemObjectSegmentIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_parts: Vec<FemMeshPartIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_build_report: Option<FemSharedDomainBuildReportIR>,
    #[serde(default)]
    pub domain_mesh_mode: FemDomainMeshModeIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_mesh_workflow_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_frame: Option<DomainFrameIR>,
    pub fe_order: u32,
    pub hmax: f64,
    pub equilibrium_magnetization: Vec<[f64; 3]>,
    pub material: MaterialIR,
    pub operator: EigenOperatorConfigIR,
    pub equilibrium: EquilibriumSourceIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k_sampling: Option<KSamplingIR>,
    pub normalization: FrequencyResponseNormalizationIR,
    pub damping_policy: EigenDampingPolicyIR,
    #[serde(default)]
    pub spin_wave_bc: SpinWaveBoundaryConditionIR,
    #[serde(default)]
    pub magnetostatic_bc: crate::MagnetostaticBoundaryConditionIR,
    pub excitation: FrequencyExcitationIR,
    pub frequencies_hz: FrequencySweepIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solver_policy: Option<crate::FrequencyResponseSolverPolicyIR>,
    pub enable_exchange: bool,
    pub enable_demag: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfacial_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dmi_interface_normal: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_dmi: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    pub gyromagnetic_ratio: f64,
    pub precision: ExecutionPrecision,
    #[serde(default)]
    pub requested_device: crate::ExecutionDevice,
    pub exchange_bc: ExchangeBoundaryCondition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_realization: Option<ResolvedFemDemagIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_box_config: Option<AirBoxConfigIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_solver_policy: Option<FemLinearSolverPolicy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_constraint_sets: Vec<PeriodicConstraintSetIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equilibrium_provenance: Option<FemFrequencyDomainEquilibriumProvenanceIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemFrequencyDomainEquilibriumProvenanceIR {
    pub schema_version: String,
    pub acceptance_gate: String,
    pub accepted: bool,
    pub source_kind: String,
    pub source_artifact_root: String,
    pub equilibrium_field_path: String,
    pub seam_diagnostics_path: String,
    pub z_padding_report_path: String,
    pub supercell_report_path: String,
    pub magnetostatic_bc: String,
    pub pbc_axes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeriodicUnknownFamilyIR {
    MagnetizationStatic,
    MagnetizationDynamic,
    MagnetostaticPotentialStatic,
    MagnetostaticPotentialDynamic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeriodicDomainScopeIR {
    MagneticDomain,
    MagnetostaticDomainWithAir,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PeriodicPhasePolicyIR {
    ZeroPhase,
    BlochPhase {
        phase_convention: crate::PhaseConventionIR,
        k_vector_rad_per_m: [f64; 3],
        real_imag_mixing: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeriodicPhaseLoopDiagnosticsIR {
    pub checked_loop_count: u64,
    pub max_phase_loop_residual_rad: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeriodicConstraintSetIR {
    pub unknown_family: PeriodicUnknownFamilyIR,
    pub domain_scope: PeriodicDomainScopeIR,
    pub pair_ids: Vec<String>,
    pub phase_policy: PeriodicPhasePolicyIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_loop_diagnostics: Option<PeriodicPhaseLoopDiagnosticsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AirBoxConfigIR {
    pub factor: f64,
    pub grading: f64,
    pub boundary_marker: u32,
    /// Boundary condition kind: `"dirichlet"` or `"robin"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bc_kind: Option<String>,
    /// Robin beta mode: `"legacy"` (c=1), `"dipole"` (c=2), `"user"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub robin_beta_mode: Option<String>,
    /// User-specified c in β = c/R*.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub robin_beta_factor: Option<f64>,
    /// Airbox shape: `"bbox"` or `"sphere"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    /// How the air-box factor was derived: `"user"`, `"study_universe"`, `"mesh_auto"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor_source: Option<String>,
    /// How the boundary marker was selected: `"certified_gamma_out"` or `"user_policy"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_marker_source: Option<String>,
}

/// User-configurable policy for air-box construction.
/// Any field left as `None` will use the planner's default heuristic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AirBoxPolicyIR {
    /// Mesh grading factor for the air-box region (default: 1.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grading: Option<f64>,
    /// Explicit boundary marker to use for the air-box outer surface.
    /// If `None`, the planner picks marker 99 or the mesh maximum.
    /// In executable strict mode, planners may require this value to be set
    /// and refuse heuristic marker selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_marker: Option<u32>,
    /// Robin beta mode override: `"legacy"`, `"dipole"`, or `"user"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub robin_beta_mode: Option<String>,
    /// Robin beta factor override (c in β = c/R*).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub robin_beta_factor: Option<f64>,
    /// Air-box shape override: `"bbox"` or `"sphere"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelaxationControlIR {
    pub algorithm: RelaxationAlgorithmIR,
    pub stop: RelaxStopIR,
}

impl RelaxationControlIR {
    pub fn torque_tolerance_apm(&self) -> Option<f64> {
        self.stop.torque_tolerance_apm
    }

    pub fn energy_tolerance_j(&self) -> Option<f64> {
        self.stop.energy_tolerance_j
    }

    pub fn max_steps(&self) -> Option<u64> {
        self.stop.max_steps
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutputPlanIR {
    pub outputs: Vec<OutputIR>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestedIntegratorIR {
    Auto,
    Heun,
    Rk4,
    Rk23,
    Rk45,
    Abm3,
}

impl RequestedIntegratorIR {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Heun => "heun",
            Self::Rk4 => "rk4",
            Self::Rk23 => "rk23",
            Self::Rk45 => "rk45",
            Self::Abm3 => "abm3",
        }
    }
}

impl From<IntegratorChoice> for RequestedIntegratorIR {
    fn from(value: IntegratorChoice) -> Self {
        match value {
            IntegratorChoice::Heun => Self::Heun,
            IntegratorChoice::Rk4 => Self::Rk4,
            IntegratorChoice::Rk23 => Self::Rk23,
            IntegratorChoice::Rk45 => Self::Rk45,
            IntegratorChoice::Abm3 => Self::Abm3,
        }
    }
}

/// Canonical record of the authored time-integrator choice and planner result.
///
/// `requested_integrator` retains `auto`; `resolved_integrator` is the concrete
/// choice consumed by an execution backend. Neither field describes a backend
/// implementation detail.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IntegratorResolutionProvenanceIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_integrator: Option<RequestedIntegratorIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_integrator: Option<IntegratorChoice>,
}

/// Versioned, typed provenance for the normalized physics graph carried by a
/// resolved execution plan.  This is intentionally separate from backend
/// solver telemetry: it records authored graph identity and lane resolution
/// before a runner realizes operators on a concrete mesh/grid.
pub const PHYSICS_GRAPH_RUNTIME_PROVENANCE_SCHEMA: &str = "physics_graph.runtime.v1";

/// Versioned certificate for the transition from semantic graph scope to the
/// concrete topology consumed by one backend lane.  A runtime plan may carry
/// semantic marker/mask identities even when this certificate is absent; that
/// distinction is deliberate and prevents a planner identity from being
/// mistaken for an element/cell realization.
pub const PHYSICS_GRAPH_REALIZATION_SCHEMA: &str = "physics_graph.realization.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhysicsGraphRealizationStateIR {
    /// The authored scope could not be mapped unambiguously to the resolved
    /// mesh/grid.  The semantic module remains visible, but no backend mask is
    /// legal to consume.
    SemanticOnly,
    /// The authored scope was mapped to concrete marker/cell identities in the
    /// resolved plan.  This is a resolution proof, not an execution proof.
    Resolved,
    /// The backend emitted an execution record for the module in this run.
    /// This state is written only after the solver returns a matching runtime
    /// observation; it is never inferred from planning alone.
    Executed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhysicsGraphModuleRealizationIR {
    pub module_id: String,
    pub state: PhysicsGraphRealizationStateIR,
    /// Fingerprint of the exact mesh/grid used for this resolution.
    pub topology_fingerprint: String,
    /// Concrete FEM element markers selected by the module scope.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub realized_fem_marker_ids: Vec<u32>,
    /// Digest of the concrete FDM cell mask selected by the module scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_fdm_mask_digest: Option<String>,
    /// Number of active cells/elements selected by the concrete scope.
    pub realized_cell_count: u64,
    /// Numeric FDM region IDs consumed by the selected mask, when applicable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub realized_fdm_region_ids: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhysicsGraphRealizationProvenanceIR {
    pub schema_version: String,
    pub topology_fingerprint: String,
    pub resolved_module_ids: Vec<String>,
    /// Empty during planning.  The runner replaces this with an observed set
    /// only after the corresponding backend execution record is available.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executed_module_ids: Vec<String>,
    pub modules: Vec<PhysicsGraphModuleRealizationIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhysicsGraphRuntimeProvenanceIR {
    pub schema_version: String,
    pub graph_sha256: String,
    pub scene_revision: u64,
    pub mesh_revision: u64,
    pub requested_lane: BackendTarget,
    pub resolved_lane: BackendTarget,
    pub modules: Vec<PhysicsGraphModuleProvenanceIR>,
    /// Concrete mesh/grid realization.  This is optional for compatibility
    /// with pre-certificate plan artifacts and becomes required by the runner
    /// for newly planned graph-bearing executions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization: Option<PhysicsGraphRealizationProvenanceIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhysicsGraphModuleProvenanceIR {
    pub module_id: String,
    pub kind: String,
    /// Canonical, order-independent scope identity (for example
    /// `object:free-layer` or `cross_object:fixed,free`).
    pub scope: String,
    pub status: String,
    pub depends_on: Vec<String>,
    pub requested_lane: BackendTarget,
    pub resolved_lane: BackendTarget,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fem_marker_ids: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cell_mask_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProvenancePlanIR {
    pub notes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrator_resolution: Option<IntegratorResolutionProvenanceIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physics_graph: Option<PhysicsGraphRuntimeProvenanceIR>,
}

#[cfg(test)]
mod tests {
    use super::{
        FdmGridCertificateIR, FdmPlanIR, FdmRegionLegendEntryIR, FemMeshTopologyFamilyIR,
        FemMixedTopologyCapabilityStatusIR, FemMixedTopologyProvenanceIR, RequestedFemDemagIR,
        ResolvedFemDemagIR,
    };
    use crate::{
        validate_fdm_region_lut_indices, ExecutionDevice, ExecutionPrecision, MAX_FDM_REGION_IDS,
    };

    #[test]
    fn legacy_fdm_plan_defaults_gpu_charge_transports_to_empty() {
        let encoded = serde_json::to_value(FdmPlanIR::default()).expect("FDM plan serializes");
        assert!(encoded.get("fdm_gpu_charge_transports").is_none());
        let decoded: FdmPlanIR =
            serde_json::from_value(encoded).expect("legacy FDM plan deserializes");
        assert!(decoded.fdm_gpu_charge_transports.is_empty());
    }

    #[test]
    fn fem_mixed_topology_provenance_round_trips_typed_execution_contract() {
        let provenance = FemMixedTopologyProvenanceIR {
            requested_topology: FemMeshTopologyFamilyIR::MixedP1,
            resolved_topology: FemMeshTopologyFamilyIR::MixedP1,
            accepted_certificate_fingerprint: format!("sha256:{}", "a".repeat(64)),
            requested_device: ExecutionDevice::Auto,
            precision: ExecutionPrecision::Double,
            capability_status: FemMixedTopologyCapabilityStatusIR::Unsupported,
        };

        let encoded = serde_json::to_value(&provenance).expect("provenance serializes");
        assert_eq!(encoded["requested_topology"], "mixed_p1");
        assert_eq!(encoded["resolved_topology"], "mixed_p1");
        assert_eq!(encoded["requested_device"], "auto");
        assert_eq!(encoded["precision"], "double");
        assert_eq!(encoded["capability_status"], "unsupported");
        assert_eq!(
            encoded["accepted_certificate_fingerprint"],
            format!("sha256:{}", "a".repeat(64))
        );

        let decoded: FemMixedTopologyProvenanceIR =
            serde_json::from_value(encoded.clone()).expect("provenance deserializes");
        assert_eq!(decoded, provenance);
    }

    #[test]
    fn fredkin_koehler_demag_is_body_only_and_executable() {
        assert!(!RequestedFemDemagIR::FredkinKoehler.requires_airbox());
        assert!(RequestedFemDemagIR::FredkinKoehler.is_implemented());
        assert!(!ResolvedFemDemagIR::FredkinKoehler.requires_airbox());
        assert!(ResolvedFemDemagIR::FredkinKoehler.is_implemented());
        assert_eq!(
            ResolvedFemDemagIR::FredkinKoehler.provenance_name(),
            "fem_fredkin_koehler"
        );
    }

    #[test]
    fn generic_bem_and_fmm_remain_future_models() {
        assert!(!RequestedFemDemagIR::Bem.requires_airbox());
        assert!(!RequestedFemDemagIR::Bem.is_implemented());
        assert!(!RequestedFemDemagIR::Fmm.requires_airbox());
        assert!(!RequestedFemDemagIR::Fmm.is_implemented());
    }

    #[test]
    fn fdm_grid_certificate_round_trips_and_enforces_extent() {
        let certificate = FdmGridCertificateIR::new(
            [-2.0e-9, 0.0, 1.0e-9],
            [4, 3, 2],
            [1.0e-9, 2.0e-9, 3.0e-9],
            17,
            4_096,
        )
        .expect("resolved grid certificate should validate");
        let encoded = serde_json::to_vec(&certificate).expect("certificate serializes");
        let decoded: FdmGridCertificateIR =
            serde_json::from_slice(&encoded).expect("certificate deserializes");
        assert_eq!(decoded, certificate);

        let mut invalid = certificate.clone();
        invalid.extent_m[0] += 1.0e-12;
        let error = invalid.validate().expect_err("N*d mismatch must reject");
        assert!(error.contains("extent_m[0]"));
    }

    #[test]
    fn fdm_grid_certificate_rejects_active_count_and_fingerprint_tampering() {
        let certificate = FdmGridCertificateIR::new([0.0; 3], [2, 2, 1], [1.0e-9; 3], 3, 1_024)
            .expect("resolved grid certificate should validate");
        let mut active_invalid = certificate.clone();
        active_invalid.active_cells = 5;
        assert!(active_invalid
            .validate()
            .expect_err("active count beyond grid must reject")
            .contains("active_cells"));

        let mut hash_invalid = certificate;
        hash_invalid.grid_fingerprint.replace_range(..2, "00");
        assert!(hash_invalid
            .validate_against_masks(None, &[])
            .expect_err("fingerprint tampering must reject")
            .contains("fingerprint mismatch"));

        let topology_certificate = FdmGridCertificateIR::new_with_masks(
            [0.0; 3],
            [2, 2, 1],
            [1.0e-9; 3],
            2,
            1_024,
            Some(&[true, false, true, false]),
            &[1, 1, 2, 2],
        )
        .expect("topology certificate should validate")
        .with_region_legend(vec![
            FdmRegionLegendEntryIR {
                numeric_id: 1,
                object_id: "magnet-a".to_string(),
                region_id: "magnet-a:core".to_string(),
                priority: 0,
            },
            FdmRegionLegendEntryIR {
                numeric_id: 2,
                object_id: "magnet-b".to_string(),
                region_id: "magnet-b:core".to_string(),
                priority: 0,
            },
        ]);
        assert!(topology_certificate
            .validate_against_masks(Some(&[false, true, true, false]), &[1, 1, 2, 2])
            .expect_err("active topology swap must reject")
            .contains("fingerprint mismatch"));
    }

    #[test]
    fn fdm_grid_certificate_binds_deterministic_region_legend() {
        let certificate = FdmGridCertificateIR::new([0.0; 3], [2, 2, 1], [1.0e-9; 3], 2, 1_024)
            .expect("resolved grid certificate should validate")
            .with_region_legend(vec![FdmRegionLegendEntryIR {
                numeric_id: 1,
                object_id: "magnet".to_string(),
                region_id: "magnet:core".to_string(),
                priority: 0,
            }]);
        assert_eq!(certificate.region_legend.len(), 1);
        assert!(certificate
            .region_legend_fingerprint
            .as_deref()
            .is_some_and(|value| value.starts_with("sha256:")));
        let changed = certificate
            .clone()
            .with_region_legend(vec![FdmRegionLegendEntryIR {
                numeric_id: 1,
                object_id: "magnet".to_string(),
                region_id: "magnet:shell".to_string(),
                priority: 0,
            }]);
        assert_ne!(
            certificate.region_legend_fingerprint,
            changed.region_legend_fingerprint
        );
    }

    #[test]
    fn fdm_grid_certificate_rejects_unlisted_realized_region_id() {
        let certificate = FdmGridCertificateIR::new_with_masks(
            [0.0; 3],
            [2, 1, 1],
            [1.0e-9; 3],
            2,
            1_024,
            None,
            &[1, 2],
        )
        .expect("resolved grid certificate should validate")
        .with_region_legend(vec![FdmRegionLegendEntryIR {
            numeric_id: 1,
            object_id: "magnet".to_string(),
            region_id: "magnet:core".to_string(),
            priority: 0,
        }]);
        let error = certificate
            .validate_against_masks(None, &[1, 2])
            .expect_err("unknown realized region ID must fail closed");
        assert!(error.contains("has no legend entry"));
    }

    #[test]
    fn fdm_grid_certificate_rejects_realized_region_mask_without_legend() {
        let certificate = FdmGridCertificateIR::new_with_masks(
            [0.0; 3],
            [2, 1, 1],
            [1.0e-9; 3],
            2,
            1_024,
            None,
            &[1, 1],
        )
        .expect("resolved grid certificate should validate");
        let error = certificate
            .validate_against_masks(None, &[1, 1])
            .expect_err("realized region mask without legend must fail closed");
        assert!(error.contains("region legend is missing"));
    }

    #[test]
    fn fdm_region_lut_accepts_boundary_id_and_rejects_256() {
        validate_fdm_region_lut_indices(&[0, MAX_FDM_REGION_IDS], &[])
            .expect("id 255 is the last addressable non-background region");
        let error = validate_fdm_region_lut_indices(&[0, MAX_FDM_REGION_IDS + 1], &[])
            .expect_err("id 256 would index past the 256-entry LUT");
        assert!(error.contains("fdm_region_lut_capacity_exceeded"));
        assert!(error.contains("requested_region_id=256"));
    }

    #[test]
    fn fdm_region_lut_rejects_out_of_range_exchange_pair() {
        let error = validate_fdm_region_lut_indices(&[1, 2], &[(1, MAX_FDM_REGION_IDS + 1, 1.0)])
            .expect_err("exchange pair ids must use the same LUT bound");
        assert!(error.contains("exchange_pair_index=0"));
        assert!(error.contains("supported_region_ids=255"));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaterialFieldPlan {
    pub object_id: String,
    pub parameter: MaterialParameterNameIR,
    pub source_kind: MaterialFieldSourceKind,
    pub realization_location: MaterialFieldLocationIR,
    pub requires_sampling: bool,
    pub requires_mesh_revision: bool,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statistics: Option<MaterialFieldStatisticsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaterialFieldStatisticsIR {
    pub sample_count: usize,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaterialFieldSourceKind {
    Parent,
    Override,
    Gradient,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaterialFieldAssetIR {
    pub asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    pub parameter: MaterialParameterNameIR,
    pub owner_object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_region_id: Option<String>,
    pub mesh_id: String,
    pub mesh_generation_id: String,
    pub location: MaterialFieldLocationIR,
    pub component_count: u32,
    pub unit: String,
    pub values: Vec<f64>,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub provenance: MaterialFieldProvenanceIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaterialFieldProvenanceIR {
    pub source_kind: MaterialFieldSourceKind,
    pub algorithm: String,
    pub timing_ms: f64,
}
