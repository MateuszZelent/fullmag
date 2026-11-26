/*
 * GPU cuDSS frequency-domain driven response contract test.
 *
 * Covers Review Focus #5 and Plan Task 7:
 * 1. No-demag sweep parity (exchange + Zeeman + uniaxial anisotropy + DMI,
 *    plus zero-base-stiffness diagonal slot reservation) with 1x symbolic
 *    analysis and K numeric factorizations.
 * 2. Coupled airbox demag sweep parity across 1e20 magnetic/Poisson scale
 *    disparity (Ruiz equilibration), explicit defensive zeroing of ess_tdofs
 *    rows in -R_{phi q}, and independent unscaled certification of both blocks.
 * 3. Divergence-free mode (R_{phi q} q == 0, delta_phi ~ 0) passing Poisson
 *    residual certification via the scaled atol_phi floor.
 * 4. VRAM budget guard: BUDGET_BYTES=1 falls back cleanly under Auto
 *    (numeric_factorization_count == 0) and fails hard under Required;
 *    malformed MAX_VRAM_MIB / BUDGET_BYTES fails hard with validation_error
 *    even under Auto.
 * 5. Singular undamped resonance (alpha = 0, omega_k = omega_0) fails hard
 *    with solve_error even under Auto (zero silent fallback).
 * 6. Static periodic k=0 lifting (delta_phi_red -> delta_phi_full) and
 *    tangent h_demag recovery via G_rec, plus nonzero-k Floquet rejection
 *    under Auto (explicit fallback) and Required (hard unavailable).
 */

#include "gpu/frequency_domain/driven_response_cudss.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#if defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED
#include <cuda_runtime.h>
#endif

namespace {

using namespace fullmag::fem::frequency_domain;

constexpr double kGamma0 = 2.212761569e5;

#if defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED
using Complex = std::complex<double>;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
#endif

struct ScopedEnvVar {
    std::string name;
    bool had_previous = false;
    std::string previous;

    ScopedEnvVar(const char *env_name, const char *value) : name(env_name)
    {
        const char *existing = std::getenv(env_name);
        if (existing != nullptr) {
            had_previous = true;
            previous = existing;
        }
        if (value != nullptr) {
            setenv(env_name, value, 1);
        } else {
            unsetenv(env_name);
        }
    }

    ~ScopedEnvVar()
    {
        if (had_previous) {
            setenv(name.c_str(), previous.c_str(), 1);
        } else {
            unsetenv(name.c_str());
        }
    }
};

#define CHECK(cond, msg)                                                                  \
    do {                                                                                  \
        if (!(cond)) {                                                                    \
            std::cerr << "FAILED [" << __func__ << ":" << __LINE__ << "]: " << (msg)      \
                      << "\n";                                                            \
            return false;                                                                 \
        }                                                                                 \
    } while (false)

TangentFrameNode make_frame(double mx, double my, double mz)
{
    const double norm = std::sqrt(mx * mx + my * my + mz * mz);
    TangentFrameNode node{};
    node.m[0] = mx / norm;
    node.m[1] = my / norm;
    node.m[2] = mz / norm;
    double ref[3] = {0.0, 0.0, 1.0};
    if (std::abs(node.m[2]) > 0.9) {
        ref[0] = 1.0;
        ref[1] = 0.0;
        ref[2] = 0.0;
    }
    // e1 = normalize(ref - (ref.m) m)
    const double d = ref[0] * node.m[0] + ref[1] * node.m[1] + ref[2] * node.m[2];
    double e1[3] = {ref[0] - d * node.m[0], ref[1] - d * node.m[1], ref[2] - d * node.m[2]};
    const double n1 = std::sqrt(e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2]);
    for (int c = 0; c < 3; ++c) {
        node.e1[c] = e1[c] / n1;
    }
    // e2 = m x e1
    node.e2[0] = node.m[1] * node.e1[2] - node.m[2] * node.e1[1];
    node.e2[1] = node.m[2] * node.e1[0] - node.m[0] * node.e1[2];
    node.e2[2] = node.m[0] * node.e1[1] - node.m[1] * node.e1[0];
    return node;
}

#if defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED
double dot3(const double a[3], const double b[3])
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

struct OwnedCsr {
    std::uint64_t num_rows = 0;
    std::uint64_t num_cols = 0;
    std::vector<std::uint32_t> row_ptr;
    std::vector<std::uint32_t> col_indices;
    std::vector<double> values;

    DrivenFrequencyResponseSparseCsrView view() const
    {
        return DrivenFrequencyResponseSparseCsrView{
            num_rows,
            num_cols,
            static_cast<std::uint64_t>(values.size()),
            row_ptr.empty() ? nullptr : row_ptr.data(),
            col_indices.empty() ? nullptr : col_indices.data(),
            values.empty() ? nullptr : values.data(),
        };
    }
};

OwnedCsr dense_to_csr(const std::vector<double> &dense, std::uint64_t rows, std::uint64_t cols)
{
    OwnedCsr csr{};
    csr.num_rows = rows;
    csr.num_cols = cols;
    csr.row_ptr.assign(static_cast<std::size_t>(rows) + 1u, 0u);
    for (std::uint64_t r = 0; r < rows; ++r) {
        for (std::uint64_t c = 0; c < cols; ++c) {
            const double v = dense[static_cast<std::size_t>(r * cols + c)];
            if (v != 0.0) {
                csr.col_indices.push_back(static_cast<std::uint32_t>(c));
                csr.values.push_back(v);
            }
        }
        csr.row_ptr[static_cast<std::size_t>(r) + 1u] =
            static_cast<std::uint32_t>(csr.values.size());
    }
    return csr;
}

bool solve_dense_complex_linear_system(
    std::size_t n,
    std::vector<Complex> a,
    std::vector<Complex> b,
    std::vector<Complex> &x)
{
    for (std::size_t col = 0; col < n; ++col) {
        std::size_t pivot = col;
        double best = std::abs(a[col * n + col]);
        for (std::size_t r = col + 1; r < n; ++r) {
            const double cand = std::abs(a[r * n + col]);
            if (cand > best) {
                best = cand;
                pivot = r;
            }
        }
        if (!(best > 0.0) || !std::isfinite(best)) {
            return false;
        }
        if (pivot != col) {
            for (std::size_t j = col; j < n; ++j) {
                std::swap(a[col * n + j], a[pivot * n + j]);
            }
            std::swap(b[col], b[pivot]);
        }
        const Complex diag = a[col * n + col];
        for (std::size_t r = col + 1; r < n; ++r) {
            const Complex factor = a[r * n + col] / diag;
            a[r * n + col] = Complex(0.0, 0.0);
            for (std::size_t j = col + 1; j < n; ++j) {
                a[r * n + j] -= factor * a[col * n + j];
            }
            b[r] -= factor * b[col];
        }
    }
    x.assign(n, Complex(0.0, 0.0));
    for (std::size_t rev = 0; rev < n; ++rev) {
        const std::size_t r = n - 1u - rev;
        Complex sum = b[r];
        for (std::size_t j = r + 1; j < n; ++j) {
            sum -= a[r * n + j] * x[j];
        }
        x[r] = sum / a[r * n + r];
    }
    return true;
}

