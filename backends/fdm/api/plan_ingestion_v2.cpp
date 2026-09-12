#include "plan_ingestion_v2.hpp"

#include <cmath>
#include <cstddef>
#include <cstring>
#include <limits>
#include <new>

namespace {

void copy_plan_desc_v2_fields(
    fullmag_fdm_plan_desc_v2 &destination,
    const fullmag_fdm_plan_desc_v2 &source,
    uint32_t source_size,
    uint32_t destination_size)
{
    std::memset(&destination, 0, destination_size);
#define FULLMAG_FDM_PLAN_V2_HEADER_FIELD(field, expected) \
    if (source_size >= expected + sizeof(destination.field) && \
        destination_size >= expected + sizeof(destination.field)) { \
        std::memcpy(&destination.field, &source.field, sizeof(destination.field)); \
    }
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected) \
    if (source_size >= expected + sizeof(destination.base.field) && \
        destination_size >= expected + sizeof(destination.base.field)) { \
        std::memcpy(&destination.base.field, &source.base.field, sizeof(destination.base.field)); \
    }
#define FULLMAG_FDM_PLAN_V2_GRID_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_MATERIAL_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_TIME_FIELD(field, expected) \
    if (source_size >= expected + sizeof(destination.time_policy.field) && \
        destination_size >= expected + sizeof(destination.time_policy.field)) { \
        std::memcpy(&destination.time_policy.field, &source.time_policy.field, \
                    sizeof(destination.time_policy.field)); \
    }
#define FULLMAG_FDM_PLAN_V2_EXTENSION_FIELD(field, expected) \
    if (source_size >= expected + sizeof(destination.field) && \
        destination_size >= expected + sizeof(destination.field)) { \
        std::memcpy(&destination.field, &source.field, sizeof(destination.field)); \
    }
#include "fullmag_fdm_plan_desc_v2_layout.def"
#undef FULLMAG_FDM_PLAN_V2_EXTENSION_FIELD
#undef FULLMAG_FDM_PLAN_V2_TIME_FIELD
#undef FULLMAG_FDM_PLAN_V2_MATERIAL_FIELD
#undef FULLMAG_FDM_PLAN_V2_GRID_FIELD
#undef FULLMAG_FDM_PLAN_V2_BASE_FIELD
#undef FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD
#undef FULLMAG_FDM_PLAN_V2_HEADER_FIELD
}

constexpr uint32_t legacy_plan_desc_v2_size = static_cast<uint32_t>(
    offsetof(fullmag_fdm_plan_desc_v2, has_rotated_interfacial_dmi));
constexpr uint32_t complete_plan_desc_v2_size =
    static_cast<uint32_t>(sizeof(fullmag_fdm_plan_desc_v2));

bool has_open_magnetic_boundary(const fullmag_fdm_plan_desc_v2 &plan)
{
    if (plan.base.periodic_x == 0 || plan.base.periodic_y == 0 ||
        plan.base.periodic_z == 0) {
        return true;
    }

    if (plan.base.active_mask == nullptr && plan.base.active_mask_len == 0) {
        return false;
    }

    uint64_t cell_count = 0;
    const auto &grid = plan.base.grid;
    if (grid.nx == 0 || grid.ny == 0 || grid.nz == 0 ||
        static_cast<uint64_t>(grid.nx) > UINT64_MAX /
            static_cast<uint64_t>(grid.ny)) {
        return true;
    }
    cell_count = static_cast<uint64_t>(grid.nx) * grid.ny;
    if (static_cast<uint64_t>(grid.nz) > UINT64_MAX / cell_count ||
        plan.base.active_mask == nullptr ||
        plan.base.active_mask_len != cell_count * grid.nz) {
        return true;
    }
    for (uint64_t index = 0; index < plan.base.active_mask_len; ++index) {
        if (plan.base.active_mask[index] == 0) return true;
    }
    return false;
}

bool rotated_dmi_has_valid_open_boundary_exchange(
    const fullmag_fdm_plan_desc_v2 &plan)
{
    return plan.has_rotated_interfacial_dmi == 0 ||
        plan.dmi_D_rotated_interfacial == 0.0 ||
        plan.base.enable_exchange != 0 ||
        !has_open_magnetic_boundary(plan);
}

