/* fem_mesh_contract.cpp - typed native FEM mesh ABI and core contract. */

#include "context.hpp"
#include "core/fem_mesh.hpp"

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

static_assert(sizeof(fullmag_fem_mesh_desc) == 232u, "typed mesh ABI size");
static_assert(alignof(fullmag_fem_mesh_desc) == 8u, "typed mesh ABI alignment");
static_assert(offsetof(fullmag_fem_mesh_desc, abi_version) == 0u, "abi_version offset");
static_assert(offsetof(fullmag_fem_mesh_desc, struct_size) == 4u, "struct_size offset");
static_assert(offsetof(fullmag_fem_mesh_desc, nodes_xyz) == 8u, "nodes_xyz offset");
static_assert(offsetof(fullmag_fem_mesh_desc, nodes_xyz_len) == 16u, "nodes_xyz_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_types) == 24u, "cell_types offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_types_len) == 32u, "cell_types_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_offsets) == 40u, "cell_offsets offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_offsets_len) == 48u, "cell_offsets_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_nodes) == 56u, "cell_nodes offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_nodes_len) == 64u, "cell_nodes_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_global_ordinals) == 72u, "cell_global_ordinals offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_global_ordinals_len) == 80u, "cell_global_ordinals_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_markers) == 88u, "cell_markers offset");
static_assert(offsetof(fullmag_fem_mesh_desc, cell_markers_len) == 96u, "cell_markers_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_types) == 104u, "facet_types offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_types_len) == 112u, "facet_types_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_roles) == 120u, "facet_roles offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_roles_len) == 128u, "facet_roles_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_offsets) == 136u, "facet_offsets offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_offsets_len) == 144u, "facet_offsets_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_nodes) == 152u, "facet_nodes offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_nodes_len) == 160u, "facet_nodes_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_global_ordinals) == 168u, "facet_global_ordinals offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_global_ordinals_len) == 176u, "facet_global_ordinals_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_markers) == 184u, "facet_markers offset");
static_assert(offsetof(fullmag_fem_mesh_desc, facet_markers_len) == 192u, "facet_markers_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, periodic_node_pairs) == 200u, "periodic_node_pairs offset");
static_assert(offsetof(fullmag_fem_mesh_desc, periodic_node_pairs_len) == 208u, "periodic_node_pairs_len offset");
static_assert(offsetof(fullmag_fem_mesh_desc, periodic_boundary_pair_markers) == 216u, "periodic_boundary_pair_markers offset");
static_assert(offsetof(fullmag_fem_mesh_desc, periodic_boundary_pair_markers_len) == 224u, "periodic_boundary_pair_markers_len offset");
static_assert(sizeof(fullmag_fem_mesh_abi_layout) == 360u, "mesh ABI query size");
static_assert(alignof(fullmag_fem_mesh_abi_layout) == 8u, "mesh ABI query alignment");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, abi_version) == 0u, "mesh ABI query version offset");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, struct_size) == 4u, "mesh ABI query size offset");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, mesh_desc_abi_version) == 8u, "mesh ABI descriptor version offset");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, mesh_desc_struct_size) == 12u, "mesh ABI descriptor size offset");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, field_count) == 16u, "mesh ABI field count offset");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, reserved) == 20u, "mesh ABI reserved offset");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, field_offsets) == 24u, "mesh ABI offsets offset");
static_assert(offsetof(fullmag_fem_mesh_abi_layout, layout_fingerprint) == 264u, "mesh ABI fingerprint offset");
static_assert(sizeof(fullmag_fem_mesh_abi_record) == 416u, "mesh ABI record size");
static_assert(alignof(fullmag_fem_mesh_abi_record) == 8u, "mesh ABI record alignment");
static_assert(offsetof(fullmag_fem_mesh_abi_record, magic) == 0u, "mesh ABI record magic offset");
static_assert(offsetof(fullmag_fem_mesh_abi_record, record_version) == 40u, "mesh ABI record version offset");
static_assert(offsetof(fullmag_fem_mesh_abi_record, record_size) == 44u, "mesh ABI record size offset");
static_assert(offsetof(fullmag_fem_mesh_abi_record, endian_tag) == 48u, "mesh ABI record endian offset");
static_assert(offsetof(fullmag_fem_mesh_abi_record, reserved) == 52u, "mesh ABI record reserved offset");
static_assert(offsetof(fullmag_fem_mesh_abi_record, layout) == 56u, "mesh ABI record layout offset");

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

