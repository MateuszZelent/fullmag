#include "device_solver.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace fullmag::fdm::gpu::transport::charge {
namespace {

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
    uint8_t digest[32];
};

__device__ void load_charge_face(
    const void *, uint64_t, uint64_t, uint32_t *, uint32_t *, int32_t *,
    uint64_t *, double *, double *);
__device__ uint64_t load_charge_source_id(const void *, uint64_t, uint64_t);

struct DeviceSha256 {
    uint32_t state[8];
    uint8_t block[64];
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
    for (uint32_t i = 0; i < 16; ++i)
        w[i] = (uint32_t(sha->block[4*i]) << 24) | (uint32_t(sha->block[4*i+1]) << 16) |
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

__device__ void sha_init(DeviceSha256 *sha) {
    const uint32_t initial[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                               0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    for(uint32_t i=0;i<8;++i) sha->state[i]=initial[i];
    sha->bytes=0;sha->used=0;
}

__device__ void sha_update(DeviceSha256 *sha, const void *source, uint64_t length) {
    const auto *bytes=static_cast<const uint8_t *>(source);
    sha->bytes += length;
    for(uint64_t i=0;i<length;++i) {
        sha->block[sha->used++]=bytes[i];
        if(sha->used==64){sha_transform(sha);sha->used=0;}
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
            const uint64_t boundary_ordinal = axis == 0
                ? side_offset * ny * nz + y + ny * z
                : axis == 1
                    ? x_faces + side_offset * nx * nz + x + nx * z
                    : x_faces + y_faces + side_offset * nx * ny + x + nx * y;
            bad = boundary_ordinal >= face_count ||
                  atomicCAS(seen_faces + boundary_ordinal, 0u, 1u) != 0u;
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

__device__ double apply_row(uint64_t i, const double *v, const double *diag,
                            const double *gx, const double *gy, const double *gz,
                            uint64_t nx, uint64_t ny, uint64_t nz) {
    const uint64_t x = i % nx;
    const uint64_t yz = i / nx;
    const uint64_t y = yz % ny;
    const uint64_t z = yz / ny;
    double value = diag[i] * v[i];
    if (x > 0) value -= gx[i - 1] * v[i - 1];
    if (x + 1 < nx) value -= gx[i] * v[i + 1];
    if (y > 0) value -= gy[i - nx] * v[i - nx];
    if (y + 1 < ny) value -= gy[i] * v[i + nx];
    if (z > 0) value -= gz[i - nx * ny] * v[i - nx * ny];
    if (z + 1 < nz) value -= gz[i] * v[i + nx * ny];
    return value;
}

__device__ double fixed_tree_sum(double value, double *tree) {
    tree[threadIdx.x] = value;
    __syncthreads();
    for (uint32_t width = blockDim.x / 2; width != 0; width >>= 1) {
        if (threadIdx.x < width) tree[threadIdx.x] += tree[threadIdx.x + width];
        __syncthreads();
    }
    return tree[0];
}

__device__ double fixed_tree_dot(const double *a, const double *b, uint64_t count,
                                 double *tree) {
    double local = 0.0;
    for (uint64_t i = threadIdx.x; i < count; i += blockDim.x) local += a[i] * b[i];
    return fixed_tree_sum(local, tree);
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

__global__ void build_geometric_rap_kernel(
    const uint8_t *active, const double *diag, const double *gx, const double *gy,
    const double *gz, uint64_t nx, uint64_t ny, uint64_t nz,
    uint64_t *aggregate, double *coarse_diag, uint64_t *coarse_edge_a,
    uint64_t *coarse_edge_b, double *coarse_edge_weight,
    DeviceHierarchyInfo *info) {
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

__global__ void finalize_geometric_rap_kernel(
    const uint64_t *aggregate, uint64_t cells, const uint64_t *coarse_edge_a,
    const uint64_t *coarse_edge_b, const double *coarse_edge_weight,
    uint64_t coarse_nx, uint64_t coarse_ny, uint64_t coarse_nz,
    DeviceHierarchyInfo *info) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    const uint64_t coarse_cells = coarse_nx * coarse_ny * coarse_nz;
    const uint64_t edge_count =
        (coarse_nx > 1 ? (coarse_nx - 1) * coarse_ny * coarse_nz : 0) +
        (coarse_ny > 1 ? coarse_nx * (coarse_ny - 1) * coarse_nz : 0) +
        (coarse_nz > 1 ? coarse_nx * coarse_ny * (coarse_nz - 1) : 0);
    uint64_t state[4] = {
        UINT64_C(0xcbf29ce484222325), UINT64_C(0x9e3779b97f4a7c15),
        UINT64_C(0x6a09e667f3bcc909), UINT64_C(0xbb67ae8584caa73b)};
    for (uint64_t i = 0; i < cells; ++i) {
        for (uint32_t lane = 0; lane < 4; ++lane) {
            state[lane] ^= aggregate[i] + UINT64_C(0x100000001b3) * (lane + 1);
            state[lane] *= UINT64_C(0x100000001b3);
        }
    }
    for (uint64_t edge = 0; edge < edge_count; ++edge) {
        const uint64_t weight_bits = __double_as_longlong(coarse_edge_weight[edge]);
        for (uint32_t lane = 0; lane < 4; ++lane) {
            state[lane] ^= coarse_edge_a[edge] + (coarse_edge_b[edge] << 1) + weight_bits;
            state[lane] *= UINT64_C(0x100000001b3);
        }
    }
    info->coarse_cells = coarse_cells;
    info->edge_count = edge_count;
    info->coarse_nx = coarse_nx;
    info->coarse_ny = coarse_ny;
    info->coarse_nz = coarse_nz;
    for (uint32_t lane = 0; lane < 4; ++lane)
        for (uint32_t byte = 0; byte < 8; ++byte)
            info->digest[8 * lane + byte] = static_cast<uint8_t>(state[lane] >> (8 * byte));
}

__device__ double apply_coarse_row(
    uint64_t i, const double *v, const double *diag, const uint64_t *edge_a,
    const uint64_t *edge_b, const double *edge_weight, uint64_t edge_count,
    uint64_t coarse_nx, uint64_t coarse_ny, uint64_t coarse_nz) {
    (void)edge_a; (void)edge_b; (void)edge_count;
    const uint64_t x = i % coarse_nx;
    const uint64_t yz = i / coarse_nx;
    const uint64_t y = yz % coarse_ny;
    const uint64_t z = yz / coarse_ny;
    const uint64_t x_edges = coarse_nx > 1 ? (coarse_nx - 1) * coarse_ny * coarse_nz : 0;
    const uint64_t y_edges = coarse_ny > 1 ? coarse_nx * (coarse_ny - 1) * coarse_nz : 0;
    double value = diag[i] * v[i];
    if (x > 0) value -= edge_weight[(x - 1) + (coarse_nx - 1) * (y + coarse_ny * z)] * v[i - 1];
    if (x + 1 < coarse_nx) value -= edge_weight[x + (coarse_nx - 1) * (y + coarse_ny * z)] * v[i + 1];
    if (y > 0) value -= edge_weight[x_edges + x + coarse_nx * ((y - 1) + (coarse_ny - 1) * z)] * v[i - coarse_nx];
    if (y + 1 < coarse_ny) value -= edge_weight[x_edges + x + coarse_nx * (y + (coarse_ny - 1) * z)] * v[i + coarse_nx];
    if (z > 0) value -= edge_weight[x_edges + y_edges + x + coarse_nx * (y + coarse_ny * (z - 1))] * v[i - coarse_nx * coarse_ny];
    if (z + 1 < coarse_nz) value -= edge_weight[x_edges + y_edges + x + coarse_nx * (y + coarse_ny * z)] * v[i + coarse_nx * coarse_ny];
    return value;
}

__device__ void device_galerkin_amg_vcycle(
    const double *residual, double *correction, double *fine_tmp,
    double *coarse_rhs, double *coarse_x, double *coarse_tmp,
    const double *diag, const double *gx, const double *gy, const double *gz,
    const uint64_t *aggregate, const double *coarse_diag,
    const uint64_t *coarse_edge_a, const uint64_t *coarse_edge_b,
    const double *coarse_edge_weight, uint64_t coarse_cells, uint64_t edge_count,
    uint64_t nx, uint64_t ny, uint64_t nz) {
    const uint64_t cells = nx * ny * nz;
    for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x) correction[i] = 0.0;
    __syncthreads();
    constexpr double omega = 2.0 / 3.0;
    for (uint32_t sweep = 0; sweep < 2; ++sweep) {
        for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x)
            fine_tmp[i] = correction[i] + omega *
                (residual[i] - apply_row(i, correction, diag, gx, gy, gz, nx, ny, nz)) / diag[i];
        __syncthreads();
        for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x) correction[i] = fine_tmp[i];
        __syncthreads();
    }
    for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x)
        fine_tmp[i] = residual[i] - apply_row(i, correction, diag, gx, gy, gz, nx, ny, nz);
    __syncthreads();
    const uint64_t coarse_nx = (nx + 1) / 2;
    const uint64_t coarse_ny = (ny + 1) / 2;
    const uint64_t coarse_nz = (nz + 1) / 2;
    for (uint64_t coarse = threadIdx.x; coarse < coarse_cells; coarse += blockDim.x) {
        const uint64_t cx = coarse % coarse_nx;
        const uint64_t cyz = coarse / coarse_nx;
        const uint64_t cy = cyz % coarse_ny;
        const uint64_t cz = cyz / coarse_ny;
        double sum = 0.0;
        for (uint64_t dz = 0; dz < 2; ++dz) {
            const uint64_t z = 2 * cz + dz;
            if (z >= nz) continue;
            for (uint64_t dy = 0; dy < 2; ++dy) {
                const uint64_t y = 2 * cy + dy;
                if (y >= ny) continue;
                for (uint64_t dx = 0; dx < 2; ++dx) {
                    const uint64_t x = 2 * cx + dx;
                    if (x < nx) sum += fine_tmp[x + nx * (y + ny * z)];
                }
            }
        }
        coarse_rhs[coarse] = sum;
        coarse_x[coarse] = 0.0;
    }
    __syncthreads();
    /* R=P^T and the cached coarse operator is the deterministic A_c=R A P. */
    for (uint32_t sweep = 0; sweep < 32; ++sweep) {
        for (uint64_t coarse = threadIdx.x; coarse < coarse_cells; coarse += blockDim.x) {
            const double row_value = apply_coarse_row(
                coarse, coarse_x, coarse_diag, coarse_edge_a, coarse_edge_b,
                coarse_edge_weight, edge_count, coarse_nx, coarse_ny, coarse_nz);
            coarse_tmp[coarse] = coarse_diag[coarse] > 0.0 && isfinite(coarse_diag[coarse])
                ? coarse_x[coarse] + omega *
                    (coarse_rhs[coarse] - row_value) / coarse_diag[coarse]
                : 0.0;
        }
        __syncthreads();
        for (uint64_t coarse = threadIdx.x; coarse < coarse_cells; coarse += blockDim.x)
            coarse_x[coarse] = coarse_tmp[coarse];
        __syncthreads();
    }
    for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x)
        correction[i] += coarse_x[aggregate[i]];
    __syncthreads();
    for (uint32_t sweep = 0; sweep < 2; ++sweep) {
        for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x)
            fine_tmp[i] = correction[i] + omega *
                (residual[i] - apply_row(i, correction, diag, gx, gy, gz, nx, ny, nz)) / diag[i];
        __syncthreads();
        for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x) correction[i] = fine_tmp[i];
        __syncthreads();
    }
}

