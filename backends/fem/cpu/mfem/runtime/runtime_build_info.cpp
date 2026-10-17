#include "cpu/mfem/runtime/runtime_build_info.hpp"

#include <cstdio>

#ifdef __has_include
#  if __has_include("fullmag_fem_runtime_source_snapshot.hpp")
#    include "fullmag_fem_runtime_source_snapshot.hpp"
#    define FULLMAG_FEM_HAS_GENERATED_SOURCE_SNAPSHOT 1
#  endif
#endif

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#include <HYPRE.h>
#endif

#ifndef FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256
#define FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256 ""
#endif

namespace fullmag::fem {

const char *runtime_source_snapshot_sha256() noexcept
{
#if defined(FULLMAG_FEM_HAS_GENERATED_SOURCE_SNAPSHOT)
    return detail::kRuntimeSourceSnapshotSha256;
#else
    return FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256;
#endif
}

bool runtime_build_info(fullmag_fem_runtime_build_info &out_info)
{
    out_info = {};
    out_info.abi_version = FULLMAG_FEM_RUNTIME_BUILD_INFO_V1_ABI_VERSION;
    out_info.struct_size = sizeof(out_info);
#if FULLMAG_HAS_MFEM_STACK
    const int major = mfem::GetVersionMajor();
    const int minor = mfem::GetVersionMinor();
    std::snprintf(out_info.mfem_version, sizeof(out_info.mfem_version), "%d.%d", major, minor);
    return true;
#else
    return false;
#endif
}

bool runtime_build_info_v2(fullmag_fem_runtime_build_info_v2 &out_info)
{
    out_info = {};
    out_info.abi_version = FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION;
    out_info.struct_size = sizeof(out_info);
#if FULLMAG_HAS_MFEM_STACK
    const int major = mfem::GetVersionMajor();
    const int minor = mfem::GetVersionMinor();
    std::snprintf(out_info.mfem_version, sizeof(out_info.mfem_version), "%d.%d", major, minor);
    HYPRE_Int hypre_major = 0;
    HYPRE_Int hypre_minor = 0;
    HYPRE_Int hypre_patch = 0;
    if (HYPRE_VersionNumber(&hypre_major, &hypre_minor, &hypre_patch, nullptr) != 0) {
        return false;
    }
    std::snprintf(out_info.hypre_version, sizeof(out_info.hypre_version), "%d.%d.%d",
                  static_cast<int>(hypre_major), static_cast<int>(hypre_minor),
                  static_cast<int>(hypre_patch));
    return true;
#else
    return false;
#endif
}

} // namespace fullmag::fem