struct MeshBuffers {
    std::vector<double> nodes_xyz{
        0, 0, 0,  1, 0, 0,  0, 1, 0,  0, 0, 1,
        2, 0, 0,  3, 0, 0,  2, 1, 0,  2, 0, 1,  3, 0, 1,  2, 1, 1,
        4, 0, 0,  5, 0, 0,  5, 1, 0,  4, 1, 0,  4.5, 0.5, 1,
        6, 0, 0,  7, 0, 0,  7, 1, 0,  6, 1, 0,
        6, 0, 1,  7, 0, 1,  7, 1, 1,  6, 1, 1,
    };
    std::vector<uint32_t> cell_types{
        FULLMAG_FEM_CELL_TET4,
        FULLMAG_FEM_CELL_PRISM6,
        FULLMAG_FEM_CELL_PYRAMID5,
        FULLMAG_FEM_CELL_HEX8,
    };
    std::vector<uint32_t> cell_offsets{0u, 4u, 10u, 15u, 23u};
    std::vector<uint32_t> cell_nodes{
        0u, 1u, 2u, 3u,
        4u, 5u, 6u, 7u, 8u, 9u,
        10u, 11u, 12u, 13u, 14u,
        15u, 16u, 17u, 18u, 19u, 20u, 21u, 22u,
    };
    std::vector<uint64_t> cell_global_ordinals{100u, 101u, 102u, 103u};
    std::vector<uint32_t> cell_markers{7u, 7u, 0u, 0u};
    std::vector<uint32_t> facet_types{
        FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_QUAD4,
        FULLMAG_FEM_FACET_TRI3,
    };
    std::vector<uint32_t> facet_roles{
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE,
        FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM,
    };
    std::vector<uint32_t> facet_offsets{0u, 3u, 7u, 10u};
    std::vector<uint32_t> facet_nodes{0u, 2u, 1u, 4u, 5u, 8u, 7u, 15u, 16u, 17u};
    std::vector<uint64_t> facet_global_ordinals{700u, 701u, 702u};
    std::vector<uint32_t> facet_markers{3u, 4u, 5u};
    std::vector<uint32_t> periodic_node_pairs{15u, 16u};
    std::vector<uint32_t> periodic_boundary_pair_markers{5u, 6u};
    std::vector<double> ms_field;
    std::vector<double> a_field;
    std::vector<double> alpha_field;
    std::vector<double> ms_element_field;

    fullmag_fem_mesh_desc desc() const {
        fullmag_fem_mesh_desc mesh{};
        mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
        mesh.struct_size = sizeof(fullmag_fem_mesh_desc);
        mesh.nodes_xyz = nodes_xyz.data();
        mesh.nodes_xyz_len = nodes_xyz.size();
        mesh.cell_types = cell_types.data();
        mesh.cell_types_len = cell_types.size();
        mesh.cell_offsets = cell_offsets.data();
        mesh.cell_offsets_len = cell_offsets.size();
        mesh.cell_nodes = cell_nodes.data();
        mesh.cell_nodes_len = cell_nodes.size();
        mesh.cell_global_ordinals = cell_global_ordinals.data();
        mesh.cell_global_ordinals_len = cell_global_ordinals.size();
        mesh.cell_markers = cell_markers.data();
        mesh.cell_markers_len = cell_markers.size();
        mesh.facet_types = facet_types.data();
        mesh.facet_types_len = facet_types.size();
        mesh.facet_roles = facet_roles.data();
        mesh.facet_roles_len = facet_roles.size();
        mesh.facet_offsets = facet_offsets.data();
        mesh.facet_offsets_len = facet_offsets.size();
        mesh.facet_nodes = facet_nodes.data();
        mesh.facet_nodes_len = facet_nodes.size();
        mesh.facet_global_ordinals = facet_global_ordinals.data();
        mesh.facet_global_ordinals_len = facet_global_ordinals.size();
        mesh.facet_markers = facet_markers.data();
        mesh.facet_markers_len = facet_markers.size();
        mesh.periodic_node_pairs = periodic_node_pairs.data();
        mesh.periodic_node_pairs_len = periodic_node_pairs.size();
        mesh.periodic_boundary_pair_markers = periodic_boundary_pair_markers.data();
        mesh.periodic_boundary_pair_markers_len = periodic_boundary_pair_markers.size();
        return mesh;
    }
};

void expect_rejected(const fullmag_fem_mesh_desc &mesh, const char *needle) {
    fullmag::fem::Context ctx;
    std::string error;
    if (fullmag::fem::initialize_mesh_plan_fields(ctx, mesh, error)) {
        std::fprintf(stderr, "FAIL: invalid typed mesh accepted; expected %s\n", needle);
        std::exit(1);
    }
    check(error.find(needle) != std::string::npos, error.c_str());
}

