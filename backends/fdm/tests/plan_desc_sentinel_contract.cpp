#include "fullmag_fdm.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <type_traits>

namespace {

static_assert(alignof(fullmag_fdm_plan_desc) == 8);
static_assert(sizeof(fullmag_fdm_plan_desc) == 1280);
static_assert(alignof(fullmag_fdm_plan_desc_v2) == 8);
static_assert(sizeof(fullmag_fdm_plan_desc_v2) == 1384);
#define FULLMAG_FDM_PLAN_V2_HEADER_FIELD(field, expected) \
    static_assert(offsetof(fullmag_fdm_plan_desc_v2, field) == expected);
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected) \
    static_assert(offsetof(fullmag_fdm_plan_desc_v2, field) == expected);
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected) \
    static_assert(offsetof(fullmag_fdm_plan_desc_v2, base) + \
                      offsetof(fullmag_fdm_plan_desc, field) == expected);
#define FULLMAG_FDM_PLAN_V2_TIME_FIELD(field, expected) \
    static_assert(offsetof(fullmag_fdm_plan_desc_v2, time_policy) + \
                      offsetof(fullmag_fdm_time_policy_desc_v2, field) == expected);
#include "fullmag_fdm_plan_desc_v2_layout.def"
#undef FULLMAG_FDM_PLAN_V2_TIME_FIELD
#undef FULLMAG_FDM_PLAN_V2_BASE_FIELD
#undef FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD
#undef FULLMAG_FDM_PLAN_V2_HEADER_FIELD

constexpr std::size_t kHeaderFieldCount = 0
#define FULLMAG_FDM_PLAN_V2_HEADER_FIELD(field, expected) +1
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_TIME_FIELD(field, expected)
#include "fullmag_fdm_plan_desc_v2_layout.def"
;
constexpr std::size_t kAggregateFieldCount = 0
#undef FULLMAG_FDM_PLAN_V2_HEADER_FIELD
#define FULLMAG_FDM_PLAN_V2_HEADER_FIELD(field, expected)
#undef FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected) +1
#include "fullmag_fdm_plan_desc_v2_layout.def"
;
constexpr std::size_t kBaseFieldCount = 0
#undef FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected)
#undef FULLMAG_FDM_PLAN_V2_BASE_FIELD
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected) +1
#include "fullmag_fdm_plan_desc_v2_layout.def"
;
constexpr std::size_t kTimeFieldCount = 0
#undef FULLMAG_FDM_PLAN_V2_BASE_FIELD
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected)
#undef FULLMAG_FDM_PLAN_V2_TIME_FIELD
#define FULLMAG_FDM_PLAN_V2_TIME_FIELD(field, expected) +1
#include "fullmag_fdm_plan_desc_v2_layout.def"
;
#undef FULLMAG_FDM_PLAN_V2_TIME_FIELD
#undef FULLMAG_FDM_PLAN_V2_BASE_FIELD
#undef FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD
#undef FULLMAG_FDM_PLAN_V2_HEADER_FIELD
static_assert(kHeaderFieldCount == 2);
static_assert(kAggregateFieldCount == 2);
static_assert(kBaseFieldCount == 140);
static_assert(kTimeFieldCount == 13);

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

template <typename T>
std::enable_if_t<std::is_arithmetic_v<T>> assign_sentinel(T &field, std::size_t seed) {
    field = static_cast<T>(seed + 1);
}

template <typename T, std::size_t N>
void assign_sentinel(T (&field)[N], std::size_t seed) {
    for (std::size_t index = 0; index < N; ++index) {
        assign_sentinel(field[index], seed + index);
    }
}

template <typename T>
void assign_sentinel(const T *&field, std::size_t seed) {
    static std::array<T, 512> storage{};
    field = storage.data() + seed;
}

void assign_sentinel(fullmag_fdm_grid_desc &field, std::size_t seed) {
    field.nx = static_cast<uint32_t>(seed + 1);
    field.ny = static_cast<uint32_t>(seed + 2);
    field.nz = static_cast<uint32_t>(seed + 3);
    field.dx = static_cast<double>(seed + 4);
    field.dy = static_cast<double>(seed + 5);
    field.dz = static_cast<double>(seed + 6);
}

void assign_sentinel(fullmag_fdm_material_desc &field, std::size_t seed) {
    field.saturation_magnetisation = static_cast<double>(seed + 1);
    field.exchange_stiffness = static_cast<double>(seed + 2);
    field.damping = static_cast<double>(seed + 3);
    field.gyromagnetic_ratio = static_cast<double>(seed + 4);
}

void assign_sentinel(fullmag_fdm_precision &field, std::size_t) {
    field = FULLMAG_FDM_PRECISION_DOUBLE;
}

