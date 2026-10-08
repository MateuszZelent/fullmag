#include "cpu/frequency_domain/mode_deduplication.hpp"
#include "cpu/frequency_domain/mode_filter.hpp"
#include "cpu/frequency_domain/slepc_modal_eigen.hpp"

#include <array>
#include <complex>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <utility>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

struct FakeSlepcHandle {
    bool live = true;
};

struct FakeSlepcDestroyFixture {
    std::array<FakeSlepcHandle, 5> handles{};
    std::array<int, 4> destroy_calls{};
    std::array<bool, 5> quarantined{};
    int fail_operation = 2;
    int quarantine_calls = 0;
};

struct FakeSlepcDestroyContext {
    FakeSlepcDestroyFixture *fixture = nullptr;
    std::size_t handle_index = 0;
    std::size_t operation_index = 0;
};

bool fake_slepc_destroy(void *context)
{
    auto *operation = static_cast<FakeSlepcDestroyContext *>(context);
    if (operation == nullptr || operation->fixture == nullptr ||
        operation->handle_index >= operation->fixture->handles.size() ||
        operation->operation_index >= operation->fixture->destroy_calls.size()) {
        return false;
    }
    FakeSlepcDestroyFixture &fixture = *operation->fixture;
    ++fixture.destroy_calls[operation->operation_index];
    if (static_cast<int>(operation->operation_index) == fixture.fail_operation) {
        return false;
    }
    fixture.handles[operation->handle_index].live = false;
    return true;
}

void quarantine_fake_slepc_handles(void *context)
{
    auto *fixture = static_cast<FakeSlepcDestroyFixture *>(context);
    if (fixture == nullptr) {
        return;
    }
    ++fixture->quarantine_calls;
    for (std::size_t index = 0; index < fixture->handles.size(); ++index) {
        fixture->quarantined[index] = fixture->handles[index].live;
    }
}

void slepc_destroy_sequence_stops_and_retains_remaining_handles_on_failure()
{
    FakeSlepcDestroyFixture fixture{};
    std::array<FakeSlepcDestroyContext, 4> contexts{};
    std::array<fd::SLEPcModalDestroyOperation, 4> operations{};
    for (std::size_t index = 0; index < contexts.size(); ++index) {
        contexts[index] = FakeSlepcDestroyContext{&fixture, index, index};
        operations[index] = fd::SLEPcModalDestroyOperation{
            &contexts[index], fake_slepc_destroy};
    }

    const bool destroyed = fd::run_slepc_modal_destroy_sequence(
        operations.data(),
        operations.size(),
        quarantine_fake_slepc_handles,
        &fixture);
    check(!destroyed, "a failed destroy callback must terminate the sequence");
    check(fixture.destroy_calls == std::array<int, 4>{1, 1, 1, 0},
          "no later EPS or matrix destructor may run after the injected EPS failure");
    check(fixture.quarantine_calls == 1,
          "the failure path must quarantine remaining object handles exactly once");
    check(!fixture.handles[0].live && !fixture.handles[1].live,
          "objects destroyed before the failure remain released");
    check(fixture.quarantined[2] && fixture.quarantined[3] && fixture.quarantined[4],
          "the failed EPS, later rotated matrix and wrapper-owned input matrix remain retained");
}

void slepc_hard_solve_error_prevents_followup_queries_and_cleanup()
{
    bool graph_healthy = true;
    std::array<int, 3> operation_calls{};
    const bool solve_succeeded = fd::run_slepc_modal_graph_operation(
        &graph_healthy,
        [&]() {
            ++operation_calls[0];
            return false;
        });
    const bool status_query_succeeded = fd::run_slepc_modal_graph_operation(
        &graph_healthy,
        [&]() {
            ++operation_calls[1];
            return true;
        });
    const bool cleanup_succeeded = fd::run_slepc_modal_graph_operation(
        &graph_healthy,
        [&]() {
            ++operation_calls[2];
            return true;
        });

    check(!solve_succeeded && !status_query_succeeded && !cleanup_succeeded,
          "a hard solve error keeps later graph operations disabled");
    check(operation_calls == std::array<int, 3>{1, 0, 0},
          "no EPS status query or destructor may run after the injected solve failure");
    check(!graph_healthy, "a failed solve permanently poisons this attempt's graph gate");
}

