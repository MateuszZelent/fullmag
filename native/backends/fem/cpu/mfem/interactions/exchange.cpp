#include "cpu/mfem/interactions/exchange.hpp"

#include "context.hpp"
#include "gpu_state.hpp"
#include "transfer_audit.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace fullmag::fem {
#if FULLMAG_HAS_MFEM_STACK
namespace {

/*
 * FEM exchange interaction for the native MFEM CPU backend.
 *
 * Physical contract
 * -----------------
 * The exchange energy for reduced magnetization m = M/Ms is
 *
 *   E_ex = integral_Omega A_ex |grad m|^2 dV                         [J],
 *
 * where A_ex is the exchange stiffness in J/m. The effective exchange field
 * is defined by the variational relation
 *
 *   dE_ex = -mu0 integral_Omega Ms H_ex . delta_m dV,
 *
 * giving the continuum field
 *
 *   H_ex = 2 A_ex / (mu0 Ms) Delta m                                  [A/m].
 *
 * This module returns H_ex in A/m and the global exchange energy in joules.
 * The LLG integrator later converts H_ex into dm/dt through gamma_mu0 in
 * m/(A s). This file must not add gamma, alpha, or direct torque factors.
 *
 * FEM discretization
 * ------------------
 * For P1 tetrahedral H1 basis functions phi_i, the assembled stiffness matrix
 * K_A represents integral A_ex grad(phi_i) . grad(phi_j) dV over magnetic
 * elements. For each component m_c:
 *
 *   rhs_c = K_A m_c,
 *   M h_raw_c = rhs_c,
 *   H_ex,c = -2 h_raw_c / (mu0 Ms).
 *
 * The default path uses a lumped magnetic mass diagonal. The consistent-mass
 * path solves M h_raw = K_A m with CG. Periodic reductions aggregate the RHS
 * and mass on periodic node classes before lifting the result back to full
 * nodes.
 *
 * Boundary conditions and regions
 * -------------------------------
 * Exchange is assembled only on magnetic elements. Natural exchange boundary
 * conditions apply on free magnetic boundaries. Nonmagnetic/air nodes are
 * explicitly zeroed in the returned H_ex buffer so that visualization and RHS
 * assembly cannot accidentally treat airbox nodes as magnetic degrees of
 * freedom.
 */

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;
constexpr int kInterruptPollStride = 256;

bool debug_startup_env_enabled()
{
    const char *raw = std::getenv("FULLMAG_FEM_DEBUG_STARTUP");
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "1") == 0 ||
           std::strcmp(raw, "true") == 0 ||
           std::strcmp(raw, "TRUE") == 0 ||
           std::strcmp(raw, "on") == 0 ||
           std::strcmp(raw, "ON") == 0 ||
           std::strcmp(raw, "yes") == 0 ||
           std::strcmp(raw, "YES") == 0;
}

void debug_checkpoint(const char *stage)
{
    if (!debug_startup_env_enabled()) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

uint64_t vector_bytes(const mfem::Vector &vector) {
    return static_cast<uint64_t>(std::max(vector.Size(), 0)) * sizeof(double);
}

const double *audited_host_read(const mfem::Vector &vector) {
    record_mfem_host_read(vector_bytes(vector));
    return vector.HostRead();
}

double *audited_host_write(mfem::Vector &vector) {
    record_mfem_host_write(vector_bytes(vector));
    return vector.HostWrite();
}

double *audited_host_read_write(mfem::Vector &vector) {
    record_mfem_host_read_write(vector_bytes(vector));
    return vector.HostReadWrite();
}

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

void unpack_aos_to_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    x.resize(n);
    y.resize(n);
    z.resize(n);
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0u];
        y[i] = aos[i * 3u + 1u];
        z[i] = aos[i * 3u + 2u];
    }
}

void unpack_aos_to_existing_components(
    const std::vector<double> &aos,
    std::vector<double> &x,
    std::vector<double> &y,
    std::vector<double> &z)
{
    const size_t n = aos.size() / 3u;
    if (x.size() != n || y.size() != n || z.size() != n) {
        unpack_aos_to_components(aos, x, y, z);
        return;
    }
    for (size_t i = 0; i < n; ++i) {
        x[i] = aos[i * 3u + 0u];
        y[i] = aos[i * 3u + 1u];
        z[i] = aos[i * 3u + 2u];
    }
}

