/*
 * Manufactured deterministic delta-potential demag research contract.
 *
 * This test is retained even when the runtime experiment is a no-go. It pins
 * the exact linear identity, full-equation residual fallback, deterministic
 * relaxation decision, and accepted-base ownership needed to reproduce the
 * research result without exposing a production selector.
 */

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

struct ManufacturedDeltaPotentialResult {
    std::vector<double> potential;
    double energy_j = 0.0;
    double pre_fallback_full_relative_residual = 0.0;
    double full_relative_residual = 0.0;
    std::size_t full_residual_checks = 0;
    std::size_t fallback_count = 0;
    bool used_fresh_fallback = false;
};

struct DeltaPotentialDecision {
    bool armijo_accepted = false;
    std::string stop_reason;
};

struct DeltaPotentialOwnership {
    std::uint64_t accepted_generation = 0;
    std::uint64_t candidate_generation = 0;
    std::uint64_t accepted_candidate_token = 0;
    std::uint64_t candidate_token = 0;
    bool base_valid = false;
    bool candidate_valid = false;
};

std::size_t matrix_order(
    const std::vector<double> &matrix,
    const std::vector<double> &rhs)
{
    const std::size_t n = rhs.size();
    if (n == 0 || matrix.size() != n * n) {
        throw std::invalid_argument("delta-potential oracle requires a non-empty square matrix");
    }
    return n;
}

std::vector<double> solve_dense(
    const std::vector<double> &matrix,
    const std::vector<double> &rhs)
{
    const std::size_t n = matrix_order(matrix, rhs);
    std::vector<double> a = matrix;
    std::vector<double> x = rhs;

    for (std::size_t pivot = 0; pivot < n; ++pivot) {
        std::size_t pivot_row = pivot;
        for (std::size_t row = pivot + 1; row < n; ++row) {
            if (std::fabs(a[row * n + pivot]) >
                std::fabs(a[pivot_row * n + pivot])) {
                pivot_row = row;
            }
        }
        if (std::fabs(a[pivot_row * n + pivot]) <=
            std::numeric_limits<double>::epsilon()) {
            throw std::invalid_argument("delta-potential oracle matrix is singular");
        }
        if (pivot_row != pivot) {
            for (std::size_t col = pivot; col < n; ++col) {
                std::swap(a[pivot * n + col], a[pivot_row * n + col]);
            }
            std::swap(x[pivot], x[pivot_row]);
        }
        for (std::size_t row = pivot + 1; row < n; ++row) {
            const double factor = a[row * n + pivot] / a[pivot * n + pivot];
            a[row * n + pivot] = 0.0;
            for (std::size_t col = pivot + 1; col < n; ++col) {
                a[row * n + col] -= factor * a[pivot * n + col];
            }
            x[row] -= factor * x[pivot];
        }
    }
    for (std::size_t row = n; row-- > 0;) {
        for (std::size_t col = row + 1; col < n; ++col) {
            x[row] -= a[row * n + col] * x[col];
        }
        x[row] /= a[row * n + row];
    }
    return x;
}

double full_relative_residual(
    const std::vector<double> &matrix,
    const std::vector<double> &potential,
    const std::vector<double> &rhs)
{
    const std::size_t n = matrix_order(matrix, rhs);
    if (potential.size() != n) {
        throw std::invalid_argument("delta-potential oracle vector size mismatch");
    }
    double residual_squared = 0.0;
    double rhs_squared = 0.0;
    for (std::size_t row = 0; row < n; ++row) {
        double applied = 0.0;
        for (std::size_t col = 0; col < n; ++col) {
            applied += matrix[row * n + col] * potential[col];
        }
        const double residual = applied - rhs[row];
        residual_squared += residual * residual;
        rhs_squared += rhs[row] * rhs[row];
    }
    const double denominator = rhs_squared > 0.0 ? std::sqrt(rhs_squared) : 1.0;
    return std::sqrt(residual_squared) / denominator;
}

double quadratic_energy(
    const std::vector<double> &potential,
    const std::vector<double> &rhs)
{
    double energy = 0.0;
    for (std::size_t i = 0; i < rhs.size(); ++i) {
        energy -= 0.5 * potential[i] * rhs[i];
    }
    return energy;
}

