/*
 * GPU cuDSS direct solver for frequency-domain driven response.
 *
 * Unconditionally compiled into fullmag_fem so non-MFEM / no-CUDA builds link
 * cleanly. When built with FULLMAG_FEM_CUDSS_DRIVEN_ENABLED &&
 * FULLMAG_HAS_CUDA_RUNTIME:
 * - Assembles the coupled sparse augmented system Z_aug(omega_k) with exact
 *   signs (K_loc - i omega_k M, K_{q phi}; -R_{phi q}, P) and explicit
 *   reservation of the 4*N_m_eff diagonal frequency slots.
 * - Explicitly zeroes ess_tdofs rows in -R_{phi q}.
 * - Performs one-time 6-pass Ruiz equilibration (D_r, D_c) on |Z_aug(omega_ref)|.
 * - Executes CUDSS_PHASE_ANALYSIS exactly once per frequency sweep and enforces
 *   VRAM budget preflight (CUDSS_DATA_MEMORY_ESTIMATES) before factorization.
 * - For each frequency omega_k, updates only the 4*N_m_eff diagonal entries on
 *   GPU (zero H2D matrix copies), runs CUDSS_PHASE_FACTORIZATION + CUDSS_DATA_INFO
 *   check + CUDSS_PHASE_SOLVE, and independently certifies unscaled residuals
 *   (r_q, r_phi) on GPU without CSR duplication.
 */

#include "gpu/frequency_domain/driven_response_cudss.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#if defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED && \
    defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
#define FULLMAG_DRIVEN_CUDSS_ACTIVE 1
#include <cuda_runtime.h>
#include <cudss.h>
#else
#define FULLMAG_DRIVEN_CUDSS_ACTIVE 0
#endif

