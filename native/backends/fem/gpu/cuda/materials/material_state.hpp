#pragma once

/*
 * GPU CUDA material device-state module header.
 *
 * Owns device-side material coefficient fields shared by exchange, local
 * interactions, LLG RHS dispatch, and observable energy reductions.
 */

#include <cstdint>

namespace fullmag::fem {

struct FemGpuMaterialDeviceState {
    uint64_t node_count = 0;
    double *ms = nullptr;
    double *a = nullptr;
    double *alpha = nullptr;
    double *ku = nullptr;
    double *ku2 = nullptr;
    double *dind = nullptr;
    double *dbulk = nullptr;
    double *kc1 = nullptr;
    double *kc2 = nullptr;
    double *kc3 = nullptr;
};

} // namespace fullmag::fem
