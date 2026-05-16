#include "cpu/mfem/interactions/demag_fem_bem.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <chrono>
#include <limits>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <tuple>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kAreaEps = 1e-300;
constexpr double kVertexCoincidenceTol2 = 1e-48;

using Vec3 = std::array<double, 3>;

struct FaceKey {
    uint32_t a;
    uint32_t b;
    uint32_t c;
};

struct FaceRecord {
    FaceKey key{};
    std::array<uint32_t, 3> tri{};
    uint32_t opposite = 0;
    uint32_t count = 0;
};

Vec3 sub(const Vec3 &a, const Vec3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

Vec3 add(const Vec3 &a, const Vec3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

Vec3 scale(const Vec3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

double dot(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Vec3 cross(const Vec3 &a, const Vec3 &b) {
    return {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}

double norm(const Vec3 &a) {
    return std::sqrt(dot(a, a));
}

Vec3 normalized(const Vec3 &a) {
    const double len = norm(a);
    if (!(len > 0.0)) {
        return {0.0, 0.0, 0.0};
    }
    return scale(a, 1.0 / len);
}

Vec3 node_position(const Context &ctx, uint32_t node) {
    const size_t base = static_cast<size_t>(node) * 3u;
    return {
        ctx.nodes_xyz[base + 0u],
        ctx.nodes_xyz[base + 1u],
        ctx.nodes_xyz[base + 2u],
    };
}

FaceKey sorted_key(std::array<uint32_t, 3> tri) {
    std::sort(tri.begin(), tri.end());
    return {tri[0], tri[1], tri[2]};
}

bool key_less(const FaceKey &lhs, const FaceKey &rhs) {
    return std::tie(lhs.a, lhs.b, lhs.c) < std::tie(rhs.a, rhs.b, rhs.c);
}

bool key_equal(const FaceKey &lhs, const FaceKey &rhs) {
    return lhs.a == rhs.a && lhs.b == rhs.b && lhs.c == rhs.c;
}

std::array<std::array<uint32_t, 3>, 4> tetra_faces(const uint32_t *tet) {
    return {{
        {tet[1], tet[2], tet[3]},
        {tet[0], tet[3], tet[2]},
        {tet[0], tet[1], tet[3]},
        {tet[0], tet[2], tet[1]},
    }};
}

std::array<uint32_t, 4> tetra_opposites(const uint32_t *tet) {
    return {tet[0], tet[1], tet[2], tet[3]};
}

bool face_references_valid_nodes(
    const Context &ctx,
    const std::array<uint32_t, 3> &face)
{
    return face[0] < ctx.n_nodes && face[1] < ctx.n_nodes && face[2] < ctx.n_nodes;
}

bool build_face_records(const Context &ctx, std::vector<FaceRecord> &records, std::string &error) {
    records.clear();
    records.reserve(static_cast<size_t>(ctx.n_elements) * 4u);
    for (uint32_t elem = 0; elem < ctx.n_elements; ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
            continue;
        }
        const size_t base = static_cast<size_t>(elem) * 4u;
        const uint32_t tet[4] = {
            ctx.elements[base + 0u],
            ctx.elements[base + 1u],
            ctx.elements[base + 2u],
            ctx.elements[base + 3u],
        };
        for (uint32_t node : tet) {
            if (node >= ctx.n_nodes) {
                error = "FEM/BEM demag boundary extraction found an element node outside the mesh";
                return false;
            }
        }
        const auto faces = tetra_faces(tet);
        const auto opposites = tetra_opposites(tet);
        for (size_t i = 0; i < faces.size(); ++i) {
            records.push_back(FaceRecord{sorted_key(faces[i]), faces[i], opposites[i], 1u});
        }
    }
    std::sort(records.begin(), records.end(), [](const FaceRecord &lhs, const FaceRecord &rhs) {
        return key_less(lhs.key, rhs.key);
    });

    std::vector<FaceRecord> merged;
    merged.reserve(records.size());
    for (const FaceRecord &record : records) {
        if (!merged.empty() && key_equal(merged.back().key, record.key)) {
            merged.back().count += 1u;
            continue;
        }
        merged.push_back(record);
    }
    records = std::move(merged);
    return true;
}

const FaceRecord *find_face_record(
    const std::vector<FaceRecord> &records,
    const FaceKey &key)
{
    const auto it = std::lower_bound(
        records.begin(),
        records.end(),
        key,
        [](const FaceRecord &lhs, const FaceKey &rhs) {
            return key_less(lhs.key, rhs);
        });
    if (it == records.end() || !key_equal(it->key, key)) {
        return nullptr;
    }
    return &*it;
}

bool add_oriented_boundary_face(
    const Context &ctx,
    const std::array<uint32_t, 3> &input_tri,
    uint32_t opposite,
    DemagBoundarySurface &surface,
    std::string &error)
{
    if (!face_references_valid_nodes(ctx, input_tri) || opposite >= ctx.n_nodes) {
        error = "FEM/BEM demag boundary face references a node outside the mesh";
        return false;
    }

    std::array<uint32_t, 3> tri = input_tri;
    const Vec3 p0 = node_position(ctx, tri[0]);
    const Vec3 p1 = node_position(ctx, tri[1]);
    const Vec3 p2 = node_position(ctx, tri[2]);
    Vec3 normal = cross(sub(p1, p0), sub(p2, p0));
    double area2 = norm(normal);
    if (!(area2 > kAreaEps)) {
        error = "FEM/BEM demag boundary face has zero area";
        return false;
    }

    const Vec3 centroid = scale(add(add(p0, p1), p2), 1.0 / 3.0);
    const Vec3 interior = node_position(ctx, opposite);
    if (dot(normal, sub(interior, centroid)) > 0.0) {
        std::swap(tri[1], tri[2]);
        normal = scale(normal, -1.0);
    }

    area2 = norm(normal);
    surface.triangles.push_back(tri);
    surface.unit_normals.push_back(scale(normal, 1.0 / area2));
    surface.triangle_areas.push_back(0.5 * area2);
    for (uint32_t node : tri) {
        if (surface.global_to_boundary[static_cast<size_t>(node)] < 0) {
            surface.global_to_boundary[static_cast<size_t>(node)] =
                static_cast<int32_t>(surface.boundary_nodes.size());
            surface.boundary_nodes.push_back(node);
        }
    }
    return true;
}

double solid_angle_magnitude(const Vec3 &x, const Vec3 &p0, const Vec3 &p1, const Vec3 &p2) {
    const Vec3 r0 = sub(p0, x);
    const Vec3 r1 = sub(p1, x);
    const Vec3 r2 = sub(p2, x);
    const double n0 = norm(r0);
    const double n1 = norm(r1);
    const double n2 = norm(r2);
    if (!(n0 > 0.0) || !(n1 > 0.0) || !(n2 > 0.0)) {
        return 0.0;
    }
    const double det = dot(r0, cross(r1, r2));
    const double denom =
        n0 * n1 * n2 +
        dot(r0, r1) * n2 +
        dot(r1, r2) * n0 +
        dot(r2, r0) * n1;
    return std::abs(2.0 * std::atan2(det, denom));
}

bool point_matches_vertex(const Vec3 &x, const Vec3 &p) {
    const Vec3 d = sub(x, p);
    return dot(d, d) <= kVertexCoincidenceTol2;
}

std::array<double, 3> lindholm_linear_triangle_weights(
    const Vec3 &x,
    const std::array<Vec3, 3> &p,
    double area,
    const Vec3 &unit_normal)
{
    if (!(area > 0.0) ||
        point_matches_vertex(x, p[0]) ||
        point_matches_vertex(x, p[1]) ||
        point_matches_vertex(x, p[2])) {
        return {0.0, 0.0, 0.0};
    }

    std::array<Vec3, 3> rho_vec{};
    std::array<Vec3, 3> edge_unit{};
    std::array<Vec3, 3> eta{};
    std::array<double, 3> eta0{};
    std::array<double, 3> rho{};
    std::array<double, 3> edge_len{};
    std::array<double, 3> edge_log{};

    for (int i = 0; i < 3; ++i) {
        rho_vec[static_cast<size_t>(i)] = sub(p[static_cast<size_t>(i)], x);
        rho[static_cast<size_t>(i)] = norm(rho_vec[static_cast<size_t>(i)]);
    }
    for (int i = 0; i < 3; ++i) {
        const int next = (i + 1) % 3;
        const Vec3 edge = sub(rho_vec[static_cast<size_t>(next)], rho_vec[static_cast<size_t>(i)]);
        edge_len[static_cast<size_t>(i)] = norm(edge);
        if (!(edge_len[static_cast<size_t>(i)] > 0.0)) {
            return {0.0, 0.0, 0.0};
        }
        edge_unit[static_cast<size_t>(i)] = scale(edge, 1.0 / edge_len[static_cast<size_t>(i)]);
        eta[static_cast<size_t>(i)] = cross(unit_normal, edge_unit[static_cast<size_t>(i)]);
        eta0[static_cast<size_t>(i)] = dot(eta[static_cast<size_t>(i)], rho_vec[static_cast<size_t>(i)]);
        const double numerator =
            rho[static_cast<size_t>(i)] +
            rho[static_cast<size_t>(next)] +
            edge_len[static_cast<size_t>(i)];
        const double denominator =
            rho[static_cast<size_t>(i)] +
            rho[static_cast<size_t>(next)] -
            edge_len[static_cast<size_t>(i)];
        if (!(numerator > 0.0) || !(denominator > 0.0)) {
            return {0.0, 0.0, 0.0};
        }
        edge_log[static_cast<size_t>(i)] = std::log(numerator / denominator);
    }

    double omega = solid_angle_magnitude(x, p[0], p[1], p[2]);
    const double chi0 = dot(unit_normal, rho_vec[0]);
    if (chi0 < 0.0) {
        omega = -omega;
    }

    double gamma_times_log[3] = {0.0, 0.0, 0.0};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            gamma_times_log[i] +=
                dot(edge_unit[static_cast<size_t>((i + 1) % 3)], edge_unit[static_cast<size_t>(j)]) *
                edge_log[static_cast<size_t>(j)];
        }
    }

    std::array<double, 3> weights{};
    for (int i = 0; i < 3; ++i) {
        const int next = (i + 1) % 3;
        weights[static_cast<size_t>(i)] =
            edge_len[static_cast<size_t>(next)] / (8.0 * kPi * area) *
            (eta0[static_cast<size_t>(next)] * omega - chi0 * gamma_times_log[i]);
    }
    return weights;
}

double boundary_node_solid_angle_sum(
    const Context &ctx,
    uint32_t node)
{
    double sum = 0.0;
    for (uint32_t elem = 0; elem < ctx.n_elements; ++elem) {
        if (!ctx.magnetic_element_mask.empty() &&
            ctx.magnetic_element_mask[static_cast<size_t>(elem)] == 0u) {
            continue;
        }
        const size_t base = static_cast<size_t>(elem) * 4u;
        int local = -1;
        for (int i = 0; i < 4; ++i) {
            if (ctx.elements[base + static_cast<size_t>(i)] == node) {
                local = i;
                break;
            }
        }
        if (local < 0) {
            continue;
        }
        const Vec3 x = node_position(ctx, node);
        Vec3 other[3]{};
        int cursor = 0;
        for (int i = 0; i < 4; ++i) {
            if (i == local) {
                continue;
            }
            other[cursor++] = node_position(ctx, ctx.elements[base + static_cast<size_t>(i)]);
        }
        sum += solid_angle_magnitude(x, other[0], other[1], other[2]);
    }
    return sum;
}

#if FULLMAG_HAS_MFEM_STACK
using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_ns(const SteadyClock::time_point &start) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

struct DemagFemBemWorkspace {
    DemagBoundarySurface surface;
    DenseDemagBemOperator boundary_operator;
    std::unique_ptr<mfem::FiniteElementCollection> potential_fec;
    std::unique_ptr<mfem::FiniteElementSpace> potential_fes;
    std::unique_ptr<mfem::BilinearForm> stiffness_form;
    std::unique_ptr<mfem::SparseMatrix> neumann_op;
    std::unique_ptr<mfem::SparseMatrix> dirichlet_op;
    std::unique_ptr<mfem::Vector> u1;
    std::unique_ptr<mfem::Vector> u2;
    std::unique_ptr<mfem::Vector> total_potential;
    std::unique_ptr<mfem::Vector> boundary_values_global;
    std::unique_ptr<mfem::Vector> laplace_rhs;
    std::vector<int> boundary_tdofs;
    int last_u1_iterations = 0;
    int last_u2_iterations = 0;
    double last_u1_residual = 0.0;
    double last_u2_residual = 0.0;
};

void copy_vector(const mfem::Vector &src, mfem::Vector &dst) {
    dst.SetSize(src.Size());
    for (int i = 0; i < src.Size(); ++i) {
        dst(i) = src(i);
    }
}

#ifdef MFEM_USE_MPI
void ensure_local_mpi_initialized() {
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (initialized == 0) {
        int argc = 0;
        char **argv = nullptr;
        MPI_Init(&argc, &argv);
    }
}
#endif

bool solve_sparse_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    int &iterations,
    double &residual,
    std::string &error)
{
    iterations = 0;
    residual = 0.0;
#ifdef MFEM_USE_MPI
    ensure_local_mpi_initialized();
    const HYPRE_BigInt glob_size = static_cast<HYPRE_BigInt>(op.NumRows());
    HYPRE_BigInt row_starts[2] = {0, glob_size};
    auto A_par = std::make_unique<mfem::HypreParMatrix>(MPI_COMM_WORLD, glob_size, row_starts, &op);
    mfem::HypreParVector b_par(MPI_COMM_WORLD, glob_size, row_starts);
    mfem::HypreParVector x_par(MPI_COMM_WORLD, glob_size, row_starts);
    double *b_host = b_par.HostWrite();
    double *x_host = x_par.HostWrite();
    for (int i = 0; i < rhs.Size(); ++i) {
        b_host[i] = rhs(i);
        x_host[i] = solution(i);
    }

    std::unique_ptr<mfem::HypreSolver> preconditioner;
    switch (ctx.demag_solver.preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG: {
        auto amg = std::make_unique<mfem::HypreBoomerAMG>(*A_par);
        amg->SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
        preconditioner = std::move(amg);
        break;
    }
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        preconditioner = std::make_unique<mfem::HypreDiagScale>(*A_par);
        break;
    case FULLMAG_FEM_PRECONDITIONER_NONE: {
        auto identity = std::make_unique<mfem::HypreIdentity>();
        identity->SetOperator(*A_par);
        preconditioner = std::move(identity);
        break;
    }
    default:
        error = "FEM/BEM demag requested an unsupported preconditioner";
        return false;
    }

    if (ctx.demag_solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES) {
        mfem::HypreGMRES solver(MPI_COMM_WORLD);
        solver.iterative_mode = true;
        solver.SetTol(ctx.demag_solver.relative_tolerance);
        if (ctx.demag_solver.has_absolute_tolerance &&
            ctx.demag_solver.absolute_tolerance > 0.0) {
            solver.SetAbsTol(ctx.demag_solver.absolute_tolerance);
        }
        solver.SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
        solver.SetKDim(50);
        solver.SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
        solver.SetOperator(*A_par);
        solver.SetPreconditioner(*preconditioner);
        solver.Mult(b_par, x_par);
        mfem::real_t final_residual = 0.0;
        solver.GetNumIterations(iterations);
        solver.GetFinalResidualNorm(final_residual);
        residual = static_cast<double>(final_residual);
    } else {
        mfem::HyprePCG solver(MPI_COMM_WORLD);
        solver.iterative_mode = true;
        solver.SetTol(ctx.demag_solver.relative_tolerance);
        if (ctx.demag_solver.has_absolute_tolerance &&
            ctx.demag_solver.absolute_tolerance > 0.0) {
            solver.SetAbsTol(ctx.demag_solver.absolute_tolerance);
        }
        solver.SetMaxIter(static_cast<int>(ctx.demag_solver.max_iterations));
        solver.SetPrintLevel(static_cast<int>(ctx.demag_solver.print_level));
        solver.SetOperator(*A_par);
        solver.SetPreconditioner(*preconditioner);
        solver.Mult(b_par, x_par);
        mfem::real_t final_residual = 0.0;
        solver.GetNumIterations(iterations);
        solver.GetFinalResidualNorm(final_residual);
        residual = static_cast<double>(final_residual);
    }

    const double *solved_host = x_par.HostRead();
    solution.SetSize(rhs.Size());
    for (int i = 0; i < rhs.Size(); ++i) {
        solution(i) = solved_host[i];
    }
    return true;
#else
    (void)ctx;
    (void)op;
    (void)rhs;
    (void)solution;
    error =
        "FEM/BEM demag requires an MPI/Hypre-enabled MFEM runtime in this initial dense-reference implementation";
    return false;
#endif
}

void accumulate_fem_bem_phase_timings(
    PhaseTimings *timings,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t solver_apply_wall_time_ns,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns)
{
    if (timings == nullptr) {
        return;
    }
    accumulate_demag_poisson_phase_timings(
        &timings->demag,
        assemble_wall_time_ns,
        solve_wall_time_ns,
        0,
        solver_apply_wall_time_ns,
        true,
        recover_wall_time_ns,
        energy_wall_time_ns);
}

void eliminate_row_col_zero(mfem::SparseMatrix &op, int tdof) {
    op.EliminateRowCol(tdof);
}

void set_boundary_values(
    const DemagFemBemWorkspace &workspace,
    const std::vector<double> &boundary_values,
    mfem::Vector &global_values)
{
    global_values = 0.0;
    for (size_t i = 0; i < workspace.surface.boundary_nodes.size(); ++i) {
        const int tdof = static_cast<int>(workspace.surface.boundary_nodes[i]);
        if (tdof >= 0 && tdof < global_values.Size()) {
            global_values(tdof) = boundary_values[i];
        }
    }
}
#endif

} // namespace

