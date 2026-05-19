#pragma once

namespace fullmag::fem {

/*
 * Documentation marker for the no-MFEM exchange fallback.
 *
 * This module owns the no-MFEM fallback symbol definitions for exchange.
 * When `FULLMAG_HAS_MFEM_STACK` is false, the fallback definitions for the
 * public exchange operator/field symbols live in `exchange_fallback.cpp`.
 * Disabled exchange returns zero field/energy, while active exchange reports an
 * explicit MFEM-stack requirement.
 *
 * It does not assemble MFEM operators, compute H_ex, project mass, refresh runtime fields, or claim active exchange execution.
 */

} // namespace fullmag::fem
