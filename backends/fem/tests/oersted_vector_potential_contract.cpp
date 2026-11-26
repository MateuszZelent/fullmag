#include "cpu/mfem/interactions/oersted/vector_potential.hpp"

#include "cpu/mfem/transport/conservative_current_view.hpp"
#include "cpu/mfem/transport/periodic_charge_potential.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(MFEM_USE_MPI) && \
    !(defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI) && \
    defined(__unix__)
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

using fullmag::fem::multiphysics::SparseCpuBackendPolicy;
using fullmag::fem::multiphysics::SparseExecutionTarget;
using fullmag::fem::multiphysics::compute_saddle_point_equilibration_beta;
using fullmag::fem::oersted::VectorPotentialOptions;
using fullmag::fem::oersted::VectorPotentialResult;
using fullmag::fem::oersted::VectorPotentialSolver;
using fullmag::fem::transport::ClosedGeometryCurrentClosure;
using fullmag::fem::transport::ConservativeCurrentBoundaryFace;
using fullmag::fem::transport::ConservativeCurrentBoundaryRole;
using fullmag::fem::transport::ConservativeCurrentBuildRequest;
using fullmag::fem::transport::ConservativeCurrentIdentityInput;
using fullmag::fem::transport::ConservativeCurrentImportRequest;
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

bool can_test_hypre_backend() noexcept
{
#if defined(MFEM_USE_MPI) && \
    !(defined(FULLMAG_OET0_DISABLE_MPI) && FULLMAG_OET0_DISABLE_MPI)
#if defined(__unix__)
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        ::close(fd);
        return true;
    }
    return false;
#else
    return true;
#endif
#else
    return false;
#endif
}

std::vector<int> boundary_elements_on_x(
    const mfem::Mesh &mesh,
    double x,
    double tolerance)
{
    std::vector<int> result;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        bool matches = true;
        for (int index = 0; index < vertices.Size(); ++index) {
            matches = matches &&
                std::abs(mesh.GetVertex(vertices[index])[0] - x) < tolerance;
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

struct PeriodicCubeTopology {
    StableMeshVertexIdentities ids;
    PeriodicCurrentSourceCut cut;
    std::vector<ConservativeCurrentBoundaryFace> boundary_faces;
    ClosedGeometryCurrentClosure closure;
    ConservativeCurrentIdentityInput identity;
};

PeriodicCubeTopology make_periodic_cube_topology(
    const mfem::Mesh &mesh,
    double length_x)
{
    PeriodicCubeTopology topo;
    topo.ids.version = "stable_mesh_vertex_u64.v1";
    topo.ids.local_to_stable.resize(static_cast<std::size_t>(mesh.GetNV()));
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        topo.ids.local_to_stable[static_cast<std::size_t>(vertex)] =
            1000u + static_cast<std::uint64_t>(vertex);
    }

    const double coord_tol = 1.0e-11 * length_x;
    const auto minus = boundary_elements_on_x(mesh, 0.0, coord_tol);
    const auto plus_boundaries = boundary_elements_on_x(mesh, length_x, coord_tol);
    auto plus = plus_boundaries;
    require(minus.size() == plus.size() && !minus.empty(),
        "OE-F2 fixture has no paired source-cut faces");

    topo.cut.id = "x-periodic-voltage-cut";
    topo.cut.translation_m = {length_x, 0.0, 0.0};
    topo.cut.potential_drop_v = -1.0;
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
                return std::abs(plus_y - y) < coord_tol &&
                    std::abs(plus_z - z) < coord_tol;
            });
        require(match != plus.end(),
            "OE-F2 fixture source-cut face pairing is not geometric");
        PeriodicCurrentSourceCutFacePair pair;
        pair.minus_face_vertex_ids = face_key(mesh, topo.ids, minus_boundary);
        pair.plus_face_vertex_ids = face_key(mesh, topo.ids, *match);
        topo.cut.face_pairs.push_back(pair);
        plus.erase(match);
    }

    topo.boundary_faces.reserve(static_cast<std::size_t>(mesh.GetNBE()));
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
            face.circuit_id = topo.cut.id;
        }
        topo.boundary_faces.push_back(std::move(face));
    }

    topo.closure.operator_version = "fem_closed_current_geometry.v1";
    topo.closure.revision = "closure-r1";
    topo.closure.digest = "closure-digest-r1";
    topo.closure.source_cuts.push_back(topo.cut);

    topo.identity.source_module_id = "oe-f2-test-current";
    topo.identity.source_state_revision = "source-r1";
    topo.identity.source_field_digest = "field-r1";
    topo.identity.mesh_revision = "mesh-r1";
    topo.identity.topology_revision = "topology-r1";
    topo.identity.geometry_digest = "geometry-r1";
    topo.identity.envelope_revision = "envelope-r1";
    topo.identity.envelope_digest = "envelope-digest-r1";
    topo.identity.evaluated_envelope_multiplier = 1.0;
    topo.identity.evaluation_time_s = 0.0;
    topo.identity.stage_identity = 1;
    return topo;
}