bool build_demag_boundary_surface(
    const Context &ctx,
    DemagBoundarySurface &surface,
    std::string &error)
{
    surface = {};
    surface.global_to_boundary.assign(static_cast<size_t>(ctx.n_nodes), -1);

    if (ctx.n_nodes == 0 || ctx.n_elements == 0) {
        error = "FEM/BEM demag requires a non-empty magnetic tetrahedral mesh";
        return false;
    }

    std::vector<FaceRecord> records;
    if (!build_face_records(ctx, records, error)) {
        return false;
    }
    if (records.empty()) {
        error = "FEM/BEM demag could not extract a magnetic boundary surface";
        return false;
    }

    if (!ctx.boundary_faces.empty()) {
        if (ctx.boundary_faces.size() % 3u != 0u) {
            error = "FEM/BEM demag boundary face buffer length is not a multiple of 3";
            return false;
        }
        for (size_t i = 0; i < ctx.boundary_faces.size() / 3u; ++i) {
            const std::array<uint32_t, 3> tri = {
                ctx.boundary_faces[i * 3u + 0u],
                ctx.boundary_faces[i * 3u + 1u],
                ctx.boundary_faces[i * 3u + 2u],
            };
            const FaceRecord *record = find_face_record(records, sorted_key(tri));
            if (record == nullptr) {
                error = "FEM/BEM demag boundary face is not owned by any magnetic tetrahedron";
                return false;
            }
            if (record->count != 1u) {
                error = "FEM/BEM demag boundary face is nonmanifold or belongs to an interior interface";
                return false;
            }
            if (!add_oriented_boundary_face(ctx, tri, record->opposite, surface, error)) {
                return false;
            }
        }
    } else {
        for (const FaceRecord &record : records) {
            if (record.count == 1u) {
                if (!add_oriented_boundary_face(ctx, record.tri, record.opposite, surface, error)) {
                    return false;
                }
            }
        }
    }

    if (surface.boundary_nodes.empty() || surface.triangles.empty()) {
        error = "FEM/BEM demag requires a watertight exterior magnetic boundary";
        return false;
    }
    return true;
}

