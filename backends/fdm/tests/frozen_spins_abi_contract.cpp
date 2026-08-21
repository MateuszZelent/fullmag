#include "fullmag_fdm.h"

#include <cassert>
#include <cstddef>
#include <cstring>

static_assert(FULLMAG_FDM_FROZEN_SPINS_ABI_V1 == 1u);
static_assert(FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1 == (UINT64_C(1) << 0));
static_assert(offsetof(fullmag_fdm_plan_desc, frozen_mask)
              > offsetof(fullmag_fdm_plan_desc, stats_stride));
static_assert(offsetof(fullmag_fdm_plan_desc, frozen_reference_xyz)
              > offsetof(fullmag_fdm_plan_desc, frozen_mask_len));
static_assert(offsetof(fullmag_fdm_plan_desc, frozen_reference_len)
              > offsetof(fullmag_fdm_plan_desc, frozen_reference_xyz));

int main() {
    fullmag_fdm_plan_desc legacy{};
    assert(legacy.frozen_mask == nullptr);
    assert(legacy.frozen_mask_len == 0);
    assert(legacy.frozen_reference_xyz == nullptr);
    assert(legacy.frozen_reference_len == 0);

    assert((fullmag_fdm_capability_bits_v1()
            & FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1) != 0);

#if FULLMAG_FDM_TEST_CUDA_BUILD
    uint8_t mask[1] = {1};
    double reference[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_plan_desc invalid{};
    invalid.grid = {1, 1, 1, 1.0, 1.0, 1.0};
    invalid.frozen_mask = mask;
    invalid.frozen_mask_len = 1;
    invalid.frozen_reference_xyz = reference;
    invalid.frozen_reference_len = 2;
    auto *invalid_handle = fullmag_fdm_backend_create(&invalid);
    assert(invalid_handle != nullptr);
    const char *invalid_error = fullmag_fdm_backend_last_error(invalid_handle);
    assert(invalid_error != nullptr);
    assert(std::strstr(invalid_error, "frozen_spins_cuda_abi_invalid") != nullptr);
    fullmag_fdm_backend_destroy(invalid_handle);

    fullmag_fdm_plan_desc supported = invalid;
    supported.frozen_reference_len = 3;
    supported.material = {8.0e5, 1.0e-11, 0.02, 2.21e5};
    supported.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    supported.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    supported.initial_magnetization_xyz = reference;
    supported.initial_magnetization_len = 3;
    auto *supported_handle = fullmag_fdm_backend_create(&supported);
    assert(supported_handle != nullptr);
    const char *supported_error = fullmag_fdm_backend_last_error(supported_handle);
    assert(supported_error == nullptr);
    fullmag_fdm_backend_destroy(supported_handle);
#endif

    return 0;
}
