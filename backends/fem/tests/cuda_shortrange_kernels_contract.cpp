/*
 * GPU CUDA short-range kernel optimizations contract test (Wave 3 Track 2).
 *
 * Verifies:
 * 1. Null-reduction gating for DMI (with deadlock-free predicated BlockReduce),
 *    uniaxial/cubic anisotropy, magnetoelastic, and Brown thermal kernels.
 * 2. Lazy zeroing transitions for FemGpuFieldBufferDeviceState::h_drive_zeroed
 *    (starting false after raw cudaMalloc, zeroing once on first zero-drive
 *    call, skipping subsequent memsets, and re-zeroing after drive_count>0->0).
 * 3. Exchange fast FP64 FMA graph-Laplacian (Compensated=false, RK) vs
 *    compensated DD (Compensated=true, relaxation): exact 0.0 on uniform m and
 *    <= 1e-13 relative parity on nonuniform textures, for legacy, xyz, and
 *    periodic-reduced exchange kernels.
 * 4. Single-launch fused XYZ H_eff accumulation bitwise parity (memcmp == 0)
 *    against the split 28-kernel sequence across all 10 interaction terms and
 *    partial subsets (base-only, explicit Oersted, scaled cylinder Oersted).
 * 5. Device-side packed AoS/SoA upload and download round-trip (bit-exact for
 *    N in {1, 3, 257, 1031}, rejecting raw_stream == nullptr, exact audit).
 * 6. Source contracts pinning RK vs relaxation exchange routing, nullptr
 *    intermediate reductions, deadlock-free DMI predication, and packed I/O.
 */

#include "context.hpp"
#include "gpu/cuda/exchange/exchange_kernels.hpp"
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#include "gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp"
#include "gpu/cuda/interactions/dmi/dmi_kernels.hpp"
#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp"
#include "gpu/cuda/interactions/oersted/oersted_kernels.hpp"
#include "gpu/cuda/interactions/thermal/thermal_kernels.hpp"
#include "gpu/cuda/interactions/zeeman/regional_field_kernels.cuh"
#include "gpu/cuda/state/device_memory.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/component_transfer.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

using namespace fullmag::fem;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void cuda_check(cudaError_t status, const char *context)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "CUDA FAIL (%s): %s\n", context, cudaGetErrorString(status));
        std::exit(1);
    }
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream in(path);
    check(in.good(), "unable to read contract source file");
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

template <typename T>
void upload_vec(T *dst, const std::vector<T> &src, const char *label)
{
    if (!src.empty()) {
        cuda_check(
            cudaMemcpy(dst, src.data(), src.size() * sizeof(T), cudaMemcpyHostToDevice),
            label);
    }
}

template <typename T>
std::vector<T> download_vec(const T *src, size_t count, const char *label)
{
    std::vector<T> out(count);
    if (count > 0) {
        cuda_check(
            cudaMemcpy(out.data(), src, count * sizeof(T), cudaMemcpyDeviceToHost),
            label);
    }
    return out;
}

bool vectors_bitwise_equal(const std::vector<double> &a, const std::vector<double> &b)
{
    return a.size() == b.size() &&
        (a.empty() || std::memcmp(a.data(), b.data(), a.size() * sizeof(double)) == 0);
}

double deterministic_value(size_t index, double scale, double phase)
{
    return scale * (std::sin(0.37 * static_cast<double>(index) + phase) +
                    0.45 * std::cos(1.13 * static_cast<double>(index) - 0.5 * phase));
}

double cpu_dmi_energy_reference(
    const std::vector<double> &nodes_xyz,
    const std::vector<uint32_t> &elements,
    const std::vector<uint8_t> &magnetic_element_mask,
    const std::vector<double> &mx,
    const std::vector<double> &my,
    const std::vector<double> &mz,
    const std::vector<double> &d_field,
    double uniform_d,
    double uniform_rotated_d,
    double nx,
    double ny,
    double nz,
    bool use_d_field,
    bool rotated_enabled,
    bool bulk_mode,
    int element_count)
{
    constexpr double kGeomEps = 1.0e-30;
    long double total_energy = 0.0L;
    for (int e = 0; e < element_count; ++e) {
        if (!magnetic_element_mask.empty() && magnetic_element_mask[static_cast<size_t>(e)] == 0u) {
            continue;
        }
        const size_t ebase = static_cast<size_t>(e) * 4u;
        const uint32_t nodes[4] = {
            elements[ebase + 0u],
            elements[ebase + 1u],
            elements[ebase + 2u],
            elements[ebase + 3u],
        };
        const double p0x = nodes_xyz[static_cast<size_t>(nodes[0]) * 3u + 0u];
        const double p0y = nodes_xyz[static_cast<size_t>(nodes[0]) * 3u + 1u];
        const double p0z = nodes_xyz[static_cast<size_t>(nodes[0]) * 3u + 2u];
        const double d1x = nodes_xyz[static_cast<size_t>(nodes[1]) * 3u + 0u] - p0x;
        const double d1y = nodes_xyz[static_cast<size_t>(nodes[1]) * 3u + 1u] - p0y;
        const double d1z = nodes_xyz[static_cast<size_t>(nodes[1]) * 3u + 2u] - p0z;
        const double d2x = nodes_xyz[static_cast<size_t>(nodes[2]) * 3u + 0u] - p0x;
        const double d2y = nodes_xyz[static_cast<size_t>(nodes[2]) * 3u + 1u] - p0y;
        const double d2z = nodes_xyz[static_cast<size_t>(nodes[2]) * 3u + 2u] - p0z;
        const double d3x = nodes_xyz[static_cast<size_t>(nodes[3]) * 3u + 0u] - p0x;
        const double d3y = nodes_xyz[static_cast<size_t>(nodes[3]) * 3u + 1u] - p0y;
        const double d3z = nodes_xyz[static_cast<size_t>(nodes[3]) * 3u + 2u] - p0z;

        const double c23x = d2y * d3z - d2z * d3y;
        const double c23y = d2z * d3x - d2x * d3z;
        const double c23z = d2x * d3y - d2y * d3x;
        const double det = d1x * c23x + d1y * c23y + d1z * c23z;
        if (!(std::fabs(det) > kGeomEps) || !std::isfinite(det)) {
            continue;
        }
        const double volume = std::fabs(det) / 6.0;
        const double inv_det = 1.0 / det;
        double grads[4][3]{};
        grads[1][0] =  (d2y * d3z - d2z * d3y) * inv_det;
        grads[1][1] = -(d2x * d3z - d2z * d3x) * inv_det;
        grads[1][2] =  (d2x * d3y - d2y * d3x) * inv_det;
        grads[2][0] = -(d1y * d3z - d1z * d3y) * inv_det;
        grads[2][1] =  (d1x * d3z - d1z * d3x) * inv_det;
        grads[2][2] = -(d1x * d3y - d1y * d3x) * inv_det;
        grads[3][0] =  (d1y * d2z - d1z * d2y) * inv_det;
        grads[3][1] = -(d1x * d2z - d1z * d2x) * inv_det;
        grads[3][2] =  (d1x * d2y - d1y * d2x) * inv_det;
        for (int dir = 0; dir < 3; ++dir) {
            grads[0][dir] = -(grads[1][dir] + grads[2][dir] + grads[3][dir]);
        }

        double elem_d = uniform_d;
        if (use_d_field && !d_field.empty()) {
            elem_d = 0.25 * (d_field[nodes[0]] + d_field[nodes[1]] +
                             d_field[nodes[2]] + d_field[nodes[3]]);
        }
        if (elem_d == 0.0 && (!rotated_enabled || uniform_rotated_d == 0.0)) {
            continue;
        }

        double grad_m[3][3]{};
        double m_q[3]{};
        for (int local = 0; local < 4; ++local) {
            const uint32_t node = nodes[local];
            const double m[3] = {mx[node], my[node], mz[node]};
            for (int comp = 0; comp < 3; ++comp) {
                m_q[comp] += 0.25 * m[comp];
                grad_m[comp][0] += m[comp] * grads[local][0];
                grad_m[comp][1] += m[comp] * grads[local][1];
                grad_m[comp][2] += m[comp] * grads[local][2];
            }
        }
        const double div_m = grad_m[0][0] + grad_m[1][1] + grad_m[2][2];
        const double curl_m[3] = {
            grad_m[2][1] - grad_m[1][2],
            grad_m[0][2] - grad_m[2][0],
            grad_m[1][0] - grad_m[0][1],
        };
        const double grad_m_dot_n[3] = {
            nx * grad_m[0][0] + ny * grad_m[1][0] + nz * grad_m[2][0],
            nx * grad_m[0][1] + ny * grad_m[1][1] + nz * grad_m[2][1],
            nx * grad_m[0][2] + ny * grad_m[1][2] + nz * grad_m[2][2],
        };
        const double m_dot_n = m_q[0] * nx + m_q[1] * ny + m_q[2] * nz;
        double energy = 0.0;
        if (bulk_mode) {
            energy = elem_d *
                (m_q[0] * curl_m[0] + m_q[1] * curl_m[1] + m_q[2] * curl_m[2]) *
                volume;
        } else {
            const double m_grad_mn =
                m_q[0] * grad_m_dot_n[0] +
                m_q[1] * grad_m_dot_n[1] +
                m_q[2] * grad_m_dot_n[2];
            energy = elem_d * (m_dot_n * div_m - m_grad_mn) * volume;
            if (rotated_enabled && uniform_rotated_d != 0.0) {
                energy += uniform_rotated_d *
                    (m_q[2] * grad_m[0][0] - m_q[0] * grad_m[2][0] +
                     m_q[0] * grad_m[1][1] - m_q[1] * grad_m[0][1]) * volume;
            }
        }
        total_energy += static_cast<long double>(energy);
    }
    return static_cast<double>(total_energy);
}

