#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"
#include "cpu/mfem/interactions/oersted/surface_rt0.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <initializer_list>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using fullmag::fem::oersted::DirectTetraQuadrature;
using fullmag::fem::oersted::DirectTetraQuadratureOptions;

void require(bool condition, const char *message)
{
    if (!condition) throw std::runtime_error(message);
}

void direct_tetra_signed_current_and_budget_contract()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);

    const std::vector<std::array<double, 3>> targets{
        {2.0, 0.5, 0.5}, {2.0, 0.25, 0.75}};
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 4;
    options.maximum_subdivision_depth = 3;
    options.relative_tolerance = 1.0e-5;
    options.absolute_tolerance_apm = 1.0e-10;
    const auto forward = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    require(forward.operator_version ==
            DirectTetraQuadrature::operator_version,
        "direct tetrahedral Oersted operator version is not frozen");
    require(forward.h_xyz_apm.size() == targets.size() * 3u &&
            forward.diagnostics.source_target_pairs ==
                static_cast<std::uint64_t>(mesh.GetNE()) * targets.size(),
        "direct tetrahedral Oersted result dimensions are wrong");
    require(forward.diagnostics.unconverged_pair_count == 0,
        "far direct tetrahedral Oersted pair did not converge");
    require(std::all_of(forward.h_xyz_apm.begin(), forward.h_xyz_apm.end(),
            [](double value) { return std::isfinite(value); }),
        "direct tetrahedral Oersted result contains a non-finite value");

    struct Progress {
        std::uint64_t calls = 0, completed = 0;
        bool valid = true;
        std::uint64_t expected_total, expected_cells;
    } progress{0, 0, true, targets.size(), static_cast<std::uint64_t>(mesh.GetNE())};
    const fullmag::fem::oersted::SurfaceRt0ProgressObserver observer{&progress,
        [](void *context, fullmag::fem::oersted::AntennaProgressPhase phase,
            std::uint64_t completed, std::uint64_t total, std::uint64_t cells) noexcept {
            auto &p = *static_cast<Progress *>(context);
            p.valid = p.valid && phase == fullmag::fem::oersted::AntennaProgressPhase::evaluating_field &&
                completed == p.calls && total == p.expected_total && cells == p.expected_cells;
            ++p.calls;
            p.completed = completed;
        }};
    const auto observed = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options, &observer);
    require(observed.h_xyz_apm == forward.h_xyz_apm &&
            observed.diagnostics.kernel_evaluations == forward.diagnostics.kernel_evaluations &&
            observed.diagnostics.ledger_leaf_visits == forward.diagnostics.ledger_leaf_visits,
        "observer changed direct quadrature output or work");
    require(progress.valid && progress.calls == targets.size() + 1 &&
            progress.completed == targets.size(),
        "direct progress must report initial zero and each completed target exactly once");

    current *= -1.0;
    const auto reversed = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    for (std::size_t i = 0; i < forward.h_xyz_apm.size(); ++i) {
        require(std::abs(reversed.h_xyz_apm[i] + forward.h_xyz_apm[i]) <=
                1.0e-13 * std::max(1.0, std::abs(forward.h_xyz_apm[i])),
            "direct tetrahedral Oersted failed signed-current involution");
    }
    const auto repeat = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    require(repeat.h_xyz_apm == reversed.h_xyz_apm,
        "direct tetrahedral Oersted accumulation is not deterministic");

    options.maximum_source_target_pairs = 1;
    const auto calls_before_refusal = progress.calls;
    bool rejected = false;
    try {
        (void)DirectTetraQuadrature::EvaluateField(mesh, current, targets, options, &observer);
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected,
        "direct tetrahedral Oersted did not reject an exceeded pair budget");
    require(progress.calls == calls_before_refusal,
        "admission refusal must not report completed field targets");
}

void direct_tetra_explicit_volume_profile_contract()
{
    DirectTetraQuadratureOptions options;
    const auto legacy = DirectTetraQuadrature::ResolveWorkLimits(options);
    require(legacy.maximum_kernel_evaluations == 100'000'000 &&
            legacy.maximum_ledger_leaf_visits == 100'000'000,
        "default direct tetra work limits changed");
    auto restricted_legacy = options;
    restricted_legacy.maximum_source_target_pairs = 1;
    restricted_legacy.base_quadrature_order = 16;
    restricted_legacy.maximum_subdivision_depth = 0;
    restricted_legacy.absolute_tolerance_apm = 0.0;
    restricted_legacy.relative_tolerance = 0.0;
    require(DirectTetraQuadrature::ResolveWorkLimits(restricted_legacy).maximum_kernel_evaluations == 100'000'000,
        "legacy restricted pair limits or generic quadrature options changed");
    auto reject = [](const DirectTetraQuadratureOptions &bad) {
        bool rejected = false;
        try { (void)DirectTetraQuadrature::ResolveWorkLimits(bad); }
        catch (const std::invalid_argument &) { rejected = true; }
        require(rejected, "direct tetra accepted an unknown or mixed work profile");
    };
    for (const auto limit : {std::uint64_t{0}, std::uint64_t{1'000'001},
            std::uint64_t{3'999'999}, std::uint64_t{4'000'001},
            std::numeric_limits<std::uint64_t>::max()}) {
        auto bad = options; bad.maximum_source_target_pairs = limit; reject(bad);
    }
    options.maximum_source_target_pairs = 4'000'000;
    const auto volume = DirectTetraQuadrature::ResolveWorkLimits(options);
    require(volume.maximum_kernel_evaluations == 500'000'000 &&
            volume.maximum_ledger_leaf_visits == 500'000'000 &&
            DirectTetraQuadrature::maximum_final_leaves_per_target == 1'000'000,
        "explicit volume work limits differ from the approved tuple");
    auto bad = options; bad.base_quadrature_order = 6; reject(bad);
    bad = options; bad.maximum_subdivision_depth = 5; reject(bad);
    bad = options; bad.absolute_tolerance_apm = std::nextafter(1.0e-9, 0.0); reject(bad);
    bad = options; bad.relative_tolerance = std::nextafter(1.0e-5, 0.0); reject(bad);

    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3); vector = 0.0; vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);
    const std::vector<std::array<double, 3>> targets{{2.0, 0.5, 0.5}, {2.0, 0.25, 0.75}};
    const auto legacy_result = DirectTetraQuadrature::EvaluateField(mesh, current, targets);
    const auto volume_result = DirectTetraQuadrature::EvaluateField(mesh, current, targets, options);
    require(volume_result.h_xyz_apm == legacy_result.h_xyz_apm &&
            volume_result.diagnostics.kernel_evaluations == legacy_result.diagnostics.kernel_evaluations &&
            volume_result.diagnostics.ledger_leaf_visits == legacy_result.diagnostics.ledger_leaf_visits,
        "volume work limits changed quadrature or field values below the legacy cap");
    std::uint64_t samples = 0, visits = 0;
    for (const auto &target : volume_result.target_diagnostics) {
        samples += target.kernel_evaluations; visits += target.ledger_leaf_visits;
    }
    require(samples == volume_result.diagnostics.kernel_evaluations &&
            visits == volume_result.diagnostics.ledger_leaf_visits &&
            samples > volume_result.target_diagnostics.front().kernel_evaluations &&
            visits > volume_result.target_diagnostics.front().ledger_leaf_visits,
        "direct tetra work counters did not retain all targets");

    // Stop at coordinate validation: admission is tested without a multi-million-pair solve.
    const auto admission_error = [&](std::size_t count, const DirectTetraQuadratureOptions &policy) {
        std::vector<std::array<double, 3>> invalid_targets(count, targets.front());
        invalid_targets.front()[0] = std::numeric_limits<double>::quiet_NaN();
        try { (void)DirectTetraQuadrature::EvaluateField(mesh, current, invalid_targets, policy); }
        catch (const std::invalid_argument &error) { return std::string(error.what()); }
        throw std::runtime_error("nonfinite admission fixture was accepted");
    };
    const auto source_count = static_cast<std::size_t>(mesh.GetNE());
    const auto large_count = 1'000'000u / source_count + 1u;
    require(admission_error(large_count, {}).find("pair budget exceeded") != std::string::npos &&
            admission_error(large_count, options).find("target is non-finite") != std::string::npos &&
            admission_error(4'000'000u / source_count, options).find("target is non-finite") != std::string::npos &&
            admission_error(4'000'000u / source_count + 1u, options).find("pair budget exceeded") != std::string::npos,
        "explicit volume pair admission is not bounded independently from the legacy profile");
}

