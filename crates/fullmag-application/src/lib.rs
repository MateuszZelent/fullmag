//! Application-level project lifecycle primitives.
//!
//! This crate deliberately has no HTTP, UI, solver, or filesystem dependency.
//! A repository adapter owns archive parsing and durable publication.  The
//! application layer owns the document lifecycle and its revision/dirty
//! policy, so every entry point can use the same Create/Open/Save/Save As/
//! Close semantics.

mod antenna_inspection_bundle;
mod application;
mod batch_expansion;
mod coordinator;
mod declared_execution;
mod execution;
mod execution_profile;
mod execution_profile_binding;
mod file_repository;
mod legacy_live_execution;
mod preparation;
mod closed_loop_preparation;
mod script_pipeline_acceptance;
mod project;
mod repository;
mod run_intent_materialization;
mod run_spec;
mod script_antenna_inspection_planning;
mod script_pipeline_compilation;
pub mod script_stage_contract;
pub mod script_stage_materialization;
mod study_artifact;
mod study_execution_materialization;
mod task_execution;

pub use antenna_inspection_bundle::{
    decode_antenna_inspection_bundle, encode_antenna_inspection_bundle, AntennaInspectionBundle,
    ANTENNA_INSPECTION_BUNDLE_CODEC_ID, ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION,
    ANTENNA_INSPECTION_BUNDLE_MAX_BYTES,
};
pub use application::{
    ActiveExecution, ActiveExecutionPolicy, ApplicationError, CloseRequest, CloseResult,
    CreateProjectRequest, DirtyClosePolicy, DocumentMode, DocumentView, OpenProjectResult,
    ProjectApplication, SaveAsProjectRequest, SaveProjectRequest, SaveReceipt,
};
pub use batch_expansion::{
    bind_batch_case_output_storage, expand_independent_batch, materialize_independent_batch_case,
    BatchAxis, BatchAxisJoin, BatchAxisTarget, BatchAxisValues, BatchAxisValueKind, BatchCase,
    BatchExecutionStrategy, BatchExpansionError, BatchExpansionManifest, BatchExpansionRequest,
    BatchFailurePolicy,
    BatchRangeEndpoint, MaterializedBatchCase, validate_independent_batch_cases,
    BATCH_EXPANSION_MANIFEST_SCHEMA, BATCH_EXPANSION_MAX_CASES,
};
pub use coordinator::{
    CoordinatorCheckpoint, CoordinatorDisposition, CoordinatorError, CoordinatorMessage,
    CoordinatorPhase, CoordinatorTransition, DurableWorkerCoordinator, WorkerCoordinator,
    COORDINATOR_CHECKPOINT_SCHEMA, COORDINATOR_TRANSITION_SCHEMA, COORDINATOR_TRANSPORT_SCHEMA,
};
pub use declared_execution::bind_declared_execution;
pub use execution::{
    resolved_inputs_sha256, study_task_input_fingerprint, AttemptId, ClaimIdentity, ExecutionError,
    LeaseToken, ObservationState, OwnershipEpoch, ProtocolDisposition, ResolvedInput,
    ResolvedStudyArtifact, ResolvedTaskInput, ResourceBudget, ResourceKind, ResourceLease,
    ResourceLeaseRegistry, RetryAction, RetryDecision, RetryTrigger, ScientificAssessment,
    TaskClaim, TaskId, TaskLifecycle, TaskReadiness, TaskRecord, WorkerCommand,
    WorkerCommandEnvelope, WorkerCommandInbox, WorkerEvent, WorkerEventEnvelope,
    WorkerInboxCheckpoint, WorkerProtocolLedger, LEGACY_RESOLVED_TASK_INPUT_SCHEMA,
    CLOSED_LOOP_RESOLVED_TASK_INPUT_SCHEMA, CLOSED_LOOP_WORKER_PROTOCOL_SCHEMA, RESOLVED_TASK_INPUT_SCHEMA, RETRY_DECISION_SCHEMA, WORKER_INBOX_SCHEMA, WORKER_PROTOCOL_SCHEMA,
};
pub use execution_profile::{
    materialize_execution_request, materialize_referenced_execution,
    validate_execution_materialization,
};
pub use execution_profile_binding::bind_materialized_execution;
pub use legacy_live_execution::{
    legacy_live_execution_profile, migrate_legacy_live_execution,
    LegacyLiveExecutionMigration, LEGACY_LIVE_EXECUTION_PROFILE_ID,
    LEGACY_LIVE_EXECUTION_PROFILE_VERSION,
};
pub use file_repository::{FileProjectRepository, FileRepositoryError};
pub use closed_loop_preparation::{AcceptedPreparationProof, AcceptedPreparationReceipt, ClosedLoopPreparationPlan, ClosedLoopPreparationReceipt, CLOSED_LOOP_PREPARATION_SCHEMA, CLOSED_LOOP_PREPARATION_BINDING_SCHEMA};
pub use script_pipeline_acceptance::{compile_accepted_closed_loop_pipeline, validate_accepted_script_pipeline_source, validate_script_source_assets, AcceptedScriptPipeline, SCRIPT_PIPELINE_SOURCE_ASSET_ID, SCRIPT_PIPELINE_SOURCE_SCHEMA};
pub use preparation::{
    materialize_antenna_external_lead_inspection_preparation_from_problem,
    materialize_fdm_preparation_from_problem, materialize_fem_preparation_from_problem,
    AcceptedRunPreparationSource, PreparationBinding, PreparationMaterializationError,
    PreparationReceipt, PreparationReceiptError, ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA,
    PREPARATION_BINDING_SCHEMA, PREPARATION_RECEIPT_SCHEMA,
};
pub use project::{
    DefinitionRevision, JsonEnvelopeError, MigrationReport, OpaqueAsset, OpaqueDocument,
    ProjectDefinition, ProjectDefinitionError, ProjectEnvelope, ProjectId, ProjectIdError,
    ProjectPathError, ProjectSource, ProjectTarget, RawJsonEnvelope, CURRENT_PROJECT_SCHEMA,
    CURRENT_SCENE_SCHEMA,
};
pub use repository::{
    DurabilityGuarantee, ProjectRepository, RepositoryCommitRequest, RepositoryCommitResult,
    RepositoryOpenResult,
};
pub use run_spec::{
    ImmutableAssetReference, ProjectSnapshot, RequestedExecution, RequestedResourceBudget,
    RunDependency, RunId, RunIntent, RunIntentLedger, RunSpecError, RunSpecification, StudyId,
    StudyReference, SubmitDisposition, SubmitReceipt, RUN_INTENT_SCHEMA, RUN_SPEC_SCHEMA,
};
pub use run_intent_materialization::{materialize_run_intent, RunIntentAuthoring};
pub use script_antenna_inspection_planning::plan_script_antenna_inspection;
pub use script_pipeline_compilation::{
    materialize_script_pipeline_with_output_policy_bounded, CompiledScriptExecution,
    ScriptPipelineCompilation, ScriptPipelineNodeBinding, ScriptPipelineNodeKind,
};
pub use study_artifact::{
    decode_magnetization_field_semantics, decode_study_artifact, decode_study_artifact_bytes,
    encode_study_scalar_artifact, study_artifact_content_sha256, study_state_layout_sha256,
    AntennaInspectionArtifact, DecodedStudyArtifact, MagnetizationStateArtifact,
    StudyScalarArtifact, MAGNETIZATION_STATE_IDENTITY_SCHEMA, STUDY_ANTENNA_INSPECTION_CODEC_ID,
    STUDY_ANTENNA_INSPECTION_CODEC_VERSION, STUDY_MAGNETIZATION_CODEC_ID,
    STUDY_MAGNETIZATION_CODEC_VERSION, STUDY_SCALAR_ARTIFACT_SCHEMA, STUDY_SCALAR_CODEC_ID,
    STUDY_SCALAR_CODEC_VERSION,
};
pub use study_execution_materialization::{
    materialize_captured_study_input, materialize_study_execution, CapturedStudyExecutionInput,
    StudyStepExecutionInput,
};