ConservativeCurrentView::Ptr make_uniform_current_view(mfem::Mesh &mesh)
{
    auto topo = make_periodic_cube_topology(mesh, 1.0);
    mfem::ConstantCoefficient conductivity(4.0);

    PeriodicChargePotentialSolveRequest potential_request;
    potential_request.mesh = &mesh;
    potential_request.conductivity = &conductivity;
    potential_request.stable_vertex_identities = topo.ids;
    potential_request.boundary_faces = topo.boundary_faces;
    potential_request.source_cut = topo.cut;
    potential_request.operator_version = "fem_charge_h1_periodic_jump.v1";
    potential_request.source_module_id = topo.identity.source_module_id;
    potential_request.source_state_revision = topo.identity.source_state_revision;
    potential_request.source_field_digest = topo.identity.source_field_digest;
    potential_request.evaluation_time_s = topo.identity.evaluation_time_s;
    potential_request.stage_identity = topo.identity.stage_identity;
    potential_request.envelope_revision = topo.identity.envelope_revision;
    potential_request.envelope_digest = topo.identity.envelope_digest;
    potential_request.evaluated_envelope_multiplier = 1.0;
    potential_request.mesh_revision = topo.identity.mesh_revision;
    potential_request.geometry_digest = topo.identity.geometry_digest;
    potential_request.conductivity_digest = "conductivity-r1";
    potential_request.source_cut_digest = topo.closure.digest;
    potential_request.algebraic_relative_tolerance = 1.0e-12;
    potential_request.maximum_iterations = 1000;

    ConservativeCurrentBuildRequest request;
    request.mesh = &mesh;
    request.conductivity = &conductivity;
    request.stable_vertex_identities = std::move(topo.ids);
    request.boundary_faces = std::move(topo.boundary_faces);
    request.closure = std::move(topo.closure);
    request.periodic_charge_potential =
        fullmag::fem::transport::PeriodicChargePotentialSolver::Solve(
            potential_request);
    request.identity = topo.identity;
    request.pins.required_source_state_revision = topo.identity.source_state_revision;
    request.pins.required_source_field_digest = topo.identity.source_field_digest;
    request.pins.required_mesh_revision = topo.identity.mesh_revision;
    request.pins.required_topology_revision = topo.identity.topology_revision;
    request.algebraic_relative_tolerance = 1.0e-12;
    request.physical_relative_gate = 1.0e-10;
    request.physical_absolute_gate_a = 1.0e-18;
    return ConservativeCurrentView::Build(request);
}

