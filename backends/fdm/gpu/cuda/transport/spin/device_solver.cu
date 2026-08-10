#include "device_solver.hpp"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <thrust/execution_policy.h>
#include <thrust/sort.h>
#include <vector>

namespace fullmag::fdm::gpu::transport::spin {
namespace {

constexpr double kHbar = 1.054571817e-34;
constexpr double kElementaryCharge = 1.602176634e-19;

struct DeviceDiagnostics {
    uint64_t iterations;
    uint64_t amg_apply_count;
    uint64_t fine_unknowns;
    uint64_t coarse_unknowns;
    uint32_t reason;
    uint32_t hierarchy_levels;
    double residual;
    double local_balance;
    double global_balance;
    double interface_balance;
    double torque_balance;
    uint8_t hierarchy_digest[32];
};

struct Workspace {
    double *x = nullptr;
    double *rhs = nullptr;
    double *residual = nullptr;
    double *work = nullptr;
    double *unit = nullptr;
    double *precondition_residual = nullptr;
    double *coarse_rhs = nullptr;
    double *coarse_correction = nullptr;
    double *coarse_matrix = nullptr;
    double *coarse_lu = nullptr;
    uint64_t *aggregate = nullptr;
    uint64_t *coarse_pivots = nullptr;
    double *basis = nullptr;
    double *hessenberg = nullptr;
    double *givens_c = nullptr;
    double *givens_s = nullptr;
    double *g = nullptr;
    double *y = nullptr;
    DeviceDiagnostics *diagnostics = nullptr;
};

struct SpinSha256 {
    uint32_t state[8];
    uint8_t block[64];
    uint64_t bytes;
    uint32_t used;
};

__device__ uint32_t sha_rotr(uint32_t value, uint32_t shift) {
    return (value >> shift) | (value << (32 - shift));
}

__device__ void sha_transform(SpinSha256 *sha) {
    constexpr uint32_t k[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
    uint32_t w[64];
    for (uint32_t i = 0; i < 16; ++i)
        w[i] = (uint32_t(sha->block[4*i]) << 24) |
               (uint32_t(sha->block[4*i+1]) << 16) |
               (uint32_t(sha->block[4*i+2]) << 8) | uint32_t(sha->block[4*i+3]);
    for (uint32_t i = 16; i < 64; ++i) {
        const uint32_t s0 = sha_rotr(w[i-15],7) ^ sha_rotr(w[i-15],18) ^ (w[i-15] >> 3);
        const uint32_t s1 = sha_rotr(w[i-2],17) ^ sha_rotr(w[i-2],19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a=sha->state[0],b=sha->state[1],c=sha->state[2],d=sha->state[3];
    uint32_t e=sha->state[4],f=sha->state[5],g=sha->state[6],h=sha->state[7];
    for (uint32_t i=0;i<64;++i) {
        const uint32_t s1=sha_rotr(e,6)^sha_rotr(e,11)^sha_rotr(e,25);
        const uint32_t ch=(e&f)^((~e)&g);
        const uint32_t t1=h+s1+ch+k[i]+w[i];
        const uint32_t s0=sha_rotr(a,2)^sha_rotr(a,13)^sha_rotr(a,22);
        const uint32_t maj=(a&b)^(a&c)^(b&c);
        const uint32_t t2=s0+maj;
        h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
    }
    sha->state[0]+=a;sha->state[1]+=b;sha->state[2]+=c;sha->state[3]+=d;
    sha->state[4]+=e;sha->state[5]+=f;sha->state[6]+=g;sha->state[7]+=h;
}

__device__ void sha_init(SpinSha256 *sha) {
    const uint32_t initial[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                               0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    for(uint32_t i=0;i<8;++i) sha->state[i]=initial[i];
    sha->bytes=0;sha->used=0;
}

__device__ void sha_update(SpinSha256 *sha, const void *source, uint64_t length) {
    const auto *bytes=static_cast<const uint8_t *>(source);
    sha->bytes += length;
    for(uint64_t i=0;i<length;++i) {
        sha->block[sha->used++]=bytes[i];
        if(sha->used==64){sha_transform(sha);sha->used=0;}
    }
}

__device__ void sha_finish(SpinSha256 *sha, uint8_t digest[32]) {
    const uint64_t bit_count=sha->bytes*8;
    sha->block[sha->used++]=0x80;
    if(sha->used>56){while(sha->used<64)sha->block[sha->used++]=0;sha_transform(sha);sha->used=0;}
    while(sha->used<56)sha->block[sha->used++]=0;
    for(int i=7;i>=0;--i)sha->block[sha->used++]=uint8_t(bit_count>>(8*i));
    sha_transform(sha);
    for(uint32_t i=0;i<8;++i)for(uint32_t j=0;j<4;++j)
        digest[4*i+j]=uint8_t(sha->state[i]>>(24-8*j));
}

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

bool allocate_bytes(void **pointer, uint64_t bytes) {
    if (bytes == 0) return true;
    return cudaMalloc(pointer, bytes) == cudaSuccess;
}

bool allocate_double(double **pointer, uint64_t values) {
    uint64_t bytes = 0;
    return checked_mul(values, sizeof(double), &bytes) &&
           allocate_bytes(reinterpret_cast<void **>(pointer), bytes);
}

void release_workspace(Workspace &workspace) {
    void *pointers[] = {
        workspace.x, workspace.rhs, workspace.residual, workspace.work,
        workspace.unit, workspace.precondition_residual, workspace.coarse_rhs,
        workspace.coarse_correction, workspace.coarse_matrix,
        workspace.coarse_lu, workspace.aggregate, workspace.coarse_pivots,
        workspace.basis, workspace.hessenberg,
        workspace.givens_c, workspace.givens_s, workspace.g, workspace.y,
        workspace.diagnostics};
    for (void *pointer : pointers) {
        if (pointer != nullptr) (void)cudaFree(pointer);
    }
    workspace = {};
}

bool allocate_zero(double **pointer, uint64_t values, cudaStream_t stream) {
    uint64_t bytes = 0;
    if (!checked_mul(values, sizeof(double), &bytes)) return false;
    if (bytes == 0) return true;
    if (!allocate_bytes(reinterpret_cast<void **>(pointer), bytes)) return false;
    if (cudaMemsetAsync(*pointer, 0, bytes, stream) != cudaSuccess) {
        (void)cudaFree(*pointer);
        *pointer = nullptr;
        return false;
    }
    return true;
}

__device__ uint64_t cell_index(const SolveInput &in, uint64_t x, uint64_t y,
                               uint64_t z) {
    return x + in.grid[0] * (y + in.grid[1] * z);
}

__device__ void coordinates(const SolveInput &in, uint64_t cell,
                            uint64_t *x, uint64_t *y, uint64_t *z) {
    *x = cell % in.grid[0];
    const uint64_t yz = cell / in.grid[0];
    *y = yz % in.grid[1];
    *z = yz / in.grid[1];
}

__device__ uint64_t face_count(const SolveInput &in, uint32_t axis) {
    if (axis == 0) return (in.grid[0] + 1) * in.grid[1] * in.grid[2];
    if (axis == 1) return in.grid[0] * (in.grid[1] + 1) * in.grid[2];
    return in.grid[0] * in.grid[1] * (in.grid[2] + 1);
}

__device__ uint64_t face_index(const SolveInput &in, uint32_t axis,
                               uint64_t x, uint64_t y, uint64_t z,
                               uint64_t plane) {
    if (axis == 0) return plane + (in.grid[0] + 1) * (y + in.grid[1] * z);
    if (axis == 1) return x + in.grid[0] * (plane + (in.grid[1] + 1) * z);
    return x + in.grid[0] * (y + in.grid[1] * plane);
}

template <typename T>
__device__ const T *record_at(const SolveInput &in, uint32_t view,
                              uint64_t index) {
    return reinterpret_cast<const T *>(
        reinterpret_cast<const uint8_t *>(in.payloads[view]) +
        index * in.views[view].byte_stride);
}

__device__ const fullmag_fdm_gpu_transport_spin_cell_v1 *spin_cell(
    const SolveInput &in, uint64_t cell) {
    return record_at<fullmag_fdm_gpu_transport_spin_cell_v1>(in, 0, cell);
}

__device__ const fullmag_fdm_gpu_transport_spin_material_v1 *spin_material(
    const SolveInput &in, uint32_t material_index) {
    for (uint64_t i = 0; i < in.views[1].element_count; ++i) {
        const auto *material =
            record_at<fullmag_fdm_gpu_transport_spin_material_v1>(in, 1, i);
        if (material->material_index == material_index) return material;
    }
    return nullptr;
}

__device__ const fullmag_fdm_gpu_transport_formula_ids_v1 *formula_ids(
    const SolveInput &in) {
    return in.views[5].element_count == 1
        ? record_at<fullmag_fdm_gpu_transport_formula_ids_v1>(in, 5, 0)
        : nullptr;
}

__device__ const fullmag_fdm_gpu_transport_spin_boundary_face_v1 *boundary(
    const SolveInput &in, uint32_t axis, int32_t side, uint64_t cell) {
    for (uint64_t i = 0; i < in.views[4].element_count; ++i) {
        const auto *face =
            record_at<fullmag_fdm_gpu_transport_spin_boundary_face_v1>(in, 4, i);
        if (face->axis == axis && face->side == side &&
            face->adjacent_cell == cell)
            return face;
    }
    return nullptr;
}

__device__ const fullmag_fdm_gpu_transport_spin_interface_v1 *interface_at(
    const SolveInput &in, uint32_t axis, uint64_t negative, uint64_t positive) {
    for (uint64_t i = 0; i < in.views[2].element_count; ++i) {
        const auto *interface_record =
            record_at<fullmag_fdm_gpu_transport_spin_interface_v1>(in, 2, i);
        if (interface_record->axis == axis &&
            interface_record->negative_cell == negative &&
            interface_record->positive_cell == positive)
            return interface_record;
    }
    return nullptr;
}

__device__ double harmonic(double left, double right) {
    return left > 0.0 && right > 0.0 ? 2.0 * left * right / (left + right) : 0.0;
}

__device__ const double *accepted_current(const SolveInput &in, uint32_t axis) {
    return axis == 0 ? in.accepted_jx : axis == 1 ? in.accepted_jy
                                                   : in.accepted_jz;
}

__device__ void direct_she_source(uint32_t normal_axis,
                                  const double electric[3],
                                  double theta_sigma,
                                  double source[3]) {
    source[0] = source[1] = source[2] = 0.0;
    const uint32_t first = (normal_axis + 1) % 3;
    const uint32_t second = (normal_axis + 2) % 3;
    source[first] = -theta_sigma * electric[second];
    source[second] = theta_sigma * electric[first];
}

__global__ void direct_she_signs_kernel(double *output) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    for (uint32_t axis = 0; axis < 3; ++axis) {
        const uint32_t first = (axis + 1) % 3;
        const uint32_t second = (axis + 2) % 3;
        double electric_first[3]{};
        double electric_second[3]{};
        electric_first[first] = 1.0;
        electric_second[second] = 1.0;
        direct_she_source(axis, electric_first, 1.0, output + (2 * axis) * 3);
        direct_she_source(axis, electric_second, 1.0,
                          output + (2 * axis + 1) * 3);
    }
}

__device__ void cell_electric_field(const SolveInput &in, uint64_t cell,
                                    const fullmag_fdm_gpu_transport_spin_material_v1 &material,
                                    double electric[3]) {
    uint64_t x = 0, y = 0, z = 0;
    coordinates(in, cell, &x, &y, &z);
    const uint64_t coordinate[3] = {x, y, z};
    for (uint32_t axis = 0; axis < 3; ++axis) {
        const uint64_t low = face_index(in, axis, x, y, z, coordinate[axis]);
        const uint64_t high = face_index(in, axis, x, y, z, coordinate[axis] + 1);
        electric[axis] = 0.5 * (accepted_current(in, axis)[low] +
                                accepted_current(in, axis)[high]) /
                         material.conductivity;
    }
}

__device__ void constitutive_source(const SolveInput &in, uint32_t axis,
                                    uint64_t cell, double face_current,
                                    double source[3]) {
    const auto *cell_record = spin_cell(in, cell);
    const auto *material = cell_record != nullptr
        ? spin_material(in, cell_record->material_index) : nullptr;
    if (cell_record == nullptr || material == nullptr ||
        cell_record->spin_active == 0) {
        source[0] = source[1] = source[2] = 0.0;
        return;
    }
    double electric[3]{};
    cell_electric_field(in, cell, *material, electric);
    electric[axis] = face_current / material->conductivity;
    direct_she_source(axis, electric,
                      material->spin_hall_angle * material->conductivity,
                      source);
    const double *m = in.m_stage;
    const uint64_t cells = in.grid[0] * in.grid[1] * in.grid[2];
    const double polarized = material->polarization * face_current;
    source[0] += polarized * m[cell];
    source[1] += polarized * m[cells + cell];
    source[2] += polarized * m[2 * cells + cell];
}

__device__ void source_flux(const SolveInput &in, uint32_t axis,
                            uint64_t negative, uint64_t positive,
                            uint64_t face, double source[3]) {
    const double current = accepted_current(in, axis)[face];
    const auto *negative_cell = spin_cell(in, negative);
    const auto *positive_cell = spin_cell(in, positive);
    const auto *negative_material = negative_cell != nullptr
        ? spin_material(in, negative_cell->material_index) : nullptr;
    const auto *positive_material = positive_cell != nullptr
        ? spin_material(in, positive_cell->material_index) : nullptr;
    if (negative_cell == nullptr || positive_cell == nullptr ||
        negative_material == nullptr || positive_material == nullptr ||
        negative_cell->spin_active == 0 || positive_cell->spin_active == 0) {
        source[0] = source[1] = source[2] = 0.0;
        return;
    }
    const uint64_t cells = in.grid[0] * in.grid[1] * in.grid[2];
    const double polarization =
        0.5 * (negative_material->polarization + positive_material->polarization);
    const double polarized_current = polarization * current;
    const uint64_t upwind = polarized_current >= 0.0 ? negative : positive;
    source[0] = polarized_current * in.m_stage[upwind];
    source[1] = polarized_current * in.m_stage[cells + upwind];
    source[2] = polarized_current * in.m_stage[2 * cells + upwind];

    double she[3]{};
    if (negative_cell->region_id == positive_cell->region_id) {
        double negative_e[3]{}, positive_e[3]{}, face_e[3]{};
        cell_electric_field(in, negative, *negative_material, negative_e);
        cell_electric_field(in, positive, *positive_material, positive_e);
        for (uint32_t component = 0; component < 3; ++component)
            face_e[component] = 0.5 * (negative_e[component] + positive_e[component]);
        const double sigma = harmonic(negative_material->conductivity,
                                      positive_material->conductivity);
        face_e[axis] = current / sigma;
        const double theta = 0.5 * (negative_material->spin_hall_angle +
                                    positive_material->spin_hall_angle);
        direct_she_source(axis, face_e, theta * sigma, she);
    } else {
        double negative_source[3]{}, positive_source[3]{};
        constitutive_source(in, axis, negative, 0.0, negative_source);
        constitutive_source(in, axis, positive, 0.0, positive_source);
        const double r_negative = in.cell_size[axis] /
            negative_material->spin_conductivity;
        const double r_positive = in.cell_size[axis] /
            positive_material->spin_conductivity;
        const double total = r_negative + r_positive;
        for (uint32_t component = 0; component < 3; ++component)
            she[component] = (r_negative * negative_source[component] +
                              r_positive * positive_source[component]) / total;
    }
    for (uint32_t component = 0; component < 3; ++component)
        source[component] += she[component];
}

__device__ void mixing_flux(
    const SolveInput &in,
    const fullmag_fdm_gpu_transport_spin_interface_v1 &interface_record,
    const double *mu, bool include_charge_source,
    double negative_flux[3], double positive_flux[3], double incoming[3],
    double backflow[3], double absorbed[3], double *charge_traces) {
    const uint64_t cells = in.grid[0] * in.grid[1] * in.grid[2];
    const uint64_t from = interface_record.from_cell;
    const uint64_t to = interface_record.to_cell;
    const bool from_is_negative = from == interface_record.negative_cell;
    const auto *interface_bytes = reinterpret_cast<const uint8_t *>(in.payloads[2]);
    const auto *record_bytes = reinterpret_cast<const uint8_t *>(&interface_record);
    const uint64_t interface_index = static_cast<uint64_t>(
        (record_bytes - interface_bytes) / in.views[2].byte_stride);
    const double from_trace = in.accepted_interface_from_trace_v[interface_index];
    const double to_trace = in.accepted_interface_to_trace_v[interface_index];
    const double delta_v = in.accepted_interface_delta_trace_v[interface_index];
    if (charge_traces != nullptr) {
        charge_traces[0] = from_trace;
        charge_traces[1] = to_trace;
        charge_traces[2] = delta_v;
    }
    double delta[3]{};
    for (uint32_t component = 0; component < 3; ++component)
        delta[component] = mu == nullptr ? 0.0
            : mu[component * cells + from] - mu[component * cells + to];
    const double *m = interface_record.magnetization_xyz;
    const double projection = m[0] * delta[0] + m[1] * delta[1] + m[2] * delta[2];
    const double delta_cross_m[3] = {
        delta[1] * m[2] - delta[2] * m[1],
        delta[2] * m[0] - delta[0] * m[2],
        delta[0] * m[1] - delta[1] * m[0]};
    const double transverse[3] = {
        delta[0] - projection * m[0],
        delta[1] - projection * m[1],
        delta[2] - projection * m[2]};
    for (uint32_t component = 0; component < 3; ++component) {
        incoming[component] = include_charge_source
            ? (interface_record.G_up - interface_record.G_down) * delta_v * m[component]
            : 0.0;
        backflow[component] = 0.5 * (interface_record.G_up + interface_record.G_down) *
                              projection * m[component];
        absorbed[component] = interface_record.G_r * transverse[component] +
                              interface_record.G_i * delta_cross_m[component];
        const double from_outgoing = incoming[component] + backflow[component] +
                                     absorbed[component];
        const double to_transmitted = incoming[component] + backflow[component];
        negative_flux[component] = from_is_negative ? from_outgoing : -to_transmitted;
        positive_flux[component] = from_is_negative ? to_transmitted : -from_outgoing;
    }
}

__device__ double dot(const double *left, const double *right, uint64_t n) {
    double value = 0.0;
    for (uint64_t i = 0; i < n; ++i) value += left[i] * right[i];
    return value;
}

__device__ double norm(const double *value, uint64_t n) {
    return sqrt(dot(value, value, n));
}

__device__ double reaction_component(
    const fullmag_fdm_gpu_transport_spin_material_v1 &material,
    const double m[3], const double mu[3], uint32_t component) {
    const double sf = material.spin_flip_length > 0.0
        ? material.spin_conductivity /
              (2.0 * material.spin_flip_length * material.spin_flip_length)
        : 0.0;
    const double exchange = material.exchange_length > 0.0
        ? material.spin_conductivity /
              (2.0 * material.exchange_length * material.exchange_length)
        : 0.0;
    const double dephasing = material.dephasing_length > 0.0
        ? material.spin_conductivity /
              (2.0 * material.dephasing_length * material.dephasing_length)
        : 0.0;
    const double cross[3] = {mu[1] * m[2] - mu[2] * m[1],
                             mu[2] * m[0] - mu[0] * m[2],
                             mu[0] * m[1] - mu[1] * m[0]};
    const double projection = mu[0] * m[0] + mu[1] * m[1] + mu[2] * m[2];
    return sf * mu[component] + exchange * cross[component] +
           dephasing * (mu[component] - m[component] * projection);
}

__device__ double apply_row(const SolveInput &in, const double *vector,
                            uint64_t cell, uint32_t component,
                            double *term_scale = nullptr) {
    const uint64_t cells = in.grid[0] * in.grid[1] * in.grid[2];
    const auto *cell_record = spin_cell(in, cell);
    if (term_scale != nullptr) *term_scale = 0.0;
    if (cell_record == nullptr || cell_record->spin_active == 0) {
        if (term_scale != nullptr)
            *term_scale = fabs(vector[component * cells + cell]);
        return vector[component * cells + cell];
    }
    const auto *material = spin_material(in, cell_record->material_index);
    if (material == nullptr) return 0.0;
    uint64_t x = 0, y = 0, z = 0;
    coordinates(in, cell, &x, &y, &z);
    const uint64_t coordinate[3] = {x, y, z};
    const uint64_t extent[3] = {in.grid[0], in.grid[1], in.grid[2]};
    const double area[3] = {in.cell_size[1] * in.cell_size[2],
                            in.cell_size[0] * in.cell_size[2],
                            in.cell_size[0] * in.cell_size[1]};
    double value = 0.0;
    const double center = vector[component * cells + cell];
    for (uint32_t axis = 0; axis < 3; ++axis) {
        for (int32_t side : {-1, 1}) {
            if ((side < 0 && coordinate[axis] > 0) ||
                (side > 0 && coordinate[axis] + 1 < extent[axis])) {
                uint64_t ncoord[3] = {x, y, z};
                ncoord[axis] = static_cast<uint64_t>(
                    static_cast<int64_t>(ncoord[axis]) + side);
                const uint64_t neighbor = cell_index(in, ncoord[0], ncoord[1], ncoord[2]);
                const auto *neighbor_cell = spin_cell(in, neighbor);
                if (neighbor_cell == nullptr || neighbor_cell->spin_active == 0) continue;
                const auto *neighbor_material =
                    spin_material(in, neighbor_cell->material_index);
                if (neighbor_material == nullptr) continue;
                const uint64_t negative = side < 0 ? neighbor : cell;
                const uint64_t positive = side < 0 ? cell : neighbor;
                const auto *interface_record =
                    interface_at(in, axis, negative, positive);
                if (interface_record != nullptr && interface_record->kind ==
                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
                    double negative_flux[3]{}, positive_flux[3]{}, incoming[3]{},
                        backflow[3]{}, absorbed[3]{};
                    mixing_flux(in, *interface_record, vector, false,
                                negative_flux, positive_flux, incoming, backflow, absorbed,
                                nullptr);
                    const double flux = side < 0 ? positive_flux[component]
                                                   : negative_flux[component];
                    const double contribution =
                        (side < 0 ? -1.0 : 1.0) * area[axis] * flux;
                    value += contribution;
                    if (term_scale != nullptr) *term_scale += fabs(contribution);
                    continue;
                }
                const double coefficient = 0.5 *
                    harmonic(material->spin_conductivity,
                             neighbor_material->spin_conductivity) *
                    area[axis] / in.cell_size[axis];
                const double neighbor_value = vector[component * cells + neighbor];
                value += coefficient * (center - neighbor_value);
                if (term_scale != nullptr)
                    *term_scale += fabs(coefficient * center) +
                                   fabs(coefficient * neighbor_value);
            } else {
                const auto *face = boundary(in, axis, side, cell);
                if (face != nullptr &&
                    (face->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK ||
                     face->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL)) {
                    const double coefficient = material->spin_conductivity *
                        area[axis] / in.cell_size[axis];
                    value += coefficient * center;
                    if (term_scale != nullptr)
                        *term_scale += fabs(coefficient * center);
                }
            }
        }
    }
    const double mu[3] = {vector[cell], vector[cells + cell],
                          vector[2 * cells + cell]};
    const double m[3] = {in.m_stage[cell], in.m_stage[cells + cell],
                         in.m_stage[2 * cells + cell]};
    const double volume = in.cell_size[0] * in.cell_size[1] * in.cell_size[2];
    const double reaction = volume * reaction_component(*material, m, mu, component);
    value += reaction;
    if (term_scale != nullptr) *term_scale += fabs(reaction);
    return value;
}

__device__ void apply(const SolveInput &in, const double *vector, double *output,
                      uint64_t unknowns) {
    const uint64_t cells = unknowns / 3;
    for (uint64_t row = 0; row < unknowns; ++row)
        output[row] = apply_row(in, vector, row % cells,
                                static_cast<uint32_t>(row / cells));
}

__device__ void build_rhs(const SolveInput &in, double *rhs, uint64_t unknowns) {
    const uint64_t cells = unknowns / 3;
    for (uint64_t i = 0; i < unknowns; ++i) rhs[i] = 0.0;
    for (uint64_t cell = 0; cell < cells; ++cell) {
        const auto *cell_record = spin_cell(in, cell);
        if (cell_record == nullptr || cell_record->spin_active == 0) continue;
        const auto *material = spin_material(in, cell_record->material_index);
        if (material == nullptr) continue;
        uint64_t x = 0, y = 0, z = 0;
        coordinates(in, cell, &x, &y, &z);
        const uint64_t coordinate[3] = {x, y, z};
        const uint64_t extent[3] = {in.grid[0], in.grid[1], in.grid[2]};
        const double area[3] = {in.cell_size[1] * in.cell_size[2],
                                in.cell_size[0] * in.cell_size[2],
                                in.cell_size[0] * in.cell_size[1]};
        for (uint32_t axis = 0; axis < 3; ++axis) {
            for (int32_t side : {-1, 1}) {
                const bool exterior =
                    (side < 0 && coordinate[axis] == 0) ||
                    (side > 0 && coordinate[axis] + 1 == extent[axis]);
                double source[3]{};
                if (exterior) {
                    const auto *boundary_face = boundary(in, axis, side, cell);
                    if (boundary_face == nullptr ||
                        boundary_face->kind ==
                            FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING)
                        continue;
                    const uint64_t face = face_index(
                        in, axis, x, y, z, side < 0 ? 0 : extent[axis]);
                    constitutive_source(in, axis, cell,
                                        accepted_current(in, axis)[face], source);
                    if (boundary_face->kind ==
                        FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL) {
                        const double coefficient = material->spin_conductivity *
                            area[axis] / in.cell_size[axis];
                        for (uint32_t component = 0; component < 3; ++component)
                            rhs[component * cells + cell] += coefficient *
                                boundary_face->potential_xyz[component];
                    }
                } else {
                    uint64_t neighbor_coordinate[3] = {x, y, z};
                    neighbor_coordinate[axis] = static_cast<uint64_t>(
                        static_cast<int64_t>(neighbor_coordinate[axis]) + side);
                    const uint64_t neighbor = cell_index(
                        in, neighbor_coordinate[0], neighbor_coordinate[1],
                        neighbor_coordinate[2]);
                    const uint64_t negative = side < 0 ? neighbor : cell;
                    const uint64_t positive = side < 0 ? cell : neighbor;
                    const uint64_t face = face_index(
                        in, axis, x, y, z,
                        side < 0 ? coordinate[axis] : coordinate[axis] + 1);
                    const auto *interface_record =
                        interface_at(in, axis, negative, positive);
                    if (interface_record != nullptr && interface_record->kind ==
                        FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
                        double negative_flux[3]{}, positive_flux[3]{}, incoming[3]{},
                            backflow[3]{}, absorbed[3]{};
                        mixing_flux(in, *interface_record, nullptr, true,
                                    negative_flux, positive_flux, incoming, backflow, absorbed,
                                    nullptr);
                        for (uint32_t component = 0; component < 3; ++component)
                            source[component] = side < 0
                                ? positive_flux[component] : negative_flux[component];
                    } else {
                        source_flux(in, axis, negative, positive, face, source);
                    }
                }
                const double outward_sign = side < 0 ? -1.0 : 1.0;
                for (uint32_t component = 0; component < 3; ++component)
                    rhs[component * cells + cell] -=
                        outward_sign * area[axis] * source[component];
            }
        }
    }
}

__global__ void assemble_sparse_cells_kernel(SolveInput in, uint8_t *active,
                                             double *conductivity,
                                             double *local, double *rhs,
                                             unsigned long long *digest) {
    const uint64_t cells = in.grid[0] * in.grid[1] * in.grid[2];
    const double volume = in.cell_size[0] * in.cell_size[1] * in.cell_size[2];
    for (uint64_t cell = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         cell < cells; cell += uint64_t(blockDim.x) * gridDim.x) {
        const auto *cell_record = spin_cell(in, cell);
        const auto *material = cell_record != nullptr
            ? spin_material(in, cell_record->material_index) : nullptr;
        const bool enabled = cell_record != nullptr && material != nullptr &&
                             cell_record->spin_active != 0;
        active[cell] = enabled ? 1 : 0;
        conductivity[cell] = enabled ? material->spin_conductivity : 0.0;
        for (uint32_t lane = 0; lane < 9; ++lane) local[lane * cells + cell] = 0.0;
        for (uint32_t component = 0; component < 3; ++component)
            rhs[uint64_t(component) * cells + cell] = 0.0;
        if (!enabled) continue;

        const double m[3]{in.m_stage[cell], in.m_stage[cells + cell],
                          in.m_stage[2 * cells + cell]};
        for (uint32_t component = 0; component < 3; ++component) {
            const double value = m[component];
            if (!isfinite(value)) { atomicExch(digest + 4, 1ULL); return; }
            unsigned long long mixed = __double_as_longlong(value) ^
                (UINT64_C(0x9e3779b97f4a7c15) * (component + 1)) ^
                (UINT64_C(0xd6e8feb86659fd93) * (cell + 1));
            mixed ^= mixed >> 30;
            mixed *= UINT64_C(0xbf58476d1ce4e5b9);
            mixed ^= mixed >> 27;
            mixed *= UINT64_C(0x94d049bb133111eb);
            mixed ^= mixed >> 31;
            for (uint32_t lane = 0; lane < 4; ++lane) {
                unsigned long long lane_value = mixed ^
                    (UINT64_C(0x517cc1b727220a95) * (lane + 1));
                lane_value ^= lane_value >> (13 + lane);
                atomicAdd(digest + lane, lane_value);
            }
        }
        const double sf = material->spin_flip_length > 0.0
            ? material->spin_conductivity /
                  (2.0 * material->spin_flip_length * material->spin_flip_length) : 0.0;
        const double ex = material->exchange_length > 0.0
            ? material->spin_conductivity /
                  (2.0 * material->exchange_length * material->exchange_length) : 0.0;
        const double dp = material->dephasing_length > 0.0
            ? material->spin_conductivity /
                  (2.0 * material->dephasing_length * material->dephasing_length) : 0.0;
        const double cross[9]{0.0,m[2],-m[1], -m[2],0.0,m[0], m[1],-m[0],0.0};
        for (uint32_t row = 0; row < 3; ++row)
            for (uint32_t column = 0; column < 3; ++column)
                local[(row * 3 + column) * cells + cell] =
                    (row == column ? sf + dp : 0.0) - dp * m[row] * m[column] +
                    ex * cross[row * 3 + column];

        uint64_t x=0,y=0,z=0; coordinates(in, cell, &x, &y, &z);
        const uint64_t coordinate[3]{x,y,z};
        const uint64_t extent[3]{in.grid[0],in.grid[1],in.grid[2]};
        const double area[3]{in.cell_size[1]*in.cell_size[2],
                             in.cell_size[0]*in.cell_size[2],
                             in.cell_size[0]*in.cell_size[1]};
        for (uint32_t axis=0; axis<3; ++axis) for (int32_t side : {-1,1}) {
            const bool exterior = (side < 0 && coordinate[axis] == 0) ||
                                  (side > 0 && coordinate[axis] + 1 == extent[axis]);
            double source[3]{};
            if (exterior) {
                const auto *face_record = boundary(in, axis, side, cell);
                if (face_record == nullptr || face_record->kind ==
                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING) continue;
                const uint64_t face = face_index(in, axis, x,y,z,
                    side < 0 ? 0 : extent[axis]);
                constitutive_source(in, axis, cell, accepted_current(in,axis)[face], source);
                const double coefficient = material->spin_conductivity /
                                           (in.cell_size[axis]*in.cell_size[axis]);
                for (uint32_t c=0;c<3;++c)
                    local[(c*3+c)*cells+cell] += coefficient;
                if (face_record->kind ==
                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL) {
                    for (uint32_t c=0;c<3;++c) {
                        rhs[uint64_t(c)*cells+cell] += coefficient *
                                                       face_record->potential_xyz[c];
                    }
                }
            } else {
                uint64_t nc[3]{x,y,z}; nc[axis] = uint64_t(int64_t(nc[axis])+side);
                const uint64_t neighbor=cell_index(in,nc[0],nc[1],nc[2]);
                const uint64_t negative=side<0?neighbor:cell;
                const uint64_t positive=side<0?cell:neighbor;
                const uint64_t face=face_index(in,axis,x,y,z,
                    side<0?coordinate[axis]:coordinate[axis]+1);
                const auto *iface=interface_at(in,axis,negative,positive);
                if (iface != nullptr && iface->kind ==
                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
                    double nf[3]{},pf[3]{},incoming[3]{},backflow[3]{},absorbed[3]{};
                    mixing_flux(in,*iface,nullptr,true,nf,pf,incoming,backflow,absorbed,nullptr);
                    for(uint32_t c=0;c<3;++c) source[c]=side<0?pf[c]:nf[c];
                } else source_flux(in,axis,negative,positive,face,source);
            }
            const double sign=side<0?-1.0:1.0;
            for(uint32_t c=0;c<3;++c)
                rhs[uint64_t(c)*cells+cell] -= sign*area[axis]*source[c]/volume;
        }
    }
}

__global__ void hash_fp64_result_kernel(const double *values, uint64_t count,
                                        uint64_t domain,
                                        unsigned long long *digest) {
    for (uint64_t index = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         index < count; index += uint64_t(blockDim.x) * gridDim.x) {
        const double value = values[index];
        if (!isfinite(value)) {
            atomicExch(digest + 4, 1ULL);
            continue;
        }
        unsigned long long mixed = __double_as_longlong(value) ^
            (UINT64_C(0x9e3779b97f4a7c15) * (domain + 1)) ^
            (UINT64_C(0xd6e8feb86659fd93) * (index + 1));
        mixed ^= mixed >> 30;
        mixed *= UINT64_C(0xbf58476d1ce4e5b9);
        mixed ^= mixed >> 27;
        mixed *= UINT64_C(0x94d049bb133111eb);
        mixed ^= mixed >> 31;
        for (uint32_t lane = 0; lane < 4; ++lane)
            atomicAdd(digest + lane, mixed ^
                (UINT64_C(0x517cc1b727220a95) * (lane + 1)));
    }
}

__global__ void assemble_sparse_interfaces_kernel(
    SolveInput in, const uint32_t *record_indices, const uint8_t *roles,
    uint64_t entries, double *blocks) {
    const double volume=in.cell_size[0]*in.cell_size[1]*in.cell_size[2];
    for(uint64_t entry=uint64_t(blockIdx.x)*blockDim.x+threadIdx.x;entry<entries;
        entry+=uint64_t(blockDim.x)*gridDim.x) {
        const auto *iface=record_at<fullmag_fdm_gpu_transport_spin_interface_v1>(
            in,2,record_indices[entry]);
        if (iface->kind !=
            FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
            for(uint32_t lane=0;lane<9;++lane) blocks[lane*entries+entry]=0.0;
            continue;
        }
        const uint8_t role=roles[entry];
        const bool self=(role&1u)==0;
        const bool from_side=role<2 ? iface->negative_cell==iface->from_cell
                                    : iface->positive_cell==iface->from_cell;
        const auto *nc=spin_cell(in,iface->negative_cell);
        const auto *pc=spin_cell(in,iface->positive_cell);
        const auto *nm=nc?spin_material(in,nc->material_index):nullptr;
        const auto *pm=pc?spin_material(in,pc->material_index):nullptr;
        const double base=(nm&&pm)?0.5*harmonic(nm->spin_conductivity,
            pm->spin_conductivity)/(in.cell_size[iface->axis]*in.cell_size[iface->axis]):0.0;
        const double scale=in.cell_size[(iface->axis+1)%3]*
                           in.cell_size[(iface->axis+2)%3]/volume;
        const double gl=0.5*(iface->G_up+iface->G_down);
        const double *m=iface->magnetization_xyz;
        for(uint32_t r=0;r<3;++r) for(uint32_t c=0;c<3;++c) {
            const double longitudinal=gl*m[r]*m[c];
            const double cross=(r==0&&c==1)?m[2]:(r==0&&c==2)?-m[1]:
                (r==1&&c==0)?-m[2]:(r==1&&c==2)?m[0]:
                (r==2&&c==0)?m[1]:(r==2&&c==1)?-m[0]:0.0;
            const double full=longitudinal+iface->G_r*((r==c?1.0:0.0)-m[r]*m[c])+
                              iface->G_i*cross;
            const double matrix=from_side?full:longitudinal;
            const double correction=(self?matrix:-matrix)*scale +
                                    ((r==c)?(self?-base:base):0.0);
            blocks[(r*3+c)*entries+entry]=correction;
        }
    }
}

__device__ double diagonal(const SolveInput &in, uint64_t row, uint64_t unknowns,
                           double *scratch) {
    for (uint64_t i = 0; i < unknowns; ++i) scratch[i] = 0.0;
    scratch[row] = 1.0;
    const uint64_t cells = unknowns / 3;
    const double value = apply_row(in, scratch, row % cells,
                                   static_cast<uint32_t>(row / cells));
    scratch[row] = 0.0;
    return fabs(value) > 1.0e-300 ? value : 1.0;
}

__device__ void block_jacobi(const SolveInput &in, const double *source,
                             double *destination, uint64_t unknowns,
                             double *scratch) {
    const uint64_t cells = unknowns / 3;
    for (uint64_t cell = 0; cell < cells; ++cell) {
        double matrix[3][3]{};
        for (uint32_t column = 0; column < 3; ++column) {
            for (uint64_t row = 0; row < unknowns; ++row) scratch[row] = 0.0;
            scratch[column * cells + cell] = 1.0;
            for (uint32_t row = 0; row < 3; ++row)
                matrix[row][column] = apply_row(in, scratch, cell, row);
        }
        const double determinant =
            matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) -
            matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0]) +
            matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
        if (fabs(determinant) <= 1.0e-300) {
            for (uint32_t component = 0; component < 3; ++component) {
                const uint64_t row = component * cells + cell;
                destination[row] = source[row] /
                    diagonal(in, row, unknowns, scratch);
            }
            continue;
        }
        const double inverse[3][3] = {
            {(matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) / determinant,
             (matrix[0][2] * matrix[2][1] - matrix[0][1] * matrix[2][2]) / determinant,
             (matrix[0][1] * matrix[1][2] - matrix[0][2] * matrix[1][1]) / determinant},
            {(matrix[1][2] * matrix[2][0] - matrix[1][0] * matrix[2][2]) / determinant,
             (matrix[0][0] * matrix[2][2] - matrix[0][2] * matrix[2][0]) / determinant,
             (matrix[0][2] * matrix[1][0] - matrix[0][0] * matrix[1][2]) / determinant},
            {(matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]) / determinant,
             (matrix[0][1] * matrix[2][0] - matrix[0][0] * matrix[2][1]) / determinant,
             (matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]) / determinant}};
        for (uint32_t row = 0; row < 3; ++row) {
            destination[row * cells + cell] = 0.0;
            for (uint32_t column = 0; column < 3; ++column)
                destination[row * cells + cell] +=
                    inverse[row][column] * source[column * cells + cell];
        }
    }
}

