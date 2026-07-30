#pragma once

#include "fullmag_fem.h"

namespace fullmag::fem {

bool runtime_build_info(fullmag_fem_runtime_build_info &out_info);
bool runtime_build_info_v2(fullmag_fem_runtime_build_info_v2 &out_info);

} // namespace fullmag::fem