void slepc_vector_query_error_leaves_acquired_views_in_quarantine()
{
    bool graph_healthy = true;
    bool real_array_view_acquired = false;
    std::array<int, 4> operation_calls{};
    const bool real_get_succeeded = fd::run_slepc_modal_graph_operation(
        &graph_healthy,
        [&]() {
            ++operation_calls[0];
            real_array_view_acquired = true;
            return true;
        });
    const bool imaginary_get_succeeded = fd::run_slepc_modal_graph_operation(
        &graph_healthy,
        [&]() {
            ++operation_calls[1];
            return false;
        });
    const bool real_restore_succeeded = fd::run_slepc_modal_graph_operation(
        &graph_healthy,
        [&]() {
            ++operation_calls[2];
            real_array_view_acquired = false;
            return true;
        });
    const bool imaginary_restore_succeeded = fd::run_slepc_modal_graph_operation(
        &graph_healthy,
        [&]() {
            ++operation_calls[3];
            return true;
        });

    check(real_get_succeeded && !imaginary_get_succeeded &&
              !real_restore_succeeded && !imaginary_restore_succeeded,
          "a failed second array query quarantines instead of issuing restores");
    check(operation_calls == std::array<int, 4>{1, 1, 0, 0} &&
              real_array_view_acquired && !graph_healthy,
          "the acquired view remains attached and no PETSc operation follows the failed query");
}

fd::ModalCandidate candidate(
    double frequency_hz,
    double residual,
    std::complex<double> u0,
    std::complex<double> u1,
    int source_index = -1)
{
    fd::ModalCandidate value{};
    value.frequency_hz = frequency_hz;
    value.relative_residual = residual;
    value.source_index = source_index;
    value.mode = {u0, u1};
    return value;
}

void mode_filter_keeps_boundary_modes_inclusive()
{
    const std::vector<fd::ModalCandidate> candidates{
        candidate(99.0, 1.0e-12, {1.0, 0.0}, {0.0, 0.0}),
        candidate(100.0, 1.0e-12, {1.0, 0.0}, {0.0, 0.0}),
        candidate(200.0, 1.0e-12, {0.0, 0.0}, {1.0, 0.0}),
        candidate(201.0, 1.0e-12, {0.0, 0.0}, {1.0, 0.0}),
    };

    const std::vector<fd::ModalCandidate> filtered =
        fd::filter_modes_for_window(candidates, 100.0, 200.0, 1.0e-8);

    check(filtered.size() == 2, "window filter must keep both inclusive boundaries");
    check(filtered[0].frequency_hz == 100.0, "lower boundary mode is retained");
    check(filtered[1].frequency_hz == 200.0, "upper boundary mode is retained");
}

void mode_deduplication_keeps_lower_residual_duplicate()
{
    const double identity_mass[] = {
        1.0, 0.0,
        0.0, 1.0,
    };
    const std::vector<fd::ModalCandidate> candidates{
        candidate(1.0e9, 1.0e-8, {1.0, 0.0}, {0.0, 0.0}),
        candidate(1.0e9 + 10.0, 1.0e-10, {1.0, 0.0}, {0.0, 0.0}),
        candidate(1.2e9, 1.0e-9, {0.0, 0.0}, {1.0, 0.0}),
    };

    const std::vector<fd::ModalCandidate> deduplicated =
        fd::deduplicate_modes_by_frequency_and_overlap(
            candidates,
            identity_mass,
            2,
            1.0e-6,
            1.0e3,
            0.90);

    check(deduplicated.size() == 2, "duplicate mode must be removed");
    check(deduplicated[0].relative_residual == 1.0e-10,
          "lower residual duplicate must be retained");
    check(deduplicated[1].frequency_hz == 1.2e9,
          "independent mode must remain");
}

struct DenseMass {
    std::size_t dof_count = 0;
    std::vector<std::complex<double>> row_major;
};

bool apply_dense_mass(
    const void *context,
    const std::complex<double> *input,
    std::complex<double> *output,
    std::size_t dof_count)
{
    const auto *mass = static_cast<const DenseMass *>(context);
    if (mass == nullptr || mass->dof_count != dof_count ||
        mass->row_major.size() != dof_count * dof_count) {
        return false;
    }
    for (std::size_t row = 0; row < dof_count; ++row) {
        output[row] = {0.0, 0.0};
        for (std::size_t column = 0; column < dof_count; ++column) {
            output[row] += mass->row_major[row * dof_count + column] * input[column];
        }
    }
    return true;
}

