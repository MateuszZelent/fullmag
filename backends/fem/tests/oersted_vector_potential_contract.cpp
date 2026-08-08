#include "cpu/mfem/interactions/oersted/vector_potential.hpp"

#include "cpu/mfem/transport/conservative_current_view.hpp"
#include "cpu/mfem/transport/periodic_charge_potential.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using fullmag::fem::oersted::VectorPotentialOptions;
using fullmag::fem::oersted::VectorPotentialSolver;
using fullmag::fem::transport::ClosedGeometryCurrentClosure;
using fullmag::fem::transport::ConservativeCurrentBoundaryFace;
using fullmag::fem::transport::ConservativeCurrentBoundaryRole;
using fullmag::fem::transport::ConservativeCurrentBuildRequest;
using fullmag::fem::transport::ConservativeCurrentIdentityInput;
using fullmag::fem::transport::ConservativeCurrentPins;
using fullmag::fem::transport::ConservativeCurrentView;
using fullmag::fem::transport::PeriodicChargePotentialSolveRequest;
using fullmag::fem::transport::PeriodicCurrentSourceCut;
using fullmag::fem::transport::PeriodicCurrentSourceCutFacePair;
using fullmag::fem::transport::StableMeshVertexIdentities;

void require(bool condition, const std::string &message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
}

std::vector<int> boundary_elements_on_x(
    const mfem::Mesh &mesh,
    double x)
{
    std::vector<int> result;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        bool matches = true;
        for (int index = 0; index < vertices.Size(); ++index) {
            matches = matches &&
                std::abs(mesh.GetVertex(vertices[index])[0] - x) < 1.0e-12;
        }
        if (matches) {
            result.push_back(boundary);
        }
    }
    return result;
}

std::array<std::uint64_t, 3> face_key(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    int boundary)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary, vertices);
    require(vertices.Size() == 3, "OE-F2 fixture requires triangular boundary faces");
    std::array<std::uint64_t, 3> key{
        ids.local_to_stable.at(vertices[0]),
        ids.local_to_stable.at(vertices[1]),
        ids.local_to_stable.at(vertices[2])};
    std::sort(key.begin(), key.end());
    return key;
}

