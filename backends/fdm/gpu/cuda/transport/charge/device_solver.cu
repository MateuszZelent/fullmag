#include "device_solver.hpp"
#include "cudss_solver.hpp"

#include <cooperative_groups.h>

#ifdef small
// cooperative_groups.h may restore the Windows RPC `small` macro.
#undef small
#endif

#include <algorithm>
#include <cfloat>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

namespace fullmag::fdm::gpu::transport::charge {
namespace {

namespace cg = cooperative_groups;

constexpr uint32_t kThreads = 256;
constexpr uint32_t kMaxCoopBlocks = 1024;
constexpr uint64_t kBlock0CellThreshold = 1024;
constexpr uint32_t kCoarsestHalfSweeps = 16; // 16 (R,B) + 16 (B,R) symmetric sweeps
constexpr uint64_t kHashChunkSize = 1024;

bool inject_cuda_failure(CudaFailurePolicy *policy, uint32_t boundary) {
    if (policy == nullptr || boundary == 0 ||
        policy->requested_boundary != boundary)
        return false;
    policy->failed_boundary = boundary;
    return true;
}

struct LegacyChargeFaceV1 {
    uint32_t kind;
    uint32_t axis;
    int32_t side;
    uint32_t reserved;
    uint64_t adjacent_cell;
    double area;
    double value;
};
static_assert(sizeof(LegacyChargeFaceV1) == 40);

struct DeviceSolveMetrics {
    uint64_t iterations;
    uint64_t amg_apply_count;
    uint32_t reason;
    uint32_t hierarchy_levels;
    uint32_t candidate_nonfinite;
    uint32_t reserved0;
    double algebraic_residual;
    double physical_residual;
    double component_balance;
    double electrode_balance;
    double debug_rho;
    double debug_denominator;
    double debug_transverse_max;
    uint64_t fine_unknown_count;
    uint64_t coarse_unknown_count;
    uint8_t hierarchy_digest[32];
};

struct DeviceHierarchyInfo {
    uint64_t coarse_cells;
    uint64_t edge_count;
    uint64_t coarse_nx;
    uint64_t coarse_ny;
    uint64_t coarse_nz;
    uint32_t level_count;
    uint32_t reserved0;
    uint8_t digest[32];
};

struct DeviceAmgHierarchy {
    CoarseLevel levels[kMaxAmgLevels];
    uint32_t level_count;
    uint32_t split_level;
};

struct DeviceAmgVectors {
    double *rhs[kMaxAmgLevels];
    double *u[kMaxAmgLevels];
};

struct DevicePcgState {
    double norm_b;
    double rho;
    double residual_norm;
    double alpha;
    double beta;
    double scalar0;
    double scalar1;
    double scalar2;
    uint64_t completed;
    uint64_t active_count;
    uint32_t reason;
    uint32_t changed;
};

__device__ void load_charge_face(
    const void *, uint64_t, uint64_t, uint32_t *, uint32_t *, int32_t *,
    uint64_t *, double *, double *);
__device__ uint64_t load_charge_source_id(const void *, uint64_t, uint64_t);

struct DeviceSha256 {
    uint32_t state[8];
    alignas(4) uint8_t block[64];
    uint64_t bytes;
    uint32_t used;
};

__device__ uint32_t sha_rotr(uint32_t value, uint32_t shift) {
    return (value >> shift) | (value << (32 - shift));
}

__device__ void sha_transform(DeviceSha256 *sha) {
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
    #pragma unroll
    for (uint32_t i = 0; i < 16; ++i)
        w[i] = (uint32_t(sha->block[4*i]) << 24) | (uint32_t(sha->block[4*i+1]) << 16) |
               (uint32_t(sha->block[4*i+2]) << 8) | uint32_t(sha->block[4*i+3]);
    #pragma unroll
    for (uint32_t i = 16; i < 64; ++i) {
        const uint32_t s0 = sha_rotr(w[i-15],7) ^ sha_rotr(w[i-15],18) ^ (w[i-15] >> 3);
        const uint32_t s1 = sha_rotr(w[i-2],17) ^ sha_rotr(w[i-2],19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a=sha->state[0],b=sha->state[1],c=sha->state[2],d=sha->state[3];
    uint32_t e=sha->state[4],f=sha->state[5],g=sha->state[6],h=sha->state[7];
    #pragma unroll
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

__device__ void sha_init(DeviceSha256 *sha) {
    const uint32_t initial[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                               0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    for(uint32_t i=0;i<8;++i) sha->state[i]=initial[i];
    sha->bytes=0;sha->used=0;
}

__device__ void sha_update(DeviceSha256 *sha, const void *source, uint64_t length) {
    const auto *bytes = static_cast<const uint8_t *>(source);
    sha->bytes += length;
    uint64_t i = 0;
    while (i < length && sha->used != 0) {
        sha->block[sha->used++] = bytes[i++];
        if (sha->used == 64) {
            sha_transform(sha);
            sha->used = 0;
        }
    }
    if (sha->used == 0 && i + 64 <= length &&
        ((reinterpret_cast<uintptr_t>(bytes + i) & 3u) == 0u)) {
        auto *dst_words = reinterpret_cast<uint32_t *>(sha->block);
        while (i + 64 <= length) {
            const auto *src_words = reinterpret_cast<const uint32_t *>(bytes + i);
            #pragma unroll
            for (uint32_t word = 0; word < 16; ++word) dst_words[word] = src_words[word];
            sha_transform(sha);
            i += 64;
        }
    }
    while (i < length) {
        sha->block[sha->used++] = bytes[i++];
        if (sha->used == 64) {
            sha_transform(sha);
            sha->used = 0;
        }
    }
}

__device__ void sha_segment(DeviceSha256 *sha, uint32_t tag,
                            const void *source, uint64_t length) {
    sha_update(sha,&tag,sizeof(tag));
    sha_update(sha,&length,sizeof(length));
    sha_update(sha,source,length);
}

__device__ void sha_finish(DeviceSha256 *sha, uint8_t digest[32]) {
    const uint64_t bit_count=sha->bytes*8;
    sha->block[sha->used++]=0x80;
    if(sha->used>56){while(sha->used<64)sha->block[sha->used++]=0;sha_transform(sha);sha->used=0;}
    while(sha->used<56)sha->block[sha->used++]=0;
    for(int i=7;i>=0;--i)sha->block[sha->used++]=uint8_t(bit_count>>(8*i));
    sha_transform(sha);
    for(uint32_t i=0;i<8;++i)for(uint32_t j=0;j<4;++j)
        digest[4*i+j]=uint8_t(sha->state[i]>>(24-8*j));
}

__global__ void content_digest_kernel(
    Buffers buffers, const void *charge_faces, uint64_t charge_face_count,
    uint64_t charge_face_stride, const void *interfaces, uint64_t interface_stride,
    ContentDigestIdentity identity, uint8_t *digest) {
    if(blockIdx.x!=0||threadIdx.x!=0)return;
    DeviceSha256 sha{};sha_init(&sha);
    const auto *identity_bytes = reinterpret_cast<const uint8_t *>(&identity);
    sha_segment(&sha,1,identity_bytes + offsetof(ContentDigestIdentity, static_digest),
                sizeof(identity.static_digest));
    sha_segment(&sha,2,identity_bytes + offsetof(ContentDigestIdentity, lineage),
                sizeof(identity.lineage));
    sha_segment(&sha,3,&identity.accepted_sequence,sizeof(identity.accepted_sequence));
    sha_segment(&sha,4,identity_bytes + offsetof(ContentDigestIdentity, grid),sizeof(identity.grid));
    sha_segment(&sha,5,identity_bytes + offsetof(ContentDigestIdentity, cell_size),sizeof(identity.cell_size));
    sha_segment(&sha,6,&identity.descriptor_revision,sizeof(identity.descriptor_revision));
    sha_segment(&sha,7,&identity.source_revision,sizeof(identity.source_revision));
    sha_segment(&sha,8,buffers.active,buffers.cells);
    sha_segment(&sha,9,buffers.potential,buffers.cells*sizeof(double));
    sha_segment(&sha,10,buffers.jx,buffers.jx_count*sizeof(double));
    sha_segment(&sha,11,buffers.jy,buffers.jy_count*sizeof(double));
    sha_segment(&sha,12,buffers.jz,buffers.jz_count*sizeof(double));
    uint64_t exact_count=0;
    for(uint64_t i=0;i<charge_face_count;++i){
        uint32_t kind=0,axis=0;int32_t side=0;uint64_t adjacent=0;double area=0,value=0;
        load_charge_face(charge_faces,charge_face_stride,i,&kind,&axis,&side,&adjacent,&area,&value);
        if(kind==FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY)++exact_count;
    }
    sha_segment(&sha,13,&exact_count,sizeof(exact_count));
    for(uint64_t i=0;i<charge_face_count;++i){
        uint32_t kind=0,axis=0;int32_t side=0;uint64_t adjacent=0;double area=0,value=0;
        load_charge_face(charge_faces,charge_face_stride,i,&kind,&axis,&side,&adjacent,&area,&value);
        if(kind!=FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY)continue;
        sha_update(&sha,&adjacent,sizeof(adjacent));sha_update(&sha,&axis,sizeof(axis));
        sha_update(&sha,&side,sizeof(side));sha_update(&sha,&area,sizeof(area));
        const uint64_t source_id=load_charge_source_id(charge_faces,charge_face_stride,i);
        sha_update(&sha,&value,sizeof(value));sha_update(&sha,&source_id,sizeof(source_id));
    }
    sha_segment(&sha,14,&buffers.interface_count,sizeof(buffers.interface_count));
    const double *trace_arrays[4]={buffers.interface_from_trace_v,buffers.interface_to_trace_v,
        buffers.interface_delta_trace_v,buffers.interface_charge_current_density};
    (void)interfaces;
    (void)interface_stride;
    for(uint32_t lane=0;lane<4;++lane){
        const uint32_t tag=15+lane;
        const uint64_t bytes=buffers.interface_count*sizeof(double);
        sha_update(&sha,&tag,sizeof(tag));sha_update(&sha,&bytes,sizeof(bytes));
        sha_update(&sha,trace_arrays[lane],bytes);
    }
    sha_finish(&sha,digest);
}

__device__ uint64_t cell_index(uint64_t x, uint64_t y, uint64_t z,
                               uint64_t nx, uint64_t ny) {
    return x + nx * (y + ny * z);
}

__device__ double harmonic(double a, double b) {
    return 2.0 / (1.0 / a + 1.0 / b);
}

__device__ uint64_t boundary_ordinal(uint32_t axis, int32_t side,
    uint64_t x, uint64_t y, uint64_t z, uint64_t nx, uint64_t ny, uint64_t nz) {
    const uint64_t x_faces = 2 * ny * nz;
    const uint64_t y_faces = 2 * nx * nz;
    if (axis == 0) return (side > 0 ? ny * nz : 0) + y + ny * z;
    if (axis == 1) return x_faces + (side > 0 ? nx * nz : 0) + x + nx * z;
    return x_faces + y_faces + (side > 0 ? nx * ny : 0) + x + nx * y;
}

__device__ double internal_face_conductance(
    uint32_t axis, uint64_t canonical_face, uint64_t a, uint64_t b,
    double h, double area, const double *sigma, const void *interface_payload,
    uint64_t interface_count, uint64_t interface_stride) {
    uint64_t begin = 0, end = interface_count;
    while (begin < end) {
        const uint64_t middle = begin + (end - begin) / 2;
        const auto *candidate = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(
            reinterpret_cast<const uint8_t *>(interface_payload) + middle * interface_stride);
        if (candidate->axis < axis ||
            (candidate->axis == axis && candidate->canonical_face_index < canonical_face))
            begin = middle + 1;
        else
            end = middle;
    }
    if (begin < interface_count) {
        const auto *record = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(
            reinterpret_cast<const uint8_t *>(interface_payload) + begin * interface_stride);
        if (record->axis == axis && record->canonical_face_index == canonical_face) {
            if (record->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_TRANSPARENT)
                return harmonic(sigma[a], sigma[b]) * area / h;
            const double total = record->G_up + record->G_down;
            if (total == 0.0) return 0.0;
            return record->area /
                (0.5 * h / sigma[a] + 1.0 / total + 0.5 * h / sigma[b]);
        }
    }
    return harmonic(sigma[a], sigma[b]) * area / h;
}

__global__ void normalize_charge_payload_kernel(
    const void *mask_payload, uint64_t mask_stride, uint32_t mask_type,
    const void *material_payload, uint64_t material_count, uint64_t material_stride,
    uint32_t material_type, uint64_t cells, uint8_t *active, double *sigma) {
    for (uint64_t i = blockIdx.x * blockDim.x + threadIdx.x; i < cells;
         i += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        uint32_t material_index = static_cast<uint32_t>(i);
        if (mask_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8) {
            active[i] = *(reinterpret_cast<const uint8_t *>(mask_payload) + i * mask_stride) != 0;
        } else {
            const auto *cell = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_cell_v1 *>(
                reinterpret_cast<const uint8_t *>(mask_payload) + i * mask_stride);
            active[i] = cell->active != 0 && cell->conductor != 0;
            material_index = cell->material_index;
        }
        double value = 0.0;
        if (material_type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64) {
            const uint64_t source = material_count == 1 ? 0 : i;
            value = *reinterpret_cast<const double *>(
                reinterpret_cast<const uint8_t *>(material_payload) + source * material_stride);
        } else {
            for (uint64_t material = 0; material < material_count; ++material) {
                const auto *record = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_material_v1 *>(
                    reinterpret_cast<const uint8_t *>(material_payload) + material * material_stride);
                if (record->material_index == material_index) {
                    value = record->conductivity;
                    break;
                }
            }
        }
        sigma[i] = active[i] ? value : 0.0;
    }
}

__device__ void load_charge_face(const void *payload, uint64_t stride, uint64_t index,
                                 uint32_t *kind, uint32_t *axis, int32_t *side,
                                 uint64_t *adjacent_cell, double *area, double *value) {
    const uint8_t *bytes = reinterpret_cast<const uint8_t *>(payload) + index * stride;
    if (stride == sizeof(LegacyChargeFaceV1)) {
        const auto *face = reinterpret_cast<const LegacyChargeFaceV1 *>(bytes);
        *kind = face->kind;
        *axis = face->axis;
        *side = face->side;
        *adjacent_cell = face->adjacent_cell;
        *area = face->area;
        *value = face->value;
    } else {
        const auto *face = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_face_v1 *>(bytes);
        *kind = face->kind;
        *axis = face->axis;
        *side = face->side;
        *adjacent_cell = face->adjacent_cell;
        *area = face->area;
        *value = face->value;
    }
}

__device__ uint64_t load_charge_source_id(
    const void *payload, uint64_t stride, uint64_t index) {
    if (stride == sizeof(LegacyChargeFaceV1)) return index + 1;
    const auto *face = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_face_v1 *>(
        reinterpret_cast<const uint8_t *>(payload) + index * stride);
    return face->source_id;
}

__device__ bool load_active_cell(const void *payload, uint64_t stride,
                                 uint32_t type, uint64_t index) {
    if (type == FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8)
        return *(reinterpret_cast<const uint8_t *>(payload) + index * stride) != 0;
    const auto *cell = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_cell_v1 *>(
        reinterpret_cast<const uint8_t *>(payload) + index * stride);
    return cell->active != 0 && cell->conductor != 0;
}

__global__ void validate_static_payload_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, double hx, double hy, double hz,
    const void *mask_payload, uint64_t mask_stride, uint32_t mask_type,
    const void *face_payload, uint64_t face_count, uint64_t face_stride,
    uint32_t *seen_faces, uint32_t *invalid) {
    const uint64_t cells = nx * ny * nz;
    if (blockIdx.x == 0 && threadIdx.x == 0) {
        const uint64_t expected_faces = 2 * (ny * nz + nx * nz + nx * ny);
        if (face_count != expected_faces) atomicCAS(invalid, 0u, 1u);
    }
    for (uint64_t f = blockIdx.x * blockDim.x + threadIdx.x; f < face_count;
         f += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        uint32_t kind = 0, axis = 0; int32_t side = 0; uint64_t adjacent = 0;
        double area = 0.0, value = 0.0;
        load_charge_face(face_payload, face_stride, f, &kind, &axis, &side,
                         &adjacent, &area, &value);
        uint32_t invalid_code = 0;
        bool bad = kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INVALID ||
            kind > FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING || axis > 2 ||
            (side != -1 && side != 1) || adjacent >= cells || !isfinite(area) ||
            area <= 0.0 || !isfinite(value) ||
            (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING && value != 0.0);
        if (bad) invalid_code = 2;
        if (!bad) {
            const uint64_t x = adjacent % nx;
            const uint64_t yz = adjacent / nx;
            const uint64_t y = yz % ny;
            const uint64_t z = yz / ny;
            const uint64_t coordinate = axis == 0 ? x : axis == 1 ? y : z;
            const uint64_t extent = axis == 0 ? nx : axis == 1 ? ny : nz;
            const double expected_area = axis == 0 ? hy * hz : axis == 1 ? hx * hz : hx * hy;
            bad = (side == -1 && coordinate != 0) ||
                  (side == 1 && coordinate + 1 != extent) ||
                  fabs(area - expected_area) > 1.0e-12 * expected_area ||
                  !load_active_cell(mask_payload, mask_stride, mask_type, adjacent);
            if (bad) invalid_code = 3;
        }
        if (!bad && face_stride >= sizeof(fullmag_fdm_gpu_transport_charge_face_v1)) {
            const auto *face = reinterpret_cast<const fullmag_fdm_gpu_transport_charge_face_v1 *>(
                reinterpret_cast<const uint8_t *>(face_payload) + f * face_stride);
            const uint64_t x = adjacent % nx;
            const uint64_t yz = adjacent / nx;
            const uint64_t y = yz % ny;
            const uint64_t z = yz / ny;
            const uint64_t expected_index = axis == 0
                ? (side < 0 ? 0 : nx) + (nx + 1) * (y + ny * z)
                : axis == 1
                    ? x + nx * ((side < 0 ? 0 : ny) + (ny + 1) * z)
                    : x + nx * (y + ny * (side < 0 ? 0 : nz));
            bad = face->outward_sign != side || face->canonical_face_index != expected_index ||
                  face->source_id == 0;
            if (bad) invalid_code = 4;
        }
        if (!bad) {
            const uint64_t x = adjacent % nx;
            const uint64_t yz = adjacent / nx;
            const uint64_t y = yz % ny;
            const uint64_t z = yz / ny;
            const uint64_t x_faces = 2 * ny * nz;
            const uint64_t y_faces = 2 * nx * nz;
            const uint64_t side_offset = side > 0 ? 1 : 0;
            const uint64_t boundary_ordinal_value = axis == 0
                ? side_offset * ny * nz + y + ny * z
                : axis == 1
                    ? x_faces + side_offset * nx * nz + x + nx * z
                    : x_faces + y_faces + side_offset * nx * ny + x + nx * y;
            bad = boundary_ordinal_value >= face_count ||
                  atomicCAS(seen_faces + boundary_ordinal_value, 0u, 1u) != 0u;
            if (bad) invalid_code = 5;
        }
        if (bad) atomicCAS(invalid, 0u, invalid_code);
    }
}

__global__ void assemble_charge_fv_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, double hx, double hy, double hz,
    const uint8_t *active, const double *sigma, const void *face_payload,
    uint64_t face_count, uint64_t face_stride, const void *interface_payload,
    uint64_t interface_count, uint64_t interface_stride, double *diag, double *rhs,
    double *gx, double *gy, double *gz) {
    const uint64_t cells = nx * ny * nz;
    for (uint64_t i = blockIdx.x * blockDim.x + threadIdx.x; i < cells;
         i += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        if (!active[i]) {
            diag[i] = 1.0;
            rhs[i] = 0.0;
            gx[i] = gy[i] = gz[i] = 0.0;
            continue;
        }
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny;
        const uint64_t z = yz / ny;
        const double ax = hy * hz;
        const double ay = hx * hz;
        const double az = hx * hy;
        const uint64_t x_face = x + 1 + (nx + 1) * (y + ny * z);
        const uint64_t y_face = x + nx * ((y + 1) + (ny + 1) * z);
        const uint64_t z_face = x + nx * (y + ny * (z + 1));
        gx[i] = x + 1 < nx && active[i + 1]
                    ? internal_face_conductance(0, x_face, i, i + 1, hx, ax, sigma,
                        interface_payload, interface_count, interface_stride) : 0.0;
        gy[i] = y + 1 < ny && active[i + nx]
                    ? internal_face_conductance(1, y_face, i, i + nx, hy, ay, sigma,
                        interface_payload, interface_count, interface_stride) : 0.0;
        gz[i] = z + 1 < nz && active[i + nx * ny]
                    ? internal_face_conductance(2, z_face, i, i + nx * ny, hz, az, sigma,
                        interface_payload, interface_count, interface_stride) : 0.0;
        double diagonal = gx[i] + gy[i] + gz[i];
        if (x > 0 && active[i - 1])
            diagonal += internal_face_conductance(
                0, x + (nx + 1) * (y + ny * z), i - 1, i, hx, ax, sigma,
                interface_payload, interface_count, interface_stride);
        if (y > 0 && active[i - nx])
            diagonal += internal_face_conductance(
                1, x + nx * (y + (ny + 1) * z), i - nx, i, hy, ay, sigma,
                interface_payload, interface_count, interface_stride);
        if (z > 0 && active[i - nx * ny])
            diagonal += internal_face_conductance(
                2, x + nx * (y + ny * z), i - nx * ny, i, hz, az, sigma,
                interface_payload, interface_count, interface_stride);
        double source = 0.0;
        const uint64_t coordinates[3] = {x, y, z};
        const uint64_t extents[3] = {nx, ny, nz};
        for (uint32_t boundary_axis = 0; boundary_axis < 3; ++boundary_axis) {
            for (int32_t boundary_side = -1; boundary_side <= 1; boundary_side += 2) {
                if ((boundary_side < 0 && coordinates[boundary_axis] != 0) ||
                    (boundary_side > 0 && coordinates[boundary_axis] + 1 != extents[boundary_axis]))
                    continue;
                const uint64_t f = boundary_ordinal(
                    boundary_axis, boundary_side, x, y, z, nx, ny, nz);
                if (f >= face_count) continue;
                uint32_t kind = 0, axis = 0;
                int32_t side = 0;
                uint64_t adjacent = 0;
                double area = 0.0, value = 0.0;
                load_charge_face(face_payload, face_stride, f, &kind, &axis, &side,
                                 &adjacent, &area, &value);
                if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE) {
                    const double normal_h = axis == 0 ? hx : axis == 1 ? hy : hz;
                    const double conductance = 2.0 * sigma[i] * area / normal_h;
                    diagonal += conductance;
                    source += conductance * value;
                } else if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY) {
                    source -= value * area;
                }
            }
        }
        diag[i] = diagonal;
        rhs[i] = source;
    }
}

__device__ double apply_level_row(
    uint64_t i, const double *v, const CoarseLevel &lvl) {
    const uint64_t nx = lvl.nx;
    const uint64_t ny = lvl.ny;
    const uint64_t nz = lvl.nz;
    const uint64_t plane = nx * ny;
    const uint64_t x = i % nx;
    const uint64_t yz = i / nx;
    const uint64_t y = yz % ny;
    const uint64_t z = yz / ny;
    double value = lvl.diag[i] * v[i];
    if (x > 0) value -= lvl.gx[i - 1] * v[i - 1];
    if (x + 1 < nx) value -= lvl.gx[i] * v[i + 1];
    if (y > 0) value -= lvl.gy[i - nx] * v[i - nx];
    if (y + 1 < ny) value -= lvl.gy[i] * v[i + nx];
    if (z > 0) value -= lvl.gz[i - plane] * v[i - plane];
    if (z + 1 < nz) value -= lvl.gz[i] * v[i + plane];
    return value;
}

// Conservative flux-difference form of A*v on the fine FV grid: eliminates
// catastrophic 6*g*v[i] - sum(g*v[nb]) FP64 cancellation on smooth/Neumann fields.
__device__ double apply_level_row_conservative(
    uint64_t i, const double *v, const CoarseLevel &fine, const uint8_t *active) {
    if (active[i] == 0) return 0.0;
    const uint64_t nx = fine.nx;
    const uint64_t ny = fine.ny;
    const uint64_t nz = fine.nz;
    const uint64_t plane = nx * ny;
    const uint64_t x = i % nx;
    const uint64_t yz = i / nx;
    const uint64_t y = yz % ny;
    const uint64_t z = yz / ny;
    const double gx_p = x + 1 < nx ? fine.gx[i] : 0.0;
    const double gy_p = y + 1 < ny ? fine.gy[i] : 0.0;
    const double gz_p = z + 1 < nz ? fine.gz[i] : 0.0;
    const double gx_m = x > 0 ? fine.gx[i - 1] : 0.0;
    const double gy_m = y > 0 ? fine.gy[i - nx] : 0.0;
    const double gz_m = z > 0 ? fine.gz[i - plane] : 0.0;
    // Sum internal conductances in the exact order used by assemble_charge_fv_kernel
    // so d_bc is bit-for-bit 0.0 on all non-Dirichlet cells.
    double internal_sum = gx_p + gy_p + gz_p;
    if (x > 0) internal_sum += gx_m;
    if (y > 0) internal_sum += gy_m;
    if (z > 0) internal_sum += gz_m;
    const double d_bc = fine.diag[i] - internal_sum;
    const double vi = v[i];
    double value = d_bc * vi;
    if (x > 0) value += gx_m * (vi - v[i - 1]);
    if (x + 1 < nx) value += gx_p * (vi - v[i + 1]);
    if (y > 0) value += gy_m * (vi - v[i - nx]);
    if (y + 1 < ny) value += gy_p * (vi - v[i + nx]);
    if (z > 0) value += gz_m * (vi - v[i - plane]);
    if (z + 1 < nz) value += gz_p * (vi - v[i + plane]);
    return value;
}

__device__ double deterministic_block_reduce_sum(double value, double *shared) {
    shared[threadIdx.x] = value;
    __syncthreads();
    for (uint32_t stride = blockDim.x / 2; stride != 0; stride >>= 1) {
        if (threadIdx.x < stride) shared[threadIdx.x] += shared[threadIdx.x + stride];
        __syncthreads();
    }
    const double result = shared[0];
    __syncthreads();
    return result;
}

__device__ double deterministic_block_reduce_max(double value, double *shared) {
    shared[threadIdx.x] = value;
    __syncthreads();
    for (uint32_t stride = blockDim.x / 2; stride != 0; stride >>= 1) {
        if (threadIdx.x < stride)
            shared[threadIdx.x] = fmax(shared[threadIdx.x], shared[threadIdx.x + stride]);
        __syncthreads();
    }
    const double result = shared[0];
    __syncthreads();
    return result;
}

__device__ double deterministic_grid_sum(
    double local, double *partials, double *scalar_out,
    double *shared, cg::grid_group grid) {
    const double block_sum = deterministic_block_reduce_sum(local, shared);
    if (threadIdx.x == 0) partials[blockIdx.x] = block_sum;
    grid.sync();
    if (grid.thread_rank() == 0) {
        double total = 0.0;
        for (uint32_t b = 0; b < gridDim.x; ++b) total += partials[b];
        *scalar_out = total;
    }
    grid.sync();
    return *scalar_out;
}

__device__ double deterministic_grid_max(
    double local, double *partials, double *scalar_out,
    double *shared, cg::grid_group grid) {
    const double block_max = deterministic_block_reduce_max(local, shared);
    if (threadIdx.x == 0) partials[blockIdx.x] = block_max;
    grid.sync();
    if (grid.thread_rank() == 0) {
        double best = 0.0;
        for (uint32_t b = 0; b < gridDim.x; ++b) best = fmax(best, partials[b]);
        *scalar_out = best;
    }
    grid.sync();
    return *scalar_out;
}

__device__ uint64_t deterministic_grid_sum_u64(
    uint64_t local, uint64_t *partials_u64, uint64_t *scalar_out,
    uint64_t *shared_u64, cg::grid_group grid) {
    shared_u64[threadIdx.x] = local;
    __syncthreads();
    for (uint32_t stride = blockDim.x / 2; stride != 0; stride >>= 1) {
        if (threadIdx.x < stride) shared_u64[threadIdx.x] += shared_u64[threadIdx.x + stride];
        __syncthreads();
    }
    if (threadIdx.x == 0) partials_u64[blockIdx.x] = shared_u64[0];
    grid.sync();
    if (grid.thread_rank() == 0) {
        uint64_t total = 0;
        for (uint32_t b = 0; b < gridDim.x; ++b) total += partials_u64[b];
        *scalar_out = total;
    }
    grid.sync();
    return *scalar_out;
}

__device__ double deterministic_dot_coop(
    const double *a, const double *b, uint64_t count,
    double *partials, double *scalar_out, double *shared,
    cg::grid_group grid) {
    double local = 0.0;
    for (uint64_t i = grid.thread_rank(); i < count; i += grid.size())
        local += a[i] * b[i];
    return deterministic_grid_sum(local, partials, scalar_out, shared, grid);
}

__global__ void assign_geometric_aggregates_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, uint64_t coarse_nx,
    uint64_t coarse_ny, uint64_t *aggregate) {
    const uint64_t cells = nx * ny * nz;
    for (uint64_t i = blockIdx.x * blockDim.x + threadIdx.x; i < cells;
         i += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny;
        const uint64_t z = yz / ny;
        aggregate[i] = x / 2 + coarse_nx * (y / 2 + coarse_ny * (z / 2));
    }
}

// Builds exact Level-1 2x2x2 geometric RAP for both readback oracle compatibility
// (coarse_diag, coarse_edge_a/b/weight) and uniform multi-level stencil storage
// (l1_gx, l1_gy, l1_gz).
__global__ void build_geometric_rap_kernel(
    const uint8_t *active, const double *diag, const double *gx, const double *gy,
    const double *gz, uint64_t nx, uint64_t ny, uint64_t nz,
    const uint64_t *aggregate, double *coarse_diag, uint64_t *coarse_edge_a,
    uint64_t *coarse_edge_b, double *coarse_edge_weight,
    double *l1_gx, double *l1_gy, double *l1_gz) {
    const uint64_t coarse_nx = (nx + 1) / 2;
    const uint64_t coarse_ny = (ny + 1) / 2;
    const uint64_t coarse_nz = (nz + 1) / 2;
    const uint64_t coarse_cells = coarse_nx * coarse_ny * coarse_nz;
    const uint64_t plane = nx * ny;
    const uint64_t x_edges = coarse_nx > 1 ? (coarse_nx - 1) * coarse_ny * coarse_nz : 0;
    const uint64_t y_edges = coarse_ny > 1 ? coarse_nx * (coarse_ny - 1) * coarse_nz : 0;
    for (uint64_t coarse = blockIdx.x * blockDim.x + threadIdx.x;
         coarse < coarse_cells;
         coarse += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const uint64_t cx = coarse % coarse_nx;
        const uint64_t cyz = coarse / coarse_nx;
        const uint64_t cy = cyz % coarse_ny;
        const uint64_t cz = cyz / coarse_ny;
        double diagonal = 0.0;
        double wx = 0.0, wy = 0.0, wz = 0.0;
        for (uint64_t dz = 0; dz < 2; ++dz) {
            const uint64_t z = 2 * cz + dz;
            if (z >= nz) continue;
            for (uint64_t dy = 0; dy < 2; ++dy) {
                const uint64_t y = 2 * cy + dy;
                if (y >= ny) continue;
                for (uint64_t dx = 0; dx < 2; ++dx) {
                    const uint64_t x = 2 * cx + dx;
                    if (x >= nx) continue;
                    const uint64_t i = x + nx * (y + ny * z);
                    if (!active[i]) continue;
                    diagonal += diag[i];
                    if (x + 1 < nx && gx[i] > 0.0) {
                        if (aggregate[i + 1] == coarse) diagonal -= 2.0 * gx[i];
                        else if (cx + 1 < coarse_nx) wx += gx[i];
                    }
                    if (y + 1 < ny && gy[i] > 0.0) {
                        if (aggregate[i + nx] == coarse) diagonal -= 2.0 * gy[i];
                        else if (cy + 1 < coarse_ny) wy += gy[i];
                    }
                    if (z + 1 < nz && gz[i] > 0.0) {
                        if (aggregate[i + plane] == coarse) diagonal -= 2.0 * gz[i];
                        else if (cz + 1 < coarse_nz) wz += gz[i];
                    }
                }
            }
        }
        coarse_diag[coarse] = diagonal;
        if (l1_gx != nullptr) l1_gx[coarse] = cx + 1 < coarse_nx ? wx : 0.0;
        if (l1_gy != nullptr) l1_gy[coarse] = cy + 1 < coarse_ny ? wy : 0.0;
        if (l1_gz != nullptr) l1_gz[coarse] = cz + 1 < coarse_nz ? wz : 0.0;
        if (cx + 1 < coarse_nx) {
            const uint64_t edge = cx + (coarse_nx - 1) * (cy + coarse_ny * cz);
            coarse_edge_a[edge] = coarse;
            coarse_edge_b[edge] = coarse + 1;
            coarse_edge_weight[edge] = wx;
        }
        if (cy + 1 < coarse_ny) {
            const uint64_t edge = x_edges + cx + coarse_nx * (cy + (coarse_ny - 1) * cz);
            coarse_edge_a[edge] = coarse;
            coarse_edge_b[edge] = coarse + coarse_nx;
            coarse_edge_weight[edge] = wy;
        }
        if (cz + 1 < coarse_nz) {
            const uint64_t edge = x_edges + y_edges + cx + coarse_nx * (cy + coarse_ny * cz);
            coarse_edge_a[edge] = coarse;
            coarse_edge_b[edge] = coarse + coarse_nx * coarse_ny;
            coarse_edge_weight[edge] = wz;
        }
    }
}

// Exact 2x2x2 Galerkin RAP coarsening for levels l >= 2.
__global__ void build_coarse_rap_level_kernel(CoarseLevel fine, CoarseLevel coarse) {
    const uint64_t fplane = fine.nx * fine.ny;
    for (uint64_t c = blockIdx.x * blockDim.x + threadIdx.x; c < coarse.cells;
         c += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const uint64_t cx = c % coarse.nx;
        const uint64_t cyz = c / coarse.nx;
        const uint64_t cy = cyz % coarse.ny;
        const uint64_t cz = cyz / coarse.ny;
        double sum_diag = 0.0;
        double d = 0.0;
        double wx = 0.0, wy = 0.0, wz = 0.0;
        double w_neg = 0.0;
        for (uint64_t dz = 0; dz < 2; ++dz) {
            const uint64_t z = 2 * cz + dz;
            if (z >= fine.nz) continue;
            for (uint64_t dy = 0; dy < 2; ++dy) {
                const uint64_t y = 2 * cy + dy;
                if (y >= fine.ny) continue;
                for (uint64_t dx = 0; dx < 2; ++dx) {
                    const uint64_t x = 2 * cx + dx;
                    if (x >= fine.nx) continue;
                    const uint64_t i = x + fine.nx * (y + fine.ny * z);
                    const double fi = fine.diag[i];
                    sum_diag += fi;
                    d += fi;
                    if (dx == 0 && x > 0) w_neg += fine.gx[i - 1];
                    if (dy == 0 && y > 0) w_neg += fine.gy[i - fine.nx];
                    if (dz == 0 && z > 0) w_neg += fine.gz[i - fplane];
                    if (x + 1 < fine.nx && fine.gx[i] > 0.0) {
                        if (dx == 0) d -= 2.0 * fine.gx[i];
                        else if (cx + 1 < coarse.nx) wx += fine.gx[i];
                    }
                    if (y + 1 < fine.ny && fine.gy[i] > 0.0) {
                        if (dy == 0) d -= 2.0 * fine.gy[i];
                        else if (cy + 1 < coarse.ny) wy += fine.gy[i];
                    }
                    if (z + 1 < fine.nz && fine.gz[i] > 0.0) {
                        if (dz == 0) d -= 2.0 * fine.gz[i];
                        else if (cz + 1 < coarse.nz) wz += fine.gz[i];
                    }
                }
            }
        }
        // Guard tiny cancellation roundoff on a completely disconnected pure-Neumann aggregate.
        if (wx == 0.0 && wy == 0.0 && wz == 0.0 && w_neg == 0.0 &&
            d <= 128.0 * DBL_EPSILON * sum_diag) {
            d = 0.0;
        }
        coarse.diag[c] = d > 0.0 ? d : 0.0;
        coarse.gx[c] = cx + 1 < coarse.nx ? wx : 0.0;
        coarse.gy[c] = cy + 1 < coarse.ny ? wy : 0.0;
        coarse.gz[c] = cz + 1 < coarse.nz ? wz : 0.0;
    }
}

// Deterministic fixed-chunk parallel hierarchy digest (SM-count independent).
__global__ void hash_hierarchy_chunks_kernel(
    const uint64_t *aggregate, uint64_t cells,
    const uint64_t *coarse_edge_a, const uint64_t *coarse_edge_b,
    const double *coarse_edge_weight, uint64_t edge_count,
    uint64_t agg_chunks, uint64_t total_chunks, uint64_t *chunk_hashes) {
    for (uint64_t chunk = blockIdx.x * blockDim.x + threadIdx.x; chunk < total_chunks;
         chunk += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        uint64_t state[4] = {
            UINT64_C(0xcbf29ce484222325) ^ chunk,
            UINT64_C(0x9e3779b97f4a7c15) ^ (chunk << 1),
            UINT64_C(0x6a09e667f3bcc909) ^ (chunk << 2),
            UINT64_C(0xbb67ae8584caa73b) ^ (chunk << 3)};
        if (chunk < agg_chunks) {
            const uint64_t begin = chunk * kHashChunkSize;
            const uint64_t end = begin + kHashChunkSize < cells ? begin + kHashChunkSize : cells;
            for (uint64_t i = begin; i < end; ++i) {
                for (uint32_t lane = 0; lane < 4; ++lane) {
                    state[lane] ^= aggregate[i] + UINT64_C(0x100000001b3) * (lane + 1);
                    state[lane] *= UINT64_C(0x100000001b3);
                }
            }
        } else {
            const uint64_t echunk = chunk - agg_chunks;
            const uint64_t begin = echunk * kHashChunkSize;
            const uint64_t end = begin + kHashChunkSize < edge_count ? begin + kHashChunkSize : edge_count;
            for (uint64_t edge = begin; edge < end; ++edge) {
                const uint64_t weight_bits =
                    static_cast<uint64_t>(__double_as_longlong(coarse_edge_weight[edge]));
                for (uint32_t lane = 0; lane < 4; ++lane) {
                    state[lane] ^= coarse_edge_a[edge] + (coarse_edge_b[edge] << 1) + weight_bits;
                    state[lane] *= UINT64_C(0x100000001b3);
                }
            }
        }
        for (uint32_t lane = 0; lane < 4; ++lane) chunk_hashes[4 * chunk + lane] = state[lane];
    }
}

__global__ void finalize_geometric_rap_kernel(
    const uint64_t *chunk_hashes, uint64_t total_chunks,
    uint64_t coarse_nx, uint64_t coarse_ny, uint64_t coarse_nz,
    uint64_t edge_count, uint32_t level_count, DeviceHierarchyInfo *info) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    uint64_t state[4] = {
        UINT64_C(0xcbf29ce484222325), UINT64_C(0x9e3779b97f4a7c15),
        UINT64_C(0x6a09e667f3bcc909), UINT64_C(0xbb67ae8584caa73b)};
    for (uint32_t lane = 0; lane < 4; ++lane) {
        state[lane] ^= static_cast<uint64_t>(level_count) + (coarse_nx << 8) +
                       (coarse_ny << 16) + (coarse_nz << 24);
        state[lane] *= UINT64_C(0x100000001b3);
    }
    for (uint64_t chunk = 0; chunk < total_chunks; ++chunk) {
        for (uint32_t lane = 0; lane < 4; ++lane) {
            state[lane] ^= chunk_hashes[4 * chunk + lane];
            state[lane] *= UINT64_C(0x100000001b3);
        }
    }
    info->coarse_cells = coarse_nx * coarse_ny * coarse_nz;
    info->edge_count = edge_count;
    info->coarse_nx = coarse_nx;
    info->coarse_ny = coarse_ny;
    info->coarse_nz = coarse_nz;
    info->level_count = level_count;
    info->reserved0 = 0;
    for (uint32_t lane = 0; lane < 4; ++lane)
        for (uint32_t byte = 0; byte < 8; ++byte)
            info->digest[8 * lane + byte] = static_cast<uint8_t>(state[lane] >> (8 * byte));
}