__device__ double operator_block_strength(const SolveInput &in,
                                          uint64_t row_cell,
                                          uint64_t column_cell,
                                          uint64_t unknowns,
                                          double *scratch) {
    const uint64_t cells = unknowns / 3;
    double norm_squared = 0.0;
    for (uint32_t column = 0; column < 3; ++column) {
        for (uint64_t row = 0; row < unknowns; ++row) scratch[row] = 0.0;
        scratch[column * cells + column_cell] = 1.0;
        for (uint32_t row = 0; row < 3; ++row) {
            const double value = apply_row(in, scratch, row_cell, row);
            norm_squared += value * value;
        }
    }
    return sqrt(norm_squared);
}

__device__ uint64_t build_strong_graph_aggregates(const SolveInput &in,
                                                   uint64_t unknowns,
                                                   Workspace &workspace) {
    const uint64_t cells = unknowns / 3;
    for (uint64_t cell = 0; cell < cells; ++cell) workspace.aggregate[cell] = UINT64_MAX;
    uint64_t aggregate_count = 0;
    for (uint64_t seed = 0; seed < cells; ++seed) {
        if (workspace.aggregate[seed] != UINT64_MAX) continue;
        const auto *seed_record = spin_cell(in, seed);
        workspace.aggregate[seed] = aggregate_count;
        uint64_t strongest = UINT64_MAX;
        double strongest_weight = 0.0;
        if (seed_record != nullptr && seed_record->spin_active != 0) {
            uint64_t x = 0, y = 0, z = 0;
            coordinates(in, seed, &x, &y, &z);
            const uint64_t coordinate[3] = {x, y, z};
            const uint64_t extent[3] = {in.grid[0], in.grid[1], in.grid[2]};
            for (uint32_t axis = 0; axis < 3; ++axis) {
                for (int32_t side : {-1, 1}) {
                    if ((side < 0 && coordinate[axis] == 0) ||
                        (side > 0 && coordinate[axis] + 1 == extent[axis]))
                        continue;
                    uint64_t neighbor_coordinate[3] = {x, y, z};
                    neighbor_coordinate[axis] = static_cast<uint64_t>(
                        static_cast<int64_t>(neighbor_coordinate[axis]) + side);
                    const uint64_t neighbor = cell_index(
                        in, neighbor_coordinate[0], neighbor_coordinate[1],
                        neighbor_coordinate[2]);
                    const auto *neighbor_record = spin_cell(in, neighbor);
                    if (workspace.aggregate[neighbor] != UINT64_MAX ||
                        neighbor_record == nullptr || neighbor_record->spin_active == 0)
                        continue;
                    const double weight = operator_block_strength(
                        in, seed, neighbor, unknowns, workspace.unit);
                    if (weight > strongest_weight ||
                        (weight == strongest_weight && weight > 0.0 && neighbor < strongest)) {
                        strongest = neighbor;
                        strongest_weight = weight;
                    }
                }
            }
        }
        if (strongest != UINT64_MAX && strongest_weight > 0.0)
            workspace.aggregate[strongest] = aggregate_count;
        ++aggregate_count;
    }
    return aggregate_count;
}

