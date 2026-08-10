#include "fullmag_fdm.h"
#include "fullmag/fdm/cpu/charge_transport_v1.hpp"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <string>
#include <vector>

extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_runtime_counters_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint64_t, uint64_t);
extern "C" uint32_t fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint64_t *, uint64_t *, uint64_t *);

namespace {

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

fullmag_fdm_gpu_transport_buffer_view_v1 view(
    const void *data, uint64_t count, uint64_t stride, uint32_t element_type) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = stride;
    result.byte_length = count * stride;
    result.element_type = element_type;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    result.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR;
    return result;
}

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string hex(const uint8_t *bytes, size_t size) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string value;
    value.reserve(size * 2);
    for (size_t i = 0; i < size; ++i) {
        value.push_back(digits[bytes[i] >> 4]);
        value.push_back(digits[bytes[i] & 0xf]);
    }
    return value;
}

fullmag_fdm_gpu_transport_charge_face_v1 face(
    uint32_t kind, uint32_t axis, int32_t side, uint64_t adjacent,
    uint64_t canonical_index, double area, double value, uint64_t source_id) {
    fullmag_fdm_gpu_transport_charge_face_v1 result{};
    init_record(result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    result.kind = kind;
    result.axis = axis;
    result.side = side;
    result.outward_sign = side;
    result.adjacent_cell = adjacent;
    result.canonical_face_index = canonical_index;
    result.area = area;
    result.value = value;
    result.source_id = source_id;
    return result;
}

void rotated_workload(uint32_t axis, bool exact_density,
                      const fullmag_fdm_gpu_transport_context_create_request_v1 &create) {
    using namespace fullmag::fdm::cpu::transport::v1;
    const std::array<uint64_t, 3> n{{3, 4, 5}};
    const std::array<double, 3> h{{1.0e-9, 1.5e-9, 2.0e-9}};
    const uint64_t cells = n[0] * n[1] * n[2];
    const double sigma = 4.0e6, j = 2.0e5;
    const double length = n[axis] * h[axis];
    const double high_v = exact_density ? 0.0 : 8.0e-3;
    const double expected_j = exact_density ? j : sigma * high_v / length;
    auto index = [&](uint64_t x, uint64_t y, uint64_t z) {
        return x + n[0] * (y + n[1] * z);
    };
    auto canonical = [&](uint32_t a, int side, uint64_t x, uint64_t y, uint64_t z) {
        if (a == 0) return static_cast<uint64_t>((side < 0 ? 0 : n[0]) +
            (n[0] + 1) * (y + n[1] * z));
        if (a == 1) return x + n[0] * ((side < 0 ? 0 : n[1]) + (n[1] + 1) * z);
        return x + n[0] * (y + n[1] * (side < 0 ? 0 : n[2]));
    };
    std::vector<fullmag_fdm_gpu_transport_charge_cell_v1> cell_records(cells);
    for (auto &c : cell_records) { init_record(c, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE); c.active = c.conductor = 1; }
    fullmag_fdm_gpu_transport_charge_material_v1 material{};
    init_record(material, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    material.conductivity = sigma; material.material_revision = 1;
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> faces;
    for (uint64_t z = 0; z < n[2]; ++z) for (uint64_t y = 0; y < n[1]; ++y)
        for (uint64_t x = 0; x < n[0]; ++x) for (uint32_t a = 0; a < 3; ++a)
            for (int side : {-1, 1}) {
                const uint64_t coord = a == 0 ? x : a == 1 ? y : z;
                if ((side < 0 && coord != 0) || (side > 0 && coord + 1 != n[a])) continue;
                const double area = a == 0 ? h[1] * h[2] : a == 1 ? h[0] * h[2] : h[0] * h[1];
                uint32_t kind = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING;
                double value = 0.0;
                if (a == axis && side < 0) {
                    kind = exact_density ? FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY
                                         : FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE;
                    value = exact_density ? -expected_j : high_v;
                } else if (a == axis && side > 0) kind = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE;
                faces.push_back(face(kind, a, side, index(x,y,z), canonical(a,side,x,y,z),
                                     area, value, 1 + faces.size()));
            }
    fullmag_fdm_gpu_transport_charge_formula_ids_v1 formula{};
    init_record(formula, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision = 1;
    std::array<uint8_t,1> empty{{0}}; std::array<fullmag_fdm_gpu_transport_charge_material_v1,1> materials{{material}};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1,6> views{{
        view(cell_records.data(),cells,sizeof(cell_records[0]),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(materials.data(),1,sizeof(material),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(),0,1,FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(faces.data(),faces.size(),sizeof(faces[0]),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(),0,1,FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(&formula,1,sizeof(formula),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES)}};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{}; init_record(descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    for (int a=0;a<3;++a) { descriptor.grid[a]=n[a]; descriptor.cell_size[a]=h[a]; }
    descriptor.descriptor_revision=descriptor.source_revision=1;
    std::fill(std::begin(descriptor.descriptor_digest),std::end(descriptor.descriptor_digest),static_cast<uint8_t>(0x80+axis+exact_density));
    descriptor.masks_view_ptr=(uint64_t)&views[0]; descriptor.materials_view_ptr=(uint64_t)&views[1];
    descriptor.interfaces_view_ptr=(uint64_t)&views[2]; descriptor.charge_faces_view_ptr=(uint64_t)&views[3];
    descriptor.spin_faces_view_ptr=(uint64_t)&views[4]; descriptor.formula_ids_view_ptr=(uint64_t)&views[5];
    auto reject_rotated_metadata = [&](bool mutate_sign) {
        auto mutated_faces = faces;
        auto selected = std::find_if(mutated_faces.begin(), mutated_faces.end(), [&](const auto &f) {
            return f.axis == axis && f.side == -1;
        });
        require(selected != mutated_faces.end(), "rotated mutation face missing");
        if (mutate_sign) selected->outward_sign = +1;
        else ++selected->canonical_face_index;
        auto mutated_views = views;
        mutated_views[3] = view(mutated_faces.data(), mutated_faces.size(), sizeof(mutated_faces[0]),
                                FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
        auto mutated_descriptor = descriptor;
        mutated_descriptor.masks_view_ptr=(uint64_t)&mutated_views[0]; mutated_descriptor.materials_view_ptr=(uint64_t)&mutated_views[1];
        mutated_descriptor.interfaces_view_ptr=(uint64_t)&mutated_views[2]; mutated_descriptor.charge_faces_view_ptr=(uint64_t)&mutated_views[3];
        mutated_descriptor.spin_faces_view_ptr=(uint64_t)&mutated_views[4]; mutated_descriptor.formula_ids_view_ptr=(uint64_t)&mutated_views[5];
        fullmag_fdm_gpu_transport_context_create_result_v1 rejected{}; init_record(rejected);
        require(fullmag_fdm_gpu_transport_context_create_v1(&create,&rejected)==0,"rotated mutation context failed");
        require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(rejected.context_handle,&mutated_descriptor)==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR,
                "rotated sign/index mutation was not rejected exactly");
        require(fullmag_fdm_gpu_transport_context_destroy_v1(rejected.context_handle)==0,"rotated mutation teardown failed");
    };
    fullmag_fdm_gpu_transport_context_create_result_v1 created{}; init_record(created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create,&created)==0,"rotated context create failed");
    const uint32_t rotated_upload = fullmag_fdm_gpu_transport_static_descriptor_upload_v1(created.context_handle,&descriptor);
    if (rotated_upload != 0) std::fprintf(stderr, "rotated axis=%u exact=%d upload=%u faces=%zu\n", axis, exact_density, rotated_upload, faces.size());
    require(rotated_upload==0,"rotated descriptor upload failed");
    fullmag_fdm_gpu_charge_solve_request_v1 solve{}; init_record(solve); solve.context_handle=created.context_handle;
    solve.solver_policy=FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    solve.gauge_policy=FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    solve.source_revision=solve.static_revision=1; solve.relative_tolerance=1e-12; solve.max_iterations=500;
    fullmag_fdm_gpu_charge_solve_result_v1 solved{}; init_record(solved);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve,&solved)==0 && solved.reason==FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,"rotated solve failed");
    fullmag_fdm_gpu_charge_snapshot_info_v1 snap{}; init_record(snap);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(created.context_handle,solved.provisional_generation,&snap)==0,"rotated accept failed");
    const uint64_t counts[3]={(n[0]+1)*n[1]*n[2],n[0]*(n[1]+1)*n[2],n[0]*n[1]*(n[2]+1)};
    std::vector<double> current(counts[0]+counts[1]+counts[2]); auto dst=view(current.data(),current.size(),sizeof(double),FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64);
    dst.pointer_space=FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY; dst.component_order=FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ;
    fullmag_fdm_gpu_transport_artifact_request_v1 art{}; init_record(art, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE | FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK); art.context_handle=created.context_handle; art.snapshot_handle=snap.snapshot_handle;
    art.field_id=FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C; art.cadence=FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    art.range_count=current.size(); art.destination_view_ptr=(uint64_t)&dst; art.expected_bytes=current.size()*sizeof(double); art.accepted_sequence=snap.accepted_sequence;
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(&art)==0,"rotated current readback failed");
    uint64_t offset=axis==0?0:axis==1?counts[0]:counts[0]+counts[1];
    for(uint64_t i=0;i<counts[axis];++i) require(std::abs(current[offset+i]-expected_j)<=1e-9*std::abs(expected_j),"rotated analytic current mismatch");
    for(uint32_t a=0;a<3;++a) if(a!=axis) { uint64_t off=a==0?0:a==1?counts[0]:counts[0]+counts[1]; for(uint64_t i=0;i<counts[a];++i) require(std::abs(current[off+i])<=1e-9*std::abs(expected_j),"rotated transverse current mismatch"); }
    Problem cpu{}; cpu.grid={n[0],n[1],n[2],h[0],h[1],h[2]}; cpu.active_cells.assign(cells,1); cpu.conductivity_s_per_m.assign(cells,sigma);
    for(auto &bc:cpu.boundary.values) bc=BoundaryCondition::insulating();
    const Face minf=axis==0?Face::x_min:axis==1?Face::y_min:Face::z_min;
    const Face maxf=axis==0?Face::x_max:axis==1?Face::y_max:Face::z_max;
    cpu.boundary[minf]=exact_density?BoundaryCondition::specified_outward_current_density():BoundaryCondition::voltage(high_v); cpu.boundary[maxf]=BoundaryCondition::voltage(0.0);
    if(exact_density) for(const auto &f:faces) if(f.axis==axis&&f.side<0) cpu.specified_outward_current_density_faces.push_back({{f.axis,f.canonical_face_index,f.adjacent_cell,f.side,f.area},f.value});
    auto oracle=fullmag::fdm::cpu::transport::v1::solve(cpu,{1e-12,1e-14,10000}); require(oracle.ok(),"rotated CPU oracle failed");
    const auto &oj=axis==0?oracle.solution.face_current_density_a_per_m2.x:
                   axis==1?oracle.solution.face_current_density_a_per_m2.y:
                           oracle.solution.face_current_density_a_per_m2.z;
    for(uint64_t i=0;i<counts[axis];++i) require(std::abs(current[offset+i]-oj[i])<=1e-9*std::abs(expected_j),"rotated GPU/CPU parity mismatch");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snap.snapshot_handle)==0 && fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle)==0,"rotated teardown failed");
    reject_rotated_metadata(true);
    reject_rotated_metadata(false);
}

} // namespace

