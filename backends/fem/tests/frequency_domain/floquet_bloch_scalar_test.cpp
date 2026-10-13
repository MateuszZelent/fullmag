#include "cpu/frequency_domain/floquet_bloch_scalar.hpp"
#include "frequency_domain/tangent_frame.hpp"
#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
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

void floquet_bloch_scalar_full_field_uses_phase_constraint_only()
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
    request.k_rad_per_m[0] = 3.0;
    request.representation =
        fd::FloquetBlochScalarRepresentation::full_field_phase_constrained;

    fd::FloquetBlochScalarAssemblyResult result{};
    check(
        fd::assemble_floquet_bloch_scalar_operator(request, &result) ==
            fd::FrequencyDomainStatus::ok,
        "full-field Floquet scalar operator assembles at nonzero k");

    const mfem::SparseMatrix &imaginary = result.operator_matrix->imag();
    double imaginary_abs_sum = 0.0;
    for (int row = 0; row < imaginary.Height(); ++row) {
        for (int column = 0; column < imaginary.Width(); ++column) {
            imaginary_abs_sum += std::abs(imaginary(row, column));
        }
    }
    check(imaginary_abs_sum < 1.0e-12,
          "full-field representation has no shifted-derivative imaginary block");

    mfem::BilinearForm diffusion(&scalar_space);
    diffusion.AddDomainIntegrator(new mfem::DiffusionIntegrator());
    diffusion.Assemble();
    diffusion.Finalize();
    mfem::Vector input(2 * scalar_space.GetVSize());
    input = 0.0;
    for (int dof = 0; dof < scalar_space.GetVSize(); ++dof) {
        input[dof] = static_cast<double>(dof + 1);
    }
    mfem::Vector actual(input.Size());
    result.operator_matrix->Mult(input, actual);
    mfem::Vector expected(scalar_space.GetVSize());
    mfem::Vector real_input(scalar_space.GetVSize());
    for (int dof = 0; dof < scalar_space.GetVSize(); ++dof) {
        real_input[dof] = input[dof];
    }
    diffusion.SpMat().Mult(real_input, expected);
    for (int dof = 0; dof < scalar_space.GetVSize(); ++dof) {
        check(std::abs(actual[dof] - expected[dof]) < 1.0e-12,
              "full-field representation keeps ordinary diffusion block");
        check(std::abs(actual[scalar_space.GetVSize() + dof]) < 1.0e-12,
              "full-field representation keeps imaginary action zero");
    }
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

void floquet_bloch_scalar_tangent_source_masks_air_and_reduces_magnetic_nodes()
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
    const int dof_count = scalar_space.GetVSize();
    const int element_count = mesh.GetNE();
    std::vector<fd::TangentFrameNode> frames(static_cast<std::size_t>(dof_count));
    std::vector<double> nodal_ms(static_cast<std::size_t>(dof_count), 0.0);
    nodal_ms[0] = 1.0;

    std::vector<std::uint8_t> no_magnetic_elements(
        static_cast<std::size_t>(element_count), 0u);
    fd::FloquetBlochScalarTangentSourceRequest masked_request{};
    masked_request.scalar_space = &scalar_space;
    masked_request.tangent_frames = frames.data();
    masked_request.tangent_frame_count = static_cast<std::uint64_t>(frames.size());
    masked_request.saturation_magnetization_field = nodal_ms.data();
    masked_request.saturation_magnetization_field_count =
        static_cast<std::uint64_t>(nodal_ms.size());
    masked_request.representation =
        fd::FloquetBlochScalarRepresentation::full_field_phase_constrained;
    masked_request.magnetic_element_mask = no_magnetic_elements.data();
    masked_request.magnetic_element_mask_count =
        static_cast<std::uint64_t>(no_magnetic_elements.size());
    const std::uint32_t inactive = std::numeric_limits<std::uint32_t>::max();
    std::vector<std::uint32_t> one_reduced_node(
        static_cast<std::size_t>(dof_count), inactive);
    one_reduced_node[0] = 0u;
    masked_request.magnetic_reduced_node = one_reduced_node.data();
    masked_request.magnetic_reduced_node_count = 1u;

    fd::FloquetBlochScalarTangentSourceResult masked_result{};
    check(
        fd::assemble_floquet_bloch_scalar_tangent_source(
            masked_request,
            &masked_result) == fd::FrequencyDomainStatus::ok,
        "masked Floquet tangent source assembles with reduced magnetic map");
    check(masked_result.source_matrix->imag().Height() == dof_count &&
              masked_result.source_matrix->imag().Width() == 2,
          "reduced tangent source exposes two real-split q columns");
    mfem::Vector reduced_input(4);
    reduced_input = 0.0;
    reduced_input[0] = 1.0;
    mfem::Vector masked_output(2 * dof_count);
    masked_result.source_matrix->Mult(reduced_input, masked_output);
    for (int index = 0; index < masked_output.Size(); ++index) {
        check(std::abs(masked_output[index]) < 1.0e-12,
              "air-only element mask removes tangent source contribution");
    }

    std::vector<std::uint8_t> all_magnetic_elements(
        static_cast<std::size_t>(element_count), 1u);
    fd::FloquetBlochScalarTangentSourceRequest full_request = masked_request;
    full_request.magnetic_element_mask = all_magnetic_elements.data();
    std::vector<std::uint32_t> all_one_reduced(
        static_cast<std::size_t>(dof_count), 0u);
    full_request.magnetic_reduced_node = all_one_reduced.data();
    fd::FloquetBlochScalarTangentSourceResult full_result{};
    check(
        fd::assemble_floquet_bloch_scalar_tangent_source(
            full_request,
            &full_result) == fd::FrequencyDomainStatus::ok,
        "full magnetic tangent source assembles with one reduced class");
    check(full_result.source_matrix->real().Width() == 2,
          "magnetic node reduction collapses q columns to one class");
    mfem::Vector full_output(2 * dof_count);
    full_result.source_matrix->Mult(reduced_input, full_output);
    for (int dof = 0; dof < dof_count; ++dof) {
        check(std::abs(full_output[dof_count + dof]) < 1.0e-12,
              "full-field reduced source keeps imaginary block zero");
    }
