/*
 * async_snapshot_contract.cpp - native FDM asynchronous snapshot contract.
 *
 * Field and preview snapshots may wait for the legacy default stream before
 * reading solver buffers, but the staging and host download work must run on
 * the snapshot IO stream.  The default stream only waits for private staging to
 * finish so solver writes cannot race the snapshot while host downloads can
 * still overlap later solver work.
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
    const std::string context = read_text_file(root / "core" / "context.cu");

    check(
        context_header.find("staging_done_event") != std::string::npos,
        "async snapshot handles must own a staging_done_event");
    check(
        context.find("cudaEventDestroy(reinterpret_cast<cudaEvent_t>(snapshot.staging_done_event))") !=
            std::string::npos,
        "async snapshot resource cleanup must destroy staging_done_event");
}

void async_field_snapshot_stages_on_io_stream() {
    const std::filesystem::path root = fdm_source_root();
    const std::string field_snapshot = function_body(
        read_text_file(root / "core" / "context.cu"),
        "AsyncFieldSnapshot *context_begin_async_field_snapshot");

    check(
        field_snapshot.find("cudaEventCreateWithFlags(&staging_done_event, cudaEventDisableTiming)") !=
            std::string::npos,
        "field snapshots must create a staging completion event");
    check(
        field_snapshot.find("cudaStreamWaitEvent(io_stream, ready_event, 0)") !=
            std::string::npos,
        "field snapshots must wait for default-stream readiness on the IO stream");
    check(
        field_snapshot.find("snapshot->staging.x, field->x, component_bytes, cudaMemcpyDeviceToDevice, io_stream") !=
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
        field_snapshot.find("cudaEventRecord(staging_done_event, io_stream)") !=
            std::string::npos,
        "field snapshots must record staging completion on the IO stream");
    check(
        field_snapshot.find("cudaStreamWaitEvent(nullptr, staging_done_event, 0)") !=
            std::string::npos,
        "field snapshots must protect future default-stream writes until staging is complete");
}

void async_preview_snapshot_downsamples_on_io_stream() {
    const std::filesystem::path root = fdm_source_root();
    const std::string preview_snapshot = function_body(
        read_text_file(root / "core" / "context.cu"),
        "AsyncPreviewSnapshot *context_begin_async_preview_snapshot");

    const std::size_t switch_pos = preview_snapshot.find("switch (observable)");
    const std::size_t host_alloc_pos =
        preview_snapshot.find("cudaHostAlloc(&snapshot->host_xyz");
    check(
        host_alloc_pos != std::string::npos && switch_pos != std::string::npos &&
            host_alloc_pos < switch_pos,
        "preview snapshots must allocate pinned host storage before host-filled observable branches");
    check(
        preview_snapshot.find("cudaEventCreateWithFlags(&staging_done_event, cudaEventDisableTiming)") !=
            std::string::npos,
        "preview snapshots must create a staging completion event");
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
        preview_snapshot.find("cudaStreamWaitEvent(nullptr, staging_done_event, 0)") !=
            std::string::npos,
        "preview snapshots must protect future default-stream writes until staging is complete");
}

} // namespace

int main() {
    async_snapshot_handles_record_staging_completion();
    async_field_snapshot_stages_on_io_stream();
    async_preview_snapshot_downsamples_on_io_stream();
    std::printf("async snapshot contract: PASS\n");
    return 0;
}
