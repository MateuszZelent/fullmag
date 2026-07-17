# ── FDM Backend ──
# Builds libfullmag_fdm as a shared library.
# When CUDA is enabled: real GPU implementation.
# When CUDA is disabled: stub that returns "unavailable".

set(FDM_PUBLIC_HEADERS
    ${CMAKE_SOURCE_DIR}/include/fullmag_fdm.h
)

set(FDM_SOURCES
    api/c_api.cpp
    api/error.cpp
)

if(FULLMAG_ENABLE_CUDA)
    list(APPEND FDM_SOURCES
        gpu/cuda/runtime/context.cu
        gpu/cuda/runtime/telemetry.cu
        gpu/cuda/runtime/device_info.cpp
        gpu/cuda/runtime/streams.cu
        gpu/cuda/runtime/reductions_fp64.cu
        gpu/cuda/interactions/exchange_fp64.cu
        gpu/cuda/interactions/exchange_fp32.cu
        gpu/cuda/interactions/multilayer_exchange.cu
        gpu/cuda/interactions/multilayer_dmi.cu
        gpu/cuda/interactions/multilayer_anisotropy.cu
        gpu/cuda/interactions/multilayer_effective_field.cu
        gpu/cuda/interactions/exchange_t0_fp64.cu
        gpu/cuda/interactions/exchange_t1_fp64.cu
        gpu/cuda/interactions/demag_fp64.cu
        gpu/cuda/interactions/demag_fp32.cu
        gpu/cuda/interactions/demag_boundary_fp64.cu
        gpu/cuda/integrators/llg_fp64.cu
        gpu/cuda/integrators/llg_fp32.cu
        gpu/cuda/integrators/llg_dp45_fp64.cu
        gpu/cuda/integrators/llg_dp45_fp32.cu
        gpu/cuda/integrators/llg_rk4_fp64.cu
        gpu/cuda/integrators/llg_rk4_fp32.cu
        gpu/cuda/integrators/llg_rk23_fp64.cu
        gpu/cuda/integrators/llg_rk23_fp32.cu
        gpu/cuda/integrators/llg_abm3_fp64.cu
        gpu/cuda/integrators/llg_abm3_fp32.cu
        gpu/cuda/integrators/multilayer_heun.cu
        gpu/cuda/integrators/multilayer_explicit_rk.cu
        gpu/cuda/demag/multilayer_convolution.cu
        gpu/cuda/demag/newell_gpu_fp64.cu
        gpu/cuda/demag/newell_gpu_fp32.cu
    )
endif()

add_library(fullmag_fdm SHARED ${FDM_SOURCES})