bool DenseDemagBemOperator::build(
    const Context &ctx,
    const DemagBoundarySurface &surface,
    std::string &error)
{
    size_ = static_cast<uint32_t>(surface.boundary_nodes.size());
    matrix_.assign(static_cast<size_t>(size_) * static_cast<size_t>(size_), 0.0);
    if (size_ == 0) {
        error = "FEM/BEM dense BEM operator requires at least one boundary node";
        return false;
    }

    for (uint32_t row = 0; row < size_; ++row) {
        const uint32_t global_node = surface.boundary_nodes[static_cast<size_t>(row)];
        const double omega_sum = boundary_node_solid_angle_sum(ctx, global_node);
        matrix_[static_cast<size_t>(row) * size_ + row] =
            omega_sum / (4.0 * kPi) - 1.0;
    }

    for (uint32_t row = 0; row < size_; ++row) {
        const Vec3 x = node_position(ctx, surface.boundary_nodes[static_cast<size_t>(row)]);
        for (size_t face = 0; face < surface.triangles.size(); ++face) {
            const auto &tri = surface.triangles[face];
            if (tri[0] == surface.boundary_nodes[row] ||
                tri[1] == surface.boundary_nodes[row] ||
                tri[2] == surface.boundary_nodes[row]) {
                continue;
            }
            const std::array<Vec3, 3> p = {
                node_position(ctx, tri[0]),
                node_position(ctx, tri[1]),
                node_position(ctx, tri[2]),
            };
            const auto weights = lindholm_linear_triangle_weights(
                x,
                p,
                surface.triangle_areas[face],
                surface.unit_normals[face]);
            for (int local = 0; local < 3; ++local) {
                const int32_t col =
                    surface.global_to_boundary[static_cast<size_t>(tri[static_cast<size_t>(local)])];
                if (col < 0) {
                    error = "FEM/BEM dense BEM operator found a boundary face without a node map";
                    return false;
                }
                matrix_[static_cast<size_t>(row) * size_ + static_cast<size_t>(col)] +=
                    weights[static_cast<size_t>(local)];
            }
        }
    }
    return true;
}

