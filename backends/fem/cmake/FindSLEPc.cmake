include(FindPackageHandleStandardArgs)

find_package(PETSc REQUIRED)

set(_FULLMAG_SLEPC_MODULE_DIR "${CMAKE_CURRENT_LIST_DIR}")
get_filename_component(_FULLMAG_SLEPC_RUNTIME_PREFIX
    "${_FULLMAG_SLEPC_MODULE_DIR}/../../.."
    ABSOLUTE
)

find_library(SLEPc_LIBRARY
    NAMES slepc_real slepc
    HINTS "${_FULLMAG_SLEPC_RUNTIME_PREFIX}/lib"
    NO_DEFAULT_PATH
)

set(SLEPc_INCLUDE_DIR "")
if(EXISTS "${_FULLMAG_SLEPC_RUNTIME_PREFIX}/include/slepc")
    set(SLEPc_INCLUDE_DIR "${_FULLMAG_SLEPC_RUNTIME_PREFIX}/include/slepc")
endif()

set(SLEPc_FIND_MODULE_FILE "${CMAKE_CURRENT_LIST_FILE}")

find_package(PkgConfig QUIET)
if((NOT SLEPc_LIBRARY OR NOT SLEPc_INCLUDE_DIR) AND PkgConfig_FOUND)
    pkg_check_modules(SLEPc_PKG QUIET IMPORTED_TARGET SLEPc)
    if(SLEPc_PKG_FOUND)
        execute_process(
            COMMAND "${PKG_CONFIG_EXECUTABLE}" --variable=pcfiledir SLEPc
            OUTPUT_VARIABLE SLEPc_PKGCONFIG_DIR
            OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        execute_process(
            COMMAND "${PKG_CONFIG_EXECUTABLE}" --variable=libdir SLEPc
            OUTPUT_VARIABLE SLEPc_LIBRARY_DIR
            OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        execute_process(
            COMMAND "${PKG_CONFIG_EXECUTABLE}" --variable=includedir SLEPc
            OUTPUT_VARIABLE SLEPc_INCLUDE_DIR
            OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        find_library(SLEPc_LIBRARY
            NAMES slepc_real slepc
            HINTS ${SLEPc_PKG_LIBRARY_DIRS} "${SLEPc_LIBRARY_DIR}"
        )
        set(SLEPc_VERSION "${SLEPc_PKG_VERSION}")
        set(SLEPc_INCLUDE_DIRS ${SLEPc_PKG_INCLUDE_DIRS})
    endif()
endif()

if(NOT SLEPc_INCLUDE_DIRS)
    set(SLEPc_INCLUDE_DIRS "${SLEPc_INCLUDE_DIR}")
endif()
if(NOT SLEPc_VERSION AND EXISTS "${SLEPc_INCLUDE_DIR}/slepcversion.h")
    file(STRINGS "${SLEPc_INCLUDE_DIR}/slepcversion.h" _SLEPc_VERSION_LINES
        REGEX "#define SLEPC_VERSION_(MAJOR|MINOR|SUBMINOR)[ \t]+[0-9]+")
    foreach(_SLEPc_VERSION_LINE IN LISTS _SLEPc_VERSION_LINES)
        if(_SLEPc_VERSION_LINE MATCHES "#define SLEPC_VERSION_MAJOR[ \t]+([0-9]+)")
            set(_SLEPc_VERSION_MAJOR "${CMAKE_MATCH_1}")
        elseif(_SLEPc_VERSION_LINE MATCHES "#define SLEPC_VERSION_MINOR[ \t]+([0-9]+)")
            set(_SLEPc_VERSION_MINOR "${CMAKE_MATCH_1}")
        elseif(_SLEPc_VERSION_LINE MATCHES "#define SLEPC_VERSION_SUBMINOR[ \t]+([0-9]+)")
            set(_SLEPc_VERSION_SUBMINOR "${CMAKE_MATCH_1}")
        endif()
    endforeach()
    if(DEFINED _SLEPc_VERSION_MAJOR AND DEFINED _SLEPc_VERSION_MINOR AND DEFINED _SLEPc_VERSION_SUBMINOR)
        set(SLEPc_VERSION "${_SLEPc_VERSION_MAJOR}.${_SLEPc_VERSION_MINOR}.${_SLEPc_VERSION_SUBMINOR}")
    endif()
endif()
if(NOT SLEPc_PKGCONFIG_DIR)
    set(SLEPc_PKGCONFIG_DIR "")
endif()
if(NOT SLEPc_VERSION)
    set(SLEPc_VERSION "")
endif()

if(NOT TARGET SLEPC::slepc)
    add_library(SLEPC::slepc INTERFACE IMPORTED GLOBAL)
    if(TARGET PkgConfig::SLEPc_PKG)
        set_target_properties(SLEPC::slepc PROPERTIES
            INTERFACE_COMPILE_OPTIONS "${SLEPc_PKG_CFLAGS_OTHER}"
            INTERFACE_INCLUDE_DIRECTORIES "${SLEPc_INCLUDE_DIRS}"
            INTERFACE_LINK_LIBRARIES "PkgConfig::SLEPc_PKG;PETSC::petsc"
        )
    else()
        set_target_properties(SLEPC::slepc PROPERTIES
            INTERFACE_INCLUDE_DIRECTORIES "${SLEPc_INCLUDE_DIRS}"
            INTERFACE_LINK_LIBRARIES "${SLEPc_LIBRARY};PETSC::petsc"
        )
    endif()
endif()

find_package_handle_standard_args(SLEPc
    REQUIRED_VARS SLEPc_LIBRARY SLEPc_INCLUDE_DIRS
    VERSION_VAR SLEPc_VERSION
)

mark_as_advanced(
    SLEPc_FIND_MODULE_FILE
    SLEPc_INCLUDE_DIR
    SLEPc_LIBRARY
    SLEPc_LIBRARY_DIR
    SLEPc_PKGCONFIG_DIR
    SLEPc_VERSION
)
