#pragma once

#include "cpu/frequency_domain/mode_deduplication.hpp"
#include "frequency_domain/modal_eigen_request.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <complex>
#include <cstdint>
#include <limits>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace detail {

struct FloquetComplexSpectralShiftDistance {
    bool available = false;
    double rad_s = std::numeric_limits<double>::quiet_NaN();
    double hz = std::numeric_limits<double>::quiet_NaN();
};

inline FloquetComplexSpectralShiftDistance
floquet_complex_spectral_shift_distance(
    double rotated_real_rad_s,
    double rotated_imaginary_rad_s,
    double target_omega_rad_s) noexcept
{
    FloquetComplexSpectralShiftDistance result{};
    if (!std::isfinite(rotated_real_rad_s) ||
        !std::isfinite(rotated_imaginary_rad_s) ||
        !std::isfinite(target_omega_rad_s)) {
        return result;
    }
    const double real_offset = rotated_real_rad_s - target_omega_rad_s;
    const double distance_rad_s = std::hypot(
        real_offset,
        rotated_imaginary_rad_s);
    if (!std::isfinite(real_offset) || !std::isfinite(distance_rad_s) ||
        distance_rad_s < 0.0) {
        return result;
    }
    const double distance_hz = distance_rad_s / (2.0 * std::acos(-1.0));
    if (!std::isfinite(distance_hz) || distance_hz < 0.0) {
        return result;
    }
    result.available = true;
    result.rad_s = distance_rad_s;
    result.hz = distance_hz;
    return result;
}

} // namespace detail

struct FloquetSharedDomainSparseModalOperator;

