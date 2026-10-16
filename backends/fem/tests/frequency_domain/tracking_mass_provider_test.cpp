#include "cpu/frequency_domain/modal/tracking_mass_provider.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <iostream>
#include <limits>
#include <memory>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    }
}

bool close(double actual, double expected)
{
    const double scale = std::max(std::abs(actual), std::abs(expected));
    return std::isfinite(actual) && std::isfinite(expected) &&
        (scale == 0.0 || std::abs(actual - expected) <= 1.0e-12 * scale);
}

std::unique_ptr<mfem::Mesh> make_tetrahedron(double scale = 1.0)
{
    auto mesh = std::make_unique<mfem::Mesh>(3, 4, 1, 0, 3);
    mesh->AddVertex(0.0, 0.0, 0.0);
    mesh->AddVertex(scale, 0.0, 0.0);
    mesh->AddVertex(0.0, scale, 0.0);
    mesh->AddVertex(0.0, 0.0, scale);
    int vertices[4]{0, 1, 2, 3};
    mesh->AddTet(vertices, 1);
    mesh->FinalizeTopology(false);
    mesh->Finalize(false, false);
    return mesh;
}

std::unique_ptr<mfem::Mesh> make_affine_wedge(double scale = 1.0)
{
    auto mesh = std::make_unique<mfem::Mesh>(3, 6, 1, 0, 3);
    mesh->AddVertex(0.0, 0.0, 0.0);
    mesh->AddVertex(scale, 0.0, 0.0);
    mesh->AddVertex(0.0, scale, 0.0);
    mesh->AddVertex(0.0, 0.0, 2.0 * scale);
    mesh->AddVertex(scale, 0.0, 2.0 * scale);
    mesh->AddVertex(0.0, scale, 2.0 * scale);
    int vertices[6]{0, 1, 2, 3, 4, 5};
    mesh->AddWedge(vertices, 1);
    mesh->FinalizeTopology(false);
    mesh->Finalize(false, false);
    return mesh;
}

std::unique_ptr<mfem::Mesh> make_flat_tetrahedron()
{
    auto mesh = std::make_unique<mfem::Mesh>(3, 4, 1, 0, 3);
    mesh->AddVertex(0.0, 0.0, 0.0);
    mesh->AddVertex(1.0, 0.0, 0.0);
    mesh->AddVertex(0.0, 1.0, 0.0);
    mesh->AddVertex(0.25, 0.25, 0.0);
    int vertices[4]{0, 1, 2, 3};
    mesh->AddTet(vertices, 1);
    mesh->FinalizeTopology(false);
    mesh->Finalize(false, false);
    return mesh;
}

std::unique_ptr<mfem::Mesh> make_magnetic_and_air_tetrahedra()
{
    auto mesh = std::make_unique<mfem::Mesh>(3, 5, 2, 0, 3);
    mesh->AddVertex(0.0, 0.0, 0.0);
    mesh->AddVertex(1.0, 0.0, 0.0);
    mesh->AddVertex(0.0, 1.0, 0.0);
    mesh->AddVertex(0.0, 0.0, 1.0);
    mesh->AddVertex(0.0, 0.0, -1.0);
    int magnetic_vertices[4]{0, 1, 2, 3};
    int air_vertices[4]{0, 2, 1, 4};
    mesh->AddTet(magnetic_vertices, 1);
    mesh->AddTet(air_vertices, 2);
    mesh->FinalizeTopology(false);
    mesh->Finalize(false, false);
    return mesh;
}

std::size_t row_for_vertex(
    const fullmag::fem::frequency_domain::TrackingMassCsrSnapshot &snapshot,
    std::uint32_t vertex)
{
    const auto &vertices = snapshot.canonical_vertex_ids();
    const auto found = std::find(vertices.begin(), vertices.end(), vertex);
    return found == vertices.end() ? vertices.size() :
        static_cast<std::size_t>(found - vertices.begin());
}