// Multi-block cooperative parallel connected components (Shiloach-Vishkin union-find)
// with canonical ascending component numbering, anchor detection, and free-component
// RHS balance summary. Runs once per static HierarchyCache build.
__global__ void label_reference_components_coop_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, const uint8_t *active,
    const void *face_payload, uint64_t face_count, uint64_t face_stride,
    const double *gx, const double *gy, const double *gz, const double *rhs,
    uint64_t *labels, uint8_t *component_anchored, uint32_t *component_pin_cell,
    uint32_t *free_component_ids, uint64_t *free_component_sizes,
    uint32_t *device_component_count, uint32_t *device_free_component_count,
    uint32_t *device_has_unanchored, uint32_t *device_has_unbalanced_free,
    uint64_t *aux_u64, double *comp_rhs_sum_scratch, double *comp_rhs_l1_scratch,
    double *partials, DevicePcgState *state) {
    extern __shared__ double shared_buf[];
    auto *shared_u32 = reinterpret_cast<uint32_t *>(shared_buf);
    auto *shared_u64 = reinterpret_cast<uint64_t *>(shared_buf);
    cg::grid_group grid = cg::this_grid();
    const uint64_t cells = nx * ny * nz;
    const uint64_t plane = nx * ny;

    // 1. Initialize each active cell as its own root.
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
        labels[i] = active[i] ? i : UINT64_MAX;
    grid.sync();

    // 2. Parallel union-find hooking + read-only full pointer compression.
    while (true) {
        if (grid.thread_rank() == 0) state->changed = 0u;
        grid.sync();
        uint32_t local_changed = 0u;
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (!active[i]) continue;
            const uint64_t x = i % nx;
            const uint64_t yz = i / nx;
            const uint64_t y = yz % ny;
            const uint64_t z = yz / ny;
            auto hook_edge = [&](uint64_t nb) {
                uint64_t u = labels[i];
                uint64_t v = labels[nb];
                while (u != v) {
                    if (u < v) {
                        const uint64_t prev = static_cast<uint64_t>(atomicMin(
                            reinterpret_cast<unsigned long long *>(labels + v),
                            static_cast<unsigned long long>(u)));
                        if (prev == v) {
                            local_changed = 1u;
                            break;
                        }
                        if (prev > u) local_changed = 1u;
                        v = prev;
                    } else {
                        const uint64_t prev = static_cast<uint64_t>(atomicMin(
                            reinterpret_cast<unsigned long long *>(labels + u),
                            static_cast<unsigned long long>(v)));
                        if (prev == u) {
                            local_changed = 1u;
                            break;
                        }
                        if (prev > v) local_changed = 1u;
                        u = prev;
                    }
                }
            };
            if (x + 1 < nx && gx[i] > 0.0) hook_edge(i + 1);
            if (y + 1 < ny && gy[i] > 0.0) hook_edge(i + nx);
            if (z + 1 < nz && gz[i] > 0.0) hook_edge(i + plane);
        }
        if (local_changed != 0u) atomicOr(&state->changed, 1u);
        grid.sync();
        if (state->changed == 0u) break;
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (!active[i]) {
                aux_u64[i] = UINT64_MAX;
                continue;
            }
            uint64_t p = labels[i];
            while (p != labels[p]) p = labels[p];
            aux_u64[i] = p;
        }
        grid.sync();
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
            labels[i] = aux_u64[i];
        grid.sync();
    }

    // 3. Assign canonical compact component IDs [0..component_count-1] in ascending root order.
    const uint64_t chunk_size = (cells + gridDim.x - 1) / gridDim.x;
    const uint64_t begin = uint64_t(blockIdx.x) * chunk_size < cells
        ? uint64_t(blockIdx.x) * chunk_size : cells;
    const uint64_t end = begin + chunk_size < cells ? begin + chunk_size : cells;
    uint32_t local_roots = 0u;
    for (uint64_t i = begin + threadIdx.x; i < end; i += blockDim.x) {
        if (active[i] && labels[i] == i) ++local_roots;
    }
    shared_u32[threadIdx.x] = local_roots;
    __syncthreads();
    for (uint32_t stride = blockDim.x / 2; stride != 0; stride >>= 1) {
        if (threadIdx.x < stride) shared_u32[threadIdx.x] += shared_u32[threadIdx.x + stride];
        __syncthreads();
    }
    auto *block_counts = reinterpret_cast<uint32_t *>(partials);
    auto *block_offsets = block_counts + kMaxCoopBlocks;
    if (threadIdx.x == 0) block_counts[blockIdx.x] = shared_u32[0];
    grid.sync();

    if (grid.thread_rank() == 0) {
        uint32_t total = 0u;
        for (uint32_t b = 0; b < gridDim.x; ++b) {
            block_offsets[b] = total;
            total += block_counts[b];
        }
        *device_component_count = total;
        *device_free_component_count = 0u;
        *device_has_unanchored = 0u;
        *device_has_unbalanced_free = 0u;
    }
    grid.sync();

    uint32_t running_offset = block_offsets[blockIdx.x];
    for (uint64_t tile = begin; tile < end; tile += blockDim.x) {
        const uint64_t i = tile + threadIdx.x;
        const uint32_t is_root = (i < end && active[i] && labels[i] == i) ? 1u : 0u;
        shared_u32[threadIdx.x] = is_root;
        __syncthreads();
        // Inclusive Hillis-Steele scan in shared memory (256 threads).
        for (uint32_t offset = 1; offset < blockDim.x; offset <<= 1) {
            const uint32_t val = threadIdx.x >= offset
                ? shared_u32[threadIdx.x] + shared_u32[threadIdx.x - offset]
                : shared_u32[threadIdx.x];
            __syncthreads();
            shared_u32[threadIdx.x] = val;
            __syncthreads();
        }
        if (is_root != 0u) {
            const uint32_t cid = running_offset + shared_u32[threadIdx.x] - 1u;
            aux_u64[i] = cid;
            component_pin_cell[cid] = static_cast<uint32_t>(i);
        }
        running_offset += shared_u32[blockDim.x - 1];
        __syncthreads();
    }
    grid.sync();

    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
        if (active[i]) labels[i] = aux_u64[labels[i]];
        else labels[i] = UINT64_MAX;
    }
    grid.sync();

    // 4. Detect anchored components (voltage boundary faces) and select a centered
    // deterministic pin cell per component (closest to domain center).
    const uint32_t comp_count = *device_component_count;
    for (uint64_t c = grid.thread_rank(); c < comp_count; c += grid.size()) {
        component_anchored[c] = 0;
        comp_rhs_sum_scratch[c] = 0.0;
        comp_rhs_l1_scratch[c] = 0.0;
        aux_u64[c] = UINT64_MAX;
    }
    grid.sync();

    const uint64_t cx_mid = nx / 2;
    const uint64_t cy_mid = ny / 2;
    const uint64_t cz_mid = nz / 2;
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
        const uint64_t c = labels[i];
        if (c == UINT64_MAX) continue;
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny;
        const uint64_t z = yz / ny;
        const uint64_t dx = x >= cx_mid ? x - cx_mid : cx_mid - x;
        const uint64_t dy = y >= cy_mid ? y - cy_mid : cy_mid - y;
        const uint64_t dz = z >= cz_mid ? z - cz_mid : cz_mid - z;
        const uint64_t dist = dx + dy + dz;
        const uint64_t key = (dist << 32) | (i & UINT64_C(0xFFFFFFFF));
        atomicMin(reinterpret_cast<unsigned long long *>(aux_u64 + c),
                  static_cast<unsigned long long>(key));
    }
    grid.sync();
    for (uint64_t c = grid.thread_rank(); c < comp_count; c += grid.size()) {
        const uint64_t best = aux_u64[c];
        if (best != UINT64_MAX) {
            component_pin_cell[c] = static_cast<uint32_t>(best & UINT64_C(0xFFFFFFFF));
        }
        aux_u64[c] = 0;
    }
    grid.sync();

    for (uint64_t f = grid.thread_rank(); f < face_count; f += grid.size()) {
        uint32_t kind = 0, axis = 0;
        int32_t side = 0;
        uint64_t cell = 0;
        double area = 0.0, value = 0.0;
        load_charge_face(face_payload, face_stride, f, &kind, &axis, &side,
                         &cell, &area, &value);
        if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE &&
            cell < cells && labels[cell] != UINT64_MAX) {
            component_anchored[labels[cell]] = 1;
        }
    }
    grid.sync();

    // 5. Collect free components and certify RHS balance per free component.
    if (comp_count <= 32u) {
        if (grid.thread_rank() == 0) {
            uint32_t fc = 0u;
            for (uint32_t c = 0; c < comp_count; ++c) {
                if (component_anchored[c] == 0) {
                    free_component_ids[fc++] = c;
                }
            }
            *device_free_component_count = fc;
            *device_has_unanchored = fc > 0u ? 1u : 0u;
        }
        grid.sync();
        const uint32_t fc = *device_free_component_count;
        double *partials_sum = partials;
        double *partials_l1 = partials + kMaxCoopBlocks;
        auto *partials_cnt = reinterpret_cast<uint64_t *>(partials + 2 * kMaxCoopBlocks);
        for (uint32_t k = 0; k < fc; ++k) {
            const uint32_t c = free_component_ids[k];
            double local_sum = 0.0, local_l1 = 0.0;
            uint64_t local_cnt = 0;
            for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
                if (labels[i] == c) {
                    local_sum += rhs[i];
                    local_l1 += fabs(rhs[i]);
                    ++local_cnt;
                }
            }
            const double b_sum = deterministic_block_reduce_sum(local_sum, shared_buf);
            if (threadIdx.x == 0) partials_sum[blockIdx.x] = b_sum;
            const double b_l1 = deterministic_block_reduce_sum(local_l1, shared_buf);
            if (threadIdx.x == 0) partials_l1[blockIdx.x] = b_l1;
            shared_u64[threadIdx.x] = local_cnt;
            __syncthreads();
            for (uint32_t stride = blockDim.x / 2; stride != 0; stride >>= 1) {
                if (threadIdx.x < stride) shared_u64[threadIdx.x] += shared_u64[threadIdx.x + stride];
                __syncthreads();
            }
            if (threadIdx.x == 0) partials_cnt[blockIdx.x] = shared_u64[0];
            grid.sync();
            if (grid.thread_rank() == 0) {
                double rhs_sum = 0.0, rhs_l1 = 0.0;
                uint64_t cnt = 0;
                for (uint32_t b = 0; b < gridDim.x; ++b) {
                    rhs_sum += partials_sum[b];
                    rhs_l1 += partials_l1[b];
                    cnt += partials_cnt[b];
                }
                free_component_sizes[k] = cnt;
                const double tol = 64.0 * DBL_EPSILON * rhs_l1;
                if (fabs(rhs_sum) > tol) *device_has_unbalanced_free = 1u;
            }
            grid.sync();
        }
    } else {
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            const uint64_t c = labels[i];
            if (c == UINT64_MAX || component_anchored[c] != 0) continue;
            atomicAdd(reinterpret_cast<unsigned long long *>(aux_u64 + c), 1ULL);
            atomicAdd(comp_rhs_sum_scratch + c, rhs[i]);
            atomicAdd(comp_rhs_l1_scratch + c, fabs(rhs[i]));
        }
        grid.sync();
        if (grid.thread_rank() == 0) {
            uint32_t fc = 0u;
            for (uint32_t c = 0; c < comp_count; ++c) {
                if (component_anchored[c] != 0) continue;
                *device_has_unanchored = 1u;
                free_component_ids[fc] = c;
                free_component_sizes[fc] = aux_u64[c];
                ++fc;
                const double tol = 64.0 * DBL_EPSILON * comp_rhs_l1_scratch[c];
                if (fabs(comp_rhs_sum_scratch[c]) > tol)
                    *device_has_unbalanced_free = 1u;
            }
            *device_free_component_count = fc;
        }
        grid.sync();
    }
}

