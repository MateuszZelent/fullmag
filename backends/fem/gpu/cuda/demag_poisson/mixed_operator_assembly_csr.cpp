/*
 * GPU CUDA Poisson demag CSR operator assembly source contract.
 *
 * This source owns the default two-pass assembly of the strict GPU Poisson
 * demag RHS, magnetic-recovery, and visual-recovery CSR operators for the
 * nonperiodic path:
 * - the symbolic pass builds each sparsity pattern from element DOF incidence
 *   (count, fill, then sort and deduplicate each row), so columns ascend
 *   within a row exactly as the legacy std::map iteration produced them;
 * - the numeric pass repeats the legacy element loop and adds every
 *   contribution into precomputed CSR positions in the same element,
 *   quadrature-point, i, k order, so every sum and every array is
 *   byte-identical to the row-map assembly.
 * It does not own validation, periodic node-class merging, the Robin boundary
 * mass, essential DOFs, recovery modes, fingerprints, upload, or destruction.
 */

#include "gpu/cuda/demag_poisson/mixed_operator_assembly.hpp"

#include "context.hpp"
#include "fem_common.hpp"
#include "fem_memory_trace.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem::demag_operator_assembly {

#if FULLMAG_HAS_MFEM_STACK
namespace {

struct CsrPattern {
    std::vector<uint32_t> row_offsets;
    std::vector<uint32_t> col_indices;
};

// Element DOF lists gathered once for the symbolic pass. The gather stops at
// the first element whose DOFs cannot be indexed safely; the numeric pass
// reaches that element and reports the original validation error first.
struct ElementIncidence {
    std::vector<uint64_t> potential_offsets{0u};
    std::vector<uint32_t> potential_dofs;
    std::vector<uint64_t> state_offsets{0u};
    std::vector<uint32_t> state_nodes;
    std::vector<uint8_t> magnetic;
    std::vector<uint8_t> integrated;
    int element_count = 0;
};

enum class IncidenceBlock {
    Rhs,
    MagneticRecovery,
    VisualRecovery,
};

void gather_element_incidence(
    const MixedDemagAssemblyInput &input,
    ElementIncidence &incidence)
{
    const Context &ctx = *input.ctx;
    const int element_count = input.mesh->GetNE();
    incidence.potential_offsets.reserve(static_cast<size_t>(element_count) + 1u);
    incidence.state_offsets.reserve(static_cast<size_t>(element_count) + 1u);
    incidence.magnetic.reserve(static_cast<size_t>(element_count));
    incidence.integrated.reserve(static_cast<size_t>(element_count));
    mfem::Array<int> potential_dofs;
    mfem::Array<int> state_dofs;
    for (int elem = 0; elem < element_count; ++elem) {
        const mfem::FiniteElement *potential_fe = input.potential_fes->GetFE(elem);
        if (potential_fe == nullptr) {
            return;
        }
        input.potential_fes->GetElementDofs(elem, potential_dofs);
        input.state_fes->GetElementDofs(elem, state_dofs);
        for (const int dof : potential_dofs) {
            const int gdof = signed_dof_index(dof);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= input.potential_rows) {
                return;
            }
        }
        for (const int dof : state_dofs) {
            const int gdof = signed_dof_index(dof);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= input.state_rows) {
                return;
            }
        }
        for (const int dof : potential_dofs) {
            incidence.potential_dofs.push_back(static_cast<uint32_t>(signed_dof_index(dof)));
        }
        for (const int dof : state_dofs) {
            incidence.state_nodes.push_back(static_cast<uint32_t>(signed_dof_index(dof)));
        }
        incidence.potential_offsets.push_back(incidence.potential_dofs.size());
        incidence.state_offsets.push_back(incidence.state_nodes.size());
        incidence.magnetic.push_back(
            ctx.mesh.magnetic_element_mask.empty() ||
                    ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] != 0u
                ? 1u
                : 0u);
        // The row-map loop creates entries only inside the quadrature loop.
        const mfem::IntegrationRule &ir = mfem::IntRules.Get(
            potential_fe->GetGeomType(),
            2 * potential_fe->GetOrder());
        incidence.integrated.push_back(ir.GetNPoints() > 0 ? 1u : 0u);
        incidence.element_count = elem + 1;
    }
}