namespace fullmag::fem::frequency_domain {

#if FULLMAG_DRIVEN_CUDSS_ACTIVE
namespace detail {

std::size_t driven_response_norm_partials_bytes() noexcept;

cudaError_t launch_driven_response_update_omega_entries(
    const std::uint32_t *d_slot_csr_indices,
    const double2 *d_slot_base_values,
    const double *d_slot_omega_imag_coeffs,
    double omega,
    double2 *d_csr_values,
    std::uint32_t slot_count,
    cudaStream_t stream) noexcept;

cudaError_t launch_driven_response_unscaled_residual_cert(
    const std::uint32_t *d_row_ptr,
    const std::uint32_t *d_col_indices,
    const double2 *d_scaled_csr_values,
    const double *d_row_scale,
    const double *d_col_scale,
    const double2 *d_b_unscaled,
    const double2 *d_b_scaled,
    const double2 *d_y_scaled,
    std::uint32_t n_q,
    std::uint32_t n_aug,
    double2 *d_x_unscaled,
    void *d_block_partials,
    double *d_out_norms,
    cudaStream_t stream) noexcept;

} // namespace detail
#endif

namespace {

constexpr double kGammaKVectorAbsTol = 1.0e-12;
constexpr std::uint64_t kBytesPerMiB = UINT64_C(1024) * UINT64_C(1024);

#if FULLMAG_DRIVEN_CUDSS_ACTIVE
constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
constexpr double kTinyDenominator = 1.0e-300;
constexpr double kDefaultDirectRtol = 1.0e-8;
constexpr std::uint64_t kMinimumVramReserveBytes = UINT64_C(512) * kBytesPerMiB;
#endif

std::string trim_ascii(const char *raw)
{
    if (raw == nullptr) {
        return {};
    }
    const char *begin = raw;
    while (*begin != '\0' && std::isspace(static_cast<unsigned char>(*begin)) != 0) {
        ++begin;
    }
    const char *end = begin;
    while (*end != '\0') {
        ++end;
    }
    while (end > begin && std::isspace(static_cast<unsigned char>(*(end - 1))) != 0) {
        --end;
    }
    return std::string(begin, end);
}

bool parse_positive_uint64_env(
    const char *env_name,
    const char *raw_value,
    const char *unit_label,
    bool &has_value,
    std::uint64_t &parsed_out,
    std::string &error)
{
    has_value = false;
    parsed_out = 0;
    const std::string trimmed = trim_ascii(raw_value);
    if (trimmed.empty()) {
        return true;
    }
    const bool digits_only = std::all_of(trimmed.begin(), trimmed.end(), [](char c) {
        return std::isdigit(static_cast<unsigned char>(c)) != 0;
    });
    errno = 0;
    char *endptr = nullptr;
    const unsigned long long parsed =
        digits_only ? std::strtoull(trimmed.c_str(), &endptr, 10) : 0ull;
    if (!digits_only || endptr == nullptr || *endptr != '\0' || errno == ERANGE ||
        parsed == 0ull || parsed > std::numeric_limits<std::uint64_t>::max()) {
        error = std::string(env_name) + " must be a positive integer number of " +
            unit_label + ", got '" + raw_value + "'";
        return false;
    }
    has_value = true;
    parsed_out = static_cast<std::uint64_t>(parsed);
    return true;
}

bool parse_driven_cudss_budget_caps(
    bool &has_cap,
    std::uint64_t &cap_bytes,
    std::string &error)
{
    has_cap = false;
    cap_bytes = 0;

    bool has_bytes_cap = false;
    std::uint64_t bytes_cap = 0;
    if (!parse_positive_uint64_env(
            kDrivenCudssBudgetBytesEnv,
            std::getenv(kDrivenCudssBudgetBytesEnv),
            "bytes",
            has_bytes_cap,
            bytes_cap,
            error)) {
        return false;
    }

    bool has_mib_cap = false;
    std::uint64_t mib_value = 0;
    const char *raw_mib = std::getenv(kDrivenCudssMaxVramMibEnv);
    if (!parse_positive_uint64_env(
            kDrivenCudssMaxVramMibEnv,
            raw_mib,
            "MiB",
            has_mib_cap,
            mib_value,
            error)) {
        return false;
    }

    std::uint64_t mib_cap_bytes = 0;
    if (has_mib_cap) {
        if (mib_value > std::numeric_limits<std::uint64_t>::max() / kBytesPerMiB) {
            error = std::string(kDrivenCudssMaxVramMibEnv) +
                " overflows uint64 byte conversion, got '" +
                (raw_mib != nullptr ? raw_mib : "") + "'";
            return false;
        }
        mib_cap_bytes = mib_value * kBytesPerMiB;
    }

    if (has_bytes_cap && has_mib_cap) {
        has_cap = true;
        cap_bytes = std::min(bytes_cap, mib_cap_bytes);
    } else if (has_bytes_cap) {
        has_cap = true;
        cap_bytes = bytes_cap;
    } else if (has_mib_cap) {
        has_cap = true;
        cap_bytes = mib_cap_bytes;
    }
    return true;
}

bool request_has_nonzero_floquet_k(const DrivenFrequencyResponseSolveRequest &request) noexcept
{
    if (request.requires_floquet_airbox_dynamic_demag ||
        request.floquet_periodic_pair_count > 0u) {
        return true;
    }
    if (!request.has_floquet_k_vector) {
        return false;
    }
    return std::abs(request.floquet_k_vector_rad_per_m[0]) > kGammaKVectorAbsTol ||
        std::abs(request.floquet_k_vector_rad_per_m[1]) > kGammaKVectorAbsTol ||
        std::abs(request.floquet_k_vector_rad_per_m[2]) > kGammaKVectorAbsTol;
}

bool request_demag_enabled(const DrivenFrequencyResponseSolveRequest &request) noexcept
{
    const auto &problem = request.mfem_validation_problem;
    return problem.descriptor.demag_enabled ||
        request.solve_request.operator_request.demag_kind != FrequencyDomainDemagKind::none ||
        request.requires_periodic_airbox_dynamic_demag ||
        problem.apply_demag_tangent != nullptr ||
        problem.apply_demag_tangent_with_potential != nullptr ||
        problem.demag_tangent_matrix_row_major != nullptr ||
        request.demag_sparse_blocks != nullptr;
}

FrequencyDomainStatus handle_unsupported_or_fallback(
    DrivenFrequencyResponseGpuDirectPolicy policy,
    const char *reason,
    const std::string &message,
    DrivenResponseCudssOutcome &outcome)
{
    outcome.used_cudss = false;
    outcome.fallback_reason = reason;
    if (policy == DrivenFrequencyResponseGpuDirectPolicy::Required) {
        outcome.status = FrequencyDomainStatus::unavailable;
        outcome.fallback_to_krylov = false;
        outcome.error_message = message;
    } else {
        outcome.status = FrequencyDomainStatus::ok;
        outcome.fallback_to_krylov = true;
        outcome.error_message.clear();
    }
    return outcome.status;
}

#if FULLMAG_DRIVEN_CUDSS_ACTIVE

double dot3(const double a[3], const double b[3]) noexcept
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

double env_positive_double_alias(
    const char *primary,
    const char *alias,
    double fallback) noexcept
{
    const auto try_parse = [](const char *name, double &out) -> bool {
        const char *raw = std::getenv(name);
        if (raw == nullptr || raw[0] == '\0') {
            return false;
        }
        char *end = nullptr;
        const double parsed = std::strtod(raw, &end);
        if (end != raw && end != nullptr && *end == '\0' &&
            std::isfinite(parsed) && parsed > 0.0) {
            out = parsed;
            return true;
        }
        return false;
    };
    double value = fallback;
    if (try_parse(primary, value) || try_parse(alias, value)) {
        return value;
    }
    return fallback;
}

double resolve_direct_rtol(const DrivenFrequencyResponseSolveRequest &request) noexcept
{
    const double requested = request.solver_options.relative_tolerance;
    if (std::isfinite(requested) && requested > 0.0) {
        return requested;
    }
    return env_positive_double_alias(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL",
        "FULLMAG_FMR_RESPONSE_RTOL",
        kDefaultDirectRtol);
}

double resolve_direct_atol(const DrivenFrequencyResponseSolveRequest &request) noexcept
{
    const double requested = request.solver_options.absolute_tolerance;
    if (std::isfinite(requested) && requested > 0.0) {
        return requested;
    }
    return env_positive_double_alias(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_ATOL",
        "FULLMAG_FMR_RESPONSE_ATOL",
        0.0);
}

bool force_pageable_scalar_readback() noexcept
{
    const char *value = std::getenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
    return value != nullptr && std::strcmp(value, "1") == 0;
}

double phase_sign(FrequencyDomainPhaseConvention convention) noexcept
{
    return convention == FrequencyDomainPhaseConvention::exp_minus_i_omega_t
        ? -1.0
        : 1.0;
}

bool validate_csr_view(
    const DrivenFrequencyResponseSparseCsrView &view,
    std::uint64_t expected_rows,
    std::uint64_t expected_cols,
    const char *label,
    std::string &error)
{
    if (view.num_rows != expected_rows ||
        view.num_cols != expected_cols ||
        view.row_ptr == nullptr) {
        error = std::string("cuDSS driven response received invalid ") + label + " CSR dimensions";
        return false;
    }
    if (view.row_ptr[0] != 0u ||
        static_cast<std::uint64_t>(view.row_ptr[expected_rows]) != view.nnz) {
        error = std::string("cuDSS driven response received inconsistent ") + label + " CSR bounds";
        return false;
    }
    if (view.nnz > 0u && (view.col_indices == nullptr || view.values == nullptr)) {
        error = std::string("cuDSS driven response received null ") + label + " CSR payload";
        return false;
    }
    for (std::uint64_t row = 0; row < expected_rows; ++row) {
        const std::uint32_t begin = view.row_ptr[row];
        const std::uint32_t end = view.row_ptr[row + 1u];
        if (end < begin || static_cast<std::uint64_t>(end) > view.nnz) {
            error = std::string("cuDSS driven response received non-monotonic ") + label +
                " CSR row offsets";
            return false;
        }
    }
    return true;
}

struct StaticPeriodicReduction {
    bool active = false;
    std::uint64_t full_node_count = 0;
    std::uint64_t reduced_node_count = 0;
    std::vector<std::uint32_t> node_to_reduced;
    std::vector<std::uint32_t> class_size;
};

bool build_static_periodic_reduction(
    const DrivenFrequencyResponseMfemValidationProblem &problem,
    StaticPeriodicReduction &out,
    std::string &error)
{
    const std::uint64_t n = problem.descriptor.node_count;
    out = StaticPeriodicReduction{};
    out.full_node_count = n;
    out.node_to_reduced.resize(static_cast<std::size_t>(n));

    if (problem.static_periodic_node_pair_count == 0u) {
        out.active = false;
        out.reduced_node_count = n;
        out.class_size.assign(static_cast<std::size_t>(n), 1u);
        for (std::uint64_t i = 0; i < n; ++i) {
            out.node_to_reduced[static_cast<std::size_t>(i)] = static_cast<std::uint32_t>(i);
        }
        return true;
    }
    if (problem.static_periodic_node_pairs == nullptr) {
        error = "cuDSS driven response static periodic reduction requires non-null node pairs";
        return false;
    }

    std::vector<std::uint64_t> parent(static_cast<std::size_t>(n));
    for (std::uint64_t i = 0; i < n; ++i) {
        parent[static_cast<std::size_t>(i)] = i;
    }
    auto find_root = [&](std::uint64_t x) {
        while (parent[static_cast<std::size_t>(x)] != x) {
            parent[static_cast<std::size_t>(x)] =
                parent[static_cast<std::size_t>(parent[static_cast<std::size_t>(x)])];
            x = parent[static_cast<std::size_t>(x)];
        }
        return x;
    };

    for (std::uint64_t p = 0; p < problem.static_periodic_node_pair_count; ++p) {
        const std::uint64_t a = problem.static_periodic_node_pairs[2u * p];
        const std::uint64_t b = problem.static_periodic_node_pairs[2u * p + 1u];
        if (a >= n || b >= n || a == b) {
            error = "cuDSS driven response received invalid static periodic node pair";
            return false;
        }
        const std::uint64_t ra = find_root(a);
        const std::uint64_t rb = find_root(b);
        if (ra != rb) {
            if (ra < rb) {
                parent[static_cast<std::size_t>(rb)] = ra;
            } else {
                parent[static_cast<std::size_t>(ra)] = rb;
            }
        }
    }

    std::vector<std::uint32_t> root_to_reduced(
        static_cast<std::size_t>(n),
        std::numeric_limits<std::uint32_t>::max());
    out.class_size.clear();
    for (std::uint64_t i = 0; i < n; ++i) {
        const std::uint64_t r = find_root(i);
        if (root_to_reduced[static_cast<std::size_t>(r)] ==
            std::numeric_limits<std::uint32_t>::max()) {
            const std::uint32_t id = static_cast<std::uint32_t>(out.class_size.size());
            root_to_reduced[static_cast<std::size_t>(r)] = id;
            out.class_size.push_back(0u);
        }
        const std::uint32_t red = root_to_reduced[static_cast<std::size_t>(r)];
        out.node_to_reduced[static_cast<std::size_t>(i)] = red;
        out.class_size[static_cast<std::size_t>(red)] += 1u;
    }
    out.reduced_node_count = static_cast<std::uint64_t>(out.class_size.size());
    out.active = out.reduced_node_count < n;
    return true;
}

struct DrivenResponseAugmentedCsr {
    std::uint32_t n_m_eff = 0;
    std::uint32_t n_q = 0;
    std::uint32_t n_phi = 0;
    std::uint32_t n_aug = 0;
    std::vector<std::uint32_t> row_ptr;
    std::vector<std::uint32_t> col_indices;
    std::vector<double> base_real_values;
    std::vector<std::uint32_t> slot_csr_indices;
    std::vector<double> slot_mass_entries;
    double inf_norm_p = 0.0;
    double inf_norm_r_phi_q = 0.0;
};

bool assemble_augmented_csr(
    const DrivenFrequencyResponseSolveRequest &request,
    const StaticPeriodicReduction &periodic,
    const DrivenFrequencyResponseDemagSparseBlocks *blocks,
    DrivenResponseAugmentedCsr &out,
    std::string &error)
{
    const auto &problem = request.mfem_validation_problem;
    const std::uint64_t n_m = problem.descriptor.node_count;
    const std::uint64_t n_m_eff = periodic.reduced_node_count;
    const std::uint64_t n_q = n_m_eff * 2u;
    const std::uint64_t n_phi = blocks != nullptr ? blocks->phi_dof_count : 0u;
    const std::uint64_t n_aug = n_q + n_phi;
    const double gamma0 = request.solve_request.operator_request.gamma0;
    const double uniform_alpha = request.solve_request.operator_request.alpha;

    if (n_aug == 0u || n_aug > static_cast<std::uint64_t>(std::numeric_limits<std::int32_t>::max())) {
        error = "cuDSS driven response augmented dimension exceeds 32-bit CSR index limit";
        return false;
    }
    if (!std::isfinite(gamma0) || gamma0 <= 0.0 ||
        !std::isfinite(uniform_alpha) || uniform_alpha < 0.0) {
        error = "cuDSS driven response requires finite positive gamma0 and non-negative alpha";
        return false;
    }

    std::vector<double> reduced_alpha(static_cast<std::size_t>(n_m_eff), 0.0);
    for (std::uint64_t u = 0; u < n_m; ++u) {
        const double alpha_u =
            problem.alpha_per_node != nullptr ? problem.alpha_per_node[u] : uniform_alpha;
        if (!std::isfinite(alpha_u) || alpha_u < 0.0) {
            error = "cuDSS driven response requires finite non-negative nodewise alpha";
            return false;
        }
        const std::uint32_t ru = periodic.node_to_reduced[static_cast<std::size_t>(u)];
        reduced_alpha[static_cast<std::size_t>(ru)] +=
            alpha_u / static_cast<double>(periodic.class_size[static_cast<std::size_t>(ru)]);
    }

    std::vector<std::vector<std::pair<std::uint32_t, double>>> rows(
        static_cast<std::size_t>(n_aug));

    // Reserve all 4 diagonal mass/damping entries for every reduced magnetic
    // node so the CSR sparsity pattern is strictly invariant across all omega_k.
    for (std::uint64_t r = 0; r < n_m_eff; ++r) {
        const std::uint32_t d0 = static_cast<std::uint32_t>(2u * r);
        const std::uint32_t d1 = d0 + 1u;
        rows[d0].emplace_back(d0, 0.0);
        rows[d0].emplace_back(d1, 0.0);
        rows[d1].emplace_back(d0, 0.0);
        rows[d1].emplace_back(d1, 0.0);
    }

    // Left-multiplies an effective-field 2x2 block B by R_{gamma0} = gamma0 * [[0, 1], [-1, 0]]
    // and applies static-periodic row compression 1/|C_{r_u}| and column prolongation.
    auto add_effective_field_block = [&](
        std::uint64_t mag_row_u,
        std::uint64_t mag_col_v,
        double b00,
        double b01,
        double b10,
        double b11) {
        const std::uint32_t ru = periodic.node_to_reduced[static_cast<std::size_t>(mag_row_u)];
        const std::uint32_t rv = periodic.node_to_reduced[static_cast<std::size_t>(mag_col_v)];
        const double scale =
            gamma0 / static_cast<double>(periodic.class_size[static_cast<std::size_t>(ru)]);
        const std::uint32_t r0 = 2u * ru;
        const std::uint32_t r1 = r0 + 1u;
        const std::uint32_t c0 = 2u * rv;
        const std::uint32_t c1 = c0 + 1u;
        if (b10 != 0.0) {
            rows[r0].emplace_back(c0, scale * b10);
        }
        if (b11 != 0.0) {
            rows[r0].emplace_back(c1, scale * b11);
        }
        if (b00 != 0.0) {
            rows[r1].emplace_back(c0, -scale * b00);
        }
        if (b01 != 0.0) {
            rows[r1].emplace_back(c1, -scale * b01);
        }
    };

    // 1. Exchange edges (matches driven_response_gpu.cu::exchange_kernel)
    if (problem.descriptor.exchange_enabled && problem.exchange_edge_count > 0u) {
        if (problem.exchange_edges == nullptr) {
            error = "cuDSS driven response requires non-null exchange_edges when exchange is enabled";
            return false;
        }
        for (std::uint64_t e = 0; e < problem.exchange_edge_count; ++e) {
            const TangentOperatorEdgeBlock &edge = problem.exchange_edges[e];
            if (edge.node_i >= n_m || edge.node_j >= n_m || edge.node_i == edge.node_j ||
                !std::isfinite(edge.stiffness)) {
                error = "cuDSS driven response received invalid exchange edge";
                return false;
            }
            const TangentFrameNode &ni = problem.nodes[edge.node_i];
            const TangentFrameNode &nj = problem.nodes[edge.node_j];
            const double s = edge.stiffness;
            const double r00 = dot3(ni.e1, nj.e1);
            const double r01 = dot3(ni.e1, nj.e2);
            const double r10 = dot3(ni.e2, nj.e1);
            const double r11 = dot3(ni.e2, nj.e2);
            add_effective_field_block(edge.node_i, edge.node_i, s, 0.0, 0.0, s);
            add_effective_field_block(
                edge.node_i, edge.node_j, -s * r00, -s * r01, -s * r10, -s * r11);
            add_effective_field_block(edge.node_j, edge.node_j, s, 0.0, 0.0, s);
            add_effective_field_block(
                edge.node_j, edge.node_i, -s * r00, -s * r10, -s * r01, -s * r11);
        }
    }

    // 2. Zeeman (matches driven_response_gpu.cu::local_precession_mass_kernel)
    if (problem.descriptor.zeeman_enabled) {
        if (problem.h_ext_a_per_m == nullptr ||
            !std::isfinite(problem.h_ext_a_per_m[0]) ||
            !std::isfinite(problem.h_ext_a_per_m[1]) ||
            !std::isfinite(problem.h_ext_a_per_m[2])) {
            error = "cuDSS driven response requires finite h_ext_a_per_m when Zeeman is enabled";
            return false;
        }
        for (std::uint64_t u = 0; u < n_m; ++u) {
            const double h_parallel = dot3(problem.h_ext_a_per_m, problem.nodes[u].m);
            add_effective_field_block(u, u, -h_parallel, 0.0, 0.0, -h_parallel);
        }
    }

    // 3. Uniaxial anisotropy (matches driven_response_gpu.cu::local_precession_mass_kernel)
    if (problem.descriptor.uniaxial_anisotropy_enabled) {
        if (problem.uniaxial_anisotropy_axis == nullptr ||
            !std::isfinite(problem.uniaxial_anisotropy_axis[0]) ||
            !std::isfinite(problem.uniaxial_anisotropy_axis[1]) ||
            !std::isfinite(problem.uniaxial_anisotropy_axis[2]) ||
            !std::isfinite(problem.uniaxial_anisotropy_field_a_per_m)) {
            error = "cuDSS driven response requires finite uniaxial anisotropy parameters";
            return false;
        }
        const double hk = problem.uniaxial_anisotropy_field_a_per_m;
        for (std::uint64_t u = 0; u < n_m; ++u) {
            const double u0 = dot3(problem.uniaxial_anisotropy_axis, problem.nodes[u].e1);
            const double u1 = dot3(problem.uniaxial_anisotropy_axis, problem.nodes[u].e2);
            add_effective_field_block(
                u, u, hk * u0 * u0, hk * u0 * u1, hk * u1 * u0, hk * u1 * u1);
        }
    }

    // 4. DMI 4-node element tangent operator (matches driven_response_gpu.cu:668-799)
    if (problem.descriptor.dmi_enabled && problem.dmi_element_count > 0u) {
        if (problem.dmi_elements == nullptr ||
            problem.dmi_lumped_mass == nullptr ||
            !std::isfinite(problem.dmi_uniform_ms) ||
            problem.dmi_uniform_ms <= 0.0) {
            error = "cuDSS driven response requires complete DMI element payload";
            return false;
        }
        for (std::uint64_t e = 0; e < problem.dmi_element_count; ++e) {
            const MfemDmiElementTangentData &elem = problem.dmi_elements[e];
            if (elem.kind != MfemDmiInteractionKind::interfacial &&
                elem.kind != MfemDmiInteractionKind::bulk) {
                error = "cuDSS driven response received unsupported DMI element kind";
                return false;
            }
            if (!std::isfinite(elem.weight) || !std::isfinite(elem.d)) {
                error = "cuDSS driven response received non-finite DMI weight or D";
                return false;
            }
            if (elem.weight == 0.0 || elem.d == 0.0) {
                continue;
            }
            for (int ln = 0; ln < 4; ++ln) {
                if (static_cast<std::uint64_t>(elem.node_indices[ln]) >= n_m ||
                    !std::isfinite(elem.shape[ln]) ||
                    !std::isfinite(elem.grad_shape[ln][0]) ||
                    !std::isfinite(elem.grad_shape[ln][1]) ||
                    !std::isfinite(elem.grad_shape[ln][2])) {
                    error = "cuDSS driven response received invalid DMI element node or geometry";
                    return false;
                }
            }
            if (elem.kind == MfemDmiInteractionKind::interfacial &&
                (!std::isfinite(elem.normal[0]) ||
                 !std::isfinite(elem.normal[1]) ||
                 !std::isfinite(elem.normal[2]))) {
                error = "cuDSS driven response received non-finite interfacial DMI normal";
                return false;
            }

            for (int b = 0; b < 4; ++b) {
                const std::uint64_t node_b = elem.node_indices[b];
                const double sb = elem.shape[b];
                const double *gb = elem.grad_shape[b];
                for (int t = 0; t < 2; ++t) {
                    const double *v =
                        (t == 0) ? problem.nodes[node_b].e1 : problem.nodes[node_b].e2;
                    const double delta_q[3] = {sb * v[0], sb * v[1], sb * v[2]};
                    double grad_delta[3][3]{};
                    for (int c = 0; c < 3; ++c) {
                        for (int d = 0; d < 3; ++d) {
                            grad_delta[c][d] = v[c] * gb[d];
                        }
                    }
                    const double div_delta =
                        grad_delta[0][0] + grad_delta[1][1] + grad_delta[2][2];
                    const double curl_delta[3] = {
                        grad_delta[2][1] - grad_delta[1][2],
                        grad_delta[0][2] - grad_delta[2][0],
                        grad_delta[1][0] - grad_delta[0][1],
                    };
                    const double grad_delta_dot_n[3] = {
                        elem.normal[0] * grad_delta[0][0] +
                            elem.normal[1] * grad_delta[1][0] +
                            elem.normal[2] * grad_delta[2][0],
                        elem.normal[0] * grad_delta[0][1] +
                            elem.normal[1] * grad_delta[1][1] +
                            elem.normal[2] * grad_delta[2][1],
                        elem.normal[0] * grad_delta[0][2] +
                            elem.normal[1] * grad_delta[1][2] +
                            elem.normal[2] * grad_delta[2][2],
                    };
                    const double delta_dot_n = dot3(delta_q, elem.normal);

                    for (int a = 0; a < 4; ++a) {
                        const std::uint64_t node_a = elem.node_indices[a];
                        const double mass_a = problem.dmi_lumped_mass[node_a];
                        const double ms_a = problem.dmi_ms_field != nullptr
                            ? problem.dmi_ms_field[node_a]
                            : problem.dmi_uniform_ms;
                        if (!(mass_a > 0.0) || !(ms_a > 0.0)) {
                            continue;
                        }
                        const double sa = elem.shape[a];
                        const double *ga = elem.grad_shape[a];
                        double residual[3]{};
                        if (elem.kind == MfemDmiInteractionKind::bulk) {
                            residual[0] = elem.d * elem.weight *
                                (sa * curl_delta[0] + delta_q[1] * ga[2] - delta_q[2] * ga[1]);
                            residual[1] = elem.d * elem.weight *
                                (sa * curl_delta[1] - delta_q[0] * ga[2] + delta_q[2] * ga[0]);
                            residual[2] = elem.d * elem.weight *
                                (sa * curl_delta[2] + delta_q[0] * ga[1] - delta_q[1] * ga[0]);
                        } else {
                            for (int comp = 0; comp < 3; ++comp) {
                                const double n_comp = elem.normal[comp];
                                const double dw_dm =
                                    elem.d * (n_comp * div_delta - grad_delta_dot_n[comp]);
                                double grad_action = 0.0;
                                for (int dir = 0; dir < 3; ++dir) {
                                    const double kron = comp == dir ? 1.0 : 0.0;
                                    const double dw_dg =
                                        elem.d * (delta_dot_n * kron - n_comp * delta_q[dir]);
                                    grad_action += dw_dg * ga[dir];
                                }
                                residual[comp] = elem.weight * (sa * dw_dm + grad_action);
                            }
                        }
                        const double inv_proj = -1.0 / (kMu0 * ms_a * mass_a + kTinyDenominator);
                        const double field[3] = {
                            residual[0] * inv_proj,
                            residual[1] * inv_proj,
                            residual[2] * inv_proj,
                        };
                        const double h0 = dot3(field, problem.nodes[node_a].e1);
                        const double h1 = dot3(field, problem.nodes[node_a].e2);
                        const std::uint32_t ra =
                            periodic.node_to_reduced[static_cast<std::size_t>(node_a)];
                        const std::uint32_t rb =
                            periodic.node_to_reduced[static_cast<std::size_t>(node_b)];
                        const double scale = gamma0 /
                            static_cast<double>(periodic.class_size[static_cast<std::size_t>(ra)]);
                        const std::uint32_t col = 2u * rb + static_cast<std::uint32_t>(t);
                        if (h1 != 0.0) {
                            rows[2u * ra].emplace_back(col, scale * h1);
                        }
                        if (h0 != 0.0) {
                            rows[2u * ra + 1u].emplace_back(col, -scale * h0);
                        }
                    }
                }
            }
        }
    }

    // 5. Coupled demagnetization blocks: K_{q phi}, -R_{phi q}, P
    if (blocks != nullptr) {
        if (blocks->full_node_count == 0u ||
            blocks->phi_dof_count == 0u ||
            blocks->magnetic_node_count != n_m ||
            blocks->magnetic_node_indices == nullptr) {
            error = "cuDSS driven response demag_sparse_blocks dimensions mismatch tangent problem";
            return false;
        }
        if (blocks->is_periodic_reduced != 0u && blocks->periodic_reduced_node == nullptr) {
            error = "cuDSS driven response periodic demag_sparse_blocks missing periodic_reduced_node";
            return false;
        }
        if (!validate_csr_view(blocks->poisson_matrix, n_phi, n_phi, "poisson_matrix", error) ||
            !validate_csr_view(blocks->rhs_x, n_phi, blocks->full_node_count, "rhs_x", error) ||
            !validate_csr_view(blocks->rhs_y, n_phi, blocks->full_node_count, "rhs_y", error) ||
            !validate_csr_view(blocks->rhs_z, n_phi, blocks->full_node_count, "rhs_z", error) ||
            !validate_csr_view(blocks->recovery_x, blocks->full_node_count, n_phi, "recovery_x", error) ||
            !validate_csr_view(blocks->recovery_y, blocks->full_node_count, n_phi, "recovery_y", error) ||
            !validate_csr_view(blocks->recovery_z, blocks->full_node_count, n_phi, "recovery_z", error)) {
            return false;
        }
        if (blocks->ess_tdof_count > 0u && blocks->ess_tdofs == nullptr) {
            error = "cuDSS driven response demag_sparse_blocks has null ess_tdofs";
            return false;
        }

        std::vector<std::uint8_t> is_ess_row(static_cast<std::size_t>(n_phi), 0u);
        for (std::uint64_t i = 0; i < blocks->ess_tdof_count; ++i) {
            const std::uint32_t ess = blocks->ess_tdofs[i];
            if (static_cast<std::uint64_t>(ess) >= n_phi) {
                error = "cuDSS driven response demag_sparse_blocks ess_tdof out of range";
                return false;
            }
            is_ess_row[static_cast<std::size_t>(ess)] = 1u;
        }

        if (blocks->is_periodic_reduced != 0u) {
            for (std::uint64_t u = 0; u < blocks->full_node_count; ++u) {
                if (static_cast<std::uint64_t>(blocks->periodic_reduced_node[u]) >= n_phi) {
                    error = "cuDSS driven response periodic_reduced_node entry out of range";
                    return false;
                }
            }
        }

        constexpr std::uint32_t kNotMagnetic = std::numeric_limits<std::uint32_t>::max();
        std::vector<std::uint32_t> full_to_mag(
            static_cast<std::size_t>(blocks->full_node_count), kNotMagnetic);
        for (std::uint64_t u = 0; u < n_m; ++u) {
            const std::uint32_t g = blocks->magnetic_node_indices[u];
            if (static_cast<std::uint64_t>(g) >= blocks->full_node_count ||
                full_to_mag[static_cast<std::size_t>(g)] != kNotMagnetic) {
                error = "cuDSS driven response magnetic_node_indices contains invalid or duplicate node";
                return false;
            }
            full_to_mag[static_cast<std::size_t>(g)] = static_cast<std::uint32_t>(u);
        }

        const std::array<const DrivenFrequencyResponseSparseCsrView *, 3> rec_views = {
            &blocks->recovery_x, &blocks->recovery_y, &blocks->recovery_z};
        const std::array<const DrivenFrequencyResponseSparseCsrView *, 3> rhs_views = {
            &blocks->rhs_x, &blocks->rhs_y, &blocks->rhs_z};

        // K_{q phi} = R_{gamma0} E_lift^T G_rec (with periodic row averaging if active)
        for (std::uint64_t u = 0; u < n_m; ++u) {
            const std::uint32_t g = blocks->magnetic_node_indices[u];
            const std::uint32_t ru = periodic.node_to_reduced[static_cast<std::size_t>(u)];
            const double scale =
                gamma0 / static_cast<double>(periodic.class_size[static_cast<std::size_t>(ru)]);
            const TangentFrameNode &node = problem.nodes[u];
            for (int c = 0; c < 3; ++c) {
                const auto &rec = *rec_views[static_cast<std::size_t>(c)];
                const std::uint32_t begin = rec.row_ptr[g];
                const std::uint32_t end = rec.row_ptr[g + 1u];
                for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
                    const std::uint32_t p = rec.col_indices[cursor];
                    const double val = rec.values[cursor];
                    if (static_cast<std::uint64_t>(p) >= n_phi || !std::isfinite(val)) {
                        error = "cuDSS driven response received invalid recovery CSR entry";
                        return false;
                    }
                    const std::uint32_t col = static_cast<std::uint32_t>(n_q) + p;
                    const double c0 = scale * node.e2[c] * val;
                    const double c1 = -scale * node.e1[c] * val;
                    if (c0 != 0.0) {
                        rows[2u * ru].emplace_back(col, c0);
                    }
                    if (c1 != 0.0) {
                        rows[2u * ru + 1u].emplace_back(col, c1);
                    }
                }
            }
        }

        // -R_{phi q} = -D_rhs E_lift L_per (explicitly skipping ess_tdofs rows!)
        for (std::uint64_t p = 0; p < n_phi; ++p) {
            if (is_ess_row[static_cast<std::size_t>(p)] != 0u) {
                continue;
            }
            const std::uint32_t row_aug = static_cast<std::uint32_t>(n_q + p);
            for (int c = 0; c < 3; ++c) {
                const auto &rhs = *rhs_views[static_cast<std::size_t>(c)];
                const std::uint32_t begin = rhs.row_ptr[p];
                const std::uint32_t end = rhs.row_ptr[p + 1u];
                for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
                    const std::uint32_t g = rhs.col_indices[cursor];
                    const double val = rhs.values[cursor];
                    if (static_cast<std::uint64_t>(g) >= blocks->full_node_count ||
                        !std::isfinite(val)) {
                        error = "cuDSS driven response received invalid RHS CSR entry";
                        return false;
                    }
                    const std::uint32_t u = full_to_mag[static_cast<std::size_t>(g)];
                    if (u == kNotMagnetic) {
                        continue;
                    }
                    const std::uint32_t ru = periodic.node_to_reduced[static_cast<std::size_t>(u)];
                    const TangentFrameNode &node = problem.nodes[u];
                    const double v0 = -val * node.e1[c];
                    const double v1 = -val * node.e2[c];
                    if (v0 != 0.0) {
                        rows[row_aug].emplace_back(2u * ru, v0);
                    }
                    if (v1 != 0.0) {
                        rows[row_aug].emplace_back(2u * ru + 1u, v1);
                    }
                }
            }
        }