#endif
}

#if FULLMAG_HAS_MFEM_STACK

double small_factorial(int n)
{
    double value = 1.0;
    for (int i = 2; i <= n; ++i) {
        value *= i;
    }
    return value;
}

// Exact barycentric moments on the reference simplex, independent of MFEM
// integration rules and of the production coefficient sampling code.
double simplex_source_moment(int dimension, int first, int second, int third = -1)
{
    int powers[4] = {};
    ++powers[first];
    ++powers[second];
    int degree = 2;
    if (third >= 0) {
        ++powers[third];
        ++degree;
    }
    double numerator = 1.0;
    for (int i = 0; i <= dimension; ++i) {
        numerator *= small_factorial(powers[i]);
    }
    return numerator / small_factorial(dimension + degree);
}

double segment_source_moment(int first, int second, int third = -1)
{
    const int upper = first + second + (third >= 0 ? third : 0);
    const int degree = third >= 0 ? 3 : 2;
    return small_factorial(upper) * small_factorial(degree - upper) /
        small_factorial(degree + 1);
}

void populate_reference_source_mesh(mfem::Mesh &mesh, bool prism)
{
    const double vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0}, {1.0, 0.0, 1.0}, {0.0, 1.0, 1.0}};
    for (int vertex = 0; vertex < (prism ? 6 : 4); ++vertex) {
        mesh.AddVertex(vertices[vertex]);
    }
    const int nodes[] = {0, 1, 2, 3, 4, 5};
    if (prism) {
        mesh.AddWedge(nodes, 1);
    } else {
        mesh.AddTet(nodes, 1);
    }
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
}

void source_vertex_materials(
    mfem::FiniteElementSpace &space,
    std::vector<int> &vertex_dofs,
    std::vector<double> &ms,
    std::vector<fd::TangentFrameNode> &frames)
{
    for (int vertex = 0; vertex < space.GetMesh()->GetNV(); ++vertex) {
        mfem::Array<int> dofs;
        space.GetVertexDofs(vertex, dofs);
        check(dofs.Size() == 1 && dofs[0] >= 0, "source oracle uses nodal H1 P1 DOFs");
        const int node = dofs[0];
        vertex_dofs.push_back(node);
        ms[node] = 1.0 + 0.5 * vertex;
        // Different valid tangent frames also test column-specific frame use.
        const double angle = 0.2 * vertex;
        frames[node].m[0] = 1.0;
        frames[node].m[1] = frames[node].m[2] = 0.0;
        frames[node].e1[0] = frames[node].e2[0] = 0.0;
        frames[node].e1[1] = std::cos(angle);
        frames[node].e1[2] = std::sin(angle);
        frames[node].e2[1] = -std::sin(angle);
        frames[node].e2[2] = std::cos(angle);
    }
}

