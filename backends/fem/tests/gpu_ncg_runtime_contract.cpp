/* Native CUDA production-path contracts for FEM nonlinear-CG endpoint reuse. */

#include "fullmag_fem.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

struct TetraMeshInput {
    const double nodes[12] = {
        0.0, 0.0, 0.0,
        12.0e-9, 0.0, 0.0,
        0.0, 12.0e-9, 0.0,
        0.0, 0.0, 12.0e-9,
    };
    const uint32_t cell_nodes[4] = {0u, 1u, 2u, 3u};
    const uint32_t cell_types[1] = {FULLMAG_FEM_CELL_TET4};
    const uint32_t cell_offsets[2] = {0u, 4u};
    const uint64_t cell_ordinals[1] = {0u};
    const uint32_t cell_markers[1] = {1u};
    const uint32_t facet_nodes[12] = {
        0u, 1u, 2u,
        0u, 1u, 3u,
        1u, 2u, 3u,
        2u, 0u, 3u,
    };
    const uint32_t facet_types[4] = {
        FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3,
    };
    const uint32_t facet_roles[4] = {
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    const uint32_t facet_offsets[5] = {0u, 3u, 6u, 9u, 12u};
    const uint64_t facet_ordinals[4] = {0u, 1u, 2u, 3u};
    const uint32_t facet_markers[4] = {1u, 1u, 1u, 1u};
};

constexpr double kNonstationaryMagnetization[12] = {
    0.9701425001453319, 0.24253562503633297, 0.0,
    1.0, 0.0, 0.0,
    0.9701425001453319, -0.24253562503633297, 0.0,
    1.0, 0.0, 0.0,
};

fullmag_fem_backend *create_cuda_backend(
    const double *initial_magnetization,
    double external_field_y,
    bool enable_demag,
    double demag_relative_tolerance)
{
    static const TetraMeshInput mesh;
    fullmag_fem_plan_desc plan{};
    plan.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    plan.mesh.struct_size = sizeof(plan.mesh);
    plan.mesh.nodes_xyz = mesh.nodes;
    plan.mesh.nodes_xyz_len = 12u;
    plan.mesh.cell_types = mesh.cell_types;
    plan.mesh.cell_types_len = 1u;
    plan.mesh.cell_offsets = mesh.cell_offsets;
    plan.mesh.cell_offsets_len = 2u;
    plan.mesh.cell_nodes = mesh.cell_nodes;
    plan.mesh.cell_nodes_len = 4u;
    plan.mesh.cell_global_ordinals = mesh.cell_ordinals;
    plan.mesh.cell_global_ordinals_len = 1u;
    plan.mesh.cell_markers = mesh.cell_markers;
    plan.mesh.cell_markers_len = 1u;
    plan.mesh.facet_types = mesh.facet_types;
    plan.mesh.facet_types_len = 4u;
    plan.mesh.facet_roles = mesh.facet_roles;
    plan.mesh.facet_roles_len = 4u;
    plan.mesh.facet_offsets = mesh.facet_offsets;
    plan.mesh.facet_offsets_len = 5u;
    plan.mesh.facet_nodes = mesh.facet_nodes;
    plan.mesh.facet_nodes_len = 12u;
    plan.mesh.facet_global_ordinals = mesh.facet_ordinals;
    plan.mesh.facet_global_ordinals_len = 4u;
    plan.mesh.facet_markers = mesh.facet_markers;
    plan.mesh.facet_markers_len = 4u;

    plan.material.saturation_magnetisation = 8.0e5;
    plan.material.exchange_stiffness = 1.3e-11;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.fe_order = 1u;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.enable_demag = enable_demag ? 1 : 0;
    plan.has_external_field = 1;
    plan.external_field_am[0] = 0.0;
    plan.external_field_am[1] = external_field_y;
    plan.external_field_am[2] = 0.0;
    plan.initial_magnetization_xyz = initial_magnetization;
    plan.initial_magnetization_len = 12u;
    plan.dt_seconds = 1.0e-15;
    plan.hmax = 12.0e-9;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.poisson_boundary_marker = 1;
    plan.air_box_factor = 1.0;
    plan.robin_beta_mode = 2;
    plan.gpu_device_index = 0;
    plan.mfem_device_string = "cuda";
    plan.has_precession_enabled = 1;
    plan.precession_enabled = 0;

    if (enable_demag) {
        plan.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
        plan.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
        plan.demag_solver.relative_tolerance = demag_relative_tolerance;
        plan.demag_solver.has_absolute_tolerance = 0;
        plan.demag_solver.absolute_tolerance = 0.0;
        plan.demag_solver.max_iterations = 500u;
        plan.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    }
    plan.eager_initial_effective_field = 1;

    fullmag_fem_backend *const handle = fullmag_fem_backend_create(&plan);
    if (handle == nullptr) {
        const char *const error = fullmag_fem_backend_last_error(nullptr);
        std::fprintf(
            stderr,
            "FAIL: strict CUDA NCG fixture creation failed demag=%d rtol=%.17g: %s\n",
            enable_demag ? 1 : 0,
            demag_relative_tolerance,
            error == nullptr ? "unknown native FEM error" : error);
        std::exit(1);
    }
    check(
        fullmag_fem_backend_set_gpu_execution_request_v1(
            handle,
            FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE) == FULLMAG_FEM_OK,
        "strict CUDA NCG fixture must request device execution");
    uint64_t generation_id = 0u;
    check(
        fullmag_fem_backend_gpu_execution_begin_v2(handle, &generation_id) == FULLMAG_FEM_OK &&
            generation_id != 0u,
        "strict CUDA NCG fixture must begin an execution generation");
    return handle;
}

void check_device_execution(fullmag_fem_backend *handle)
{
    fullmag_fem_device_info device{};
    fullmag_fem_gpu_state_info gpu_state{};
    check(
        fullmag_fem_backend_get_device_info(handle, &device) == FULLMAG_FEM_OK &&
            device.is_gpu_enabled != 0,
        "NCG runtime fixture must report an enabled CUDA device");
    check(
        fullmag_fem_backend_get_gpu_state_info(handle, &gpu_state) == FULLMAG_FEM_OK &&
            gpu_state.allocated != 0 &&
            gpu_state.source_of_truth == FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
        "NCG runtime fixture must leave magnetization device-resident");

    fullmag_fem_gpu_execution_receipt_v2 receipt{};
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt.struct_size = sizeof(receipt);
    check(
        fullmag_fem_backend_gpu_execution_receipt_v2(handle, &receipt) == FULLMAG_FEM_OK &&
            receipt.execution_class == FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT &&
            receipt.fallback_count == 0u &&
            receipt.executed_host_operator_mask == 0u &&
            receipt.executed_unknown_operator_mask == 0u,
        "NCG runtime fixture must prove device-only execution without fallback");
    check(receipt.accounting_valid != 0u &&
              receipt.lifecycle_valid != 0u &&
              receipt.identity_valid != 0u &&
              receipt.execution_generation_id != 0u &&
              receipt.accepted_step_count > 0u,
          "accepted NCG step must publish valid accounting, lifecycle and identity");
    check(receipt.required_operator_mask != 0u &&
              receipt.resolved_device_operator_mask == receipt.required_operator_mask &&
              receipt.resolved_host_operator_mask == 0u &&
              receipt.resolved_unknown_operator_mask == 0u &&
              (receipt.executed_device_operator_mask & receipt.required_operator_mask) ==
                  receipt.required_operator_mask &&
              (receipt.executed_device_operator_mask &
                  ~(receipt.required_operator_mask |
                    FULLMAG_FEM_GPU_OPERATOR_DIRECT_ENERGY_REFINEMENT)) == 0u,
          "accepted NCG step must prove all required and only allowed device operators");
    check(receipt.hot_loop_compute_h2d_bytes == 0u &&
              receipt.hot_loop_compute_d2h_bytes == 0u &&
              receipt.hot_loop_compute_host_sync_count == 0u &&
              receipt.compute_h2d_bytes == 0u &&
              receipt.compute_d2h_bytes == 0u &&
              receipt.compute_host_sync_count == 0u &&
              receipt.exchange_h2d_bytes == 0u &&
              receipt.exchange_d2h_bytes == 0u &&
              receipt.exchange_host_sync_count == 0u &&
              receipt.transfer_violation_mask == 0u &&
              receipt.residency_violation_count == 0u,
          "accepted NCG step must not hide compute or exchange host traffic");
}

fullmag_fem_gpu_performance_snapshot_v3 query_performance(
    fullmag_fem_backend *handle)
{
    fullmag_fem_gpu_performance_snapshot_v3 snapshot{};
    snapshot.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION;
    snapshot.struct_size = sizeof(snapshot);
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v3(handle, &snapshot) ==
            FULLMAG_FEM_OK,
        "NCG runtime fixture must publish a v3 performance snapshot");
    check(
        snapshot.available != 0u &&
            snapshot.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER &&
            snapshot.relaxation_algorithm == FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
        "NCG performance snapshot must identify an available direct NCG execution");
    return snapshot;
}

