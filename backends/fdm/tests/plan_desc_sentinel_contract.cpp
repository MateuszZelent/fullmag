#include "fullmag_fdm.h"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

static_assert(alignof(fullmag_fdm_plan_desc) == 8);
static_assert(sizeof(fullmag_fdm_plan_desc) == 1280);
static_assert(alignof(fullmag_fdm_plan_desc_v2) == 8);
static_assert(sizeof(fullmag_fdm_plan_desc_v2) == 1384);
static_assert(offsetof(fullmag_fdm_plan_desc_v2, abi_version) == 0);
static_assert(offsetof(fullmag_fdm_plan_desc_v2, struct_size) == 4);
static_assert(offsetof(fullmag_fdm_plan_desc_v2, base) == 8);
#define FULLMAG_PLAN_V2_BASE_OFFSET(field) \
    (offsetof(fullmag_fdm_plan_desc_v2, base) + offsetof(fullmag_fdm_plan_desc, field))
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(grid) == 8);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(ms_field) == 128);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(a_field) == 144);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(alpha_field) == 160);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(dind_field) == 376);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(dbulk_field) == 392);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(zhang_li_formula) == 536);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(slonczewski_formula) == 600);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(slonczewski_active_mask) == 632);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(sot_active_mask) == 712);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(oersted_field_xyz) == 848);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(demag_kernel_xx_spectrum) == 864);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(active_mask) == 936);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(region_mask) == 952);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(exchange_pairs) == 992);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(volume_fraction) == 1032);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(demag_corr_target_idx) == 1152);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(initial_magnetization_xyz) == 1184);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(frozen_mask) == 1256);
static_assert(FULLMAG_PLAN_V2_BASE_OFFSET(frozen_reference_xyz) == 1272);
#undef FULLMAG_PLAN_V2_BASE_OFFSET
static_assert(offsetof(fullmag_fdm_plan_desc_v2, time_policy) == 1288);

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void complete_descriptor_round_trips_every_byte() {
    fullmag_fdm_plan_desc_v2 plan;
    std::memset(&plan, 0xA5, sizeof(plan));
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2;
    plan.struct_size = sizeof(plan);

    fullmag_fdm_plan_desc_v2 receipt;
    std::memset(&receipt, 0, sizeof(receipt));
    const int status = fullmag_fdm_plan_desc_v2_receipt(&plan, &receipt);

    check(status == FULLMAG_FDM_OK, "valid v2 descriptor must be accepted");
    check(std::memcmp(&plan, &receipt, sizeof(plan)) == 0,
          "receipt must preserve every pointer, scalar, array, and padding byte");
}

void incompatible_version_and_size_fail_before_backend_allocation() {
    fullmag_fdm_backend *handle = reinterpret_cast<fullmag_fdm_backend *>(
        static_cast<std::uintptr_t>(0x1));
    fullmag_fdm_plan_desc_v2 plan{};
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2 + 1;
    plan.struct_size = sizeof(plan);

    int status = fullmag_fdm_backend_create_time_policy_v2_checked(&plan, &handle);
    check(status == FULLMAG_FDM_ERR_ABI, "unknown ABI version must return typed ABI error");
    check(handle == nullptr, "unknown ABI version must not allocate a backend handle");

    handle = reinterpret_cast<fullmag_fdm_backend *>(static_cast<std::uintptr_t>(0x1));
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2;
    plan.struct_size = sizeof(plan) - 1;
    status = fullmag_fdm_backend_create_time_policy_v2_checked(&plan, &handle);
    check(status == FULLMAG_FDM_ERR_ABI, "truncated descriptor must return typed ABI error");
    check(handle == nullptr, "truncated descriptor must not allocate a backend handle");

    handle = reinterpret_cast<fullmag_fdm_backend *>(static_cast<std::uintptr_t>(0x1));
    plan.struct_size = sizeof(plan) + 1;
    status = fullmag_fdm_backend_create_time_policy_v2_checked(&plan, &handle);
    check(status == FULLMAG_FDM_ERR_ABI, "oversized unknown descriptor must return typed ABI error");
    check(handle == nullptr, "oversized unknown descriptor must not allocate a backend handle");
}

} // namespace

int main() {
    complete_descriptor_round_trips_every_byte();
    incompatible_version_and_size_fail_before_backend_allocation();
    std::printf("versioned FDM plan descriptor sentinel contract OK\n");
    return 0;
}
