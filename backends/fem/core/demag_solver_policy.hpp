#pragma once

namespace fullmag::fem {

struct ResolvedDemagAmgPolicy {
    int relax_type = 0;
    int coarsening = 0;
    int interpolation = 0;
    int aggressive_coarsening = 0;
    double strength_threshold = 0.0;
    bool strength_threshold_is_set = false;
    int max_levels = 0;
    bool max_levels_is_set = false;
};

ResolvedDemagAmgPolicy resolve_demag_amg_policy_from_environment();

} // namespace fullmag::fem