// Callback-time scalar diagnostics for a hard shifted-KSP/EPS failure. These
// observations are separate from the completed-solve ksp_last_* fields.
struct FloquetShiftedKspFailureProbe {
    bool eps_dimension_arguments_available = false;
    int eps_attempt_number = 0;
    std::int64_t eps_nev_argument = 0;
    std::int64_t eps_ncv_argument = 0;
    std::uint64_t callback_count = 0;
    bool callback_observation_available = false;
    std::int64_t last_callback_iteration = -1;
    bool last_recursive_residual_available = false;
    double last_recursive_residual_norm =
        std::numeric_limits<double>::quiet_NaN();
    bool last_default_reason_available = false;
    int last_default_reason = 0;
    bool last_reason_after_gate_available = false;
    int last_reason_after_gate = 0;
    std::uint64_t true_probe_attempt_count = 0;
    std::uint64_t true_probe_count = 0;
    std::uint64_t true_probe_measurement_failure_count = 0;
    std::uint64_t true_probe_auxiliary_measurement_failure_count = 0;
    bool last_true_build_reason_available = false;
    int last_true_build_reason = 0;
    bool last_true_probe_available = false;
    std::uint64_t last_true_probe_callback_ordinal = 0;
    std::int64_t last_true_probe_iteration = -1;
    // Internal Euclidean L2 norms for the shifted linear system, not the
    // physical tangent-mass norm or an original-pencil residual.
    bool last_true_solution_norm_available = false;
    double last_true_solution_norm = std::numeric_limits<double>::quiet_NaN();
    bool last_true_operator_action_norm_available = false;
    double last_true_operator_action_norm =
        std::numeric_limits<double>::quiet_NaN();
    double last_true_rhs_norm = std::numeric_limits<double>::quiet_NaN();
    double last_true_residual_norm = std::numeric_limits<double>::quiet_NaN();
    double last_true_residual_threshold =
        std::numeric_limits<double>::quiet_NaN();
    double last_true_rtol = std::numeric_limits<double>::quiet_NaN();
    double last_true_atol = std::numeric_limits<double>::quiet_NaN();
    bool last_true_probe_recursive_residual_available = false;
    double last_true_probe_recursive_residual_norm =
        std::numeric_limits<double>::quiet_NaN();
    bool last_true_probe_default_reason_available = false;
    int last_true_probe_default_reason = 0;
    bool last_true_probe_reason_after_gate_available = false;
    int last_true_probe_reason_after_gate = 0;
    bool last_true_tolerance_ratio_available = false;
    double last_true_tolerance_ratio =
        std::numeric_limits<double>::quiet_NaN();
    struct CandidateOperatorDiagnostic {
        struct ShiftedLuPolicyOutcome {
            bool factorization_setup_available = false;
            int factorization_setup_error_code = 0;
            bool solve_available = false;
            int solve_error_code = 0;
            bool solve_reason_available = false;
            int solve_reason = 0;
            bool repeat_solve_reason_available = false;
            int repeat_solve_reason = 0;
            bool preconditioner_solution_l2_norm_available = false;
            double preconditioner_solution_l2_norm =
                std::numeric_limits<double>::quiet_NaN();
            bool operator_solution_l2_norm_available = false;
            double operator_solution_l2_norm =
                std::numeric_limits<double>::quiet_NaN();
            bool repeat_operator_solution_l2_norm_available = false;
            double repeat_operator_solution_l2_norm =
                std::numeric_limits<double>::quiet_NaN();
            bool repeatability_relative_defect_available = false;
            double repeatability_relative_defect =
                std::numeric_limits<double>::quiet_NaN();
            bool preconditioner_residual_l2_norm_available = false;
            double preconditioner_residual_l2_norm =
                std::numeric_limits<double>::quiet_NaN();
            bool preconditioner_relative_residual_available = false;
            double preconditioner_relative_residual =
                std::numeric_limits<double>::quiet_NaN();
            bool operator_residual_l2_norm_available = false;
            double operator_residual_l2_norm =
                std::numeric_limits<double>::quiet_NaN();
            bool operator_relative_residual_available = false;
            double operator_relative_residual =
                std::numeric_limits<double>::quiet_NaN();
            bool operator_tolerance_ratio_available = false;
            double operator_tolerance_ratio =
                std::numeric_limits<double>::quiet_NaN();
        };
        struct ShiftedLuPolicyComparison {
            bool requested = false;
            bool exact_shifted_matrix_available = false;
            bool rhs_available = false;
            bool rhs_l2_norm_available = false;
            double rhs_l2_norm = std::numeric_limits<double>::quiet_NaN();
            bool true_residual_threshold_available = false;
            double true_residual_threshold_l2_norm =
                std::numeric_limits<double>::quiet_NaN();
            bool available = false;
            const char *status = "disabled";
            const char *reason = "";
            double target_shift_rad_s =
                std::numeric_limits<double>::quiet_NaN();
            double operator_normalization_scale =
                std::numeric_limits<double>::quiet_NaN();
            double preconditioner_normalization_scale =
                std::numeric_limits<double>::quiet_NaN();
            double shifted_preconditioner_matrix_infinity_norm_after_normalization =
                std::numeric_limits<double>::quiet_NaN();
            double requested_factorization_shift_amount =
                std::numeric_limits<double>::quiet_NaN();
            double shifted_ksp_rtol =
                std::numeric_limits<double>::quiet_NaN();
            double shifted_ksp_atol =
                std::numeric_limits<double>::quiet_NaN();
            ShiftedLuPolicyOutcome mat_shift_nonzero{};
            ShiftedLuPolicyOutcome mat_shift_none{};
        };
        bool requested = false;
        bool workspace_available = false;
        bool sample_available = false;
        const char *status = "disabled";
        const char *reason = "";
        std::uint64_t callback_ordinal = 0;
        std::int64_t iteration = -1;
        bool production_phi_rhs_norm_available = false;
        double production_phi_rhs_norm = std::numeric_limits<double>::quiet_NaN();
        bool production_phi_norm_available = false;
        double production_phi_norm = std::numeric_limits<double>::quiet_NaN();
        bool production_poisson_residual_available = false;
        double production_poisson_residual_norm =
            std::numeric_limits<double>::quiet_NaN();
        bool production_poisson_relative_residual_available = false;
        double production_poisson_relative_residual =
            std::numeric_limits<double>::quiet_NaN();
        bool production_vs_isolated_replay_available = false;
        double production_vs_isolated_replay_relative_defect =
            std::numeric_limits<double>::quiet_NaN();
        bool isolated_repeatability_available = false;
        double isolated_repeatability_relative_defect =
            std::numeric_limits<double>::quiet_NaN();
        bool isolated_additivity_available = false;
        double isolated_additivity_relative_defect =
            std::numeric_limits<double>::quiet_NaN();
        bool exact_shifted_matrix_comparison_available = false;
        double exact_shifted_matrix_relative_defect =
            std::numeric_limits<double>::quiet_NaN();
        ShiftedLuPolicyComparison shifted_lu_policy_comparison{};
        double preconditioner_normalization_scale =
            std::numeric_limits<double>::quiet_NaN();
        std::uint64_t measurement_failure_count = 0;
        int last_error_code = 0;
    } candidate_operator_diagnostic{};
};

