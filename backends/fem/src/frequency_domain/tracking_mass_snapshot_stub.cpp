#include "fullmag_fem.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

void fullmag_fem_set_global_error(const std::string &message);
void fullmag_fem_clear_global_error();

namespace {

int prepare_error_buffer(char *buffer, std::uint64_t capacity)
{
    if (buffer == nullptr && capacity != 0u) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    if (buffer != nullptr && capacity > 0u) {
        buffer[0] = '\0';
    }
    return FULLMAG_FEM_OK;
}

int publish_error(const char *message, int status, char *buffer, std::uint64_t capacity)
{
    fullmag_fem_set_global_error(message);
    if (buffer != nullptr && capacity > 0u) {
        const auto writable = static_cast<std::size_t>(capacity - 1u);
        const auto count = std::min(std::strlen(message), writable);
        std::memcpy(buffer, message, count);
        buffer[count] = '\0';
    }
    return status;
}

} // namespace

int fullmag_fem_tracking_mass_snapshot_create_v1(
    const fullmag_fem_tracking_mass_snapshot_request_v1 *request,
    fullmag_fem_tracking_mass_snapshot_v1 **out_snapshot,
    char *error_message,
    std::uint64_t error_message_capacity)
{
    if (out_snapshot != nullptr) {
        *out_snapshot = nullptr;
    }
    if (prepare_error_buffer(error_message, error_message_capacity) != FULLMAG_FEM_OK) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    fullmag_fem_clear_global_error();
    if (out_snapshot == nullptr || request == nullptr || request->mesh == nullptr ||
        request->abi_version != FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_ABI_VERSION ||
        request->struct_size < sizeof(*request) || request->magnetic_cell_mask == nullptr ||
        request->magnetic_cell_mask_count == 0u || request->generation == 0u) {
        return publish_error(
            "tracking mass snapshot request is invalid",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    return publish_error(
        "tracking mass snapshot is unavailable without the MFEM stack",
        FULLMAG_FEM_ERR_UNAVAILABLE,
        error_message,
        error_message_capacity);
}

int fullmag_fem_tracking_mass_snapshot_get_info_v1(
    const fullmag_fem_tracking_mass_snapshot_v1 *snapshot,
    fullmag_fem_tracking_mass_snapshot_info_v1 *out_info,
    char *error_message,
    std::uint64_t error_message_capacity)
{
    if (prepare_error_buffer(error_message, error_message_capacity) != FULLMAG_FEM_OK) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    fullmag_fem_clear_global_error();
    if (snapshot == nullptr || out_info == nullptr) {
        return publish_error(
            "tracking mass snapshot query requires a valid handle and output",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    return publish_error(
        "tracking mass snapshot handle is unavailable without the MFEM stack",
        FULLMAG_FEM_ERR_UNAVAILABLE,
        error_message,
        error_message_capacity);
}

int fullmag_fem_tracking_mass_snapshot_copy_v1(
    const fullmag_fem_tracking_mass_snapshot_v1 *snapshot,
    std::uint64_t expected_generation,
    const std::uint8_t expected_identity_sha256[FULLMAG_FEM_TRACKING_MASS_SNAPSHOT_DIGEST_BYTES],
    std::uint64_t row_offsets_capacity,
    std::uint64_t columns_capacity,
    std::uint64_t values_capacity,
    std::uint64_t canonical_vertex_ids_capacity,
    std::uint64_t scalar_dof_ids_capacity,
    std::uint64_t *row_offsets,
    std::uint32_t *columns,
    double *values_m3,
    std::uint32_t *canonical_vertex_ids,
    std::uint32_t *scalar_dof_ids,
    char *error_message,
    std::uint64_t error_message_capacity)
{
    if (prepare_error_buffer(error_message, error_message_capacity) != FULLMAG_FEM_OK) {
        return FULLMAG_FEM_ERR_INVALID;
    }
    fullmag_fem_clear_global_error();
    if (snapshot == nullptr) {
        return publish_error(
            "tracking mass snapshot copy requires a valid handle",
            FULLMAG_FEM_ERR_INVALID,
            error_message,
            error_message_capacity);
    }
    (void)expected_generation;
    (void)expected_identity_sha256;
    (void)row_offsets_capacity;
    (void)columns_capacity;
    (void)values_capacity;
    (void)canonical_vertex_ids_capacity;
    (void)scalar_dof_ids_capacity;
    (void)row_offsets;
    (void)columns;
    (void)values_m3;
    (void)canonical_vertex_ids;
    (void)scalar_dof_ids;
    return publish_error(
        "tracking mass snapshot handle is unavailable without the MFEM stack",
        FULLMAG_FEM_ERR_UNAVAILABLE,
        error_message,
        error_message_capacity);
}

void fullmag_fem_tracking_mass_snapshot_destroy_v1(fullmag_fem_tracking_mass_snapshot_v1 *snapshot)
{
    (void)snapshot;
}
