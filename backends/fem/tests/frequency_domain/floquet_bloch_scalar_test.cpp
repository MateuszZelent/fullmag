#include "cpu/frequency_domain/floquet_bloch_scalar.hpp"
#include "frequency_domain/tangent_frame.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void floquet_bloch_scalar_k0_reproduces_real_diffusion()
{
#if FULLMAG_HAS_MFEM_STACK
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1,
        1,
        1,
        mfem::Element::TETRAHEDRON,
        1.0,
        1.0,
        1.0);
    mfem::H1_FECollection collection(1, mesh.Dimension());
    mfem::FiniteElementSpace scalar_space(&mesh, &collection);

    fd::FloquetBlochScalarAssemblyRequest request{};
    request.scalar_space = &scalar_space;

    fd::FloquetBlochScalarAssemblyResult result{};
    check(
        fd::assemble_floquet_bloch_scalar_operator(request, &result) ==
            fd::FrequencyDomainStatus::ok,
        "Floquet Bloch scalar operator assembles at k=0");
    check(result.operator_matrix != nullptr,
          "Floquet Bloch scalar operator returns a complex MFEM matrix");

    mfem::BilinearForm diffusion(&scalar_space);
    diffusion.AddDomainIntegrator(new mfem::DiffusionIntegrator());
    diffusion.Assemble();
    diffusion.Finalize();

    const int dof_count = scalar_space.GetVSize();
    mfem::Vector input(2 * dof_count);
    for (int index = 0; index < dof_count; ++index) {
        input[index] = static_cast<double>(index + 1);
        input[dof_count + index] = 0.0;
    }
    mfem::Vector real_input(dof_count);
    for (int index = 0; index < dof_count; ++index) {
        real_input[index] = input[index];
    }
    mfem::Vector actual(2 * dof_count);
    check(result.operator_matrix->Height() == 2 * dof_count,
          "Floquet Bloch complex matrix has real-split dimension");
    result.operator_matrix->Mult(input, actual);

    mfem::Vector expected(dof_count);
    diffusion.SpMat().Mult(real_input, expected);
    for (int index = 0; index < dof_count; ++index) {
        check(std::abs(actual[index] - expected[index]) < 1.0e-12,
              "k=0 Floquet Bloch real block matches MFEM diffusion");
        check(std::abs(actual[dof_count + index]) < 1.0e-12,
              "k=0 Floquet Bloch imaginary block vanishes");
    }
#endif
}

void floquet_bloch_scalar_nonzero_k_has_antisymmetric_imaginary_block()
{
#if FULLMAG_HAS_MFEM_STACK
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1,
        1,
        1,
        mfem::Element::TETRAHEDRON,
        1.0,
        1.0,
        1.0);
    mfem::H1_FECollection collection(1, mesh.Dimension());
    mfem::FiniteElementSpace scalar_space(&mesh, &collection);

    fd::FloquetBlochScalarAssemblyRequest request{};
    request.scalar_space = &scalar_space;
    request.k_rad_per_m[0] = 1.0;

    fd::FloquetBlochScalarAssemblyResult result{};
    check(
        fd::assemble_floquet_bloch_scalar_operator(request, &result) ==
            fd::FrequencyDomainStatus::ok,
        "Floquet Bloch scalar operator assembles at nonzero k");

    const mfem::SparseMatrix &imaginary = result.operator_matrix->imag();
    double imaginary_abs_sum = 0.0;
    for (int row = 0; row < imaginary.Height(); ++row) {
        for (int column = 0; column < imaginary.Width(); ++column) {
            const double value = imaginary(row, column);
            imaginary_abs_sum += std::abs(value);
            check(std::abs(value + imaginary(column, row)) < 1.0e-12,
                  "Floquet Bloch scalar imaginary block is antisymmetric");
        }
    }
    check(imaginary_abs_sum > 0.0,
          "Floquet Bloch scalar imaginary block is nonzero for nonzero k");
#endif
}

