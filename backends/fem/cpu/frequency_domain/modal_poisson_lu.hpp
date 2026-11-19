#pragma once

#if FULLMAG_FEM_WITH_SLEPC
#include <petscksp.h>

namespace fullmag::fem::frequency_domain {

// LU realization of the exact scalar Poisson solve phi = P^{-1} r that sits
// inside every application of the modal Schur operator (K0 Poisson-airbox and
// nonzero-k Floquet).  The solve must stay an exact inverse; only the sparse
// direct package changes.
//
// With a PETSc build that provides MUMPS, the factorization uses MUMPS with a
// METIS fill-reducing ordering when METIS is also available.  MUMPS performs
// threshold partial pivoting, so a structurally zero diagonal (for example the
// gauge row of an augmented Poisson block) needs no factorization shift and
// the inverse is not perturbed.  Without MUMPS the native PETSc LU and the
// caller's shift policy are kept unchanged.  The resolved package is reported
// through kModalPoissonLuPackage in solver provenance.
//
// Plain error returns keep this header usable with the PETSc 3.15 managed
// qualification runtime, which predates PetscCall and PETSC_SUCCESS.
#if defined(PETSC_HAVE_MUMPS) && defined(PETSC_HAVE_METIS)
inline constexpr const char *kModalPoissonLuPackage = "mumps_lu_metis";
#elif defined(PETSC_HAVE_MUMPS)
inline constexpr const char *kModalPoissonLuPackage = "mumps_lu";
#else
inline constexpr const char *kModalPoissonLuPackage = "petsc_default_lu";
#endif

// Configure `pc` (already attached to a KSP with operators set) as the exact
// Poisson LU.  `native_shift_type` is applied only to the native PETSc LU.
inline PetscErrorCode configure_modal_poisson_lu(
    PC pc,
    MatFactorShiftType native_shift_type)
{
    PetscErrorCode error = PCSetType(pc, PCLU);
    if (error != 0) {
        return error;
    }
#if defined(PETSC_HAVE_MUMPS)
    (void)native_shift_type;
    error = PCFactorSetMatSolverType(pc, MATSOLVERMUMPS);
    if (error != 0) {
        return error;
    }
#if defined(PETSC_HAVE_METIS)
    error = PCFactorSetUpMatSolverType(pc);
    if (error != 0) {
        return error;
    }
    Mat factor = nullptr;
    error = PCFactorGetMatrix(pc, &factor);
    if (error != 0) {
        return error;
    }
    // ICNTL(7)=5: METIS ordering for the sequential analysis phase.
    error = MatMumpsSetIcntl(factor, 7, 5);
#endif
    return error;
#else
    return PCFactorSetShiftType(pc, native_shift_type);
#endif
}

} // namespace fullmag::fem::frequency_domain
#endif
