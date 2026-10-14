/*
 * floquet_airbox_operator_test.cpp - bounded MFEM Floquet airbox assembly
 * contract tests.
 */

#include "cpu/frequency_domain/floquet_airbox_operator.hpp"

#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <memory>
#include <tuple>
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

void check_close(double actual, double expected, const char *message)
{
    check(std::abs(actual - expected) < 1.0e-12, message);
}

#if FULLMAG_HAS_MFEM_STACK

std::unique_ptr<mfem::ComplexSparseMatrix> make_complex_matrix(
    int rows,
    int columns,
    std::initializer_list<std::tuple<int, int, double>> real_entries,
    std::initializer_list<std::tuple<int, int, double>> imaginary_entries)
{
    auto real = std::make_unique<mfem::SparseMatrix>(rows, columns);
    auto imaginary = std::make_unique<mfem::SparseMatrix>(rows, columns);
    for (const auto &[row, column, value] : real_entries) {
        real->Add(row, column, value);
    }
    for (const auto &[row, column, value] : imaginary_entries) {
        imaginary->Add(row, column, value);
    }
    real->Finalize();
    imaginary->Finalize();
    return std::make_unique<mfem::ComplexSparseMatrix>(
        real.release(),
        imaginary.release(),
        true,
        true,
        mfem::ComplexOperator::HERMITIAN);
}

