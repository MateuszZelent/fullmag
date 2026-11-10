#pragma once
#include <cstdint>
#include <string>
namespace fullmag::fem {
struct Context;
int gpu_object_average(
    Context &ctx, const uint32_t *indices, uint64_t count,
    bool element_set, double *out_xyz, std::string &error);
}
