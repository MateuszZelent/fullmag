#include "cpu/mfem/interactions/oersted/vector_potential.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace fullmag::fem::oersted {
namespace {

void require(bool condition, const std::string &message)
{
    if (!condition) {
        throw std::invalid_argument(message);
    }
}

void add_sparse_block(
    const mfem::SparseMatrix &source,
    mfem::DenseMatrix &destination,
    int row_offset,
    int column_offset)
{
    const int *row_ptr = source.GetI();
    const int *columns = source.GetJ();
    const double *values = source.GetData();
    for (int row = 0; row < source.Height(); ++row) {
        for (int entry = row_ptr[row]; entry < row_ptr[row + 1]; ++entry) {
            destination(row_offset + row, column_offset + columns[entry]) =
                values[entry];
        }
    }
}

void add_sparse_transpose_block(
    const mfem::SparseMatrix &source,
    mfem::DenseMatrix &destination,
    int row_offset,
    int column_offset)
{
    const int *row_ptr = source.GetI();
    const int *columns = source.GetJ();
    const double *values = source.GetData();
    for (int row = 0; row < source.Height(); ++row) {
        for (int entry = row_ptr[row]; entry < row_ptr[row + 1]; ++entry) {
            destination(row_offset + columns[entry], column_offset + row) =
                values[entry];
        }
    }
}

void impose_zero(mfem::DenseMatrix &matrix, mfem::Vector &rhs, int dof)
{
    for (int column = 0; column < matrix.Width(); ++column) {
        matrix(dof, column) = 0.0;
    }
    for (int row = 0; row < matrix.Height(); ++row) {
        matrix(row, dof) = 0.0;
    }
    matrix(dof, dof) = 1.0;
    rhs[dof] = 0.0;
}

double vector_norm_slice(const mfem::Vector &value, int offset, int length)
{
    double sum = 0.0;
    for (int index = 0; index < length; ++index) {
        const double component = value[offset + index];
        sum += component * component;
    }
    return std::sqrt(sum);
}

void matrix_vector_residual(
    const mfem::DenseMatrix &matrix,
    const mfem::Vector &solution,
    const mfem::Vector &rhs,
    mfem::Vector &residual)
{
    residual.SetSize(matrix.Height());
    for (int row = 0; row < matrix.Height(); ++row) {
        double value = 0.0;
        for (int column = 0; column < matrix.Width(); ++column) {
            value += matrix(row, column) * solution[column];
        }
        residual[row] = value - rhs[row];
    }
}

int euler_characteristic(const mfem::Mesh &mesh)
{
    return mesh.GetNV() - mesh.GetNEdges() + mesh.GetNFaces() - mesh.GetNE();
}

void validate_options(
    const VectorPotentialOptions &options,
    const mfem::Mesh &mesh,
    const fullmag::fem::transport::ConservativeCurrentView &source)
{
    require(options.boundary_gauge_variant == "tangential_A_h1_0.v1",
        "OE-F2 only implements the baseline tangential_A_h1_0.v1 gauge");
    require(std::isfinite(options.mu0_si) && options.mu0_si > 0.0,
        "OE-F2 mu0 must be finite and positive");
    require(std::isfinite(options.relative_tolerance) &&
            options.relative_tolerance > 0.0,
        "OE-F2 relative tolerance must be finite and positive");
    require(options.maximum_nd_dofs > 0 && options.maximum_h1_dofs > 0,
        "OE-F2 DOF limits must be positive");
    require(source.space().GetMesh() == &mesh,
        "OE-F2 source view and airbox must use the same mesh");
    require(mesh.Dimension() == 3,
        "OE-F2 exact-sequence baseline requires a three-dimensional mesh");
    require(euler_characteristic(mesh) == 1,
        "OE-F2 topology certificate rejected a nontrivial harmonic domain");
    require(source.field().FESpace() != nullptr &&
            source.field().FESpace()->FEColl() != nullptr &&
            source.field().FESpace()->FEColl()->Name() ==
                std::string("RT_3D_P0"),
        "OE-F2 requires the certified RT0 current view");
}

} // namespace