void direct_tetra_singular_target_contract()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);

    mfem::Array<int> vertices;
    mesh.GetElementVertices(0, vertices);
    require(vertices.Size() == 4,
        "singular-target fixture must start from a tetrahedron");
    std::array<std::array<double, 3>, 4> points{};
    for (int local = 0; local < 4; ++local) {
        const auto *coordinate = mesh.GetVertex(vertices[local]);
        points[local] = {coordinate[0], coordinate[1], coordinate[2]};
    }
    const auto average = [&](std::initializer_list<int> indices) {
        std::array<double, 3> result{0.0, 0.0, 0.0};
        for (const int index : indices) {
            for (int component = 0; component < 3; ++component) {
                result[component] += points[index][component];
            }
        }
        const double scale = 1.0 / static_cast<double>(indices.size());
        for (double &component : result) component *= scale;
        return result;
    };

    const std::vector<std::array<double, 3>> targets{
        average({0, 1, 2, 3}), // interior
        average({0, 1, 2}),    // face
        average({0, 1}),        // edge
    };
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 8;
    options.maximum_subdivision_depth = 6;
    options.absolute_tolerance_apm = 1.0e-9;
    options.relative_tolerance = 1.0e-5;
    std::cerr << "OE-F1 CASE singular_targets q8_depth6\n";
    const auto result = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, options);
    require(result.diagnostics.unconverged_pair_count == 0,
        "singular-target Oersted quadrature did not converge");
    require(std::all_of(result.h_xyz_apm.begin(), result.h_xyz_apm.end(),
            [](double value) { return std::isfinite(value); }),
        "singular-target Oersted result contains a non-finite value");
    require(result.diagnostics.refined_pairs > 0,
        "singular-target Oersted did not exercise adaptive refinement");

    auto bounded = options;
    bounded.maximum_subdivision_depth = 0;
    bool rejected = false;
    std::string failure;
    std::cerr << "OE-F1 CASE singular_targets bounded_depth0\n";
    std::ostringstream failure_log;
    auto *previous_stderr = std::cerr.rdbuf(failure_log.rdbuf());
    try {
        (void)DirectTetraQuadrature::EvaluateField(
            mesh, current, {targets.front()}, bounded);
    } catch (const std::runtime_error &error) {
        rejected = true;
        failure = error.what();
    } catch (...) {
        std::cerr.rdbuf(previous_stderr);
        throw;
    }
    std::cerr.rdbuf(previous_stderr);
    require(rejected,
        "singular-target Oersted silently accepted an exhausted depth budget");
    require(failure.find("global_target_depth_exhausted; target_m=(") == 0 &&
            failure.find("estimated_error_apm=") != std::string::npos,
        "additive failure diagnostics changed the original exception");
    const auto text = failure_log.str();
    require(text.find("[oersted_failure_v1] reason=global_target_depth_exhausted;") == 0 &&
            text.size() <= 480 && std::count(text.begin(), text.end(), '\n') == 1 &&
            text.find("depth_limited=" + std::to_string(mesh.GetNE())) != std::string::npos &&
            text.find("unresolved=0") != std::string::npos &&
            text.find("depth_error_apm=") != std::string::npos &&
            text.find("top_s_d_e_r=[") != std::string::npos &&
            text.size() >= 2 && text.substr(text.size() - 2) == "]\n",
        "failure diagnostics are missing, unbounded or incomplete");
    const auto top_begin = text.find("top_s_d_e_r=[") + std::string("top_s_d_e_r=[").size();
    std::istringstream rows(text.substr(top_begin, text.size() - top_begin - 2));
    std::string row;
    std::vector<std::size_t> source_indices;
    double previous_error = std::numeric_limits<double>::infinity();
    while (std::getline(rows, row, ';')) {
        std::replace(row.begin(), row.end(), ',', ' ');
        std::istringstream columns(row);
        std::size_t source_index;
        int depth;
        double error;
        char rule;
        require(static_cast<bool>(columns >> source_index >> depth >> error >> rule),
            "failure dominant-leaf tuple cannot be decoded");
        require(source_index < static_cast<std::size_t>(mesh.GetNE()) && depth == 0 &&
                std::isfinite(error) && error >= 0.0 && error <= previous_error &&
                (rule == 'D' || rule == 'R' || rule == 'U') &&
                std::find(source_indices.begin(), source_indices.end(), source_index) == source_indices.end(),
            "failure dominant leaves are not distinct ordered source roots");
        source_indices.push_back(source_index);
        previous_error = error;
    }
    require(source_indices.size() == 3,
        "failure diagnostics did not retain exactly three dominant roots");

    auto convergence_options = options;
    convergence_options.maximum_subdivision_depth = 4;
    std::cerr << "OE-F1 CASE singular_targets convergence_depth4\n";
    const auto coarse = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, convergence_options);
    for (std::size_t index = 0; index < result.h_xyz_apm.size(); ++index) {
        require(std::abs(coarse.h_xyz_apm[index] - result.h_xyz_apm[index]) <=
                5.0e-5 * std::max(1.0, std::abs(result.h_xyz_apm[index])),
            "singular-target Oersted failed independent depth convergence");
    }

    DirectTetraQuadratureOptions defaults;
    std::cerr << "OE-F1 CASE singular_targets default_options\n";
    const auto default_result = DirectTetraQuadrature::EvaluateField(
        mesh, current, targets, defaults);
    require(default_result.diagnostics.unconverged_pair_count == 0,
        "default singular-target Oersted options did not converge");
}