__global__ void evaluate_gauge_policy_kernel(
    uint32_t gauge_policy, const uint32_t *has_unanchored,
    const uint32_t *has_unbalanced_free, uint32_t *invalid) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    uint32_t code = 0u;
    if (*has_unanchored != 0u) {
        if (gauge_policy ==
            FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT) {
            code = 1u;
        } else if (gauge_policy ==
                   FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT) {
            if (*has_unbalanced_free != 0u) code = 2u;
        } else {
            code = 1u;
        }
    }
    *invalid = code;
}

// Parallel deterministic zero-mean projection across free components.
__device__ void project_free_component_means_coop(
    double *values, const uint64_t *labels,
    const uint32_t *free_ids, const uint64_t *free_sizes,
    uint32_t free_count, uint64_t cells,
    double *partials, double *scalar_out, double *shared,
    cg::grid_group grid) {
    if (free_count == 0u) return;
    for (uint32_t k = 0; k < free_count; ++k) {
        const uint64_t cnt = free_sizes[k];
        if (cnt == 0) continue;
        const uint32_t comp = free_ids[k];
        double local = 0.0;
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (labels[i] == comp) local += values[i];
        }
        const double sum = deterministic_grid_sum(local, partials, scalar_out, shared, grid);
        const double mean = sum / static_cast<double>(cnt);
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (labels[i] == comp) values[i] -= mean;
        }
        grid.sync();
    }
}

// Multi-block Red-Black Gauss-Seidel half-sweep (color 0 = red, color 1 = black).
__device__ void rb_gs_sweep_grid(
    const CoarseLevel &lvl, const uint8_t *active_or_null,
    const double *rhs, double *u, uint32_t color, cg::grid_group grid) {
    const uint64_t nx = lvl.nx;
    const uint64_t ny = lvl.ny;
    const uint64_t nz = lvl.nz;
    const uint64_t plane = nx * ny;
    for (uint64_t i = grid.thread_rank(); i < lvl.cells; i += grid.size()) {
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny;
        const uint64_t z = yz / ny;
        if (((x + y + z) & 1u) != color) continue;
        if (active_or_null != nullptr && active_or_null[i] == 0) {
            u[i] = 0.0;
            continue;
        }
        const double d = lvl.diag[i];
        if (d > 0.0 && isfinite(d)) {
            double s = rhs[i];
            if (x > 0) s += lvl.gx[i - 1] * u[i - 1];
            if (x + 1 < nx) s += lvl.gx[i] * u[i + 1];
            if (y > 0) s += lvl.gy[i - nx] * u[i - nx];
            if (y + 1 < ny) s += lvl.gy[i] * u[i + nx];
            if (z > 0) s += lvl.gz[i - plane] * u[i - plane];
            if (z + 1 < nz) s += lvl.gz[i] * u[i + plane];
            u[i] = s / d;
        } else {
            u[i] = 0.0;
        }
    }
    grid.sync();
}

// Block-0 single-block Red-Black Gauss-Seidel half-sweep (uses __syncthreads only).
__device__ void rb_gs_sweep_block0(
    const CoarseLevel &lvl, const uint8_t *active_or_null,
    const double *rhs, double *u, uint32_t color) {
    const uint64_t nx = lvl.nx;
    const uint64_t ny = lvl.ny;
    const uint64_t nz = lvl.nz;
    const uint64_t plane = nx * ny;
    for (uint64_t i = threadIdx.x; i < lvl.cells; i += blockDim.x) {
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny;
        const uint64_t z = yz / ny;
        if (((x + y + z) & 1u) != color) continue;
        if (active_or_null != nullptr && active_or_null[i] == 0) {
            u[i] = 0.0;
            continue;
        }
        const double d = lvl.diag[i];
        if (d > 0.0 && isfinite(d)) {
            double s = rhs[i];
            if (x > 0) s += lvl.gx[i - 1] * u[i - 1];
            if (x + 1 < nx) s += lvl.gx[i] * u[i + 1];
            if (y > 0) s += lvl.gy[i - nx] * u[i - nx];
            if (y + 1 < ny) s += lvl.gy[i] * u[i + nx];
            if (z > 0) s += lvl.gz[i - plane] * u[i - plane];
            if (z + 1 < nz) s += lvl.gz[i] * u[i + plane];
            u[i] = s / d;
        } else {
            u[i] = 0.0;
        }
    }
    __syncthreads();
}