// Calls visit(rows, row_count, cols, col_count) for each element block of one
// operator: RHS rows are potential DOFs with state-node columns; recovery rows
// are state nodes with potential-DOF columns.
template <typename Visit>
void for_each_incidence_block(
    const ElementIncidence &incidence,
    IncidenceBlock block,
    Visit &&visit)
{
    for (int elem = 0; elem < incidence.element_count; ++elem) {
        const size_t element = static_cast<size_t>(elem);
        if (incidence.integrated[element] == 0u ||
            (block != IncidenceBlock::VisualRecovery && incidence.magnetic[element] == 0u)) {
            continue;
        }
        const uint32_t *potential =
            incidence.potential_dofs.data() + incidence.potential_offsets[element];
        const size_t potential_count = static_cast<size_t>(
            incidence.potential_offsets[element + 1u] - incidence.potential_offsets[element]);
        const uint32_t *state = incidence.state_nodes.data() + incidence.state_offsets[element];
        const size_t state_count = static_cast<size_t>(
            incidence.state_offsets[element + 1u] - incidence.state_offsets[element]);
        if (block == IncidenceBlock::Rhs) {
            visit(potential, potential_count, state, state_count);
        } else {
            visit(state, state_count, potential, potential_count);
        }
    }
}

// Symbolic pass for one operator: count incidences per row, fill them, then
// sort and deduplicate each row in place. Transient memory is one uint32 per
// incidence plus two uint64 per row.
bool build_csr_pattern(
    const ElementIncidence &incidence,
    IncidenceBlock block,
    uint64_t rows,
    const char *capacity_error,
    CsrPattern &pattern,
    std::string &error)
{
    std::vector<uint64_t> offsets(static_cast<size_t>(rows) + 1u, 0u);
    for_each_incidence_block(
        incidence,
        block,
        [&offsets](const uint32_t *block_rows, size_t row_count, const uint32_t *, size_t col_count) {
            for (size_t r = 0; r < row_count; ++r) {
                offsets[static_cast<size_t>(block_rows[r]) + 1u] += col_count;
            }
        });
    for (size_t row = 1; row < offsets.size(); ++row) {
        offsets[row] += offsets[row - 1u];
    }
    std::vector<uint32_t> columns(static_cast<size_t>(offsets.back()), 0u);
    {
        std::vector<uint64_t> cursor(offsets.begin(), offsets.end() - 1);
        for_each_incidence_block(
            incidence,
            block,
            [&columns, &cursor](
                const uint32_t *block_rows,
                size_t row_count,
                const uint32_t *block_cols,
                size_t col_count) {
                for (size_t r = 0; r < row_count; ++r) {
                    uint64_t &next = cursor[static_cast<size_t>(block_rows[r])];
                    for (size_t c = 0; c < col_count; ++c) {
                        columns[static_cast<size_t>(next++)] = block_cols[c];
                    }
                }
            });
    }
    pattern.row_offsets.assign(static_cast<size_t>(rows) + 1u, 0u);
    uint64_t write = 0;
    for (size_t row = 0; row < static_cast<size_t>(rows); ++row) {
        const auto first = columns.begin() + static_cast<std::ptrdiff_t>(offsets[row]);
        const auto last = columns.begin() + static_cast<std::ptrdiff_t>(offsets[row + 1u]);
        std::sort(first, last);
        const auto unique_last = std::unique(first, last);
        // In place: the write cursor never passes the read cursor.
        for (auto column = first; column != unique_last; ++column) {
            columns[static_cast<size_t>(write++)] = *column;
        }
        if (write > std::numeric_limits<uint32_t>::max()) {
            error = capacity_error;
            return false;
        }
        pattern.row_offsets[row + 1u] = static_cast<uint32_t>(write);
    }
    pattern.col_indices.assign(
        columns.begin(),
        columns.begin() + static_cast<std::ptrdiff_t>(write));
    return true;
}

bool find_csr_position(
    const CsrPattern &pattern,
    uint32_t row,
    uint32_t column,
    size_t &position)
{
    const auto first = pattern.col_indices.begin() + pattern.row_offsets[row];
    const auto last = pattern.col_indices.begin() + pattern.row_offsets[row + 1u];
    const auto found = std::lower_bound(first, last, column);
    if (found == last || *found != column) {
        return false;
    }
    position = static_cast<size_t>(found - pattern.col_indices.begin());
    return true;
}

