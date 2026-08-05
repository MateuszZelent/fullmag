/* Numeric CUDA contract for the canonical FEM prescribed-SOT descriptor. */

#include "context.hpp"
#include "cpu/mfem/interactions/sot.hpp"
#include "gpu/cuda/interactions/sot/sot_kernels.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
constexpr double kHbar = 1.054571817e-34;
constexpr double kExactElectronCharge = 1.602176634e-19;
constexpr double kGammaMu0 = 2.211e5;

void fail(const char *message)
{
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
}

void check(bool condition, const char *message)
{
    if (!condition) {
        fail(message);
    }
}

void check_cuda(cudaError_t status, const char *message)
{
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, cudaGetErrorString(status));
        std::exit(1);
    }
}

void check_near(double actual, double expected, const char *message)
{
    const double tolerance = 2.0e-12 * std::max(std::abs(expected), 1.0);
    if (std::abs(actual - expected) > tolerance) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g, tolerance %.17g\n",
            message,
            expected,
            actual,
            tolerance);
        std::exit(1);
    }
}

template <typename T>
T *copy_to_device(const std::vector<T> &host)
{
    T *device = nullptr;
    check_cuda(cudaMalloc(&device, host.size() * sizeof(T)), "cudaMalloc");
    check_cuda(
        cudaMemcpy(device, host.data(), host.size() * sizeof(T), cudaMemcpyHostToDevice),
        "cudaMemcpy host-to-device");
    return device;
}

template <typename T>
std::vector<T> copy_from_device(const T *device, size_t count)
{
    std::vector<T> host(count);
    check_cuda(
        cudaMemcpy(host.data(), device, count * sizeof(T), cudaMemcpyDeviceToHost),
        "cudaMemcpy device-to-host");
    return host;
}

void clear_rhs(double *x, double *y, double *z, double *max_rhs)
{
    check_cuda(cudaMemset(x, 0, 2 * sizeof(double)), "clear rhs x");
    check_cuda(cudaMemset(y, 0, 2 * sizeof(double)), "clear rhs y");
    check_cuda(cudaMemset(z, 0, 2 * sizeof(double)), "clear rhs z");
    check_cuda(cudaMemset(max_rhs, 0, sizeof(double)), "clear block max");
}