fullmag_fem_accepted_energy_proof_v1 take_energy_proof(
    fullmag_fem_backend *handle)
{
    fullmag_fem_accepted_energy_proof_v1 proof{};
    proof.abi_version = FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION;
    proof.struct_size = sizeof(proof);
    check(
        fullmag_fem_backend_take_accepted_energy_proof_v1(handle, &proof) ==
            FULLMAG_FEM_OK &&
            proof.accepted_energy_proof_available != 0 &&
            std::isfinite(proof.accepted_energy_delta_j) &&
            std::isfinite(proof.accepted_energy_roundoff_bound_j) &&
            std::isfinite(proof.accepted_energy_delta_upper_j) &&
            std::isfinite(proof.armijo_increment_rhs_j) &&
            proof.accepted_energy_roundoff_bound_j >= 0.0 &&
            std::abs(
                proof.accepted_energy_delta_upper_j -
                (proof.accepted_energy_delta_j +
                 proof.accepted_energy_roundoff_bound_j)) <=
                8.0 * std::numeric_limits<double>::epsilon() *
                    std::max({
                        1.0e-300,
                        std::abs(proof.accepted_energy_delta_upper_j),
                        std::abs(proof.accepted_energy_delta_j +
                                 proof.accepted_energy_roundoff_bound_j)}) &&
            proof.accepted_energy_delta_upper_j <=
                proof.armijo_increment_rhs_j &&
            proof.armijo_increment_rhs_j < 0.0,
        "accepted NCG step must publish a finite energy proof");
    return proof;
}