ConservativeCurrentView::Ptr make_imported_uniform_current_view(
    mfem::Mesh &mesh,
    double length_x,
    double jx_apm2)
{
    auto topo = make_periodic_cube_topology(mesh, length_x);
    mfem::RT_FECollection rt_fec(0, 3);
    mfem::FiniteElementSpace rt_space(&mesh, &rt_fec);
    mfem::GridFunction rt_field(&rt_space);
    mfem::Vector j_vec(3);
    j_vec = 0.0;
    j_vec[0] = jx_apm2;
    mfem::VectorConstantCoefficient j_coeff(j_vec);
    rt_field.ProjectCoefficient(j_coeff);

    ConservativeCurrentImportRequest request;
    request.mesh = &mesh;
    request.rt0_field = &rt_field;
    request.stable_vertex_identities = std::move(topo.ids);
    request.boundary_faces = std::move(topo.boundary_faces);
    request.closure = std::move(topo.closure);
    request.identity = topo.identity;
    request.pins.required_source_state_revision = topo.identity.source_state_revision;
    request.pins.required_source_field_digest = topo.identity.source_field_digest;
    request.pins.required_mesh_revision = topo.identity.mesh_revision;
    request.pins.required_topology_revision = topo.identity.topology_revision;
    request.physical_relative_gate = 1.0e-10;
    request.physical_absolute_gate_a = 1.0e-18;
    request.require_independent_physical_certificate = true;
    return ConservativeCurrentView::Import(request);
}