struct CsrMass {
    std::size_t dof_count = 0;
    std::vector<std::size_t> row_offsets;
    std::vector<std::size_t> columns;
    std::vector<std::complex<double>> values;
};

bool apply_csr_mass(
    const void *context,
    const std::complex<double> *input,
    std::complex<double> *output,
    std::size_t dof_count)
{
    const auto *mass = static_cast<const CsrMass *>(context);
    if (mass == nullptr || mass->dof_count != dof_count ||
        mass->row_offsets.size() != dof_count + 1 ||
        mass->columns.size() != mass->values.size() ||
        mass->row_offsets.front() != 0 ||
        mass->row_offsets.back() != mass->values.size()) {
        return false;
    }
    for (std::size_t row = 0; row < dof_count; ++row) {
        const std::size_t begin = mass->row_offsets[row];
        const std::size_t end = mass->row_offsets[row + 1];
        if (begin > end || end > mass->values.size()) return false;
        output[row] = {0.0, 0.0};
        for (std::size_t entry = begin; entry < end; ++entry) {
            const std::size_t column = mass->columns[entry];
            if (column >= dof_count) return false;
            output[row] += mass->values[entry] * input[column];
        }
    }
    return true;
}

bool fail_mass_action(
    const void *context,
    const std::complex<double> *input,
    std::complex<double> *output,
    std::size_t dof_count)
{
    static_cast<void>(context);
    static_cast<void>(input);
    static_cast<void>(output);
    static_cast<void>(dof_count);
    return false;
}

void strict_mode_deduplication_removes_phase_duplicates_without_rescaling_output()
{
    const DenseMass small_volume_mass{
        2,
        {
            {1.0e-24, 0.0}, {0.0, 0.0},
            {0.0, 0.0}, {1.0e-24, 0.0},
        },
    };
    const std::vector<fd::ModalCandidate> candidates{
        candidate(1.0e9, 1.0e-8, {2.0, 1.0}, {0.0, 0.0}, 10),
        candidate(1.0e9 + 10.0, 1.0e-10, {-1.0, 2.0}, {0.0, 0.0}, 11),
    };

    const fd::ModalDeduplicationResult result =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            candidates,
            2,
            apply_dense_mass,
            &small_volume_mass,
            1.0e-6,
            1.0e3,
            0.90);

    check(result.status == fd::ModalDeduplicationStatus::success,
          "positive small-volume mass action must be accepted");
    check(result.modes.size() == 1, "q and i*q must be treated as one phase-equivalent mode");
    check(result.modes[0].source_index == 11,
          "lower-residual phase duplicate must be selected");
    check(result.modes[0].mode[0] == std::complex<double>(-1.0, 2.0),
          "accepted mode must preserve the original i*q amplitude");
    check(result.modes[0].mode[1] == std::complex<double>(0.0, 0.0),
          "accepted mode must preserve its original second component");
    check(result.modes[0].relative_residual == 1.0e-10,
          "accepted mode must preserve its original residual");
    check(result.modes[0].frequency_hz == candidates[1].frequency_hz,
          "accepted mode must preserve its original frequency");
}