struct SLEPcModalEigenAdapterStatus {
    const char *solver_adapter = "slepc_modal_eigen";
    const char *solver_adapter_status = "pending";
    const char *unavailable_message = "";
    const char *unsupported_reason = "";
    const char *eps_type = "";
    const char *problem_type = "";
    const char *which_eigenpairs = "";
    const char *ksp_type = "";
    const char *pc_type = "";
    const char *factorization_package = "";
    const char *factorization_shift_policy = "";
    const char *nullspace_policy = "";
    const char *linear_tolerance_policy = "";
    const char *algebraic_form = "";
    const char *positive_frequency_filter = "";
    const char *eigenvalue_to_frequency = "";
    bool requires_slepc = true;
    bool slepc_available = false;
};

SLEPcModalEigenAdapterStatus slepc_modal_eigen_adapter_status() noexcept;

struct SLEPcTangentMassActionContext {
    std::size_t dimension = 0;
    const double *dense_row_major = nullptr;
    CsrMatrixView csr{};
    bool sparse = false;
    bool validated = false;
};

bool create_slepc_tangent_mass_action_context(
    int tangent_dof_count,
    const double *dense_mass_row_major,
    const CsrMatrixView &csr_mass,
    SLEPcTangentMassActionContext *out_context) noexcept;

struct SLEPcTinyGyrotropicModalEigenRequest {
    int tangent_dof_count = 0;
    const double *stiffness_matrix_row_major = nullptr;
    const double *gyrotropic_matrix_row_major = nullptr;
    const double *tangent_mass_matrix_row_major = nullptr;
    CsrMatrixView tangent_mass_csr{};
    const SLEPcTangentMassActionContext *tangent_mass_action_context = nullptr;
    int requested_mode_count = 1;
    double target_frequency_hz = 0.0;
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    double residual_tolerance = 1.0e-10;
    int max_outer_iterations = 64;
    int max_linear_iterations = 128;
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
};

struct SLEPcModalAcceptedMode {
    bool floquet_descriptor_certified = false;
    bool floquet_seam_frame_certified = false;
    bool floquet_gauge_policy_satisfied = false;
    bool floquet_mode_vector_physical_complex = false;
    std::array<char, 32> floquet_poisson_boundary_kind{};
    std::array<char, 32> floquet_poisson_gauge_policy{};
    double floquet_magnetic_residual = 0.0;
    double floquet_potential_residual = 0.0;
    double floquet_full_magnetic_residual =
        std::numeric_limits<double>::quiet_NaN();
    double floquet_full_potential_residual =
        std::numeric_limits<double>::quiet_NaN();
    double floquet_scalar_phase_seam_residual =
        std::numeric_limits<double>::quiet_NaN();
    double floquet_tangent_frame_seam_residual =
        std::numeric_limits<double>::quiet_NaN();
    double floquet_cartesian_seam_residual =
        std::numeric_limits<double>::quiet_NaN();
    double floquet_equilibrium_pair_residual =
        std::numeric_limits<double>::quiet_NaN();
    std::vector<std::complex<double>> floquet_potential_real_split;
    int eigenpair_index = -1;
    int positive_frequency_pair_index = -1;
    double lambda_real = 0.0;
    double lambda_imag = 0.0;
    double frequency_hz = 0.0;
    double relative_residual = 0.0;
    std::vector<std::complex<double>> mode_vector{};
};

enum class SLEPcModalCandidateSelection {
    nearest_target,
    lowest_frequency,
};

struct SLEPcModalCandidateFinalization {
    bool success = false;
    ModalDeduplicationStatus deduplication_status =
        ModalDeduplicationStatus::invalid_parameters;
    std::size_t unique_candidate_count_before_cap = 0;
    bool truncated_by_requested_count = false;
    std::vector<SLEPcModalAcceptedMode> accepted_modes;
};