void heterogeneous_source_matches_analytic_column_moments(bool prism)
{
    const int vertices = prism ? 6 : 4;
    mfem::Mesh mesh(3, vertices, 1, 0, 3);
    populate_reference_source_mesh(mesh, prism);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    const int n = space.GetVSize();
    std::vector<int> vertex_dofs;
    std::vector<double> ms(n);
    std::vector<fd::TangentFrameNode> frames(n);
    source_vertex_materials(space, vertex_dofs, ms, frames);
    const double tet_gradient[4][3] = {
        {-1.0, -1.0, -1.0}, {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0}};
    const double triangle_gradient[3][2] = {{-1.0, -1.0}, {1.0, 0.0}, {0.0, 1.0}};
    fd::FloquetBlochScalarTangentSourceRequest request{};
    request.scalar_space = &space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = n;
    request.saturation_magnetization_field = ms.data();
    request.saturation_magnetization_field_count = n;
    request.k_rad_per_m = {{0.7, -0.4, 0.9}};
    for (const auto representation : {
             fd::FloquetBlochScalarRepresentation::full_field_phase_constrained,
             fd::FloquetBlochScalarRepresentation::shifted_envelope}) {
        request.representation = representation;
        fd::FloquetBlochScalarTangentSourceResult assembled{};
        check(fd::assemble_floquet_bloch_scalar_tangent_source(request, &assembled) ==
                  fd::FrequencyDomainStatus::ok,
              "heterogeneous nodal source assembles for tet4 and prism6");
        for (int j = 0; j < vertices; ++j) {
            for (int component = 0; component < 2; ++component) {
                const double *frame = component == 0
                    ? frames[vertex_dofs[j]].e1 : frames[vertex_dofs[j]].e2;
                mfem::Vector column(2 * n);
                column = 0.0;
                column[2 * vertex_dofs[j] + component] = 1.0;
                mfem::Vector real(n), imaginary(n);
                assembled.source_matrix->real().Mult(column, real);
                assembled.source_matrix->imag().Mult(column, imaginary);
                for (int i = 0; i < vertices; ++i) {
                    double expected_real = 0.0;
                    double expected_imaginary = 0.0;
                    for (int l = 0; l < vertices; ++l) {
                        double gradient_moment[3] = {};
                        double shape_moment = 0.0;
                        if (!prism) {
                            const double pair = simplex_source_moment(3, l, j);
                            for (int axis = 0; axis < 3; ++axis) {
                                gradient_moment[axis] = pair * tet_gradient[i][axis];
                            }
                            shape_moment = simplex_source_moment(3, l, j, i);
                        } else {
                            const double triangle_pair = simplex_source_moment(2, l % 3, j % 3);
                            const double triangle_triple = simplex_source_moment(2, l % 3, j % 3, i % 3);
                            const double segment_pair = segment_source_moment(l / 3, j / 3);
                            const double segment_triple = segment_source_moment(l / 3, j / 3, i / 3);
                            for (int axis = 0; axis < 2; ++axis) {
                                gradient_moment[axis] = triangle_pair * segment_triple *
                                    triangle_gradient[i % 3][axis];
                            }
                            gradient_moment[2] = triangle_triple * segment_pair *
                                (i < 3 ? -1.0 : 1.0);
                            shape_moment = triangle_triple * segment_triple;
                        }
                        for (int axis = 0; axis < 3; ++axis) {
                            expected_real += ms[vertex_dofs[l]] * frame[axis] * gradient_moment[axis];
                            if (representation == fd::FloquetBlochScalarRepresentation::shifted_envelope) {
                                expected_imaginary += ms[vertex_dofs[l]] * frame[axis] *
                                    request.k_rad_per_m[axis] * shape_moment;
                            }
                        }
                    }
                    check(std::abs(real[vertex_dofs[i]] - expected_real) < 1.0e-12,
                          "heterogeneous source column matches analytic gradient moments");
                    check(std::abs(imaginary[vertex_dofs[i]] - expected_imaginary) < 1.0e-12,
                          "heterogeneous source column matches analytic cubic wavevector moments");
                }
            }
        }
        // Inactive tangent nodes still contribute their material coefficient.
        const std::uint32_t inactive = std::numeric_limits<std::uint32_t>::max();
        std::vector<std::uint32_t> reduced(n, inactive);
        reduced[vertex_dofs[0]] = 0u;
        request.magnetic_reduced_node = reduced.data();
        request.magnetic_reduced_node_count = 1u;
        fd::FloquetBlochScalarTangentSourceResult restricted{};
        check(fd::assemble_floquet_bloch_scalar_tangent_source(request, &restricted) ==
                  fd::FrequencyDomainStatus::ok,
              "heterogeneous source accepts inactive tangent nodes");
        mfem::Vector full_column(2 * n), reduced_column(2);
        full_column = 0.0;
        reduced_column = 0.0;
        full_column[2 * vertex_dofs[0]] = reduced_column[0] = 1.0;
        mfem::Vector full_real(n), reduced_real(n), full_imaginary(n), reduced_imaginary(n);
        assembled.source_matrix->real().Mult(full_column, full_real);
        restricted.source_matrix->real().Mult(reduced_column, reduced_real);
        assembled.source_matrix->imag().Mult(full_column, full_imaginary);
        restricted.source_matrix->imag().Mult(reduced_column, reduced_imaginary);
        for (int row = 0; row < n; ++row) {
            check(std::abs(full_real[row] - reduced_real[row]) < 1.0e-12 &&
                      std::abs(full_imaginary[row] - reduced_imaginary[row]) < 1.0e-12,
                  "tangent reduction preserves contributions from all material nodes");
        }
        request.magnetic_reduced_node = nullptr;
        request.magnetic_reduced_node_count = 0u;
    }
    // A constant nodal coefficient must reproduce the unchanged uniform path.
    std::vector<double> constant_ms(n, 2.0);
    request.saturation_magnetization_field = constant_ms.data();
    for (const auto representation : {
             fd::FloquetBlochScalarRepresentation::full_field_phase_constrained,
             fd::FloquetBlochScalarRepresentation::shifted_envelope}) {
        request.representation = representation;
        fd::FloquetBlochScalarTangentSourceResult nodal{}, uniform{};
        check(fd::assemble_floquet_bloch_scalar_tangent_source(request, &nodal) == fd::FrequencyDomainStatus::ok,
              "constant nodal source assembles");
        auto uniform_request = request;
        uniform_request.saturation_magnetization_field = nullptr;
        uniform_request.saturation_magnetization_field_count = 0u;
        uniform_request.saturation_magnetization_a_per_m = 2.0;
        check(fd::assemble_floquet_bloch_scalar_tangent_source(uniform_request, &uniform) == fd::FrequencyDomainStatus::ok,
              "uniform source assembles through its existing branch");
        for (int j = 0; j < 2 * n; ++j) {
            mfem::Vector column(2 * n), nodal_real(n), uniform_real(n), nodal_imaginary(n), uniform_imaginary(n);
            column = 0.0;
            column[j] = 1.0;
            nodal.source_matrix->real().Mult(column, nodal_real);
            uniform.source_matrix->real().Mult(column, uniform_real);
            nodal.source_matrix->imag().Mult(column, nodal_imaginary);
            uniform.source_matrix->imag().Mult(column, uniform_imaginary);
            for (int row = 0; row < n; ++row) {
                check(std::abs(nodal_real[row] - uniform_real[row]) < 1.0e-12 &&
                          std::abs(nodal_imaginary[row] - uniform_imaginary[row]) < 1.0e-12,
                      "constant nodal Ms reproduces the uniform source for both representations");
            }
        }
    }
}

