/*
 * async_snapshot_contract.cpp - native FDM asynchronous snapshot contract.
 *
 * Field and preview snapshots lease bounded persistent CUDA resources.  Solver
 * readiness is observed through an event and all staging/host-download work
 * runs on the private snapshot IO stream; no global device synchronization or
 * per-request CUDA allocation is allowed on the publication path.
 */

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

std::filesystem::path fdm_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::string function_body(const std::string &source, const std::string &signature) {
    const std::size_t start = source.find(signature);
    check(start != std::string::npos, "expected function signature not found");

    const std::size_t body_start = source.find('{', start);
    check(body_start != std::string::npos, "expected function body not found");

    std::size_t depth = 0;
    for (std::size_t i = body_start; i < source.size(); ++i) {
        if (source[i] == '{') {
            ++depth;
        } else if (source[i] == '}') {
            --depth;
            if (depth == 0) {
                return source.substr(body_start, i - body_start + 1);
            }
        }
    }

    std::fprintf(stderr, "FAIL: unterminated function body for %s\n", signature.c_str());
    std::exit(1);
}

void async_snapshot_handles_record_staging_completion() {
    const std::filesystem::path root = fdm_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string context = read_text_file(root / "gpu" / "cuda" / "runtime" / "context.cu");

    check(
        context_header.find("staging_done_event") != std::string::npos,
        "async snapshot handles must own a staging_done_event");
    check(
        context.find("cudaEventDestroy(reinterpret_cast<cudaEvent_t>(slot.staging_done_event))") !=
            std::string::npos,
        "async snapshot pool cleanup must destroy staging_done_event");
    check(
        context_header.find("kFdmAsyncFieldSnapshotPoolCapacity = 4") != std::string::npos,
        "FDM async field snapshots must use a bounded pool");
    check(
        context_header.find("kFdmAsyncPreviewSnapshotPoolCapacity = 4") != std::string::npos,
        "FDM async preview snapshots must use a bounded pool");
    check(
        context_header.find("done_event_recorded") != std::string::npos,
        "async snapshot handles must distinguish a current completion event from a reused pool event");
    check(
        context.find("if (snapshot.needs_wait && !snapshot.done_event_recorded)") != std::string::npos,
        "failed snapshot setup must drain a slot before reusing its persistent resources");
    check(
        context.find("fdm_async_snapshot_pool_exhausted") != std::string::npos,
        "FDM async field snapshots must expose bounded backpressure");
    check(
        context.find("fdm_async_preview_snapshot_pool_exhausted") != std::string::npos,
        "FDM async preview snapshots must expose bounded backpressure");
}

void async_field_snapshot_stages_on_io_stream() {
    const std::filesystem::path root = fdm_source_root();
    const std::string field_snapshot = function_body(
        read_text_file(root / "gpu" / "cuda" / "runtime" / "context.cu"),
        "AsyncFieldSnapshot *context_begin_async_field_snapshot");

    check(
        field_snapshot.find("snapshot->staging_done_event = slot.staging_done_event") !=
            std::string::npos,
        "field snapshots must lease the persistent staging completion event");
    check(
        field_snapshot.find("cudaStreamWaitEvent(io_stream, ready_event, 0)") !=
            std::string::npos,
        "field snapshots must wait for default-stream readiness on the IO stream");
    check(
        field_snapshot.find("snapshot->staging.x, source_x, component_bytes, cudaMemcpyDeviceToDevice, io_stream") !=
            std::string::npos,
        "field snapshot x staging copy must run on the IO stream");
    check(
        field_snapshot.find("snapshot->staging.y, field->y, component_bytes, cudaMemcpyDeviceToDevice, io_stream") !=
            std::string::npos,
        "field snapshot y staging copy must run on the IO stream");
    check(
        field_snapshot.find("snapshot->staging.z, field->z, component_bytes, cudaMemcpyDeviceToDevice, io_stream") !=
            std::string::npos,
        "field snapshot z staging copy must run on the IO stream");
    check(
        field_snapshot.find("cudaMalloc(") == std::string::npos &&
            field_snapshot.find("cudaHostAlloc(") == std::string::npos,
        "field snapshots must not allocate CUDA resources per request");
    check(
        field_snapshot.find("cudaEventRecord(staging_done_event, io_stream)") !=
            std::string::npos,
        "field snapshots must record staging completion on the IO stream");
    check(
        field_snapshot.find("cudaStreamWaitEvent(nullptr, staging_done_event, 0)") ==
            std::string::npos,
        "field snapshots must not block the global default stream after staging");
}

void async_preview_snapshot_downsamples_on_io_stream() {
    const std::filesystem::path root = fdm_source_root();
    const std::string preview_snapshot = function_body(
        read_text_file(root / "gpu" / "cuda" / "runtime" / "context.cu"),
        "AsyncPreviewSnapshot *context_begin_async_preview_snapshot");

    const std::size_t switch_pos = preview_snapshot.find("switch (observable)");
    const std::size_t pool_acquire_pos = preview_snapshot.find(
        "acquire_async_preview_snapshot_pool_slot");
    check(
        pool_acquire_pos != std::string::npos && switch_pos != std::string::npos &&
            pool_acquire_pos < switch_pos,
        "preview snapshots must lease pinned host storage before host-filled observable branches");
    check(
        preview_snapshot.find("cudaMalloc(") == std::string::npos &&
            preview_snapshot.find("cudaHostAlloc(") == std::string::npos,
        "preview snapshots must not allocate CUDA resources per request");
    check(
        preview_snapshot.find("snapshot->staging_done_event = slot.staging_done_event") !=
            std::string::npos,
        "preview snapshots must lease the persistent staging completion event");
    check(
        preview_snapshot.find("cudaStreamWaitEvent(io_stream, ready_event, 0)") !=
            std::string::npos,
        "preview snapshots must wait for default-stream readiness on the IO stream");
    check(
        preview_snapshot.find("downsample_field_preview_kernel<double, double><<<blocks, threads_per_block, 0, io_stream>>>") !=
            std::string::npos,
        "double preview downsample kernels must run on the IO stream");
    check(
        preview_snapshot.find("downsample_field_preview_kernel<float, float><<<blocks, threads_per_block, 0, io_stream>>>") !=
            std::string::npos,
        "single preview downsample kernels must run on the IO stream");
    check(
        preview_snapshot.find("cudaEventRecord(staging_done_event, io_stream)") !=
            std::string::npos,
        "preview snapshots must record staging completion on the IO stream");
    check(
        preview_snapshot.find("cudaStreamWaitEvent(nullptr, staging_done_event, 0)") ==
            std::string::npos,
        "preview snapshots must not block the global default stream after staging");
}

} // namespace

int main() {
    async_snapshot_handles_record_staging_completion();
    async_field_snapshot_stages_on_io_stream();
    async_preview_snapshot_downsamples_on_io_stream();
    std::printf("async snapshot contract: PASS\n");
    return 0;
}
