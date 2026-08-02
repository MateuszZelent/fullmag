#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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

double matrix_value(const fd::PoissonAirboxSharedDomainCsrMatrix &matrix,
                    std::uint64_t row,
                    std::uint64_t column)
{
    check(row < matrix.row_count && column < matrix.column_count,
          "matrix lookup is in range");
    for (std::uint32_t entry = matrix.row_offsets[static_cast<std::size_t>(row)];
         entry < matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
         ++entry) {
        if (matrix.column_indices[entry] == column) {
            return matrix.values[entry];
        }
    }
    return 0.0;
}

} // namespace

int main()
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

    const std::uint64_t node_count = static_cast<std::uint64_t>(scalar_space.GetVSize());
    check(node_count > 0, "manufactured mesh has scalar P1 nodes");
    std::vector<fd::TangentFrameNode> frames(static_cast<std::size_t>(node_count));
    for (fd::TangentFrameNode &frame : frames) {
        frame.m[0] = 0.0;
        frame.m[1] = 0.0;
        frame.m[2] = 1.0;
        frame.e1[0] = 1.0;
        frame.e1[1] = 0.0;
        frame.e1[2] = 0.0;
        frame.e2[0] = 0.0;
        frame.e2[1] = 1.0;
        frame.e2[2] = 0.0;
    }
    std::vector<std::uint8_t> magnetic_elements(
        static_cast<std::size_t>(mesh.GetNE()), 1u);
    std::vector<std::uint32_t> scalar_classes(static_cast<std::size_t>(node_count));
    std::vector<std::uint32_t> magnetic_classes(static_cast<std::size_t>(node_count));
    for (std::uint32_t node = 0; node < node_count; ++node) {
        scalar_classes[node] = node;
        magnetic_classes[node] = node;
    }

    const std::uint64_t q_count = 2u * node_count;
    std::vector<std::uint32_t> zero_row_offsets(static_cast<std::size_t>(q_count + 1u), 0u);
    fd::CsrMatrixView zero_a_qq{
        q_count,
        q_count,
        zero_row_offsets.data(),
        zero_row_offsets.size(),
        nullptr,
        0,
        nullptr,
        0};
    mfem::Array<int> boundary_marker(mesh.bdr_attributes.Max());
    boundary_marker = 1;

    fd::PoissonAirboxSharedDomainAssemblyRequest request{};
    request.scalar_space = &scalar_space;
    request.tangent_frames = frames.data();
    request.tangent_frame_count = node_count;
    request.magnetic_element_mask = magnetic_elements.data();
    request.magnetic_element_count = magnetic_elements.size();
    request.uniform_saturation_magnetization_a_per_m = 2.0;
    request.gamma0_m_per_a_s = 3.0;
    request.mu0_T_m_A = 4.0;
    request.magnetic_a_qq_csr = &zero_a_qq;
    request.scalar_reduced_node = scalar_classes.data();
    request.scalar_reduced_node_count = node_count;
    request.magnetic_reduced_node = magnetic_classes.data();
    request.magnetic_reduced_node_count = node_count;
    request.equivalence_classes_complete = true;
    request.boundary_kind = fd::PoissonAirboxBoundaryKind::robin;
    request.robin_beta = 1.0;
    request.robin_boundary_marker = &boundary_marker;

    fd::PoissonAirboxSharedDomainAssemblyResult result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(request, &result) ==
            fd::FrequencyDomainStatus::ok,
        result.error_message);
    check(result.q_dof_count == q_count, "shared-domain q count is canonical");
    check(result.phi_dof_count == node_count, "shared-domain phi count is canonical");
    check(result.p.row_count == node_count && result.p.column_count == node_count,
          "shared-domain P has scalar dimensions");
    check(result.p.values.size() > 0, "shared-domain P has assembled entries");
    check(matrix_value(result.p, 0, 0) > 0.0, "Robin P has positive diagonal");
    check(result.a_phiq.values.size() > 0, "shared-domain scalar coupling is nonzero");
    check(result.a_qphi.values.size() > 0, "shared-domain tangent feedback is nonzero");
    check(result.b_qq.values.size() > 0, "shared-domain gyrotropic mass is nonzero");
    check(std::abs(matrix_value(result.b_qq, 0, 1) +
                   matrix_value(result.b_qq, 1, 0)) < 1.0e-12,
          "B_qq is skew-symmetric for alpha-zero energy-Hessian form");
    check(result.operator_digest[0] != '\0', "shared-domain assembly publishes digest");

    fd::PoissonAirboxSharedDomainAssemblyRequest pure_neumann = request;
    pure_neumann.boundary_kind = fd::PoissonAirboxBoundaryKind::pure_neumann;
    pure_neumann.robin_beta = 0.0;
    pure_neumann.robin_boundary_marker = nullptr;
    fd::PoissonAirboxSharedDomainAssemblyResult pure_neumann_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(pure_neumann, &pure_neumann_result) ==
            fd::FrequencyDomainStatus::ok,
        pure_neumann_result.error_message);
    check(pure_neumann_result.phi_mean_weights.size() == node_count,
          "pure-Neumann assembly publishes one mean weight per scalar class");
    double mean_weight_sum = 0.0;
    for (double value : pure_neumann_result.phi_mean_weights) {
        check(std::isfinite(value) && value > 0.0,
              "pure-Neumann mean weights are finite and positive");
        mean_weight_sum += value;
    }
    check(std::abs(mean_weight_sum - 1.0) <= 1.0e-12,
          "pure-Neumann gauge vector is normalized to unit measure");
    check(std::strcmp(pure_neumann_result.gauge_policy, "mean_zero_augmented") == 0,
          "pure-Neumann assembly publishes the mean-zero gauge policy");

    fd::PoissonAirboxSharedDomainAssemblyRequest dirichlet = request;
    dirichlet.boundary_kind = fd::PoissonAirboxBoundaryKind::dirichlet;
    dirichlet.robin_beta = 0.0;
    fd::PoissonAirboxSharedDomainAssemblyResult dirichlet_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(dirichlet, &dirichlet_result) ==
            fd::FrequencyDomainStatus::ok,
        dirichlet_result.error_message);
    check(!dirichlet_result.dirichlet_dofs.empty(),
          "Dirichlet assembly publishes reduced essential DOFs");
    check(std::strcmp(dirichlet_result.gauge_policy, "none") == 0,
          "Dirichlet assembly does not publish a gauge constraint");
    for (std::uint64_t row = 0; row < dirichlet_result.a_phiq.row_count; ++row) {
        for (std::uint32_t entry =
                 dirichlet_result.a_phiq.row_offsets[static_cast<std::size_t>(row)];
             entry < dirichlet_result.a_phiq.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            check(std::find(
                      dirichlet_result.dirichlet_dofs.begin(),
                      dirichlet_result.dirichlet_dofs.end(),
                      static_cast<std::uint32_t>(row)) ==
                      dirichlet_result.dirichlet_dofs.end(),
                  "Dirichlet A_phiq rows must exclude essential potential DOFs");
        }
    }
    for (std::uint64_t row = 0; row < dirichlet_result.a_qphi.row_count; ++row) {
        for (std::uint32_t entry =
                 dirichlet_result.a_qphi.row_offsets[static_cast<std::size_t>(row)];
             entry < dirichlet_result.a_qphi.row_offsets[static_cast<std::size_t>(row + 1u)];
             ++entry) {
            check(std::find(
                      dirichlet_result.dirichlet_dofs.begin(),
                      dirichlet_result.dirichlet_dofs.end(),
                      dirichlet_result.a_qphi.column_indices[entry]) ==
                      dirichlet_result.dirichlet_dofs.end(),
                  "Dirichlet A_qphi columns must exclude essential potential DOFs");
        }
    }

    std::vector<std::uint32_t> reduced_scalar_classes(static_cast<std::size_t>(node_count));
    std::vector<std::uint32_t> reduced_magnetic_classes(static_cast<std::size_t>(node_count));
    for (std::uint32_t node = 0; node < node_count; ++node) {
        reduced_scalar_classes[node] = node % 2u;
        reduced_magnetic_classes[node] = node % 2u;
    }
    fd::PoissonAirboxSharedDomainAssemblyRequest reduced = pure_neumann;
    reduced.scalar_reduced_node = reduced_scalar_classes.data();
    reduced.scalar_reduced_node_count = 2;
    reduced.magnetic_reduced_node = reduced_magnetic_classes.data();
    reduced.magnetic_reduced_node_count = 2;
    fd::PoissonAirboxSharedDomainAssemblyResult reduced_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain(reduced, &reduced_result) ==
            fd::FrequencyDomainStatus::ok,
        reduced_result.error_message);
    check(reduced_result.phi_dof_count == 2 && reduced_result.q_dof_count == 4,
          "complete equivalence classes reduce scalar and tangent dimensions");
    check(reduced_result.p.row_count == 2 && reduced_result.p.column_count == 2,
          "reduced P has class dimensions");
    check(reduced_result.phi_mean_weights.size() == 2,
          "reduced pure-Neumann gauge vector follows scalar classes");

    fd::PoissonAirboxSharedDomainAssemblyRequest incomplete = request;
    incomplete.equivalence_classes_complete = false;
    fd::PoissonAirboxSharedDomainAssemblyResult rejected{};
    check(
        fd::assemble_poisson_airbox_shared_domain(incomplete, &rejected) ==
            fd::FrequencyDomainStatus::validation_error,
        "shared-domain assembly rejects incomplete equivalence classes");

    const std::vector<double> payload_nodes = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0};
    const std::vector<std::uint32_t> payload_cell_types = {FULLMAG_FEM_CELL_TET4};
    const std::vector<std::uint32_t> payload_cell_offsets = {0u, 4u};
    const std::vector<std::uint32_t> payload_cell_nodes = {0u, 1u, 2u, 3u};
    const std::vector<std::uint64_t> payload_cell_ordinals = {0u};
    const std::vector<std::uint32_t> payload_cell_markers = {1u};
    const std::vector<std::uint32_t> payload_facet_types(4u, FULLMAG_FEM_FACET_TRI3);
    const std::vector<std::uint32_t> payload_facet_roles(
        4u, FULLMAG_FEM_FACET_ROLE_EXTERIOR);
    const std::vector<std::uint32_t> payload_facet_offsets = {0u, 3u, 6u, 9u, 12u};
    const std::vector<std::uint32_t> payload_facet_nodes = {
        1u, 2u, 3u,
        0u, 3u, 2u,
        0u, 1u, 3u,
        0u, 2u, 1u};
    const std::vector<std::uint64_t> payload_facet_ordinals = {0u, 1u, 2u, 3u};
    const std::vector<std::uint32_t> payload_facet_markers(4u, 1u);
    const fullmag_fem_mesh_desc payload_mesh{
        FULLMAG_FEM_MESH_DESC_ABI_VERSION,
        sizeof(fullmag_fem_mesh_desc),
        payload_nodes.data(), payload_nodes.size(),
        payload_cell_types.data(), payload_cell_types.size(),
        payload_cell_offsets.data(), payload_cell_offsets.size(),
        payload_cell_nodes.data(), payload_cell_nodes.size(),
        payload_cell_ordinals.data(), payload_cell_ordinals.size(),
        payload_cell_markers.data(), payload_cell_markers.size(),
        payload_facet_types.data(), payload_facet_types.size(),
        payload_facet_roles.data(), payload_facet_roles.size(),
        payload_facet_offsets.data(), payload_facet_offsets.size(),
        payload_facet_nodes.data(), payload_facet_nodes.size(),
        payload_facet_ordinals.data(), payload_facet_ordinals.size(),
        payload_facet_markers.data(), payload_facet_markers.size(),
        nullptr, 0u,
        nullptr, 0u};
    const std::vector<double> payload_equilibrium = {
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0};
    const std::vector<std::uint32_t> payload_scalar_classes = {0u, 1u, 2u, 3u};
    const std::vector<std::uint32_t> payload_magnetic_classes = {0u, 1u, 2u, 3u};
    const std::vector<std::uint32_t> payload_a_qq_offsets(9u, 0u);
    const char *payload_boundary = "robin";
    const char *payload_digest = "sha256:payload-test";
    FullmagFemModalSharedDomainPayload payload{};
    payload.abi_version = FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION;
    payload.struct_size = sizeof(FullmagFemModalSharedDomainPayload);
    payload.mesh = &payload_mesh;
    payload.equilibrium_m0_xyz = payload_equilibrium.data();
    payload.equilibrium_m0_xyz_count = payload_equilibrium.size();
    payload.uniform_saturation_magnetisation_a_per_m = 2.0;
    payload.gamma0_m_per_a_s = 3.0;
    payload.magnetic_a_qq_csr = FullmagFemCsrMatrixView{
        8u, 8u, payload_a_qq_offsets.data(), payload_a_qq_offsets.size(),
        nullptr, 0u, nullptr, 0u};
    payload.scalar_reduced_node = payload_scalar_classes.data();
    payload.scalar_reduced_node_count = payload_scalar_classes.size();
    payload.magnetic_reduced_node = payload_magnetic_classes.data();
    payload.magnetic_reduced_node_count = payload_magnetic_classes.size();
    payload.magnetic_pair_count = 1u;
    payload.airbox_pair_count = 1u;
    payload.boundary_kind = payload_boundary;
    payload.robin_beta = 1.0;
    payload.boundary_marker = 1u;
    payload.equilibrium_digest = payload_digest;
    payload.mesh_certificate_digest = payload_digest;
    payload.mesh_certificate_schema = "periodic_mesh_certificate.v6";
    fd::PoissonAirboxSharedDomainAssemblyResult payload_result{};
    check(
        fd::assemble_poisson_airbox_shared_domain_payload(payload, &payload_result) ==
            fd::FrequencyDomainStatus::ok,
        payload_result.error_message);
    check(std::strcmp(payload_result.assembly_kind, "mfem_weak_form_shared_domain") == 0,
          "public shared-domain payload import preserves production assembly kind");
    check(payload_result.operator_digest[0] != '\0',
          "public shared-domain payload import publishes an operator digest");
#endif
    return 0;
}