void typed_mesh_import_copies_every_canonical_buffer() {
    const MeshBuffers source;
    const auto mesh = source.desc();
    fullmag::fem::Context ctx;
    std::string error;
    check(fullmag::fem::initialize_mesh_plan_fields(ctx, mesh, error), error.c_str());
    check(ctx.mesh.n_nodes == 23u, "node count derived from coordinate buffer");
    check(ctx.mesh.n_elements == 4u, "cell count derived from type buffer");
    check(ctx.mesh.n_boundary_faces == 3u, "facet count derived from type buffer");
    check(ctx.mesh.cell_types == source.cell_types, "cell types copied");
    check(ctx.mesh.cell_offsets == source.cell_offsets, "cell offsets copied");
    check(ctx.mesh.cell_nodes == source.cell_nodes, "cell nodes copied");
    check(ctx.mesh.cell_global_ordinals == source.cell_global_ordinals, "cell global ordinals copied");
    check(ctx.mesh.cell_markers == source.cell_markers, "cell markers copied");
    check(ctx.mesh.facet_types == source.facet_types, "facet types copied");
    check(ctx.mesh.facet_roles == source.facet_roles, "facet roles copied");
    check(ctx.mesh.facet_offsets == source.facet_offsets, "facet offsets copied");
    check(ctx.mesh.facet_nodes == source.facet_nodes, "facet nodes copied");
    check(ctx.mesh.facet_global_ordinals == source.facet_global_ordinals, "facet global ordinals copied");
    check(ctx.mesh.facet_markers == source.facet_markers, "facet markers copied");
    check(ctx.mesh.periodic_node_pairs == source.periodic_node_pairs, "periodic nodes copied");
    check(ctx.mesh.periodic_boundary_marker_set.count(5u) == 1u, "periodic marker A copied");
    check(ctx.mesh.periodic_boundary_marker_set.count(6u) == 1u, "periodic marker B copied");
}

void exported_mesh_abi_query_matches_compiled_layout() {
    fullmag_fem_mesh_abi_layout layout{};
    check(fullmag_fem_get_mesh_abi_layout(&layout) == FULLMAG_FEM_OK, "mesh ABI query succeeds");
    check(layout.abi_version == 1u, "mesh ABI query version");
    check(layout.struct_size == sizeof(layout), "mesh ABI query struct size");
    check(layout.mesh_desc_abi_version == FULLMAG_FEM_MESH_DESC_ABI_VERSION, "mesh ABI descriptor version");
    check(layout.mesh_desc_struct_size == sizeof(fullmag_fem_mesh_desc), "mesh ABI descriptor size");
    check(layout.field_count == 30u, "mesh ABI field count");
    const uint64_t expected[] = {0,4,8,16,24,32,40,48,56,64,72,80,88,96,104,112,120,128,136,144,152,160,168,176,184,192,200,208,216,224};
    check(std::equal(std::begin(expected), std::end(expected), layout.field_offsets), "mesh ABI field offsets");
    check(std::string(layout.layout_fingerprint) == FULLMAG_FEM_MESH_DESC_ABI_LAYOUT_FINGERPRINT, "mesh ABI fingerprint");
    check(std::string(fullmag_fem_mesh_abi_record_v1.magic) == FULLMAG_FEM_MESH_ABI_RECORD_MAGIC,
          "embedded mesh ABI record magic");
    check(fullmag_fem_mesh_abi_record_v1.record_version == FULLMAG_FEM_MESH_ABI_RECORD_VERSION,
          "embedded mesh ABI record version");
    check(fullmag_fem_mesh_abi_record_v1.record_size == sizeof(fullmag_fem_mesh_abi_record),
          "embedded mesh ABI record size");
    check(fullmag_fem_mesh_abi_record_v1.endian_tag == FULLMAG_FEM_MESH_ABI_RECORD_ENDIAN_TAG,
          "embedded mesh ABI record endian tag");
    check(std::memcmp(&layout, &fullmag_fem_mesh_abi_record_v1.layout, sizeof(layout)) == 0,
          "runtime query returns the embedded mesh ABI record");
}

MeshBuffers qualified_mixed_operator_mesh() {
    MeshBuffers source;
    source.cell_types.resize(3u);
    source.cell_offsets.resize(4u);
    source.cell_nodes.resize(15u);
    source.cell_global_ordinals.resize(3u);
    source.cell_markers = {0u, 1u, 0u};
    source.facet_types.resize(2u);
    source.facet_roles.resize(2u);
    source.facet_offsets.resize(3u);
    source.facet_nodes.resize(7u);
    source.facet_global_ordinals.resize(2u);
    source.facet_markers.resize(2u);
    source.periodic_node_pairs.clear();
    source.periodic_boundary_pair_markers.clear();
    return source;
}

fullmag_fem_plan_desc qualified_mixed_operator_plan(const MeshBuffers &source) {
    fullmag_fem_plan_desc plan{};
    plan.mesh = source.desc();
    plan.material = {8.0e5, 1.3e-11, 0.1, 2.211e5};
    plan.fe_order = 1;
    plan.hmax = 1.0;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    plan.dt_seconds = 1e-15;
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.mfem_device_string = "cpu";
    return plan;
}