void strict_mode_deduplication_is_invariant_to_finite_candidate_scale()
{
    struct ScaleCase {
        double candidate_scale;
        double mass_scale;
        int expected_source_index;
    };
    const ScaleCase scale_cases[] = {
        {1.0e300, 1.0e200, 52},
        {1.0e-300, 1.0e-200, 62},
    };

    for (const ScaleCase &scale_case : scale_cases) {
        const DenseMass mass{
            2,
            {
                {scale_case.mass_scale, 0.0}, {0.0, 0.0},
                {0.0, 0.0}, {scale_case.mass_scale, 0.0},
            },
        };
        const std::vector<fd::ModalCandidate> candidates{
            candidate(1.0e9, 1.0e-8,
                      {scale_case.candidate_scale, 0.0}, {0.0, 0.0},
                      scale_case.expected_source_index - 1),
            candidate(1.0e9 + 10.0, 1.0e-10,
                      {0.0, scale_case.candidate_scale}, {0.0, 0.0},
                      scale_case.expected_source_index),
        };

        const fd::ModalDeduplicationResult result =
            fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
                candidates,
                2,
                apply_dense_mass,
                &mass,
                1.0e-6,
                1.0e3,
                0.90);

        check(result.status == fd::ModalDeduplicationStatus::success,
              "finite arbitrary candidate scale must not invalidate the mass metric");
        check(result.modes.size() == 1,
              "phase duplicates must remain equivalent at very large or small scale");
        check(result.modes[0].source_index == scale_case.expected_source_index,
              "lower-residual phase duplicate must retain its original identity");
        check(result.modes[0].mode[0] ==
                  std::complex<double>(0.0, scale_case.candidate_scale),
              "accepted mode must preserve its finite input amplitude exactly");
        check(result.modes[0].mode[1] == std::complex<double>(0.0, 0.0),
              "accepted mode must preserve all remaining input components");
    }
}

void strict_mode_deduplication_keeps_mass_orthogonal_degenerate_modes()
{
    const DenseMass anisotropic_mass{
        2,
        {
            {1.0, 0.0}, {0.0, 0.0},
            {0.0, 0.0}, {1.0e6, 0.0},
        },
    };
    const std::vector<fd::ModalCandidate> candidates{
        candidate(1.0e9, 1.0e-10, {1.0, 0.0}, {1.0e-3, 0.0}, 21),
        candidate(1.0e9, 1.0e-9, {1.0, 0.0}, {-1.0e-3, 0.0}, 22),
    };
    const double euclidean_overlap = std::abs(1.0 - 1.0e-6) /
        std::sqrt((1.0 + 1.0e-6) * (1.0 + 1.0e-6));
    check(euclidean_overlap > 0.99,
          "degenerate fixture must look nearly parallel in the Euclidean metric");

    const fd::ModalDeduplicationResult result =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            candidates,
            2,
            apply_dense_mass,
            &anisotropic_mass,
            1.0e-6,
            1.0e3,
            0.90);

    check(result.status == fd::ModalDeduplicationStatus::success,
          "positive anisotropic mass action must be accepted");
    check(result.modes.size() == 2,
          "mass-orthogonal degenerate modes must both be retained");
    check(result.modes[0].source_index == 21 && result.modes[1].source_index == 22,
          "retained degenerate modes must preserve their original identities");
    check(result.modes[0].mode[1] == std::complex<double>(1.0e-3, 0.0) &&
              result.modes[1].mode[1] == std::complex<double>(-1.0e-3, 0.0),
          "mass comparison normalization must not rescale accepted modes");
}

void strict_mode_deduplication_dense_and_csr_mass_actions_are_equivalent()
{
    const DenseMass dense_mass{
        2,
        {
            {2.0, 0.0}, {0.5, 0.25},
            {0.5, -0.25}, {3.0, 0.0},
        },
    };
    const CsrMass csr_mass{
        2,
        {0, 2, 4},
        {0, 1, 0, 1},
        {{2.0, 0.0}, {0.5, 0.25}, {0.5, -0.25}, {3.0, 0.0}},
    };
    const std::vector<fd::ModalCandidate> candidates{
        candidate(1.0e9, 1.0e-8, {2.0, 1.0}, {1.0, -0.5}, 31),
        candidate(1.0e9 + 10.0, 1.0e-10, {-1.0, 2.0}, {0.5, 1.0}, 32),
        candidate(1.2e9, 1.0e-9, {0.0, 0.0}, {1.0, 0.0}, 33),
    };
    const auto dense_result =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            candidates, 2, apply_dense_mass, &dense_mass, 1.0e-6, 1.0e3, 0.90);
    const auto csr_result =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            candidates, 2, apply_csr_mass, &csr_mass, 1.0e-6, 1.0e3, 0.90);

    check(dense_result.status == fd::ModalDeduplicationStatus::success &&
              csr_result.status == fd::ModalDeduplicationStatus::success,
          "dense and CSR mass actions must both be valid");
    check(dense_result.modes.size() == 2 &&
              csr_result.modes.size() == dense_result.modes.size(),
          "dense and CSR mass actions must produce the same unique-mode count");
    for (std::size_t i = 0; i < dense_result.modes.size(); ++i) {
        check(csr_result.modes[i].source_index == dense_result.modes[i].source_index,
              "dense and CSR actions must select the same original candidates");
        check(csr_result.modes[i].mode == dense_result.modes[i].mode,
              "dense and CSR actions must return the same unscaled modes");
        check(csr_result.modes[i].relative_residual == dense_result.modes[i].relative_residual,
              "dense and CSR actions must preserve the same residuals");
    }
}