void direct_tetra_consistent_h1_projection_contract()
{
    auto source_mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    auto target_mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    for (int vertex = 0; vertex < target_mesh.GetNV(); ++vertex) {
        target_mesh.GetVertex(vertex)[0] += 2.0;
    }
    mfem::RT_FECollection source_collection(0, 3);
    mfem::FiniteElementSpace source_space(&source_mesh, &source_collection);
    mfem::GridFunction current(&source_space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);

    mfem::H1_FECollection target_collection(1, 3);
    mfem::FiniteElementSpace target_space(
        &target_mesh, &target_collection, 3, mfem::Ordering::byVDIM);
    mfem::GridFunction projected(&target_space);
    projected = 0.0;
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 4;
    options.maximum_subdivision_depth = 4;
    options.relative_tolerance = 1.0e-5;
    const auto diagnostics = DirectTetraQuadrature::ProjectField(
        current, projected, options);
    require(diagnostics.unconverged_pair_count == 0,
        "consistent H1 projection left unconverged source pairs");
    require(diagnostics.source_target_pairs > 0,
        "consistent H1 projection did not evaluate direct source pairs");
    DirectTetraQuadratureOptions volume;
    volume.maximum_source_target_pairs = 4'000'000;
    bool volume_rejected = false;
    try { (void)DirectTetraQuadrature::ProjectField(current, projected, volume); }
    catch (const std::invalid_argument &) { volume_rejected = true; }
    require(volume_rejected, "H1 projection accepted the inspection-only volume profile");
    require(std::all_of(projected.begin(), projected.end(),
            [](double value) { return std::isfinite(value); }),
        "consistent H1 projection produced a non-finite field");
}

std::array<double, 3> linear_current_field_at_resolution(
    int subdivisions,
    int quadrature_order,
    int maximum_subdivision_depth)
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        subdivisions, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::VectorFunctionCoefficient coefficient(3,
        [](const mfem::Vector &point, mfem::Vector &value) {
            value = 0.0;
            value[0] = 4.0 + 2.0 * point[0];
        });
    current.ProjectCoefficient(coefficient);

    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = quadrature_order;
    options.maximum_subdivision_depth = maximum_subdivision_depth;
    options.relative_tolerance = 1.0e-8;
    options.absolute_tolerance_apm = 1.0e-11;
    const auto result = DirectTetraQuadrature::EvaluateField(
        mesh, current, {{2.5, 0.37, 0.61}}, options);
    require(result.diagnostics.unconverged_pair_count == 0,
        "linear-current h-refinement left unconverged source pairs");
    require(result.h_xyz_apm.size() == 3u,
        "linear-current h-refinement returned an invalid field length");
    return {result.h_xyz_apm[0], result.h_xyz_apm[1], result.h_xyz_apm[2]};
}

void direct_tetra_h_refinement_contract()
{
    const auto reference = linear_current_field_at_resolution(16, 8, 6);
    const auto coarse = linear_current_field_at_resolution(1, 8, 6);
    const auto medium = linear_current_field_at_resolution(2, 8, 6);
    const auto fine = linear_current_field_at_resolution(4, 8, 6);
    const auto distance = [](const std::array<double, 3> &lhs,
                             const std::array<double, 3> &rhs) {
        double squared = 0.0;
        for (int component = 0; component < 3; ++component) {
            const double delta = lhs[component] - rhs[component];
            squared += delta * delta;
        }
        return std::sqrt(squared);
    };
    const double coarse_error = distance(coarse, reference);
    const double medium_error = distance(medium, reference);
    const double fine_error = distance(fine, reference);
    require(std::isfinite(coarse_error) && std::isfinite(medium_error) &&
                std::isfinite(fine_error),
        "linear-current h-refinement produced a non-finite error");
    std::cerr << "OE-F1 h-refinement errors: coarse=" << coarse_error
              << " medium=" << medium_error << " fine=" << fine_error << '\n';
    require(fine_error < coarse_error,
        "direct tetrahedral OE-F1 failed h-refinement improvement");

    const auto low_order = linear_current_field_at_resolution(4, 3, 6);
    const auto high_order = linear_current_field_at_resolution(4, 8, 6);
    const double order_error = distance(low_order, high_order);
    require(order_error <= 1.0e-7 * std::max(1.0, distance(high_order,
        std::array<double, 3>{0.0, 0.0, 0.0})),
        "direct tetrahedral OE-F1 quadrature order changed the converged far field");
}

std::array<double, 3> fdm_midpoint_uniform_cube_field(int subdivisions)
{
    require(subdivisions > 0, "FDM midpoint benchmark requires a positive resolution");
    const double cell_size = 1.0 / static_cast<double>(subdivisions);
    const double volume = cell_size * cell_size * cell_size;
    const std::array<double, 3> target{2.5, 0.37, 0.61};
    const std::array<double, 3> current{4.0, 0.0, 0.0};
    std::array<double, 3> field{0.0, 0.0, 0.0};
    constexpr double pi = 3.141592653589793238462643383279502884;
    for (int z = 0; z < subdivisions; ++z) {
        for (int y = 0; y < subdivisions; ++y) {
            for (int x = 0; x < subdivisions; ++x) {
                const std::array<double, 3> center{
                    (static_cast<double>(x) + 0.5) * cell_size,
                    (static_cast<double>(y) + 0.5) * cell_size,
                    (static_cast<double>(z) + 0.5) * cell_size};
                const std::array<double, 3> displacement{
                    target[0] - center[0], target[1] - center[1],
                    target[2] - center[2]};
                const double radius_squared = displacement[0] * displacement[0] +
                    displacement[1] * displacement[1] +
                    displacement[2] * displacement[2];
                const double inverse_radius_cubed =
                    1.0 / (radius_squared * std::sqrt(radius_squared));
                const std::array<double, 3> cross{
                    current[1] * displacement[2] - current[2] * displacement[1],
                    current[2] * displacement[0] - current[0] * displacement[2],
                    current[0] * displacement[1] - current[1] * displacement[0]};
                for (int component = 0; component < 3; ++component) {
                    field[component] += volume * cross[component] *
                        inverse_radius_cubed / (4.0 * pi);
                }
            }
        }
    }
    return field;
}

std::array<double, 3> fem_direct_uniform_cube_field(int subdivisions)
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        subdivisions, subdivisions, subdivisions,
        mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 8;
    options.maximum_subdivision_depth = 6;
    options.relative_tolerance = 1.0e-7;
    options.absolute_tolerance_apm = 1.0e-10;
    const auto result = DirectTetraQuadrature::EvaluateField(
        mesh, current, {{2.5, 0.37, 0.61}}, options);
    require(result.diagnostics.unconverged_pair_count == 0,
        "FEM/FDM common-limit benchmark left unconverged source pairs");
    require(result.h_xyz_apm.size() == 3u &&
            std::all_of(result.h_xyz_apm.begin(), result.h_xyz_apm.end(),
                [](double value) { return std::isfinite(value); }),
        "FEM/FDM common-limit benchmark returned a non-finite FEM field");
    return {result.h_xyz_apm[0], result.h_xyz_apm[1], result.h_xyz_apm[2]};
}