bool DenseDemagBemOperator::apply(
    const std::vector<double> &u1_boundary,
    std::vector<double> &u2_boundary,
    std::string &error) const
{
    if (u1_boundary.size() != size_) {
        error = "FEM/BEM dense BEM operator input size mismatch";
        return false;
    }
    u2_boundary.assign(static_cast<size_t>(size_), 0.0);
    for (uint32_t row = 0; row < size_; ++row) {
        double sum = 0.0;
        for (uint32_t col = 0; col < size_; ++col) {
            sum += matrix_[static_cast<size_t>(row) * size_ + col] *
                   u1_boundary[static_cast<size_t>(col)];
        }
        u2_boundary[static_cast<size_t>(row)] = sum;
    }
    return true;
}

double demag_fem_bem_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    return demag_poisson_energy_from_field(ctx, m_xyz, h_demag_xyz, energy_threads);
}

#if FULLMAG_HAS_MFEM_STACK
bool context_initialize_demag_fem_bem(Context &ctx, std::string &error)
{
    try {
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
        if (mesh == nullptr) {
            error = "FEM/BEM demag initialization requires an MFEM mesh";
            return false;
        }

        auto workspace = std::make_unique<DemagFemBemWorkspace>();
        if (!build_demag_boundary_surface(ctx, workspace->surface, error)) {
            return false;
        }
        if (!ctx.periodic_node_pairs.empty()) {
            error = "FEM/BEM Fredkin-Koehler demag does not support periodic FEM meshes";
            return false;
        }
        if (!workspace->boundary_operator.build(ctx, workspace->surface, error)) {
            return false;
        }

        workspace->potential_fec =
            std::make_unique<mfem::H1_FECollection>(static_cast<int>(ctx.fe_order), mesh->Dimension());
        workspace->potential_fes =
            std::make_unique<mfem::FiniteElementSpace>(mesh, workspace->potential_fec.get());
        workspace->stiffness_form =
            std::make_unique<mfem::BilinearForm>(workspace->potential_fes.get());
        workspace->stiffness_form->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        workspace->stiffness_form->Assemble();
        workspace->stiffness_form->Finalize();

        if (!initialize_demag_poisson_rhs_workspace(
                ctx,
                *workspace->potential_fes,
                error)) {
            return false;
        }
        if (!initialize_demag_poisson_recovery_workspace(
                ctx,
                *workspace->potential_fes,
                error)) {
            return false;
        }

        const int true_size = workspace->potential_fes->GetTrueVSize();
        workspace->u1 = std::make_unique<mfem::Vector>(true_size);
        workspace->u2 = std::make_unique<mfem::Vector>(true_size);
        workspace->total_potential = std::make_unique<mfem::Vector>(true_size);
        workspace->boundary_values_global = std::make_unique<mfem::Vector>(true_size);
        workspace->laplace_rhs = std::make_unique<mfem::Vector>(true_size);
        *workspace->u1 = 0.0;
        *workspace->u2 = 0.0;
        *workspace->total_potential = 0.0;
        *workspace->boundary_values_global = 0.0;
        *workspace->laplace_rhs = 0.0;

        workspace->neumann_op =
            std::make_unique<mfem::SparseMatrix>(workspace->stiffness_form->SpMat());
        if (true_size <= 0) {
            error = "FEM/BEM demag potential space has no true DOFs";
            return false;
        }
        eliminate_row_col_zero(*workspace->neumann_op, 0);

        workspace->dirichlet_op =
            std::make_unique<mfem::SparseMatrix>(workspace->stiffness_form->SpMat());
        workspace->boundary_tdofs.reserve(workspace->surface.boundary_nodes.size());
        for (uint32_t node : workspace->surface.boundary_nodes) {
            if (node >= static_cast<uint32_t>(true_size)) {
                error = "FEM/BEM demag boundary node does not map to a P1 true DOF";
                return false;
            }
            workspace->boundary_tdofs.push_back(static_cast<int>(node));
        }
        std::sort(workspace->boundary_tdofs.begin(), workspace->boundary_tdofs.end());
        workspace->boundary_tdofs.erase(
            std::unique(workspace->boundary_tdofs.begin(), workspace->boundary_tdofs.end()),
            workspace->boundary_tdofs.end());
        for (int tdof : workspace->boundary_tdofs) {
            eliminate_row_col_zero(*workspace->dirichlet_op, tdof);
        }

        ctx.mfem_demag_fem_bem_workspace = workspace.release();
        ctx.demag_fem_bem_ready = true;
        return true;
    } catch (const std::exception &ex) {
        error = std::string("FEM/BEM demag initialization failed: ") + ex.what();
    } catch (...) {
        error = "FEM/BEM demag initialization failed with an unknown error";
    }
    context_destroy_demag_fem_bem(ctx);
    return false;
}