void check_snapshot_energy_matches_observation(
    fullmag_fem_backend *handle,
    const fullmag_fem_step_stats &accepted,
    const char *label)
{
    fullmag_fem_step_stats observed{};
    check(
        fullmag_fem_backend_snapshot_stats(handle, &observed) == FULLMAG_FEM_OK,
        "NCG runtime fixture must support an independent GPU energy observation");
    check(std::isfinite(accepted.total_energy_joules) &&
              std::isfinite(observed.total_energy_joules),
          "accepted and independently observed energies must both be finite");
    const double scale = std::max(
        std::numeric_limits<double>::denorm_min(),
        std::max(std::abs(accepted.total_energy_joules),
                 std::abs(observed.total_energy_joules)));
    const double tolerance = 4096.0 * std::numeric_limits<double>::epsilon() * scale;
    if (std::abs(accepted.total_energy_joules - observed.total_energy_joules) >
        tolerance) {
        std::fprintf(
            stderr,
            "FAIL: %s accepted energy differs from an independent observation accepted=%.17g observed=%.17g tol=%.17g\n",
            label,
            accepted.total_energy_joules,
            observed.total_energy_joules,
            tolerance);
        std::exit(1);
    }
}

void check_ncg_endpoint_cache_miss_then_hit()
{
    fullmag_fem_backend *const handle = create_cuda_backend(
        kNonstationaryMagnetization, 1.0e5, false, 0.0);
    fullmag_fem_step_stats first_stats{};
    check(
        fullmag_fem_backend_relax_step(
            handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &first_stats) == FULLMAG_FEM_OK,
        "first production NCG step must be accepted");
    check(
        first_stats.step == 1u &&
            std::isfinite(first_stats.total_energy_joules) &&
            std::isfinite(first_stats.max_torque_Apm) &&
            first_stats.max_torque_Apm > 0.0,
        "first production NCG step must be nonstationary and finite");
    take_energy_proof(handle);
    const auto first_snapshot = query_performance(handle);
    check_device_execution(handle);

    fullmag_fem_step_stats second_stats{};
    check(
        fullmag_fem_backend_relax_step(
            handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &second_stats) == FULLMAG_FEM_OK,
        "second production NCG step must be accepted");
    check(
        second_stats.step == 2u &&
            std::isfinite(second_stats.total_energy_joules) &&
            second_stats.max_torque_Apm > 0.0,
        "second production NCG step must be nonstationary and finite");
    take_energy_proof(handle);
    const auto second_snapshot = query_performance(handle);

    check(
        first_snapshot.accepted_step_count == 1u &&
            second_snapshot.accepted_step_count == 2u,
        "NCG runtime snapshot must count both accepted steps");
    check(
        first_snapshot.physical_endpoint_cache_misses >= 1u &&
            first_snapshot.accepted_endpoint_cache_misses >= 1u &&
            first_snapshot.physical_endpoint_cache_hits == 0u &&
            first_snapshot.accepted_endpoint_cache_hits == 0u,
        "first NCG step must perform a real accepted-endpoint cache miss");
    check(
        second_snapshot.physical_endpoint_cache_hits ==
                first_snapshot.physical_endpoint_cache_hits + 1u &&
            second_snapshot.accepted_endpoint_cache_hits ==
                first_snapshot.accepted_endpoint_cache_hits + 1u &&
            second_snapshot.physical_endpoint_cache_misses ==
                first_snapshot.physical_endpoint_cache_misses &&
            second_snapshot.accepted_endpoint_cache_misses ==
                first_snapshot.accepted_endpoint_cache_misses,
        "second NCG step must consume the published endpoint cache with no new miss");

    const uint64_t first_energy_evaluations =
        first_snapshot.accepted_energy_evaluations;
    const uint64_t first_armijo_candidates =
        first_snapshot.accepted_armijo_candidates;
    const uint64_t second_energy_evaluations =
        second_snapshot.accepted_energy_evaluations - first_energy_evaluations;
    const uint64_t second_armijo_candidates =
        second_snapshot.accepted_armijo_candidates - first_armijo_candidates;
    check(
        first_energy_evaluations == first_armijo_candidates + 1u &&
            second_energy_evaluations == second_armijo_candidates &&
            second_energy_evaluations > 0u,
        "NCG cache hit must remove only the current-endpoint energy evaluation while retaining trial Armijo work");
    check(
        second_snapshot.accepted_effective_field_applies -
                first_snapshot.accepted_effective_field_applies ==
            second_energy_evaluations,
        "NCG cache hit must not add a current effective-field apply");

    check_snapshot_energy_matches_observation(
        handle, second_stats, "ordinary accepted NCG endpoint");
    fullmag_fem_backend_destroy(handle);
    std::printf("PASS: CUDA NCG endpoint cache miss->hit production contract\n");
}