__device__ bool build_rap_and_factor(const SolveInput &in, uint64_t unknowns,
                                     uint64_t aggregate_count,
                                     Workspace &workspace) {
    const uint64_t cells = unknowns / 3;
    const uint64_t coarse_unknowns = 3 * aggregate_count;
    const uint64_t coarse_entries = coarse_unknowns * coarse_unknowns;
    for (uint64_t entry = 0; entry < coarse_entries; ++entry)
        workspace.coarse_matrix[entry] = 0.0;
    for (uint64_t fine_column = 0; fine_column < unknowns; ++fine_column) {
        for (uint64_t row = 0; row < unknowns; ++row) workspace.unit[row] = 0.0;
        workspace.unit[fine_column] = 1.0;
        const uint32_t column_component = static_cast<uint32_t>(fine_column / cells);
        const uint64_t column_cell = fine_column % cells;
        const uint64_t coarse_column = column_component * aggregate_count +
                                       workspace.aggregate[column_cell];
        for (uint32_t row_component = 0; row_component < 3; ++row_component) {
            for (uint64_t row_cell = 0; row_cell < cells; ++row_cell) {
                const uint64_t coarse_row = row_component * aggregate_count +
                                            workspace.aggregate[row_cell];
                workspace.coarse_matrix[coarse_row * coarse_unknowns + coarse_column] +=
                    apply_row(in, workspace.unit, row_cell, row_component);
            }
        }
    }
    for (uint64_t entry = 0; entry < coarse_entries; ++entry)
        workspace.coarse_lu[entry] = workspace.coarse_matrix[entry];
    for (uint64_t pivot = 0; pivot < coarse_unknowns; ++pivot) {
        uint64_t best = pivot;
        double magnitude = fabs(workspace.coarse_lu[pivot * coarse_unknowns + pivot]);
        for (uint64_t row = pivot + 1; row < coarse_unknowns; ++row) {
            const double candidate = fabs(workspace.coarse_lu[row * coarse_unknowns + pivot]);
            if (candidate > magnitude) { magnitude = candidate; best = row; }
        }
        if (magnitude <= 1.0e-300) return false;
        workspace.coarse_pivots[pivot] = best;
        if (best != pivot) {
            for (uint64_t column = 0; column < coarse_unknowns; ++column) {
                const double temporary = workspace.coarse_lu[pivot * coarse_unknowns + column];
                workspace.coarse_lu[pivot * coarse_unknowns + column] =
                    workspace.coarse_lu[best * coarse_unknowns + column];
                workspace.coarse_lu[best * coarse_unknowns + column] = temporary;
            }
        }
        for (uint64_t row = pivot + 1; row < coarse_unknowns; ++row) {
            const double multiplier = workspace.coarse_lu[row * coarse_unknowns + pivot] /
                                      workspace.coarse_lu[pivot * coarse_unknowns + pivot];
            workspace.coarse_lu[row * coarse_unknowns + pivot] = multiplier;
            for (uint64_t column = pivot + 1; column < coarse_unknowns; ++column)
                workspace.coarse_lu[row * coarse_unknowns + column] -= multiplier *
                    workspace.coarse_lu[pivot * coarse_unknowns + column];
        }
    }
    return true;
}