void pack_components_to_aos(
    const std::vector<double> &x,
    const std::vector<double> &y,
    const std::vector<double> &z,
    std::vector<double> &aos)
{
    const size_t n = x.size();
    aos.resize(n * 3u);
    for (size_t i = 0; i < n; ++i) {
        aos[i * 3u + 0u] = x[i];
        aos[i * 3u + 1u] = y[i];
        aos[i * 3u + 2u] = z[i];
    }
}

void copy_host_vector_to_mfem(const std::vector<double> &src, mfem::Vector &dst) {
    dst.SetSize(static_cast<int>(src.size()));
    dst.UseDevice(true);
    double *host = audited_host_write(dst);
    for (size_t i = 0; i < src.size(); ++i) {
        host[static_cast<int>(i)] = src[i];
    }
}

void copy_mfem_vector_to_host(const mfem::Vector &src, std::vector<double> &dst) {
    const int n = src.Size();
    dst.resize(static_cast<size_t>(n));
    const double *host = audited_host_read(src);
    for (int i = 0; i < n; ++i) {
        dst[static_cast<size_t>(i)] = host[i];
    }
}

void prepare_mass_lumping(
    mfem::BilinearForm &mass_form,
    mfem::Vector &ones,
    mfem::Vector &lumped,
    mfem::Vector &inv_lumped,
    std::vector<double> &host_lumped)
{
    const int ndofs = mass_form.FESpace()->GetNDofs();
    ones.SetSize(ndofs);
    lumped.SetSize(ndofs);
    inv_lumped.SetSize(ndofs);
    ones.UseDevice(true);
    lumped.UseDevice(true);
    inv_lumped.UseDevice(true);
    ones = 1.0;
    mass_form.Mult(ones, lumped);
    const double *lumped_host = audited_host_read(lumped);
    double *inv_host = audited_host_write(inv_lumped);
    for (int i = 0; i < ndofs; ++i) {
        const double mass = lumped_host[i];
        inv_host[i] = mass > 0.0 ? 1.0 / mass : 0.0;
    }
    copy_mfem_vector_to_host(lumped, host_lumped);
}

double dot_host_vectors(const std::vector<double> &a, const std::vector<double> &b) {
    double value = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        value += a[i] * b[i];
    }
    return value;
}