bool try_ncg_refinement_case(
    const double *initial_magnetization,
    double external_field_y,
    double demag_relative_tolerance,
    const char *case_name)
{
    fullmag_fem_backend *const handle = create_cuda_backend(
        initial_magnetization,
        external_field_y,
        true,
        demag_relative_tolerance);
    fullmag_fem_step_stats stats{};
    const int status = fullmag_fem_backend_relax_step(
        handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &stats);
    if (status != FULLMAG_FEM_OK) {
        const char *const error = fullmag_fem_backend_last_error(handle);
        std::fprintf(
            stderr,
            "FAIL: production refinement candidate %s returned %d: %s\n",
            case_name,
            status,
            error == nullptr ? "unknown native FEM error" : error);
        std::exit(1);
    }
    if (stats.step != 1u) {
        std::printf(
            "NCG refinement candidate %s was stationary before an accepted step\n",
            case_name);
        fullmag_fem_backend_destroy(handle);
        return false;
    }
    check(
        std::isfinite(stats.total_energy_joules) && stats.max_torque_Apm > 0.0,
        "demag NCG refinement candidate must publish a nonstationary finite step");
    const auto proof = take_energy_proof(handle);
    const auto performance = query_performance(handle);
    check_device_execution(handle);

    const bool refined = performance.refinement_evaluation_count > 0u;
    if (!refined) {
        fullmag_fem_backend_destroy(handle);
        return false;
    }
    check(
        performance.accepted_endpoint_cache_misses >= 1u &&
            performance.accepted_armijo_candidates == 1u &&
            performance.rejected_candidate_count == 0u &&
            performance.failed_candidate_count == 0u &&
            performance.accepted_energy_evaluations >=
                performance.accepted_armijo_candidates + 3u &&
            performance.physical_demag_solves > 0u,
        "refined NCG step must have one accepted Armijo candidate and publish real demag refinement evaluations");
    fullmag_fem_step_stats second_stats{};
    check(
        fullmag_fem_backend_relax_step(
            handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &second_stats) == FULLMAG_FEM_OK &&
            second_stats.step == 2u &&
            std::isfinite(second_stats.total_energy_joules),
        "refined NCG fixture must accept a second production step");
    take_energy_proof(handle);
    const auto second_performance = query_performance(handle);
    check(
        second_performance.accepted_endpoint_cache_hits ==
                performance.accepted_endpoint_cache_hits &&
            second_performance.accepted_endpoint_cache_misses ==
                performance.accepted_endpoint_cache_misses + 1u &&
            second_performance.accepted_energy_evaluations >=
                performance.accepted_energy_evaluations &&
            second_performance.accepted_armijo_candidates >=
                performance.accepted_armijo_candidates &&
            second_performance.accepted_effective_field_applies >=
                performance.accepted_effective_field_applies,
        "accepted refined NCG endpoint must invalidate reuse and force a real next-step cache miss");
    const uint64_t second_energy_evaluations =
        second_performance.accepted_energy_evaluations -
        performance.accepted_energy_evaluations;
    const uint64_t second_armijo_candidates =
        second_performance.accepted_armijo_candidates -
        performance.accepted_armijo_candidates;
    const uint64_t second_effective_field_applies =
        second_performance.accepted_effective_field_applies -
        performance.accepted_effective_field_applies;
    check(
        second_effective_field_applies == second_armijo_candidates + 1u &&
            second_energy_evaluations >= second_armijo_candidates + 1u,
        "accepted refined NCG endpoint must cause fresh current effective-field and energy work before trial work");
    check_snapshot_energy_matches_observation(
        handle, second_stats, "step after refined accepted NCG endpoint");
    std::printf(
        "NCG refinement candidate %s accepted refinement_count=%llu energy=%.17g next_miss=%llu\n",
        case_name,
        static_cast<unsigned long long>(performance.refinement_evaluation_count),
        stats.total_energy_joules,
        static_cast<unsigned long long>(
            second_performance.accepted_endpoint_cache_misses));
    fullmag_fem_backend_destroy(handle);
    return true;
}