double compute_source_potential_energy(
    const ConservativeCurrentView &current,
    const std::vector<double> &a_dofs_t_m)
{
    const mfem::Mesh &mesh = *current.space().GetMesh();
    mfem::ND_FECollection nd_fec(1, 3);
    mfem::FiniteElementSpace nd_space(const_cast<mfem::Mesh *>(&mesh), &nd_fec);
    require(static_cast<int>(a_dofs_t_m.size()) == nd_space.GetVSize(),
        "OE-F2 vector-potential payload does not match the ND target space");
    mfem::GridFunction vector_potential(&nd_space);
    std::copy(a_dofs_t_m.begin(), a_dofs_t_m.end(), vector_potential.GetData());
    const mfem::IntegrationRule &rule = mfem::IntRules.Get(
        mfem::Geometry::TETRAHEDRON, 4);
    double source_potential_pairing = 0.0;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        auto *transformation =
            const_cast<mfem::Mesh &>(mesh).GetElementTransformation(element);
        mfem::Vector source_value(3);
        mfem::Vector potential_value(3);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            const auto &integration_point = rule.IntPoint(point);
            transformation->SetIntPoint(&integration_point);
            current.field().GetVectorValue(
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
    return source_potential_pairing;
}

double vector_l2_norm(const std::vector<double> &v)
{
    long double sum = 0.0L;
    for (double x : v) {
        const long double lx = static_cast<long double>(x);
        sum += lx * lx;
    }
    return static_cast<double>(std::sqrt(sum));
}

double vector_relative_difference(
    const std::vector<double> &actual,
    const std::vector<double> &reference,
    double floor_scale)
{
    require(actual.size() == reference.size(),
        "OE-F2 vector comparison size mismatch");
    long double diff_sq = 0.0L;
    long double ref_sq = 0.0L;
    for (std::size_t i = 0; i < actual.size(); ++i) {
        const long double d =
            static_cast<long double>(actual[i]) - static_cast<long double>(reference[i]);
        const long double r = static_cast<long double>(reference[i]);
        diff_sq += d * d;
        ref_sq += r * r;
    }
    const long double denom = std::max(static_cast<long double>(floor_scale), std::sqrt(ref_sq));
    return static_cast<double>(std::sqrt(diff_sq) / denom);
}

// Local test-only dense oracle used strictly on small meshes (e.g. 3x3x3) to
// cross-check the production sparse OE-F2 solver and sparse H1 mass projection.
struct DenseReferenceSolution {
    std::vector<double> a_dofs_t_m;
    std::vector<double> gauge_dofs_apm;
    std::vector<double> compatible_h_dofs_apm;
    std::vector<double> nodal_h_xyz_apm;
};

class DenseOracleRt0Component final : public mfem::Coefficient {
public:
    DenseOracleRt0Component(const mfem::GridFunction &field, int component)
        : field_(field), component_(component)
    {}

    double Eval(mfem::ElementTransformation &tr, const mfem::IntegrationPoint &ip) override
    {
        mfem::Vector value(3);
        field_.GetVectorValue(tr, ip, value);
        return value[component_];
    }

private:
    const mfem::GridFunction &field_;
    int component_ = 0;
};

DenseReferenceSolution solve_dense_reference_oracle(
    const ConservativeCurrentView &source,
    double mu0_si)
{
    const mfem::Mesh &mesh = *source.space().GetMesh();
    mfem::ND_FECollection nd_fec(1, 3);
    mfem::H1_FECollection h1_fec(1, 3);
    mfem::FiniteElementSpace nd_space(const_cast<mfem::Mesh *>(&mesh), &nd_fec);
    mfem::FiniteElementSpace h1_space(const_cast<mfem::Mesh *>(&mesh), &h1_fec);
    const int nd_dofs = nd_space.GetVSize();
    const int h1_dofs = h1_space.GetVSize();

    mfem::ConstantCoefficient inv_mu0(1.0 / mu0_si);
    mfem::BilinearForm curl_form(&nd_space);
    curl_form.AddDomainIntegrator(new mfem::CurlCurlIntegrator(inv_mu0));
    curl_form.Assemble();
    curl_form.Finalize();

    mfem::MixedBilinearForm grad_form(&h1_space, &nd_space);
    grad_form.AddDomainIntegrator(new mfem::MixedVectorGradientIntegrator());
    grad_form.Assemble();
    grad_form.Finalize();

    mfem::VectorGridFunctionCoefficient current_coeff(&source.field());
    mfem::LinearForm load(&nd_space);
    load.AddDomainIntegrator(new mfem::VectorFEDomainLFIntegrator(current_coeff));
    load.Assemble();

    const mfem::SparseMatrix &curl_mat = curl_form.SpMat();
    const mfem::SparseMatrix &grad_mat = grad_form.SpMat();
    const double beta = compute_saddle_point_equilibration_beta(curl_mat, grad_mat);

    const int total = nd_dofs + h1_dofs;
    mfem::DenseMatrix block(total);
    block = 0.0;
    const int *ki = curl_mat.HostReadI();
    const int *kj = curl_mat.HostReadJ();
    const double *ka = curl_mat.HostReadData();
    for (int r = 0; r < nd_dofs; ++r) {
        for (int p = ki[r]; p < ki[r + 1]; ++p) {
            block(r, kj[p]) = ka[p];
        }
    }
    const int *gi = grad_mat.HostReadI();
    const int *gj = grad_mat.HostReadJ();
    const double *ga = grad_mat.HostReadData();
    for (int r = 0; r < nd_dofs; ++r) {
        for (int p = gi[r]; p < gi[r + 1]; ++p) {
            block(r, nd_dofs + gj[p]) = beta * ga[p];
            block(nd_dofs + gj[p], r) = beta * ga[p];
        }
    }

    mfem::Vector rhs(total);
    rhs = 0.0;
    for (int i = 0; i < nd_dofs; ++i) {
        rhs[i] = load[i];
    }

    auto impose_zero = [&](int dof) {
        for (int j = 0; j < total; ++j) {
            block(dof, j) = 0.0;
            block(j, dof) = 0.0;
        }
        block(dof, dof) = 1.0;
        rhs[dof] = 0.0;
    };

    mfem::Array<int> ess_nd;
    mfem::Array<int> ess_h1;
    nd_space.GetBoundaryTrueDofs(ess_nd);
    h1_space.GetBoundaryTrueDofs(ess_h1);
    for (int i = 0; i < ess_nd.Size(); ++i) {
        impose_zero(ess_nd[i]);
    }
    for (int i = 0; i < ess_h1.Size(); ++i) {
        impose_zero(nd_dofs + ess_h1[i]);
    }

    mfem::DenseMatrixInverse inv(block);
    mfem::Vector sol(total);
    inv.Mult(rhs, sol);

    DenseReferenceSolution out;
    out.a_dofs_t_m.assign(sol.GetData(), sol.GetData() + nd_dofs);
    out.gauge_dofs_apm.resize(static_cast<std::size_t>(h1_dofs));
    for (int i = 0; i < h1_dofs; ++i) {
        out.gauge_dofs_apm[static_cast<std::size_t>(i)] = beta * sol[nd_dofs + i];
    }

    mfem::RT_FECollection rt_fec(0, 3);
    mfem::FiniteElementSpace rt_space(const_cast<mfem::Mesh *>(&mesh), &rt_fec);
    mfem::DiscreteLinearOperator curl_to_rt(&nd_space, &rt_space);
    curl_to_rt.AddDomainInterpolator(new mfem::CurlInterpolator());
    curl_to_rt.Assemble();
    curl_to_rt.Finalize();

    mfem::Vector a_vec(nd_dofs);
    std::copy(out.a_dofs_t_m.begin(), out.a_dofs_t_m.end(), a_vec.GetData());
    mfem::Vector b_rt(rt_space.GetVSize());
    curl_to_rt.Mult(a_vec, b_rt);

    mfem::GridFunction h_rt(&rt_space);
    out.compatible_h_dofs_apm.resize(static_cast<std::size_t>(b_rt.Size()));
    for (int i = 0; i < b_rt.Size(); ++i) {
        const double hv = b_rt[i] / mu0_si;
        h_rt[i] = hv;
        out.compatible_h_dofs_apm[static_cast<std::size_t>(i)] = hv;
    }

    mfem::FiniteElementSpace scalar_space(
        const_cast<mfem::Mesh *>(&mesh), &h1_fec, 1, mfem::Ordering::byNODES);
    const int n_nodes = scalar_space.GetVSize();
    mfem::BilinearForm mass(&scalar_space);
    mass.AddDomainIntegrator(new mfem::MassIntegrator());
    mass.Assemble();
    mass.Finalize();

    mfem::DenseMatrix mass_dense(n_nodes);
    mass_dense = 0.0;
    const auto &m_sp = mass.SpMat();
    const int *mi = m_sp.HostReadI();
    const int *mj = m_sp.HostReadJ();
    const double *ma = m_sp.HostReadData();
    for (int r = 0; r < n_nodes; ++r) {
        for (int p = mi[r]; p < mi[r + 1]; ++p) {
            mass_dense(r, mj[p]) = ma[p];
        }
    }
    mfem::DenseMatrixInverse mass_inv(mass_dense);

    out.nodal_h_xyz_apm.assign(static_cast<std::size_t>(n_nodes) * 3u, 0.0);
    mfem::Vector nodal_sol(n_nodes);
    for (int c = 0; c < 3; ++c) {
        DenseOracleRt0Component comp_coeff(h_rt, c);
        mfem::LinearForm comp_rhs(&scalar_space);
        comp_rhs.AddDomainIntegrator(new mfem::DomainLFIntegrator(comp_coeff));
        comp_rhs.Assemble();
        mass_inv.Mult(comp_rhs, nodal_sol);
        for (int node = 0; node < n_nodes; ++node) {
            out.nodal_h_xyz_apm[static_cast<std::size_t>(node) * 3u +
                static_cast<std::size_t>(c)] = nodal_sol[node];
        }
    }
    return out;
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
            result.diagnostics.compatible_divergence_residual < 1.0e-7 &&
            result.diagnostics.nodal_projection_residual <= 1.0e-10,
        "OE-F2 residual certificate is outside the fixture tolerance");
    require(!result.diagnostics.resolved_linear_solver.empty() &&
            std::isfinite(result.diagnostics.linear_solve_ms) &&
            result.diagnostics.linear_solve_ms >= 0.0 &&
            std::isfinite(result.diagnostics.nodal_projection_ms) &&
            result.diagnostics.nodal_projection_ms >= 0.0,
        "OE-F2 did not publish linear solver telemetry");
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

    const double source_potential_pairing =
        compute_source_potential_energy(*current, result.a_dofs_t_m);
    require(std::isfinite(source_potential_pairing) &&
            source_potential_pairing > 0.0,
        "OE-F2 source-potential energy diagnostic is not finite and positive");
    std::cout << std::setprecision(17)
              << "OE-F2 target-space max boundary |p|="
              << maximum_boundary_gauge
              << " source-potential energy W_J="
              << source_potential_pairing
              << " solver=" << result.diagnostics.resolved_linear_solver << "\n";

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

void vector_potential_sparse_matches_dense_oracle_on_small_mesh()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        3, 3, 3, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    const auto current = make_imported_uniform_current_view(mesh, 1.0, 4.0);
    const DenseReferenceSolution oracle =
        solve_dense_reference_oracle(*current, VectorPotentialOptions{}.mu0_si);
    require(vector_l2_norm(oracle.a_dofs_t_m) > 0.0 &&
            vector_l2_norm(oracle.compatible_h_dofs_apm) > 0.0 &&
            vector_l2_norm(oracle.nodal_h_xyz_apm) > 0.0,
        "OE-F2 dense oracle produced a zero field on 3x3x3 cube");

    std::vector<SparseCpuBackendPolicy> policies{
        SparseCpuBackendPolicy::Auto,
        SparseCpuBackendPolicy::MfemSerial,
    };
    if (can_test_hypre_backend()) {
        policies.push_back(SparseCpuBackendPolicy::Hypre);
    }

    for (const SparseCpuBackendPolicy policy : policies) {
        VectorPotentialOptions options;
        options.relative_tolerance = 1.0e-10;
        options.cpu_backend = policy;
        const VectorPotentialResult result = VectorPotentialSolver::Evaluate(*current, options);

        require(result.diagnostics.h1_dofs > result.diagnostics.essential_h1_dof_count,
            "3x3x3 cube must exercise non-empty interior H1 gauge DOFs");
        require(!result.diagnostics.resolved_linear_solver.empty(),
            "OE-F2 sparse solve did not report resolved_linear_solver");
        if (policy == SparseCpuBackendPolicy::Hypre) {
            require(result.diagnostics.resolved_linear_solver == "hypre_ams_boomeramg_minres",
                "OE-F2 explicit Hypre policy did not use HYPRE AMS+BoomerAMG MINRES");
        }
        if (policy == SparseCpuBackendPolicy::MfemSerial) {
            require(result.diagnostics.resolved_linear_solver == "mfem_block_gs_minres",
                "OE-F2 explicit MfemSerial policy did not use serial block-GS MINRES");
        }

        const double err_a = vector_relative_difference(
            result.a_dofs_t_m, oracle.a_dofs_t_m, 0.0);
        const double err_p = vector_relative_difference(
            result.gauge_dofs_apm, oracle.gauge_dofs_apm, 1.0);
        const double err_h = vector_relative_difference(
            result.compatible_h_dofs_apm, oracle.compatible_h_dofs_apm, 0.0);
        const double err_nodal = vector_relative_difference(
            result.nodal_h_xyz_apm, oracle.nodal_h_xyz_apm, 0.0);

        require(err_a <= 1.0e-11 && err_p <= 1.0e-11 &&
                err_h <= 1.0e-11 && err_nodal <= 1.0e-11,
            "OE-F2 sparse solver diverged from dense oracle on 3x3x3 mesh (" +
            result.diagnostics.resolved_linear_solver + ")");
        require(result.diagnostics.nodal_projection_residual <= 1.0e-11,
            "OE-F2 sparse nodal projection residual exceeded 1e-11 on 3x3x3 mesh");
    }
}

