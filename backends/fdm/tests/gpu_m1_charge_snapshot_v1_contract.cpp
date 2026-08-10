#include "fullmag_fdm.h"
#include "charge/checkpoint_codec.hpp"

#include <cuda_runtime_api.h>
#include <openssl/sha.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <string>
#include <vector>

namespace {

#ifndef FULLMAG_SOURCE_ROOT
#error "FULLMAG_SOURCE_ROOT must point at the repository root"
#endif

constexpr uint32_t kChargeFaceVoltage = 1;
constexpr uint32_t kChargeFaceExactDensity = 2;
constexpr uint32_t kChargeFaceInsulating = 3;
constexpr uint64_t kCharge = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
constexpr uint64_t kSpin = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN;

struct ChargeFaceV1 {
    uint32_t kind;
    uint32_t axis;
    int32_t side;
    uint32_t reserved;
    uint64_t adjacent_cell;
    double area;
    double value;
};

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

fullmag_fdm_gpu_transport_buffer_view_v1 view(
    const void *data, uint64_t count, uint64_t stride, uint32_t element_type,
    uint32_t component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = stride;
    result.byte_length = count * stride;
    result.element_type = element_type;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    result.component_order = component_order;
    return result;
}

bool close(double actual, double expected, double rtol, double atol = 0.0) {
    return std::abs(actual - expected) <= atol + rtol * std::abs(expected);
}

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string hex(const uint8_t *bytes, size_t count) {
    std::string value;
    value.reserve(2 * count);
    constexpr char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < count; ++i) {
        value.push_back(digits[bytes[i] >> 4]);
        value.push_back(digits[bytes[i] & 0xf]);
    }
    return value;
}

std::vector<uint8_t> frozen_hex(const char *begin_marker, const char *end_marker) {
    std::ifstream input(std::string(FULLMAG_SOURCE_ROOT) +
                        "/docs/specs/spin-transport-runtime-contract-v1.md");
    require(input.good(), "frozen runtime specification must be readable");
    const std::string text((std::istreambuf_iterator<char>(input)), {});
    const size_t begin = text.find(begin_marker);
    const size_t end = text.find(end_marker, begin);
    require(begin != std::string::npos && end != std::string::npos,
            "restore golden markers must exist");
    std::vector<uint8_t> bytes;
    int high = -1;
    for (size_t i = begin + std::strlen(begin_marker); i < end; ++i) {
        const char c = text[i];
        const int digit = c >= '0' && c <= '9' ? c - '0' :
                          c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                          c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (digit < 0) continue;
        if (high < 0) high = digit;
        else { bytes.push_back(static_cast<uint8_t>((high << 4) | digit)); high = -1; }
    }
    require(high < 0, "restore golden hex must contain complete bytes");
    return bytes;
}

} // namespace