bool apply_periodic_consistent_mass_component(
    const Context &ctx,
    mfem::BilinearForm &mass_form,
    const mfem::Vector &rhs_full,
    mfem::Vector &h_component,
    std::vector<double> &h_component_host)
{
    const int ndofs = rhs_full.Size();
    const uint32_t n_reduced = ctx.periodic_reduced_node_count;
    if (n_reduced == 0 || ctx.periodic_reduced_node.size() != static_cast<size_t>(ndofs)) {
        return false;
    }

    std::vector<double> rhs_reduced(static_cast<size_t>(n_reduced), 0.0);
    const double *rhs_host = audited_host_read(rhs_full);
    for (int i = 0; i < ndofs; ++i) {
        const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(i)];
        rhs_reduced[static_cast<size_t>(reduced)] += rhs_host[i];
    }

    auto multiply_reduced_mass =
        [&](const std::vector<double> &x_reduced, std::vector<double> &out_reduced) {
            mfem::Vector full_x(ndofs);
            mfem::Vector full_y(ndofs);
            full_x.UseDevice(true);
            full_y.UseDevice(true);
            double *x_host = audited_host_write(full_x);
            for (int i = 0; i < ndofs; ++i) {
                const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(i)];
                x_host[i] = x_reduced[static_cast<size_t>(reduced)];
            }

            mass_form.Mult(full_x, full_y);
            out_reduced.assign(static_cast<size_t>(n_reduced), 0.0);
            const double *y_host = audited_host_read(full_y);
            for (int i = 0; i < ndofs; ++i) {
                const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(i)];
                out_reduced[static_cast<size_t>(reduced)] += y_host[i];
            }
        };

    std::vector<double> solution(static_cast<size_t>(n_reduced), 0.0);
    std::vector<double> residual = rhs_reduced;
    std::vector<double> direction = residual;
    std::vector<double> operator_direction;
    double residual_norm_sq = dot_host_vectors(residual, residual);
    const double rhs_norm = std::sqrt(residual_norm_sq);
    if (rhs_norm <= 1e-30) {
        h_component = 0.0;
        copy_mfem_vector_to_host(h_component, h_component_host);
        return true;
    }
    const double tolerance_sq = std::pow(std::max(1e-20, 1e-10 * rhs_norm), 2.0);
    const int max_iter = std::max(200, static_cast<int>(n_reduced) * 10);
    for (int iter = 0; iter < max_iter && residual_norm_sq > tolerance_sq; ++iter) {
        multiply_reduced_mass(direction, operator_direction);
        const double denom = dot_host_vectors(direction, operator_direction);
        if (!std::isfinite(denom) || denom <= 0.0) {
            return false;
        }
        const double alpha = residual_norm_sq / denom;
        for (uint32_t i = 0; i < n_reduced; ++i) {
            solution[static_cast<size_t>(i)] += alpha * direction[static_cast<size_t>(i)];
            residual[static_cast<size_t>(i)] -= alpha * operator_direction[static_cast<size_t>(i)];
        }
        const double next_residual_norm_sq = dot_host_vectors(residual, residual);
        if (!std::isfinite(next_residual_norm_sq)) {
            return false;
        }
        if (next_residual_norm_sq <= tolerance_sq) {
            residual_norm_sq = next_residual_norm_sq;
            break;
        }
        const double beta = next_residual_norm_sq / residual_norm_sq;
        for (uint32_t i = 0; i < n_reduced; ++i) {
            direction[static_cast<size_t>(i)] =
                residual[static_cast<size_t>(i)] + beta * direction[static_cast<size_t>(i)];
        }
        residual_norm_sq = next_residual_norm_sq;
    }
    if (residual_norm_sq > tolerance_sq) {
        return false;
    }

    std::vector<double> reduced_ms(static_cast<size_t>(n_reduced), ctx.material.saturation_magnetisation);
    for (uint32_t reduced = 0; reduced < n_reduced; ++reduced) {
        const uint32_t representative = ctx.periodic_representative_nodes[static_cast<size_t>(reduced)];
        reduced_ms[static_cast<size_t>(reduced)] = scalar_field_value(
            ctx.Ms_field,
            static_cast<size_t>(representative),
            ctx.material.saturation_magnetisation);
    }
    double *h_host = audited_host_write(h_component);
    for (int i = 0; i < ndofs; ++i) {
        const uint32_t reduced = ctx.periodic_reduced_node[static_cast<size_t>(i)];
        const double Ms = reduced_ms[static_cast<size_t>(reduced)];
        if (Ms <= 0.0) {
            h_host[i] = 0.0;
        } else {
            h_host[i] = -(2.0 / (kMu0 * Ms)) * solution[static_cast<size_t>(reduced)];
        }
    }
    copy_mfem_vector_to_host(h_component, h_component_host);
    return true;
}