uint64_t ncg_counter_delta(uint64_t after, uint64_t before, const char *label)
{
    check(after >= before, label);
    return after - before;
}

void check_fresh_step_after_refined_endpoint(
    fullmag_fem_backend *handle,
    const fullmag_fem_step_stats &refined_stats,
    const fullmag_fem_gpu_performance_snapshot_v3 &before)
{
    fullmag_fem_step_stats next_stats{};
    check(
        fullmag_fem_backend_relax_step(
            handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &next_stats) == FULLMAG_FEM_OK,
        "step after refined endpoint must succeed");
    check(next_stats.step == refined_stats.step + 1u &&
              std::isfinite(next_stats.total_energy_joules),
          "step after refined endpoint must be a real accepted step");
    take_energy_proof(handle);
    check_device_execution(handle);
    const auto after = query_performance(handle);
    check(after.execution_generation_id == before.execution_generation_id,
          "next-step counters must belong to the same generation");
    check(ncg_counter_delta(after.accepted_step_count, before.accepted_step_count,
                            "accepted step counter decreased") == 1u,
          "next step must add exactly one accepted step");
    check(ncg_counter_delta(after.accepted_endpoint_cache_hits,
                            before.accepted_endpoint_cache_hits,
                            "accepted cache hit counter decreased") == 0u &&
              ncg_counter_delta(after.accepted_endpoint_cache_misses,
                                before.accepted_endpoint_cache_misses,
                                "accepted cache miss counter decreased") == 1u &&
              ncg_counter_delta(after.physical_endpoint_cache_hits,
                                before.physical_endpoint_cache_hits,
                                "physical cache hit counter decreased") == 0u &&
              ncg_counter_delta(after.physical_endpoint_cache_misses,
                                before.physical_endpoint_cache_misses,
                                "physical cache miss counter decreased") == 1u,
          "refined endpoint must not be reused with the ordinary solver signature");

    const uint64_t candidates = ncg_counter_delta(
        after.accepted_armijo_candidates, before.accepted_armijo_candidates,
        "Armijo candidate counter decreased");
    const uint64_t fields = ncg_counter_delta(
        after.accepted_effective_field_applies,
        before.accepted_effective_field_applies,
        "accepted field counter decreased");
    const uint64_t energies = ncg_counter_delta(
        after.accepted_energy_evaluations, before.accepted_energy_evaluations,
        "accepted energy counter decreased");
    const uint64_t solves = ncg_counter_delta(
        after.physical_demag_solves, before.physical_demag_solves,
        "physical demag solve counter decreased");
    // These equations retain the existing NCG counter semantics. Refinement
    // field work is additionally evidenced by physical_demag_solves.
    check(candidates > 0u && fields == candidates + 1u &&
              energies >= candidates + 1u && solves >= candidates + 1u,
          "next step must perform fresh current field/energy/demag work before trials");
    check_snapshot_energy_matches_observation(
        handle, next_stats, "step after a trajectory-refined endpoint");
}

