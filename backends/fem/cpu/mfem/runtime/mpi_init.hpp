#pragma once

/*
 * Shared MPI initialization for native FEM Hypre solve paths.
 *
 * Guarantees MPI_THREAD_FUNNELED and provides a serial communicator for
 * HypreParMatrix wrapping.  All Hypre call sites must use these helpers
 * instead of hand-rolling MPI_Init or using MPI_COMM_WORLD.
 */

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>

#ifdef MFEM_USE_MPI

#include <cassert>

namespace fullmag::fem {

/// Ensure MPI is initialized exactly once with MPI_THREAD_FUNNELED.
inline void ensure_mpi_initialized() {
    int initialized = 0;
    MPI_Initialized(&initialized);
    if (!initialized) {
        int provided = 0;
        MPI_Init_thread(nullptr, nullptr, MPI_THREAD_FUNNELED, &provided);
    }
}

/// Return a serial communicator for Hypre wrapping.
///
/// Fullmag native FEM is a serial solver that wraps MFEM serial
/// SparseMatrix into HypreParMatrix for access to Hypre solvers.
/// Using MPI_COMM_WORLD is undefined when comm_size > 1 because
/// the row_starts = {0, N} partitioning assumes a single rank.
/// MPI_COMM_SELF is always correct for this serial wrapping.
inline MPI_Comm fullmag_serial_comm() {
    return MPI_COMM_SELF;
}

} // namespace fullmag::fem

#endif // MFEM_USE_MPI
#endif // FULLMAG_HAS_MFEM_STACK