void test_null_reduction_outputs_match_field_bitwise(cudaStream_t stream)
{
    uint64_t bytes = 0;
    std::string error;

    // 1. DMI: 307 disjoint tetrahedra (non-256-divisible: exercises tail
    //    threads e >= element_count alongside air elements, degenerate tets,
    //    and elem_d == 0 elements inside the same 256-thread block to prove
    //    cub::BlockReduce never deadlocks). Disjoint per-tet nodes avoid
    //    concurrent atomicAdd scheduling nondeterminism for exact memcmp == 0.
    {
        const int elem_count = 307;
        const int node_count = elem_count * 4;
        std::vector<double> nodes_xyz(static_cast<size_t>(node_count) * 3u, 0.0);
        std::vector<uint32_t> elements(static_cast<size_t>(elem_count) * 4u, 0u);
        std::vector<uint8_t> elem_mask(static_cast<size_t>(elem_count), 1u);
        std::vector<uint8_t> node_mask(static_cast<size_t>(node_count), 1u);
        std::vector<double> mx(static_cast<size_t>(node_count));
        std::vector<double> my(static_cast<size_t>(node_count));
        std::vector<double> mz(static_cast<size_t>(node_count));
        std::vector<double> ms(static_cast<size_t>(node_count), 800.0e3);
        std::vector<double> d_field(static_cast<size_t>(node_count), 3.0e-3);
        std::vector<double> lumped_mass(static_cast<size_t>(node_count), 1.25e-24);

        for (int e = 0; e < elem_count; ++e) {
            const uint32_t n0 = static_cast<uint32_t>(4 * e + 0);
            const uint32_t n1 = static_cast<uint32_t>(4 * e + 1);
            const uint32_t n2 = static_cast<uint32_t>(4 * e + 2);
            const uint32_t n3 = static_cast<uint32_t>(4 * e + 3);
            elements[static_cast<size_t>(e) * 4u + 0u] = n0;
            elements[static_cast<size_t>(e) * 4u + 1u] = n1;
            elements[static_cast<size_t>(e) * 4u + 2u] = n2;
            elements[static_cast<size_t>(e) * 4u + 3u] = n3;

            const double ox = 10.0e-9 * static_cast<double>(e);
            const double h = 2.0e-9 + 0.1e-9 * static_cast<double>(e % 5);
            const bool is_air = (e % 11 == 0);
            const bool is_degenerate = (!is_air && e % 13 == 0);
            const bool is_zero_d = (!is_air && !is_degenerate && e % 17 == 0);
            if (is_air) {
                elem_mask[static_cast<size_t>(e)] = 0u;
                for (uint32_t k = 0; k < 4u; ++k) {
                    node_mask[n0 + k] = 0u;
                }
            }
            const double z3 = is_degenerate ? 0.0 : h;
            const std::array<std::array<double, 3>, 4> pts = {{
                {ox, 0.0, 0.0},
                {ox + h, 0.0, 0.0},
                {ox, h, 0.0},
                {ox, 0.0, z3},
            }};
            for (uint32_t k = 0; k < 4u; ++k) {
                const uint32_t idx = n0 + k;
                nodes_xyz[static_cast<size_t>(idx) * 3u + 0u] = pts[k][0];
                nodes_xyz[static_cast<size_t>(idx) * 3u + 1u] = pts[k][1];
                nodes_xyz[static_cast<size_t>(idx) * 3u + 2u] = pts[k][2];
                const double vx = deterministic_value(idx, 1.0, 0.1);
                const double vy = deterministic_value(idx, 1.0, 1.2);
                const double vz = deterministic_value(idx, 1.0, 2.3) + 0.5;
                const double inv_n = 1.0 / std::sqrt(vx * vx + vy * vy + vz * vz);
                mx[idx] = vx * inv_n;
                my[idx] = vy * inv_n;
                mz[idx] = vz * inv_n;
                d_field[idx] = is_zero_d ? 0.0 : (2.5e-3 + 0.2e-3 * static_cast<double>(k));
            }
        }

        double *d_nodes = nullptr;
        uint32_t *d_elems = nullptr;
        uint8_t *d_emask = nullptr;
        uint8_t *d_nmask = nullptr;
        double *d_ms = nullptr;
        double *d_dfield = nullptr;
        double *d_mass = nullptr;
        double *d_energy = nullptr;
        FemGpuComponentField d_m{}, d_res{}, d_h_ref{}, d_h_null{};
        check(gpu_device_allocate_double(d_nodes, nodes_xyz.size(), bytes, error), error.c_str());
        check(gpu_device_allocate_u32(d_elems, elements.size(), bytes, error), error.c_str());
        check(gpu_device_allocate_u8(d_emask, elem_mask.size(), bytes, error), error.c_str());
        check(gpu_device_allocate_u8(d_nmask, node_mask.size(), bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_ms, node_count, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_dfield, node_count, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_mass, node_count, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_energy, 1, bytes, error), error.c_str());
        check(gpu_device_allocate_component(d_m, node_count, bytes, error), error.c_str());
        check(gpu_device_allocate_component(d_res, node_count, bytes, error), error.c_str());
        check(gpu_device_allocate_component(d_h_ref, node_count, bytes, error), error.c_str());
        check(gpu_device_allocate_component(d_h_null, node_count, bytes, error), error.c_str());

        upload_vec(d_nodes, nodes_xyz, "dmi nodes");
        upload_vec(d_elems, elements, "dmi elements");
        upload_vec(d_emask, elem_mask, "dmi elem mask");
        upload_vec(d_nmask, node_mask, "dmi node mask");
        upload_vec(d_ms, ms, "dmi ms");
        upload_vec(d_dfield, d_field, "dmi d_field");
        upload_vec(d_mass, lumped_mass, "dmi mass");
        upload_vec(d_m.x, mx, "dmi mx");
        upload_vec(d_m.y, my, "dmi my");
        upload_vec(d_m.z, mz, "dmi mz");

        for (bool bulk_mode : {false, true}) {
            for (bool rotated : {false, true}) {
                if (bulk_mode && rotated) {
                    continue;
                }
                const double rot_d = rotated ? 0.7e-3 : 0.0;
                fullmag_cuda_dmi_field_energy(
                    d_nodes, d_elems, d_emask,
                    d_m.x, d_m.y, d_m.z, d_ms, d_dfield, d_mass, d_nmask,
                    d_res.x, d_res.y, d_res.z,
                    d_h_ref.x, d_h_ref.y, d_h_ref.z,
                    d_energy,
                    800.0e3, 3.0e-3, rot_d,
                    0.0, 0.0, 1.0,
                    true, rotated, bulk_mode,
                    elem_count, node_count, stream);
                cuda_check(cudaPeekAtLastError(), "dmi_field_energy with energy_out");
                fullmag_cuda_dmi_field_energy(
                    d_nodes, d_elems, d_emask,
                    d_m.x, d_m.y, d_m.z, d_ms, d_dfield, d_mass, d_nmask,
                    d_res.x, d_res.y, d_res.z,
                    d_h_null.x, d_h_null.y, d_h_null.z,
                    nullptr,
                    800.0e3, 3.0e-3, rot_d,
                    0.0, 0.0, 1.0,
                    true, rotated, bulk_mode,
                    elem_count, node_count, stream);
                cuda_check(cudaPeekAtLastError(), "dmi_field_energy with energy_out=nullptr");
                cuda_check(cudaStreamSynchronize(stream), "sync dmi_field_energy");

                const auto hx_ref = download_vec(d_h_ref.x, node_count, "dmi hx_ref");
                const auto hy_ref = download_vec(d_h_ref.y, node_count, "dmi hy_ref");
                const auto hz_ref = download_vec(d_h_ref.z, node_count, "dmi hz_ref");
                const auto hx_null = download_vec(d_h_null.x, node_count, "dmi hx_null");
                const auto hy_null = download_vec(d_h_null.y, node_count, "dmi hy_null");
                const auto hz_null = download_vec(d_h_null.z, node_count, "dmi hz_null");
                check(
                    vectors_bitwise_equal(hx_ref, hx_null) &&
                        vectors_bitwise_equal(hy_ref, hy_null) &&
                        vectors_bitwise_equal(hz_ref, hz_null),
                    "DMI field with energy_out=nullptr must match energy_out!=nullptr bit-for-bit");

                const double gpu_energy = download_vec(d_energy, 1, "dmi energy")[0];
                const double ref_energy = cpu_dmi_energy_reference(
                    nodes_xyz, elements, elem_mask, mx, my, mz, d_field,
                    3.0e-3, rot_d, 0.0, 0.0, 1.0,
                    true, rotated, bulk_mode, elem_count);
                const double scale = std::max(1.0e-30, std::fabs(ref_energy));
                check(
                    std::isfinite(gpu_energy) &&
                        std::fabs(gpu_energy - ref_energy) <= 1.0e-13 * scale,
                    "DMI BlockReduce energy must match CPU reference within 1e-13");
            }
        }

        gpu_device_free_double(d_nodes);
        gpu_device_free_u32(d_elems);
        gpu_device_free_u8(d_emask);
        gpu_device_free_u8(d_nmask);
        gpu_device_free_double(d_ms);
        gpu_device_free_double(d_dfield);
        gpu_device_free_double(d_mass);
        gpu_device_free_double(d_energy);
        gpu_device_free_component(d_m);
        gpu_device_free_component(d_res);
        gpu_device_free_component(d_h_ref);
        gpu_device_free_component(d_h_null);
    }

    // 2. Uniaxial anisotropy, cubic anisotropy, magnetoelastic, and thermal:
    //    compare block_sums / block_max_sigma == nullptr vs non-null bitwise.
    {
        const int n = 307;
        const int blocks = (n + 255) / 256;
        std::vector<double> mx(n), my(n), mz(n), ms(n), ku(n), ku2(n);
        std::vector<double> ax(n), ay(n), az(n), kc1(n), kc2(n), kc3(n);
        std::vector<double> alpha(n), mass(n), strain(static_cast<size_t>(n) * 6u);
        std::vector<uint8_t> mask(n, 1u);
        for (int i = 0; i < n; ++i) {
            mask[i] = (i % 19 == 0) ? 0u : 1u;
            const double vx = deterministic_value(i, 1.0, 0.3);
            const double vy = deterministic_value(i, 1.0, 1.7);
            const double vz = deterministic_value(i, 1.0, 2.9);
            const double inv = 1.0 / std::sqrt(vx * vx + vy * vy + vz * vz);
            mx[i] = vx * inv;
            my[i] = vy * inv;
            mz[i] = vz * inv;
            ms[i] = 800.0e3 * (0.8 + 0.05 * static_cast<double>(i % 7));
            ku[i] = 5.0e5 * (1.0 + 0.1 * static_cast<double>(i % 5));
            ku2[i] = 1.2e5 * (1.0 + 0.05 * static_cast<double>(i % 3));
            ax[i] = 0.2;
            ay[i] = 0.3;
            az[i] = std::sqrt(1.0 - 0.04 - 0.09);
            kc1[i] = 4.5e4;
            kc2[i] = -1.5e4;
            kc3[i] = 0.8e4;
            alpha[i] = 0.02 + 0.005 * static_cast<double>(i % 4);
            mass[i] = 2.0e-24 * (1.0 + 0.1 * static_cast<double>(i % 6));
            for (int c = 0; c < 6; ++c) {
                strain[static_cast<size_t>(i) * 6u + static_cast<size_t>(c)] =
                    deterministic_value(static_cast<size_t>(i) * 6u + static_cast<size_t>(c), 1.0e-3, 0.5);
            }
        }

        FemGpuComponentField d_m{}, d_h_ref{}, d_h_null{};
        double *d_ms = nullptr, *d_ku = nullptr, *d_ku2 = nullptr;
        double *d_ax = nullptr, *d_ay = nullptr, *d_az = nullptr;
        double *d_kc1 = nullptr, *d_kc2 = nullptr, *d_kc3 = nullptr;
        double *d_alpha = nullptr, *d_mass = nullptr, *d_strain = nullptr;
        double *d_blocks = nullptr;
        uint8_t *d_mask = nullptr;
        check(gpu_device_allocate_component(d_m, n, bytes, error), error.c_str());
        check(gpu_device_allocate_component(d_h_ref, n, bytes, error), error.c_str());
        check(gpu_device_allocate_component(d_h_null, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_ms, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_ku, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_ku2, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_ax, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_ay, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_az, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_kc1, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_kc2, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_kc3, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_alpha, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_mass, n, bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_strain, strain.size(), bytes, error), error.c_str());
        check(gpu_device_allocate_double(d_blocks, blocks, bytes, error), error.c_str());
        check(gpu_device_allocate_u8(d_mask, n, bytes, error), error.c_str());

        upload_vec(d_m.x, mx, "local mx");
        upload_vec(d_m.y, my, "local my");
        upload_vec(d_m.z, mz, "local mz");
        upload_vec(d_ms, ms, "local ms");
        upload_vec(d_ku, ku, "local ku");
        upload_vec(d_ku2, ku2, "local ku2");
        upload_vec(d_ax, ax, "local ax");
        upload_vec(d_ay, ay, "local ay");
        upload_vec(d_az, az, "local az");
        upload_vec(d_kc1, kc1, "local kc1");
        upload_vec(d_kc2, kc2, "local kc2");
        upload_vec(d_kc3, kc3, "local kc3");
        upload_vec(d_alpha, alpha, "local alpha");
        upload_vec(d_mass, mass, "local mass");
        upload_vec(d_strain, strain, "local strain");
        upload_vec(d_mask, mask, "local mask");

        auto check_fields_match = [&](const char *label) {
            cuda_check(cudaStreamSynchronize(stream), label);
            const auto rx = download_vec(d_h_ref.x, n, label);
            const auto ry = download_vec(d_h_ref.y, n, label);
            const auto rz = download_vec(d_h_ref.z, n, label);
            const auto nx = download_vec(d_h_null.x, n, label);
            const auto ny = download_vec(d_h_null.y, n, label);
            const auto nz = download_vec(d_h_null.z, n, label);
            check(
                vectors_bitwise_equal(rx, nx) &&
                    vectors_bitwise_equal(ry, ny) &&
                    vectors_bitwise_equal(rz, nz),
                label);
        };

        // Uniaxial anisotropy
        fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
            d_m.x, d_m.y, d_m.z, d_ms, d_ku, d_ku2, d_ax, d_ay, d_az, d_mass, d_mask,
            d_h_ref.x, d_h_ref.y, d_h_ref.z, d_blocks,
            5.0e5, 1.2e5, 0.0, 0.0, 1.0, true, true, true, n, stream);
        fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(
            d_m.x, d_m.y, d_m.z, d_ms, d_ku, d_ku2, d_ax, d_ay, d_az, d_mass, d_mask,
            d_h_null.x, d_h_null.y, d_h_null.z, nullptr,
            5.0e5, 1.2e5, 0.0, 0.0, 1.0, true, true, true, n, stream);
        cuda_check(cudaPeekAtLastError(), "uniaxial anisotropy null reduction");
        check_fields_match("uniaxial anisotropy nullptr block_sums bitwise parity");

        // Cubic anisotropy
        fullmag_cuda_cubic_anisotropy_field_energy_blocks(
            d_m.x, d_m.y, d_m.z, d_ms, d_kc1, d_kc2, d_kc3, d_mass, d_mask,
            d_h_ref.x, d_h_ref.y, d_h_ref.z, d_blocks,
            4.5e4, -1.5e4, 0.8e4, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, true, true, true, n, stream);
        fullmag_cuda_cubic_anisotropy_field_energy_blocks(
            d_m.x, d_m.y, d_m.z, d_ms, d_kc1, d_kc2, d_kc3, d_mass, d_mask,
            d_h_null.x, d_h_null.y, d_h_null.z, nullptr,
            4.5e4, -1.5e4, 0.8e4, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, true, true, true, n, stream);
        cuda_check(cudaPeekAtLastError(), "cubic anisotropy null reduction");
        check_fields_match("cubic anisotropy nullptr block_sums bitwise parity");

        // Magnetoelastic (uniform and per-node strain)
        for (bool per_node : {false, true}) {
            fullmag_cuda_magnetoelastic_field_energy_blocks(
                d_m.x, d_m.y, d_m.z, d_ms, d_mass, d_mask, per_node ? d_strain : nullptr,
                d_h_ref.x, d_h_ref.y, d_h_ref.z, d_blocks,
                -3.0e6, 6.0e6, 1e-3, -0.5e-3, 0.2e-3, 0.3e-3, -0.1e-3, 0.4e-3,
                per_node, n, stream);
            fullmag_cuda_magnetoelastic_field_energy_blocks(
                d_m.x, d_m.y, d_m.z, d_ms, d_mass, d_mask, per_node ? d_strain : nullptr,
                d_h_null.x, d_h_null.y, d_h_null.z, nullptr,
                -3.0e6, 6.0e6, 1e-3, -0.5e-3, 0.2e-3, 0.3e-3, -0.1e-3, 0.4e-3,
                per_node, n, stream);
            cuda_check(cudaPeekAtLastError(), "magnetoelastic null reduction");
            check_fields_match("magnetoelastic nullptr block_sums bitwise parity");
        }

        // Brown thermal field
        fullmag_cuda_thermal_field_blocks(
            d_ms, d_alpha, d_mass, d_mask,
            d_h_ref.x, d_h_ref.y, d_h_ref.z, d_blocks,
            2.211e5, 0.05, 300.0, 1.0e-13, 0x123456789abcdef0ull, 7ull, true, n, stream);
        fullmag_cuda_thermal_field_blocks(
            d_ms, d_alpha, d_mass, d_mask,
            d_h_null.x, d_h_null.y, d_h_null.z, nullptr,
            2.211e5, 0.05, 300.0, 1.0e-13, 0x123456789abcdef0ull, 7ull, true, n, stream);
        cuda_check(cudaPeekAtLastError(), "thermal null reduction");
        check_fields_match("thermal nullptr block_max_sigma bitwise parity");

        gpu_device_free_component(d_m);
        gpu_device_free_component(d_h_ref);
        gpu_device_free_component(d_h_null);
        gpu_device_free_double(d_ms);
        gpu_device_free_double(d_ku);
        gpu_device_free_double(d_ku2);
        gpu_device_free_double(d_ax);
        gpu_device_free_double(d_ay);
        gpu_device_free_double(d_az);
        gpu_device_free_double(d_kc1);
        gpu_device_free_double(d_kc2);
        gpu_device_free_double(d_kc3);
        gpu_device_free_double(d_alpha);
        gpu_device_free_double(d_mass);
        gpu_device_free_double(d_strain);
        gpu_device_free_double(d_blocks);
        gpu_device_free_u8(d_mask);
    }
}

