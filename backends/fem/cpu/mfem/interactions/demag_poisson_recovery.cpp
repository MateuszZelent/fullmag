/*
 * Poisson demag recovery source contract.
 *
 * This source owns scalar-potential-to-H_demag recovery, nonmagnetic zeroing,
 * visual demag sync, and Robin boundary energy extraction. It does not assemble RHS, solve Poisson, or format telemetry.
 */

#include "cpu/mfem/interactions/demag_poisson_recovery.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "fem_common.hpp"

#include <algorithm>
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
        mfem::Array<int> dofs;
        mfem::Vector u_elem;
        mfem::DenseMatrix dshape;
        mfem::Vector shape;
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
    std::string &error)
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

    const size_t node_count = static_cast<size_t>(ctx.mesh.n_nodes);
    const size_t field_len = node_count * 3u;
    h_demag_xyz.assign(field_len, 0.0);

    auto accumulate_element = [&](int elem,
                                  std::vector<double> &field_accum,
                                  std::vector<double> &weight_accum,
                                  const mfem::GridFunction &gf_u,
                                  mfem::Array<int> &dofs,
                                  mfem::Vector &u_elem,
                                  mfem::DenseMatrix &dshape,
                                  mfem::Vector &shape,
                                  bool atomic_updates) {
        const mfem::FiniteElement *fe = fes->GetFE(elem);
        mfem::ElementTransformation *T = mesh->GetElementTransformation(elem);

        fes->GetElementDofs(elem, dofs);
        const int local_ndof = dofs.Size();
        u_elem.SetSize(local_ndof);
        for (int i = 0; i < local_ndof; ++i) {
            const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
            const double sign = dofs[i] >= 0 ? 1.0 : -1.0;
            u_elem(i) = sign * gf_u(gdof);
        }

        // P1 fast path: grad(u) is constant per element for linear tetrahedra.
        // One CalcPhysDShape call suffices; distribute equally to all 4 nodes
        // weighted by element volume / 4.
        if (fe->GetOrder() == 1 && local_ndof == 4) {
            const mfem::IntegrationPoint &ip0 =
                mfem::Geometries.GetCenter(fe->GetGeomType());
            T->SetIntPoint(&ip0);
            const double elem_volume = std::abs(T->Weight()) / 6.0;

            dshape.SetSize(local_ndof, 3);
            fe->CalcPhysDShape(*T, dshape);

            double grad_u[3] = {0.0, 0.0, 0.0};
            for (int i = 0; i < local_ndof; ++i) {
                for (int d = 0; d < 3; ++d) {
                    grad_u[d] += u_elem(i) * dshape(i, d);
                }
            }

            const double node_weight = elem_volume / 4.0;
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.mesh.n_nodes) {
                    continue;
                }
                const size_t node = static_cast<size_t>(gdof);
                const size_t base = node * 3u;
                const double hx = -grad_u[0] * node_weight;
                const double hy = -grad_u[1] * node_weight;
                const double hz = -grad_u[2] * node_weight;
                if (atomic_updates) {
#pragma omp atomic update
                    field_accum[base + 0] += hx;
#pragma omp atomic update
                    field_accum[base + 1] += hy;
#pragma omp atomic update
                    field_accum[base + 2] += hz;
#pragma omp atomic update
                    weight_accum[node] += node_weight;
                } else {
                    field_accum[base + 0] += hx;
                    field_accum[base + 1] += hy;
                    field_accum[base + 2] += hz;
                    weight_accum[node] += node_weight;
                }
            }
            return;
        }

        // General path for higher-order elements: quadrature-based recovery.
        const mfem::IntegrationRule &ir =
            mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder());

        shape.SetSize(local_ndof);
        dshape.SetSize(local_ndof, 3);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint &ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            const double w = ip.weight * T->Weight();

            fe->CalcPhysDShape(*T, dshape);

            double grad_u[3] = {0.0, 0.0, 0.0};
            for (int i = 0; i < local_ndof; ++i) {
                for (int d = 0; d < 3; ++d) {
                    grad_u[d] += u_elem(i) * dshape(i, d);
                }
            }

            fe->CalcShape(ip, shape);
            for (int i = 0; i < local_ndof; ++i) {
                const int gdof = dofs[i] >= 0 ? dofs[i] : -1 - dofs[i];
                if (gdof < 0 || static_cast<uint32_t>(gdof) >= ctx.mesh.n_nodes) {
                    continue;
                }
                const double phi_w = std::abs(shape(i)) * w;
                const size_t node = static_cast<size_t>(gdof);
                const size_t base = node * 3u;
                const double hx = -grad_u[0] * phi_w;
                const double hy = -grad_u[1] * phi_w;
                const double hz = -grad_u[2] * phi_w;
                if (atomic_updates) {
#pragma omp atomic update
                    field_accum[base + 0] += hx;
#pragma omp atomic update
                    field_accum[base + 1] += hy;
#pragma omp atomic update
                    field_accum[base + 2] += hz;
#pragma omp atomic update
                    weight_accum[node] += phi_w;
                } else {
                    field_accum[base + 0] += hx;
                    field_accum[base + 1] += hy;
                    field_accum[base + 2] += hz;
                    weight_accum[node] += phi_w;
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
    std::vector<double> &node_weight = demag_recovery_workspace->node_weight;

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
                    gf_u,
                    scratch.dofs,
                    scratch.u_elem,
                    scratch.dshape,
                    scratch.shape,
                    true);
            }
        }