fullmag_fem_regional_field_drive_desc qualified_global_uniform_sinc_drive() {
    fullmag_fem_regional_field_drive_desc drive{};
    drive.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    drive.struct_size = sizeof(drive);
    drive.target.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    drive.target.struct_size = sizeof(drive.target);
    drive.target.kind = FULLMAG_FEM_FIELD_TARGET_GLOBAL;
    drive.spatial_profile.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    drive.spatial_profile.struct_size = sizeof(drive.spatial_profile);
    drive.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_UNIFORM;
    drive.amplitude_b_t = 1.0e-3;
    drive.direction[1] = 1.0;
    drive.waveform.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
    drive.waveform.struct_size = sizeof(drive.waveform);
    drive.waveform.kind = FULLMAG_FEM_TIME_SINC_PULSE;
    drive.waveform.parameters.sinc_pulse = {10.0e9, 2.0e-9, 1.0};
    drive.time_origin = FULLMAG_FEM_TIME_STAGE_LOCAL;
    return drive;
}

void native_physics_gate_accepts_only_qualified_global_uniform_sinc_drive() {
    MeshBuffers source = qualified_mixed_operator_mesh();
    fullmag::fem::Context ctx;
    std::string error;
    check(fullmag::fem::initialize_mesh_plan_fields(ctx, source.desc(), error), error.c_str());

    auto plan = qualified_mixed_operator_plan(source);
    auto drive = qualified_global_uniform_sinc_drive();
    plan.regional_field_drives = &drive;
    plan.regional_field_drive_count = 1;
    for (const char *device : {"cpu", "cuda"}) {
        plan.mfem_device_string = device;
        error.clear();
        check(fullmag::fem::validate_supported_physics_topology(ctx, plan, error), error.c_str());
    }
}