int main() {
    constexpr uint64_t nx = 64, ny = 4, nz = 2;
    constexpr uint64_t cells = nx * ny * nz;
    constexpr double h = 1.0e-9;
    constexpr double sigma = 5.0e6;
    constexpr double left_v = 64.0e-3;
    constexpr double right_v = 0.0;

    auto restore_golden = frozen_hex("FMGPUTR1_RESTORE_GOLDEN_HEX_BEGIN",
                                     "FMGPUTR1_RESTORE_GOLDEN_HEX_END");
    require(restore_golden.size() == 4352, "frozen one-cell restore golden size drifted");
    uint8_t restore_sha[32]{};
    SHA256(restore_golden.data(), restore_golden.size(), restore_sha);
    require(hex(restore_sha, 32) ==
                "ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5",
            "frozen one-cell restore golden payload SHA drifted");
    require(hex(restore_golden.data() + 272, 32) ==
                "bc3bcc1b51314fe46e0bbd2f71e94f1517f8e438943853e33b8e79b1495c7b60",
            "frozen one-cell embedded file hash drifted");
    require(restore_golden[72] == 7, "frozen one-cell accepted sequence drifted");
    uint32_t restore_golden_kind = 0;
    require(fullmag_fdm_gpu_transport_checkpoint_validate_v1(
                restore_golden.data(), restore_golden.size(), &restore_golden_kind) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                restore_golden_kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE,
            "frozen one-cell restore golden failed runtime codec integration");

    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess, "an actual CUDA device is required; SKIP is forbidden");
    cudaDeviceProp device_properties{};
    require(cudaGetDeviceProperties(&device_properties, device) == cudaSuccess,
            "actual CUDA device properties are required");

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2 |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1 |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy = FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 128ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 64ULL * 1024ULL * 1024ULL;
    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "FP64 strict CUDA context creation failed");

    std::vector<fullmag_fdm_gpu_transport_spin_cell_v1> mask(cells);
    for (uint64_t i = 0; i < cells; ++i) {
        init_record(mask[i], kCharge);
        mask[i].active = mask[i].conductor = mask[i].spin_active = mask[i].torque_target = 1;
        mask[i].material_index = 7;
        mask[i].region_id = 1;
        mask[i].saturation_magnetization = 8.0e5;
    }
    std::array<fullmag_fdm_gpu_transport_spin_material_v1,4> materials{};
    const std::array<double,4> conductivities{{sigma,2.0e6,8.0e6,3.0e6}};
    for(size_t i=0;i<materials.size();++i){
        init_record(materials[i],kCharge);materials[i].material_index=7+i;
        materials[i].conductivity=conductivities[i];materials[i].material_revision=1;
        materials[i].spin_conductivity=conductivities[i];materials[i].spin_flip_length=8.0e-9;
        materials[i].spin_revision=1;
    }
    mask[1].material_index=8;mask[1+nx].material_index=9;mask[0].material_index=10;
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> faces;
    faces.reserve(2 * ny * nz);
    auto append_face = [&](uint32_t kind, uint32_t axis, int32_t side,
                           uint64_t adjacent, uint64_t canonical, double area,
                           double value, uint64_t source_id) {
        fullmag_fdm_gpu_transport_charge_face_v1 face{};
        init_record(face, kCharge); face.kind = kind; face.axis = axis; face.side = side;
        face.outward_sign = side; face.adjacent_cell = adjacent;
        face.canonical_face_index = canonical; face.area = area;
        face.value = value; face.source_id = source_id; faces.push_back(face);
    };
    uint64_t source_id = 100;
    for (uint64_t z = 0; z < nz; ++z) {
        for (uint64_t y = 0; y < ny; ++y) {
            append_face(kChargeFaceVoltage,0,-1,nx*(y+ny*z),(nx+1)*(y+ny*z),h*h,left_v,source_id++);
            append_face(kChargeFaceVoltage,0,+1,nx-1+nx*(y+ny*z),nx+(nx+1)*(y+ny*z),h*h,right_v,source_id++);
        }
    }
    for (uint64_t z = 0; z < nz; ++z) for (uint64_t x = 0; x < nx; ++x) {
        append_face(kChargeFaceVoltage,1,-1,x+nx*ny*z,x+nx*((ny+1)*z),h*h,20.0e-3,source_id++);
        append_face(kChargeFaceVoltage,1,+1,x+nx*(ny-1+ny*z),x+nx*(ny+(ny+1)*z),h*h,0.0,source_id++);
    }
    for (uint64_t y = 0; y < ny; ++y) for (uint64_t x = 0; x < nx; ++x) {
        append_face(kChargeFaceVoltage,2,-1,x+nx*y,x+nx*y,h*h,10.0e-3,source_id++);
        append_face(kChargeFaceVoltage,2,+1,x+nx*(y+ny*(nz-1)),x+nx*(y+ny*nz),h*h,0.0,source_id++);
    }
    std::vector<fullmag_fdm_gpu_transport_spin_boundary_face_v1> spin_faces;
    spin_faces.reserve(faces.size());
    for (const auto &charge_face : faces) {
        fullmag_fdm_gpu_transport_spin_boundary_face_v1 face{};
        init_record(face, kSpin); face.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING;
        face.axis = charge_face.axis; face.side = charge_face.side; face.outward_sign = charge_face.side;
        face.adjacent_cell = charge_face.adjacent_cell;
        face.canonical_face_index = charge_face.canonical_face_index;
        face.area = charge_face.area; face.source_id = charge_face.source_id; spin_faces.push_back(face);
    }
    std::vector<fullmag_fdm_gpu_transport_spin_interface_v1> interfaces(3);
    auto set_interface = [&](size_t i, uint32_t axis, uint64_t negative_cell,
                             uint64_t positive_cell, uint64_t from_cell, uint64_t to_cell,
                             uint64_t face, uint64_t source, uint64_t topology) {
        auto &record = interfaces[i]; init_record(record, kCharge|FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2);
        record.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2;
        record.axis = axis; record.orientation = from_cell == negative_cell ? 1 : -1;
        record.negative_cell = negative_cell; record.positive_cell = positive_cell;
        record.from_cell = from_cell; record.to_cell = to_cell;
        record.canonical_face_index = face; record.area = h*h;
        record.source_id = source; record.topology_id = topology;
        record.magnetization_xyz[2] = 1.0;
    };
    set_interface(0,2,0,nx*ny,nx*ny,0,nx*ny,420,4200);
    set_interface(1,1,1,1+nx,1,1+nx,1+nx,410,4100);
    set_interface(2,1,2,2+nx,2+nx,2,2+nx,430,4300);
    interfaces[0].G_up=1.0e15;interfaces[0].G_down=2.0e15;interfaces[0].charge_edge_enabled=1;
    interfaces[1].G_up=2.0e15;interfaces[1].G_down=3.0e15;interfaces[1].charge_edge_enabled=1;
    interfaces[2].G_up=interfaces[2].G_down=0.0;interfaces[2].charge_edge_enabled=0;
    fullmag_fdm_gpu_transport_formula_ids_v1 formula{};
    init_record(formula,kCharge); formula.formula_id=FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id=FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id=FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id=FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision=1; formula.spin_formula_id=FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1;
    formula.spin_operator_id=FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1;
    formula.electric_reconstruction_id=FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1;
    formula.interface_formula_id=FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2;
    formula.torque_operator_id=FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1;
    formula.spin_engine_id=FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1;
    formula.preconditioner_id=FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1;
    formula.spin_residual_id=FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1;
    formula.local_residual_id=FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1;
    formula.spin_operator_revision=1; formula.preconditioner_revision=1;
    formula.gamma_e=1.76085963023e11; formula.gmres_restart=50;
    std::array<uint32_t, 4> formula_ids{{1, 1, 1, 1}};
    std::array<uint8_t, 1> empty{{0}};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        view(mask.data(),mask.size(),sizeof(mask[0]),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(materials.data(),materials.size(),sizeof(materials[0]),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(interfaces.data(),interfaces.size(),sizeof(interfaces[0]),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(faces.data(),faces.size(),sizeof(faces[0]),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(spin_faces.data(),spin_faces.size(),sizeof(spin_faces[0]),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(&formula,1,sizeof(formula),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_MIXING_V2);
    descriptor.grid[0] = nx;
    descriptor.grid[1] = ny;
    descriptor.grid[2] = nz;
    descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = h;
    descriptor.descriptor_revision = 1;
    descriptor.source_revision = 1;
    std::fill(std::begin(descriptor.descriptor_digest), std::end(descriptor.descriptor_digest), 0x5a);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    const uint32_t descriptor_status =
        fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
            created.context_handle, &descriptor);
    if (descriptor_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        std::fprintf(stderr, "snapshot descriptor status=%u\n", descriptor_status);
    require(descriptor_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "snapshot typed charge descriptor upload failed");

    auto frozen_source = view(restore_golden.data(), restore_golden.size(), 1,
                              FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 frozen_import{};
    init_record(frozen_import, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    frozen_import.context_handle = created.context_handle;
    frozen_import.source_view_ptr = reinterpret_cast<uint64_t>(&frozen_source);
    std::memcpy(frozen_import.expected_payload_sha256, restore_sha, 32);
    std::memcpy(frozen_import.device_uuid, created.device_uuid, 16);
    std::memcpy(frozen_import.build_digest, created.build_digest, 32);
    std::memcpy(frozen_import.static_descriptor_digest, descriptor.descriptor_digest, 32);
    frozen_import.restore_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD;
    frozen_import.expected_bytes = restore_golden.size();
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 frozen_restored{};
    init_record(frozen_restored, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                     FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(&frozen_import, &frozen_restored) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
            "synthetic frozen oracle crossed an exact runtime identity boundary");

    fullmag_fdm_gpu_charge_solve_request_v1 solve{};
    init_record(solve);
    solve.context_handle = created.context_handle;
    solve.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    solve.gauge_policy = FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    solve.attempt_id = 1;
    solve.stage_id = 1;
    solve.source_revision = 1;
    solve.static_revision = 1;
    solve.relative_tolerance = 1.0e-13;
    solve.max_iterations = 500;
    fullmag_fdm_gpu_charge_solve_result_v1 solved{};
    init_record(solved);
    const uint32_t solve_status = fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved);
    if (solve_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        (void)fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle);
        std::fprintf(stderr,
                     "FAIL: charge_snapshot_v1 expected solve=OK, got status=%u (Phase1 RED expects UNSUPPORTED=1)\n",
                     solve_status);
        return 1;
    }
    require(solved.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            "uniform charge solve did not converge");
    require(solved.physical_residual <= 1.0e-10 && solved.component_balance <= 1.0e-10 &&
                solved.electrode_balance <= 1.0e-10,
            "uniform charge physical balance exceeded the frozen tolerance");

    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, solved.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "uniform charge candidate was not atomically accepted");
    const std::array<uint8_t, 32> accepted_digest = [&] {
        std::array<uint8_t, 32> digest{};
        std::memcpy(digest.data(), snapshot.snapshot_content_digest, digest.size());
        return digest;
    }();
    require(std::any_of(accepted_digest.begin(), accepted_digest.end(),
                        [](uint8_t byte) { return byte != 0; }),
            "accepted snapshot content digest must be content-derived and nonzero");
    require(std::memcmp(solved.candidate_digest, accepted_digest.data(),
                        accepted_digest.size()) == 0,
            "solve candidate and accepted snapshot content digests differ");

    std::vector<double> potential(cells);
    const uint64_t jx_count = (nx + 1) * ny * nz;
    const uint64_t jy_count = nx * (ny + 1) * nz;
    const uint64_t jz_count = nx * ny * (nz + 1);
    std::vector<double> current(jx_count + jy_count + jz_count);
    auto readback = [&](uint32_t field, std::vector<double> &destination) {
        auto destination_view = view(destination.data(), destination.size(), sizeof(double),
                                     FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
                                     field == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C
                                         ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
                                         : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR);
        destination_view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
        fullmag_fdm_gpu_transport_artifact_request_v1 request{};
        init_record(request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                 FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
        request.context_handle = created.context_handle;
        request.snapshot_handle = snapshot.snapshot_handle;
        request.field_id = field;
        request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
        request.range_count = destination.size();
        request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination_view);
        request.expected_bytes = destination.size() * sizeof(double);
        request.accepted_sequence = snapshot.accepted_sequence;
        require(fullmag_fdm_gpu_transport_readback_artifact_v1(&request) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "accepted charge artifact readback failed");
    };
    readback(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, potential);
    readback(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C, current);
    auto readback_interface_traces=[&](fullmag_fdm_gpu_transport_context_handle_v1 context,
        fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle,uint64_t sequence) {
        std::vector<fullmag_fdm_gpu_transport_charge_interface_trace_v1> records(interfaces.size());
        auto destination=view(records.data(),records.size(),sizeof(records[0]),
            FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
        destination.pointer_space=FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
        fullmag_fdm_gpu_transport_artifact_request_v1 request{};
        init_record(request,kCharge|FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
        request.context_handle=context;request.snapshot_handle=snapshot_handle;
        request.field_id=FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_CHARGE_INTERFACE_TRACE;
        request.cadence=FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
        request.range_count=records.size();request.destination_view_ptr=reinterpret_cast<uint64_t>(&destination);
        request.expected_bytes=records.size()*sizeof(records[0]);request.accepted_sequence=sequence;
        require(fullmag_fdm_gpu_transport_readback_artifact_v1(&request)==FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "accepted charge interface trace readback failed");
        return records;
    };
    const auto accepted_interface_traces=readback_interface_traces(
        created.context_handle,snapshot.snapshot_handle,snapshot.accepted_sequence);

    fullmag_fdm_gpu_transport_checkpoint_size_request_v1 checkpoint_size{};
    init_record(checkpoint_size, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                     FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    checkpoint_size.context_handle = created.context_handle;
    checkpoint_size.snapshot_handle = snapshot.snapshot_handle;
    checkpoint_size.accepted_sequence = snapshot.accepted_sequence;
    checkpoint_size.schema_version = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    checkpoint_size.inclusion_mask = UINT32_C(0x33);
    std::memcpy(checkpoint_size.static_descriptor_digest, descriptor.descriptor_digest, 32);
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 checkpoint_size_result{};
    init_record(checkpoint_size_result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    const uint32_t checkpoint_size_status = fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
        &checkpoint_size, &checkpoint_size_result);
    if (checkpoint_size_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        (void)fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle);
        (void)fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle);
        std::fprintf(stderr,
                     "FAIL: charge_snapshot_v1 expected checkpoint query=OK, got status=%u (Phase1 stub expects UNSUPPORTED=1)\n",
                     checkpoint_size_status);
        return 1;
    }
    require(checkpoint_size_result.required_bytes > 4352 &&
                checkpoint_size_result.section_count == 11 &&
                checkpoint_size_result.alignment == 64,
            "checkpoint query did not return the canonical dynamic charge layout");
    require(std::memcmp(checkpoint_size_result.snapshot_content_digest,
                        accepted_digest.data(), accepted_digest.size()) == 0,
            "checkpoint size query changed the accepted snapshot digest");
    std::vector<uint8_t> checkpoint(checkpoint_size_result.required_bytes);
    auto checkpoint_destination = view(checkpoint.data(), checkpoint.size(), 1,
                                       FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    checkpoint_destination.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 checkpoint_export{};
    init_record(checkpoint_export, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                      FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    checkpoint_export.context_handle = created.context_handle;
    checkpoint_export.snapshot_handle = snapshot.snapshot_handle;
    checkpoint_export.accepted_sequence = snapshot.accepted_sequence;
    checkpoint_export.cadence_id = 1;
    checkpoint_export.destination_view_ptr = reinterpret_cast<uint64_t>(&checkpoint_destination);
    checkpoint_export.exact_capacity = checkpoint.size();
    checkpoint_export.expected_size = checkpoint.size();
    checkpoint_export.inclusion_mask = UINT32_C(0x33);
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 exported{};
    init_record(exported, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                              FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    const uint32_t checkpoint_export_status =
        fullmag_fdm_gpu_transport_checkpoint_export_v1(&checkpoint_export, &exported);
    if (checkpoint_export_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        std::fprintf(stderr, "checkpoint export status=%u expected_size=%zu committed=%llu\n",
                     checkpoint_export_status, checkpoint.size(),
                     static_cast<unsigned long long>(exported.committed_bytes));
    require(checkpoint_export_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                exported.committed_bytes == checkpoint.size(),
            "canonical charge checkpoint export failed");
    require(std::memcmp(exported.snapshot_digest, accepted_digest.data(),
                        accepted_digest.size()) == 0,
            "checkpoint export changed the accepted snapshot digest");
    uint32_t checkpoint_kind = 0;
    require(fullmag_fdm_gpu_transport_checkpoint_validate_v1(
                checkpoint.data(), checkpoint.size(), &checkpoint_kind) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                checkpoint_kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE,
            "exported checkpoint failed the independent Phase1 semantic codec");
    fullmag::fdm::gpu::transport::charge::CheckpointData interface_checkpoint{};
    require(fullmag::fdm::gpu::transport::charge::parse_checkpoint(
                checkpoint.data(), checkpoint.size(), &interface_checkpoint) &&
                interface_checkpoint.interface_source_ids == std::vector<uint64_t>({410,420,430}) &&
                interface_checkpoint.interface_topology_ids == std::vector<uint64_t>({4100,4200,4300}) &&
                interface_checkpoint.interface_axes == std::vector<uint32_t>({1,2,1}) &&
                interface_checkpoint.interface_negative_cells == std::vector<uint64_t>({1,0,2}) &&
                interface_checkpoint.interface_positive_cells == std::vector<uint64_t>({1+nx,nx*ny,2+nx}) &&
                interface_checkpoint.interface_from_cells == std::vector<uint64_t>({1,nx*ny,2+nx}) &&
                interface_checkpoint.interface_to_cells == std::vector<uint64_t>({1+nx,0,2}),
            "reversed authored Y/Z multicell identities did not round-trip canonically");
    require(interface_checkpoint.interface_from_trace_v.size() == 3 &&
                interface_checkpoint.interface_to_trace_v.size() == 3 &&
                interface_checkpoint.interface_delta_trace_v.size() == 3 &&
                interface_checkpoint.interface_charge_current_density.size() == 3 &&
                interface_checkpoint.interface_from_trace_v[0] -
                        interface_checkpoint.interface_to_trace_v[0] ==
                    interface_checkpoint.interface_delta_trace_v[0] &&
                interface_checkpoint.interface_from_trace_v[1] -
                        interface_checkpoint.interface_to_trace_v[1] ==
                    interface_checkpoint.interface_delta_trace_v[1] &&
                interface_checkpoint.interface_from_trace_v[2] -
                        interface_checkpoint.interface_to_trace_v[2] ==
                    interface_checkpoint.interface_delta_trace_v[2],
            "accepted Y/Z interface trace arrays did not round-trip bitwise");
    for(size_t i=0;i<accepted_interface_traces.size();++i) {
        const auto &record=accepted_interface_traces[i];
        require(record.source_id==interfaces[i].source_id&&record.topology_id==interfaces[i].topology_id&&
                    record.axis==interfaces[i].axis&&record.orientation==interfaces[i].orientation&&
                    record.canonical_face_index==interfaces[i].canonical_face_index&&
                    record.negative_cell==interfaces[i].negative_cell&&record.positive_cell==interfaces[i].positive_cell&&
                    record.from_cell==interfaces[i].from_cell&&record.to_cell==interfaces[i].to_cell,
                "public interface trace metadata drifted from immutable descriptor order");
    }
    auto sigma_at=[&](uint64_t cell){return conductivities[mask[cell].material_index-7];};
    for(size_t i=0;i<interfaces.size();++i){
        const auto &spec=interfaces[i];const auto &trace=accepted_interface_traces[i];
        const double gsum=spec.G_up+spec.G_down;
        if(gsum==0.0){
            require(trace.oriented_current_density==0.0&&
                    trace.from_trace_v==potential[spec.from_cell]&&
                    trace.to_trace_v==potential[spec.to_cell]&&
                    trace.delta_trace_v==potential[spec.from_cell]-potential[spec.to_cell],
                "Gsum=0 interface did not remain exactly insulating with cell-centred traces");
            continue;
        }
        const double rf=h/(2.0*sigma_at(spec.negative_cell))+1.0/gsum+
                        h/(2.0*sigma_at(spec.positive_cell));
        const double global_j=(potential[spec.negative_cell]-potential[spec.positive_cell])/rf;
        const double oriented_j=spec.orientation*global_j;
        const double expected_from=potential[spec.from_cell]-
            oriented_j*h/(2.0*sigma_at(spec.from_cell));
        const double expected_to=potential[spec.to_cell]+
            oriented_j*h/(2.0*sigma_at(spec.to_cell));
        require(std::abs(global_j)>1.0&&close(trace.oriented_current_density,oriented_j,2.0e-11)&&
                close(trace.from_trace_v,expected_from,2.0e-11,1.0e-15)&&
                close(trace.to_trace_v,expected_to,2.0e-11,1.0e-15)&&
                close(trace.delta_trace_v,expected_from-expected_to,2.0e-11,1.0e-15),
            "independent finite-G Y/Z series-resistance oracle mismatch");
    }

    std::vector<double> retained_potential(cells);
    readback(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, retained_potential);
    require(std::memcmp(retained_potential.data(), potential.data(), cells * sizeof(double)) == 0,
            "checkpoint export mutated the retained immutable snapshot");
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 retained_size{};
    init_record(retained_size, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
                &checkpoint_size, &retained_size) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                std::memcmp(retained_size.snapshot_content_digest, accepted_digest.data(),
                            accepted_digest.size()) == 0,
            "checkpoint export mutated accepted snapshot identity");

    fullmag_fdm_gpu_transport_context_create_result_v1 restored_context{};
    init_record(restored_context);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &restored_context) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "exact-matching restore context creation failed");
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                restored_context.context_handle, &descriptor) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "restore context static descriptor upload failed");
    auto checkpoint_source = view(checkpoint.data(), checkpoint.size(), 1,
                                  FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 checkpoint_import{};
    init_record(checkpoint_import, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                      FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    checkpoint_import.context_handle = restored_context.context_handle;
    checkpoint_import.source_view_ptr = reinterpret_cast<uint64_t>(&checkpoint_source);
    std::memcpy(checkpoint_import.expected_payload_sha256, exported.payload_sha256, 32);
    std::memcpy(checkpoint_import.device_uuid, restored_context.device_uuid, 16);
    std::memcpy(checkpoint_import.build_digest, restored_context.build_digest, 32);
    std::memcpy(checkpoint_import.static_descriptor_digest, descriptor.descriptor_digest, 32);
    checkpoint_import.restore_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD;
    checkpoint_import.expected_bytes = checkpoint.size();
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 restored{};
    init_record(restored, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                          FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    checkpoint.back() ^= 1;
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(&checkpoint_import, &restored) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
            "mutated checkpoint import did not fail closed");
    checkpoint.back() ^= 1;
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(&checkpoint_import, &restored) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                restored.restored_state ==
                    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_CHARGE_ACCEPTED,
            "exact same-device checkpoint import failed");
    require(restored.accepted_sequence == snapshot.accepted_sequence &&
                std::memcmp(restored.snapshot_lineage_id, exported.snapshot_lineage_id, 16) == 0 &&
                std::memcmp(restored.snapshot_content_digest, accepted_digest.data(), 32) == 0,
            "checkpoint import did not preserve accepted identity");

    auto readback_restored = [&](fullmag_fdm_gpu_transport_context_handle_v1 context_handle,
                                 uint32_t field, std::vector<double> &destination) {
        auto destination_view = view(destination.data(), destination.size(), sizeof(double),
                                     FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
                                     field == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C
                                         ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
                                         : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR);
        destination_view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
        fullmag_fdm_gpu_transport_artifact_request_v1 request{};
        init_record(request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                 FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
        request.context_handle = context_handle;
        request.snapshot_handle = restored.snapshot_handle;
        request.field_id = field;
        request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
        request.range_count = destination.size();
        request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination_view);
        request.expected_bytes = destination.size() * sizeof(double);
        request.accepted_sequence = restored.accepted_sequence;
        return fullmag_fdm_gpu_transport_readback_artifact_v1(&request);
    };
    std::vector<double> restored_potential(cells);
    std::vector<double> restored_current(current.size());
    require(readback_restored(restored_context.context_handle,
                              FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
                              restored_potential) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                readback_restored(restored_context.context_handle,
                                  FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
                                  restored_current) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "restored accepted artifacts were not readable");
    require(std::memcmp(restored_potential.data(), potential.data(), cells * sizeof(double)) == 0 &&
                std::memcmp(restored_current.data(), current.data(), current.size() * sizeof(double)) == 0,
            "checkpoint restore changed V/J bytes or performed a re-solve");
    const auto restored_interface_traces=readback_interface_traces(
        restored_context.context_handle,restored.snapshot_handle,restored.accepted_sequence);
    require(std::memcmp(restored_interface_traces.data(),accepted_interface_traces.data(),
                        accepted_interface_traces.size()*sizeof(accepted_interface_traces[0]))==0,
            "checkpoint restore changed immutable interface trace records or re-solved charge");
    require(readback_restored(created.context_handle,
                              FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
                              restored_potential) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_STALE_SNAPSHOT,
            "wrong-context restored snapshot use did not fail closed");

    for(double value:potential) require(std::isfinite(value),"finite-G potential is non-finite");
    for(double value:current) require(std::isfinite(value),"finite-G current is non-finite");
    double max_transverse = 0.0;
    for (uint64_t i = jx_count; i < current.size(); ++i)
        max_transverse = std::max(max_transverse, std::abs(current[i]));
    require(max_transverse > 1.0,"finite-G Y/Z oracle did not exercise nonzero transverse current");

    uint64_t hierarchy_build_count = 0, hierarchy_cache_hit_count = 0;
    uint64_t amg_apply_count = 0, host_fallback_count = UINT64_MAX;
    uint64_t fine_unknown_count = 0, coarse_unknown_count = 0;
    uint32_t hierarchy_levels = 0;
    std::array<uint8_t, 32> hierarchy_digest{};
    require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                created.context_handle, &hierarchy_build_count,
                &hierarchy_cache_hit_count, &amg_apply_count,
                &host_fallback_count, &fine_unknown_count,
                &coarse_unknown_count, &hierarchy_levels,
                hierarchy_digest.data()) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                host_fallback_count == 0,
            "measured charge audit reported a host fallback");

    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "snapshot destroy failed");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_ALREADY_DESTROYED,
            "snapshot double destroy did not fail exactly");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "context destroy failed");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(restored_context.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_LIVE_SNAPSHOT,
            "restore context destroy ignored a live immutable snapshot");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(restored.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "restored snapshot destroy failed");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(restored_context.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "restore context destroy failed after snapshot release");

    // The frozen 4,352-byte oracle above deliberately has synthetic identity fields.
    // Exercise the same one-cell layout with this device/build identity and sequence 7,
    // then restore it into a fresh exact-matching context without another solve.
    std::array<uint8_t, 1> one_mask{{1}};
    std::array<double, 1> one_conductivity{{sigma}};
    std::array<ChargeFaceV1, 6> one_faces{{
        {kChargeFaceExactDensity, 0, -1, 0, 0, h * h, -1.25e11},
        {kChargeFaceVoltage, 0, +1, 0, 0, h * h, 1.0},
        {kChargeFaceInsulating, 1, -1, 0, 0, h * h, 0.0},
        {kChargeFaceInsulating, 1, +1, 0, 0, h * h, 0.0},
        {kChargeFaceInsulating, 2, -1, 0, 0, h * h, 0.0},
        {kChargeFaceInsulating, 2, +1, 0, 0, h * h, 0.0},
    }};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> one_views{{
        view(one_mask.data(), one_mask.size(), sizeof(one_mask[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U8),
        view(one_conductivity.data(), one_conductivity.size(), sizeof(one_conductivity[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64),
        view(empty.data(), 0, sizeof(empty[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(one_faces.data(), one_faces.size(), sizeof(ChargeFaceV1),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(), 0, sizeof(empty[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(formula_ids.data(), formula_ids.size(), sizeof(formula_ids[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U32),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 one_descriptor{};
    init_record(one_descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    one_descriptor.grid[0] = one_descriptor.grid[1] = one_descriptor.grid[2] = 1;
    one_descriptor.cell_size[0] = one_descriptor.cell_size[1] = one_descriptor.cell_size[2] = h;
    one_descriptor.descriptor_revision = 1;
    one_descriptor.source_revision = 1;
    std::fill(std::begin(one_descriptor.descriptor_digest),
              std::end(one_descriptor.descriptor_digest), 0x3c);
    one_descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&one_views[0]);
    one_descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&one_views[1]);
    one_descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&one_views[2]);
    one_descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&one_views[3]);
    one_descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&one_views[4]);
    one_descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&one_views[5]);

    fullmag_fdm_gpu_transport_context_create_result_v1 one_created{};
    init_record(one_created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &one_created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    one_created.context_handle, &one_descriptor) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "one-cell exact-layout context setup failed");
    fullmag_fdm_gpu_charge_snapshot_info_v1 one_snapshot{};
    fullmag_fdm_gpu_charge_solve_result_v1 one_solved{};
    std::array<uint8_t, 32> one_sequence_one_digest{};
    for (uint64_t sequence = 1; sequence <= 7; ++sequence) {
        fullmag_fdm_gpu_charge_solve_request_v1 one_solve{};
        init_record(one_solve);
        one_solve.context_handle = one_created.context_handle;
        one_solve.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
        one_solve.gauge_policy =
            FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
        one_solve.attempt_id = sequence;
        one_solve.stage_id = 1;
        one_solve.source_revision = 1;
        one_solve.static_revision = 1;
        one_solve.relative_tolerance = 1.0e-13;
        one_solve.max_iterations = 64;
        init_record(one_solved);
        require(fullmag_fdm_gpu_transport_solve_charge_v1(&one_solve, &one_solved) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                    one_solved.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
                "one-cell sequence solve failed");
        init_record(one_snapshot);
        require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                    one_created.context_handle, one_solved.provisional_generation, &one_snapshot) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                    one_snapshot.accepted_sequence == sequence,
                "one-cell accepted sequence drifted");
        if (sequence == 1)
            std::memcpy(one_sequence_one_digest.data(),
                        one_snapshot.snapshot_content_digest,
                        one_sequence_one_digest.size());
        if (sequence == 7)
            require(std::memcmp(one_sequence_one_digest.data(),
                                one_snapshot.snapshot_content_digest,
                                one_sequence_one_digest.size()) != 0,
                    "accepted identity metadata mutation did not change content digest");
        if (sequence != 7) {
            require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(one_snapshot.snapshot_handle) ==
                        FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                    "one-cell intermediate snapshot release failed");
        }
    }

    fullmag_fdm_gpu_transport_checkpoint_size_request_v1 one_size{};
    init_record(one_size, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                              FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    one_size.context_handle = one_created.context_handle;
    one_size.snapshot_handle = one_snapshot.snapshot_handle;
    one_size.accepted_sequence = 7;
    one_size.schema_version = FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    one_size.inclusion_mask = UINT32_C(0x33);
    std::memcpy(one_size.static_descriptor_digest, one_descriptor.descriptor_digest, 32);
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 one_size_result{};
    init_record(one_size_result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                     FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    const uint32_t one_size_status =
        fullmag_fdm_gpu_transport_checkpoint_query_size_v1(&one_size, &one_size_result);
    if (one_size_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK ||
        one_size_result.required_bytes != 4352 ||
        one_size_result.section_count != 11 || one_size_result.alignment != 64) {
        std::fprintf(stderr,
                     "one-cell size diagnostics: status=%u bytes=%llu sections=%u alignment=%u\n",
                     one_size_status,
                     static_cast<unsigned long long>(one_size_result.required_bytes),
                     one_size_result.section_count, one_size_result.alignment);
    }
    require(one_size_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                one_size_result.required_bytes == 4352 &&
                one_size_result.section_count == 11 && one_size_result.alignment == 64,
            "actual one-cell sequence-7 checkpoint is not the exact 4,352-byte layout");
    std::vector<uint8_t> one_checkpoint(one_size_result.required_bytes);
    auto one_destination = view(one_checkpoint.data(), one_checkpoint.size(), 1,
                                FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    one_destination.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 one_export_request{};
    init_record(one_export_request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    one_export_request.context_handle = one_created.context_handle;
    one_export_request.snapshot_handle = one_snapshot.snapshot_handle;
    one_export_request.accepted_sequence = 7;
    one_export_request.cadence_id = 7;
    one_export_request.destination_view_ptr = reinterpret_cast<uint64_t>(&one_destination);
    one_export_request.exact_capacity = one_checkpoint.size();
    one_export_request.expected_size = one_checkpoint.size();
    one_export_request.inclusion_mask = UINT32_C(0x33);
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 one_exported{};
    init_record(one_exported, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                  FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    const uint32_t one_export_status =
        fullmag_fdm_gpu_transport_checkpoint_export_v1(&one_export_request, &one_exported);
    if (one_export_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK ||
        one_exported.committed_bytes != 4352 || one_exported.accepted_sequence != 7)
        std::fprintf(stderr,
                     "one-cell export diagnostics: status=%u committed=%llu sequence=%llu\n",
                     one_export_status,
                     static_cast<unsigned long long>(one_exported.committed_bytes),
                     static_cast<unsigned long long>(one_exported.accepted_sequence));
    require(one_export_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                one_exported.committed_bytes == 4352 && one_exported.accepted_sequence == 7,
            "actual one-cell sequence-7 checkpoint export failed");
    uint8_t one_sha[32]{};
    SHA256(one_checkpoint.data(), one_checkpoint.size(), one_sha);
    require(std::memcmp(one_sha, one_exported.payload_sha256, 32) == 0,
            "actual one-cell payload SHA does not cover the committed bytes");
    uint32_t one_kind = 0;
    require(fullmag_fdm_gpu_transport_checkpoint_validate_v1(
                one_checkpoint.data(), one_checkpoint.size(), &one_kind) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                one_kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE,
            "actual one-cell sequence-7 checkpoint failed the independent validator");

    fullmag::fdm::gpu::transport::charge::CheckpointData digest_fixture{};
    require(fullmag::fdm::gpu::transport::charge::parse_checkpoint(
                one_checkpoint.data(), one_checkpoint.size(), &digest_fixture),
            "runtime checkpoint did not parse for exact digest mutations");
    std::array<uint8_t, 32> mutation_baseline{};
    require(fullmag::fdm::gpu::transport::charge::checkpoint_content_digest_v2(
                digest_fixture, mutation_baseline.data()),
            "canonical mutation baseline digest failed");
    require(digest_fixture.charge_adjacent_cells == std::vector<uint64_t>{0} &&
                digest_fixture.charge_axes == std::vector<uint32_t>{0} &&
                digest_fixture.charge_sides == std::vector<int32_t>{-1} &&
                digest_fixture.charge_areas == std::vector<double>{h * h} &&
                digest_fixture.charge_values == std::vector<double>{-1.25e11} &&
                digest_fixture.charge_source_ids == std::vector<std::string>{"1"},
            "actual exact-density section-7 trace did not survive checkpoint export");
    require(std::memcmp(mutation_baseline.data(),
                        one_snapshot.snapshot_content_digest, mutation_baseline.size()) == 0 &&
                std::memcmp(one_size_result.snapshot_content_digest,
                            mutation_baseline.data(), mutation_baseline.size()) == 0 &&
                std::memcmp(one_exported.snapshot_digest,
                            mutation_baseline.data(), mutation_baseline.size()) == 0,
            "accept/query/export disagree with the independent host content digest");
    auto require_digest_mutation = [&](const char *name, auto mutate) {
        auto changed = digest_fixture;
        mutate(changed);
        std::array<uint8_t, 32> changed_digest{};
        require(fullmag::fdm::gpu::transport::charge::checkpoint_content_digest_v2(
                    changed, changed_digest.data()) && changed_digest != mutation_baseline,
                name);
    };
    require_digest_mutation("V byte mutation did not change snapshot digest",
                            [](auto &data) { data.potential[0] = std::nextafter(data.potential[0], INFINITY); });
    require_digest_mutation("Jx byte mutation did not change snapshot digest",
                            [](auto &data) { data.jx[0] = std::nextafter(data.jx[0], INFINITY); });
    require_digest_mutation("Jy byte mutation did not change snapshot digest",
                            [](auto &data) { data.jy[0] = std::nextafter(data.jy[0], INFINITY); });
    require_digest_mutation("Jz byte mutation did not change snapshot digest",
                            [](auto &data) { data.jz[0] = std::nextafter(data.jz[0], INFINITY); });
    require_digest_mutation("charge trace mutation did not change snapshot digest",
                            [](auto &data) { data.charge_values[0] = std::nextafter(data.charge_values[0], INFINITY); });
    require_digest_mutation("identity mutation did not change snapshot digest",
                            [](auto &data) { ++data.accepted_sequence; });

    std::array<double, 1> one_potential{};
    std::array<double, 6> one_current{};
    auto one_readback = [&](fullmag_fdm_gpu_transport_context_handle_v1 context_handle,
                            fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot_handle,
                            uint64_t accepted_sequence, uint32_t field, auto &destination) {
        auto destination_view = view(destination.data(), destination.size(), sizeof(double),
                                     FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
                                     field == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C
                                         ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
                                         : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR);
        destination_view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
        fullmag_fdm_gpu_transport_artifact_request_v1 request{};
        init_record(request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                 FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
        request.context_handle = context_handle;
        request.snapshot_handle = snapshot_handle;
        request.field_id = field;
        request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
        request.range_count = destination.size();
        request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination_view);
        request.expected_bytes = destination.size() * sizeof(double);
        request.accepted_sequence = accepted_sequence;
        return fullmag_fdm_gpu_transport_readback_artifact_v1(&request);
    };
    require(one_readback(one_created.context_handle, one_snapshot.snapshot_handle, 7,
                         FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, one_potential) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                one_readback(one_created.context_handle, one_snapshot.snapshot_handle, 7,
                             FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C, one_current) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "actual one-cell accepted artifacts were not readable");

    fullmag_fdm_gpu_transport_context_create_result_v1 one_restored_context{};
    init_record(one_restored_context);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &one_restored_context) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    one_restored_context.context_handle, &one_descriptor) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "one-cell exact-matching restore context setup failed");
    auto one_source = view(one_checkpoint.data(), one_checkpoint.size(), 1,
                           FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 one_import{};
    init_record(one_import, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    one_import.context_handle = one_restored_context.context_handle;
    one_import.source_view_ptr = reinterpret_cast<uint64_t>(&one_source);
    std::memcpy(one_import.expected_payload_sha256, one_exported.payload_sha256, 32);
    std::memcpy(one_import.device_uuid, one_restored_context.device_uuid, 16);
    std::memcpy(one_import.build_digest, one_restored_context.build_digest, 32);
    std::memcpy(one_import.static_descriptor_digest, one_descriptor.descriptor_digest, 32);
    one_import.restore_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD;
    one_import.expected_bytes = one_checkpoint.size();
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 one_restored{};
    init_record(one_restored, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                  FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(&one_import, &one_restored) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                one_restored.accepted_sequence == 7 &&
                std::memcmp(one_restored.snapshot_content_digest,
                            mutation_baseline.data(), mutation_baseline.size()) == 0 &&
                one_restored.restored_state ==
                    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_CHARGE_ACCEPTED,
            "actual one-cell sequence-7 checkpoint import failed");
    std::array<double, 1> one_restored_potential{};
    std::array<double, 6> one_restored_current{};
    require(one_readback(one_restored_context.context_handle, one_restored.snapshot_handle, 7,
                         FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
                         one_restored_potential) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                one_readback(one_restored_context.context_handle, one_restored.snapshot_handle, 7,
                             FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
                             one_restored_current) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                std::memcmp(one_restored_potential.data(), one_potential.data(), sizeof(one_potential)) == 0 &&
                std::memcmp(one_restored_current.data(), one_current.data(), sizeof(one_current)) == 0,
            "actual one-cell restore changed V/J bytes or performed a re-solve");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(one_snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_context_destroy_v1(one_created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_charge_snapshot_destroy_v1(one_restored.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_context_destroy_v1(one_restored_context.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "actual one-cell snapshot/context token teardown failed");

    const char *evidence_path = std::getenv("FULLMAG_FDM_GPU_M1_CHARGE_SNAPSHOT_EVIDENCE_PATH");
    require(evidence_path != nullptr && evidence_path[0] != '\0', "evidence path is required");
    std::ofstream evidence(evidence_path, std::ios::trunc);
    require(evidence.good(), "cannot create charge evidence JSON");
    evidence << "{\n  \"workload\": \"charge_snapshot_v1\",\n"
             << "  \"device_ordinal\": " << device << ",\n"
             << "  \"device_name\": \"" << device_properties.name << "\",\n"
             << "  \"device_uuid\": \"" << hex(created.device_uuid, 16) << "\",\n"
             << "  \"compute_major\": " << created.compute_major << ",\n"
             << "  \"compute_minor\": " << created.compute_minor << ",\n"
             << "  \"cuda_runtime\": " << created.cuda_runtime << ",\n"
             << "  \"cuda_driver\": " << created.cuda_driver << ",\n"
             << "  \"build_digest\": \"" << hex(created.build_digest, 32) << "\",\n"
             << "  \"engine_id\": \"fdm_charge_cg_cuda_v1\",\n"
             << "  \"iterations\": " << solved.iterations << ",\n"
             << std::setprecision(17)
             << "  \"algebraic_residual\": " << solved.algebraic_residual << ",\n"
             << "  \"physical_residual\": " << solved.physical_residual << ",\n"
             << "  \"component_balance\": " << solved.component_balance << ",\n"
             << "  \"electrode_balance\": " << solved.electrode_balance << ",\n"
             << "  \"snapshot_digest\": \"" << hex(exported.snapshot_digest, 32) << "\",\n"
             << "  \"checkpoint_bytes\": " << checkpoint.size() << ",\n"
             << "  \"one_cell_checkpoint_bytes\": " << one_checkpoint.size() << ",\n"
             << "  \"one_cell_accepted_sequence\": 7,\n"
             << "  \"one_cell_payload_sha256\": \"" << hex(one_exported.payload_sha256, 32) << "\",\n"
             << "  \"one_cell_snapshot_digest\": \"" << hex(one_exported.snapshot_digest, 32) << "\",\n"
             << "  \"restored_without_resolve\": true,\n"
             << "  \"one_cell_restored_without_resolve\": true,\n"
             << "  \"host_fallback_count\": " << host_fallback_count << "\n}\n";
    require(evidence.good(), "failed to commit charge evidence JSON");
    return 0;
}