        // P (poisson_matrix)
        for (std::uint64_t p = 0; p < n_phi; ++p) {
            const std::uint32_t row_aug = static_cast<std::uint32_t>(n_q + p);
            const std::uint32_t begin = blocks->poisson_matrix.row_ptr[p];
            const std::uint32_t end = blocks->poisson_matrix.row_ptr[p + 1u];
            for (std::uint32_t cursor = begin; cursor < end; ++cursor) {
                const std::uint32_t q_col = blocks->poisson_matrix.col_indices[cursor];
                const double val = blocks->poisson_matrix.values[cursor];
                if (static_cast<std::uint64_t>(q_col) >= n_phi || !std::isfinite(val)) {
                    error = "cuDSS driven response received invalid Poisson CSR entry";
                    return false;
                }
                rows[row_aug].emplace_back(static_cast<std::uint32_t>(n_q) + q_col, val);
            }
        }
    }

    // Coalesce sorted rows into 0-based CSR and capture exact omega slot indices.
    out = DrivenResponseAugmentedCsr{};
    out.n_m_eff = static_cast<std::uint32_t>(n_m_eff);
    out.n_q = static_cast<std::uint32_t>(n_q);
    out.n_phi = static_cast<std::uint32_t>(n_phi);
    out.n_aug = static_cast<std::uint32_t>(n_aug);
    out.row_ptr.assign(static_cast<std::size_t>(n_aug) + 1u, 0u);