// Reference dense assembly of (K_loc, M) matching driven_response_gpu.cu exactly.
void build_dense_magnetic_km(
    const DrivenFrequencyResponseSolveRequest &request,
    std::vector<double> &k_mat,
    std::vector<double> &m_mat)
{
    const auto &problem = request.mfem_validation_problem;
    const std::size_t n_m = static_cast<std::size_t>(problem.descriptor.node_count);
    const std::size_t n_q = 2u * n_m;
    const double gamma0 = request.solve_request.operator_request.gamma0;
    const double alpha = request.solve_request.operator_request.alpha;

    std::vector<double> h_mat(n_q * n_q, 0.0);
    m_mat.assign(n_q * n_q, 0.0);

    for (std::size_t u = 0; u < n_m; ++u) {
        const double a_u = problem.alpha_per_node != nullptr ? problem.alpha_per_node[u] : alpha;
        m_mat[(2 * u) * n_q + (2 * u)] = 1.0;
        m_mat[(2 * u) * n_q + (2 * u + 1)] = a_u;
        m_mat[(2 * u + 1) * n_q + (2 * u)] = -a_u;
        m_mat[(2 * u + 1) * n_q + (2 * u + 1)] = 1.0;
    }

    if (problem.descriptor.exchange_enabled) {
        for (std::uint64_t e = 0; e < problem.exchange_edge_count; ++e) {
            const auto &edge = problem.exchange_edges[e];
            const std::size_t i = static_cast<std::size_t>(edge.node_i);
            const std::size_t j = static_cast<std::size_t>(edge.node_j);
            const double s = edge.stiffness;
            const auto &ni = problem.nodes[i];
            const auto &nj = problem.nodes[j];
            const double r00 = dot3(ni.e1, nj.e1);
            const double r01 = dot3(ni.e1, nj.e2);
            const double r10 = dot3(ni.e2, nj.e1);
            const double r11 = dot3(ni.e2, nj.e2);
            h_mat[(2 * i) * n_q + (2 * i)] += s;
            h_mat[(2 * i + 1) * n_q + (2 * i + 1)] += s;
            h_mat[(2 * i) * n_q + (2 * j)] -= s * r00;
            h_mat[(2 * i) * n_q + (2 * j + 1)] -= s * r01;
            h_mat[(2 * i + 1) * n_q + (2 * j)] -= s * r10;
            h_mat[(2 * i + 1) * n_q + (2 * j + 1)] -= s * r11;
            h_mat[(2 * j) * n_q + (2 * j)] += s;
            h_mat[(2 * j + 1) * n_q + (2 * j + 1)] += s;
            h_mat[(2 * j) * n_q + (2 * i)] -= s * r00;
            h_mat[(2 * j) * n_q + (2 * i + 1)] -= s * r10;
            h_mat[(2 * j + 1) * n_q + (2 * i)] -= s * r01;
            h_mat[(2 * j + 1) * n_q + (2 * i + 1)] -= s * r11;
        }
    }

    if (problem.descriptor.zeeman_enabled) {
        for (std::size_t u = 0; u < n_m; ++u) {
            const double hp = dot3(problem.h_ext_a_per_m, problem.nodes[u].m);
            h_mat[(2 * u) * n_q + (2 * u)] -= hp;
            h_mat[(2 * u + 1) * n_q + (2 * u + 1)] -= hp;
        }
    }

    if (problem.descriptor.uniaxial_anisotropy_enabled) {
        const double hk = problem.uniaxial_anisotropy_field_a_per_m;
        for (std::size_t u = 0; u < n_m; ++u) {
            const double u0 = dot3(problem.uniaxial_anisotropy_axis, problem.nodes[u].e1);
            const double u1 = dot3(problem.uniaxial_anisotropy_axis, problem.nodes[u].e2);
            h_mat[(2 * u) * n_q + (2 * u)] += hk * u0 * u0;
            h_mat[(2 * u) * n_q + (2 * u + 1)] += hk * u0 * u1;
            h_mat[(2 * u + 1) * n_q + (2 * u)] += hk * u1 * u0;
            h_mat[(2 * u + 1) * n_q + (2 * u + 1)] += hk * u1 * u1;
        }
    }

    if (problem.descriptor.dmi_enabled) {
        // Compute columns of DMI effective field operator by direct element evaluation.
        for (std::size_t col = 0; col < n_q; ++col) {
            std::vector<double> delta_xyz(3u * n_m, 0.0);
            const std::size_t nb = col / 2u;
            const double *v = (col % 2u == 0u) ? problem.nodes[nb].e1 : problem.nodes[nb].e2;
            for (int c = 0; c < 3; ++c) {
                delta_xyz[3u * nb + static_cast<std::size_t>(c)] = v[c];
            }
            std::vector<double> residual_xyz(3u * n_m, 0.0);
            for (std::uint64_t e = 0; e < problem.dmi_element_count; ++e) {
                const auto &elem = problem.dmi_elements[e];
                double dq[3]{};
                double gd[3][3]{};
                for (int ln = 0; ln < 4; ++ln) {
                    const std::size_t idx = elem.node_indices[ln];
                    for (int c = 0; c < 3; ++c) {
                        dq[c] += elem.shape[ln] * delta_xyz[3u * idx + static_cast<std::size_t>(c)];
                        for (int d = 0; d < 3; ++d) {
                            gd[c][d] += delta_xyz[3u * idx + static_cast<std::size_t>(c)] *
                                elem.grad_shape[ln][d];
                        }
                    }
                }
                const double div_d = gd[0][0] + gd[1][1] + gd[2][2];
                const double curl_d[3] = {
                    gd[2][1] - gd[1][2],
                    gd[0][2] - gd[2][0],
                    gd[1][0] - gd[0][1],
                };
                const double gdn[3] = {
                    elem.normal[0] * gd[0][0] + elem.normal[1] * gd[1][0] + elem.normal[2] * gd[2][0],
                    elem.normal[0] * gd[0][1] + elem.normal[1] * gd[1][1] + elem.normal[2] * gd[2][1],
                    elem.normal[0] * gd[0][2] + elem.normal[1] * gd[1][2] + elem.normal[2] * gd[2][2],
                };
                const double dn = dot3(dq, elem.normal);
                for (int ln = 0; ln < 4; ++ln) {
                    const std::size_t idx = elem.node_indices[ln];
                    double r[3]{};
                    if (elem.kind == MfemDmiInteractionKind::bulk) {
                        r[0] = elem.d * elem.weight *
                            (elem.shape[ln] * curl_d[0] + dq[1] * elem.grad_shape[ln][2] -
                             dq[2] * elem.grad_shape[ln][1]);
                        r[1] = elem.d * elem.weight *
                            (elem.shape[ln] * curl_d[1] - dq[0] * elem.grad_shape[ln][2] +
                             dq[2] * elem.grad_shape[ln][0]);
                        r[2] = elem.d * elem.weight *
                            (elem.shape[ln] * curl_d[2] + dq[0] * elem.grad_shape[ln][1] -
                             dq[1] * elem.grad_shape[ln][0]);
                    } else {
                        for (int c = 0; c < 3; ++c) {
                            const double dw_dm = elem.d * (elem.normal[c] * div_d - gdn[c]);
                            double ga = 0.0;
                            for (int d = 0; d < 3; ++d) {
                                const double kron = (c == d) ? 1.0 : 0.0;
                                ga += elem.d * (dn * kron - elem.normal[c] * dq[d]) *
                                    elem.grad_shape[ln][d];
                            }
                            r[c] = elem.weight * (elem.shape[ln] * dw_dm + ga);
                        }
                    }
                    for (int c = 0; c < 3; ++c) {
                        residual_xyz[3u * idx + static_cast<std::size_t>(c)] += r[c];
                    }
                }
            }
            for (std::size_t u = 0; u < n_m; ++u) {
                const double mass = problem.dmi_lumped_mass[u];
                const double ms = problem.dmi_ms_field != nullptr
                    ? problem.dmi_ms_field[u]
                    : problem.dmi_uniform_ms;
                const double inv_p = -1.0 / (kMu0 * ms * mass + 1.0e-300);
                const double field[3] = {
                    residual_xyz[3u * u] * inv_p,
                    residual_xyz[3u * u + 1u] * inv_p,
                    residual_xyz[3u * u + 2u] * inv_p,
                };
                h_mat[(2 * u) * n_q + col] += dot3(field, problem.nodes[u].e1);
                h_mat[(2 * u + 1) * n_q + col] += dot3(field, problem.nodes[u].e2);
            }
        }
    }

    k_mat.assign(n_q * n_q, 0.0);
    for (std::size_t u = 0; u < n_m; ++u) {
        for (std::size_t col = 0; col < n_q; ++col) {
            k_mat[(2 * u) * n_q + col] = gamma0 * h_mat[(2 * u + 1) * n_q + col];
            k_mat[(2 * u + 1) * n_q + col] = -gamma0 * h_mat[(2 * u) * n_q + col];
        }
    }
}

double relative_l2_error(
    const double *actual_re,
    const double *actual_im,
    const std::vector<Complex> &expected)
{
    double diff_sq = 0.0;
    double ref_sq = 0.0;
    for (std::size_t i = 0; i < expected.size(); ++i) {
        const Complex got(actual_re[i], actual_im[i]);
        diff_sq += std::norm(got - expected[i]);
        ref_sq += std::norm(expected[i]);
    }
    return std::sqrt(diff_sq) / std::max(1.0e-300, std::sqrt(ref_sq));
}
#endif // FULLMAG_FEM_CUDSS_DRIVEN_ENABLED

DrivenFrequencyResponseSolveRequest make_base_request(
    const std::vector<TangentFrameNode> &nodes,
    const std::vector<double> &freqs_hz,
    double alpha)
{
    DrivenFrequencyResponseSolveRequest req{};
    req.abi_version = kDrivenFrequencyResponseSolveRequestAbiVersion;
    req.struct_size = sizeof(DrivenFrequencyResponseSolveRequest);
    req.execution_lane = DrivenFrequencyResponseExecutionLane::production_gpu;
    req.phase_convention = FrequencyDomainPhaseConvention::exp_i_omega_t;
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;

    req.solve_request.frequencies_hz = freqs_hz.data();
    req.solve_request.frequency_count = static_cast<std::uint64_t>(freqs_hz.size());
    req.solve_request.operator_request.node_count = static_cast<std::uint64_t>(nodes.size());
    req.solve_request.operator_request.tangent_dof_count =
        static_cast<std::uint64_t>(nodes.size() * 2u);
    req.solve_request.operator_request.alpha = alpha;
    req.solve_request.operator_request.gamma0 = kGamma0;
    req.solve_request.operator_request.demag_kind = FrequencyDomainDemagKind::none;

    req.mfem_validation_problem.enabled = true;
    req.mfem_validation_problem.descriptor.node_count = static_cast<std::uint64_t>(nodes.size());
    req.mfem_validation_problem.descriptor.full_dof_count =
        static_cast<std::uint64_t>(nodes.size() * 3u);
    req.mfem_validation_problem.descriptor.tangent_dof_count =
        static_cast<std::uint64_t>(nodes.size() * 2u);
    req.mfem_validation_problem.layout.node_count = static_cast<std::uint64_t>(nodes.size());
    req.mfem_validation_problem.layout.full_dof_count =
        static_cast<std::uint64_t>(nodes.size() * 3u);
    req.mfem_validation_problem.layout.tangent_dof_count =
        static_cast<std::uint64_t>(nodes.size() * 2u);
    req.mfem_validation_problem.nodes = nodes.data();
    req.mfem_validation_problem.node_count = static_cast<std::uint64_t>(nodes.size());
    return req;
}

