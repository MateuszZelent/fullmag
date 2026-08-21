/*
 * Native FEM tangent-plane implicit relaxation.
 *
 * Owns one CPU/MFEM tangent-plane step. The step solves a global tangent-space
 * mass-plus-exchange linear system, retracts the result back to |m| = 1, and
 * accepts it through the same native Armijo energy gate as the other FEM
 * minimizers. Non-exchange effective-field terms enter the tangent residual
 * explicitly through the current native H_eff snapshot.
 */

#include "cpu/mfem/relaxation/tangent_plane_implicit.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/relaxation/direct_energy_increment.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"
#include "cpu/mfem/runtime/mpi_init.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "fem_common.hpp"
#include "src/relaxation_numerics.hpp"
#include "src/relaxation_operator_units.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <vector>

#if defined(MFEM_USE_MPI) && defined(__unix__)
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace fullmag::fem {

namespace {

void update_implicit_step_size(
    FemRelaxationRuntimeState &state,
    double accepted_step,
    uint32_t backtracks)
{
    if (backtracks == 0u) {
        state.step_size =
            std::clamp(accepted_step * 1.2, relaxation::kMinStepSize, relaxation::kMaxStepSize);
    } else {
        state.step_size =
            std::clamp(accepted_step, relaxation::kMinStepSize, relaxation::kMaxStepSize);
    }
    state.use_bb1 = true;
    state.reset_consecutive = 0;
    state.nonlinear_cg_direction.clear();
}

#if FULLMAG_HAS_MFEM_STACK

inline constexpr double kLinearSolveRelativeTolerance = 1.0e-8;
inline constexpr double kLinearSolveAbsoluteTolerance = 1.0e-24;
inline constexpr int kLinearSolveMaximumIterations = 20000;

struct TangentFrame {
    std::array<double, 3> e1{0.0, 0.0, 0.0};
    std::array<double, 3> e2{0.0, 0.0, 0.0};
    bool active = false;
};

bool magnetic_node(
    const Context &ctx,
    size_t node)
{
    return ctx.mesh.magnetic_node_mask.empty() ||
        ctx.mesh.magnetic_node_mask[node] != 0u;
}

std::array<double, 3> cross(
    const std::array<double, 3> &a,
    const std::array<double, 3> &b)
{
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double norm(
    const std::array<double, 3> &value)
{
    return std::sqrt(
        value[0] * value[0] +
        value[1] * value[1] +
        value[2] * value[2]);
}

std::array<double, 3> normalized(
    const std::array<double, 3> &value)
{
    const double length = norm(value);
    if (length <= 0.0) {
        return {1.0, 0.0, 0.0};
    }
    const double inv = 1.0 / length;
    return {value[0] * inv, value[1] * inv, value[2] * inv};
}

double dot_node(
    const std::array<double, 3> &basis,
    const std::vector<double> &field,
    size_t node)
{
    const size_t base = node * 3u;
    return basis[0] * field[base + 0u] +
        basis[1] * field[base + 1u] +
        basis[2] * field[base + 2u];
}

std::vector<TangentFrame> build_tangent_frames(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    const size_t nodes = m_xyz.size() / 3u;
    std::vector<TangentFrame> frames(nodes);
    for (size_t node = 0; node < nodes; ++node) {
        if (!magnetic_node(ctx, node)) {
            continue;
        }
        const size_t base = node * 3u;
        const std::array<double, 3> m = normalized({
            m_xyz[base + 0u],
            m_xyz[base + 1u],
            m_xyz[base + 2u],
        });
        const std::array<double, 3> reference =
            std::abs(m[2]) < 0.9 ? std::array<double, 3>{0.0, 0.0, 1.0}
                                 : std::array<double, 3>{1.0, 0.0, 0.0};
        TangentFrame frame{};
        frame.e1 = normalized(cross(reference, m));
        frame.e2 = normalized(cross(m, frame.e1));
        frame.active = true;
        frames[node] = frame;
    }
    return frames;
}

bool all_finite(const std::vector<double> &values)
{
    return std::all_of(
        values.begin(),
        values.end(),
        [](double value) { return std::isfinite(value); });
}

bool apply_mass_to_field(
    mfem::SparseMatrix &mass,
    const std::vector<double> &field_xyz,
    std::vector<double> &mass_field_xyz)
{
    const int nodes = static_cast<int>(field_xyz.size() / 3u);
    mfem::Vector component_in(nodes);
    mfem::Vector component_out(nodes);
    mass_field_xyz.assign(field_xyz.size(), 0.0);
    for (int component = 0; component < 3; ++component) {
        double *in_data = audited_host_write(component_in);
        for (int node = 0; node < nodes; ++node) {
            in_data[node] =
                field_xyz[static_cast<size_t>(node) * 3u + static_cast<size_t>(component)];
        }
        mass.Mult(component_in, component_out);
        const double *out_data = audited_host_read(component_out);
        for (int node = 0; node < nodes; ++node) {
            mass_field_xyz[static_cast<size_t>(node) * 3u +
                static_cast<size_t>(component)] = out_data[node];
        }
    }
    return all_finite(mass_field_xyz);
}

void expand_tangent_solution_to_field(
    const std::vector<TangentFrame> &frames,
    const mfem::Vector &q,
    std::vector<double> &field_xyz)
{
    const double *q_data = audited_host_read(q);
    field_xyz.assign(frames.size() * 3u, 0.0);
    for (size_t node = 0; node < frames.size(); ++node) {
        const TangentFrame &frame = frames[node];
        if (!frame.active) {
            continue;
        }
        const size_t base = node * 3u;
        const int q_base = static_cast<int>(node * 2u);
        for (size_t component = 0; component < 3u; ++component) {
            field_xyz[base + component] =
                q_data[q_base + 0] * frame.e1[component] +
                q_data[q_base + 1] * frame.e2[component];
        }
    }
}

double tangent_basis_dot(
    const TangentFrame &row_frame,
    size_t row_component,
    const TangentFrame &col_frame,
    size_t col_component)
{
    const std::array<double, 3> &row_basis =
        row_component == 0u ? row_frame.e1 : row_frame.e2;
    const std::array<double, 3> &col_basis =
        col_component == 0u ? col_frame.e1 : col_frame.e2;
    return row_basis[0] * col_basis[0] +
        row_basis[1] * col_basis[1] +
        row_basis[2] * col_basis[2];
}

double dot_array3(
    const std::array<double, 3> &a,
    const std::array<double, 3> &b)
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

std::array<double, 3> crystal_axis3(const Context &ctx)
{
    const auto &a = ctx.anisotropy.cubic_axis1;
    const auto &b = ctx.anisotropy.cubic_axis2;
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

using Matrix3 = std::array<std::array<double, 3>, 3>;

void add_outer_scaled(
    Matrix3 &matrix,
    const std::array<double, 3> &a,
    const std::array<double, 3> &b,
    double scale)
{
    for (size_t row = 0; row < 3u; ++row) {
        for (size_t col = 0; col < 3u; ++col) {
            matrix[row][col] += scale * a[row] * b[col];
        }
    }
}

void add_uniaxial_anisotropy_jacobian(
    const Context &ctx,
    const std::array<double, 3> &m,
    size_t node,
    Matrix3 &jacobian,
    std::array<double, 3> &h_ani)
{
    if (!ctx.anisotropy.uniaxial_enabled) {
        return;
    }
    const double ms = scalar_field_value(
        ctx.material_fields.Ms_field,
        node,
        ctx.material_fields.material.saturation_magnetisation);
    if (ms <= 0.0) {
        return;
    }
    const double ku = scalar_field_value(
        ctx.material_fields.Ku_field,
        node,
        ctx.anisotropy.uniaxial_Ku);
    const double ku2 = scalar_field_value(
        ctx.material_fields.Ku2_field,
        node,
        ctx.anisotropy.uniaxial_Ku2);
    if (ku == 0.0 && ku2 == 0.0) {
        return;
    }
    const auto &u = ctx.anisotropy.uniaxial_axis;
    const double s = m[0] * u[0] + m[1] * u[1] + m[2] * u[2];
    const double prefactor1 = 2.0 * ku / (kMu0 * ms);
    const double prefactor2 = ku2 != 0.0 ? 4.0 * ku2 / (kMu0 * ms) : 0.0;
    const double h_coeff = prefactor1 * s + prefactor2 * s * s * s;
    const double dh_coeff = prefactor1 + 3.0 * prefactor2 * s * s;
    for (size_t component = 0; component < 3u; ++component) {
        h_ani[component] += h_coeff * u[component];
    }
    add_outer_scaled(jacobian, u, u, dh_coeff);
}

void add_cubic_anisotropy_jacobian(
    const Context &ctx,
    const std::array<double, 3> &m,
    size_t node,
    Matrix3 &jacobian,
    std::array<double, 3> &h_ani)
{
    if (!ctx.anisotropy.cubic_enabled) {
        return;
    }
    const double ms = scalar_field_value(
        ctx.material_fields.Ms_field,
        node,
        ctx.material_fields.material.saturation_magnetisation);
    if (ms <= 0.0) {
        return;
    }
    const double kc1 = scalar_field_value(
        ctx.material_fields.Kc1_field,
        node,
        ctx.anisotropy.cubic_Kc1);
    const double kc2 = scalar_field_value(
        ctx.material_fields.Kc2_field,
        node,
        ctx.anisotropy.cubic_Kc2);
    const double kc3 = scalar_field_value(
        ctx.material_fields.Kc3_field,
        node,
        ctx.anisotropy.cubic_Kc3);
    if (kc1 == 0.0 && kc2 == 0.0 && kc3 == 0.0) {
        return;
    }
    const std::array<std::array<double, 3>, 3> axis = {
        ctx.anisotropy.cubic_axis1,
        ctx.anisotropy.cubic_axis2,
        crystal_axis3(ctx),
    };
    const double mc[3] = {
        dot_array3(m, axis[0]),
        dot_array3(m, axis[1]),
        dot_array3(m, axis[2]),
    };
    const double m2[3] = {
        mc[0] * mc[0],
        mc[1] * mc[1],
        mc[2] * mc[2],
    };
    const double sigma = m2[0] * m2[1] + m2[1] * m2[2] + m2[0] * m2[2];
    const double inv_mu0_ms = 1.0 / (kMu0 * ms);
    const double pf1 = -2.0 * kc1 * inv_mu0_ms;
    const double pf2 = -2.0 * kc2 * inv_mu0_ms;
    const double pf3 = -4.0 * kc3 * inv_mu0_ms;

    double h_crystal[3] = {0.0, 0.0, 0.0};
    double j_crystal[3][3] = {{0.0, 0.0, 0.0}, {0.0, 0.0, 0.0}, {0.0, 0.0, 0.0}};
    const double dsigma[3] = {
        2.0 * mc[0] * (m2[1] + m2[2]),
        2.0 * mc[1] * (m2[0] + m2[2]),
        2.0 * mc[2] * (m2[0] + m2[1]),
    };
    for (size_t row = 0; row < 3u; ++row) {
        const size_t a = (row + 1u) % 3u;
        const size_t b = (row + 2u) % 3u;
        const double t = m2[a] + m2[b];
        h_crystal[row] += pf1 * mc[row] * t;
        j_crystal[row][row] += pf1 * t;
        j_crystal[row][a] += pf1 * 2.0 * mc[row] * mc[a];
        j_crystal[row][b] += pf1 * 2.0 * mc[row] * mc[b];

        h_crystal[row] += pf2 * mc[row] * m2[a] * m2[b];
        j_crystal[row][row] += pf2 * m2[a] * m2[b];
        j_crystal[row][a] += pf2 * 2.0 * mc[row] * mc[a] * m2[b];
        j_crystal[row][b] += pf2 * 2.0 * mc[row] * m2[a] * mc[b];

        h_crystal[row] += pf3 * sigma * mc[row] * t;
        j_crystal[row][row] += pf3 * (dsigma[row] * mc[row] * t + sigma * t);
        j_crystal[row][a] += pf3 *
            (dsigma[a] * mc[row] * t + sigma * mc[row] * 2.0 * mc[a]);
        j_crystal[row][b] += pf3 *
            (dsigma[b] * mc[row] * t + sigma * mc[row] * 2.0 * mc[b]);
    }

    for (size_t crystal = 0; crystal < 3u; ++crystal) {
        for (size_t component = 0; component < 3u; ++component) {
            h_ani[component] += h_crystal[crystal] * axis[crystal][component];
        }
    }
    for (size_t row = 0; row < 3u; ++row) {
        for (size_t col = 0; col < 3u; ++col) {
            add_outer_scaled(jacobian, axis[row], axis[col], j_crystal[row][col]);
        }
    }
}

bool add_local_anisotropy_tangent_hessian(
    const Context &ctx,
    const std::vector<TangentFrame> &frames,
    const std::vector<double> &m_xyz,
    double implicit_weight,
    mfem::SparseMatrix &op)
{
    if ((!ctx.anisotropy.uniaxial_enabled && !ctx.anisotropy.cubic_enabled) ||
        ctx.integration_weights.mfem_lumped_mass.size() < frames.size()) {
        return false;
    }
    bool added = false;
    for (size_t node = 0; node < frames.size(); ++node) {
        const TangentFrame &frame = frames[node];
        if (!frame.active) {
            continue;
        }
        const double mass = ctx.integration_weights.mfem_lumped_mass[node];
        if (mass <= 0.0) {
            continue;
        }
        const size_t base = node * 3u;
        const std::array<double, 3> m = normalized({
            m_xyz[base + 0u],
            m_xyz[base + 1u],
            m_xyz[base + 2u],
        });
        Matrix3 jacobian{};
        std::array<double, 3> h_ani{0.0, 0.0, 0.0};
        add_uniaxial_anisotropy_jacobian(ctx, m, node, jacobian, h_ani);
        add_cubic_anisotropy_jacobian(ctx, m, node, jacobian, h_ani);
        const double mdoth = dot_array3(m, h_ani);
        const std::array<std::array<double, 3>, 2> tangent = {frame.e1, frame.e2};
        for (size_t row = 0; row < 2u; ++row) {
            for (size_t col = 0; col < 2u; ++col) {
                double j_tangent = 0.0;
                for (size_t i = 0; i < 3u; ++i) {
                    for (size_t j = 0; j < 3u; ++j) {
                        j_tangent += tangent[row][i] * jacobian[i][j] * tangent[col][j];
                    }
                }
                const double curvature =
                    (row == col ? mdoth : 0.0) - j_tangent;
                const double ms = scalar_field_value(
                    ctx.material_fields.Ms_field,
                    node,
                    ctx.material_fields.material.saturation_magnetisation);
                const double value =
                    relaxation::local_field_curvature_operator_entry(
                        implicit_weight, ms, mass, curvature);
                if (std::isfinite(value) && value != 0.0) {
                    op.Add(
                        2 * static_cast<int>(node) + static_cast<int>(row),
                        2 * static_cast<int>(node) + static_cast<int>(col),
                        value);
                    added = true;
                }
            }
        }
    }
    return added;
}

bool add_local_zeeman_tangent_curvature(
    const Context &ctx,
    const std::vector<TangentFrame> &frames,
    const std::vector<double> &m_xyz,
    double implicit_weight,
    mfem::SparseMatrix &op)
{
    if (!ctx.zeeman.has_external_field ||
        ctx.zeeman.h_ext_xyz.size() < frames.size() * 3u ||
        ctx.integration_weights.mfem_lumped_mass.size() < frames.size()) {
        return false;
    }

    bool added = false;
    for (size_t node = 0; node < frames.size(); ++node) {
        const TangentFrame &frame = frames[node];
        if (!frame.active) {
            continue;
        }
        const double mass = ctx.integration_weights.mfem_lumped_mass[node];
        if (mass <= 0.0) {
            continue;
        }
        const size_t base = node * 3u;
        const std::array<double, 3> m = normalized({
            m_xyz[base + 0u],
            m_xyz[base + 1u],
            m_xyz[base + 2u],
        });
        const std::array<double, 3> h_ext = {
            ctx.zeeman.h_ext_xyz[base + 0u],
            ctx.zeeman.h_ext_xyz[base + 1u],
            ctx.zeeman.h_ext_xyz[base + 2u],
        };
        const double curvature = dot_array3(m, h_ext);
        const double ms = scalar_field_value(
            ctx.material_fields.Ms_field,
            node,
            ctx.material_fields.material.saturation_magnetisation);
        const double value = relaxation::local_field_curvature_operator_entry(
            implicit_weight, ms, mass, curvature);
        if (!std::isfinite(value) || value == 0.0) {
            continue;
        }
        op.Add(2 * static_cast<int>(node) + 0, 2 * static_cast<int>(node) + 0, value);
        op.Add(2 * static_cast<int>(node) + 1, 2 * static_cast<int>(node) + 1, value);
        added = true;
    }
    return added;
}

bool has_active_dmi_tangent_operator(const Context &ctx)
{
    return (ctx.dmi.interfacial_enabled &&
            (ctx.dmi.interfacial_D != 0.0 || !ctx.material_fields.Dind_field.empty())) ||
        (ctx.dmi.bulk_enabled &&
         (ctx.dmi.bulk_D != 0.0 || !ctx.material_fields.Dbulk_field.empty()));
}

bool has_active_demag_tangent_operator(const Context &ctx)
{
    const size_t expected_len = static_cast<size_t>(ctx.mesh.n_nodes) * 3u;
    return ctx.demag.enabled &&
        (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET ||
         ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN ||
         ctx.demag.realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) &&
        ctx.demag.h_xyz.size() >= expected_len;
}

bool has_active_matrix_free_tangent_operator(const Context &ctx)
{
    return has_active_dmi_tangent_operator(ctx) ||
        has_active_demag_tangent_operator(ctx);
}

std::unique_ptr<mfem::SparseMatrix> assemble_tangent_plane_operator(
    const Context &ctx,
    const std::vector<TangentFrame> &frames,
    const std::vector<double> &m_xyz,
    mfem::SparseMatrix &mass,
    mfem::SparseMatrix &exchange,
    double implicit_weight,
    bool &has_local_indefinite_terms)
{
    const int nodes = static_cast<int>(frames.size());
    auto op = std::make_unique<mfem::SparseMatrix>(nodes * 2, nodes * 2);
    mfem::Array<int> cols;
    mfem::Vector vals;
    auto add_scalar_row =
        [&](int i, mfem::SparseMatrix &scalar_op, double scale) {
            scalar_op.GetRow(i, cols, vals);
            const TangentFrame &row_frame = frames[static_cast<size_t>(i)];
            for (int k = 0; k < cols.Size(); ++k) {
                const int j = cols[k];
                const TangentFrame &col_frame = frames[static_cast<size_t>(j)];
                if (!col_frame.active) {
                    continue;
                }
                const double scalar_value = scale * vals[k];
                if (scalar_value == 0.0) {
                    continue;
                }
                for (size_t row_component = 0; row_component < 2u; ++row_component) {
                    for (size_t col_component = 0; col_component < 2u; ++col_component) {
                        const double value =
                            scalar_value *
                            tangent_basis_dot(row_frame, row_component, col_frame, col_component);
                        if (value != 0.0) {
                            op->Add(
                                2 * i + static_cast<int>(row_component),
                                2 * j + static_cast<int>(col_component),
                                value);
                        }
                    }
                }
            }
        };
    for (int i = 0; i < nodes; ++i) {
        const TangentFrame &row_frame = frames[static_cast<size_t>(i)];
        if (!row_frame.active) {
            op->Add(2 * i + 0, 2 * i + 0, 1.0);
            op->Add(2 * i + 1, 2 * i + 1, 1.0);
            continue;
        }
        add_scalar_row(i, mass, 1.0);
        add_scalar_row(
            i,
            exchange,
            relaxation::exchange_hessian_scale_from_step_m_per_a(implicit_weight));
    }
    const bool has_local_anisotropy =
        add_local_anisotropy_tangent_hessian(ctx, frames, m_xyz, implicit_weight, *op);
    const bool has_local_zeeman =
        add_local_zeeman_tangent_curvature(ctx, frames, m_xyz, implicit_weight, *op);
    has_local_indefinite_terms = has_local_anisotropy || has_local_zeeman;
    op->Finalize();
    return op;
}

class MatrixFreeTangentPlaneOperator final : public mfem::Operator {
public:
    MatrixFreeTangentPlaneOperator(
        Context &ctx,
        mfem::SparseMatrix &base_operator,
        const std::vector<TangentFrame> &frames,
        const std::vector<double> &m_xyz,
        double implicit_weight)
        : mfem::Operator(base_operator.Height(), base_operator.Width()),
          ctx_(ctx),
          base_operator_(base_operator),
          frames_(frames),
          m_xyz_(m_xyz),
          implicit_weight_(implicit_weight)
    {
    }

    void Mult(const mfem::Vector &x, mfem::Vector &y) const override
    {
        base_operator_.Mult(x, y);
        if (failed_) {
            return;
        }

        const bool use_dmi = has_active_dmi_tangent_operator(ctx_);
        const bool use_demag = has_active_demag_tangent_operator(ctx_);
        expand_tangent_solution_to_field(frames_, x, delta_m_xyz_);
        std::string local_error;

        if (use_dmi) {
            dmi_delta_xyz_.assign(delta_m_xyz_.size(), 0.0);
            if (ctx_.dmi.interfacial_enabled) {
                if (!compute_interfacial_dmi_field(
                        ctx_, delta_m_xyz_, interfacial_delta_xyz_, nullptr, local_error)) {
                     failed_ = true;
                     error_ = local_error;
                     return;
                }
                for (size_t i = 0; i < dmi_delta_xyz_.size(); ++i) {
                    dmi_delta_xyz_[i] += interfacial_delta_xyz_[i];
                }
            }
            if (ctx_.dmi.bulk_enabled) {
                if (!compute_bulk_dmi_field(
                        ctx_, delta_m_xyz_, bulk_delta_xyz_, nullptr, local_error)) {
                     failed_ = true;
                     error_ = local_error;
                     return;
                }
                for (size_t i = 0; i < dmi_delta_xyz_.size(); ++i) {
                    dmi_delta_xyz_[i] += bulk_delta_xyz_[i];
                }
            }
        }

        if (use_demag) {
            double demag_energy = 0.0;
            if (!compute_fresh_demag_field_for_magnetization(
                    ctx_,
                    delta_m_xyz_,
                    demag_delta_xyz_,
                    demag_energy,
                    false,
                    nullptr,
                    local_error)) {
                failed_ = true;
                error_ = local_error;
                return;
            }
        }

        const double *x_data = audited_host_read(x);
        double *y_data = audited_host_read_write(y);
        for (size_t node = 0; node < frames_.size(); ++node) {
            const TangentFrame &frame = frames_[node];
            if (!frame.active || node >= ctx_.integration_weights.mfem_lumped_mass.size()) {
                continue;
            }
            const double mass = ctx_.integration_weights.mfem_lumped_mass[node];
            if (mass <= 0.0) {
                continue;
            }
            const size_t base = node * 3u;
            const std::array<double, 3> m = normalized({
                m_xyz_[base + 0u],
                m_xyz_[base + 1u],
                m_xyz_[base + 2u],
            });
            std::array<double, 3> h_current{0.0, 0.0, 0.0};
            std::array<double, 3> h_delta{0.0, 0.0, 0.0};
            if (use_dmi && ctx_.dmi.h_interfacial_xyz.size() >= base + 3u) {
                h_current[0] += ctx_.dmi.h_interfacial_xyz[base + 0u];
                h_current[1] += ctx_.dmi.h_interfacial_xyz[base + 1u];
                h_current[2] += ctx_.dmi.h_interfacial_xyz[base + 2u];
            }
            if (use_dmi && ctx_.dmi.h_bulk_xyz.size() >= base + 3u) {
                h_current[0] += ctx_.dmi.h_bulk_xyz[base + 0u];
                h_current[1] += ctx_.dmi.h_bulk_xyz[base + 1u];
                h_current[2] += ctx_.dmi.h_bulk_xyz[base + 2u];
            }
            if (use_dmi && dmi_delta_xyz_.size() >= base + 3u) {
                h_delta[0] += dmi_delta_xyz_[base + 0u];
                h_delta[1] += dmi_delta_xyz_[base + 1u];
                h_delta[2] += dmi_delta_xyz_[base + 2u];
            }
            if (use_demag && ctx_.demag.h_xyz.size() >= base + 3u) {
                h_current[0] += ctx_.demag.h_xyz[base + 0u];
                h_current[1] += ctx_.demag.h_xyz[base + 1u];
                h_current[2] += ctx_.demag.h_xyz[base + 2u];
            }
            if (use_demag && demag_delta_xyz_.size() >= base + 3u) {
                h_delta[0] += demag_delta_xyz_[base + 0u];
                h_delta[1] += demag_delta_xyz_[base + 1u];
                h_delta[2] += demag_delta_xyz_[base + 2u];
            }
            const double mdoth = dot_array3(m, h_current);
            const int q_base = static_cast<int>(node * 2u);
            y_data[q_base + 0] += implicit_weight_ * mass *
                (mdoth * x_data[q_base + 0] - dot_array3(frame.e1, h_delta));
            y_data[q_base + 1] += implicit_weight_ * mass *
                (mdoth * x_data[q_base + 1] - dot_array3(frame.e2, h_delta));
        }
    }

    bool failed() const { return failed_; }
    const std::string &error() const { return error_; }

private:
    Context &ctx_;
    mfem::SparseMatrix &base_operator_;
    const std::vector<TangentFrame> &frames_;
    const std::vector<double> &m_xyz_;
    double implicit_weight_ = 0.0;
    mutable bool failed_ = false;
    mutable std::string error_;
    mutable std::vector<double> delta_m_xyz_;
    mutable std::vector<double> dmi_delta_xyz_;
    mutable std::vector<double> interfacial_delta_xyz_;
    mutable std::vector<double> bulk_delta_xyz_;
    mutable std::vector<double> demag_delta_xyz_;
};

bool solve_tangent_plane_mfem_cg_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    mfem::GSSmoother preconditioner(op);
    mfem::CGSolver solver;
    solver.SetRelTol(kLinearSolveRelativeTolerance);
    solver.SetAbsTol(kLinearSolveAbsoluteTolerance);
    solver.SetMaxIter(kLinearSolveMaximumIterations);
    solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    solver.SetPreconditioner(preconditioner);
    solver.SetOperator(op);
    solution.SetSize(rhs.Size());
    solution = 0.0;
    solver.Mult(rhs, solution);
    if (!std::isfinite(solution.Norml2())) {
        error = "tangent-plane implicit MFEM CG solve produced non-finite values";
        return false;
    }
    const double initial_residual = static_cast<double>(solver.GetInitialNorm());
    const double final_residual = static_cast<double>(solver.GetFinalNorm());
    if (!std::isfinite(initial_residual) || !std::isfinite(final_residual)) {
        error = "tangent-plane implicit MFEM CG solve produced non-finite residual diagnostics";
        return false;
    }
    const double residual_limit = std::max(
        kLinearSolveAbsoluteTolerance,
        kLinearSolveRelativeTolerance * std::max(1.0, initial_residual));
    if (!solver.GetConverged() || final_residual > residual_limit) {
        error =
            "tangent-plane implicit MFEM CG solve did not converge: iterations=" +
            std::to_string(solver.GetNumIterations()) +
            " final_residual=" + std::to_string(final_residual) +
            " limit=" + std::to_string(residual_limit);
        return false;
    }
    return true;
}

bool solve_tangent_plane_mfem_minres_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    mfem::DSmoother preconditioner(op);
    mfem::MINRESSolver solver;
    solver.SetRelTol(kLinearSolveRelativeTolerance);
    solver.SetAbsTol(kLinearSolveAbsoluteTolerance);
    solver.SetMaxIter(kLinearSolveMaximumIterations);
    solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    solver.SetPreconditioner(preconditioner);
    solver.SetOperator(op);
    solution.SetSize(rhs.Size());
    solution = 0.0;
    solver.Mult(rhs, solution);
    if (!std::isfinite(solution.Norml2())) {
        error = "tangent-plane implicit MFEM MINRES solve produced non-finite values";
        return false;
    }
    const double initial_residual = static_cast<double>(solver.GetInitialNorm());
    const double final_residual = static_cast<double>(solver.GetFinalNorm());
    if (!std::isfinite(initial_residual) || !std::isfinite(final_residual)) {
        error = "tangent-plane implicit MFEM MINRES solve produced non-finite residual diagnostics";
        return false;
    }
    const double residual_limit = std::max(
        kLinearSolveAbsoluteTolerance,
        kLinearSolveRelativeTolerance * std::max(1.0, initial_residual));
    if (!solver.GetConverged() || final_residual > residual_limit) {
        error =
            "tangent-plane implicit MFEM MINRES solve did not converge: iterations=" +
            std::to_string(solver.GetNumIterations()) +
            " final_residual=" + std::to_string(final_residual) +
            " limit=" + std::to_string(residual_limit);
        return false;
    }
    return true;
}

class FrozenSparsePreconditioner final : public mfem::Solver {
public:
    explicit FrozenSparsePreconditioner(mfem::SparseMatrix &op)
        : mfem::Solver(op.Height()), smoother_(op)
    {
    }

    void SetOperator(const mfem::Operator &op) override
    {
        (void)op;
    }

    void Mult(const mfem::Vector &x, mfem::Vector &y) const override
    {
        smoother_.Mult(x, y);
    }

private:
    mfem::DSmoother smoother_;
};

bool solve_tangent_plane_mfem_gmres_system(
    const Context &ctx,
    mfem::Operator &op,
    mfem::SparseMatrix &preconditioner_operator,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    FrozenSparsePreconditioner preconditioner(preconditioner_operator);
    mfem::GMRESSolver solver;
    solver.SetRelTol(kLinearSolveRelativeTolerance);
    solver.SetAbsTol(kLinearSolveAbsoluteTolerance);
    solver.SetMaxIter(kLinearSolveMaximumIterations);
    solver.SetKDim(50);
    solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
    solver.SetPreconditioner(preconditioner);
    solver.SetOperator(op);
    solution.SetSize(rhs.Size());
    solution = 0.0;
    solver.Mult(rhs, solution);
    if (!std::isfinite(solution.Norml2())) {
        error = "tangent-plane implicit MFEM GMRES solve produced non-finite values";
        return false;
    }
    const double initial_residual = static_cast<double>(solver.GetInitialNorm());
    const double final_residual = static_cast<double>(solver.GetFinalNorm());
    if (!std::isfinite(initial_residual) || !std::isfinite(final_residual)) {
        error = "tangent-plane implicit MFEM GMRES solve produced non-finite residual diagnostics";
        return false;
    }
    const double residual_limit = std::max(
        kLinearSolveAbsoluteTolerance,
        kLinearSolveRelativeTolerance * std::max(1.0, initial_residual));
    if (!solver.GetConverged() || final_residual > residual_limit) {
        error =
            "tangent-plane implicit MFEM GMRES solve did not converge: iterations=" +
            std::to_string(solver.GetNumIterations()) +
            " final_residual=" + std::to_string(final_residual) +
            " limit=" + std::to_string(residual_limit);
        return false;
    }
    return true;
}

#ifdef MFEM_USE_MPI

bool validate_hypre_relative_residual(
    double final_relative_residual,
    double rhs_norm,
    int iterations,
    const char *label,
    std::string &error)
{
    if (!std::isfinite(final_relative_residual)) {
        error = std::string(label) + " produced a non-finite relative residual";
        return false;
    }
    if (final_relative_residual < 0.0) {
        error = std::string(label) + " produced a negative relative residual";
        return false;
    }
    const double final_absolute_residual =
        final_relative_residual * std::max(rhs_norm, 0.0);
    if (final_relative_residual <= kLinearSolveRelativeTolerance ||
        final_absolute_residual <= kLinearSolveAbsoluteTolerance) {
        return true;
    }
    error = std::string(label) + " did not converge: iterations=" +
        std::to_string(iterations) +
        " final_relative_residual=" +
        std::to_string(final_relative_residual) +
        " final_absolute_residual=" +
        std::to_string(final_absolute_residual) +
        " relative_limit=" +
        std::to_string(kLinearSolveRelativeTolerance) +
        " absolute_limit=" +
        std::to_string(kLinearSolveAbsoluteTolerance);
    return false;
}

bool forced_hypre_tangent_plane_solver()
{
    const char *solver = std::getenv("FULLMAG_FEM_TPI_LINEAR_SOLVER");
    return solver != nullptr &&
        (std::strcmp(solver, "hypre") == 0 || std::strcmp(solver, "HYPRE") == 0);
}

bool forced_serial_tangent_plane_solver()
{
    const char *solver = std::getenv("FULLMAG_FEM_TPI_LINEAR_SOLVER");
    return solver != nullptr &&
        (std::strcmp(solver, "mfem_serial") == 0 ||
         std::strcmp(solver, "serial") == 0 ||
         std::strcmp(solver, "MFEM_SERIAL") == 0 ||
         std::strcmp(solver, "SERIAL") == 0);
}

bool openmpi_singleton_can_create_socket()
{
#if defined(__unix__)
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        ::close(fd);
        return true;
    }
    return false;
#else
    return true;
#endif
}

bool should_use_hypre_tangent_plane_solver()
{
    if (forced_hypre_tangent_plane_solver()) {
        return true;
    }
    if (forced_serial_tangent_plane_solver()) {
        return false;
    }
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (initialized) {
        return true;
    }
    return openmpi_singleton_can_create_socket();
}

bool solve_tangent_plane_hypre_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    bool has_local_indefinite_terms,
    std::string &error)
{
    if (!openmpi_singleton_can_create_socket()) {
        error =
            "tangent-plane implicit Hypre linear solve requires OpenMPI singleton socket support";
        return false;
    }
    ensure_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(op.NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};
    mfem::HypreParMatrix A_par(fullmag_serial_comm(), glob_size, row_starts, &op);
    mfem::HypreParVector b_par(fullmag_serial_comm(), glob_size, row_starts);
    mfem::HypreParVector x_par(fullmag_serial_comm(), glob_size, row_starts);
    const double *rhs_host = audited_host_read(rhs);
    double *b_host = audited_host_write(b_par);
    double *x_host = audited_host_write(x_par);
    for (int i = 0; i < rhs.Size(); ++i) {
        b_host[i] = rhs_host[i];
        x_host[i] = 0.0;
    }

    std::unique_ptr<mfem::HypreSolver> preconditioner;
    switch (ctx.demag.solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(A_par);
        amg->SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        preconditioner = std::move(amg);
        break;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        preconditioner = std::make_unique<mfem::HypreDiagScale>(A_par);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE: {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        identity->SetOperator(A_par);
        preconditioner = std::move(identity);
        break;
    }
    default:
        error = "tangent-plane implicit requested an unsupported preconditioner";
        return false;
    }

    mfem::real_t final_residual = 0.0;
    int iterations = 0;
    if (has_local_indefinite_terms) {
        mfem::HypreGMRES solver(fullmag_serial_comm());
        solver.iterative_mode = false;
        solver.SetTol(kLinearSolveRelativeTolerance);
        solver.SetAbsTol(kLinearSolveAbsoluteTolerance);
        solver.SetMaxIter(kLinearSolveMaximumIterations);
        solver.SetKDim(50);
        solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        solver.SetOperator(A_par);
        solver.SetPreconditioner(*preconditioner);
        solver.Mult(b_par, x_par);
        solver.GetNumIterations(iterations);
        solver.GetFinalResidualNorm(final_residual);
    } else {
        mfem::HyprePCG solver(fullmag_serial_comm());
        solver.iterative_mode = false;
        solver.SetTol(kLinearSolveRelativeTolerance);
        solver.SetAbsTol(kLinearSolveAbsoluteTolerance);
        solver.SetMaxIter(kLinearSolveMaximumIterations);
        solver.SetPrintLevel(static_cast<int>(ctx.demag.solver.print_level));
        solver.SetOperator(A_par);
        solver.SetPreconditioner(*preconditioner);
        solver.Mult(b_par, x_par);
        solver.GetNumIterations(iterations);
        solver.GetFinalResidualNorm(final_residual);
    }
    if (!validate_hypre_relative_residual(
            static_cast<double>(final_residual),
            rhs.Norml2(),
            iterations,
            "tangent-plane implicit Hypre linear solve",
            error)) {
        return false;
    }

    solution.SetSize(rhs.Size());
    const double *solved_host = audited_host_read(x_par);
    double *solution_host = audited_host_write(solution);
    for (int i = 0; i < rhs.Size(); ++i) {
        solution_host[i] = solved_host[i];
    }
    return true;
}
#endif