double field_distance(
    const std::array<double, 3> &left,
    const std::array<double, 3> &right)
{
    double squared = 0.0;
    for (int component = 0; component < 3; ++component) {
        const double delta = left[component] - right[component];
        squared += delta * delta;
    }
    return std::sqrt(squared);
}

void direct_tetra_fdm_midpoint_common_limit_contract()
{
    const auto fem_coarse = fem_direct_uniform_cube_field(1);
    const auto fem_medium = fem_direct_uniform_cube_field(2);
    const auto fem_fine = fem_direct_uniform_cube_field(4);
    const auto fem_oracle = fem_direct_uniform_cube_field(8);
    const auto fdm_coarse = fdm_midpoint_uniform_cube_field(1);
    const auto fdm_medium = fdm_midpoint_uniform_cube_field(2);
    const auto fdm_fine = fdm_midpoint_uniform_cube_field(4);
    const auto fdm_finest = fdm_midpoint_uniform_cube_field(8);

    const double fem_coarse_error = field_distance(fem_coarse, fem_oracle);
    const double fem_medium_error = field_distance(fem_medium, fem_oracle);
    const double fem_fine_error = field_distance(fem_fine, fem_oracle);
    const double fdm_coarse_error = field_distance(fdm_coarse, fem_oracle);
    const double fdm_medium_error = field_distance(fdm_medium, fem_oracle);
    const double fdm_fine_error = field_distance(fdm_fine, fem_oracle);
    const double fdm_finest_error = field_distance(fdm_finest, fem_oracle);
    const double cross_method_fine_error = field_distance(fem_fine, fdm_fine);
    const double cross_method_coarse_error = field_distance(fem_coarse, fdm_coarse);
    std::cerr << "FEM/FDM Oersted common-limit diagnostics: FEM coarse="
              << fem_coarse_error << " medium=" << fem_medium_error
              << " fine=" << fem_fine_error << "; FDM coarse="
              << fdm_coarse_error << " medium=" << fdm_medium_error
              << " fine=" << fdm_fine_error << " finest="
              << fdm_finest_error << "; cross coarse="
              << cross_method_coarse_error << " fine="
              << cross_method_fine_error << '\n';
    require(std::isfinite(fem_coarse_error) &&
            std::isfinite(fem_medium_error) && std::isfinite(fem_fine_error) &&
            std::isfinite(fdm_coarse_error) && std::isfinite(fdm_medium_error) &&
            std::isfinite(fdm_fine_error) && std::isfinite(fdm_finest_error),
        "FEM/FDM common-limit benchmark produced a non-finite error");
    require(fem_fine_error < fem_coarse_error &&
            fdm_fine_error < fdm_coarse_error,
        "FEM/FDM common-limit benchmark did not improve under h-refinement");
    require(cross_method_fine_error < cross_method_coarse_error,
        "FEM/FDM common-limit discrepancy did not decrease under h-refinement");
    require(field_distance(fdm_finest, fem_oracle) < fdm_coarse_error,
        "FDM midpoint finest field did not approach the FEM reference oracle");
}