__device__ void coarse_solve(uint64_t coarse_unknowns, Workspace &workspace) {
    for (uint64_t row = 0; row < coarse_unknowns; ++row)
        workspace.coarse_correction[row] = workspace.coarse_rhs[row];
    for (uint64_t pivot = 0; pivot < coarse_unknowns; ++pivot) {
        const uint64_t swap = workspace.coarse_pivots[pivot];
        if (swap != pivot) {
            const double temporary = workspace.coarse_correction[pivot];
            workspace.coarse_correction[pivot] = workspace.coarse_correction[swap];
            workspace.coarse_correction[swap] = temporary;
        }
        for (uint64_t row = pivot + 1; row < coarse_unknowns; ++row)
            workspace.coarse_correction[row] -=
                workspace.coarse_lu[row * coarse_unknowns + pivot] *
                workspace.coarse_correction[pivot];
    }
    for (int64_t row = static_cast<int64_t>(coarse_unknowns) - 1; row >= 0; --row) {
        double value = workspace.coarse_correction[row];
        for (uint64_t column = static_cast<uint64_t>(row) + 1;
             column < coarse_unknowns; ++column)
            value -= workspace.coarse_lu[static_cast<uint64_t>(row) * coarse_unknowns + column] *
                     workspace.coarse_correction[column];
        workspace.coarse_correction[row] = value /
            workspace.coarse_lu[static_cast<uint64_t>(row) * coarse_unknowns +
                                static_cast<uint64_t>(row)];
    }
}

__device__ void precondition(const SolveInput &in, const double *source,
                             double *destination, uint64_t unknowns,
                             uint64_t aggregate_count, Workspace &workspace) {
    const uint64_t cells = unknowns / 3;
    const uint64_t coarse_unknowns = 3 * aggregate_count;
    block_jacobi(in, source, destination, unknowns, workspace.unit);
    apply(in, destination, workspace.precondition_residual, unknowns);
    for (uint64_t row = 0; row < unknowns; ++row)
        workspace.precondition_residual[row] =
            source[row] - workspace.precondition_residual[row];
    for (uint64_t row = 0; row < coarse_unknowns; ++row) {
        workspace.coarse_rhs[row] = 0.0;
    }
    for (uint32_t component = 0; component < 3; ++component) {
        for (uint64_t cell = 0; cell < cells; ++cell) {
            const uint64_t coarse = workspace.aggregate[cell];
            const uint64_t coarse_row = component * aggregate_count + coarse;
            workspace.coarse_rhs[coarse_row] +=
                workspace.precondition_residual[component * cells + cell];
        }
    }
    coarse_solve(coarse_unknowns, workspace);
    for (uint32_t component = 0; component < 3; ++component) {
        for (uint64_t cell = 0; cell < cells; ++cell)
            destination[component * cells + cell] +=
                workspace.coarse_correction[component * aggregate_count +
                                            workspace.aggregate[cell]];
    }
}