    std::size_t estimated_nnz = 0;
    for (const auto &r : rows) {
        estimated_nnz += r.size();
    }
    out.col_indices.reserve(estimated_nnz);
    out.base_real_values.reserve(estimated_nnz);
    out.slot_csr_indices.assign(static_cast<std::size_t>(4u * n_m_eff), 0u);
    out.slot_mass_entries.assign(static_cast<std::size_t>(4u * n_m_eff), 0.0);

    std::uint64_t nnz = 0;
    for (std::uint32_t row = 0; row < out.n_aug; ++row) {
        auto &entries = rows[static_cast<std::size_t>(row)];
        std::sort(
            entries.begin(),
            entries.end(),
            [](const auto &lhs, const auto &rhs) { return lhs.first < rhs.first; });

        double row_sum_p = 0.0;
        double row_sum_r_phi_q = 0.0;
        const bool is_mag_row = row < out.n_q;
        const std::uint32_t diag_block_base = is_mag_row ? (row & ~1u) : 0u;

        for (std::size_t idx = 0; idx < entries.size();) {
            const std::uint32_t col = entries[idx].first;
            double sum = entries[idx].second;
            ++idx;
            while (idx < entries.size() && entries[idx].first == col) {
                sum += entries[idx].second;
                ++idx;
            }
            if (!std::isfinite(sum)) {
                error = "cuDSS driven response assembled a non-finite augmented matrix entry";
                return false;
            }
            const bool is_omega_slot =
                is_mag_row && (col == diag_block_base || col == diag_block_base + 1u);
            if (!is_omega_slot && sum == 0.0) {
                continue;
            }
            if (nnz >= static_cast<std::uint64_t>(std::numeric_limits<std::int32_t>::max())) {
                error = "cuDSS driven response CSR nnz exceeds 32-bit cuDSS index limit";
                return false;
            }
            const std::uint32_t csr_idx = static_cast<std::uint32_t>(nnz);
            out.col_indices.push_back(col);
            out.base_real_values.push_back(sum);
            ++nnz;

            if (is_omega_slot) {
                const std::uint32_t node_r = row >> 1u;
                const std::uint32_t local_row = row & 1u;
                const std::uint32_t local_col = col - diag_block_base;
                const std::size_t slot =
                    static_cast<std::size_t>(node_r) * 4u +
                    static_cast<std::size_t>(local_row) * 2u +
                    static_cast<std::size_t>(local_col);
                out.slot_csr_indices[slot] = csr_idx;
                const double alpha_r = reduced_alpha[static_cast<std::size_t>(node_r)];
                // M_jj = [[1, alpha_r], [-alpha_r, 1]]
                if (local_row == local_col) {
                    out.slot_mass_entries[slot] = 1.0;
                } else if (local_row == 0u) {
                    out.slot_mass_entries[slot] = alpha_r;
                } else {
                    out.slot_mass_entries[slot] = -alpha_r;
                }
            } else if (!is_mag_row) {
                if (col < out.n_q) {
                    row_sum_r_phi_q += std::abs(sum);
                } else {
                    row_sum_p += std::abs(sum);
                }
            }
        }
        out.row_ptr[static_cast<std::size_t>(row) + 1u] = static_cast<std::uint32_t>(nnz);
        if (!is_mag_row) {
            out.inf_norm_p = std::max(out.inf_norm_p, row_sum_p);
            out.inf_norm_r_phi_q = std::max(out.inf_norm_r_phi_q, row_sum_r_phi_q);
        }
        // Release per-row temporary storage progressively to minimize host peak RAM.
        std::vector<std::pair<std::uint32_t, double>>().swap(entries);
    }
    return true;
}