void native_physics_gate_accepts_only_qualified_explicit_cpu_or_cuda_mixed_p1_operator_scope() {
    MeshBuffers source = qualified_mixed_operator_mesh();
    fullmag::fem::Context ctx;
    std::string error;
    check(fullmag::fem::initialize_mesh_plan_fields(ctx, source.desc(), error), error.c_str());
    auto plan = qualified_mixed_operator_plan(source);
    const char *accepted_devices[] = {"cpu", "cuda"};
    for (const char *device : accepted_devices) {
        plan.mfem_device_string = device;
        error.clear();
        check(fullmag::fem::validate_supported_physics_topology(ctx, plan, error), error.c_str());
    }

    for (const char *device : accepted_devices) {
        const size_t node_count = source.nodes_xyz.size() / 3u;
        std::vector<double> ku(node_count, 1.0e5);
        std::vector<double> ku2(node_count, 2.0e4);
        std::vector<double> axis_x(node_count, 0.0);
        std::vector<double> axis_y(node_count, 0.0);
        std::vector<double> axis_z(node_count, 1.0);
        std::vector<double> kc1(node_count, 3.0e4);
        std::vector<double> kc2(node_count, 4.0e3);
        std::vector<double> kc3(node_count, 5.0e2);
        auto local_anisotropy = qualified_mixed_operator_plan(source);
        local_anisotropy.mfem_device_string = device;
        local_anisotropy.has_uniaxial_anisotropy = 1;
        local_anisotropy.uniaxial_anisotropy_constant = 1.0e5;
        local_anisotropy.uniaxial_anisotropy_k2 = 2.0e4;
        local_anisotropy.ku_field = ku.data();
        local_anisotropy.ku_field_len = ku.size();
        local_anisotropy.ku2_field = ku2.data();
        local_anisotropy.ku2_field_len = ku2.size();
        local_anisotropy.anisotropy_axis_x_field = axis_x.data();
        local_anisotropy.anisotropy_axis_x_field_len = axis_x.size();
        local_anisotropy.anisotropy_axis_y_field = axis_y.data();
        local_anisotropy.anisotropy_axis_y_field_len = axis_y.size();
        local_anisotropy.anisotropy_axis_z_field = axis_z.data();
        local_anisotropy.anisotropy_axis_z_field_len = axis_z.size();
        local_anisotropy.has_cubic_anisotropy = 1;
        local_anisotropy.cubic_kc1 = 3.0e4;
        local_anisotropy.cubic_kc2 = 4.0e3;
        local_anisotropy.cubic_kc3 = 5.0e2;
        local_anisotropy.kc1_field = kc1.data();
        local_anisotropy.kc1_field_len = kc1.size();
        local_anisotropy.kc2_field = kc2.data();
        local_anisotropy.kc2_field_len = kc2.size();
        local_anisotropy.kc3_field = kc3.data();
        local_anisotropy.kc3_field_len = kc3.size();
        error.clear();
        check(fullmag::fem::validate_supported_physics_topology(
                  ctx, local_anisotropy, error),
              error.c_str());
    }


    auto cpu_dmi = qualified_mixed_operator_plan(source);
    const size_t dmi_node_count = source.nodes_xyz.size() / 3u;
    std::vector<double> dind(dmi_node_count, 2.0e-3);
    std::vector<double> dbulk(dmi_node_count, 3.0e-3);
    cpu_dmi.mfem_device_string = "cpu";
    cpu_dmi.has_interfacial_dmi = 1;
    cpu_dmi.has_bulk_dmi = 1;
    cpu_dmi.dind_field = dind.data();
    cpu_dmi.dind_field_len = dind.size();
    cpu_dmi.dbulk_field = dbulk.data();
    cpu_dmi.dbulk_field_len = dbulk.size();
    error.clear();
    check(fullmag::fem::validate_supported_physics_topology(ctx, cpu_dmi, error), error.c_str());

    auto cuda_dmi = cpu_dmi;
    cuda_dmi.mfem_device_string = "cuda";
    error.clear();
    check(!fullmag::fem::validate_supported_physics_topology(ctx, cuda_dmi, error),
          "CUDA mixed-P1 DMI must remain rejected before the tetrahedral-only kernel");
    check(error.find("fallback=none") != std::string::npos, error.c_str());

    check(error.find("failed_predicates=[gpu_dmi_kernel_not_mixed_p1]") !=
              std::string::npos,
          error.c_str());
    struct Case {
        const char *name;
        void (*mutate)(fullmag_fem_plan_desc &, MeshBuffers &);
    };
    const Case cases[] = {
        {"missing device", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.mfem_device_string = nullptr;
         }},
        {"empty device", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.mfem_device_string = "";
         }},
        {"auto device", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.mfem_device_string = "auto";
         }},
        {"unknown device", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.mfem_device_string = "hip";
         }},
        {"single", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.precision = FULLMAG_FEM_PRECISION_SINGLE;
         }},
        {"no exchange", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.enable_exchange = 0;
         }},
        {"no demag", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.enable_demag = 0;
         }},
        {"FEM-BEM", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.demag_realization = FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER;
         }},
        {"STT", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.has_zhang_li_stt = 1;
         }},
        {"thermal", [](fullmag_fem_plan_desc &value, MeshBuffers &) {
             value.temperature = 300.0;
         }},
        {"DG0", [](fullmag_fem_plan_desc &value, MeshBuffers &buffers) {
             buffers.ms_element_field.assign(value.mesh.cell_types_len, 8.0e5);
             value.ms_element_field = buffers.ms_element_field.data();
             value.ms_element_field_len = buffers.ms_element_field.size();
         }},
        {"nodal Ms", [](fullmag_fem_plan_desc &value, MeshBuffers &buffers) {
             buffers.ms_field.assign(value.mesh.nodes_xyz_len / 3u, 8.0e5);
             value.ms_field = buffers.ms_field.data();
             value.ms_field_len = buffers.ms_field.size();
         }},
        {"nodal A", [](fullmag_fem_plan_desc &value, MeshBuffers &buffers) {
             buffers.a_field.assign(value.mesh.nodes_xyz_len / 3u, 13.0e-12);
             value.a_field = buffers.a_field.data();
             value.a_field_len = buffers.a_field.size();
         }},
        {"nodal alpha", [](fullmag_fem_plan_desc &value, MeshBuffers &buffers) {
             buffers.alpha_field.assign(value.mesh.nodes_xyz_len / 3u, 0.02);
             value.alpha_field = buffers.alpha_field.data();
             value.alpha_field_len = buffers.alpha_field.size();
         }},
        {"PBC", [](fullmag_fem_plan_desc &value, MeshBuffers &mesh) {
             mesh.periodic_node_pairs = {0u, 1u};
             value.mesh = mesh.desc();
         }},
        {"hex", [](fullmag_fem_plan_desc &value, MeshBuffers &mesh) {
             mesh.cell_types[0] = FULLMAG_FEM_CELL_HEX8;
             value.mesh = mesh.desc();
         }},
    };
    for (const Case &item : cases) {
        MeshBuffers rejected_source = qualified_mixed_operator_mesh();
        fullmag::fem::Context rejected_ctx;
        error.clear();
        check(fullmag::fem::initialize_mesh_plan_fields(
                  rejected_ctx, rejected_source.desc(), error),
              "qualified mixed fixture must import before scope mutation");
        auto rejected = qualified_mixed_operator_plan(rejected_source);
        item.mutate(rejected, rejected_source);
        error.clear();
        check(!fullmag::fem::validate_supported_physics_topology(
                  rejected_ctx, rejected, error),
              item.name);
        check(error.find("mixed P1") != std::string::npos, error.c_str());
        check(error.find("explicit_cpu_or_gpu") != std::string::npos, error.c_str());
        check(error.find("fallback=none") != std::string::npos, error.c_str());
    }
}

