/* Numeric CUDA Zhang-Li skew-tetra contract, sharing only an independent host geometry oracle. */

#include "gpu/cuda/interactions/stt/stt_kernels.hpp"
#include "context.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "tetra_geometry_oracle.hpp"

#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

constexpr double kBohrMagneton = 9.274009994e-24;
constexpr double kElectronCharge = 1.60217662e-19;

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_cuda(cudaError_t status, const char *message)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, cudaGetErrorString(status));
        std::exit(1);
    }
}

void check_near(double actual, double expected, double absolute_tolerance, const char *message)
{
    if (std::abs(actual - expected) > absolute_tolerance) {
        std::fprintf(stderr, "FAIL: %s: expected %.17g, got %.17g, atol %.17g\n", message, expected, actual, absolute_tolerance);
        std::exit(1);
    }
}

template <typename T>
T *copy_to_device(const std::vector<T> &host)
{
    T *device = nullptr;
    check_cuda(cudaMalloc(&device, host.size() * sizeof(T)), "cudaMalloc");
    check_cuda(cudaMemcpy(device, host.data(), host.size() * sizeof(T), cudaMemcpyHostToDevice), "cudaMemcpy H2D");
    return device;
}

template <typename T>
std::vector<T> copy_from_device(T *device, size_t count)
{
    std::vector<T> host(count);
    check_cuda(cudaMemcpy(host.data(), device, count * sizeof(T), cudaMemcpyDeviceToHost), "cudaMemcpy D2H");
    return host;
}

void normalize_node(double &x, double &y, double &z)
{
    const double norm = std::sqrt(x * x + y * y + z * z);
    check(norm > 0.0 && std::isfinite(norm), "trajectory magnetization remains finite and nonzero");
    x /= norm;
    y /= norm;
    z /= norm;
}