void context_destroy_demag_fem_bem(Context &ctx)
{
    destroy_demag_poisson_rhs_workspace(ctx);
    destroy_demag_poisson_recovery_workspace(ctx);
    delete static_cast<DemagFemBemWorkspace *>(ctx.mfem_demag_fem_bem_workspace);
    ctx.mfem_demag_fem_bem_workspace = nullptr;
    ctx.demag_fem_bem_ready = false;
}

bool context_compute_demag_fem_bem(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    auto *workspace = static_cast<DemagFemBemWorkspace *>(ctx.mfem_demag_fem_bem_workspace);
    if (!ctx.demag_fem_bem_ready || workspace == nullptr) {
        error = "FEM/BEM demag requested before initialization";
        return false;
    }
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    const auto assemble_start = SteadyClock::now();
    mfem::Vector *rhs = nullptr;
    if (!assemble_demag_poisson_rhs(ctx, m_xyz, rhs, error)) {
        return false;
    }
    if (rhs == nullptr) {
        error = "FEM/BEM demag RHS assembly returned a null vector";
        return false;
    }
    mfem::Vector rhs_neumann(rhs->Size());
    copy_vector(*rhs, rhs_neumann);
    rhs_neumann(0) = 0.0;
    const uint64_t assemble_ns = elapsed_ns(assemble_start);

    const auto solve_start = SteadyClock::now();
    const auto u1_solve_start = SteadyClock::now();
    if (!solve_sparse_system(
            ctx,
            *workspace->neumann_op,
            rhs_neumann,
            *workspace->u1,
            workspace->last_u1_iterations,
            workspace->last_u1_residual,
            error)) {
        return false;
    }
    const uint64_t u1_solve_ns = elapsed_ns(u1_solve_start);
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    std::vector<double> u1_boundary(workspace->surface.boundary_nodes.size(), 0.0);
    for (size_t i = 0; i < workspace->surface.boundary_nodes.size(); ++i) {
        const int tdof = static_cast<int>(workspace->surface.boundary_nodes[i]);
        u1_boundary[i] = (*workspace->u1)(tdof);
    }
    std::vector<double> u2_boundary;
    if (!workspace->boundary_operator.apply(u1_boundary, u2_boundary, error)) {
        return false;
    }

    set_boundary_values(*workspace, u2_boundary, *workspace->boundary_values_global);
    workspace->stiffness_form->SpMat().Mult(
        *workspace->boundary_values_global,
        *workspace->laplace_rhs);
    *workspace->laplace_rhs *= -1.0;
    for (int tdof : workspace->boundary_tdofs) {
        (*workspace->laplace_rhs)(tdof) = (*workspace->boundary_values_global)(tdof);
        (*workspace->u2)(tdof) = (*workspace->boundary_values_global)(tdof);
    }

    const auto u2_solve_start = SteadyClock::now();
    if (!solve_sparse_system(
            ctx,
            *workspace->dirichlet_op,
            *workspace->laplace_rhs,
            *workspace->u2,
            workspace->last_u2_iterations,
            workspace->last_u2_residual,
            error)) {
        return false;
    }
    const uint64_t u2_solve_ns = elapsed_ns(u2_solve_start);
    const uint64_t solve_ns = elapsed_ns(solve_start);
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    workspace->total_potential->SetSize(workspace->u1->Size());
    for (int i = 0; i < workspace->total_potential->Size(); ++i) {
        (*workspace->total_potential)(i) = (*workspace->u1)(i) + (*workspace->u2)(i);
    }

    uint64_t energy_ns = 0;
    const auto recover_start = SteadyClock::now();
    if (!recover_demag_poisson_field(
            ctx,
            *workspace->total_potential,
            h_demag_xyz,
            demag_energy,
            m_xyz,
            &energy_ns,
            error)) {
        return false;
    }
    const uint64_t recover_total_ns = elapsed_ns(recover_start);
    const uint64_t recover_ns = recover_total_ns > energy_ns ? recover_total_ns - energy_ns : 0;
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    ctx.demag_solves_current_step += 2u;
    ctx.poisson_last_iterations =
        std::max(0, workspace->last_u1_iterations) +
        std::max(0, workspace->last_u2_iterations);
    ctx.poisson_last_residual =
        std::max(workspace->last_u1_residual, workspace->last_u2_residual);
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_apply_wall_time_ns = u1_solve_ns + u2_solve_ns;
    ctx.poisson_last_solver_setup_reused = true;

    accumulate_fem_bem_phase_timings(
        timings,
        assemble_ns,
        solve_ns,
        u1_solve_ns + u2_solve_ns,
        recover_ns,
        energy_ns);
    return true;
}
#endif

} // namespace fullmag::fem
