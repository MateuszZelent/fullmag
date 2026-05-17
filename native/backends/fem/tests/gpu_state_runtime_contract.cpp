/*
 * gpu_state_runtime_contract.cpp - native FEM GPU-state bootstrap contract.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/gpu_state_runtime.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::string extract_function_body(const std::string &source, const std::string &signature) {
    const size_t signature_pos = source.find(signature);
    check(signature_pos != std::string::npos, "function signature not found");

    const size_t body_start = source.find('{', signature_pos);
    check(body_start != std::string::npos, "function body start not found");

    int depth = 0;
    for (size_t i = body_start; i < source.size(); ++i) {
        if (source[i] == '{') {
            ++depth;
        } else if (source[i] == '}') {
            --depth;
            if (depth == 0) {
                return source.substr(body_start, i - body_start + 1);
            }
        }
    }
    check(false, "function body end not found");
    return {};
}

void gpu_state_bootstrap_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string runtime =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "gpu_state_runtime.cpp");
    const std::string runtime_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "gpu_state_runtime.hpp");
    const std::string context_from_plan = extract_function_body(
        context,
        "bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error)");

    check(
        context_from_plan.find("initialize_context_gpu_state(ctx, error)") != std::string::npos,
        "context_from_plan must delegate GPU-state bootstrap to gpu_state_runtime.cpp");
    check(
        context_from_plan.find("gpu_state_initialize(") == std::string::npos,
        "context_from_plan must not own GPU-state allocation");
    check(
        context_from_plan.find("gpu_state_upload_runtime_coefficients(") == std::string::npos,
        "context_from_plan must not own runtime coefficient GPU upload");
    check(
        context_from_plan.find("gpu_state_upload_mesh_geometry(") == std::string::npos,
        "context_from_plan must not own mesh geometry GPU upload");
    check(
        context_from_plan.find("gpu_state_upload_effective_fields_aos(") == std::string::npos,
        "context_from_plan must not own effective-field GPU upload");
    check(
        context_from_plan.find("gpu_state_upload_local_vector_fields_aos(") == std::string::npos,
        "context_from_plan must not own local vector field GPU upload");
    check(
        runtime.find("bool initialize_context_gpu_state(") != std::string::npos,
        "GPU-state bootstrap must be defined in gpu_state_runtime.cpp");
    check(
        runtime.find("gpu_state_upload_runtime_coefficients(") != std::string::npos,
        "gpu_state_runtime.cpp must upload runtime coefficients");
    check(
        runtime.find("gpu_state_upload_mesh_geometry(") != std::string::npos,
        "gpu_state_runtime.cpp must upload mesh geometry");
    check(
        runtime.find("gpu_state_upload_effective_fields_aos(") != std::string::npos,
        "gpu_state_runtime.cpp must upload effective fields");
    check(
        runtime.find("gpu_state_upload_local_vector_fields_aos(") != std::string::npos,
        "gpu_state_runtime.cpp must upload local vector fields");
    check(
        runtime_header.find("Initialize and upload native FEM GPU state runtime buffers") !=
            std::string::npos,
        "gpu_state_runtime header must document GPU-state bootstrap ownership");
}

void no_cuda_bootstrap_initializes_host_resident_gpu_metadata() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 4;
    ctx.integrator = FULLMAG_FEM_INTEGRATOR_RK45_DP54;
    ctx.m_xyz = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
    };
    ctx.h_ex_xyz.assign(12, 0.0);
    ctx.h_demag_xyz.assign(12, 0.0);
    ctx.h_ext_xyz.assign(12, 0.0);
    ctx.h_eff_xyz.assign(12, 0.0);
    ctx.h_ani_xyz.assign(12, 0.0);
    ctx.h_cubic_ani_xyz.assign(12, 0.0);
    ctx.h_dmi_xyz.assign(12, 0.0);
    ctx.h_bulk_dmi_xyz.assign(12, 0.0);
    ctx.h_oe_xyz.assign(12, 0.0);
    ctx.h_therm_xyz.assign(12, 0.0);
    ctx.h_mel_xyz.assign(12, 0.0);
    ctx.node_volumes.assign(4, 0.25);
    ctx.Ms_field.assign(4, 800e3);
    ctx.A_field.assign(4, 13e-12);
    ctx.alpha_field.assign(4, 0.1);
    ctx.magnetic_node_mask.assign(4, 1);
    ctx.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.elements = {0, 1, 2, 3};
    ctx.magnetic_element_mask.assign(1, 1);
    ctx.material.saturation_magnetisation = 800e3;
    ctx.material.exchange_stiffness = 13e-12;
    ctx.material.damping = 0.1;
    ctx.device_info_cache.is_gpu_enabled = 0;
    ctx.device_info_valid = true;

    std::string error;
    check(
        fullmag::fem::initialize_context_gpu_state(ctx, error),
        "host-resident GPU-state bootstrap should succeed without CUDA allocation");
    check(ctx.gpu_state.initialized, "GPU-state metadata must be initialized");
    check(!ctx.gpu_state.allocated, "no-CUDA host bootstrap must not allocate device state");
    check(ctx.gpu_state.node_count == 4, "GPU-state node count mismatch");
    check(ctx.gpu_state.dof_len == 12, "GPU-state DOF length mismatch");
    check(ctx.gpu_state.stage_count == 7, "GPU-state stage count mismatch");
}

} // namespace

int main() {
    gpu_state_bootstrap_is_owned_by_runtime_module();
    no_cuda_bootstrap_initializes_host_resident_gpu_metadata();
    return 0;
}
