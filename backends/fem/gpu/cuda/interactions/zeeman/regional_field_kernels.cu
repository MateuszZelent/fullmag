#include "gpu/cuda/interactions/zeeman/regional_field_kernels.cuh"
#include "gpu/cuda/interactions/zeeman/time_dependence_device.cuh"

#include "context.hpp"
#include "gpu/cuda/state/device_memory.hpp"

#include <cuda_runtime.h>

#include <limits>
#include <vector>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

bool cuda_ok(cudaError_t rc, const char *operation, std::string &error)
{
    if (rc == cudaSuccess) return true;
    error = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

__global__ void materialize_regional_field_kernel(
    const RegionalFieldDriveDeviceDesc *descs,
    uint64_t drive_count,
    const double *basis_x,
    const double *basis_y,
    const double *basis_z,
    const double *point_times,
    const double *point_values,
    uint64_t node_count,
    double evaluation_time_s,
    double stage_start_time_s,
    bool accumulate_into_h_eff,
    double *h_drive_x,
    double *h_drive_y,
    double *h_drive_z,
    double *h_eff_x,
    double *h_eff_y,
    double *h_eff_z)
{
    const uint64_t node = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (node >= node_count) return;
    double hx = 0.0;
    double hy = 0.0;
    double hz = 0.0;
    for (uint64_t drive = 0; drive < drive_count; ++drive) {
        const double multiplier = evaluate_device_time_dependence(
            descs[drive], point_times, point_values, evaluation_time_s, stage_start_time_s);
        const uint64_t index = drive * node_count + node;
        hx += multiplier * basis_x[index];
        hy += multiplier * basis_y[index];
        hz += multiplier * basis_z[index];
    }
    h_drive_x[node] = hx;
    h_drive_y[node] = hy;
    h_drive_z[node] = hz;
    if (accumulate_into_h_eff) {
        h_eff_x[node] += hx;
        h_eff_y[node] += hy;
        h_eff_z[node] += hz;
    }
}

RegionalFieldDriveDeviceDesc pack_waveform(
    const RegionalFieldDriveRuntime &drive,
    uint64_t point_offset)
{
    RegionalFieldDriveDeviceDesc packed{};
    packed.kind = drive.waveform.kind;
    packed.time_origin = drive.time_origin;
    packed.point_offset = point_offset;
    packed.point_count = drive.waveform.points.size();
    switch (drive.waveform.kind) {
    case FULLMAG_FEM_TIME_SINUSOIDAL:
        packed.p0 = drive.waveform.parameters.sinusoidal.frequency_hz;
        packed.p1 = drive.waveform.parameters.sinusoidal.phase_rad;
        packed.p2 = drive.waveform.parameters.sinusoidal.offset;
        break;
    case FULLMAG_FEM_TIME_PULSE:
        packed.p0 = drive.waveform.parameters.pulse.t_on_s;
        packed.p1 = drive.waveform.parameters.pulse.t_off_s;
        break;
    case FULLMAG_FEM_TIME_SINC_PULSE:
        packed.p0 = drive.waveform.parameters.sinc_pulse.cutoff_hz;
        packed.p1 = drive.waveform.parameters.sinc_pulse.t0_s;
        packed.p2 = drive.waveform.parameters.sinc_pulse.amplitude;
        break;
    default:
        break;
    }
    return packed;
}

} // namespace

void gpu_regional_field_drive_destroy(FemGpuFieldBufferDeviceState &fields)
{
    gpu_device_free_component(fields.regional_drive_basis);
    gpu_device_free_bytes(reinterpret_cast<void *&>(fields.regional_drive_descs));
    gpu_device_free_double(fields.regional_drive_point_times);
    gpu_device_free_double(fields.regional_drive_point_values);
    fields.regional_drive_count = 0;
    fields.regional_drive_point_count = 0;
    fields.regional_drive_device_bytes = 0;
}