__global__ void charge_pcg_device_amg_kernel(
    const double *diag, const double *rhs, const double *gx, const double *gy,
    const double *gz, uint64_t nx, uint64_t ny, uint64_t nz, double tolerance,
    uint64_t max_iterations, double *potential, double *r, double *z, double *p,
    double *ap, double *fine_tmp, double *coarse_rhs, double *coarse_x,
    double *coarse_tmp, const uint64_t *aggregate, const double *coarse_diag,
    const uint64_t *coarse_edge_a, const uint64_t *coarse_edge_b,
    const double *coarse_edge_weight, const DeviceHierarchyInfo *hierarchy,
    DeviceSolveMetrics *metrics) {
    __shared__ double tree[256];
    __shared__ double norm_b;
    __shared__ double rho;
    __shared__ double residual_norm;
    __shared__ double alpha;
    __shared__ double beta;
    __shared__ uint64_t completed;
    __shared__ uint32_t reason;
    const uint64_t cells = nx * ny * nz;
    for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x) {
        potential[i] = 0.0;
        r[i] = rhs[i];
    }
    __syncthreads();
    const double rhs_norm_squared = fixed_tree_dot(rhs, rhs, cells, tree);
    if (threadIdx.x == 0) {
        norm_b = sqrt(rhs_norm_squared);
        residual_norm = norm_b == 0.0 ? 0.0 : 1.0;
        completed = 0;
        reason = norm_b == 0.0 ? FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED
                               : FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS;
    }
    __syncthreads();
    if (norm_b != 0.0) {
        device_galerkin_amg_vcycle(r, z, fine_tmp, coarse_rhs, coarse_x, coarse_tmp,
                                   diag, gx, gy, gz, aggregate, coarse_diag,
                                   coarse_edge_a, coarse_edge_b, coarse_edge_weight,
                                   hierarchy->coarse_cells, hierarchy->edge_count, nx, ny, nz);
        const double initial_rho = fixed_tree_dot(r, z, cells, tree);
        if (threadIdx.x == 0) rho = initial_rho;
        for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x) p[i] = z[i];
        __syncthreads();
        for (uint64_t iteration = 0; iteration < max_iterations; ++iteration) {
            for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x)
                ap[i] = apply_row(i, p, diag, gx, gy, gz, nx, ny, nz);
            __syncthreads();
            const double denominator = fixed_tree_dot(p, ap, cells, tree);
            if (threadIdx.x == 0) {
                alpha = rho / denominator;
                metrics->debug_rho = rho;
                metrics->debug_denominator = denominator;
                if (!isfinite(alpha) || denominator <= 0.0)
                    reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE;
            }
            __syncthreads();
            if (reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_ALGEBRAIC_FAILURE) break;
            for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x) {
                potential[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
            }
            __syncthreads();
            const double residual_squared = fixed_tree_dot(r, r, cells, tree);
            if (threadIdx.x == 0) {
                completed = iteration + 1;
                residual_norm = sqrt(residual_squared) / norm_b;
                if (!isfinite(residual_norm))
                    reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_NON_FINITE;
                else if (residual_norm <= tolerance)
                    reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
            }
            __syncthreads();
            if (reason != FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS) break;
            device_galerkin_amg_vcycle(r, z, fine_tmp, coarse_rhs, coarse_x, coarse_tmp,
                                       diag, gx, gy, gz, aggregate, coarse_diag,
                                       coarse_edge_a, coarse_edge_b, coarse_edge_weight,
                                       hierarchy->coarse_cells, hierarchy->edge_count, nx, ny, nz);
            const double next_rho = fixed_tree_dot(r, z, cells, tree);
            if (threadIdx.x == 0) {
                beta = next_rho / rho;
                rho = next_rho;
            }
            __syncthreads();
            for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x)
                p[i] = z[i] + beta * p[i];
            __syncthreads();
        }
    }
    if (threadIdx.x == 0) {
        metrics->iterations = completed;
        metrics->amg_apply_count = norm_b == 0.0 ? 0 : completed +
            (reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_MAX_ITERATIONS ? 1 : 0);
        metrics->reason = reason;
        metrics->hierarchy_levels = hierarchy->coarse_cells < cells ? 2 : 1;
        metrics->fine_unknown_count = cells;
        metrics->coarse_unknown_count = hierarchy->coarse_cells;
        for (uint32_t byte = 0; byte < 32; ++byte)
            metrics->hierarchy_digest[byte] = hierarchy->digest[byte];
        metrics->algebraic_residual = residual_norm;
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

__global__ void label_reference_components_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, const uint8_t *active,
    const void *face_payload, uint64_t face_count, uint64_t face_stride,
    const double *gx, const double *gy, const double *gz,
    uint64_t *labels, uint32_t *invalid) {
    if (blockIdx.x != 0 || threadIdx.x != 0) return;
    const uint64_t cells = nx * ny * nz;
    const uint64_t plane = nx * ny;
    for (uint64_t i = 0; i < cells; ++i) labels[i] = UINT64_MAX;
    uint64_t component = 0;
    for (uint64_t seed = 0; seed < cells; ++seed) {
        if (!active[seed] || labels[seed] != UINT64_MAX) continue;
        labels[seed] = component;
        bool changed = true;
        while (changed) {
            changed = false;
            for (uint64_t i = 0; i < cells; ++i) {
                if (!active[i] || labels[i] != UINT64_MAX) continue;
                const uint64_t x = i % nx;
                const uint64_t yz = i / nx;
                const uint64_t y = yz % ny;
                const uint64_t z = yz / ny;
                const bool linked =
                    (x > 0 && gx[i - 1] > 0.0 && labels[i - 1] == component) ||
                    (x + 1 < nx && gx[i] > 0.0 && labels[i + 1] == component) ||
                    (y > 0 && gy[i - nx] > 0.0 && labels[i - nx] == component) ||
                    (y + 1 < ny && gy[i] > 0.0 && labels[i + nx] == component) ||
                    (z > 0 && gz[i - plane] > 0.0 && labels[i - plane] == component) ||
                    (z + 1 < nz && gz[i] > 0.0 && labels[i + plane] == component);
                if (linked) { labels[i] = component; changed = true; }
            }
        }
        bool anchored = false;
        for (uint64_t f = 0; f < face_count; ++f) {
            uint32_t kind = 0, axis = 0; int32_t side = 0; uint64_t cell = 0;
            double area = 0.0, value = 0.0;
            load_charge_face(face_payload, face_stride, f, &kind, &axis, &side,
                             &cell, &area, &value);
            if (kind == FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE &&
                cell < cells && labels[cell] == component) anchored = true;
        }
        if (!anchored) *invalid = 1;
        ++component;
    }
}