MeshBuffers qualified_pure_prism_p2_mesh() {
    MeshBuffers source;
    source.nodes_xyz = {
        0, 0, 0,  1, 0, 0,  0, 1, 0,
        0, 0, 1,  1, 0, 1,  0, 1, 1,
        2, 0, 0,  3, 0, 0,  2, 1, 0,
        2, 0, 1,  3, 0, 1,  2, 1, 1,
    };
    source.cell_types = {FULLMAG_FEM_CELL_PRISM6, FULLMAG_FEM_CELL_PRISM6};
    source.cell_offsets = {0u, 6u, 12u};
    source.cell_nodes = {
        0u, 1u, 2u, 3u, 4u, 5u,
        6u, 7u, 8u, 9u, 10u, 11u,
    };
    source.cell_global_ordinals = {100u, 101u};
    source.cell_markers = {1u, 0u};
    source.facet_types = {FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_QUAD4};
    source.facet_roles = {
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    };
    source.facet_offsets = {0u, 3u, 7u};
    source.facet_nodes = {0u, 2u, 1u, 6u, 7u, 10u, 9u};
    source.facet_global_ordinals = {700u, 701u};
    source.facet_markers = {99u, 99u};
    source.periodic_node_pairs.clear();
    source.periodic_boundary_pair_markers.clear();
    return source;
}

void native_physics_gate_accepts_bounded_cpu_pure_prism_p2_shared_domain() {
    MeshBuffers source = qualified_pure_prism_p2_mesh();
    fullmag::fem::Context ctx;
    std::string error;
    check(fullmag::fem::initialize_mesh_plan_fields(ctx, source.desc(), error), error.c_str());
    auto plan = qualified_mixed_operator_plan(source);
    check(fullmag::fem::validate_supported_physics_topology(ctx, plan, error), error.c_str());

    auto cuda = plan;
    cuda.mfem_device_string = "cuda";
    error.clear();
    check(!fullmag::fem::validate_supported_physics_topology(ctx, cuda, error),
          "pure prism P2 must remain CPU-only until CUDA is qualified");
    check(error.find("pure_prism_p2_cpu_only") != std::string::npos, error.c_str());
    check(error.find("fallback=none") != std::string::npos, error.c_str());

    MeshBuffers missing_air = source;
    missing_air.cell_markers = {1u, 1u};
    fullmag::fem::Context missing_air_ctx;
    error.clear();
    check(fullmag::fem::initialize_mesh_plan_fields(
              missing_air_ctx, missing_air.desc(), error),
          error.c_str());
    auto missing_air_plan = qualified_mixed_operator_plan(missing_air);
    error.clear();
    check(!fullmag::fem::validate_supported_physics_topology(
              missing_air_ctx, missing_air_plan, error),
          "pure prism shared domain without air markers must fail closed");
    check(error.find("prism_shared_domain_magnetic_air_markers") !=
              std::string::npos,
          error.c_str());
}

void typed_mesh_import_accepts_empty_optional_buffers() {
    MeshBuffers source;
    source.facet_types.clear();
    source.facet_roles.clear();
    source.facet_offsets = {0u};
    source.facet_nodes.clear();
    source.facet_global_ordinals.clear();
    source.facet_markers.clear();
    source.periodic_node_pairs.clear();
    source.periodic_boundary_pair_markers.clear();
    const auto mesh = source.desc();
    fullmag::fem::Context ctx;
    std::string error;
    check(fullmag::fem::initialize_mesh_plan_fields(ctx, mesh, error), error.c_str());
    check(ctx.mesh.facet_types.empty(), "empty facets remain empty");
    check(ctx.mesh.periodic_node_pairs.empty(), "empty periodic nodes remain empty");
}

void typed_mesh_import_rejects_bad_version_pointers_and_lengths() {
    MeshBuffers source;
    auto mesh = source.desc();
    mesh.abi_version = 1u;
    expect_rejected(mesh, "ABI version");
    mesh = source.desc();
    mesh.struct_size -= 1u;
    expect_rejected(mesh, "struct_size");
    mesh = source.desc();
    mesh.nodes_xyz = nullptr;
    expect_rejected(mesh, "nodes_xyz pointer");
    mesh = source.desc();
    mesh.nodes_xyz_len -= 1u;
    expect_rejected(mesh, "multiple of 3");
    mesh = source.desc();
    mesh.cell_types = nullptr;
    expect_rejected(mesh, "cell_types pointer");
    mesh = source.desc();
    mesh.cell_offsets_len -= 1u;
    expect_rejected(mesh, "cell_offsets length");
    mesh = source.desc();
    mesh.cell_nodes = nullptr;
    expect_rejected(mesh, "cell_nodes pointer");
    mesh = source.desc();
    mesh.cell_global_ordinals_len -= 1u;
    expect_rejected(mesh, "cell_global_ordinals length");
    mesh = source.desc();
    mesh.cell_markers = nullptr;
    expect_rejected(mesh, "cell_markers pointer");
    mesh = source.desc();
    mesh.facet_roles_len -= 1u;
    expect_rejected(mesh, "facet_roles length");
    mesh = source.desc();
    mesh.facet_offsets = nullptr;
    expect_rejected(mesh, "facet_offsets pointer");
    mesh = source.desc();
    mesh.facet_nodes_len -= 1u;
    expect_rejected(mesh, "facet_offsets final value");
    mesh = source.desc();
    mesh.facet_global_ordinals = nullptr;
    expect_rejected(mesh, "facet_global_ordinals pointer");
    mesh = source.desc();
    mesh.facet_markers_len -= 1u;
    expect_rejected(mesh, "facet_markers length");
    mesh = source.desc();
    mesh.periodic_node_pairs_len = 1u;
    expect_rejected(mesh, "periodic_node_pairs length");
    mesh = source.desc();
    mesh.periodic_boundary_pair_markers = nullptr;
    expect_rejected(mesh, "periodic_boundary_pair_markers pointer");
}