bool try_ncg_refinement_trajectory_case(
    const double *initial_magnetization,
    double external_field_y,
    double demag_relative_tolerance,
    const char *case_name)
{
    // A finite search for a real witness, not a production stopping criterion.
    constexpr uint32_t kMaximumFollowupSteps = 128u;
    fullmag_fem_backend *const handle = create_cuda_backend(
        initial_magnetization, external_field_y, true, demag_relative_tolerance);

    // Prime using an actual step. Do not construct a synthetic zero snapshot
    // and subtract it from counters that may include eager setup work.
    fullmag_fem_step_stats previous_stats{};
    check(fullmag_fem_backend_relax_step(
              handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &previous_stats) == FULLMAG_FEM_OK,
          "trajectory priming step must succeed");
    if (previous_stats.step == 0u) {
        fullmag_fem_backend_destroy(handle);
        return false;
    }
    check(previous_stats.step == 1u &&
              std::isfinite(previous_stats.total_energy_joules) &&
              std::isfinite(previous_stats.max_torque_Apm),
          "trajectory priming step must be finite and accepted");
    take_energy_proof(handle);
    check_device_execution(handle);
    auto before = query_performance(handle);
    check(before.execution_generation_id != 0u,
          "trajectory must have a real execution generation");

    for (uint32_t i = 0; i < kMaximumFollowupSteps; ++i) {
        fullmag_fem_step_stats stats{};
        const int rc = fullmag_fem_backend_relax_step(
            handle, FULLMAG_FEM_RELAX_NONLINEAR_CG, &stats);
        if (rc != FULLMAG_FEM_OK) {
            const char *error = fullmag_fem_backend_last_error(handle);
            std::fprintf(stderr, "FAIL: trajectory %s returned %d: %s\n",
                         case_name, rc, error == nullptr ? "unknown" : error);
            std::exit(1);
        }
        check(std::isfinite(stats.total_energy_joules) &&
                  std::isfinite(stats.max_torque_Apm),
              "trajectory observation must be finite");
        if (stats.step == previous_stats.step) {
            std::printf("NOT VERIFIED: %s became stationary before an isolated refinement witness\n",
                        case_name);
            fullmag_fem_backend_destroy(handle);
            return false;
        }
        check(stats.step == previous_stats.step + 1u,
              "trajectory must advance by exactly one accepted step");
        const auto proof = take_energy_proof(handle);
        check_device_execution(handle);
        const auto after = query_performance(handle);
        check(after.execution_generation_id == before.execution_generation_id,
              "cannot subtract counters from different generations");
        check(ncg_counter_delta(after.accepted_step_count, before.accepted_step_count,
                                "accepted step counter decreased") == 1u &&
                  ncg_counter_delta(after.physical_outer_attempt_count, before.physical_outer_attempt_count,
                                    "outer attempt counter decreased") == 1u,
              "one ABI call must identify one accepted outer attempt");

        const uint64_t candidates = ncg_counter_delta(
            after.accepted_armijo_candidates, before.accepted_armijo_candidates,
            "candidate counter decreased");
        const uint64_t rejected = ncg_counter_delta(
            after.rejected_candidate_count, before.rejected_candidate_count,
            "rejected candidate counter decreased");
        const uint64_t failed = ncg_counter_delta(
            after.failed_candidate_count, before.failed_candidate_count,
            "failed candidate counter decreased");
        const uint64_t refinements = ncg_counter_delta(
            after.refinement_evaluation_count, before.refinement_evaluation_count,
            "refinement counter decreased");
        std::printf(
            "NCG-TRACE case=%s generation=%llu outer=%llu step=%llu candidates=%llu rejected=%llu failed=%llu refinements=%llu\n",
            case_name,
            static_cast<unsigned long long>(after.execution_generation_id),
            static_cast<unsigned long long>(after.physical_outer_attempt_count),
            static_cast<unsigned long long>(stats.step),
            static_cast<unsigned long long>(candidates),
            static_cast<unsigned long long>(rejected),
            static_cast<unsigned long long>(failed),
            static_cast<unsigned long long>(refinements));

        // This is a witness-selection predicate, not a relaxed Armijo test.
        // A step with several candidates may be legal, but cumulative counters
        // alone do not identify which of them refined and was accepted.
        if (candidates == 1u && rejected == 0u && failed == 0u && refinements == 1u) {
            const uint64_t misses = ncg_counter_delta(
                after.accepted_endpoint_cache_misses, before.accepted_endpoint_cache_misses,
                "cache miss counter decreased");
            const uint64_t hits = ncg_counter_delta(
                after.accepted_endpoint_cache_hits, before.accepted_endpoint_cache_hits,
                "cache hit counter decreased");
            check(misses <= 1u && hits <= 1u && misses + hits == 1u,
                  "one outer attempt must classify the current endpoint exactly once");
            const uint64_t energies = ncg_counter_delta(
                after.accepted_energy_evaluations, before.accepted_energy_evaluations,
                "energy counter decreased");
            const uint64_t solves = ncg_counter_delta(
                after.physical_demag_solves, before.physical_demag_solves,
                "demag solve counter decreased");
            check(energies == candidates + misses + 2u &&
                      solves >= candidates + misses + 2u,
                  "isolated refinement must perform refined base and trial evaluations");
            // take_energy_proof already checked finite delta/bound/upper/rhs,
            // upper == delta + bound within roundoff, and upper <= rhs.
            std::printf(
                "NCG-REFINEMENT-WITNESS case=%s generation=%llu outer=%llu candidate=1 delta=%.17g bound=%.17g upper=%.17g rhs=%.17g energy_work=%llu demag_work=%llu\n",
                case_name,
                static_cast<unsigned long long>(after.execution_generation_id),
                static_cast<unsigned long long>(after.physical_outer_attempt_count),
                proof.accepted_energy_delta_j,
                proof.accepted_energy_roundoff_bound_j,
                proof.accepted_energy_delta_upper_j,
                proof.armijo_increment_rhs_j,
                static_cast<unsigned long long>(energies),
                static_cast<unsigned long long>(solves));
            check_fresh_step_after_refined_endpoint(handle, stats, after);
            fullmag_fem_backend_destroy(handle);
            return true;
        }
        previous_stats = stats;
        before = after;
    }
    std::printf("NOT VERIFIED: %s exhausted the bounded refinement trajectory\n", case_name);
    fullmag_fem_backend_destroy(handle);
    return false;
}