double matrix_entry(
    const fullmag::fem::frequency_domain::TrackingMassCsrSnapshot &snapshot,
    std::uint32_t row_vertex,
    std::uint32_t column_vertex)
{
    const std::size_t row = row_for_vertex(snapshot, row_vertex);
    const std::size_t column = row_for_vertex(snapshot, column_vertex);
    if (row >= snapshot.rows() || column >= snapshot.rows()) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    const auto &offsets = snapshot.row_offsets();
    const auto &columns = snapshot.column_indices();
    const auto &values = snapshot.values_m3();
    if (offsets.size() != snapshot.rows() + 1u || columns.size() != values.size() ||
        offsets.empty() || offsets.front() != 0u || offsets.back() != values.size() ||
        row >= snapshot.rows() || column >= snapshot.rows() ||
        offsets[row] > offsets[row + 1u] || offsets[row + 1u] > values.size()) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    const auto begin = columns.begin() + static_cast<std::ptrdiff_t>(offsets[row]);
    const auto end = columns.begin() + static_cast<std::ptrdiff_t>(offsets[row + 1u]);
    const auto found = std::lower_bound(begin, end, static_cast<std::uint32_t>(column));
    if (found == end || *found != column) {
        return 0.0;
    }
    return values[static_cast<std::size_t>(found - columns.begin())];
}

void check_csr_invariants(
    const fullmag::fem::frequency_domain::TrackingMassCsrSnapshot &snapshot,
    const std::vector<std::uint32_t> &active_vertices)
{
    const auto &offsets = snapshot.row_offsets();
    const auto &columns = snapshot.column_indices();
    const auto &values = snapshot.values_m3();
    check(snapshot.rows() > 0u, "snapshot contains canonical physical vertices");
    check(offsets.size() == snapshot.rows() + 1u,
        "CSR row-offset extent matches canonical physical rows");
    check(snapshot.canonical_vertex_ids().size() == snapshot.rows() &&
        snapshot.scalar_dof_ids().size() == snapshot.rows(),
        "canonical physical vertex and scalar DOF maps cover every row");

    double total = 0.0;
    if (offsets.size() != snapshot.rows() + 1u || offsets.empty() ||
        columns.size() != values.size() || offsets.front() != 0u ||
        offsets.back() != values.size()) {
        check(false, "CSR offsets and entry arrays agree");
        return;
    }
    check(true, "CSR offsets and entry arrays agree");
    for (std::size_t row = 0; row < snapshot.rows(); ++row) {
        check(snapshot.canonical_vertex_ids()[row] == static_cast<std::uint32_t>(row),
            "canonical physical vertex ids preserve full mesh ordering");
        check(snapshot.scalar_dof_ids()[row] == static_cast<std::uint32_t>(row),
            "scalar P1 DOFs preserve the exact canonical vertex map");
        if (offsets[row] > offsets[row + 1u] || offsets[row + 1u] > values.size()) {
            check(false, "CSR row offsets are monotonic and in bounds");
            return;
        }
        double row_sum = 0.0;
        std::uint32_t previous_column = 0u;
        bool first_column = true;
        bool has_positive_diagonal = false;
        for (std::size_t offset = offsets[row]; offset < offsets[row + 1u]; ++offset) {
            const std::uint32_t column = columns[offset];
            if (column >= snapshot.rows()) {
                check(false, "CSR column points to a canonical physical row");
                continue;
            }
            check(first_column || previous_column < column, "CSR columns are strictly sorted");
            check(std::isfinite(values[offset]), "CSR values are finite");
            first_column = false;
            previous_column = column;
            row_sum += values[offset];
            if (column == row && values[offset] > 0.0) {
                has_positive_diagonal = true;
            }
            const double transpose = matrix_entry(
                snapshot,
                snapshot.canonical_vertex_ids()[column],
                snapshot.canonical_vertex_ids()[row]);
            check(close(values[offset], transpose), "CSR matrix is symmetric");
        }
        const std::uint32_t vertex = snapshot.canonical_vertex_ids()[row];
        const bool active = std::find(active_vertices.begin(), active_vertices.end(), vertex) !=
            active_vertices.end();
        if (active) {
            check(has_positive_diagonal, "each magnetic row has a positive diagonal");
            check(row_sum > 0.0 && std::isfinite(row_sum), "each magnetic row sum is positive");
        } else {
            check(offsets[row] == offsets[row + 1u] && row_sum == 0.0,
                "air-only physical rows remain present and exactly zero");
        }
        total += row_sum;
    }
    check(close(total, snapshot.magnetic_volume_m3()),
        "sum of CSR entries equals the assembled magnetic volume");
}

