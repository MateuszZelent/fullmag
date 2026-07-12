// ── GPU CUDA thermal kernels source contract ──────────────────────────
// This source owns deterministic Brown thermal field RNG, kernel, and CUDA
// wrapper. It does not own RK orchestration, Context construction, plan import,
// exchange, demag, DMI, STT, magnetoelastic, or C ABI entrypoints.

#include "gpu/cuda/interactions/thermal/thermal_kernels.hpp"

#include <cmath>
#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__device__ uint64_t splitmix64_next(uint64_t x)
{
    x += 0x9e3779b97f4a7c15ull;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ull;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebull;
    return x ^ (x >> 31);
}

__device__ double uniform_open01(uint64_t x)
{
    constexpr double kInv53 = 1.0 / 9007199254740992.0;
    const uint64_t mantissa = (splitmix64_next(x) >> 11) | 1ull;
    return static_cast<double>(mantissa) * kInv53;
}

__device__ double deterministic_normal(uint64_t seed, uint64_t node, uint64_t component, uint64_t step_index)
{
    constexpr double kTwoPi = 6.283185307179586476925286766559;
    const uint64_t base =
        seed ^
        (node * 0x9e3779b97f4a7c15ull) ^
        (component * 0xbf58476d1ce4e5b9ull) ^
        (step_index * 0x94d049bb133111ebull);
    const double u1 = uniform_open01(base);
    const double u2 = uniform_open01(base ^ 0xd2b74407b1ce6e93ull);
    return sqrt(-2.0 * log(u1)) * cos(kTwoPi * u2);
}

__global__ void thermal_field_blocks_kernel(
    const double *__restrict__ ms,
    const double *__restrict__ alpha,
    const double *__restrict__ node_volumes,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_therm_x,
    double *__restrict__ h_therm_y,
    double *__restrict__ h_therm_z,
    double *__restrict__ block_max_sigma,
    double gamma_red,
    double uniform_alpha,
    double temperature,
    double dt_seconds,
    uint64_t seed,
    uint64_t step_index,
    bool use_alpha_field,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;
    constexpr double kBoltzmann = 1.380649e-23;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double sigma = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double ms_i = ms[i];
        const double alpha_i = use_alpha_field ? alpha[i] : uniform_alpha;
        const double volume_i = node_volumes[i];
        if (temperature > 0.0 && dt_seconds > 0.0 && gamma_red > 0.0 &&
            ms_i > 0.0 && alpha_i > 0.0 && volume_i > 0.0 && seed != 0ull) {
            sigma = sqrt(
                2.0 * alpha_i * kBoltzmann * temperature /
                (gamma_red * kMu0 * ms_i * volume_i * dt_seconds));
            const uint64_t node = static_cast<uint64_t>(i);
            h_therm_x[i] = deterministic_normal(seed, node, 0ull, step_index) * sigma;
            h_therm_y[i] = deterministic_normal(seed, node, 1ull, step_index) * sigma;
            h_therm_z[i] = deterministic_normal(seed, node, 2ull, step_index) * sigma;
        } else {
            h_therm_x[i] = 0.0;
            h_therm_y[i] = 0.0;
            h_therm_z[i] = 0.0;
        }
    } else if (i < N) {
        h_therm_x[i] = 0.0;
        h_therm_y[i] = 0.0;
        h_therm_z[i] = 0.0;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_max = BlockReduce(temp_storage).Reduce(sigma, cub::Max());
    if (threadIdx.x == 0 && block_max_sigma != nullptr) {
        block_max_sigma[blockIdx.x] = block_max;
    }
}

void fullmag_cuda_thermal_field_blocks(
    const double *ms,
    const double *alpha,
    const double *node_volumes,
    const uint8_t *magnetic_node_mask,
    double *h_therm_x,
    double *h_therm_y,
    double *h_therm_z,
    double *block_max_sigma,
    double gamma_red,
    double uniform_alpha,
    double temperature,
    double dt_seconds,
    uint64_t seed,
    uint64_t step_index,
    bool use_alpha_field,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    thermal_field_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        ms,
        alpha,
        node_volumes,
        magnetic_node_mask,
        h_therm_x,
        h_therm_y,
        h_therm_z,
        block_max_sigma,
        gamma_red,
        uniform_alpha,
        temperature,
        dt_seconds,
        seed,
        step_index,
        use_alpha_field,
        N);
}

} // namespace fullmag::fem
