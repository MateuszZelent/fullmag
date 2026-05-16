#pragma once

namespace fullmag::fem {

struct Context;

const char *configured_mfem_device_string();
const char *configured_mfem_device_string(const Context &ctx);
bool is_gpu_device_string(const char *device);
bool mfem_device_requests_gpu();
bool mfem_device_requests_gpu(const Context &ctx);

} // namespace fullmag::fem