void check_tetrahedron_coefficients()
{
    for (double scale : {1.0, 1.0e-9}) {
        auto mesh = make_tetrahedron(scale);
        mfem::H1_FECollection collection(1, 3);
        mfem::FiniteElementSpace space(mesh.get(), &collection);
        const auto result = fullmag::fem::frequency_domain::assemble_consistent_p1_tracking_mass(
            space, {1});
        check(result.ok(), "Tet4 assembles a scalar P1 tracking mass at unit and nanoscale");
        if (!result.ok()) {
            std::cerr << "Tet4 provider diagnostic: " << result.diagnostic << '\n';
            continue;
        }

        const auto &snapshot = *result.snapshot;
        check_csr_invariants(snapshot, {0u, 1u, 2u, 3u});
        const double volume = scale * scale * scale / 6.0;
        check(close(snapshot.magnetic_volume_m3(), volume),
            "Tet4 mass measures its exact SI volume at the geometry scale");
        for (std::uint32_t row = 0; row < 4u; ++row) {
            for (std::uint32_t column = 0; column < 4u; ++column) {
                const double expected = row == column ? volume / 10.0 : volume / 20.0;
                check(close(matrix_entry(snapshot, row, column), expected),
                    "Tet4 entry matches independent consistent P1 coefficients");
            }
        }
        for (std::uint32_t row = 0; row < 4u; ++row) {
            double row_sum = 0.0;
            for (std::uint32_t column = 0; column < 4u; ++column) {
                row_sum += matrix_entry(snapshot, row, column);
            }
            check(close(row_sum, volume / 4.0), "Tet4 nodal row sum is V/4");
        }
    }
}

void check_wedge_coefficients()
{
    for (double scale : {1.0, 1.0e-9}) {
        auto mesh = make_affine_wedge(scale);
        mfem::H1_FECollection collection(1, 3);
        mfem::FiniteElementSpace space(mesh.get(), &collection);
        const auto result = fullmag::fem::frequency_domain::assemble_consistent_p1_tracking_mass(
            space, {1});
        check(result.ok(), "affine Wedge6 assembles a scalar P1 tracking mass at unit and nanoscale");
        if (!result.ok()) {
            std::cerr << "Wedge6 provider diagnostic: " << result.diagnostic << '\n';
            continue;
        }

        const auto &snapshot = *result.snapshot;
        check_csr_invariants(snapshot, {0u, 1u, 2u, 3u, 4u, 5u});
        const double volume = scale * scale * scale;
        check(close(snapshot.magnetic_volume_m3(), volume),
            "Wedge6 mass measures its exact SI volume at the geometry scale");
        for (std::uint32_t row = 0; row < 6u; ++row) {
            for (std::uint32_t column = 0; column < 6u; ++column) {
                const bool same_layer = (row < 3u) == (column < 3u);
                const bool same_triangle_vertex = row % 3u == column % 3u;
                double expected = 0.0;
                if (same_layer) {
                    expected = row == column ? volume / 18.0 : volume / 36.0;
                } else {
                    expected = same_triangle_vertex ? volume / 36.0 : volume / 72.0;
                }
                check(close(matrix_entry(snapshot, row, column), expected),
                    "Wedge6 entry matches independent affine-prism integration");
            }
            double row_sum = 0.0;
            for (std::uint32_t column = 0; column < 6u; ++column) {
                row_sum += matrix_entry(snapshot, row, column);
            }
            check(close(row_sum, volume / 6.0), "Wedge6 nodal row sum is V/6");
        }
    }
}