void check_ncg_refined_energy_reuse()
{
    // These are ordinary physical parameter variants, not instrumentation
    // switches. The test fails closed if production never enters refinement.
    static constexpr double symmetry_axis[12] = {
        0.5773502691896257, 0.5773502691896257, 0.5773502691896257,
        0.5773502691896257, 0.5773502691896257, 0.5773502691896257,
        0.5773502691896257, 0.5773502691896257, 0.5773502691896257,
        0.5773502691896257, 0.5773502691896257, 0.5773502691896257,
    };
    static constexpr double near_uniform[12] = {
        1.0, 0.0, 0.0,
        0.9701425001453319, 0.24253562503633297, 0.0,
        1.0, 0.0, 0.0,
        0.9701425001453319, -0.24253562503633297, 0.0,
    };
    static constexpr double weakly_tilted[12] = {
        0.9999500037496876, 0.009999500037496875, 0.0,
        0.9998000599800071, -0.01999600119960014, 0.0,
        0.9995503035223668, 0.02998950910567098, 0.0,
        0.9992009592320494, -0.039968038369922, 0.0,
    };
    static constexpr double kRefinedWitnessMagnetization[12] = {
        0x1.d8fd4ab624277p-1, 0x1.65616159ddde6p-2, 0x1.425c9ffcca1c8p-3,
        0x1.f26d2ce96f3fbp-1, 0x1.4b3da445c74ffp-3, 0x1.4b3da445c74ffp-3,
        0x1.f863e9fb9e4bdp-1, -0x1.2abf445afdb0bp-5, 0x1.57c3471d7f195p-3,
        0x1.f26d2ce96f3fbp-1, 0x1.4b3da445c74ffp-3, 0x1.4b3da445c74ffp-3,
    };
    static constexpr struct {
        const double *initial_magnetization;
        double external_field_y;
        double demag_relative_tolerance;
        const char *name;
    } cases[] = {
        {kRefinedWitnessMagnetization, 0.0, 1.0e-12, "exact-armijo-refinement"},
        {kNonstationaryMagnetization, 1.0e5, 1.0e-12, "tilted-H1e5-rtol1e-12"},
        {near_uniform, 1.0e3, 1.0e-12, "near-uniform-H1e3-rtol1e-12"},
        {weakly_tilted, 1.0e2, 1.0e-12, "weak-tilt-H1e2-rtol1e-12"},
        {symmetry_axis, 1.0e1, 1.0e-12, "symmetry-axis-H1e1-rtol1e-12"},
        {symmetry_axis, 0.0, 1.0e-12, "symmetry-axis-zero-field-rtol1e-12"},
    };
    for (const auto &item : cases) {
        if (try_ncg_refinement_case(
                item.initial_magnetization,
                item.external_field_y,
                item.demag_relative_tolerance,
                item.name)) {
            std::printf("PASS: CUDA NCG refined accepted-energy production contract\n");
            return;
        }
    }
    for (const auto &item : cases) {
        if (try_ncg_refinement_trajectory_case(
                item.initial_magnetization,
                item.external_field_y,
                item.demag_relative_tolerance,
                item.name)) {
            std::printf("PASS: CUDA NCG refined accepted-energy production contract\n");
            return;
        }
    }
    check(
        false,
        "no legitimate CUDA demag NCG fixture entered production Armijo refinement");
}

} // namespace

