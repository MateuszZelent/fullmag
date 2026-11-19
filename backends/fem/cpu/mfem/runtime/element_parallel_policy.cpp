// Owns the provider capability gate for shared MFEM element evaluation.
#include "cpu/mfem/runtime/element_parallel_policy.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem/config/config.hpp>
#endif

namespace fullmag::fem {

bool mfem_shared_element_evaluation_parallel_safe() noexcept
{
#if FULLMAG_HAS_MFEM_STACK && defined(_OPENMP) && defined(MFEM_USE_OPENMP) && defined(MFEM_THREAD_SAFE)
    return true;
#else
    return false;
#endif
}

} // namespace fullmag::fem