bool rotated_dmi_has_valid_boundary_exchange_stiffness(
    const fullmag_fdm_plan_desc_v2 &plan)
{
    if (plan.has_rotated_interfacial_dmi == 0 ||
        plan.dmi_D_rotated_interfacial == 0.0) {
        return true;
    }

    const auto &grid = plan.base.grid;
    const bool has_active_mask = plan.base.active_mask != nullptr ||
        plan.base.active_mask_len != 0;
    if ((plan.base.active_mask == nullptr) !=
        (plan.base.active_mask_len == 0)) {
        return false;
    }
    const bool has_a_field = plan.base.a_field != nullptr ||
        plan.base.a_field_len != 0;
    if ((plan.base.a_field == nullptr) != (plan.base.a_field_len == 0)) {
        return false;
    }

    // A fully periodic, unmasked grid has no natural or active-mask boundary
    // cells.  Keep the boundary contract a no-op even for descriptors whose
    // later backend validation will reject an incomplete grid payload.
    if (grid.nx == 0 || grid.ny == 0 || grid.nz == 0) {
        return !has_active_mask && !has_a_field &&
            plan.base.periodic_x != 0 && plan.base.periodic_y != 0 &&
            plan.base.periodic_z != 0;
    }
    if (static_cast<uint64_t>(grid.nx) >
            std::numeric_limits<uint64_t>::max() /
                static_cast<uint64_t>(grid.ny)) {
        return false;
    }
    const uint64_t plane = static_cast<uint64_t>(grid.nx) * grid.ny;
    if (static_cast<uint64_t>(grid.nz) >
            std::numeric_limits<uint64_t>::max() / plane) {
        return false;
    }
    const uint64_t cell_count = plane * grid.nz;
    if ((has_active_mask && plan.base.active_mask_len != cell_count) ||
        (has_a_field && plan.base.a_field_len != cell_count)) {
        return false;
    }
    if (!has_active_mask && !has_a_field &&
        plan.base.periodic_x != 0 && plan.base.periodic_y != 0 &&
        plan.base.periodic_z != 0) {
        return true;
    }

    const bool periodic[3] = {
        plan.base.periodic_x != 0,
        plan.base.periodic_y != 0,
        plan.base.periodic_z != 0,
    };
    const uint64_t dimensions[3] = {grid.nx, grid.ny, grid.nz};
    const uint64_t strides[3] = {1, grid.nx, plane};
    const auto is_active = [&](uint64_t index) {
        return !has_active_mask || plan.base.active_mask[index] != 0;
    };
    const auto resolved_aex = [&](uint64_t index) {
        return has_a_field ? plan.base.a_field[index] :
            plan.base.material.exchange_stiffness;
    };

    for (uint64_t z = 0; z < grid.nz; ++z) {
        for (uint64_t y = 0; y < grid.ny; ++y) {
            for (uint64_t x = 0; x < grid.nx; ++x) {
                const uint64_t coordinates[3] = {x, y, z};
                const uint64_t index = z * plane + y * grid.nx + x;
                if (!is_active(index)) continue;

                bool touches_boundary = false;
                for (int axis = 0; axis < 3; ++axis) {
                    const uint64_t coordinate = coordinates[axis];
                    const uint64_t dimension = dimensions[axis];
                    const uint64_t stride = strides[axis];
                    if (coordinate == 0) {
                        if (!periodic[axis] ||
                            !is_active(index + (dimension - 1) * stride)) {
                            touches_boundary = true;
                        }
                    } else if (!is_active(index - stride)) {
                        touches_boundary = true;
                    }
                    if (coordinate + 1 == dimension) {
                        if (!periodic[axis] ||
                            !is_active(index - (dimension - 1) * stride)) {
                            touches_boundary = true;
                        }
                    } else if (!is_active(index + stride)) {
                        touches_boundary = true;
                    }
                }

                if (touches_boundary) {
                    const double aex = resolved_aex(index);
                    if (!(std::isfinite(aex) && aex > 0.0)) return false;
                }
            }
        }
    }
    return true;
}

