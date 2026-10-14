#!/usr/bin/env python3
"""Read-only contract checks for the native Windows libCEED adapter.

This check deliberately inspects the source and CMake contract only.  It does
not invoke CMake, a compiler, CUDA, or a unit-test build.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import tempfile


ROOT = Path(__file__).resolve().parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def check_crlf_normalization_contract(cmake: str) -> None:
    """Keep the CMake text patches working with a real CRLF source fixture."""
    # Path.read_text() applies universal-newline conversion and would hide the
    # original defect.  Write/read raw bytes so this regression proves that the
    # fixture actually contains CRLF before applying the same normalization
    # operation promised by the CMake adapter.
    fixtures = {
        "ceed-core.c": (
            b"#include <stdlib.h>\r\n"
            b"int ierr = posix_memalign((void **)p, CEED_ALIGN, n * unit);\r\n",
            "posix_memalign((void **)p, CEED_ALIGN, n * unit);\n",
        ),
        "ceed-jit-tools.c": (
            b"  char *last_colon = strrchr(source_file_path, ':');\r\n",
            "  char *last_colon = strrchr(source_file_path, ':');\n",
        ),
        "ceed.h": (
            b"#define CEED_VERSION_MINOR 12\r\n",
            "#define CEED_VERSION_MINOR 12\n",
        ),
    }
    with tempfile.TemporaryDirectory() as temporary:
        for name, (raw, expected_line) in fixtures.items():
            fixture = Path(temporary) / name
            fixture.write_bytes(raw)
            observed = fixture.read_bytes()
            require(b"\r\n" in observed, f"CRLF fixture was normalized before the regression ran: {name}")
            normalized = observed.decode("utf-8").replace("\r\n", "\n")
            require("\r\n" not in normalized, f"CRLF normalization left CRLF bytes: {name}")
            require(expected_line in normalized, f"patch marker was changed by normalization: {name}")

    for relative_path, variable in (
        ("include/ceed/ceed.h", "CEED_HEADER"),
        ("interface/ceed.c", "CEED_CORE_SOURCE"),
        ("interface/ceed-jit-tools.c", "CEED_JIT_TOOLS_SOURCE"),
    ):
        read_marker = f'file(READ "${{CEED_SOURCE_DIR}}/{relative_path}" {variable}'
        read_offset = cmake.index(read_marker)
        normalize_marker = f'string(REPLACE "\\r\\n" "\\n" {variable} "${{{variable}}}")'
        normalize_offset = cmake.find(normalize_marker, read_offset)
        require(
            normalize_offset > read_offset,
            f"{variable} is read without immediate CRLF normalization",
        )

    public_read = 'file(READ "${CEED_SOURCE_DIR}/include/ceed/ceed.h" CEED_PUBLIC_HEADER)'
    public_offset = cmake.index(public_read)
    public_normalize = (
        'string(REPLACE "\\r\\n" "\\n" CEED_PUBLIC_HEADER "${CEED_PUBLIC_HEADER}")'
    )
    require(
        cmake.find(public_normalize, public_offset) > public_offset,
        "CEED_PUBLIC_HEADER is read without CRLF normalization",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    args = parser.parse_args()

    source = args.source_dir.resolve()
    cmake = (ROOT / "CMakeLists.txt").read_text(encoding="utf-8")
    check_crlf_normalization_contract(cmake)
    compat = (ROOT / "ceed_windows_compat.c").read_text(encoding="utf-8")
    jit_template = (ROOT / "ceed_jit_source_root_install.c.in").read_text(encoding="utf-8")
    header = (source / "include/ceed/ceed.h").read_text(encoding="utf-8")
    core_source = (source / "interface/ceed.c").read_text(encoding="utf-8")
    jit_tools_source = (source / "interface/ceed-jit-tools.c").read_text(encoding="utf-8")
    makefile = (source / "Makefile").read_text(encoding="utf-8")
    backend_list = (source / "backends/ceed-backend-list.h").read_text(encoding="utf-8")

    require(source.is_dir(), f"libCEED source directory is missing: {source}")
    require(
        all(re.search(rf"#define CEED_VERSION_{name}[ \t]+{value}\b", header) for name, value in (
            ("MAJOR", "0"), ("MINOR", "12"), ("PATCH", "0")
        )),
        "source checkout is not libCEED v0.12.0",
    )
    require("interface/ceed-cuda.c" in makefile, "upstream CUDA interface source is not selected")
    for required_source in (r"cuda-ref\.cu\s*:=", r"cuda-shared\.cu\s*:="):
        require(re.search(required_source, makefile) is not None, f"upstream source list omits {required_source}")

    require("if(NOT WIN32)" in cmake, "adapter must refuse the Linux route")
    require(
        "if(NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)" in cmake,
        "adapter must require x64 with CMake's supported NOT-before-comparison grammar",
    )
    require(
        "CMAKE_SIZEOF_VOID_P NOT EQUAL 8" not in cmake,
        "adapter must not use CMake's unsupported infix NOT EQUAL grammar",
    )
    require('CMAKE_C_COMPILER_ID STREQUAL "Clang"' in cmake, "adapter must require clang-cl C")
    require('CMAKE_CXX_COMPILER_ID MATCHES "^(Clang|MSVC)$"' in cmake,
            "adapter must require an MSVC ABI C++ compiler")
    require("C_STANDARD 99" in cmake, "C99 mode is not explicit")
    require("CMAKE_MSVC_RUNTIME_LIBRARY" in cmake, "MSVC runtime selection is not explicit")
    require("CEED_SOURCE_DIR" in cmake and "FULLMAG_CEED_SOURCE_ROOT" in cmake,
            "source checkout must be an explicit input or managed compatibility alias")
    cuda_option = 'option(FULLMAG_CEED_ENABLE_CUDA "Build the CUDA libCEED provider" ON)'
    require(cuda_option in cmake, "CUDA provider switch is missing")
    require(cmake.index(cuda_option) < cmake.index("project("),
            "CUDA provider switch must be evaluated before language enablement")
    require("project(fullmag_native_ceed VERSION 0.12.0 LANGUAGES C CXX)" in cmake,
            "the project must keep C/C++ language setup common to both variants")
    require("if(FULLMAG_CEED_ENABLE_CUDA)\n    enable_language(CUDA)" in cmake,
            "CUDA mode must enable the CUDA language conditionally")
    require("if(FULLMAG_CEED_ENABLE_CUDA)\n    find_package(CUDAToolkit REQUIRED)" in cmake,
            "CUDA toolkit discovery must be conditional")
    require("refusing a CPU-only substitute" not in cmake,
            "CPU/ref mode must be a supported provider variant")
    require("FULLMAG_CEED_NO_CUDA=1" in cmake and "FULLMAG_CEED_NO_CUDA" in compat,
            "CPU/ref mode must supply explicit CUDA registration fallbacks")
    require("set(CEED_CUDA_C_SOURCES \"\")" in cmake and
            "set(CEED_CUDA_KERNEL_SOURCES \"\")" in cmake,
            "CPU/ref mode must initialize empty CUDA source sets")
    require('file(READ "${CEED_SOURCE_DIR}/interface/ceed.c"' in cmake,
            "the pinned core source must be read for a validated Windows adaptation")
    require('generated/interface/ceed-windows-core.c' in cmake,
            "the Windows allocator adaptation must be generated outside the pinned checkout")
    require("posix_memalign" in core_source, "the pinned v0.12.0 allocator guard is no longer exercising the known Windows issue")
    for allocator in ("_aligned_malloc", "_aligned_realloc", "_aligned_free"):
        require(allocator in cmake, f"Windows allocator adaptation is missing: {allocator}")
    calloc_guard = "if (unit && n > (size_t)-1 / unit)"
    calloc_multiplication = "bytes = n * unit;"
    require(calloc_guard in cmake, "Windows calloc adaptation lacks a size-overflow guard")
    require("calloc size overflow" in cmake, "Windows calloc overflow does not return a diagnostic error")
    require(
        cmake.index(calloc_guard) < cmake.index(calloc_multiplication, cmake.index(calloc_guard)),
        "Windows calloc adaptation multiplies before checking for size overflow",
    )
    require("generated/interface/ceed-windows-jit-tools.c" in cmake,
            "the Windows JiT path adaptation must be generated outside the pinned checkout")
    require("strrchr(source_file_path, '/')" in jit_tools_source,
            "the pinned JiT source must exercise the separator adaptation guard")
    require("last_colon = strrchr(source_file_path, ':')" in jit_tools_source,
            "the pinned JiT source must exercise the drive-colon adaptation guard")
    require("CeedWindowsLastPathSeparator" in cmake and "source_file_path + 1" in cmake,
            "Windows drive and path separators are not adapted")
    require("add_library(ceed SHARED" in cmake, "the provider must produce a DLL")
    require('RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}"' in cmake,
            "the DLL install location is missing")
    require('ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}"' in cmake,
            "the MSVC import-library install location is missing")
    require("native-ceed-adapter-manifest.txt" in cmake,
            "the installed adapter provenance manifest is missing")
    for manifest_field in ("windows_abi=x64-msvc", "/gpu/cuda/shared", "/cpu/self/ref/serial"):
        require(manifest_field in cmake, f"adapter provenance omits {manifest_field}")
    for manifest_value in (
        'set(CEED_MANIFEST_CUDA_RUNTIME "nvrtc")',
        'set(CEED_MANIFEST_CUDA_RUNTIME "disabled")',
    ):
        require(manifest_value in cmake, f"adapter provenance omits {manifest_value}")
    require("if(FULLMAG_CEED_ENABLE_CUDA)\n    target_link_libraries(ceed PRIVATE" in cmake,
            "CUDA link dependencies must be conditional")
    for cuda_target in ("CUDA::cudart", "CUDA::cuda_driver", "CUDA::nvrtc", "CUDA::cublas"):
        require(cuda_target in cmake, f"CUDA link target is missing: {cuda_target}")
    require("WINDOWS_EXPORT_ALL_SYMBOLS ON" in cmake, "DLL export/import-library generation is not enabled")
    require("CUDA_SEPARABLE_COMPILATION ON" in cmake, "CUDA device linking is not enabled")
    require("CUDA_RESOLVE_DEVICE_SYMBOLS ON" in cmake, "CUDA device symbol resolution is not enabled")
    require("CEED_JIT_SOURCE_ROOT_DEFAULT" in cmake, "installed JiT source root is not configured")
    require("@CEED_JIT_SOURCE_ROOT_DEFAULT@" in jit_template, "JiT root template is malformed")
    require("CEED_BUILDING_DLL=1" in cmake, "the DLL build must export the public MSVC ABI")
    require("__declspec(dllexport)" in cmake and "__declspec(dllimport)" in cmake,
            "the installed public header must import/export the Windows ABI")
    require('"${CMAKE_CURRENT_BINARY_DIR}/generated"' in cmake,
            "the DLL must compile against the generated Windows public header")
    require('"#define CEED_SKIP_VISIBILITY 1\\n"' in cmake,
            "installed Windows public header must suppress ELF visibility attributes")

    require("/gpu/cuda/shared" in backend_list, "upstream backend list omits /gpu/cuda/shared")
    require("/cpu/self/ref/serial" in backend_list, "upstream backend list omits the CPU reference lane")
    require('CeedRegister("/gpu/cuda/shared"' in (
        source / "backends/cuda-shared/ceed-cuda-shared.c"
    ).read_text(encoding="utf-8"), "CUDA shared registration is not the upstream one")
    require('CeedRegister("/cpu/self/ref/serial"' in (
        source / "backends/ref/ceed-ref.c"
    ).read_text(encoding="utf-8"), "CPU reference registration is not the upstream one")

    require("ceed-backend-weak.c" not in cmake, "COFF-incompatible upstream weak backend source was selected")
    require("ceed-gallery-weak.c" not in cmake, "COFF-incompatible upstream weak gallery source was selected")
    for fallback in (
        "CeedRegister_Cuda",
        "CeedRegister_Cuda_Gen",
        "CeedRegister_Cuda_Shared",
        "CeedRegister_Avx_Serial",
        "CeedRegister_Hip",
        "CeedRegister_Sycl",
        "CeedRegister_Magma",
        "CeedRegister_Opt_Serial",
        "CeedRegister_Ref_Blocked",
        "CeedRegister_Xsmm_Serial",
    ):
        require(fallback in compat, f"Windows fallback registration is missing: {fallback}")
    backend_names = re.findall(r"CEED_BACKEND\((CeedRegister_[A-Za-z0-9_]+),", backend_list)
    retained_names = {
        "CeedRegister_Cuda", "CeedRegister_Cuda_Gen", "CeedRegister_Cuda_Shared", "CeedRegister_Ref"
    }
    require(backend_names, "upstream backend registration list is empty")
    for name in backend_names:
        require(name in retained_names or name in compat,
                f"Windows target has no implementation or fallback for {name}")
    require(re.search(r"\bCeedRegister_Ref\s*\(", compat) is None,
            "real CPU reference registration was replaced")
    for retained_cuda in ("CeedRegister_Cuda", "CeedRegister_Cuda_Gen", "CeedRegister_Cuda_Shared"):
        require(f"CEED_WINDOWS_UNAVAILABLE_BACKEND({retained_cuda}" in compat,
                f"CPU/ref mode lacks a conditional CUDA fallback: {retained_cuda}")

    print("native libCEED Windows contract: PASS (source/CMake inspection only)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
