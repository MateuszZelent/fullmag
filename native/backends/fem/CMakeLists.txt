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
    src/error.cpp
)

if(FULLMAG_USE_MFEM_STACK)
    find_package(MFEM CONFIG REQUIRED)

    list(APPEND FEM_SOURCES
        src/mfem_bridge.cpp
    )

    # S11: CUDA fused kernels (LLG RHS, normalize, accumulate)
    if(FULLMAG_ENABLE_CUDA)
        enable_language(CUDA)
        list(APPEND FEM_SOURCES src/kernels.cu)
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
    target_link_libraries(fullmag_fem PRIVATE fullmag_fdm)
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
