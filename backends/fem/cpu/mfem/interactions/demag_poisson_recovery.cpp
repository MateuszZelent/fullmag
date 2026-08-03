/*
 * Poisson demag recovery source contract.
 *
 * This source owns scalar-potential-to-H_demag recovery, nonmagnetic zeroing,
 * visual demag sync, and Robin boundary energy extraction. It does not assemble RHS, solve Poisson, or format telemetry.
 */

#include "cpu/mfem/interactions/demag_poisson_recovery.hpp"

#include "cpu/mfem/interactions/demag_poisson_field.hpp"
#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _OPENMP
#include <omp.h>
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
struct DemagRecoveryWorkspace {
    struct Scratch {
        mfem::IsoparametricTransformation transformation;
        mfem::Array<int> potential_dofs;
        mfem::Array<int> state_dofs;
        mfem::Vector u_elem;
        mfem::DenseMatrix dshape;
        mfem::Vector state_shape;
    };

    explicit DemagRecoveryWorkspace(mfem::FiniteElementSpace *fes)
        : fes(fes)
        , potential(fes)
        , robin_boundary_tmp(fes->GetNDofs())
    {}

    static void reset_vector(std::vector<double> &values, size_t size) {
        if (values.size() != size) {
            values.assign(size, 0.0);
        } else {
            std::fill(values.begin(), values.end(), 0.0);
        }
    }

    void prepare(size_t node_count, int recover_threads, bool parallel_recover) {
        reset_vector(node_weight, node_count);
        reset_vector(visual_node_weight, node_count);
        if (!parallel_recover) {
            return;
        }

        const size_t thread_count = static_cast<size_t>(recover_threads);
        while (thread_scratch.size() < thread_count) {
            thread_scratch.emplace_back(std::make_unique<Scratch>());
        }
    }

    mfem::FiniteElementSpace *fes = nullptr;
    mfem::GridFunction potential;
    std::vector<double> node_weight;
    std::vector<double> visual_node_weight;
    Scratch serial_scratch;
    std::vector<std::unique_ptr<Scratch>> thread_scratch;
    mfem::Vector robin_boundary_tmp;
};

namespace {

void zero_non_magnetic_nodes_aos(
    std::vector<double> &field_xyz,
    const std::vector<uint8_t> &magnetic_node_mask)
{
    if (magnetic_node_mask.empty()) {
        return;
    }
    const size_t n = field_xyz.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        if (magnetic_node_mask[i] == 0u) {
            const size_t base = i * 3u;
            field_xyz[base + 0] = 0.0;
            field_xyz[base + 1] = 0.0;
            field_xyz[base + 2] = 0.0;
        }
    }
}

} // namespace

bool initialize_demag_poisson_recovery_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error)
{
    try {
        ctx.poisson_demag.recovery_workspace =
            new DemagRecoveryWorkspace(&fes);
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson demag recovery workspace initialization failed: ") +
                ex.what();
    } catch (...) {
        error = "Poisson demag recovery workspace initialization failed with an unknown error";
    }
    ctx.poisson_demag.recovery_workspace = nullptr;
    return false;
}

void destroy_demag_poisson_recovery_workspace(Context &ctx)
{
    delete static_cast<DemagRecoveryWorkspace *>(ctx.poisson_demag.recovery_workspace);
    ctx.poisson_demag.recovery_workspace = nullptr;
}

