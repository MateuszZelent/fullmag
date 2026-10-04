# Import the runtime and link-time library for the selected target platform.
function(fullmag_import_external_fdm library_dir include_dir)
    if(WIN32)
        set(runtime_library "${library_dir}/fullmag_fdm.dll")
        if(MSVC)
            set(import_library "${library_dir}/fullmag_fdm.lib")
        else()
            set(import_library "${library_dir}/libfullmag_fdm.dll.a")
        endif()
        if(NOT EXISTS "${runtime_library}" OR IS_DIRECTORY "${runtime_library}")
            message(FATAL_ERROR "External Windows FDM runtime is missing: ${runtime_library}")
        endif()
        if(NOT EXISTS "${import_library}" OR IS_DIRECTORY "${import_library}")
            message(FATAL_ERROR "External Windows FDM import library is missing: ${import_library}")
        endif()
        add_library(fullmag_fdm SHARED IMPORTED GLOBAL)
        set_target_properties(fullmag_fdm PROPERTIES
            IMPORTED_LOCATION "${runtime_library}"
            IMPORTED_IMPLIB "${import_library}"
            INTERFACE_INCLUDE_DIRECTORIES "${include_dir}"
        )
    else()
        if(EXISTS "${library_dir}/libfullmag_fdm.so" AND NOT IS_DIRECTORY "${library_dir}/libfullmag_fdm.so")
            set(runtime_library "${library_dir}/libfullmag_fdm.so")
        elseif(EXISTS "${library_dir}/libfullmag_fdm.so.0" AND NOT IS_DIRECTORY "${library_dir}/libfullmag_fdm.so.0")
            set(runtime_library "${library_dir}/libfullmag_fdm.so.0")
        else()
            message(FATAL_ERROR "External FDM directory does not contain libfullmag_fdm.so or libfullmag_fdm.so.0: ${library_dir}")
        endif()
        add_library(fullmag_fdm SHARED IMPORTED GLOBAL)
        set_target_properties(fullmag_fdm PROPERTIES
            IMPORTED_LOCATION "${runtime_library}"
            IMPORTED_NO_SONAME FALSE
            INTERFACE_INCLUDE_DIRECTORIES "${include_dir}"
        )
    endif()
endfunction()
