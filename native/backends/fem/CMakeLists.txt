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

add_library(fullmag_fem SHARED ${FEM_SOURCES})

target_include_directories(fullmag_fem
    PUBLIC
        ${CMAKE_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(FULLMAG_USE_MFEM_STACK)
    find_package(MFEM CONFIG REQUIRED)

    list(APPEND FEM_SOURCES
        src/mfem_bridge.cpp
    )

    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_MFEM_STACK=1)
    target_link_libraries(fullmag_fem PRIVATE fullmag_fdm)
    if(TARGET MFEM::mfem)
        target_link_libraries(fullmag_fem PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fullmag_fem PRIVATE mfem)
    endif()
else()
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_MFEM_STACK=0)
endif()

set_target_properties(fullmag_fem PROPERTIES
    VERSION 0.1.0
    SOVERSION 0
    PUBLIC_HEADER "${FEM_PUBLIC_HEADERS}"
)
