#pragma once

#include "context.hpp"

#include <string>

/*
 * Native FEM C ABI backend handle storage.
 *
 * This private backend header owns the concrete storage behind the opaque
 * `fullmag_fem_backend` C ABI handle: the native FEM Context plus the last
 * per-handle error string. It does not own public ABI declarations, Context
 * construction sequencing, runtime lifecycle helpers, or physics modules.
 */
struct fullmag_fem_backend {
    fullmag::fem::Context context;
    std::string last_error;
};