bool compute_ruiz_equilibration(
    const DrivenResponseAugmentedCsr &csr,
    double omega_ref,
    std::vector<double> &row_scale,
    std::vector<double> &col_scale,
    std::string &error)
{
    const std::size_t n = static_cast<std::size_t>(csr.n_aug);
    const std::size_t nnz = csr.base_real_values.size();
    std::vector<double> abs_ref(nnz, 0.0);
    for (std::size_t idx = 0; idx < nnz; ++idx) {
        abs_ref[idx] = std::abs(csr.base_real_values[idx]);
    }
    for (std::size_t slot = 0; slot < csr.slot_csr_indices.size(); ++slot) {
        const std::uint32_t idx = csr.slot_csr_indices[slot];
        abs_ref[idx] = std::hypot(
            csr.base_real_values[idx],
            -omega_ref * csr.slot_mass_entries[slot]);
    }

    row_scale.assign(n, 1.0);
    col_scale.assign(n, 1.0);
    std::vector<double> row_max(n, 0.0);
    std::vector<double> col_max(n, 0.0);

    constexpr int kRuizPasses = 6;
    for (int pass = 0; pass < kRuizPasses; ++pass) {
        std::fill(row_max.begin(), row_max.end(), 0.0);
        std::fill(col_max.begin(), col_max.end(), 0.0);
        for (std::size_t row = 0; row < n; ++row) {
            const double dr = row_scale[row];
            const std::uint32_t begin = csr.row_ptr[row];
            const std::uint32_t end = csr.row_ptr[row + 1u];
            double local_row_max = 0.0;
            for (std::uint32_t idx = begin; idx < end; ++idx) {
                const std::uint32_t col = csr.col_indices[idx];
                const double scaled = dr * abs_ref[idx] * col_scale[col];
                if (scaled > local_row_max) {
                    local_row_max = scaled;
                }
                if (scaled > col_max[col]) {
                    col_max[col] = scaled;
                }
            }
            row_max[row] = local_row_max;
        }
        for (std::size_t i = 0; i < n; ++i) {
            if (row_max[i] > 0.0) {
                row_scale[i] /= std::sqrt(row_max[i]);
            }
            if (col_max[i] > 0.0) {
                col_scale[i] /= std::sqrt(col_max[i]);
            }
            if (!std::isfinite(row_scale[i]) || !(row_scale[i] > 0.0) ||
                !std::isfinite(col_scale[i]) || !(col_scale[i] > 0.0)) {
                error = "cuDSS driven response Ruiz equilibration produced non-finite scaling";
                return false;
            }
        }
    }
    return true;
}

struct DrivenResponseCudssDeviceSession {
    cudaStream_t stream = nullptr;
    cudssHandle_t handle = nullptr;
    cudssConfig_t config = nullptr;
    cudssData_t data = nullptr;
    cudssMatrix_t matrix = nullptr;
    cudssMatrix_t rhs_desc = nullptr;
    cudssMatrix_t sol_desc = nullptr;

    std::uint32_t *d_row_ptr = nullptr;
    std::uint32_t *d_col_indices = nullptr;
    double2 *d_csr_values = nullptr;
    std::uint32_t *d_slot_csr_indices = nullptr;
    double2 *d_slot_base_values = nullptr;
    double *d_slot_omega_imag_coeffs = nullptr;
    double *d_row_scale = nullptr;
    double *d_col_scale = nullptr;
    double2 *d_b_unscaled = nullptr;
    double2 *d_b_scaled = nullptr;
    double2 *d_y_scaled = nullptr;
    double2 *d_x_unscaled = nullptr;
    void *d_norm_partials = nullptr;
    double *d_out_norms = nullptr;
    double *h_out_norms = nullptr;
    bool host_norms_pinned = false;

    ~DrivenResponseCudssDeviceSession() noexcept { destroy(); }

    void destroy() noexcept
    {
        if (stream != nullptr) {
            (void)cudaStreamSynchronize(stream);
        }
        if (data != nullptr && handle != nullptr) {
            (void)cudssDataDestroy(handle, data);
            data = nullptr;
        }
        if (sol_desc != nullptr) {
            (void)cudssMatrixDestroy(sol_desc);
            sol_desc = nullptr;
        }
        if (rhs_desc != nullptr) {
            (void)cudssMatrixDestroy(rhs_desc);
            rhs_desc = nullptr;
        }
        if (matrix != nullptr) {
            (void)cudssMatrixDestroy(matrix);
            matrix = nullptr;
        }
        if (config != nullptr) {
            (void)cudssConfigDestroy(config);
            config = nullptr;
        }
        if (handle != nullptr) {
            (void)cudssDestroy(handle);
            handle = nullptr;
        }

        auto free_dev = [](auto *&ptr) {
            if (ptr != nullptr) {
                (void)cudaFree(ptr);
                ptr = nullptr;
            }
        };
        free_dev(d_row_ptr);
        free_dev(d_col_indices);
        free_dev(d_csr_values);
        free_dev(d_slot_csr_indices);
        free_dev(d_slot_base_values);
        free_dev(d_slot_omega_imag_coeffs);
        free_dev(d_row_scale);
        free_dev(d_col_scale);
        free_dev(d_b_unscaled);
        free_dev(d_b_scaled);
        free_dev(d_y_scaled);
        free_dev(d_x_unscaled);
        free_dev(d_norm_partials);
        free_dev(d_out_norms);

        if (h_out_norms != nullptr) {
            if (host_norms_pinned) {
                (void)cudaFreeHost(h_out_norms);
            } else {
                delete[] h_out_norms;
            }
            h_out_norms = nullptr;
        }
        host_norms_pinned = false;

        if (stream != nullptr) {
            (void)cudaStreamDestroy(stream);
            stream = nullptr;
        }
    }
};

template <class T>
bool alloc_and_upload_device(
    T *&dst,
    const std::vector<T> &src,
    cudaStream_t stream,
    const char *label,
    std::string &error)
{
    if (src.empty()) {
        dst = nullptr;
        return true;
    }
    const std::size_t bytes = src.size() * sizeof(T);
    const cudaError_t alloc_rc = cudaMalloc(reinterpret_cast<void **>(&dst), bytes);
    if (alloc_rc != cudaSuccess) {
        error = std::string("cuDSS driven response cudaMalloc failed for ") + label + ": " +
            cudaGetErrorString(alloc_rc);
        return false;
    }
    const cudaError_t copy_rc =
        cudaMemcpyAsync(dst, src.data(), bytes, cudaMemcpyHostToDevice, stream);
    if (copy_rc != cudaSuccess) {
        error = std::string("cuDSS driven response cudaMemcpyAsync failed for ") + label + ": " +
            cudaGetErrorString(copy_rc);
        return false;
    }
    return true;
}

void compute_tangent_h_demag_from_phi(
    const DrivenFrequencyResponseMfemValidationProblem &problem,
    const DrivenFrequencyResponseDemagSparseBlocks &blocks,
    const double2 *delta_phi,
    double *out_h_demag_real,
    double *out_h_demag_imag) noexcept
{
    const std::uint64_t n_m = problem.descriptor.node_count;
    for (std::uint64_t u = 0; u < n_m; ++u) {
        const std::uint32_t g = blocks.magnetic_node_indices[u];
        double hx_re = 0.0, hx_im = 0.0;
        double hy_re = 0.0, hy_im = 0.0;
        double hz_re = 0.0, hz_im = 0.0;

        for (std::uint32_t c = blocks.recovery_x.row_ptr[g];
             c < blocks.recovery_x.row_ptr[g + 1u];
             ++c) {
            const double val = blocks.recovery_x.values[c];
            const double2 phi = delta_phi[blocks.recovery_x.col_indices[c]];
            hx_re += val * phi.x;
            hx_im += val * phi.y;
        }
        for (std::uint32_t c = blocks.recovery_y.row_ptr[g];
             c < blocks.recovery_y.row_ptr[g + 1u];
             ++c) {
            const double val = blocks.recovery_y.values[c];
            const double2 phi = delta_phi[blocks.recovery_y.col_indices[c]];
            hy_re += val * phi.x;
            hy_im += val * phi.y;
        }
        for (std::uint32_t c = blocks.recovery_z.row_ptr[g];
             c < blocks.recovery_z.row_ptr[g + 1u];
             ++c) {
            const double val = blocks.recovery_z.values[c];
            const double2 phi = delta_phi[blocks.recovery_z.col_indices[c]];
            hz_re += val * phi.x;
            hz_im += val * phi.y;
        }

        const TangentFrameNode &node = problem.nodes[u];
        out_h_demag_real[2u * u] =
            hx_re * node.e1[0] + hy_re * node.e1[1] + hz_re * node.e1[2];
        out_h_demag_real[2u * u + 1u] =
            hx_re * node.e2[0] + hy_re * node.e2[1] + hz_re * node.e2[2];
        out_h_demag_imag[2u * u] =
            hx_im * node.e1[0] + hy_im * node.e1[1] + hz_im * node.e1[2];
        out_h_demag_imag[2u * u + 1u] =
            hx_im * node.e2[0] + hy_im * node.e2[1] + hz_im * node.e2[2];
    }
}

#endif // FULLMAG_DRIVEN_CUDSS_ACTIVE

} // namespace