bool test_portable_policy_env_and_scope_contracts()
{
    const std::vector<TangentFrameNode> nodes = {
        make_frame(0.0, 0.0, 1.0),
        make_frame(0.0, 0.0, 1.0),
    };
    const std::vector<double> freqs = {2.0e9};
    const std::vector<double> drive_re = {1.0, 0.0, 1.0, 0.0};
    std::vector<double> out_re(4, 0.0);
    std::vector<double> out_im(4, 0.0);

    // 1. Disabled policy returns fallback_to_krylov = true cleanly.
    {
        auto req = make_base_request(nodes, freqs, 0.02);
        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Disabled;
        DrivenResponseCudssOutcome outcome{};
        const auto status = solve_driven_response_gpu_cudss(
            req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
            nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &outcome);
        CHECK(status == FrequencyDomainStatus::ok, "Disabled policy must return ok");
        CHECK(!outcome.used_cudss && outcome.fallback_to_krylov,
              "Disabled policy must fall back to Krylov");
        CHECK(outcome.fallback_reason == "policy_disabled",
              "Disabled policy fallback reason mismatch");
    }

    // 2. Malformed VRAM env vars fail hard with validation_error even under Auto.
    for (const char *bad : {"0", "-5", "abc"}) {
        ScopedEnvVar guard(kDrivenCudssMaxVramMibEnv, bad);
        auto req = make_base_request(nodes, freqs, 0.02);
        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
        DrivenResponseCudssOutcome outcome{};
        const auto status = solve_driven_response_gpu_cudss(
            req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
            nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &outcome);
        CHECK(status == FrequencyDomainStatus::validation_error,
              "Malformed MAX_VRAM_MIB must fail hard with validation_error under Auto");
        CHECK(!outcome.fallback_to_krylov, "Malformed MAX_VRAM_MIB must never fall back");
    }
    for (const char *bad : {"0", "-1", "xyz"}) {
        ScopedEnvVar guard(kDrivenCudssBudgetBytesEnv, bad);
        auto req = make_base_request(nodes, freqs, 0.02);
        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
        DrivenResponseCudssOutcome outcome{};
        const auto status = solve_driven_response_gpu_cudss(
            req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
            nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &outcome);
        CHECK(status == FrequencyDomainStatus::validation_error,
              "Malformed BUDGET_BYTES must fail hard with validation_error under Auto");
        CHECK(!outcome.fallback_to_krylov, "Malformed BUDGET_BYTES must never fall back");
    }

    // 3. Nonzero-k Floquet airbox with demag: Auto falls back explicitly; Required fails hard.
    {
        auto req = make_base_request(nodes, freqs, 0.02);
        req.requires_floquet_airbox_dynamic_demag = true;
        req.has_floquet_k_vector = true;
        req.floquet_k_vector_rad_per_m[0] = 1.0e7;
        req.mfem_validation_problem.descriptor.demag_enabled = true;

        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
        DrivenResponseCudssOutcome auto_out{};
        const auto auto_status = solve_driven_response_gpu_cudss(
            req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
            nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &auto_out);
        CHECK(auto_status == FrequencyDomainStatus::ok, "Auto Floquet must return ok fallback");
        CHECK(!auto_out.used_cudss && auto_out.fallback_to_krylov,
              "Auto Floquet must fall back to Krylov");
        CHECK(auto_out.fallback_reason == "floquet_nonzero_k_demag_unsupported",
              "Auto Floquet fallback reason mismatch");

        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
        DrivenResponseCudssOutcome req_out{};
        const auto req_status = solve_driven_response_gpu_cudss(
            req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
            nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &req_out);
        CHECK(req_status == FrequencyDomainStatus::unavailable,
              "Required Floquet must fail hard with unavailable");
        CHECK(!req_out.used_cudss && !req_out.fallback_to_krylov,
              "Required Floquet must never fall back");
    }

    // 4. Demag enabled without sparse blocks: Auto falls back; Required fails hard.
    {
        auto req = make_base_request(nodes, freqs, 0.02);
        req.mfem_validation_problem.descriptor.demag_enabled = true;
        req.demag_sparse_blocks = nullptr;

        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
        DrivenResponseCudssOutcome auto_out{};
        CHECK(solve_driven_response_gpu_cudss(
                  req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
                  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &auto_out) ==
                  FrequencyDomainStatus::ok,
              "Auto missing sparse blocks must return ok fallback");
        CHECK(auto_out.fallback_to_krylov &&
                  auto_out.fallback_reason == "demag_sparse_blocks_unavailable",
              "Auto missing sparse blocks fallback reason mismatch");

        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
        DrivenResponseCudssOutcome req_out{};
        CHECK(solve_driven_response_gpu_cudss(
                  req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
                  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &req_out) ==
                  FrequencyDomainStatus::unavailable,
              "Required missing sparse blocks must fail hard with unavailable");
        CHECK(!req_out.fallback_to_krylov, "Required missing sparse blocks must never fall back");
    }

    // 4b. Periodic-airbox delta_phi output stride mismatch must fail closed with validation_error.
    {
        auto req = make_base_request(nodes, freqs, 0.02);
        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
        req.mfem_validation_problem.descriptor.demag_enabled = true;
        req.requires_periodic_airbox_dynamic_demag = true;
        req.periodic_airbox_delta_phi_dof_count = 4u;

        DrivenFrequencyResponseDemagSparseBlocks mismatch_blocks{};
        mismatch_blocks.is_periodic_reduced = 1u;
        mismatch_blocks.full_node_count = 6u;
        mismatch_blocks.phi_dof_count = 3u;
        req.demag_sparse_blocks = &mismatch_blocks;

        std::vector<double> phi_re(4u, 0.0);
        std::vector<double> phi_im(4u, 0.0);
        DrivenResponseCudssOutcome stride_out{};
        const auto stride_status = solve_driven_response_gpu_cudss(
            req,
            drive_re.data(),
            nullptr,
            out_re.data(),
            out_im.data(),
            nullptr,
            nullptr,
            phi_re.data(),
            phi_im.data(),
            nullptr,
            nullptr,
            &stride_out);
        CHECK(stride_status == FrequencyDomainStatus::validation_error,
              "delta_phi stride mismatch must fail closed with validation_error");
        CHECK(!stride_out.used_cudss && !stride_out.fallback_to_krylov,
              "delta_phi stride mismatch must never fall back");
    }

#if !(defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED)
    // 5. Non-cuDSS builds report cudss_unavailable cleanly (Auto fallback / Required hard error).
    {
        auto req = make_base_request(nodes, freqs, 0.02);
        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
        DrivenResponseCudssOutcome auto_out{};
        CHECK(solve_driven_response_gpu_cudss(
                  req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
                  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &auto_out) ==
                  FrequencyDomainStatus::ok,
              "Non-cuDSS Auto must fall back");
        CHECK(auto_out.fallback_to_krylov && auto_out.fallback_reason == "cudss_unavailable",
              "Non-cuDSS Auto fallback reason mismatch");

        req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
        DrivenResponseCudssOutcome req_out{};
        CHECK(solve_driven_response_gpu_cudss(
                  req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
                  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &req_out) ==
                  FrequencyDomainStatus::unavailable,
              "Non-cuDSS Required must fail hard with unavailable");
        CHECK(!req_out.fallback_to_krylov, "Non-cuDSS Required must never fall back");
    }
#endif
    return true;
}

#if defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED

bool has_cuda_device()
{
    int count = 0;
    return cudaGetDeviceCount(&count) == cudaSuccess && count > 0;
}