bool solve_tangent_plane_sparse_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    bool has_local_indefinite_terms,
    std::string &error)
{
#ifdef MFEM_USE_MPI
    if (should_use_hypre_tangent_plane_solver()) {
        return solve_tangent_plane_hypre_system(
            ctx, op, rhs, solution, has_local_indefinite_terms, error);
    }
#endif
    if (has_local_indefinite_terms) {
        return solve_tangent_plane_mfem_minres_system(ctx, op, rhs, solution, error);
    }
    return solve_tangent_plane_mfem_cg_system(ctx, op, rhs, solution, error);
}

bool solve_tangent_plane_matrix_free_system(
    Context &ctx,
    mfem::SparseMatrix &base_operator,
    const std::vector<TangentFrame> &frames,
    const std::vector<double> &m_xyz,
    double implicit_weight,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error)
{
    MatrixFreeTangentPlaneOperator op(ctx, base_operator, frames, m_xyz, implicit_weight);
    if (!solve_tangent_plane_mfem_gmres_system(
            ctx, op, base_operator, rhs, solution, error)) {
        return false;
    }
    if (op.failed()) {
        error = op.error();
        return false;
    }
    return true;
}

bool solve_tangent_plane_linear_system(
    Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &gradient,
    double implicit_weight,
    std::vector<double> &direction,
    std::string &error)
{
    auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.mass_form);
    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.exchange.mfem.exchange_form);
    if (mass_form == nullptr || exchange_form == nullptr) {
        error = "tangent-plane implicit relaxation requires MFEM mass and exchange forms";
        return false;
    }
    const size_t nodes = m_xyz.size() / 3u;
    if (mass_form->FESpace() == nullptr ||
        mass_form->FESpace()->GetNDofs() != static_cast<int>(nodes)) {
        error = "tangent-plane implicit mass form size does not match magnetization nodes";
        return false;
    }
    if (exchange_form->FESpace() == nullptr ||
        exchange_form->FESpace()->GetNDofs() != static_cast<int>(nodes)) {
        error = "tangent-plane implicit exchange form size does not match magnetization nodes";
        return false;
    }

    const std::vector<TangentFrame> frames = build_tangent_frames(ctx, m_xyz);
    std::vector<double> mass_gradient;
    if (!apply_mass_to_field(mass_form->SpMat(), gradient, mass_gradient)) {
        error = "tangent-plane implicit mass-gradient RHS produced non-finite values";
        return false;
    }

    std::vector<double> rhs(nodes * 2u, 0.0);
    for (size_t node = 0; node < nodes; ++node) {
        const TangentFrame &frame = frames[node];
        if (!frame.active) {
            continue;
        }
        const size_t q_base = node * 2u;
        rhs[q_base + 0u] = -dot_node(frame.e1, mass_gradient, node);
        rhs[q_base + 1u] = -dot_node(frame.e2, mass_gradient, node);
    }
    if (!all_finite(rhs)) {
        error = "tangent-plane implicit RHS contains non-finite values";
        return false;
    }

    bool has_local_indefinite_terms = false;
    const bool has_matrix_free_terms = has_active_matrix_free_tangent_operator(ctx);
    std::unique_ptr<mfem::SparseMatrix> tangent_operator =
        assemble_tangent_plane_operator(
            ctx,
            frames,
            m_xyz,
            mass_form->SpMat(),
            exchange_form->SpMat(),
            implicit_weight,
            has_local_indefinite_terms);
    mfem::Vector rhs_vector(static_cast<int>(rhs.size()));
    double *rhs_vector_data = audited_host_write(rhs_vector);
    for (int i = 0; i < rhs_vector.Size(); ++i) {
        rhs_vector_data[i] = rhs[static_cast<size_t>(i)];
    }
    mfem::Vector solution;
    if (has_matrix_free_terms) {
        if (!solve_tangent_plane_matrix_free_system(
                ctx,
                *tangent_operator,
                frames,
                m_xyz,
                implicit_weight,
                rhs_vector,
                solution,
                error)) {
            return false;
        }
    } else if (!solve_tangent_plane_sparse_system(
            ctx,
            *tangent_operator,
            rhs_vector,
            solution,
            has_local_indefinite_terms,
            error)) {
        return false;
    }
    expand_tangent_solution_to_field(frames, solution, direction);
    direction = relaxation::project_tangent(ctx, m_xyz, direction);
    if (!all_finite(direction)) {
        error = "tangent-plane implicit projected direction contains non-finite values";
        return false;
    }
    return true;
}