// Fused residual + 2x2x2 restriction: coarse_rhs = R (fine_rhs - A_fine * fine_u).
__device__ void fused_residual_restrict_grid(
    const CoarseLevel &fine, const uint8_t *fine_active_or_null,
    const double *fine_rhs, const double *fine_u,
    const CoarseLevel &coarse, double *coarse_rhs, cg::grid_group grid) {
    for (uint64_t c = grid.thread_rank(); c < coarse.cells; c += grid.size()) {
        const uint64_t cx = c % coarse.nx;
        const uint64_t cyz = c / coarse.nx;
        const uint64_t cy = cyz % coarse.ny;
        const uint64_t cz = cyz / coarse.ny;
        double sum = 0.0;
        for (uint64_t dz = 0; dz < 2; ++dz) {
            const uint64_t z = 2 * cz + dz;
            if (z >= fine.nz) continue;
            for (uint64_t dy = 0; dy < 2; ++dy) {
                const uint64_t y = 2 * cy + dy;
                if (y >= fine.ny) continue;
                for (uint64_t dx = 0; dx < 2; ++dx) {
                    const uint64_t x = 2 * cx + dx;
                    if (x >= fine.nx) continue;
                    const uint64_t i = x + fine.nx * (y + fine.ny * z);
                    if (fine_active_or_null != nullptr && fine_active_or_null[i] == 0) continue;
                    sum += fine_rhs[i] - apply_level_row(i, fine_u, fine);
                }
            }
        }
        coarse_rhs[c] = sum;
    }
    grid.sync();
}

__device__ void fused_residual_restrict_block0(
    const CoarseLevel &fine, const uint8_t *fine_active_or_null,
    const double *fine_rhs, const double *fine_u,
    const CoarseLevel &coarse, double *coarse_rhs) {
    for (uint64_t c = threadIdx.x; c < coarse.cells; c += blockDim.x) {
        const uint64_t cx = c % coarse.nx;
        const uint64_t cyz = c / coarse.nx;
        const uint64_t cy = cyz % coarse.ny;
        const uint64_t cz = cyz / coarse.ny;
        double sum = 0.0;
        for (uint64_t dz = 0; dz < 2; ++dz) {
            const uint64_t z = 2 * cz + dz;
            if (z >= fine.nz) continue;
            for (uint64_t dy = 0; dy < 2; ++dy) {
                const uint64_t y = 2 * cy + dy;
                if (y >= fine.ny) continue;
                for (uint64_t dx = 0; dx < 2; ++dx) {
                    const uint64_t x = 2 * cx + dx;
                    if (x >= fine.nx) continue;
                    const uint64_t i = x + fine.nx * (y + fine.ny * z);
                    if (fine_active_or_null != nullptr && fine_active_or_null[i] == 0) continue;
                    sum += fine_rhs[i] - apply_level_row(i, fine_u, fine);
                }
            }
        }
        coarse_rhs[c] = sum;
    }
    __syncthreads();
}

__device__ void prolong_add_grid(
    const CoarseLevel &fine, const uint8_t *fine_active_or_null,
    const CoarseLevel &coarse, const double *coarse_u, double *fine_u,
    cg::grid_group grid) {
    for (uint64_t i = grid.thread_rank(); i < fine.cells; i += grid.size()) {
        if (fine_active_or_null != nullptr && fine_active_or_null[i] == 0) continue;
        const uint64_t x = i % fine.nx;
        const uint64_t yz = i / fine.nx;
        const uint64_t y = yz % fine.ny;
        const uint64_t z = yz / fine.ny;
        const uint64_t c = (x / 2) + coarse.nx * ((y / 2) + coarse.ny * (z / 2));
        fine_u[i] += coarse_u[c];
    }
    grid.sync();
}

__device__ void prolong_add_block0(
    const CoarseLevel &fine, const uint8_t *fine_active_or_null,
    const CoarseLevel &coarse, const double *coarse_u, double *fine_u) {
    for (uint64_t i = threadIdx.x; i < fine.cells; i += blockDim.x) {
        if (fine_active_or_null != nullptr && fine_active_or_null[i] == 0) continue;
        const uint64_t x = i % fine.nx;
        const uint64_t yz = i / fine.nx;
        const uint64_t y = yz % fine.ny;
        const uint64_t z = yz / fine.ny;
        const uint64_t c = (x / 2) + coarse.nx * ((y / 2) + coarse.ny * (z / 2));
        fine_u[i] += coarse_u[c];
    }
    __syncthreads();
}

__device__ uint8_t cycle_gamma(
    const DeviceAmgHierarchy &h, uint32_t l, bool in_block0) {
    if (l + 2 >= h.level_count) return 1u;
    if (in_block0) return 2u;
    if (h.levels[l + 1].cells * 4 <= h.levels[l].cells) return 2u;
    return (l & 1u) == 0u ? 2u : 1u;
}

// Runs one symmetric W-cycle iteration in-place on levels [root_level .. level_count-1]
// exclusively inside Block 0 using __syncthreads() (zero grid.sync overhead!).
__device__ void run_subcycle_block0(
    const DeviceAmgHierarchy &h, const uint8_t *fine_active,
    const DeviceAmgVectors &vecs, uint32_t root_level) {
    uint8_t stage[kMaxAmgLevels];
    uint8_t rem[kMaxAmgLevels];
    stage[root_level] = 0u;
    rem[root_level] = 0u;
    uint32_t l = root_level;
    while (true) {
        const CoarseLevel &lvl = h.levels[l];
        const uint8_t *act = l == 0u ? fine_active : nullptr;
        if (stage[l] == 0u) {
            if (l + 1u == h.level_count) {
                if (lvl.cells == 1u) {
                    if (threadIdx.x == 0) {
                        const double d = lvl.diag[0];
                        vecs.u[l][0] = (act != nullptr && act[0] == 0)
                            ? 0.0
                            : (d > 0.0 && isfinite(d) ? vecs.rhs[l][0] / d : 0.0);
                    }
                    __syncthreads();
                } else {
                    for (uint32_t s = 0; s < kCoarsestHalfSweeps; ++s) {
                        rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 0u);
                        rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 1u);
                    }
                    for (uint32_t s = 0; s < kCoarsestHalfSweeps; ++s) {
                        rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 1u);
                        rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 0u);
                    }
                }
                if (l == root_level) break;
                --l;
            } else {
                rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 0u);
                rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 1u);
                const CoarseLevel &child = h.levels[l + 1u];
                fused_residual_restrict_block0(
                    lvl, act, vecs.rhs[l], vecs.u[l], child, vecs.rhs[l + 1u]);
                for (uint64_t i = threadIdx.x; i < child.cells; i += blockDim.x)
                    vecs.u[l + 1u][i] = 0.0;
                __syncthreads();
                rem[l + 1u] = static_cast<uint8_t>(cycle_gamma(h, l, true) - 1u);
                stage[l] = 1u;
                stage[l + 1u] = 0u;
                ++l;
            }
        } else {
            if (rem[l + 1u] > 0u) {
                --rem[l + 1u];
                stage[l + 1u] = 0u;
                ++l;
            } else {
                prolong_add_block0(
                    lvl, act, h.levels[l + 1u], vecs.u[l + 1u], vecs.u[l]);
                rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 1u);
                rb_gs_sweep_block0(lvl, act, vecs.rhs[l], vecs.u[l], 0u);
                if (l == root_level) break;
                --l;
            }
        }
    }
}

// Multi-block symmetric multi-level geometric AMG W-cycle preconditioner with
// Block-0 sub-hierarchy handoff for levels <= kBlock0CellThreshold cells.
__device__ void device_multilevel_amg_wcycle(
    const DeviceAmgHierarchy &h, const uint8_t *fine_active,
    const DeviceAmgVectors &vecs, cg::grid_group grid) {
    const uint64_t fine_cells = h.levels[0].cells;
    for (uint64_t i = grid.thread_rank(); i < fine_cells; i += grid.size())
        vecs.u[0][i] = 0.0;
    grid.sync();

    if (h.level_count <= 1u) {
        if (blockIdx.x == 0) run_subcycle_block0(h, fine_active, vecs, 0u);
        grid.sync();
        return;
    }
    if (h.split_level == 0u) {
        if (blockIdx.x == 0) run_subcycle_block0(h, fine_active, vecs, 0u);
        grid.sync();
        return;
    }

    uint8_t stage[kMaxAmgLevels];
    uint8_t rem[kMaxAmgLevels];
    stage[0] = 0u;
    rem[0] = 0u;
    uint32_t l = 0u;
    while (true) {
        const CoarseLevel &lvl = h.levels[l];
        const uint8_t *act = l == 0u ? fine_active : nullptr;
        if (stage[l] == 0u) {
            if (l + 1u == h.level_count) {
                // Coarsest level reached in multi-block mode (only if coarsest > kBlock0CellThreshold).
                for (uint32_t s = 0; s < kCoarsestHalfSweeps; ++s) {
                    rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 0u, grid);
                    rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 1u, grid);
                }
                for (uint32_t s = 0; s < kCoarsestHalfSweeps; ++s) {
                    rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 1u, grid);
                    rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 0u, grid);
                }
                if (l == 0u) break;
                --l;
            } else {
                rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 0u, grid);
                rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 1u, grid);
                const CoarseLevel &child = h.levels[l + 1u];
                fused_residual_restrict_grid(
                    lvl, act, vecs.rhs[l], vecs.u[l], child, vecs.rhs[l + 1u], grid);
                const uint8_t gamma = cycle_gamma(h, l, false);
                if (l + 1u == h.split_level) {
                    // Hand off all gamma visits of [split_level .. L-1] to Block 0 in one sync pair.
                    if (blockIdx.x == 0) {
                        for (uint64_t i = threadIdx.x; i < child.cells; i += blockDim.x)
                            vecs.u[l + 1u][i] = 0.0;
                        __syncthreads();
                        for (uint8_t v = 0; v < gamma; ++v)
                            run_subcycle_block0(h, fine_active, vecs, l + 1u);
                    }
                    grid.sync();
                    prolong_add_grid(lvl, act, child, vecs.u[l + 1u], vecs.u[l], grid);
                    rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 1u, grid);
                    rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 0u, grid);
                    if (l == 0u) break;
                    --l;
                } else {
                    for (uint64_t i = grid.thread_rank(); i < child.cells; i += grid.size())
                        vecs.u[l + 1u][i] = 0.0;
                    grid.sync();
                    rem[l + 1u] = static_cast<uint8_t>(gamma - 1u);
                    stage[l] = 1u;
                    stage[l + 1u] = 0u;
                    ++l;
                }
            }
        } else {
            if (rem[l + 1u] > 0u) {
                --rem[l + 1u];
                stage[l + 1u] = 0u;
                ++l;
            } else {
                prolong_add_grid(
                    lvl, act, h.levels[l + 1u], vecs.u[l + 1u], vecs.u[l], grid);
                rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 1u, grid);
                rb_gs_sweep_grid(lvl, act, vecs.rhs[l], vecs.u[l], 0u, grid);
                if (l == 0u) break;
                --l;
            }
        }
    }
}

__global__ void charge_pcg_device_amg_kernel(
    const uint8_t *active, DeviceAmgHierarchy amg, DeviceAmgVectors amg_vecs,
    const double *rhs, double tolerance, uint64_t max_iterations,
    const double *warm_potential, uint32_t warm_start_used,
    uint32_t gauge_policy, const uint64_t *component_labels,
    const uint32_t *free_component_ids, const uint64_t *free_component_sizes,
    const uint32_t *free_component_count_device,
    double *potential, double *r, double *z, double *p,
    double *ap, double *fine_tmp, double *partials, DevicePcgState *state,
    const DeviceHierarchyInfo *hierarchy, DeviceSolveMetrics *metrics) {
    extern __shared__ double shared[];
    cg::grid_group grid = cg::this_grid();
    const CoarseLevel &fine = amg.levels[0];
    const uint64_t cells = fine.cells;
    const bool zero_mean = gauge_policy ==
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT;
    const uint32_t free_count = *free_component_count_device;

    amg_vecs.rhs[0] = r;
    amg_vecs.u[0] = z;

    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
        potential[i] = (warm_start_used != 0u && active[i] != 0) ? warm_potential[i] : 0.0;
    }
    grid.sync();
    if (zero_mean && free_count > 0u) {
        project_free_component_means_coop(
            potential, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }
    if (zero_mean && free_count > 0u) {
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
            fine_tmp[i] = rhs[i];
        grid.sync();
        project_free_component_means_coop(
            fine_tmp, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }
    const double *effective_rhs = (zero_mean && free_count > 0u) ? fine_tmp : rhs;
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
        r[i] = effective_rhs[i] -
            (warm_start_used != 0u || (zero_mean && free_count > 0u)
                ? apply_level_row(i, potential, fine)
                : 0.0);
    }
    grid.sync();
    if (zero_mean && free_count > 0u) {
        project_free_component_means_coop(
            r, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }

    uint64_t active_local = 0;
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
        active_local += active[i] != 0 ? 1ULL : 0ULL;
    const uint64_t active_total = deterministic_grid_sum_u64(
        active_local, reinterpret_cast<uint64_t *>(partials), &state->active_count,
        reinterpret_cast<uint64_t *>(shared), grid);
    if (grid.thread_rank() == 0) metrics->fine_unknown_count = active_total;

    const double rhs_norm_squared = deterministic_dot_coop(
        effective_rhs, effective_rhs, cells, partials, &state->scalar0, shared, grid);
    const double initial_residual_squared = deterministic_dot_coop(
        r, r, cells, partials, &state->scalar1, shared, grid);
    if (grid.thread_rank() == 0) {
        state->norm_b = sqrt(rhs_norm_squared);
        state->residual_norm = state->norm_b == 0.0
            ? sqrt(initial_residual_squared)
            : sqrt(initial_residual_squared) / state->norm_b;
        state->completed = 0;
        state->reason = state->residual_norm <= tolerance
            ? FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED
            : state->norm_b == 0.0
                ? FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE
                : FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS;
        metrics->debug_rho = 0.0;
        metrics->debug_denominator = 1.0;
    }
    grid.sync();

    if (state->reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS) {
        device_multilevel_amg_wcycle(amg, active, amg_vecs, grid);
        if (zero_mean && free_count > 0u) {
            project_free_component_means_coop(
                z, component_labels, free_component_ids, free_component_sizes,
                free_count, cells, partials, &state->scalar0, shared, grid);
        }
        const double initial_rho = deterministic_dot_coop(
            r, z, cells, partials, &state->scalar0, shared, grid);
        if (grid.thread_rank() == 0) state->rho = initial_rho;
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) p[i] = z[i];
        grid.sync();

        for (uint64_t iteration = 0; iteration < max_iterations; ++iteration) {
            for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
                ap[i] = apply_level_row(i, p, fine);
            grid.sync();
            if (zero_mean && free_count > 0u) {
                project_free_component_means_coop(
                    ap, component_labels, free_component_ids, free_component_sizes,
                    free_count, cells, partials, &state->scalar0, shared, grid);
            }
            const double denominator = deterministic_dot_coop(
                p, ap, cells, partials, &state->scalar0, shared, grid);
            if (grid.thread_rank() == 0) {
                state->alpha = state->rho / denominator;
                metrics->debug_rho = state->rho;
                metrics->debug_denominator = denominator;
                if (!isfinite(state->alpha) || denominator <= 0.0)
                    state->reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE;
            }
            grid.sync();
            if (state->reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE)
                break;
            const double alpha = state->alpha;
            for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
                potential[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
            }
            grid.sync();
            if (zero_mean && free_count > 0u) {
                project_free_component_means_coop(
                    potential, component_labels, free_component_ids, free_component_sizes,
                    free_count, cells, partials, &state->scalar0, shared, grid);
                project_free_component_means_coop(
                    r, component_labels, free_component_ids, free_component_sizes,
                    free_count, cells, partials, &state->scalar0, shared, grid);
            }
            const double residual_squared = deterministic_dot_coop(
                r, r, cells, partials, &state->scalar0, shared, grid);
            if (grid.thread_rank() == 0) {
                state->completed = iteration + 1;
                state->residual_norm = sqrt(residual_squared) / state->norm_b;
                if (!isfinite(state->residual_norm))
                    state->reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_NON_FINITE;
                else if (state->residual_norm <= tolerance)
                    state->reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
            }
            grid.sync();
            if (state->reason != FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS)
                break;
            device_multilevel_amg_wcycle(amg, active, amg_vecs, grid);
            if (zero_mean && free_count > 0u) {
                project_free_component_means_coop(
                    z, component_labels, free_component_ids, free_component_sizes,
                    free_count, cells, partials, &state->scalar0, shared, grid);
            }
            const double next_rho = deterministic_dot_coop(
                r, z, cells, partials, &state->scalar0, shared, grid);
            if (grid.thread_rank() == 0) {
                state->beta = next_rho / state->rho;
                state->rho = next_rho;
            }
            grid.sync();
            const double beta = state->beta;
            for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
                p[i] = z[i] + beta * p[i];
            grid.sync();
            if (zero_mean && free_count > 0u) {
                project_free_component_means_coop(
                    p, component_labels, free_component_ids, free_component_sizes,
                    free_count, cells, partials, &state->scalar0, shared, grid);
            }
        }
    }

    if (grid.thread_rank() == 0) {
        metrics->iterations = state->completed;
        metrics->amg_apply_count = state->completed +
            (state->reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS ? 1ULL : 0ULL);
        metrics->reason = state->reason;
        metrics->hierarchy_levels = hierarchy->level_count;
        metrics->coarse_unknown_count = hierarchy->coarse_cells;
        for (uint32_t byte = 0; byte < 32; ++byte)
            metrics->hierarchy_digest[byte] = hierarchy->digest[byte];
        metrics->algebraic_residual = state->residual_norm;
    }
}

// Builds pinned-cell mask (1 cell per unanchored free component) on GPU.
__global__ void build_pinned_mask_kernel(
    uint64_t cells, const uint32_t *free_component_ids,
    const uint32_t *free_component_count, const uint32_t *component_pin_cell,
    uint8_t *pinned_mask) {
    const uint32_t fc = *free_component_count;
    for (uint32_t k = blockIdx.x * blockDim.x + threadIdx.x; k < fc;
         k += static_cast<uint32_t>(blockDim.x) * gridDim.x) {
        const uint32_t comp = free_component_ids[k];
        const uint32_t pin = component_pin_cell[comp];
        if (pin < cells) pinned_mask[pin] = 1;
    }
}