bool apply_exchange_component_device(
    Context *ctx,
    bool allow_interrupt,
    mfem::BilinearForm &exchange_form,
    mfem::GridFunction &m_component,
    mfem::GridFunction &ms_field,
    mfem::Vector &inv_lumped_mass,
    mfem::BilinearForm &mass_form,
    bool use_consistent_mass,
    mfem::Vector &tmp,
    mfem::Vector &h_component,
    std::vector<double> &h_component_host,
    double *energy_out)
{
    exchange_form.Mult(m_component, tmp);
    if (allow_interrupt && ctx != nullptr && poll_interrupt(*ctx)) {
        return false;
    }

    const int ndofs = tmp.Size();
    if (ctx != nullptr && !ctx->periodic_reduced_node.empty()) {
        if (ctx->mfem_lumped_mass.size() != static_cast<size_t>(ndofs)) {
            return false;
        }
        if (ctx->use_consistent_mass) {
            if (energy_out != nullptr) {
                *energy_out = m_component * tmp;
            }
            return apply_periodic_consistent_mass_component(
                *ctx,
                mass_form,
                tmp,
                h_component,
                h_component_host);
        }
        const uint32_t n_reduced = ctx->periodic_reduced_node_count;
        std::vector<double> reduced_tmp(static_cast<size_t>(n_reduced), 0.0);
        std::vector<double> reduced_mass(static_cast<size_t>(n_reduced), 0.0);
        const double *tmp_host = audited_host_read(tmp);
        for (int i = 0; i < ndofs; ++i) {
            const uint32_t reduced =
                ctx->periodic_reduced_node[static_cast<size_t>(i)];
            reduced_tmp[static_cast<size_t>(reduced)] += tmp_host[i];
            reduced_mass[static_cast<size_t>(reduced)] +=
                ctx->mfem_lumped_mass[static_cast<size_t>(i)];
        }

        std::vector<double> reduced_ms(
            static_cast<size_t>(n_reduced),
            ctx->material.saturation_magnetisation);
        for (uint32_t reduced = 0; reduced < n_reduced; ++reduced) {
            const uint32_t representative =
                ctx->periodic_representative_nodes[static_cast<size_t>(reduced)];
            reduced_ms[static_cast<size_t>(reduced)] = scalar_field_value(
                ctx->Ms_field,
                static_cast<size_t>(representative),
                ctx->material.saturation_magnetisation);
        }
        double *h_host = audited_host_write(h_component);
        for (int i = 0; i < ndofs; ++i) {
            const uint32_t reduced =
                ctx->periodic_reduced_node[static_cast<size_t>(i)];
            const double mass = reduced_mass[static_cast<size_t>(reduced)];
            const double Ms = reduced_ms[static_cast<size_t>(reduced)];
            if (mass <= 0.0 || Ms <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms)) *
                    reduced_tmp[static_cast<size_t>(reduced)] / mass;
            }
        }
        if (energy_out != nullptr) {
            *energy_out = m_component * tmp;
        }
        copy_mfem_vector_to_host(h_component, h_component_host);
        return true;
    }

    if (use_consistent_mass) {
        mfem::CGSolver cg_solver;
        cg_solver.SetRelTol(1e-10);
        cg_solver.SetMaxIter(200);
        cg_solver.SetPrintLevel(0);
        cg_solver.SetOperator(mass_form);
        h_component = 0.0;
        cg_solver.Mult(tmp, h_component);
        const double *ms_host = audited_host_read(ms_field);
        double *h_host = audited_host_read_write(h_component);
        for (int i = 0; i < ndofs; ++i) {
            const double Ms_i = ms_host[i];
            if (Ms_i <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms_i)) * h_host[i];
            }
        }
    } else {
        const double *tmp_host = audited_host_read(tmp);
        const double *inv_mass_host = audited_host_read(inv_lumped_mass);
        const double *ms_host = audited_host_read(ms_field);
        double *h_host = audited_host_write(h_component);
        for (int i = 0; i < ndofs; ++i) {
            const double inv_mass = inv_mass_host[i];
            const double Ms_i = ms_host[i];
            if (inv_mass <= 0.0 || Ms_i <= 0.0) {
                h_host[i] = 0.0;
            } else {
                h_host[i] = -(2.0 / (kMu0 * Ms_i)) * tmp_host[i] * inv_mass;
            }
        }
    }
    if (energy_out != nullptr) {
        *energy_out = m_component * tmp;
    }
    copy_mfem_vector_to_host(h_component, h_component_host);
    return true;
}

} // namespace

