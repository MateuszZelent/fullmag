cmake_minimum_required(VERSION 3.25)

# This adapter intentionally has a native-Windows boundary.  The repository's
# managed Linux recipes remain the supported route for Linux libCEED builds.
if(NOT WIN32)
    message(FATAL_ERROR "fullmag_native_ceed is the native Windows libCEED adapter")
endif()

option(FULLMAG_CEED_ENABLE_CUDA "Build the CUDA libCEED provider" ON)
if(FULLMAG_CEED_ENABLE_CUDA)
    set(CEED_CUDA_ARCHITECTURES "" CACHE STRING
        "CUDA architectures for the libCEED device wrappers (for example 89)")
    if(NOT CEED_CUDA_ARCHITECTURES AND CMAKE_CUDA_ARCHITECTURES)
        set(CEED_CUDA_ARCHITECTURES "${CMAKE_CUDA_ARCHITECTURES}")
    endif()
    if(NOT CEED_CUDA_ARCHITECTURES)
        message(FATAL_ERROR
            "Set CEED_CUDA_ARCHITECTURES explicitly; the Windows FEM package must not guess a GPU target")
    endif()
    set(CMAKE_CUDA_ARCHITECTURES "${CEED_CUDA_ARCHITECTURES}" CACHE STRING
        "CUDA architectures selected for the libCEED device wrappers" FORCE)
endif()

# clang-cl is required for the C translation units.  libCEED v0.12.0 uses
# C99 VLA syntax in its core implementation; compiling those files with the
# MSVC C compiler, or pretending they are C++, is not a valid ABI workaround.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
project(fullmag_native_ceed VERSION 0.12.0 LANGUAGES C CXX)
if(FULLMAG_CEED_ENABLE_CUDA)
    enable_language(CUDA)
endif()

if(NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "libCEED Windows target requires the x64 MSVC ABI")
endif()
if(NOT CMAKE_C_COMPILER_ID STREQUAL "Clang")
    message(FATAL_ERROR "libCEED C sources require clang-cl for the C99 VLA implementation")
endif()
if(NOT CMAKE_CXX_COMPILER_ID MATCHES "^(Clang|MSVC)$")
    message(FATAL_ERROR "libCEED C++ sources require clang-cl or MSVC under the x64 ABI")