void direct_tetra_multithread_is_bit_exact_and_observer_monotonic()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        4, 4, 4, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    require(mesh.GetNE() == 384, "4x4x4 tetrahedral fixture must contain 384 elements");
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::VectorFunctionCoefficient coefficient(3,
        [](const mfem::Vector &point, mfem::Vector &value) {
            value[0] = 4.0 + 0.5 * point[0];
            value[1] = -1.5 * point[1];
            value[2] = 0.75 * point[2];
        });
    current.ProjectCoefficient(coefficient);

    mfem::Array<int> verts;
    mesh.GetElementVertices(0, verts);
    require(verts.Size() == 4, "element 0 must be a tetrahedron");
    std::array<std::array<double, 3>, 4> v{};
    for (int local = 0; local < 4; ++local) {
        const auto *coord = mesh.GetVertex(verts[local]);
        v[local] = {coord[0], coord[1], coord[2]};
    }
    const auto avg = [&](std::initializer_list<int> idx) {
        std::array<double, 3> out{0.0, 0.0, 0.0};
        for (int i : idx) {
            for (int c = 0; c < 3; ++c) out[c] += v[i][c];
        }
        const double inv = 1.0 / static_cast<double>(idx.size());
        for (double &c : out) c *= inv;
        return out;
    };

    std::vector<std::array<double, 3>> many_targets{
        avg({0, 1, 2, 3}), // interior
        avg({0, 1, 2}),    // face
        avg({0, 1}),       // edge
        v[0],              // vertex
        {-0.15, 0.20, 0.30},
        {1.15, 0.40, 0.60},
        {0.30, -0.15, 0.70},
        {0.60, 0.80, 1.15},
    };
    for (int i = 0; i < 24; ++i) {
        many_targets.push_back({
            2.0 + 0.25 * static_cast<double>(i % 6),
            0.10 + 0.25 * static_cast<double>((i / 6) % 4),
            0.20 + 0.15 * static_cast<double>(i % 5)});
    }
    require(many_targets.size() == 32u, "scenario (a) must contain 32 targets");

    const std::vector<std::array<double, 3>> few_targets{
        {2.25, 0.35, 0.65},
        avg({0, 1, 2, 3}),
    };

    const auto run_observed = [&](const std::vector<std::array<double, 3>> &targets,
                                  int worker_threads) {
        DirectTetraQuadratureOptions options;
        options.base_quadrature_order = 4;
        options.maximum_subdivision_depth = 6;
        options.absolute_tolerance_apm = 1.0e-9;
        options.relative_tolerance = 1.0e-5;
        options.worker_threads = worker_threads;
        options.execution_policy =
            fullmag::fem::oersted::DirectTetraExecutionPolicy::CpuDeterministic;

        struct Progress {
            std::atomic<int> active{0};
            std::uint64_t calls = 0;
            std::uint64_t completed = 0;
            bool valid = true;
            bool reentrant = false;
            std::uint64_t expected_total = 0;
            std::uint64_t expected_cells = 0;
        } progress;
        progress.expected_total = static_cast<std::uint64_t>(targets.size());
        progress.expected_cells = static_cast<std::uint64_t>(mesh.GetNE());

        const fullmag::fem::oersted::SurfaceRt0ProgressObserver observer{&progress,
            [](void *context, fullmag::fem::oersted::AntennaProgressPhase phase,
                std::uint64_t completed, std::uint64_t total, std::uint64_t cells) noexcept {
                auto &p = *static_cast<Progress *>(context);
                if (p.active.fetch_add(1, std::memory_order_acq_rel) != 0) {
                    p.reentrant = true;
                }
                p.valid = p.valid &&
                    phase == fullmag::fem::oersted::AntennaProgressPhase::evaluating_field &&
                    completed == p.calls && total == p.expected_total && cells == p.expected_cells;
                ++p.calls;
                p.completed = completed;
                p.active.fetch_sub(1, std::memory_order_acq_rel);
            }};

        auto res = DirectTetraQuadrature::EvaluateField(mesh, current, targets, options, &observer);
        require(!progress.reentrant && progress.valid &&
                progress.calls == static_cast<std::uint64_t>(targets.size()) + 1u &&
                progress.completed == static_cast<std::uint64_t>(targets.size()),
            "multithreaded observer must be strictly monotonic and non-reentrant");
        std::uint64_t sample_sum = 0;
        std::uint64_t visit_sum = 0;
        for (const auto &td : res.target_diagnostics) {
            sample_sum += td.kernel_evaluations;
            visit_sum += td.ledger_leaf_visits;
        }
        require(sample_sum == res.diagnostics.kernel_evaluations &&
                visit_sum == res.diagnostics.ledger_leaf_visits,
            "aggregate kernel_evaluations/ledger_leaf_visits must equal exact sum over targets");
        require(res.diagnostics.effective_worker_threads == worker_threads,
            "effective_worker_threads did not match requested CPU thread count");
        require(res.diagnostics.resolved_execution_policy == "cpu_deterministic",
            "resolved_execution_policy must report cpu_deterministic");
        return res;
    };

    const auto require_bit_exact = [](const auto &baseline, const auto &candidate) {
        require(baseline.h_xyz_apm.size() == candidate.h_xyz_apm.size() &&
                std::memcmp(baseline.h_xyz_apm.data(), candidate.h_xyz_apm.data(),
                    baseline.h_xyz_apm.size() * sizeof(double)) == 0,
            "multithreaded CPU DTQ field is not 0-ULP bit-exact with single-threaded baseline");
        require(baseline.diagnostics.kernel_evaluations == candidate.diagnostics.kernel_evaluations &&
                baseline.diagnostics.ledger_leaf_visits == candidate.diagnostics.ledger_leaf_visits &&
                baseline.diagnostics.refined_pairs == candidate.diagnostics.refined_pairs &&
                baseline.diagnostics.unconverged_pair_count == 0 &&
                candidate.diagnostics.unconverged_pair_count == 0 &&
                std::memcmp(&baseline.diagnostics.maximum_pair_error_apm,
                    &candidate.diagnostics.maximum_pair_error_apm, sizeof(double)) == 0,
            "multithreaded CPU DTQ diagnostics diverged from single-threaded baseline");
        require(baseline.target_diagnostics.size() == candidate.target_diagnostics.size(),
            "multithreaded target_diagnostics size mismatch");
        for (std::size_t t = 0; t < baseline.target_diagnostics.size(); ++t) {
            const auto &a = baseline.target_diagnostics[t];
            const auto &b = candidate.target_diagnostics[t];
            require(std::memcmp(&a.estimated_error_apm, &b.estimated_error_apm, sizeof(double)) == 0 &&
                    std::memcmp(&a.tolerance_apm, &b.tolerance_apm, sizeof(double)) == 0 &&
                    std::memcmp(&a.roundoff_indicator_apm, &b.roundoff_indicator_apm, sizeof(double)) == 0 &&
                    a.final_leaf_count == b.final_leaf_count &&
                    a.kernel_evaluations == b.kernel_evaluations &&
                    a.ledger_leaf_visits == b.ledger_leaf_visits,
                "multithreaded target_diagnostics entry diverged from single-threaded baseline");
        }
    };

    const auto many_w1 = run_observed(many_targets, 1);
    const auto many_w4 = run_observed(many_targets, 4);
    const auto many_w8 = run_observed(many_targets, 8);
    require_bit_exact(many_w1, many_w4);
    require_bit_exact(many_w1, many_w8);

    const auto few_w1 = run_observed(few_targets, 1);
    const auto few_w4 = run_observed(few_targets, 4);
    const auto few_w8 = run_observed(few_targets, 8);
    require_bit_exact(few_w1, few_w4);
    require_bit_exact(few_w1, few_w8);

    DirectTetraQuadratureOptions invalid_threads;
    invalid_threads.worker_threads = -1;
    bool rejected = false;
    try {
        (void)DirectTetraQuadrature::ResolveWorkLimits(invalid_threads);
    } catch (const std::invalid_argument &) {
        rejected = true;
    }
    require(rejected, "negative worker_threads must be rejected");
}

void direct_tetra_parallel_budget_exceeded_fails_cleanly()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        4, 4, 4, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vec(3);
    vec = 0.0;
    vec[0] = 4.0;
    mfem::VectorConstantCoefficient coeff(vec);
    current.ProjectCoefficient(coeff);

    mfem::Array<int> verts;
    mesh.GetElementVertices(0, verts);
    std::array<std::array<double, 3>, 4> v{};
    for (int local = 0; local < 4; ++local) {
        const auto *coord = mesh.GetVertex(verts[local]);
        v[local] = {coord[0], coord[1], coord[2]};
    }
    const std::array<double, 3> interior{
        0.25 * (v[0][0] + v[1][0] + v[2][0] + v[3][0]),
        0.25 * (v[0][1] + v[1][1] + v[2][1] + v[3][1]),
        0.25 * (v[0][2] + v[1][2] + v[2][2] + v[3][2])};

    std::vector<std::array<double, 3>> targets(16, interior);
    for (std::size_t i = 0; i < 8; ++i) {
        targets[i] = {2.0 + 0.1 * static_cast<double>(i), 0.5, 0.5};
    }

    // (a) Tight pair budget rejected cleanly before launching threads.
    DirectTetraQuadratureOptions pair_capped;
    pair_capped.worker_threads = 4;
    pair_capped.maximum_source_target_pairs = 10;
    bool pair_rejected = false;
    try {
        (void)DirectTetraQuadrature::EvaluateField(mesh, current, targets, pair_capped);
    } catch (const std::invalid_argument &) {
        pair_rejected = true;
    }
    require(pair_rejected, "parallel DTQ did not reject exceeded pair budget");

    // (b) Concurrent worker failure under target-level parallelism (N_t = 16, W = 4).
    DirectTetraQuadratureOptions depth_capped;
    depth_capped.base_quadrature_order = 8;
    depth_capped.maximum_subdivision_depth = 0;
    depth_capped.worker_threads = 4;
    bool parallel_failed = false;
    std::string parallel_error;
    std::ostringstream captured_stderr;
    auto *prev_stderr = std::cerr.rdbuf(captured_stderr.rdbuf());
    try {
        (void)DirectTetraQuadrature::EvaluateField(mesh, current, targets, depth_capped);
    } catch (const std::runtime_error &error) {
        parallel_failed = true;
        parallel_error = error.what();
    } catch (...) {
        std::cerr.rdbuf(prev_stderr);
        throw;
    }
    std::cerr.rdbuf(prev_stderr);
    require(parallel_failed &&
            parallel_error.find("global_target_depth_exhausted") != std::string::npos,
        "target-parallel failure did not propagate std::runtime_error cleanly");

    // (c) Failure under source-root parallelism (N_t = 2, W = 4).
    const std::vector<std::array<double, 3>> two_targets{{2.0, 0.5, 0.5}, interior};
    bool root_parallel_failed = false;
    prev_stderr = std::cerr.rdbuf(captured_stderr.rdbuf());
    try {
        (void)DirectTetraQuadrature::EvaluateField(mesh, current, two_targets, depth_capped);
    } catch (const std::runtime_error &) {
        root_parallel_failed = true;
    } catch (...) {
        std::cerr.rdbuf(prev_stderr);
        throw;
    }
    std::cerr.rdbuf(prev_stderr);
    require(root_parallel_failed,
        "source-root-parallel failure did not propagate std::runtime_error cleanly");
}