#endif

} // namespace

int run_tangent_plane_implicit_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const int lane_status =
        relaxation::ensure_cpu_mfem_relaxation_lane(ctx, "tangent-plane implicit", error);
    if (lane_status != FULLMAG_FEM_OK) {
        return lane_status;
    }

    fullmag_fem_step_stats current_stats{};
    const int current_snapshot_status = relaxation::fresh_line_search_snapshot(
        ctx,
        current_stats,
        "tangent-plane implicit",
        "current",
        error);
    if (current_snapshot_status != FULLMAG_FEM_OK) {
        return current_snapshot_status;
    }
    if (!relaxation::validate_relaxation_state_fields(
            ctx,
            "tangent-plane implicit",
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!relaxation::validate_relaxation_step_energy(
            current_stats,
            "tangent-plane implicit",
            "current",
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    fullmag_fem_step_stats profile_stats{};
    relaxation::accumulate_relaxation_profile_sample(profile_stats, current_stats);
    if (complete_stage_from_current_stats(ctx, current_stats)) {
        out_stats = current_stats;
        out_stats.dt_seconds = 0.0;
        return FULLMAG_FEM_OK;
    }
    if (relaxation_torque_confirmation_pending(ctx, current_stats.max_torque_Apm)) {
        out_stats = current_stats;
        out_stats.dt_seconds = 0.0;
        out_stats.max_rhs_amplitude = 0.0;
        update_stage_completion_from_stats(ctx, out_stats);
        return FULLMAG_FEM_OK;
    }

    std::vector<double> previous_m;
    std::vector<double> previous_h_demag;
    std::vector<double> previous_h_eff;
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_state_copy_wall_time_ns);
        previous_m = ctx.state.m_xyz;
        previous_h_demag = ctx.demag.h_xyz;
        previous_h_eff = ctx.effective_field.h_xyz;
    }
    std::vector<double> gradient;
    double g_norm_sq = 0.0;
    bool current_gradient_valid = false;
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_gradient_wall_time_ns);
        relaxation::tangent_gradient_from_field(
            ctx,
            previous_m,
            ctx.effective_field.h_xyz,
            gradient);
        current_gradient_valid = relaxation::validate_tangent_gradient_field(
            ctx,
            gradient,
            "tangent-plane implicit",
            "current",
            g_norm_sq,
            error);
    }
    if (!current_gradient_valid) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (g_norm_sq == 0.0) {
        relaxation::finish_degenerate_gradient_relaxation_step(
            ctx,
            current_stats,
            out_stats,
            g_norm_sq);
        return FULLMAG_FEM_OK;
    }

    double trial_step =
        relaxation::sanitized_relaxation_step_size(ctx.relaxation.step_size);
    fullmag_fem_step_stats trial_stats{};
    std::vector<double> trial_m;
    uint32_t backtracks = 0u;
    int status = FULLMAG_FEM_OK;
    double direction_dot_gradient = 0.0;
    bool line_search_accepted = false;
    DirectMinimizerArmijoResult armijo_result;
    while (true) {
        std::vector<double> direction;
        if (!solve_tangent_plane_linear_system(
                ctx,
                previous_m,
                gradient,
                trial_step,
                direction,
                error)) {
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        {
            ScopedPhaseTimer timer(&profile_stats.relaxation_metric_wall_time_ns);
            direction_dot_gradient =
                relaxation::energy_weighted_dot_fields(ctx, direction, gradient);
        }
        if (!std::isfinite(direction_dot_gradient) ||
            direction_dot_gradient >= 0.0) {
            error =
                "tangent-plane implicit relaxation produced a non-finite or non-descent tangent direction";
            return FULLMAG_FEM_ERR_INTERNAL;
        }

        {
            ScopedPhaseTimer timer(&profile_stats.relaxation_retraction_wall_time_ns);
            trial_m = relaxation::retracted_step(ctx, previous_m, direction, trial_step);
        }
        status = relaxation::upload_and_snapshot(
            ctx,
            trial_m,
            trial_stats,
            "tangent-plane implicit",
            "trial",
            error);
        if (status != FULLMAG_FEM_OK) {
            const std::string trial_error = error;
            return relaxation::restore_previous_relaxation_state(
                ctx,
                previous_m,
                "tangent-plane implicit",
                "failed trial snapshot",
                status,
                trial_error,
                error);
        }
        relaxation::accumulate_relaxation_profile_sample(profile_stats, trial_stats);
        bool armijo = false;
        {
            ScopedPhaseTimer timer(&profile_stats.relaxation_line_search_wall_time_ns);
            relaxation::EnergyDifference direct_difference;
            relaxation::EnergyDifference accepted_difference;
            double armijo_increment_rhs_j = 0.0;
            armijo = direct_minimizer_armijo_accepts(
                ctx,
                "tangent-plane implicit",
                previous_m,
                trial_m,
                previous_h_demag,
                previous_h_eff,
                current_stats,
                trial_stats,
                profile_stats,
                direct_difference,
                accepted_difference,
                armijo_increment_rhs_j,
                error);
            armijo_result.direct_difference = direct_difference;
            armijo_result.accepted_difference = accepted_difference;
            armijo_result.accepted_stats = trial_stats;
            armijo_result.armijo_increment_rhs_j = armijo_increment_rhs_j;
            armijo_result.outcome = armijo
                ? DirectMinimizerArmijoOutcome::AcceptedOrdinary
                : DirectMinimizerArmijoOutcome::Rejected;
        }
        if (!error.empty() || ctx.interrupt.step_interrupted) {
            const bool interrupted = ctx.interrupt.step_interrupted;
            const std::string difference_error = error.empty()
                ? "tangent-plane implicit direct energy difference interrupted"
                : error;
            return relaxation::restore_previous_relaxation_state(
                ctx,
                previous_m,
                "tangent-plane implicit",
                "direct trial energy-difference failure",
                interrupted ? FULLMAG_FEM_ERR_INTERRUPTED : FULLMAG_FEM_ERR_INTERNAL,
                difference_error,
                error);
        }
        if (armijo) {
            line_search_accepted = true;
            break;
        }
        if (backtracks >= relaxation::kTangentPlaneImplicitMaxBacktracks) {
            break;
        }
        const int restore_status = relaxation::restore_after_rejected_trial(
            ctx,
            previous_m,
            "tangent-plane implicit",
            backtracks,
            trial_step,
            error);
        if (restore_status != FULLMAG_FEM_OK) {
            return restore_status;
        }
        trial_step *= 0.5;
        backtracks += 1;
    }
    if (!line_search_accepted) {
        return relaxation::restore_after_failed_line_search(
            ctx,
            previous_m,
            "tangent-plane implicit",
            backtracks,
            {},
            error);
    }

    const double accepted_energy_delta_upper_j =
        armijo_result.accepted_difference.delta_joules +
        armijo_result.accepted_difference.roundoff_bound_joules;
    if (!std::isfinite(accepted_energy_delta_upper_j) ||
        !std::isfinite(armijo_result.armijo_increment_rhs_j) ||
        !(accepted_energy_delta_upper_j <=
              armijo_result.armijo_increment_rhs_j &&
          armijo_result.armijo_increment_rhs_j <= 0.0)) {
        const std::string proof_error =
            "tangent-plane implicit accepted Armijo proof is invalid";
        return relaxation::restore_previous_relaxation_state(
            ctx,
            previous_m,
            "tangent-plane implicit",
            "accepted Armijo proof validation failure",
            FULLMAG_FEM_ERR_INTERNAL,
            proof_error,
            error);
    }

    std::vector<double> trial_gradient;
    double trial_g_norm_sq = 0.0;
    bool accepted_gradient_valid = false;
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_gradient_wall_time_ns);
        relaxation::tangent_gradient_from_field(
            ctx,
            trial_m,
            ctx.effective_field.h_xyz,
            trial_gradient);
        accepted_gradient_valid = relaxation::validate_tangent_gradient_field(
            ctx,
            trial_gradient,
            "tangent-plane implicit",
            "accepted",
            trial_g_norm_sq,
            error);
    }
    if (!accepted_gradient_valid) {
        const std::string gradient_error = error;
        return relaxation::restore_previous_relaxation_state(
            ctx,
            previous_m,
            "tangent-plane implicit",
            "accepted-gradient validation failure",
            FULLMAG_FEM_ERR_INTERNAL,
            gradient_error,
            error);
    }

    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_update_wall_time_ns);
        update_implicit_step_size(ctx.relaxation, trial_step, backtracks);
    }
    relaxation::finish_accepted_relaxation_step(
        ctx,
        armijo_result.accepted_stats,
        profile_stats,
        out_stats,
        trial_step);
    ctx.relaxation.accepted_energy_proof.available = true;
    ctx.relaxation.accepted_energy_proof.delta_j =
        armijo_result.accepted_difference.delta_joules;
    ctx.relaxation.accepted_energy_proof.roundoff_bound_j =
        armijo_result.accepted_difference.roundoff_bound_joules;
    ctx.relaxation.accepted_energy_proof.delta_upper_j =
        accepted_energy_delta_upper_j;
    ctx.relaxation.accepted_energy_proof.armijo_rhs_j =
        armijo_result.armijo_increment_rhs_j;
    relaxation::publish_accepted_gradient_completion(ctx, trial_g_norm_sq);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)out_stats;
    error = "tangent-plane implicit relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