endif()
if(DEFINED CMAKE_C_COMPILER_FRONTEND_VARIANT AND
   NOT CMAKE_C_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
    message(FATAL_ERROR "The C compiler must use the clang-cl/MSVC frontend")
endif()
if(DEFINED CMAKE_CXX_COMPILER_FRONTEND_VARIANT AND
   NOT CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
    message(FATAL_ERROR "The C++ compiler must use the clang-cl/MSVC frontend")
endif()

set(CEED_SOURCE_DIR "" CACHE PATH "Pinned libCEED v0.12.0 source checkout")
set(FULLMAG_CEED_SOURCE_ROOT "" CACHE PATH
    "Compatibility alias for CEED_SOURCE_DIR used by the managed FEM provider recipe")
if(NOT CEED_SOURCE_DIR AND FULLMAG_CEED_SOURCE_ROOT)
    set(CEED_SOURCE_DIR "${FULLMAG_CEED_SOURCE_ROOT}")
endif()
if(NOT CEED_SOURCE_DIR OR NOT IS_DIRECTORY "${CEED_SOURCE_DIR}")
    message(FATAL_ERROR "CEED_SOURCE_DIR must point to the pinned libCEED source checkout")
endif()
get_filename_component(CEED_SOURCE_DIR "${CEED_SOURCE_DIR}" REALPATH)
if(NOT EXISTS "${CEED_SOURCE_DIR}/Makefile" OR
   NOT EXISTS "${CEED_SOURCE_DIR}/backends/ceed-backend-list.h")
    message(FATAL_ERROR "CEED_SOURCE_DIR is not a libCEED source checkout: ${CEED_SOURCE_DIR}")
endif()
file(READ "${CEED_SOURCE_DIR}/include/ceed/ceed.h" CEED_HEADER LIMIT 16384)
# CMake keeps the bytes returned by file(READ), including CRLF from a Windows
# checkout.  The exact-source guards below intentionally match LF-delimited
# fragments, so normalize each upstream text input before checking or patching.
string(REPLACE "\r\n" "\n" CEED_HEADER "${CEED_HEADER}")
if(NOT CEED_HEADER MATCHES "CEED_VERSION_MAJOR[ \t]+0" OR
   NOT CEED_HEADER MATCHES "CEED_VERSION_MINOR[ \t]+12" OR
   NOT CEED_HEADER MATCHES "CEED_VERSION_PATCH[ \t]+0")
    message(FATAL_ERROR "CEED_SOURCE_DIR must contain libCEED v0.12.0")
endif()

if(FULLMAG_CEED_ENABLE_CUDA)
    find_package(CUDAToolkit REQUIRED)
endif()

file(GLOB CEED_INTERFACE_SOURCES CONFIGURE_DEPENDS
    "${CEED_SOURCE_DIR}/interface/*.c")
list(FILTER CEED_INTERFACE_SOURCES EXCLUDE REGEX "/ceed\\.c$")
list(FILTER CEED_INTERFACE_SOURCES EXCLUDE REGEX "/ceed-jit-tools\\.c$")
list(FILTER CEED_INTERFACE_SOURCES EXCLUDE REGEX "/ceed-(cuda|hip)\\.c$")
list(FILTER CEED_INTERFACE_SOURCES EXCLUDE REGEX "/ceed-jit-source-root-(default|install)\\.c$")

file(GLOB CEED_CPU_SOURCES CONFIGURE_DEPENDS
    "${CEED_SOURCE_DIR}/backends/ref/*.c")
file(GLOB CEED_GALLERY_SOURCES CONFIGURE_DEPENDS
    "${CEED_SOURCE_DIR}/gallery/*.c"
    "${CEED_SOURCE_DIR}/gallery/*/*.c")
list(FILTER CEED_GALLERY_SOURCES EXCLUDE REGEX "/ceed-gallery-weak\\.c$")

# The CUDA source set follows the v0.12.0 Makefile exactly: C and C++ host
# pieces, plus the three CUDA wrapper/kernel families.  NVRTC remains a
# runtime dependency of the CUDA backend; the .cu files here are only the
# small device wrappers used by libCEED.  CPU/ref mode deliberately leaves all
# CUDA source lists empty so that CMake never enables a CUDA language/toolkit.
set(CEED_CUDA_C_SOURCES "")
set(CEED_CUDA_CXX_SOURCES "")
set(CEED_CUDA_KERNEL_SOURCES "")
if(FULLMAG_CEED_ENABLE_CUDA)
    file(GLOB CEED_CUDA_C_SOURCES CONFIGURE_DEPENDS
        "${CEED_SOURCE_DIR}/interface/ceed-cuda.c"
        "${CEED_SOURCE_DIR}/backends/cuda/*.c"
        "${CEED_SOURCE_DIR}/backends/cuda-ref/*.c"
        "${CEED_SOURCE_DIR}/backends/cuda-shared/*.c"
        "${CEED_SOURCE_DIR}/backends/cuda-gen/*.c")
    file(GLOB CEED_CUDA_CXX_SOURCES CONFIGURE_DEPENDS
        "${CEED_SOURCE_DIR}/backends/cuda/*.cpp"
        "${CEED_SOURCE_DIR}/backends/cuda-ref/*.cpp"
        "${CEED_SOURCE_DIR}/backends/cuda-gen/*.cpp")
    file(GLOB CEED_CUDA_KERNEL_SOURCES CONFIGURE_DEPENDS
        "${CEED_SOURCE_DIR}/backends/cuda-ref/kernels/*.cu"
        "${CEED_SOURCE_DIR}/backends/cuda-shared/kernels/*.cu"
        "${CEED_SOURCE_DIR}/backends/cuda-gen/kernels/*.cu")
endif()

set(CEED_JIT_SOURCE_ROOT_DEFAULT "${CMAKE_INSTALL_PREFIX}/include/")
file(TO_CMAKE_PATH "${CEED_JIT_SOURCE_ROOT_DEFAULT}" CEED_JIT_SOURCE_ROOT_DEFAULT)
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated/ceed")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated/interface")

# MSVC's aligned allocator must be paired with its own free/realloc routines.
# Keep the pinned checkout read-only and patch only the v0.12.0 allocator
# fragment into a generated translation unit.  Exact-source guards make a
# future libCEED update fail at configure time instead of silently applying a
# stale compatibility patch.
file(READ "${CEED_SOURCE_DIR}/interface/ceed.c" CEED_CORE_SOURCE)
string(REPLACE "\r\n" "\n" CEED_CORE_SOURCE "${CEED_CORE_SOURCE}")
string(REPLACE
    "#include <stdlib.h>"
    "#include <stdlib.h>\n#include <malloc.h>"
    CEED_CORE_SOURCE "${CEED_CORE_SOURCE}")
string(REPLACE [=[int ierr = posix_memalign((void **)p, CEED_ALIGN, n * unit);
  CeedCheck(ierr == 0, NULL, CEED_ERROR_MAJOR, "posix_memalign failed to allocate %zd members of size %zd\n", n, unit);]=]
    [=[size_t bytes = n * unit;
  *(void **)p = bytes ? _aligned_malloc(bytes, CEED_ALIGN) : NULL;
  CeedCheck(!bytes || *(void **)p, NULL, CEED_ERROR_MAJOR, "_aligned_malloc failed to allocate %zd members of size %zd\n", n, unit);]=]
    CEED_CORE_SOURCE "${CEED_CORE_SOURCE}")
string(REPLACE [=[*(void **)p = calloc(n, unit);
  CeedCheck(!n || !unit || *(void **)p, NULL, CEED_ERROR_MAJOR, "calloc failed to allocate %zd members of size %zd\n", n, unit);]=]
    [=[size_t bytes = 0;
  if (unit && n > (size_t)-1 / unit) {
    return CeedError(NULL, CEED_ERROR_MAJOR,
                     "calloc size overflow for %zd members of size %zd\n", n, unit);
  }
  bytes = n * unit;
  *(void **)p = bytes ? _aligned_malloc(bytes, CEED_ALIGN) : NULL;
  if (*(void **)p) memset(*(void **)p, 0, bytes);
  CeedCheck(!bytes || *(void **)p, NULL, CEED_ERROR_MAJOR, "_aligned_malloc/calloc failed to allocate %zd members of size %zd\n", n, unit);]=]
    CEED_CORE_SOURCE "${CEED_CORE_SOURCE}")
string(REPLACE [=[*(void **)p = realloc(*(void **)p, n * unit);
  CeedCheck(!n || !unit || *(void **)p, NULL, CEED_ERROR_MAJOR, "realloc failed to allocate %zd members of size %zd\n", n, unit);]=]
    [=[size_t bytes = n * unit;
  if (bytes) {
    *(void **)p = _aligned_realloc(*(void **)p, bytes, CEED_ALIGN);
  } else {
    _aligned_free(*(void **)p);
    *(void **)p = NULL;
  }
  CeedCheck(!bytes || *(void **)p, NULL, CEED_ERROR_MAJOR, "_aligned_realloc failed to allocate %zd members of size %zd\n", n, unit);]=]
    CEED_CORE_SOURCE "${CEED_CORE_SOURCE}")
string(REPLACE "  free(*(void **)p);" "  _aligned_free(*(void **)p);"
    CEED_CORE_SOURCE "${CEED_CORE_SOURCE}")
foreach(CEED_UNPATCHED_MARKER
    "posix_memalign"
    "*(void **)p = calloc(n, unit)"
    "*(void **)p = realloc(*(void **)p, n * unit)"
    "  free(*(void **)p);")
    string(FIND "${CEED_CORE_SOURCE}" "${CEED_UNPATCHED_MARKER}" CEED_UNPATCHED_OFFSET)
    if(NOT CEED_UNPATCHED_OFFSET EQUAL -1)
        message(FATAL_ERROR
            "libCEED v0.12.0 allocator source no longer matches the Windows patch contract: ${CEED_UNPATCHED_MARKER}")
    endif()
endforeach()
if(NOT CEED_CORE_SOURCE MATCHES "_aligned_malloc" OR
   NOT CEED_CORE_SOURCE MATCHES "_aligned_realloc" OR
   NOT CEED_CORE_SOURCE MATCHES "_aligned_free")
    message(FATAL_ERROR "Windows libCEED allocator patch was not applied")
endif()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/interface/ceed-windows-core.c" "${CEED_CORE_SOURCE}")

# JiT source paths can arrive from Windows __FILE__ values with a drive-colon
# and backslashes.  The upstream Linux path splitter would mistake `C:` for a
# QFunction suffix and would fail to find the final separator.  Apply the
# small path-only adaptation to another generated translation unit, with the
# same exact-source guard as the allocator patch.
file(READ "${CEED_SOURCE_DIR}/interface/ceed-jit-tools.c" CEED_JIT_TOOLS_SOURCE)
string(REPLACE "\r\n" "\n" CEED_JIT_TOOLS_SOURCE "${CEED_JIT_TOOLS_SOURCE}")
string(REPLACE
    "#include <string.h>"
    "#include <string.h>\n\nstatic const char *CeedWindowsLastPathSeparator(const char *path) {\n  const char *forward = strrchr(path, '/');\n  const char *backward = strrchr(path, (char)92);\n  if (!forward) return backward;\n  if (!backward) return forward;\n  return forward > backward ? forward : backward;\n}"
    CEED_JIT_TOOLS_SOURCE "${CEED_JIT_TOOLS_SOURCE}")
string(REPLACE
    "  char *last_colon = strrchr(source_file_path, ':');"
    "  char *last_colon = strrchr(source_file_path, ':');\n  // The colon in a Windows drive prefix is not a QFunction suffix.\n  if (last_colon == source_file_path + 1) last_colon = NULL;"
    CEED_JIT_TOOLS_SOURCE "${CEED_JIT_TOOLS_SOURCE}")
string(REPLACE
    "          long root_length           = strrchr(source_file_path, '/') - source_file_path;"
    "          long root_length           = CeedWindowsLastPathSeparator(source_file_path) - source_file_path;"
    CEED_JIT_TOOLS_SOURCE "${CEED_JIT_TOOLS_SOURCE}")
string(REPLACE
    "char  *last_slash  = strrchr(base_file_path, '/');"
    "char  *last_slash  = (char *)CeedWindowsLastPathSeparator(base_file_path);"
    CEED_JIT_TOOLS_SOURCE "${CEED_JIT_TOOLS_SOURCE}")
string(REPLACE
    "  *(relative_file_path) = strstr(absolute_file_path, \"ceed/jit-source\");"
    "  *(relative_file_path) = strstr(absolute_file_path, \"ceed/jit-source\");\n  if (!*relative_file_path) *relative_file_path = strstr(absolute_file_path, \"ceed\\\\jit-source\");"
    CEED_JIT_TOOLS_SOURCE "${CEED_JIT_TOOLS_SOURCE}")
foreach(CEED_UNPATCHED_JIT_MARKER
    "          long root_length           = strrchr(source_file_path, '/') - source_file_path;"
    "char  *last_slash  = strrchr(base_file_path, '/');")
    string(FIND "${CEED_JIT_TOOLS_SOURCE}" "${CEED_UNPATCHED_JIT_MARKER}" CEED_UNPATCHED_JIT_OFFSET)
    if(NOT CEED_UNPATCHED_JIT_OFFSET EQUAL -1)
        message(FATAL_ERROR
            "libCEED v0.12.0 JiT path source no longer matches the Windows patch contract: ${CEED_UNPATCHED_JIT_MARKER}")
    endif()
endforeach()
string(FIND "${CEED_JIT_TOOLS_SOURCE}" "CeedWindowsLastPathSeparator" CEED_JIT_HELPER_OFFSET)
string(FIND "${CEED_JIT_TOOLS_SOURCE}" "last_colon == source_file_path + 1" CEED_JIT_DRIVE_OFFSET)
string(FIND "${CEED_JIT_TOOLS_SOURCE}" [=[ceed\\jit-source]=] CEED_JIT_BACKSLASH_OFFSET)
if(CEED_JIT_HELPER_OFFSET EQUAL -1 OR
   CEED_JIT_DRIVE_OFFSET EQUAL -1 OR
   CEED_JIT_BACKSLASH_OFFSET EQUAL -1)
    message(FATAL_ERROR "Windows libCEED JiT path patch was not applied")
endif()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/interface/ceed-windows-jit-tools.c" "${CEED_JIT_TOOLS_SOURCE}")

file(READ "${CEED_SOURCE_DIR}/include/ceed/ceed.h" CEED_PUBLIC_HEADER)
string(REPLACE "\r\n" "\n" CEED_PUBLIC_HEADER "${CEED_PUBLIC_HEADER}")
string(REPLACE
    "#define CEED_EXTERN extern \"C\" CEED_VISIBILITY(default)"
    "#define CEED_EXTERN extern \"C\" CEED_WINDOWS_EXPORT"
    CEED_PUBLIC_HEADER "${CEED_PUBLIC_HEADER}")
string(REPLACE
    "#define CEED_EXTERN extern CEED_VISIBILITY(default)"
    "#define CEED_EXTERN extern CEED_WINDOWS_EXPORT"
    CEED_PUBLIC_HEADER "${CEED_PUBLIC_HEADER}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/ceed/ceed.h"
    "/* Generated Windows ABI wrapper around libCEED v0.12.0. */\n"
    "#if defined(_WIN32)\n"
    "#if defined(CEED_BUILDING_DLL)\n"
    "#define CEED_WINDOWS_EXPORT __declspec(dllexport)\n"
    "#else\n"
    "#define CEED_WINDOWS_EXPORT __declspec(dllimport)\n"
    "#endif\n"
    "#else\n"
    "#define CEED_WINDOWS_EXPORT\n"
    "#endif\n"
    "#if defined(_WIN32) && !defined(CEED_SKIP_VISIBILITY)\n"
    "#define CEED_SKIP_VISIBILITY 1\n"
    "#endif\n"
    "${CEED_PUBLIC_HEADER}")
configure_file(
    "${CMAKE_CURRENT_LIST_DIR}/ceed_jit_source_root_install.c.in"
    "${CMAKE_CURRENT_BINARY_DIR}/generated/ceed-jit-source-root-install.c"
    @ONLY)

set(CEED_SOURCES
    ${CEED_INTERFACE_SOURCES}
    ${CEED_CPU_SOURCES}
    ${CEED_GALLERY_SOURCES}
    ${CEED_CUDA_C_SOURCES}
    ${CEED_CUDA_CXX_SOURCES}
    ${CEED_CUDA_KERNEL_SOURCES}
    "${CMAKE_CURRENT_BINARY_DIR}/generated/interface/ceed-windows-core.c"
    "${CMAKE_CURRENT_BINARY_DIR}/generated/interface/ceed-windows-jit-tools.c"
    "${CMAKE_CURRENT_BINARY_DIR}/generated/ceed-jit-source-root-install.c"
    "${CMAKE_CURRENT_LIST_DIR}/ceed_windows_compat.c")

add_library(ceed SHARED ${CEED_SOURCES})
set_target_properties(ceed PROPERTIES
    OUTPUT_NAME "ceed"
    WINDOWS_EXPORT_ALL_SYMBOLS ON
    C_STANDARD 99
    C_STANDARD_REQUIRED ON
    C_EXTENSIONS OFF
    CXX_STANDARD 11
    CXX_STANDARD_REQUIRED ON
)
if(FULLMAG_CEED_ENABLE_CUDA)
    set_target_properties(ceed PROPERTIES
        CUDA_SEPARABLE_COMPILATION ON
        CUDA_RESOLVE_DEVICE_SYMBOLS ON
        CUDA_STANDARD 17
        CUDA_STANDARD_REQUIRED ON)
endif()

target_include_directories(ceed
    PRIVATE
        "${CMAKE_CURRENT_BINARY_DIR}/generated"
        "${CEED_SOURCE_DIR}/include"
        "${CEED_SOURCE_DIR}/backends/cuda"
        "${CEED_SOURCE_DIR}/backends/cuda-ref"
        "${CEED_SOURCE_DIR}/backends/cuda-shared"
        "${CEED_SOURCE_DIR}/backends/cuda-gen")

# CEED_VISIBILITY uses ELF attributes in the upstream headers.  The generated
# public header maps CEED_EXTERN to the MSVC import/export ABI for functions
# and data, while WINDOWS_EXPORT_ALL_SYMBOLS keeps backend entry points
# reachable from the DLL.  Suppressing ELF visibility attributes retains the
# same unmangled extern "C" declarations under clang-cl and MSVC.
target_compile_definitions(ceed PRIVATE
    CEED_BUILDING_DLL=1
    CEED_SKIP_VISIBILITY=1
    _CRT_SECURE_NO_WARNINGS=1)
if(NOT FULLMAG_CEED_ENABLE_CUDA)
    target_compile_definitions(ceed PRIVATE FULLMAG_CEED_NO_CUDA=1)
endif()
target_compile_options(ceed PRIVATE
    "$<$<COMPILE_LANGUAGE:CXX>:/EHsc>"
    "$<$<COMPILE_LANGUAGE:C>:/W3>")

if(FULLMAG_CEED_ENABLE_CUDA)
    target_link_libraries(ceed PRIVATE
        CUDA::cudart
        CUDA::cuda_driver
        CUDA::nvrtc
        CUDA::cublas)
endif()

include(GNUInstallDirs)
set(CEED_ADAPTER_MANIFEST "${CMAKE_CURRENT_BINARY_DIR}/generated/native-ceed-adapter-manifest.txt")
if(FULLMAG_CEED_ENABLE_CUDA)
    set(CEED_MANIFEST_CUDA_RUNTIME "nvrtc")
    set(CEED_MANIFEST_BACKENDS "/gpu/cuda/ref,/gpu/cuda/shared,/gpu/cuda/gen,/cpu/self/ref/serial")
else()
    set(CEED_MANIFEST_CUDA_RUNTIME "disabled")
    set(CEED_MANIFEST_BACKENDS "/cpu/self/ref/serial")
endif()
file(WRITE "${CEED_ADAPTER_MANIFEST}"
    "schema=fullmag.native-ceed.adapter.v1\n"
    "libceed_version=0.12.0\n"
    "windows_abi=x64-msvc\n"
    "c_compiler=clang-cl\n"
    "cuda_runtime=${CEED_MANIFEST_CUDA_RUNTIME}\n"
    "backends=${CEED_MANIFEST_BACKENDS}\n"
    "allocator_adapter=generated/interface/ceed-windows-core.c;aligned-crt\n"
    "jit_path_adapter=generated/interface/ceed-windows-jit-tools.c;drive-colon-and-both-separators\n")
install(TARGETS ceed
    RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}"
    ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}")
