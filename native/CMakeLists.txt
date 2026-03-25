cmake_minimum_required(VERSION 3.18)
project(fullmag_native LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Optional CUDA ──
option(FULLMAG_ENABLE_CUDA "Build CUDA FDM backend" ON)
set(FULLMAG_EXTERNAL_FDM_LIB_DIR "" CACHE PATH "Use an externally built fullmag_fdm instead of building backends/fdm")

if(FULLMAG_ENABLE_CUDA)
    include(CheckLanguage)
    check_language(CUDA)
    if(CMAKE_CUDA_COMPILER)
        enable_language(CUDA)
        find_package(CUDAToolkit REQUIRED)
        set(CMAKE_CUDA_STANDARD 17)
        set(CMAKE_CUDA_STANDARD_REQUIRED ON)
        message(STATUS "CUDA enabled: ${CMAKE_CUDA_COMPILER_VERSION}")
    else()
        message(WARNING "CUDA requested but no compiler found — disabling")
        set(FULLMAG_ENABLE_CUDA OFF)
    endif()
endif()

# ── Subdirectories ──
if(FULLMAG_EXTERNAL_FDM_LIB_DIR)
    if(EXISTS "${FULLMAG_EXTERNAL_FDM_LIB_DIR}/libfullmag_fdm.so")
        set(FULLMAG_EXTERNAL_FDM_LIB "${FULLMAG_EXTERNAL_FDM_LIB_DIR}/libfullmag_fdm.so")
    elseif(EXISTS "${FULLMAG_EXTERNAL_FDM_LIB_DIR}/libfullmag_fdm.so.0")
        set(FULLMAG_EXTERNAL_FDM_LIB "${FULLMAG_EXTERNAL_FDM_LIB_DIR}/libfullmag_fdm.so.0")
    else()
        message(FATAL_ERROR "FULLMAG_EXTERNAL_FDM_LIB_DIR does not contain libfullmag_fdm.so or libfullmag_fdm.so.0")
    endif()

    add_library(fullmag_fdm SHARED IMPORTED GLOBAL)
    set_target_properties(fullmag_fdm PROPERTIES
        IMPORTED_LOCATION "${FULLMAG_EXTERNAL_FDM_LIB}"
        IMPORTED_NO_SONAME FALSE
        INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_SOURCE_DIR}/include"
    )
else()
    add_subdirectory(backends/fdm)
endif()
add_subdirectory(backends/fem)