// Private fail-closed sequencing primitive used by PETSc object teardown.
// The callbacks are typed adapters supplied by the owner; the test exercises
// sequencing with inert handles and never fabricates or dereferences PETSc
// objects. This is an internal C++ contract, not a public C ABI.
struct SLEPcModalDestroyOperation {
    void *context = nullptr;
    bool (*destroy)(void *context) = nullptr;
};
using SLEPcModalDestroyFailureHandler = void (*)(void *context);

// A hard PETSc/SLEPc operation error makes the current graph unsafe to touch.
// This per-attempt gate lets the source regression prove that later queries or
// teardown operations are not called after the first failure.
template <typename Operation>
bool run_slepc_modal_graph_operation(
    bool *graph_healthy,
    Operation operation) noexcept
{
    if (graph_healthy == nullptr || !*graph_healthy) {
        return false;
    }
    if (!operation()) {
        *graph_healthy = false;
        return false;
    }
    return true;
}

bool run_slepc_modal_destroy_sequence(
    const SLEPcModalDestroyOperation *operations,
    std::size_t operation_count,
    SLEPcModalDestroyFailureHandler on_failure,
    void *failure_context) noexcept;

constexpr double kSLEPcModalDedupFrequencyRelativeTolerance = 1.0e-8;
constexpr double kSLEPcModalDedupFrequencyAbsoluteToleranceHz = 1.0e-12;
constexpr double kSLEPcModalDedupOverlapThreshold = 0.90;