void finish_result(
    ManufacturedDeltaPotentialResult &result,
    const std::vector<double> &matrix,
    const std::vector<double> &rhs)
{
    result.full_relative_residual =
        full_relative_residual(matrix, result.potential, rhs);
    result.energy_j = quadratic_energy(result.potential, rhs);
}

ManufacturedDeltaPotentialResult solve_manufactured_fresh_potential(
    const std::vector<double> &matrix,
    const std::vector<double> &rhs,
    double full_residual_tolerance)
{
    if (!(full_residual_tolerance > 0.0) ||
        !std::isfinite(full_residual_tolerance)) {
        throw std::invalid_argument("full residual tolerance must be finite and positive");
    }
    ManufacturedDeltaPotentialResult result;
    result.potential = solve_dense(matrix, rhs);
    finish_result(result, matrix, rhs);
    return result;
}

ManufacturedDeltaPotentialResult solve_manufactured_delta_potential(
    const std::vector<double> &matrix,
    const std::vector<double> &base_rhs,
    const std::vector<double> &base_potential,
    const std::vector<double> &trial_rhs,
    double full_residual_tolerance)
{
    const std::size_t n = matrix_order(matrix, trial_rhs);
    if (base_rhs.size() != n || base_potential.size() != n) {
        throw std::invalid_argument("delta-potential oracle base vector size mismatch");
    }
    if (!(full_residual_tolerance > 0.0) ||
        !std::isfinite(full_residual_tolerance)) {
        throw std::invalid_argument("full residual tolerance must be finite and positive");
    }
    std::vector<double> delta_rhs(n, 0.0);
    for (std::size_t i = 0; i < n; ++i) {
        delta_rhs[i] = trial_rhs[i] - base_rhs[i];
    }
    const std::vector<double> delta_potential = solve_dense(matrix, delta_rhs);
    ManufacturedDeltaPotentialResult result;
    result.potential.resize(n);
    for (std::size_t i = 0; i < n; ++i) {
        result.potential[i] = base_potential[i] + delta_potential[i];
    }
    result.full_residual_checks = 1;
    result.pre_fallback_full_relative_residual =
        full_relative_residual(matrix, result.potential, trial_rhs);
    if (!std::isfinite(result.pre_fallback_full_relative_residual) ||
        result.pre_fallback_full_relative_residual > full_residual_tolerance) {
        result.potential = solve_dense(matrix, trial_rhs);
        result.used_fresh_fallback = true;
        result.fallback_count = 1;
    }
    finish_result(result, matrix, trial_rhs);
    return result;
}

DeltaPotentialDecision make_delta_potential_decision(
    double energy_j,
    double armijo_limit_j,
    double torque,
    double torque_tolerance)
{
    DeltaPotentialDecision result;
    result.armijo_accepted = std::isfinite(energy_j) &&
                             std::isfinite(armijo_limit_j) &&
                             energy_j <= armijo_limit_j;
    result.stop_reason = result.armijo_accepted && std::isfinite(torque) &&
                                 std::isfinite(torque_tolerance) &&
                                 torque <= torque_tolerance
                             ? "torque"
                             : "continue";
    return result;
}

bool initialize_delta_potential_base(
    DeltaPotentialOwnership &ownership,
    std::uint64_t accepted_generation)
{
    ownership = {};
    ownership.accepted_generation = accepted_generation;
    ownership.base_valid = true;
    return true;
}

void record_delta_potential_candidate(
    DeltaPotentialOwnership &ownership,
    std::uint64_t accepted_generation,
    std::uint64_t candidate_token)
{
    if (!ownership.base_valid ||
        accepted_generation != ownership.accepted_generation) {
        return;
    }
    ownership.candidate_generation = accepted_generation;
    ownership.candidate_token = candidate_token;
    ownership.candidate_valid = true;
}

bool discard_delta_potential_candidate(
    DeltaPotentialOwnership &ownership,
    std::uint64_t accepted_generation,
    std::uint64_t candidate_token)
{
    if (!ownership.base_valid || !ownership.candidate_valid ||
        ownership.accepted_generation != accepted_generation ||
        ownership.candidate_generation != accepted_generation ||
        ownership.candidate_token != candidate_token) {
        return false;
    }
    ownership.candidate_generation = 0;
    ownership.candidate_token = 0;
    ownership.candidate_valid = false;
    return true;
}