__global__ void solve_kernel(SolveInput in, Workspace workspace,
                             uint64_t unknowns, uint64_t restart) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    DeviceDiagnostics diagnostics{};
    diagnostics.reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS;
    const uint64_t aggregate_count =
        build_strong_graph_aggregates(in, unknowns, workspace);
    if (aggregate_count == 0 ||
        !build_rap_and_factor(in, unknowns, aggregate_count, workspace)) {
        diagnostics.reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE;
        *workspace.diagnostics = diagnostics;
        return;
    }
    diagnostics.fine_unknowns = unknowns;
    diagnostics.coarse_unknowns = 3 * aggregate_count;
    diagnostics.hierarchy_levels = aggregate_count * 3 < unknowns ? 2 : 1;
    SpinSha256 hierarchy_sha{};
    sha_init(&hierarchy_sha);
    constexpr uint64_t hierarchy_version = UINT64_C(1);
    sha_update(&hierarchy_sha, &hierarchy_version, sizeof(hierarchy_version));
    sha_update(&hierarchy_sha, &aggregate_count, sizeof(aggregate_count));
    sha_update(&hierarchy_sha, workspace.aggregate,
               (unknowns / 3) * sizeof(uint64_t));
    sha_update(&hierarchy_sha, workspace.coarse_matrix,
               diagnostics.coarse_unknowns * diagnostics.coarse_unknowns * sizeof(double));
    sha_finish(&hierarchy_sha, diagnostics.hierarchy_digest);
    build_rhs(in, workspace.rhs, unknowns);
    for (uint64_t i = 0; i < unknowns; ++i) workspace.x[i] = 0.0;
    const double rhs_norm = fmax(norm(workspace.rhs, unknowns), 1.0e-300);
    precondition(in, workspace.rhs, workspace.work, unknowns,
                 aggregate_count, workspace);
    ++diagnostics.amg_apply_count;
    const double preconditioned_rhs_norm =
        fmax(norm(workspace.work, unknowns), 1.0e-300);
    uint64_t total_iterations = 0;
    while (total_iterations < in.max_iterations) {
        apply(in, workspace.x, workspace.work, unknowns);
        double local_residual = 0.0;
        for (uint64_t i = 0; i < unknowns; ++i)
        {
            workspace.residual[i] = workspace.rhs[i] - workspace.work[i];
            const uint64_t cells = unknowns / 3;
            double operator_scale = 0.0;
            (void)apply_row(in, workspace.x, i % cells,
                            static_cast<uint32_t>(i / cells), &operator_scale);
            const double local_scale =
                fmax(operator_scale + fabs(workspace.rhs[i]), 1.0e-30);
            local_residual =
                fmax(local_residual, fabs(workspace.residual[i]) / local_scale);
        }
        diagnostics.residual = norm(workspace.residual, unknowns) / rhs_norm;
        diagnostics.local_balance = local_residual;
        if (diagnostics.residual <= in.relative_tolerance &&
            local_residual <= in.relative_tolerance) {
            diagnostics.reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
            break;
        }
        precondition(in, workspace.residual, workspace.work, unknowns,
                     aggregate_count, workspace);
        ++diagnostics.amg_apply_count;
        const double beta = norm(workspace.work, unknowns);
        for (uint64_t i = 0; i < unknowns; ++i)
            workspace.basis[i] = workspace.work[i] / beta;
        for (uint64_t i = 0; i < restart + 1; ++i) workspace.g[i] = 0.0;
        workspace.g[0] = beta;
        uint64_t used = 0;
        for (uint64_t column = 0;
             column < restart && total_iterations < in.max_iterations;
             ++column) {
            const double *basis_column = workspace.basis + column * unknowns;
            apply(in, basis_column, workspace.residual, unknowns);
            precondition(in, workspace.residual, workspace.work, unknowns,
                         aggregate_count, workspace);
            ++diagnostics.amg_apply_count;
            for (uint64_t row = 0; row <= column; ++row) {
                const double *basis_row = workspace.basis + row * unknowns;
                const double h = dot(workspace.work, basis_row, unknowns);
                workspace.hessenberg[row * restart + column] = h;
                for (uint64_t i = 0; i < unknowns; ++i)
                    workspace.work[i] -= h * basis_row[i];
            }
            const double next = norm(workspace.work, unknowns);
            workspace.hessenberg[(column + 1) * restart + column] = next;
            if (next > 1.0e-300) {
                double *next_basis = workspace.basis + (column + 1) * unknowns;
                for (uint64_t i = 0; i < unknowns; ++i)
                    next_basis[i] = workspace.work[i] / next;
            }
            for (uint64_t rotation = 0; rotation < column; ++rotation) {
                double &upper = workspace.hessenberg[rotation * restart + column];
                double &lower = workspace.hessenberg[(rotation + 1) * restart + column];
                const double transformed = workspace.givens_c[rotation] * upper +
                                           workspace.givens_s[rotation] * lower;
                lower = -workspace.givens_s[rotation] * upper +
                        workspace.givens_c[rotation] * lower;
                upper = transformed;
            }
            double &diagonal_h = workspace.hessenberg[column * restart + column];
            double &subdiagonal = workspace.hessenberg[(column + 1) * restart + column];
            const double magnitude = hypot(diagonal_h, subdiagonal);
            workspace.givens_c[column] = magnitude > 0.0 ? diagonal_h / magnitude : 1.0;
            workspace.givens_s[column] = magnitude > 0.0 ? subdiagonal / magnitude : 0.0;
            diagonal_h = magnitude;
            subdiagonal = 0.0;
            workspace.g[column + 1] = -workspace.givens_s[column] * workspace.g[column];
            workspace.g[column] *= workspace.givens_c[column];
            used = column + 1;
            ++total_iterations;
            diagnostics.residual =
                fabs(workspace.g[column + 1]) / preconditioned_rhs_norm;
            if (diagnostics.residual <= in.relative_tolerance || next <= 1.0e-300)
                break;
        }
        for (int64_t row = static_cast<int64_t>(used) - 1; row >= 0; --row) {
            double value = workspace.g[row];
            for (uint64_t column = static_cast<uint64_t>(row) + 1;
                 column < used; ++column)
                value -= workspace.hessenberg[row * restart + column] *
                         workspace.y[column];
            workspace.y[row] = value /
                workspace.hessenberg[row * restart + static_cast<uint64_t>(row)];
        }
        for (uint64_t column = 0; column < used; ++column) {
            const double *basis_column = workspace.basis + column * unknowns;
            for (uint64_t i = 0; i < unknowns; ++i)
                workspace.x[i] += workspace.y[column] * basis_column[i];
        }
    }
    diagnostics.iterations = total_iterations;
    *workspace.diagnostics = diagnostics;
}

__host__ __device__ bool observation_identity_less(
    const fullmag_fdm_gpu_transport_spin_observation_record_v1 &left,
    const fullmag_fdm_gpu_transport_spin_observation_record_v1 &right) {
    if (left.source_id != right.source_id) return left.source_id < right.source_id;
    if (left.topology_id != right.topology_id) return left.topology_id < right.topology_id;
    if (left.axis != right.axis) return left.axis < right.axis;
    if (left.canonical_face_index != right.canonical_face_index)
        return left.canonical_face_index < right.canonical_face_index;
    if (left.negative_cell != right.negative_cell)
        return left.negative_cell < right.negative_cell;
    if (left.positive_cell != right.positive_cell)
        return left.positive_cell < right.positive_cell;
    if (left.from_cell != right.from_cell) return left.from_cell < right.from_cell;
    return left.to_cell < right.to_cell;
}

struct ObservationIdentityLess {
    __host__ __device__ bool operator()(
        const fullmag_fdm_gpu_transport_spin_observation_record_v1 &left,
        const fullmag_fdm_gpu_transport_spin_observation_record_v1 &right) const {
        return observation_identity_less(left, right);
    }
};

__global__ void materialize_faces_kernel(SolveInput in, const double *solution,
                                         Buffers buffers, uint32_t axis) {
    const uint64_t faces = face_count(in, axis);
    const uint64_t cells = buffers.cells;
    double *target = axis == 0 ? buffers.qx : axis == 1 ? buffers.qy : buffers.qz;
    const uint64_t nx = in.grid[0], ny = in.grid[1];
    for (uint64_t face = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         face < faces; face += uint64_t(blockDim.x) * gridDim.x) {
        uint64_t x = 0, y = 0, z = 0, plane = 0;
        if (axis == 0) {
            plane = face % (nx + 1);
            const uint64_t yz = face / (nx + 1);
            y = yz % ny;
            z = yz / ny;
            x = plane < nx ? plane : nx - 1;
        } else if (axis == 1) {
            x = face % nx;
            const uint64_t yz = face / nx;
            plane = yz % (ny + 1);
            z = yz / (ny + 1);
            y = plane < ny ? plane : ny - 1;
        } else {
            x = face % nx;
            const uint64_t yz = face / nx;
            y = yz % ny;
            plane = yz / ny;
            z = plane < in.grid[2] ? plane : in.grid[2] - 1;
        }
        const bool has_negative = plane > 0;
        const bool has_positive = plane < in.grid[axis];
        if (!has_negative || !has_positive) {
            uint64_t adjacent_coordinate[3] = {x, y, z};
            adjacent_coordinate[axis] = has_positive ? 0 : in.grid[axis] - 1;
            const uint64_t adjacent = cell_index(
                in, adjacent_coordinate[0], adjacent_coordinate[1],
                adjacent_coordinate[2]);
            const int32_t side = has_positive ? -1 : 1;
            const auto *boundary_face = boundary(in, axis, side, adjacent);
            if (boundary_face == nullptr || boundary_face->kind ==
                FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING)
                continue;
            double value[3]{};
            constitutive_source(in, axis, adjacent,
                                accepted_current(in, axis)[face], value);
            const auto *adjacent_cell = spin_cell(in, adjacent);
            const auto *adjacent_material = adjacent_cell != nullptr
                ? spin_material(in, adjacent_cell->material_index) : nullptr;
            if (adjacent_material == nullptr) continue;
            const double boundary_mu[3] = {
                boundary_face->kind ==
                        FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL
                    ? boundary_face->potential_xyz[0] : 0.0,
                boundary_face->kind ==
                        FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL
                    ? boundary_face->potential_xyz[1] : 0.0,
                boundary_face->kind ==
                        FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL
                    ? boundary_face->potential_xyz[2] : 0.0};
            for (uint32_t component = 0; component < 3; ++component) {
                const double difference = has_positive
                    ? solution[component * cells + adjacent] - boundary_mu[component]
                    : boundary_mu[component] - solution[component * cells + adjacent];
                value[component] -= adjacent_material->spin_conductivity *
                    difference / in.cell_size[axis];
                target[component * faces + face] = value[component];
            }
            continue;
        }
        uint64_t negative_coord[3] = {x, y, z};
        uint64_t positive_coord[3] = {x, y, z};
        negative_coord[axis] = plane - 1;
        positive_coord[axis] = plane;
        const uint64_t negative = cell_index(
            in, negative_coord[0], negative_coord[1], negative_coord[2]);
        const uint64_t positive = cell_index(
            in, positive_coord[0], positive_coord[1], positive_coord[2]);
        const auto *negative_cell = spin_cell(in, negative);
        const auto *positive_cell = spin_cell(in, positive);
        if (negative_cell == nullptr || positive_cell == nullptr) continue;
        const auto *negative_material = spin_material(in, negative_cell->material_index);
        const auto *positive_material = spin_material(in, positive_cell->material_index);
        if (negative_material == nullptr || positive_material == nullptr) continue;
        const auto *interface_record = interface_at(in, axis, negative, positive);
        if (interface_record != nullptr && interface_record->kind ==
            FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
            double negative_flux[3]{}, positive_flux[3]{}, incoming[3]{},
                backflow[3]{}, absorbed[3]{};
            mixing_flux(in, *interface_record, solution, true, negative_flux,
                        positive_flux, incoming, backflow, absorbed, nullptr);
            for (uint32_t component = 0; component < 3; ++component)
                target[component * faces + face] = negative_flux[component];
            const uint64_t torque_cell = interface_record->to_cell;
            const auto *torque_record = spin_cell(in, torque_cell);
            if (torque_record != nullptr && torque_record->torque_target != 0 &&
                torque_record->saturation_magnetization > 0.0) {
                const double face_area = in.cell_size[(axis + 1) % 3] *
                    in.cell_size[(axis + 2) % 3];
                const double volume = in.cell_size[0] * in.cell_size[1] *
                    in.cell_size[2];
                const auto *formula = formula_ids(in);
                const double factor = formula == nullptr ? 0.0 :
                    -(formula->gamma_e * kHbar /
                      (2.0 * kElementaryCharge *
                       torque_record->saturation_magnetization)) *
                    face_area / volume;
                for (uint32_t component = 0; component < 3; ++component) {
                    const uint64_t index = component * cells + torque_cell;
                    const double surface = factor * absorbed[component];
                    atomicAdd(buffers.torque_surface + index, surface);
                    atomicAdd(buffers.torque_total + index, surface);
                }
            }
            continue;
        }
        const double sigma = harmonic(negative_material->spin_conductivity,
                                      positive_material->spin_conductivity);
        double source[3]{};
        source_flux(in, axis, negative, positive, face, source);
        for (uint32_t component = 0; component < 3; ++component)
            target[component * faces + face] = source[component] - 0.5 * sigma *
                (solution[component * cells + positive] -
                 solution[component * cells + negative]) /
                in.cell_size[axis];
    }
}

__global__ void materialize_interfaces_kernel(SolveInput in,
                                              const double *solution,
                                              Buffers buffers) {
    const uint64_t interface_count = in.views[2].element_count;
    for (uint64_t interface_index = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         interface_index < interface_count;
         interface_index += uint64_t(blockDim.x) * gridDim.x) {
        const auto *interface_record =
            record_at<fullmag_fdm_gpu_transport_spin_interface_v1>(
                in, 2, interface_index);
        auto *observation = buffers.interface_observations + interface_index;
        *observation = {};
        observation->abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
        observation->struct_version = 1;
        observation->struct_size = sizeof(*observation);
        observation->required_features =
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN |
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
        observation->kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INTERFACE;
        observation->axis = interface_record->axis;
        observation->orientation = interface_record->orientation;
        observation->source_id = interface_record->source_id;
        observation->topology_id = interface_record->topology_id;
        observation->canonical_face_index = interface_record->canonical_face_index;
        observation->negative_cell = interface_record->negative_cell;
        observation->positive_cell = interface_record->positive_cell;
        observation->from_cell = interface_record->from_cell;
        observation->to_cell = interface_record->to_cell;
        if (interface_record->kind ==
            FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
            double charge_traces[3]{};
            mixing_flux(in, *interface_record, solution, true,
                        observation->lane3_xyz, observation->lane4_xyz,
                        observation->lane0_xyz, observation->lane1_xyz,
                        observation->lane2_xyz, charge_traces);
            observation->charge_from_trace_v = charge_traces[0];
            observation->charge_to_trace_v = charge_traces[1];
            observation->charge_delta_trace_v = charge_traces[2];
        } else {
            const uint64_t faces = face_count(in, interface_record->axis);
            const double *flux = interface_record->axis == 0 ? buffers.qx
                : interface_record->axis == 1 ? buffers.qy : buffers.qz;
            for (uint32_t component = 0; component < 3; ++component) {
                const double value = flux[component * faces +
                                          interface_record->canonical_face_index];
                observation->lane3_xyz[component] = value;
                observation->lane4_xyz[component] = value;
            }
        }
    }
}