/// Recover H_demag = -grad(u) from the scalar potential solution.
/// Computes element-wise gradient, then distributes it to nodes with shape weights.
bool recover_demag_poisson_field(
    Context &ctx,
    const mfem::Vector &potential,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    const std::vector<double> &m_xyz,
    uint64_t *energy_wall_time_ns,
    std::string &error,
    const mfem::Vector *assembled_rhs)
{
    auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
    auto *demag_recovery_workspace =
        static_cast<DemagRecoveryWorkspace *>(ctx.poisson_demag.recovery_workspace);
    if (demag_recovery_workspace == nullptr || demag_recovery_workspace->fes == nullptr ||
        mesh == nullptr) {
        error = "Poisson FE space or mesh is null during H_demag recovery";
        return false;
    }
    mfem::FiniteElementSpace *fes = demag_recovery_workspace->fes;
    auto *state_fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_context.fes);
    if (state_fes == nullptr ||
        state_fes->GetNDofs() != static_cast<int>(ctx.mesh.n_nodes)) {
        error = "Poisson demag recovery requires the base P1 magnetization FE space";
        return false;
    }

    const size_t node_count = static_cast<size_t>(ctx.mesh.n_nodes);
    const size_t field_len = node_count * 3u;
    h_demag_xyz.assign(field_len, 0.0);
    ctx.demag.h_visual_xyz.assign(field_len, 0.0);
    if (!ctx.mesh.magnetic_element_mask.empty() &&
        ctx.mesh.magnetic_element_mask.size() != static_cast<size_t>(mesh->GetNE())) {
        error = "Poisson demag recovery magnetic-element mask size mismatch";
        return false;
    }

    std::atomic<bool> jacobian_weights_valid{true};
    std::atomic<bool> combined_weights_valid{true};

    auto accumulate_projection = [](std::vector<double> &field_accum,
                                    std::vector<double> &weight_accum,
                                    size_t node,
                                    double hx,
                                    double hy,
                                    double hz,
                                    double weight,
                                    bool atomic_updates) {
        const size_t base = node * 3u;
        if (atomic_updates) {
#pragma omp atomic update
            field_accum[base + 0] += hx;
#pragma omp atomic update
            field_accum[base + 1] += hy;
#pragma omp atomic update
            field_accum[base + 2] += hz;
#pragma omp atomic update
            weight_accum[node] += weight;
        } else {
            field_accum[base + 0] += hx;
            field_accum[base + 1] += hy;
            field_accum[base + 2] += hz;
            weight_accum[node] += weight;
        }
    };

    auto accumulate_element = [&](int elem,
                                  std::vector<double> &field_accum,
                                  std::vector<double> &weight_accum,
                                  std::vector<double> &visual_field_accum,
                                  std::vector<double> &visual_weight_accum,
                                  const mfem::GridFunction &gf_u,
                                  mfem::IsoparametricTransformation &transformation,
                                  mfem::Array<int> &potential_dofs,
                                  mfem::Array<int> &state_dofs,
                                  mfem::Vector &u_elem,
                                  mfem::DenseMatrix &dshape,
                                  mfem::Vector &state_shape,
                                  bool atomic_updates) {
        const mfem::FiniteElement *potential_fe = fes->GetFE(elem);
        const mfem::FiniteElement *state_fe = state_fes->GetFE(elem);
        mesh->GetElementTransformation(elem, &transformation);
        mfem::ElementTransformation *T = &transformation;
        const bool magnetic_element = ctx.mesh.magnetic_element_mask.empty() ||
            ctx.mesh.magnetic_element_mask[static_cast<size_t>(elem)] != 0u;

        fes->GetElementDofs(elem, potential_dofs);
        state_fes->GetElementDofs(elem, state_dofs);
        const int potential_ndof = potential_dofs.Size();
        const int state_ndof = state_dofs.Size();
        u_elem.SetSize(potential_ndof);
        for (int i = 0; i < potential_ndof; ++i) {
            const int gdof = potential_dofs[i] >= 0
                ? potential_dofs[i] : -1 - potential_dofs[i];
            const double sign = potential_dofs[i] >= 0 ? 1.0 : -1.0;
            u_elem(i) = sign * gf_u(gdof);
        }

        // P1 fast path: grad(u) is constant per element for linear tetrahedra.
        // One CalcPhysDShape call suffices; distribute equally to all 4 nodes
        // weighted by element volume / 4.
        if (potential_fe->GetOrder() == 1 &&
            potential_fe->GetGeomType() == mfem::Geometry::TETRAHEDRON) {
            const mfem::IntegrationPoint &ip0 =
                mfem::Geometries.GetCenter(potential_fe->GetGeomType());
            T->SetIntPoint(&ip0);
            const double jacobian_weight = T->Weight();
            if (!std::isfinite(jacobian_weight) || jacobian_weight <= 0.0) {
                jacobian_weights_valid.store(false, std::memory_order_relaxed);
                return;
            }
            const double elem_volume = jacobian_weight / 6.0;

            dshape.SetSize(potential_ndof, 3);
            potential_fe->CalcPhysDShape(*T, dshape);

            double grad_u[3] = {0.0, 0.0, 0.0};
            for (int i = 0; i < potential_ndof; ++i) {
                for (int d = 0; d < 3; ++d) {
                    grad_u[d] += u_elem(i) * dshape(i, d);
                }
            }

            const double node_weight = elem_volume / static_cast<double>(state_ndof);
            for (int i = 0; i < state_ndof; ++i) {
                const int gdof = state_dofs[i] >= 0
                    ? state_dofs[i] : -1 - state_dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.mesh.n_nodes) {
                    continue;
                }
                const size_t node = static_cast<size_t>(gdof);
                const double hx = -grad_u[0] * node_weight;
                const double hy = -grad_u[1] * node_weight;
                const double hz = -grad_u[2] * node_weight;
                accumulate_projection(
                    visual_field_accum,
                    visual_weight_accum,
                    node,
                    hx,
                    hy,
                    hz,
                    node_weight,
                    atomic_updates);
                if (magnetic_element) {
                    accumulate_projection(
                        field_accum,
                        weight_accum,
                        node,
                        hx,
                        hy,
                        hz,
                        node_weight,
                        atomic_updates);
                }
            }
            return;
        }

        // General path for higher-order elements: quadrature-based recovery.
        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(
                potential_fe->GetGeomType(),
                2 * potential_fe->GetOrder());

        state_shape.SetSize(state_ndof);
        dshape.SetSize(potential_ndof, 3);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double jacobian_weight = T->Weight();
            if (!std::isfinite(jacobian_weight) || jacobian_weight <= 0.0) {
                jacobian_weights_valid.store(false, std::memory_order_relaxed);
                return;
            }
            const double w = ip.weight * jacobian_weight;
            if (!std::isfinite(w)) {
                combined_weights_valid.store(false, std::memory_order_relaxed);
                return;
            }

            potential_fe->CalcPhysDShape(*T, dshape);

            double grad_u[3] = {0.0, 0.0, 0.0};
            for (int i = 0; i < potential_ndof; ++i) {
                for (int d = 0; d < 3; ++d) {
                    grad_u[d] += u_elem(i) * dshape(i, d);
                }
            }

            state_fe->CalcShape(ip, state_shape);
            for (int i = 0; i < state_ndof; ++i) {
                const int gdof = state_dofs[i] >= 0
                    ? state_dofs[i] : -1 - state_dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.mesh.n_nodes) {
                    continue;
                }
                const double phi_w = state_shape(i) * w;
                const size_t node = static_cast<size_t>(gdof);
                const double hx = -grad_u[0] * phi_w;
                const double hy = -grad_u[1] * phi_w;
                const double hz = -grad_u[2] * phi_w;
                accumulate_projection(
                    visual_field_accum,
                    visual_weight_accum,
                    node,
                    hx,
                    hy,
                    hz,
                    phi_w,
                    atomic_updates);
                if (magnetic_element) {
                    accumulate_projection(
                        field_accum,
                        weight_accum,
                        node,
                        hx,
                        hy,
                        hz,
                        phi_w,
                        atomic_updates);
                }
            }
        }

    };

    int recover_threads = 1;
