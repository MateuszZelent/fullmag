#include "cpu/mfem/runtime/runtime_build_info.hpp"

#include <cstdio>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

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

} // namespace fullmag::fem
