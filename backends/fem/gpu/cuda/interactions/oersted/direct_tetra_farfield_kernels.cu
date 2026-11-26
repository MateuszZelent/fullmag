#include "gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.hpp"

namespace fullmag::fem::oersted {

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
    std::string &error)
{
    (void)sources;
    (void)target_xyz;
    (void)target_count;
    (void)low_rule_xyzw;
    (void)low_npts;
    (void)high_rule_xyzw;
    (void)high_npts;
    (void)near_radius_factor;
    (void)relative_tolerance;
    (void)absolute_tolerance_apm;
    out = GpuDirectTetraTargetResult{};
    error = "direct tetrahedral Oersted CUDA far-field kernel not yet implemented";
    return false;
}

} // namespace fullmag::fem::oersted
