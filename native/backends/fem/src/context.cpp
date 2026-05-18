/*
 * FEM Context facade source contract.
 *
 * This source owns only the compatibility entrypoint for Context construction.
 * It delegates plan construction to the core Context builder. It does not own base/core import helpers, runtime lifecycle, device policy, integrator stage mechanics, or interaction physics.
 */

#include "context.hpp"
#include "core/fem_context_builder.hpp"

namespace fullmag::fem {

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error)
{
    return build_context_from_plan(ctx, plan, error);
}

} // namespace fullmag::fem