void direct_tetra_project_field_single_pass_parity()
{
    auto source_mesh = mfem::Mesh::MakeCartesian3D(
        2, 2, 2, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    auto target_mesh = mfem::Mesh::MakeCartesian3D(
        2, 2, 2, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    for (int vertex = 0; vertex < target_mesh.GetNV(); ++vertex) {
        target_mesh.GetVertex(vertex)[0] += 2.0;
    }
    mfem::RT_FECollection source_collection(0, 3);
    mfem::FiniteElementSpace source_space(&source_mesh, &source_collection);
    mfem::GridFunction current(&source_space);
    mfem::Vector vec(3);
    vec = 0.0;
    vec[0] = 4.0;
    vec[1] = -1.25;
    mfem::VectorConstantCoefficient coeff(vec);
    current.ProjectCoefficient(coeff);

    mfem::H1_FECollection target_collection(1, 3);
    mfem::FiniteElementSpace target_space(
        &target_mesh, &target_collection, 3, mfem::Ordering::byVDIM);
    mfem::GridFunction proj_w1(&target_space);
    mfem::GridFunction proj_w4(&target_space);
    proj_w1 = 0.0;
    proj_w4 = 0.0;

    DirectTetraQuadratureOptions opt_w1;
    opt_w1.base_quadrature_order = 4;
    opt_w1.maximum_subdivision_depth = 4;
    opt_w1.relative_tolerance = 1.0e-5;
    opt_w1.absolute_tolerance_apm = 1.0e-9;
    opt_w1.worker_threads = 1;
    const auto diag_w1 = DirectTetraQuadrature::ProjectField(current, proj_w1, opt_w1);

    auto opt_w4 = opt_w1;
    opt_w4.worker_threads = 4;
    const auto diag_w4 = DirectTetraQuadrature::ProjectField(current, proj_w4, opt_w4);

    require(diag_w1.unconverged_pair_count == 0 && diag_w4.unconverged_pair_count == 0,
        "fused H1 projection left unconverged pairs");
    require(diag_w1.source_target_pairs == diag_w4.source_target_pairs &&
            diag_w1.kernel_evaluations == diag_w4.kernel_evaluations &&
            diag_w1.ledger_leaf_visits == diag_w4.ledger_leaf_visits,
        "fused H1 projection work counters differed between worker_threads=1 and 4");

    mfem::Vector diff(proj_w1.Size());
    diff = proj_w4;
    diff -= proj_w1;
    const double rel_diff = diff.Norml2() / std::max(1.0, proj_w1.Norml2());
    require(std::isfinite(rel_diff) && rel_diff <= 1.0e-12,
        "fused H1 projection differed between worker_threads=1 and 4");

    // Verify 3x single-pass fusion: total source-target pairs and kernel evaluations
    // are at most 1/3 of legacy 3-component separate quadrature passes.
    const int target_order = std::max(2, opt_w1.base_quadrature_order + 2);
    const auto npts = static_cast<std::uint64_t>(
        mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, target_order).GetNPoints());
    const auto single_pass_pairs =
        static_cast<std::uint64_t>(source_mesh.GetNE()) *
        static_cast<std::uint64_t>(target_mesh.GetNE()) * npts;
    const auto low_npts = static_cast<std::uint64_t>(
        mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, opt_w1.base_quadrature_order).GetNPoints());
    const auto high_npts = static_cast<std::uint64_t>(
        mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, opt_w1.base_quadrature_order + 2).GetNPoints());
    const auto exact_single_pass_kernels =
        (single_pass_pairs + 8u * diag_w1.refined_pairs) * (low_npts + high_npts);
    const auto legacy_three_pass_kernels = 3u * exact_single_pass_kernels;
    require(diag_w1.source_target_pairs == single_pass_pairs,
        "fused H1 projection evaluated more than one pass of source-target pairs");
    require(diag_w1.kernel_evaluations == exact_single_pass_kernels &&
            diag_w1.kernel_evaluations <= legacy_three_pass_kernels / 3u,
        "fused H1 projection did not achieve exact 3x single-pass kernel reduction");

    // Verify ProjectField bypasses pointwise pair cap while retaining shared WorkBudget.
    auto opt_small_pair_cap = opt_w4;
    opt_small_pair_cap.maximum_source_target_pairs =
        static_cast<std::uint64_t>(source_mesh.GetNE());
    mfem::GridFunction proj_capped(&target_space);
    proj_capped = 0.0;
    const auto diag_capped = DirectTetraQuadrature::ProjectField(
        current, proj_capped, opt_small_pair_cap);
    require(diag_capped.unconverged_pair_count == 0 &&
            diag_capped.source_target_pairs == single_pass_pairs,
        "fused H1 projection falsely triggered pointwise pair cap");
    diff = proj_capped;
    diff -= proj_w1;
    require(diff.Norml2() <= 1.0e-12 * std::max(1.0, proj_w1.Norml2()),
        "pair-cap-bypassed H1 projection differed from baseline");
}