bool initialize_exchange_operator_mfem(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    mfem::GridFunctionCoefficient &a_coeff,
    std::string &error)
{
    auto exchange_form = std::make_unique<mfem::BilinearForm>(&fes);
    auto mass_form = std::make_unique<mfem::BilinearForm>(&fes);
    auto mass_ones = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto mass_lumped = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto inv_lumped_mass = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto exchange_tmp_vec = std::make_unique<mfem::Vector>(fes.GetNDofs());
    auto exchange_out_vec = std::make_unique<mfem::Vector>(fes.GetNDofs());
    mass_ones->UseDevice(true);
    mass_lumped->UseDevice(true);
    inv_lumped_mass->UseDevice(true);
    exchange_tmp_vec->UseDevice(true);
    exchange_out_vec->UseDevice(true);

    // F-01: build the magnetic attribute set from the resolved magnetic
    // element mask instead of assuming a single hard-coded attribute.
    const int max_attr = mesh.attributes.Max();
    mfem::Array<int> magnetic_attr_marker(max_attr);
    magnetic_attr_marker = 0;
    for (int e = 0; e < mesh.GetNE(); ++e) {
        if (!ctx.magnetic_element_mask.empty() &&
            static_cast<size_t>(e) < ctx.magnetic_element_mask.size() &&
            ctx.magnetic_element_mask[e] == 0u) {
            continue;
        }
        const int attr = mesh.GetAttribute(e);
        if (attr >= 1 && attr <= max_attr) {
            magnetic_attr_marker[attr - 1] = 1;
        }
    }

    int n_active_attrs = 0;
    for (int a = 0; a < max_attr; ++a) {
        n_active_attrs += magnetic_attr_marker[a];
    }
    if (ctx.enable_exchange && n_active_attrs == 0) {
        error = "F-01 validation: enable_exchange=true but no MFEM "
                "attributes are marked as magnetic — exchange/mass "
                "assembly would be empty.  Check element_markers.";
        return false;
    }

    // The intended end state for exchange is partial assembly, but the current
    // MFEM 4.7 tetrahedral H1 path in the managed GPU runtime can abort in
    // `GetDofToQuad(..., DofToQuad::FULL)` before the simulation even starts.
    // Use the assembled operator path so FEM can execute via device-backed SpMV.
    exchange_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    exchange_form->AddDomainIntegrator(
        new mfem::DiffusionIntegrator(a_coeff),
        magnetic_attr_marker);
    exchange_form->Assemble();
    exchange_form->Finalize();

    const auto &exchange_spmat = exchange_form->SpMat();
    ctx.gpu_exchange_legacy_sparse_metadata_ready = true;
    ctx.gpu_exchange_legacy_sparse_rows =
        static_cast<uint64_t>(std::max(0, exchange_spmat.Height()));
    ctx.gpu_exchange_legacy_sparse_cols =
        static_cast<uint64_t>(std::max(0, exchange_spmat.Width()));
    ctx.gpu_exchange_legacy_sparse_nnz =
        static_cast<uint64_t>(std::max(0, exchange_spmat.NumNonZeroElems()));

    // Build a scalar mass form on the same magnetic attributes. Runtime exchange
    // uses the lumped diagonal by default and the form itself for consistent
    // mass projection.
    mass_form->SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
    mass_form->AddDomainIntegrator(
        new mfem::MassIntegrator(),
        magnetic_attr_marker);
    mass_form->Assemble();
    mass_form->Finalize();
    prepare_mass_lumping(
        *mass_form,
        *mass_ones,
        *mass_lumped,
        *inv_lumped_mass,
        ctx.mfem_lumped_mass);
    ctx.gpu_exchange_lumped_mass_ready =
        ctx.mfem_lumped_mass.size() == static_cast<size_t>(fes.GetNDofs());

    const bool has_nonzero_lumped_mass = std::any_of(
        ctx.mfem_lumped_mass.begin(),
        ctx.mfem_lumped_mass.end(),
        [](double value) { return value > 0.0; });
    if (ctx.enable_exchange && !has_nonzero_lumped_mass) {
        error = "F-01 validation: enable_exchange=true but MFEM lumped "
                "mass is zero on every node in the resolved magnetic "
                "domain.  Check element_markers and magnetic region "
                "resolution.";
        return false;
    }

    ctx.mfem_exchange_form = exchange_form.release();
    ctx.mfem_mass_form = mass_form.release();
    ctx.mfem_mass_ones = mass_ones.release();
    ctx.mfem_mass_lumped = mass_lumped.release();
    ctx.mfem_inv_lumped_mass = inv_lumped_mass.release();
    ctx.mfem_exchange_tmp_vec = exchange_tmp_vec.release();
    ctx.mfem_exchange_out_vec = exchange_out_vec.release();
    return true;
}

