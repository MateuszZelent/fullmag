#pragma once

#include <string>

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Refresh the current Context exchange/effective-field buffers from MFEM state.
 *
 * This runtime wrapper synchronizes GPU magnetization back to host storage,
 * invokes the extracted effective-field composition path, records exchange
 * readiness, and keeps debug startup checkpoints out of the exchange operator
 * and exchange field-computation modules.
 */
bool context_refresh_exchange_field_mfem(Context &ctx, std::string &error);
#endif

} // namespace fullmag::fem