void typed_mesh_import_rejects_invalid_csr_enums_indices_duplicates_and_jacobians() {
    MeshBuffers source;
    auto mesh = source.desc();
    source.cell_offsets[0] = 1u;
    mesh = source.desc();
    expect_rejected(mesh, "cell_offsets must start at zero");
    source.cell_offsets = {0u, 4u, 3u, 15u, 23u};
    mesh = source.desc();
    expect_rejected(mesh, "cell_offsets must be monotonic");
    source = MeshBuffers{};
    source.cell_offsets.back() -= 1u;
    mesh = source.desc();
    expect_rejected(mesh, "cell_offsets final value");
    source = MeshBuffers{};
    source.cell_types[1] = 99u;
    mesh = source.desc();
    expect_rejected(mesh, "cell type");
    source = MeshBuffers{};
    source.cell_offsets[2] = 9u;
    mesh = source.desc();
    expect_rejected(mesh, "cell arity");
    source = MeshBuffers{};
    source.cell_nodes[0] = 99u;
    mesh = source.desc();
    expect_rejected(mesh, "outside mesh");
    source = MeshBuffers{};
    source.cell_nodes[1] = source.cell_nodes[0];
    mesh = source.desc();
    expect_rejected(mesh, "duplicate node");
    source = MeshBuffers{};
    source.cell_global_ordinals[1] = source.cell_global_ordinals[0];
    mesh = source.desc();
    expect_rejected(mesh, "duplicate global ordinal");
    source = MeshBuffers{};
    source.facet_types[0] = 99u;
    mesh = source.desc();
    expect_rejected(mesh, "facet type");
    source = MeshBuffers{};
    source.facet_roles[0] = 99u;
    mesh = source.desc();
    expect_rejected(mesh, "facet role");
    source = MeshBuffers{};
    source.facet_nodes[1] = source.facet_nodes[0];
    mesh = source.desc();
    expect_rejected(mesh, "duplicate node");
    source = MeshBuffers{};
    source.facet_global_ordinals[2] = source.facet_global_ordinals[0];
    mesh = source.desc();
    expect_rejected(mesh, "duplicate global ordinal");
    source = MeshBuffers{};
    std::swap(source.cell_nodes[1], source.cell_nodes[2]);
    mesh = source.desc();
    expect_rejected(mesh, "Jacobian");
}

fullmag_fem_mesh_desc single_facet_mesh(
    MeshBuffers &source,
    uint32_t facet_type,
    const std::vector<std::array<double, 3>> &points) {
    const uint32_t first = static_cast<uint32_t>(source.nodes_xyz.size() / 3u);
    for (const auto &point : points) {
        source.nodes_xyz.insert(source.nodes_xyz.end(), point.begin(), point.end());
    }
    source.facet_types = {facet_type};
    source.facet_roles = {FULLMAG_FEM_FACET_ROLE_EXTERIOR};
    source.facet_offsets = {0u, static_cast<uint32_t>(points.size())};
    source.facet_nodes.clear();
    for (uint32_t i = 0; i < points.size(); ++i) source.facet_nodes.push_back(first + i);
    source.facet_global_ordinals = {900u};
    source.facet_markers = {1u};
    return source.desc();
}

void typed_mesh_import_validates_surface_geometry() {
    MeshBuffers source;
    auto mesh = single_facet_mesh(
        source, FULLMAG_FEM_FACET_TRI3,
        {{{0,0,0}}, {{1,0,0}}, {{2,0,0}}});
    expect_rejected(mesh, "surface Jacobian");

    source = MeshBuffers{};
    mesh = single_facet_mesh(
        source, FULLMAG_FEM_FACET_QUAD4,
        {{{0,0,0}}, {{1,0,0}}, {{1,0,0}}, {{0,1,0}}});
    expect_rejected(mesh, "surface Jacobian");

    source = MeshBuffers{};
    mesh = single_facet_mesh(
        source, FULLMAG_FEM_FACET_QUAD4,
        {{{0,0,0}}, {{1,0,0}}, {{0,1,0}}, {{1,1,0}}});
    expect_rejected(mesh, "surface Jacobian");

    source = MeshBuffers{};
    mesh = single_facet_mesh(
        source, FULLMAG_FEM_FACET_QUAD4,
        {{{0,0,0}}, {{1,0,0.1}}, {{1,1,0.2}}, {{0,1,-0.1}}});
    fullmag::fem::Context ctx;
    std::string error;
    check(fullmag::fem::initialize_mesh_plan_fields(ctx, mesh, error), error.c_str());
}