void floquet_bloch_scalar_constraint_applies_negative_bloch_phase()
{
#if FULLMAG_HAS_MFEM_STACK
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1,
        1,
        1,
        mfem::Element::TETRAHEDRON,
        1.0,
        1.0,
        1.0);
    mfem::H1_FECollection collection(1, mesh.Dimension());
    mfem::FiniteElementSpace scalar_space(&mesh, &collection);

    const int full_dof_count = scalar_space.GetVSize();
    check(full_dof_count >= 2,
          "scalar Floquet constraint fixture has at least two DOFs");

    std::vector<fd::FloquetBlochScalarConstraintEntry> entries(
        static_cast<std::size_t>(full_dof_count));
    for (int dof = 0; dof < full_dof_count; ++dof) {
        entries[static_cast<std::size_t>(dof)].full_dof =
            static_cast<std::uint64_t>(dof);
        entries[static_cast<std::size_t>(dof)].reduced_dof =
            static_cast<std::uint64_t>(dof == 0 ? 0 : dof - 1);
    }
    entries[1].reduced_dof = 0;
    entries[1].translation_m[0] = 0.25 * std::acos(-1.0);

    fd::FloquetBlochScalarConstraintRequest request{};
    request.scalar_space = &scalar_space;
    request.entries = entries.data();
    request.entry_count = static_cast<std::uint64_t>(entries.size());
    request.reduced_dof_count = static_cast<std::uint64_t>(full_dof_count - 1);
    request.k_rad_per_m[0] = 2.0;

    fd::FloquetBlochScalarConstraintResult result{};
    check(
        fd::assemble_floquet_bloch_scalar_constraint(request, &result) ==
            fd::FrequencyDomainStatus::ok,
        "scalar Floquet constraint assembles for complete DOF classes");
    check(result.constraint_matrix != nullptr,
          "scalar Floquet constraint returns a complex real-split matrix");

    const int reduced_dof_count = full_dof_count - 1;
    mfem::Vector input(2 * reduced_dof_count);
    input = 0.0;
    input[0] = 3.0;
    mfem::Vector output(2 * full_dof_count);
    result.constraint_matrix->Mult(input, output);

    check(std::abs(output[0] - 3.0) < 1.0e-12,
          "scalar Floquet representative preserves the real amplitude");
    check(std::abs(output[full_dof_count]) < 1.0e-12,
          "scalar Floquet representative has zero imaginary amplitude");
    check(std::abs(output[1]) < 1.0e-12,
          "negative pi-over-two Bloch phase has zero real component");
    check(std::abs(output[full_dof_count + 1] + 3.0) < 1.0e-12,
          "scalar Floquet member applies exp(-i k dot R)");
#endif
}

void floquet_bloch_scalar_constraint_reduces_the_full_operator()
{
#if FULLMAG_HAS_MFEM_STACK
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1,
        1,
        1,
        mfem::Element::TETRAHEDRON,
        1.0,
        1.0,
        1.0);
    mfem::H1_FECollection collection(1, mesh.Dimension());
    mfem::FiniteElementSpace scalar_space(&mesh, &collection);
    const int full_dof_count = scalar_space.GetVSize();

    std::vector<fd::FloquetBlochScalarConstraintEntry> entries(
        static_cast<std::size_t>(full_dof_count));
    for (int dof = 0; dof < full_dof_count; ++dof) {
        entries[static_cast<std::size_t>(dof)].full_dof =
            static_cast<std::uint64_t>(dof);
        entries[static_cast<std::size_t>(dof)].reduced_dof =
            static_cast<std::uint64_t>(dof == 0 ? 0 : dof - 1);
    }
    entries[1].reduced_dof = 0;

    fd::FloquetBlochScalarAssemblyRequest operator_request{};
    operator_request.scalar_space = &scalar_space;
    fd::FloquetBlochScalarAssemblyResult operator_result{};
    check(
        fd::assemble_floquet_bloch_scalar_operator(operator_request, &operator_result) ==
            fd::FrequencyDomainStatus::ok,
        "full scalar operator assembles before constraint reduction");

    fd::FloquetBlochScalarConstraintRequest constraint_request{};
    constraint_request.scalar_space = &scalar_space;
    constraint_request.entries = entries.data();
    constraint_request.entry_count = static_cast<std::uint64_t>(entries.size());
    constraint_request.reduced_dof_count = static_cast<std::uint64_t>(full_dof_count - 1);
    fd::FloquetBlochScalarConstraintResult constraint_result{};
    check(
        fd::assemble_floquet_bloch_scalar_constraint(
            constraint_request,
            &constraint_result) == fd::FrequencyDomainStatus::ok,
        "scalar constraint assembles before constrained reduction");

    fd::FloquetBlochScalarReducedOperatorRequest reduction_request{};
    reduction_request.full_operator = operator_result.operator_matrix.get();
    reduction_request.constraint = constraint_result.constraint_matrix.get();
    fd::FloquetBlochScalarReducedOperatorResult reduction_result{};
    check(
        fd::assemble_floquet_bloch_scalar_reduced_operator(
            reduction_request,
            &reduction_result) == fd::FrequencyDomainStatus::ok,
        "scalar Floquet constraint reduces C^H P C");
    check(reduction_result.matrix != nullptr,
          "scalar Floquet constrained operator returns a dense real-split matrix");

    const int reduced_dof_count = full_dof_count - 1;
    mfem::Vector input(2 * reduced_dof_count);
    for (int index = 0; index < input.Size(); ++index) {
        input[index] = static_cast<double>(index + 1);
    }
    mfem::Vector full_input(2 * full_dof_count);
    mfem::Vector full_output(2 * full_dof_count);
    mfem::Vector expected(2 * reduced_dof_count);
    mfem::Vector actual(2 * reduced_dof_count);
    constraint_result.constraint_matrix->Mult(input, full_input);
    operator_result.operator_matrix->Mult(full_input, full_output);
    constraint_result.constraint_matrix->MultTranspose(full_output, expected);
    reduction_result.matrix->Mult(input, actual);
    for (int index = 0; index < actual.Size(); ++index) {
        check(std::abs(actual[index] - expected[index]) < 1.0e-12,
              "scalar Floquet constrained matrix matches C^H P C action");
    }