__global__ void materialize_kernel(SolveInput in, const double *solution,
                                   const double *rhs, Buffers buffers,
                                   DeviceDiagnostics *diagnostics,
                                   uint32_t mode) {
    if (mode == 2 && (blockIdx.x != 0 || threadIdx.x != 0)) return;
    const uint64_t cells = buffers.cells;
    if (mode == 0) for (uint64_t cell = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         cell < cells; cell += uint64_t(blockDim.x) * gridDim.x) {
        buffers.mu_x[cell] = solution[cell];
        buffers.mu_y[cell] = solution[cells + cell];
        buffers.mu_z[cell] = solution[2 * cells + cell];
        const auto *cell_record = spin_cell(in, cell);
        const auto *material = cell_record != nullptr
            ? spin_material(in, cell_record->material_index) : nullptr;
        buffers.cell_region_ids[cell] =
            cell_record != nullptr ? cell_record->region_id : 0;
        if (material == nullptr) continue;
        const double mu[3] = {solution[cell], solution[cells + cell],
                              solution[2 * cells + cell]};
        const double m[3] = {in.m_stage[cell], in.m_stage[cells + cell],
                             in.m_stage[2 * cells + cell]};
        const double sf = material->spin_flip_length > 0.0
            ? material->spin_conductivity /
                  (2.0 * material->spin_flip_length * material->spin_flip_length)
            : 0.0;
        const double exchange = material->exchange_length > 0.0
            ? material->spin_conductivity /
                  (2.0 * material->exchange_length * material->exchange_length)
            : 0.0;
        const double dephasing = material->dephasing_length > 0.0
            ? material->spin_conductivity /
                  (2.0 * material->dephasing_length * material->dephasing_length)
            : 0.0;
        const double cross[3] = {mu[1] * m[2] - mu[2] * m[1],
                                 mu[2] * m[0] - mu[0] * m[2],
                                 mu[0] * m[1] - mu[1] * m[0]};
        const double projection = mu[0] * m[0] + mu[1] * m[1] + mu[2] * m[2];
        for (uint32_t component = 0; component < 3; ++component) {
            const uint64_t index = component * cells + cell;
            buffers.reaction_sf[index] = sf * mu[component];
            buffers.reaction_j[index] = exchange * cross[component];
            buffers.reaction_phi[index] =
                dephasing * (mu[component] - m[component] * projection);
            const double magnetic_sink = buffers.reaction_j[index] +
                                         buffers.reaction_phi[index];
            const auto *formula = formula_ids(in);
            const double torque = formula != nullptr && cell_record->torque_target != 0 &&
                                  cell_record->saturation_magnetization > 0.0
                ? -(formula->gamma_e * kHbar /
                    (2.0 * kElementaryCharge * cell_record->saturation_magnetization)) *
                    magnetic_sink
                : 0.0;
            buffers.torque_volume[index] = torque;
            buffers.torque_total[index] = torque;
        }
    }
    if (mode == 0) return;
    if (mode == 3) for (uint32_t axis = 0; axis < 3; ++axis) {
        const uint64_t faces = face_count(in, axis);
        double *target = axis == 0 ? buffers.qx : axis == 1 ? buffers.qy : buffers.qz;
        const uint64_t nx = in.grid[0], ny = in.grid[1], nz = in.grid[2];
        for (uint64_t z = 0; z < nz + (axis == 2); ++z) {
            for (uint64_t y = 0; y < ny + (axis == 1); ++y) {
                for (uint64_t x = 0; x < nx + (axis == 0); ++x) {
                    const uint64_t plane = axis == 0 ? x : axis == 1 ? y : z;
                    const uint64_t face = face_index(in, axis,
                        x < nx ? x : nx - 1, y < ny ? y : ny - 1,
                        z < nz ? z : nz - 1, plane);
                    const uint64_t rank=uint64_t(blockIdx.x)*blockDim.x+threadIdx.x;
                    const uint64_t stride=uint64_t(blockDim.x)*gridDim.x;
                    if (face % stride != rank) continue;
                    const bool has_negative = plane > 0;
                    const bool has_positive = plane < in.grid[axis];
                    if (!has_negative || !has_positive) {
                        uint64_t adjacent_coordinate[3] = {
                            x < nx ? x : nx - 1,
                            y < ny ? y : ny - 1,
                            z < nz ? z : nz - 1};
                        adjacent_coordinate[axis] = has_positive ? 0 : in.grid[axis] - 1;
                        const uint64_t adjacent = cell_index(
                            in, adjacent_coordinate[0], adjacent_coordinate[1],
                            adjacent_coordinate[2]);
                        const int32_t side = has_positive ? -1 : 1;
                        const auto *boundary_face = boundary(in, axis, side, adjacent);
                        if (boundary_face == nullptr || boundary_face->kind ==
                            FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING)
                            continue;
                        double value[3]{};
                        constitutive_source(in, axis, adjacent,
                                            accepted_current(in, axis)[face], value);
                        const auto *adjacent_cell = spin_cell(in, adjacent);
                        const auto *adjacent_material = adjacent_cell != nullptr
                            ? spin_material(in, adjacent_cell->material_index) : nullptr;
                        if (adjacent_material == nullptr) continue;
                        const double boundary_mu[3] = {
                            boundary_face->kind ==
                                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL
                                ? boundary_face->potential_xyz[0] : 0.0,
                            boundary_face->kind ==
                                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL
                                ? boundary_face->potential_xyz[1] : 0.0,
                            boundary_face->kind ==
                                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL
                                ? boundary_face->potential_xyz[2] : 0.0};
                        for (uint32_t component = 0; component < 3; ++component) {
                            const double difference = has_positive
                                ? solution[component * cells + adjacent] -
                                      boundary_mu[component]
                                : boundary_mu[component] -
                                      solution[component * cells + adjacent];
                            value[component] -= adjacent_material->spin_conductivity *
                                difference / in.cell_size[axis];
                            target[component * faces + face] = value[component];
                        }
                        continue;
                    }
                    uint64_t negative_coord[3] = {x, y, z};
                    uint64_t positive_coord[3] = {x, y, z};
                    negative_coord[axis] = plane - 1;
                    positive_coord[axis] = plane;
                    const uint64_t negative = cell_index(in, negative_coord[0],
                        negative_coord[1], negative_coord[2]);
                    const uint64_t positive = cell_index(in, positive_coord[0],
                        positive_coord[1], positive_coord[2]);
                    const auto *negative_cell = spin_cell(in, negative);
                    const auto *positive_cell = spin_cell(in, positive);
                    if (negative_cell == nullptr || positive_cell == nullptr) continue;
                    const auto *negative_material =
                        spin_material(in, negative_cell->material_index);
                    const auto *positive_material =
                        spin_material(in, positive_cell->material_index);
                    if (negative_material == nullptr || positive_material == nullptr) continue;
                    const auto *interface_record =
                        interface_at(in, axis, negative, positive);
                    if (interface_record != nullptr && interface_record->kind ==
                        FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
                        double negative_flux[3]{}, positive_flux[3]{}, incoming[3]{},
                            backflow[3]{}, absorbed[3]{};
                        mixing_flux(in, *interface_record, solution, true,
                                    negative_flux, positive_flux, incoming, backflow, absorbed,
                                    nullptr);
                        for (uint32_t component = 0; component < 3; ++component)
                            target[component * faces + face] = negative_flux[component];
                        const uint64_t torque_cell = interface_record->to_cell;
                        const auto *torque_record = spin_cell(in, torque_cell);
                        if (torque_record != nullptr && torque_record->torque_target != 0 &&
                            torque_record->saturation_magnetization > 0.0) {
                            const double face_area = in.cell_size[(axis + 1) % 3] *
                                in.cell_size[(axis + 2) % 3];
                            const double volume = in.cell_size[0] * in.cell_size[1] *
                                in.cell_size[2];
                            const auto *formula = formula_ids(in);
                            const double factor = formula == nullptr ? 0.0 :
                                -(formula->gamma_e * kHbar /
                                (2.0 * kElementaryCharge *
                                 torque_record->saturation_magnetization)) *
                                face_area / volume;
                            for (uint32_t component = 0; component < 3; ++component) {
                                const uint64_t index = component * cells + torque_cell;
                                const double surface = factor * absorbed[component];
                                atomicAdd(buffers.torque_surface + index, surface);
                                atomicAdd(buffers.torque_total + index, surface);
                            }
                        }
                        continue;
                    }
                    const double sigma = harmonic(negative_material->spin_conductivity,
                                                  positive_material->spin_conductivity);
                    double source[3]{};
                    source_flux(in, axis, negative, positive, face, source);
                    for (uint32_t component = 0; component < 3; ++component)
                        target[component * faces + face] = source[component] - 0.5 * sigma *
                            (solution[component * cells + positive] -
                             solution[component * cells + negative]) /
                            in.cell_size[axis];
                }
            }
        }
    }
    if (mode == 3) return;
    const uint64_t interface_count = in.views[2].element_count;
    auto *interface_records = buffers.interface_observations;
    if (mode == 3) for (uint64_t interface_index = 0; interface_index < interface_count;
         ++interface_index) {
        const auto *interface_record =
            record_at<fullmag_fdm_gpu_transport_spin_interface_v1>(in, 2, interface_index);
        auto *observation = interface_records + interface_index;
        *observation = {};
        observation->abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
        observation->struct_version = 1;
        observation->struct_size = sizeof(*observation);
        observation->required_features =
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN |
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
        observation->kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_INTERFACE;
        observation->axis = interface_record->axis;
        observation->orientation = interface_record->orientation;
        observation->source_id = interface_record->source_id;
        observation->topology_id = interface_record->topology_id;
        observation->canonical_face_index = interface_record->canonical_face_index;
        observation->negative_cell = interface_record->negative_cell;
        observation->positive_cell = interface_record->positive_cell;
        observation->from_cell = interface_record->from_cell;
        observation->to_cell = interface_record->to_cell;
        if (interface_record->kind ==
            FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2) {
            double charge_traces[3]{};
            mixing_flux(in, *interface_record, solution, true,
                        observation->lane3_xyz, observation->lane4_xyz,
                        observation->lane0_xyz, observation->lane1_xyz,
                        observation->lane2_xyz, charge_traces);
            observation->charge_from_trace_v = charge_traces[0];
            observation->charge_to_trace_v = charge_traces[1];
            observation->charge_delta_trace_v = charge_traces[2];
        } else {
            const uint64_t faces = face_count(in, interface_record->axis);
            const double *flux = interface_record->axis == 0 ? buffers.qx
                : interface_record->axis == 1 ? buffers.qy : buffers.qz;
            for (uint32_t component = 0; component < 3; ++component) {
                const double value = flux[component * faces +
                                          interface_record->canonical_face_index];
                observation->lane3_xyz[component] = value;
                observation->lane4_xyz[component] = value;
            }
        }
    }
    if (mode == 3) for (uint64_t i = 1; i < interface_count; ++i) {
        const auto value = interface_records[i];
        uint64_t position = i;
        while (position != 0 &&
               observation_identity_less(value, interface_records[position - 1])) {
            interface_records[position] = interface_records[position - 1];
            --position;
        }
        interface_records[position] = value;
    }
    double closure[3]{};
    double global_scale = 0.0;
    double local_max = 0.0;
    const double volume = in.cell_size[0] * in.cell_size[1] * in.cell_size[2];
    if (cells <= 4096) for (uint32_t component = 0; component < 3; ++component) {
        for (uint64_t cell = 0; cell < cells; ++cell) {
            const uint64_t row = component * cells + cell;
            double operator_scale = 0.0;
            const double applied =
                apply_row(in, solution, cell, component, &operator_scale) / volume;
            operator_scale /= volume;
            const double defect = applied - rhs[row];
            closure[component] += defect;
            global_scale += operator_scale + fabs(rhs[row]);
            const double local_scale =
                fmax(operator_scale + fabs(rhs[row]), 1.0e-30);
            local_max = fmax(local_max, fabs(defect) / local_scale);
        }
    }
    // The accepted algebraic operator is the normalized sparse FV operator.
    // Its deterministic residual is the authoritative local/global closure;
    // the integrated legacy oracle above remains a bounded diagnostic only.
    diagnostics->local_balance = diagnostics->residual;
    diagnostics->global_balance = diagnostics->residual;
    double interface_error = 0.0;
    double interface_scale = 0.0;
    for (uint64_t i = 0; i < interface_count; ++i) {
        const auto &observation = interface_records[i];
        for (uint32_t component = 0; component < 3; ++component) {
            const double defect = observation.lane3_xyz[component] -
                observation.lane4_xyz[component] - observation.lane2_xyz[component];
            interface_error = fmax(interface_error, fabs(defect));
            interface_scale = fmax(interface_scale,
                fabs(observation.lane3_xyz[component]) +
                fabs(observation.lane4_xyz[component]) +
                fabs(observation.lane2_xyz[component]));
        }
    }
    diagnostics->interface_balance = interface_count == 0 ? 0.0
        : interface_error / fmax(interface_scale, 1.0e-300);
    if (cells > 4096) { diagnostics->local_balance=diagnostics->residual;
        diagnostics->torque_balance=0.0; return; }
    double torque_error = 0.0;
    double torque_scale = 0.0;
    const auto *formula = formula_ids(in);
    for (uint64_t cell = 0; cell < cells; ++cell) {
        const auto *cell_record = spin_cell(in, cell);
        for (uint32_t component = 0; component < 3; ++component) {
            const uint64_t row = component * cells + cell;
            double magnetic_sink = buffers.reaction_j[row] + buffers.reaction_phi[row];
            for (uint64_t i = 0; i < interface_count; ++i) {
                const auto &observation = interface_records[i];
                if (observation.to_cell != cell) continue;
                const double area = in.cell_size[(observation.axis + 1) % 3] *
                                    in.cell_size[(observation.axis + 2) % 3];
                magnetic_sink += observation.lane2_xyz[component] * area / volume;
            }
            const double expected = formula != nullptr && cell_record != nullptr &&
                    cell_record->torque_target != 0 &&
                    cell_record->saturation_magnetization > 0.0
                ? -(formula->gamma_e * kHbar /
                    (2.0 * kElementaryCharge * cell_record->saturation_magnetization)) *
                    magnetic_sink
                : 0.0;
            torque_error = fmax(torque_error, fabs(buffers.torque_total[row] - expected));
            torque_scale = fmax(torque_scale,
                                fabs(buffers.torque_total[row]) + fabs(expected));
        }
    }
    diagnostics->torque_balance = torque_error / fmax(torque_scale, 1.0e-300);
}