bool upload_legacy_sparse_exchange_to_gpu_state(
    Context &ctx,
    mfem::SparseMatrix &exchange_spmat,
    std::string &error)
{
    if (!ctx.gpu_state.allocated) {
        return true;
    }
    const int height = exchange_spmat.Height();
    const int width = exchange_spmat.Width();
    const int nnz = exchange_spmat.NumNonZeroElems();
    if (height <= 0 || width <= 0 || nnz < 0) {
        error = "legacy sparse exchange CSR has invalid dimensions";
        return false;
    }
    if (height > static_cast<int>(std::numeric_limits<uint32_t>::max()) ||
        width > static_cast<int>(std::numeric_limits<uint32_t>::max())) {
        error = "legacy sparse exchange CSR dimensions exceed u32 GPU indexing";
        return false;
    }
    if (ctx.mfem_lumped_mass.size() != static_cast<size_t>(height)) {
        error = "legacy sparse exchange CSR row count does not match lumped mass";
        return false;
    }

    const int *row_offsets_raw = exchange_spmat.GetI();
    const int *col_indices_raw = exchange_spmat.GetJ();
    const double *values_raw = exchange_spmat.GetData();
    if (row_offsets_raw == nullptr || col_indices_raw == nullptr || values_raw == nullptr) {
        error = "legacy sparse exchange CSR data pointers are null";
        return false;
    }

    std::vector<uint32_t> row_offsets(static_cast<size_t>(height) + 1u);
    for (int i = 0; i <= height; ++i) {
        if (row_offsets_raw[i] < 0) {
            error = "legacy sparse exchange CSR row offset is negative";
            return false;
        }
        row_offsets[static_cast<size_t>(i)] = static_cast<uint32_t>(row_offsets_raw[i]);
    }
    if (row_offsets.back() != static_cast<uint32_t>(nnz)) {
        error = "legacy sparse exchange CSR row offsets do not match nnz";
        return false;
    }

    std::vector<uint32_t> col_indices(static_cast<size_t>(nnz));
    for (int i = 0; i < nnz; ++i) {
        if (col_indices_raw[i] < 0 || col_indices_raw[i] >= width) {
            error = "legacy sparse exchange CSR column index is out of bounds";
            return false;
        }
        col_indices[static_cast<size_t>(i)] = static_cast<uint32_t>(col_indices_raw[i]);
    }

    std::vector<double> inv_lumped(ctx.mfem_lumped_mass.size(), 0.0);
    for (size_t i = 0; i < ctx.mfem_lumped_mass.size(); ++i) {
        const double mass = ctx.mfem_lumped_mass[i];
        inv_lumped[i] = mass > 0.0 ? 1.0 / mass : 0.0;
    }

    return gpu_state_upload_exchange_legacy_sparse(
        ctx.gpu_state,
        static_cast<uint64_t>(height),
        static_cast<uint64_t>(width),
        row_offsets.data(),
        static_cast<uint64_t>(row_offsets.size()),
        col_indices.data(),
        static_cast<uint64_t>(col_indices.size()),
        values_raw,
        static_cast<uint64_t>(nnz),
        ctx.mfem_lumped_mass.data(),
        static_cast<uint64_t>(ctx.mfem_lumped_mass.size()),
        inv_lumped.data(),
        static_cast<uint64_t>(inv_lumped.size()),
        ctx.transfer_audit,
        error);
}

bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool allow_interrupt,
    std::string &error)
{
    if (!ctx.mfem_ready) {
        error = "MFEM exchange requested before MFEM context initialization";
        return false;
    }

    auto *exchange_form = static_cast<mfem::BilinearForm *>(ctx.mfem_exchange_form);
    auto *mass_form = static_cast<mfem::BilinearForm *>(ctx.mfem_mass_form);
    auto *gf_mx = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mx);
    auto *gf_my = static_cast<mfem::GridFunction *>(ctx.mfem_gf_my);
    auto *gf_mz = static_cast<mfem::GridFunction *>(ctx.mfem_gf_mz);
    auto *gf_ms = static_cast<mfem::GridFunction *>(ctx.mfem_gf_ms);
    auto *inv_lumped_mass = static_cast<mfem::Vector *>(ctx.mfem_inv_lumped_mass);
    auto *tmp_vec = static_cast<mfem::Vector *>(ctx.mfem_exchange_tmp_vec);
    auto *out_vec = static_cast<mfem::Vector *>(ctx.mfem_exchange_out_vec);
    if (exchange_form == nullptr || gf_mx == nullptr || gf_my == nullptr || gf_mz == nullptr ||
        gf_ms == nullptr || inv_lumped_mass == nullptr || tmp_vec == nullptr || out_vec == nullptr) {
        error = "MFEM exchange scaffold is missing one or more operator/device buffers";
        return false;
    }
    if (ctx.use_consistent_mass && mass_form == nullptr) {
        error = "MFEM mass form is required for consistent-mass exchange but is null";
        return false;
    }

    TransferAuditScope exchange_audit_scope(
        ctx.transfer_audit,
        TransferAuditScopeKind::ExchangeInterop);

    unpack_aos_to_existing_components(m_xyz, ctx.mfem_mx, ctx.mfem_my, ctx.mfem_mz);
    copy_host_vector_to_mfem(ctx.mfem_mx, *gf_mx);
    copy_host_vector_to_mfem(ctx.mfem_my, *gf_my);
    copy_host_vector_to_mfem(ctx.mfem_mz, *gf_mz);

    double exchange_energy_accum = 0.0;
    double component_energy = 0.0;

    if (!apply_exchange_component_device(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_mx,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.mfem_h_ex_x,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    component_energy = 0.0;
    if (!apply_exchange_component_device(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_my,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.mfem_h_ex_y,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    component_energy = 0.0;
    if (!apply_exchange_component_device(
            &ctx,
            allow_interrupt,
            *exchange_form,
            *gf_mz,
            *gf_ms,
            *inv_lumped_mass,
            *mass_form,
            ctx.use_consistent_mass,
            *tmp_vec,
            *out_vec,
            ctx.mfem_h_ex_z,
            exchange_energy != nullptr ? &component_energy : nullptr)) {
        return false;
    }
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }
    if (exchange_energy != nullptr) {
        exchange_energy_accum += component_energy;
    }
    pack_components_to_aos(ctx.mfem_h_ex_x, ctx.mfem_h_ex_y, ctx.mfem_h_ex_z, h_ex_xyz);

    if (!ctx.magnetic_node_mask.empty()) {
        for (size_t i = 0; i < ctx.magnetic_node_mask.size(); ++i) {
            if (allow_interrupt &&
                i > 0 &&
                (i % static_cast<size_t>(kInterruptPollStride)) == 0 &&
                poll_interrupt(ctx)) {
                return false;
            }
            if (ctx.magnetic_node_mask[i] == 0u) {
                const size_t base = i * 3u;
                h_ex_xyz[base + 0u] = 0.0;
                h_ex_xyz[base + 1u] = 0.0;
                h_ex_xyz[base + 2u] = 0.0;
            }
        }
    }

    if (h_eff_xyz != nullptr) {
        h_eff_xyz->resize(h_ex_xyz.size());
        if (ctx.has_external_field) {
            for (size_t i = 0; i < h_ex_xyz.size(); ++i) {
                (*h_eff_xyz)[i] = h_ex_xyz[i] + ctx.h_ext_xyz[i];
            }
        } else {
            *h_eff_xyz = h_ex_xyz;
        }
    }

    if (exchange_energy != nullptr) {
        *exchange_energy = exchange_energy_accum;
    }

    return true;
}

bool context_refresh_exchange_field_mfem(Context &ctx, std::string &error)
{
    debug_checkpoint("context_refresh_exchange_field_mfem:enter");
    if (!context_sync_gpu_magnetization_to_host(ctx, error)) {
        return false;
    }
    double exchange_energy = 0.0;
    double demag_energy = 0.0;
    if (!compute_effective_fields_for_magnetization(
            ctx,
            ctx.m_xyz,
            ctx.h_ex_xyz,
            ctx.h_demag_xyz,
            ctx.h_eff_xyz,
            &exchange_energy,
            &demag_energy,
            false,
            nullptr,
            error)) {
        return false;
    }
    ctx.mfem_exchange_ready = true;
    debug_checkpoint("context_refresh_exchange_field_mfem:done");
    return true;
}

#else

bool initialize_exchange_operator_mfem(
    Context &,
    mfem::Mesh &,
    mfem::FiniteElementSpace &,
    mfem::GridFunctionCoefficient &,
    std::string &error)
{
    error = "Native FEM exchange requires the MFEM stack";
    return false;
}

bool upload_legacy_sparse_exchange_to_gpu_state(
    Context &,
    mfem::SparseMatrix &,
    std::string &error)
{
    error = "Native FEM exchange GPU upload requires the MFEM stack";
    return false;
}

bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool,
    std::string &error)
{
    const size_t field_size =
        !m_xyz.empty() ? m_xyz.size() : static_cast<size_t>(ctx.n_nodes) * 3u;
    h_ex_xyz.assign(field_size, 0.0);
    if (h_eff_xyz != nullptr) {
        *h_eff_xyz = h_ex_xyz;
    }
    if (exchange_energy != nullptr) {
        *exchange_energy = 0.0;
    }
    if (!ctx.enable_exchange || ctx.material.exchange_stiffness == 0.0) {
        return true;
    }
    error = "Native FEM exchange requires the MFEM stack";
    return false;
}

#endif

} // namespace fullmag::fem
