#include "plan_ingestion_v2.hpp"

#include <cstddef>
#include <cstring>
#include <new>

namespace {

void copy_plan_desc_v2_fields(
    fullmag_fdm_plan_desc_v2 &destination,
    const fullmag_fdm_plan_desc_v2 &source,
    uint32_t source_size)
{
    std::memset(&destination, 0, sizeof(destination));
#define FULLMAG_FDM_PLAN_V2_HEADER_FIELD(field, expected) \
    std::memcpy(&destination.field, &source.field, sizeof(destination.field));
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected) \
    std::memcpy(&destination.base.field, &source.base.field, sizeof(destination.base.field));
#define FULLMAG_FDM_PLAN_V2_GRID_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_MATERIAL_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_TIME_FIELD(field, expected) \
    std::memcpy(&destination.time_policy.field, &source.time_policy.field, \
                sizeof(destination.time_policy.field));
#define FULLMAG_FDM_PLAN_V2_EXTENSION_FIELD(field, expected) \
    if (source_size >= expected + sizeof(destination.field)) { \
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
    constexpr uint32_t legacy_struct_size =
        static_cast<uint32_t>(offsetof(fullmag_fdm_plan_desc_v2, has_rotated_interfacial_dmi));
    if (header.abi_version != FULLMAG_FDM_PLAN_DESC_ABI_V2 ||
        (header.struct_size != legacy_struct_size &&
         header.struct_size != sizeof(fullmag_fdm_plan_desc_v2)))
    {
        return FULLMAG_FDM_ERR_ABI;
    }
    auto *ingestion = new (std::nothrow) fullmag_fdm_plan_ingestion_v2();
    if (!ingestion) return FULLMAG_FDM_ERR_INTERNAL;
    copy_plan_desc_v2_fields(ingestion->descriptor, *plan, header.struct_size);
    ingestion->descriptor.struct_size = sizeof(fullmag_fdm_plan_desc_v2);
    *out_ingestion = ingestion;
    return FULLMAG_FDM_OK;
}

int fullmag_fdm_plan_ingestion_v2_receipt(
    const fullmag_fdm_plan_ingestion_v2 *ingestion,
    fullmag_fdm_plan_desc_v2 *out_receipt)
{
    if (!ingestion || !out_receipt) return FULLMAG_FDM_ERR_INVALID;
    copy_plan_desc_v2_fields(
        *out_receipt, ingestion->descriptor, sizeof(fullmag_fdm_plan_desc_v2));
    return FULLMAG_FDM_OK;
}

void fullmag_fdm_plan_ingestion_v2_destroy(
    fullmag_fdm_plan_ingestion_v2 *ingestion)
{
    delete ingestion;
}