void direct_tetra_gpu_hybrid_farfield_parity_and_singular_handoff()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        4, 4, 4, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::VectorFunctionCoefficient coefficient(3,
        [](const mfem::Vector &point, mfem::Vector &value) {
            value[0] = 4.0 + 0.5 * point[0];
            value[1] = -1.5 * point[1];
            value[2] = 0.75 * point[2];
        });
    current.ProjectCoefficient(coefficient);

    mfem::Array<int> verts;
    mesh.GetElementVertices(0, verts);
    std::array<std::array<double, 3>, 4> v{};
    std::array<double, 3> c0{0.0, 0.0, 0.0};
    for (int local = 0; local < 4; ++local) {
        const auto *coord = mesh.GetVertex(verts[local]);
        v[local] = {coord[0], coord[1], coord[2]};
        for (int c = 0; c < 3; ++c) c0[c] += 0.25 * coord[c];
    }
    double r0 = 0.0;
    for (int local = 0; local < 4; ++local) {
        r0 = std::max(r0, field_distance(v[local], c0));
    }

    const std::vector<std::array<double, 3>> targets{
        {3.0, 0.5, 0.5},                                       // far (d > 5 Rs)
        {-2.0, 0.25, 0.75},                                    // far (d > 5 Rs)
        {0.5, 3.5, 0.5},                                       // far (d > 5 Rs)
        {0.5, 0.5, -2.5},                                      // far (d > 5 Rs)
        {c0[0] - 2.5 * r0, c0[1], c0[2]},                      // near boundary (d ~ 2.5 Rs)
        {c0[0], c0[1] - 2.5 * r0, c0[2]},                      // near boundary (d ~ 2.5 Rs)
        v[0],                                                  // vertex singularity
        {0.5 * (v[0][0] + v[1][0]), 0.5 * (v[0][1] + v[1][1]),
            0.5 * (v[0][2] + v[1][2])},                        // edge singularity
        {(v[0][0] + v[1][0] + v[2][0]) / 3.0,
            (v[0][1] + v[1][1] + v[2][1]) / 3.0,
            (v[0][2] + v[1][2] + v[2][2]) / 3.0},              // face singularity
        c0,                                                    // interior singularity
    };

    DirectTetraQuadratureOptions cpu_options;
    cpu_options.base_quadrature_order = 4;
    cpu_options.maximum_subdivision_depth = 6;
    cpu_options.absolute_tolerance_apm = 1.0e-9;
    cpu_options.relative_tolerance = 1.0e-5;
    cpu_options.worker_threads = 4;
    cpu_options.execution_policy =
        fullmag::fem::oersted::DirectTetraExecutionPolicy::CpuDeterministic;

    auto gpu_options = cpu_options;
    gpu_options.execution_policy =
        fullmag::fem::oersted::DirectTetraExecutionPolicy::GpuHybridFarField;

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
    const char *cuda_visible = std::getenv("CUDA_VISIBLE_DEVICES");
    const bool cuda_hidden = cuda_visible != nullptr && std::string(cuda_visible).empty();
    if (cuda_hidden) {
        bool rejected = false;
        try {
            (void)DirectTetraQuadrature::EvaluateField(mesh, current, targets, gpu_options);
        } catch (const std::runtime_error &) {
            rejected = true;
        }
        require(rejected,
            "GPU hybrid policy must fail closed when CUDA_VISIBLE_DEVICES is empty");
    } else {
        const auto cpu_res = DirectTetraQuadrature::EvaluateField(
            mesh, current, targets, cpu_options);
        const auto gpu_res = DirectTetraQuadrature::EvaluateField(
            mesh, current, targets, gpu_options);
        const auto gpu_repeat = DirectTetraQuadrature::EvaluateField(
            mesh, current, targets, gpu_options);

        require(gpu_res.diagnostics.unconverged_pair_count == 0,
            "GPU hybrid far-field left unconverged pairs");
        require(gpu_res.diagnostics.resolved_execution_policy == "gpu_hybrid_farfield",
            "GPU hybrid policy did not report gpu_hybrid_farfield");
        require(gpu_res.diagnostics.gpu_farfield_pairs > 0 &&
                gpu_res.diagnostics.cpu_near_singular_pairs > 0 &&
                gpu_res.diagnostics.gpu_farfield_pairs +
                    gpu_res.diagnostics.cpu_near_singular_pairs ==
                    gpu_res.diagnostics.source_target_pairs,
            "GPU hybrid far-field pair partitioning counts are invalid");
        require(gpu_res.h_xyz_apm == gpu_repeat.h_xyz_apm,
            "GPU hybrid far-field TwoSum accumulation is not deterministic");

        std::uint64_t sample_sum = 0;
        std::uint64_t visit_sum = 0;
        for (const auto &td : gpu_res.target_diagnostics) {
            sample_sum += td.kernel_evaluations;
            visit_sum += td.ledger_leaf_visits;
        }
        require(sample_sum == gpu_res.diagnostics.kernel_evaluations &&
                visit_sum == gpu_res.diagnostics.ledger_leaf_visits,
            "GPU hybrid aggregate work counters do not match target sums");

        for (std::size_t t = 0; t < targets.size(); ++t) {
            const std::array<double, 3> h_cpu{
                cpu_res.h_xyz_apm[3u * t + 0u],
                cpu_res.h_xyz_apm[3u * t + 1u],
                cpu_res.h_xyz_apm[3u * t + 2u]};
            const std::array<double, 3> h_gpu{
                gpu_res.h_xyz_apm[3u * t + 0u],
                gpu_res.h_xyz_apm[3u * t + 1u],
                gpu_res.h_xyz_apm[3u * t + 2u]};
            const double cpu_norm = field_distance(h_cpu, {0.0, 0.0, 0.0});
            const double err = field_distance(h_gpu, h_cpu);
            require(std::isfinite(err) && err <= 1.0e-13 * std::max(1.0, cpu_norm),
                "GPU hybrid far-field + CPU singular handoff exceeded 1e-13 parity tolerance");
        }
    }
#else
    bool rejected = false;
    try {
        (void)DirectTetraQuadrature::EvaluateField(mesh, current, targets, gpu_options);
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    require(rejected,
        "GPU hybrid policy must fail closed with std::runtime_error when CUDA runtime is absent");
#endif
}