ConservativeCurrentView::Ptr make_uniform_current_view(mfem::Mesh &mesh)
{
    StableMeshVertexIdentities ids;
    ids.version = "stable_mesh_vertex_u64.v1";
    ids.local_to_stable.resize(mesh.GetNV());
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        ids.local_to_stable[vertex] = 1000u +
            static_cast<std::uint64_t>(vertex);
    }

    const auto minus = boundary_elements_on_x(mesh, 0.0);
    const auto plus_boundaries = boundary_elements_on_x(mesh, 1.0);
    auto plus = plus_boundaries;
    require(minus.size() == plus.size() && !minus.empty(),
        "OE-F2 fixture has no paired source-cut faces");

    PeriodicCurrentSourceCut cut;
    cut.id = "x-periodic-voltage-cut";
    cut.translation_m = {1.0, 0.0, 0.0};
    cut.potential_drop_v = -1.0;
    std::reverse(plus.begin(), plus.end());
    for (const int minus_boundary : minus) {
        mfem::Array<int> minus_vertices;
        mesh.GetBdrElementVertices(minus_boundary, minus_vertices);
        double y = 0.0;
        double z = 0.0;
        for (int index = 0; index < minus_vertices.Size(); ++index) {
            y += mesh.GetVertex(minus_vertices[index])[1];
            z += mesh.GetVertex(minus_vertices[index])[2];
        }
        y /= minus_vertices.Size();
        z /= minus_vertices.Size();
        const auto match = std::find_if(plus.begin(), plus.end(),
            [&](int plus_boundary) {
                mfem::Array<int> plus_vertices;
                mesh.GetBdrElementVertices(plus_boundary, plus_vertices);
                double plus_y = 0.0;
                double plus_z = 0.0;
                for (int index = 0; index < plus_vertices.Size(); ++index) {
                    plus_y += mesh.GetVertex(plus_vertices[index])[1];
                    plus_z += mesh.GetVertex(plus_vertices[index])[2];
                }
                plus_y /= plus_vertices.Size();
                plus_z /= plus_vertices.Size();
                return std::abs(plus_y - y) < 1.0e-12 &&
                    std::abs(plus_z - z) < 1.0e-12;
            });
        require(match != plus.end(),
            "OE-F2 fixture source-cut face pairing is not geometric");
        PeriodicCurrentSourceCutFacePair pair;
        pair.minus_face_vertex_ids = face_key(mesh, ids, minus_boundary);
        pair.plus_face_vertex_ids = face_key(mesh, ids, *match);
        cut.face_pairs.push_back(pair);
        plus.erase(match);
    }

    std::vector<ConservativeCurrentBoundaryFace> boundary_faces;
    boundary_faces.reserve(mesh.GetNBE());
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        ConservativeCurrentBoundaryFace face;
        face.boundary_element = boundary;
        const bool is_source_cut =
            std::find(minus.begin(), minus.end(), boundary) != minus.end() ||
            std::find(plus_boundaries.begin(), plus_boundaries.end(), boundary) !=
                plus_boundaries.end();
        face.role = is_source_cut
            ? ConservativeCurrentBoundaryRole::SourceCut
            : ConservativeCurrentBoundaryRole::InsulatingOuter;
        if (is_source_cut) {
            face.circuit_id = cut.id;
        }
        boundary_faces.push_back(std::move(face));
    }

    mfem::ConstantCoefficient conductivity(4.0);
    ClosedGeometryCurrentClosure closure;
    closure.operator_version = "fem_closed_current_geometry.v1";
    closure.revision = "closure-r1";
    closure.digest = "closure-digest-r1";
    closure.source_cuts.push_back(cut);

    ConservativeCurrentIdentityInput identity;
    identity.source_module_id = "oe-f2-test-current";
    identity.source_state_revision = "source-r1";
    identity.source_field_digest = "field-r1";
    identity.mesh_revision = "mesh-r1";
    identity.topology_revision = "topology-r1";
    identity.geometry_digest = "geometry-r1";
    identity.envelope_revision = "envelope-r1";
    identity.envelope_digest = "envelope-digest-r1";
    identity.evaluated_envelope_multiplier = 1.0;
    identity.evaluation_time_s = 0.0;
    identity.stage_identity = 1;

    PeriodicChargePotentialSolveRequest potential_request;
    potential_request.mesh = &mesh;
    potential_request.conductivity = &conductivity;
    potential_request.stable_vertex_identities = ids;
    potential_request.boundary_faces = boundary_faces;
    potential_request.source_cut = cut;
    potential_request.operator_version = "fem_charge_h1_periodic_jump.v1";
    potential_request.source_module_id = identity.source_module_id;
    potential_request.source_state_revision = identity.source_state_revision;
    potential_request.source_field_digest = identity.source_field_digest;
    potential_request.evaluation_time_s = identity.evaluation_time_s;
    potential_request.stage_identity = identity.stage_identity;
    potential_request.envelope_revision = identity.envelope_revision;
    potential_request.envelope_digest = identity.envelope_digest;
    potential_request.evaluated_envelope_multiplier = 1.0;
    potential_request.mesh_revision = identity.mesh_revision;
    potential_request.geometry_digest = identity.geometry_digest;
    potential_request.conductivity_digest = "conductivity-r1";
    potential_request.source_cut_digest = closure.digest;
    potential_request.algebraic_relative_tolerance = 1.0e-12;
    potential_request.maximum_iterations = 1000;

    ConservativeCurrentBuildRequest request;
    request.mesh = &mesh;
    request.conductivity = &conductivity;
    request.stable_vertex_identities = std::move(ids);
    request.boundary_faces = std::move(boundary_faces);
    request.closure = std::move(closure);
    request.periodic_charge_potential =
        fullmag::fem::transport::PeriodicChargePotentialSolver::Solve(
            potential_request);
    request.identity = identity;
    request.pins.required_source_state_revision = identity.source_state_revision;
    request.pins.required_source_field_digest = identity.source_field_digest;
    request.pins.required_mesh_revision = identity.mesh_revision;
    request.pins.required_topology_revision = identity.topology_revision;
    request.algebraic_relative_tolerance = 1.0e-12;
    request.physical_relative_gate = 1.0e-10;
    request.physical_absolute_gate_a = 1.0e-18;
    return ConservativeCurrentView::Build(request);
}

