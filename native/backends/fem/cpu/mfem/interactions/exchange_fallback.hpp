#pragma once

namespace fullmag::fem {

/*
 * Documentation marker for the no-MFEM exchange fallback.
 *
 * When `FULLMAG_HAS_MFEM_STACK` is false, the fallback definitions for the
 * public exchange operator/field symbols live in `exchange_fallback.cpp`.
 * Disabled exchange returns zero field/energy, while active exchange reports an
 * explicit MFEM-stack requirement.
 */

} // namespace fullmag::fem