__device__ double integrated_cell_flux(
    uint64_t i, uint64_t nx, uint64_t ny, uint64_t nz,
    double ax, double ay, double az, const double *jx, const double *jy,
    const double *jz, double *scale) {
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

__global__ void charge_balance_kernel(
    uint64_t nx, uint64_t ny, uint64_t nz, double hx, double hy, double hz,
    const uint8_t *active, const uint64_t *labels, const double *jx,
    const double *jy, const double *jz, DeviceSolveMetrics *metrics) {
    __shared__ double residual_tree[256];
    __shared__ double scale_tree[256];
    __shared__ double transverse_tree[256];
    double local_residual_squared = 0.0;
    double local_scale_squared = 0.0;
    double local_transverse = 0.0;
    const double ax = hy * hz, ay = hx * hz, az = hx * hy;
    const uint64_t cells = nx * ny * nz;
    for (uint64_t i = threadIdx.x; i < cells; i += blockDim.x) {
        if (!active[i]) continue;
        const uint64_t x = i % nx;
        const uint64_t yz = i / nx;
        const uint64_t y = yz % ny, z = yz / ny;
        const uint64_t fy0 = x + nx * (y + (ny + 1) * z);
        const uint64_t fz0 = x + nx * (y + ny * z);
        double scale = 0.0;
        const double net = integrated_cell_flux(
            i, nx, ny, nz, ax, ay, az, jx, jy, jz, &scale);
        local_residual_squared += net * net;
        local_scale_squared += scale * scale;
        local_transverse = fmax(local_transverse, fmax(fabs(jy[fy0]), fabs(jy[fy0 + nx])));
        local_transverse = fmax(local_transverse, fmax(fabs(jz[fz0]), fabs(jz[fz0 + nx * ny])));
    }
    residual_tree[threadIdx.x] = local_residual_squared;
    scale_tree[threadIdx.x] = local_scale_squared;
    transverse_tree[threadIdx.x] = local_transverse;
    __syncthreads();
    for (uint32_t width = blockDim.x / 2; width != 0; width >>= 1) {
        if (threadIdx.x < width) {
            residual_tree[threadIdx.x] += residual_tree[threadIdx.x + width];
            scale_tree[threadIdx.x] += scale_tree[threadIdx.x + width];
            transverse_tree[threadIdx.x] = fmax(transverse_tree[threadIdx.x],
                                                transverse_tree[threadIdx.x + width]);
        }
        __syncthreads();
    }
    if (threadIdx.x == 0) {
        metrics->physical_residual = scale_tree[0] == 0.0
            ? (residual_tree[0] == 0.0 ? 0.0 : INFINITY)
            : sqrt(residual_tree[0] / scale_tree[0]);
        uint64_t component_count = 0;
        for (uint64_t i = 0; i < cells; ++i)
            if (active[i] && labels[i] != UINT64_MAX)
                component_count = component_count > labels[i] + 1
                    ? component_count : labels[i] + 1;
        double component_max = 0.0;
        for (uint64_t component = 0; component < component_count; ++component) {
            double net_sum = 0.0, component_scale = 0.0;
            for (uint64_t i = 0; i < cells; ++i) {
                if (!active[i] || labels[i] != component) continue;
                double scale = 0.0;
                net_sum += integrated_cell_flux(
                    i, nx, ny, nz, ax, ay, az, jx, jy, jz, &scale);
                component_scale += scale;
            }
            const double ratio = component_scale == 0.0
                ? (net_sum == 0.0 ? 0.0 : INFINITY)
                : fabs(net_sum) / component_scale;
            component_max = fmax(component_max, ratio);
        }
        metrics->component_balance = component_max;
        double electrode = 0.0, electrode_scale = 0.0;
        for (uint64_t z = 0; z < nz; ++z) for (uint64_t y = 0; y < ny; ++y) {
            const uint64_t left = (nx + 1) * (y + ny * z);
            const uint64_t right = nx + (nx + 1) * (y + ny * z);
            electrode += (-jx[left] + jx[right]) * ax;
            electrode_scale += (fabs(jx[left]) + fabs(jx[right])) * ax;
        }
        for (uint64_t z = 0; z < nz; ++z) for (uint64_t x = 0; x < nx; ++x) {
            const uint64_t lower = x + nx * ((ny + 1) * z);
            const uint64_t upper = x + nx * (ny + (ny + 1) * z);
            electrode += (-jy[lower] + jy[upper]) * ay;
            electrode_scale += (fabs(jy[lower]) + fabs(jy[upper])) * ay;
        }
        for (uint64_t y = 0; y < ny; ++y) for (uint64_t x = 0; x < nx; ++x) {
            const uint64_t back = x + nx * y;
            const uint64_t front = x + nx * (y + ny * nz);
            electrode += (-jz[back] + jz[front]) * az;
            electrode_scale += (fabs(jz[back]) + fabs(jz[front])) * az;
        }
        metrics->electrode_balance = electrode_scale == 0.0 ? 0.0 : fabs(electrode) / electrode_scale;
        metrics->debug_transverse_max = transverse_tree[0];
    }
}
} // namespace

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
    constexpr uint32_t threads = 256;
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
    constexpr uint32_t threads = 256;
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
    double *r = nullptr, *z = nullptr, *p = nullptr, *ap = nullptr;
    double *fine_tmp = nullptr, *coarse_rhs = nullptr, *coarse_x = nullptr, *coarse_tmp = nullptr;
    uint64_t *component_labels = nullptr;
    uint32_t *device_gauge_invalid = nullptr;
    DeviceSolveMetrics *device_metrics = nullptr;
    auto cleanup = [&]() {
        if (r) (void)cudaFree(r);
        if (z) (void)cudaFree(z);
        if (p) (void)cudaFree(p);
        if (ap) (void)cudaFree(ap);
        if (fine_tmp) (void)cudaFree(fine_tmp);
        if (coarse_rhs) (void)cudaFree(coarse_rhs);
        if (coarse_x) (void)cudaFree(coarse_x);
        if (coarse_tmp) (void)cudaFree(coarse_tmp);
        if (component_labels) (void)cudaFree(component_labels);
        if (device_gauge_invalid) (void)cudaFree(device_gauge_invalid);
        if (device_metrics) (void)cudaFree(device_metrics);
    };
    auto alloc = [](void **pointer, uint64_t bytes) {
        return cudaMalloc(pointer, static_cast<size_t>(bytes)) == cudaSuccess;
    };
    const uint64_t fine_bytes = cells * sizeof(double);
    const uint64_t max_coarse_edges = 3 * cells;
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
    uint64_t workspace_bytes = 0, cache_bytes = 0, candidate_bytes = 0;
    uint64_t edge_bytes = 0, face_values = 0, face_bytes = 0, interface_bytes = 0,
             total_peak_bytes = 0;
    const bool sizes_valid =
        checked_scaled(fine_bytes, 9, &workspace_bytes) &&
        checked_add(workspace_bytes, sizeof(DeviceSolveMetrics) + sizeof(uint32_t),
                    &workspace_bytes) &&
        checked_scaled(max_coarse_edges, 3 * sizeof(uint64_t), &edge_bytes) &&
        checked_scaled(fine_bytes, 8, &cache_bytes) &&
        checked_add(cache_bytes, cells, &cache_bytes) &&
        checked_add(cache_bytes, edge_bytes, &cache_bytes) &&
        checked_add(cache_bytes, sizeof(DeviceHierarchyInfo), &cache_bytes) &&
        checked_add(jx_count, jy_count, &face_values) &&
        checked_add(face_values, jz_count, &face_values) &&
        checked_scaled(face_values, sizeof(double), &face_bytes) &&
        checked_scaled(candidate.interface_count, 4 * sizeof(double), &interface_bytes) &&
        checked_scaled(fine_bytes, 2, &candidate_bytes) &&
        checked_add(candidate_bytes, cells, &candidate_bytes) &&
        checked_add(candidate_bytes, face_bytes, &candidate_bytes) &&
        checked_add(candidate_bytes, interface_bytes, &candidate_bytes) &&
        checked_add(input.static_owned_bytes, cache_bytes, &total_peak_bytes) &&
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
    bool cache_allocated = true;
    if (!cache_hit) {
        cache.cells = cells;
        cache.coarse_cells = cells;
        cache_allocated =
            alloc(reinterpret_cast<void **>(&cache.active), cells) &&
            alloc(reinterpret_cast<void **>(&cache.conductivity), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.diag), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.rhs), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.gx), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.gy), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.gz), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_diag), fine_bytes) &&
            alloc(reinterpret_cast<void **>(&cache.aggregate), cells * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_edge_a),
                  max_coarse_edges * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_edge_b),
                  max_coarse_edges * sizeof(uint64_t)) &&
            alloc(reinterpret_cast<void **>(&cache.coarse_edge_weight),
                  max_coarse_edges * sizeof(double)) &&
            alloc(&cache.hierarchy_info, sizeof(DeviceHierarchyInfo));
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
        alloc(reinterpret_cast<void **>(&coarse_rhs), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&coarse_x), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&coarse_tmp), fine_bytes) &&
        alloc(reinterpret_cast<void **>(&component_labels), cells * sizeof(uint64_t)) &&
        alloc(reinterpret_cast<void **>(&device_gauge_invalid), sizeof(uint32_t)) &&
        alloc(reinterpret_cast<void **>(&device_metrics), sizeof(DeviceSolveMetrics));
    if (!allocated) {
        cleanup();
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_MEMORY;
    }
    if (cudaMemsetAsync(device_metrics, 0, sizeof(DeviceSolveMetrics), input.stream) != cudaSuccess ||
        cudaMemsetAsync(device_gauge_invalid, 0, sizeof(uint32_t), input.stream) != cudaSuccess) {
        cleanup();
        release(candidate);
        if (!cache_hit) release(cache);
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    }
    constexpr uint32_t threads = 256;
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
        const uint64_t coarse_nx = (nx + 1) / 2;
        const uint64_t coarse_ny = (ny + 1) / 2;
        const uint64_t coarse_nz = (nz + 1) / 2;
        const uint64_t coarse_cells = coarse_nx * coarse_ny * coarse_nz;
        const uint32_t coarse_blocks = static_cast<uint32_t>(std::min<uint64_t>(
            (coarse_cells + threads - 1) / threads, 65535));
        assign_geometric_aggregates_kernel<<<blocks, threads, 0, input.stream>>>(
            nx, ny, nz, coarse_nx, coarse_ny, cache.aggregate);
        build_geometric_rap_kernel<<<coarse_blocks, threads, 0, input.stream>>>(
            cache.active, cache.diag, cache.gx, cache.gy, cache.gz, nx, ny, nz,
            cache.aggregate, cache.coarse_diag, cache.coarse_edge_a, cache.coarse_edge_b,
            cache.coarse_edge_weight,
            reinterpret_cast<DeviceHierarchyInfo *>(cache.hierarchy_info));
        finalize_geometric_rap_kernel<<<1, 1, 0, input.stream>>>(
            cache.aggregate, cells, cache.coarse_edge_a, cache.coarse_edge_b,
            cache.coarse_edge_weight, coarse_nx, coarse_ny, coarse_nz,
            reinterpret_cast<DeviceHierarchyInfo *>(cache.hierarchy_info));
    }
    label_reference_components_kernel<<<1, 1, 0, input.stream>>>(
        nx, ny, nz, cache.active, input.payloads[3], face_view.element_count,
        face_view.byte_stride, cache.gx, cache.gy, cache.gz, component_labels,
        device_gauge_invalid);
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
        return gauge_invalid != 0 ? FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR
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
    charge_pcg_device_amg_kernel<<<1, threads, 0, input.stream>>>(
        cache.diag, cache.rhs, cache.gx, cache.gy, cache.gz, nx, ny, nz,
        0.1 * input.relative_tolerance,
        input.max_iterations, candidate.potential, r, z, p, ap, fine_tmp,
        coarse_rhs, coarse_x, coarse_tmp, cache.aggregate, cache.coarse_diag,
        cache.coarse_edge_a, cache.coarse_edge_b, cache.coarse_edge_weight,
        reinterpret_cast<const DeviceHierarchyInfo *>(cache.hierarchy_info), device_metrics);
    const uint64_t max_faces = std::max({jx_count, jy_count, jz_count});
    const uint32_t face_blocks = static_cast<uint32_t>(
        std::min<uint64_t>((max_faces + threads - 1) / threads, 65535));
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
    charge_balance_kernel<<<1, threads, 0, input.stream>>>(
        nx, ny, nz, input.cell_size[0], input.cell_size[1], input.cell_size[2],
        candidate.active, component_labels, candidate.jx, candidate.jy, candidate.jz,
        device_metrics);
    DeviceSolveMetrics metrics{};
    const cudaError_t launch_status = cudaGetLastError();
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
    if (metrics.reason != FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED) {
        std::fprintf(stderr,
                     "charge device PCG failed: reason=%u iterations=%llu residual=%.17g amg_applies=%llu levels=%u rho=%.17g denominator=%.17g\\n",
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
