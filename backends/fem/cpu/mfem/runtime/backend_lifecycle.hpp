#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Initialize native FEM backend runtime resources behind the C ABI facade.
 *
 * This runtime helper owns Context construction delegation and transfer-audit
 * environment import for a backend Context. It also validates the optional
 * mixed-body ownership certificate before any Context/operator construction.
 * It does not own exported
 * fullmag_fem_backend_create, C ABI handle allocation, or public error
 * plumbing.
 */
bool initialize_backend_runtime(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error,
    const fullmag_fem_mixed_body_certificate_v2 *mixed_body_certificate_v2 = nullptr);

/*
 * Destroy native FEM backend runtime resources behind the C ABI facade.
 *
 * This runtime helper owns teardown of GPU state and optional MFEM context
 * resources associated with a Context. It does not own exported fullmag_fem_backend_destroy,
 * C ABI handle deletion, or public error plumbing.
 */
void destroy_backend_runtime(Context &ctx);

} // namespace fullmag::fem
