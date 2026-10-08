#include "cpu/frequency_domain/mode_deduplication.hpp"
#include "cpu/frequency_domain/mode_filter.hpp"

#include <complex>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
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

} // namespace

int main()
{
    mode_filter_keeps_boundary_modes_inclusive();
    mode_deduplication_keeps_lower_residual_duplicate();
    strict_mode_deduplication_removes_phase_duplicates_without_rescaling_output();
    strict_mode_deduplication_is_invariant_to_finite_candidate_scale();
    strict_mode_deduplication_keeps_mass_orthogonal_degenerate_modes();
    strict_mode_deduplication_dense_and_csr_mass_actions_are_equivalent();
    strict_mode_deduplication_fails_without_a_valid_mass_action();
    return 0;
}