bool test_no_demag_sweep_parity_and_single_analysis()
{
    const std::vector<TangentFrameNode> nodes = {
        make_frame(0.1, 0.2, 0.97467943448),
        make_frame(-0.15, 0.1, 0.98361577865),
        make_frame(0.05, -0.12, 0.99151399385),
        make_frame(0.0, 0.0, 1.0),
    };
    const std::vector<TangentOperatorEdgeBlock> edges = {
        {FrequencyDomainOperatorTermKind::exchange, 0, 1, 2.5e4},
        {FrequencyDomainOperatorTermKind::exchange, 1, 2, 3.1e4},
        {FrequencyDomainOperatorTermKind::exchange, 2, 3, 1.9e4},
        {FrequencyDomainOperatorTermKind::exchange, 0, 3, 2.2e4},
    };
    const double h_ext[3] = {1.5e4, -0.5e4, 8.0e4};
    const double aniso_axis[3] = {0.0, 0.0, 1.0};
    const double hk = 3.5e4;
    const std::vector<double> alpha_per_node = {0.02, 0.025, 0.018, 0.02};

    MfemDmiElementTangentData dmi_interfacial{};
    dmi_interfacial.kind = MfemDmiInteractionKind::interfacial;
    dmi_interfacial.node_indices[0] = 0;
    dmi_interfacial.node_indices[1] = 1;
    dmi_interfacial.node_indices[2] = 2;
    dmi_interfacial.node_indices[3] = 3;
    dmi_interfacial.shape[0] = 0.25;
    dmi_interfacial.shape[1] = 0.25;
    dmi_interfacial.shape[2] = 0.25;
    dmi_interfacial.shape[3] = 0.25;
    const double gs[4][3] = {
        {-1.0e8, -1.0e8, -1.0e8},
        {1.0e8, 0.0, 0.0},
        {0.0, 1.0e8, 0.0},
        {0.0, 0.0, 1.0e8},
    };
    std::memcpy(dmi_interfacial.grad_shape, gs, sizeof(gs));
    dmi_interfacial.weight = 1.0e-25;
    dmi_interfacial.d = 1.5e-3;
    dmi_interfacial.normal[0] = 0.0;
    dmi_interfacial.normal[1] = 0.0;
    dmi_interfacial.normal[2] = 1.0;

    MfemDmiElementTangentData dmi_bulk = dmi_interfacial;
    dmi_bulk.kind = MfemDmiInteractionKind::bulk;
    dmi_bulk.d = 0.8e-3;
    const std::vector<MfemDmiElementTangentData> dmi_elems = {dmi_interfacial, dmi_bulk};
    const std::vector<double> lumped_mass = {2.5e-26, 2.5e-26, 2.5e-26, 2.5e-26};
    const double uniform_ms = 8.0e5;

    std::vector<double> freqs(10);
    for (std::size_t k = 0; k < freqs.size(); ++k) {
        freqs[k] = (1.0 + static_cast<double>(k)) * 1.0e9;
    }

    auto req = make_base_request(nodes, freqs, 0.02);
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
    req.solver_options.relative_tolerance = 1.0e-10;
    req.mfem_validation_problem.descriptor.exchange_enabled = true;
    req.mfem_validation_problem.exchange_edges = edges.data();
    req.mfem_validation_problem.exchange_edge_count = static_cast<std::uint64_t>(edges.size());
    req.mfem_validation_problem.descriptor.zeeman_enabled = true;
    req.mfem_validation_problem.h_ext_a_per_m = h_ext;
    req.mfem_validation_problem.h_ext_value_count = 3;
    req.mfem_validation_problem.descriptor.uniaxial_anisotropy_enabled = true;
    req.mfem_validation_problem.uniaxial_anisotropy_axis = aniso_axis;
    req.mfem_validation_problem.uniaxial_anisotropy_axis_value_count = 3;
    req.mfem_validation_problem.uniaxial_anisotropy_field_a_per_m = hk;
    req.mfem_validation_problem.alpha_per_node = alpha_per_node.data();
    req.mfem_validation_problem.alpha_value_count = static_cast<std::uint64_t>(alpha_per_node.size());
    req.mfem_validation_problem.descriptor.dmi_enabled = true;
    req.mfem_validation_problem.dmi_elements = dmi_elems.data();
    req.mfem_validation_problem.dmi_element_count = static_cast<std::uint64_t>(dmi_elems.size());
    req.mfem_validation_problem.dmi_lumped_mass = lumped_mass.data();
    req.mfem_validation_problem.dmi_lumped_mass_value_count =
        static_cast<std::uint64_t>(lumped_mass.size());
    req.mfem_validation_problem.dmi_uniform_ms = uniform_ms;

    const std::vector<double> drive_re = {1.0, -0.3, 0.7, 0.4, -0.5, 0.9, 0.2, -0.6};
    const std::vector<double> drive_im = {0.2, 0.5, -0.1, 0.3, 0.4, -0.2, 0.6, 0.1};
    const std::size_t n_q = nodes.size() * 2u;

    std::vector<double> resp_re(freqs.size() * n_q, 0.0);
    std::vector<double> resp_im(freqs.size() * n_q, 0.0);
    std::vector<double> res_l2(freqs.size(), 0.0);
    std::vector<double> rel_res_l2(freqs.size(), 0.0);

    for (const char *pageable : {static_cast<const char *>(nullptr), "1"}) {
        ScopedEnvVar pageable_guard("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK", pageable);
        DrivenResponseCudssOutcome outcome{};
        const auto status = solve_driven_response_gpu_cudss(
            req,
            drive_re.data(),
            drive_im.data(),
            resp_re.data(),
            resp_im.data(),
            res_l2.data(),
            rel_res_l2.data(),
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            &outcome);
        CHECK(status == FrequencyDomainStatus::ok, "no-demag cuDSS sweep failed");
        CHECK(outcome.used_cudss && !outcome.fallback_to_krylov,
              "no-demag sweep must use cuDSS");
        CHECK(outcome.symbolic_analysis_count == 1u,
              "symbolic analysis must run exactly once for the whole sweep");
        CHECK(outcome.numeric_factorization_count == freqs.size(),
              "numeric factorization count must equal frequency count");
        CHECK(outcome.completed_frequency_count == freqs.size(),
              "completed frequency count mismatch");
        CHECK(outcome.max_magnetic_relative_residual_l2 <= 1.0e-10,
              "magnetic relative residual exceeded 1e-10");

        std::vector<double> k_mat;
        std::vector<double> m_mat;
        build_dense_magnetic_km(req, k_mat, m_mat);
        std::vector<Complex> rhs(n_q);
        for (std::size_t i = 0; i < n_q; ++i) {
            rhs[i] = Complex(drive_re[i], drive_im[i]);
        }
        for (std::size_t k = 0; k < freqs.size(); ++k) {
            const double omega = kTwoPi * freqs[k];
            std::vector<Complex> z(n_q * n_q);
            for (std::size_t idx = 0; idx < n_q * n_q; ++idx) {
                z[idx] = Complex(k_mat[idx], -omega * m_mat[idx]);
            }
            std::vector<Complex> q_ref;
            CHECK(solve_dense_complex_linear_system(n_q, z, rhs, q_ref),
                  "dense reference solve failed");
            const double err = relative_l2_error(
                resp_re.data() + k * n_q,
                resp_im.data() + k * n_q,
                q_ref);
            CHECK(err < 1.0e-10, "no-demag cuDSS sweep parity exceeded 1e-10");
        }
    }

    // Subcase: K_loc == 0 (all local stiffness terms off) verifies explicit 4*N_m slot reservation.
    {
        auto zero_k_req = make_base_request(nodes, freqs, 0.05);
        zero_k_req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
        DrivenResponseCudssOutcome outcome{};
        CHECK(solve_driven_response_gpu_cudss(
                  zero_k_req,
                  drive_re.data(),
                  drive_im.data(),
                  resp_re.data(),
                  resp_im.data(),
                  res_l2.data(),
                  rel_res_l2.data(),
                  nullptr,
                  nullptr,
                  nullptr,
                  nullptr,
                  &outcome) == FrequencyDomainStatus::ok,
              "zero-K_loc cuDSS sweep failed");
        CHECK(outcome.symbolic_analysis_count == 1u &&
                  outcome.numeric_factorization_count == freqs.size(),
              "zero-K_loc analysis/factorization counts mismatch");
        CHECK(outcome.max_magnetic_relative_residual_l2 <= 1.0e-10,
              "zero-K_loc residual exceeded 1e-10");
    }
    return true;
}