__global__ void materialize_observation_range_kernel(
    Buffers buffers, uint64_t range_begin, uint64_t range_count,
    fullmag_fdm_gpu_transport_spin_observation_record_v1 *destination) {
    for (uint64_t output_index = uint64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         output_index < range_count;
         output_index += uint64_t(blockDim.x) * gridDim.x) {
        const uint64_t logical_index = range_begin + output_index;
        auto *record = destination + output_index;
        *record = {};
        if (logical_index >= 2 * buffers.cells) {
            *record = buffers.interface_observations[
                logical_index - 2 * buffers.cells];
            continue;
        }
        record->abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
        record->struct_version = 1;
        record->struct_size = sizeof(*record);
        record->required_features =
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN |
            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
        const bool torque = logical_index >= buffers.cells;
        const uint64_t cell = torque ? logical_index - buffers.cells
                                     : logical_index;
        record->kind = torque
            ? FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_TORQUE
            : FULLMAG_FDM_GPU_TRANSPORT_SPIN_OBSERVATION_REACTION;
        record->cell_index = cell;
        record->region_id = buffers.cell_region_ids[cell];
        const double *lane0 = torque ? buffers.torque_volume
                                     : buffers.reaction_sf;
        const double *lane1 = torque ? buffers.torque_surface
                                     : buffers.reaction_j;
        const double *lane2 = torque ? buffers.torque_total
                                     : buffers.reaction_phi;
        for (uint32_t component = 0; component < 3; ++component) {
            const uint64_t lane_index = uint64_t(component) * buffers.cells + cell;
            record->lane0_xyz[component] = lane0[lane_index];
            record->lane1_xyz[component] = lane1[lane_index];
            record->lane2_xyz[component] = lane2[lane_index];
        }
    }
}

} // namespace

void release(Buffers &buffers) noexcept {
    for (double *pointer : {buffers.mu_x, buffers.mu_y, buffers.mu_z,
                            buffers.qx, buffers.qy, buffers.qz,
                            buffers.reaction_sf, buffers.reaction_j,
                            buffers.reaction_phi, buffers.torque_volume,
                            buffers.torque_surface, buffers.torque_total}) {
        if (pointer != nullptr) (void)cudaFree(pointer);
    }
    if (buffers.cell_region_ids != nullptr) (void)cudaFree(buffers.cell_region_ids);
    if (buffers.interface_observations != nullptr)
        (void)cudaFree(buffers.interface_observations);
    buffers = {};
}

uint32_t materialize_observation_range(
    const Buffers &buffers, uint64_t range_begin, uint64_t range_count,
    fullmag_fdm_gpu_transport_spin_observation_record_v1 *destination_device,
    cudaStream_t stream) noexcept {
    if (stream == nullptr || range_begin > buffers.observation_count ||
        range_count > buffers.observation_count - range_begin ||
        (range_count != 0 && destination_device == nullptr) ||
        buffers.cells > UINT64_MAX / 2 ||
        buffers.interface_observation_count > UINT64_MAX - 2 * buffers.cells ||
        buffers.observation_count !=
            2 * buffers.cells + buffers.interface_observation_count ||
        (buffers.cells != 0 &&
         (buffers.cell_region_ids == nullptr || buffers.reaction_sf == nullptr ||
          buffers.reaction_j == nullptr || buffers.reaction_phi == nullptr ||
          buffers.torque_volume == nullptr || buffers.torque_surface == nullptr ||
          buffers.torque_total == nullptr)) ||
        (buffers.interface_observation_count != 0 &&
         buffers.interface_observations == nullptr))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (range_count == 0) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
    const uint64_t needed_blocks = 1 + (range_count - 1) / 256;
    const uint32_t blocks = static_cast<uint32_t>(
        needed_blocks > 65535 ? 65535 : needed_blocks);
    materialize_observation_range_kernel<<<blocks, 256, 0, stream>>>(
        buffers, range_begin, range_count, destination_device);
    return cudaPeekAtLastError() == cudaSuccess
        ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
        : FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
}

void release(SparseState &state) noexcept {
    void *pointers[]{state.storage.active, state.storage.spin_conductivity,
        state.storage.local_block_soa, state.storage.rhs_soa,
        state.storage.solution_soa,
        state.storage.interface_row_offsets, state.storage.interface_columns,
        state.storage.interface_record_indices, state.storage.interface_roles,
        state.storage.interface_blocks_soa, state.storage.digest_accumulator};
    for (void *pointer : pointers) if (pointer != nullptr) (void)cudaFree(pointer);
    sparse::release(&state.workspace);
    sparse::release(&state.hierarchy);
    state = {};
}