void strict_mode_deduplication_fails_without_a_valid_mass_action()
{
    const std::vector<fd::ModalCandidate> candidates{
        candidate(1.0e9, 1.0e-8, {1.0, 0.0}, {0.0, 0.0}, 41),
    };
    const fd::ModalDeduplicationResult missing_metric =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            candidates, 2, nullptr, nullptr, 1.0e-6, 1.0e3, 0.90);
    check(missing_metric.status == fd::ModalDeduplicationStatus::invalid_metric,
          "strict deduplication must not use identity mass when the action is missing");
    check(missing_metric.modes.empty(), "metric failure must return no partial modes");

    const DenseMass negative_mass{
        2,
        {
            {-1.0, 0.0}, {0.0, 0.0},
            {0.0, 0.0}, {-1.0, 0.0},
        },
    };
    const fd::ModalDeduplicationResult invalid_metric =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            candidates, 2, apply_dense_mass, &negative_mass, 1.0e-6, 1.0e3, 0.90);
    check(invalid_metric.status == fd::ModalDeduplicationStatus::invalid_metric,
          "non-positive self-norm must fail as an invalid mass metric");
    check(invalid_metric.modes.empty(), "invalid metric must return no partial modes");

    const DenseMass non_hermitian_mass{
        2,
        {
            {1.0, 0.0}, {0.0, 1.0},
            {0.0, 0.0}, {1.0, 0.0},
        },
    };
    const std::vector<fd::ModalCandidate> non_hermitian_probe{
        candidate(1.0e9, 1.0e-8, {1.0, 0.0}, {1.0, 0.0}, 42),
    };
    const fd::ModalDeduplicationResult non_hermitian_result =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            non_hermitian_probe, 2, apply_dense_mass, &non_hermitian_mass,
            1.0e-6, 1.0e3, 0.90);
    check(non_hermitian_result.status == fd::ModalDeduplicationStatus::invalid_metric,
          "a material imaginary component in q^H M q must fail the metric check");

    const fd::ModalDeduplicationResult action_failure =
        fd::deduplicate_modes_by_frequency_and_overlap_with_mass_action(
            candidates, 2, fail_mass_action, nullptr, 1.0e-6, 1.0e3, 0.90);
    check(action_failure.status == fd::ModalDeduplicationStatus::mass_action_failed,
          "failed mass action must be reported explicitly");
    check(action_failure.modes.empty(), "action failure must return no partial modes");
}

fd::SLEPcModalAcceptedMode slepc_mode(
    int eigenpair_index,
    double frequency_hz,
    double residual,
    std::vector<std::complex<double>> vector)
{
    fd::SLEPcModalAcceptedMode mode{};
    mode.eigenpair_index = eigenpair_index;
    mode.frequency_hz = frequency_hz;
    mode.relative_residual = residual;
    mode.mode_vector = std::move(vector);
    return mode;
}

