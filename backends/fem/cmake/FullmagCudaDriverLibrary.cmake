function(_fullmag_reject_cuda_stub_path path label)
    file(TO_CMAKE_PATH "${path}" _normalized_path)
    string(TOLOWER "${_normalized_path}" _normalized_path_lower)
    if(_normalized_path_lower MATCHES "(^|/)stubs(/|$)")
        message(FATAL_ERROR
            "Refusing CUDA toolkit stub library for ${label}: ${path}")
    endif()
endfunction()

function(fullmag_find_cuda_driver_library output_variable)
    set(_candidate "${${output_variable}}")
    if(NOT _candidate OR _candidate MATCHES "-NOTFOUND$")
        set(_compat_hints)
        if(CMAKE_CUDA_COMPILER_TOOLKIT_ROOT)
            list(APPEND _compat_hints
                "${CMAKE_CUDA_COMPILER_TOOLKIT_ROOT}/compat")
        endif()
        if(CUDAToolkit_LIBRARY_ROOT)
            list(APPEND _compat_hints "${CUDAToolkit_LIBRARY_ROOT}/../compat")
        endif()

        if(_compat_hints)
            find_library(${output_variable} NAMES cuda HINTS ${_compat_hints})
        else()
            find_library(${output_variable} NAMES cuda)
        endif()
        set(_candidate "${${output_variable}}")
    endif()

    if(NOT _candidate OR _candidate MATCHES "-NOTFOUND$")
        message(FATAL_ERROR
            "CUDA-enabled FEM source-facade contracts require an installed "
            "CUDA driver or compatibility library")
    endif()
    if(NOT IS_ABSOLUTE "${_candidate}")
        message(FATAL_ERROR
            "CUDA driver library must be an absolute path: ${_candidate}")
    endif()
    if(NOT EXISTS "${_candidate}" OR IS_DIRECTORY "${_candidate}")
        message(FATAL_ERROR
            "CUDA driver library path does not name an existing file: ${_candidate}")
    endif()

    _fullmag_reject_cuda_stub_path("${_candidate}" "selected path")
    get_filename_component(_resolved_candidate "${_candidate}" REALPATH)
    if(NOT _resolved_candidate OR NOT EXISTS "${_resolved_candidate}")
        message(FATAL_ERROR
            "CUDA driver library could not be resolved to an existing file: ${_candidate}")
    endif()
    _fullmag_reject_cuda_stub_path("${_resolved_candidate}" "resolved path")

    set(${output_variable} "${_resolved_candidate}" PARENT_SCOPE)
endfunction()
