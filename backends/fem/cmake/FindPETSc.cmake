include(FindPackageHandleStandardArgs)

set(_FULLMAG_PETSC_MODULE_DIR "${CMAKE_CURRENT_LIST_DIR}")
get_filename_component(_FULLMAG_PETSC_RUNTIME_PREFIX
    "${_FULLMAG_PETSC_MODULE_DIR}/../../.."
    ABSOLUTE
)

# Re-resolve the repository-local candidate instead of trusting a cached path
# from an earlier runtime prefix.
unset(PETSc_LIBRARY CACHE)
unset(PETSc_LIBRARY)
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
    get_cmake_property(_FULLMAG_PETSC_CACHE_VARIABLES CACHE_VARIABLES)
    foreach(_FULLMAG_PETSC_CACHE_VARIABLE IN LISTS _FULLMAG_PETSC_CACHE_VARIABLES)
        if(_FULLMAG_PETSC_CACHE_VARIABLE MATCHES "^pkgcfg_lib_PETSc_PKG_")
            unset("${_FULLMAG_PETSC_CACHE_VARIABLE}" CACHE)
        endif()
    endforeach()

    # FindPkgConfig's query cache does not track PKG_CONFIG_PATH/provider changes.
    # Invalidate only this package's query markers, not unrelated discoveries.
    unset(__pkg_config_checked_PETSc_PKG CACHE)
    unset(__pkg_config_checked_PETSc_PKG)
    unset(__pkg_config_arguments_PETSc_PKG CACHE)
    unset(__pkg_config_arguments_PETSc_PKG)

    pkg_check_modules(PETSc_PKG QUIET IMPORTED_TARGET PETSc)
    if(PETSc_PKG_FOUND)
        # FindPkgConfig creates a target only once per configure. Refresh every
        # property it owns when this module re-queries an existing provider.
        set_target_properties(PkgConfig::PETSc_PKG PROPERTIES
            INTERFACE_INCLUDE_DIRECTORIES "${PETSc_PKG_INCLUDE_DIRS}"
            INTERFACE_LINK_LIBRARIES "${PETSc_PKG_LINK_LIBRARIES}"
            INTERFACE_LINK_OPTIONS "${PETSc_PKG_LDFLAGS_OTHER}"
            INTERFACE_COMPILE_OPTIONS "${PETSc_PKG_CFLAGS_OTHER}"
        )
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

        set(_FULLMAG_PETSC_PRIMARY_LIBRARY_NAME "")
        foreach(_FULLMAG_PETSC_PACKAGE_LIBRARY IN LISTS PETSc_PKG_LIBRARIES)
            if(_FULLMAG_PETSC_PACKAGE_LIBRARY MATCHES "^petsc(_real)?$")
                set(_FULLMAG_PETSC_PRIMARY_LIBRARY_NAME "${_FULLMAG_PETSC_PACKAGE_LIBRARY}")
                break()
            endif()
        endforeach()

        unset(PETSc_LIBRARY CACHE)
        unset(PETSc_LIBRARY)
        if(_FULLMAG_PETSC_PRIMARY_LIBRARY_NAME)
            find_library(PETSc_LIBRARY
                NAMES "${_FULLMAG_PETSC_PRIMARY_LIBRARY_NAME}"
                HINTS ${PETSc_PKG_LIBRARY_DIRS} "${PETSc_LIBRARY_DIR}"
                NO_DEFAULT_PATH
            )
        endif()

        set(_FULLMAG_PETSC_IMPORTED_PRIMARY_LIBRARY "")
        if(TARGET PkgConfig::PETSc_PKG AND _FULLMAG_PETSC_PRIMARY_LIBRARY_NAME)
            get_target_property(_FULLMAG_PETSC_IMPORTED_LIBRARIES
                PkgConfig::PETSc_PKG INTERFACE_LINK_LIBRARIES
            )
            foreach(_FULLMAG_PETSC_IMPORTED_LIBRARY IN LISTS _FULLMAG_PETSC_IMPORTED_LIBRARIES)
                get_filename_component(_FULLMAG_PETSC_IMPORTED_LIBRARY_NAME
                    "${_FULLMAG_PETSC_IMPORTED_LIBRARY}"
                    NAME
                )
                if(_FULLMAG_PETSC_IMPORTED_LIBRARY_NAME MATCHES
                    "^(lib)?${_FULLMAG_PETSC_PRIMARY_LIBRARY_NAME}(\\..*)?$"
                    AND IS_ABSOLUTE "${_FULLMAG_PETSC_IMPORTED_LIBRARY}"
                    AND EXISTS "${_FULLMAG_PETSC_IMPORTED_LIBRARY}"
                )
                    set(_FULLMAG_PETSC_IMPORTED_PRIMARY_LIBRARY
                        "${_FULLMAG_PETSC_IMPORTED_LIBRARY}"
                    )
                    break()
                endif()
            endforeach()
        endif()

        if(PETSc_LIBRARY AND _FULLMAG_PETSC_IMPORTED_PRIMARY_LIBRARY)
            file(REAL_PATH "${PETSc_LIBRARY}" _FULLMAG_PETSC_SELECTED_LIBRARY_REAL)
            file(REAL_PATH "${_FULLMAG_PETSC_IMPORTED_PRIMARY_LIBRARY}"
                _FULLMAG_PETSC_IMPORTED_LIBRARY_REAL
            )
            if(_FULLMAG_PETSC_SELECTED_LIBRARY_REAL STREQUAL _FULLMAG_PETSC_IMPORTED_LIBRARY_REAL)
                set(PETSc_LIBRARY "${_FULLMAG_PETSC_IMPORTED_PRIMARY_LIBRARY}" CACHE FILEPATH
                    "Primary PETSc library from the selected pkg-config target" FORCE
                )
            else()
                unset(PETSc_LIBRARY CACHE)
                set(PETSc_LIBRARY "")
            endif()
        else()
            unset(PETSc_LIBRARY CACHE)
            set(PETSc_LIBRARY "")
        endif()

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
    set_property(TARGET PETSC::petsc PROPERTY FULLMAG_DISCOVERY_OWNER "${PETSc_FIND_MODULE_FILE}")
endif()
get_target_property(_FULLMAG_PETSC_WRAPPER_OWNER PETSC::petsc FULLMAG_DISCOVERY_OWNER)
if(_FULLMAG_PETSC_WRAPPER_OWNER STREQUAL PETSc_FIND_MODULE_FILE)
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
