#include "cpu/frequency_domain/floquet_airbox_operator.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstring>
#include <exception>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem::frequency_domain {
namespace {

using Complex = std::complex<double>;

constexpr std::uint64_t kMaxMaterializedDofs = 512;

void copy_error(FloquetDynamicDemagKDiagnostics &diagnostics, const char *message) noexcept
{
    std::strncpy(diagnostics.error_message, message != nullptr ? message : "", 191u);
    diagnostics.error_message[191] = '\0';
}

bool checked_product(std::uint64_t lhs, std::uint64_t rhs, std::uint64_t *out) noexcept
{
    if (out == nullptr || (rhs != 0u && lhs > std::numeric_limits<std::uint64_t>::max() / rhs)) {
        return false;
    }
    *out = lhs * rhs;
    return true;
}

bool finite_complex(Complex value) noexcept
{
    return std::isfinite(value.real()) && std::isfinite(value.imag());
}

bool matrix_shape(
    const mfem::ComplexSparseMatrix *matrix,
    std::uint64_t *rows,
    std::uint64_t *columns) noexcept
{
    if (matrix == nullptr || rows == nullptr || columns == nullptr) {
        return false;
    }
    const mfem::SparseMatrix &real = matrix->real();
    const mfem::SparseMatrix &imaginary = matrix->imag();
    if (real.Height() != imaginary.Height() || real.Width() != imaginary.Width() ||
        real.Height() <= 0 || real.Width() <= 0) {
        return false;
    }
    *rows = static_cast<std::uint64_t>(real.Height());
    *columns = static_cast<std::uint64_t>(real.Width());
    return true;
}

Complex matrix_entry(const mfem::ComplexSparseMatrix &matrix, int row, int column) noexcept
{
    return Complex(matrix.real()(row, column), matrix.imag()(row, column));
}

bool finite_matrix(const mfem::ComplexSparseMatrix &matrix) noexcept
{
    const mfem::SparseMatrix &real = matrix.real();
    const mfem::SparseMatrix &imaginary = matrix.imag();
    for (int row = 0; row < real.Height(); ++row) {
        for (int column = 0; column < real.Width(); ++column) {
            if (!std::isfinite(real(row, column)) || !std::isfinite(imaginary(row, column))) {
                return false;
            }
        }
    }
    return true;
}

bool dense_workspace_fits(
    std::uint64_t reduced_phi,
    std::uint64_t q,
    FloquetDynamicDemagKGaugePolicy gauge_policy,
    std::uint64_t budget_bytes) noexcept
{
    // P_red, A_phiq and A_qphi are retained simultaneously.  Include the
    // output and the provider's LU/RHS workspace so the single budget bounds
    // the complete bounded bridge rather than each allocation independently.
    const std::uint64_t pinned =
        gauge_policy == FloquetDynamicDemagKGaugePolicy::pin_first_dof ? 1u : 0u;
    if (reduced_phi <= pinned) {
        return false;
    }
    const std::uint64_t factored_phi = reduced_phi - pinned;
    long double complex_entries = static_cast<long double>(reduced_phi) * reduced_phi +
        static_cast<long double>(reduced_phi) * q * 2.0L +
        static_cast<long double>(factored_phi) * factored_phi +
        static_cast<long double>(q) * q +
        static_cast<long double>(factored_phi) * 2.0L;
    long double byte_count = complex_entries * static_cast<long double>(sizeof(Complex));
    byte_count += static_cast<long double>(factored_phi * sizeof(std::uint64_t));
    byte_count += static_cast<long double>(2u * q) * static_cast<long double>(2u * q) *
        static_cast<long double>(sizeof(double));
    if (!std::isfinite(static_cast<double>(byte_count))) {
        return false;
    }
    return byte_count <= static_cast<long double>(budget_bytes);
}

FrequencyDomainStatus fail(
    FloquetAirboxDynamicDemagKResult *result,
    const char *message,
    FrequencyDomainStatus status = FrequencyDomainStatus::validation_error) noexcept
{
    if (result != nullptr) {
        result->real_split_row_major.clear();
        copy_error(result->diagnostics, message);
    }
    return status;
}

void copy_block_error(FloquetAirboxSharedDomainBlockResult *result, const char *message) noexcept
{
    if (result == nullptr) {
        return;
    }
    std::strncpy(result->error_message, message != nullptr ? message : "", 255u);
    result->error_message[255] = '\0';
}

bool collect_dirichlet_dofs(
    const FloquetAirboxSharedDomainBlockRequest &request,
    std::vector<int> &out_dofs,
    std::string &error)
{
    out_dofs.clear();
    if (request.boundary_kind != FloquetAirboxBoundaryKind::dirichlet) {
        return true;
    }
    if (request.scalar_space == nullptr || request.scalar_space->GetMesh() == nullptr ||
        request.robin_boundary_marker == nullptr) {
        error = "Floquet Dirichlet elimination requires a scalar space and boundary marker";
        return false;
    }
    const int maximum_boundary_attribute =
        request.scalar_space->GetMesh()->bdr_attributes.Max();
    if (maximum_boundary_attribute <= 0 ||
        request.robin_boundary_marker->Size() < maximum_boundary_attribute) {
        error = "Floquet Dirichlet elimination boundary marker has invalid size";
        return false;
    }

    mfem::Array<int> essential_true_dofs;
    request.scalar_space->GetEssentialTrueDofs(
        *request.robin_boundary_marker,
        essential_true_dofs);
    const std::uint64_t node_count =
        static_cast<std::uint64_t>(request.scalar_space->GetVSize());
    if (essential_true_dofs.Size() == 0) {
        error = "Floquet Dirichlet boundary marker selects no scalar true dofs";
        return false;
    }

    std::vector<std::uint8_t> essential_classes(
        static_cast<std::size_t>(request.scalar_reduced_node_count), 0u);
    for (int index = 0; index < essential_true_dofs.Size(); ++index) {
        const int dof = essential_true_dofs[index];
        if (dof < 0 || static_cast<std::uint64_t>(dof) >= node_count) {
            error = "Floquet Dirichlet elimination returned an out-of-range true dof";
            return false;
        }
        const std::uint32_t reduced =
            request.scalar_reduced_node[static_cast<std::size_t>(dof)];
        if (reduced >= request.scalar_reduced_node_count) {
            error = "Floquet Dirichlet elimination found an invalid scalar class";
            return false;
        }
        essential_classes[static_cast<std::size_t>(reduced)] = 1u;
    }

    for (std::uint64_t node = 0u; node < node_count; ++node) {
        const std::uint32_t reduced =
            request.scalar_reduced_node[static_cast<std::size_t>(node)];
        if (reduced >= request.scalar_reduced_node_count) {
            error = "Floquet Dirichlet elimination found an invalid scalar class";
            return false;
        }
        if (essential_classes[static_cast<std::size_t>(reduced)] != 0u) {
            out_dofs.push_back(static_cast<int>(node));
        }
    }
    if (out_dofs.empty()) {
        error = "Floquet Dirichlet boundary has no scalar classes to eliminate";
        return false;
    }
    return true;
}

bool eliminate_dirichlet_dofs(
    const FloquetAirboxSharedDomainBlockRequest &request,
    mfem::ComplexSparseMatrix &scalar_operator,
    mfem::ComplexSparseMatrix &tangent_source,
    std::string &error)
{
    std::vector<int> essential_dofs;
    if (!collect_dirichlet_dofs(request, essential_dofs, error)) {
        return false;
    }
    if (request.boundary_kind != FloquetAirboxBoundaryKind::dirichlet) {
        return true;
    }

    for (const int dof : essential_dofs) {
        // P is complex-valued even in the full-field representation. Keep
        // the real identity row used for an essential unknown and keep the
        // imaginary identity contribution zero.
        scalar_operator.real().EliminateRowCol(dof, mfem::Operator::DIAG_ONE);
        scalar_operator.imag().EliminateRowCol(dof, mfem::Operator::DIAG_ZERO);
        // The source is rectangular; its essential rows must be removed as
        // well, otherwise C^H P^-1 A would reintroduce a boundary potential.
        tangent_source.real().EliminateRow(dof, mfem::Operator::DIAG_ZERO);
        tangent_source.imag().EliminateRow(dof, mfem::Operator::DIAG_ZERO);
    }
    return true;
}

struct PhaseEdge {
    std::uint64_t target = 0;
    std::array<double, 3> translation{};
};

double dot3_array(const std::array<double, 3> &left, const std::array<double, 3> &right) noexcept
{
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

bool finite_array(const std::array<double, 3> &value) noexcept
{
    return std::isfinite(value[0]) && std::isfinite(value[1]) && std::isfinite(value[2]);
}

bool build_phase_entries(
    const std::uint32_t *node_classes,
    std::uint64_t node_count,
    std::uint64_t class_count,
    bool allow_inactive,
    const FrequencyDomainFloquetPeriodicPair *periodic_pairs,
    std::uint64_t periodic_pair_count,
    const std::array<double, 3> &k_rad_per_m,
    std::vector<FloquetBlochScalarConstraintEntry> &out_entries,
    std::string &error)
{
    constexpr std::uint32_t inactive = std::numeric_limits<std::uint32_t>::max();
    constexpr double two_pi = 2.0 * 3.14159265358979323846264338327950288;
    if (node_classes == nullptr || node_count == 0u || class_count == 0u ||
        class_count > node_count ||
        (periodic_pair_count > 0u && periodic_pairs == nullptr)) {
        error = "Floquet shared-domain class or periodic-pair input is invalid";
        return false;
    }
    std::vector<std::vector<PhaseEdge>> adjacency(static_cast<std::size_t>(node_count));
    for (std::uint64_t index = 0u; index < node_count; ++index) {
        const std::uint32_t class_id = node_classes[index];
        if (class_id == inactive) {
            if (!allow_inactive) {
                error = "Floquet scalar class map contains an inactive node";
                return false;
            }
        } else if (class_id >= class_count) {
            error = "Floquet class map contains an out-of-range class";
            return false;
        }
    }
    for (std::uint64_t index = 0u; index < periodic_pair_count; ++index) {
        const FrequencyDomainFloquetPeriodicPair &pair = periodic_pairs[index];
        if (pair.node_a >= node_count || pair.node_b >= node_count ||
            pair.node_a == pair.node_b) {
            error = "Floquet periodic pair has an invalid node endpoint";
            return false;
        }
        std::array<double, 3> translation = {
            pair.translation_m[0], pair.translation_m[1], pair.translation_m[2]};
        if (!pair.has_translation || !finite_array(translation)) {
            error = "Floquet periodic pair requires a finite translation";
            return false;
        }
        if (pair.has_phase) {
            if (!std::isfinite(pair.phase_rad)) {
                error = "Floquet periodic pair has a non-finite phase";
                return false;
            }
            const double expected_phase = -dot3_array(k_rad_per_m, translation);
            const double phase_residual = std::remainder(pair.phase_rad - expected_phase, two_pi);
            if (!std::isfinite(phase_residual) || std::abs(phase_residual) > 1.0e-10) {
                error = "Floquet periodic pair phase does not match -k dot translation";
                return false;
            }
        }
        const std::uint32_t class_a = node_classes[pair.node_a];
        const std::uint32_t class_b = node_classes[pair.node_b];
        if (class_a == inactive || class_b == inactive) {
            if (!allow_inactive || (class_a == inactive) != (class_b == inactive)) {
                error = "Floquet periodic pair crosses an inactive class";
                return false;
            }
            // Air-only rows have no source contribution.  Keep their phase
            // graph out of the magnetic class reduction.
            continue;
        }
        if (class_a != class_b) {
            error = "Floquet periodic pair endpoints belong to different classes";
            return false;
        }
        adjacency[static_cast<std::size_t>(pair.node_a)].push_back(
            PhaseEdge{pair.node_b, translation});
        adjacency[static_cast<std::size_t>(pair.node_b)].push_back(
            PhaseEdge{
                pair.node_a,
                {-translation[0], -translation[1], -translation[2]}});
    }

    const std::uint64_t unset = std::numeric_limits<std::uint64_t>::max();
    std::vector<std::uint64_t> class_seed(static_cast<std::size_t>(class_count), unset);
    std::vector<std::uint8_t> visited(static_cast<std::size_t>(node_count), 0u);
    std::vector<std::array<double, 3>> node_translation(
        static_cast<std::size_t>(node_count), {0.0, 0.0, 0.0});
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        const std::uint32_t class_id = node_classes[node];
        if (class_id == inactive) {
            continue;
        }
        if (class_seed[static_cast<std::size_t>(class_id)] != unset) {
            continue;
        }
        class_seed[static_cast<std::size_t>(class_id)] = node;
        std::vector<std::uint64_t> queue{node};
        visited[static_cast<std::size_t>(node)] = 1u;
        while (!queue.empty()) {
            const std::uint64_t current = queue.back();
            queue.pop_back();
            for (const PhaseEdge &edge : adjacency[static_cast<std::size_t>(current)]) {
                const std::uint32_t target_class = node_classes[edge.target];
                if (target_class == inactive || target_class != class_id) {
                    continue;
                }
                std::array<double, 3> candidate = {
                    node_translation[static_cast<std::size_t>(current)][0] + edge.translation[0],
                    node_translation[static_cast<std::size_t>(current)][1] + edge.translation[1],
                    node_translation[static_cast<std::size_t>(current)][2] + edge.translation[2]};
                if (!finite_array(candidate)) {
                    error = "Floquet periodic translation accumulation is non-finite";
                    return false;
                }
                if (visited[static_cast<std::size_t>(edge.target)] != 0u) {
                    const auto &known = node_translation[static_cast<std::size_t>(edge.target)];
                    for (int axis = 0; axis < 3; ++axis) {
                        if (std::abs(known[static_cast<std::size_t>(axis)] -
                                     candidate[static_cast<std::size_t>(axis)]) > 1.0e-10) {
                            error = "Floquet periodic graph has inconsistent translations";
                            return false;
                        }
                    }
                    continue;
                }
                node_translation[static_cast<std::size_t>(edge.target)] = candidate;
                visited[static_cast<std::size_t>(edge.target)] = 1u;
                queue.push_back(edge.target);
            }
        }
    }
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        if (node_classes[node] != inactive && visited[static_cast<std::size_t>(node)] == 0u) {
            error = "Floquet class map is not connected by the supplied periodic pairs";
            return false;
        }
    }
    for (std::uint64_t class_id = 0u; class_id < class_count; ++class_id) {
        if (class_seed[static_cast<std::size_t>(class_id)] == unset) {
            error = "Floquet class map omits a reduced class";
            return false;
        }
    }