#ifdef _OPENMP
    recover_threads = std::max(1, ctx.cpu_threads.effective_omp_threads);
    const size_t bytes_per_thread =
        sizeof(double) * (field_len + node_count);
    constexpr size_t kMaxRecoverScratchBytes = 256ull * 1024ull * 1024ull;
    while (recover_threads > 1 &&
           bytes_per_thread * static_cast<size_t>(recover_threads) > kMaxRecoverScratchBytes) {
        recover_threads /= 2;
    }
#endif
    const bool parallel_recover = recover_threads > 1 && mesh->GetNE() >= 2000;

    demag_recovery_workspace->prepare(
        node_count,
        recover_threads,
        parallel_recover);
    mfem::GridFunction &gf_u = demag_recovery_workspace->potential;
    gf_u.SetFromTrueDofs(potential);
    gf_u.HostRead();
    std::vector<double> &node_weight = demag_recovery_workspace->node_weight;
    std::vector<double> &visual_node_weight =
        demag_recovery_workspace->visual_node_weight;

    if (parallel_recover) {
#ifdef _OPENMP
#pragma omp parallel num_threads(recover_threads)
        {
            const int tid = omp_get_thread_num();
            auto &scratch =
                *demag_recovery_workspace->thread_scratch[static_cast<size_t>(tid)];

#pragma omp for schedule(static)
            for (int elem = 0; elem < mesh->GetNE(); ++elem) {
                accumulate_element(
                    elem,
                    h_demag_xyz,
                    node_weight,
                    ctx.demag.h_visual_xyz,
                    visual_node_weight,
                    gf_u,
                    scratch.transformation,
                    scratch.potential_dofs,
                    scratch.state_dofs,
                    scratch.u_elem,
                    scratch.dshape,
                    scratch.state_shape,
                    true);
            }
        }

#endif
    } else {
        auto &scratch = demag_recovery_workspace->serial_scratch;
        for (int elem = 0; elem < mesh->GetNE(); ++elem) {
            accumulate_element(
                elem,
                h_demag_xyz,
                node_weight,
                ctx.demag.h_visual_xyz,
                visual_node_weight,
                gf_u,
                scratch.transformation,
                scratch.potential_dofs,
                scratch.state_dofs,
                scratch.u_elem,
                scratch.dshape,
                scratch.state_shape,
                false);
        }

    }

    if (!jacobian_weights_valid.load(std::memory_order_relaxed)) {
        h_demag_xyz.clear();
        ctx.demag.h_visual_xyz.clear();
        error = "Poisson demag recovery requires finite positive Jacobian weights";
        return false;
    }
    if (!combined_weights_valid.load(std::memory_order_relaxed)) {
        h_demag_xyz.clear();
        ctx.demag.h_visual_xyz.clear();
        error = "Poisson demag recovery requires finite combined quadrature weights";
        return false;
    }

    for (size_t node = 0; node < node_count; ++node) {
        const double visual_weight = visual_node_weight[node];
        if (!std::isfinite(visual_weight) || visual_weight <= 0.0) {
            h_demag_xyz.clear();
            ctx.demag.h_visual_xyz.clear();
            error = "Poisson demag recovery has invalid visual accumulated projection mass at state node " +
                std::to_string(node);
            return false;
        }
        const bool magnetic_node = ctx.mesh.magnetic_node_mask.empty() ||
            ctx.mesh.magnetic_node_mask[node] != 0u;
        const double magnetic_weight = node_weight[node];
        if (magnetic_node &&
            (!std::isfinite(magnetic_weight) || magnetic_weight <= 0.0)) {
            h_demag_xyz.clear();
            ctx.demag.h_visual_xyz.clear();
            error = "Poisson demag recovery has invalid magnetic accumulated projection mass at state node " +
                std::to_string(node);
            return false;
        }
    }