bool accept_delta_potential_candidate(
    DeltaPotentialOwnership &ownership,
    std::uint64_t accepted_generation,
    std::uint64_t accepted_candidate_token,
    std::uint64_t observed_generation)
{
    if (ownership.base_valid && ownership.candidate_valid &&
        ownership.accepted_generation == accepted_generation &&
        ownership.candidate_generation == accepted_generation &&
        ownership.candidate_token == accepted_candidate_token &&
        observed_generation == accepted_generation + 1) {
        ownership.accepted_generation = observed_generation;
        ownership.accepted_candidate_token = ownership.candidate_token;
        ownership.candidate_generation = 0;
        ownership.candidate_token = 0;
        ownership.candidate_valid = false;
        return true;
    }
    ownership = {};
    return false;
}

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_near(double actual, double expected, double tolerance, const char *message)
{
    if (!std::isfinite(actual) || !std::isfinite(expected) ||
        std::fabs(actual - expected) > tolerance) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g (tol %.3e)\n",
            message,
            expected,
            actual,
            tolerance);
        std::exit(1);
    }
}

const std::vector<double> kOperator = {
    6.0, -2.0, 0.5,
    -2.0, 5.0, -1.0,
    0.5, -1.0, 4.0,
};

std::vector<double> apply(
    const std::vector<double> &matrix,
    const std::vector<double> &value)
{
    const std::size_t n = value.size();
    std::vector<double> result(n, 0.0);
    for (std::size_t row = 0; row < n; ++row) {
        for (std::size_t col = 0; col < n; ++col) {
            result[row] += matrix[row * n + col] * value[col];
        }
    }
    return result;
}

void manufactured_fresh_and_delta_match_relaxation_decision()
{
    const std::vector<double> base_phi = {0.75, -0.25, 0.5};
    const std::vector<double> trial_phi = {0.70, -0.15, 0.45};
    const std::vector<double> base_rhs = apply(kOperator, base_phi);
    const std::vector<double> trial_rhs = apply(kOperator, trial_phi);

    const ManufacturedDeltaPotentialResult fresh =
        solve_manufactured_fresh_potential(kOperator, trial_rhs, 1.0e-13);
    const ManufacturedDeltaPotentialResult delta =
        solve_manufactured_delta_potential(
            kOperator, base_rhs, base_phi, trial_rhs, 1.0e-13);

    check(fresh.potential.size() == trial_phi.size(), "fresh oracle potential size");
    check(delta.potential.size() == trial_phi.size(), "delta oracle potential size");
    for (std::size_t i = 0; i < trial_phi.size(); ++i) {
        check_near(fresh.potential[i], trial_phi[i], 2.0e-14,
                   "fresh oracle manufactured potential");
        check_near(delta.potential[i], fresh.potential[i], 2.0e-14,
                   "delta oracle matches fresh potential");
    }
    check_near(delta.full_relative_residual, fresh.full_relative_residual, 2.0e-14,
               "delta full-equation residual matches fresh");
    check_near(delta.energy_j, fresh.energy_j, 2.0e-14,
               "delta quadratic energy matches fresh");
    check(!delta.used_fresh_fallback, "exact correction does not use fallback");

    const double armijo_limit_j = fresh.energy_j + 1.0e-12;
    const DeltaPotentialDecision fresh_decision =
        make_delta_potential_decision(
            fresh.energy_j, armijo_limit_j, 7.5e-5, 1.0e-4);
    const DeltaPotentialDecision delta_decision =
        make_delta_potential_decision(
            delta.energy_j, armijo_limit_j, 7.5e-5, 1.0e-4);
    check(fresh_decision.armijo_accepted == delta_decision.armijo_accepted,
          "fresh and delta Armijo decisions are identical");
    check(fresh_decision.stop_reason == delta_decision.stop_reason,
          "fresh and delta stop reasons are identical");
    check(fresh_decision.armijo_accepted, "manufactured strict Armijo decision accepts");
    check(fresh_decision.stop_reason == "torque",
          "manufactured accepted endpoint stops on torque");
}