    out_entries.assign(static_cast<std::size_t>(node_count), {});
    for (std::uint64_t node = 0u; node < node_count; ++node) {
        std::uint32_t class_id = node_classes[node];
        if (class_id == inactive) {
            // Inactive magnetic nodes have identically zero source columns.
            // Map their unused constraint rows to class zero to keep the
            // rectangular q constraint complete without inventing a field.
            class_id = 0u;
            node_translation[static_cast<std::size_t>(node)] = {0.0, 0.0, 0.0};
        }
        FloquetBlochScalarConstraintEntry &entry = out_entries[static_cast<std::size_t>(node)];
        entry.full_dof = node;
        entry.reduced_dof = class_id;
        entry.translation_m = node_translation[static_cast<std::size_t>(node)];
    }
    return true;
}

std::unique_ptr<mfem::ComplexSparseMatrix> build_tangent_constraint_matrix(
    const std::vector<FloquetBlochScalarConstraintEntry> &entries,
    std::uint64_t reduced_node_count,
    const std::array<double, 3> &k_rad_per_m)
{
    const int full_node_count = static_cast<int>(entries.size());
    const int reduced_count = static_cast<int>(reduced_node_count);
    auto real = std::make_unique<mfem::SparseMatrix>(2 * full_node_count, 2 * reduced_count);
    auto imaginary = std::make_unique<mfem::SparseMatrix>(2 * full_node_count, 2 * reduced_count);
    for (const FloquetBlochScalarConstraintEntry &entry : entries) {
        double phase_argument = 0.0;
        for (int axis = 0; axis < 3; ++axis) {
            phase_argument += k_rad_per_m[static_cast<std::size_t>(axis)] *
                entry.translation_m[static_cast<std::size_t>(axis)];
        }
        const double phase_real = std::cos(phase_argument);
        const double phase_imaginary = -std::sin(phase_argument);
        for (int component = 0; component < 2; ++component) {
            real->Add(
                2 * static_cast<int>(entry.full_dof) + component,
                2 * static_cast<int>(entry.reduced_dof) + component,
                phase_real);
            imaginary->Add(
                2 * static_cast<int>(entry.full_dof) + component,
                2 * static_cast<int>(entry.reduced_dof) + component,
                phase_imaginary);
        }
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

} // namespace

FrequencyDomainStatus assemble_floquet_airbox_shared_domain_blocks(
    const FloquetAirboxSharedDomainBlockRequest &request,
    FloquetAirboxSharedDomainBlockResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetAirboxSharedDomainBlockResult{};
    if (request.scalar_space == nullptr || request.scalar_space->GetMesh() == nullptr ||
        request.tangent_frames == nullptr || request.tangent_frame_count == 0u ||
        request.scalar_space->GetMesh()->Dimension() != 3) {
        copy_block_error(out_result, "Floquet shared-domain block request has no 3D scalar space");
        return FrequencyDomainStatus::validation_error;
    }
    const std::uint64_t node_count =
        static_cast<std::uint64_t>(request.scalar_space->GetVSize());
    if (node_count == 0u || node_count != request.tangent_frame_count ||
        node_count > static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2) ||
        request.scalar_reduced_node == nullptr || request.scalar_reduced_node_count == 0u ||
        request.scalar_reduced_node_count >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2) ||
        request.magnetic_reduced_node == nullptr || request.magnetic_reduced_node_count == 0u ||
        request.magnetic_reduced_node_count >
            static_cast<std::uint64_t>(std::numeric_limits<int>::max() / 2) ||
        request.magnetic_element_mask == nullptr ||
        request.magnetic_element_count !=
            static_cast<std::uint64_t>(request.scalar_space->GetMesh()->GetNE())) {
        copy_block_error(out_result, "Floquet shared-domain block request dimensions are invalid");
        return FrequencyDomainStatus::validation_error;
    }
    for (double component : request.k_rad_per_m) {
        if (!std::isfinite(component)) {
            copy_block_error(out_result, "Floquet shared-domain block wavevector is non-finite");
            return FrequencyDomainStatus::validation_error;
        }
    }
    const double k_squared =
        request.k_rad_per_m[0] * request.k_rad_per_m[0] +
        request.k_rad_per_m[1] * request.k_rad_per_m[1] +
        request.k_rad_per_m[2] * request.k_rad_per_m[2];
    if (k_squared > 0.0 && request.periodic_pair_count == 0u) {
        copy_block_error(
            out_result,
            "nonzero-k Floquet shared-domain blocks require periodic translation pairs");
        return FrequencyDomainStatus::validation_error;
    }
    switch (request.boundary_kind) {
    case FloquetAirboxBoundaryKind::robin:
        if (!std::isfinite(request.robin_beta) || request.robin_beta <= 0.0 ||
            request.robin_boundary_marker == nullptr) {
            copy_block_error(
                out_result,
                "Floquet shared-domain Robin boundary requires beta>0 and a boundary marker");
            return FrequencyDomainStatus::validation_error;
        }
        break;
    case FloquetAirboxBoundaryKind::dirichlet:
        if (!std::isfinite(request.robin_beta) || request.robin_beta != 0.0 ||
            request.robin_boundary_marker == nullptr) {
            copy_block_error(
                out_result,
                "Floquet shared-domain Dirichlet boundary requires beta=0 and a boundary marker");
            return FrequencyDomainStatus::validation_error;
        }
        break;
    case FloquetAirboxBoundaryKind::pure_neumann:
        if (!std::isfinite(request.robin_beta) || request.robin_beta != 0.0 ||
            request.robin_boundary_marker != nullptr) {
            copy_block_error(
                out_result,
                "Floquet shared-domain pure-Neumann boundary forbids Robin data");
            return FrequencyDomainStatus::validation_error;
        }
        break;
    case FloquetAirboxBoundaryKind::unknown:
    default:
        copy_block_error(
            out_result,
            "Floquet shared-domain boundary kind must be explicit");
        return FrequencyDomainStatus::validation_error;
    }

    try {
        std::vector<FloquetBlochScalarConstraintEntry> scalar_entries;
        std::vector<FloquetBlochScalarConstraintEntry> magnetic_entries;
        std::string error;
        if (!build_phase_entries(
                request.scalar_reduced_node,
                node_count,
                request.scalar_reduced_node_count,
                false,
                request.periodic_pairs,
                request.periodic_pair_count,
                request.k_rad_per_m,
                scalar_entries,
                error) ||
            !build_phase_entries(
                request.magnetic_reduced_node,
                node_count,
                request.magnetic_reduced_node_count,
                true,
                request.periodic_pairs,
                request.periodic_pair_count,
                request.k_rad_per_m,
                magnetic_entries,
                error)) {
            copy_block_error(out_result, error.c_str());
            return FrequencyDomainStatus::validation_error;
        }

        FloquetBlochScalarAssemblyRequest scalar_request{};
        scalar_request.scalar_space = request.scalar_space;
        scalar_request.k_rad_per_m = request.k_rad_per_m;
        scalar_request.robin_beta = request.robin_beta;
        scalar_request.robin_boundary_marker = request.robin_boundary_marker;
        scalar_request.representation =
            FloquetBlochScalarRepresentation::full_field_phase_constrained;
        FloquetBlochScalarAssemblyResult scalar_result{};
        FrequencyDomainStatus status = assemble_floquet_bloch_scalar_operator(
            scalar_request,
            &scalar_result);
        if (status != FrequencyDomainStatus::ok) {
            copy_block_error(out_result, "Floquet scalar operator assembly failed");
            return status;
        }

        FloquetBlochScalarConstraintRequest scalar_constraint_request{};
        scalar_constraint_request.scalar_space = request.scalar_space;
        scalar_constraint_request.entries = scalar_entries.data();
        scalar_constraint_request.entry_count = scalar_entries.size();
        scalar_constraint_request.reduced_dof_count = request.scalar_reduced_node_count;
        scalar_constraint_request.k_rad_per_m = request.k_rad_per_m;
        FloquetBlochScalarConstraintResult scalar_constraint_result{};
        status = assemble_floquet_bloch_scalar_constraint(
            scalar_constraint_request,
            &scalar_constraint_result);
        if (status != FrequencyDomainStatus::ok) {
            copy_block_error(out_result, "Floquet scalar phase constraint assembly failed");
            return status;
        }

        FloquetBlochScalarTangentSourceRequest source_request{};
        source_request.scalar_space = request.scalar_space;
        source_request.tangent_frames = request.tangent_frames;
        source_request.tangent_frame_count = request.tangent_frame_count;
        source_request.saturation_magnetization_a_per_m =
            request.uniform_saturation_magnetization_a_per_m;
        source_request.saturation_magnetization_field =
            request.saturation_magnetization_a_per_m;
        source_request.saturation_magnetization_field_count =
            request.saturation_magnetization_count;
        source_request.k_rad_per_m = request.k_rad_per_m;
        source_request.representation =
            FloquetBlochScalarRepresentation::full_field_phase_constrained;
        source_request.magnetic_element_mask = request.magnetic_element_mask;
        source_request.magnetic_element_mask_count = request.magnetic_element_count;
        FloquetBlochScalarTangentSourceResult source_result{};
        status = assemble_floquet_bloch_scalar_tangent_source(source_request, &source_result);
        if (status != FrequencyDomainStatus::ok) {
            copy_block_error(out_result, "Floquet magnetic-potential source assembly failed");
            return status;
        }

        if (!eliminate_dirichlet_dofs(
                request,
                *scalar_result.operator_matrix,
                *source_result.source_matrix,
                error)) {
            copy_block_error(out_result, error.c_str());
            return FrequencyDomainStatus::validation_error;
        }

        // ComplexSparseMatrix returned by SesquilinearForm is a non-owning
        // view of the form's real/imaginary sparse matrices.  Move every
        // owner together with the view; moving only operator_matrix would
        // leave both that view and its coefficient references dangling when
        // scalar_result goes out of scope.
        out_result->scalar_k_squared_coefficient =
            std::move(scalar_result.k_squared_coefficient);
        out_result->scalar_k_coefficient = std::move(scalar_result.k_coefficient);
        out_result->scalar_robin_coefficient = std::move(scalar_result.robin_coefficient);
        out_result->scalar_form = std::move(scalar_result.form);
        out_result->scalar_operator = std::move(scalar_result.operator_matrix);
        out_result->scalar_constraint = std::move(scalar_constraint_result.constraint_matrix);
        out_result->tangent_source = std::move(source_result.source_matrix);
        out_result->tangent_constraint = build_tangent_constraint_matrix(
            magnetic_entries,
            request.magnetic_reduced_node_count,
            request.k_rad_per_m);
        if (out_result->scalar_operator == nullptr || out_result->scalar_constraint == nullptr ||
            out_result->tangent_source == nullptr || out_result->tangent_constraint == nullptr) {
            copy_block_error(out_result, "Floquet shared-domain block assembly returned an empty block");
            return FrequencyDomainStatus::operator_error;
        }
        return FrequencyDomainStatus::ok;
    } catch (const std::exception &exception) {
        copy_block_error(out_result, exception.what());
        return FrequencyDomainStatus::operator_error;
    } catch (...) {
        copy_block_error(out_result, "Floquet shared-domain block assembly failed");
        return FrequencyDomainStatus::operator_error;
    }
}