FrequencyDomainStatus solve_driven_response_gpu_cudss(
    const DrivenFrequencyResponseSolveRequest &request,
    const double *drive_real,
    const double *drive_imag,
    double *out_response_real,
    double *out_response_imag,
    double *out_residual_l2,
    double *out_relative_residual_l2,
    double *out_delta_phi_full_real_opt,
    double *out_delta_phi_full_imag_opt,
    double *out_h_demag_real_opt,
    double *out_h_demag_imag_opt,
    DrivenResponseCudssOutcome *out_outcome) noexcept
{
    DrivenResponseCudssOutcome outcome{};
    auto finish = [&](FrequencyDomainStatus status) noexcept {
        outcome.status = status;
        if (out_outcome != nullptr) {
            *out_outcome = outcome;
        }
        return status;
    };

    try {
        if (request.gpu_direct_policy == DrivenFrequencyResponseGpuDirectPolicy::Disabled) {
            outcome.used_cudss = false;
            outcome.fallback_to_krylov = true;
            outcome.fallback_reason = "policy_disabled";
            return finish(FrequencyDomainStatus::ok);
        }

        // Always validate VRAM budget env vars fail-closed, even under Auto.
        bool has_vram_cap = false;
        std::uint64_t vram_cap_bytes = 0;
        std::string env_error;
        if (!parse_driven_cudss_budget_caps(has_vram_cap, vram_cap_bytes, env_error)) {
            outcome.used_cudss = false;
            outcome.fallback_to_krylov = false;
            outcome.error_message = env_error;
            return finish(FrequencyDomainStatus::validation_error);
        }

        const bool demag_enabled = request_demag_enabled(request);
        if (request_has_nonzero_floquet_k(request)) {
            const char *reason = demag_enabled
                ? "floquet_nonzero_k_demag_unsupported"
                : "floquet_nonzero_k_unsupported";
            return finish(handle_unsupported_or_fallback(
                request.gpu_direct_policy,
                reason,
                "GPU cuDSS driven-response solver does not support nonzero-k Floquet operators",
                outcome));
        }

        if (demag_enabled && request.demag_sparse_blocks == nullptr) {
            return finish(handle_unsupported_or_fallback(
                request.gpu_direct_policy,
                "demag_sparse_blocks_unavailable",
                "GPU cuDSS driven-response solver requires exported Poisson demag sparse CSR blocks",
                outcome));
        }

        if (demag_enabled &&
            request.demag_sparse_blocks != nullptr &&
            (out_delta_phi_full_real_opt != nullptr || out_delta_phi_full_imag_opt != nullptr) &&
            (request.requires_periodic_airbox_dynamic_demag ||
             request.periodic_airbox_delta_phi_dof_count > 0u)) {
            const std::uint64_t expected_out_phi_stride =
                request.demag_sparse_blocks->is_periodic_reduced != 0u
                    ? request.demag_sparse_blocks->full_node_count
                    : request.demag_sparse_blocks->phi_dof_count;
            if (expected_out_phi_stride != request.periodic_airbox_delta_phi_dof_count) {
                outcome.used_cudss = false;
                outcome.fallback_to_krylov = false;
                outcome.error_message =
                    "cuDSS driven response delta_phi output stride does not match periodic_airbox_delta_phi_dof_count";
                return finish(FrequencyDomainStatus::validation_error);
            }
        }

#if !FULLMAG_DRIVEN_CUDSS_ACTIVE
        (void)drive_real;
        (void)drive_imag;
        (void)out_response_real;
        (void)out_response_imag;
        (void)out_residual_l2;
        (void)out_relative_residual_l2;
        (void)out_delta_phi_full_real_opt;
        (void)out_delta_phi_full_imag_opt;
        (void)out_h_demag_real_opt;
        (void)out_h_demag_imag_opt;
        (void)has_vram_cap;
        (void)vram_cap_bytes;
        return finish(handle_unsupported_or_fallback(
            request.gpu_direct_policy,
            "cudss_unavailable",
            "GPU cuDSS driven-response direct solver is unavailable in this build",
            outcome));
#else
        const auto &problem = request.mfem_validation_problem;
        const std::uint64_t n_m = problem.descriptor.node_count;
        const std::uint64_t n_q_full =
            request.solve_request.operator_request.tangent_dof_count;
        const std::uint64_t freq_count = request.solve_request.frequency_count;

        if (!problem.enabled ||
            n_m == 0u ||
            n_q_full != 2u * n_m ||
            problem.descriptor.tangent_dof_count != n_q_full ||
            problem.nodes == nullptr ||
            freq_count == 0u ||
            request.solve_request.frequencies_hz == nullptr ||
            drive_real == nullptr ||
            out_response_real == nullptr ||
            out_response_imag == nullptr) {
            outcome.error_message =
                "cuDSS driven response received incomplete or mismatched request payload";
            return finish(FrequencyDomainStatus::validation_error);
        }

        double min_freq_hz = std::numeric_limits<double>::infinity();
        double max_freq_hz = 0.0;
        for (std::uint64_t k = 0; k < freq_count; ++k) {
            const double f = request.solve_request.frequencies_hz[k];
            if (!std::isfinite(f) || !(f > 0.0)) {
                outcome.error_message =
                    "cuDSS driven response requires strictly positive finite frequencies";
                return finish(FrequencyDomainStatus::validation_error);
            }
            min_freq_hz = std::min(min_freq_hz, f);
            max_freq_hz = std::max(max_freq_hz, f);
        }
        for (std::uint64_t i = 0; i < n_q_full; ++i) {
            if (!std::isfinite(drive_real[i]) ||
                (drive_imag != nullptr && !std::isfinite(drive_imag[i]))) {
                outcome.error_message =
                    "cuDSS driven response received non-finite drive vector entry";
                return finish(FrequencyDomainStatus::validation_error);
            }
        }

        StaticPeriodicReduction periodic{};
        std::string error;
        if (!build_static_periodic_reduction(problem, periodic, error)) {
            outcome.error_message = error;
            return finish(FrequencyDomainStatus::validation_error);
        }

        const DrivenFrequencyResponseDemagSparseBlocks *blocks =
            demag_enabled ? request.demag_sparse_blocks : nullptr;
        DrivenResponseAugmentedCsr csr{};
        if (!assemble_augmented_csr(request, periodic, blocks, csr, error)) {
            outcome.error_message = error;
            return finish(FrequencyDomainStatus::validation_error);
        }

        constexpr double kTwoPi = 6.283185307179586476925286766559005768;
        const double omega_ref = kTwoPi * std::sqrt(min_freq_hz * max_freq_hz);
        std::vector<double> row_scale;
        std::vector<double> col_scale;
        if (!compute_ruiz_equilibration(csr, omega_ref, row_scale, col_scale, error)) {
            outcome.error_message = error;
            return finish(FrequencyDomainStatus::solve_error);
        }

        // Build Ruiz-scaled host arrays for one-time upload.
        const std::size_t n_aug = static_cast<std::size_t>(csr.n_aug);
        const std::size_t nnz = csr.base_real_values.size();
        std::vector<double2> h_scaled_base_values(nnz);
        for (std::size_t row = 0; row < n_aug; ++row) {
            const double dr = row_scale[row];
            const std::uint32_t begin = csr.row_ptr[row];
            const std::uint32_t end = csr.row_ptr[row + 1u];
            for (std::uint32_t idx = begin; idx < end; ++idx) {
                const double val = dr * csr.base_real_values[idx] * col_scale[csr.col_indices[idx]];
                h_scaled_base_values[idx] = make_double2(val, 0.0);
            }
        }

        const std::size_t slot_count = csr.slot_csr_indices.size();
        std::vector<double2> h_slot_base_values(slot_count);
        std::vector<double> h_slot_omega_imag_coeffs(slot_count);
        for (std::size_t slot = 0; slot < slot_count; ++slot) {
            const std::uint32_t node_r = static_cast<std::uint32_t>(slot / 4u);
            const std::uint32_t local_row = static_cast<std::uint32_t>((slot % 4u) / 2u);
            const std::uint32_t local_col = static_cast<std::uint32_t>(slot % 2u);
            const std::uint32_t row = 2u * node_r + local_row;
            const std::uint32_t col = 2u * node_r + local_col;
            const std::uint32_t csr_idx = csr.slot_csr_indices[slot];
            h_slot_base_values[slot] = h_scaled_base_values[csr_idx];
            h_slot_omega_imag_coeffs[slot] =
                row_scale[row] * csr.slot_mass_entries[slot] * col_scale[col];
        }

        // Compress full drive into reduced magnetic space (C_per f) and zero-pad phi block.
        std::vector<double2> h_b_unscaled(n_aug, make_double2(0.0, 0.0));
        for (std::uint64_t u = 0; u < n_m; ++u) {
            const std::uint32_t ru = periodic.node_to_reduced[static_cast<std::size_t>(u)];
            const double inv_count =
                1.0 / static_cast<double>(periodic.class_size[static_cast<std::size_t>(ru)]);
            const double fr0 = drive_real[2u * u];
            const double fr1 = drive_real[2u * u + 1u];
            const double fi0 = drive_imag != nullptr ? drive_imag[2u * u] : 0.0;
            const double fi1 = drive_imag != nullptr ? drive_imag[2u * u + 1u] : 0.0;
            h_b_unscaled[2u * ru].x += fr0 * inv_count;
            h_b_unscaled[2u * ru].y += fi0 * inv_count;
            h_b_unscaled[2u * ru + 1u].x += fr1 * inv_count;
            h_b_unscaled[2u * ru + 1u].y += fi1 * inv_count;
        }
        std::vector<double2> h_b_scaled(n_aug, make_double2(0.0, 0.0));
        for (std::size_t i = 0; i < n_aug; ++i) {
            h_b_scaled[i] = make_double2(
                row_scale[i] * h_b_unscaled[i].x,
                row_scale[i] * h_b_unscaled[i].y);
        }

        // Initialize CUDA stream, cuDSS handles, and device buffers.
        DrivenResponseCudssDeviceSession dev{};
        if (cudaStreamCreateWithFlags(&dev.stream, cudaStreamNonBlocking) != cudaSuccess) {
            outcome.error_message = "cuDSS driven response failed to create CUDA stream";
            return finish(FrequencyDomainStatus::operator_error);
        }
        if (cudssCreate(&dev.handle) != CUDSS_STATUS_SUCCESS ||
            cudssSetStream(dev.handle, dev.stream) != CUDSS_STATUS_SUCCESS ||
            cudssConfigCreate(&dev.config) != CUDSS_STATUS_SUCCESS ||
            cudssDataCreate(dev.handle, &dev.data) != CUDSS_STATUS_SUCCESS) {
            outcome.error_message = "cuDSS driven response failed to initialize cuDSS handles";
            return finish(FrequencyDomainStatus::operator_error);
        }

        const int hybrid_off = 0;
        const int ir_steps = 1;
        if (cudssConfigSet(
                dev.config, CUDSS_CONFIG_HYBRID_MEMORY_MODE, &hybrid_off, sizeof(hybrid_off)) !=
                CUDSS_STATUS_SUCCESS ||
            cudssConfigSet(
                dev.config, CUDSS_CONFIG_HYBRID_EXECUTE_MODE, &hybrid_off, sizeof(hybrid_off)) !=
                CUDSS_STATUS_SUCCESS ||
            cudssConfigSet(
                dev.config, CUDSS_CONFIG_IR_N_STEPS, &ir_steps, sizeof(ir_steps)) !=
                CUDSS_STATUS_SUCCESS) {
            outcome.error_message = "cuDSS driven response failed to configure cuDSS options";
            return finish(FrequencyDomainStatus::operator_error);
        }

        const std::size_t vec_bytes = n_aug * sizeof(double2);
        const std::size_t partials_bytes = detail::driven_response_norm_partials_bytes();
        if (!alloc_and_upload_device(dev.d_row_ptr, csr.row_ptr, dev.stream, "row_ptr", error) ||
            !alloc_and_upload_device(dev.d_col_indices, csr.col_indices, dev.stream, "col_indices", error) ||
            !alloc_and_upload_device(dev.d_csr_values, h_scaled_base_values, dev.stream, "csr_values", error) ||
            !alloc_and_upload_device(dev.d_slot_csr_indices, csr.slot_csr_indices, dev.stream, "slot_csr_indices", error) ||
            !alloc_and_upload_device(dev.d_slot_base_values, h_slot_base_values, dev.stream, "slot_base_values", error) ||
            !alloc_and_upload_device(dev.d_slot_omega_imag_coeffs, h_slot_omega_imag_coeffs, dev.stream, "slot_omega_coeffs", error) ||
            !alloc_and_upload_device(dev.d_row_scale, row_scale, dev.stream, "row_scale", error) ||
            !alloc_and_upload_device(dev.d_col_scale, col_scale, dev.stream, "col_scale", error) ||
            !alloc_and_upload_device(dev.d_b_unscaled, h_b_unscaled, dev.stream, "b_unscaled", error) ||
            !alloc_and_upload_device(dev.d_b_scaled, h_b_scaled, dev.stream, "b_scaled", error) ||
            cudaMalloc(reinterpret_cast<void **>(&dev.d_y_scaled), vec_bytes) != cudaSuccess ||
            cudaMalloc(reinterpret_cast<void **>(&dev.d_x_unscaled), vec_bytes) != cudaSuccess ||
            cudaMalloc(&dev.d_norm_partials, partials_bytes) != cudaSuccess ||
            cudaMalloc(reinterpret_cast<void **>(&dev.d_out_norms), 8u * sizeof(double)) != cudaSuccess) {
            outcome.error_message = error.empty()
                ? "cuDSS driven response failed to allocate GPU buffers"
                : error;
            return finish(FrequencyDomainStatus::operator_error);
        }

        if (force_pageable_scalar_readback()) {
            dev.h_out_norms = new double[8]{};
            dev.host_norms_pinned = false;
        } else if (cudaMallocHost(
                       reinterpret_cast<void **>(&dev.h_out_norms),
                       8u * sizeof(double)) == cudaSuccess) {
            dev.host_norms_pinned = true;
        } else {
            dev.h_out_norms = new double[8]{};
            dev.host_norms_pinned = false;
        }

        static_assert(sizeof(std::uint32_t) == sizeof(std::int32_t));
        const std::int64_t dim = static_cast<std::int64_t>(csr.n_aug);
        const std::int64_t nnz_i64 = static_cast<std::int64_t>(nnz);
        if (cudssMatrixCreateCsr(
                &dev.matrix,
                dim,
                dim,
                nnz_i64,
                dev.d_row_ptr,
                nullptr,
                dev.d_col_indices,
                dev.d_csr_values,
                CUDSS_R_32I,
                CUDSS_R_32I,
                CUDSS_C_64F,
                CUDSS_MTYPE_GENERAL,
                CUDSS_MVIEW_FULL,
                CUDSS_BASE_ZERO) != CUDSS_STATUS_SUCCESS ||
            cudssMatrixCreateDn(
                &dev.rhs_desc,
                dim,
                1,
                dim,
                dev.d_b_scaled,
                CUDSS_C_64F,
                CUDSS_LAYOUT_COL_MAJOR) != CUDSS_STATUS_SUCCESS ||
            cudssMatrixCreateDn(
                &dev.sol_desc,
                dim,
                1,
                dim,
                dev.d_y_scaled,
                CUDSS_C_64F,
                CUDSS_LAYOUT_COL_MAJOR) != CUDSS_STATUS_SUCCESS) {
            outcome.error_message = "cuDSS driven response failed to create cuDSS descriptors";
            return finish(FrequencyDomainStatus::operator_error);
        }

        // One-time symbolic analysis for the entire frequency sweep.
        if (cudssExecute(
                dev.handle,
                CUDSS_PHASE_ANALYSIS,
                dev.config,
                dev.data,
                dev.matrix,
                dev.sol_desc,
                dev.rhs_desc) != CUDSS_STATUS_SUCCESS ||
            cudaStreamSynchronize(dev.stream) != cudaSuccess) {
            outcome.error_message = "cuDSS driven response symbolic analysis failed";
            return finish(FrequencyDomainStatus::solve_error);
        }
        outcome.symbolic_analysis_count = 1u;

        // VRAM memory preflight before launching factorization.
        std::array<std::int64_t, 16> estimates{};
        std::size_t estimates_written = 0;
        if (cudssDataGet(
                dev.handle,
                dev.data,
                CUDSS_DATA_MEMORY_ESTIMATES,
                estimates.data(),
                sizeof(estimates),
                &estimates_written) != CUDSS_STATUS_SUCCESS ||
            estimates_written < 2u * sizeof(estimates[0]) ||
            estimates[1] <= 0) {
            dev.destroy();
            return finish(handle_unsupported_or_fallback(
                request.gpu_direct_policy,
                "cudss_peak_memory_estimate_unavailable",
                "cuDSS driven response could not query post-analysis VRAM peak estimate; factorization not started",
                outcome));
        }

        std::size_t free_bytes = 0;
        std::size_t total_bytes = 0;
        if (cudaMemGetInfo(&free_bytes, &total_bytes) != cudaSuccess ||
            total_bytes == 0u ||
            free_bytes > total_bytes) {
            dev.destroy();
            return finish(handle_unsupported_or_fallback(
                request.gpu_direct_policy,
                "cudss_device_memory_budget_unavailable",
                "cuDSS driven response could not query cudaMemGetInfo; factorization not started",
                outcome));
        }

        const std::uint64_t reserve = std::max<std::uint64_t>(
            kMinimumVramReserveBytes,
            static_cast<std::uint64_t>(total_bytes) / 20u);
        const std::uint64_t available =
            static_cast<std::uint64_t>(free_bytes) > reserve
                ? static_cast<std::uint64_t>(free_bytes) - reserve
                : 0u;
        const std::uint64_t budget = has_vram_cap
            ? std::min(available, vram_cap_bytes)
            : available;
        const std::uint64_t peak = static_cast<std::uint64_t>(estimates[1]);
        outcome.estimated_peak_device_bytes = peak;
        outcome.device_budget_bytes = budget;

        if (peak > budget) {
            dev.destroy();
            char msg[384]{};
            std::snprintf(
                msg,
                sizeof(msg),
                "cuDSS driven response estimated peak VRAM (%llu bytes) exceeds device budget (%llu bytes); factorization not started",
                static_cast<unsigned long long>(peak),
                static_cast<unsigned long long>(budget));
            return finish(handle_unsupported_or_fallback(
                request.gpu_direct_policy,
                "cudss_peak_memory_budget_exceeded",
                msg,
                outcome));
        }

        const double omega_sign = phase_sign(request.phase_convention);
        const double rtol = resolve_direct_rtol(request);
        const double atol = resolve_direct_atol(request);
        std::vector<double2> h_x_unscaled(n_aug);
        const std::uint64_t out_phi_stride = blocks != nullptr
            ? (blocks->is_periodic_reduced != 0u ? blocks->full_node_count : blocks->phi_dof_count)
            : 0u;
        if (blocks != nullptr &&
            (out_delta_phi_full_real_opt != nullptr || out_delta_phi_full_imag_opt != nullptr) &&
            (request.requires_periodic_airbox_dynamic_demag ||
             request.periodic_airbox_delta_phi_dof_count > 0u) &&
            out_phi_stride != request.periodic_airbox_delta_phi_dof_count) {
            outcome.used_cudss = false;
            outcome.fallback_to_krylov = false;
            outcome.error_message =
                "cuDSS driven response delta_phi output stride does not match periodic_airbox_delta_phi_dof_count";
            return finish(FrequencyDomainStatus::validation_error);
        }

        // Per-frequency sweep loop: zero H2D matrix copies!
        for (std::uint64_t k = 0; k < freq_count; ++k) {
            if (request.cancel_requested != nullptr &&
                request.cancel_requested(request.cancel_user_data)) {
                outcome.used_cudss = true;
                outcome.completed_frequency_count = k;
                outcome.error_message = "cuDSS driven response interrupted by cancellation request";
                return finish(FrequencyDomainStatus::interrupted);
            }

            const double freq_hz = request.solve_request.frequencies_hz[k];
            const double omega_k = omega_sign * kTwoPi * freq_hz;

            const cudaError_t upd_rc = detail::launch_driven_response_update_omega_entries(
                dev.d_slot_csr_indices,
                dev.d_slot_base_values,
                dev.d_slot_omega_imag_coeffs,
                omega_k,
                dev.d_csr_values,
                static_cast<std::uint32_t>(slot_count),
                dev.stream);
            if (upd_rc != cudaSuccess) {
                outcome.used_cudss = true;
                outcome.fallback_to_krylov = false;
                outcome.completed_frequency_count = k;
                outcome.error_message =
                    std::string("cuDSS driven response omega diagonal update failed: ") +
                    cudaGetErrorString(upd_rc);
                return finish(FrequencyDomainStatus::operator_error);
            }

            if (cudssMatrixSetValues(dev.matrix, dev.d_csr_values) != CUDSS_STATUS_SUCCESS) {
                outcome.used_cudss = true;
                outcome.fallback_to_krylov = false;
                outcome.completed_frequency_count = k;
                outcome.error_message = "cuDSS driven response cudssMatrixSetValues failed";
                return finish(FrequencyDomainStatus::solve_error);
            }

            const cudssStatus_t fact_status = cudssExecute(
                dev.handle,
                CUDSS_PHASE_FACTORIZATION,
                dev.config,
                dev.data,
                dev.matrix,
                dev.sol_desc,
                dev.rhs_desc);
            const cudaError_t fact_sync = cudaStreamSynchronize(dev.stream);
            if (fact_status != CUDSS_STATUS_SUCCESS || fact_sync != cudaSuccess) {
                outcome.used_cudss = true;
                outcome.fallback_to_krylov = false;
                outcome.completed_frequency_count = k;
                outcome.error_message =
                    "cudss_factorization_singular_or_failed: numerical factorization failed";
                return finish(FrequencyDomainStatus::solve_error);
            }
            outcome.numeric_factorization_count += 1u;

            int info = 0;
            std::size_t info_written = 0;
            if (cudssDataGet(
                    dev.handle,
                    dev.data,
                    CUDSS_DATA_INFO,
                    &info,
                    sizeof(info),
                    &info_written) != CUDSS_STATUS_SUCCESS ||
                info_written != sizeof(info) ||
                info != 0) {
                outcome.used_cudss = true;
                outcome.fallback_to_krylov = false;
                outcome.completed_frequency_count = k;
                outcome.error_message =
                    "cudss_factorization_singular_or_failed: CUDSS_DATA_INFO=" +
                    std::to_string(info);
                return finish(FrequencyDomainStatus::solve_error);
            }

            if (cudssExecute(
                    dev.handle,
                    CUDSS_PHASE_SOLVE,
                    dev.config,
                    dev.data,
                    dev.matrix,
                    dev.sol_desc,
                    dev.rhs_desc) != CUDSS_STATUS_SUCCESS) {
                outcome.used_cudss = true;
                outcome.fallback_to_krylov = false;
                outcome.completed_frequency_count = k;
                outcome.error_message = "cuDSS driven response solve phase failed";
                return finish(FrequencyDomainStatus::solve_error);
            }

            const cudaError_t cert_rc = detail::launch_driven_response_unscaled_residual_cert(
                dev.d_row_ptr,
                dev.d_col_indices,
                dev.d_csr_values,
                dev.d_row_scale,
                dev.d_col_scale,
                dev.d_b_unscaled,
                dev.d_b_scaled,
                dev.d_y_scaled,
                csr.n_q,
                csr.n_aug,
                dev.d_x_unscaled,
                dev.d_norm_partials,
                dev.d_out_norms,
                dev.stream);
            if (cert_rc != cudaSuccess ||
                cudaMemcpyAsync(
                    dev.h_out_norms,
                    dev.d_out_norms,
                    8u * sizeof(double),
                    cudaMemcpyDeviceToHost,
                    dev.stream) != cudaSuccess ||
                cudaMemcpyAsync(
                    h_x_unscaled.data(),
                    dev.d_x_unscaled,
                    vec_bytes,
                    cudaMemcpyDeviceToHost,
                    dev.stream) != cudaSuccess ||
                cudaStreamSynchronize(dev.stream) != cudaSuccess) {
                outcome.used_cudss = true;
                outcome.fallback_to_krylov = false;
                outcome.completed_frequency_count = k;
                outcome.error_message =
                    "cuDSS driven response GPU residual certification readback failed";
                return finish(FrequencyDomainStatus::solve_error);
            }

            const double norm_r_q = dev.h_out_norms[0];
            const double norm_f = dev.h_out_norms[1];
            const double norm_q = dev.h_out_norms[2];
            const double norm_r_phi = dev.h_out_norms[3];
            const double norm_r_phi_q = dev.h_out_norms[4];
            const double norm_p_delta_phi = dev.h_out_norms[5];
            const double norm_delta_phi = dev.h_out_norms[6];
            const bool any_nonfinite = dev.h_out_norms[7] != 0.0 ||
                !std::isfinite(norm_r_q) ||
                !std::isfinite(norm_f) ||
                !std::isfinite(norm_q) ||
                !std::isfinite(norm_r_phi) ||
                !std::isfinite(norm_r_phi_q) ||
                !std::isfinite(norm_p_delta_phi) ||
                !std::isfinite(norm_delta_phi);

            const double q_tol = norm_f > 0.0
                ? std::max(rtol * norm_f, atol)
                : std::max(atol, 1.0e-14);
            const bool q_ok = !any_nonfinite && (norm_r_q <= q_tol);
            const double rel_r_q = norm_f > 0.0 ? (norm_r_q / norm_f) : norm_r_q;

            bool phi_ok = true;
            double rel_r_phi = 0.0;
            if (csr.n_phi > 0u) {
                const double phi_scale = std::max(norm_r_phi_q, norm_p_delta_phi);
                const double atol_phi = 1.0e-14 * std::max({
                    csr.inf_norm_p * norm_delta_phi,
                    csr.inf_norm_r_phi_q * norm_q,
                    1.0e-300,
                });
                const double phi_tol = std::max(rtol * phi_scale, atol_phi);
                phi_ok = !any_nonfinite && (norm_r_phi <= phi_tol);
                const double rel_phi_denom = std::max({
                    phi_scale,
                    atol_phi / std::max(rtol, 1.0e-300),
                    1.0e-300,
                });
                rel_r_phi = norm_r_phi / rel_phi_denom;
            }

            if (any_nonfinite || !q_ok || !phi_ok) {
                outcome.used_cudss = true;
                outcome.fallback_to_krylov = false;
                outcome.completed_frequency_count = k;
                char msg[384]{};
                std::snprintf(
                    msg,
                    sizeof(msg),
                    "cudss_residual_certification_failed at f=%.6e Hz: nonfinite=%d "
                    "||r_q||=%.3e (||f||=%.3e, rel=%.3e, tol=%.3e) "
                    "||r_phi||=%.3e (rel=%.3e)",
                    freq_hz,
                    any_nonfinite ? 1 : 0,
                    norm_r_q,
                    norm_f,
                    rel_r_q,
                    q_tol,
                    norm_r_phi,
                    rel_r_phi);
                outcome.error_message = msg;
                return finish(FrequencyDomainStatus::solve_error);
            }

            outcome.max_magnetic_relative_residual_l2 =
                std::max(outcome.max_magnetic_relative_residual_l2, rel_r_q);
            outcome.max_poisson_relative_residual_l2 =
                std::max(outcome.max_poisson_relative_residual_l2, rel_r_phi);

            // Lift reduced magnetic response back to full magnetic tangent DOFs.
            double *resp_re = out_response_real + k * n_q_full;
            double *resp_im = out_response_imag + k * n_q_full;
            for (std::uint64_t u = 0; u < n_m; ++u) {
                const std::uint32_t ru = periodic.node_to_reduced[static_cast<std::size_t>(u)];
                const double2 q0 = h_x_unscaled[2u * ru];
                const double2 q1 = h_x_unscaled[2u * ru + 1u];
                resp_re[2u * u] = q0.x;
                resp_im[2u * u] = q0.y;
                resp_re[2u * u + 1u] = q1.x;
                resp_im[2u * u + 1u] = q1.y;
            }
            if (out_residual_l2 != nullptr) {
                out_residual_l2[k] = norm_r_q;
            }
            if (out_relative_residual_l2 != nullptr) {
                out_relative_residual_l2[k] = rel_r_q;
            }

            if (blocks != nullptr) {
                const double2 *delta_phi = h_x_unscaled.data() + csr.n_q;
                if (out_delta_phi_full_real_opt != nullptr &&
                    out_delta_phi_full_imag_opt != nullptr) {
                    double *phi_re = out_delta_phi_full_real_opt + k * out_phi_stride;
                    double *phi_im = out_delta_phi_full_imag_opt + k * out_phi_stride;
                    if (blocks->is_periodic_reduced != 0u) {
                        for (std::uint64_t node = 0; node < blocks->full_node_count; ++node) {
                            const std::uint32_t red = blocks->periodic_reduced_node[node];
                            phi_re[node] = delta_phi[red].x;
                            phi_im[node] = delta_phi[red].y;
                        }
                    } else {
                        for (std::uint64_t p = 0; p < blocks->phi_dof_count; ++p) {
                            phi_re[p] = delta_phi[p].x;
                            phi_im[p] = delta_phi[p].y;
                        }
                    }
                }
                if (out_h_demag_real_opt != nullptr && out_h_demag_imag_opt != nullptr) {
                    compute_tangent_h_demag_from_phi(
                        problem,
                        *blocks,
                        delta_phi,
                        out_h_demag_real_opt + k * n_q_full,
                        out_h_demag_imag_opt + k * n_q_full);
                }
            }

            outcome.completed_frequency_count = k + 1u;
            if (request.progress_callback != nullptr) {
                ProductionCpuDrivenResponseProgress progress{};
                progress.frequency_index = k;
                progress.completed_frequency_count = k + 1u;
                progress.total_frequency_count = freq_count;
                progress.iteration_count = 1u;
                progress.frequency_hz = freq_hz;
                progress.residual_l2_norm = norm_r_q;
                progress.relative_residual_l2_norm = rel_r_q;
                progress.converged = true;
                request.progress_callback(request.progress_user_data, progress);
            }
        }

        outcome.used_cudss = true;
        outcome.fallback_to_krylov = false;
        outcome.fallback_reason.clear();
        return finish(FrequencyDomainStatus::ok);
#endif
    } catch (const std::exception &ex) {
        outcome.fallback_to_krylov = false;
        outcome.error_message = std::string("cuDSS driven response exception: ") + ex.what();
        return finish(FrequencyDomainStatus::solve_error);
    } catch (...) {
        outcome.fallback_to_krylov = false;
        outcome.error_message = "cuDSS driven response threw an unknown exception";
        return finish(FrequencyDomainStatus::solve_error);
    }
}

} // namespace fullmag::fem::frequency_domain
