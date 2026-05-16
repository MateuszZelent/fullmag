# ── FEM Backend ──
# Builds libfullmag_fem as a shared library.
# Current stage: ABI + dispatch scaffold.
# Real MFEM/libCEED/hypre sources will be added behind FULLMAG_USE_MFEM_STACK.

option(FULLMAG_ENABLE_FEM_GPU "Build FEM GPU backend scaffold" ON)
option(FULLMAG_USE_MFEM_STACK "Build FEM backend against MFEM/libCEED/hypre" OFF)

set(FEM_PUBLIC_HEADERS
    ${CMAKE_SOURCE_DIR}/include/fullmag_fem.h
)

set(FEM_SOURCES
    src/api.cpp
    src/context.cpp
    src/dmi_weak_residual.cpp
    src/error.cpp
    src/gpu_exchange.cpp
    src/gpu_rk.cpp
    src/gpu_state.cpp
    src/transfer_audit.cpp
)

if(FULLMAG_USE_MFEM_STACK)
    find_package(MFEM CONFIG REQUIRED)

    list(APPEND FEM_SOURCES
        src/mfem_bridge.cpp
    )

    # S11: CUDA fused kernels (LLG RHS, normalize, accumulate)
    if(FULLMAG_ENABLE_CUDA)
        enable_language(CUDA)
        list(APPEND FEM_SOURCES
            src/kernels.cu
            src/gpu_rk.cu
        )
    endif()
endif()

add_library(fullmag_fem SHARED ${FEM_SOURCES})

target_include_directories(fullmag_fem
    PUBLIC
        ${CMAKE_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(FULLMAG_USE_MFEM_STACK)
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_MFEM_STACK=1)
    if(FULLMAG_ENABLE_CUDA)
        target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_CUDA_RUNTIME=1)
        target_link_libraries(fullmag_fem PRIVATE CUDA::cudart)
    else()
        target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_CUDA_RUNTIME=0)
    endif()
    if(TARGET MFEM::mfem)
        target_link_libraries(fullmag_fem PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fullmag_fem PRIVATE mfem)
    endif()
else()
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_MFEM_STACK=0)
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_CUDA_RUNTIME=0)
endif()

set_target_properties(fullmag_fem PROPERTIES
    VERSION 0.1.0
    SOVERSION 0
    PUBLIC_HEADER "${FEM_PUBLIC_HEADERS}"
)

# ── Tests ──
enable_testing()

add_executable(fem_gpu_state_info tests/gpu_state_info.cpp)
target_link_libraries(fem_gpu_state_info PRIVATE fullmag_fem)
add_test(NAME fem_gpu_state_info COMMAND fem_gpu_state_info)

add_executable(fem_gpu_rk_plan tests/gpu_rk_plan.cpp)
target_link_libraries(fem_gpu_rk_plan PRIVATE fullmag_fem)
target_include_directories(fem_gpu_rk_plan PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fem_gpu_rk_plan COMMAND fem_gpu_rk_plan)

add_executable(fem_transfer_audit tests/transfer_audit.cpp)
target_link_libraries(fem_transfer_audit PRIVATE fullmag_fem)
target_include_directories(fem_transfer_audit PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fem_transfer_audit COMMAND fem_transfer_audit)

add_executable(fem_dmi_weak_residual tests/dmi_weak_residual.cpp)
target_link_libraries(fem_dmi_weak_residual PRIVATE fullmag_fem)
target_include_directories(fem_dmi_weak_residual PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fem_dmi_weak_residual COMMAND fem_dmi_weak_residual)

# S14: PA vs Assembled benchmark (opt-in)
if(FULLMAG_USE_MFEM_STACK)
    add_executable(pa_benchmark examples/pa_benchmark.cpp)
    target_link_libraries(pa_benchmark PRIVATE fullmag_fem)
    if(TARGET MFEM::mfem)
        target_link_libraries(pa_benchmark PRIVATE MFEM::mfem)
    else()
        target_link_libraries(pa_benchmark PRIVATE mfem)
    endif()
    if(FULLMAG_ENABLE_CUDA)
        target_link_libraries(pa_benchmark PRIVATE CUDA::cudart)
    endif()
    set_target_properties(pa_benchmark PROPERTIES EXCLUDE_FROM_ALL TRUE)
endif()