void vector_potential_exact_sequence_contract()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    const auto current = make_uniform_current_view(mesh);
    VectorPotentialOptions options;
    options.relative_tolerance = 1.0e-9;
    const auto result = VectorPotentialSolver::Evaluate(*current, options);

    require(result.operator_version == VectorPotentialSolver::operator_version,
        "OE-F2 operator version is not frozen");
    require(result.boundary_gauge_variant == "tangential_A_h1_0.v1",
        "OE-F2 did not use the baseline H_0(curl) x H^1_0 gauge");
    require(result.source_view_identity_digest ==
            current->identity().view_identity_digest,
        "OE-F2 lost the source-view identity digest");
    require(result.diagnostics.nd_dofs > 0 && result.diagnostics.h1_dofs > 0,
        "OE-F2 assembled an empty exact-sequence space");
    require(result.diagnostics.essential_nd_dof_count > 0 &&
            result.diagnostics.essential_h1_dof_count > 0,
        "OE-F2 did not mark the outer tangential/scalar boundary DOFs");
    require(result.diagnostics.harmonic_count == 0,
        "OE-F2 cube fixture reported a harmonic mode");
    require(result.diagnostics.first_block_residual < 1.0e-7 &&
            result.diagnostics.constraint_residual < 1.0e-7 &&
            result.diagnostics.compatible_divergence_residual < 1.0e-7,
        "OE-F2 residual certificate is outside the fixture tolerance");
    require(result.compatible_b_dofs_t.size() ==
            result.compatible_h_dofs_apm.size() &&
            !result.compatible_b_dofs_t.empty(),
        "OE-F2 did not publish compatible RT0 B/H fields");

    // Independent target-space/energy gate. Do not infer the scalar gauge
    // boundary condition from the mixed residual: reconstruct the returned
    // H1 field and inspect the boundary true DOFs directly.
    mfem::H1_FECollection h1_fec(1, 3);
    mfem::FiniteElementSpace h1_space(&mesh, &h1_fec);
    require(static_cast<int>(result.gauge_dofs_apm.size()) ==
            h1_space.GetVSize(),
        "OE-F2 gauge payload does not match the H1 target space");
    mfem::GridFunction gauge(&h1_space);
    std::copy(result.gauge_dofs_apm.begin(), result.gauge_dofs_apm.end(),
        gauge.GetData());
    mfem::Array<int> boundary_true_dofs;
    h1_space.GetBoundaryTrueDofs(boundary_true_dofs);
    double maximum_boundary_gauge = 0.0;
    for (int index = 0; index < boundary_true_dofs.Size(); ++index) {
        maximum_boundary_gauge = std::max(maximum_boundary_gauge,
            std::abs(gauge[boundary_true_dofs[index]]));
    }
    require(std::isfinite(maximum_boundary_gauge) &&
            maximum_boundary_gauge <= 1.0e-12,
        "OE-F2 H1_0 target-space gauge is nonzero on the boundary");

    // The source-potential pairing is a separate energy diagnostic. It is not
    // the LLG Zeeman/work observable; it checks the positive quadratic form
    // of the linear magnetostatic source solve without reusing solver
    // residuals or the returned diagnostic norm.
    mfem::ND_FECollection nd_fec(1, 3);
    mfem::FiniteElementSpace nd_space(&mesh, &nd_fec);
    require(static_cast<int>(result.a_dofs_t_m.size()) == nd_space.GetVSize(),
        "OE-F2 vector-potential payload does not match the ND target space");
    mfem::GridFunction vector_potential(&nd_space);
    std::copy(result.a_dofs_t_m.begin(), result.a_dofs_t_m.end(),
        vector_potential.GetData());
    const mfem::IntegrationRule &rule = mfem::IntRules.Get(
        mfem::Geometry::TETRAHEDRON, 4);
    double source_potential_pairing = 0.0;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        auto *transformation = mesh.GetElementTransformation(element);
        mfem::Vector source_value(3);
        mfem::Vector potential_value(3);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            const auto &integration_point = rule.IntPoint(point);
            transformation->SetIntPoint(&integration_point);
            current->field().GetVectorValue(
                *transformation, integration_point, source_value);
            vector_potential.GetVectorValue(
                *transformation, integration_point, potential_value);
            const double integrand = source_value * potential_value;
            require(std::isfinite(integrand),
                "OE-F2 source-potential integrand is non-finite");
            source_potential_pairing += 0.5 * integrand *
                transformation->Weight() * integration_point.weight;
        }
    }
    require(std::isfinite(source_potential_pairing) &&
            source_potential_pairing > 0.0,
        "OE-F2 source-potential energy diagnostic is not finite and positive");
    std::cout << std::setprecision(17)
              << "OE-F2 target-space max boundary |p|="
              << maximum_boundary_gauge
              << " source-potential energy W_J="
              << source_potential_pairing << "\n";

    VectorPotentialOptions unsupported = options;
    unsupported.boundary_gauge_variant = "natural_curl_zero_mean_h1.v1";
    bool rejected = false;
    try {
        (void)VectorPotentialSolver::Evaluate(*current, unsupported);
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected,
        "OE-F2 silently substituted the unimplemented zero-mean gauge variant");
}

} // namespace

int main()
{
    try {
        vector_potential_exact_sequence_contract();
        std::cout << "fem mixed vector-potential Oersted contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem mixed vector-potential Oersted contract: FAIL: "
                  << error.what() << '\n';
        return 1;
    }
}