void check_magnetic_attribute_isolation()
{
    auto mesh = make_magnetic_and_air_tetrahedra();
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(mesh.get(), &collection);
    const auto result = fullmag::fem::frequency_domain::assemble_consistent_p1_tracking_mass(
        space, {1});
    check(result.ok(), "mixed magnetic/air mesh assembles selected magnetic attributes");
    if (!result.ok()) {
        std::cerr << "mixed-domain provider diagnostic: " << result.diagnostic << '\n';
        return;
    }

    const auto &snapshot = *result.snapshot;
    check_csr_invariants(snapshot, {0u, 1u, 2u, 3u});
    check(snapshot.canonical_vertex_ids() == std::vector<std::uint32_t>({0u, 1u, 2u, 3u, 4u}),
        "snapshot preserves every canonical physical vertex, including air-only vertices");
    check(snapshot.scalar_dof_ids() == std::vector<std::uint32_t>({0u, 1u, 2u, 3u, 4u}),
        "snapshot exposes the exact full scalar P1 DOF map");
    check(matrix_entry(snapshot, 4u, 4u) == 0.0 &&
        matrix_entry(snapshot, 4u, 0u) == 0.0 &&
        snapshot.row_offsets()[4] == snapshot.row_offsets()[5],
        "air-only physical vertex has a retained empty zero CSR row");
    check(close(snapshot.magnetic_volume_m3(), 1.0 / 6.0),
        "air element volume does not enter the tracking metric");
    check(close(matrix_entry(snapshot, 0u, 0u), 1.0 / 60.0),
        "shared vertex receives only its magnetic Tet4 diagonal contribution");
    check(close(matrix_entry(snapshot, 1u, 2u), 1.0 / 120.0),
        "shared magnetic face retains consistent off-diagonal mass");
}

void check_fail_closed_requests()
{
    auto mesh = make_tetrahedron();
    mfem::H1_FECollection p1(1, 3);
    mfem::FiniteElementSpace scalar(mesh.get(), &p1);
    using fullmag::fem::frequency_domain::TrackingMassProviderStatus;
    using fullmag::fem::frequency_domain::assemble_consistent_p1_tracking_mass;

    check(assemble_consistent_p1_tracking_mass(scalar, {}).status ==
            TrackingMassProviderStatus::invalid_argument,
        "empty magnetic attribute request is rejected");
    check(assemble_consistent_p1_tracking_mass(scalar, {2}).status ==
            TrackingMassProviderStatus::invalid_argument,
        "absent magnetic attribute is rejected");
    check(assemble_consistent_p1_tracking_mass(scalar, {1, 1}).status ==
            TrackingMassProviderStatus::invalid_argument,
        "duplicate magnetic attributes are rejected");

    mfem::FiniteElementSpace vector(mesh.get(), &p1, 3);
    check(assemble_consistent_p1_tracking_mass(vector, {1}).status ==
            TrackingMassProviderStatus::unsupported_space,
        "vector finite-element space cannot masquerade as scalar P1");

    mfem::H1_FECollection p2(2, 3);
    mfem::FiniteElementSpace higher_order(mesh.get(), &p2);
    check(assemble_consistent_p1_tracking_mass(higher_order, {1}).status ==
            TrackingMassProviderStatus::unsupported_space,
        "higher-order finite-element space is rejected instead of being projected");

    auto flat_mesh = make_flat_tetrahedron();
    mfem::FiniteElementSpace flat_space(flat_mesh.get(), &p1);
    const auto flat_result = assemble_consistent_p1_tracking_mass(flat_space, {1});
    check(flat_result.status == TrackingMassProviderStatus::invalid_matrix &&
            flat_result.snapshot == nullptr,
        "degenerate Tet4 geometry is rejected before producing a tracking snapshot");
}

} // namespace

int main()
{
    check_tetrahedron_coefficients();
    check_wedge_coefficients();
    check_magnetic_attribute_isolation();
    check_fail_closed_requests();
    if (failures != 0) {
        std::cerr << "Tracking mass provider contract failed with " << failures << " assertion(s)\n";
        return 1;
    }
    std::cout << "PASS: fem_tracking_mass_provider_geometric_csr_contract\n";
    return 0;
}
