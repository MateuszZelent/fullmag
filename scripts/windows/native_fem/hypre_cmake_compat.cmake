# Keep HYPRE v3.1.0's generated CUDA source identity stable across configure
# runs.  Its seq_mv CMakeLists.txt tests generated filenames relative to the
# process working directory, while file(WRITE) resolves them relative to the
# source directory.  The provider invokes configure from seq_mv and this
# scoped hook validates the exact generated contents before HYPRE's own guard.

if(NOT FULLMAG_HYPRE_COMPAT_ENABLE)
  return()
endif()
if(NOT FULLMAG_HYPRE_COMPAT_SOURCE_ROOT)
  message(FATAL_ERROR
    "FULLMAG_HYPRE_COMPAT_SOURCE_ROOT is required for the HYPRE provider hook")
endif()

set(_fullmag_hypre_seq_mv
  "${FULLMAG_HYPRE_COMPAT_SOURCE_ROOT}/src/seq_mv")
if(NOT IS_DIRECTORY "${_fullmag_hypre_seq_mv}")
  message(FATAL_ERROR
    "HYPRE provider hook cannot find src/seq_mv: ${_fullmag_hypre_seq_mv}")
endif()

foreach(_fullmag_hypre_template IN ITEMS
    csr_spgemm_device_numer.in
    csr_spgemm_device_symbl.in)
  set(_fullmag_hypre_template_path
    "${_fullmag_hypre_seq_mv}/${_fullmag_hypre_template}")
  if(NOT EXISTS "${_fullmag_hypre_template_path}")
    message(FATAL_ERROR
      "HYPRE provider hook cannot find template: ${_fullmag_hypre_template_path}")
  endif()
  file(READ "${_fullmag_hypre_template_path}" _fullmag_hypre_template_contents)
  string(REPLACE "\r\n" "\n" _fullmag_hypre_template_contents
    "${_fullmag_hypre_template_contents}")
  string(REPLACE "\r" "\n" _fullmag_hypre_template_contents
    "${_fullmag_hypre_template_contents}")

  if(_fullmag_hypre_template STREQUAL "csr_spgemm_device_numer.in")
    set(_fullmag_hypre_prefix csr_spgemm_device_numer)
  else()
    set(_fullmag_hypre_prefix csr_spgemm_device_symbl)
  endif()

  foreach(_fullmag_hypre_number RANGE 1 10)
    set(_fullmag_hypre_generated
      "${_fullmag_hypre_seq_mv}/${_fullmag_hypre_prefix}${_fullmag_hypre_number}.c")
    set(_fullmag_hypre_expected
      "#define HYPRE_SPGEMM_BIN ${_fullmag_hypre_number}${_fullmag_hypre_template_contents}")
    set(_fullmag_hypre_write TRUE)
    if(EXISTS "${_fullmag_hypre_generated}")
      file(READ "${_fullmag_hypre_generated}" _fullmag_hypre_existing)
      string(REPLACE "\r\n" "\n" _fullmag_hypre_existing
        "${_fullmag_hypre_existing}")
      string(REPLACE "\r" "\n" _fullmag_hypre_existing
        "${_fullmag_hypre_existing}")
      if("${_fullmag_hypre_existing}" STREQUAL "${_fullmag_hypre_expected}")
        set(_fullmag_hypre_write FALSE)
      endif()
    endif()
    if(_fullmag_hypre_write)
      file(WRITE "${_fullmag_hypre_generated}" "${_fullmag_hypre_expected}")
    endif()
  endforeach()
endforeach()