void full_residual_includes_base_error_and_falls_back_fresh()
{
    const std::vector<double> exact_base_phi = {0.75, -0.25, 0.5};
    std::vector<double> inexact_base_phi = exact_base_phi;
    inexact_base_phi[1] += 2.0e-4;
    const std::vector<double> trial_phi = {0.70, -0.15, 0.45};
    const std::vector<double> base_rhs = apply(kOperator, exact_base_phi);
    const std::vector<double> trial_rhs = apply(kOperator, trial_phi);

    const ManufacturedDeltaPotentialResult delta =
        solve_manufactured_delta_potential(
            kOperator, base_rhs, inexact_base_phi, trial_rhs, 1.0e-13);

    check(delta.used_fresh_fallback,
          "base error above the full residual threshold uses fresh fallback");
    check(delta.fallback_count == 1u,
          "full residual threshold violation increments exactly one fallback");
    check(delta.full_residual_checks == 1u,
          "every correction performs one full-equation residual check");
    check(delta.pre_fallback_full_relative_residual > 1.0e-13,
          "full residual exposes inherited accepted-base error");
    check(delta.full_relative_residual <= 1.0e-13,
          "fresh fallback satisfies the original residual threshold");
    for (std::size_t i = 0; i < trial_phi.size(); ++i) {
        check_near(delta.potential[i], trial_phi[i], 2.0e-14,
                   "fallback returns deterministic fresh-zero solution");
    }
}

void rejected_trial_cannot_become_next_correction_base()
{
    DeltaPotentialOwnership ownership{};
    check(initialize_delta_potential_base(ownership, 12u),
          "initial accepted base is recorded");
    check(ownership.accepted_generation == 12u,
          "accepted base generation is initialized");

    record_delta_potential_candidate(ownership, 12u, 101u);
    check(ownership.accepted_candidate_token == 0u,
          "completed trial is not accepted implicitly");
    check(discard_delta_potential_candidate(ownership, 12u, 101u),
          "rejected trial explicitly discards its candidate token");
    check(ownership.accepted_generation == 12u,
          "rejected trial leaves accepted base generation unchanged");
    check(ownership.accepted_candidate_token == 0u,
          "rejected trial token never becomes the base token");
    check(!ownership.candidate_valid,
          "rejected trial leaves no promotable candidate");
    check(!accept_delta_potential_candidate(ownership, 12u, 101u, 13u),
          "a discarded stale token cannot be promoted later");
    check(!ownership.base_valid && !ownership.candidate_valid,
          "stale-token promotion attempt resets ambiguous delta ownership");

    check(initialize_delta_potential_base(ownership, 12u),
          "ownership can be reinitialized after stale-token rejection");
    record_delta_potential_candidate(ownership, 12u, 202u);
    check(accept_delta_potential_candidate(ownership, 12u, 202u, 13u),
          "accepted-step generation advance promotes the exact accepted token");
    check(ownership.accepted_generation == 13u,
          "accepted base advances exactly one generation");
    check(ownership.accepted_candidate_token == 202u,
          "only the final accepted candidate becomes the next base");
    check(ownership.accepted_candidate_token != 101u,
          "earlier rejected candidate cannot contaminate the next base");

    record_delta_potential_candidate(ownership, 13u, 303u);
    check(!accept_delta_potential_candidate(ownership, 13u, 404u, 14u),
          "a different accepted endpoint cannot promote a cached candidate token");
    check(!ownership.base_valid && !ownership.candidate_valid,
          "accepted-token mismatch resets ambiguous delta ownership");

    check(initialize_delta_potential_base(ownership, 20u),
          "ownership can be reinitialized after fail-closed reset");
    record_delta_potential_candidate(ownership, 20u, 505u);
    check(!accept_delta_potential_candidate(ownership, 20u, 505u, 22u),
          "generation jump fails closed instead of promoting ambiguous state");
    check(!ownership.base_valid && !ownership.candidate_valid,
          "ambiguous generation transition resets delta ownership");
}

} // namespace

int main()
{
    manufactured_fresh_and_delta_match_relaxation_decision();
    full_residual_includes_base_error_and_falls_back_fresh();
    rejected_trial_cannot_become_next_correction_base();
    return 0;
}