void vector_potential_scales_beyond_legacy_4096_nd_cap()
{
    const VectorPotentialOptions defaults{};
    require(defaults.maximum_nd_dofs == 2'000'000 &&
            defaults.maximum_h1_dofs == 1'000'000,
        "OE-F2 default DOF limits were not raised to 2,000,000 / 1,000,000");

    auto mesh = mfem::Mesh::MakeCartesian3D(
        12, 12, 12, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    const auto current = make_imported_uniform_current_view(mesh, 1.0, 4.0);

    const VectorPotentialResult result =
        VectorPotentialSolver::Evaluate(*current, defaults);
    require(result.diagnostics.nd_dofs > 12000 &&
            result.diagnostics.nd_dofs > 4096 &&
            result.diagnostics.h1_dofs > 2048,
        "OE-F2 12x12x12 fixture did not exceed legacy 4096/2048 caps");
    require(!result.diagnostics.resolved_linear_solver.empty() &&
            result.diagnostics.linear_solve_ms >= 0.0 &&
            result.diagnostics.nodal_projection_ms >= 0.0,
        "OE-F2 12x12x12 solve did not publish solver diagnostics");

    const double scale = std::max(1.0, result.diagnostics.source_pairing_norm);
    const double tol = defaults.relative_tolerance * scale;
    require(result.diagnostics.first_block_residual <= tol &&
            result.diagnostics.constraint_residual <= tol &&
            result.diagnostics.compatible_divergence_residual <= tol &&
            result.diagnostics.nodal_projection_residual <= 1.0e-10,
        "OE-F2 12x12x12 solve residuals exceeded tolerance");

    const double energy = compute_source_potential_energy(*current, result.a_dofs_t_m);
    require(std::isfinite(energy) && energy > 0.0,
        "OE-F2 12x12x12 source-potential pairing energy is not finite and positive");
    std::cout << "OE-F2 12x12x12 scaling: nd_dofs=" << result.diagnostics.nd_dofs
              << " h1_dofs=" << result.diagnostics.h1_dofs
              << " solver=" << result.diagnostics.resolved_linear_solver
              << " iters=" << result.diagnostics.linear_iterations
              << " solve_ms=" << result.diagnostics.linear_solve_ms
              << " proj_ms=" << result.diagnostics.nodal_projection_ms << "\n";
}

void vector_potential_nanometer_scale_equilibration()
{
    constexpr double kLengthM = 1.0e-7;
    constexpr double kCurrentDensityApm2 = 1.0e10;
    auto mesh = mfem::Mesh::MakeCartesian3D(
        4, 4, 4, mfem::Element::TETRAHEDRON, kLengthM, kLengthM, kLengthM);
    const auto current =
        make_imported_uniform_current_view(mesh, kLengthM, kCurrentDensityApm2);

    VectorPotentialOptions auto_options;
    auto_options.relative_tolerance = 1.0e-10;
    auto_options.cpu_backend = SparseCpuBackendPolicy::Auto;
    const VectorPotentialResult auto_res =
        VectorPotentialSolver::Evaluate(*current, auto_options);

    auto check_nanometer_result = [&](const VectorPotentialResult &res) {
        const double scale = std::max(1.0, res.diagnostics.source_pairing_norm);
        const double tol = 1.0e-10 * scale;
        require(res.diagnostics.source_pairing_norm > 0.0,
            "OE-F2 nanometer fixture has zero source pairing norm");
        require(res.diagnostics.first_block_residual <= tol &&
                res.diagnostics.first_block_residual <=
                    1.0e-10 * res.diagnostics.source_pairing_norm &&
                res.diagnostics.constraint_residual <= tol &&
                res.diagnostics.compatible_divergence_residual <= tol &&
                res.diagnostics.nodal_projection_residual <= 1.0e-10,
            "OE-F2 nanometer-scale residuals exceeded 1e-10 (" +
            res.diagnostics.resolved_linear_solver + ")");
        const double energy = compute_source_potential_energy(*current, res.a_dofs_t_m);
        require(std::isfinite(energy) && energy > 0.0,
            "OE-F2 nanometer-scale source-potential energy W_J is not finite and positive");
    };

    check_nanometer_result(auto_res);

    if (can_test_hypre_backend()) {
        VectorPotentialOptions hypre_options = auto_options;
        hypre_options.cpu_backend = SparseCpuBackendPolicy::Hypre;
        const VectorPotentialResult hypre_res =
            VectorPotentialSolver::Evaluate(*current, hypre_options);
        require(hypre_res.diagnostics.resolved_linear_solver == "hypre_ams_boomeramg_minres",
            "OE-F2 nanometer Hypre solve did not use AMS+BoomerAMG MINRES");
        check_nanometer_result(hypre_res);

        const double diff_a = vector_relative_difference(
            hypre_res.a_dofs_t_m, auto_res.a_dofs_t_m, 0.0);
        const double diff_nodal = vector_relative_difference(
            hypre_res.nodal_h_xyz_apm, auto_res.nodal_h_xyz_apm, 0.0);
        require(diff_a <= 1.0e-10 && diff_nodal <= 1.0e-10,
            "OE-F2 nanometer Tier-2 HYPRE AMS solution disagreed with Auto solver");
    }
}

void vector_potential_coarse_mesh_zero_interior_h1_and_cap_rejection()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    const auto current = make_uniform_current_view(mesh);

    std::vector<SparseCpuBackendPolicy> policies{
        SparseCpuBackendPolicy::Auto,
        SparseCpuBackendPolicy::MfemSerial,
    };
    if (can_test_hypre_backend()) {
        policies.push_back(SparseCpuBackendPolicy::Hypre);
    }

    for (const SparseCpuBackendPolicy policy : policies) {
        VectorPotentialOptions options;
        options.relative_tolerance = 1.0e-10;
        options.cpu_backend = policy;
        const VectorPotentialResult result =
            VectorPotentialSolver::Evaluate(*current, options);
        require(result.diagnostics.h1_dofs == result.diagnostics.essential_h1_dof_count,
            "1x1x1 coarse mesh fixture must have zero interior H1 DOFs");
        require(result.diagnostics.nd_dofs > result.diagnostics.essential_nd_dof_count,
            "1x1x1 coarse mesh fixture must have at least one interior ND DOF");
        for (double p_val : result.gauge_dofs_apm) {
            require(p_val == 0.0,
                "OE-F2 zero-interior-H1 SPD path produced nonzero gauge DOF");
        }
        const double scale = std::max(1.0, result.diagnostics.source_pairing_norm);
        require(result.diagnostics.first_block_residual <= 1.0e-10 * scale &&
                result.diagnostics.constraint_residual <= 1.0e-10 * scale &&
                result.diagnostics.compatible_divergence_residual <= 1.0e-10 * scale &&
                result.diagnostics.nodal_projection_residual <= 1.0e-10,
            "OE-F2 1x1x1 SPD path residuals exceeded tolerance");
        require(!result.diagnostics.resolved_linear_solver.empty(),
            "OE-F2 1x1x1 SPD path did not report resolved_linear_solver");
    }

    auto require_invalid_arg = [&](const VectorPotentialOptions &bad_opts, const char *label) {
        bool threw = false;
        try {
            (void)VectorPotentialSolver::Evaluate(*current, bad_opts);
        } catch (const std::invalid_argument &) {
            threw = true;
        }
        require(threw, label);
    };

    VectorPotentialOptions small_nd_cap;
    small_nd_cap.maximum_nd_dofs = 10;
    require_invalid_arg(small_nd_cap, "OE-F2 did not reject explicit maximum_nd_dofs = 10");

    VectorPotentialOptions small_h1_cap;
    small_h1_cap.maximum_h1_dofs = 4;
    require_invalid_arg(small_h1_cap, "OE-F2 did not reject explicit maximum_h1_dofs = 4");

    VectorPotentialOptions zero_nd_cap;
    zero_nd_cap.maximum_nd_dofs = 0;
    require_invalid_arg(zero_nd_cap, "OE-F2 did not reject non-positive maximum_nd_dofs = 0");

    VectorPotentialOptions zero_h1_cap;
    zero_h1_cap.maximum_h1_dofs = 0;
    require_invalid_arg(zero_h1_cap, "OE-F2 did not reject non-positive maximum_h1_dofs = 0");

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && !FULLMAG_HAS_CUDA_RUNTIME
    VectorPotentialOptions gpu_options;
    gpu_options.execution_target = SparseExecutionTarget::GpuCudss;
    bool gpu_rejected = false;
    try {
        (void)VectorPotentialSolver::Evaluate(*current, gpu_options);
    } catch (const std::runtime_error &) {
        gpu_rejected = true;
    }
    require(gpu_rejected,
        "OE-F2 silently fell back to CPU when GpuCudss was requested without CUDA");
#endif
}

} // namespace

int main()
{
    try {
        vector_potential_exact_sequence_contract();
        vector_potential_sparse_matches_dense_oracle_on_small_mesh();
        vector_potential_scales_beyond_legacy_4096_nd_cap();
        vector_potential_nanometer_scale_equilibration();
        vector_potential_coarse_mesh_zero_interior_h1_and_cap_rejection();
        std::cout << "fem mixed vector-potential Oersted contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem mixed vector-potential Oersted contract: FAIL: "
                  << error.what() << '\n';
        return 1;
    }
}