// Assembles the symmetric lower-triangle CSR of the 7-point FV operator directly
// on GPU in closed form (zero prefix-sum, zero host transfers).
// For each unanchored free component, adds a rank-1 diagonal pin (+diag[p] e_p e_p^T)
// at the centered pin cell p so A_hat is strictly SPD with unmodified off-diagonals
// and solves A_hat x = b with x[p] = 0 automatically whenever 1^T b = 0.
__global__ void assemble_cudss_lower_csr_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, uint64_t total_nnz,
    const uint8_t *active, const uint8_t *pinned_mask,
    const double *diag, const double *gx, const double *gy, const double *gz,
    int32_t *d_offsets, int32_t *d_columns, double *d_values) {
    const uint64_t cells = nx * ny * nz;
    const uint64_t plane = nx * ny;
    for (uint64_t i = blockIdx.x * blockDim.x + threadIdx.x; i < cells;
         i += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny;
        const uint64_t z = yz / ny;
        const uint64_t before_z = i >= plane ? i - plane : 0;
        const uint64_t before_y =
            z * nx * (ny > 0 ? ny - 1 : 0) + (y > 0 ? (y - 1) * nx + x : 0);
        const uint64_t before_x =
            (y + ny * z) * (nx > 0 ? nx - 1 : 0) + (x > 0 ? x - 1 : 0);
        const int32_t row_start = static_cast<int32_t>(i + before_z + before_y + before_x);
        d_offsets[i] = row_start;
        if (i + 1 == cells) d_offsets[cells] = static_cast<int32_t>(total_nnz);
        int32_t pos = row_start;
        const bool self_active = active[i] != 0;
        const bool self_pinned = pinned_mask[i] != 0;
        if (z > 0) {
            const uint64_t nb = i - plane;
            d_columns[pos] = static_cast<int32_t>(nb);
            d_values[pos] = (self_active && gz[nb] > 0.0) ? -gz[nb] : 0.0;
            ++pos;
        }
        if (y > 0) {
            const uint64_t nb = i - nx;
            d_columns[pos] = static_cast<int32_t>(nb);
            d_values[pos] = (self_active && gy[nb] > 0.0) ? -gy[nb] : 0.0;
            ++pos;
        }
        if (x > 0) {
            const uint64_t nb = i - 1;
            d_columns[pos] = static_cast<int32_t>(nb);
            d_values[pos] = (self_active && gx[nb] > 0.0) ? -gx[nb] : 0.0;
            ++pos;
        }
        d_columns[pos] = static_cast<int32_t>(i);
        if (!self_active) {
            d_values[pos] = 1.0;
        } else if (self_pinned) {
            d_values[pos] = diag[i] > 0.0 ? 2.0 * diag[i] : 1.0;
        } else {
            d_values[pos] = diag[i];
        }
    }
}

// Prepares RHS for cuDSS direct solve (zeroes inactive cells and projects
// free-component means when ZERO_MEAN_PER_FREE_COMPONENT is active).
__global__ void prepare_cudss_rhs_coop_kernel(
    uint64_t cells, const uint8_t *active, const double *rhs,
    uint32_t gauge_policy, const uint64_t *component_labels,
    const uint32_t *free_component_ids, const uint64_t *free_component_sizes,
    const uint32_t *free_component_count_device, double *rhs_eff,
    double *partials, DevicePcgState *state) {
    extern __shared__ double shared[];
    cg::grid_group grid = cg::this_grid();
    const bool zero_mean = gauge_policy ==
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT;
    const uint32_t free_count = *free_component_count_device;
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
        rhs_eff[i] = active[i] != 0 ? rhs[i] : 0.0;
    grid.sync();
    if (zero_mean && free_count > 0u) {
        project_free_component_means_coop(
            rhs_eff, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }
}

// Iterative-refinement step on GPU: optionally adds a cuDSS correction vector
// to `potential`, enforces inactive-zero / zero-mean gauge, and computes the
// conservative flux-difference residual `r = rhs_eff - A * potential`.
__global__ void cudss_ir_residual_coop_kernel(
    CoarseLevel fine, const uint8_t *active, const double *rhs_eff,
    uint32_t gauge_policy, const uint64_t *component_labels,
    const uint32_t *free_component_ids, const uint64_t *free_component_sizes,
    const uint32_t *free_component_count_device, double *correction,
    double *potential, double *r, double *partials, DevicePcgState *state) {
    extern __shared__ double shared[];
    cg::grid_group grid = cg::this_grid();
    const uint64_t cells = fine.cells;
    const bool zero_mean = gauge_policy ==
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT;
    const uint32_t free_count = *free_component_count_device;
    if (correction != nullptr) {
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (active[i] == 0) correction[i] = 0.0;
        }
        grid.sync();
        if (zero_mean && free_count > 0u) {
            project_free_component_means_coop(
                correction, component_labels, free_component_ids, free_component_sizes,
                free_count, cells, partials, &state->scalar0, shared, grid);
        }
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            potential[i] = active[i] != 0 ? (potential[i] + correction[i]) : 0.0;
        }
    } else {
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (active[i] == 0) potential[i] = 0.0;
        }
    }
    grid.sync();
    if (zero_mean && free_count > 0u) {
        project_free_component_means_coop(
            potential, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
        r[i] = active[i] != 0
            ? (rhs_eff[i] - apply_level_row_conservative(i, potential, fine, active))
            : 0.0;
    }
    grid.sync();
    if (zero_mean && free_count > 0u) {
        project_free_component_means_coop(
            r, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }
}

// Post-processes cuDSS direct solution: applies final IR correction, subtracts
// free-component means, zeroes inactive cells, and computes exact deterministic
// FP64 conservative algebraic residual & solve metrics.
__global__ void finalize_cudss_solution_coop_kernel(
    CoarseLevel fine, const uint8_t *active, const double *rhs_eff,
    double tolerance, uint32_t gauge_policy,
    const uint64_t *component_labels, const uint32_t *free_component_ids,
    const uint64_t *free_component_sizes, const uint32_t *free_component_count_device,
    double *correction, double *potential, double *r, double *partials,
    DevicePcgState *state, const DeviceHierarchyInfo *hierarchy,
    DeviceSolveMetrics *metrics) {
    extern __shared__ double shared[];
    cg::grid_group grid = cg::this_grid();
    const uint64_t cells = fine.cells;
    const bool zero_mean = gauge_policy ==
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT;
    const uint32_t free_count = *free_component_count_device;
    if (correction != nullptr) {
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (active[i] == 0) correction[i] = 0.0;
        }
        grid.sync();
        if (zero_mean && free_count > 0u) {
            project_free_component_means_coop(
                correction, component_labels, free_component_ids, free_component_sizes,
                free_count, cells, partials, &state->scalar0, shared, grid);
        }
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            potential[i] = active[i] != 0 ? (potential[i] + correction[i]) : 0.0;
        }
    } else {
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (active[i] == 0) potential[i] = 0.0;
        }
    }
    grid.sync();
    if (zero_mean && free_count > 0u) {
        project_free_component_means_coop(
            potential, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
        r[i] = active[i] != 0
            ? (rhs_eff[i] - apply_level_row_conservative(i, potential, fine, active))
            : 0.0;
    }
    grid.sync();
    if (zero_mean && free_count > 0u) {
        project_free_component_means_coop(
            r, component_labels, free_component_ids, free_component_sizes,
            free_count, cells, partials, &state->scalar0, shared, grid);
    }
    uint64_t active_local = 0;
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size())
        active_local += active[i] != 0 ? 1ULL : 0ULL;
    const uint64_t active_total = deterministic_grid_sum_u64(
        active_local, reinterpret_cast<uint64_t *>(partials), &state->active_count,
        reinterpret_cast<uint64_t *>(shared), grid);
    const double rhs_norm_sq = deterministic_dot_coop(
        rhs_eff, rhs_eff, cells, partials, &state->scalar0, shared, grid);
    const double res_norm_sq = deterministic_dot_coop(
        r, r, cells, partials, &state->scalar1, shared, grid);
    if (grid.thread_rank() == 0) {
        const double norm_b = sqrt(rhs_norm_sq);
        const double res_norm = norm_b == 0.0
            ? sqrt(res_norm_sq)
            : sqrt(res_norm_sq) / norm_b;
        metrics->fine_unknown_count = active_total;
        metrics->coarse_unknown_count = hierarchy->coarse_cells;
        metrics->hierarchy_levels = hierarchy->level_count;
        for (uint32_t byte = 0; byte < 32; ++byte)
            metrics->hierarchy_digest[byte] = hierarchy->digest[byte];
        metrics->iterations = 1;
        metrics->amg_apply_count = 0;
        metrics->algebraic_residual = res_norm;
        metrics->debug_rho = 0.0;
        metrics->debug_denominator = 1.0;
        if (!isfinite(res_norm)) {
            metrics->reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_NON_FINITE;
        } else if (res_norm <= tolerance) {
            metrics->reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
        } else {
            metrics->reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE;
        }
    }
}

__global__ void reconstruct_charge_flux_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, double hx, double hy, double hz,
    const uint8_t *active, const double *sigma, const double *potential,
    const void *face_payload, uint64_t face_count, uint64_t face_stride,
    const void *interface_payload, uint64_t interface_count,
    uint64_t interface_stride, double *jx, double *jy, double *jz) {
    const uint64_t jx_count = (nx + 1) * ny * nz;
    const uint64_t jy_count = nx * (ny + 1) * nz;
    const uint64_t jz_count = nx * ny * (nz + 1);
    (void)face_count;
    for (uint64_t face = blockIdx.x * blockDim.x + threadIdx.x; face < jx_count;
         face += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const uint64_t x = face % (nx + 1);
        const uint64_t yz = face / (nx + 1);
        const uint64_t y = yz % ny, z = yz / ny;
        double value = 0.0;
        if (x > 0 && x < nx) {
            const uint64_t left = cell_index(x - 1, y, z, nx, ny);
            const uint64_t right = left + 1;
            if (active[left] && active[right])
                value = -internal_face_conductance(0, face, left, right, hx, hy * hz,
                    sigma, interface_payload, interface_count, interface_stride) *
                    (potential[right] - potential[left]) / (hy * hz);
        } else {
            const uint64_t adjacent = cell_index(x == 0 ? 0 : nx - 1, y, z, nx, ny);
            const int32_t side = x == 0 ? -1 : 1;
            const uint64_t f = boundary_ordinal(0, side, x == 0 ? 0 : nx - 1,
                                                y, z, nx, ny, nz);
            uint32_t kind = 0, axis = 0; int32_t stored_side = 0; uint64_t cell = 0;
            double area = 0.0, boundary = 0.0;
            load_charge_face(face_payload, face_stride, f, &kind, &axis, &stored_side,
                             &cell, &area, &boundary);
            if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE)
                value = x == 0 ? -sigma[adjacent] * (potential[adjacent] - boundary) / (0.5 * hx)
                               : -sigma[adjacent] * (boundary - potential[adjacent]) / (0.5 * hx);
            else if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY)
                value = side * boundary;
        }
        jx[face] = value;
    }
    for (uint64_t face = blockIdx.x * blockDim.x + threadIdx.x; face < jy_count;
         face += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const uint64_t x = face % nx;
        const uint64_t yz = face / nx;
        const uint64_t y = yz % (ny + 1), z = yz / (ny + 1);
        double value = 0.0;
        if (y > 0 && y < ny) {
            const uint64_t lower = cell_index(x, y - 1, z, nx, ny);
            const uint64_t upper = lower + nx;
            if (active[lower] && active[upper])
                value = -internal_face_conductance(1, face, lower, upper, hy, hx * hz,
                    sigma, interface_payload, interface_count, interface_stride) *
                    (potential[upper] - potential[lower]) / (hx * hz);
        } else {
            const uint64_t adjacent = cell_index(x, y == 0 ? 0 : ny - 1, z, nx, ny);
            const int32_t side = y == 0 ? -1 : 1;
            const uint64_t f = boundary_ordinal(1, side, x, y == 0 ? 0 : ny - 1,
                                                z, nx, ny, nz);
            uint32_t kind = 0, axis = 0; int32_t stored_side = 0; uint64_t cell = 0;
            double area = 0.0, boundary = 0.0;
            load_charge_face(face_payload, face_stride, f, &kind, &axis, &stored_side,
                             &cell, &area, &boundary);
            if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE)
                value = y == 0 ? -sigma[adjacent] * (potential[adjacent] - boundary) / (0.5 * hy)
                               : -sigma[adjacent] * (boundary - potential[adjacent]) / (0.5 * hy);
            else if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY)
                value = side * boundary;
        }
        jy[face] = value;
    }
    for (uint64_t face = blockIdx.x * blockDim.x + threadIdx.x; face < jz_count;
         face += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const uint64_t x = face % nx;
        const uint64_t yz = face / nx;
        const uint64_t y = yz % ny, z = yz / ny;
        double value = 0.0;
        if (z > 0 && z < nz) {
            const uint64_t back = cell_index(x, y, z - 1, nx, ny);
            const uint64_t front = back + nx * ny;
            if (active[back] && active[front])
                value = -internal_face_conductance(2, face, back, front, hz, hx * hy,
                    sigma, interface_payload, interface_count, interface_stride) *
                    (potential[front] - potential[back]) / (hx * hy);
        } else {
            const uint64_t adjacent = cell_index(x, y, z == 0 ? 0 : nz - 1, nx, ny);
            const int32_t side = z == 0 ? -1 : 1;
            const uint64_t f = boundary_ordinal(2, side, x, y, z == 0 ? 0 : nz - 1,
                                                nx, ny, nz);
            uint32_t kind = 0, axis = 0; int32_t stored_side = 0; uint64_t cell = 0;
            double area = 0.0, boundary = 0.0;
            load_charge_face(face_payload, face_stride, f, &kind, &axis, &stored_side,
                             &cell, &area, &boundary);
            if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE)
                value = z == 0 ? -sigma[adjacent] * (potential[adjacent] - boundary) / (0.5 * hz)
                               : -sigma[adjacent] * (boundary - potential[adjacent]) / (0.5 * hz);
            else if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY)
                value = side * boundary;
        }
        jz[face] = value;
    }
}

__global__ void materialize_interface_traces_kernel(
    const fullmag_fdm_gpu_transport_spin_interface_v1 *interfaces,
    uint64_t interface_count, uint64_t interface_stride,
    double hx, double hy, double hz, const double *sigma, const double *potential,
    const double *jx, const double *jy, const double *jz,
    double *from_trace, double *to_trace, double *delta_trace,
    double *oriented_current_density) {
    for (uint64_t i = blockIdx.x * blockDim.x + threadIdx.x; i < interface_count;
         i += static_cast<uint64_t>(blockDim.x) * gridDim.x) {
        const auto *record = reinterpret_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(
            reinterpret_cast<const uint8_t *>(interfaces) + i * interface_stride);
        const double global_current = record->axis == 0 ? jx[record->canonical_face_index]
            : record->axis == 1 ? jy[record->canonical_face_index]
                                : jz[record->canonical_face_index];
        const bool charge_insulating =
            record->kind == FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2 &&
            record->G_up + record->G_down == 0.0;
        const double oriented_current = charge_insulating ? 0.0
            : record->orientation * global_current;
        const uint64_t from = record->from_cell, to = record->to_cell;
        const double half_h = 0.5 * (record->axis == 0 ? hx : record->axis == 1 ? hy : hz);
        const double vf = charge_insulating ? potential[from]
            : potential[from] - oriented_current * half_h / sigma[from];
        const double vt = charge_insulating ? potential[to]
            : potential[to] + oriented_current * half_h / sigma[to];
        from_trace[i] = vf;
        to_trace[i] = vt;
        delta_trace[i] = vf - vt;
        oriented_current_density[i] = oriented_current;
    }
}

__global__ void validate_candidate_finite_kernel(
    Buffers buffers, DeviceSolveMetrics *metrics) {
    const double *arrays[7] = {
        buffers.potential, buffers.jx, buffers.jy, buffers.jz,
        buffers.interface_from_trace_v, buffers.interface_to_trace_v,
        buffers.interface_delta_trace_v};
    const uint64_t counts[7] = {
        buffers.cells, buffers.jx_count, buffers.jy_count, buffers.jz_count,
        buffers.interface_count, buffers.interface_count, buffers.interface_count};
    for (uint32_t array = 0; array < 7; ++array)
        for (uint64_t i = blockIdx.x * blockDim.x + threadIdx.x; i < counts[array];
             i += static_cast<uint64_t>(blockDim.x) * gridDim.x)
            if (!isfinite(arrays[array][i])) atomicExch(&metrics->candidate_nonfinite, 1u);
    for (uint64_t i = blockIdx.x * blockDim.x + threadIdx.x;
         i < buffers.interface_count;
         i += static_cast<uint64_t>(blockDim.x) * gridDim.x)
        if (!isfinite(buffers.interface_charge_current_density[i]))
            atomicExch(&metrics->candidate_nonfinite, 1u);
}

__device__ double integrated_cell_flux(
    uint64_t i, uint64_t nx, uint64_t ny, uint64_t nz,
    double ax, double ay, double az, const double *jx, const double *jy,
    const double *jz, double *scale) {
    (void)nz;
    const uint64_t x = i % nx;
    const uint64_t yz = i / nx;
    const uint64_t y = yz % ny, z = yz / ny;
    const uint64_t fx0 = x + (nx + 1) * (y + ny * z);
    const uint64_t fy0 = x + nx * (y + (ny + 1) * z);
    const uint64_t fz0 = x + nx * (y + ny * z);
    *scale = (fabs(jx[fx0 + 1]) + fabs(jx[fx0])) * ax +
             (fabs(jy[fy0 + nx]) + fabs(jy[fy0])) * ay +
             (fabs(jz[fz0 + nx * ny]) + fabs(jz[fz0])) * az;
    return (jx[fx0 + 1] - jx[fx0]) * ax +
           (jy[fy0 + nx] - jy[fy0]) * ay +
           (jz[fz0 + nx * ny] - jz[fz0]) * az;
}

