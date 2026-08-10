#include "sparse_solver.hpp"

#include <cooperative_groups.h>

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstring>
#include <limits>

namespace fullmag::fdm::gpu::transport::spin::sparse {
namespace {

namespace cg = cooperative_groups;

constexpr uint32_t kThreads = 256;
constexpr uint32_t kSmallValues = 2816;
constexpr uint32_t kHOffset = 0;
constexpr uint32_t kCsOffset = kHOffset + (kRestart + 1) * kRestart;
constexpr uint32_t kSnOffset = kCsOffset + kRestart;
constexpr uint32_t kGOffset = kSnOffset + kRestart;
constexpr uint32_t kYOffset = kGOffset + kRestart + 1;
constexpr uint32_t kScalarOffset = kYOffset + kRestart;
constexpr double kStrongThreshold = 0.25;
constexpr uint32_t kIntermediateSmoothingSweeps = 2;
constexpr uint32_t kFineSmoothingSweeps = 2;
constexpr uint32_t kCoarseChebyshevDegree = 128;
constexpr double kJacobiWeight = 2.0 / 3.0;

enum Status : uint32_t {
    ok = 0,
    invalid_argument = 1,
    out_of_memory = 2,
    cuda_failure = 3,
    resource_limit = 4,
    nonconverged = 5,
};

struct DeviceResult {
    uint64_t iterations;
    uint64_t amg_applications;
    uint32_t reason;
    uint32_t reserved;
    double relative_residual;
    uint32_t restart_count;
    uint32_t reserved2;
    double restart_residuals[32];
};

struct DevicePreconditionerAudit {
    double additive_relative_error;
    double homogeneity_relative_error;
    double repeat_relative_error;
    double energy;
    uint32_t level_count;
    uint32_t reserved;
    double residual_ratios[kMaximumLevels];
    double energy_cosines[kMaximumLevels];
    double down_phase_residuals[kMaximumLevels];
    double up_phase_residuals[kMaximumLevels];
};

constexpr uint64_t kDeviceStatusBytes =
    sizeof(DeviceResult) > sizeof(DevicePreconditionerAudit)
        ? sizeof(DeviceResult)
        : sizeof(DevicePreconditionerAudit);

bool checked_mul(uint64_t left, uint64_t right, uint64_t *value) {
    if (left != 0 && right > std::numeric_limits<uint64_t>::max() / left)
        return false;
    *value = left * right;
    return true;
}

bool checked_add(uint64_t left, uint64_t right, uint64_t *value) {
    if (right > std::numeric_limits<uint64_t>::max() - left) return false;
    *value = left + right;
    return true;
}

uint64_t cells_of(const Triple<uint64_t> &grid) {
    uint64_t xy = 0;
    uint64_t cells = 0;
    return checked_mul(grid[0], grid[1], &xy) &&
                   checked_mul(xy, grid[2], &cells)
               ? cells
               : 0;
}

uint64_t face_count(const Triple<uint64_t> &grid, uint32_t axis) {
    uint64_t count = 0;
    if (axis == 0) {
        uint64_t extent = 0;
        return checked_add(grid[0], 1, &extent) &&
                       checked_mul(extent, grid[1], &count) &&
                       checked_mul(count, grid[2], &count)
                   ? count
                   : 0;
    }
    if (axis == 1) {
        uint64_t extent = 0;
        return checked_add(grid[1], 1, &extent) &&
                       checked_mul(grid[0], extent, &count) &&
                       checked_mul(count, grid[2], &count)
                   ? count
                   : 0;
    }
    uint64_t extent = 0;
    return checked_add(grid[2], 1, &extent) &&
                   checked_mul(grid[0], grid[1], &count) &&
                   checked_mul(count, extent, &count)
               ? count
               : 0;
}

bool allocate(void **pointer, uint64_t bytes) {
    if (bytes == 0) {
        *pointer = nullptr;
        return true;
    }
    return cudaMalloc(pointer, bytes) == cudaSuccess;
}

template <typename T>
bool allocate_values(T **pointer, uint64_t count, uint64_t *ledger) {
    uint64_t bytes = 0;
    if (!checked_mul(count, sizeof(T), &bytes) ||
        !allocate(reinterpret_cast<void **>(pointer), bytes))
        return false;
    if (!checked_add(*ledger, bytes, ledger)) {
        (void)cudaFree(*pointer);
        *pointer = nullptr;
        return false;
    }
    return true;
}

void free_level(Level &level) {
    void *pointers[] = {level.active, level.gx, level.gy, level.gz,
                        level.diagonal, level.strong_edges};
    for (void *pointer : pointers)
        if (pointer != nullptr) (void)cudaFree(pointer);
    level = {};
}

__host__ __device__ uint64_t cell_index(const Triple<uint64_t> &grid,
                                        uint64_t x, uint64_t y, uint64_t z) {
    return x + grid[0] * (y + grid[1] * z);
}

__host__ __device__ uint64_t face_index(
    const Triple<uint64_t> &grid, uint32_t axis,
    uint64_t x, uint64_t y, uint64_t z, uint64_t plane) {
    if (axis == 0)
        return plane + (grid[0] + 1) * (y + grid[1] * z);
    if (axis == 1)
        return x + grid[0] * (plane + (grid[1] + 1) * z);
    return x + grid[0] * (y + grid[1] * plane);
}

__host__ __device__ void coordinates(const Triple<uint64_t> &grid,
                                     uint64_t cell, uint64_t &x, uint64_t &y,
                                     uint64_t &z) {
    x = cell % grid[0];
    const uint64_t yz = cell / grid[0];
    y = yz % grid[1];
    z = yz / grid[1];
}

__device__ double harmonic(double left, double right) {
    return left > 0.0 && right > 0.0
               ? 2.0 * left * right / (left + right)
               : 0.0;
}

__device__ double fine_edge(const Operator &op, uint32_t axis,
                            uint64_t left, uint64_t right) {
    if (!op.active[left] || !op.active[right]) return 0.0;
    const double h = op.cell_size[axis];
    return harmonic(op.spin_conductivity[left], op.spin_conductivity[right]) /
           (2.0 * h * h);
}

__device__ double level_face(const Level &level, uint32_t axis,
                             uint64_t x, uint64_t y, uint64_t z,
                             uint64_t plane) {
    const uint64_t face = face_index(level.grid, axis, x, y, z, plane);
    return axis == 0 ? level.gx[face]
                     : axis == 1 ? level.gy[face] : level.gz[face];
}

__device__ double edge_at(const Operator &op, const Level &level,
                          uint32_t level_index, uint32_t axis,
                          uint64_t left, uint64_t right,
                          uint64_t x, uint64_t y, uint64_t z,
                          uint64_t plane) {
    return level_index == 0 ? fine_edge(op, axis, left, right)
                            : level_face(level, axis, x, y, z, plane);
}

__global__ void measure_direction_strength_kernel(
    Operator op, Level level, uint32_t level_index,
    unsigned long long *maximum_bits) {
    for (uint64_t cell = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         cell < level.cells; cell += uint64_t(blockDim.x) * gridDim.x) {
        const bool active = level_index == 0 ? op.active[cell] != 0
                                             : level.active[cell] != 0;
        if (!active) continue;
        uint64_t x = 0, y = 0, z = 0;
        coordinates(level.grid, cell, x, y, z);
        const uint64_t coordinate[3]{x, y, z};
        for (uint32_t axis = 0; axis < 3; ++axis) {
            if (coordinate[axis] + 1 >= level.grid[axis]) continue;
            uint64_t neighbor_coordinate[3]{x, y, z};
            ++neighbor_coordinate[axis];
            const uint64_t neighbor = cell_index(
                level.grid, neighbor_coordinate[0], neighbor_coordinate[1],
                neighbor_coordinate[2]);
            const bool neighbor_active = level_index == 0
                                             ? op.active[neighbor] != 0
                                             : level.active[neighbor] != 0;
            if (!neighbor_active) continue;
            const double weight = edge_at(op, level, level_index, axis, cell,
                                          neighbor, x, y, z,
                                          coordinate[axis] + 1);
            if (weight > 0.0 && isfinite(weight))
                atomicMax(maximum_bits + axis,
                          static_cast<unsigned long long>(__double_as_longlong(weight)));
        }
    }
}

__global__ void build_level_cells_kernel(Operator op, Level previous,
                                         uint32_t previous_index,
                                         Level coarse) {
    for (uint64_t coarse_cell = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         coarse_cell < coarse.cells;
         coarse_cell += uint64_t(blockDim.x) * gridDim.x) {
        uint64_t cx = 0, cy = 0, cz = 0;
        coordinates(coarse.grid, coarse_cell, cx, cy, cz);
        bool active = false;
        double local[3]{0.0, 0.0, 0.0};
        for (uint32_t dz = 0; dz < coarse.coarsen_from_parent[2]; ++dz)
            for (uint32_t dy = 0; dy < coarse.coarsen_from_parent[1]; ++dy)
                for (uint32_t dx = 0; dx < coarse.coarsen_from_parent[0]; ++dx) {
                    const uint64_t x = coarse.coarsen_from_parent[0] * cx + dx;
                    const uint64_t y = coarse.coarsen_from_parent[1] * cy + dy;
                    const uint64_t z = coarse.coarsen_from_parent[2] * cz + dz;
                    if (x >= previous.grid[0] || y >= previous.grid[1] ||
                        z >= previous.grid[2])
                        continue;
                    const uint64_t child = cell_index(previous.grid, x, y, z);
                    const bool child_active = previous_index == 0
                                                  ? op.active[child] != 0
                                                  : previous.active[child] != 0;
                    if (!child_active) continue;
                    active = true;
                    for (uint32_t component = 0; component < 3; ++component) {
                        if (previous_index == 0) {
                            local[component] +=
                                op.local_block_soa[(component * 3 + component) *
                                                       previous.cells +
                                                   child];
                        } else {
                            double edge_sum = 0.0;
                            const uint64_t coord[3]{x, y, z};
                            for (uint32_t axis = 0; axis < 3; ++axis) {
                                if (coord[axis] > 0)
                                    edge_sum += level_face(previous, axis, x, y, z,
                                                           coord[axis]);
                                if (coord[axis] + 1 < previous.grid[axis])
                                    edge_sum += level_face(previous, axis, x, y, z,
                                                           coord[axis] + 1);
                            }
                            local[component] +=
                                previous.diagonal[component * previous.cells + child] -
                                edge_sum;
                        }
                    }
                }
        coarse.active[coarse_cell] = active ? 1 : 0;
        for (uint32_t component = 0; component < 3; ++component)
            coarse.diagonal[component * coarse.cells + coarse_cell] =
                active ? local[component] : 1.0;
    }
}

__global__ void build_level_faces_kernel(Operator op, Level previous,
                                         uint32_t previous_index,
                                         Level coarse, uint32_t axis,
                                         uint64_t faces) {
    for (uint64_t coarse_face = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         coarse_face < faces;
         coarse_face += uint64_t(blockDim.x) * gridDim.x) {
        uint64_t plane = 0, a = 0, b = 0;
        if (axis == 0) {
            plane = coarse_face % (coarse.grid[0] + 1);
            const uint64_t yz = coarse_face / (coarse.grid[0] + 1);
            a = yz % coarse.grid[1];
            b = yz / coarse.grid[1];
        } else if (axis == 1) {
            a = coarse_face % coarse.grid[0];
            const uint64_t pz = coarse_face / coarse.grid[0];
            plane = pz % (coarse.grid[1] + 1);
            b = pz / (coarse.grid[1] + 1);
        } else {
            a = coarse_face % coarse.grid[0];
            const uint64_t yp = coarse_face / coarse.grid[0];
            const uint64_t y = yp % coarse.grid[1];
            plane = yp / coarse.grid[1];
            b = y;
        }
        if (plane == 0 || plane == coarse.grid[axis]) {
            (axis == 0 ? coarse.gx : axis == 1 ? coarse.gy : coarse.gz)[coarse_face] =
                0.0;
            continue;
        }
        double weight = 0.0;
        const uint32_t tangent_a = axis == 0 ? 1 : 0;
        const uint32_t tangent_b = axis == 2 ? 1 : 2;
        const uint32_t count_u = coarse.coarsen_from_parent[tangent_a];
        const uint32_t count_v = coarse.coarsen_from_parent[tangent_b];
        for (uint32_t u = 0; u < count_u; ++u)
            for (uint32_t v = 0; v < count_v; ++v) {
                uint64_t x = 0, y = 0, z = 0;
                if (axis == 0) {
                    x = coarse.coarsen_from_parent[0] * plane;
                    y = coarse.coarsen_from_parent[1] * a + u;
                    z = coarse.coarsen_from_parent[2] * b + v;
                } else if (axis == 1) {
                    x = coarse.coarsen_from_parent[0] * a + u;
                    y = coarse.coarsen_from_parent[1] * plane;
                    z = coarse.coarsen_from_parent[2] * b + v;
                } else {
                    x = coarse.coarsen_from_parent[0] * a + u;
                    y = coarse.coarsen_from_parent[1] * b + v;
                    z = coarse.coarsen_from_parent[2] * plane;
                }
                if (x >= previous.grid[0] || y >= previous.grid[1] ||
                    z >= previous.grid[2])
                    continue;
                uint64_t left_coord[3]{x, y, z};
                uint64_t right_coord[3]{x, y, z};
                --left_coord[axis];
                const uint64_t left = cell_index(previous.grid, left_coord[0],
                                                 left_coord[1], left_coord[2]);
                const uint64_t right = cell_index(previous.grid, right_coord[0],
                                                  right_coord[1], right_coord[2]);
                weight += edge_at(op, previous, previous_index, axis, left, right,
                                  left_coord[0], left_coord[1], left_coord[2],
                                  right_coord[axis]);
            }
        (axis == 0 ? coarse.gx : axis == 1 ? coarse.gy : coarse.gz)[coarse_face] =
            weight;
    }
}

__global__ void finalize_level_kernel(Level level) {
    for (uint64_t cell = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         cell < level.cells; cell += uint64_t(blockDim.x) * gridDim.x) {
        if (!level.active[cell]) {
            level.strong_edges[cell] = 0;
            continue;
        }
        uint64_t x = 0, y = 0, z = 0;
        coordinates(level.grid, cell, x, y, z);
        const uint64_t c[3]{x, y, z};
        double weights[6]{};
        for (uint32_t axis = 0; axis < 3; ++axis) {
            if (c[axis] > 0)
                weights[2 * axis] = level_face(level, axis, x, y, z, c[axis]);
            if (c[axis] + 1 < level.grid[axis])
                weights[2 * axis + 1] =
                    level_face(level, axis, x, y, z, c[axis] + 1);
        }
        double maximum = 0.0;
        double edge_sum = 0.0;
        for (double weight : weights) {
            maximum = fmax(maximum, weight);
            edge_sum += weight;
        }
        uint8_t mask = 0;
        if (maximum > 0.0)
            for (uint32_t edge = 0; edge < 6; ++edge)
                if (weights[edge] >= kStrongThreshold * maximum)
                    mask |= uint8_t(1u << edge);
        level.strong_edges[cell] = mask;
        for (uint32_t component = 0; component < 3; ++component)
            level.diagonal[component * level.cells + cell] += edge_sum;
    }
}

__device__ void apply_fine(const Operator &op, const double *input,
                           double *output, cg::grid_group grid_group) {
    const uint64_t cells = op.grid[0] * op.grid[1] * op.grid[2];
    const uint64_t unknowns = 3 * cells;
    for (uint64_t unknown = grid_group.thread_rank(); unknown < unknowns;
         unknown += grid_group.size()) {
        const uint32_t component = uint32_t(unknown / cells);
        const uint64_t cell = unknown - uint64_t(component) * cells;
        if (!op.active[cell]) {
            output[unknown] = input[unknown];
            continue;
        }
        double value = 0.0;
        for (uint32_t column = 0; column < 3; ++column)
            value += op.local_block_soa[(component * 3 + column) * cells + cell] *
                     input[uint64_t(column) * cells + cell];
        uint64_t x = 0, y = 0, z = 0;
        coordinates(op.grid, cell, x, y, z);
        const uint64_t coord[3]{x, y, z};
        for (uint32_t axis = 0; axis < 3; ++axis) {
            if (coord[axis] > 0) {
                uint64_t neighbor_coord[3]{x, y, z};
                --neighbor_coord[axis];
                const uint64_t neighbor = cell_index(op.grid, neighbor_coord[0],
                                                     neighbor_coord[1],
                                                     neighbor_coord[2]);
                const double weight = fine_edge(op, axis, neighbor, cell);
                value += weight * (input[unknown] -
                                   input[uint64_t(component) * cells + neighbor]);
            }
            if (coord[axis] + 1 < op.grid[axis]) {
                uint64_t neighbor_coord[3]{x, y, z};
                ++neighbor_coord[axis];
                const uint64_t neighbor = cell_index(op.grid, neighbor_coord[0],
                                                     neighbor_coord[1],
                                                     neighbor_coord[2]);
                const double weight = fine_edge(op, axis, cell, neighbor);
                value += weight * (input[unknown] -
                                   input[uint64_t(component) * cells + neighbor]);
            }
        }
        if (op.interface_row_offsets != nullptr) {
            const uint64_t begin = op.interface_row_offsets[cell];
            const uint64_t end = op.interface_row_offsets[cell + 1];
            for (uint64_t entry = begin; entry < end; ++entry) {
                const uint64_t neighbor = op.interface_columns[entry];
                for (uint32_t column = 0; column < 3; ++column)
                    value += op.interface_blocks_soa[
                                 (component * 3 + column) *
                                     op.interface_nonzeros +
                                 entry] *
                             input[uint64_t(column) * cells + neighbor];
            }
        }
        output[unknown] = value;
    }
    grid_group.sync();
}

__device__ void apply_coarse(const Level &level, const double *input,
                             double *output, cg::grid_group grid_group) {
    const uint64_t unknowns = 3 * level.cells;
    for (uint64_t unknown = grid_group.thread_rank(); unknown < unknowns;
         unknown += grid_group.size()) {
        const uint32_t component = uint32_t(unknown / level.cells);
        const uint64_t cell = unknown - uint64_t(component) * level.cells;
        if (!level.active[cell]) {
            output[unknown] = input[unknown];
            continue;
        }
        uint64_t x = 0, y = 0, z = 0;
        coordinates(level.grid, cell, x, y, z);
        const uint64_t coord[3]{x, y, z};
        double value = level.diagonal[unknown] * input[unknown];
        for (uint32_t axis = 0; axis < 3; ++axis) {
            if (coord[axis] > 0) {
                uint64_t n[3]{x, y, z};
                --n[axis];
                const uint64_t neighbor = cell_index(level.grid, n[0], n[1], n[2]);
                value -= level_face(level, axis, x, y, z, coord[axis]) *
                         input[uint64_t(component) * level.cells + neighbor];
            }
            if (coord[axis] + 1 < level.grid[axis]) {
                uint64_t n[3]{x, y, z};
                ++n[axis];
                const uint64_t neighbor = cell_index(level.grid, n[0], n[1], n[2]);
                value -= level_face(level, axis, x, y, z, coord[axis] + 1) *
                         input[uint64_t(component) * level.cells + neighbor];
            }
        }
        output[unknown] = value;
    }
    grid_group.sync();
}

__device__ double deterministic_dot(const double *left, const double *right,
                                    uint64_t count, double *partials,
                                    double *result,
                                    cg::grid_group grid_group) {
    extern __shared__ double shared[];
    double local = 0.0;
    for (uint64_t index = grid_group.thread_rank(); index < count;
         index += grid_group.size())
        local += left[index] * right[index];
    shared[threadIdx.x] = local;
    __syncthreads();
    for (uint32_t stride = blockDim.x / 2; stride != 0; stride >>= 1) {
        if (threadIdx.x < stride) shared[threadIdx.x] += shared[threadIdx.x + stride];
        __syncthreads();
    }
    if (threadIdx.x == 0) partials[blockIdx.x] = shared[0];
    grid_group.sync();
    if (grid_group.thread_rank() == 0) {
        double total = 0.0;
        for (uint32_t block = 0; block < gridDim.x; ++block)
            total += partials[block];
        *result = total;
    }
    grid_group.sync();
    return *result;
}

__device__ void vector_copy_scale(const double *source, double *destination,
                                  uint64_t count, double scale,
                                  cg::grid_group grid_group) {
    for (uint64_t i = grid_group.thread_rank(); i < count; i += grid_group.size())
        destination[i] = scale * source[i];
    grid_group.sync();
}

__device__ void vector_axpy(double *target, const double *source, uint64_t count,
                            double scale, cg::grid_group grid_group) {
    for (uint64_t i = grid_group.thread_rank(); i < count; i += grid_group.size())
        target[i] += scale * source[i];
    grid_group.sync();
}

__device__ uint64_t coarse_offset(const HierarchyCache &hierarchy,
                                  uint32_t level_index) {
    uint64_t offset = 0;
    for (uint32_t level = 1; level < level_index; ++level)
        offset += 15 * hierarchy.levels[level].cells;
    return offset;
}

__device__ void restrict_geometric(const double *fine, uint64_t fine_cells,
                                   const Triple<uint64_t> &fine_grid,
                                   double *coarse, const Level &coarse_level,
                                   cg::grid_group grid_group) {
    const uint64_t values = 3 * coarse_level.cells;
    for (uint64_t value = grid_group.thread_rank(); value < values;
         value += grid_group.size()) {
        const uint32_t component = uint32_t(value / coarse_level.cells);
        const uint64_t coarse_cell = value - uint64_t(component) * coarse_level.cells;
        uint64_t cx = 0, cy = 0, cz = 0;
        coordinates(coarse_level.grid, coarse_cell, cx, cy, cz);
        double sum = 0.0;
        for (uint32_t dz = 0; dz < coarse_level.coarsen_from_parent[2]; ++dz)
            for (uint32_t dy = 0; dy < coarse_level.coarsen_from_parent[1]; ++dy)
                for (uint32_t dx = 0; dx < coarse_level.coarsen_from_parent[0]; ++dx) {
                    const uint64_t x = coarse_level.coarsen_from_parent[0] * cx + dx;
                    const uint64_t y = coarse_level.coarsen_from_parent[1] * cy + dy;
                    const uint64_t z = coarse_level.coarsen_from_parent[2] * cz + dz;
                    if (x < fine_grid[0] && y < fine_grid[1] && z < fine_grid[2])
                        sum += fine[uint64_t(component) * fine_cells +
                                    cell_index(fine_grid, x, y, z)];
                }
        coarse[value] = sum;
    }
    grid_group.sync();
}

__device__ void prolong_geometric(const double *coarse, const Level &coarse_level,
                                  double *fine, uint64_t fine_cells,
                                  const Triple<uint64_t> &fine_grid,
                                  cg::grid_group grid_group) {
    const uint64_t values = 3 * fine_cells;
    for (uint64_t value = grid_group.thread_rank(); value < values;
         value += grid_group.size()) {
        const uint32_t component = uint32_t(value / fine_cells);
        const uint64_t fine_cell = value - uint64_t(component) * fine_cells;
        uint64_t x = 0, y = 0, z = 0;
        coordinates(fine_grid, fine_cell, x, y, z);
        const uint64_t parent = cell_index(
            coarse_level.grid, x / coarse_level.coarsen_from_parent[0],
            y / coarse_level.coarsen_from_parent[1],
            z / coarse_level.coarsen_from_parent[2]);
        fine[value] += coarse[uint64_t(component) * coarse_level.cells + parent];
    }
    grid_group.sync();
}

__device__ void block_jacobi(const Operator &op, const double *input,
                             double *output, cg::grid_group grid_group) {
    const uint64_t cells = op.grid[0] * op.grid[1] * op.grid[2];
    for (uint64_t cell = grid_group.thread_rank(); cell < cells;
         cell += grid_group.size()) {
        if (!op.active[cell]) {
            for (uint32_t component = 0; component < 3; ++component)
                output[uint64_t(component) * cells + cell] =
                    input[uint64_t(component) * cells + cell];
            continue;
        }
        double a[9];
        for (uint32_t i = 0; i < 9; ++i)
            a[i] = op.local_block_soa[uint64_t(i) * cells + cell];
        uint64_t x = 0, y = 0, z = 0;
        coordinates(op.grid, cell, x, y, z);
        const uint64_t coord[3]{x, y, z};
        double diffusion_diagonal = 0.0;
        for (uint32_t axis = 0; axis < 3; ++axis) {
            if (coord[axis] > 0) {
                uint64_t n[3]{x, y, z};
                --n[axis];
                diffusion_diagonal += fine_edge(
                    op, axis, cell_index(op.grid, n[0], n[1], n[2]), cell);
            }
            if (coord[axis] + 1 < op.grid[axis]) {
                uint64_t n[3]{x, y, z};
                ++n[axis];
                diffusion_diagonal += fine_edge(
                    op, axis, cell, cell_index(op.grid, n[0], n[1], n[2]));
            }
        }
        a[0] += diffusion_diagonal;
        a[4] += diffusion_diagonal;
        a[8] += diffusion_diagonal;
        const double determinant =
            a[0] * (a[4] * a[8] - a[5] * a[7]) -
            a[1] * (a[3] * a[8] - a[5] * a[6]) +
            a[2] * (a[3] * a[7] - a[4] * a[6]);
        const double rhs[3]{input[cell], input[cells + cell],
                            input[2 * cells + cell]};
        if (!isfinite(determinant) || fabs(determinant) < DBL_MIN) {
            for (uint32_t component = 0; component < 3; ++component)
                output[uint64_t(component) * cells + cell] =
                    rhs[component] / a[component * 3 + component];
            continue;
        }
        const double inverse[9]{
            (a[4]*a[8]-a[5]*a[7])/determinant,
            (a[2]*a[7]-a[1]*a[8])/determinant,
            (a[1]*a[5]-a[2]*a[4])/determinant,
            (a[5]*a[6]-a[3]*a[8])/determinant,
            (a[0]*a[8]-a[2]*a[6])/determinant,
            (a[2]*a[3]-a[0]*a[5])/determinant,
            (a[3]*a[7]-a[4]*a[6])/determinant,
            (a[1]*a[6]-a[0]*a[7])/determinant,
            (a[0]*a[4]-a[1]*a[3])/determinant};
        for (uint32_t row = 0; row < 3; ++row)
            output[uint64_t(row) * cells + cell] =
                inverse[3*row] * rhs[0] + inverse[3*row+1] * rhs[1] +
                inverse[3*row+2] * rhs[2];
    }
    grid_group.sync();
}

__device__ void level_jacobi_sweep(const Level &level, const double *rhs,
                                   double *x, double *temporary,
                                   cg::grid_group grid_group) {
    apply_coarse(level, x, temporary, grid_group);
    for (uint64_t i = grid_group.thread_rank(); i < 3 * level.cells;
         i += grid_group.size())
        x[i] += kJacobiWeight * (rhs[i] - temporary[i]) / level.diagonal[i];
    grid_group.sync();
}

__device__ void fine_block_jacobi_sweep(const Operator &op,
                                        const double *rhs, double *x,
                                        double *temporary,
                                        cg::grid_group grid_group) {
    const uint64_t values =
        3 * op.grid[0] * op.grid[1] * op.grid[2];
    apply_fine(op, x, temporary, grid_group);
    for (uint64_t i = grid_group.thread_rank(); i < values;
         i += grid_group.size())
        temporary[i] = rhs[i] - temporary[i];
    grid_group.sync();
    // The block inverse is cell-local, so the residual may be transformed
    // in-place before the weighted correction is accumulated.
    block_jacobi(op, temporary, temporary, grid_group);
    vector_axpy(x, temporary, values, kJacobiWeight, grid_group);
}

__device__ void coarse_chebyshev_solve(const Level &level, const double *rhs,
                                       double *x, double *temporary,
                                       double *direction,
                                       double *scaled_residual,
                                       double *coefficients,
                                       cg::grid_group grid_group) {
    // Gershgorin bounds for D^-1 A depend only on the cached operator. They
    // therefore preserve a fixed linear preconditioner, unlike RHS-dependent
    // CG coefficients or convergence exits. The component coarse operators
    // are symmetric reaction-diffusion M-matrices.
    if (grid_group.thread_rank() == 0) {
        double lower = 1.0;
        double upper = 1.0;
        for (uint64_t cell = 0; cell < level.cells; ++cell) {
            if (!level.active[cell]) continue;
            uint64_t x_coordinate = 0, y_coordinate = 0, z_coordinate = 0;
            coordinates(level.grid, cell, x_coordinate, y_coordinate,
                        z_coordinate);
            const uint64_t coordinate[3]{x_coordinate, y_coordinate,
                                         z_coordinate};
            double edge_sum = 0.0;
            for (uint32_t axis = 0; axis < 3; ++axis) {
                if (coordinate[axis] > 0)
                    edge_sum += level_face(level, axis, x_coordinate,
                                           y_coordinate, z_coordinate,
                                           coordinate[axis]);
                if (coordinate[axis] + 1 < level.grid[axis])
                    edge_sum += level_face(level, axis, x_coordinate,
                                           y_coordinate, z_coordinate,
                                           coordinate[axis] + 1);
            }
            for (uint32_t component = 0; component < 3; ++component) {
                const double diagonal =
                    level.diagonal[uint64_t(component) * level.cells + cell];
                const double radius = edge_sum / diagonal;
                lower = fmin(lower, 1.0 - radius);
                upper = fmax(upper, 1.0 + radius);
            }
        }
        // A positive reaction term makes the analytical lower bound positive.
        // The clamp only protects roundoff in extremely diffusion-dominated
        // cases and remains an operator-only, deterministic coefficient.
        lower = fmax(lower, DBL_EPSILON * upper);
        coefficients[0] = lower;
        coefficients[1] = upper;
    }
    grid_group.sync();

    const double lower = coefficients[0];
    const double upper = coefficients[1];
    const double theta = 0.5 * (upper + lower);
    const double delta = 0.5 * (upper - lower);
    const uint64_t values = 3 * level.cells;
    if (!(delta > DBL_EPSILON * theta)) {
        for (uint64_t i = grid_group.thread_rank(); i < values;
             i += grid_group.size())
            x[i] = rhs[i] / level.diagonal[i];
        grid_group.sync();
        return;
    }

    apply_coarse(level, x, temporary, grid_group);
    for (uint64_t i = grid_group.thread_rank(); i < values;
         i += grid_group.size()) {
        scaled_residual[i] =
            (rhs[i] - temporary[i]) / level.diagonal[i];
        direction[i] = scaled_residual[i] / theta;
        x[i] += direction[i];
    }
    grid_group.sync();

    const double sigma = theta / delta;
    double rho = 1.0 / sigma;
    for (uint32_t iteration = 1; iteration < kCoarseChebyshevDegree;
         ++iteration) {
        apply_coarse(level, x, temporary, grid_group);
        const double next_rho = 1.0 / (2.0 * sigma - rho);
        const double beta = next_rho * rho;
        const double alpha = 2.0 * next_rho / delta;
        for (uint64_t i = grid_group.thread_rank(); i < values;
             i += grid_group.size()) {
            scaled_residual[i] =
                (rhs[i] - temporary[i]) / level.diagonal[i];
            direction[i] = beta * direction[i] + alpha * scaled_residual[i];
            x[i] += direction[i];
        }
        grid_group.sync();
        rho = next_rho;
    }
}

__device__ void amg_precondition(const Operator &op,
                                 const HierarchyCache &hierarchy,
                                 Workspace workspace, const double *input,
                                 double *output, double *scratch,
                                 cg::grid_group grid_group,
                                 uint32_t requested_level_count,
                                 double *down_phase_residuals,
                                 double *up_phase_residuals) {
    const uint32_t level_count =
        requested_level_count < hierarchy.level_count
            ? requested_level_count
            : hierarchy.level_count;
    const uint64_t fine_cells = hierarchy.levels[0].cells;
    for (uint64_t i = grid_group.thread_rank(); i < 3 * fine_cells;
         i += grid_group.size())
        output[i] = 0.0;
    grid_group.sync();
    for (uint32_t sweep = 0; sweep < kFineSmoothingSweeps; ++sweep)
        fine_block_jacobi_sweep(op, input, output, scratch, grid_group);
    if (level_count <= 1) return;

    // Multiplicative V-cycle: restrict the residual after the fine 3x3
    // block-Jacobi pre-smooth. Restricting the original vector would form an
    // unscaled additive correction and loses mesh-independent convergence for
    // the reaction-diffusion stiffness ratios used by transport.
    apply_fine(op, output, scratch, grid_group);
    for (uint64_t i = grid_group.thread_rank(); i < 3 * fine_cells;
         i += grid_group.size())
        scratch[i] = input[i] - scratch[i];
    grid_group.sync();
    if (down_phase_residuals != nullptr) {
        double *audit_scalar = workspace.small + kScalarOffset + 12;
        const double rhs_squared = deterministic_dot(
            input, input, 3 * fine_cells, workspace.reduction_partials,
            audit_scalar, grid_group);
        const double residual_squared = deterministic_dot(
            scratch, scratch, 3 * fine_cells, workspace.reduction_partials,
            audit_scalar, grid_group);
        if (grid_group.thread_rank() == 0)
            down_phase_residuals[0] =
                sqrt(residual_squared / fmax(rhs_squared, DBL_MIN));
        grid_group.sync();
    }
    double *first_rhs = workspace.coarse_vectors;
    restrict_geometric(scratch, fine_cells, op.grid, first_rhs,
                       hierarchy.levels[1], grid_group);
    for (uint32_t level = 1; level < level_count; ++level) {
        const Level &current = hierarchy.levels[level];
        const uint64_t offset = coarse_offset(hierarchy, level);
        double *rhs = workspace.coarse_vectors + offset;
        double *x = rhs + 3 * current.cells;
        double *temporary = x + 3 * current.cells;
        double *direction = temporary + 3 * current.cells;
        double *operator_direction = direction + 3 * current.cells;
        for (uint64_t i = grid_group.thread_rank(); i < 3 * current.cells;
             i += grid_group.size())
            x[i] = 0.0;
        grid_group.sync();
        if (level + 1 < level_count) {
            for (uint32_t sweep = 0; sweep < kIntermediateSmoothingSweeps;
                 ++sweep)
                level_jacobi_sweep(current, rhs, x, temporary, grid_group);
            apply_coarse(current, x, temporary, grid_group);
            for (uint64_t i = grid_group.thread_rank();
                 i < 3 * current.cells; i += grid_group.size())
                temporary[i] = rhs[i] - temporary[i];
            grid_group.sync();
            if (down_phase_residuals != nullptr) {
                double *audit_scalar = workspace.small + kScalarOffset + 12;
                const double rhs_squared = deterministic_dot(
                    rhs, rhs, 3 * current.cells,
                    workspace.reduction_partials, audit_scalar, grid_group);
                const double residual_squared = deterministic_dot(
                    temporary, temporary, 3 * current.cells,
                    workspace.reduction_partials, audit_scalar, grid_group);
                if (grid_group.thread_rank() == 0)
                    down_phase_residuals[level] =
                        sqrt(residual_squared / fmax(rhs_squared, DBL_MIN));
                grid_group.sync();
            }
            restrict_geometric(temporary, current.cells, current.grid,
                               workspace.coarse_vectors +
                                   coarse_offset(hierarchy, level + 1),
                               hierarchy.levels[level + 1], grid_group);
        } else {
            coarse_chebyshev_solve(
                current, rhs, x, temporary, direction, operator_direction,
                workspace.small + kScalarOffset + 4, grid_group);
            if (down_phase_residuals != nullptr) {
                apply_coarse(current, x, temporary, grid_group);
                for (uint64_t i = grid_group.thread_rank();
                     i < 3 * current.cells; i += grid_group.size())
                    temporary[i] = rhs[i] - temporary[i];
                grid_group.sync();
                double *audit_scalar = workspace.small + kScalarOffset + 12;
                const double rhs_squared = deterministic_dot(
                    rhs, rhs, 3 * current.cells,
                    workspace.reduction_partials, audit_scalar, grid_group);
                const double residual_squared = deterministic_dot(
                    temporary, temporary, 3 * current.cells,
                    workspace.reduction_partials, audit_scalar, grid_group);
                if (grid_group.thread_rank() == 0)
                    down_phase_residuals[level] =
                        sqrt(residual_squared / fmax(rhs_squared, DBL_MIN));
                grid_group.sync();
            }
        }
    }
    for (uint32_t level = level_count - 1; level > 1; --level) {
        const Level &coarse = hierarchy.levels[level];
        const Level &fine = hierarchy.levels[level - 1];
        double *coarse_x = workspace.coarse_vectors + coarse_offset(hierarchy, level) +
                           3 * coarse.cells;
        double *fine_rhs = workspace.coarse_vectors +
                           coarse_offset(hierarchy, level - 1);
        double *fine_x = fine_rhs + 3 * fine.cells;
        double *fine_tmp = fine_x + 3 * fine.cells;
        prolong_geometric(coarse_x, coarse, fine_x, fine.cells, fine.grid,
                          grid_group);
        for (uint32_t sweep = 0; sweep < kIntermediateSmoothingSweeps; ++sweep)
            level_jacobi_sweep(fine, fine_rhs, fine_x, fine_tmp, grid_group);
        if (up_phase_residuals != nullptr) {
            apply_coarse(fine, fine_x, fine_tmp, grid_group);
            for (uint64_t i = grid_group.thread_rank(); i < 3 * fine.cells;
                 i += grid_group.size())
                fine_tmp[i] = fine_rhs[i] - fine_tmp[i];
            grid_group.sync();
            double *audit_scalar = workspace.small + kScalarOffset + 12;
            const double rhs_squared = deterministic_dot(
                fine_rhs, fine_rhs, 3 * fine.cells,
                workspace.reduction_partials, audit_scalar, grid_group);
            const double residual_squared = deterministic_dot(
                fine_tmp, fine_tmp, 3 * fine.cells,
                workspace.reduction_partials, audit_scalar, grid_group);
            if (grid_group.thread_rank() == 0)
                up_phase_residuals[level - 1] =
                    sqrt(residual_squared / fmax(rhs_squared, DBL_MIN));
            grid_group.sync();
        }
    }
    double *level_one_x = workspace.coarse_vectors +
                          3 * hierarchy.levels[1].cells;
    prolong_geometric(level_one_x, hierarchy.levels[1], output, fine_cells,
                      op.grid, grid_group);
    for (uint32_t sweep = 0; sweep < kFineSmoothingSweeps; ++sweep)
        fine_block_jacobi_sweep(op, input, output, scratch, grid_group);
    if (up_phase_residuals != nullptr) {
        apply_fine(op, output, scratch, grid_group);
        for (uint64_t i = grid_group.thread_rank(); i < 3 * fine_cells;
             i += grid_group.size())
            scratch[i] = input[i] - scratch[i];
        grid_group.sync();
        double *audit_scalar = workspace.small + kScalarOffset + 12;
        const double rhs_squared = deterministic_dot(
            input, input, 3 * fine_cells, workspace.reduction_partials,
            audit_scalar, grid_group);
        const double residual_squared = deterministic_dot(
            scratch, scratch, 3 * fine_cells, workspace.reduction_partials,
            audit_scalar, grid_group);
        if (grid_group.thread_rank() == 0)
            up_phase_residuals[0] =
                sqrt(residual_squared / fmax(rhs_squared, DBL_MIN));
        grid_group.sync();
    }
}

__device__ void apply_preconditioner(const Operator &op,
                                     const HierarchyCache &hierarchy,
                                     Workspace workspace, const double *input,
                                     double *output, double *scratch,
                                     cg::grid_group grid_group) {
    const uint64_t unknowns = 3 * hierarchy.levels[0].cells;
    if (op.preconditioner == PreconditionerPolicy::identity_diagnostic) {
        vector_copy_scale(input, output, unknowns, 1.0, grid_group);
        return;
    }
    if (op.preconditioner == PreconditionerPolicy::block_jacobi_diagnostic) {
        block_jacobi(op, input, output, grid_group);
        return;
    }
    amg_precondition(op, hierarchy, workspace, input, output, scratch,
                     grid_group, hierarchy.level_count, nullptr, nullptr);
}

__global__ void preconditioner_audit_kernel(
    Operator op, HierarchyCache hierarchy, Workspace workspace,
    DevicePreconditionerAudit *result) {
    cg::grid_group grid_group = cg::this_grid();
    const uint64_t unknowns = 3 * hierarchy.levels[0].cells;
    double *a = workspace.basis;
    double *b = a + unknowns;
    double *sum = b + unknowns;
    double *scaled_a = sum + unknowns;
    double *ma = scaled_a + unknowns;
    double *mb = ma + unknowns;
    double *m_sum = mb + unknowns;
    double *m_scaled_a = m_sum + unknowns;
    double *m_sum_repeat = m_scaled_a + unknowns;
    constexpr double scale = -0.375;
    for (uint64_t i = grid_group.thread_rank(); i < unknowns;
         i += grid_group.size()) {
        const double a_value =
            double(int64_t(i % 29) - 14) / 15.0;
        const double b_value =
            double(int64_t((7 * i + 3) % 31) - 15) / 16.0;
        a[i] = a_value;
        b[i] = b_value;
        sum[i] = a_value + b_value;
        scaled_a[i] = scale * a_value;
    }
    grid_group.sync();

    apply_preconditioner(op, hierarchy, workspace, a, ma,
                         workspace.vector_a, grid_group);
    apply_preconditioner(op, hierarchy, workspace, b, mb,
                         workspace.vector_a, grid_group);
    apply_preconditioner(op, hierarchy, workspace, sum, m_sum,
                         workspace.vector_a, grid_group);
    apply_preconditioner(op, hierarchy, workspace, scaled_a, m_scaled_a,
                         workspace.vector_a, grid_group);
    apply_preconditioner(op, hierarchy, workspace, sum, m_sum_repeat,
                         workspace.vector_a, grid_group);

    double *difference = workspace.vector_b;
    double *partials = workspace.reduction_partials;
    double *scalar = workspace.small + kScalarOffset + 8;
    for (uint64_t i = grid_group.thread_rank(); i < unknowns;
         i += grid_group.size())
        difference[i] = m_sum[i] - ma[i] - mb[i];
    grid_group.sync();
    const double additive_squared = deterministic_dot(
        difference, difference, unknowns, partials, scalar, grid_group);
    const double reference_squared = deterministic_dot(
        m_sum, m_sum, unknowns, partials, scalar, grid_group);

    for (uint64_t i = grid_group.thread_rank(); i < unknowns;
         i += grid_group.size())
        difference[i] = m_scaled_a[i] - scale * ma[i];
    grid_group.sync();
    const double homogeneity_squared = deterministic_dot(
        difference, difference, unknowns, partials, scalar, grid_group);
    const double scaled_reference_squared = deterministic_dot(
        m_scaled_a, m_scaled_a, unknowns, partials, scalar, grid_group);

    for (uint64_t i = grid_group.thread_rank(); i < unknowns;
         i += grid_group.size())
        difference[i] = m_sum_repeat[i] - m_sum[i];
    grid_group.sync();
    const double repeat_squared = deterministic_dot(
        difference, difference, unknowns, partials, scalar, grid_group);
    const double energy = deterministic_dot(sum, m_sum, unknowns, partials,
                                            scalar, grid_group);
    const double rhs_squared = deterministic_dot(
        op.rhs_soa, op.rhs_soa, unknowns, partials, scalar, grid_group);
    double *actual_output = workspace.basis;
    for (uint32_t depth = 1; depth <= hierarchy.level_count; ++depth) {
        amg_precondition(op, hierarchy, workspace, op.rhs_soa, actual_output,
                         workspace.vector_a, grid_group, depth,
                         depth == hierarchy.level_count
                             ? result->down_phase_residuals
                             : nullptr,
                         depth == hierarchy.level_count
                             ? result->up_phase_residuals
                             : nullptr);
        const double output_squared = deterministic_dot(
            actual_output, actual_output, unknowns, partials, scalar,
            grid_group);
        const double depth_energy = deterministic_dot(
            op.rhs_soa, actual_output, unknowns, partials, scalar, grid_group);
        apply_fine(op, actual_output, workspace.vector_c, grid_group);
        for (uint64_t i = grid_group.thread_rank(); i < unknowns;
             i += grid_group.size())
            difference[i] = op.rhs_soa[i] - workspace.vector_c[i];
        grid_group.sync();
        const double residual_squared = deterministic_dot(
            difference, difference, unknowns, partials, scalar, grid_group);
        if (grid_group.thread_rank() == 0) {
            result->residual_ratios[depth - 1] =
                sqrt(residual_squared / fmax(rhs_squared, DBL_MIN));
            result->energy_cosines[depth - 1] =
                depth_energy /
                sqrt(fmax(rhs_squared * output_squared, DBL_MIN));
        }
        grid_group.sync();
    }
    if (grid_group.thread_rank() == 0) {
        result->additive_relative_error =
            sqrt(additive_squared / fmax(reference_squared, DBL_MIN));
        result->homogeneity_relative_error = sqrt(
            homogeneity_squared / fmax(scaled_reference_squared, DBL_MIN));
        result->repeat_relative_error =
            sqrt(repeat_squared / fmax(reference_squared, DBL_MIN));
        result->energy = energy;
        result->level_count = hierarchy.level_count;
    }
}

__global__ void persistent_gmres_kernel(Operator op, HierarchyCache hierarchy,
                                        Workspace workspace,
                                        double relative_tolerance,
                                        uint64_t max_iterations,
                                        DeviceResult *result) {
    cg::grid_group grid_group = cg::this_grid();
    const uint64_t cells = hierarchy.levels[0].cells;
    const uint64_t unknowns = 3 * cells;
    double *residual = workspace.vector_a;
    double *preconditioned = workspace.vector_b;
    double *work = workspace.vector_c;
    double *small = workspace.small;
    double *partials = workspace.reduction_partials;
    double *scalar = small + kScalarOffset;

    apply_fine(op, op.solution_soa, work, grid_group);
    for (uint64_t i = grid_group.thread_rank(); i < unknowns; i += grid_group.size())
        residual[i] = op.rhs_soa[i] - work[i];
    grid_group.sync();
    const double rhs_norm = sqrt(deterministic_dot(op.rhs_soa, op.rhs_soa,
                                                   unknowns, partials, scalar,
                                                   grid_group));
    const double normalization = rhs_norm > 0.0 ? rhs_norm : 1.0;
    uint64_t iterations = 0;
    uint64_t applications = 0;
    double relative = sqrt(deterministic_dot(residual, residual, unknowns,
                                             partials, scalar, grid_group)) /
                      normalization;
    uint32_t reason = uint32_t(ConvergenceReason::maximum_iterations);
    uint32_t restart_count = 0;
    if (grid_group.thread_rank() == 0)
        result->restart_residuals[0] = relative;
    grid_group.sync();

    while (iterations < max_iterations && relative > relative_tolerance) {
        const double beta = relative * normalization;
        vector_copy_scale(residual, workspace.basis, unknowns, 1.0 / beta,
                          grid_group);
        if (grid_group.thread_rank() == 0) {
            for (uint32_t i = 0; i < kRestart + 1; ++i)
                small[kGOffset + i] = i == 0 ? beta : 0.0;
            for (uint32_t i = 0; i < (kRestart + 1) * kRestart; ++i)
                small[kHOffset + i] = 0.0;
        }
        grid_group.sync();
        uint32_t built = 0;
        for (uint32_t column = 0;
             column < kRestart && iterations < max_iterations; ++column) {
            const double *basis_column = workspace.basis + uint64_t(column) * unknowns;
            apply_preconditioner(op, hierarchy, workspace, basis_column,
                                 preconditioned, residual, grid_group);
            ++applications;
            apply_fine(op, preconditioned, work, grid_group);
            for (uint32_t row = 0; row <= column; ++row) {
                const double h = deterministic_dot(
                    work, workspace.basis + uint64_t(row) * unknowns,
                    unknowns, partials, scalar, grid_group);
                if (grid_group.thread_rank() == 0)
                    small[kHOffset + row * kRestart + column] = h;
                grid_group.sync();
                vector_axpy(work, workspace.basis + uint64_t(row) * unknowns,
                            unknowns, -h, grid_group);
            }
            // A deterministic second MGS pass is required for FP64 transport
            // operators whose diffusion and reaction scales differ by many
            // orders. It preserves the frozen restart=50 policy while avoiding
            // the residual floor of one-pass classical bring-up code.
            for (uint32_t row = 0; row <= column; ++row) {
                const double correction = deterministic_dot(
                    work, workspace.basis + uint64_t(row) * unknowns,
                    unknowns, partials, scalar, grid_group);
                if (grid_group.thread_rank() == 0)
                    small[kHOffset + row * kRestart + column] += correction;
                grid_group.sync();
                vector_axpy(work, workspace.basis + uint64_t(row) * unknowns,
                            unknowns, -correction, grid_group);
            }
            const double h_next = sqrt(deterministic_dot(
                work, work, unknowns, partials, scalar, grid_group));
            if (grid_group.thread_rank() == 0)
                small[kHOffset + (column + 1) * kRestart + column] = h_next;
            grid_group.sync();
            if (h_next > 0.0 && isfinite(h_next))
                vector_copy_scale(work,
                                  workspace.basis + uint64_t(column + 1) * unknowns,
                                  unknowns, 1.0 / h_next, grid_group);
            if (grid_group.thread_rank() == 0) {
                for (uint32_t row = 0; row < column; ++row) {
                    double &upper = small[kHOffset + row * kRestart + column];
                    double &lower = small[kHOffset + (row + 1) * kRestart + column];
                    const double rotated = small[kCsOffset + row] * upper +
                                           small[kSnOffset + row] * lower;
                    lower = -small[kSnOffset + row] * upper +
                            small[kCsOffset + row] * lower;
                    upper = rotated;
                }
                double &diagonal = small[kHOffset + column * kRestart + column];
                double &below = small[kHOffset + (column + 1) * kRestart + column];
                const double magnitude = hypot(diagonal, below);
                const double cosine = magnitude > 0.0 ? diagonal / magnitude : 1.0;
                const double sine = magnitude > 0.0 ? below / magnitude : 0.0;
                small[kCsOffset + column] = cosine;
                small[kSnOffset + column] = sine;
                diagonal = cosine * diagonal + sine * below;
                below = 0.0;
                const double old_g = small[kGOffset + column];
                small[kGOffset + column] = cosine * old_g;
                small[kGOffset + column + 1] = -sine * old_g;
                scalar[1] = fabs(small[kGOffset + column + 1]) / normalization;
            }
            grid_group.sync();
            ++iterations;
            built = column + 1;
            relative = scalar[1];
            if (!isfinite(relative) || relative <= relative_tolerance ||
                h_next == 0.0)
                break;
        }
        if (grid_group.thread_rank() == 0) {
            for (int row = int(built) - 1; row >= 0; --row) {
                double value = small[kGOffset + row];
                for (uint32_t column = uint32_t(row) + 1; column < built; ++column)
                    value -= small[kHOffset + uint32_t(row) * kRestart + column] *
                             small[kYOffset + column];
                small[kYOffset + uint32_t(row)] =
                    value / small[kHOffset + uint32_t(row) * kRestart + uint32_t(row)];
            }
        }
        grid_group.sync();
        for (uint64_t i = grid_group.thread_rank(); i < unknowns; i += grid_group.size()) {
            double combination = 0.0;
            for (uint32_t column = 0; column < built; ++column)
                combination += small[kYOffset + column] *
                               workspace.basis[uint64_t(column) * unknowns + i];
            residual[i] = combination;
        }
        grid_group.sync();
        apply_preconditioner(op, hierarchy, workspace, residual, preconditioned,
                             work, grid_group);
        vector_axpy(op.solution_soa, preconditioned, unknowns, 1.0, grid_group);
        apply_fine(op, op.solution_soa, work, grid_group);
        for (uint64_t i = grid_group.thread_rank(); i < unknowns;
             i += grid_group.size())
            residual[i] = op.rhs_soa[i] - work[i];
        grid_group.sync();
        relative = sqrt(deterministic_dot(residual, residual, unknowns,
                                          partials, scalar, grid_group)) /
                   normalization;
        ++restart_count;
        if (grid_group.thread_rank() == 0 && restart_count < 32)
            result->restart_residuals[restart_count] = relative;
        grid_group.sync();
        if (!isfinite(relative)) break;
    }
    if (relative <= relative_tolerance)
        reason = uint32_t(ConvergenceReason::converged);
    else if (!isfinite(relative))
        reason = uint32_t(ConvergenceReason::non_finite);
    if (grid_group.thread_rank() == 0) {
        result->iterations = iterations;
        result->amg_applications = applications;
        result->reason = reason;
        result->relative_residual = relative;
        result->restart_count = restart_count;
    }
}

bool valid_operator(const Operator &input) {
    const uint64_t cells = cells_of(input.grid);
    if (cells == 0 || input.active == nullptr || input.spin_conductivity == nullptr ||
        input.local_block_soa == nullptr || input.rhs_soa == nullptr ||
        input.solution_soa == nullptr || input.operator_revision == 0)
        return false;
    if (input.preconditioner != PreconditionerPolicy::identity_diagnostic &&
        input.preconditioner != PreconditionerPolicy::block_jacobi_diagnostic &&
        input.preconditioner !=
            PreconditionerPolicy::component_amg_block_jacobi_v1)
        return false;
    for (uint32_t axis = 0; axis < 3; ++axis)
        if (!std::isfinite(input.cell_size[axis]) || input.cell_size[axis] <= 0.0)
            return false;
    if (input.interface_nonzeros != 0 &&
        (input.interface_row_offsets == nullptr || input.interface_columns == nullptr ||
         input.interface_blocks_soa == nullptr))
        return false;
    return true;
}

bool same_grid(const Triple<uint64_t> &left, const Triple<uint64_t> &right) {
    return left[0] == right[0] && left[1] == right[1] && left[2] == right[2];
}

bool same_digest(const uint8_t left[32], const uint8_t right[32]) {
    return std::memcmp(left, right, 32) == 0;
}

ByteLedger ledger_for(const Operator &input, const HierarchyCache &hierarchy,
                      const Workspace &workspace) {
    ByteLedger ledger{};
    ledger.external_context = input.resident_external_bytes;
    ledger.hierarchy = hierarchy.owned_bytes;
    uint64_t basis_values = (kRestart + 1) * workspace.vector_unknowns;
    ledger.krylov_basis = basis_values * sizeof(double);
    ledger.work_vectors = 3 * workspace.vector_unknowns * sizeof(double);
    ledger.coarse_vectors = workspace.coarse_vector_values * sizeof(double);
    ledger.reductions_and_scalars =
        workspace.reduction_blocks * sizeof(double) +
        kSmallValues * sizeof(double) + kDeviceStatusBytes;
    ledger.total_high_water = ledger.external_context + ledger.hierarchy +
                              ledger.krylov_basis + ledger.work_vectors +
                              ledger.coarse_vectors +
                              ledger.reductions_and_scalars;
    return ledger;
}

} // namespace

void release(Workspace *workspace) noexcept {
    if (workspace == nullptr) return;
    void *pointers[] = {workspace->basis, workspace->vector_a,
                        workspace->vector_b, workspace->vector_c,
                        workspace->coarse_vectors,
                        workspace->reduction_partials, workspace->small,
                        workspace->device_status};
    for (void *pointer : pointers)
        if (pointer != nullptr) (void)cudaFree(pointer);
    *workspace = {};
}

void release(HierarchyCache *hierarchy) noexcept {
    if (hierarchy == nullptr) return;
    for (Level &level : hierarchy->levels) free_level(level);
    *hierarchy = {};
}

uint32_t prepare(const Operator &input, cudaStream_t stream,
                 HierarchyCache *hierarchy, Workspace *workspace,
                 BuildMetrics *metrics) noexcept {
    if (hierarchy == nullptr || workspace == nullptr || metrics == nullptr ||
        stream == nullptr || !valid_operator(input))
        return invalid_argument;
    const uint64_t cells = cells_of(input.grid);
    const uint64_t unknowns = 3 * cells;
    if (hierarchy->valid && hierarchy->operator_revision == input.operator_revision &&
        same_digest(hierarchy->operator_digest, input.operator_digest) &&
        same_grid(hierarchy->fine_grid, input.grid) &&
        workspace->vector_unknowns == unknowns) {
        ++hierarchy->cache_hits;
        metrics->fine_unknowns = unknowns;
        metrics->coarse_unknowns =
            hierarchy->levels[hierarchy->level_count - 1].cells * 3;
        metrics->level_count = hierarchy->level_count;
        metrics->bytes = ledger_for(input, *hierarchy, *workspace);
        metrics->peak_device_bytes = metrics->bytes.total_high_water;
        return metrics->peak_device_bytes <= kDeviceBudgetBytes ? ok : resource_limit;
    }
    release(workspace);
    release(hierarchy);

    cudaEvent_t begin = nullptr;
    cudaEvent_t end = nullptr;
    if (cudaEventCreate(&begin) != cudaSuccess || cudaEventCreate(&end) != cudaSuccess)
        return cuda_failure;
    (void)cudaEventRecord(begin, stream);

    hierarchy->levels[0].grid = input.grid;
    hierarchy->levels[0].cells = cells;
    hierarchy->level_count = 1;
    unsigned long long *device_strength = nullptr;
    if (cudaMalloc(&device_strength, 3 * sizeof(unsigned long long)) != cudaSuccess) {
        (void)cudaEventDestroy(begin);
        (void)cudaEventDestroy(end);
        return out_of_memory;
    }
    while (hierarchy->level_count < kMaximumLevels &&
           hierarchy->levels[hierarchy->level_count - 1].cells > 32) {
        const uint32_t level_index = hierarchy->level_count;
        const Level &previous = hierarchy->levels[level_index - 1];
        Level &coarse = hierarchy->levels[level_index];
        unsigned long long host_strength[3]{};
        if (cudaMemsetAsync(device_strength, 0,
                            3 * sizeof(unsigned long long), stream) != cudaSuccess) {
            (void)cudaFree(device_strength);
            (void)cudaEventDestroy(begin);
            (void)cudaEventDestroy(end);
            release(hierarchy);
            return cuda_failure;
        }
        const uint32_t strength_blocks = uint32_t(std::min<uint64_t>(
            4096, (previous.cells + kThreads - 1) / kThreads));
        measure_direction_strength_kernel<<<strength_blocks, kThreads, 0, stream>>>(
            input, previous, level_index - 1, device_strength);
        if (cudaMemcpyAsync(host_strength, device_strength,
                            sizeof(host_strength), cudaMemcpyDeviceToHost,
                            stream) != cudaSuccess ||
            cudaStreamSynchronize(stream) != cudaSuccess) {
            (void)cudaFree(device_strength);
            (void)cudaEventDestroy(begin);
            (void)cudaEventDestroy(end);
            release(hierarchy);
            return cuda_failure;
        }
        double maximum_strength = 0.0;
        double strengths[3]{};
        for (uint32_t axis = 0; axis < 3; ++axis) {
            std::memcpy(&strengths[axis], &host_strength[axis], sizeof(double));
            maximum_strength = std::max(maximum_strength, strengths[axis]);
        }
        uint32_t strongest_axis = 0;
        for (uint32_t axis = 1; axis < 3; ++axis)
            if (strengths[axis] > strengths[strongest_axis]) strongest_axis = axis;
        coarse.strong_direction_mask = 0;
        for (uint32_t axis = 0; axis < 3; ++axis) {
            const bool strong = previous.grid[axis] > 1 &&
                ((maximum_strength > 0.0 &&
                  strengths[axis] >= kStrongThreshold * maximum_strength) ||
                 (maximum_strength == 0.0 && axis == strongest_axis));
            coarse.coarsen_from_parent[axis] = strong ? 2 : 1;
            if (strong) coarse.strong_direction_mask |= 1u << axis;
        }
        if (coarse.strong_direction_mask == 0) {
            for (uint32_t axis = 0; axis < 3; ++axis) {
                if (previous.grid[axis] > 1) {
                    coarse.coarsen_from_parent[axis] = 2;
                    coarse.strong_direction_mask = 1u << axis;
                    break;
                }
            }
        }
        coarse.grid = {{
            (previous.grid[0] + coarse.coarsen_from_parent[0] - 1) /
                coarse.coarsen_from_parent[0],
            (previous.grid[1] + coarse.coarsen_from_parent[1] - 1) /
                coarse.coarsen_from_parent[1],
            (previous.grid[2] + coarse.coarsen_from_parent[2] - 1) /
                coarse.coarsen_from_parent[2]}};
        coarse.cells = cells_of(coarse.grid);
        uint64_t level_bytes = 0;
        const uint64_t fx = face_count(coarse.grid, 0);
        const uint64_t fy = face_count(coarse.grid, 1);
        const uint64_t fz = face_count(coarse.grid, 2);
        if (coarse.cells == 0 || fx == 0 || fy == 0 || fz == 0 ||
            !allocate_values(&coarse.active, coarse.cells, &level_bytes) ||
            !allocate_values(&coarse.gx, fx, &level_bytes) ||
            !allocate_values(&coarse.gy, fy, &level_bytes) ||
            !allocate_values(&coarse.gz, fz, &level_bytes) ||
            !allocate_values(&coarse.diagonal, 3 * coarse.cells, &level_bytes) ||
            !allocate_values(&coarse.strong_edges, coarse.cells, &level_bytes)) {
            (void)cudaEventDestroy(begin);
            (void)cudaEventDestroy(end);
            (void)cudaFree(device_strength);
            release(hierarchy);
            return out_of_memory;
        }
        coarse.bytes = level_bytes;
        hierarchy->owned_bytes += level_bytes;
        const uint32_t blocks = uint32_t(std::min<uint64_t>(
            4096, (coarse.cells + kThreads - 1) / kThreads));
        build_level_cells_kernel<<<blocks, kThreads, 0, stream>>>(
            input, previous, level_index - 1, coarse);
        build_level_faces_kernel<<<uint32_t(std::min<uint64_t>(4096, (fx+kThreads-1)/kThreads)),
                                   kThreads, 0, stream>>>(input, previous,
                                                         level_index - 1,
                                                         coarse, 0, fx);
        build_level_faces_kernel<<<uint32_t(std::min<uint64_t>(4096, (fy+kThreads-1)/kThreads)),
                                   kThreads, 0, stream>>>(input, previous,
                                                         level_index - 1,
                                                         coarse, 1, fy);
        build_level_faces_kernel<<<uint32_t(std::min<uint64_t>(4096, (fz+kThreads-1)/kThreads)),
                                   kThreads, 0, stream>>>(input, previous,
                                                         level_index - 1,
                                                         coarse, 2, fz);
        finalize_level_kernel<<<blocks, kThreads, 0, stream>>>(coarse);
        if (cudaPeekAtLastError() != cudaSuccess) {
            (void)cudaEventDestroy(begin);
            (void)cudaEventDestroy(end);
            (void)cudaFree(device_strength);
            release(hierarchy);
            return cuda_failure;
        }
        ++hierarchy->level_count;
    }
    (void)cudaFree(device_strength);

    uint64_t workspace_bytes = 0;
    workspace->vector_unknowns = unknowns;
    uint64_t coarse_cells_sum = 0;
    for (uint32_t level = 1; level < hierarchy->level_count; ++level)
        coarse_cells_sum += hierarchy->levels[level].cells;
    workspace->coarse_vector_values = 15 * coarse_cells_sum;
    int device = 0;
    cudaDeviceProp properties{};
    if (cudaGetDevice(&device) != cudaSuccess ||
        cudaGetDeviceProperties(&properties, device) != cudaSuccess) {
        (void)cudaEventDestroy(begin);
        (void)cudaEventDestroy(end);
        release(hierarchy);
        return cuda_failure;
    }
    workspace->reduction_blocks = std::min<uint64_t>(
        uint64_t(properties.multiProcessorCount) * 2, 1024);
    if (!allocate_values(&workspace->basis, uint64_t(kRestart + 1) * unknowns,
                         &workspace_bytes) ||
        !allocate_values(&workspace->vector_a, unknowns, &workspace_bytes) ||
        !allocate_values(&workspace->vector_b, unknowns, &workspace_bytes) ||
        !allocate_values(&workspace->vector_c, unknowns, &workspace_bytes) ||
        !allocate_values(&workspace->coarse_vectors,
                         workspace->coarse_vector_values, &workspace_bytes) ||
        !allocate_values(&workspace->reduction_partials,
                         workspace->reduction_blocks, &workspace_bytes) ||
        !allocate_values(&workspace->small, kSmallValues, &workspace_bytes) ||
        !allocate_values(&workspace->device_status,
                         (kDeviceStatusBytes + sizeof(uint32_t) - 1) /
                             sizeof(uint32_t),
                         &workspace_bytes)) {
        (void)cudaEventDestroy(begin);
        (void)cudaEventDestroy(end);
        release(workspace);
        release(hierarchy);
        return out_of_memory;
    }
    workspace->owned_bytes = workspace_bytes;
    hierarchy->operator_revision = input.operator_revision;
    std::memcpy(hierarchy->operator_digest, input.operator_digest, 32);
    hierarchy->fine_grid = input.grid;
    hierarchy->valid = true;

    (void)cudaEventRecord(end, stream);
    if (cudaEventSynchronize(end) != cudaSuccess) {
        (void)cudaEventDestroy(begin);
        (void)cudaEventDestroy(end);
        release(workspace);
        release(hierarchy);
        return cuda_failure;
    }
    float milliseconds = 0.0f;
    (void)cudaEventElapsedTime(&milliseconds, begin, end);
    (void)cudaEventDestroy(begin);
    (void)cudaEventDestroy(end);
    metrics->fine_unknowns = unknowns;
    metrics->coarse_unknowns =
        hierarchy->levels[hierarchy->level_count - 1].cells * 3;
    metrics->level_count = hierarchy->level_count;
    metrics->setup_milliseconds = milliseconds;
    metrics->bytes = ledger_for(input, *hierarchy, *workspace);
    metrics->peak_device_bytes = metrics->bytes.total_high_water;
    if (metrics->peak_device_bytes > kDeviceBudgetBytes) {
        release(workspace);
        release(hierarchy);
        return resource_limit;
    }
    return ok;
}

uint32_t solve(const Operator &input, cudaStream_t stream,
               const HierarchyCache &hierarchy, Workspace &workspace,
               double relative_tolerance, uint64_t max_iterations,
               SolveMetrics *metrics) noexcept {
    if (metrics == nullptr || stream == nullptr || !valid_operator(input) ||
        !hierarchy.valid || hierarchy.operator_revision != input.operator_revision ||
        !same_digest(hierarchy.operator_digest, input.operator_digest) ||
        !same_grid(hierarchy.fine_grid, input.grid) ||
        workspace.vector_unknowns != 3 * cells_of(input.grid) ||
        !std::isfinite(relative_tolerance) || relative_tolerance <= 0.0 ||
        relative_tolerance >= 1.0 || max_iterations == 0)
        return invalid_argument;
    metrics->bytes = ledger_for(input, hierarchy, workspace);
    metrics->peak_device_bytes = metrics->bytes.total_high_water;
    if (metrics->peak_device_bytes > kDeviceBudgetBytes) return resource_limit;

    int device = 0;
    cudaDeviceProp properties{};
    int active_blocks_per_sm = 0;
    if (cudaGetDevice(&device) != cudaSuccess ||
        cudaGetDeviceProperties(&properties, device) != cudaSuccess ||
        !properties.cooperativeLaunch ||
        cudaOccupancyMaxActiveBlocksPerMultiprocessor(
            &active_blocks_per_sm, persistent_gmres_kernel, kThreads,
            kThreads * sizeof(double)) != cudaSuccess ||
        active_blocks_per_sm <= 0)
        return cuda_failure;
    uint32_t blocks = uint32_t(std::min<uint64_t>(
        workspace.reduction_blocks,
        uint64_t(active_blocks_per_sm) * properties.multiProcessorCount));
    DeviceResult *device_result =
        reinterpret_cast<DeviceResult *>(workspace.device_status);
    void *arguments[] = {const_cast<Operator *>(&input),
                         const_cast<HierarchyCache *>(&hierarchy), &workspace,
                         &relative_tolerance, &max_iterations, &device_result};
    cudaEvent_t begin = nullptr;
    cudaEvent_t end = nullptr;
    if (cudaEventCreate(&begin) != cudaSuccess || cudaEventCreate(&end) != cudaSuccess)
        return cuda_failure;
    (void)cudaEventRecord(begin, stream);
    if (cudaLaunchCooperativeKernel(
            reinterpret_cast<void *>(persistent_gmres_kernel), blocks, kThreads,
            arguments, kThreads * sizeof(double), stream) != cudaSuccess) {
        (void)cudaEventDestroy(begin);
        (void)cudaEventDestroy(end);
        return cuda_failure;
    }
    (void)cudaEventRecord(end, stream);
    DeviceResult host_result{};
    if (cudaMemcpyAsync(&host_result, device_result, sizeof(host_result),
                        cudaMemcpyDeviceToHost, stream) != cudaSuccess ||
        cudaStreamSynchronize(stream) != cudaSuccess) {
        (void)cudaEventDestroy(begin);
        (void)cudaEventDestroy(end);
        return cuda_failure;
    }
    float milliseconds = 0.0f;
    (void)cudaEventElapsedTime(&milliseconds, begin, end);
    (void)cudaEventDestroy(begin);
    (void)cudaEventDestroy(end);
    metrics->iterations = host_result.iterations;
    metrics->amg_applications = host_result.amg_applications;
    metrics->reason = static_cast<ConvergenceReason>(host_result.reason);
    metrics->relative_residual = host_result.relative_residual;
    metrics->restart_count = host_result.restart_count;
    std::memcpy(metrics->restart_residuals, host_result.restart_residuals,
                sizeof(metrics->restart_residuals));
    metrics->forbidden_transfer_bytes = 0;
    metrics->solve_milliseconds = milliseconds;
    // Timing is measured around the single persistent launch. Apply and
    // reductions are subsets, not separately synchronized host phases.
    metrics->apply_milliseconds = 0.0;
    metrics->reduction_milliseconds = 0.0;
    return metrics->reason == ConvergenceReason::converged ? ok : nonconverged;
}

uint32_t audit_preconditioner(const Operator &input, cudaStream_t stream,
                              const HierarchyCache &hierarchy,
                              Workspace &workspace,
                              PreconditionerAuditMetrics *metrics) noexcept {
    if (metrics == nullptr || stream == nullptr || !valid_operator(input) ||
        input.preconditioner !=
            PreconditionerPolicy::component_amg_block_jacobi_v1 ||
        !hierarchy.valid || hierarchy.operator_revision != input.operator_revision ||
        !same_digest(hierarchy.operator_digest, input.operator_digest) ||
        !same_grid(hierarchy.fine_grid, input.grid) ||
        workspace.vector_unknowns != 3 * cells_of(input.grid))
        return invalid_argument;

    int device = 0;
    cudaDeviceProp properties{};
    int active_blocks_per_sm = 0;
    if (cudaGetDevice(&device) != cudaSuccess ||
        cudaGetDeviceProperties(&properties, device) != cudaSuccess ||
        !properties.cooperativeLaunch ||
        cudaOccupancyMaxActiveBlocksPerMultiprocessor(
            &active_blocks_per_sm, preconditioner_audit_kernel, kThreads,
            kThreads * sizeof(double)) != cudaSuccess ||
        active_blocks_per_sm <= 0)
        return cuda_failure;
    const uint32_t blocks = uint32_t(std::min<uint64_t>(
        workspace.reduction_blocks,
        uint64_t(active_blocks_per_sm) * properties.multiProcessorCount));
    auto *device_result = reinterpret_cast<DevicePreconditionerAudit *>(
        workspace.device_status);
    void *arguments[] = {const_cast<Operator *>(&input),
                         const_cast<HierarchyCache *>(&hierarchy), &workspace,
                         &device_result};
    if (cudaLaunchCooperativeKernel(
            reinterpret_cast<void *>(preconditioner_audit_kernel), blocks,
            kThreads, arguments, kThreads * sizeof(double), stream) !=
        cudaSuccess)
        return cuda_failure;
    DevicePreconditionerAudit host_result{};
    if (cudaMemcpyAsync(&host_result, device_result, sizeof(host_result),
                        cudaMemcpyDeviceToHost, stream) != cudaSuccess ||
        cudaStreamSynchronize(stream) != cudaSuccess)
        return cuda_failure;
    metrics->additive_relative_error = host_result.additive_relative_error;
    metrics->homogeneity_relative_error =
        host_result.homogeneity_relative_error;
    metrics->repeat_relative_error = host_result.repeat_relative_error;
    metrics->energy = host_result.energy;
    metrics->level_count = host_result.level_count;
    std::memcpy(metrics->residual_ratios, host_result.residual_ratios,
                sizeof(metrics->residual_ratios));
    std::memcpy(metrics->energy_cosines, host_result.energy_cosines,
                sizeof(metrics->energy_cosines));
    std::memcpy(metrics->down_phase_residuals,
                host_result.down_phase_residuals,
                sizeof(metrics->down_phase_residuals));
    std::memcpy(metrics->up_phase_residuals,
                host_result.up_phase_residuals,
                sizeof(metrics->up_phase_residuals));
    return ok;
}

} // namespace fullmag::fdm::gpu::transport::spin::sparse