bool gpu_regional_field_drive_upload(Context &ctx, std::string &error)
{
    auto &gpu = ctx.gpu_state.device;
    auto &fields = gpu.fields;
    if (!gpu.lifecycle.allocated) return true;

    const uint64_t old_bytes = fields.regional_drive_device_bytes;
    gpu_regional_field_drive_destroy(fields);
    if (old_bytes <= gpu.lifecycle.device_bytes) gpu.lifecycle.device_bytes -= old_bytes;
    const uint64_t drive_count = ctx.zeeman.regional_drives.size();
    const uint64_t node_count = gpu.lifecycle.node_count;
    const size_t field_bytes = static_cast<size_t>(node_count) * sizeof(double);
    if (!cuda_ok(cudaMemset(fields.h_drive.x, 0, field_bytes), "clear uploaded H_drive x", error) ||
        !cuda_ok(cudaMemset(fields.h_drive.y, 0, field_bytes), "clear uploaded H_drive y", error) ||
        !cuda_ok(cudaMemset(fields.h_drive.z, 0, field_bytes), "clear uploaded H_drive z", error)) {
        return false;
    }
    if (drive_count == 0) return true;
    if (node_count != 0 && drive_count > std::numeric_limits<uint64_t>::max() / node_count) {
        error = "regional field drive GPU basis size overflow";
        return false;
    }
    const uint64_t basis_count = drive_count * node_count;
    std::vector<double> basis_x(basis_count), basis_y(basis_count), basis_z(basis_count);
    std::vector<RegionalFieldDriveDeviceDesc> descs;
    std::vector<double> point_times;
    std::vector<double> point_values;
    descs.reserve(drive_count);
    for (uint64_t drive_index = 0; drive_index < drive_count; ++drive_index) {
        const auto &drive = ctx.zeeman.regional_drives[drive_index];
        if (drive.basis_h_xyz.size() != node_count * 3u) {
            error = "regional field drive GPU upload received an invalid projected basis length";
            return false;
        }
        descs.push_back(pack_waveform(drive, point_times.size()));
        for (const auto &point : drive.waveform.points) {
            point_times.push_back(point.time_s);
            point_values.push_back(point.value);
        }
        for (uint64_t node = 0; node < node_count; ++node) {
            const uint64_t packed = drive_index * node_count + node;
            basis_x[packed] = drive.basis_h_xyz[3u * node];
            basis_y[packed] = drive.basis_h_xyz[3u * node + 1u];
            basis_z[packed] = drive.basis_h_xyz[3u * node + 2u];
        }
    }

    uint64_t bytes = 0;
    if (!gpu_device_allocate_double(fields.regional_drive_basis.x, basis_count, bytes, error) ||
        !gpu_device_allocate_double(fields.regional_drive_basis.y, basis_count, bytes, error) ||
        !gpu_device_allocate_double(fields.regional_drive_basis.z, basis_count, bytes, error) ||
        !gpu_device_allocate_bytes(reinterpret_cast<void **>(&fields.regional_drive_descs),
            descs.size() * sizeof(RegionalFieldDriveDeviceDesc), bytes, error) ||
        (!point_times.empty() &&
            (!gpu_device_allocate_double(fields.regional_drive_point_times, point_times.size(), bytes, error) ||
             !gpu_device_allocate_double(fields.regional_drive_point_values, point_values.size(), bytes, error)))) {
        gpu_regional_field_drive_destroy(fields);
        return false;
    }
    const auto copy = [&](void *dst, const void *src, size_t size, const char *label) {
        return size == 0 || cuda_ok(cudaMemcpy(dst, src, size, cudaMemcpyHostToDevice), label, error);
    };
    if (!copy(fields.regional_drive_basis.x, basis_x.data(), basis_x.size() * sizeof(double), "upload drive basis x") ||
        !copy(fields.regional_drive_basis.y, basis_y.data(), basis_y.size() * sizeof(double), "upload drive basis y") ||
        !copy(fields.regional_drive_basis.z, basis_z.data(), basis_z.size() * sizeof(double), "upload drive basis z") ||
        !copy(fields.regional_drive_descs, descs.data(), descs.size() * sizeof(RegionalFieldDriveDeviceDesc), "upload drive descriptors") ||
        !copy(fields.regional_drive_point_times, point_times.data(), point_times.size() * sizeof(double), "upload drive PWL times") ||
        !copy(fields.regional_drive_point_values, point_values.data(), point_values.size() * sizeof(double), "upload drive PWL values")) {
        gpu_regional_field_drive_destroy(fields);
        return false;
    }
    fields.regional_drive_count = drive_count;
    fields.regional_drive_point_count = point_times.size();
    fields.regional_drive_device_bytes = bytes;
    gpu.lifecycle.device_bytes += bytes;
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    if (!gpu_regional_field_drive_materialize_and_accumulate(
            ctx, stream, static_cast<int>(node_count), ctx.state.current_time, false, error)) {
        return false;
    }
    return cuda_ok(cudaStreamSynchronize(stream), "synchronize initial H_drive materialization", error);
}

bool gpu_regional_field_drive_materialize_and_accumulate(
    Context &ctx,
    cudaStream_t stream,
    int node_count,
    double evaluation_time_s,
    bool accumulate_into_h_eff,
    std::string &error)
{
    auto &fields = ctx.gpu_state.device.fields;
    if (fields.regional_drive_count == 0) {
        return cuda_ok(cudaMemsetAsync(fields.h_drive.x, 0, node_count * sizeof(double), stream),
                       "clear H_drive x", error) &&
               cuda_ok(cudaMemsetAsync(fields.h_drive.y, 0, node_count * sizeof(double), stream),
                       "clear H_drive y", error) &&
               cuda_ok(cudaMemsetAsync(fields.h_drive.z, 0, node_count * sizeof(double), stream),
                       "clear H_drive z", error);
    }
    const int blocks = (node_count + kBlockSize - 1) / kBlockSize;
    materialize_regional_field_kernel<<<blocks, kBlockSize, 0, stream>>>(
        fields.regional_drive_descs,
        fields.regional_drive_count,
        fields.regional_drive_basis.x,
        fields.regional_drive_basis.y,
        fields.regional_drive_basis.z,
        fields.regional_drive_point_times,
        fields.regional_drive_point_values,
        node_count,
        evaluation_time_s,
        ctx.zeeman.stage_start_time_s,
        accumulate_into_h_eff,
        fields.h_drive.x,
        fields.h_drive.y,
        fields.h_drive.z,
        fields.h_eff.x,
        fields.h_eff.y,
        fields.h_eff.z);
    return cuda_ok(cudaPeekAtLastError(), "launch regional field drive kernel", error);
}

} // namespace fullmag::fem