bool test_coupled_airbox_demag_sweep_parity_and_ess_tdofs()
{
    // 3 magnetic nodes (N_q = 6) inside 5-node mesh (N_phi = 5), node 4 is Dirichlet ess_tdof.
    // Magnetic scale ~1e11 s^-1 vs Poisson scale ~1e-8 m => 1e19..1e20 scale disparity (Ruiz).
    const std::vector<TangentFrameNode> nodes = {
        make_frame(0.0, 0.0, 1.0),
        make_frame(0.1, 0.0, std::sqrt(0.99)),
        make_frame(0.0, -0.1, std::sqrt(0.99)),
    };
    const std::vector<TangentOperatorEdgeBlock> edges = {
        {FrequencyDomainOperatorTermKind::exchange, 0, 1, 5.0e5},
        {FrequencyDomainOperatorTermKind::exchange, 1, 2, 4.0e5},
    };
    const double h_ext[3] = {0.0, 0.0, 4.5e5};
    const std::vector<double> freqs = {2.0e9, 5.0e9, 10.0e9, 16.0e9, 22.0e9};

    const std::uint64_t full_nodes = 5;
    const std::uint64_t n_phi = 5;
    const std::vector<std::uint32_t> mag_indices = {0, 1, 2};
    const std::vector<std::uint32_t> ess_tdofs = {4};

    // SPD Poisson matrix at ~1e-8 scale with eliminated Dirichlet row/col 4 = 1.0.
    std::vector<double> p_dense(n_phi * n_phi, 0.0);
    const double ps = 1.0e-8;
    p_dense[0 * n_phi + 0] = 4.0 * ps;
    p_dense[0 * n_phi + 1] = -1.0 * ps;
    p_dense[1 * n_phi + 0] = -1.0 * ps;
    p_dense[1 * n_phi + 1] = 4.0 * ps;
    p_dense[1 * n_phi + 2] = -1.0 * ps;
    p_dense[2 * n_phi + 1] = -1.0 * ps;
    p_dense[2 * n_phi + 2] = 4.0 * ps;
    p_dense[2 * n_phi + 3] = -1.0 * ps;
    p_dense[3 * n_phi + 2] = -1.0 * ps;
    p_dense[3 * n_phi + 3] = 3.0 * ps;
    p_dense[4 * n_phi + 4] = 1.0;

    // Deliberately put a nonzero entry on ess_tdof row 4 in rhs_x to verify defensive zeroing!
    std::vector<double> rhs_x_d(n_phi * full_nodes, 0.0);
    std::vector<double> rhs_y_d(n_phi * full_nodes, 0.0);
    std::vector<double> rhs_z_d(n_phi * full_nodes, 0.0);
    rhs_x_d[0 * full_nodes + 0] = 2.0e-9;
    rhs_x_d[1 * full_nodes + 1] = -1.5e-9;
    rhs_x_d[2 * full_nodes + 2] = 1.2e-9;
    rhs_x_d[3 * full_nodes + 2] = -0.8e-9;
    rhs_x_d[4 * full_nodes + 0] = 9.9e-9; // MUST be zeroed because row 4 is in ess_tdofs!
    rhs_y_d[0 * full_nodes + 1] = 1.1e-9;
    rhs_y_d[1 * full_nodes + 0] = -1.1e-9;
    rhs_y_d[2 * full_nodes + 1] = 0.7e-9;
    rhs_z_d[1 * full_nodes + 2] = 0.9e-9;

    // Recovery G_rec at ~1e14 scale so G_rec P^-1 R_{phi q} ~ 1e5 A/m (physical demag scale).
    std::vector<double> rec_x_d(full_nodes * n_phi, 0.0);
    std::vector<double> rec_y_d(full_nodes * n_phi, 0.0);
    std::vector<double> rec_z_d(full_nodes * n_phi, 0.0);
    rec_x_d[0 * n_phi + 0] = -1.5e6;
    rec_x_d[0 * n_phi + 1] = 0.8e6;
    rec_x_d[1 * n_phi + 1] = -1.2e6;
    rec_x_d[2 * n_phi + 2] = -1.1e6;
    rec_y_d[0 * n_phi + 1] = -0.9e6;
    rec_y_d[1 * n_phi + 2] = 0.7e6;
    rec_y_d[2 * n_phi + 3] = -0.6e6;
    rec_z_d[2 * n_phi + 1] = -0.5e6;

    const OwnedCsr p_csr = dense_to_csr(p_dense, n_phi, n_phi);
    const OwnedCsr rx_csr = dense_to_csr(rhs_x_d, n_phi, full_nodes);
    const OwnedCsr ry_csr = dense_to_csr(rhs_y_d, n_phi, full_nodes);
    const OwnedCsr rz_csr = dense_to_csr(rhs_z_d, n_phi, full_nodes);
    const OwnedCsr gx_csr = dense_to_csr(rec_x_d, full_nodes, n_phi);
    const OwnedCsr gy_csr = dense_to_csr(rec_y_d, full_nodes, n_phi);
    const OwnedCsr gz_csr = dense_to_csr(rec_z_d, full_nodes, n_phi);

    DrivenFrequencyResponseDemagSparseBlocks blocks{};
    blocks.is_periodic_reduced = 0u;
    blocks.full_node_count = full_nodes;
    blocks.phi_dof_count = n_phi;
    blocks.magnetic_node_count = nodes.size();
    blocks.ess_tdof_count = ess_tdofs.size();
    blocks.poisson_matrix = p_csr.view();
    blocks.rhs_x = rx_csr.view();
    blocks.rhs_y = ry_csr.view();
    blocks.rhs_z = rz_csr.view();
    blocks.recovery_x = gx_csr.view();
    blocks.recovery_y = gy_csr.view();
    blocks.recovery_z = gz_csr.view();
    blocks.magnetic_node_indices = mag_indices.data();
    blocks.ess_tdofs = ess_tdofs.data();

    auto req = make_base_request(nodes, freqs, 0.01);
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
    req.solver_options.relative_tolerance = 1.0e-10;
    req.solve_request.operator_request.demag_kind = FrequencyDomainDemagKind::static_k0;
    req.mfem_validation_problem.descriptor.demag_enabled = true;
    req.mfem_validation_problem.descriptor.exchange_enabled = true;
    req.mfem_validation_problem.exchange_edges = edges.data();
    req.mfem_validation_problem.exchange_edge_count = edges.size();
    req.mfem_validation_problem.descriptor.zeeman_enabled = true;
    req.mfem_validation_problem.h_ext_a_per_m = h_ext;
    req.mfem_validation_problem.h_ext_value_count = 3;
    req.demag_sparse_blocks = &blocks;

    const std::size_t n_q = nodes.size() * 2u;
    const std::vector<double> drive_re = {1.0e8, -0.4e8, 0.6e8, 0.2e8, -0.7e8, 0.5e8};
    const std::vector<double> drive_im = {0.1e8, 0.3e8, -0.2e8, 0.5e8, 0.2e8, -0.1e8};
    std::vector<double> resp_re(freqs.size() * n_q, 0.0);
    std::vector<double> resp_im(freqs.size() * n_q, 0.0);
    std::vector<double> phi_re(freqs.size() * n_phi, 0.0);
    std::vector<double> phi_im(freqs.size() * n_phi, 0.0);
    std::vector<double> hd_re(freqs.size() * n_q, 0.0);
    std::vector<double> hd_im(freqs.size() * n_q, 0.0);

    DrivenResponseCudssOutcome outcome{};
    const auto status = solve_driven_response_gpu_cudss(
        req,
        drive_re.data(),
        drive_im.data(),
        resp_re.data(),
        resp_im.data(),
        nullptr,
        nullptr,
        phi_re.data(),
        phi_im.data(),
        hd_re.data(),
        hd_im.data(),
        &outcome);
    CHECK(status == FrequencyDomainStatus::ok, "coupled airbox cuDSS sweep failed");
    CHECK(outcome.used_cudss && outcome.symbolic_analysis_count == 1u &&
              outcome.numeric_factorization_count == freqs.size(),
          "coupled sweep analysis/factorization counts mismatch");
    CHECK(outcome.max_magnetic_relative_residual_l2 <= 1.0e-10,
          "coupled sweep magnetic residual exceeded 1e-10");
    CHECK(outcome.max_poisson_relative_residual_l2 <= 1.0e-10,
          "coupled sweep Poisson residual exceeded 1e-10");

    // Build dense Schur oracle with row 4 zeroed in R_{phi q}.
    std::vector<double> k_loc;
    std::vector<double> m_mat;
    build_dense_magnetic_km(req, k_loc, m_mat);

    std::vector<double> r_phi_q(n_phi * n_q, 0.0);
    for (std::size_t p = 0; p < n_phi; ++p) {
        if (p == 4) {
            continue;
        }
        for (std::size_t u = 0; u < nodes.size(); ++u) {
            const std::size_t g = mag_indices[u];
            const double rx = rhs_x_d[p * full_nodes + g];
            const double ry = rhs_y_d[p * full_nodes + g];
            const double rz = rhs_z_d[p * full_nodes + g];
            r_phi_q[p * n_q + 2 * u] =
                rx * nodes[u].e1[0] + ry * nodes[u].e1[1] + rz * nodes[u].e1[2];
            r_phi_q[p * n_q + 2 * u + 1] =
                rx * nodes[u].e2[0] + ry * nodes[u].e2[1] + rz * nodes[u].e2[2];
        }
    }
    std::vector<double> k_q_phi(n_q * n_phi, 0.0);
    for (std::size_t u = 0; u < nodes.size(); ++u) {
        const std::size_t g = mag_indices[u];
        for (std::size_t p = 0; p < n_phi; ++p) {
            const double gx = rec_x_d[g * n_phi + p];
            const double gy = rec_y_d[g * n_phi + p];
            const double gz = rec_z_d[g * n_phi + p];
            const double h0 = gx * nodes[u].e1[0] + gy * nodes[u].e1[1] + gz * nodes[u].e1[2];
            const double h1 = gx * nodes[u].e2[0] + gy * nodes[u].e2[1] + gz * nodes[u].e2[2];
            k_q_phi[(2 * u) * n_phi + p] = kGamma0 * h1;
            k_q_phi[(2 * u + 1) * n_phi + p] = -kGamma0 * h0;
        }
    }

    // Solve P * X = R_{phi q} column by column for Schur complement K_eff = K_loc + K_{q phi} X.
    std::vector<Complex> p_c(n_phi * n_phi);
    for (std::size_t i = 0; i < p_c.size(); ++i) {
        p_c[i] = Complex(p_dense[i], 0.0);
    }
    std::vector<double> p_inv_r(n_phi * n_q, 0.0);
    for (std::size_t col = 0; col < n_q; ++col) {
        std::vector<Complex> rhs_col(n_phi);
        for (std::size_t p = 0; p < n_phi; ++p) {
            rhs_col[p] = Complex(r_phi_q[p * n_q + col], 0.0);
        }
        std::vector<Complex> x_col;
        CHECK(solve_dense_complex_linear_system(n_phi, p_c, rhs_col, x_col),
              "dense Poisson solve failed");
        for (std::size_t p = 0; p < n_phi; ++p) {
            p_inv_r[p * n_q + col] = x_col[p].real();
        }
    }
    std::vector<double> k_eff = k_loc;
    for (std::size_t i = 0; i < n_q; ++i) {
        for (std::size_t j = 0; j < n_q; ++j) {
            double s = 0.0;
            for (std::size_t p = 0; p < n_phi; ++p) {
                s += k_q_phi[i * n_phi + p] * p_inv_r[p * n_q + j];
            }
            k_eff[i * n_q + j] += s;
        }
    }

    std::vector<Complex> rhs(n_q);
    for (std::size_t i = 0; i < n_q; ++i) {
        rhs[i] = Complex(drive_re[i], drive_im[i]);
    }
    for (std::size_t k = 0; k < freqs.size(); ++k) {
        CHECK(std::abs(phi_re[k * n_phi + 4]) == 0.0 && std::abs(phi_im[k * n_phi + 4]) == 0.0,
              "ess_tdof row 4 must yield exact delta_phi == 0");
        const double omega = kTwoPi * freqs[k];
        std::vector<Complex> z(n_q * n_q);
        for (std::size_t idx = 0; idx < n_q * n_q; ++idx) {
            z[idx] = Complex(k_eff[idx], -omega * m_mat[idx]);
        }
        std::vector<Complex> q_ref;
        CHECK(solve_dense_complex_linear_system(n_q, z, rhs, q_ref),
              "dense Schur solve failed");
        std::vector<Complex> phi_ref(n_phi, Complex(0.0, 0.0));
        for (std::size_t p = 0; p < n_phi; ++p) {
            for (std::size_t j = 0; j < n_q; ++j) {
                phi_ref[p] += p_inv_r[p * n_q + j] * q_ref[j];
            }
        }
        CHECK(relative_l2_error(resp_re.data() + k * n_q, resp_im.data() + k * n_q, q_ref) <
                  1.0e-10,
              "coupled q parity with Schur oracle exceeded 1e-10");
        CHECK(relative_l2_error(phi_re.data() + k * n_phi, phi_im.data() + k * n_phi, phi_ref) <
                  1.0e-10,
              "coupled delta_phi parity with Schur oracle exceeded 1e-10");
    }
    return true;
}

bool test_divergence_free_mode_poisson_residual_certificate()
{
    // Symmetric 2-node system where R_{phi q} measures (q_0 - q_1), so a symmetric
    // drive excites a strictly divergence-free mode (R_{phi q} q == 0, delta_phi == 0).
    const std::vector<TangentFrameNode> nodes = {
        make_frame(0.0, 0.0, 1.0),
        make_frame(0.0, 0.0, 1.0),
    };
    const double h_ext[3] = {0.0, 0.0, 1.0e5};
    const std::vector<double> freqs = {3.0e9, 7.0e9};

    const std::uint64_t full_nodes = 2;
    const std::uint64_t n_phi = 3;
    const std::vector<std::uint32_t> mag_indices = {0, 1};

    std::vector<double> p_dense = {
        2.0, -0.5, 0.0,
        -0.5, 2.0, -0.5,
        0.0, -0.5, 2.0,
    };
    std::vector<double> rhs_x_d = {
        1.0, -1.0,
        -0.5, 0.5,
        0.25, -0.25,
    };
    std::vector<double> rhs_zero(n_phi * full_nodes, 0.0);
    std::vector<double> rec_x_d = {
        1.0, -0.5, 0.25,
        -1.0, 0.5, -0.25,
    };
    std::vector<double> rec_zero(full_nodes * n_phi, 0.0);

    const OwnedCsr p_csr = dense_to_csr(p_dense, n_phi, n_phi);
    const OwnedCsr rx_csr = dense_to_csr(rhs_x_d, n_phi, full_nodes);
    const OwnedCsr rz_csr = dense_to_csr(rhs_zero, n_phi, full_nodes);
    const OwnedCsr gx_csr = dense_to_csr(rec_x_d, full_nodes, n_phi);
    const OwnedCsr gz_csr = dense_to_csr(rec_zero, full_nodes, n_phi);

    DrivenFrequencyResponseDemagSparseBlocks blocks{};
    blocks.full_node_count = full_nodes;
    blocks.phi_dof_count = n_phi;
    blocks.magnetic_node_count = 2;
    blocks.poisson_matrix = p_csr.view();
    blocks.rhs_x = rx_csr.view();
    blocks.rhs_y = rz_csr.view();
    blocks.rhs_z = rz_csr.view();
    blocks.recovery_x = gx_csr.view();
    blocks.recovery_y = gz_csr.view();
    blocks.recovery_z = gz_csr.view();
    blocks.magnetic_node_indices = mag_indices.data();

    auto req = make_base_request(nodes, freqs, 0.02);
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
    req.solver_options.relative_tolerance = 1.0e-10;
    req.mfem_validation_problem.descriptor.demag_enabled = true;
    req.mfem_validation_problem.descriptor.zeeman_enabled = true;
    req.mfem_validation_problem.h_ext_a_per_m = h_ext;
    req.mfem_validation_problem.h_ext_value_count = 3;
    req.demag_sparse_blocks = &blocks;

    // Strictly symmetric drive across node 0 and node 1 => R_{phi q} q == 0!
    const std::vector<double> drive_re = {1.0e6, 0.0, 1.0e6, 0.0};
    std::vector<double> resp_re(freqs.size() * 4u, 0.0);
    std::vector<double> resp_im(freqs.size() * 4u, 0.0);
    std::vector<double> phi_re(freqs.size() * n_phi, 0.0);
    std::vector<double> phi_im(freqs.size() * n_phi, 0.0);

    DrivenResponseCudssOutcome outcome{};
    const auto status = solve_driven_response_gpu_cudss(
        req,
        drive_re.data(),
        nullptr,
        resp_re.data(),
        resp_im.data(),
        nullptr,
        nullptr,
        phi_re.data(),
        phi_im.data(),
        nullptr,
        nullptr,
        &outcome);
    CHECK(status == FrequencyDomainStatus::ok,
          "divergence-free mode must pass Poisson residual certificate via atol_phi floor");
    CHECK(outcome.used_cudss && outcome.max_poisson_relative_residual_l2 <= 1.0e-10,
          "divergence-free mode Poisson residual too large");
    for (std::size_t i = 0; i < phi_re.size(); ++i) {
        CHECK(std::hypot(phi_re[i], phi_im[i]) < 1.0e-12,
              "divergence-free mode delta_phi must be near zero");
    }
    return true;
}