// Shared generic CPU modal finalizer. It applies the declared geometric mass
// action to comparison copies, maps selected indices back to the untouched
// accepted modes, chooses nearest/lowest candidates, caps, then restores
// frequency presentation order.
SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_mass(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    std::size_t tangent_dof_count,
    ModalMassAction mass_action,
    const void *mass_action_context,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept;

SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_context(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    const SLEPcTangentMassActionContext &mass_action_context,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept;

SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_dense_mass(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    std::size_t tangent_dof_count,
    const double *mass_matrix_row_major,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept;

SLEPcModalCandidateFinalization finalize_slepc_modal_candidates_with_csr_mass(
    const std::vector<SLEPcModalAcceptedMode> &candidates,
    std::size_t tangent_dof_count,
    const CsrMatrixView &mass_csr,
    double frequency_relative_tolerance,
    double frequency_absolute_tolerance_hz,
    double overlap_threshold,
    double target_frequency_hz,
    int requested_mode_count,
    SLEPcModalCandidateSelection selection) noexcept;

struct FloquetDemagOperatorProbeSample {
    bool attempted = false;
    bool passed = false;
    double q_l2_norm = 0.0;
    double potential_relative_residual = 0.0;
    double self_energy_j = 0.0;
    double potential_energy_j = 0.0;
    double energy_form_relative_defect = 0.0;
};

struct FloquetDemagOperatorProbeResult {
    bool requested = false;
    bool available = false;
    bool passed = false;
    double hermitian_relative_defect = 0.0;
    FloquetDemagOperatorProbeSample global_y{};
    FloquetDemagOperatorProbeSample global_z{};
};

/*
 * Opt-in C2 diagnostic for the native shared-domain Floquet Schur pencil.
 * The fields intentionally live on the result, not on the request: the
 * environment switch is private and the diagnostic never changes production
 * mode selection or the public solver contract.
 */
struct FloquetDenseOracleDiagnostics {
    struct RawSpectrumEntry {
        bool available = false;
        int eps_index = -1;
        double rotated_real_rad_s = std::numeric_limits<double>::quiet_NaN();
        double rotated_imaginary_rad_s = std::numeric_limits<double>::quiet_NaN();
        double raw_lambda_real_per_s = std::numeric_limits<double>::quiet_NaN();
        double raw_lambda_imag_rad_s = std::numeric_limits<double>::quiet_NaN();
        bool shift_distance_available = false;
        double shift_distance_rad_s = std::numeric_limits<double>::quiet_NaN();
        double shift_distance_hz = std::numeric_limits<double>::quiet_NaN();
    };

    static constexpr std::size_t kRawSpectrumCapacity = 4u;
    bool requested = false;
    bool available = false;
    bool candidate_found = false;
    bool action_match = false;
    bool st_shift_zero = false;
    bool eps_converged_reason_available = false;
    const char *status = "disabled";
    const char *reason = "";
    const char *eps_type = "lapack";
    const char *problem_type = "gnhep";
    const char *spectral_transform = "unshifted_shift_of_origin";
    int q_complex_dof_count = 0;
    int phi_dof_count = 0;
    int real_split_dimension = 0;
    int eps_converged_count = 0;
    int eps_converged_reason = 0;
    bool raw_spectrum_count_available = false;
    int raw_spectrum_total_count = 0;
    int raw_spectrum_entry_count = 0;
    bool raw_spectrum_truncated = false;
    std::array<RawSpectrumEntry, kRawSpectrumCapacity> raw_spectrum{};
    int action_probe_count = 0;
    double operator_normalization_scale = 1.0;
    double action_relative_error_max = std::numeric_limits<double>::quiet_NaN();
    double poisson_relative_residual_max = std::numeric_limits<double>::quiet_NaN();
    double eps_absolute_residual = std::numeric_limits<double>::quiet_NaN();
    double rotated_omega_rad_s = std::numeric_limits<double>::quiet_NaN();
    double rotated_imaginary_rad_s = std::numeric_limits<double>::quiet_NaN();
    double frequency_hz = std::numeric_limits<double>::quiet_NaN();
    double frequency_distance_hz = std::numeric_limits<double>::quiet_NaN();
    double raw_lambda_real_per_s = std::numeric_limits<double>::quiet_NaN();
    double raw_lambda_imag_rad_per_s = std::numeric_limits<double>::quiet_NaN();
    double projected_lambda_real_per_s = std::numeric_limits<double>::quiet_NaN();
    double projected_lambda_imag_rad_per_s = std::numeric_limits<double>::quiet_NaN();
    double magnetic_residual_raw = std::numeric_limits<double>::quiet_NaN();
    double magnetic_residual_projected = std::numeric_limits<double>::quiet_NaN();
    double potential_residual = std::numeric_limits<double>::quiet_NaN();
    double q_projection_ratio = std::numeric_limits<double>::quiet_NaN();
};

/*
 * Opt-in action-only observation of the production Floquet Schur blocks.
 * This is deliberately independent from FloquetDemagOperatorProbeResult:
 * measured linear-action defects are diagnostics, not a demagnetization or
 * physical-correctness certificate.
 */
struct FloquetSchurActionDiagnostic {
    bool requested = false;
    bool available = false;
    bool pre_eps_only = true;
    bool dense_materialization = false;
    const char *status = "disabled";
    const char *reason = "";
    const char *measurement_phase = "before_eps_solve";
    const char *workspace_scope = "isolated_clone_of_production_context";
    int q_complex_dof_count = 0;
    int real_split_dimension = 0;
    int context_phase_sign = 0;
    int action_count = 0;
    int expected_action_count = 9;
    int nonzero_signal_count = 0;
    double operator_normalization_scale = 1.0;
    double preconditioner_normalization_scale = 1.0;
    double max_potential_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
    double max_repeatability_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double repeatability_first_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double repeatability_second_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double max_homogeneity_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double homogeneity_half_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double homogeneity_double_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double homogeneity_tiny_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double additivity_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double mat_shell_reconstruction_relative_defect =
        std::numeric_limits<double>::quiet_NaN();
    double min_cancellation_ratio =
        std::numeric_limits<double>::quiet_NaN();
    double max_magnetic_l2_norm =
        std::numeric_limits<double>::quiet_NaN();
    double max_feedback_l2_norm =
        std::numeric_limits<double>::quiet_NaN();
    double max_combined_l2_norm =
        std::numeric_limits<double>::quiet_NaN();
    double min_rhs_l2_norm = std::numeric_limits<double>::quiet_NaN();
    double max_rhs_l2_norm = std::numeric_limits<double>::quiet_NaN();
};

struct SLEPcTinyGyrotropicModalEigenResult {
    bool ok = false;
    // Internal terminal-state marker. A quarantined PETSc graph must not be
    // queried, destroyed again, retried, or published as canonical output.
    bool slepc_graph_quarantined = false;
    const char *status = "unavailable";
    const char *solver_adapter = "slepc_modal_eigen";
    // The current native modal adapter uses sequential PETSc objects. Keep
    // this execution scope explicit in every diagnostic result so a passing
    // solve cannot be mistaken for MPI/distributed scalability evidence.
    const char *execution_policy = "petsc_sequential_cpu";
    const char *execution_scope = "single_process_shared_memory";
    const char *communicator = "PETSC_COMM_SELF";
    const char *scalability_scope = "single_process_only";
    const char *eps_type = "krylovschur";
    const char *problem_type = "gnhep";
    const char *spectral_transform = "shift_invert";
    const char *which_eigenpairs = "target_magnitude";
    const char *ksp_type = "preonly";
    const char *ksp_orthogonalization = "";
    const char *pc_type = "lu";
    const char *factorization_package = "petsc_lu_shift_nonzero";
    const char *factorization_shift_policy =
        "positive_relative_operator_norm_amount";
    const char *poisson_ksp_type = "";
    const char *poisson_pc_type = "";
    const char *poisson_factorization_package = "";
    const char *poisson_factorization_shift_policy = "not_applicable";
    const char *poisson_iteration_semantics = "";
    const char *nullspace_policy = "none";
    const char *unsupported_reason = "";
    int converged_eigenpair_count = 0;
    // Cached return value from the completed EPSSolve call; serializing this
    // scalar never requires querying an EPS after a hard error.
    bool eps_solve_error_available = false;
    int eps_solve_error_code = 0;
    bool eps_converged_reason_available = false;
    int eps_converged_reason = 0;
    bool eps_dimensions_available = false;
    int eps_nev = 0;
    int eps_ncv = 0;
    int eps_mpd = 0;
    int eps_monitor_iteration = 0;
    double eps_first_unconverged_error_estimate =
        std::numeric_limits<double>::quiet_NaN();
    int positive_frequency_candidate_count = 0;
    int frequency_window_candidate_count = 0;
    int residual_rejection_count = 0;
    int non_real_rotated_eigenvalue_count = 0;
    int residual_evaluation_candidate_count = 0;
    int eigenpair_evaluation_failure_count = 0;
    int mode_vector_failure_count = 0;
    int potential_reconstruction_failure_count = 0;
    int accepted_mode_count = 0;
    int selected_eigenpair_index = -1;
    int outer_iterations = 0;
    int max_outer_iterations = 0;
    int eps_initial_nev = 0;
    int eps_attempt_count = 0;
    int eps_solved_attempt_count = 0;
    int eps_initial_ncv = 0;
    int eps_initial_mpd = 0;
    int eps_finalized_attempt_number = 0;
    int eps_finalized_nev = 0;
    int eps_unique_certified_mode_count = 0;
    // Snapshot the first successfully finalized EPS pool. Availability keeps
    // a default zero distinct from an observed empty certified pool.
    bool eps_first_attempt_unique_certified_mode_count_available = false;
    int eps_first_attempt_unique_certified_mode_count = 0;
    bool eps_outer_iteration_budget_exhausted = false;
    FloquetShiftedKspFailureProbe shifted_ksp_failure_probe{};
    bool eps_iteration_budget_available = false;
    bool eps_cumulative_iterations_available = false;
    bool eps_cancellation_observed = false;
    int linear_iterations_total = 0;
    int ksp_last_iterations = 0;
    bool ksp_diagnostics_available = false;
    // Iteration-time observations copied by the shifted-KSP monitor. These
    // remain distinct from post-solve true residuals and final KSP queries.
    bool ksp_monitor_registered = false;
    std::uint64_t ksp_monitor_observation_count = 0;
    bool ksp_monitor_last_iteration_available = false;
    std::int64_t ksp_monitor_last_iteration = 0;
    bool ksp_monitor_recursive_residual_available = false;
    double ksp_monitor_recursive_residual_norm =
        std::numeric_limits<double>::quiet_NaN();
    bool ksp_monitor_last_reason_available = false;
    int ksp_monitor_last_observed_reason = 0;
    // Observed before EPSSolve; distinct from last-solve residual telemetry.
    bool shifted_ksp_configuration_before_eps_available = false;
    int shifted_ksp_pc_side_before_eps = -1;
    int shifted_ksp_norm_type_before_eps = -1;
    bool ksp_converged_reason_available = false;
    int ksp_converged_reason = 0;
    int ksp_max_iterations = 0;
    int ksp_restart = 0;
    double ksp_breakdown_tolerance =
        std::numeric_limits<double>::quiet_NaN();
    int poisson_ksp_max_iterations = 0;
    double ksp_rtol = 0.0;
    double ksp_atol = 0.0;
    double poisson_ksp_rtol = 0.0;
    double poisson_ksp_atol = 0.0;
    double ksp_final_residual = 0.0;
    bool ksp_last_true_residual_available = false;
    double ksp_last_true_residual_norm =
        std::numeric_limits<double>::quiet_NaN();
    double ksp_last_rhs_norm = std::numeric_limits<double>::quiet_NaN();
    double ksp_last_true_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
    // Per-solve observation of the shifted true residual criterion.
    std::uint64_t ksp_true_criterion_solve_count = 0;
    std::uint64_t ksp_true_criterion_measured_count = 0;
    std::uint64_t ksp_true_criterion_violation_count = 0;
    std::uint64_t ksp_true_criterion_unavailable_count = 0;
    double ksp_true_criterion_maximum_tolerance_ratio =
        std::numeric_limits<double>::quiet_NaN();
    int ksp_true_residual_sample_count = 0;
    int ksp_true_residual_measurement_failure_count = 0;
    double ksp_max_true_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
    int ksp_pc_side = -1;
    int ksp_norm_type = -1;
    double factorization_shift_amount = 0.0;
    double operator_normalization_scale = 1.0;
    double preconditioner_normalization_scale = 1.0;
    double max_candidate_relative_residual = 0.0;
    double eps_normalized_absolute_tolerance = 0.0;
    double max_eps_normalized_absolute_residual = 0.0;
    double max_floquet_magnetic_relative_residual = 0.0;
    double max_floquet_potential_relative_residual = 0.0;
    double worst_candidate_frequency_hz = 0.0;
    double worst_candidate_eps_normalized_absolute_residual = 0.0;
    double worst_candidate_floquet_magnetic_relative_residual = 0.0;
    double worst_candidate_floquet_potential_relative_residual = 0.0;
    double worst_candidate_unprojected_magnetic_relative_residual =
        std::numeric_limits<double>::quiet_NaN();
    double worst_candidate_rotated_imaginary_rad_s =
        std::numeric_limits<double>::quiet_NaN();
    double worst_candidate_q_projection_ratio =
        std::numeric_limits<double>::quiet_NaN();
    double min_candidate_frequency_hz = 0.0;
    double max_candidate_frequency_hz = 0.0;
    double lambda_real = 0.0;
    double lambda_imag = 0.0;
    double frequency_hz = 0.0;
    double relative_residual = 0.0;
    double max_relative_residual = 0.0;
    FloquetDemagOperatorProbeResult dynamic_demag_operator_probe{};
    FloquetDenseOracleDiagnostics floquet_dense_oracle{};
    FloquetSchurActionDiagnostic floquet_schur_action_diagnostic{};
    std::vector<SLEPcModalAcceptedMode> accepted_modes{};
};

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_tiny_gyrotropic_modal_eigen(
    const SLEPcTinyGyrotropicModalEigenRequest &request) noexcept;

struct SLEPcSparseGyrotropicModalEigenRequest {
    int tangent_dof_count = 0;
    CsrMatrixView stiffness_csr{};
    CsrMatrixView gyrotropic_csr{};
    CsrMatrixView tangent_mass_csr{};
    const SLEPcTangentMassActionContext *tangent_mass_action_context = nullptr;
    int requested_mode_count = 1;
    double target_frequency_hz = 0.0;
    double frequency_min_hz = 0.0;
    double frequency_max_hz = 0.0;
    double residual_tolerance = 1.0e-10;
    int max_outer_iterations = 64;
    int max_linear_iterations = 128;
    FrequencyDomainPhaseConvention phase_convention =
        FrequencyDomainPhaseConvention::exp_i_omega_t;
    /* Optional native shared-domain Floquet owner.  When present, the
       stiffness/gyrotropic CSR views above are not materialised by the
       caller; the owner builds the phase-reduced static blocks and applies
       the scalar-potential Schur complement through a PETSc MatShell. */
    const FloquetSharedDomainSparseModalOperator *floquet_shared_domain_operator = nullptr;
    void *cancel_user_data = nullptr;
    int (*cancel_requested)(void *user_data) = nullptr;
};

SLEPcTinyGyrotropicModalEigenResult
solve_slepc_sparse_gyrotropic_modal_eigen(
    const SLEPcSparseGyrotropicModalEigenRequest &request) noexcept;

} // namespace fullmag::fem::frequency_domain
