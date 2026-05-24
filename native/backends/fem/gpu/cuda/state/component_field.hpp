#pragma once

/*
 * GPU CUDA component field state header.
 *
 * Owns the shared device-side x/y/z component pointer bundle used by GPU
 * field, RK, and demag substates.
 */

namespace fullmag::fem {

struct FemGpuComponentField {
    double *x = nullptr;
    double *y = nullptr;
    double *z = nullptr;
};

} // namespace fullmag::fem
