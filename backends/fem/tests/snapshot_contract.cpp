/*
 * snapshot_contract.cpp - native FEM runtime snapshot ownership contracts.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "backend_handle.hpp"
#include "fullmag_fem.h"

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include "gpu/cuda/fields/vector_field_kernels.hpp"
#endif

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

void snapshot_stats_are_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string snapshot =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.cpp");
    const std::string snapshot_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.hpp");

    check(
        bridge.find("bool context_snapshot_stats_mfem(") == std::string::npos,
        "MFEM snapshot stats must not be defined in mfem_bridge.cpp");
    check(
        context_header.find("bool context_snapshot_stats_mfem(") == std::string::npos,
        "MFEM snapshot stats declaration must not live in context.hpp");
    check(
        snapshot.find("bool context_snapshot_stats_mfem(") != std::string::npos,
        "MFEM snapshot stats must be defined in runtime/snapshot.cpp");
    check(
        snapshot_header.find("Capture native FEM scalar statistics") != std::string::npos,
        "snapshot header must document scalar snapshot ownership");
}

void demag_phi_snapshot_contract_is_declared() {
    const std::filesystem::path root = fem_source_root();
    const std::string header =
        read_text_file(root.parent_path().parent_path() / "native" / "include" / "fullmag_fem.h");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.cpp");

    check(
        header.find("FULLMAG_FEM_OBSERVABLE_DEMAG_PHI") != std::string::npos,
        "C ABI must declare a demag scalar-potential observable");
    check(
        api.find("FULLMAG_FEM_OBSERVABLE_DEMAG_PHI") != std::string::npos &&
            api.find("component_count = 1") != std::string::npos,
        "native snapshot API must expose demag phi as a scalar component payload");
    check(
        state_io.find("copy_demag_phi_observable_f64") != std::string::npos &&
            state_io.find("gf_potential") != std::string::npos,
        "state I/O must copy demag phi from the MFEM scalar-potential grid function");
}

void gpu_snapshot_preserves_full_domain_observable_fields() {
    const std::filesystem::path root = fem_source_root();
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.cpp");
    const std::string snapshot =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "snapshot.cpp");

    const std::size_t source_begin = api.find("gpu_snapshot_source_field(");
    const std::size_t source_end = api.find("#if FULLMAG_HAS_CUDA_RUNTIME", source_begin);
    check(
        source_begin != std::string::npos && source_end != std::string::npos,
        "GPU snapshot source selector must be present and bounded");
    const std::string source = api.substr(source_begin, source_end - source_begin);

    check(
        source.find("fields.h_demag") == std::string::npos,
        "GPU snapshots must not publish the material-masked LLG H_demag as a full-domain observable");
    check(
        source.find("demag_poisson.poisson_gradient") != std::string::npos,
        "strict GPU H_demag snapshots must source the recovered full-domain Poisson gradient");
    check(
        state_io.find("full_domain_visual_field_source") != std::string::npos &&
            state_io.find("ctx.demag.h_visual_xyz") != std::string::npos &&
            state_io.find("ctx.effective_field.h_visual_xyz") != std::string::npos,
        "full-domain GPU demag/effective-field snapshots must fall back to the visual observable buffers");
    check(
        api.find("prepare_gpu_full_domain_snapshot(") != std::string::npos &&
            api.find("recover_device_demag_full_domain_field_device(") != std::string::npos &&
            snapshot.find("recover_device_demag_visual_field(") != std::string::npos,
        "GPU full-domain snapshots must recover current Poisson H_demag before scheduling readback");
    check(
        api.find("fullmag_cuda_apply_full_domain_demag_correction(") != std::string::npos,
        "GPU full-domain H_eff snapshots must combine current magnetic and full-domain demag in staging");
    const std::size_t staging_done =
        api.find("cudaEventRecord(staging_done_event, io_stream)");
    const std::size_t compute_wait =
        api.find("cudaStreamWaitEvent(compute_stream, staging_done_event, 0)", staging_done);
    check(
        staging_done != std::string::npos && compute_wait != std::string::npos,
        "GPU snapshot staging must complete before the compute stream can mutate source fields");
    check(
        api.find("FEM GPU full-domain H_eff snapshot requires allocated demag component buffers") !=
            std::string::npos,
        "GPU full-domain H_eff composition must fail closed when either demag field is unallocated");
}

#if FULLMAG_HAS_CUDA_RUNTIME
void gpu_snapshot_fallback_reads_full_domain_demag_instead_of_masked_device_field() {
    int device_count = 0;
    if (cudaGetDeviceCount(&device_count) != cudaSuccess || device_count == 0) {
        return;
    }

    fullmag_fem_backend backend;
    auto &ctx = backend.context;
    ctx.mesh.n_nodes = 2;
    ctx.gpu_state.device.lifecycle.allocated = true;
    ctx.gpu_state.device.lifecycle.node_count = 2;
    ctx.demag.enabled = true;
    ctx.demag.h_xyz.assign(6, 0.0);
    ctx.demag.h_visual_xyz = {11.0, 12.0, 13.0, 14.0, 15.0, 16.0};

    auto &masked = ctx.gpu_state.device.fields.h_demag;
    check(cudaMalloc(&masked.x, 2 * sizeof(double)) == cudaSuccess, "allocate masked H_demag x");
    check(cudaMalloc(&masked.y, 2 * sizeof(double)) == cudaSuccess, "allocate masked H_demag y");
    check(cudaMalloc(&masked.z, 2 * sizeof(double)) == cudaSuccess, "allocate masked H_demag z");
    check(cudaMemset(masked.x, 0, 2 * sizeof(double)) == cudaSuccess, "zero masked H_demag x");
    check(cudaMemset(masked.y, 0, 2 * sizeof(double)) == cudaSuccess, "zero masked H_demag y");
    check(cudaMemset(masked.z, 0, 2 * sizeof(double)) == cudaSuccess, "zero masked H_demag z");

    fullmag_fem_preview_snapshot *snapshot = fullmag_fem_backend_begin_preview_snapshot(
        &backend,
        FULLMAG_FEM_OBSERVABLE_H_DEMAG);
    check(snapshot != nullptr, "begin full-domain H_demag snapshot");

    const void *data = nullptr;
    uint64_t len_bytes = 0;
    fullmag_fem_snapshot_desc desc{};
    check(
        fullmag_fem_preview_snapshot_wait(snapshot, &data, &len_bytes, &desc) == FULLMAG_FEM_OK,
        "wait for full-domain H_demag snapshot");
    check(
        desc.node_count == 2 && desc.component_count == 3 && len_bytes == 6 * sizeof(double),
        "full-domain H_demag snapshot layout");
    const auto *values = static_cast<const double *>(data);
    check(
        values[0] == 11.0 && values[1] == 12.0 && values[2] == 13.0 &&
            values[3] == 14.0 && values[4] == 15.0 && values[5] == 16.0,
        "GPU snapshot fallback must publish full-domain H_demag rather than the zeroed LLG buffer");

    fullmag_fem_preview_snapshot_destroy(snapshot);
    cudaFree(masked.x);
    cudaFree(masked.y);
    cudaFree(masked.z);
    masked = {};
}

void gpu_snapshot_composes_full_domain_effective_field_in_staging() {
    int device_count = 0;
    if (cudaGetDeviceCount(&device_count) != cudaSuccess || device_count == 0) {
        return;
    }

    const double full_host[2] = {2.0, 3.0};
    const double magnetic_host[2] = {0.0, 1.0};
    const double effective_host[2] = {5.0, 7.0};
    double *full = nullptr;
    double *magnetic = nullptr;
    double *effective = nullptr;
    check(cudaMalloc(&full, sizeof(full_host)) == cudaSuccess, "allocate full-domain demag");
    check(cudaMalloc(&magnetic, sizeof(magnetic_host)) == cudaSuccess, "allocate magnetic demag");
    check(cudaMalloc(&effective, sizeof(effective_host)) == cudaSuccess, "allocate effective staging");
    check(cudaMemcpy(full, full_host, sizeof(full_host), cudaMemcpyHostToDevice) == cudaSuccess,
        "upload full-domain demag");
    check(cudaMemcpy(magnetic, magnetic_host, sizeof(magnetic_host), cudaMemcpyHostToDevice) == cudaSuccess,
        "upload magnetic demag");
    check(cudaMemcpy(effective, effective_host, sizeof(effective_host), cudaMemcpyHostToDevice) == cudaSuccess,
        "upload effective staging");

    fullmag::fem::fullmag_cuda_apply_full_domain_demag_correction(
        full,
        magnetic,
        effective,
        2);
    check(cudaDeviceSynchronize() == cudaSuccess, "synchronize full-domain H_eff correction");
    double result[2] = {};
    check(cudaMemcpy(result, effective, sizeof(result), cudaMemcpyDeviceToHost) == cudaSuccess,
        "download full-domain H_eff correction");
    check(result[0] == 7.0 && result[1] == 9.0,
        "full-domain H_eff must equal magnetic H_eff plus the demag continuation");

    cudaFree(full);
    cudaFree(magnetic);
    cudaFree(effective);
}
#endif

} // namespace

int main() {
    snapshot_stats_are_owned_by_runtime_module();
    demag_phi_snapshot_contract_is_declared();
    gpu_snapshot_preserves_full_domain_observable_fields();
#if FULLMAG_HAS_CUDA_RUNTIME
    gpu_snapshot_fallback_reads_full_domain_demag_instead_of_masked_device_field();
    gpu_snapshot_composes_full_domain_effective_field_in_staging();
#endif
    return 0;
}