bool rotated_dmi_has_valid_abi_and_composition(
    const fullmag_fdm_plan_desc_v2 &plan)
{
    if (plan.has_rotated_interfacial_dmi != 0 &&
        plan.has_rotated_interfacial_dmi != 1) {
        return false;
    }
    if (!std::isfinite(plan.dmi_D_rotated_interfacial)) {
        return false;
    }
    return plan.has_rotated_interfacial_dmi == 0 ||
        (plan.base.has_interfacial_dmi == 0 && plan.base.has_bulk_dmi == 0);
}

} // namespace

namespace fullmag::fdm {

const fullmag_fdm_plan_desc_v2 &plan_ingestion_descriptor(
    const fullmag_fdm_plan_ingestion_v2 &ingestion)
{
    return ingestion.descriptor;
}

} // namespace fullmag::fdm

int fullmag_fdm_plan_ingestion_v2_create_checked(
    const fullmag_fdm_plan_desc_v2 *plan,
    fullmag_fdm_plan_ingestion_v2 **out_ingestion)
{
    if (!plan || !out_ingestion) return FULLMAG_FDM_ERR_INVALID;
    *out_ingestion = nullptr;
    struct PlanAbiHeader {
        uint32_t abi_version;
        uint32_t struct_size;
    } header{};
    std::memcpy(&header, plan, sizeof(header));
    constexpr uint32_t legacy_struct_size = legacy_plan_desc_v2_size;
    if (header.abi_version != FULLMAG_FDM_PLAN_DESC_ABI_V2 ||
        (header.struct_size != legacy_struct_size &&
         header.struct_size != sizeof(fullmag_fdm_plan_desc_v2)))
    {
        return FULLMAG_FDM_ERR_ABI;
    }
    fullmag_fdm_plan_desc_v2 normalized{};
    copy_plan_desc_v2_fields(
        normalized, *plan, header.struct_size, complete_plan_desc_v2_size);
    if (!rotated_dmi_has_valid_abi_and_composition(normalized)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!rotated_dmi_has_valid_boundary_exchange_stiffness(normalized)) {
        return FULLMAG_FDM_ERR_INVALID;
    }
    if (!rotated_dmi_has_valid_open_boundary_exchange(normalized)) {
        return FULLMAG_FDM_ERR_INVALID;
    }

    auto *ingestion = new (std::nothrow) fullmag_fdm_plan_ingestion_v2();
    if (!ingestion) return FULLMAG_FDM_ERR_INTERNAL;
    ingestion->descriptor = normalized;
    ingestion->descriptor.struct_size = sizeof(fullmag_fdm_plan_desc_v2);
    *out_ingestion = ingestion;
    return FULLMAG_FDM_OK;
}

int fullmag_fdm_plan_ingestion_v2_receipt(
    const fullmag_fdm_plan_ingestion_v2 *ingestion,
    fullmag_fdm_plan_desc_v2 *out_receipt)
{
    return fullmag_fdm_plan_ingestion_v2_receipt_sized(
        ingestion, out_receipt, legacy_plan_desc_v2_size);
}

int fullmag_fdm_plan_ingestion_v2_receipt_sized(
    const fullmag_fdm_plan_ingestion_v2 *ingestion,
    fullmag_fdm_plan_desc_v2 *out_receipt,
    uint32_t out_receipt_size)
{
    if (!ingestion || !out_receipt) return FULLMAG_FDM_ERR_INVALID;
    if (out_receipt_size != legacy_plan_desc_v2_size &&
        out_receipt_size != complete_plan_desc_v2_size) {
        return FULLMAG_FDM_ERR_ABI;
    }
    copy_plan_desc_v2_fields(
        *out_receipt,
        ingestion->descriptor,
        complete_plan_desc_v2_size,
        out_receipt_size);
    std::memcpy(
        reinterpret_cast<unsigned char *>(out_receipt) +
            offsetof(fullmag_fdm_plan_desc_v2, struct_size),
        &out_receipt_size,
        sizeof(out_receipt_size));
    return FULLMAG_FDM_OK;
}

void fullmag_fdm_plan_ingestion_v2_destroy(
    fullmag_fdm_plan_ingestion_v2 *ingestion)
{
    delete ingestion;
}
