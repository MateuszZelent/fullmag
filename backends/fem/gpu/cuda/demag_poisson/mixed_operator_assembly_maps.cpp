/*
 * GPU CUDA Poisson demag row-map operator assembly source contract.
 *
 * This source owns the std::map row assembly of the strict GPU Poisson demag
 * RHS, magnetic-recovery, and visual-recovery CSR operators, including the
 * periodic node-class merge. Nonperiodic meshes use the two-pass CSR assembly;
 * this path serves periodic node-class reduction and is the byte-exact
 * reference for the CSR assembly in the contract test. The element loop,
 * normalization, and CSR fill are unchanged from the original operators.cpp.
 * It does not own validation, the Robin boundary mass, essential DOFs,
 * recovery modes, fingerprints, upload, or destruction.
 */

#include "gpu/cuda/demag_poisson/mixed_operator_assembly.hpp"

#include "context.hpp"
#include "fem_common.hpp"
#include "fem_memory_trace.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem::demag_operator_assembly {

#if FULLMAG_HAS_MFEM_STACK
bool assemble_mixed_demag_operators_with_row_maps(
    const MixedDemagAssemblyInput &input,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
    const Context &ctx = *input.ctx;
    mfem::Mesh *mesh = input.mesh;
    mfem::FiniteElementSpace *potential_fes = input.potential_fes;
    mfem::FiniteElementSpace *state_fes = input.state_fes;
    const bool periodic_node_class_reduction = input.periodic_node_class_reduction;
    const int expected_potential_order = input.expected_potential_order;
    const uint64_t state_rows = input.state_rows;
    const uint64_t potential_rows = input.potential_rows;
    const uint64_t rhs_rows = input.rhs_rows;

    workspace.rhs.rows = rhs_rows;
    workspace.recovery_x.rows = state_rows;
    workspace.recovery_y.rows = state_rows;
    workspace.recovery_z.rows = state_rows;
    workspace.rhs.row_offsets.assign(static_cast<size_t>(rhs_rows) + 1u, 0u);
    workspace.recovery_x.row_offsets.assign(static_cast<size_t>(state_rows) + 1u, 0u);
    workspace.recovery_y.row_offsets.assign(static_cast<size_t>(state_rows) + 1u, 0u);
    workspace.recovery_z.row_offsets.assign(static_cast<size_t>(state_rows) + 1u, 0u);

    using Triple = std::array<double, 3>;
    std::vector<std::map<uint32_t, Triple>> rhs_entries(static_cast<size_t>(rhs_rows));
    std::vector<std::map<uint32_t, double>> rec_x(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> rec_y(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> rec_z(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> visual_x(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> visual_y(static_cast<size_t>(state_rows));
    std::vector<std::map<uint32_t, double>> visual_z(static_cast<size_t>(state_rows));
    std::vector<double> recovery_weight(static_cast<size_t>(state_rows), 0.0);
    std::vector<double> visual_weight(static_cast<size_t>(state_rows), 0.0);
    std::vector<bool> magnetic_state_node(static_cast<size_t>(state_rows), false);

    auto add_finite = [&](double &accumulator, double contribution, const char *label) {
        if (!std::isfinite(contribution)) {
            error = std::string("strict FEM GPU demag found a non-finite ") + label;
            return false;
        }
        accumulator += contribution;
        if (!std::isfinite(accumulator)) {
            error = std::string("strict FEM GPU demag accumulated a non-finite ") + label;
            return false;
        }
        return true;
    };

    mfem::Array<int> potential_dofs;
    mfem::Array<int> state_dofs;
    mfem::DenseMatrix potential_dshape;
    mfem::Vector state_shape;
    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        const mfem::FiniteElement *potential_fe = potential_fes->GetFE(elem);
        const mfem::FiniteElement *state_fe = state_fes->GetFE(elem);
        if (potential_fe == nullptr || potential_fe->GetOrder() != expected_potential_order) {
            error = periodic_node_class_reduction
                ? "strict FEM GPU periodic demag found a non-P1 element in the potential FE space"
                : "strict FEM GPU nonperiodic demag found an element whose order differs from the resolved potential order";
            return false;
        }
        if (state_fe == nullptr || state_fe->GetOrder() != 1) {
            error = "strict FEM GPU demag requires P1 state elements";
            return false;
        }
        potential_fes->GetElementDofs(elem, potential_dofs);
        state_fes->GetElementDofs(elem, state_dofs);
        const int potential_ndof = potential_dofs.Size();
        const int state_ndof = state_dofs.Size();
        if (potential_ndof <= 0 || state_ndof <= 0) {
            error = "strict FEM GPU demag found an element without scalar DOFs";
            return false;
        }

        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);
        if (T == nullptr) {
            error = "strict FEM GPU demag found a null element transformation";
            return false;
        }
        std::vector<uint32_t> potential_true_dofs(static_cast<size_t>(potential_ndof));
        std::vector<double> potential_signs(static_cast<size_t>(potential_ndof));
        for (int i = 0; i < potential_ndof; ++i) {
            const int gdof = signed_dof_index(potential_dofs[i]);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= potential_rows) {
                error = "strict FEM GPU demag found an out-of-range potential DOF";
                return false;
            }
            potential_true_dofs[static_cast<size_t>(i)] = static_cast<uint32_t>(gdof);
            potential_signs[static_cast<size_t>(i)] = signed_dof_sign(potential_dofs[i]);
        }
        std::vector<uint32_t> state_nodes(static_cast<size_t>(state_ndof));
        std::vector<double> state_signs(static_cast<size_t>(state_ndof));
        for (int i = 0; i < state_ndof; ++i) {
            const int gdof = signed_dof_index(state_dofs[i]);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= state_rows) {
                error = "strict FEM GPU demag found an out-of-range P1 state DOF";
                return false;
            }
            state_nodes[static_cast<size_t>(i)] = static_cast<uint32_t>(gdof);
            state_signs[static_cast<size_t>(i)] = signed_dof_sign(state_dofs[i]);
        }

        const bool magnetic_element = ctx.mesh.magnetic_element_mask.empty() ||
            ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] != 0u;
        const mfem::IntegrationRule &ir =
            // Match MFEM's DomainLFGradIntegrator default exactly.  Its
            // implementation requests IntRules(geom, 2 * test_order);
            // using a higher order here changes the non-affine pyramid
            // quadrature result and breaks CPU/GPU operator parity.
            mfem::IntRules.Get(
                potential_fe->GetGeomType(),
                2 * potential_fe->GetOrder());
        state_shape.SetSize(state_ndof);
        potential_dshape.SetSize(potential_ndof, 3);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double jacobian_weight = T->Weight();
            if (!std::isfinite(jacobian_weight) || jacobian_weight <= 0.0) {
                error = "strict FEM GPU demag found a non-positive element Jacobian weight";
                return false;
            }
            const double w = ip.weight * jacobian_weight;
            if (!std::isfinite(w)) {
                error = "strict FEM GPU demag found a non-finite resolved-order quadrature weight";
                return false;
            }
            state_fe->CalcShape(ip, state_shape);
            potential_fe->CalcPhysDShape(*T, potential_dshape);

            double ms = ctx.material_fields.material.saturation_magnetisation;
            if (!ctx.material_fields.Ms_field.empty()) {
                ms = 0.0;
                for (int k = 0; k < state_ndof; ++k) {
                    ms += state_shape(k) * scalar_ms_value(
                        ctx, state_nodes[static_cast<size_t>(k)]);
                }
            }

            for (int i = 0; i < state_ndof; ++i) {
                const uint32_t node_i = state_nodes[static_cast<size_t>(i)];
                const double projection_weight = state_shape(i) * w;
                if (!add_finite(
                        visual_weight[static_cast<size_t>(node_i)],
                        projection_weight,
                        "visual recovery weight")) {
                    return false;
                }
                if (magnetic_element) {
                    magnetic_state_node[static_cast<size_t>(node_i)] = true;
                    if (!add_finite(
                            recovery_weight[static_cast<size_t>(node_i)],
                            projection_weight,
                            "magnetic recovery weight")) {
                        return false;
                    }
                }
            }

            if (magnetic_element) {
                for (int i = 0; i < potential_ndof; ++i) {
                    const uint32_t potential_dof = potential_true_dofs[static_cast<size_t>(i)];
                    const uint32_t row = periodic_node_class_reduction
                        ? periodic_scalar_column(ctx, potential_dof)
                        : potential_dof;
                    for (int k = 0; k < state_ndof; ++k) {
                        Triple &entry = rhs_entries[static_cast<size_t>(row)]
                            [state_nodes[static_cast<size_t>(k)]];
                        const double coeff = potential_signs[static_cast<size_t>(i)] *
                            state_signs[static_cast<size_t>(k)] * ms * state_shape(k) * w;
                        if (!add_finite(
                                entry[0],
                                coeff * potential_dshape(i, 0),
                                "RHS x value") ||
                            !add_finite(
                                entry[1],
                                coeff * potential_dshape(i, 1),
                                "RHS y value") ||
                            !add_finite(
                                entry[2],
                                coeff * potential_dshape(i, 2),
                                "RHS z value")) {
                            return false;
                        }
                    }
                }
            }
            for (int i = 0; i < state_ndof; ++i) {
                const uint32_t row = state_nodes[static_cast<size_t>(i)];
                const double projection_weight = state_shape(i) * w;
                for (int k = 0; k < potential_ndof; ++k) {
                    const uint32_t scalar_col = periodic_node_class_reduction
                        ? periodic_scalar_column(ctx, potential_true_dofs[static_cast<size_t>(k)])
                        : potential_true_dofs[static_cast<size_t>(k)];
                    const double signed_weight = projection_weight *
                        potential_signs[static_cast<size_t>(k)];
                    if (!add_finite(
                            visual_x[static_cast<size_t>(row)][scalar_col],
                            -signed_weight * potential_dshape(k, 0),
                            "visual recovery x value") ||
                        !add_finite(
                            visual_y[static_cast<size_t>(row)][scalar_col],
                            -signed_weight * potential_dshape(k, 1),
                            "visual recovery y value") ||
                        !add_finite(
                            visual_z[static_cast<size_t>(row)][scalar_col],
                            -signed_weight * potential_dshape(k, 2),
                            "visual recovery z value")) {
                        return false;
                    }
                    if (magnetic_element) {
                        if (!add_finite(
                                rec_x[static_cast<size_t>(row)][scalar_col],
                                -signed_weight * potential_dshape(k, 0),
                                "magnetic recovery x value") ||
                            !add_finite(
                                rec_y[static_cast<size_t>(row)][scalar_col],
                                -signed_weight * potential_dshape(k, 1),
                                "magnetic recovery y value") ||
                            !add_finite(
                                rec_z[static_cast<size_t>(row)][scalar_col],
                                -signed_weight * potential_dshape(k, 2),
                                "magnetic recovery z value")) {
                            return false;
                        }
                    }
                }
            }
        }
    }
    fem_memory_trace_phase("gpu_demag:row_maps_filled");

    if (periodic_node_class_reduction) {
        // The reduced-node map was validated against the P1 state rows above.
        // Periodic images are one DOF: merge recovery weights and rows per
        // class so every image recovers the same class field.
        const size_t reduced_count =
            static_cast<size_t>(ctx.mesh.periodic_reduced_node_count);
        std::vector<double> reduced_visual_weight(reduced_count, 0.0);
        std::vector<double> reduced_recovery_weight(reduced_count, 0.0);
        std::vector<bool> reduced_magnetic_node(reduced_count, false);
        std::vector<std::map<uint32_t, double>> reduced_vis_x(reduced_count);
        std::vector<std::map<uint32_t, double>> reduced_vis_y(reduced_count);
        std::vector<std::map<uint32_t, double>> reduced_vis_z(reduced_count);
        std::vector<std::map<uint32_t, double>> reduced_rec_x(reduced_count);
        std::vector<std::map<uint32_t, double>> reduced_rec_y(reduced_count);
        std::vector<std::map<uint32_t, double>> reduced_rec_z(reduced_count);

        auto merge_row_map = [&](std::map<uint32_t, double> &dst,
                                 const std::map<uint32_t, double> &src,
                                 const char *label) {
            for (const auto &[col, val] : src) {
                if (!add_finite(dst[col], val, label)) {
                    return false;
                }
            }
            return true;
        };

        for (size_t node = 0; node < visual_weight.size(); ++node) {
            const size_t reduced =
                static_cast<size_t>(ctx.mesh.periodic_reduced_node[node]);
            if (!add_finite(
                    reduced_visual_weight[reduced],
                    visual_weight[node],
                    "periodic visual recovery weight") ||
                !add_finite(
                    reduced_recovery_weight[reduced],
                    recovery_weight[node],
                    "periodic magnetic recovery weight") ||
                !merge_row_map(reduced_vis_x[reduced], visual_x[node], "periodic visual recovery x") ||
                !merge_row_map(reduced_vis_y[reduced], visual_y[node], "periodic visual recovery y") ||
                !merge_row_map(reduced_vis_z[reduced], visual_z[node], "periodic visual recovery z") ||
                !merge_row_map(reduced_rec_x[reduced], rec_x[node], "periodic magnetic recovery x") ||
                !merge_row_map(reduced_rec_y[reduced], rec_y[node], "periodic magnetic recovery y") ||
                !merge_row_map(reduced_rec_z[reduced], rec_z[node], "periodic magnetic recovery z")) {
                return false;
            }
            if (magnetic_state_node[node]) {
                reduced_magnetic_node[reduced] = true;
            }
        }

        for (size_t node = 0; node < visual_weight.size(); ++node) {
            const size_t reduced =
                static_cast<size_t>(ctx.mesh.periodic_reduced_node[node]);
            visual_weight[node] = reduced_visual_weight[reduced];
            recovery_weight[node] = reduced_recovery_weight[reduced];
            magnetic_state_node[node] = reduced_magnetic_node[reduced];
            visual_x[node] = reduced_vis_x[reduced];
            visual_y[node] = reduced_vis_y[reduced];
            visual_z[node] = reduced_vis_z[reduced];
            rec_x[node] = reduced_rec_x[reduced];
            rec_y[node] = reduced_rec_y[reduced];
            rec_z[node] = reduced_rec_z[reduced];
        }
    }

    for (size_t node = 0; node < visual_weight.size(); ++node) {
        if (!std::isfinite(visual_weight[node]) || visual_weight[node] <= 0.0) {
            error = "strict FEM GPU demag requires finite positive visual recovery weight for every P1 state node";
            return false;
        }
        if (magnetic_state_node[node] &&
            (!std::isfinite(recovery_weight[node]) || recovery_weight[node] <= 0.0)) {
            error = "strict FEM GPU demag requires finite positive magnetic recovery weight for every magnetic P1 state node";
            return false;
        }
    }

    auto normalize_recovery = [&](std::vector<std::map<uint32_t, double>> &values,
                                  const std::vector<double> &weights,
                                  const char *label) {
        for (size_t row = 0; row < values.size(); ++row) {
            if (!std::isfinite(weights[row])) {
                error = std::string("strict FEM GPU demag found a non-finite ") + label + " weight";
                return false;
            }
            if (weights[row] <= 0.0) {
                values[row].clear();
                continue;
            }
            for (auto &[column, value] : values[row]) {
                (void)column;
                value /= weights[row];
                if (!std::isfinite(value)) {
                    error = std::string("strict FEM GPU demag found a non-finite normalized ") + label;
                    return false;
                }
            }
        }
        return true;
    };
    if (!normalize_recovery(rec_x, recovery_weight, "magnetic recovery x value") ||
        !normalize_recovery(rec_y, recovery_weight, "magnetic recovery y value") ||
        !normalize_recovery(rec_z, recovery_weight, "magnetic recovery z value") ||
        !normalize_recovery(visual_x, visual_weight, "visual recovery x value") ||
        !normalize_recovery(visual_y, visual_weight, "visual recovery y value") ||
        !normalize_recovery(visual_z, visual_weight, "visual recovery z value")) {
        return false;
    }

    uint64_t rhs_nnz = 0;
    uint64_t rec_nnz = 0;
    for (uint64_t row = 0; row < rhs_rows; ++row) {
        rhs_nnz += rhs_entries[static_cast<size_t>(row)].size();
        if (rhs_nnz > std::numeric_limits<uint32_t>::max()) {
            error = "strict FEM GPU demag CSR operator exceeds 32-bit index capacity";
            return false;
        }
        workspace.rhs.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rhs_nnz);
    }
    for (uint64_t row = 0; row < state_rows; ++row) {
        rec_nnz += rec_x[static_cast<size_t>(row)].size();
        if (rec_nnz > std::numeric_limits<uint32_t>::max()) {
            error = "strict FEM GPU demag recovery CSR operator exceeds 32-bit index capacity";
            return false;
        }
        workspace.recovery_x.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
        workspace.recovery_y.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
        workspace.recovery_z.row_offsets[static_cast<size_t>(row) + 1u] =
            static_cast<uint32_t>(rec_nnz);
    }
    workspace.rhs.nnz = rhs_nnz;
    workspace.recovery_x.nnz = rec_nnz;
    workspace.recovery_y.nnz = rec_nnz;
    workspace.recovery_z.nnz = rec_nnz;
    workspace.visual_recovery_x.rows = state_rows;
    workspace.visual_recovery_y.rows = state_rows;
    workspace.visual_recovery_z.rows = state_rows;

    workspace.rhs.col_indices.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_x.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_y.reserve(static_cast<size_t>(rhs_nnz));
    workspace.rhs.values_z.reserve(static_cast<size_t>(rhs_nnz));
    for (uint64_t row = 0; row < rhs_rows; ++row) {
        for (const auto &entry : rhs_entries[static_cast<size_t>(row)]) {
            workspace.rhs.col_indices.push_back(entry.first);
            workspace.rhs.values_x.push_back(entry.second[0]);
            workspace.rhs.values_y.push_back(entry.second[1]);
            workspace.rhs.values_z.push_back(entry.second[2]);
        }
    }

    auto fill_recovery = [&](const std::vector<std::map<uint32_t, double>> &rows_in,
                             DeviceCsrScalar &op,
                             const char *label) {
        op.col_indices.reserve(static_cast<size_t>(op.nnz));
        op.values.reserve(static_cast<size_t>(op.nnz));
        op.row_offsets.assign(rows_in.size() + 1u, 0u);
        uint64_t nnz = 0;
        for (size_t row = 0; row < rows_in.size(); ++row) {
            nnz += rows_in[row].size();
            if (nnz > std::numeric_limits<uint32_t>::max()) {
                error = std::string(label) + " exceeds 32-bit CSR capacity";
                return false;
            }
            op.row_offsets[row + 1u] = static_cast<uint32_t>(nnz);
        }
        op.nnz = nnz;
        for (const auto &row_entries : rows_in) {
            for (const auto &entry : row_entries) {
                op.col_indices.push_back(entry.first);
                op.values.push_back(entry.second);
            }
        }
        return true;
    };
    if (!fill_recovery(rec_x, workspace.recovery_x, "demag recovery x") ||
        !fill_recovery(rec_y, workspace.recovery_y, "demag recovery y") ||
        !fill_recovery(rec_z, workspace.recovery_z, "demag recovery z") ||
        !fill_recovery(visual_x, workspace.visual_recovery_x, "demag visual recovery x") ||
        !fill_recovery(visual_y, workspace.visual_recovery_y, "demag visual recovery y") ||
        !fill_recovery(visual_z, workspace.visual_recovery_z, "demag visual recovery z")) {
        return false;
    }
    return true;
}
#endif

} // namespace fullmag::fem::demag_operator_assembly