// Mirrors std::map::clear() in the row-map normalization for rows whose
// weight is not positive. Successful builds never clear a non-empty row:
// every recovery row with entries belongs to a magnetic node whose weight was
// checked positive, and every visual weight must be positive. The compaction
// therefore normally returns at once.
void drop_cleared_rows(
    CsrPattern &pattern,
    const std::vector<uint8_t> &cleared,
    std::vector<double> &values_x,
    std::vector<double> &values_y,
    std::vector<double> &values_z)
{
    const size_t rows = pattern.row_offsets.size() - 1u;
    bool clears_entries = false;
    for (size_t row = 0; row < rows && !clears_entries; ++row) {
        clears_entries = cleared[row] != 0u &&
            pattern.row_offsets[row + 1u] > pattern.row_offsets[row];
    }
    if (!clears_entries) {
        return;
    }
    std::vector<uint32_t> offsets(rows + 1u, 0u);
    uint32_t write = 0u;
    for (size_t row = 0; row < rows; ++row) {
        if (cleared[row] == 0u) {
            for (uint32_t entry = pattern.row_offsets[row];
                 entry < pattern.row_offsets[row + 1u];
                 ++entry) {
                pattern.col_indices[write] = pattern.col_indices[entry];
                values_x[write] = values_x[entry];
                values_y[write] = values_y[entry];
                values_z[write] = values_z[entry];
                ++write;
            }
        }
        offsets[row + 1u] = write;
    }
    pattern.row_offsets.swap(offsets);
    pattern.col_indices.resize(write);
    values_x.resize(write);
    values_y.resize(write);
    values_z.resize(write);
}

void publish_scalar_csr(
    DeviceCsrScalar &op,
    uint64_t rows,
    const CsrPattern &pattern,
    std::vector<double> &&values)
{
    op.rows = rows;
    op.nnz = static_cast<uint64_t>(pattern.col_indices.size());
    op.row_offsets = pattern.row_offsets;
    op.col_indices = pattern.col_indices;
    op.values = std::move(values);
}

} // namespace

