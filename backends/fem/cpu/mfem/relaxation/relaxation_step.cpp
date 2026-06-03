/*
 * Native FEM relaxation-step dispatch.
 *
 * Owns algorithm selection for production native FEM minimizer steps. Concrete
 * algorithms live in sibling files; C ABI and backend runtime facades delegate
 * here instead of embedding minimizer loops.
 */

#include "cpu/mfem/relaxation/relaxation_step.hpp"

#include "cpu/mfem/relaxation/nonlinear_cg.hpp"
#include "cpu/mfem/relaxation/projected_gradient_bb.hpp"
#include "cpu/mfem/relaxation/tangent_plane_implicit.hpp"

namespace fullmag::fem {

int run_native_relaxation_step(
    Context &ctx,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
    switch (algorithm) {
        case FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB:
            return run_projected_gradient_bb_step(ctx, out_stats, error);
        case FULLMAG_FEM_RELAX_NONLINEAR_CG:
            return run_nonlinear_cg_step(ctx, out_stats, error);
        case FULLMAG_FEM_RELAX_TANGENT_PLANE_IMPLICIT:
            return run_tangent_plane_implicit_step(ctx, out_stats, error);
        default:
            error = "unsupported native FEM relaxation algorithm";
            return FULLMAG_FEM_ERR_INVALID;
    }
}

} // namespace fullmag::fem