#endif
}

void floquet_bloch_scalar_tangent_source_matches_mfem_gradient_form_at_k0()
{
#if FULLMAG_HAS_MFEM_STACK
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1,
        1,
        1,
        mfem::Element::TETRAHEDRON,
        1.0,
        1.0,
        1.0);
    mfem::H1_FECollection collection(1, mesh.Dimension());
    mfem::FiniteElementSpace scalar_space(&mesh, &collection);
    const int scalar_dof_count = scalar_space.GetVSize();

    std::vector<fd::TangentFrameNode> frames(
        static_cast<std::size_t>(scalar_dof_count));
    fd::FloquetBlochScalarTangentSourceRequest request{};
    request.scalar_space = &scalar_space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = static_cast<std::uint64_t>(frames.size());
    request.saturation_magnetization_a_per_m = 1.0;

    fd::FloquetBlochScalarTangentSourceResult result{};
    check(
        fd::assemble_floquet_bloch_scalar_tangent_source(request, &result) ==
            fd::FrequencyDomainStatus::ok,
        "tangent scalar source assembles at k=0");
    check(result.source_matrix != nullptr,
          "tangent scalar source returns a complex real-split matrix");

    mfem::VectorConstantCoefficient x_direction(mfem::Vector({1.0, 0.0, 0.0}));
    mfem::LinearForm expected_form(&scalar_space);
    expected_form.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(x_direction));
    expected_form.Assemble();

    mfem::Vector input(4 * scalar_dof_count);
    input = 0.0;
    for (int dof = 0; dof < scalar_dof_count; ++dof) {
        input[2 * dof] = 1.0;
    }
    mfem::Vector actual(2 * scalar_dof_count);
    result.source_matrix->Mult(input, actual);
    for (int dof = 0; dof < scalar_dof_count; ++dof) {
        check(std::abs(actual[dof] - expected_form[dof]) < 1.0e-12,
              "tangent source real block matches MFEM (M, grad v)");
        check(std::abs(actual[scalar_dof_count + dof]) < 1.0e-12,
              "tangent source imaginary block vanishes at k=0");
    }
#endif
}

} // namespace

int main()
{
    floquet_bloch_scalar_k0_reproduces_real_diffusion();
    floquet_bloch_scalar_nonzero_k_has_antisymmetric_imaginary_block();
    floquet_bloch_scalar_constraint_applies_negative_bloch_phase();
    floquet_bloch_scalar_constraint_reduces_the_full_operator();
    floquet_bloch_scalar_tangent_source_matches_mfem_gradient_form_at_k0();
    return 0;
}