#ifdef _OPENMP
#pragma omp parallel for schedule(static) if(parallel_recover || (recover_threads > 1 && static_cast<int>(node_count) >= 2048)) num_threads(recover_threads)
#endif
    for (int node = 0; node < static_cast<int>(node_count); ++node) {
        const size_t index = static_cast<size_t>(node);
        const size_t base = index * 3u;
        const double weight = node_weight[index];
        if (weight > 0.0) {
            h_demag_xyz[base + 0] /= weight;
            h_demag_xyz[base + 1] /= weight;
            h_demag_xyz[base + 2] /= weight;
        }
        const double visual_weight = visual_node_weight[index];
        ctx.demag.h_visual_xyz[base + 0] /= visual_weight;
        ctx.demag.h_visual_xyz[base + 1] /= visual_weight;
        ctx.demag.h_visual_xyz[base + 2] /= visual_weight;
    }

    // The LLG/energy field contains only magnetic-element contributions and is
    // zeroed on non-magnetic nodes before periodic projection. The separately
    // accumulated visual field retains the full-domain Poisson gradient.
    // Periodic classes must not mix magnetic and airbox material classes.
    zero_non_magnetic_nodes_aos(h_demag_xyz, ctx.mesh.magnetic_node_mask);
    finalize_demag_poisson_recovered_field(ctx, h_demag_xyz);

    if (ctx.integration_weights.mfem_lumped_mass.empty()) {
        error = "MFEM lumped mass is unavailable for Poisson demag energy evaluation";
        return false;
    }

    const auto energy_wall_start = FemSteadyClock::now();
    const double recovered_field_energy = demag_poisson_energy_from_field(
        ctx,
        m_xyz,
        h_demag_xyz,
        recover_threads);
    ctx.poisson_demag.last_recovered_field_energy_joules =
        recovered_field_energy;
    if (assembled_rhs != nullptr) {
        demag_energy = demag_poisson_energy_from_rhs_potential(
            *assembled_rhs,
            potential);
        if (!std::isfinite(demag_energy)) {
            error = "Poisson demag variational energy requires matching finite RHS and potential vectors";
            return false;
        }
        ctx.poisson_demag.last_variational_energy_joules = demag_energy;
    } else {
        demag_energy = recovered_field_energy;
        ctx.poisson_demag.last_variational_energy_joules = demag_energy;
    }

    // The physical demag functional is -mu0/2 integral M.H_demag.  For a
    // Robin solve H_demag already depends on (K + beta B)^-1, so this value
    // includes the boundary condition.  Adding beta*u^T*B*u again would
    // double-count the boundary contribution and break dE/dm = -mu0*M_s*H.
    ctx.demag.cached_robin_boundary_energy = 0.0;
    if (energy_wall_time_ns != nullptr) {
        *energy_wall_time_ns += elapsed_ns(energy_wall_start);
    }

    return true;
}
#endif

} // namespace fullmag::fem