target_include_directories(fullmag_fdm
    PUBLIC
        ${CMAKE_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(FULLMAG_ENABLE_CUDA)
    target_compile_definitions(fullmag_fdm PRIVATE FULLMAG_HAS_CUDA=1)

    # Architecture targets: Ampere, Ada Lovelace, Hopper
    set_target_properties(fullmag_fdm PROPERTIES
        CUDA_ARCHITECTURES "80;86;89;90"
    )

    target_link_libraries(fullmag_fdm PRIVATE
        CUDA::cudart
        CUDA::cufft
    )
else()
    target_compile_definitions(fullmag_fdm PRIVATE FULLMAG_HAS_CUDA=0)
endif()

set_target_properties(fullmag_fdm PROPERTIES
    VERSION 0.1.0
    SOVERSION 0
    PUBLIC_HEADER "${FDM_PUBLIC_HEADERS}"
)

# ── Tests ──
enable_testing()

add_executable(source_layout_contract tests/source_layout_contract.cpp)
add_test(NAME fdm_source_layout_contract COMMAND source_layout_contract)

add_executable(multilayer_abi_v2_contract tests/multilayer_abi_v2_contract.cpp)
add_test(NAME fdm_multilayer_abi_v2_contract COMMAND multilayer_abi_v2_contract)

add_executable(region_owned_abi_contract tests/region_owned_abi_contract.cpp)
add_test(NAME fdm_region_owned_abi_contract COMMAND region_owned_abi_contract)

add_executable(periodic_exchange_fp32_contract tests/periodic_exchange_fp32_contract.cpp)
add_test(NAME fdm_periodic_exchange_fp32_contract COMMAND periodic_exchange_fp32_contract)

add_executable(fdm_llg_time_policy_contract tests/llg_time_policy_contract.cpp)
target_include_directories(fdm_llg_time_policy_contract PRIVATE ${CMAKE_SOURCE_DIR}/include)
target_link_libraries(fdm_llg_time_policy_contract PRIVATE fullmag_fdm)
if(FULLMAG_ENABLE_CUDA)
    target_compile_definitions(fdm_llg_time_policy_contract PRIVATE FULLMAG_FDM_CONTRACT_HAS_CUDA=1)
else()
    target_compile_definitions(fdm_llg_time_policy_contract PRIVATE FULLMAG_FDM_CONTRACT_HAS_CUDA=0)
endif()
add_test(NAME fdm_llg_time_policy_contract COMMAND fdm_llg_time_policy_contract)

if(FULLMAG_ENABLE_CUDA)
    add_executable(smoke_context tests/smoke_context.cpp)
    target_link_libraries(smoke_context PRIVATE fullmag_fdm)
    add_test(NAME fdm_smoke_context COMMAND smoke_context)

    add_executable(exchange_fp64_parity tests/exchange_fp64_parity.cu)
    target_link_libraries(exchange_fp64_parity PRIVATE fullmag_fdm)
    add_test(NAME fdm_exchange_fp64_parity COMMAND exchange_fp64_parity)

    add_executable(heun_fp64_parity tests/heun_fp64_parity.cu)
    target_link_libraries(heun_fp64_parity PRIVATE fullmag_fdm)
    add_test(NAME fdm_heun_fp64_parity COMMAND heun_fp64_parity)

    add_executable(tier_a_compare tests/tier_a_compare.cu)
    target_link_libraries(tier_a_compare PRIVATE fullmag_fdm)
    add_test(NAME fdm_tier_a_compare COMMAND tier_a_compare)

    add_executable(tier_b_compare tests/tier_b_compare.cu)
    target_link_libraries(tier_b_compare PRIVATE fullmag_fdm)
    add_test(NAME fdm_tier_b_compare COMMAND tier_b_compare)

    add_executable(adaptive_error_reduction_contract tests/adaptive_error_reduction_contract.cpp)
    add_test(NAME fdm_adaptive_error_reduction_contract COMMAND adaptive_error_reduction_contract)

    add_executable(stats_mode_contract tests/stats_mode_contract.cpp)
    add_test(NAME fdm_stats_mode_contract COMMAND stats_mode_contract)

    add_executable(batched_demag_fft_contract tests/batched_demag_fft_contract.cpp)
    add_test(NAME fdm_batched_demag_fft_contract COMMAND batched_demag_fft_contract)

    add_executable(async_snapshot_contract tests/async_snapshot_contract.cpp)
    add_test(NAME fdm_async_snapshot_contract COMMAND async_snapshot_contract)

    add_executable(multilayer_create_v2_contract tests/multilayer_create_v2_contract.cpp)
    target_link_libraries(multilayer_create_v2_contract PRIVATE fullmag_fdm)
    set_target_properties(multilayer_create_v2_contract PROPERTIES
        BUILD_RPATH "$<TARGET_FILE_DIR:fullmag_fdm>"
    )
    add_test(NAME fdm_multilayer_create_v2_contract COMMAND multilayer_create_v2_contract)
    set_tests_properties(fdm_multilayer_create_v2_contract PROPERTIES
        ENVIRONMENT "LD_LIBRARY_PATH=$<TARGET_FILE_DIR:fullmag_fdm>"
    )
endif()