void generic_slepc_finalizer_uses_dense_and_csr_tangent_mass_before_capping()
{
    const std::vector<fd::SLEPcModalAcceptedMode> candidates{
        slepc_mode(11, 100.0, 1.0e-6, {{1.0, 0.0}, {1.0e-3, 0.0}, {0.0, 0.0}}),
        slepc_mode(12, 100.0 + 1.0e-10, 1.0e-9,
                   {{0.0, 1.0}, {0.0, 1.0e-3}, {0.0, 0.0}}),
        slepc_mode(13, 100.0 - 1.0e-10, 2.0e-8,
                   {{1.0, 0.0}, {-1.0e-3, 0.0}, {0.0, 0.0}}),
        slepc_mode(14, 101.0, 1.0e-10, {{0.0, 0.0}, {0.0, 0.0}, {1.0, 0.0}}),
    };
    const double dense_mass[] = {
        1.0, 0.0, 0.0,
        0.0, 1.0e6, 0.0,
        0.0, 0.0, 1.0,
    };

    const fd::SLEPcModalCandidateFinalization nearest =
        fd::finalize_slepc_modal_candidates_with_dense_mass(
            candidates,
            3,
            dense_mass,
            1.0e-8,
            1.0e-12,
            0.90,
            100.95,
            2,
            fd::SLEPcModalCandidateSelection::nearest_target);
    check(nearest.success, "generic dense finalizer accepts a valid geometric tangent mass");
    check(nearest.unique_candidate_count_before_cap == 3 &&
              nearest.truncated_by_requested_count,
          "phase duplicates are removed before the public candidate cap");
    check(nearest.accepted_modes.size() == 2 &&
              nearest.accepted_modes[0].eigenpair_index == 12 &&
              nearest.accepted_modes[1].eigenpair_index == 14,
          "nearest-target selection keeps the lower-residual phase representative and nearest distinct mode");
    check(nearest.accepted_modes[0].mode_vector == candidates[1].mode_vector &&
              nearest.accepted_modes[0].relative_residual == candidates[1].relative_residual,
          "generic finalizer maps selected comparison copies back to raw amplitudes and residuals");

    const std::uint32_t row_offsets[] = {0, 1, 2, 3};
    const std::uint32_t columns[] = {0, 1, 2};
    const double values[] = {1.0, 1.0e6, 1.0};
    const fd::CsrMatrixView csr_mass{
        3, 3, row_offsets, 4, columns, 3, values, 3};
    const fd::SLEPcModalCandidateFinalization lowest =
        fd::finalize_slepc_modal_candidates_with_csr_mass(
            candidates,
            3,
            csr_mass,
            1.0e-8,
            1.0e-12,
            0.90,
            100.95,
            2,
            fd::SLEPcModalCandidateSelection::lowest_frequency);
    check(lowest.success && lowest.accepted_modes.size() == 2,
          "generic CSR finalizer accepts the same geometric mass without densifying it");
    check(lowest.accepted_modes[0].eigenpair_index == 13 &&
              lowest.accepted_modes[1].eigenpair_index == 12,
          "mass-orthogonal degenerate mode survives while lowest-frequency selection precedes the cap");
    check(lowest.accepted_modes[1].mode_vector == candidates[1].mode_vector,
          "CSR finalizer preserves the original unnormalized phase representative");

    const fd::SLEPcModalCandidateFinalization missing_mass =
        fd::finalize_slepc_modal_candidates_with_dense_mass(
            candidates,
            3,
            nullptr,
            1.0e-8,
            1.0e-12,
            0.90,
            100.95,
            2,
            fd::SLEPcModalCandidateSelection::nearest_target);
    check(!missing_mass.success &&
              missing_mass.deduplication_status == fd::ModalDeduplicationStatus::invalid_metric,
          "generic finalizer rejects missing mass instead of assuming identity");

    const std::uint32_t asymmetric_row_offsets[] = {0, 2, 3, 4};
    const std::uint32_t asymmetric_columns[] = {0, 1, 1, 2};
    const double asymmetric_values[] = {1.0, 0.25, 1.0e6, 1.0};
    const fd::CsrMatrixView asymmetric_mass{
        3, 3, asymmetric_row_offsets, 4,
        asymmetric_columns, 4, asymmetric_values, 4};
    const fd::SLEPcModalCandidateFinalization invalid_mass =
        fd::finalize_slepc_modal_candidates_with_csr_mass(
            candidates,
            3,
            asymmetric_mass,
            1.0e-8,
            1.0e-12,
            0.90,
            100.95,
            2,
            fd::SLEPcModalCandidateSelection::nearest_target);
    check(!invalid_mass.success &&
              invalid_mass.deduplication_status == fd::ModalDeduplicationStatus::invalid_metric,
          "generic CSR finalizer rejects an asymmetric tangent mass explicitly");
}