void reduces_phase_constrained_airbox_blocks_before_schur_elimination()
{
    // C = [1, exp(-i*pi/2)] maps two full scalar-potential DOFs to one
    // periodic class.  With P=I and A_phiq=[1,1], C^H A_phiq=1+i and
    // C^H P C=2, hence D=-(1+i)(1-i)/2=-1.
    auto scalar_operator = make_complex_matrix(
        2,
        2,
        {{0, 0, 1.0}, {1, 1, 1.0}},
        {});
    auto scalar_constraint = make_complex_matrix(
        2,
        1,
        {{0, 0, 1.0}},
        {{1, 0, -1.0}});
    auto tangent_source = make_complex_matrix(
        2,
        1,
        {{0, 0, 1.0}, {1, 0, 1.0}},
        {});

    fd::FloquetAirboxDynamicDemagKProblem problem{};
    problem.scalar_operator = scalar_operator.get();
    problem.scalar_constraint = scalar_constraint.get();
    problem.tangent_source = tangent_source.get();
    problem.k_rad_per_m[0] = 1.0;

    fd::FloquetAirboxDynamicDemagKResult result{};
    check(
        fd::assemble_floquet_airbox_dynamic_demag_k(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        "phase-reduced Floquet airbox Schur assembly succeeds");
    check(result.real_split_row_major.size() == 4,
          "one tangent DOF produces a 2x2 real-split Schur block");
    check_close(result.real_split_row_major[0], -1.0,
                "phase-reduced Schur real-real entry is exact");
    check_close(result.real_split_row_major[1], 0.0,
                "phase-reduced Schur real-imag entry vanishes");
    check_close(result.real_split_row_major[2], 0.0,
                "phase-reduced Schur imag-real entry vanishes");
    check_close(result.real_split_row_major[3], -1.0,
                "phase-reduced Schur imag-imag entry is exact");
    check_close(result.diagnostics.k_norm_rad_per_m, 1.0,
                "airbox diagnostics preserve the nonzero wavevector");
}

void raw_rhs_and_descriptor_reconstruct_the_same_physical_potential()
{
    auto p = make_complex_matrix(2, 2, {{0, 0, 1.0}, {1, 1, 1.0}}, {});
    auto c = make_complex_matrix(2, 1, {{0, 0, 1.0}}, {{1, 0, -1.0}});
    auto raw = make_complex_matrix(2, 2, {{0, 0, 1.0}, {1, 1, 3.0}},
                                   {{0, 0, 2.0}, {1, 1, -1.0}});
    auto descriptor = make_complex_matrix(2, 2, {{0, 0, -1.0}, {1, 1, -3.0}},
                                          {{0, 0, -2.0}, {1, 1, 1.0}});
    fd::FloquetAirboxDynamicDemagKProblem request{};
    request.scalar_operator = p.get();
    request.scalar_constraint = c.get();
    request.tangent_constraint = c.get();
    request.tangent_source = raw.get();
    request.tangent_source_convention = fd::FloquetAirboxTangentSourceConvention::weak_poisson_rhs;
    request.qphi_feedback_scale = -1.25663706212e-6;
    request.k_rad_per_m[0] = 1.0;
    fd::FloquetAirboxDynamicDemagKResult from_rhs{}, from_descriptor{};
    check(fd::assemble_floquet_airbox_dynamic_demag_k(request, &from_rhs) == fd::FrequencyDomainStatus::ok,
          "raw physical RHS is converted to descriptor");
    request.tangent_source = descriptor.get();
    request.tangent_source_convention = fd::FloquetAirboxTangentSourceConvention::descriptor_block;
    check(fd::assemble_floquet_airbox_dynamic_demag_k(request, &from_descriptor) == fd::FrequencyDomainStatus::ok,
          "explicit descriptor is accepted without another sign change");
    check(from_rhs.reconstruction.p == from_descriptor.reconstruction.p &&
          from_rhs.reconstruction.a_phiq == from_descriptor.reconstruction.a_phiq &&
          from_rhs.reconstruction.a_qphi == from_descriptor.reconstruction.a_qphi &&
          from_rhs.real_split_row_major == from_descriptor.real_split_row_major,
          "both conventions yield identical descriptor, feedback and Schur");
    const std::vector<std::complex<double>> q{{.7, -.3}};
    fd::FloquetReconstructedPotential rhs_phi{}, descriptor_phi{};
    check(fd::reconstruct_floquet_potential(from_rhs.reconstruction, q, &rhs_phi) == fd::FrequencyDomainStatus::ok &&
          fd::reconstruct_floquet_potential(from_descriptor.reconstruction, q, &descriptor_phi) == fd::FrequencyDomainStatus::ok,
          "both conventions reconstruct certified potential");
    check(rhs_phi.certified && descriptor_phi.certified &&
          rhs_phi.phi == descriptor_phi.phi && rhs_phi.phi.size() == 1u,
          "both conventions reconstruct the same potential");
    // Independent physical equation: P_red=2, S_red=4+i, phi=S_red*q/2.
    check_close(std::abs(2.0 * rhs_phi.phi[0] - std::complex<double>(4.0, 1.0) * q[0]), 0.0,
                "reconstructed phi satisfies physical P phi-S q=0");
    check_close(raw->real()(0, 0), 1.0, "raw real source owner is unchanged");
    check_close(raw->imag()(0, 0), 2.0, "raw imaginary source owner is unchanged");
    request.tangent_source_convention = static_cast<fd::FloquetAirboxTangentSourceConvention>(99);
    fd::FloquetAirboxDynamicDemagKResult rejected{};
    check(fd::assemble_floquet_airbox_dynamic_demag_k(request, &rejected) == fd::FrequencyDomainStatus::validation_error &&
          rejected.real_split_row_major.empty(), "unknown source convention fails closed");
}

void rejects_missing_floquet_airbox_blocks_without_fallback()
{
    fd::FloquetAirboxDynamicDemagKProblem problem{};
    problem.k_rad_per_m[2] = 1.0;
    fd::FloquetAirboxDynamicDemagKResult result{};
    check(
        fd::assemble_floquet_airbox_dynamic_demag_k(problem, &result) ==
            fd::FrequencyDomainStatus::validation_error,
        "missing Floquet airbox blocks are rejected");
    check(result.real_split_row_major.empty(),
          "rejected airbox assembly does not publish a partial matrix");
}

void applies_the_magnetic_floquet_constraint_before_schur_elimination()
{
    // The scalar and magnetic constraints both use
    // C=[1, exp(-i*pi/2)].  With P_full=I and A_phiq,full=I, both reductions
    // contribute a factor of two, so D=-(2)(2)/2=-2.
    auto scalar_operator = make_complex_matrix(
        2,
        2,
        {{0, 0, 1.0}, {1, 1, 1.0}},
        {});
    auto scalar_constraint = make_complex_matrix(
        2,
        1,
        {{0, 0, 1.0}},
        {{1, 0, -1.0}});
    auto tangent_source = make_complex_matrix(
        2,
        2,
        {{0, 0, 1.0}, {1, 1, 1.0}},
        {});
    auto tangent_constraint = make_complex_matrix(
        2,
        1,
        {{0, 0, 1.0}},
        {{1, 0, -1.0}});

    fd::FloquetAirboxDynamicDemagKProblem problem{};
    problem.scalar_operator = scalar_operator.get();
    problem.scalar_constraint = scalar_constraint.get();
    problem.tangent_source = tangent_source.get();
    problem.tangent_constraint = tangent_constraint.get();
    problem.k_rad_per_m[0] = 1.0;

    fd::FloquetAirboxDynamicDemagKResult result{};
    check(
        fd::assemble_floquet_airbox_dynamic_demag_k(problem, &result) ==
            fd::FrequencyDomainStatus::ok,
        "magnetic phase-reduced Floquet Schur assembly succeeds");
    check(result.real_split_row_major.size() == 4,
          "magnetic phase reduction produces a one-class 2x2 real-split block");
    check_close(result.real_split_row_major[0], -2.0,
                "magnetic phase reduction scales the Schur real-real entry");
    check_close(result.real_split_row_major[1], 0.0,
                "magnetic phase reduction has zero real-imag entry");
    check_close(result.real_split_row_major[2], 0.0,
                "magnetic phase reduction has zero imag-real entry");
    check_close(result.real_split_row_major[3], -2.0,
                "magnetic phase reduction scales the Schur imag-imag entry");
}

void assembles_shared_domain_floquet_blocks_with_one_phase_graph()
{
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
    const std::uint64_t node_count = static_cast<std::uint64_t>(scalar_space.GetVSize());
    check(node_count >= 2u, "shared-domain Floquet fixture has two nodes");

    std::vector<fd::TangentFrameNode> frames(static_cast<std::size_t>(node_count));
    std::vector<std::uint8_t> magnetic_mask(static_cast<std::size_t>(mesh.GetNE()), 1u);
    std::vector<double> saturation_magnetization(static_cast<std::size_t>(node_count), 1.0);
    std::vector<std::uint32_t> scalar_classes(static_cast<std::size_t>(node_count));
    std::vector<std::uint32_t> magnetic_classes(static_cast<std::size_t>(node_count));
    scalar_classes[0] = 0u;
    scalar_classes[1] = 0u;
    magnetic_classes[0] = 0u;
    magnetic_classes[1] = 0u;
    for (std::uint64_t node = 2u; node < node_count; ++node) {
        scalar_classes[static_cast<std::size_t>(node)] =
            static_cast<std::uint32_t>(node - 1u);
        magnetic_classes[static_cast<std::size_t>(node)] =
            static_cast<std::uint32_t>(node - 1u);
    }
    const std::uint64_t reduced_node_count = node_count - 1u;
    fd::FrequencyDomainFloquetPeriodicPair pair{};
    pair.node_a = 0u;
    pair.node_b = 1u;
    pair.has_translation = true;
    pair.translation_m[0] = 1.0;
    pair.has_phase = true;
    pair.phase_rad = -0.5;

    mfem::Array<int> robin_marker(mesh.bdr_attributes.Max());
    robin_marker = 1;
    fd::FloquetAirboxSharedDomainBlockRequest request{};
    request.scalar_space = &scalar_space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = node_count;
    request.magnetic_element_mask = magnetic_mask.data();
    request.magnetic_element_count = magnetic_mask.size();
    request.saturation_magnetization_a_per_m = saturation_magnetization.data();
    request.saturation_magnetization_count = saturation_magnetization.size();
    request.scalar_reduced_node = scalar_classes.data();
    request.scalar_reduced_node_count = reduced_node_count;
    request.magnetic_reduced_node = magnetic_classes.data();
    request.magnetic_reduced_node_count = reduced_node_count;
    request.periodic_pairs = &pair;
    request.periodic_pair_count = 1u;
    request.k_rad_per_m[0] = 0.5;
    request.boundary_kind = fd::FloquetAirboxBoundaryKind::robin;
    request.robin_beta = 1.0;
    request.robin_boundary_marker = &robin_marker;

    fd::FloquetAirboxSharedDomainBlockResult blocks{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(request, &blocks) ==
            fd::FrequencyDomainStatus::ok,
        "shared-domain Floquet block producer assembles ordinary-gradient blocks");
    check(blocks.scalar_operator != nullptr && blocks.scalar_constraint != nullptr &&
              blocks.tangent_source != nullptr && blocks.tangent_constraint != nullptr,
          "shared-domain Floquet block producer returns all four blocks");
    check(blocks.uniform_transverse_probe_q_y.size() == 2u * reduced_node_count &&
              blocks.uniform_transverse_probe_q_z.size() == 2u * reduced_node_count,
          "shared-domain Floquet producer returns reduced transverse probe vectors");
    for (std::uint64_t class_id = 0u; class_id < reduced_node_count; ++class_id) {
        check_close(
            blocks.uniform_transverse_probe_q_y[2u * class_id],
            0.0,
            "global-y perturbation is projected into the first representative tangent axis");
        check_close(
            blocks.uniform_transverse_probe_q_y[2u * class_id + 1u],
            1.0,
            "global-y perturbation is projected into the second representative tangent axis");
        check_close(
            blocks.uniform_transverse_probe_q_z[2u * class_id],
            0.0,
            "longitudinal global-z perturbation is removed for the default +z equilibrium");
        check_close(
            blocks.uniform_transverse_probe_q_z[2u * class_id + 1u],
            0.0,
            "longitudinal global-z perturbation has no tangent component");
    }
    check(blocks.scalar_constraint->real().Width() == static_cast<int>(reduced_node_count),
          "shared-domain scalar constraint uses the reduced class count");
    check(blocks.tangent_source->real().Width() == static_cast<int>(2u * node_count),
          "shared-domain tangent source retains full q columns before phase reduction");
    check(blocks.tangent_constraint->real().Height() == static_cast<int>(2u * node_count) &&
              blocks.tangent_constraint->real().Width() ==
                  static_cast<int>(2u * reduced_node_count),
          "shared-domain tangent constraint has component-wise q dimensions");
    check(std::abs(blocks.scalar_constraint->imag()(1, 0)) > 0.0,
          "shared-domain scalar constraint carries the requested nonzero phase");
    const mfem::ComplexSparseMatrix &scalar_operator = *blocks.scalar_operator;
    for (int row = 0; row < scalar_operator.imag().Height(); ++row) {
        for (int column = 0; column < scalar_operator.imag().Width(); ++column) {
            check(std::abs(scalar_operator.imag()(row, column)) < 1.0e-12,
                  "shared-domain full-field scalar operator has no shifted k block");
        }
    }

    std::vector<fd::TangentFrameNode> x_equilibrium_frames(
        static_cast<std::size_t>(node_count));
    for (auto &frame : x_equilibrium_frames) {
        frame.m[0] = 1.0;
        frame.m[1] = 0.0;
        frame.m[2] = 0.0;
        frame.e1[0] = 0.0;
        frame.e1[1] = 1.0;
        frame.e1[2] = 0.0;
        frame.e2[0] = 0.0;
        frame.e2[1] = 0.0;
        frame.e2[2] = 1.0;
    }
    request.tangent_frames = x_equilibrium_frames.data();
    fd::FloquetAirboxSharedDomainBlockResult x_equilibrium_blocks{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(
            request,
            &x_equilibrium_blocks) == fd::FrequencyDomainStatus::ok,
        "shared-domain Floquet probe accepts transverse y/z directions for +x equilibrium");
    for (std::uint64_t class_id = 0u; class_id < reduced_node_count; ++class_id) {
        check_close(
            x_equilibrium_blocks.uniform_transverse_probe_q_y[2u * class_id],
            1.0,
            "global-y probe maps to the first tangent axis for +x equilibrium");
        check_close(
            x_equilibrium_blocks.uniform_transverse_probe_q_z[2u * class_id + 1u],
            1.0,
            "global-z probe maps to the second tangent axis for +x equilibrium");
    }
    request.tangent_frames = frames.data();

    fd::FloquetAirboxDynamicDemagKProblem schur_request{};
    schur_request.scalar_operator = blocks.scalar_operator.get();
    schur_request.scalar_constraint = blocks.scalar_constraint.get();
    schur_request.tangent_source = blocks.tangent_source.get();
    schur_request.tangent_source_convention = fd::FloquetAirboxTangentSourceConvention::weak_poisson_rhs;
    schur_request.tangent_constraint = blocks.tangent_constraint.get();
    schur_request.k_rad_per_m[0] = 0.5;
    schur_request.pivot_tolerance = 1e-17;
    fd::FloquetAirboxDynamicDemagKResult schur_result{};
    check(
        fd::assemble_floquet_airbox_dynamic_demag_k(schur_request, &schur_result) ==
            fd::FrequencyDomainStatus::ok,
        "shared-domain Floquet blocks feed the phase-aware Schur bridge");
    check(schur_result.reconstruction.pivot_tolerance == schur_request.pivot_tolerance,
          "Schur bridge retains the scalar pivot policy for modal reconstruction");
    const std::size_t q_real_split = static_cast<std::size_t>(4u * reduced_node_count);
    check(schur_result.real_split_row_major.size() == q_real_split * q_real_split,
          "shared-domain Floquet Schur result has the reduced real-split q shape");

    request.boundary_kind = fd::FloquetAirboxBoundaryKind::unknown;
    fd::FloquetAirboxSharedDomainBlockResult missing_boundary_kind{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(request, &missing_boundary_kind) ==
            fd::FrequencyDomainStatus::validation_error,
        "shared-domain Floquet blocks reject a missing boundary descriptor");
    check(
        std::strstr(
            missing_boundary_kind.error_message,
            "boundary kind must be explicit") != nullptr,
        "missing boundary descriptor fails closed before scalar assembly");
    request.boundary_kind = fd::FloquetAirboxBoundaryKind::robin;

    pair.phase_rad = 0.0;
    fd::FloquetAirboxSharedDomainBlockResult invalid_blocks{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(request, &invalid_blocks) ==
            fd::FrequencyDomainStatus::validation_error,
        "shared-domain Floquet block producer rejects phase inconsistent with k dot translation");
    pair.phase_rad = -0.5;

    frames[1].e1[0] = 0.0;
    frames[1].e1[1] = 1.0;
    frames[1].e2[0] = -1.0;
    frames[1].e2[1] = 0.0;
    fd::FloquetAirboxSharedDomainBlockResult rotated_frames{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(request, &rotated_frames) ==
            fd::FrequencyDomainStatus::ok,
        "shared-domain Floquet block producer accepts a rotated tangent basis at a periodic seam");
    if (rotated_frames.tangent_constraint != nullptr) {
        const mfem::ComplexSparseMatrix &constraint = *rotated_frames.tangent_constraint;
        const double cosine = std::cos(0.5);
        const double sine = std::sin(0.5);
        check_close(
            constraint.real()(2, 1), cosine,
            "rotated tangent basis maps the second reduced component into the first full component");
        check_close(
            constraint.imag()(2, 1), -sine,
            "rotated tangent basis retains the negative Floquet phase in the imaginary block");
        check_close(
            constraint.real()(3, 0), -cosine,
            "rotated tangent basis maps the first reduced component into the second full component");
        check_close(
            constraint.imag()(3, 0), sine,
            "rotated tangent basis applies Floquet phase to the signed component map");
    }
    frames[1] = fd::TangentFrameNode{};

    frames[1].m[0] = 0.0;
    frames[1].m[1] = 1.0;
    frames[1].m[2] = 0.0;
    frames[1].e1[0] = 1.0;
    frames[1].e1[1] = 0.0;
    frames[1].e1[2] = 0.0;
    frames[1].e2[0] = 0.0;
    frames[1].e2[1] = 0.0;
    frames[1].e2[2] = -1.0;
    fd::FloquetAirboxSharedDomainBlockResult mismatched_equilibrium{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(request, &mismatched_equilibrium) ==
            fd::FrequencyDomainStatus::validation_error,
        "shared-domain Floquet block producer rejects a physically mismatched seam equilibrium");
    check(
        std::strstr(
            mismatched_equilibrium.error_message,
            "mismatched equilibrium magnetization vectors") != nullptr,
        "mismatched periodic equilibrium reports the physical seam contract");
    frames[1] = fd::TangentFrameNode{};

    request.periodic_pairs = nullptr;
    request.periodic_pair_count = 0u;
    fd::FloquetAirboxSharedDomainBlockResult missing_pairs{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(request, &missing_pairs) ==
            fd::FrequencyDomainStatus::validation_error,
        "shared-domain Floquet block producer rejects nonzero k without translation pairs");
}

void assembles_dirichlet_floquet_blocks_with_periodic_class_elimination()
{
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
    const std::uint64_t node_count = static_cast<std::uint64_t>(scalar_space.GetVSize());
    check(node_count >= 3u, "Dirichlet Floquet fixture has a free node for the class test");

    mfem::Array<int> dirichlet_marker(mesh.bdr_attributes.Max());
    dirichlet_marker = 0;
    check(dirichlet_marker.Size() > 0, "Dirichlet Floquet fixture has a boundary attribute");
    dirichlet_marker[0] = 1;
    mfem::Array<int> marked_true_dofs;
    scalar_space.GetEssentialTrueDofs(dirichlet_marker, marked_true_dofs);
    check(marked_true_dofs.Size() > 0, "Dirichlet fixture marker selects scalar true dofs");

    std::vector<std::uint8_t> is_marked(static_cast<std::size_t>(node_count), 0u);
    for (int index = 0; index < marked_true_dofs.Size(); ++index) {
        const int dof = marked_true_dofs[index];
        check(dof >= 0 && static_cast<std::uint64_t>(dof) < node_count,
              "Dirichlet fixture true dof is in the scalar space");
        is_marked[static_cast<std::size_t>(dof)] = 1u;
    }
    const std::uint64_t marked_node = static_cast<std::uint64_t>(marked_true_dofs[0]);
    std::uint64_t unmarked_node = node_count;
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        if (is_marked[static_cast<std::size_t>(node)] == 0u) {
            unmarked_node = node;
            break;
        }
    }
    check(unmarked_node < node_count,
          "Dirichlet fixture has an unmarked node for periodic class expansion");

    std::vector<fd::TangentFrameNode> frames(static_cast<std::size_t>(node_count));
    std::vector<std::uint8_t> magnetic_mask(static_cast<std::size_t>(mesh.GetNE()), 1u);
    std::vector<double> saturation_magnetization(static_cast<std::size_t>(node_count), 1.0);
    std::vector<std::uint32_t> scalar_classes(static_cast<std::size_t>(node_count));
    std::vector<std::uint32_t> magnetic_classes(static_cast<std::size_t>(node_count));
    scalar_classes[static_cast<std::size_t>(marked_node)] = 0u;
    scalar_classes[static_cast<std::size_t>(unmarked_node)] = 0u;
    std::uint32_t next_class = 1u;
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        if (node == marked_node || node == unmarked_node) {
            continue;
        }
        scalar_classes[static_cast<std::size_t>(node)] = next_class++;
    }
    magnetic_classes = scalar_classes;
    const std::uint64_t reduced_node_count = static_cast<std::uint64_t>(next_class);
    check(reduced_node_count == node_count - 1u,
          "Dirichlet fixture has one reduced class for the periodic pair");

    fd::FrequencyDomainFloquetPeriodicPair pair{};
    pair.node_a = marked_node;
    pair.node_b = unmarked_node;
    pair.has_translation = true;
    pair.translation_m[0] = 1.0;
    pair.has_phase = true;
    pair.phase_rad = -0.5;

    fd::FloquetAirboxSharedDomainBlockRequest request{};
    request.scalar_space = &scalar_space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = node_count;
    request.magnetic_element_mask = magnetic_mask.data();
    request.magnetic_element_count = magnetic_mask.size();
    request.saturation_magnetization_a_per_m = saturation_magnetization.data();
    request.saturation_magnetization_count = saturation_magnetization.size();
    request.scalar_reduced_node = scalar_classes.data();
    request.scalar_reduced_node_count = reduced_node_count;
    request.magnetic_reduced_node = magnetic_classes.data();
    request.magnetic_reduced_node_count = reduced_node_count;
    request.periodic_pairs = &pair;
    request.periodic_pair_count = 1u;
    request.k_rad_per_m[0] = 0.5;
    request.boundary_kind = fd::FloquetAirboxBoundaryKind::dirichlet;
    request.robin_boundary_marker = &dirichlet_marker;

    fd::FloquetAirboxSharedDomainBlockResult blocks{};
    check(
        fd::assemble_floquet_airbox_shared_domain_blocks(request, &blocks) ==
            fd::FrequencyDomainStatus::ok,
        "shared-domain Floquet blocks assemble with Dirichlet elimination");
    check(blocks.scalar_operator != nullptr && blocks.tangent_source != nullptr,
          "Dirichlet Floquet assembly returns scalar and source blocks");

    const mfem::ComplexSparseMatrix &scalar_operator = *blocks.scalar_operator;
    const mfem::ComplexSparseMatrix &tangent_source = *blocks.tangent_source;
    const auto check_eliminated = [&](std::uint64_t node, const char *message) {
        const int row = static_cast<int>(node);
        check(std::abs(scalar_operator.real()(row, row) - 1.0) < 1.0e-12,
              message);
        check(std::abs(scalar_operator.imag()(row, row)) < 1.0e-12,
              "Dirichlet scalar identity has no imaginary diagonal");
        for (int column = 0; column < static_cast<int>(node_count); ++column) {
            if (column == row) {
                continue;
            }
            check(std::abs(scalar_operator.real()(row, column)) < 1.0e-12,
                  "Dirichlet scalar row is eliminated");
            check(std::abs(scalar_operator.real()(column, row)) < 1.0e-12,
                  "Dirichlet scalar column is eliminated");
            check(std::abs(scalar_operator.imag()(row, column)) < 1.0e-12,
                  "Dirichlet scalar imaginary row is eliminated");
            check(std::abs(scalar_operator.imag()(column, row)) < 1.0e-12,
                  "Dirichlet scalar imaginary column is eliminated");
        }
        for (int column = 0; column < tangent_source.real().Width(); ++column) {
            check(std::abs(tangent_source.real()(row, column)) < 1.0e-12,
                  "Dirichlet tangent source row is eliminated");
            check(std::abs(tangent_source.imag()(row, column)) < 1.0e-12,
                  "Dirichlet tangent source imaginary row is eliminated");
        }
    };

    check_eliminated(marked_node, "marked Dirichlet scalar dof is eliminated");
    check_eliminated(
        unmarked_node,
        "periodic partner in a Dirichlet class is eliminated as well");
}

#endif

} // namespace

int main()
{
#if FULLMAG_HAS_MFEM_STACK
    reduces_phase_constrained_airbox_blocks_before_schur_elimination();
    applies_the_magnetic_floquet_constraint_before_schur_elimination();
    raw_rhs_and_descriptor_reconstruct_the_same_physical_potential();
    assembles_shared_domain_floquet_blocks_with_one_phase_graph();
    assembles_dirichlet_floquet_blocks_with_periodic_class_elimination();
    rejects_missing_floquet_airbox_blocks_without_fallback();
#endif
    return 0;
}
