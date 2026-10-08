#pragma once

#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <vector>

namespace fullmag::fem::transport {

// The relation is V[plus_dof] - V[minus_dof] = potential_jump_v.
// Only trace identifications belong here, never volume-conduction edges.
struct AffineTraceRelation {
    int minus_dof = -1;
    int plus_dof = -1;
    double potential_jump_v = 0.0;
    std::string id;
};

struct AffineTraceReduction {
    std::vector<int> full_to_reduced;
    std::vector<double> lift_v;
    int reduced_size = 0;
};

// This constructs Q and one evaluated L*d. It does not choose electrical
// component gauges, solve H1, or certify a terminal current. Each trace
// component uses its lowest full DOF as the zero-offset lift root.
inline AffineTraceReduction reduce_affine_trace_relations(
    int dof_count,
    const std::vector<AffineTraceRelation> &relations,
    double absolute_jump_tolerance_v,
    double relative_jump_tolerance)
{
    if (dof_count <= 0 || !std::isfinite(absolute_jump_tolerance_v) ||
        absolute_jump_tolerance_v < 0.0 ||
        !std::isfinite(relative_jump_tolerance) ||
        relative_jump_tolerance < 0.0) {
        throw std::invalid_argument("invalid affine trace dimensions or tolerance");
    }
    struct Arc {
        int next;
        long double jump_v;
    };
    std::vector<std::vector<Arc>> adjacency(static_cast<std::size_t>(dof_count));
    for (std::size_t index = 0; index < relations.size(); ++index) {
        const auto &relation = relations[index];
        if (relation.minus_dof < 0 || relation.minus_dof >= dof_count ||
            relation.plus_dof < 0 || relation.plus_dof >= dof_count ||
            relation.id.empty() || !std::isfinite(relation.potential_jump_v)) {
            throw std::invalid_argument("invalid affine trace relation");
        }
        const long double jump = relation.potential_jump_v;
        adjacency[static_cast<std::size_t>(relation.minus_dof)].push_back(
            {relation.plus_dof, jump});
        adjacency[static_cast<std::size_t>(relation.plus_dof)].push_back(
            {relation.minus_dof, -jump});
    }

    AffineTraceReduction reduction;
    reduction.full_to_reduced.assign(static_cast<std::size_t>(dof_count), -1);
    reduction.lift_v.resize(static_cast<std::size_t>(dof_count));
    std::vector<long double> offsets(static_cast<std::size_t>(dof_count), 0.0L);
    std::vector<int> queue;
    queue.reserve(static_cast<std::size_t>(dof_count));
    for (int root = 0; root < dof_count; ++root) {
        if (reduction.full_to_reduced[static_cast<std::size_t>(root)] >= 0) {
            continue;
        }
        const int component = reduction.reduced_size++;
        reduction.full_to_reduced[static_cast<std::size_t>(root)] = component;
        queue.clear();
        queue.push_back(root);
        for (std::size_t cursor = 0; cursor < queue.size(); ++cursor) {
            const int current = queue[cursor];
            for (const auto &arc : adjacency[static_cast<std::size_t>(current)]) {
                const auto next = static_cast<std::size_t>(arc.next);
                const long double candidate =
                    offsets[static_cast<std::size_t>(current)] + arc.jump_v;
                if (!std::isfinite(candidate)) {
                    throw std::invalid_argument("affine trace lift overflow");
                }
                if (reduction.full_to_reduced[next] < 0) {
                    reduction.full_to_reduced[next] = component;
                    offsets[next] = candidate;
                    queue.push_back(arc.next);
                }
            }
        }
    }
    for (int dof = 0; dof < dof_count; ++dof) {
        const double lift = static_cast<double>(offsets[static_cast<std::size_t>(dof)]);
        if (!std::isfinite(lift)) {
            throw std::invalid_argument("affine trace lift is not representable in double");
        }
        reduction.lift_v[static_cast<std::size_t>(dof)] = lift == 0.0 ? 0.0 : lift;
    }
    // Check every original row after conversion to the actual solver scalar.
    // A large jump elsewhere must not relax this relation's acceptance scale.
    for (const auto &relation : relations) {
        const long double measured =
            static_cast<long double>(reduction.lift_v[
                static_cast<std::size_t>(relation.plus_dof)]) -
            static_cast<long double>(reduction.lift_v[
                static_cast<std::size_t>(relation.minus_dof)]);
        const long double tolerance =
            static_cast<long double>(absolute_jump_tolerance_v) +
            static_cast<long double>(relative_jump_tolerance) *
                std::abs(static_cast<long double>(relation.potential_jump_v));
        if (!std::isfinite(tolerance) || !std::isfinite(measured) ||
            std::abs(measured - relation.potential_jump_v) > tolerance) {
            throw std::invalid_argument(
                "inconsistent or unrepresentable canonical affine trace lift: " + relation.id);
        }
    }
    return reduction;
}

} // namespace fullmag::fem::transport