// Multi-block cooperative physical, component, and electrode flux-balance certification
// with deterministic FP64 block-tree reductions.
__global__ void charge_balance_coop_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, double hx, double hy, double hz,
    const uint8_t *active, const uint64_t *labels, const uint32_t *component_count_device,
    const double *jx, const double *jy, const double *jz,
    double *comp_net_scratch, double *comp_scale_scratch,
    double *partials, DevicePcgState *state, DeviceSolveMetrics *metrics) {
    extern __shared__ double shared[];
    cg::grid_group grid = cg::this_grid();
    const double ax = hy * hz, ay = hx * hz, az = hx * hy;
    const uint64_t cells = nx * ny * nz;
    const uint32_t comp_count = *component_count_device;

    double local_res2 = 0.0;
    double local_scale2 = 0.0;
    double local_trans = 0.0;
    double local_c0_net = 0.0;
    double local_c0_scale = 0.0;
    for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
        if (!active[i]) continue;
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny, z = yz / ny;
        const uint64_t fy0 = x + nx * (y + (ny + 1) * z);
        const uint64_t fz0 = x + nx * (y + ny * z);
        double scale = 0.0;
        const double net = integrated_cell_flux(
            i, nx, ny, nz, ax, ay, az, jx, jy, jz, &scale);
        local_res2 += net * net;
        local_scale2 += scale * scale;
        local_trans = fmax(local_trans, fmax(fabs(jy[fy0]), fabs(jy[fy0 + nx])));
        local_trans = fmax(local_trans, fmax(fabs(jz[fz0]), fabs(jz[fz0 + nx * ny])));
        if (comp_count == 1u && labels[i] == 0) {
            local_c0_net += net;
            local_c0_scale += scale;
        }
    }
    const double total_res2 = deterministic_grid_sum(
        local_res2, partials, &state->scalar0, shared, grid);
    const double total_scale2 = deterministic_grid_sum(
        local_scale2, partials, &state->scalar1, shared, grid);
    const double total_trans = deterministic_grid_max(
        local_trans, partials, &state->scalar2, shared, grid);

    double component_max = 0.0;
    if (comp_count == 1u) {
        const double c0_net = deterministic_grid_sum(
            local_c0_net, partials, &state->scalar0, shared, grid);
        const double c0_scale = deterministic_grid_sum(
            local_c0_scale, partials, &state->scalar1, shared, grid);
        component_max = c0_scale == 0.0
            ? (c0_net == 0.0 ? 0.0 : INFINITY)
            : fabs(c0_net) / c0_scale;
    } else if (comp_count <= 32u) {
        for (uint32_t comp = 0; comp < comp_count; ++comp) {
            double local_net = 0.0, local_scale = 0.0;
            for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
                if (!active[i] || labels[i] != comp) continue;
                double scale = 0.0;
                local_net += integrated_cell_flux(
                    i, nx, ny, nz, ax, ay, az, jx, jy, jz, &scale);
                local_scale += scale;
            }
            const double net_sum = deterministic_grid_sum(
                local_net, partials, &state->scalar0, shared, grid);
            const double comp_scale = deterministic_grid_sum(
                local_scale, partials, &state->scalar1, shared, grid);
            const double ratio = comp_scale == 0.0
                ? (net_sum == 0.0 ? 0.0 : INFINITY)
                : fabs(net_sum) / comp_scale;
            component_max = fmax(component_max, ratio);
        }
    } else {
        for (uint64_t c = grid.thread_rank(); c < comp_count; c += grid.size()) {
            comp_net_scratch[c] = 0.0;
            comp_scale_scratch[c] = 0.0;
        }
        grid.sync();
        for (uint64_t i = grid.thread_rank(); i < cells; i += grid.size()) {
            if (!active[i]) continue;
            const uint64_t c = labels[i];
            if (c >= comp_count) continue;
            double scale = 0.0;
            const double net = integrated_cell_flux(
                i, nx, ny, nz, ax, ay, az, jx, jy, jz, &scale);
            atomicAdd(comp_net_scratch + c, net);
            atomicAdd(comp_scale_scratch + c, scale);
        }
        grid.sync();
        double local_cmax = 0.0;
        for (uint64_t c = grid.thread_rank(); c < comp_count; c += grid.size()) {
            const double net_sum = comp_net_scratch[c];
            const double comp_scale = comp_scale_scratch[c];
            const double ratio = comp_scale == 0.0
                ? (net_sum == 0.0 ? 0.0 : INFINITY)
                : fabs(net_sum) / comp_scale;
            local_cmax = fmax(local_cmax, ratio);
        }
        component_max = deterministic_grid_max(
            local_cmax, partials, &state->scalar0, shared, grid);
    }

    // Parallel external-face electrode balance.
    const uint64_t yz_pairs = ny * nz;
    const uint64_t xz_pairs = nx * nz;
    const uint64_t xy_pairs = nx * ny;
    const uint64_t total_pairs = yz_pairs + xz_pairs + xy_pairs;
    double local_elec = 0.0;
    double local_elec_scale = 0.0;
    for (uint64_t idx = grid.thread_rank(); idx < total_pairs; idx += grid.size()) {
        if (idx < yz_pairs) {
            const uint64_t y = idx % ny;
            const uint64_t z = idx / ny;
            const uint64_t left = (nx + 1) * (y + ny * z);
            const uint64_t right = nx + left;
            local_elec += (-jx[left] + jx[right]) * ax;
            local_elec_scale += (fabs(jx[left]) + fabs(jx[right])) * ax;
        } else if (idx < yz_pairs + xz_pairs) {
            const uint64_t k = idx - yz_pairs;
            const uint64_t x = k % nx;
            const uint64_t z = k / nx;
            const uint64_t lower = x + nx * ((ny + 1) * z);
            const uint64_t upper = x + nx * (ny + (ny + 1) * z);
            local_elec += (-jy[lower] + jy[upper]) * ay;
            local_elec_scale += (fabs(jy[lower]) + fabs(jy[upper])) * ay;
        } else {
            const uint64_t k = idx - yz_pairs - xz_pairs;
            const uint64_t x = k % nx;
            const uint64_t y = k / nx;
            const uint64_t back = x + nx * y;
            const uint64_t front = x + nx * (y + ny * nz);
            local_elec += (-jz[back] + jz[front]) * az;
            local_elec_scale += (fabs(jz[back]) + fabs(jz[front])) * az;
        }
    }
    const double total_elec = deterministic_grid_sum(
        local_elec, partials, &state->scalar0, shared, grid);
    const double total_elec_scale = deterministic_grid_sum(
        local_elec_scale, partials, &state->scalar1, shared, grid);

    if (grid.thread_rank() == 0) {
        metrics->physical_residual = total_scale2 == 0.0
            ? (total_res2 == 0.0 ? 0.0 : INFINITY)
            : sqrt(total_res2 / total_scale2);
        metrics->component_balance = component_max;
        metrics->electrode_balance =
            total_elec_scale == 0.0 ? 0.0 : fabs(total_elec) / total_elec_scale;
        metrics->debug_transverse_max = total_trans;
    }
}

uint32_t resolve_coop_blocks(
    const void *kernel, uint64_t work_items, int sm_count, bool allow_multi) {
    if (!allow_multi || work_items <= kBlock0CellThreshold) return 1u;
    int active_blocks_per_sm = 0;
    if (cudaOccupancyMaxActiveBlocksPerMultiprocessor(
            &active_blocks_per_sm, kernel, kThreads, kThreads * sizeof(double)) != cudaSuccess ||
        active_blocks_per_sm <= 0) {
        return 0u;
    }
    const uint64_t needed = std::max<uint64_t>(1, (work_items + kThreads - 1) / kThreads);
    const uint64_t max_resident = static_cast<uint64_t>(active_blocks_per_sm) * sm_count;
    return static_cast<uint32_t>(std::min<uint64_t>({needed, max_resident, kMaxCoopBlocks}));
}

} // namespace

uint64_t solve_metrics_bytes() noexcept {
    return sizeof(DeviceSolveMetrics);
}

void release(Buffers &buffers) noexcept {
    if (buffers.active) (void)cudaFree(buffers.active);
    if (buffers.conductivity) (void)cudaFree(buffers.conductivity);
    if (buffers.potential) (void)cudaFree(buffers.potential);
    if (buffers.jx) (void)cudaFree(buffers.jx);
    if (buffers.jy) (void)cudaFree(buffers.jy);
    if (buffers.jz) (void)cudaFree(buffers.jz);
    if (buffers.interface_from_trace_v) (void)cudaFree(buffers.interface_from_trace_v);
    if (buffers.interface_to_trace_v) (void)cudaFree(buffers.interface_to_trace_v);
    if (buffers.interface_delta_trace_v) (void)cudaFree(buffers.interface_delta_trace_v);
    if (buffers.interface_charge_current_density)
        (void)cudaFree(buffers.interface_charge_current_density);
    buffers = {};
}

void release(HierarchyCache &cache) noexcept {
    if (cache.cudss_solver) {
        destroy_charge_cudss_direct_solver(
            static_cast<CudssDirectSolver *>(cache.cudss_solver));
    }
    if (cache.pinned_mask) (void)cudaFree(cache.pinned_mask);
    for (uint32_t l = 1; l < kMaxAmgLevels; ++l) {
        if (l >= 2 && cache.levels[l].diag) (void)cudaFree(cache.levels[l].diag);
        if (cache.levels[l].gx) (void)cudaFree(cache.levels[l].gx);
        if (cache.levels[l].gy) (void)cudaFree(cache.levels[l].gy);
        if (cache.levels[l].gz) (void)cudaFree(cache.levels[l].gz);
    }
    if (cache.component_labels) (void)cudaFree(cache.component_labels);
    if (cache.component_anchored) (void)cudaFree(cache.component_anchored);
    if (cache.component_pin_cell) (void)cudaFree(cache.component_pin_cell);
    if (cache.free_component_ids) (void)cudaFree(cache.free_component_ids);
    if (cache.free_component_sizes) (void)cudaFree(cache.free_component_sizes);
    if (cache.device_component_count) (void)cudaFree(cache.device_component_count);
    if (cache.device_free_component_count) (void)cudaFree(cache.device_free_component_count);
    if (cache.device_has_unanchored) (void)cudaFree(cache.device_has_unanchored);
    if (cache.device_has_unbalanced_free) (void)cudaFree(cache.device_has_unbalanced_free);
    if (cache.active) (void)cudaFree(cache.active);
    if (cache.conductivity) (void)cudaFree(cache.conductivity);
    if (cache.diag) (void)cudaFree(cache.diag);
    if (cache.rhs) (void)cudaFree(cache.rhs);
    if (cache.gx) (void)cudaFree(cache.gx);
    if (cache.gy) (void)cudaFree(cache.gy);
    if (cache.gz) (void)cudaFree(cache.gz);
    if (cache.coarse_diag) (void)cudaFree(cache.coarse_diag);
    if (cache.aggregate) (void)cudaFree(cache.aggregate);
    if (cache.coarse_edge_a) (void)cudaFree(cache.coarse_edge_a);
    if (cache.coarse_edge_b) (void)cudaFree(cache.coarse_edge_b);
    if (cache.coarse_edge_weight) (void)cudaFree(cache.coarse_edge_weight);
    if (cache.hierarchy_info) (void)cudaFree(cache.hierarchy_info);
    if (cache.warm_potential) (void)cudaFree(cache.warm_potential);
    if (cache.warm_potential_staging) (void)cudaFree(cache.warm_potential_staging);
    cache = {};
}