bool test_vram_budget_guard_auto_vs_required()
{
    const std::vector<TangentFrameNode> nodes = {
        make_frame(0.0, 0.0, 1.0),
        make_frame(0.0, 0.0, 1.0),
    };
    const double h_ext[3] = {0.0, 0.0, 1.0e5};
    const std::vector<double> freqs = {2.0e9, 4.0e9};
    const std::vector<double> drive_re = {1.0, 0.0, 1.0, 0.0};
    std::vector<double> out_re(freqs.size() * 4u, 0.0);
    std::vector<double> out_im(freqs.size() * 4u, 0.0);

    ScopedEnvVar budget_guard(kDrivenCudssBudgetBytesEnv, "1");
    auto req = make_base_request(nodes, freqs, 0.02);
    req.mfem_validation_problem.descriptor.zeeman_enabled = true;
    req.mfem_validation_problem.h_ext_a_per_m = h_ext;
    req.mfem_validation_problem.h_ext_value_count = 3;

    // Auto => clean fallback before factorization starts.
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
    DrivenResponseCudssOutcome auto_out{};
    const auto auto_status = solve_driven_response_gpu_cudss(
        req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
        nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &auto_out);
    CHECK(auto_status == FrequencyDomainStatus::ok, "Auto over-budget must return ok fallback");
    CHECK(!auto_out.used_cudss && auto_out.fallback_to_krylov,
          "Auto over-budget must fall back to Krylov");
    CHECK(auto_out.fallback_reason == "cudss_peak_memory_budget_exceeded",
          "Auto over-budget fallback_reason mismatch");
    CHECK(auto_out.symbolic_analysis_count == 1u && auto_out.numeric_factorization_count == 0u,
          "Over-budget must stop before factorization starts");
    CHECK(auto_out.estimated_peak_device_bytes > auto_out.device_budget_bytes,
          "Over-budget telemetry mismatch");

    // Required => hard fail unavailable with zero fallback.
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
    DrivenResponseCudssOutcome req_out{};
    const auto req_status = solve_driven_response_gpu_cudss(
        req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
        nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &req_out);
    CHECK(req_status == FrequencyDomainStatus::unavailable,
          "Required over-budget must fail hard with unavailable");
    CHECK(!req_out.used_cudss && !req_out.fallback_to_krylov,
          "Required over-budget must never fall back");
    CHECK(req_out.numeric_factorization_count == 0u,
          "Required over-budget must not launch factorization");
    return true;
}

bool test_singular_undamped_resonance_hard_error_under_auto()
{
    // 1-node undamped Kittel resonance: alpha = 0, omega = gamma0 * H_0 => det Z(omega) == 0.
    const std::vector<TangentFrameNode> nodes = {make_frame(0.0, 0.0, 1.0)};
    const double h0 = 1.0e5;
    const double h_ext[3] = {0.0, 0.0, h0};
    const double f_res = (kGamma0 * h0) / kTwoPi;
    const std::vector<double> freqs = {f_res};
    const std::vector<double> drive_re = {1.0, 0.0};
    std::vector<double> out_re(2, 0.0);
    std::vector<double> out_im(2, 0.0);

    auto req = make_base_request(nodes, freqs, 0.0);
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Auto;
    req.mfem_validation_problem.descriptor.zeeman_enabled = true;
    req.mfem_validation_problem.h_ext_a_per_m = h_ext;
    req.mfem_validation_problem.h_ext_value_count = 3;

    DrivenResponseCudssOutcome outcome{};
    const auto status = solve_driven_response_gpu_cudss(
        req, drive_re.data(), nullptr, out_re.data(), out_im.data(),
        nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, &outcome);
    CHECK(status == FrequencyDomainStatus::solve_error,
          "Singular undamped resonance must return solve_error even under Auto");
    CHECK(!outcome.fallback_to_krylov,
          "Singular undamped resonance must never fall back to Krylov under Auto");
    return true;
}