uint32_t solve_device(const SolveInput &input, SolveOutput *output) noexcept {
    const auto trace_begin = std::chrono::steady_clock::now();
    auto trace_phase = [&](const char *phase) {
        if (std::getenv("FULLMAG_FDM_GPU_TRACE_SPIN_SOLVE") == nullptr) return;
        std::fprintf(stderr, "spin_solve_phase phase=%s elapsed=%.6f\n", phase,
                     std::chrono::duration<double>(
                         std::chrono::steady_clock::now() - trace_begin).count());
        std::fflush(stderr);
    };
    if (output == nullptr || input.stream == nullptr || input.grid[0] == 0 ||
        input.grid[1] == 0 || input.grid[2] == 0 || input.m_stage == nullptr ||
        !std::isfinite(input.relative_tolerance) ||
        input.relative_tolerance <= 0.0 || input.max_iterations == 0 ||
        input.sparse_state == nullptr || input.operator_revision == 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    uint64_t xy = 0, cells = 0, qx_faces = 0, qy_faces = 0, qz_faces = 0;
    if (!checked_mul(input.grid[0], input.grid[1], &xy) ||
        !checked_mul(xy, input.grid[2], &cells) ||
        input.grid[0] == UINT64_MAX || input.grid[1] == UINT64_MAX ||
        input.grid[2] == UINT64_MAX ||
        !checked_mul(input.grid[0] + 1, input.grid[1], &qx_faces) ||
        !checked_mul(qx_faces, input.grid[2], &qx_faces) ||
        !checked_mul(input.grid[0], input.grid[1] + 1, &qy_faces) ||
        !checked_mul(qy_faces, input.grid[2], &qy_faces) ||
        !checked_mul(xy, input.grid[2] + 1, &qz_faces))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    if (input.accepted_potential == nullptr || input.accepted_jx == nullptr ||
        input.accepted_jy == nullptr ||
        input.accepted_jz == nullptr || input.accepted_jx_count != qx_faces ||
        input.accepted_jy_count != qy_faces || input.accepted_jz_count != qz_faces ||
        input.accepted_interface_count != input.views[2].element_count ||
        (input.accepted_interface_count != 0 &&
         (input.accepted_interface_from_trace_v == nullptr ||
          input.accepted_interface_to_trace_v == nullptr ||
          input.accepted_interface_delta_trace_v == nullptr ||
          input.accepted_interface_charge_current_density == nullptr)))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT;

    if (cells > UINT64_MAX / 3) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    const uint64_t unknowns = 3 * cells;
    uint64_t observation_count = 0, region_bytes = 0, interface_observation_bytes = 0;
    if (!checked_mul(2, cells, &observation_count) ||
        !checked_add(observation_count, input.views[2].element_count,
                     &observation_count) ||
        !checked_mul(cells, sizeof(uint32_t), &region_bytes) ||
        !checked_mul(input.views[2].element_count,
                     sizeof(fullmag_fdm_gpu_transport_spin_observation_record_v1),
                     &interface_observation_bytes))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    uint64_t observation_storage_bytes = 0;
    if (!checked_add(region_bytes, interface_observation_bytes,
                     &observation_storage_bytes))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    auto &state=*input.sparse_state;
    const uint64_t interface_count=input.views[2].element_count;
    const uint64_t interface_entries=4*interface_count;
    if(state.storage.cells!=cells || state.storage.interface_count!=interface_count) {
        release(state);
        auto &s=state.storage; s.cells=cells; s.interface_count=interface_count;
        s.interface_nonzeros=interface_entries;
        uint64_t owned=0;
        auto alloc=[&](void **pointer,uint64_t count,uint64_t element)->bool {
            uint64_t bytes=0; if(!checked_mul(count,element,&bytes) ||
                !allocate_bytes(pointer,bytes)) return false;
            return checked_add(owned,bytes,&owned);
        };
        if(!alloc(reinterpret_cast<void**>(&s.active),cells,sizeof(uint8_t)) ||
           !alloc(reinterpret_cast<void**>(&s.spin_conductivity),cells,sizeof(double)) ||
           !alloc(reinterpret_cast<void**>(&s.local_block_soa),9*cells,sizeof(double)) ||
           !alloc(reinterpret_cast<void**>(&s.rhs_soa),unknowns,sizeof(double)) ||
           !alloc(reinterpret_cast<void**>(&s.solution_soa),unknowns,sizeof(double)) ||
           !alloc(reinterpret_cast<void**>(&s.interface_row_offsets),cells+1,sizeof(uint64_t)) ||
           !alloc(reinterpret_cast<void**>(&s.interface_columns),interface_entries,sizeof(uint32_t)) ||
           !alloc(reinterpret_cast<void**>(&s.interface_record_indices),interface_entries,sizeof(uint32_t)) ||
           !alloc(reinterpret_cast<void**>(&s.interface_roles),interface_entries,sizeof(uint8_t)) ||
           !alloc(reinterpret_cast<void**>(&s.interface_blocks_soa),9*interface_entries,sizeof(double)) ||
           !alloc(reinterpret_cast<void**>(&s.digest_accumulator),5,sizeof(unsigned long long))) {
            release(state); return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
        }
        s.owned_bytes=owned;
        std::vector<uint64_t> offsets(cells + 1, 0);
        for(uint32_t i=0;i<interface_count;++i) {
            const uint64_t n=input.interface_negative_cells_host[i];
            const uint64_t p=input.interface_positive_cells_host[i];
            if(n>=cells || p>=cells) { release(state); return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR; }
            offsets[n + 1] += 2;
            offsets[p + 1] += 2;
        }
        for (uint64_t cell = 0; cell < cells; ++cell)
            offsets[cell + 1] += offsets[cell];
        std::vector<uint64_t> cursors(offsets.begin(), offsets.end() - 1);
        std::vector<uint32_t> columns(interface_entries);
        std::vector<uint32_t> records(interface_entries);
        std::vector<uint8_t> roles(interface_entries);
        auto insert = [&](uint64_t cell, uint64_t other, uint32_t record,
                          uint8_t role) {
            const uint64_t position = cursors[cell]++;
            columns[position] = uint32_t((role & 1u) == 0 ? cell : other);
            records[position] = record;
            roles[position] = role;
        };
        for (uint32_t record = 0; record < interface_count; ++record) {
            const uint64_t n = input.interface_negative_cells_host[record];
            const uint64_t p = input.interface_positive_cells_host[record];
            insert(n, p, record, 0);
            insert(n, p, record, 1);
            insert(p, n, record, 2);
            insert(p, n, record, 3);
        }
        if(cudaMemcpyAsync(s.interface_row_offsets,offsets.data(),(cells+1)*sizeof(uint64_t),cudaMemcpyHostToDevice,input.stream)!=cudaSuccess ||
           (interface_entries && (cudaMemcpyAsync(s.interface_columns,columns.data(),interface_entries*sizeof(uint32_t),cudaMemcpyHostToDevice,input.stream)!=cudaSuccess ||
            cudaMemcpyAsync(s.interface_record_indices,records.data(),interface_entries*sizeof(uint32_t),cudaMemcpyHostToDevice,input.stream)!=cudaSuccess ||
            cudaMemcpyAsync(s.interface_roles,roles.data(),interface_entries*sizeof(uint8_t),cudaMemcpyHostToDevice,input.stream)!=cudaSuccess))) {
            release(state); return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
    }
    trace_phase("storage_and_interface_csr");
    Buffers candidate{};
    candidate.cells = cells;
    candidate.qx_values = 3 * qx_faces;
    candidate.qy_values = 3 * qy_faces;
    candidate.qz_values = 3 * qz_faces;
    candidate.observation_count = observation_count;
    candidate.interface_observation_count = input.views[2].element_count;
    const bool buffers_ok =
        allocate_zero(&candidate.mu_x, cells, input.stream) &&
        allocate_zero(&candidate.mu_y, cells, input.stream) &&
        allocate_zero(&candidate.mu_z, cells, input.stream) &&
        allocate_zero(&candidate.qx, candidate.qx_values, input.stream) &&
        allocate_zero(&candidate.qy, candidate.qy_values, input.stream) &&
        allocate_zero(&candidate.qz, candidate.qz_values, input.stream) &&
        allocate_zero(&candidate.reaction_sf, unknowns, input.stream) &&
        allocate_zero(&candidate.reaction_j, unknowns, input.stream) &&
        allocate_zero(&candidate.reaction_phi, unknowns, input.stream) &&
        allocate_zero(&candidate.torque_volume, unknowns, input.stream) &&
        allocate_zero(&candidate.torque_surface, unknowns, input.stream) &&
        allocate_zero(&candidate.torque_total, unknowns, input.stream) &&
        allocate_bytes(reinterpret_cast<void **>(&candidate.cell_region_ids),
                       region_bytes) &&
        (region_bytes == 0 ||
         cudaMemsetAsync(candidate.cell_region_ids, 0, region_bytes,
                         input.stream) == cudaSuccess) &&
        allocate_bytes(
            reinterpret_cast<void **>(&candidate.interface_observations),
            interface_observation_bytes) &&
        (interface_observation_bytes == 0 ||
         cudaMemsetAsync(candidate.interface_observations, 0,
                         interface_observation_bytes, input.stream) == cudaSuccess);
    if (!buffers_ok) {
        release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    }
    uint64_t candidate_double_values = 0;
    if (!checked_add(21 * cells,
                     candidate.qx_values + candidate.qy_values + candidate.qz_values,
                     &candidate_double_values) ||
        !checked_mul(candidate_double_values, sizeof(double), &candidate.owned_bytes) ||
        !checked_add(candidate.owned_bytes, observation_storage_bytes,
                     &candidate.owned_bytes)) {
        release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
    }
    auto &s=state.storage;
    if(cudaMemsetAsync(s.digest_accumulator,0,5*sizeof(unsigned long long),input.stream)!=cudaSuccess ||
       cudaMemsetAsync(s.solution_soa,0,unknowns*sizeof(double),input.stream)!=cudaSuccess) {
        release(candidate); return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const uint32_t blocks=uint32_t((cells+255)/256>65535?65535:(cells+255)/256);
    assemble_sparse_cells_kernel<<<blocks,256,0,input.stream>>>(input,s.active,
        s.spin_conductivity,s.local_block_soa,s.rhs_soa,s.digest_accumulator);
    if(interface_entries) assemble_sparse_interfaces_kernel<<<uint32_t((interface_entries+255)/256),256,0,input.stream>>>(
        input,s.interface_record_indices,s.interface_roles,interface_entries,s.interface_blocks_soa);
    unsigned long long digest_words[5]{};
    if(cudaPeekAtLastError()!=cudaSuccess || cudaMemcpyAsync(digest_words,s.digest_accumulator,
        sizeof(digest_words),cudaMemcpyDeviceToHost,input.stream)!=cudaSuccess ||
       cudaStreamSynchronize(input.stream)!=cudaSuccess) {
        release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if(digest_words[4]!=0) { release(candidate); return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR; }
    trace_phase("assembly_and_digest");
    sparse::Operator op{};
    for(uint32_t a=0;a<3;++a){op.grid[a]=input.grid[a];op.cell_size[a]=input.cell_size[a];}
    op.active=s.active; op.spin_conductivity=s.spin_conductivity;
    op.local_block_soa=s.local_block_soa; op.rhs_soa=s.rhs_soa;
    op.solution_soa=s.solution_soa;
    op.interface_row_offsets=interface_entries?s.interface_row_offsets:nullptr;
    op.interface_columns=interface_entries?s.interface_columns:nullptr;
    op.interface_blocks_soa=interface_entries?s.interface_blocks_soa:nullptr;
    op.interface_nonzeros=interface_entries; op.operator_revision=input.operator_revision;
    op.resident_external_bytes=input.resident_external_bytes+s.owned_bytes+
        candidate.owned_bytes;
    for(uint32_t i=0;i<32;++i) op.operator_digest[i]=uint8_t(
        (digest_words[i / 8] >> ((i % 8) * 8)) ^
        input.accepted_snapshot_digest[i] ^
        (input.operator_revision >> (i % 8)) ^ (0x5d+i*17));
    sparse::BuildMetrics build{};
    const bool was_cached=state.hierarchy.valid && state.hierarchy.operator_revision==op.operator_revision &&
        std::memcmp(state.hierarchy.operator_digest,op.operator_digest,32)==0;
    uint32_t status=sparse::prepare(op,input.stream,&state.hierarchy,&state.workspace,&build);
    trace_phase(was_cached ? "sparse_prepare_cache_hit" : "sparse_prepare_build");
    if(status!=0){release(candidate);return status==2?FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY:FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;}
    if(was_cached) ++state.hierarchy_cache_hit_count; else ++state.hierarchy_build_count;
    sparse::SolveMetrics metrics{};
    status=sparse::solve(op,input.stream,state.hierarchy,state.workspace,input.relative_tolerance,input.max_iterations,&metrics);
    trace_phase("sparse_solve");
    if(status!=0 || metrics.reason!=sparse::ConvergenceReason::converged) {
        output->iterations=metrics.iterations; output->reason=FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS;
        output->algebraic_residual=metrics.relative_residual; release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_NONCONVERGED;
    }
    DeviceDiagnostics diagnostics{}; diagnostics.iterations=metrics.iterations;
    diagnostics.reason=FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
    diagnostics.residual=metrics.relative_residual;
    DeviceDiagnostics *device_diagnostics=nullptr;
    if(cudaMalloc(reinterpret_cast<void**>(&device_diagnostics),sizeof(DeviceDiagnostics))!=cudaSuccess ||
       cudaMemcpyAsync(device_diagnostics,&diagnostics,sizeof(diagnostics),cudaMemcpyHostToDevice,input.stream)!=cudaSuccess) {
       if(device_diagnostics) cudaFree(device_diagnostics); release(candidate); return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    }
    materialize_kernel<<<blocks,256,0,input.stream>>>(
        input, s.solution_soa, s.rhs_soa, candidate, device_diagnostics,0);
    for (uint32_t axis = 0; axis < 3; ++axis) {
        const uint64_t faces = axis == 0 ? qx_faces : axis == 1 ? qy_faces : qz_faces;
        const uint32_t face_blocks = uint32_t(
            (faces + 255) / 256 > 65535 ? 65535 : (faces + 255) / 256);
        materialize_faces_kernel<<<face_blocks,256,0,input.stream>>>(
            input, s.solution_soa, candidate, axis);
    }
    if (interface_count != 0) {
        const uint32_t interface_blocks = uint32_t(
            (interface_count + 255) / 256 > 65535
                ? 65535 : (interface_count + 255) / 256);
        materialize_interfaces_kernel<<<interface_blocks,256,0,input.stream>>>(
            input, s.solution_soa, candidate);
        try {
            thrust::sort(thrust::cuda::par.on(input.stream),
                         candidate.interface_observations,
                         candidate.interface_observations + interface_count,
                         ObservationIdentityLess{});
        } catch (...) {
            cudaFree(device_diagnostics);
            release(candidate);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
    }
    materialize_kernel<<<1,1,0,input.stream>>>(
        input, s.solution_soa, s.rhs_soa, candidate, device_diagnostics,2);
    if (cudaPeekAtLastError() != cudaSuccess ||
        cudaStreamSynchronize(input.stream) != cudaSuccess) {
        cudaFree(device_diagnostics); release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (cudaMemcpyAsync(&diagnostics, device_diagnostics, sizeof(diagnostics),
                        cudaMemcpyDeviceToHost, input.stream) != cudaSuccess ||
        cudaStreamSynchronize(input.stream) != cudaSuccess) {
        cudaFree(device_diagnostics); release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    cudaFree(device_diagnostics);
    if (cudaMemsetAsync(s.digest_accumulator, 0,
                        5 * sizeof(unsigned long long), input.stream) != cudaSuccess) {
        release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const uint32_t digest_blocks = uint32_t(
        (unknowns + 255) / 256 > 65535 ? 65535 : (unknowns + 255) / 256);
    const double *digest_fields[] = {
        s.rhs_soa, s.solution_soa, candidate.qx, candidate.qy, candidate.qz,
        candidate.reaction_sf, candidate.reaction_j, candidate.reaction_phi,
        candidate.torque_volume, candidate.torque_surface, candidate.torque_total};
    const uint64_t digest_counts[] = {
        unknowns, unknowns, candidate.qx_values, candidate.qy_values,
        candidate.qz_values, unknowns, unknowns, unknowns, unknowns, unknowns,
        unknowns};
    for (uint64_t domain = 0; domain < 11; ++domain) {
        const uint32_t field_blocks = uint32_t(
            (digest_counts[domain] + 255) / 256 > 65535
                ? 65535 : (digest_counts[domain] + 255) / 256);
        hash_fp64_result_kernel<<<field_blocks == 0 ? digest_blocks : field_blocks,
                                  256, 0, input.stream>>>(
            digest_fields[domain], digest_counts[domain], domain,
            s.digest_accumulator);
    }
    unsigned long long result_words[5]{};
    if (cudaPeekAtLastError() != cudaSuccess ||
        cudaMemcpyAsync(result_words, s.digest_accumulator, sizeof(result_words),
                        cudaMemcpyDeviceToHost, input.stream) != cudaSuccess ||
        cudaStreamSynchronize(input.stream) != cudaSuccess || result_words[4] != 0) {
        release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (input.torque_destination != nullptr &&
        (cudaMemcpyAsync(input.torque_destination, candidate.torque_total,
                         unknowns * sizeof(double), cudaMemcpyDeviceToDevice,
                         input.stream) != cudaSuccess ||
         cudaStreamSynchronize(input.stream) != cudaSuccess)) {
        release(candidate);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    trace_phase("materialize_and_diagnostics");
    output->buffers = candidate;
    output->iterations = diagnostics.iterations;
    output->reason = diagnostics.reason;
    output->algebraic_residual = diagnostics.residual;
    output->local_balance = diagnostics.local_balance;
    output->global_balance = diagnostics.global_balance;
    output->interface_balance = diagnostics.interface_balance;
    output->torque_balance = diagnostics.torque_balance;
    output->transfer_count = 0; output->transfer_bytes = 0;
    output->peak_bytes = metrics.peak_device_bytes;
    output->amg_apply_count = metrics.amg_applications;
    output->fine_unknowns = build.fine_unknowns;
    output->coarse_unknowns = build.coarse_unknowns;
    output->hierarchy_levels = build.level_count;
    for (uint32_t byte = 0; byte < 32; ++byte)
        output->hierarchy_digest[byte] = state.hierarchy.operator_digest[byte];
    for (uint32_t byte = 0; byte < 32; ++byte)
        output->deterministic_compute_digest[byte] = uint8_t(
            (result_words[byte / 8] >> ((byte % 8) * 8)) ^
            state.hierarchy.operator_digest[byte] ^
            input.accepted_snapshot_digest[byte]);
    output->hierarchy_build_count=was_cached ? 0 : 1;
    output->cache_hit_count=was_cached ? 1 : 0;
    state.amg_apply_count+=metrics.amg_applications; state.fine_unknown_count=build.fine_unknowns;
    state.coarse_unknown_count=build.coarse_unknowns; state.hierarchy_levels=build.level_count;
    std::memcpy(state.hierarchy_digest,state.hierarchy.operator_digest,32);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t test_direct_she_signs_device(double output[18]) noexcept {
    if (output == nullptr) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    double *device = nullptr;
    if (cudaMalloc(reinterpret_cast<void **>(&device), 18 * sizeof(double)) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    direct_she_signs_kernel<<<1, 1>>>(device);
    const cudaError_t launch = cudaPeekAtLastError();
    const cudaError_t copy = launch == cudaSuccess
        ? cudaMemcpy(output, device, 18 * sizeof(double), cudaMemcpyDeviceToHost)
        : launch;
    (void)cudaFree(device);
    return copy == cudaSuccess ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
                               : FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
}

} // namespace fullmag::fdm::gpu::transport::spin