uint32_t materialize_static_state(
    const SolveInput &input, Buffers *buffers, uint32_t boundary) noexcept {
    if (buffers == nullptr) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const uint64_t cells = input.grid[0] * input.grid[1] * input.grid[2];
    if (cells == 0) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    if (cudaMalloc(reinterpret_cast<void **>(&buffers->active), cells) != cudaSuccess ||
        cudaMalloc(reinterpret_cast<void **>(&buffers->conductivity), cells * sizeof(double)) != cudaSuccess) {
        release(*buffers);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    }
    constexpr uint32_t threads = kThreads;
    const uint32_t blocks = static_cast<uint32_t>(std::min<uint64_t>(
        (cells + threads - 1) / threads, 65535));
    const auto &mask_view = input.views[0];
    const auto &material_view = input.views[1];
    if (inject_cuda_failure(input.failure_policy, boundary)) {
        release(*buffers);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    normalize_charge_payload_kernel<<<blocks, threads, 0, input.stream>>>(
        input.payloads[0], mask_view.byte_stride, mask_view.element_type,
        input.payloads[1], material_view.element_count, material_view.byte_stride,
        material_view.element_type, cells, buffers->active, buffers->conductivity);
    if (cudaGetLastError() != cudaSuccess || cudaStreamSynchronize(input.stream) != cudaSuccess) {
        release(*buffers);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t validate_static_payload_device(
    const SolveInput &input, uint32_t copy_boundary,
    uint32_t sync_boundary) noexcept {
    uint32_t *device_invalid = nullptr;
    uint32_t *device_seen_faces = nullptr;
    const uint64_t face_count = input.views[3].element_count;
    if (cudaMalloc(reinterpret_cast<void **>(&device_invalid), sizeof(uint32_t)) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    if (cudaMalloc(reinterpret_cast<void **>(&device_seen_faces),
                   face_count * sizeof(uint32_t)) != cudaSuccess) {
        (void)cudaFree(device_invalid);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    }
    uint32_t invalid = 0;
    if (cudaMemsetAsync(device_invalid, 0, sizeof(uint32_t), input.stream) != cudaSuccess ||
        cudaMemsetAsync(device_seen_faces, 0, face_count * sizeof(uint32_t),
                        input.stream) != cudaSuccess) {
        (void)cudaFree(device_seen_faces);
        (void)cudaFree(device_invalid);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const auto &mask = input.views[0];
    const auto &faces = input.views[3];
    constexpr uint32_t threads = kThreads;
    const uint32_t blocks = static_cast<uint32_t>(std::min<uint64_t>(
        (face_count + threads - 1) / threads, 65535));
    validate_static_payload_kernel<<<blocks, threads, 0, input.stream>>>(
        input.grid[0], input.grid[1], input.grid[2], input.cell_size[0], input.cell_size[1],
        input.cell_size[2], input.payloads[0], mask.byte_stride, mask.element_type,
        input.payloads[3], faces.element_count, faces.byte_stride, device_seen_faces,
        device_invalid);
    const cudaError_t launch = cudaGetLastError();
    if (launch == cudaSuccess && inject_cuda_failure(
            input.failure_policy, copy_boundary)) {
        (void)cudaFree(device_seen_faces); (void)cudaFree(device_invalid);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t copy = launch == cudaSuccess
        ? cudaMemcpyAsync(&invalid, device_invalid, sizeof(invalid), cudaMemcpyDeviceToHost, input.stream)
        : launch;
    if (copy == cudaSuccess && inject_cuda_failure(
            input.failure_policy, sync_boundary)) {
        (void)cudaFree(device_seen_faces); (void)cudaFree(device_invalid);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t sync = copy == cudaSuccess ? cudaStreamSynchronize(input.stream) : copy;
    (void)cudaFree(device_seen_faces);
    (void)cudaFree(device_invalid);
    if (launch != cudaSuccess || copy != cudaSuccess || sync != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    if (invalid != 0)
        std::fprintf(stderr, "charge static validation failed: code=%u\n", invalid);
    return invalid == 0 ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
                        : FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
}

uint32_t solve_device(const SolveInput &input, SolveOutput *output) noexcept {
    if (output == nullptr || input.hierarchy_cache == nullptr)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    const bool use_cudss = charge_cudss_direct_requested();
    if (use_cudss && !charge_cudss_compiled()) {
        std::fprintf(stderr,
                     "FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss requires an FDM GPU build with cuDSS\n");
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
    }
    output->transfer_bytes = solve_metrics_bytes() + sizeof(uint32_t);
    const uint64_t nx = input.grid[0], ny = input.grid[1], nz = input.grid[2];
    const uint64_t cells = nx * ny * nz;
    const uint64_t jx_count = (nx + 1) * ny * nz;
    const uint64_t jy_count = nx * (ny + 1) * nz;
    const uint64_t jz_count = nx * ny * (nz + 1);
    Buffers candidate{};
    candidate.cells = cells;
    candidate.jx_count = jx_count;
    candidate.jy_count = jy_count;
    candidate.jz_count = jz_count;
    candidate.interface_count = input.views[2].element_count;
    HierarchyCache &cache = *input.hierarchy_cache;
    const bool cache_hit = cache.valid;
    if (cache_hit && cache.cells != cells)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;

    int device = 0;
    cudaDeviceProp prop{};
    if (cudaGetDevice(&device) != cudaSuccess ||
        cudaGetDeviceProperties(&prop, device) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    if (!prop.cooperativeLaunch)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;

    // Plan multi-level 2x2x2 geometric hierarchy dimensions up front.
    std::array<uint64_t, kMaxAmgLevels> lvl_nx{}, lvl_ny{}, lvl_nz{}, lvl_cells{};
    lvl_nx[0] = nx; lvl_ny[0] = ny; lvl_nz[0] = nz; lvl_cells[0] = cells;
    uint32_t planned_levels = 1;
    const uint64_t l1_nx = (nx + 1) / 2;
    const uint64_t l1_ny = (ny + 1) / 2;
    const uint64_t l1_nz = (nz + 1) / 2;
    const uint64_t l1_cells = l1_nx * l1_ny * l1_nz;
    const uint64_t l1_edges =
        (l1_nx > 1 ? (l1_nx - 1) * l1_ny * l1_nz : 0) +
        (l1_ny > 1 ? l1_nx * (l1_ny - 1) * l1_nz : 0) +
        (l1_nz > 1 ? l1_nx * l1_ny * (l1_nz - 1) : 0);
    if (l1_cells < cells) {
        lvl_nx[1] = l1_nx; lvl_ny[1] = l1_ny; lvl_nz[1] = l1_nz; lvl_cells[1] = l1_cells;
        planned_levels = 2;
        while (planned_levels < kMaxAmgLevels) {
            const uint32_t prev = planned_levels - 1;
            if (lvl_nx[prev] <= 2 && lvl_ny[prev] <= 2 && lvl_nz[prev] <= 2) break;
            const uint64_t nnx = (lvl_nx[prev] + 1) / 2;
            const uint64_t nny = (lvl_ny[prev] + 1) / 2;
            const uint64_t nnz = (lvl_nz[prev] + 1) / 2;
            const uint64_t ncells = nnx * nny * nnz;
            if (ncells >= lvl_cells[prev]) break;
            lvl_nx[planned_levels] = nnx;
            lvl_ny[planned_levels] = nny;
            lvl_nz[planned_levels] = nnz;
            lvl_cells[planned_levels] = ncells;
            ++planned_levels;
        }
    }
    uint64_t total_coarse_cells = 0;
    for (uint32_t l = 1; l < planned_levels; ++l) total_coarse_cells += lvl_cells[l];
    const uint64_t agg_chunks = (cells + kHashChunkSize - 1) / kHashChunkSize;
    const uint64_t edge_chunks = l1_edges > 0 ? (l1_edges + kHashChunkSize - 1) / kHashChunkSize : 0;
    const uint64_t total_hash_chunks = std::max<uint64_t>(1, agg_chunks + edge_chunks);

    auto checked_add = [](uint64_t a, uint64_t b, uint64_t *sum) {
        if (a > UINT64_MAX - b) return false;
        *sum = a + b;
        return true;
    };
    auto checked_scaled = [](uint64_t value, uint64_t scale, uint64_t *product) {
        if (scale != 0 && value > UINT64_MAX / scale) return false;
        *product = value * scale;
        return true;
    };

    const uint64_t fine_bytes = cells * sizeof(double);
    const uint64_t l1_edge_alloc = std::max<uint64_t>(l1_edges, 1);
    const uint64_t partials_count = 4 * static_cast<uint64_t>(kMaxCoopBlocks);
    uint64_t workspace_bytes = 0, cache_bytes = 0, candidate_bytes = 0;
    uint64_t coarse_vec_bytes = 0, coarse_op_bytes = 0, edge_bytes = 0;
    uint64_t comp_cache_bytes = 0, hash_chunk_bytes = 0;
    uint64_t face_values = 0, face_bytes = 0, interface_bytes = 0, total_peak_bytes = 0;

    uint64_t extra_level_cells = 0;
    for (uint32_t l = 2; l < planned_levels; ++l) extra_level_cells += lvl_cells[l];
    const uint64_t l1_stencil_bytes = planned_levels >= 2 ? l1_cells * 3 * sizeof(double) : 0;

    const bool sizes_valid =
        checked_scaled(fine_bytes, 5, &workspace_bytes) &&
        checked_scaled(total_coarse_cells, 2 * sizeof(double), &coarse_vec_bytes) &&
        checked_add(workspace_bytes, coarse_vec_bytes, &workspace_bytes) &&
        checked_add(workspace_bytes, partials_count * sizeof(double), &workspace_bytes) &&
        checked_add(workspace_bytes, sizeof(DevicePcgState) + sizeof(DeviceSolveMetrics) + sizeof(uint32_t),
                    &workspace_bytes) &&
        checked_scaled(total_hash_chunks, 4 * sizeof(uint64_t), &hash_chunk_bytes) &&
        checked_add(workspace_bytes, cache_hit ? 0 : hash_chunk_bytes, &workspace_bytes) &&
        checked_scaled(fine_bytes, 8, &cache_bytes) &&
        checked_add(cache_bytes, cells, &cache_bytes) &&
        checked_add(cache_bytes, l1_cells * sizeof(double), &cache_bytes) &&
        checked_add(cache_bytes, cells * sizeof(uint64_t), &cache_bytes) &&
        checked_scaled(l1_edge_alloc, 2 * sizeof(uint64_t) + sizeof(double), &edge_bytes) &&
        checked_add(cache_bytes, edge_bytes, &cache_bytes) &&
        checked_add(cache_bytes, l1_stencil_bytes, &cache_bytes) &&
        checked_scaled(extra_level_cells, 4 * sizeof(double), &coarse_op_bytes) &&
        checked_add(cache_bytes, coarse_op_bytes, &cache_bytes) &&
        checked_scaled(cells, sizeof(uint64_t) + sizeof(uint8_t) + 2 * sizeof(uint32_t) + sizeof(uint64_t) + sizeof(uint8_t),
                       &comp_cache_bytes) &&
        checked_add(cache_bytes, comp_cache_bytes, &cache_bytes) &&
        checked_add(cache_bytes, 4 * sizeof(uint32_t) + sizeof(DeviceHierarchyInfo), &cache_bytes) &&
        checked_add(jx_count, jy_count, &face_values) &&
        checked_add(face_values, jz_count, &face_values) &&
        checked_scaled(face_values, sizeof(double), &face_bytes) &&
        checked_scaled(candidate.interface_count, 4 * sizeof(double), &interface_bytes) &&
        checked_scaled(fine_bytes, 2, &candidate_bytes) &&
        checked_add(candidate_bytes, cells, &candidate_bytes) &&
        checked_add(candidate_bytes, face_bytes, &candidate_bytes) &&
        checked_add(candidate_bytes, interface_bytes, &candidate_bytes) &&
        checked_add(input.static_owned_bytes, cache_hit ? cache.cached_bytes : cache_bytes,
                    &total_peak_bytes) &&
        checked_add(total_peak_bytes, candidate_bytes, &total_peak_bytes) &&
        checked_add(total_peak_bytes, workspace_bytes, &total_peak_bytes);

    if (!sizes_valid ||
        (input.workspace_limit != 0 && workspace_bytes > input.workspace_limit) ||
        (input.allocator_limit != 0 && total_peak_bytes > input.allocator_limit))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;

    uint64_t required_new_bytes = candidate_bytes;
    if (!checked_add(required_new_bytes, workspace_bytes, &required_new_bytes) ||
        (!cache_hit && !checked_add(required_new_bytes, cache_bytes, &required_new_bytes)))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;

    size_t free_device_bytes = 0, total_device_bytes = 0;
    if (cudaMemGetInfo(&free_device_bytes, &total_device_bytes) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    constexpr uint64_t minimum_safety_reserve = UINT64_C(256) * 1024 * 1024;
    const uint64_t proportional_reserve = static_cast<uint64_t>(total_device_bytes) / 20;
    const uint64_t safety_reserve = std::max(minimum_safety_reserve, proportional_reserve);
    const uint64_t usable_device_bytes = static_cast<uint64_t>(free_device_bytes) > safety_reserve
        ? static_cast<uint64_t>(free_device_bytes) - safety_reserve : 0;
    if (required_new_bytes > usable_device_bytes)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;

    double *r = nullptr, *z = nullptr, *p = nullptr, *ap = nullptr, *fine_tmp = nullptr;
    double *coarse_pool = nullptr;
    double *partials = nullptr;
    uint64_t *hash_chunks = nullptr;
    DevicePcgState *pcg_state = nullptr;
    uint32_t *device_gauge_invalid = nullptr;
    DeviceSolveMetrics *device_metrics = nullptr;
    auto cleanup = [&]() {
        if (r) (void)cudaFree(r);
        if (z) (void)cudaFree(z);
        if (p) (void)cudaFree(p);
        if (ap) (void)cudaFree(ap);
        if (fine_tmp) (void)cudaFree(fine_tmp);
        if (coarse_pool) (void)cudaFree(coarse_pool);
        if (partials) (void)cudaFree(partials);
        if (hash_chunks) (void)cudaFree(hash_chunks);
        if (pcg_state) (void)cudaFree(pcg_state);
        if (device_gauge_invalid) (void)cudaFree(device_gauge_invalid);
        if (device_metrics) (void)cudaFree(device_metrics);
    };
    auto alloc = [](void **pointer, uint64_t bytes) {
        if (bytes == 0) {
            *pointer = nullptr;
            return true;
        }
        return cudaMalloc(pointer, static_cast<size_t>(bytes)) == cudaSuccess;
    };

    bool cache_allocated = true;
    if (!cache_hit) {
        cache.cells = cells;
        cache.coarse_cells = l1_cells;
        cache.level_count = planned_levels;
        cache.level1_edge_count = l1_edges;
        cache.cached_bytes = cache_bytes;
        cache_allocated =
            alloc(reinterpret_cast<void **>(&cache.active), cells) &&
            alloc(reinterpret_cast<void **>(&cache.conductivity), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.diag), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.rhs), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.gx), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.gy), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.gz), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_diag), l1_cells * sizeof(double)) &&
            alloc(reinterpret_cast<void **>(&cache.aggregate), cells * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_edge_a),
                  l1_edge_alloc * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_edge_b),
                  l1_edge_alloc * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_edge_weight),
                  l1_edge_alloc * sizeof(double)) &&
            alloc(&cache.hierarchy_info, sizeof(DeviceHierarchyInfo)) &&
            alloc(reinterpret_cast<void **>(&cache.warm_potential), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.warm_potential_staging), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.component_labels), cells * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.component_anchored), cells) &&
            alloc(reinterpret_cast<void **>(&cache.component_pin_cell), cells * sizeof(uint32_t)) &&
            alloc(reinterpret_cast<void **>(&cache.free_component_ids), cells * sizeof(uint32_t)) &&
            alloc(reinterpret_cast<void **>(&cache.free_component_sizes), cells * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.device_component_count), sizeof(uint32_t)) &&
            alloc(reinterpret_cast<void **>(&cache.device_free_component_count), sizeof(uint32_t)) &&
            alloc(reinterpret_cast<void **>(&cache.device_has_unanchored), sizeof(uint32_t)) &&
            alloc(reinterpret_cast<void **>(&cache.device_has_unbalanced_free), sizeof(uint32_t)) &&
            alloc(reinterpret_cast<void **>(&cache.pinned_mask), cells);
        if (cache_allocated) {
            cache.levels[0] = {nx, ny, nz, cells, cache.diag, cache.gx, cache.gy, cache.gz};
            if (planned_levels >= 2) {
                cache.levels[1] = {l1_nx, l1_ny, l1_nz, l1_cells,
                                   cache.coarse_diag, nullptr, nullptr, nullptr};
                cache_allocated =
                    alloc(reinterpret_cast<void **>(&cache.levels[1].gx), l1_cells * sizeof(double)) &&
                    alloc(reinterpret_cast<void **>(&cache.levels[1].gy), l1_cells * sizeof(double)) &&
                    alloc(reinterpret_cast<void **>(&cache.levels[1].gz), l1_cells * sizeof(double));
            }
            for (uint32_t l = 2; l < planned_levels && cache_allocated; ++l) {
                cache.levels[l] = {lvl_nx[l], lvl_ny[l], lvl_nz[l], lvl_cells[l],
                                   nullptr, nullptr, nullptr, nullptr};
                const uint64_t bytes_l = lvl_cells[l] * sizeof(double);
                cache_allocated =
                    alloc(reinterpret_cast<void **>(&cache.levels[l].diag), bytes_l) &&
                    alloc(reinterpret_cast<void **>(&cache.levels[l].gx), bytes_l) &&
                    alloc(reinterpret_cast<void **>(&cache.levels[l].gy), bytes_l) &&
                    alloc(reinterpret_cast<void **>(&cache.levels[l].gz), bytes_l);
            }
        }
    }

    const bool allocated = cache_allocated &&
        alloc(reinterpret_cast<void **>(&candidate.potential), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&candidate.jx), jx_count * sizeof(double)) &&
        alloc(reinterpret_cast<void **>(&candidate.jy), jy_count * sizeof(double)) &&
        alloc(reinterpret_cast<void **>(&candidate.jz), jz_count * sizeof(double)) &&
        alloc(reinterpret_cast<void **>(&candidate.active), cells) &&
        alloc(reinterpret_cast<void **>(&candidate.conductivity), fine_bytes) &&
        (candidate.interface_count == 0 ||
         (alloc(reinterpret_cast<void **>(&candidate.interface_from_trace_v),
                candidate.interface_count * sizeof(double)) &&
          alloc(reinterpret_cast<void **>(&candidate.interface_to_trace_v),
                candidate.interface_count * sizeof(double)) &&
          alloc(reinterpret_cast<void **>(&candidate.interface_delta_trace_v),
                candidate.interface_count * sizeof(double)) &&
          alloc(reinterpret_cast<void **>(&candidate.interface_charge_current_density),
                candidate.interface_count * sizeof(double)))) &&
        alloc(reinterpret_cast<void **>(&r), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&z), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&p), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&ap), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&fine_tmp), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&coarse_pool), coarse_vec_bytes) &&
        alloc(reinterpret_cast<void **>(&partials), partials_count * sizeof(double)) &&
        (cache_hit || alloc(reinterpret_cast<void **>(&hash_chunks), hash_chunk_bytes)) &&
        alloc(reinterpret_cast<void **>(&pcg_state), sizeof(DevicePcgState)) &&
        alloc(reinterpret_cast<void **>(&device_gauge_invalid), sizeof(uint32_t)) &&
        alloc(reinterpret_cast<void **>(&device_metrics), sizeof(DeviceSolveMetrics));
    if (!allocated) {
        cleanup();
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    }
    if (cudaMemsetAsync(device_metrics, 0, sizeof(DeviceSolveMetrics), input.stream) != cudaSuccess ||
        cudaMemsetAsync(device_gauge_invalid, 0, sizeof(uint32_t), input.stream) != cudaSuccess ||
        (!cache_hit &&
         cudaMemsetAsync(cache.pinned_mask, 0, cells, input.stream) != cudaSuccess)) {
        cleanup();
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }

    constexpr uint32_t threads = kThreads;
    const uint32_t blocks = static_cast<uint32_t>(std::min<uint64_t>((cells + threads - 1) / threads, 65535));
    const auto &mask_view = input.views[0];
    const auto &material_view = input.views[1];
    const auto &face_view = input.views[3];

    if (!cache_hit) {
        normalize_charge_payload_kernel<<<blocks, threads, 0, input.stream>>>(
            input.payloads[0], mask_view.byte_stride, mask_view.element_type,
            input.payloads[1], material_view.element_count, material_view.byte_stride,
            material_view.element_type, cells, cache.active, cache.conductivity);
        assemble_charge_fv_kernel<<<blocks, threads, 0, input.stream>>>(
            nx, ny, nz, input.cell_size[0], input.cell_size[1], input.cell_size[2],
            cache.active, cache.conductivity, input.payloads[3], face_view.element_count,
            face_view.byte_stride, input.payloads[2], input.views[2].element_count,
            input.views[2].byte_stride, cache.diag, cache.rhs, cache.gx, cache.gy,
            cache.gz);
        const uint32_t coarse_blocks = static_cast<uint32_t>(std::min<uint64_t>(
            (l1_cells + threads - 1) / threads, 65535));
        assign_geometric_aggregates_kernel<<<blocks, threads, 0, input.stream>>>(
            nx, ny, nz, l1_nx, l1_ny, cache.aggregate);
        build_geometric_rap_kernel<<<coarse_blocks, threads, 0, input.stream>>>(
            cache.active, cache.diag, cache.gx, cache.gy, cache.gz, nx, ny, nz,
            cache.aggregate, cache.coarse_diag, cache.coarse_edge_a, cache.coarse_edge_b,
            cache.coarse_edge_weight,
            cache.level_count >= 2 ? cache.levels[1].gx : nullptr,
            cache.level_count >= 2 ? cache.levels[1].gy : nullptr,
            cache.level_count >= 2 ? cache.levels[1].gz : nullptr);
        for (uint32_t l = 2; l < cache.level_count; ++l) {
            const uint32_t lvl_blocks = static_cast<uint32_t>(std::min<uint64_t>(
                (cache.levels[l].cells + threads - 1) / threads, 65535));
            build_coarse_rap_level_kernel<<<lvl_blocks, threads, 0, input.stream>>>(
                cache.levels[l - 1], cache.levels[l]);
        }
        const uint32_t hash_blocks = static_cast<uint32_t>(std::min<uint64_t>(
            (total_hash_chunks + threads - 1) / threads, 65535));
        hash_hierarchy_chunks_kernel<<<hash_blocks, threads, 0, input.stream>>>(
            cache.aggregate, cells, cache.coarse_edge_a, cache.coarse_edge_b,
            cache.coarse_edge_weight, l1_edges, agg_chunks, total_hash_chunks, hash_chunks);
        finalize_geometric_rap_kernel<<<1, 1, 0, input.stream>>>(
            hash_chunks, total_hash_chunks, l1_nx, l1_ny, l1_nz, l1_edges,
            cache.level_count,
            reinterpret_cast<DeviceHierarchyInfo *>(cache.hierarchy_info));

        const uint32_t label_blocks = resolve_coop_blocks(
            reinterpret_cast<const void *>(label_reference_components_coop_kernel),
            cells, prop.multiProcessorCount, true);
        if (label_blocks == 0u) {
            cleanup(); release(candidate); release(cache);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        uint64_t nx_arg = nx, ny_arg = ny, nz_arg = nz;
        const void *face_payload_arg = input.payloads[3];
        uint64_t face_count_arg = face_view.element_count;
        uint64_t face_stride_arg = face_view.byte_stride;
        auto *aux_u64 = reinterpret_cast<uint64_t *>(r);
        void *label_args[] = {
            &nx_arg, &ny_arg, &nz_arg, &cache.active,
            &face_payload_arg, &face_count_arg, &face_stride_arg,
            &cache.gx, &cache.gy, &cache.gz, &cache.rhs,
            &cache.component_labels, &cache.component_anchored, &cache.component_pin_cell,
            &cache.free_component_ids, &cache.free_component_sizes,
            &cache.device_component_count, &cache.device_free_component_count,
            &cache.device_has_unanchored, &cache.device_has_unbalanced_free,
            &aux_u64, &z, &p, &partials, &pcg_state};
        if (cudaLaunchCooperativeKernel(
                reinterpret_cast<void *>(label_reference_components_coop_kernel),
                label_blocks, kThreads, label_args,
                kThreads * sizeof(double), input.stream) != cudaSuccess) {
            cleanup(); release(candidate); release(cache);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        build_pinned_mask_kernel<<<blocks, threads, 0, input.stream>>>(
            cells, cache.free_component_ids, cache.device_free_component_count,
            cache.component_pin_cell, cache.pinned_mask);
    }

    evaluate_gauge_policy_kernel<<<1, 1, 0, input.stream>>>(
        input.gauge_policy, cache.device_has_unanchored,
        cache.device_has_unbalanced_free, device_gauge_invalid);
    uint32_t gauge_invalid = 0;
    const cudaError_t gauge_launch = cudaGetLastError();
    if (gauge_launch == cudaSuccess && inject_cuda_failure(
            input.failure_policy, 10)) {
        cleanup(); release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t gauge_copy = gauge_launch == cudaSuccess
        ? cudaMemcpyAsync(&gauge_invalid, device_gauge_invalid, sizeof(gauge_invalid),
                          cudaMemcpyDeviceToHost, input.stream)
        : gauge_launch;
    if (gauge_copy == cudaSuccess && inject_cuda_failure(
            input.failure_policy, 11)) {
        cleanup(); release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t gauge_sync = gauge_copy == cudaSuccess
        ? cudaStreamSynchronize(input.stream) : gauge_copy;
    if (gauge_launch != cudaSuccess || gauge_copy != cudaSuccess || gauge_sync != cudaSuccess ||
        gauge_invalid != 0) {
        cleanup();
        release(candidate);
        if (!cache_hit) release(cache);
        return gauge_invalid == 2
            ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_BALANCE_FAILURE
            : gauge_invalid != 0
                ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR
                : FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    if (inject_cuda_failure(input.failure_policy, 12) ||
        cudaMemcpyAsync(candidate.active, cache.active, cells, cudaMemcpyDeviceToDevice,
                        input.stream) != cudaSuccess ||
        cudaMemcpyAsync(candidate.conductivity, cache.conductivity, fine_bytes,
                        cudaMemcpyDeviceToDevice, input.stream) != cudaSuccess) {
        cleanup();
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }

    const bool warm_start_used = !use_cudss && cache.warm_valid &&
        cache.warm_potential != nullptr && cache.cells == cells &&
        cache.warm_descriptor_revision == input.descriptor_revision &&
        cache.warm_source_revision == input.source_revision;
    if (cache.warm_valid && !use_cudss && !warm_start_used)
        cache.warm_valid = false;

    cudaError_t solver_launch = cudaSuccess;
    if (use_cudss) {
        // Lazy factor-once cuDSS direct Cholesky realization on cached operator.
        if (cache.cudss_solver == nullptr) {
            const uint64_t lower_nnz = cells +
                (nx > 1 ? (nx - 1) * ny * nz : 0) +
                (ny > 1 ? nx * (ny - 1) * nz : 0) +
                (nz > 1 ? nx * ny * (nz - 1) : 0);
            if (cells > static_cast<uint64_t>(INT32_MAX) ||
                lower_nnz > static_cast<uint64_t>(INT32_MAX)) {
                cleanup(); release(candidate);
                if (!cache_hit) release(cache);
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
            }
            const uint64_t csr_bytes =
                (cells + 1) * sizeof(int32_t) +
                lower_nnz * (sizeof(int32_t) + sizeof(double));
            uint64_t with_csr_peak = 0;
            if (!checked_add(total_peak_bytes, csr_bytes, &with_csr_peak) ||
                (input.allocator_limit != 0 && with_csr_peak > input.allocator_limit)) {
                cleanup(); release(candidate);
                if (!cache_hit) release(cache);
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES;
            }
            int32_t *d_offsets = nullptr;
            int32_t *d_columns = nullptr;
            double *d_values = nullptr;
            if (!alloc(reinterpret_cast<void **>(&d_offsets), (cells + 1) * sizeof(int32_t)) ||
                !alloc(reinterpret_cast<void **>(&d_columns), lower_nnz * sizeof(int32_t)) ||
                !alloc(reinterpret_cast<void **>(&d_values), lower_nnz * sizeof(double))) {
                if (d_offsets) (void)cudaFree(d_offsets);
                if (d_columns) (void)cudaFree(d_columns);
                if (d_values) (void)cudaFree(d_values);
                cleanup(); release(candidate);
                if (!cache_hit) release(cache);
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
            }
            assemble_cudss_lower_csr_kernel<<<blocks, threads, 0, input.stream>>>(
                nx, ny, nz, lower_nnz, cache.active, cache.pinned_mask,
                cache.diag, cache.gx, cache.gy, cache.gz,
                d_offsets, d_columns, d_values);
            if (cudaGetLastError() != cudaSuccess) {
                (void)cudaFree(d_offsets);
                (void)cudaFree(d_columns);
                (void)cudaFree(d_values);
                cleanup(); release(candidate);
                if (!cache_hit) release(cache);
                return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
            }
            const uint64_t allocator_remaining = input.allocator_limit != 0
                ? (input.allocator_limit > with_csr_peak
                       ? input.allocator_limit - with_csr_peak : 1)
                : 0;
            CudssDirectSolver *direct = nullptr;
            CudssDirectStats stats{};
            std::string cudss_error;
            const uint32_t create_status = create_charge_cudss_direct_solver(
                static_cast<int64_t>(cells), static_cast<int64_t>(lower_nnz),
                d_offsets, d_columns, d_values, input.stream,
                allocator_remaining, &direct, &stats, cudss_error);
            if (create_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
                (void)cudaFree(d_offsets);
                (void)cudaFree(d_columns);
                (void)cudaFree(d_values);
                std::fprintf(stderr, "charge cuDSS setup failed: %s\n", cudss_error.c_str());
                cleanup(); release(candidate);
                if (!cache_hit) release(cache);
                return create_status;
            }
            cache.cudss_solver = direct;
        }
        const uint64_t cudss_bytes = charge_cudss_owned_bytes(
            static_cast<const CudssDirectSolver *>(cache.cudss_solver));
        (void)checked_add(total_peak_bytes, cudss_bytes, &total_peak_bytes);

        const uint32_t prep_blocks = resolve_coop_blocks(
            reinterpret_cast<const void *>(prepare_cudss_rhs_coop_kernel),
            cells, prop.multiProcessorCount, true);
        const uint32_t ir_blocks = resolve_coop_blocks(
            reinterpret_cast<const void *>(cudss_ir_residual_coop_kernel),
            cells, prop.multiProcessorCount, true);
        const uint32_t fin_blocks = resolve_coop_blocks(
            reinterpret_cast<const void *>(finalize_cudss_solution_coop_kernel),
            cells, prop.multiProcessorCount, true);
        if (prep_blocks == 0u || ir_blocks == 0u || fin_blocks == 0u) {
            cleanup(); release(candidate);
            if (!cache_hit) release(cache);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        uint64_t cells_arg = cells;
        uint32_t gauge_arg = input.gauge_policy;
        void *prep_args[] = {
            &cells_arg, &cache.active, &cache.rhs, &gauge_arg,
            &cache.component_labels, &cache.free_component_ids,
            &cache.free_component_sizes, &cache.device_free_component_count,
            &fine_tmp, &partials, &pcg_state};
        solver_launch = cudaLaunchCooperativeKernel(
            reinterpret_cast<void *>(prepare_cudss_rhs_coop_kernel),
            prep_blocks, kThreads, prep_args, kThreads * sizeof(double), input.stream);
        if (solver_launch == cudaSuccess) {
            auto *direct_solver = static_cast<CudssDirectSolver *>(cache.cudss_solver);
            std::string solve_error;
            const uint32_t solve_status = solve_charge_cudss_direct(
                direct_solver, input.stream, fine_tmp, candidate.potential, solve_error);
            if (solve_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
                std::fprintf(stderr, "charge cuDSS solve failed: %s\n", solve_error.c_str());
                cleanup(); release(candidate);
                if (!cache_hit) release(cache);
                return solve_status;
            }
            // Device-resident iterative refinement (1 step anchored, 2 steps zero-mean)
            // using the already-factored cuDSS handle and conservative flux-difference
            // residuals (zero extra host transfers or host synchronizations).
            CoarseLevel fine_lvl = cache.levels[0];
            const uint32_t ir_steps =
                input.gauge_policy ==
                        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT
                    ? 2u
                    : 1u;
            for (uint32_t step = 0; step < ir_steps && solver_launch == cudaSuccess; ++step) {
                double *corr_ptr = step == 0u ? nullptr : z;
                void *ir_args[] = {
                    &fine_lvl, &cache.active, &fine_tmp, &gauge_arg,
                    &cache.component_labels, &cache.free_component_ids,
                    &cache.free_component_sizes, &cache.device_free_component_count,
                    &corr_ptr, &candidate.potential, &r, &partials, &pcg_state};
                solver_launch = cudaLaunchCooperativeKernel(
                    reinterpret_cast<void *>(cudss_ir_residual_coop_kernel),
                    ir_blocks, kThreads, ir_args, kThreads * sizeof(double), input.stream);
                if (solver_launch != cudaSuccess) break;
                const uint32_t ir_status = solve_charge_cudss_direct(
                    direct_solver, input.stream, r, z, solve_error);
                if (ir_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
                    std::fprintf(stderr, "charge cuDSS IR solve failed: %s\n", solve_error.c_str());
                    cleanup(); release(candidate);
                    if (!cache_hit) release(cache);
                    return ir_status;
                }
            }
            if (solver_launch == cudaSuccess) {
                double tol_arg = input.relative_tolerance;
                const auto *hinfo =
                    reinterpret_cast<const DeviceHierarchyInfo *>(cache.hierarchy_info);
                double *final_corr = z;
                void *fin_args[] = {
                    &fine_lvl, &cache.active, &fine_tmp, &tol_arg, &gauge_arg,
                    &cache.component_labels, &cache.free_component_ids,
                    &cache.free_component_sizes, &cache.device_free_component_count,
                    &final_corr, &candidate.potential, &r, &partials, &pcg_state,
                    &hinfo, &device_metrics};
                solver_launch = cudaLaunchCooperativeKernel(
                    reinterpret_cast<void *>(finalize_cudss_solution_coop_kernel),
                    fin_blocks, kThreads, fin_args, kThreads * sizeof(double), input.stream);
            }
        }
    } else {
        // Multi-block cooperative-groups PCG + multi-level geometric AMG W-cycle.
        DeviceAmgHierarchy amg{};
        amg.level_count = cache.level_count;
        amg.split_level = cache.level_count;
        for (uint32_t l = 0; l < cache.level_count; ++l) {
            amg.levels[l] = cache.levels[l];
            if (amg.split_level == cache.level_count &&
                amg.levels[l].cells <= kBlock0CellThreshold) {
                amg.split_level = l;
            }
        }
        DeviceAmgVectors amg_vecs{};
        double *cursor = coarse_pool;
        for (uint32_t l = 1; l < cache.level_count; ++l) {
            amg_vecs.rhs[l] = cursor;
            cursor += cache.levels[l].cells;
            amg_vecs.u[l] = cursor;
            cursor += cache.levels[l].cells;
        }
        const uint32_t pcg_blocks = resolve_coop_blocks(
            reinterpret_cast<const void *>(charge_pcg_device_amg_kernel),
            cells, prop.multiProcessorCount, true);
        if (pcg_blocks == 0u) {
            cleanup(); release(candidate);
            if (!cache_hit) release(cache);
            return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
        }
        double tol_arg = 0.1 * input.relative_tolerance;
        uint64_t max_iter_arg = input.max_iterations;
        uint32_t warm_flag = warm_start_used ? 1u : 0u;
        uint32_t gauge_arg = input.gauge_policy;
        const auto *hinfo = reinterpret_cast<const DeviceHierarchyInfo *>(cache.hierarchy_info);
        void *pcg_args[] = {
            &cache.active, &amg, &amg_vecs, &cache.rhs, &tol_arg, &max_iter_arg,
            &cache.warm_potential, &warm_flag, &gauge_arg,
            &cache.component_labels, &cache.free_component_ids,
            &cache.free_component_sizes, &cache.device_free_component_count,
            &candidate.potential, &r, &z, &p, &ap, &fine_tmp,
            &partials, &pcg_state, &hinfo, &device_metrics};
        solver_launch = cudaLaunchCooperativeKernel(
            reinterpret_cast<void *>(charge_pcg_device_amg_kernel),
            pcg_blocks, kThreads, pcg_args, kThreads * sizeof(double), input.stream);
    }

    const uint64_t max_faces = std::max({jx_count, jy_count, jz_count});
    const uint32_t face_blocks = static_cast<uint32_t>(
        std::min<uint64_t>((max_faces + threads - 1) / threads, 65535));
    if (solver_launch == cudaSuccess) {
        reconstruct_charge_flux_kernel<<<face_blocks, threads, 0, input.stream>>>(
            nx, ny, nz, input.cell_size[0], input.cell_size[1], input.cell_size[2],
            candidate.active, candidate.conductivity, candidate.potential, input.payloads[3], face_view.element_count,
            face_view.byte_stride, input.payloads[2], input.views[2].element_count,
            input.views[2].byte_stride, candidate.jx, candidate.jy, candidate.jz);
        if (candidate.interface_count != 0) {
            const uint32_t interface_blocks = static_cast<uint32_t>(std::min<uint64_t>(
                (candidate.interface_count + threads - 1) / threads, 65535));
            materialize_interface_traces_kernel<<<interface_blocks, threads, 0, input.stream>>>(
                static_cast<const fullmag_fdm_gpu_transport_spin_interface_v1 *>(input.payloads[2]),
                candidate.interface_count, input.views[2].byte_stride, input.cell_size[0],
                input.cell_size[1], input.cell_size[2],
                candidate.conductivity, candidate.potential, candidate.jx, candidate.jy,
                candidate.jz, candidate.interface_from_trace_v, candidate.interface_to_trace_v,
                candidate.interface_delta_trace_v,
                candidate.interface_charge_current_density);
        }
        validate_candidate_finite_kernel<<<face_blocks, threads, 0, input.stream>>>(
            candidate, device_metrics);
        const uint32_t bal_blocks = resolve_coop_blocks(
            reinterpret_cast<const void *>(charge_balance_coop_kernel),
            cells, prop.multiProcessorCount, true);
        if (bal_blocks == 0u) {
            solver_launch = cudaErrorInvalidConfiguration;
        } else {
            uint64_t nx_arg = nx, ny_arg = ny, nz_arg = nz;
            double hx_arg = input.cell_size[0], hy_arg = input.cell_size[1], hz_arg = input.cell_size[2];
            void *bal_args[] = {
                &nx_arg, &ny_arg, &nz_arg, &hx_arg, &hy_arg, &hz_arg,
                &candidate.active, &cache.component_labels, &cache.device_component_count,
                &candidate.jx, &candidate.jy, &candidate.jz,
                &z, &p, &partials, &pcg_state, &device_metrics};
            solver_launch = cudaLaunchCooperativeKernel(
                reinterpret_cast<void *>(charge_balance_coop_kernel),
                bal_blocks, kThreads, bal_args, kThreads * sizeof(double), input.stream);
        }
    }

    DeviceSolveMetrics metrics{};
    const cudaError_t launch_status =
        solver_launch != cudaSuccess ? solver_launch : cudaGetLastError();
    if (launch_status == cudaSuccess && inject_cuda_failure(
            input.failure_policy, 13)) {
        cleanup(); release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t copy_status = launch_status == cudaSuccess
        ? cudaMemcpyAsync(&metrics, device_metrics, sizeof(metrics), cudaMemcpyDeviceToHost, input.stream)
        : launch_status;
    if (copy_status == cudaSuccess && inject_cuda_failure(
            input.failure_policy, 14)) {
        cleanup(); release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t sync_status = copy_status == cudaSuccess
        ? cudaStreamSynchronize(input.stream) : copy_status;
    cleanup();
    if (launch_status != cudaSuccess || copy_status != cudaSuccess || sync_status != cudaSuccess) {
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    output->iterations = metrics.iterations;
    output->amg_apply_count = metrics.amg_apply_count;
    output->reason = metrics.reason;
    output->hierarchy_levels = metrics.hierarchy_levels;
    output->hierarchy_build_count = cache_hit ? 0 : 1;
    output->cache_hit_count = cache_hit ? 1 : 0;
    output->fine_unknown_count = metrics.fine_unknown_count;
    output->coarse_unknown_count = metrics.coarse_unknown_count;
    std::memcpy(output->hierarchy_digest, metrics.hierarchy_digest,
                sizeof(output->hierarchy_digest));
    output->algebraic_residual = metrics.algebraic_residual;
    output->physical_residual = metrics.physical_residual;
    output->component_balance = metrics.component_balance;
    output->electrode_balance = metrics.electrode_balance;
    output->transfer_count = 2;
    output->transfer_bytes = sizeof(DeviceSolveMetrics) + sizeof(gauge_invalid);
    output->peak_bytes = total_peak_bytes;
    output->warm_start_used = warm_start_used;
    if (metrics.reason != FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED) {
        std::fprintf(stderr,
                     "charge device solver failed: mode=%s reason=%u iterations=%llu residual=%.17g amg_applies=%llu levels=%u rho=%.17g denominator=%.17g\n",
                     use_cudss ? "cudss" : "pcg_amg",
                     metrics.reason, static_cast<unsigned long long>(metrics.iterations),
                     metrics.algebraic_residual,
                     static_cast<unsigned long long>(metrics.amg_apply_count),
                     metrics.hierarchy_levels, metrics.debug_rho, metrics.debug_denominator);
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_NONCONVERGED;
    }
    const bool finite_metrics = std::isfinite(metrics.algebraic_residual) &&
        std::isfinite(metrics.physical_residual) && std::isfinite(metrics.component_balance) &&
        std::isfinite(metrics.electrode_balance) && std::isfinite(metrics.debug_rho) &&
        std::isfinite(metrics.debug_denominator);
    if (metrics.candidate_nonfinite != 0 || !finite_metrics ||
        metrics.physical_residual > 1.0e-10 || metrics.component_balance > 1.0e-10 ||
        metrics.electrode_balance > 1.0e-10) {
        std::fprintf(stderr,
                     "charge balance failed: candidate_nonfinite=%u physical=%.17g component=%.17g electrode=%.17g iterations=%llu\n",
                     metrics.candidate_nonfinite,
                     metrics.physical_residual, metrics.component_balance,
                     metrics.electrode_balance,
                     static_cast<unsigned long long>(metrics.iterations));
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_BALANCE_FAILURE;
    }
    cache.valid = true;
    cache.coarse_cells = metrics.coarse_unknown_count;
    output->buffers = candidate;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t content_digest_device(
    const Buffers &buffers, const void *charge_faces, uint64_t charge_face_count,
    uint64_t charge_face_stride, const void *interfaces, uint64_t interface_stride,
    const ContentDigestIdentity &identity, cudaStream_t stream,
    uint8_t digest[32], CudaFailurePolicy *failure_policy,
    uint32_t copy_boundary, uint32_t sync_boundary) noexcept {
    if (digest == nullptr || stream == nullptr || buffers.active == nullptr ||
        buffers.conductivity == nullptr || buffers.potential == nullptr ||
        buffers.jx == nullptr || buffers.jy == nullptr || buffers.jz == nullptr ||
        (buffers.interface_count != 0 &&
         (buffers.interface_from_trace_v == nullptr ||
          buffers.interface_to_trace_v == nullptr ||
          buffers.interface_delta_trace_v == nullptr ||
          buffers.interface_charge_current_density == nullptr)) ||
        (charge_face_count != 0 && (charge_faces == nullptr || charge_face_stride == 0)) ||
        (buffers.interface_count != 0 && (interfaces == nullptr || interface_stride == 0)))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE;
    uint8_t *device_digest = nullptr;
    if (cudaMalloc(reinterpret_cast<void **>(&device_digest), 32) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    content_digest_kernel<<<1, 1, 0, stream>>>(
        buffers, charge_faces, charge_face_count, charge_face_stride,
        interfaces, interface_stride, identity, device_digest);
    const cudaError_t launch_status = cudaGetLastError();
    if (launch_status == cudaSuccess && inject_cuda_failure(
            failure_policy, copy_boundary)) {
        cudaFree(device_digest);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t copy_status = launch_status == cudaSuccess
        ? cudaMemcpyAsync(digest, device_digest, 32, cudaMemcpyDeviceToHost, stream)
        : launch_status;
    if (copy_status == cudaSuccess && inject_cuda_failure(
            failure_policy, sync_boundary)) {
        cudaFree(device_digest);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    const cudaError_t sync_status = copy_status == cudaSuccess
        ? cudaStreamSynchronize(stream) : copy_status;
    cudaFree(device_digest);
    return launch_status == cudaSuccess && copy_status == cudaSuccess &&
                   sync_status == cudaSuccess
        ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
        : FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
}

} // namespace fullmag::fdm::gpu::transport::charge