void generic_candidate_span_gram_rejects_indefinite_dense_and_csr_mass()
{
    const std::vector<fd::SLEPcModalAcceptedMode> two_axis_candidates{
        slepc_mode(51, 100.0, 1.0e-10, {{1.0, 0.0}, {0.0, 0.0}}),
        slepc_mode(52, 100.0, 1.0e-10, {{0.0, 0.0}, {1.0, 0.0}}),
    };
    const double indefinite_dense_mass[] = {
        1.0, 2.0,
        2.0, 1.0,
    };
    const auto dense_result =
        fd::finalize_slepc_modal_candidates_with_dense_mass(
            two_axis_candidates,
            2,
            indefinite_dense_mass,
            1.0e-8,
            1.0e-12,
            0.90,
            100.0,
            2,
            fd::SLEPcModalCandidateSelection::nearest_target);
    check(!dense_result.success &&
              dense_result.deduplication_status ==
                  fd::ModalDeduplicationStatus::invalid_metric &&
              dense_result.accepted_modes.empty(),
          "indefinite dense mass with positive diagonals must fail the candidate Gram check");

    const std::uint32_t row_offsets[] = {0, 2, 4};
    const std::uint32_t columns[] = {0, 1, 0, 1};
    const double indefinite_values[] = {1.0, 2.0, 2.0, 1.0};
    const fd::CsrMatrixView indefinite_csr_mass{
        2, 2, row_offsets, 3, columns, 4, indefinite_values, 4};
    const auto csr_result =
        fd::finalize_slepc_modal_candidates_with_csr_mass(
            two_axis_candidates,
            2,
            indefinite_csr_mass,
            1.0e-8,
            1.0e-12,
            0.90,
            100.0,
            2,
            fd::SLEPcModalCandidateSelection::nearest_target);
    check(!csr_result.success &&
              csr_result.deduplication_status ==
                  fd::ModalDeduplicationStatus::invalid_metric &&
              csr_result.accepted_modes.empty(),
          "indefinite CSR mass must fail without materializing the sparse operator");

    // Pairwise Cauchy bounds alone are insufficient: all three normalized
    // cross-overlaps are 0.9, but this candidate Gram matrix is indefinite.
    const std::vector<fd::SLEPcModalAcceptedMode> three_axis_candidates{
        slepc_mode(61, 100.0, 1.0e-10,
                   {{1.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}}),
        slepc_mode(62, 100.0, 1.0e-10,
                   {{0.0, 0.0}, {1.0, 0.0}, {0.0, 0.0}}),
        slepc_mode(63, 100.0, 1.0e-10,
                   {{0.0, 0.0}, {0.0, 0.0}, {1.0, 0.0}}),
    };
    const double pairwise_bounded_indefinite_mass[] = {
        1.0, 0.9, 0.9,
        0.9, 1.0, -0.9,
        0.9, -0.9, 1.0,
    };
    const auto pivoted_psd_result =
        fd::finalize_slepc_modal_candidates_with_dense_mass(
            three_axis_candidates,
            3,
            pairwise_bounded_indefinite_mass,
            1.0e-8,
            1.0e-12,
            0.90,
            100.0,
            3,
            fd::SLEPcModalCandidateSelection::nearest_target);
    check(!pivoted_psd_result.success &&
              pivoted_psd_result.deduplication_status ==
                  fd::ModalDeduplicationStatus::invalid_metric &&
              pivoted_psd_result.accepted_modes.empty(),
          "pivoted candidate Gram PSD check must reject global indefiniteness after pairwise Cauchy passes");
}

} // namespace

int main()
{
    slepc_destroy_sequence_stops_and_retains_remaining_handles_on_failure();
    slepc_hard_solve_error_prevents_followup_queries_and_cleanup();
    slepc_vector_query_error_leaves_acquired_views_in_quarantine();
    mode_filter_keeps_boundary_modes_inclusive();
    mode_deduplication_keeps_lower_residual_duplicate();
    strict_mode_deduplication_removes_phase_duplicates_without_rescaling_output();
    strict_mode_deduplication_is_invariant_to_finite_candidate_scale();
    strict_mode_deduplication_keeps_mass_orthogonal_degenerate_modes();
    strict_mode_deduplication_dense_and_csr_mass_actions_are_equivalent();
    strict_mode_deduplication_fails_without_a_valid_mass_action();
    generic_slepc_finalizer_uses_dense_and_csr_tangent_mass_before_capping();
    generic_candidate_span_gram_rejects_indefinite_dense_and_csr_mass();
    std::printf("PASS: generic_slepc_mass_action_finalizer_contract\n");
    return 0;
}
