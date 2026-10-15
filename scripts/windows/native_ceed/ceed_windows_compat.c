// Windows compatibility registrations for the libCEED v0.12.0 DLL.
//
// Upstream libCEED uses ELF weak symbols to report optional backends that were
// not compiled.  COFF/MSVC does not provide the same weak-definition contract,
// so this adapter supplies ordinary fallback registrations for the optional
// entries while retaining the real CPU reference and, when enabled, CUDA
// registrations.

#include <ceed.h>
#include <ceed/backend.h>
#include <stdarg.h>

static int CeedInit_WindowsUnavailable(const char *resource, Ceed ceed) {
  return CeedError(ceed, CEED_ERROR_UNSUPPORTED,
                   "Backend not currently compiled in the native Windows libCEED package: %s", resource);
}

static int CeedRegister_WindowsUnavailable(const char *name, int num_prefixes, ...) {
  va_list prefixes;
  va_start(prefixes, num_prefixes);
  for (int i = 0; i < num_prefixes; i++) {
    const char *prefix = va_arg(prefixes, const char *);
    CeedRegister(prefix, CeedInit_WindowsUnavailable, CEED_MAX_BACKEND_PRIORITY);
  }
  va_end(prefixes);
  (void)name;
  return CEED_ERROR_SUCCESS;
}

#define CEED_WINDOWS_UNAVAILABLE_BACKEND(name, num_prefixes, ...) \
  int name(void) { return CeedRegister_WindowsUnavailable(#name, num_prefixes, __VA_ARGS__); }

#if defined(FULLMAG_CEED_NO_CUDA)
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Cuda, 1, "/gpu/cuda/ref")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Cuda_Gen, 1, "/gpu/cuda/gen")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Cuda_Shared, 1, "/gpu/cuda/shared")
#endif

CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Avx_Blocked, 1, "/cpu/self/avx/blocked")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Avx_Serial, 1, "/cpu/self/avx/serial")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Hip, 1, "/gpu/hip/ref")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Hip_Gen, 1, "/gpu/hip/gen")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Hip_Shared, 1, "/gpu/hip/shared")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Sycl, 1, "/gpu/sycl/ref")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Sycl_Shared, 1, "/gpu/sycl/shared")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Sycl_Gen, 1, "/gpu/sycl/gen")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Magma, 2, "/gpu/cuda/magma", "/gpu/hip/magma")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Magma_Det, 2, "/gpu/cuda/magma/det", "/gpu/hip/magma/det")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Memcheck_Blocked, 1, "/cpu/self/memcheck/blocked")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Memcheck_Serial, 1, "/cpu/self/memcheck/serial")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Occa, 6, "/cpu/self/occa", "/cpu/openmp/occa", "/gpu/dpcpp/occa", "/gpu/opencl/occa", "/gpu/hip/occa", "/gpu/cuda/occa")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Opt_Blocked, 1, "/cpu/self/opt/blocked")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Opt_Serial, 1, "/cpu/self/opt/serial")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Ref_Blocked, 1, "/cpu/self/ref/blocked")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Xsmm_Blocked, 1, "/cpu/self/xsmm/blocked")
CEED_WINDOWS_UNAVAILABLE_BACKEND(CeedRegister_Xsmm_Serial, 1, "/cpu/self/xsmm/serial")

#undef CEED_WINDOWS_UNAVAILABLE_BACKEND
