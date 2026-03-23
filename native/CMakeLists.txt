cmake_minimum_required(VERSION 3.18)
project(fullmag_native LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Optional CUDA ──
option(FULLMAG_ENABLE_CUDA "Build CUDA FDM backend" ON)

if(FULLMAG_ENABLE_CUDA)
    include(CheckLanguage)
    check_language(CUDA)
    if(CMAKE_CUDA_COMPILER)
        enable_language(CUDA)
        set(CMAKE_CUDA_STANDARD 17)
        set(CMAKE_CUDA_STANDARD_REQUIRED ON)
        message(STATUS "CUDA enabled: ${CMAKE_CUDA_COMPILER_VERSION}")
    else()
        message(WARNING "CUDA requested but no compiler found — disabling")
        set(FULLMAG_ENABLE_CUDA OFF)
    endif()
endif()

# ── Subdirectories ──
add_subdirectory(backends/fdm)
# add_subdirectory(backends/fem)  # FEM deferred