FrequencyDomainStatus assemble_floquet_airbox_dynamic_demag_k(
    const FloquetAirboxDynamicDemagKProblem &problem,
    FloquetAirboxDynamicDemagKResult *out_result) noexcept
{
    if (out_result == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_result = FloquetAirboxDynamicDemagKResult{};

    if (problem.scalar_operator == nullptr || problem.scalar_constraint == nullptr ||
        problem.tangent_source == nullptr) {
        return fail(out_result, "Floquet airbox dynamic demag-k blocks are missing");
    }

    std::uint64_t full_phi_from_operator = 0;
    std::uint64_t full_phi_columns = 0;
    std::uint64_t constraint_rows = 0;
    std::uint64_t reduced_phi = 0;
    std::uint64_t source_rows = 0;
    std::uint64_t source_columns = 0;
    std::uint64_t tangent_constraint_rows = 0;
    std::uint64_t q = 0;
    if (!matrix_shape(
            problem.scalar_operator,
            &full_phi_from_operator,
            &full_phi_columns) ||
        !matrix_shape(problem.scalar_constraint, &constraint_rows, &reduced_phi) ||
        !matrix_shape(problem.tangent_source, &source_rows, &source_columns) ||
        full_phi_from_operator != full_phi_columns ||
        constraint_rows != full_phi_from_operator || source_rows != full_phi_from_operator ||
        full_phi_from_operator > kMaxMaterializedDofs || reduced_phi > kMaxMaterializedDofs ||
        source_columns > kMaxMaterializedDofs) {
        return fail(out_result, "Floquet airbox dynamic demag-k block dimensions are invalid");
    }
    if (problem.tangent_constraint != nullptr) {
        if (!matrix_shape(
                problem.tangent_constraint,
                &tangent_constraint_rows,
                &q) ||
            tangent_constraint_rows != source_columns || q == 0u ||
            q > kMaxMaterializedDofs) {
            return fail(out_result, "Floquet airbox tangent constraint dimensions are invalid");
        }
    } else {
        q = source_columns;
    }
    if (problem.scalar_operator->GetConvention() != mfem::ComplexOperator::HERMITIAN ||
        problem.scalar_constraint->GetConvention() != mfem::ComplexOperator::HERMITIAN ||
        problem.tangent_source->GetConvention() != mfem::ComplexOperator::HERMITIAN ||
        (problem.tangent_constraint != nullptr &&
         problem.tangent_constraint->GetConvention() != mfem::ComplexOperator::HERMITIAN)) {
        return fail(out_result, "Floquet airbox dynamic demag-k blocks require Hermitian convention");
    }
    if (!finite_matrix(*problem.scalar_operator) ||
        !finite_matrix(*problem.scalar_constraint) || !finite_matrix(*problem.tangent_source) ||
        (problem.tangent_constraint != nullptr &&
         !finite_matrix(*problem.tangent_constraint))) {
        return fail(out_result, "Floquet airbox dynamic demag-k blocks contain non-finite values");
    }
    if (problem.workspace_budget_bytes == 0u ||
        !dense_workspace_fits(
            reduced_phi,
            q,
            problem.gauge_policy,
            problem.workspace_budget_bytes)) {
        return fail(out_result, "Floquet airbox dynamic demag-k materialization exceeds its workspace budget");
    }
    if (!std::isfinite(problem.qphi_feedback_scale) ||
        problem.qphi_feedback_scale == 0.0) {
        return fail(out_result, "Floquet airbox reciprocal q-phi feedback scale must be finite and nonzero");
    }

    try {
        const int full_phi = static_cast<int>(full_phi_from_operator);
        const int reduced = static_cast<int>(reduced_phi);
        const int q_count = static_cast<int>(q);
        std::vector<Complex> p_reduced(
            static_cast<std::size_t>(reduced_phi * reduced_phi), Complex(0.0, 0.0));
        std::vector<Complex> a_phiq(
            static_cast<std::size_t>(reduced_phi * q), Complex(0.0, 0.0));

        for (int reduced_row = 0; reduced_row < reduced; ++reduced_row) {
            for (int reduced_column = 0; reduced_column < reduced; ++reduced_column) {
                Complex value(0.0, 0.0);
                for (int row = 0; row < full_phi; ++row) {
                    const Complex constraint_row =
                        matrix_entry(*problem.scalar_constraint, row, reduced_row);
                    if (std::abs(constraint_row) == 0.0) {
                        continue;
                    }
                    for (int column = 0; column < full_phi; ++column) {
                        const Complex constraint_column =
                            matrix_entry(*problem.scalar_constraint, column, reduced_column);
                        if (std::abs(constraint_column) == 0.0) {
                            continue;
                        }
                        value += std::conj(constraint_row) *
                            matrix_entry(*problem.scalar_operator, row, column) *
                            constraint_column;
                    }
                }
                if (!finite_complex(value)) {
                    return fail(out_result, "Floquet airbox reduced scalar block is non-finite");
                }
                p_reduced[static_cast<std::size_t>(reduced_row * reduced + reduced_column)] = value;
            }
        }

        for (int reduced_row = 0; reduced_row < reduced; ++reduced_row) {
            for (int column = 0; column < q_count; ++column) {
                Complex value(0.0, 0.0);
                for (int row = 0; row < full_phi; ++row) {
                    const Complex phi_constraint = std::conj(matrix_entry(
                        *problem.scalar_constraint,
                        row,
                        reduced_row));
                    if (std::abs(phi_constraint) == 0.0) {
                        continue;
                    }
                    if (problem.tangent_constraint == nullptr) {
                        value += phi_constraint * matrix_entry(
                            *problem.tangent_source,
                            row,
                            column);
                        continue;
                    }
                    for (int full_column = 0;
                         full_column < static_cast<int>(source_columns);
                         ++full_column) {
                        const Complex q_constraint = matrix_entry(
                            *problem.tangent_constraint,
                            full_column,
                            column);
                        if (std::abs(q_constraint) == 0.0) {
                            continue;
                        }
                        value += phi_constraint * matrix_entry(
                            *problem.tangent_source,
                            row,
                            full_column) * q_constraint;
                    }
                }
                if (!finite_complex(value)) {
                    return fail(out_result, "Floquet airbox reduced magnetic-potential coupling is non-finite");
                }
                a_phiq[static_cast<std::size_t>(reduced_row * q + column)] = value;
            }
        }

        std::vector<Complex> a_qphi(static_cast<std::size_t>(q * reduced));
        for (std::uint64_t row = 0; row < q; ++row) {
            for (std::uint64_t column = 0; column < reduced_phi; ++column) {
                a_qphi[static_cast<std::size_t>(row * reduced_phi + column)] = std::conj(
                    a_phiq[static_cast<std::size_t>(column * q + row)]) *
                    problem.qphi_feedback_scale;
            }
        }

        FloquetDynamicDemagKProblem schur_problem{};
        schur_problem.q_dof_count = q;
        schur_problem.phi_dof_count = reduced_phi;
        schur_problem.a_qphi_row_major = a_qphi.data();
        schur_problem.a_qphi_value_count = q * reduced_phi;
        schur_problem.p_row_major = p_reduced.data();
        schur_problem.p_value_count = reduced_phi * reduced_phi;
        schur_problem.a_phiq_row_major = a_phiq.data();
        schur_problem.a_phiq_value_count = reduced_phi * q;
        schur_problem.k_rad_per_m[0] = problem.k_rad_per_m[0];
        schur_problem.k_rad_per_m[1] = problem.k_rad_per_m[1];
        schur_problem.k_rad_per_m[2] = problem.k_rad_per_m[2];
        schur_problem.gauge_policy = problem.gauge_policy;
        schur_problem.pivot_tolerance = problem.pivot_tolerance;
        schur_problem.workspace_budget_bytes = problem.workspace_budget_bytes;

        std::uint64_t output_dimension = 0;
        std::uint64_t output_values = 0;
        if (!checked_product(q, 2u, &output_dimension) ||
            !checked_product(output_dimension, output_dimension, &output_values)) {
            return fail(out_result, "Floquet airbox dynamic demag-k output dimensions overflow");
        }
        out_result->real_split_row_major.assign(static_cast<std::size_t>(output_values), 0.0);
        const FrequencyDomainStatus status = build_floquet_dynamic_demag_k_real_split(
            schur_problem,
            out_result->real_split_row_major.data(),
            output_values,
            &out_result->diagnostics);
        if (status != FrequencyDomainStatus::ok) {
            out_result->real_split_row_major.clear();
        } else {
            out_result->reconstruction.q_count = q;
            out_result->reconstruction.phi_count = reduced_phi;
            out_result->reconstruction.gauge_policy = problem.gauge_policy;
            out_result->reconstruction.pivot_tolerance = problem.pivot_tolerance;
            out_result->reconstruction.magnetic_stiffness_real_split_value_count =
                output_values;
            out_result->reconstruction.p = std::move(p_reduced);
            out_result->reconstruction.a_phiq = std::move(a_phiq);
            out_result->reconstruction.a_qphi = std::move(a_qphi);
        }
        return status;
    } catch (...) {
        return fail(
            out_result,
            "Floquet airbox dynamic demag-k materialization failed while allocating workspace",
            FrequencyDomainStatus::operator_error);
    }
}

} // namespace fullmag::fem::frequency_domain

#endif
