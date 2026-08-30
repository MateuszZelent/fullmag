use fullmag_ir::{FrozenSpinsIR, SelectionExprIR};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SelectionCartesianComponentSchema {
    X,
    Y,
    Z,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SelectionComparisonOpSchema {
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SelectionClosedIntervalSchema {
    None,
    Left,
    Right,
    Both,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SelectionComparisonToleranceSchema {
    pub atol: f64,
    pub rtol: f64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionFrameSchema {
    World {},
    Object { object_id: String },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionSamplingSchema {
    DofPoint {},
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionBoundaryMembershipSchema {
    Inclusive {
        absolute_tolerance_m: f64,
        relative_tolerance: f64,
    },
    Exclusive {
        absolute_tolerance_m: f64,
        relative_tolerance: f64,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionGeometryPredicateSchema {
    Box {
        center_m: [f64; 3],
        size_m: [f64; 3],
    },
    Cylinder {
        center_m: [f64; 3],
        axis: [f64; 3],
        radius_m: f64,
        height_m: f64,
    },
    Sphere {
        center_m: [f64; 3],
        radius_m: f64,
    },
    Ellipsoid {
        center_m: [f64; 3],
        radii_m: [f64; 3],
    },
    Union {
        #[schema(no_recursion)]
        a: Box<SelectionGeometryPredicateSchema>,
        #[schema(no_recursion)]
        b: Box<SelectionGeometryPredicateSchema>,
    },
    Intersection {
        #[schema(no_recursion)]
        a: Box<SelectionGeometryPredicateSchema>,
        #[schema(no_recursion)]
        b: Box<SelectionGeometryPredicateSchema>,
    },
    Difference {
        #[schema(no_recursion)]
        base: Box<SelectionGeometryPredicateSchema>,
        #[schema(no_recursion)]
        tool: Box<SelectionGeometryPredicateSchema>,
    },
    Xor {
        #[schema(no_recursion)]
        a: Box<SelectionGeometryPredicateSchema>,
        #[schema(no_recursion)]
        b: Box<SelectionGeometryPredicateSchema>,
    },
    Complement {
        #[schema(no_recursion)]
        geometry: Box<SelectionGeometryPredicateSchema>,
        #[schema(no_recursion)]
        domain: Box<SelectionGeometryPredicateSchema>,
    },
    Affine {
        #[schema(no_recursion)]
        geometry: Box<SelectionGeometryPredicateSchema>,
        translation_m: [f64; 3],
        rotation_xyzw: [f64; 4],
        scale: [f64; 3],
        pivot_m: [f64; 3],
    },
    ImportedSolid {
        asset_id: String,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionScalarExprSchema {
    Constant {
        value: f64,
    },
    Coordinate {
        component: SelectionCartesianComponentSchema,
        frame: SelectionFrameSchema,
    },
    MagnetizationComponent {
        component: SelectionCartesianComponentSchema,
    },
    MagnetizationNorm {},
    MagnetizationDot {
        axis: [f64; 3],
    },
    Abs {
        #[schema(no_recursion)]
        value: Box<SelectionScalarExprSchema>,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionExprSchema {
    AllMagnetic {},
    InObject {
        object_id: String,
    },
    InRegion {
        object_id: String,
        region_id: String,
    },
    InsideGeometry {
        geometry: SelectionGeometryPredicateSchema,
        frame: SelectionFrameSchema,
        sampling: SelectionSamplingSchema,
        boundary: SelectionBoundaryMembershipSchema,
    },
    Compare {
        lhs: SelectionScalarExprSchema,
        op: SelectionComparisonOpSchema,
        rhs: SelectionScalarExprSchema,
        #[schema(nullable = false)]
        tolerance: Option<SelectionComparisonToleranceSchema>,
    },
    Approx {
        value: SelectionScalarExprSchema,
        target: SelectionScalarExprSchema,
        atol: f64,
        rtol: f64,
    },
    Between {
        value: SelectionScalarExprSchema,
        lower: f64,
        upper: f64,
        closed: SelectionClosedIntervalSchema,
    },
    And {
        #[schema(no_recursion)]
        expressions: Vec<SelectionExprSchema>,
    },
    Or {
        #[schema(no_recursion)]
        expressions: Vec<SelectionExprSchema>,
    },
    Xor {
        #[schema(no_recursion)]
        expressions: Vec<SelectionExprSchema>,
    },
    Not {
        #[schema(no_recursion)]
        expression: Box<SelectionExprSchema>,
    },
    Ref {
        selection_id: String,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SelectionDefinitionSchema {
    pub schema_version: String,
    pub id: String,
    pub name: Option<String>,
    pub expression: SelectionExprSchema,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FrozenReferencePolicySchema {
    CaptureCurrentAtActivation {},
    InitialState {},
    ExplicitFieldAsset { asset_id: String },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionMembershipPolicySchema {
    Static {},
    SnapshotAtActivation {},
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConstraintActivationSchema {
    AllStages {},
    StageIds { stage_ids: Vec<String> },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum EmptySelectionPolicySchema {
    Error,
    AllowNoop,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InactiveSelectionPolicySchema {
    WarnAndIntersect,
    Error,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsSchema {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    #[schema(nullable = false)]
    pub enabled: Option<bool>,
    pub selector: SelectionExprSchema,
    #[schema(nullable = false)]
    pub reference: Option<FrozenReferencePolicySchema>,
    pub membership: Option<SelectionMembershipPolicySchema>,
    #[schema(nullable = false)]
    pub activation: Option<ConstraintActivationSchema>,
    #[schema(nullable = false)]
    pub empty_selection: Option<EmptySelectionPolicySchema>,
    #[schema(nullable = false)]
    pub inactive_selection: Option<InactiveSelectionPolicySchema>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MagnetizationConstraintSchema {
    FrozenSpins(FrozenSpinsSchema),
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsCollectionResource {
    pub revision: u64,
    pub count: usize,
    #[schema(value_type = Vec<FrozenSpinsSchema>)]
    pub definitions: Vec<FrozenSpinsIR>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_application: Option<FrozenSpinsRuntimeApplication>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsDefinitionResource {
    pub revision: u64,
    #[schema(value_type = FrozenSpinsSchema)]
    pub definition: FrozenSpinsIR,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_application: Option<FrozenSpinsRuntimeApplication>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FrozenSpinsRuntimeApplicationState {
    PendingRuntimePlan,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FrozenSpinsRuntimeApplyBoundary {
    NextRuntimePlan,
    AcceptedStep,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsRuntimeApplication {
    pub state: FrozenSpinsRuntimeApplicationState,
    pub pending_revision: u64,
    pub apply_boundary: FrozenSpinsRuntimeApplyBoundary,
    pub current_runtime_unchanged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_command_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct FrozenSpinsMutationRequest {
    pub expected_revision: u64,
    #[schema(value_type = FrozenSpinsSchema)]
    pub definition: FrozenSpinsIR,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct FrozenSpinsDeleteRequest {
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct FrozenSpinsPreviewRequest {
    pub expected_revision: u64,
    pub expected_source_state_revision: u64,
    pub expected_topology_fingerprint: String,
    pub target_object_id: String,
    #[serde(default)]
    pub stage_id: Option<String>,
    #[schema(value_type = SelectionExprSchema)]
    pub selector: SelectionExprIR,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsRequestedIntent {
    pub target_object_id: String,
    pub stage_id: Option<String>,
    pub selector_sha256: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsResolvedPlanSummary {
    pub schema_version: String,
    pub evaluator_id: String,
    pub constraint_ids: Vec<String>,
    pub topology_fingerprint: String,
    pub effective_selector_sha256: String,
    pub source_state_revision: Option<u64>,
    pub resolved_reference_sha256: String,
    pub all_active_dofs_frozen: bool,
    pub qualification: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FrozenSpinsPreviewAuthority {
    SpeculativeAuthoringPreview,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FrozenSpinsSolverBinding {
    Unbound,
    PendingRuntimeActivation,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FrozenSpinsActivationScope {
    AuthoringCommit,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsPreviewResponse {
    pub schema_version: String,
    pub preview_id: String,
    pub authority: FrozenSpinsPreviewAuthority,
    pub solver_binding: FrozenSpinsSolverBinding,
    pub activation_candidate_token: String,
    pub revision: u64,
    pub current: bool,
    pub frozen_dof_count: u64,
    pub free_dof_count: u64,
    pub fraction: f64,
    pub bounds_m: Option<[[f64; 3]; 2]>,
    pub mask_sha256: String,
    pub warnings: Vec<FrozenSpinsWarning>,
    pub mask_resource: String,
    pub requested: FrozenSpinsRequestedIntent,
    pub resolved: FrozenSpinsResolvedPlanSummary,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct FrozenSpinsPreviewActivationRequest {
    pub expected_revision: u64,
    pub activation_candidate_token: String,
    #[schema(value_type = FrozenSpinsSchema)]
    pub definition: FrozenSpinsIR,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FrozenSpinsPreviewActivationResponse {
    pub schema_version: String,
    pub preview_id: String,
    pub authority: FrozenSpinsPreviewAuthority,
    pub activation_scope: FrozenSpinsActivationScope,
    pub solver_binding: FrozenSpinsSolverBinding,
    pub runtime_application: FrozenSpinsRuntimeApplication,
    pub activation_candidate_token_consumed: bool,
    pub active_site_count: u64,
    pub frozen_site_count: u64,
    pub free_site_count: u64,
    pub source_state_revision: u64,
    pub topology_fingerprint: String,
    pub mask_sha256: String,
    pub mask_resource: String,
    pub revision: u64,
    #[schema(value_type = FrozenSpinsSchema)]
    pub definition: FrozenSpinsIR,
}
