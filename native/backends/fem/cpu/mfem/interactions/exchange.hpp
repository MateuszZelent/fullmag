#pragma once

#include <string>
#include <vector>

namespace mfem {
class FiniteElementSpace;
class GridFunctionCoefficient;
class Mesh;
class SparseMatrix;
} // namespace mfem

namespace fullmag::fem {

struct Context;

bool initialize_exchange_operator_mfem(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    mfem::GridFunctionCoefficient &a_coeff,
    std::string &error);

bool upload_legacy_sparse_exchange_to_gpu_state(
    Context &ctx,
    mfem::SparseMatrix &exchange_spmat,
    std::string &error);

bool compute_exchange_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ex_xyz,
    std::vector<double> *h_eff_xyz,
    double *exchange_energy,
    bool allow_interrupt,
    std::string &error);

} // namespace fullmag::fem