void test_regional_drive_lazy_zero_transition(cudaStream_t stream)
{
    const uint64_t node_count = 64;
    std::vector<double> initial_m(static_cast<size_t>(node_count) * 3u, 0.0);
    for (uint64_t i = 0; i < node_count; ++i) {
        initial_m[static_cast<size_t>(3u * i + 2u)] = 1.0;
    }

    Context ctx{};
    TransferAudit audit{};
    std::string error;
    check(
        gpu_state_initialize(
            ctx.gpu_state.device,
            node_count,
            FULLMAG_FEM_INTEGRATOR_RK4,
            true,
            false,
            initial_m.data(),
            initial_m.size(),
            audit,
            error),
        error.c_str());
    ctx.gpu_state.cuda.compute_stream = reinterpret_cast<void *>(stream);

    auto &fields = ctx.gpu_state.device.fields;
    check(
        !fields.h_drive_zeroed,
        "freshly allocated FemGpuFieldBufferDeviceState must start with h_drive_zeroed == false");

    // Seed h_drive with a non-zero sentinel representing uninitialized cudaMalloc VRAM.
    const std::vector<double> sentinel(static_cast<size_t>(node_count), 1234.5);
    upload_vec(fields.h_drive.x, sentinel, "sentinel h_drive.x");
    upload_vec(fields.h_drive.y, sentinel, "sentinel h_drive.y");
    upload_vec(fields.h_drive.z, sentinel, "sentinel h_drive.z");

    check(
        gpu_regional_field_drive_materialize_and_accumulate(
            ctx, stream, static_cast<int>(node_count), 0.0, false, error),
        error.c_str());
    cuda_check(cudaStreamSynchronize(stream), "first lazy h_drive zero");
    check(fields.h_drive_zeroed, "first zero-drive call must mark h_drive_zeroed == true");
    for (double *comp : {fields.h_drive.x, fields.h_drive.y, fields.h_drive.z}) {
        const auto host = download_vec(comp, node_count, "verify zeroed h_drive");
        for (double v : host) {
            check(v == 0.0, "first zero-drive call must zero every element of h_drive");
        }
    }

    // Prove the second call skips cudaMemsetAsync when h_drive_zeroed == true.
    const double marker = 77.25;
    cuda_check(
        cudaMemcpy(fields.h_drive.x, &marker, sizeof(double), cudaMemcpyHostToDevice),
        "write lazy-skip probe");
    check(
        gpu_regional_field_drive_materialize_and_accumulate(
            ctx, stream, static_cast<int>(node_count), 1.0e-12, false, error),
        error.c_str());
    cuda_check(cudaStreamSynchronize(stream), "second lazy h_drive call");
    check(
        download_vec(fields.h_drive.x, 1, "read lazy-skip probe")[0] == marker,
        "second zero-drive call must skip redundant cudaMemsetAsync while h_drive_zeroed == true");

    // Transition drive_count: 0 -> 1 -> 0.
    RegionalFieldDriveRuntime drive{};
    drive.waveform.kind = FULLMAG_FEM_TIME_CONSTANT;
    drive.time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;
    drive.basis_h_xyz.resize(static_cast<size_t>(node_count) * 3u);
    for (uint64_t i = 0; i < node_count; ++i) {
        drive.basis_h_xyz[static_cast<size_t>(3u * i + 0u)] = 5.0;
        drive.basis_h_xyz[static_cast<size_t>(3u * i + 1u)] = -3.0;
        drive.basis_h_xyz[static_cast<size_t>(3u * i + 2u)] = 2.0;
    }
    ctx.zeeman.regional_drives.push_back(drive);
    check(gpu_regional_field_drive_upload(ctx, error), error.c_str());
    check(
        fields.regional_drive_count == 1 && !fields.h_drive_zeroed,
        "active regional drive must clear h_drive_zeroed");
    check(
        download_vec(fields.h_drive.x, 1, "active drive x")[0] == 5.0 &&
            download_vec(fields.h_drive.y, 1, "active drive y")[0] == -3.0 &&
            download_vec(fields.h_drive.z, 1, "active drive z")[0] == 2.0,
        "active regional drive must materialize basis into h_drive");

    ctx.zeeman.regional_drives.clear();
    check(gpu_regional_field_drive_upload(ctx, error), error.c_str());
    check(
        fields.regional_drive_count == 0 && fields.h_drive_zeroed,
        "clearing regional drives via upload must zero h_drive and set h_drive_zeroed == true");
    for (double *comp : {fields.h_drive.x, fields.h_drive.y, fields.h_drive.z}) {
        const auto host = download_vec(comp, node_count, "verify cleared h_drive");
        for (double v : host) {
            check(v == 0.0, "cleared drive h_drive must be zero");
        }
    }

    gpu_regional_field_drive_destroy(fields);
    check(!fields.h_drive_zeroed, "gpu_regional_field_drive_destroy must reset h_drive_zeroed == false");

    ctx.gpu_state.cuda.compute_stream = nullptr;
    gpu_state_destroy(ctx.gpu_state.device);
}