int main() {
    constexpr uint64_t nx = 4, ny = 1, nz = 1, cells = nx * ny * nz;
    constexpr double h = 1.0e-9;
    constexpr double sigma = 5.0e6;
    constexpr double imposed_j = 1.0;
    constexpr uint64_t mutation_count = 16;

    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess,
            "an actual CUDA device is required; SKIP is forbidden");
    cudaDeviceProp device_properties{};
    require(cudaGetDeviceProperties(&device_properties, device) == cudaSuccess,
            "actual CUDA device properties are required");

    // Absence of the M1 feature is absence of the charge graph.  Sentinel
    // values prove that append-only charge fields are not interpreted.
    fullmag_fdm_gpu_transport_context_create_request_v1 absent_create{};
    init_record(absent_create, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    absent_create.device_ordinal = device;
    absent_create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    absent_create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    absent_create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    absent_create.stream_policy =
        FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    absent_create.allocator_limit = 32ULL * 1024ULL * 1024ULL;
    absent_create.workspace_limit = 16ULL * 1024ULL * 1024ULL;
    fullmag_fdm_gpu_transport_context_create_result_v1 absent_context{};
    init_record(absent_context);
    require(fullmag_fdm_gpu_transport_context_create_v1(
                &absent_create, &absent_context) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "module-absence context creation failed");
    fullmag_fdm_gpu_transport_static_descriptor_v1 absent_descriptor{};
    init_record(absent_descriptor);
    absent_descriptor.descriptor_revision = 1;
    absent_descriptor.source_revision = 1;
    absent_descriptor.grid[0] = 1;
    absent_descriptor.grid[1] = 1;
    absent_descriptor.grid[2] = 1;
    absent_descriptor.cell_size[0] = 1.0e-9;
    absent_descriptor.cell_size[1] = 1.0e-9;
    absent_descriptor.cell_size[2] = 1.0e-9;
    std::memset(absent_descriptor.descriptor_digest, 0x5a,
                sizeof(absent_descriptor.descriptor_digest));
    absent_descriptor.masks_view_ptr = UINT64_C(0x1);
    absent_descriptor.materials_view_ptr = UINT64_C(0x3);
    absent_descriptor.interfaces_view_ptr = UINT64_C(0x5);
    absent_descriptor.charge_faces_view_ptr = UINT64_C(0x7);
    absent_descriptor.spin_faces_view_ptr = UINT64_C(0x9);
    absent_descriptor.formula_ids_view_ptr = UINT64_C(0xb);
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                absent_context.context_handle, &absent_descriptor) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "module-absence descriptor dereferenced charge sentinels");
    uint64_t absent_count = UINT64_MAX;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                absent_context.context_handle, 0, nullptr, 0, &absent_count) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && absent_count == 0,
            "module-absence upload published charge telemetry");
    auto absent_to_m1 = absent_descriptor;
    absent_to_m1.required_features = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                absent_context.context_handle, &absent_to_m1) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
            "idempotent absent descriptor accepted an M1 feature transition");
    fullmag_fdm_gpu_charge_solve_request_v1 absent_solve{};
    init_record(absent_solve);
    absent_solve.context_handle = absent_context.context_handle;
    absent_solve.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    absent_solve.gauge_policy =
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    absent_solve.source_revision = 1;
    absent_solve.static_revision = 1;
    absent_solve.relative_tolerance = 1.0e-12;
    absent_solve.max_iterations = 8;
    fullmag_fdm_gpu_charge_solve_result_v1 absent_result{};
    init_record(absent_result);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&absent_solve, &absent_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
            "module-absence charge solve did not fail before launch");
    fullmag_fdm_gpu_transport_artifact_request_v1 absent_artifact{};
    init_record(absent_artifact, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                     FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    absent_artifact.context_handle = absent_context.context_handle;
    absent_artifact.field_id = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V;
    absent_artifact.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    absent_artifact.range_count = 1;
    absent_artifact.destination_view_ptr = UINT64_C(0x1);
    absent_artifact.expected_bytes = sizeof(double);
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(&absent_artifact) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
            "module-absence artifact path dereferenced a sentinel destination");
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 absent_export{};
    init_record(absent_export, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    absent_export.context_handle = absent_context.context_handle;
    absent_export.destination_view_ptr = UINT64_C(0x1);
    absent_export.exact_capacity = absent_export.expected_size = 1;
    absent_export.inclusion_mask = UINT32_C(0x33);
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 absent_export_result{};
    init_record(absent_export_result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                          FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_export_v1(
                &absent_export, &absent_export_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
            "module-absence checkpoint export dereferenced a sentinel destination");
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 absent_import{};
    init_record(absent_import, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                   FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    absent_import.context_handle = absent_context.context_handle;
    absent_import.source_view_ptr = UINT64_C(0x1);
    absent_import.restore_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD;
    absent_import.expected_bytes = 1;
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 absent_restore{};
    init_record(absent_restore, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                    FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1);
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(
                &absent_import, &absent_restore) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
            "module-absence checkpoint import dereferenced a sentinel source");
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                absent_context.context_handle, 0, nullptr, 0, &absent_count) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && absent_count == 0,
            "module-absence charge rejection mutated telemetry");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(
                absent_context.context_handle) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "module-absence context teardown failed");
    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy = FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 32ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 16ULL * 1024ULL * 1024ULL;

    {
        auto bounded_create = create;
        bounded_create.allocator_limit =
            sizeof(fullmag_fdm_gpu_transport_static_descriptor_v1) +
            6 * sizeof(fullmag_fdm_gpu_transport_buffer_view_v1) + 64;
        fullmag_fdm_gpu_transport_context_create_result_v1 bounded_context{};
        init_record(bounded_context);
        require(fullmag_fdm_gpu_transport_context_create_v1(
                    &bounded_create, &bounded_context) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "bounded validation context creation failed");
        std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> oversized_views{};
        for (auto &record : oversized_views)
            record = view(reinterpret_cast<const void *>(uintptr_t{1}), 0, 1,
                          FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
        oversized_views[0] = view(reinterpret_cast<const void *>(uintptr_t{1}), 1024, 1,
                                  FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES);
        fullmag_fdm_gpu_transport_static_descriptor_v1 oversized{};
        init_record(oversized, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        oversized.grid[0] = oversized.grid[1] = oversized.grid[2] = 1;
        oversized.cell_size[0] = oversized.cell_size[1] = oversized.cell_size[2] = h;
        oversized.descriptor_revision = oversized.source_revision = 1;
        std::fill(std::begin(oversized.descriptor_digest),
                  std::end(oversized.descriptor_digest), 0x5e);
        oversized.masks_view_ptr = reinterpret_cast<uint64_t>(&oversized_views[0]);
        oversized.materials_view_ptr = reinterpret_cast<uint64_t>(&oversized_views[1]);
        oversized.interfaces_view_ptr = reinterpret_cast<uint64_t>(&oversized_views[2]);
        oversized.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&oversized_views[3]);
        oversized.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&oversized_views[4]);
        oversized.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&oversized_views[5]);
        require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    bounded_context.context_handle, &oversized) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
                "allocator bound was not enforced before payload dereference");
        uint64_t bounded_events = UINT64_MAX;
        require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                    bounded_context.context_handle, 0, nullptr, 0, &bounded_events) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && bounded_events == 0,
                "pre-dereference allocator rejection published partial telemetry");
        require(fullmag_fdm_gpu_transport_context_destroy_v1(
                    bounded_context.context_handle) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "bounded validation context teardown failed");
    }

    rotated_workload(0, false, create);
    rotated_workload(0, true, create);
    rotated_workload(1, false, create);
    rotated_workload(1, true, create);
    rotated_workload(2, false, create);
    rotated_workload(2, true, create);

    std::array<fullmag_fdm_gpu_transport_charge_cell_v1, cells> base_cells{};
    for (auto &cell_record : base_cells) {
        init_record(cell_record, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        cell_record.active = 1;
        cell_record.conductor = 1;
        cell_record.material_index = 0;
    }
    fullmag_fdm_gpu_transport_charge_material_v1 base_material{};
    init_record(base_material, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    base_material.material_index = 0;
    base_material.conductivity = sigma;
    base_material.material_revision = 1;
    fullmag_fdm_gpu_transport_charge_formula_ids_v1 base_formula{};
    init_record(base_formula, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    base_formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    base_formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    base_formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    base_formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    base_formula.operator_revision = 1;
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> base_faces;
    base_faces.reserve(2 + 4 * nx);
    base_faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY,
                              0, -1, 0, 0, h * h, -imposed_j, 1));
    base_faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE,
                              0, +1, nx - 1, nx, h * h, 0.0, 2));
    for (uint64_t x = 0; x < nx; ++x) {
        base_faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                                  1, -1, x, x, h * h, 0.0, 3 + base_faces.size()));
        base_faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                                  1, +1, x, x + nx, h * h, 0.0, 3 + base_faces.size()));
        base_faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                                  2, -1, x, x, h * h, 0.0, 3 + base_faces.size()));
        base_faces.push_back(face(FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                                  2, +1, x, x + nx, h * h, 0.0, 3 + base_faces.size()));
    }
    std::array<uint8_t, 1> empty{{0}};

    auto descriptor_for = [&](auto &cell_records, auto &materials, auto &faces,
                              auto &formula, uint8_t digest_byte) {
        std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
            view(cell_records.data(), cell_records.size(), sizeof(cell_records[0]),
                 FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
            view(materials.data(), materials.size(), sizeof(materials[0]),
                 FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
            view(empty.data(), 0, sizeof(empty[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
            view(faces.data(), faces.size(), sizeof(faces[0]),
                 FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
            view(empty.data(), 0, sizeof(empty[0]), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
            view(&formula, 1, sizeof(formula), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        }};
        fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
        init_record(descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        descriptor.grid[0] = nx; descriptor.grid[1] = ny; descriptor.grid[2] = nz;
        descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = h;
        descriptor.descriptor_revision = 1;
        descriptor.source_revision = 1;
        std::fill(std::begin(descriptor.descriptor_digest),
                  std::end(descriptor.descriptor_digest), digest_byte);
        descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
        descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
        descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
        descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
        descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
        descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
        return std::pair{views, descriptor};
    };
    auto bind_views = [](auto &views, auto &descriptor) {
        descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
        descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
        descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
        descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
        descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
        descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    };

    auto rejected = [&](uint32_t mutation) {
        auto cell_records = base_cells;
        std::array<fullmag_fdm_gpu_transport_charge_material_v1, 1> materials{{base_material}};
        auto faces = base_faces;
        auto formula = base_formula;
        uint32_t expected = FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
        switch (mutation) {
        case 0: cell_records[0].abi_version = 2; expected = FULLMAG_FDM_GPU_TRANSPORT_ERROR_INCOMPATIBLE_ABI; break;
        case 1: cell_records[0].struct_size = sizeof(cell_records[0]) - 1;
                expected = FULLMAG_FDM_GPU_TRANSPORT_ERROR_INCOMPATIBLE_ABI; break;
        case 2: cell_records[0].reserved1 = 1; break;
        case 3: formula.formula_id = 2; break;
        case 4: faces[0].kind = 99; break;
        case 5: faces[0].adjacent_cell = 1; break;
        case 6: cell_records[0].active = 0; cell_records[0].conductor = 0; break;
        case 7: faces.push_back(faces[0]); faces.back().source_id = 99; break;
        case 8: faces[0].value = std::numeric_limits<double>::quiet_NaN(); break;
        case 9: faces[0].area *= 2.0; break;
        case 10: faces[0].outward_sign = +1; break;
        case 11: ++faces[0].canonical_face_index; break;
        case 12: faces[2].value = 1.0; break;
        case 13: faces.pop_back(); break;
        case 14: faces.erase(faces.begin()); break;
        case 15: faces.erase(faces.begin() + faces.size() / 2); break;
        default: require(false, "unknown test mutation");
        }
        fullmag_fdm_gpu_transport_context_create_result_v1 created{};
        init_record(created);
        require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "mutation context creation failed");
        auto [views, descriptor] = descriptor_for(
            cell_records, materials, faces, formula, static_cast<uint8_t>(0x20 + mutation));
        bind_views(views, descriptor);
        const uint32_t actual = fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
            created.context_handle, &descriptor);
        if (actual != expected)
            std::fprintf(stderr, "mutation=%u expected=%u actual=%u\n", mutation, expected, actual);
        require(actual == expected,
                "typed mutation did not fail with the exact status");
        uint64_t telemetry_count = UINT64_MAX;
        require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                    created.context_handle, 0, nullptr, 0, &telemetry_count) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && telemetry_count == 0,
                "rejected upload published telemetry state");
        uint64_t builds = 9, hits = 9, applies = 9, fallbacks = 9, fine = 9, coarse = 9;
        uint32_t levels = 9;
        std::array<uint8_t, 32> digest{};
        require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                    created.context_handle, &builds, &hits, &applies, &fallbacks,
                    &fine, &coarse, &levels, digest.data()) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                    builds == 0 && hits == 0 && applies == 0 && fallbacks == 0 &&
                    fine == 0 && coarse == 0 && levels == 0,
                "rejected upload changed hierarchy/solver state");
        fullmag_fdm_gpu_charge_solve_request_v1 solve{};
        init_record(solve);
        solve.context_handle = created.context_handle;
        solve.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
        solve.gauge_policy = FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
        solve.source_revision = solve.static_revision = 1;
        solve.relative_tolerance = 1.0e-12;
        solve.max_iterations = 64;
        fullmag_fdm_gpu_charge_solve_result_v1 solved{};
        init_record(solved);
        require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
                "rejected upload left executable scientific state");
        require(fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "mutation context teardown failed");
    };
    for (uint32_t mutation = 0; mutation < mutation_count; ++mutation) rejected(mutation);

    auto cell_records = base_cells;
    std::array<fullmag_fdm_gpu_transport_charge_material_v1, 1> materials{{base_material}};
    auto faces = base_faces;
    auto formula = base_formula;
    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "valid mixed-boundary context creation failed");
    auto [views, descriptor] = descriptor_for(cell_records, materials, faces, formula, 0x7d);
    bind_views(views, descriptor);
    const uint32_t valid_upload = fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
        created.context_handle, &descriptor);
    if (valid_upload != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        std::fprintf(stderr, "valid upload status=%u face_count=%zu\n",
                     valid_upload, faces.size());
    require(valid_upload == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "valid exact-density/voltage/insulating descriptor upload failed");
    auto m1_to_absent = descriptor;
    m1_to_absent.required_features = 0;
    m1_to_absent.masks_view_ptr = UINT64_C(0x1);
    m1_to_absent.materials_view_ptr = UINT64_C(0x3);
    m1_to_absent.interfaces_view_ptr = UINT64_C(0x5);
    m1_to_absent.charge_faces_view_ptr = UINT64_C(0x7);
    m1_to_absent.spin_faces_view_ptr = UINT64_C(0x9);
    m1_to_absent.formula_ids_view_ptr = UINT64_C(0xb);
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                created.context_handle, &m1_to_absent) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_STATE,
            "idempotent M1 descriptor accepted a module-absence transition");
    fullmag_fdm_gpu_charge_solve_request_v1 solve{};
    init_record(solve);
    solve.context_handle = created.context_handle;
    solve.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    solve.gauge_policy = FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    solve.attempt_id = solve.stage_id = solve.source_revision = solve.static_revision = 1;
    solve.relative_tolerance = 1.0e-12;
    solve.max_iterations = 128;
    fullmag_fdm_gpu_charge_solve_result_v1 solved{};
    init_record(solved);
    uint64_t baseline_generation = 0;
    uint64_t baseline_sequence = 0;
    uint64_t baseline_telemetry_count = 0;
    require(fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
                created.context_handle, &baseline_generation, &baseline_sequence,
                &baseline_telemetry_count) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "runtime counter query failed");
    require(fullmag_fdm_gpu_transport_test_set_runtime_counters_v1(
                created.context_handle, UINT64_MAX - 1, baseline_sequence) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "provisional overflow hook failed");
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
            "provisional generation overflow did not fail before solve");
    uint64_t observed_generation = 0;
    uint64_t observed_sequence = 0;
    uint64_t observed_telemetry_count = 0;
    require(fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
                created.context_handle, &observed_generation, &observed_sequence,
                &observed_telemetry_count) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                observed_generation == UINT64_MAX - 1 &&
                observed_sequence == baseline_sequence &&
                observed_telemetry_count == baseline_telemetry_count,
            "rejected provisional overflow mutated runtime state");
    require(fullmag_fdm_gpu_transport_test_set_runtime_counters_v1(
                created.context_handle, baseline_generation, UINT64_MAX - 1) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "telemetry overflow hook failed");
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OUT_OF_RESOURCES,
            "telemetry sequence overflow did not fail before solve");
    require(fullmag_fdm_gpu_transport_test_get_runtime_counters_v1(
                created.context_handle, &observed_generation, &observed_sequence,
                &observed_telemetry_count) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                observed_generation == baseline_generation &&
                observed_sequence == UINT64_MAX - 1 &&
                observed_telemetry_count == baseline_telemetry_count,
            "rejected telemetry overflow mutated runtime state or emitted sequence zero");
    require(fullmag_fdm_gpu_transport_test_set_runtime_counters_v1(
                created.context_handle, baseline_generation, baseline_sequence) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "runtime counter reset failed");
    solve.relative_tolerance = 1.0e-15;
    solve.max_iterations = 1;
    init_record(solved);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_NONCONVERGED,
            "one-iteration cold solve must exercise transactional cache rollback");
    solve.relative_tolerance = 1.0e-12;
    solve.max_iterations = 128;
    init_record(solved);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                solved.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            "valid mixed-boundary device solve failed");
    uint64_t retry_builds = 0, retry_hits = 0, retry_applies = 0,
             retry_fallbacks = 0, retry_fine = 0, retry_coarse = 0;
    uint32_t retry_levels = 0;
    std::array<uint8_t, 32> retry_digest{};
    require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                created.context_handle, &retry_builds, &retry_hits, &retry_applies,
                &retry_fallbacks, &retry_fine, &retry_coarse, &retry_levels,
                retry_digest.data()) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                retry_builds == 1 && retry_hits == 0,
            "retry after rejected cold solve must rebuild provisional hierarchy");
    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, solved.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "valid mixed-boundary snapshot acceptance failed");
    std::array<double, (nx + 1) * ny * nz> jx{};
    auto destination = view(jx.data(), jx.size(), sizeof(double),
                            FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64);
    destination.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    destination.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ;
    fullmag_fdm_gpu_transport_artifact_request_v1 artifact{};
    init_record(artifact, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                              FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    artifact.context_handle = created.context_handle;
    artifact.snapshot_handle = snapshot.snapshot_handle;
    artifact.field_id = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C;
    artifact.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    artifact.range_count = jx.size();
    artifact.destination_view_ptr = reinterpret_cast<uint64_t>(&destination);
    artifact.expected_bytes = jx.size() * sizeof(double);
    artifact.accepted_sequence = snapshot.accepted_sequence;
    auto incomplete_artifact_features = artifact;
    incomplete_artifact_features.required_features =
        FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(
                &incomplete_artifact_features) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE,
            "artifact readback without M1 charge feature must fail closed");
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(&artifact) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "valid mixed-boundary Jx readback failed");
    for (double value : jx)
        require(std::abs(value - imposed_j) <= 1.0e-10,
                "exact-density/voltage current reconstruction mismatch");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "valid mixed-boundary token teardown failed");

    const char *evidence_path = std::getenv("FULLMAG_FDM_GPU_M1_CHARGE_MUTATION_EVIDENCE_PATH");
    require(evidence_path != nullptr && evidence_path[0] != '\0', "mutation evidence path is required");
    std::ofstream evidence(evidence_path, std::ios::trunc);
    require(evidence.good(), "cannot create mutation evidence JSON");
    evidence << "{\n  \"workload\": \"charge_boundary_mutation_v1\",\n"
             << "  \"device_ordinal\": " << device << ",\n"
             << "  \"device_name\": \"" << device_properties.name << "\",\n"
             << "  \"device_uuid\": \"" << hex(created.device_uuid, 16) << "\",\n"
             << "  \"compute_major\": " << created.compute_major << ",\n"
             << "  \"compute_minor\": " << created.compute_minor << ",\n"
             << "  \"cuda_runtime\": " << created.cuda_runtime << ",\n"
             << "  \"cuda_driver\": " << created.cuda_driver << ",\n"
             << "  \"build_digest\": \"" << hex(created.build_digest, 32) << "\",\n"
             << "  \"engine_id\": \"fdm_charge_cg_cuda_v1\",\n"
             << "  \"operator_id\": \"fv_charge_harmonic_v1\",\n"
             << "  \"residual_id\": \"fixed_tree_fp64_v1\",\n"
             << "  \"mutation_count\": " << mutation_count << ",\n"
             << "  \"valid_boundary_kinds\": [\"exact_density\", \"voltage\", \"insulating\"],\n"
             << "  \"rejected_state_unchanged\": true,\n"
             << "  \"host_fallback_count\": 0\n}\n";
    require(evidence.good(), "failed to commit mutation evidence JSON");
    return 0;
}