// Failure-only test diagnostics; the original contract remains fatal.
void diagnose_singular_targets_after_failure()
{
    using Point = std::array<double, 3>;
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);

    mfem::Array<int> vertices;
    mesh.GetElementVertices(0, vertices);
    require(vertices.Size() == 4,
        "singular-target fixture must start from a tetrahedron");
    std::array<std::array<double, 3>, 4> points{};
    for (int local = 0; local < 4; ++local) {
        const auto *coordinate = mesh.GetVertex(vertices[local]);
        points[local] = {coordinate[0], coordinate[1], coordinate[2]};
    }
    const auto average = [&](std::initializer_list<int> indices) {
        std::array<double, 3> result{0.0, 0.0, 0.0};
        for (const int index : indices) {
            for (int component = 0; component < 3; ++component) {
                result[component] += points[index][component];
            }
        }
        const double scale = 1.0 / static_cast<double>(indices.size());
        for (double &component : result) component *= scale;
        return result;
    };

    const std::vector<std::array<double, 3>> targets{
        average({0, 1, 2, 3}), // interior
        average({0, 1, 2}),    // face
        average({0, 1}),        // edge
    };
    DirectTetraQuadratureOptions options;
    options.base_quadrature_order = 8;
    options.maximum_subdivision_depth = 6;
    options.absolute_tolerance_apm = 1.0e-9;
    options.relative_tolerance = 1.0e-5;
    require(mesh.GetNE() == 6, "singular diagnostic requires exactly six source roots");
    std::cerr << std::setprecision(std::numeric_limits<double>::max_digits10);
    const auto print_point = [](const Point &point) {
        std::cerr << '(' << point[0] << ',' << point[1] << ',' << point[2] << ')';
    };
    std::array<std::array<Point, 4>, 6> roots{};
    for (int source = 0; source < mesh.GetNE(); ++source) {
        mesh.GetElementVertices(source, vertices);
        std::cerr << "OE-F1 DIAGNOSTIC source=" << source << " vertices_m=";
        for (int local = 0; local < 4; ++local) {
            const auto *coordinate = mesh.GetVertex(vertices[local]);
            roots[source][local] = {coordinate[0], coordinate[1], coordinate[2]};
            print_point(roots[source][local]);
        }
        std::cerr << '\n';
    }
    for (const int requested_order : {20, 22}) {
        const auto &rule = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, requested_order);
        long double sum = 0.0L, sum_abs = 0.0L;
        double minimum = std::numeric_limits<double>::infinity();
        for (int sample = 0; sample < rule.GetNPoints(); ++sample) {
            const double weight = rule.IntPoint(sample).weight;
            sum += weight;
            sum_abs += std::abs(weight);
            minimum = std::min(minimum, weight);
        }
        std::cerr << "OE-F1 DIAGNOSTIC tetra_rule requested_order=" << requested_order
                  << " actual_order=" << rule.GetOrder() << " points=" << rule.GetNPoints()
                  << " sum_weights=" << sum << " sum_abs_weights=" << sum_abs
                  << " min_weight=" << minimum << '\n';
    }
    const auto subtract = [](const Point &a, const Point &b) {
        return Point{a[0] - b[0], a[1] - b[1], a[2] - b[2]};
    };
    const auto determinant = [](const Point &a, const Point &b, const Point &c) {
        return a[0] * (b[1] * c[2] - b[2] * c[1]) +
            a[1] * (b[2] * c[0] - b[0] * c[2]) +
            a[2] * (b[0] * c[1] - b[1] * c[0]);
    };
    const std::array<const char *, 3> names{{"interior", "face", "edge"}};
    const auto limits = DirectTetraQuadrature::ResolveWorkLimits(options);
    for (std::size_t target_index = 0; target_index < targets.size(); ++target_index) {
        const auto &target = targets[target_index];
        std::cerr << "OE-F1 DIAGNOSTIC BEGIN case=" << names[target_index] << " target_m=";
        print_point(target);
        std::cerr << " base_order=" << options.base_quadrature_order
                  << " maximum_depth=" << options.maximum_subdivision_depth
                  << " absolute_tolerance_apm=" << options.absolute_tolerance_apm
                  << " relative_tolerance=" << options.relative_tolerance
                  << " pair_cap=" << options.maximum_source_target_pairs
                  << " kernel_cap=" << limits.maximum_kernel_evaluations
                  << " ledger_cap=" << limits.maximum_ledger_leaf_visits << '\n';
        for (std::size_t source = 0; source < roots.size(); ++source) {
            const auto &root = roots[source];
            const auto a = subtract(root[1], root[0]);
            const auto b = subtract(root[2], root[0]);
            const auto c = subtract(root[3], root[0]);
            const auto offset = subtract(target, root[0]);
            const double denominator = determinant(a, b, c);
            require(std::isfinite(denominator) && denominator != 0.0,
                "singular diagnostic root is degenerate");
            const double b1 = determinant(offset, b, c) / denominator;
            const double b2 = determinant(a, offset, c) / denominator;
            const double b3 = determinant(a, b, offset) / denominator;
            const std::array<double, 4> barycentric{{1.0 - b1 - b2 - b3, b1, b2, b3}};
            const bool contained = std::all_of(barycentric.begin(), barycentric.end(),
                [](double value) { return std::isfinite(value) && value >= -1.0e-12; });
            std::cerr << "OE-F1 DIAGNOSTIC geometry case=" << names[target_index]
                      << " source=" << source << " barycentric=(" << barycentric[0] << ','
                      << b1 << ',' << b2 << ',' << b3 << ") root_classification="
                      << (contained ? "closed_simplex" : "outside") << '\n';
        }
        try {
            // Each public call owns a fresh, unchanged production-default WorkBudget.
            const auto result = DirectTetraQuadrature::EvaluateField(mesh, current, {target}, options);
            const auto &diagnostics = result.diagnostics;
            const auto &record = result.target_diagnostics.at(0);
            std::cerr << "OE-F1 DIAGNOSTIC SUCCESS case=" << names[target_index] << " h_apm=("
                      << result.h_xyz_apm.at(0) << ',' << result.h_xyz_apm.at(1) << ','
                      << result.h_xyz_apm.at(2) << "); estimated_error_apm=" << record.estimated_error_apm
                      << " roundoff_indicator_apm=" << record.roundoff_indicator_apm
                      << " tolerance_apm=" << record.tolerance_apm
                      << " final_leaves=" << record.final_leaf_count
                      << " target_kernels=" << record.kernel_evaluations
                      << " target_visits=" << record.ledger_leaf_visits
                      << " source_target_pairs=" << diagnostics.source_target_pairs
                      << " refined_pairs=" << diagnostics.refined_pairs
                      << " unconverged_pairs=" << diagnostics.unconverged_pair_count
                      << " maximum_pair_error_apm=" << diagnostics.maximum_pair_error_apm
                      << " global_kernels=" << diagnostics.kernel_evaluations
                      << " global_visits=" << diagnostics.ledger_leaf_visits << '\n';
        } catch (const std::exception &error) {
            std::cerr << "OE-F1 DIAGNOSTIC REFUSED case=" << names[target_index]
                      << " exception=" << error.what() << '\n';
        }
    }
}

} // namespace

int main()
{
    try {
        std::cerr << "OE-F1 CASE direct_tetra_signed_current_and_budget_contract\n";
        direct_tetra_signed_current_and_budget_contract();
        std::cerr << "OE-F1 CASE direct_tetra_explicit_volume_profile_contract\n";
        direct_tetra_explicit_volume_profile_contract();
        std::cerr << "OE-F1 CASE direct_tetra_singular_target_contract\n";
        direct_tetra_singular_target_contract();
        std::cerr << "OE-F1 CASE direct_tetra_consistent_h1_projection_contract\n";
        direct_tetra_consistent_h1_projection_contract();
        std::cerr << "OE-F1 CASE direct_tetra_h_refinement_contract\n";
        direct_tetra_h_refinement_contract();
        std::cerr << "OE-F1 CASE direct_tetra_fdm_midpoint_common_limit_contract\n";
        direct_tetra_fdm_midpoint_common_limit_contract();
        std::cerr << "OE-F1 CASE direct_tetra_multithread_is_bit_exact_and_observer_monotonic\n";
        direct_tetra_multithread_is_bit_exact_and_observer_monotonic();
        std::cerr << "OE-F1 CASE direct_tetra_parallel_budget_exceeded_fails_cleanly\n";
        direct_tetra_parallel_budget_exceeded_fails_cleanly();
        std::cerr << "OE-F1 CASE direct_tetra_project_field_single_pass_parity\n";
        direct_tetra_project_field_single_pass_parity();
        std::cerr << "OE-F1 CASE direct_tetra_gpu_hybrid_farfield_parity_and_singular_handoff\n";
        direct_tetra_gpu_hybrid_farfield_parity_and_singular_handoff();
        std::cout << "fem direct tetrahedral Oersted contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "fem direct tetrahedral Oersted contract: FAIL: "
                  << error.what() << '\n';
        try {
            diagnose_singular_targets_after_failure();
        } catch (const std::exception &diagnostic_error) {
            std::cerr << "OE-F1 DIAGNOSTIC SETUP REFUSED exception="
                      << diagnostic_error.what() << '\n';
        }
        return 1;
    }
}
