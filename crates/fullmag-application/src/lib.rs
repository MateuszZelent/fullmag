//! Application-level project lifecycle primitives.
//!
//! This crate deliberately has no HTTP, UI, solver, or filesystem dependency.
//! A repository adapter owns archive parsing and durable publication.  The
//! application layer owns the document lifecycle and its revision/dirty
//! policy, so every entry point can use the same Create/Open/Save/Save As/
//! Close semantics.

mod application;
mod coordinator;
mod execution;
mod file_repository;
mod preparation;
mod project;
mod repository;
mod run_spec;
mod study_artifact;

pub use application::{
    ActiveExecution, ActiveExecutionPolicy, ApplicationError, CloseRequest, CloseResult,
    CreateProjectRequest, DirtyClosePolicy, DocumentMode, DocumentView, OpenProjectResult,
    ProjectApplication, SaveAsProjectRequest, SaveProjectRequest, SaveReceipt,
};
pub use coordinator::{
    CoordinatorCheckpoint, CoordinatorDisposition, CoordinatorError, CoordinatorMessage,
    CoordinatorPhase, CoordinatorTransition, DurableWorkerCoordinator, WorkerCoordinator,
    COORDINATOR_CHECKPOINT_SCHEMA, COORDINATOR_TRANSITION_SCHEMA, COORDINATOR_TRANSPORT_SCHEMA,
};
pub use execution::{
    resolved_inputs_sha256, study_task_input_fingerprint, AttemptId, ClaimIdentity, ExecutionError,
    LeaseToken, ObservationState, OwnershipEpoch, ProtocolDisposition, ResolvedInput,
    ResolvedStudyArtifact, ResolvedTaskInput, ResourceBudget, ResourceKind, ResourceLease,
    ResourceLeaseRegistry, RetryAction, RetryDecision, RetryTrigger, ScientificAssessment,
    TaskClaim, TaskId, TaskLifecycle, TaskReadiness, TaskRecord, WorkerCommand,
    WorkerCommandEnvelope, WorkerCommandInbox, WorkerEvent, WorkerEventEnvelope,
    WorkerInboxCheckpoint, WorkerProtocolLedger, RESOLVED_TASK_INPUT_SCHEMA, RETRY_DECISION_SCHEMA,
    WORKER_INBOX_SCHEMA, WORKER_PROTOCOL_SCHEMA,
};
pub use file_repository::{FileProjectRepository, FileRepositoryError};
pub use preparation::{
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
    ImmutableAssetReference, ProjectSnapshot, RequestedExecution, RunDependency, RunId, RunIntent,
    RunIntentLedger, RunSpecError, RunSpecification, StudyId, StudyReference, SubmitDisposition,
    SubmitReceipt, RUN_INTENT_SCHEMA, RUN_SPEC_SCHEMA,
};
pub use study_artifact::{
    decode_study_artifact, decode_study_artifact_bytes, encode_study_scalar_artifact,
    study_artifact_content_sha256, study_state_layout_sha256, DecodedStudyArtifact,
    MagnetizationStateArtifact, StudyScalarArtifact, MAGNETIZATION_STATE_IDENTITY_SCHEMA,
    STUDY_MAGNETIZATION_CODEC_ID, STUDY_MAGNETIZATION_CODEC_VERSION, STUDY_SCALAR_ARTIFACT_SCHEMA,
    STUDY_SCALAR_CODEC_ID, STUDY_SCALAR_CODEC_VERSION,
};
