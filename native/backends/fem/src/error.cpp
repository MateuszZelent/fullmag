/*
 * FEM error facade source contract.
 *
 * This source owns thread-local global error storage plus handle-scoped last
 * error synchronization for the native FEM C ABI. It does not own backend creation, Context construction, solver execution, availability policy, or transfer auditing.
 */

#include "backend_handle.hpp"

#include <string>

namespace {
thread_local std::string g_last_error;
}

void fullmag_fem_set_global_error(const std::string &message) {
    g_last_error = message;
}

void fullmag_fem_clear_global_error() {
    g_last_error.clear();
}

const char *fullmag_fem_get_global_error() {
    return g_last_error.empty() ? nullptr : g_last_error.c_str();
}

void fullmag_fem_set_handle_error(fullmag_fem_backend *handle, const std::string &message) {
    if (handle != nullptr) {
        handle->last_error = message;
    }
    fullmag_fem_set_global_error(message);
}
