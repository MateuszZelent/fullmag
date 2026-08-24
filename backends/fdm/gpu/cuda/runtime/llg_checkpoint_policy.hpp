#ifndef FULLMAG_FDM_LLG_CHECKPOINT_POLICY_HPP
#define FULLMAG_FDM_LLG_CHECKPOINT_POLICY_HPP

#include "fullmag_fdm.h"

namespace fullmag::fdm {

inline bool llg_checkpoint_execution_identity_matches(
    const fullmag_fdm_llg_checkpoint_info_v2 &checkpoint,
    const fullmag_fdm_llg_checkpoint_info_v2 &local)
{
    return checkpoint.integrator == local.integrator &&
        checkpoint.precision == local.precision &&
        checkpoint.requested_backend == local.requested_backend &&
        checkpoint.resolved_backend == local.resolved_backend &&
        checkpoint.executed_backend == local.executed_backend &&
        checkpoint.requested_policy == local.requested_policy &&
        checkpoint.resolved_policy == local.resolved_policy &&
        checkpoint.execution_realization == local.execution_realization &&
        checkpoint.device_ordinal == local.device_ordinal;
}

} // namespace fullmag::fdm

#endif
