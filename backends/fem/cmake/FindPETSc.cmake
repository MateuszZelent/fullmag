include(FindPackageHandleStandardArgs)

set(_FULLMAG_PETSC_MODULE_DIR "${CMAKE_CURRENT_LIST_DIR}")
get_filename_component(_FULLMAG_PETSC_RUNTIME_PREFIX
    "${_FULLMAG_PETSC_MODULE_DIR}/../../.."
    ABSOLUTE
)

find_library(PETSc_LIBRARY
    NAMES petsc_real petsc
    HINTS "${_FULLMAG_PETSC_RUNTIME_PREFIX}/lib"
    NO_DEFAULT_PATH
)

set(PETSc_INCLUDE_DIR "")
if(EXISTS "${_FULLMAG_PETSC_RUNTIME_PREFIX}/include/petsc")
    set(PETSc_INCLUDE_DIR "${_FULLMAG_PETSC_RUNTIME_PREFIX}/include/petsc")
endif()

set(PETSc_FIND_MODULE_FILE "${CMAKE_CURRENT_LIST_FILE}")

find_package(PkgConfig QUIET)
if((NOT PETSc_LIBRARY OR NOT PETSc_INCLUDE_DIR) AND PkgConfig_FOUND)
    pkg_check_modules(PETSc_PKG QUIET IMPORTED_TARGET PETSc)
    if(PETSc_PKG_FOUND)
        execute_process(
            COMMAND "${PKG_CONFIG_EXECUTABLE}" --variable=pcfiledir PETSc
            OUTPUT_VARIABLE PETSc_PKGCONFIG_DIR
            OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        execute_process(
            COMMAND "${PKG_CONFIG_EXECUTABLE}" --variable=libdir PETSc
            OUTPUT_VARIABLE PETSc_LIBRARY_DIR
            OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        execute_process(
            COMMAND "${PKG_CONFIG_EXECUTABLE}" --variable=includedir PETSc
            OUTPUT_VARIABLE PETSc_INCLUDE_DIR
            OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        find_library(PETSc_LIBRARY
            NAMES petsc_real petsc
            HINTS ${PETSc_PKG_LIBRARY_DIRS} "${PETSc_LIBRARY_DIR}"
        )
        set(PETSc_VERSION "${PETSc_PKG_VERSION}")
        set(PETSc_INCLUDE_DIRS ${PETSc_PKG_INCLUDE_DIRS})
    endif()
endif()

if(NOT PETSc_INCLUDE_DIRS)
    set(PETSc_INCLUDE_DIRS "${PETSc_INCLUDE_DIR}")
endif()
if(NOT PETSc_VERSION AND EXISTS "${PETSc_INCLUDE_DIR}/petscversion.h")
    file(STRINGS "${PETSc_INCLUDE_DIR}/petscversion.h" _PETSc_VERSION_LINES
        REGEX "#define PETSC_VERSION_(MAJOR|MINOR|SUBMINOR)[ \t]+[0-9]+")
    foreach(_PETSc_VERSION_LINE IN LISTS _PETSc_VERSION_LINES)
        if(_PETSc_VERSION_LINE MATCHES "#define PETSC_VERSION_MAJOR[ \t]+([0-9]+)")
            set(_PETSc_VERSION_MAJOR "${CMAKE_MATCH_1}")
        elseif(_PETSc_VERSION_LINE MATCHES "#define PETSC_VERSION_MINOR[ \t]+([0-9]+)")
            set(_PETSc_VERSION_MINOR "${CMAKE_MATCH_1}")
        elseif(_PETSc_VERSION_LINE MATCHES "#define PETSC_VERSION_SUBMINOR[ \t]+([0-9]+)")
            set(_PETSc_VERSION_SUBMINOR "${CMAKE_MATCH_1}")
        endif()
    endforeach()
    if(DEFINED _PETSc_VERSION_MAJOR AND DEFINED _PETSc_VERSION_MINOR AND DEFINED _PETSc_VERSION_SUBMINOR)
        set(PETSc_VERSION "${_PETSc_VERSION_MAJOR}.${_PETSc_VERSION_MINOR}.${_PETSc_VERSION_SUBMINOR}")
    endif()
endif()
if(NOT PETSc_PKGCONFIG_DIR)
    set(PETSc_PKGCONFIG_DIR "")
endif()
if(NOT PETSc_VERSION)
    set(PETSc_VERSION "")
endif()

if(NOT TARGET PETSC::petsc)
    add_library(PETSC::petsc INTERFACE IMPORTED GLOBAL)
    if(TARGET PkgConfig::PETSc_PKG)
        set_target_properties(PETSC::petsc PROPERTIES
            INTERFACE_COMPILE_OPTIONS "${PETSc_PKG_CFLAGS_OTHER}"
            INTERFACE_INCLUDE_DIRECTORIES "${PETSc_INCLUDE_DIRS}"
            INTERFACE_LINK_LIBRARIES "PkgConfig::PETSc_PKG"
        )
    else()
        set_target_properties(PETSC::petsc PROPERTIES
            INTERFACE_INCLUDE_DIRECTORIES "${PETSc_INCLUDE_DIRS}"
            INTERFACE_LINK_LIBRARIES "${PETSc_LIBRARY}"
        )
    endif()
endif()

find_package_handle_standard_args(PETSc
    REQUIRED_VARS PETSc_LIBRARY PETSc_INCLUDE_DIRS
    VERSION_VAR PETSc_VERSION
)

mark_as_advanced(
    PETSc_FIND_MODULE_FILE
    PETSc_INCLUDE_DIR
    PETSc_LIBRARY
    PETSc_LIBRARY_DIR
    PETSc_PKGCONFIG_DIR
    PETSc_VERSION
)