install(FILES "${CEED_ADAPTER_MANIFEST}"
    DESTINATION "${CMAKE_INSTALL_DATAROOTDIR}/fullmag/native-ceed")
install(FILES
    "${CEED_SOURCE_DIR}/include/ceed.h"
    "${CEED_SOURCE_DIR}/include/ceedf.h"
    DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}")
install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/generated/ceed/ceed.h"
    "${CEED_SOURCE_DIR}/include/ceed/types.h"
    "${CEED_SOURCE_DIR}/include/ceed/ceed-f32.h"
    "${CEED_SOURCE_DIR}/include/ceed/ceed-f64.h"
    "${CEED_SOURCE_DIR}/include/ceed/fortran.h"
    "${CEED_SOURCE_DIR}/include/ceed/backend.h"
    "${CEED_SOURCE_DIR}/include/ceed/cuda.h"
    "${CEED_SOURCE_DIR}/include/ceed/hip.h"
    DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}/ceed")
install(DIRECTORY "${CEED_SOURCE_DIR}/include/ceed/jit-source/"
    DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}/ceed/jit-source"
    FILES_MATCHING PATTERN "*.h")

message(STATUS "libCEED source: ${CEED_SOURCE_DIR}")
if(FULLMAG_CEED_ENABLE_CUDA)
    message(STATUS "libCEED CUDA architectures: ${CEED_CUDA_ARCHITECTURES}")
else()
    message(STATUS "libCEED provider: CPU reference (/cpu/self/ref/serial)")
endif()
message(STATUS "libCEED install prefix: ${CMAKE_INSTALL_PREFIX}")
