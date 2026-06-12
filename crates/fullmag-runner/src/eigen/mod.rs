pub mod artifacts;
pub mod assembly_scalar;
pub mod diagnostics;
pub mod orchestrator;
pub mod path;
pub mod response_block_real;
pub mod tracking;
pub mod types;

pub use artifacts::{
    solve_and_write_field_driven_response_sweep_bundle,
    solve_and_write_field_driven_response_sweep_bundle_with_interrupt, write_branch_bundle,
    write_frequency_domain_eigen_manifest, write_mode_bundle, write_path_bundle,
    write_response_sweep_artifact, write_response_sweep_bundle,
    write_response_sweep_bundle_with_progress,
};
pub use orchestrator::{run_path_or_single, SingleKSolver};
pub use path::expand_k_sampling;
pub use response_block_real::{
    build_field_driven_response_sweep_artifact, solve_block_real_harmonic_response,
    solve_field_driven_block_real_sweep, solve_field_driven_block_real_sweep_with_interrupt,
    BlockRealHarmonicSolution, BlockRealHarmonicSystem, BlockRealHarmonicTemplate,
    BlockRealSweepReuseProvenance, BlockRealWarmStartProvenance, FieldDrivenBlockRealResponsePoint,
    FieldDrivenBlockRealSweepOutcome, FieldDrivenResponseSweepArtifact,
    FieldDrivenResponseSweepPointArtifact, ResponseExcitationProvenanceArtifact,
    TangentLeakageDiagnosticArtifact,
};
pub use tracking::track_branches;
pub use types::{
    EigenSolverModel, KSampleDescriptor, PathSolveResult, SingleKModeResult, SingleKSolveResult,
    TrackedBranch, TrackedBranchPoint,
};