#pragma omp parallel for schedule(static) num_threads(recover_threads)
        for (int node = 0; node < static_cast<int>(node_count); ++node) {
            const size_t base = static_cast<size_t>(node) * 3u;
            const double weight = node_weight[static_cast<size_t>(node)];
            if (weight > 0.0) {
                h_demag_xyz[base + 0] /= weight;
                h_demag_xyz[base + 1] /= weight;
                h_demag_xyz[base + 2] /= weight;
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
                gf_u,
                scratch.dofs,
                scratch.u_elem,
                scratch.dshape,
                scratch.shape,
                false);
        }

#ifdef _OPENMP
#pragma omp parallel for schedule(static) if(recover_threads > 1 && static_cast<int>(node_count) >= 2048) num_threads(recover_threads)
#endif
        for (int node = 0; node < static_cast<int>(node_count); ++node) {
            const double weight = node_weight[static_cast<size_t>(node)];
            if (weight > 0.0) {
                const size_t base = static_cast<size_t>(node) * 3u;
                h_demag_xyz[base + 0] /= weight;
                h_demag_xyz[base + 1] /= weight;
                h_demag_xyz[base + 2] /= weight;
            }
        }
    }

    // Preserve full-domain H_demag for visualization before zeroing airbox.
    ctx.demag.h_visual_xyz = h_demag_xyz;

    zero_non_magnetic_nodes_aos(h_demag_xyz, ctx.mesh.magnetic_node_mask);

    if (ctx.integration_weights.mfem_lumped_mass.empty()) {
        error = "MFEM lumped mass is unavailable for Poisson demag energy evaluation";
        return false;
    }

    const auto energy_wall_start = FemSteadyClock::now();
    demag_energy = demag_poisson_energy_from_field(
        ctx,
        m_xyz,
        h_demag_xyz,
        recover_threads);

    // Robin BC correction: E_bdr = (mu0/2) * beta * integral_Gamma u^2 dS.
    ctx.demag.cached_robin_boundary_energy = 0.0;
    if (ctx.demag.realization == 2 /* AIRBOX_ROBIN */ &&
        ctx.poisson_demag.robin_effective_beta > 0.0 &&
        ctx.poisson_demag.robin_boundary_mass != nullptr) {
        auto *bdr_mass =
            static_cast<mfem::BilinearForm *>(ctx.poisson_demag.robin_boundary_mass);
        mfem::Vector &robin_boundary_tmp =
            demag_recovery_workspace->robin_boundary_tmp;
        robin_boundary_tmp.SetSize(gf_u.Size());
        bdr_mass->SpMat().Mult(gf_u, robin_boundary_tmp);
        ctx.demag.cached_robin_boundary_energy =
            0.5 * kMu0 * ctx.poisson_demag.robin_effective_beta * (gf_u * robin_boundary_tmp);
        demag_energy += ctx.demag.cached_robin_boundary_energy;
    }
    if (energy_wall_time_ns != nullptr) {
        *energy_wall_time_ns += elapsed_ns(energy_wall_start);
    }

    return true;
}
#endif

} // namespace fullmag::fem