void canonical_prescribed_sot_matches_cpu_and_independent_oracle()
{
    int device_count = 0;
    const cudaError_t device_status = cudaGetDeviceCount(&device_count);
    if (device_status != cudaSuccess || device_count == 0) {
        std::printf(
            "SKIP: FEM CUDA prescribed-SOT contract: no CUDA device (%s)\n",
            cudaGetErrorString(device_status));
        return;
    }

    const std::vector<double> mx = {1.0, 1.0};
    const std::vector<double> my = {0.0, 0.0};
    const std::vector<double> mz = {0.0, 0.0};
    const std::vector<double> ms = {800.0e3, 800.0e3};
    const std::vector<double> alpha = {0.2, 0.2};
    const std::vector<uint8_t> magnetic_mask = {1u, 1u};
    const std::vector<uint8_t> active_mask = {1u, 0u};
    const std::vector<double> zeros = {0.0, 0.0};

    double *d_mx = copy_to_device(mx);
    double *d_my = copy_to_device(my);
    double *d_mz = copy_to_device(mz);
    double *d_ms = copy_to_device(ms);
    double *d_alpha = copy_to_device(alpha);
    uint8_t *d_magnetic_mask = copy_to_device(magnetic_mask);
    uint8_t *d_active_mask = copy_to_device(active_mask);
    double *d_rhs_x = copy_to_device(zeros);
    double *d_rhs_y = copy_to_device(zeros);
    double *d_rhs_z = copy_to_device(zeros);
    double *d_block_max = copy_to_device(std::vector<double>{0.0});

    const double current_density = 1.0e11;
    const double xi_dl = 0.12;
    const double xi_fl = -0.02;
    const double envelope = 0.25;
    const double thickness = 1.5e-9;
    const double sigma_x = 0.0;
    const double sigma_y = 1.0;
    const double sigma_z = 0.0;
    const double damping = 0.2;

    fullmag::fem::fullmag_cuda_add_prescribed_sot_rhs(
        d_mx,
        d_my,
        d_mz,
        d_ms,
        d_alpha,
        d_magnetic_mask,
        d_active_mask,
        d_rhs_x,
        d_rhs_y,
        d_rhs_z,
        d_block_max,
        current_density,
        xi_dl,
        xi_fl,
        envelope,
        kGammaMu0,
        thickness,
        sigma_x,
        sigma_y,
        sigma_z,
        2);
    check_cuda(cudaGetLastError(), "launch prescribed SOT");
    check_cuda(cudaDeviceSynchronize(), "synchronize prescribed SOT");

    const auto rhs_x = copy_from_device(d_rhs_x, 2);
    const auto rhs_y = copy_from_device(d_rhs_y, 2);
    const auto rhs_z = copy_from_device(d_rhs_z, 2);
    const double gamma_e = kGammaMu0 / kMu0;
    const double omega_base = gamma_e * kHbar * current_density * envelope /
        (2.0 * kExactElectronCharge * ms[0] * thickness);
    const double inv_gilbert = 1.0 / (1.0 + damping * damping);
    const double damping_like = omega_base * (xi_dl - damping * xi_fl) * inv_gilbert;
    const double field_like = omega_base * (xi_fl + damping * xi_dl) * inv_gilbert;
    // m=(1,0,0), sigma=(0,1,0): m×sigma=(0,0,1), m×(m×sigma)=(0,-1,0).
    check_near(rhs_x[0], 0.0, "prescribed SOT x torque");
    check_near(rhs_y[0], damping_like, "prescribed SOT damping-like torque");
    check_near(rhs_z[0], field_like, "prescribed SOT field-like torque");
    check_near(rhs_x[1], 0.0, "inactive SOT target x torque");
    check_near(rhs_y[1], 0.0, "inactive SOT target y torque");
    check_near(rhs_z[1], 0.0, "inactive SOT target z torque");

    fullmag::fem::Context cpu_context;
    cpu_context.mesh.n_nodes = 2;
    cpu_context.mesh.magnetic_node_mask = magnetic_mask;
    cpu_context.sot.enabled = true;
    cpu_context.sot.formula_version = FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1;
    cpu_context.sot.current_density_am2 = current_density;
    cpu_context.sot.xi_dl = xi_dl;
    cpu_context.sot.xi_fl = xi_fl;
    cpu_context.sot.thickness = thickness;
    cpu_context.sot.envelope_value = envelope;
    cpu_context.sot.sigma = {sigma_x, sigma_y, sigma_z};
    cpu_context.sot.active_node_mask = active_mask;
    cpu_context.material_fields.Ms_field = ms;
    cpu_context.material_fields.alpha_field = alpha;
    cpu_context.material_fields.material.saturation_magnetisation = ms[0];
    cpu_context.material_fields.material.damping = damping;
    cpu_context.material_fields.material.gyromagnetic_ratio = kGammaMu0;
    std::vector<double> cpu_rhs(6u, 0.0);
    double cpu_max_rhs = 0.0;
    fullmag::fem::add_sot_rhs_aos(
        cpu_context,
        {1.0, 0.0, 0.0, 1.0, 0.0, 0.0},
        cpu_rhs,
        cpu_max_rhs);
    check_near(rhs_y[0], cpu_rhs[1], "CPU/GPU prescribed SOT damping-like parity");
    check_near(rhs_z[0], cpu_rhs[2], "CPU/GPU prescribed SOT field-like parity");

    clear_rhs(d_rhs_x, d_rhs_y, d_rhs_z, d_block_max);
    fullmag::fem::fullmag_cuda_add_prescribed_sot_rhs(
        d_mx,
        d_my,
        d_mz,
        d_ms,
        d_alpha,
        d_magnetic_mask,
        d_active_mask,
        d_rhs_x,
        d_rhs_y,
        d_rhs_z,
        d_block_max,
        -current_density,
        xi_dl,
        xi_fl,
        envelope,
        kGammaMu0,
        thickness,
        sigma_x,
        sigma_y,
        sigma_z,
        2);
    check_cuda(cudaGetLastError(), "launch reversed prescribed SOT");
    check_cuda(cudaDeviceSynchronize(), "synchronize reversed prescribed SOT");
    const auto reversed_y = copy_from_device(d_rhs_y, 2);
    const auto reversed_z = copy_from_device(d_rhs_z, 2);
    check_near(reversed_y[0], -rhs_y[0], "prescribed SOT current reversal damping-like sign");
    check_near(reversed_z[0], -rhs_z[0], "prescribed SOT current reversal field-like sign");

    for (void *pointer : {
             static_cast<void *>(d_mx),
             static_cast<void *>(d_my),
             static_cast<void *>(d_mz),
             static_cast<void *>(d_ms),
             static_cast<void *>(d_alpha),
             static_cast<void *>(d_magnetic_mask),
             static_cast<void *>(d_active_mask),
             static_cast<void *>(d_rhs_x),
             static_cast<void *>(d_rhs_y),
             static_cast<void *>(d_rhs_z),
             static_cast<void *>(d_block_max),
         }) {
        cudaFree(pointer);
    }
}

} // namespace

int main()
{
    canonical_prescribed_sot_matches_cpu_and_independent_oracle();
    std::printf("FEM CUDA prescribed-SOT numeric contract PASS\n");
    return 0;
}