bool assemble_mixed_demag_operators_with_csr(
    const MixedDemagAssemblyInput &input,
    GpuDemagPoissonWorkspace &workspace,
    std::string &error)
{
    const Context &ctx = *input.ctx;
    mfem::Mesh *mesh = input.mesh;
    mfem::FiniteElementSpace *potential_fes = input.potential_fes;
    mfem::FiniteElementSpace *state_fes = input.state_fes;
    const int expected_potential_order = input.expected_potential_order;
    const uint64_t state_rows = input.state_rows;
    const uint64_t potential_rows = input.potential_rows;
    const uint64_t rhs_rows = input.rhs_rows;
    if (input.periodic_node_class_reduction) {
        error = "strict FEM GPU demag CSR assembly does not merge periodic node classes";
        return false;
    }

    // Symbolic pass. Only one incidence array is alive at a time.
    CsrPattern rhs_pattern;
    CsrPattern recovery_pattern;
    CsrPattern visual_pattern;
    int pattern_element_count = 0;
    {
        ElementIncidence incidence;
        gather_element_incidence(input, incidence);
        pattern_element_count = incidence.element_count;
        if (!build_csr_pattern(
                incidence, IncidenceBlock::Rhs, rhs_rows,
                "strict FEM GPU demag CSR operator exceeds 32-bit index capacity",
                rhs_pattern, error) ||
            !build_csr_pattern(
                incidence, IncidenceBlock::MagneticRecovery, state_rows,
                "strict FEM GPU demag recovery CSR operator exceeds 32-bit index capacity",
                recovery_pattern, error) ||
            !build_csr_pattern(
                incidence, IncidenceBlock::VisualRecovery, state_rows,
                "demag visual recovery x exceeds 32-bit CSR capacity",
                visual_pattern, error)) {
            return false;
        }
    }
    fem_memory_trace_phase("gpu_demag:csr_pattern_built");

    // Numeric pass. Values start at +0.0 like value-initialized map entries.
    const size_t rhs_nnz = rhs_pattern.col_indices.size();
    const size_t recovery_nnz = recovery_pattern.col_indices.size();
    const size_t visual_nnz = visual_pattern.col_indices.size();
    std::vector<double> rhs_x(rhs_nnz, 0.0);
    std::vector<double> rhs_y(rhs_nnz, 0.0);
    std::vector<double> rhs_z(rhs_nnz, 0.0);
    std::vector<double> rec_x(recovery_nnz, 0.0);
    std::vector<double> rec_y(recovery_nnz, 0.0);
    std::vector<double> rec_z(recovery_nnz, 0.0);
    std::vector<double> visual_x(visual_nnz, 0.0);
    std::vector<double> visual_y(visual_nnz, 0.0);
    std::vector<double> visual_z(visual_nnz, 0.0);
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
    auto locate = [&](const CsrPattern &pattern, uint32_t row, uint32_t column, size_t &position) {
        if (find_csr_position(pattern, row, column, position)) {
            return true;
        }
        error = "strict FEM GPU demag CSR pattern is missing an element incidence";
        return false;
    };

    mfem::Array<int> potential_dofs;
    mfem::Array<int> state_dofs;
    mfem::DenseMatrix potential_dshape;
    mfem::Vector state_shape;
    std::vector<uint32_t> potential_true_dofs;
    std::vector<double> potential_signs;
    std::vector<uint32_t> state_nodes;
    std::vector<double> state_signs;
    std::vector<size_t> rhs_positions;
    std::vector<size_t> recovery_positions;
    std::vector<size_t> visual_positions;
    for (int elem = 0; elem < mesh->GetNE(); ++elem) {
        const mfem::FiniteElement *potential_fe = potential_fes->GetFE(elem);
        const mfem::FiniteElement *state_fe = state_fes->GetFE(elem);
        if (potential_fe == nullptr || potential_fe->GetOrder() != expected_potential_order) {
            error = "strict FEM GPU nonperiodic demag found an element whose order differs from the resolved potential order";
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
        potential_true_dofs.resize(static_cast<size_t>(potential_ndof));
        potential_signs.resize(static_cast<size_t>(potential_ndof));
        for (int i = 0; i < potential_ndof; ++i) {
            const int gdof = signed_dof_index(potential_dofs[i]);
            if (gdof < 0 || static_cast<uint64_t>(gdof) >= potential_rows) {
                error = "strict FEM GPU demag found an out-of-range potential DOF";
                return false;
            }
            potential_true_dofs[static_cast<size_t>(i)] = static_cast<uint32_t>(gdof);
            potential_signs[static_cast<size_t>(i)] = signed_dof_sign(potential_dofs[i]);
        }
        state_nodes.resize(static_cast<size_t>(state_ndof));
        state_signs.resize(static_cast<size_t>(state_ndof));
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
        if (ir.GetNPoints() > 0) {
            if (elem >= pattern_element_count) {
                error = "strict FEM GPU demag CSR pattern does not cover an integrated element";
                return false;
            }
            // One position lookup per element pair, reused by every quadrature point.
            const size_t pair_count =
                static_cast<size_t>(potential_ndof) * static_cast<size_t>(state_ndof);
            rhs_positions.resize(magnetic_element ? pair_count : 0u);
            recovery_positions.resize(magnetic_element ? pair_count : 0u);
            visual_positions.resize(pair_count);
            if (magnetic_element) {
                for (int i = 0; i < potential_ndof; ++i) {
                    for (int k = 0; k < state_ndof; ++k) {
                        if (!locate(
                                rhs_pattern,
                                potential_true_dofs[static_cast<size_t>(i)],
                                state_nodes[static_cast<size_t>(k)],
                                rhs_positions[static_cast<size_t>(i * state_ndof + k)])) {
                            return false;
                        }
                    }
                }
            }
            for (int i = 0; i < state_ndof; ++i) {
                for (int k = 0; k < potential_ndof; ++k) {
                    const size_t pair = static_cast<size_t>(i * potential_ndof + k);
                    if (!locate(
                            visual_pattern,
                            state_nodes[static_cast<size_t>(i)],
                            potential_true_dofs[static_cast<size_t>(k)],
                            visual_positions[pair])) {
                        return false;
                    }
                    if (magnetic_element &&
                        !locate(
                            recovery_pattern,
                            state_nodes[static_cast<size_t>(i)],
                            potential_true_dofs[static_cast<size_t>(k)],
                            recovery_positions[pair])) {
                        return false;
                    }
                }
            }
        }
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
                    for (int k = 0; k < state_ndof; ++k) {
                        const size_t position =
                            rhs_positions[static_cast<size_t>(i * state_ndof + k)];
                        const double coeff = potential_signs[static_cast<size_t>(i)] *
                            state_signs[static_cast<size_t>(k)] * ms * state_shape(k) * w;
                        if (!add_finite(
                                rhs_x[position],
                                coeff * potential_dshape(i, 0),
                                "RHS x value") ||
                            !add_finite(
                                rhs_y[position],
                                coeff * potential_dshape(i, 1),
                                "RHS y value") ||
                            !add_finite(
                                rhs_z[position],
                                coeff * potential_dshape(i, 2),
                                "RHS z value")) {
                            return false;
                        }
                    }
                }
            }
            for (int i = 0; i < state_ndof; ++i) {
                const double projection_weight = state_shape(i) * w;
                for (int k = 0; k < potential_ndof; ++k) {
                    const size_t pair = static_cast<size_t>(i * potential_ndof + k);
                    const double signed_weight = projection_weight *
                        potential_signs[static_cast<size_t>(k)];
                    const size_t visual_position = visual_positions[pair];
                    if (!add_finite(
                            visual_x[visual_position],
                            -signed_weight * potential_dshape(k, 0),
                            "visual recovery x value") ||
                        !add_finite(
                            visual_y[visual_position],
                            -signed_weight * potential_dshape(k, 1),
                            "visual recovery y value") ||
                        !add_finite(
                            visual_z[visual_position],
                            -signed_weight * potential_dshape(k, 2),
                            "visual recovery z value")) {
                        return false;
                    }
                    if (magnetic_element) {
                        const size_t recovery_position = recovery_positions[pair];
                        if (!add_finite(
                                rec_x[recovery_position],
                                -signed_weight * potential_dshape(k, 0),
                                "magnetic recovery x value") ||
                            !add_finite(
                                rec_y[recovery_position],
                                -signed_weight * potential_dshape(k, 1),
                                "magnetic recovery y value") ||
                            !add_finite(
                                rec_z[recovery_position],
                                -signed_weight * potential_dshape(k, 2),
                                "magnetic recovery z value")) {
                            return false;
                        }
                    }
                }
            }
        }
    }
    fem_memory_trace_phase("gpu_demag:csr_values_accumulated");

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

    // Same order, checks, and messages as the row-map normalization.
    std::vector<uint8_t> cleared_recovery_rows(static_cast<size_t>(state_rows), 0u);
    std::vector<uint8_t> cleared_visual_rows(static_cast<size_t>(state_rows), 0u);
    auto normalize_recovery = [&](const CsrPattern &pattern,
                                  std::vector<double> &values,
                                  const std::vector<double> &weights,
                                  std::vector<uint8_t> &cleared,
                                  const char *label) {
        for (size_t row = 0; row + 1u < pattern.row_offsets.size(); ++row) {
            if (!std::isfinite(weights[row])) {
                error = std::string("strict FEM GPU demag found a non-finite ") + label + " weight";
                return false;
            }
            if (weights[row] <= 0.0) {
                cleared[row] = 1u;
                continue;
            }
            for (uint32_t entry = pattern.row_offsets[row];
                 entry < pattern.row_offsets[row + 1u];
                 ++entry) {
                double &value = values[entry];
                value /= weights[row];
                if (!std::isfinite(value)) {
                    error = std::string("strict FEM GPU demag found a non-finite normalized ") + label;
                    return false;
                }
            }
        }
        return true;
    };
    if (!normalize_recovery(recovery_pattern, rec_x, recovery_weight, cleared_recovery_rows, "magnetic recovery x value") ||
        !normalize_recovery(recovery_pattern, rec_y, recovery_weight, cleared_recovery_rows, "magnetic recovery y value") ||
        !normalize_recovery(recovery_pattern, rec_z, recovery_weight, cleared_recovery_rows, "magnetic recovery z value") ||
        !normalize_recovery(visual_pattern, visual_x, visual_weight, cleared_visual_rows, "visual recovery x value") ||
        !normalize_recovery(visual_pattern, visual_y, visual_weight, cleared_visual_rows, "visual recovery y value") ||
        !normalize_recovery(visual_pattern, visual_z, visual_weight, cleared_visual_rows, "visual recovery z value")) {
        return false;
    }
    drop_cleared_rows(recovery_pattern, cleared_recovery_rows, rec_x, rec_y, rec_z);
    drop_cleared_rows(visual_pattern, cleared_visual_rows, visual_x, visual_y, visual_z);

    workspace.rhs.rows = rhs_rows;
    workspace.rhs.nnz = static_cast<uint64_t>(rhs_pattern.col_indices.size());
    workspace.rhs.row_offsets = std::move(rhs_pattern.row_offsets);
    workspace.rhs.col_indices = std::move(rhs_pattern.col_indices);
    workspace.rhs.values_x = std::move(rhs_x);
    workspace.rhs.values_y = std::move(rhs_y);
    workspace.rhs.values_z = std::move(rhs_z);
    publish_scalar_csr(workspace.recovery_x, state_rows, recovery_pattern, std::move(rec_x));
    publish_scalar_csr(workspace.recovery_y, state_rows, recovery_pattern, std::move(rec_y));
    publish_scalar_csr(workspace.recovery_z, state_rows, recovery_pattern, std::move(rec_z));
    publish_scalar_csr(workspace.visual_recovery_x, state_rows, visual_pattern, std::move(visual_x));
    publish_scalar_csr(workspace.visual_recovery_y, state_rows, visual_pattern, std::move(visual_y));
    publish_scalar_csr(workspace.visual_recovery_z, state_rows, visual_pattern, std::move(visual_z));
    return true;
}
#endif

} // namespace fullmag::fem::demag_operator_assembly