void heterogeneous_source_k0_matches_shared_domain(bool prism)
{
    const int vertices = prism ? 6 : 4;
    mfem::Mesh mesh(3, vertices, 1, 0, 3);
    populate_reference_source_mesh(mesh, prism);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    const int n = space.GetVSize();
    std::vector<int> vertex_dofs;
    std::vector<double> ms(n);
    std::vector<fd::TangentFrameNode> frames(n);
    source_vertex_materials(space, vertex_dofs, ms, frames);
    std::vector<std::uint32_t> identity(n);
    for (int node = 0; node < n; ++node) {
        identity[node] = static_cast<std::uint32_t>(node);
    }
    std::vector<std::uint8_t> magnetic_elements(1, 1u);
    std::vector<std::uint32_t> zero_offsets(2 * n + 1, 0u);
    const fd::CsrMatrixView zero_a_qq{
        static_cast<std::uint64_t>(2 * n), static_cast<std::uint64_t>(2 * n),
        zero_offsets.data(), zero_offsets.size(), nullptr, 0u, nullptr, 0u};
    fd::PoissonAirboxSharedDomainAssemblyRequest k0{};
    k0.scalar_space = &space;
    k0.tangent_frames = frames.data();
    k0.tangent_frame_count = n;
    k0.magnetic_element_mask = magnetic_elements.data();
    k0.magnetic_element_count = magnetic_elements.size();
    k0.saturation_magnetization_a_per_m = ms.data();
    k0.saturation_magnetization_count = ms.size();
    k0.gamma0_m_per_a_s = 3.0;
    k0.mu0_T_m_A = 4.0;
    k0.magnetic_a_qq_csr = &zero_a_qq;
    k0.scalar_reduced_node = k0.magnetic_reduced_node = identity.data();
    k0.scalar_reduced_node_count = k0.magnetic_reduced_node_count = n;
    k0.equivalence_classes_complete = true;
    fd::PoissonAirboxSharedDomainAssemblyResult k0_result{};
    check(fd::assemble_poisson_airbox_shared_domain(k0, &k0_result) == fd::FrequencyDomainStatus::ok,
          k0_result.error_message);
    fd::FloquetBlochScalarTangentSourceRequest request{};
    request.scalar_space = &space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = n;
    request.saturation_magnetization_field = ms.data();
    request.saturation_magnetization_field_count = ms.size();
    for (const auto representation : {
             fd::FloquetBlochScalarRepresentation::full_field_phase_constrained,
             fd::FloquetBlochScalarRepresentation::shifted_envelope}) {
        request.representation = representation;
        fd::FloquetBlochScalarTangentSourceResult result{};
        check(fd::assemble_floquet_bloch_scalar_tangent_source(request, &result) == fd::FrequencyDomainStatus::ok,
              "heterogeneous Floquet source assembles at Gamma");
        for (int column_index = 0; column_index < 2 * n; ++column_index) {
            mfem::Vector column(2 * n), real(n), imaginary(n);
            column = 0.0;
            column[column_index] = 1.0;
            result.source_matrix->real().Mult(column, real);
            result.source_matrix->imag().Mult(column, imaginary);
            for (int row = 0; row < n; ++row) {
                double descriptor_entry = 0.0;
                for (std::uint32_t entry = k0_result.a_phiq.row_offsets[row];
                     entry < k0_result.a_phiq.row_offsets[row + 1]; ++entry) {
                    if (k0_result.a_phiq.column_indices[entry] == static_cast<std::uint32_t>(column_index)) {
                        descriptor_entry = k0_result.a_phiq.values[entry];
                    }
                }
                check(std::abs(real[row] + descriptor_entry) < 1.0e-12,
                      "heterogeneous Floquet Gamma source agrees with independent K0 descriptor -S");
                double feedback_entry = 0.0;
                for (std::uint32_t entry = k0_result.a_qphi.row_offsets[column_index];
                     entry < k0_result.a_qphi.row_offsets[column_index + 1]; ++entry) {
                    if (k0_result.a_qphi.column_indices[entry] == static_cast<std::uint32_t>(row)) {
                        feedback_entry = k0_result.a_qphi.values[entry];
                    }
                }
                check(std::abs(k0.mu0_T_m_A * real[row] - feedback_entry) < 1.0e-12,
                      "heterogeneous Gamma source retains reciprocal K0 feedback");
                check(std::abs(imaginary[row]) < 1.0e-12,
                      "heterogeneous shifted source imaginary action vanishes at Gamma");
            }
        }
    }
}
#endif