void assign_sentinel(fullmag_fdm_integrator &field, std::size_t) {
    field = FULLMAG_FDM_INTEGRATOR_RK23;
}

void assign_sentinel(fullmag_fdm_zhang_li_formula &field, std::size_t) {
    field = FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1;
}

void assign_sentinel(fullmag_fdm_slonczewski_formula &field, std::size_t) {
    field = FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2;
}

void assign_sentinel(fullmag_fdm_prescribed_sot_formula &field, std::size_t) {
    field = FULLMAG_FDM_PRESCRIBED_SOT_V1;
}

void assign_sentinel(fullmag_fdm_exchange_pair_mode &field, std::size_t) {
    field = FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN;
}

void assign_sentinel(fullmag_fdm_boundary_correction &field, std::size_t) {
    field = FULLMAG_FDM_BOUNDARY_VOLUME;
}

void assign_sentinel(fullmag_fdm_stats_mode &field, std::size_t) {
    field = FULLMAG_FDM_STATS_NONE;
}

void assign_sentinel(fullmag_fdm_adaptive_tolerance_mode &field, std::size_t) {
    field = FULLMAG_FDM_ADAPTIVE_ADVANCED;
}

template <typename T>
std::enable_if_t<
    std::is_arithmetic_v<T> || std::is_enum_v<T> || std::is_pointer_v<T>,
    bool>
semantic_field_equal(const T &left, const T &right) {
    return left == right;
}

template <typename T, std::size_t N>
bool semantic_field_equal(const T (&left)[N], const T (&right)[N]) {
    for (std::size_t index = 0; index < N; ++index) {
        if (!semantic_field_equal(left[index], right[index])) return false;
    }
    return true;
}

bool semantic_field_equal(
    const fullmag_fdm_grid_desc &left,
    const fullmag_fdm_grid_desc &right)
{
    return left.nx == right.nx && left.ny == right.ny && left.nz == right.nz &&
        left.dx == right.dx && left.dy == right.dy && left.dz == right.dz;
}

bool semantic_field_equal(
    const fullmag_fdm_material_desc &left,
    const fullmag_fdm_material_desc &right)
{
    return left.saturation_magnetisation == right.saturation_magnetisation &&
        left.exchange_stiffness == right.exchange_stiffness &&
        left.damping == right.damping &&
        left.gyromagnetic_ratio == right.gyromagnetic_ratio;
}

void populate_distinct_semantic_sentinels(fullmag_fdm_plan_desc_v2 &plan) {
    std::size_t seed = 1;
#define FULLMAG_FDM_PLAN_V2_HEADER_FIELD(field, expected) assign_sentinel(plan.field, seed++);
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected) \
    assign_sentinel(plan.base.field, seed++);
#define FULLMAG_FDM_PLAN_V2_TIME_FIELD(field, expected) \
    assign_sentinel(plan.time_policy.field, seed++);
#include "fullmag_fdm_plan_desc_v2_layout.def"
#undef FULLMAG_FDM_PLAN_V2_TIME_FIELD
#undef FULLMAG_FDM_PLAN_V2_BASE_FIELD
#undef FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD
#undef FULLMAG_FDM_PLAN_V2_HEADER_FIELD
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2;
    plan.struct_size = sizeof(plan);
}

