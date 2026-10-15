# Repair MFEM v4.9's Windows warning option at the provider boundary.
#
# MFEM adds /wd4819 as an unqualified PUBLIC option.  With MFEM_USE_CUDA=ON
# its .cpp sources are compiled by nvcc, so CMake emits the raw MSVC option
# beside nvcc's own arguments instead of passing it through -Xcompiler.  The
# pinned MFEM checkout stays read-only: defer this target-property correction
# until MFEM has created and populated the target.

function(_fullmag_fix_mfem_windows_cuda_options)
  if(NOT WIN32 OR NOT MSVC OR NOT MFEM_USE_CUDA OR NOT TARGET mfem)
    return()
  endif()
  get_target_property(_fullmag_already_patched mfem
    FULLMAG_MFEM_CUDA_OPTIONS_PATCHED)
  if(_fullmag_already_patched)
    return()
  endif()
  set_property(TARGET mfem PROPERTY FULLMAG_MFEM_CUDA_OPTIONS_PATCHED TRUE)

  # MFEM v4.9 exposes this namespace-scope const from kernels.hpp to
  # MFEM_HOST_DEVICE functions.  CUDA 13.3 on the MSVC toolchain does not
  # make that host-only object visible during device compilation.  Generate
  # a build-local copy with a device declaration for the exact upstream
  # marker, and pre-include it for MFEM's CUDA translation units.  The pinned
  # source tree remains read-only and the exact marker is fail-closed.
  set(_fullmag_mfem_source "${CMAKE_CURRENT_SOURCE_DIR}")
  set(_fullmag_mfem_kernels "${_fullmag_mfem_source}/linalg/kernels.hpp")
  if(NOT EXISTS "${_fullmag_mfem_kernels}")
    message(FATAL_ERROR
      "MFEM CUDA compatibility hook cannot find linalg/kernels.hpp: "
      "${_fullmag_mfem_kernels}")
  endif()
  file(READ "${_fullmag_mfem_kernels}" _fullmag_kernels_source)
  string(REPLACE "\r\n" "\n" _fullmag_kernels_source
    "${_fullmag_kernels_source}")
  set(_fullmag_epsilon_host
    "const real_t Epsilon = std::numeric_limits<real_t>::epsilon();")
  set(_fullmag_epsilon_device [=[
#if defined(__CUDA_ARCH__)
#if defined(MFEM_USE_SINGLE)
__device__ const real_t Epsilon = 1.1920928955078125e-7F;
#else
__device__ const real_t Epsilon = 2.220446049250313080847263336181640625e-16;
#endif
#else
const real_t Epsilon = std::numeric_limits<real_t>::epsilon();
#endif]=])
  set(_fullmag_lzclz_compat [=[
#if defined(_MSC_VER) && defined(__CUDACC__) && !defined(FULLMAG_MFEM_LZCLZ_COMPAT)
#define FULLMAG_MFEM_LZCLZ_COMPAT
__host__ __device__ inline int fullmag_mfem_lzclz(unsigned int value)
{
#if defined(__CUDA_ARCH__)
  return __clz(static_cast<int>(value));
#else
  int result = 0;
  if (value == 0u) { return 32; }
  while ((value & 0x80000000u) == 0u)
  {
    value <<= 1;
    ++result;
  }
  return result;
#endif
}
#ifndef __lzclz
#define __lzclz(value) fullmag_mfem_lzclz(static_cast<unsigned int>(value))
#endif
#endif]=])
  string(FIND "${_fullmag_kernels_source}" "${_fullmag_epsilon_host}"
    _fullmag_epsilon_offset)
  if(_fullmag_epsilon_offset GREATER_EQUAL 0)
    string(REPLACE "${_fullmag_epsilon_host}" "${_fullmag_epsilon_device}"
      _fullmag_kernels_source "${_fullmag_kernels_source}")
  else()
    string(FIND "${_fullmag_kernels_source}" "__device__ const real_t Epsilon"
      _fullmag_epsilon_offset)
    if(_fullmag_epsilon_offset LESS 0)
      message(FATAL_ERROR
        "MFEM CUDA compatibility hook found no recognized Epsilon marker in: "
        "${_fullmag_mfem_kernels}")
    endif()
  endif()

  # MFEM v4.9's MSVC branch spells the CUDA leading-zero intrinsic as
  # __lzclz, which CUDA 13.3 does not provide. Keep the repair private to
  # CUDA/MSVC translation units: use CUDA's device __clz and a small bounded
  # host implementation for nvcc's host pass.
  string(PREPEND _fullmag_kernels_source
    "${_fullmag_lzclz_compat}\n")

  # The generated header is outside the source tree, so keep the pinned
  # header's relative dependencies valid by resolving its four includes to
  # the frozen MFEM source directory before writing it.
  file(TO_CMAKE_PATH "${_fullmag_mfem_source}" _fullmag_mfem_source_cmake)
  # MFEM's CUDA branch uses GNU-style inline PTX in MFEM_ABORT_KERNEL.  NVCC
  # 13.3 with the MSVC host frontend rejects that declaration while parsing
  # the host/device lambda.  Include the pinned error header first so its
  # include guard prevents a later redefinition, then preserve the device
  # abort as CUDA's supported __trap() builtin.  The host pass keeps MFEM's
  # original host abort macro and all non-CUDA providers are untouched.
  set(_fullmag_mfem_abort_kernel_compat [=[
#if defined(_MSC_VER) && defined(__CUDACC__) && defined(__CUDA_ARCH__) && !defined(FULLMAG_MFEM_ABORT_KERNEL_COMPAT)
#define FULLMAG_MFEM_ABORT_KERNEL_COMPAT
#undef MFEM_ABORT_KERNEL
#define MFEM_ABORT_KERNEL(...) \
   {                           \
      printf(__VA_ARGS__);     \
      __trap();                \
   }
#endif]=])
  set(_fullmag_mfem_cuda_preamble
    "#include \"${_fullmag_mfem_source_cmake}/general/error.hpp\"\n${_fullmag_mfem_abort_kernel_compat}\n")
  string(PREPEND _fullmag_kernels_source "${_fullmag_mfem_cuda_preamble}")
  string(REPLACE "#include \"../config/config.hpp\""
    "#include \"${_fullmag_mfem_source_cmake}/config/config.hpp\""
    _fullmag_kernels_source "${_fullmag_kernels_source}")
  foreach(_fullmag_dependency IN ITEMS tmatrix.hpp tlayout.hpp ttensor.hpp)
    string(REPLACE "#include \"${_fullmag_dependency}\""
      "#include \"${_fullmag_mfem_source_cmake}/linalg/${_fullmag_dependency}\""
      _fullmag_kernels_source "${_fullmag_kernels_source}")
  endforeach()

  set(_fullmag_mfem_compat_dir
    "${CMAKE_CURRENT_BINARY_DIR}/fullmag-mfem-cuda-compat")
  set(_fullmag_mfem_compat_header
    "${_fullmag_mfem_compat_dir}/kernels.hpp")
  file(MAKE_DIRECTORY "${_fullmag_mfem_compat_dir}")
  set(_fullmag_write_compat_header TRUE)
  if(EXISTS "${_fullmag_mfem_compat_header}")
    # CMake's Windows text writer may persist LF as CRLF. Compare the
    # existing text after the same CRLF-to-LF normalization used for the
    # generated source, so an unchanged header keeps its original mtime.
    file(READ "${_fullmag_mfem_compat_header}" _fullmag_existing_compat_source)
    string(REPLACE "\r\n" "\n" _fullmag_existing_compat_source
      "${_fullmag_existing_compat_source}")
    string(SHA256 _fullmag_existing_compat_sha256
      "${_fullmag_existing_compat_source}")
    string(SHA256 _fullmag_generated_compat_sha256 "${_fullmag_kernels_source}")
    if(_fullmag_existing_compat_sha256 STREQUAL _fullmag_generated_compat_sha256)
      set(_fullmag_write_compat_header FALSE)
    endif()
  endif()
  if(_fullmag_write_compat_header)
    file(WRITE "${_fullmag_mfem_compat_header}" "${_fullmag_kernels_source}")
  endif()
  set_property(TARGET mfem PROPERTY FULLMAG_MFEM_CUDA_COMPAT_HEADER
    "${_fullmag_mfem_compat_header}")

  foreach(_fullmag_property IN ITEMS COMPILE_OPTIONS INTERFACE_COMPILE_OPTIONS)
    get_target_property(_fullmag_options mfem "${_fullmag_property}")
    if(_fullmag_options STREQUAL "_fullmag_options-NOTFOUND")
      set(_fullmag_options "")
    endif()
    list(REMOVE_ITEM _fullmag_options "/wd4819")
    list(APPEND _fullmag_options
      "$<$<COMPILE_LANGUAGE:CXX>:/wd4819>"
      "$<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=/wd4819>")
    set_property(TARGET mfem PROPERTY "${_fullmag_property}" "${_fullmag_options}")
  endforeach()

  get_target_property(_fullmag_compile_options mfem COMPILE_OPTIONS)
  if(_fullmag_compile_options STREQUAL "_fullmag_compile_options-NOTFOUND")
    set(_fullmag_compile_options "")
  endif()
  list(APPEND _fullmag_compile_options
    "$<$<COMPILE_LANGUAGE:CUDA>:--pre-include>"
    "$<$<COMPILE_LANGUAGE:CUDA>:${_fullmag_mfem_compat_header}>")
  set_property(TARGET mfem PROPERTY COMPILE_OPTIONS
    "${_fullmag_compile_options}")
  # ode.cpp uses M_PI.  MSVC's math headers expose it only when this macro is
  # defined before inclusion; scope the compatibility definition to MFEM.
  get_target_property(_fullmag_target_type mfem TYPE)
  if(_fullmag_target_type STREQUAL "INTERFACE_LIBRARY")
    set_property(TARGET mfem APPEND PROPERTY INTERFACE_COMPILE_DEFINITIONS
      _USE_MATH_DEFINES)
  else()
    target_compile_definitions(mfem PRIVATE _USE_MATH_DEFINES)
  endif()
endfunction()

# CMake 3.25 is the managed Windows minimum and supports DEFER (3.19+).
cmake_language(DEFER CALL _fullmag_fix_mfem_windows_cuda_options)
