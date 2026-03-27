# ── FDM Backend ──
# Builds libfullmag_fdm as a shared library.
# When CUDA is enabled: real GPU implementation.
# When CUDA is disabled: stub that returns "unavailable".

set(FDM_PUBLIC_HEADERS
    ${CMAKE_SOURCE_DIR}/include/fullmag_fdm.h
)

set(FDM_SOURCES
    src/api.cpp
    src/error.cpp
)

if(FULLMAG_ENABLE_CUDA)
    list(APPEND FDM_SOURCES
        src/context.cu
        src/device_info.cpp
        src/exchange_fp64.cu
        src/exchange_fp32.cu
        src/demag_fp64.cu
        src/demag_fp32.cu
        src/llg_fp64.cu
        src/llg_fp32.cu
        src/llg_dp45_fp64.cu
        src/llg_abm3_fp64.cu
        src/reductions_fp64.cu
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
if(FULLMAG_ENABLE_CUDA)
    enable_testing()

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
endif()