bool test_static_periodic_k0_lifting_and_h_demag_recovery()
{
    // 4 magnetic nodes reduced to 2 classes via pairs (0,2), (1,3), coupled to a
    // 6-node periodic mesh reduced to 3 potential classes (0, 1, 2=pin).
    const std::vector<TangentFrameNode> nodes = {
        make_frame(0.0, 0.0, 1.0),
        make_frame(0.0, 0.0, 1.0),
        make_frame(0.0, 0.0, 1.0),
        make_frame(0.0, 0.0, 1.0),
    };
    const std::vector<std::uint64_t> mag_pairs = {0, 2, 1, 3};
    const std::vector<TangentOperatorEdgeBlock> edges = {
        {FrequencyDomainOperatorTermKind::exchange, 0, 1, 4.0e4},
        {FrequencyDomainOperatorTermKind::exchange, 2, 3, 4.0e4},
    };
    const double h_ext[3] = {0.0, 0.0, 1.2e5};
    const std::vector<double> freqs = {4.0e9, 9.0e9};

    const std::uint64_t full_nodes = 6;
    const std::uint64_t n_phi = 3;
    const std::vector<std::uint32_t> mag_indices = {0, 1, 2, 3};
    const std::vector<std::uint32_t> periodic_red_node = {0, 1, 0, 1, 2, 2};
    const std::vector<std::uint32_t> ess_tdofs = {2};

    std::vector<double> p_dense = {
        3.0e-8, -1.0e-8, 0.0,
        -1.0e-8, 3.0e-8, 0.0,
        0.0, 0.0, 1.0,
    };
    // Periodic-consistent RHS and recovery (identical rows for periodic images (0,2) and (1,3)).
    std::vector<double> rhs_x_d(n_phi * full_nodes, 0.0);
    std::vector<double> rhs_zero(n_phi * full_nodes, 0.0);
    rhs_x_d[0 * full_nodes + 0] = 1.0e-9;
    rhs_x_d[0 * full_nodes + 2] = 1.0e-9;
    rhs_x_d[1 * full_nodes + 1] = -1.2e-9;
    rhs_x_d[1 * full_nodes + 3] = -1.2e-9;

    std::vector<double> rec_x_d(full_nodes * n_phi, 0.0);
    std::vector<double> rec_zero(full_nodes * n_phi, 0.0);
    rec_x_d[0 * n_phi + 0] = -8.0e5;
    rec_x_d[0 * n_phi + 1] = 3.0e5;
    rec_x_d[2 * n_phi + 0] = -8.0e5;
    rec_x_d[2 * n_phi + 1] = 3.0e5;
    rec_x_d[1 * n_phi + 0] = 2.0e5;
    rec_x_d[1 * n_phi + 1] = -7.0e5;
    rec_x_d[3 * n_phi + 0] = 2.0e5;
    rec_x_d[3 * n_phi + 1] = -7.0e5;

    const OwnedCsr p_csr = dense_to_csr(p_dense, n_phi, n_phi);
    const OwnedCsr rx_csr = dense_to_csr(rhs_x_d, n_phi, full_nodes);
    const OwnedCsr rz_csr = dense_to_csr(rhs_zero, n_phi, full_nodes);
    const OwnedCsr gx_csr = dense_to_csr(rec_x_d, full_nodes, n_phi);
    const OwnedCsr gz_csr = dense_to_csr(rec_zero, full_nodes, n_phi);

    DrivenFrequencyResponseDemagSparseBlocks blocks{};
    blocks.is_periodic_reduced = 1u;
    blocks.full_node_count = full_nodes;
    blocks.phi_dof_count = n_phi;
    blocks.magnetic_node_count = nodes.size();
    blocks.ess_tdof_count = ess_tdofs.size();
    blocks.poisson_matrix = p_csr.view();
    blocks.rhs_x = rx_csr.view();
    blocks.rhs_y = rz_csr.view();
    blocks.rhs_z = rz_csr.view();
    blocks.recovery_x = gx_csr.view();
    blocks.recovery_y = gz_csr.view();
    blocks.recovery_z = gz_csr.view();
    blocks.magnetic_node_indices = mag_indices.data();
    blocks.ess_tdofs = ess_tdofs.data();
    blocks.periodic_reduced_node = periodic_red_node.data();

    auto req = make_base_request(nodes, freqs, 0.015);
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
    req.solver_options.relative_tolerance = 1.0e-10;
    req.requires_periodic_airbox_dynamic_demag = true;
    req.periodic_airbox_delta_phi_dof_count = full_nodes;
    req.mfem_validation_problem.descriptor.demag_enabled = true;
    req.mfem_validation_problem.descriptor.exchange_enabled = true;
    req.mfem_validation_problem.exchange_edges = edges.data();
    req.mfem_validation_problem.exchange_edge_count = edges.size();
    req.mfem_validation_problem.descriptor.zeeman_enabled = true;
    req.mfem_validation_problem.h_ext_a_per_m = h_ext;
    req.mfem_validation_problem.h_ext_value_count = 3;
    req.mfem_validation_problem.static_periodic_node_pairs = mag_pairs.data();
    req.mfem_validation_problem.static_periodic_node_pair_count = 2;
    req.demag_sparse_blocks = &blocks;

    const std::vector<double> drive_re = {
        1.0e7, -0.5e7, 0.3e7, 0.8e7, 1.0e7, -0.5e7, 0.3e7, 0.8e7};
    const std::size_t n_q_full = nodes.size() * 2u;
    std::vector<double> resp_re(freqs.size() * n_q_full, 0.0);
    std::vector<double> resp_im(freqs.size() * n_q_full, 0.0);
    std::vector<double> phi_full_re(freqs.size() * full_nodes, 0.0);
    std::vector<double> phi_full_im(freqs.size() * full_nodes, 0.0);
    std::vector<double> hd_re(freqs.size() * n_q_full, 0.0);
    std::vector<double> hd_im(freqs.size() * n_q_full, 0.0);

    DrivenResponseCudssOutcome outcome{};
    CHECK(solve_driven_response_gpu_cudss(
              req,
              drive_re.data(),
              nullptr,
              resp_re.data(),
              resp_im.data(),
              nullptr,
              nullptr,
              phi_full_re.data(),
              phi_full_im.data(),
              hd_re.data(),
              hd_im.data(),
              &outcome) == FrequencyDomainStatus::ok,
          "periodic_airbox_k0 cuDSS solve failed");
    CHECK(outcome.used_cudss && outcome.max_magnetic_relative_residual_l2 <= 1.0e-10 &&
              outcome.max_poisson_relative_residual_l2 <= 1.0e-10,
          "periodic_airbox_k0 residual certification too large");

    for (std::size_t k = 0; k < freqs.size(); ++k) {
        const double *qr = resp_re.data() + k * n_q_full;
        const double *qi = resp_im.data() + k * n_q_full;
        const double *pr = phi_full_re.data() + k * full_nodes;
        const double *pi = phi_full_im.data() + k * full_nodes;
        const double *hr = hd_re.data() + k * n_q_full;
        const double *hi = hd_im.data() + k * n_q_full;

        // Exact periodic lifting for magnetic tangent DOFs (0==2, 1==3).
        for (int c = 0; c < 2; ++c) {
            CHECK(qr[0 * 2 + c] == qr[2 * 2 + c] && qi[0 * 2 + c] == qi[2 * 2 + c],
                  "periodic magnetic lift mismatch on pair (0,2)");
            CHECK(qr[1 * 2 + c] == qr[3 * 2 + c] && qi[1 * 2 + c] == qi[3 * 2 + c],
                  "periodic magnetic lift mismatch on pair (1,3)");
            CHECK(std::abs(hr[0 * 2 + c] - hr[2 * 2 + c]) <= 1.0e-12 &&
                      std::abs(hi[0 * 2 + c] - hi[2 * 2 + c]) <= 1.0e-12,
                  "periodic h_demag seam mismatch on pair (0,2)");
            CHECK(std::abs(hr[1 * 2 + c] - hr[3 * 2 + c]) <= 1.0e-12 &&
                      std::abs(hi[1 * 2 + c] - hi[3 * 2 + c]) <= 1.0e-12,
                  "periodic h_demag seam mismatch on pair (1,3)");
        }
        // Exact periodic lifting for delta_phi_full (0==2, 1==3, 4==5==0 pin).
        CHECK(pr[0] == pr[2] && pi[0] == pi[2], "periodic phi lift mismatch on pair (0,2)");
        CHECK(pr[1] == pr[3] && pi[1] == pi[3], "periodic phi lift mismatch on pair (1,3)");
        CHECK(pr[4] == 0.0 && pi[4] == 0.0 && pr[5] == 0.0 && pi[5] == 0.0,
              "periodic gauge pin must yield exact zero delta_phi on pinned class");

        // Verify G_rec recovery matches recovered tangent h_demag.
        const double phi_red_re[3] = {pr[0], pr[1], pr[4]};
        const double phi_red_im[3] = {pi[0], pi[1], pi[4]};
        for (std::size_t u = 0; u < nodes.size(); ++u) {
            double hx_re = 0.0, hx_im = 0.0;
            for (std::size_t p = 0; p < n_phi; ++p) {
                hx_re += rec_x_d[u * n_phi + p] * phi_red_re[p];
                hx_im += rec_x_d[u * n_phi + p] * phi_red_im[p];
            }
            const double exp_h0_re = hx_re * nodes[u].e1[0];
            const double exp_h0_im = hx_im * nodes[u].e1[0];
            const double exp_h1_re = hx_re * nodes[u].e2[0];
            const double exp_h1_im = hx_im * nodes[u].e2[0];
            CHECK(std::abs(hr[2 * u] - exp_h0_re) <= 1.0e-10 * (1.0 + std::abs(exp_h0_re)) &&
                      std::abs(hi[2 * u] - exp_h0_im) <= 1.0e-10 * (1.0 + std::abs(exp_h0_im)) &&
                      std::abs(hr[2 * u + 1] - exp_h1_re) <= 1.0e-10 * (1.0 + std::abs(exp_h1_re)) &&
                      std::abs(hi[2 * u + 1] - exp_h1_im) <= 1.0e-10 * (1.0 + std::abs(exp_h1_im)),
                  "recovered tangent h_demag does not match G_rec * delta_phi_red");
        }
    }
    return true;
}