int main()
{
    const char *requested_device = std::getenv("FULLMAG_NCG_RUNTIME_DEVICE");
    const char *require_env = std::getenv("FULLMAG_REQUIRE_CUDA_CONTRACTS");
    const bool require_cuda =
        require_env != nullptr && std::strcmp(require_env, "1") == 0;
    const bool requested_cuda =
        requested_device != nullptr && std::strcmp(requested_device, "cuda") == 0;
#if !FULLMAG_HAS_CUDA_RUNTIME
    check(!(require_cuda || requested_cuda),
          "required NCG CUDA runtime was not compiled; SKIP cannot satisfy this contract");
    std::printf("SKIP: optional CUDA NCG contract is not compiled\n");
    return 0;
#else
    check(!require_cuda || requested_cuda,
          "managed NCG contract requires FULLMAG_NCG_RUNTIME_DEVICE=cuda");
    if (!requested_cuda) {
        std::printf("SKIP: optional CUDA NCG contract was not requested\n");
        return 0;
    }
    int device_count = 0;
    check(cudaGetDeviceCount(&device_count) == cudaSuccess && device_count > 0,
          "managed CUDA NCG runtime contract requires a real CUDA device");
    std::printf("Running native CUDA FEM nonlinear-CG runtime contracts...\n");
    check_ncg_endpoint_cache_miss_then_hit();
    check_ncg_refined_energy_reuse();
    return 0;
#endif
}