void typed_mesh_import_rejects_unrepresentable_cardinality_before_reading() {
    MeshBuffers source;
    auto mesh = source.desc();
    mesh.nodes_xyz_len = (static_cast<uint64_t>(UINT32_MAX) + 1u) * 3u;
    expect_rejected(mesh, "32-bit runtime limits");
}

void element_family_tables_cover_all_supported_cells() {
    using fullmag::fem::ElementTopology;
    ElementTopology topology{};
    auto exact = [](const fullmag::fem::LocalEntityTopology &entities,
                    const std::vector<uint8_t> &offsets,
                    const std::vector<uint8_t> &nodes,
                    const char *message) {
        check(std::vector<uint8_t>(entities.offsets, entities.offsets + offsets.size()) == offsets, message);
        check(std::vector<uint8_t>(entities.nodes, entities.nodes + nodes.size()) == nodes, message);
    };
    check(fullmag::fem::element_topology(FULLMAG_FEM_CELL_TET4, topology), "tet topology exists");
    check(topology.arity == 4u && topology.faces.entity_count == 4u && topology.edges.entity_count == 6u, "tet face/edge counts");
    exact(topology.faces, {0,3,6,9,12}, {1,2,3,0,3,2,0,1,3,0,2,1}, "tet MFEM face table");
    exact(topology.edges, {0,2,4,6,8,10,12}, {0,1,1,2,2,0,0,3,1,3,2,3}, "tet edge orientation");
    check(fullmag::fem::element_topology(FULLMAG_FEM_CELL_PRISM6, topology), "prism topology exists");
    check(topology.arity == 6u && topology.faces.entity_count == 5u && topology.edges.entity_count == 9u, "prism face/edge counts");
    exact(topology.faces, {0,3,6,10,14,18}, {0,2,1,3,4,5,0,1,4,3,1,2,5,4,2,0,3,5}, "prism face orientation");
    exact(topology.edges, {0,2,4,6,8,10,12,14,16,18}, {0,1,1,2,2,0,3,4,4,5,5,3,0,3,1,4,2,5}, "prism edge orientation");
    check(fullmag::fem::element_topology(FULLMAG_FEM_CELL_PYRAMID5, topology), "pyramid topology exists");
    check(topology.arity == 5u && topology.faces.entity_count == 5u && topology.edges.entity_count == 8u, "pyramid face/edge counts");
    exact(topology.faces, {0,4,7,10,13,16}, {3,2,1,0,0,1,4,1,2,4,2,3,4,3,0,4}, "pyramid MFEM face table");
    exact(topology.edges, {0,2,4,6,8,10,12,14,16}, {0,1,1,2,2,3,3,0,0,4,1,4,2,4,3,4}, "pyramid edge orientation");
    check(fullmag::fem::element_topology(FULLMAG_FEM_CELL_HEX8, topology), "hex topology exists");
    check(topology.arity == 8u && topology.faces.entity_count == 6u && topology.edges.entity_count == 12u, "hex face/edge counts");
    exact(topology.faces, {0,4,8,12,16,20,24}, {3,2,1,0,0,1,5,4,1,2,6,5,2,3,7,6,3,0,4,7,4,5,6,7}, "hex MFEM face table");
    exact(topology.edges, {0,2,4,6,8,10,12,14,16,18,20,22,24}, {0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7}, "hex edge orientation");
    check(!fullmag::fem::element_topology(99u, topology), "unknown cell topology rejects");
}

} // namespace

int main() {
    typed_mesh_import_copies_every_canonical_buffer();
    exported_mesh_abi_query_matches_compiled_layout();
    native_physics_gate_accepts_only_qualified_global_uniform_sinc_drive();
    native_physics_gate_accepts_only_qualified_explicit_cpu_or_cuda_mixed_p1_operator_scope();
    native_physics_gate_accepts_bounded_cpu_pure_prism_p2_shared_domain();
    typed_mesh_import_accepts_empty_optional_buffers();
    typed_mesh_import_rejects_bad_version_pointers_and_lengths();
    typed_mesh_import_rejects_invalid_csr_enums_indices_duplicates_and_jacobians();
    typed_mesh_import_validates_surface_geometry();
    typed_mesh_import_rejects_unrepresentable_cardinality_before_reading();
    element_family_tables_cover_all_supported_cells();
    return 0;
}