bool test_asymmetric_1e25_open_airbox_block_prescaling()
{
    // Mirrors real MFEM open-airbox block scaling (3A_open / 3B_open_large):
    // s_qq ~ 1e12, K_{q phi} ~ 3.5e13, -R_{phi q} ~ 2.7e-12 (~1e25 off-diagonal
    // asymmetry), interior P ~ 1.35e-7 alongside unit-diagonal ess_tdofs row and
    // uncoupled airbox rows. Without 2x2 block geometric pre-scaling before Ruiz,
    // coupled P diagonals squash toward ~1e-10 and perturb pivots.
    const std::vector<TangentFrameNode> nodes = {
        make_frame(1.0, 0.0, 0.0),
        make_frame(0.95, 0.3122498999199199, 0.0),
        make_frame(0.8, 0.0, 0.6),
    };
    const double h_ext[3] = {5.0e4, 1.0e4, 0.0};
    const std::vector<MfemExchangeEdgeTerm> edges = {
        {FrequencyDomainOperatorTermKind::exchange, 0, 1, 2.2e6},
        {FrequencyDomainOperatorTermKind::exchange, 1, 2, 2.0e6},
    };
    const std::vector<double> freqs = {1.0e9, 5.0e9, 11.0e9, 18.0e9, 25.0e9};

    const std::size_t full_nodes = 8u;
    const std::size_t n_phi = 8u;
    const std::vector<std::uint32_t> mag_indices = {0u, 1u, 2u};
    const std::vector<std::uint32_t> ess_tdofs = {7u};

    // Interior Poisson stiffness ~1.35e-7 coupling magnetic {0..2} & airbox {3..6};
    // unit-diagonal eliminated Dirichlet boundary row 7.
    std::vector<double> p_dense(n_phi * n_phi, 0.0);
    const double ps = 1.35e-7;
    for (std::size_t i = 0; i < 7u; ++i) {
        p_dense[i * n_phi + i] = 4.0 * ps;
        if (i + 1u < 7u) {
            p_dense[i * n_phi + (i + 1u)] = -1.0 * ps;
            p_dense[(i + 1u) * n_phi + i] = -1.0 * ps;
        }
    }
    p_dense[0 * n_phi + 3] = -0.5 * ps;
    p_dense[3 * n_phi + 0] = -0.5 * ps;
    p_dense[2 * n_phi + 5] = -0.5 * ps;
    p_dense[5 * n_phi + 2] = -0.5 * ps;
    p_dense[7 * n_phi + 7] = 1.0;

    // -R_{phi q} at ~2.67e-12 on magnetic-coupled rows {0..2}; zero on uncoupled
    // airbox rows {3..6} and ess_tdofs row {7}.
    std::vector<double> rhs_x_d(n_phi * full_nodes, 0.0);
    std::vector<double> rhs_y_d(n_phi * full_nodes, 0.0);
    std::vector<double> rhs_z_d(n_phi * full_nodes, 0.0);
    rhs_x_d[0 * full_nodes + 0] = 2.67e-12;
    rhs_x_d[1 * full_nodes + 1] = -2.10e-12;
    rhs_x_d[2 * full_nodes + 2] = 1.85e-12;
    rhs_y_d[0 * full_nodes + 1] = 1.60e-12;
    rhs_y_d[1 * full_nodes + 0] = -1.45e-12;
    rhs_y_d[2 * full_nodes + 1] = 1.10e-12;
    rhs_z_d[1 * full_nodes + 2] = 1.30e-12;
    rhs_z_d[2 * full_nodes + 0] = -0.95e-12;

    // Recovery G_rec at ~1.6e8 -> K_{q phi} = R_{gamma0} E^T G_rec ~ 3.54e13.
    std::vector<double> rec_x_d(full_nodes * n_phi, 0.0);
    std::vector<double> rec_y_d(full_nodes * n_phi, 0.0);
    std::vector<double> rec_z_d(full_nodes * n_phi, 0.0);
    rec_x_d[0 * n_phi + 0] = -1.60e8;
    rec_x_d[0 * n_phi + 1] = 0.85e8;
    rec_x_d[1 * n_phi + 1] = -1.35e8;
    rec_x_d[2 * n_phi + 2] = -1.20e8;
    rec_y_d[0 * n_phi + 1] = -1.10e8;
    rec_y_d[1 * n_phi + 2] = 0.90e8;
    rec_y_d[2 * n_phi + 3] = -0.75e8;
    rec_z_d[2 * n_phi + 1] = -0.80e8;

    const OwnedCsr p_csr = dense_to_csr(p_dense, n_phi, n_phi);
    const OwnedCsr rx_csr = dense_to_csr(rhs_x_d, n_phi, full_nodes);
    const OwnedCsr ry_csr = dense_to_csr(rhs_y_d, n_phi, full_nodes);
    const OwnedCsr rz_csr = dense_to_csr(rhs_z_d, n_phi, full_nodes);
    const OwnedCsr gx_csr = dense_to_csr(rec_x_d, full_nodes, n_phi);
    const OwnedCsr gy_csr = dense_to_csr(rec_y_d, full_nodes, n_phi);
    const OwnedCsr gz_csr = dense_to_csr(rec_z_d, full_nodes, n_phi);

    DrivenFrequencyResponseDemagSparseBlocks blocks{};
    blocks.is_periodic_reduced = 0u;
    blocks.full_node_count = full_nodes;
    blocks.phi_dof_count = n_phi;
    blocks.magnetic_node_count = nodes.size();
    blocks.ess_tdof_count = ess_tdofs.size();
    blocks.poisson_matrix = p_csr.view();
    blocks.rhs_x = rx_csr.view();
    blocks.rhs_y = ry_csr.view();
    blocks.rhs_z = rz_csr.view();
    blocks.recovery_x = gx_csr.view();
    blocks.recovery_y = gy_csr.view();
    blocks.recovery_z = gz_csr.view();
    blocks.magnetic_node_indices = mag_indices.data();
    blocks.ess_tdofs = ess_tdofs.data();

    auto req = make_base_request(nodes, freqs, 0.01);
    req.gpu_direct_policy = DrivenFrequencyResponseGpuDirectPolicy::Required;
    req.solver_options.relative_tolerance = 1.0e-10;
    req.solve_request.operator_request.demag_kind = FrequencyDomainDemagKind::static_k0;
    req.mfem_validation_problem.descriptor.demag_enabled = true;
    req.mfem_validation_problem.descriptor.exchange_enabled = true;
    req.mfem_validation_problem.exchange_edges = edges.data();
    req.mfem_validation_problem.exchange_edge_count = edges.size();
    req.mfem_validation_problem.descriptor.zeeman_enabled = true;
    req.mfem_validation_problem.h_ext_a_per_m = h_ext;
    req.mfem_validation_problem.h_ext_value_count = 3;
    req.demag_sparse_blocks = &blocks;

    const std::size_t n_q = nodes.size() * 2u;
    const std::vector<double> drive_re = {1.0e9, -0.4e9, 0.6e9, 0.2e9, -0.7e9, 0.5e9};
    const std::vector<double> drive_im = {0.1e9, 0.3e9, -0.2e9, 0.5e9, 0.2e9, -0.1e9};
    std::vector<double> resp_re(freqs.size() * n_q, 0.0);
    std::vector<double> resp_im(freqs.size() * n_q, 0.0);
    std::vector<double> phi_re(freqs.size() * n_phi, 0.0);
    std::vector<double> phi_im(freqs.size() * n_phi, 0.0);

    DrivenResponseCudssOutcome outcome{};
    const auto status = solve_driven_response_gpu_cudss(
        req,
        drive_re.data(),
        drive_im.data(),
        resp_re.data(),
        resp_im.data(),
        nullptr,
        nullptr,
        phi_re.data(),
        phi_im.data(),
        nullptr,
        nullptr,
        &outcome);
    CHECK(status == FrequencyDomainStatus::ok, "1e25 asymmetric-coupling open-airbox sweep failed");
    CHECK(outcome.used_cudss && outcome.symbolic_analysis_count == 1u &&
              outcome.numeric_factorization_count == freqs.size(),
          "1e25 asymmetric-coupling analysis/factorization counts mismatch");
    CHECK(outcome.max_magnetic_relative_residual_l2 <= 1.0e-12,
          "1e25 asymmetric-coupling magnetic residual exceeded 1e-12");
    CHECK(outcome.max_poisson_relative_residual_l2 <= 1.0e-12,
          "1e25 asymmetric-coupling Poisson residual exceeded 1e-12");

    std::vector<double> k_loc;
    std::vector<double> m_mat;
    build_dense_magnetic_km(req, k_loc, m_mat);

    std::vector<double> r_phi_q(n_phi * n_q, 0.0);
    for (std::size_t p = 0; p < n_phi; ++p) {
        if (p == 7u) {
            continue;
        }
        for (std::size_t u = 0; u < nodes.size(); ++u) {
            const std::size_t g = mag_indices[u];
            const double rx = rhs_x_d[p * full_nodes + g];
            const double ry = rhs_y_d[p * full_nodes + g];
            const double rz = rhs_z_d[p * full_nodes + g];
            r_phi_q[p * n_q + 2 * u] =
                rx * nodes[u].e1[0] + ry * nodes[u].e1[1] + rz * nodes[u].e1[2];
            r_phi_q[p * n_q + 2 * u + 1] =
                rx * nodes[u].e2[0] + ry * nodes[u].e2[1] + rz * nodes[u].e2[2];
        }
    }
    std::vector<double> k_q_phi(n_q * n_phi, 0.0);
    for (std::size_t u = 0; u < nodes.size(); ++u) {
        const std::size_t g = mag_indices[u];
        for (std::size_t p = 0; p < n_phi; ++p) {
            const double gx = rec_x_d[g * n_phi + p];
            const double gy = rec_y_d[g * n_phi + p];
            const double gz = rec_z_d[g * n_phi + p];
            const double h1 = gx * nodes[u].e1[0] + gy * nodes[u].e1[1] + gz * nodes[u].e1[2];
            const double h2 = gx * nodes[u].e2[0] + gy * nodes[u].e2[1] + gz * nodes[u].e2[2];
            k_q_phi[(2 * u) * n_phi + p] = kGamma0 * h2;
            k_q_phi[(2 * u + 1) * n_phi + p] = -kGamma0 * h1;
        }
    }

    // Dense Schur complement oracle: K_eff = K_loc + K_{q phi} P^{-1} R_{phi q}.
    std::vector<double> k_eff = k_loc;
    for (std::size_t col = 0; col < n_q; ++col) {
        std::vector<Complex> p_c(n_phi * n_phi);
        for (std::size_t i = 0; i < n_phi * n_phi; ++i) {
            p_c[i] = Complex(p_dense[i], 0.0);
        }
        std::vector<Complex> rhs_col(n_phi);
        for (std::size_t p = 0; p < n_phi; ++p) {
            rhs_col[p] = Complex(r_phi_q[p * n_q + col], 0.0);
        }
        std::vector<Complex> phi_col;
        CHECK(solve_dense_complex_linear_system(n_phi, p_c, rhs_col, phi_col),
              "1e25 dense P solve failed");
        for (std::size_t r = 0; r < n_q; ++r) {
            double acc = 0.0;
            for (std::size_t p = 0; p < n_phi; ++p) {
                acc += k_q_phi[r * n_phi + p] * phi_col[p].real();
            }
            k_eff[r * n_q + col] += acc;
        }
    }

    for (std::size_t k = 0; k < freqs.size(); ++k) {
        const double omega = kTwoPi * freqs[k];
        std::vector<Complex> z_eff(n_q * n_q);
        for (std::size_t i = 0; i < n_q * n_q; ++i) {
            z_eff[i] = Complex(k_eff[i], -omega * m_mat[i]);
        }
        std::vector<Complex> rhs_q(n_q);
        for (std::size_t i = 0; i < n_q; ++i) {
            rhs_q[i] = Complex(drive_re[i], drive_im[i]);
        }
        std::vector<Complex> q_ref;
        CHECK(solve_dense_complex_linear_system(n_q, z_eff, rhs_q, q_ref),
              "1e25 dense Schur oracle solve failed");
        const double err_q = relative_l2_error(
            resp_re.data() + k * n_q, resp_im.data() + k * n_q, q_ref);
        CHECK(err_q < 1.0e-11, "1e25 asymmetric-coupling q diverged from Schur oracle");

        std::vector<Complex> p_c(n_phi * n_phi);
        for (std::size_t i = 0; i < n_phi * n_phi; ++i) {
            p_c[i] = Complex(p_dense[i], 0.0);
        }
        std::vector<Complex> rhs_phi(n_phi, Complex(0.0, 0.0));
        for (std::size_t p = 0; p < n_phi; ++p) {
            for (std::size_t c = 0; c < n_q; ++c) {
                rhs_phi[p] += r_phi_q[p * n_q + c] * q_ref[c];
            }
        }
        std::vector<Complex> phi_ref;
        CHECK(solve_dense_complex_linear_system(n_phi, p_c, rhs_phi, phi_ref),
              "1e25 dense phi oracle solve failed");
        const double err_phi = relative_l2_error(
            phi_re.data() + k * n_phi, phi_im.data() + k * n_phi, phi_ref);
        CHECK(err_phi < 1.0e-11, "1e25 asymmetric-coupling delta_phi diverged from Schur oracle");
        CHECK(std::hypot(phi_re[k * n_phi + 7u], phi_im[k * n_phi + 7u]) < 1.0e-15,
              "1e25 Dirichlet ess_tdof node 7 must remain zero");
    }
    return true;
}

#endif // FULLMAG_FEM_CUDSS_DRIVEN_ENABLED

} // namespace

int main()
{
    if (!test_portable_policy_env_and_scope_contracts()) {
        return 1;
    }
#if defined(FULLMAG_FEM_CUDSS_DRIVEN_ENABLED) && FULLMAG_FEM_CUDSS_DRIVEN_ENABLED
    if (!has_cuda_device()) {
        std::cout << "fem_driven_response_cudss_contract: portable checks passed (no CUDA GPU present)\n";
        return 0;
    }
    if (!test_no_demag_sweep_parity_and_single_analysis() ||
        !test_coupled_airbox_demag_sweep_parity_and_ess_tdofs() ||
        !test_asymmetric_1e25_open_airbox_block_prescaling() ||
        !test_divergence_free_mode_poisson_residual_certificate() ||
        !test_vram_budget_guard_auto_vs_required() ||
        !test_singular_undamped_resonance_hard_error_under_auto() ||
        !test_static_periodic_k0_lifting_and_h_demag_recovery()) {
        return 1;
    }
#endif
    std::cout << "fem_driven_response_cudss_contract: ALL PASSED\n";
    return 0;
}