void floquet_bloch_scalar_heterogeneous_source_moment_contract()
{
#if FULLMAG_HAS_MFEM_STACK
    heterogeneous_source_matches_analytic_column_moments(false);
    heterogeneous_source_matches_analytic_column_moments(true);
#endif
}

void floquet_bloch_scalar_heterogeneous_source_k0_consistency()
{
#if FULLMAG_HAS_MFEM_STACK
    heterogeneous_source_k0_matches_shared_domain(false);
    heterogeneous_source_k0_matches_shared_domain(true);
#endif
}

} // namespace

int main()
{
    floquet_bloch_scalar_k0_reproduces_real_diffusion();
    floquet_bloch_scalar_nonzero_k_has_antisymmetric_imaginary_block();
    floquet_bloch_scalar_full_field_uses_phase_constraint_only();
    floquet_bloch_scalar_constraint_applies_negative_bloch_phase();
    floquet_bloch_scalar_constraint_reduces_the_full_operator();
    floquet_bloch_scalar_tangent_source_matches_mfem_gradient_form_at_k0();
    floquet_bloch_scalar_tangent_source_masks_air_and_reduces_magnetic_nodes();
    (void)floquet_bloch_scalar_heterogeneous_source_moment_contract();
    (void)floquet_bloch_scalar_heterogeneous_source_k0_consistency();
#if FULLMAG_HAS_MFEM_STACK
    std::printf("PASS: floquet_heterogeneous_nodal_ms_moments_and_gamma_consistency\n");
#endif
    return 0;
}
