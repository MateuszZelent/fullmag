#include "cpu/mfem/workflows/antenna_field_solve/charge_current_response.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/charge_control_nullspace_rank.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>

namespace fullmag::fem::antenna_field_solve {
namespace {

constexpr std::size_t maximum_controls = 64;

double checked_double(long double value, const char *message)
{
    const double converted = static_cast<double>(value);
    if (!std::isfinite(value) || !std::isfinite(converted)) {
        throw std::runtime_error(message);
    }
    return converted == 0.0 ? 0.0 : converted;
}

void require_same_partition(const ChargeTraceSolution &reference,
    const ChargeTraceSolution &candidate)
{
    if (candidate.stable_vertex_identities.version != reference.stable_vertex_identities.version ||
        candidate.stable_vertex_identities.local_to_stable != reference.stable_vertex_identities.local_to_stable ||
        candidate.vertex_component_ids != reference.vertex_component_ids ||
        candidate.gauge_vertex_ids != reference.gauge_vertex_ids ||
        candidate.component_ids != reference.component_ids ||
        candidate.potential_vertex_values_v.size() != reference.potential_vertex_values_v.size() ||
        candidate.reaction_vertex_values_a.size() != reference.reaction_vertex_values_a.size()) {
        throw std::runtime_error("charge current response changed its vertex/component/gauge partition");
    }
}

void reject_constant_control(const ChargeTraceSolution &solution)
{
    std::map<std::uint64_t, std::pair<double, double>> ranges;
    for (std::size_t vertex = 0; vertex < solution.potential_vertex_values_v.size(); ++vertex) {
        const double value = solution.potential_vertex_values_v[vertex];
        if (!std::isfinite(value)) throw std::runtime_error("nonfinite unit control potential");
        const auto id = solution.vertex_component_ids.at(vertex);
        const auto [found, inserted] = ranges.emplace(id, std::make_pair(value, value));
        if (!inserted) {
            found->second.first = std::min(found->second.first, value);
            found->second.second = std::max(found->second.second, value);
        }
    }
    for (const auto &[id, range] : ranges) {
        (void)id;
        const long double scale = std::max(std::abs(static_cast<long double>(range.first)),
            std::abs(static_cast<long double>(range.second)));
        const long double difference = static_cast<long double>(range.second) - range.first;
        if (difference > 100.0L * std::numeric_limits<double>::epsilon() * scale) return;
    }
    throw std::invalid_argument("charge current control is constant on every electrical component");
}

long double reaction_product(const ChargeTraceSolution &unit,
    const ChargeTraceSolution &response)
{
    long double value = 0.0L;
    for (std::size_t vertex = 0; vertex < unit.potential_vertex_values_v.size(); ++vertex) {
        // The unit solve is for 1 V, so its numerical V values are U=V/(1 V).
        value += static_cast<long double>(unit.potential_vertex_values_v[vertex]) *
            response.reaction_vertex_values_a.at(vertex);
    }
    if (!std::isfinite(value)) throw std::runtime_error("charge current reaction product overflow");
    return value;
}

void validate_response_request(const ChargeCurrentResponseRequest &request)
{
    const auto &base = request.zero_baseline;
    const std::size_t count = request.columns.size();
    if (count == 0 || count > maximum_controls) {
        throw std::invalid_argument("charge current response requires between 1 and 64 controls");
    }
    for (const auto &relation : base.trace_relations) {
        if (relation.potential_jump_v != 0.0) {
            throw std::invalid_argument("charge current response requires zero baseline jumps");
        }
    }
    for (const auto &anchor : base.potential_anchors) {
        if (anchor.potential_v != 0.0) {
            throw std::invalid_argument("charge current response requires zero baseline anchors");
        }
    }
    std::set<std::string> ids;
    for (const auto &column : request.columns) {
        if (column.id.empty() || !ids.insert(column.id).second ||
            column.trace_jump_coefficients.size() != base.trace_relations.size() ||
            column.anchor_potential_coefficients.size() != base.potential_anchors.size() ||
            !std::isfinite(column.requested_conjugate_current_a)) {
            throw std::invalid_argument("invalid charge current control identity, dimensions or current");
        }
        for (const auto *values : {&column.trace_jump_coefficients, &column.anchor_potential_coefficients}) {
            for (double value : *values) {
                if (!std::isfinite(value)) throw std::invalid_argument("nonfinite charge current control coefficient");
            }
        }
    }
}

} // namespace

std::shared_ptr<const ChargeCurrentResponseSolution> solve_charge_current_response_prepared(
    const ChargeCurrentResponseRequest &request, const ChargeTraceWorkspace &workspace)
{
    validate_response_request(request);
    const auto &base = request.zero_baseline;
    const std::size_t count = request.columns.size();
    workspace.require_control_topology(base);
    const double pivot_tolerance = std::max(1.0e-10, 100.0 * base.algebraic_relative_tolerance);
    if (!std::isfinite(pivot_tolerance) || pivot_tolerance >= 1.0) {
        throw std::invalid_argument("charge H1 tolerance is insufficient for a current response rank gate");
    }
    for (const auto &column : request.columns) {
        if (workspace.is_component_constant_control(
                column.trace_jump_coefficients, column.anchor_potential_coefficients)) {
            throw std::invalid_argument("authored charge current control is constant on every electrical component");
        }
    }
    validate_charge_control_rank(request, workspace);
    std::vector<std::shared_ptr<const ChargeTraceSolution>> units;
    units.reserve(count);
    for (const auto &column : request.columns) {
        auto unit = workspace.solve(column.trace_jump_coefficients, column.anchor_potential_coefficients);
        if (!units.empty()) require_same_partition(*units.front(), *unit);
        reject_constant_control(*unit);
        units.push_back(std::move(unit));
    }
    auto result = std::make_shared<ChargeCurrentResponseSolution>();
    std::vector<long double> energy(count * count), scale(count), scaled(count * count);
    result->response_matrix_s.reserve(count * count);
    for (std::size_t row = 0; row < count; ++row) {
        for (std::size_t column = 0; column < count; ++column) {
            energy[row * count + column] = reaction_product(*units[row], *units[column]);
            result->response_matrix_s.push_back(checked_double(energy[row * count + column],
                "charge response matrix is not representable in double"));
        }
        const long double diagonal = energy[row * count + row];
        if (!(diagonal > 0.0L) || result->response_matrix_s[row * count + row] <= 0.0) {
            throw std::invalid_argument("charge current control has nonpositive or unrepresentable energy");
        }
        scale[row] = std::sqrt(diagonal);
    }
    for (std::size_t row = 0; row < count; ++row) {
        for (std::size_t column = 0; column < count; ++column) {
            const long double denominator = scale[row] * scale[column];
            const long double value = energy[row * count + column] / denominator;
            const long double symmetry = std::abs(energy[row * count + column] -
                energy[column * count + row]) / denominator;
            if (!std::isfinite(value) || !std::isfinite(symmetry) || symmetry > pivot_tolerance) {
                throw std::runtime_error("charge response failed its independent scaled symmetry gate");
            }
            scaled[row * count + column] = value;
            result->maximum_scaled_symmetry_error = std::max(result->maximum_scaled_symmetry_error,
                checked_double(symmetry, "charge response symmetry diagnostic overflow"));
        }
    }
    std::vector<long double> lower(count * count, 0.0L), intermediate(count), voltage(count);
    result->minimum_scaled_cholesky_pivot = std::numeric_limits<double>::infinity();
    // Factor even for zero requested currents. No symmetrization or diagonal shift.
    for (std::size_t row = 0; row < count; ++row) {
        for (std::size_t column = 0; column <= row; ++column) {
            long double value = scaled[row * count + column];
            for (std::size_t inner = 0; inner < column; ++inner) {
                value -= lower[row * count + inner] * lower[column * count + inner];
            }
            if (!std::isfinite(value)) throw std::runtime_error("charge response Cholesky overflow");
            if (row == column) {
                if (value <= pivot_tolerance) {
                    throw std::runtime_error("charge response is numerically unresolved after authored full-rank certification");
                }
                result->minimum_scaled_cholesky_pivot = std::min(result->minimum_scaled_cholesky_pivot,
                    checked_double(value, "charge response pivot diagnostic overflow"));
                lower[row * count + column] = std::sqrt(value);
            } else {
                lower[row * count + column] = value / lower[column * count + column];
                if (!std::isfinite(lower[row * count + column])) {
                    throw std::runtime_error("charge response Cholesky coefficient overflow");
                }
            }
        }
    }
    for (std::size_t row = 0; row < count; ++row) {
        long double value = -static_cast<long double>(request.columns[row].requested_conjugate_current_a) / scale[row];
        for (std::size_t column = 0; column < row; ++column) value -= lower[row * count + column] * intermediate[column];
        intermediate[row] = value / lower[row * count + row];
        if (!std::isfinite(intermediate[row])) throw std::runtime_error("charge response forward solve overflow");
    }
    for (std::size_t row = count; row-- > 0;) {
        long double value = intermediate[row];
        for (std::size_t column = row + 1; column < count; ++column) value -= lower[column * count + row] * voltage[column];
        voltage[row] = value / lower[row * count + row];
        if (!std::isfinite(voltage[row])) throw std::runtime_error("charge response backward solve overflow");
    }
    for (std::size_t control = 0; control < count; ++control) {
        result->control_ids.push_back(request.columns[control].id);
        result->control_voltages_v.push_back(checked_double(voltage[control] / scale[control],
            "charge control voltage overflow"));
    }
    const auto combine = [&](bool jumps) {
        const std::size_t size = jumps ? base.trace_relations.size() : base.potential_anchors.size();
        std::vector<double> values(size);
        for (std::size_t item = 0; item < size; ++item) {
            long double value = 0.0L;
            for (std::size_t control = 0; control < count; ++control) {
                const auto &coefficients = jumps ? request.columns[control].trace_jump_coefficients :
                    request.columns[control].anchor_potential_coefficients;
                value += static_cast<long double>(coefficients[item]) * result->control_voltages_v[control];
            }
            values[item] = checked_double(value, "charge final control combination overflow");
        }
        return values;
    };
    result->accepted_solution = workspace.solve(combine(true), combine(false));
    require_same_partition(*units.front(), *result->accepted_solution);
    for (std::size_t vertex = 0; vertex < units.front()->potential_vertex_values_v.size(); ++vertex) {
        long double predicted = 0.0L, local_scale = 0.0L;
        for (std::size_t control = 0; control < count; ++control) {
            const long double term = static_cast<long double>(units[control]->potential_vertex_values_v[vertex]) *
                result->control_voltages_v[control];
            predicted += term;
            local_scale += std::abs(term);
        }
        const long double measured = result->accepted_solution->potential_vertex_values_v[vertex];
        const long double tolerance = base.absolute_jump_tolerance_v +
            std::max(base.relative_jump_tolerance, 100.0 * base.algebraic_relative_tolerance) *
                std::max(local_scale, std::abs(measured));
        if (!std::isfinite(predicted) || !std::isfinite(tolerance) ||
            std::abs(predicted - measured) > tolerance) {
            throw std::runtime_error("charge response failed vertex-local potential superposition");
        }
    }
    for (std::size_t control = 0; control < count; ++control) {
        long double predicted = 0.0L;
        for (std::size_t column = 0; column < count; ++column) {
            predicted -= energy[control * count + column] * result->control_voltages_v[column];
        }
        const long double measured = -reaction_product(*units[control], *result->accepted_solution);
        const long double requested = request.columns[control].requested_conjugate_current_a;
        const long double residual = measured - requested;
        const long double tolerance = 1.0e-18L + 1.0e-8L * std::abs(requested);
        if (!std::isfinite(predicted) || std::abs(predicted - requested) > tolerance) {
            throw std::runtime_error("charge response failed its predicted signed current gate");
        }
        if (std::abs(residual) > tolerance) {
            throw std::runtime_error("charge response failed its final signed conjugate-current gate");
        }
        result->measured_conjugate_currents_a.push_back(checked_double(measured, "charge current overflow"));
        result->current_residuals_a.push_back(checked_double(residual, "charge current residual overflow"));
    }
    return result;
}

std::shared_ptr<const ChargeCurrentResponseSolution> solve_charge_current_response(
    const ChargeCurrentResponseRequest &request)
{
    validate_response_request(request);
    ChargeTraceWorkspace workspace(request.zero_baseline);
    return solve_charge_current_response_prepared(request, workspace);
}

} // namespace fullmag::fem::antenna_field_solve
