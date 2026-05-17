#pragma once

#include "cpu/mfem/interactions/exchange_fallback.hpp"
#include "cpu/mfem/interactions/exchange_field.hpp"
#include "cpu/mfem/interactions/exchange_legacy_gpu_upload.hpp"
#include "cpu/mfem/interactions/exchange_operator.hpp"
#include "cpu/mfem/interactions/exchange_runtime.hpp"
#include "fullmag_fem.h"

namespace fullmag::fem {

struct Context;

/*
 * Initialize native FEM exchange plan fields.
 *
 * Copies the ABI plan's exchange enable flag and, when the MFEM stack is
 * active, the consistent-mass exchange projection policy into Context
 * compatibility storage. Operator assembly, mass projection, field computation,
 * and runtime refresh remain in the dedicated Exchange modules included here.
 */
void initialize_exchange_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Aggregated include surface for native FEM exchange responsibilities.
 */

} // namespace fullmag::fem