void check_semantic_receipt(
    const fullmag_fdm_plan_desc_v2 &plan,
    const fullmag_fdm_plan_desc_v2 &receipt)
{
#define FULLMAG_FDM_CHECK_FIELD(path) \
    check(semantic_field_equal(plan.path, receipt.path), "receipt drift: " #path)
#define FULLMAG_FDM_PLAN_V2_HEADER_FIELD(field, expected) FULLMAG_FDM_CHECK_FIELD(field);
#define FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD(field, expected)
#define FULLMAG_FDM_PLAN_V2_BASE_FIELD(field, expected) FULLMAG_FDM_CHECK_FIELD(base.field);
#define FULLMAG_FDM_PLAN_V2_TIME_FIELD(field, expected) \
    FULLMAG_FDM_CHECK_FIELD(time_policy.field);
#include "fullmag_fdm_plan_desc_v2_layout.def"
#undef FULLMAG_FDM_PLAN_V2_TIME_FIELD
#undef FULLMAG_FDM_PLAN_V2_BASE_FIELD
#undef FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD
#undef FULLMAG_FDM_PLAN_V2_HEADER_FIELD
#undef FULLMAG_FDM_CHECK_FIELD
}

void owner_ingestion_receipt_preserves_every_semantic_field() {
    fullmag_fdm_plan_desc_v2 plan{};
    populate_distinct_semantic_sentinels(plan);

    fullmag_fdm_plan_ingestion_v2 *ingestion = nullptr;
    int status = fullmag_fdm_plan_ingestion_v2_create_checked(&plan, &ingestion);
    check(status == FULLMAG_FDM_OK, "complete v2 descriptor must enter the canonical owner");
    check(ingestion != nullptr, "successful plan ingestion must allocate its narrow owner");

    fullmag_fdm_plan_desc_v2 receipt{};
    status = fullmag_fdm_plan_ingestion_v2_receipt(ingestion, &receipt);
    check(status == FULLMAG_FDM_OK, "owner must expose its post-ingestion receipt");
    check_semantic_receipt(plan, receipt);
    fullmag_fdm_plan_ingestion_v2_destroy(ingestion);
}

void incompatible_version_and_size_fail_before_backend_allocation() {
    fullmag_fdm_plan_ingestion_v2 *ingestion =
        reinterpret_cast<fullmag_fdm_plan_ingestion_v2 *>(static_cast<std::uintptr_t>(0x1));
    fullmag_fdm_plan_desc_v2 plan{};
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2 + 1;
    plan.struct_size = sizeof(plan);

    int status = fullmag_fdm_plan_ingestion_v2_create_checked(&plan, &ingestion);
    check(status == FULLMAG_FDM_ERR_ABI, "unknown ABI version must return typed ABI error");
    check(ingestion == nullptr, "unknown ABI version must not allocate a plan owner");

    ingestion =
        reinterpret_cast<fullmag_fdm_plan_ingestion_v2 *>(static_cast<std::uintptr_t>(0x1));
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2;
    plan.struct_size = sizeof(plan) - 1;
    status = fullmag_fdm_plan_ingestion_v2_create_checked(&plan, &ingestion);
    check(status == FULLMAG_FDM_ERR_ABI, "truncated descriptor must return typed ABI error");
    check(ingestion == nullptr, "truncated descriptor must not allocate a plan owner");

    ingestion =
        reinterpret_cast<fullmag_fdm_plan_ingestion_v2 *>(static_cast<std::uintptr_t>(0x1));
    plan.struct_size = sizeof(plan) + 1;
    status = fullmag_fdm_plan_ingestion_v2_create_checked(&plan, &ingestion);
    check(status == FULLMAG_FDM_ERR_ABI, "oversized descriptor must return typed ABI error");
    check(ingestion == nullptr, "oversized descriptor must not allocate a plan owner");

#if FULLMAG_FDM_CONTRACT_HAS_CUDA
    fullmag_fdm_backend *handle =
        reinterpret_cast<fullmag_fdm_backend *>(static_cast<std::uintptr_t>(0x1));
    status = fullmag_fdm_backend_create_time_policy_v2_checked(&plan, &handle);
    check(status == FULLMAG_FDM_ERR_ABI, "backend checked constructor must preserve ABI error");
    check(handle == nullptr, "ABI rejection must happen before backend allocation");
#endif
}

#if FULLMAG_FDM_CONTRACT_HAS_CUDA
void checked_backend_constructor_accepts_a_runtime_valid_plan() {
    double magnetization[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_plan_desc_v2 plan{};
    plan.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2;
    plan.struct_size = sizeof(plan);
    plan.base.grid = {1, 1, 1, 1e-9, 1e-9, 1e-9};
    plan.base.material = {8e5, 1.3e-11, 0.1, 2.211e5};
    plan.base.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.base.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.base.initial_magnetization_xyz = magnetization;
    plan.base.initial_magnetization_len = 3;
    plan.base.exchange_pair_default = FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN;
    plan.time_policy.adaptive_tolerance_mode = FULLMAG_FDM_ADAPTIVE_MAX_ERROR;
    plan.time_policy.adaptive_atol = 1e-6;
    plan.time_policy.adaptive_dt_min = 1e-16;
    plan.time_policy.adaptive_dt_max = 1e-14;
    plan.time_policy.adaptive_safety = 0.9;
    plan.time_policy.adaptive_growth_limit = 2.0;
    plan.time_policy.adaptive_shrink_limit = 0.2;

    fullmag_fdm_backend *handle = nullptr;
    const int status = fullmag_fdm_backend_create_time_policy_v2_checked(&plan, &handle);
    check(status == FULLMAG_FDM_OK, "runtime-valid descriptor must pass checked constructor");
    check(handle != nullptr, "successful checked constructor must return a backend handle");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "runtime-valid descriptor must complete backend ingestion without deferred error");
    fullmag_fdm_backend_destroy(handle);
}
#endif

} // namespace

int main() {
    owner_ingestion_receipt_preserves_every_semantic_field();
    incompatible_version_and_size_fail_before_backend_allocation();
#if FULLMAG_FDM_CONTRACT_HAS_CUDA
    checked_backend_constructor_accepts_a_runtime_valid_plan();
#endif
    std::printf("semantic versioned FDM plan descriptor contract OK\n");
    return 0;
}