void test_exchange_fast_vs_compensated_parity(cudaStream_t stream)
{
    // Build a 6x6x6 = 216-node 3D graph-Laplacian CSR with heterogeneous edge
    // weights and one nonmagnetic node (node 0).
    const int nx = 6, ny = 6, nz = 6;
    const int rows = nx * ny * nz;
    std::vector<uint32_t> row_offsets(static_cast<size_t>(rows) + 1u, 0u);
    std::vector<uint32_t> col_indices;
    std::vector<double> values;

    auto node_id = [&](int x, int y, int z) -> uint32_t {
        return static_cast<uint32_t>((z * ny + y) * nx + x);
    };
    for (int z = 0; z < nz; ++z) {
        for (int y = 0; y < ny; ++y) {
            for (int x = 0; x < nx; ++x) {
                const uint32_t r = node_id(x, y, z);
                std::vector<std::pair<uint32_t, double>> entries;
                double diag = 0.0;
                const int dirs[6][3] = {
                    {-1, 0, 0}, {1, 0, 0}, {0, -1, 0}, {0, 1, 0}, {0, 0, -1}, {0, 0, 1},
                };
                for (const auto &d : dirs) {
                    const int xx = x + d[0];
                    const int yy = y + d[1];
                    const int zz = z + d[2];
                    if (xx < 0 || xx >= nx || yy < 0 || yy >= ny || zz < 0 || zz >= nz) {
                        continue;
                    }
                    const uint32_t c = node_id(xx, yy, zz);
                    const uint32_t lo = std::min(r, c);
                    const uint32_t hi = std::max(r, c);
                    const double w = -13.0e-12 * 3.0e-9 *
                        (1.0 + 0.07 * static_cast<double>((lo * 13u + hi * 7u) % 11u));
                    entries.emplace_back(c, w);
                    diag -= w;
                }
                entries.emplace_back(r, diag);
                std::sort(entries.begin(), entries.end());
                row_offsets[r] = static_cast<uint32_t>(col_indices.size());
                for (const auto &kv : entries) {
                    col_indices.push_back(kv.first);
                    values.push_back(kv.second);
                }
            }
        }
    }
    row_offsets[static_cast<size_t>(rows)] = static_cast<uint32_t>(col_indices.size());

    std::vector<double> ms(rows, 800.0e3);
    std::vector<double> mass(rows, 2.7e-26);
    std::vector<double> inv_mass(rows, 1.0 / 2.7e-26);
    std::vector<uint8_t> mask(rows, 1u);
    mask[0] = 0u;

    std::vector<double> mx_unif(rows, 0.6), my_unif(rows, 0.8), mz_unif(rows, 0.0);
    std::vector<double> mx_vortex(rows), my_vortex(rows), mz_vortex(rows);
    for (int z = 0; z < nz; ++z) {
        for (int y = 0; y < ny; ++y) {
            for (int x = 0; x < nx; ++x) {
                const uint32_t r = node_id(x, y, z);
                const double rx = static_cast<double>(x) - 2.5;
                const double ry = static_cast<double>(y) - 2.5;
                const double rz = static_cast<double>(z) - 2.5;
                const double vx = -ry + 0.15 * rz;
                const double vy = rx - 0.1 * rz;
                const double vz = 0.8 * std::exp(-0.25 * (rx * rx + ry * ry));
                const double inv = 1.0 / std::sqrt(vx * vx + vy * vy + vz * vz);
                mx_vortex[r] = vx * inv;
                my_vortex[r] = vy * inv;
                mz_vortex[r] = vz * inv;
            }
        }
    }

    // Trivial 1-to-1 periodic-reduced map exercising periodic_reduced_exchange_kernel<Compensated>.
    std::vector<uint32_t> identity_map(rows);
    for (int i = 0; i < rows; ++i) {
        identity_map[i] = static_cast<uint32_t>(i);
    }
    // Off-diagonal only reduced CSR for periodic_reduced_exchange_kernel.
    std::vector<uint32_t> red_row_offsets(static_cast<size_t>(rows) + 1u, 0u);
    std::vector<uint32_t> red_col_indices;
    std::vector<double> red_values;
    for (int r = 0; r < rows; ++r) {
        red_row_offsets[r] = static_cast<uint32_t>(red_col_indices.size());
        for (uint32_t p = row_offsets[r]; p < row_offsets[r + 1]; ++p) {
            if (col_indices[p] != static_cast<uint32_t>(r)) {
                red_col_indices.push_back(col_indices[p]);
                red_values.push_back(values[p]);
            }
        }
    }
    red_row_offsets[static_cast<size_t>(rows)] = static_cast<uint32_t>(red_col_indices.size());

    uint64_t bytes = 0;
    std::string error;
    uint32_t *d_row_offsets = nullptr, *d_col_indices = nullptr;
    uint32_t *d_red_offsets = nullptr, *d_red_cols = nullptr, *d_id_map = nullptr;
    double *d_values = nullptr, *d_red_values = nullptr;
    double *d_ms = nullptr, *d_mass = nullptr, *d_inv_mass = nullptr, *d_row_scale = nullptr;
    uint8_t *d_mask = nullptr;
    FemGpuComponentField d_m{}, d_h_dd{}, d_h_fast{}, d_red_h{};

    check(gpu_device_allocate_u32(d_row_offsets, row_offsets.size(), bytes, error), error.c_str());
    check(gpu_device_allocate_u32(d_col_indices, col_indices.size(), bytes, error), error.c_str());
    check(gpu_device_allocate_u32(d_red_offsets, red_row_offsets.size(), bytes, error), error.c_str());
    check(gpu_device_allocate_u32(d_red_cols, red_col_indices.size(), bytes, error), error.c_str());
    check(gpu_device_allocate_u32(d_id_map, identity_map.size(), bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_values, values.size(), bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_red_values, red_values.size(), bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_ms, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_mass, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_inv_mass, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_double(d_row_scale, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_u8(d_mask, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_component(d_m, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_component(d_h_dd, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_component(d_h_fast, rows, bytes, error), error.c_str());
    check(gpu_device_allocate_component(d_red_h, rows, bytes, error), error.c_str());

    upload_vec(d_row_offsets, row_offsets, "ex row_offsets");
    upload_vec(d_col_indices, col_indices, "ex col_indices");
    upload_vec(d_red_offsets, red_row_offsets, "ex red_offsets");
    upload_vec(d_red_cols, red_col_indices, "ex red_cols");
    upload_vec(d_id_map, identity_map, "ex id_map");
    upload_vec(d_values, values, "ex values");
    upload_vec(d_red_values, red_values, "ex red_values");
    upload_vec(d_ms, ms, "ex ms");
    upload_vec(d_mass, mass, "ex mass");
    upload_vec(d_inv_mass, inv_mass, "ex inv_mass");
    upload_vec(d_mask, mask, "ex mask");
    fullmag_cuda_prepare_exchange_row_scale(d_ms, d_row_scale, rows, stream);

    // 1. Uniform magnetization -> exact 0.0 on every node for Compensated=false.
    upload_vec(d_m.x, mx_unif, "ex unif mx");
    upload_vec(d_m.y, my_unif, "ex unif my");
    upload_vec(d_m.z, mz_unif, "ex unif mz");
    fullmag_cuda_legacy_sparse_exchange_xyz(
        d_row_offsets, d_col_indices, d_values,
        d_m.x, d_m.y, d_m.z, d_row_scale, d_inv_mass, d_mask,
        d_h_fast.x, d_h_fast.y, d_h_fast.z, rows, stream, false);
    cuda_check(cudaStreamSynchronize(stream), "sync uniform fast exchange xyz");
    for (double *comp : {d_h_fast.x, d_h_fast.y, d_h_fast.z}) {
        for (double v : download_vec(comp, rows, "uniform fast xyz")) {
            check(v == 0.0, "uniform m must produce exact 0.0 in fast FP64 FMA exchange_xyz");
        }
    }
    fullmag_cuda_legacy_sparse_exchange(
        d_row_offsets, d_col_indices, d_values,
        d_m.x, d_ms, d_inv_mass, d_mask, d_h_fast.x, rows, stream, false);
    cuda_check(cudaStreamSynchronize(stream), "sync uniform fast exchange scalar");
    for (double v : download_vec(d_h_fast.x, rows, "uniform fast scalar")) {
        check(v == 0.0, "uniform m must produce exact 0.0 in fast FP64 FMA scalar exchange");
    }
    fullmag_cuda_periodic_reduced_exchange_xyz(
        d_red_offsets, d_red_cols, d_red_values, d_mass,
        d_m.x, d_m.y, d_m.z, d_ms, d_id_map, d_id_map, d_mask,
        d_red_h.x, d_red_h.y, d_red_h.z,
        d_h_fast.x, d_h_fast.y, d_h_fast.z, rows, rows, stream, false);
    cuda_check(cudaStreamSynchronize(stream), "sync uniform fast periodic exchange");
    for (double *comp : {d_h_fast.x, d_h_fast.y, d_h_fast.z}) {
        for (double v : download_vec(comp, rows, "uniform fast periodic")) {
            check(v == 0.0, "uniform m must produce exact 0.0 in fast FP64 FMA periodic exchange");
        }
    }

    // 2. Nonuniform vortex texture -> <= 1e-13 relative parity vs DD.
    upload_vec(d_m.x, mx_vortex, "ex vortex mx");
    upload_vec(d_m.y, my_vortex, "ex vortex my");
    upload_vec(d_m.z, mz_vortex, "ex vortex mz");

    auto check_parity = [&](const char *label) {
        cuda_check(cudaStreamSynchronize(stream), label);
        double max_abs_diff = 0.0;
        double max_dd_inf = 1.0;
        const std::array<double *, 3> dd_ptrs = {d_h_dd.x, d_h_dd.y, d_h_dd.z};
        const std::array<double *, 3> fast_ptrs = {d_h_fast.x, d_h_fast.y, d_h_fast.z};
        for (int c = 0; c < 3; ++c) {
            const auto h_dd = download_vec(dd_ptrs[c], rows, label);
            const auto h_fast = download_vec(fast_ptrs[c], rows, label);
            check(h_dd[0] == 0.0 && h_fast[0] == 0.0, "nonmagnetic node must remain exact 0.0");
            for (int i = 0; i < rows; ++i) {
                max_dd_inf = std::max(max_dd_inf, std::fabs(h_dd[i]));
                max_abs_diff = std::max(max_abs_diff, std::fabs(h_fast[i] - h_dd[i]));
            }
        }
        check(
            max_abs_diff <= 1.0e-13 * max_dd_inf,
            label);
    };

    fullmag_cuda_legacy_sparse_exchange_xyz(
        d_row_offsets, d_col_indices, d_values,
        d_m.x, d_m.y, d_m.z, d_row_scale, d_inv_mass, d_mask,
        d_h_dd.x, d_h_dd.y, d_h_dd.z, rows, stream, true);
    fullmag_cuda_legacy_sparse_exchange_xyz(
        d_row_offsets, d_col_indices, d_values,
        d_m.x, d_m.y, d_m.z, d_row_scale, d_inv_mass, d_mask,
        d_h_fast.x, d_h_fast.y, d_h_fast.z, rows, stream, false);
    check_parity("legacy_sparse_exchange_xyz fast vs DD parity <= 1e-13");

    fullmag_cuda_legacy_sparse_exchange(
        d_row_offsets, d_col_indices, d_values, d_m.x, d_ms, d_inv_mass, d_mask, d_h_dd.x, rows, stream, true);
    fullmag_cuda_legacy_sparse_exchange(
        d_row_offsets, d_col_indices, d_values, d_m.y, d_ms, d_inv_mass, d_mask, d_h_dd.y, rows, stream, true);
    fullmag_cuda_legacy_sparse_exchange(
        d_row_offsets, d_col_indices, d_values, d_m.z, d_ms, d_inv_mass, d_mask, d_h_dd.z, rows, stream, true);
    fullmag_cuda_legacy_sparse_exchange(
        d_row_offsets, d_col_indices, d_values, d_m.x, d_ms, d_inv_mass, d_mask, d_h_fast.x, rows, stream, false);
    fullmag_cuda_legacy_sparse_exchange(
        d_row_offsets, d_col_indices, d_values, d_m.y, d_ms, d_inv_mass, d_mask, d_h_fast.y, rows, stream, false);
    fullmag_cuda_legacy_sparse_exchange(
        d_row_offsets, d_col_indices, d_values, d_m.z, d_ms, d_inv_mass, d_mask, d_h_fast.z, rows, stream, false);
    check_parity("legacy_sparse_exchange scalar fast vs DD parity <= 1e-13");

    fullmag_cuda_periodic_reduced_exchange_xyz(
        d_red_offsets, d_red_cols, d_red_values, d_mass,
        d_m.x, d_m.y, d_m.z, d_ms, d_id_map, d_id_map, d_mask,
        d_red_h.x, d_red_h.y, d_red_h.z,
        d_h_dd.x, d_h_dd.y, d_h_dd.z, rows, rows, stream, true);
    fullmag_cuda_periodic_reduced_exchange_xyz(
        d_red_offsets, d_red_cols, d_red_values, d_mass,
        d_m.x, d_m.y, d_m.z, d_ms, d_id_map, d_id_map, d_mask,
        d_red_h.x, d_red_h.y, d_red_h.z,
        d_h_fast.x, d_h_fast.y, d_h_fast.z, rows, rows, stream, false);
    check_parity("periodic_reduced_exchange_xyz fast vs DD parity <= 1e-13");

    gpu_device_free_u32(d_row_offsets);
    gpu_device_free_u32(d_col_indices);
    gpu_device_free_u32(d_red_offsets);
    gpu_device_free_u32(d_red_cols);
    gpu_device_free_u32(d_id_map);
    gpu_device_free_double(d_values);
    gpu_device_free_double(d_red_values);
    gpu_device_free_double(d_ms);
    gpu_device_free_double(d_mass);
    gpu_device_free_double(d_inv_mass);
    gpu_device_free_double(d_row_scale);
    gpu_device_free_u8(d_mask);
    gpu_device_free_component(d_m);
    gpu_device_free_component(d_h_dd);
    gpu_device_free_component(d_h_fast);
    gpu_device_free_component(d_red_h);
}

void test_fused_heff_bitwise_parity_all_terms(cudaStream_t stream)
{
    const int n = 1031;
    uint64_t bytes = 0;
    std::string error;

    enum TermIndex {
        kEx = 0, kDemag, kExt, kDrive, kAni, kCubic, kDmi, kBulkDmi, kOeBasis, kMel, kTherm, kCount
    };
    std::array<FemGpuComponentField, kCount> d_terms{};
    FemGpuComponentField d_oe_ref{}, d_oe_fused{}, d_eff_ref{}, d_eff_fused{};
    for (int t = 0; t < kCount; ++t) {
        check(gpu_device_allocate_component(d_terms[t], n, bytes, error), error.c_str());
        std::vector<double> vx(n), vy(n), vz(n);
        for (int i = 0; i < n; ++i) {
            const double scale = 1.0e5 * (1.0 + 0.17 * static_cast<double>(t));
            vx[i] = deterministic_value(static_cast<size_t>(i), scale, 0.2 * static_cast<double>(t));
            vy[i] = deterministic_value(static_cast<size_t>(i), scale, 0.9 + 0.3 * static_cast<double>(t));
            vz[i] = deterministic_value(static_cast<size_t>(i), scale, 1.8 + 0.4 * static_cast<double>(t));
        }
        upload_vec(d_terms[t].x, vx, "heff term x");
        upload_vec(d_terms[t].y, vy, "heff term y");
        upload_vec(d_terms[t].z, vz, "heff term z");
    }
    check(gpu_device_allocate_component(d_oe_ref, n, bytes, error), error.c_str());
    check(gpu_device_allocate_component(d_oe_fused, n, bytes, error), error.c_str());
    check(gpu_device_allocate_component(d_eff_ref, n, bytes, error), error.c_str());
    check(gpu_device_allocate_component(d_eff_fused, n, bytes, error), error.c_str());

    auto assert_component_bitwise = [&](const FemGpuComponentField &a, const FemGpuComponentField &b, const char *msg) {
        const auto ax = download_vec(a.x, n, msg);
        const auto ay = download_vec(a.y, n, msg);
        const auto az = download_vec(a.z, n, msg);
        const auto bx = download_vec(b.x, n, msg);
        const auto by = download_vec(b.y, n, msg);
        const auto bz = download_vec(b.z, n, msg);
        check(
            vectors_bitwise_equal(ax, bx) &&
                vectors_bitwise_equal(ay, by) &&
                vectors_bitwise_equal(az, bz),
            msg);
    };

    // Case A: All 10 terms + scaled cylinder Oersted (scale = 2.75).
    const double oe_scale = 2.75;
    fullmag_cuda_accumulate_heff(d_terms[kEx].x, d_terms[kDemag].x, d_terms[kExt].x, d_eff_ref.x, n, true, stream);
    fullmag_cuda_accumulate_heff(d_terms[kEx].y, d_terms[kDemag].y, d_terms[kExt].y, d_eff_ref.y, n, true, stream);
    fullmag_cuda_accumulate_heff(d_terms[kEx].z, d_terms[kDemag].z, d_terms[kExt].z, d_eff_ref.z, n, true, stream);
    for (int t : {kDrive, kAni, kCubic, kDmi, kBulkDmi}) {
        fullmag_cuda_add_field_inplace(d_terms[t].x, d_eff_ref.x, n, stream);
        fullmag_cuda_add_field_inplace(d_terms[t].y, d_eff_ref.y, n, stream);
        fullmag_cuda_add_field_inplace(d_terms[t].z, d_eff_ref.z, n, stream);
    }
    fullmag_cuda_scale_field(d_terms[kOeBasis].x, d_oe_ref.x, oe_scale, n, stream);
    fullmag_cuda_scale_field(d_terms[kOeBasis].y, d_oe_ref.y, oe_scale, n, stream);
    fullmag_cuda_scale_field(d_terms[kOeBasis].z, d_oe_ref.z, oe_scale, n, stream);
    fullmag_cuda_add_scaled_field_inplace(d_oe_ref.x, d_eff_ref.x, 1.0, n, stream);
    fullmag_cuda_add_scaled_field_inplace(d_oe_ref.y, d_eff_ref.y, 1.0, n, stream);
    fullmag_cuda_add_scaled_field_inplace(d_oe_ref.z, d_eff_ref.z, 1.0, n, stream);
    for (int t : {kMel, kTherm}) {
        fullmag_cuda_add_field_inplace(d_terms[t].x, d_eff_ref.x, n, stream);
        fullmag_cuda_add_field_inplace(d_terms[t].y, d_eff_ref.y, n, stream);
        fullmag_cuda_add_field_inplace(d_terms[t].z, d_eff_ref.z, n, stream);
    }

    FemGpuHeffAccumulateTerms fused_all{};
    fused_all.h_ex_x = d_terms[kEx].x;
    fused_all.h_ex_y = d_terms[kEx].y;
    fused_all.h_ex_z = d_terms[kEx].z;
    fused_all.h_demag_x = d_terms[kDemag].x;
    fused_all.h_demag_y = d_terms[kDemag].y;
    fused_all.h_demag_z = d_terms[kDemag].z;
    fused_all.h_ext_x = d_terms[kExt].x;
    fused_all.h_ext_y = d_terms[kExt].y;
    fused_all.h_ext_z = d_terms[kExt].z;
    fused_all.h_drive_x = d_terms[kDrive].x;
    fused_all.h_drive_y = d_terms[kDrive].y;
    fused_all.h_drive_z = d_terms[kDrive].z;
    fused_all.h_ani_x = d_terms[kAni].x;
    fused_all.h_ani_y = d_terms[kAni].y;
    fused_all.h_ani_z = d_terms[kAni].z;
    fused_all.h_cubic_x = d_terms[kCubic].x;
    fused_all.h_cubic_y = d_terms[kCubic].y;
    fused_all.h_cubic_z = d_terms[kCubic].z;
    fused_all.h_dmi_x = d_terms[kDmi].x;
    fused_all.h_dmi_y = d_terms[kDmi].y;
    fused_all.h_dmi_z = d_terms[kDmi].z;
    fused_all.h_bulk_dmi_x = d_terms[kBulkDmi].x;
    fused_all.h_bulk_dmi_y = d_terms[kBulkDmi].y;
    fused_all.h_bulk_dmi_z = d_terms[kBulkDmi].z;
    fused_all.h_oe_src_x = d_terms[kOeBasis].x;
    fused_all.h_oe_src_y = d_terms[kOeBasis].y;
    fused_all.h_oe_src_z = d_terms[kOeBasis].z;
    fused_all.h_oe_out_x = d_oe_fused.x;
    fused_all.h_oe_out_y = d_oe_fused.y;
    fused_all.h_oe_out_z = d_oe_fused.z;
    fused_all.h_oe_scale = oe_scale;
    fused_all.h_mel_x = d_terms[kMel].x;
    fused_all.h_mel_y = d_terms[kMel].y;
    fused_all.h_mel_z = d_terms[kMel].z;
    fused_all.h_therm_x = d_terms[kTherm].x;
    fused_all.h_therm_y = d_terms[kTherm].y;
    fused_all.h_therm_z = d_terms[kTherm].z;
    fused_all.active_mask =
        FEM_GPU_HEFF_TERM_EXT | FEM_GPU_HEFF_TERM_DRIVE |
        FEM_GPU_HEFF_TERM_ANI | FEM_GPU_HEFF_TERM_CUBIC |
        FEM_GPU_HEFF_TERM_DMI | FEM_GPU_HEFF_TERM_BULK_DMI |
        FEM_GPU_HEFF_TERM_OE_SCALED | FEM_GPU_HEFF_TERM_MEL |
        FEM_GPU_HEFF_TERM_THERM;

    fullmag_cuda_accumulate_heff_fused_xyz(
        fused_all, d_eff_fused.x, d_eff_fused.y, d_eff_fused.z, n, stream);
    cuda_check(cudaStreamSynchronize(stream), "sync fused heff all terms");
    assert_component_bitwise(d_eff_ref, d_eff_fused, "fused H_eff all terms must match split path bit-for-bit");
    assert_component_bitwise(d_oe_ref, d_oe_fused, "fused scaled H_oe output must match scale_field bit-for-bit");

    // Case B: Minimal base subset (h_ex + h_demag only, no h_ext, optional pointers null).
    fullmag_cuda_accumulate_heff(d_terms[kEx].x, d_terms[kDemag].x, nullptr, d_eff_ref.x, n, false, stream);
    fullmag_cuda_accumulate_heff(d_terms[kEx].y, d_terms[kDemag].y, nullptr, d_eff_ref.y, n, false, stream);
    fullmag_cuda_accumulate_heff(d_terms[kEx].z, d_terms[kDemag].z, nullptr, d_eff_ref.z, n, false, stream);
    FemGpuHeffAccumulateTerms fused_base{};
    fused_base.h_ex_x = d_terms[kEx].x;
    fused_base.h_ex_y = d_terms[kEx].y;
    fused_base.h_ex_z = d_terms[kEx].z;
    fused_base.h_demag_x = d_terms[kDemag].x;
    fused_base.h_demag_y = d_terms[kDemag].y;
    fused_base.h_demag_z = d_terms[kDemag].z;
    fused_base.active_mask = 0u;
    fullmag_cuda_accumulate_heff_fused_xyz(
        fused_base, d_eff_fused.x, d_eff_fused.y, d_eff_fused.z, n, stream);
    cuda_check(cudaStreamSynchronize(stream), "sync fused heff base subset");
    assert_component_bitwise(d_eff_ref, d_eff_fused, "fused H_eff base-only subset must match bit-for-bit");

    // Case C: Explicit unscaled Oersted + external field.
    fullmag_cuda_accumulate_heff(d_terms[kEx].x, d_terms[kDemag].x, d_terms[kExt].x, d_eff_ref.x, n, true, stream);
    fullmag_cuda_accumulate_heff(d_terms[kEx].y, d_terms[kDemag].y, d_terms[kExt].y, d_eff_ref.y, n, true, stream);
    fullmag_cuda_accumulate_heff(d_terms[kEx].z, d_terms[kDemag].z, d_terms[kExt].z, d_eff_ref.z, n, true, stream);
    fullmag_cuda_add_scaled_field_inplace(d_terms[kOeBasis].x, d_eff_ref.x, 1.0, n, stream);
    fullmag_cuda_add_scaled_field_inplace(d_terms[kOeBasis].y, d_eff_ref.y, 1.0, n, stream);
    fullmag_cuda_add_scaled_field_inplace(d_terms[kOeBasis].z, d_eff_ref.z, 1.0, n, stream);
    FemGpuHeffAccumulateTerms fused_explicit_oe = fused_base;
    fused_explicit_oe.h_ext_x = d_terms[kExt].x;
    fused_explicit_oe.h_ext_y = d_terms[kExt].y;
    fused_explicit_oe.h_ext_z = d_terms[kExt].z;
    fused_explicit_oe.h_oe_src_x = d_terms[kOeBasis].x;
    fused_explicit_oe.h_oe_src_y = d_terms[kOeBasis].y;
    fused_explicit_oe.h_oe_src_z = d_terms[kOeBasis].z;
    fused_explicit_oe.active_mask = FEM_GPU_HEFF_TERM_EXT | FEM_GPU_HEFF_TERM_OE_EXPLICIT;
    fullmag_cuda_accumulate_heff_fused_xyz(
        fused_explicit_oe, d_eff_fused.x, d_eff_fused.y, d_eff_fused.z, n, stream);
    cuda_check(cudaStreamSynchronize(stream), "sync fused heff explicit oersted");
    assert_component_bitwise(d_eff_ref, d_eff_fused, "fused H_eff explicit Oersted subset must match bit-for-bit");

    for (int t = 0; t < kCount; ++t) {
        gpu_device_free_component(d_terms[t]);
    }
    gpu_device_free_component(d_oe_ref);
    gpu_device_free_component(d_oe_fused);
    gpu_device_free_component(d_eff_ref);
    gpu_device_free_component(d_eff_fused);
}

void test_packed_upload_download_roundtrip(cudaStream_t stream)
{
    for (uint64_t node_count : {1ull, 3ull, 257ull, 1031ull}) {
        const uint64_t dof_len = node_count * 3ull;
        std::vector<double> initial_m(static_cast<size_t>(dof_len), 0.0);
        std::vector<double> expected_field(static_cast<size_t>(dof_len), 0.0);
        std::vector<double> updated_m(static_cast<size_t>(dof_len), 0.0);
        for (uint64_t i = 0; i < node_count; ++i) {
            initial_m[static_cast<size_t>(3u * i + 2u)] = 1.0;
            expected_field[static_cast<size_t>(3u * i + 0u)] = deterministic_value(i, 1.0e4, 0.25);
            expected_field[static_cast<size_t>(3u * i + 1u)] = deterministic_value(i, 1.0e4, 1.15);
            expected_field[static_cast<size_t>(3u * i + 2u)] = deterministic_value(i, 1.0e4, 2.35);
            const double vx = deterministic_value(i, 1.0, 0.4);
            const double vy = deterministic_value(i, 1.0, 1.5);
            const double vz = deterministic_value(i, 1.0, 2.6);
            const double inv = 1.0 / std::sqrt(vx * vx + vy * vy + vz * vz);
            updated_m[static_cast<size_t>(3u * i + 0u)] = vx * inv;
            updated_m[static_cast<size_t>(3u * i + 1u)] = vy * inv;
            updated_m[static_cast<size_t>(3u * i + 2u)] = vz * inv;
        }

        FemGpuState state{};
        TransferAudit audit{};
        std::string error;
        check(
            gpu_state_initialize(
                state,
                node_count,
                FULLMAG_FEM_INTEGRATOR_RK4,
                true,
                false,
                initial_m.data(),
                initial_m.size(),
                audit,
                error),
            error.c_str());
        cuda_check(cudaStreamSynchronize(nullptr), "sync initial magnetization upload");

        const uint64_t expected_bytes = dof_len * sizeof(double);
        const uint64_t h2d_before_reject = audit.counters.h2d_bytes;
        check(
            !gpu_component_upload_aos_packed(
                state.lifecycle,
                state.fields.h_ex,
                state.packed_field_download.aos_device,
                state.packed_field_download.dof_len,
                nullptr,
                expected_field.data(),
                expected_field.size(),
                "packed_roundtrip",
                audit,
                error),
            "gpu_component_upload_aos_packed must reject raw_stream == nullptr");
        check(
            !error.empty() && audit.counters.h2d_bytes == h2d_before_reject,
            "null-stream packed upload rejection must not charge H2D audit");

        error.clear();
        check(
            !gpu_state_upload_magnetization_aos_packed(
                state,
                updated_m.data(),
                updated_m.size(),
                audit,
                nullptr,
                error),
            "gpu_state_upload_magnetization_aos_packed must reject raw_stream == nullptr");
        check(
            !error.empty() && audit.counters.h2d_bytes == h2d_before_reject,
            "null-stream magnetization packed upload rejection must not charge H2D audit");

        // Component packed upload -> download roundtrip.
        const uint64_t h2d_before = audit.counters.h2d_bytes;
        const uint64_t d2h_before = audit.counters.d2h_bytes;
        error.clear();
        check(
            gpu_component_upload_aos_packed(
                state.lifecycle,
                state.fields.h_ex,
                state.packed_field_download.aos_device,
                state.packed_field_download.dof_len,
                reinterpret_cast<void *>(stream),
                expected_field.data(),
                expected_field.size(),
                "packed_roundtrip",
                audit,
                error),
            error.c_str());
        std::vector<double> downloaded_field;
        check(
            gpu_component_download_aos_packed(
                state.lifecycle,
                state.fields.h_ex,
                state.packed_field_download.aos_device,
                state.packed_field_download.dof_len,
                reinterpret_cast<void *>(stream),
                downloaded_field,
                audit,
                "packed_roundtrip",
                error),
            error.c_str());
        check(
            vectors_bitwise_equal(expected_field, downloaded_field),
            "packed component upload/download roundtrip must be bit-for-bit identical");
        check(
            audit.counters.h2d_bytes - h2d_before == expected_bytes &&
                audit.counters.d2h_bytes - d2h_before == expected_bytes,
            "packed component roundtrip must audit exact 3*N*sizeof(double) H2D and D2H bytes");

        // Magnetization packed upload -> download roundtrip.
        const uint64_t m_h2d_before = audit.counters.h2d_bytes;
        const uint64_t m_d2h_before = audit.counters.d2h_bytes;
        state.residency.host_state = FemGpuSyncState::HostStale;
        check(
            gpu_state_upload_magnetization_aos_packed(
                state,
                updated_m.data(),
                updated_m.size(),
                audit,
                reinterpret_cast<void *>(stream),
                error),
            error.c_str());
        state.residency.host_state = FemGpuSyncState::HostStale;
        std::vector<double> downloaded_m;
        check(
            gpu_state_download_magnetization_aos_packed(
                state,
                downloaded_m,
                audit,
                reinterpret_cast<void *>(stream),
                error),
            error.c_str());
        check(
            vectors_bitwise_equal(updated_m, downloaded_m) &&
                state.residency.host_state == FemGpuSyncState::HostClean,
            "packed magnetization upload/download roundtrip must be bit-exact and mark HostClean");
        check(
            audit.counters.h2d_bytes - m_h2d_before == expected_bytes &&
                audit.counters.d2h_bytes - m_d2h_before == expected_bytes,
            "packed magnetization roundtrip must audit exact 3*N*sizeof(double) H2D and D2H bytes");

        gpu_state_destroy(state);
    }
}

void test_source_contracts()
{
    const std::filesystem::path root = fem_source_root();
    const std::string rk_dmi = read_text_file(root / "gpu/cuda/integrators/rk/rk_dmi_fields.cu");
    const std::string dmi_kernels = read_text_file(root / "gpu/cuda/interactions/dmi/dmi_kernels.cu");
    const std::string rk_ani = read_text_file(root / "gpu/cuda/integrators/rk/rk_anisotropy_field.cu");
    const std::string rk_mel = read_text_file(root / "gpu/cuda/integrators/rk/rk_magnetoelastic_field.cu");
    const std::string rk_therm = read_text_file(root / "gpu/cuda/integrators/rk/rk_thermal_field.cu");
    const std::string rk_rhs = read_text_file(root / "gpu/cuda/integrators/rk/rk_rhs_runtime.cu");
    const std::string state_io = read_text_file(root / "cpu/mfem/runtime/state_io.cpp");
    const std::string stage_compute = read_text_file(root / "gpu/cuda/demag_poisson/stage_compute.cpp");

    // Intermediate RK field launches must pass nullptr instead of scalar_workspace.
    check(
        rk_dmi.find("gpu.reductions.scalar_workspace") == std::string::npos &&
            rk_ani.find("gpu.reductions.scalar_workspace") == std::string::npos &&
            rk_mel.find("gpu.reductions.scalar_workspace") == std::string::npos &&
            rk_therm.find("gpu.reductions.scalar_workspace") == std::string::npos,
        "intermediate RK DMI/anisotropy/magnetoelastic/thermal field launches must pass nullptr instead of scalar_workspace");

    // DMI kernel must include <cub/cub.cuh> and have zero early return; inside dmi_element_residual_kernel.
    check(
        dmi_kernels.find("#include <cub/cub.cuh>") != std::string::npos &&
            dmi_kernels.find("template <bool ComputeEnergy>") != std::string::npos &&
            dmi_kernels.find("cub::BlockReduce<double, kBlockSize>") != std::string::npos,
        "dmi_kernels.cu must include <cub/cub.cuh> and specialize dmi_element_residual_kernel<ComputeEnergy> with BlockReduce");
    const std::size_t dmi_kern_pos = dmi_kernels.find("dmi_element_residual_kernel(");
    const std::size_t dmi_diff_pos = dmi_kernels.find("dmi_energy_difference_kernel(", dmi_kern_pos);
    check(dmi_kern_pos != std::string::npos && dmi_diff_pos != std::string::npos,
          "dmi_kernels.cu must contain dmi_element_residual_kernel before dmi_energy_difference_kernel");
    const std::string dmi_kern_body = dmi_kernels.substr(dmi_kern_pos, dmi_diff_pos - dmi_kern_pos);
    check(
        dmi_kern_body.find("return;") == std::string::npos,
        "dmi_element_residual_kernel must predicate inactive threads instead of early return; before BlockReduce");

    // Exchange routing in rk_rhs_runtime.cu: Compensated=false on RK, Compensated=true on relaxation fresh_demag.
    check(
        rk_rhs.find("ctx, m, stream, n, evaluation_time_s, label, reason, false, false, false") !=
                std::string::npos &&
            rk_rhs.find("ctx, m, stream, n, evaluation_time_s, label, reason, true, false, true") !=
                std::string::npos &&
            rk_rhs.find("ctx, m, stream, n, evaluation_time_s, label, reason, false, true, false") !=
                std::string::npos,
        "rk_rhs_runtime.cu must route RK stages to fast FP64 FMA exchange and relaxation fresh_demag to compensated DD");

    // Packed transfer adoption in state_io.cpp and stage_compute.cpp.
    check(
        state_io.find("gpu_state_download_component_aos_packed(") != std::string::npos &&
            state_io.find("gpu_state_download_magnetization_aos_packed(") != std::string::npos &&
            state_io.find("gpu_state_upload_magnetization_aos_packed(") != std::string::npos,
        "state_io.cpp must route GPU field and magnetization transfers through packed AoS/SoA helpers");
    const std::size_t vis_pos = stage_compute.find("bool recover_device_demag_visual_field(");
    const std::size_t vis_end = stage_compute.find("bool reduce_device_demag_robin_boundary_energy(", vis_pos);
    check(vis_pos != std::string::npos && vis_end != std::string::npos,
          "stage_compute.cpp must define recover_device_demag_visual_field");
    const std::string vis_body = stage_compute.substr(vis_pos, vis_end - vis_pos);
    check(
        vis_body.find("gpu_state_download_component_aos_packed(") != std::string::npos &&
            vis_body.find("cudaStreamSynchronize(") == std::string::npos,
        "stage_compute.cpp recover_device_demag_visual_field must use packed download without pre-copy sync");
}

} // namespace

int main()
{
    test_source_contracts();

    cudaStream_t stream = nullptr;
    cuda_check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking), "create contract test stream");

    test_null_reduction_outputs_match_field_bitwise(stream);
    test_regional_drive_lazy_zero_transition(stream);
    test_exchange_fast_vs_compensated_parity(stream);
    test_fused_heff_bitwise_parity_all_terms(stream);
    test_packed_upload_download_roundtrip(stream);

    cuda_check(cudaStreamDestroy(stream), "destroy contract test stream");
    std::puts("PASS: CUDA short-range kernel optimizations contract (Track 2)");
    return 0;
}