VectorPotentialResult VectorPotentialSolver::Evaluate(
    const fullmag::fem::transport::ConservativeCurrentView &source,
    const VectorPotentialOptions &options)
{
    const mfem::Mesh &mesh = *source.space().GetMesh();
    validate_options(options, mesh, source);

    mfem::ND_FECollection nd_fec(1, 3);
    mfem::H1_FECollection h1_fec(1, 3);
    mfem::FiniteElementSpace nd_space(
        const_cast<mfem::Mesh *>(&mesh), &nd_fec);
    mfem::FiniteElementSpace h1_space(
        const_cast<mfem::Mesh *>(&mesh), &h1_fec);
    const int nd_dofs = nd_space.GetVSize();
    const int h1_dofs = h1_space.GetVSize();
    require(nd_dofs <= options.maximum_nd_dofs,
        "OE-F2 ND system exceeds the bounded CPU reference size");
    require(h1_dofs <= options.maximum_h1_dofs,
        "OE-F2 H1 system exceeds the bounded CPU reference size");

    mfem::ConstantCoefficient inverse_mu0(1.0 / options.mu0_si);
    mfem::BilinearForm curl_form(&nd_space);
    curl_form.AddDomainIntegrator(
        new mfem::CurlCurlIntegrator(inverse_mu0));
    curl_form.Assemble();
    curl_form.Finalize();

    mfem::MixedBilinearForm gradient_form(&h1_space, &nd_space);
    gradient_form.AddDomainIntegrator(
        new mfem::MixedVectorGradientIntegrator());
    gradient_form.Assemble();
    gradient_form.Finalize();

    mfem::VectorGridFunctionCoefficient current_coefficient(&source.field());
    mfem::LinearForm current_load(&nd_space);
    current_load.AddDomainIntegrator(
        new mfem::VectorFEDomainLFIntegrator(current_coefficient));
    current_load.Assemble();

    const mfem::SparseMatrix &curl_matrix = curl_form.SpMat();
    const mfem::SparseMatrix &gradient_matrix = gradient_form.SpMat();
    require(curl_matrix.Height() == nd_dofs &&
            curl_matrix.Width() == nd_dofs,
        "OE-F2 curl block has an unexpected dimension");
    require(gradient_matrix.Height() == nd_dofs &&
            gradient_matrix.Width() == h1_dofs,
        "OE-F2 gradient block has an unexpected dimension");

    const int block_size = nd_dofs + h1_dofs;
    mfem::DenseMatrix block(block_size);
    block = 0.0;
    add_sparse_block(curl_matrix, block, 0, 0);
    add_sparse_block(gradient_matrix, block, 0, nd_dofs);
    add_sparse_transpose_block(gradient_matrix, block, nd_dofs, 0);

    mfem::Vector rhs(block_size);
    rhs = 0.0;
    for (int dof = 0; dof < nd_dofs; ++dof) {
        rhs[dof] = current_load[dof];
    }

    mfem::Array<int> essential_nd;
    mfem::Array<int> essential_h1;
    nd_space.GetBoundaryTrueDofs(essential_nd);
    h1_space.GetBoundaryTrueDofs(essential_h1);
    std::vector<bool> essential_nd_mask(static_cast<std::size_t>(nd_dofs), false);
    std::vector<bool> essential_h1_mask(static_cast<std::size_t>(h1_dofs), false);
    for (int index = 0; index < essential_nd.Size(); ++index) {
        essential_nd_mask.at(static_cast<std::size_t>(essential_nd[index])) = true;
        impose_zero(block, rhs, essential_nd[index]);
    }
    for (int index = 0; index < essential_h1.Size(); ++index) {
        essential_h1_mask.at(static_cast<std::size_t>(essential_h1[index])) = true;
        impose_zero(block, rhs, nd_dofs + essential_h1[index]);
    }

    mfem::DenseMatrixInverse inverse(block);
    mfem::Vector solution(rhs);
    inverse.Mult(rhs, solution);
    for (int index = 0; index < solution.Size(); ++index) {
        require(std::isfinite(solution[index]),
            "OE-F2 mixed solve produced a non-finite coefficient");
    }

    mfem::Vector residual;
    matrix_vector_residual(block, solution, rhs, residual);

    // Recompute the physical blocks without the essential-row identity
    // modifications.  This keeps the published diagnostics tied to the
    // actual weak form rather than to the algebraic boundary-condition rows.
    mfem::Vector first_block(nd_dofs);
    mfem::Vector constraint_block(h1_dofs);
    for (int row = 0; row < nd_dofs; ++row) {
        double value = 0.0;
        for (int column = 0; column < nd_dofs; ++column) {
            value += curl_matrix(row, column) * solution[column];
        }
        for (int column = 0; column < h1_dofs; ++column) {
            value += gradient_matrix(row, column) *
                solution[nd_dofs + column];
        }
        first_block[row] = essential_nd_mask.at(static_cast<std::size_t>(row))
            ? 0.0
            : value - current_load[row];
    }
    for (int row = 0; row < h1_dofs; ++row) {
        double value = 0.0;
        for (int column = 0; column < nd_dofs; ++column) {
            value += gradient_matrix(column, row) * solution[column];
        }
        constraint_block[row] = essential_h1_mask.at(static_cast<std::size_t>(row))
            ? 0.0
            : value;
    }

    mfem::RT_FECollection rt_fec(0, 3);
    mfem::FiniteElementSpace rt_space(
        const_cast<mfem::Mesh *>(&mesh), &rt_fec);
    mfem::DiscreteLinearOperator curl_to_rt(&nd_space, &rt_space);
    curl_to_rt.AddDomainInterpolator(new mfem::CurlInterpolator());
    curl_to_rt.Assemble();
    curl_to_rt.Finalize();
    mfem::Vector compatible_b(rt_space.GetVSize());
    mfem::Vector a_dofs(nd_dofs);
    for (int index = 0; index < nd_dofs; ++index) {
        a_dofs[index] = solution[index];
    }
    curl_to_rt.Mult(a_dofs, compatible_b);

    mfem::L2_FECollection l2_fec(0, 3);
    mfem::FiniteElementSpace l2_space(
        const_cast<mfem::Mesh *>(&mesh), &l2_fec);
    mfem::DiscreteLinearOperator divergence(
        &rt_space, &l2_space);
    divergence.AddDomainInterpolator(new mfem::DivergenceInterpolator());
    divergence.Assemble();
    divergence.Finalize();
    mfem::Vector divergence_values(l2_space.GetVSize());
    divergence.Mult(compatible_b, divergence_values);

    VectorPotentialResult result;
    result.a_dofs_t_m.assign(solution.GetData(),
        solution.GetData() + nd_dofs);
    result.gauge_dofs_apm.assign(solution.GetData() + nd_dofs,
        solution.GetData() + block_size);
    result.compatible_b_dofs_t.assign(compatible_b.GetData(),
        compatible_b.GetData() + compatible_b.Size());
    result.compatible_h_dofs_apm.resize(compatible_b.Size());
    for (int index = 0; index < compatible_b.Size(); ++index) {
        result.compatible_h_dofs_apm[index] = compatible_b[index] /
            options.mu0_si;
    }
    result.diagnostics.nd_dofs = nd_dofs;
    result.diagnostics.h1_dofs = h1_dofs;
    result.diagnostics.block_size = block_size;
    result.diagnostics.harmonic_count = 0;
    result.diagnostics.essential_nd_dof_count = essential_nd.Size();
    result.diagnostics.essential_h1_dof_count = essential_h1.Size();
    result.diagnostics.first_block_residual = first_block.Norml2();
    result.diagnostics.constraint_residual = constraint_block.Norml2();
    result.diagnostics.weak_ampere_residual = first_block.Norml2();
    result.diagnostics.compatible_divergence_residual =
        divergence_values.Norml2();
    result.diagnostics.source_pairing_norm = current_load.Norml2();
    result.operator_version = operator_version;
    result.source_view_identity_digest =
        source.identity().view_identity_digest;
    result.boundary_gauge_variant = options.boundary_gauge_variant;

    const double scale = std::max(1.0, result.diagnostics.source_pairing_norm);
    const double tolerance = std::max(
        options.relative_tolerance * scale,
        128.0 * std::numeric_limits<double>::epsilon() * scale);
    require(result.diagnostics.first_block_residual <= tolerance,
        "OE-F2 first-block residual exceeds the declared tolerance");
    require(result.diagnostics.constraint_residual <= tolerance,
        "OE-F2 B^T A constraint residual exceeds the declared tolerance");
    require(result.diagnostics.compatible_divergence_residual <= tolerance,
        "OE-F2 compatible RT0 divergence exceeds the declared tolerance");
    return result;
}

} // namespace fullmag::fem::oersted