void cuda_zhang_li_skew_tetra_matches_independent_affine_oracle()
{
    const std::array<fullmag::fem::test::Vec3, 4> points = {{
        {0.0, 0.0, 0.0}, {2.0, 0.0, 0.0}, {1.0, 1.0, 0.0}, {0.0, 0.0, 1.0},
    }};
    std::array<fullmag::fem::test::Vec3, 4> gradients{};
    check(fullmag::fem::test::p1_tetra_gradients(points, gradients), "skew tetra oracle geometry is nondegenerate");
    check_near(gradients[1][0], 0.5, 1e-15, "oracle grad N1 x");
    check_near(gradients[1][1], -0.5, 1e-15, "oracle grad N1 y");
    check_near(gradients[1][2], 0.0, 1e-15, "oracle grad N1 z");

    const std::vector<double> nodes_xyz = {0., 0., 0., 2., 0., 0., 1., 1., 0., 0., 0., 1.};
    const std::vector<uint32_t> elements = {0, 1, 2, 3};
    const std::vector<uint8_t> magnetic_elements = {1};
    const std::vector<uint8_t> magnetic_nodes = {1, 1, 1, 1};
    const std::vector<double> mx = {1., 1., 1., 1.};
    const std::vector<double> my = {0., 0., 0., 0.};
    const std::vector<double> mz = {0., 2., 1., 0.}; // m_z = x on the shared skew tetra.
    const std::vector<double> ms = {800e3, 800e3, 800e3, 800e3};
    const std::vector<double> zero = {0., 0., 0., 0.};
    const double current_x = 1e12;
    const double u_x = kBohrMagneton * current_x / (kElectronCharge * ms[0]);

    double *d_nodes = copy_to_device(nodes_xyz);
    uint32_t *d_elements = copy_to_device(elements);
    uint8_t *d_magnetic_elements = copy_to_device(magnetic_elements);
    uint8_t *d_magnetic_nodes = copy_to_device(magnetic_nodes);
    double *d_mx = copy_to_device(mx);
    double *d_my = copy_to_device(my);
    double *d_mz = copy_to_device(mz);
    double *d_ms = copy_to_device(ms);
    double *d_work_x = copy_to_device(zero);
    double *d_work_y = copy_to_device(zero);
    double *d_work_z = copy_to_device(zero);
    double *d_weight = copy_to_device(zero);
    double *d_rhs_x = copy_to_device(zero);
    double *d_rhs_y = copy_to_device(zero);
    double *d_rhs_z = copy_to_device(zero);
    double *d_max_rhs = copy_to_device(std::vector<double>{0.});

    fullmag::fem::fullmag_cuda_add_zhang_li_stt_rhs(
        d_nodes, d_elements, d_magnetic_elements, d_mx, d_my, d_mz, d_ms, nullptr,
        d_magnetic_nodes, d_work_x, d_work_y, d_work_z, d_weight, d_rhs_x, d_rhs_y,
        d_rhs_z, d_max_rhs, current_x, 0.0, 0.0, 1.0, 0.0, 0.0, 1, 4);
    check_cuda(cudaGetLastError(), "CUDA Zhang-Li launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA Zhang-Li synchronize");

    const auto rhs_x = copy_from_device(d_rhs_x, 4);
    const auto rhs_y = copy_from_device(d_rhs_y, 4);
    const auto rhs_z = copy_from_device(d_rhs_z, 4);
    for (size_t node = 0; node < 4; ++node) {
        const double scale = std::max(std::abs(u_x), 1e-24);
        check_near(rhs_x[node], -mz[node] * u_x, 1e-12 * scale, "CUDA skew-tetra affine RHS x");
        check_near(rhs_y[node], 0.0, 1e-24, "CUDA skew-tetra affine RHS y");
        check_near(rhs_z[node], u_x, 1e-12 * scale, "CUDA skew-tetra affine RHS z");
    }

    // A physical current reversal must reverse the local texture velocity, not merely source text.
    check_cuda(cudaMemset(d_rhs_x, 0, 4 * sizeof(double)), "clear reversed RHS x");
    check_cuda(cudaMemset(d_rhs_y, 0, 4 * sizeof(double)), "clear reversed RHS y");
    check_cuda(cudaMemset(d_rhs_z, 0, 4 * sizeof(double)), "clear reversed RHS z");
    fullmag::fem::fullmag_cuda_add_zhang_li_stt_rhs(
        d_nodes, d_elements, d_magnetic_elements, d_mx, d_my, d_mz, d_ms, nullptr,
        d_magnetic_nodes, d_work_x, d_work_y, d_work_z, d_weight, d_rhs_x, d_rhs_y,
        d_rhs_z, d_max_rhs, -current_x, 0.0, 0.0, 1.0, 0.0, 0.0, 1, 4);
    check_cuda(cudaGetLastError(), "CUDA reversed Zhang-Li launch");
    check_cuda(cudaDeviceSynchronize(), "CUDA reversed Zhang-Li synchronize");
    const auto reversed_z = copy_from_device(d_rhs_z, 4);
    for (double value : reversed_z) {
        check_near(value, -u_x, 1e-12 * std::max(std::abs(u_x), 1e-24), "CUDA current reversal velocity");
    }

    // The ten-step comparison uses the production CPU operator and CUDA wrapper on
    // the same mesh. Its bound comes from the observed dt versus dt/2 convergence,
    // so it cannot be tuned from a single CPU/GPU regression result.
    fullmag::fem::Context cpu_context;
    cpu_context.mesh.n_nodes = 4;
    cpu_context.mesh.n_elements = 1;
    cpu_context.mesh.nodes_xyz = nodes_xyz;
    cpu_context.mesh.elements = elements;
    cpu_context.mesh.magnetic_element_mask = magnetic_elements;
    cpu_context.mesh.magnetic_node_mask = magnetic_nodes;
    cpu_context.stt.zhang_li_enabled = true;
    cpu_context.stt.current_density_am2 = {current_x, 0.0, 0.0};
    cpu_context.stt.degree = 1.0;
    cpu_context.stt.beta = 0.0;
    cpu_context.material_fields.material.saturation_magnetisation = ms[0];
    cpu_context.material_fields.material.damping = 0.0;
    const std::vector<double> trajectory_initial = {
        1.0, 0.0, 0.0,
        std::sqrt(0.96), 0.0, 0.2,
        std::sqrt(0.99), 0.0, 0.1,
        1.0, 0.0, 0.0,
    };
    const auto advance_cpu = [&](double dt, int steps) {
        std::vector<double> state = trajectory_initial;
        for (int step = 0; step < steps; ++step) {
            std::vector<double> rhs(12u, 0.0);
            fullmag::fem::add_zhang_li_stt_rhs_aos(cpu_context, state, rhs);
            for (size_t node = 0; node < 4; ++node) {
                const size_t base = node * 3u;
                state[base] += dt * rhs[base];
                state[base + 1u] += dt * rhs[base + 1u];
                state[base + 2u] += dt * rhs[base + 2u];
                normalize_node(state[base], state[base + 1u], state[base + 2u]);
            }
        }
        return state;
    };
    const auto advance_cuda = [&](double dt, int steps, double signed_current) {
        std::vector<double> hx(4), hy(4), hz(4);
        for (size_t node = 0; node < 4; ++node) {
            hx[node] = trajectory_initial[node * 3u];
            hy[node] = trajectory_initial[node * 3u + 1u];
            hz[node] = trajectory_initial[node * 3u + 2u];
        }
        check_cuda(cudaMemcpy(d_mx, hx.data(), 4 * sizeof(double), cudaMemcpyHostToDevice), "seed CUDA trajectory mx");
        check_cuda(cudaMemcpy(d_my, hy.data(), 4 * sizeof(double), cudaMemcpyHostToDevice), "seed CUDA trajectory my");
        check_cuda(cudaMemcpy(d_mz, hz.data(), 4 * sizeof(double), cudaMemcpyHostToDevice), "seed CUDA trajectory mz");
        for (int step = 0; step < steps; ++step) {
            check_cuda(cudaMemset(d_rhs_x, 0, 4 * sizeof(double)), "clear trajectory RHS x");
            check_cuda(cudaMemset(d_rhs_y, 0, 4 * sizeof(double)), "clear trajectory RHS y");
            check_cuda(cudaMemset(d_rhs_z, 0, 4 * sizeof(double)), "clear trajectory RHS z");
            fullmag::fem::fullmag_cuda_add_zhang_li_stt_rhs(
                d_nodes, d_elements, d_magnetic_elements, d_mx, d_my, d_mz, d_ms, nullptr,
                d_magnetic_nodes, d_work_x, d_work_y, d_work_z, d_weight, d_rhs_x, d_rhs_y,
                d_rhs_z, d_max_rhs, signed_current, 0.0, 0.0, 1.0, 0.0, 0.0, 1, 4);
            check_cuda(cudaGetLastError(), "CUDA trajectory Zhang-Li launch");
            check_cuda(cudaDeviceSynchronize(), "CUDA trajectory synchronize");
            const auto rx = copy_from_device(d_rhs_x, 4);
            const auto ry = copy_from_device(d_rhs_y, 4);
            const auto rz = copy_from_device(d_rhs_z, 4);
            for (size_t node = 0; node < 4; ++node) {
                hx[node] += dt * rx[node];
                hy[node] += dt * ry[node];
                hz[node] += dt * rz[node];
                normalize_node(hx[node], hy[node], hz[node]);
            }
            check_cuda(cudaMemcpy(d_mx, hx.data(), 4 * sizeof(double), cudaMemcpyHostToDevice), "update CUDA trajectory mx");
            check_cuda(cudaMemcpy(d_my, hy.data(), 4 * sizeof(double), cudaMemcpyHostToDevice), "update CUDA trajectory my");
            check_cuda(cudaMemcpy(d_mz, hz.data(), 4 * sizeof(double), cudaMemcpyHostToDevice), "update CUDA trajectory mz");
        }
        std::vector<double> state(12);
        for (size_t node = 0; node < 4; ++node) {
            state[node * 3u] = hx[node];
            state[node * 3u + 1u] = hy[node];
            state[node * 3u + 2u] = hz[node];
        }
        return state;
    };
    const double dt = 1e-4;
    const auto cpu_coarse = advance_cpu(dt, 10);
    const auto cpu_fine = advance_cpu(dt / 2.0, 20);
    const auto cuda_coarse = advance_cuda(dt, 10, current_x);
    double convergence_error = 0.0;
    double cpu_gpu_error = 0.0;
    for (size_t component = 0; component < cpu_coarse.size(); ++component) {
        convergence_error = std::max(convergence_error, std::abs(cpu_coarse[component] - cpu_fine[component]));
        cpu_gpu_error = std::max(cpu_gpu_error, std::abs(cpu_coarse[component] - cuda_coarse[component]));
    }
    check(convergence_error > 0.0, "dt convergence study must resolve a nonzero truncation difference");
    const double trajectory_bound = 2.0 * convergence_error;
    check(cpu_gpu_error <= trajectory_bound, "ten-step CPU/GPU error is bounded by observed dt-convergence error");
    check(cpu_gpu_error <= 1e-10, "ten-step CPU/GPU parity remains below 1e-10");
    const auto cuda_reversed = advance_cuda(dt, 10, -current_x);
    check(cuda_reversed[2] < trajectory_initial[2], "reversed current reverses ten-step texture velocity");
    std::printf("STT trajectory dt-study: coarse-fine %.17g, CPU-GPU %.17g, bound %.17g\n", convergence_error, cpu_gpu_error, trajectory_bound);

    for (void *pointer : {static_cast<void *>(d_nodes), static_cast<void *>(d_elements), static_cast<void *>(d_magnetic_elements), static_cast<void *>(d_magnetic_nodes), static_cast<void *>(d_mx), static_cast<void *>(d_my), static_cast<void *>(d_mz), static_cast<void *>(d_ms), static_cast<void *>(d_work_x), static_cast<void *>(d_work_y), static_cast<void *>(d_work_z), static_cast<void *>(d_weight), static_cast<void *>(d_rhs_x), static_cast<void *>(d_rhs_y), static_cast<void *>(d_rhs_z), static_cast<void *>(d_max_rhs)}) {
        cudaFree(pointer);
    }
}

} // namespace

int main()
{
    cuda_zhang_li_skew_tetra_matches_independent_affine_oracle();
    std::printf("FEM CUDA Zhang-Li skew-tetra numeric contract PASS\n");
    return 0;
}
