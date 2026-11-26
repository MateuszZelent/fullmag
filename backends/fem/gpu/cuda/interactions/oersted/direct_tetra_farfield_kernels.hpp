#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem::oersted {

// Host-resident Structure-of-Arrays (SoA) source tetrahedron representation
// uploaded once per evaluation to the opt-in CUDA far-field Biot--Savart kernel.
struct GpuDirectTetraSourceHostData {
    std::size_t source_count = 0;
    // 4 vertices per source tetrahedron in SoA layout: index [k * source_count + s]
    // for local vertex k in {0, 1, 2, 3} and source s in [0, source_count).
    std::vector<double> vertex_x;
    std::vector<double> vertex_y;
    std::vector<double> vertex_z;
    // 4 signed RT0 basis coefficients in SoA layout: index [k * source_count + s].
    std::vector<double> signed_coefficients_a;
    // Circumscribing/bounding sphere center and radius per source tetrahedron.
    std::vector<double> center_x;
    std::vector<double> center_y;
    std::vector<double> center_z;
    std::vector<double> bounding_radius;
    // Element volume and |det(J)| = 6 * volume per source tetrahedron.
    std::vector<double> volume;
    std::vector<double> abs_det;
};

// Host-resident output returned by the opt-in CUDA far-field Biot--Savart kernel:
// deterministic 106-bit TwoSum accumulated far-field sums per target, plus a
// compact CSR list of near/singular/unconverged source indices handed off to the
// authoritative CPU long-double Duffy + adaptive subdivision path.
struct GpuDirectTetraTargetResult {
    // Length 3 * target_count (AoS-3 H_x, H_y, H_z in A/m).
    std::vector<double> far_h_xyz_apm;
    // Length target_count: sum of ||high - low||_2 over GPU-accepted far pairs.
    std::vector<double> far_error_sum_apm;
    // Length target_count: sum of weighted quadrature norms for roundoff tracking.
    std::vector<double> far_weighted_norm_sum_apm;
    // Length target_count: maximum pair error among GPU-accepted far pairs.
    std::vector<double> far_max_pair_error_apm;
    // Length target_count: number of GPU-accepted far pairs.
    std::vector<std::uint64_t> far_pair_count;
    // Length target_count: exact number of GPU kernel evaluations performed.
    std::vector<std::uint64_t> far_kernel_evaluations;
    // Compact CSR list of source indices handed off to CPU per target:
    // cpu_pair_offsets has length target_count + 1; for target t,
    // cpu_pair_sources[cpu_pair_offsets[t] .. cpu_pair_offsets[t + 1]) holds
    // sorted ascending source indices requiring CPU long-double evaluation.
    std::vector<std::uint64_t> cpu_pair_offsets;
    std::vector<std::uint32_t> cpu_pair_sources;
    // Length target_count: non-zero if target t must evaluate all sources on CPU.
    std::vector<std::uint8_t> target_requires_full_cpu_fallback;
};

// Evaluate non-singular root-level far-field Biot--Savart pairs on CUDA GPU using
// 106-bit double-double TwoSum accumulation in deterministic ascending source order.
// Pairs with ||x_t - c_s||_2 <= near_radius_factor * R_s or insufficient root
// accuracy are flagged in `out.cpu_pair_sources` for authoritative CPU long-double
// Duffy / adaptive subdivision. Returns false with diagnostic `error` on any
// CUDA failure (callers must never silently fall back to CPU).
bool fullmag_cuda_direct_tetra_evaluate_root_farfield(
    const GpuDirectTetraSourceHostData &sources,
    const double *target_xyz,
    std::size_t target_count,
    const double *low_rule_xyzw,
    int low_npts,
    const double *high_rule_xyzw,
    int high_npts,
    double near_radius_factor,
    double relative_tolerance,
    double absolute_tolerance_apm,
    GpuDirectTetraTargetResult &out,
    std::string &error);

} // namespace fullmag::fem::oersted
