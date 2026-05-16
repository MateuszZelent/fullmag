# ── FEM Backend ──
# Builds libfullmag_fem as a shared library.
# Current stage: ABI + dispatch scaffold.
# Real MFEM/libCEED/hypre sources will be added behind FULLMAG_USE_MFEM_STACK.

option(FULLMAG_ENABLE_FEM_GPU "Build FEM GPU backend scaffold" ON)
option(FULLMAG_USE_MFEM_STACK "Build FEM backend against MFEM/libCEED/hypre" OFF)

set(FEM_PUBLIC_HEADERS
    ${CMAKE_SOURCE_DIR}/include/fullmag_fem.h
)

set(FEM_SOURCES
    cpu/mfem/interactions/anisotropy.cpp
    cpu/mfem/interactions/demag.cpp
    cpu/mfem/interactions/demag_fem_bem.cpp
    cpu/mfem/interactions/demag_poisson.cpp
    cpu/mfem/interactions/dmi.cpp
    cpu/mfem/interactions/effective_field.cpp
    cpu/mfem/interactions/exchange.cpp
    cpu/mfem/interactions/magnetoelastic.cpp
    cpu/mfem/interactions/oersted.cpp
    cpu/mfem/interactions/stt.cpp
    cpu/mfem/interactions/thermal_brown.cpp
    cpu/mfem/interactions/zeeman.cpp
    cpu/mfem/integrators/adaptive_dt.cpp
    cpu/mfem/integrators/heun.cpp
    cpu/mfem/integrators/llg_rhs.cpp
    cpu/mfem/integrators/rk_explicit.cpp
    cpu/mfem/integrators/rk_stage_rhs.cpp
    cpu/mfem/integrators/rk4.cpp
    cpu/mfem/integrators/rk23.cpp
    cpu/mfem/integrators/rk45.cpp
    cpu/mfem/runtime/aos_field.cpp
    cpu/mfem/runtime/cpu_threads.cpp
    cpu/mfem/runtime/mfem_device.cpp
    cpu/mfem/runtime/stage_completion.cpp
    cpu/mfem/runtime/step_metrics.cpp
    src/api.cpp
    src/context.cpp
    src/dmi_weak_residual.cpp
    src/error.cpp
    src/gpu_exchange.cpp
    src/gpu_rk.cpp
    src/gpu_state.cpp
    src/transfer_audit.cpp
)

if(FULLMAG_USE_MFEM_STACK)
    find_package(MFEM CONFIG REQUIRED)

    list(APPEND FEM_SOURCES
        src/mfem_bridge.cpp
    )

    # S11: CUDA fused kernels (LLG RHS, normalize, accumulate)
    if(FULLMAG_ENABLE_CUDA)
        enable_language(CUDA)
        list(APPEND FEM_SOURCES
            src/kernels.cu
            src/gpu_rk.cu
        )
    endif()
endif()

add_library(fullmag_fem SHARED ${FEM_SOURCES})

target_include_directories(fullmag_fem
    PUBLIC
        ${CMAKE_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(FULLMAG_USE_MFEM_STACK)
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_MFEM_STACK=1)
    if(FULLMAG_ENABLE_CUDA)
        target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_CUDA_RUNTIME=1)
        target_link_libraries(fullmag_fem PRIVATE CUDA::cudart)
    else()
        target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_CUDA_RUNTIME=0)
    endif()
    if(TARGET MFEM::mfem)
        target_link_libraries(fullmag_fem PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fullmag_fem PRIVATE mfem)
    endif()
else()
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_MFEM_STACK=0)
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_HAS_CUDA_RUNTIME=0)
endif()

set_target_properties(fullmag_fem PROPERTIES
    VERSION 0.1.0
    SOVERSION 0
    PUBLIC_HEADER "${FEM_PUBLIC_HEADERS}"
)

# ── Tests ──
enable_testing()

add_executable(fem_gpu_state_info tests/gpu_state_info.cpp)
target_link_libraries(fem_gpu_state_info PRIVATE fullmag_fem)
add_test(NAME fem_gpu_state_info COMMAND fem_gpu_state_info)

add_executable(fem_gpu_rk_plan tests/gpu_rk_plan.cpp)
target_link_libraries(fem_gpu_rk_plan PRIVATE fullmag_fem)
target_include_directories(fem_gpu_rk_plan PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fem_gpu_rk_plan COMMAND fem_gpu_rk_plan)

add_executable(fem_transfer_audit tests/transfer_audit.cpp)
target_link_libraries(fem_transfer_audit PRIVATE fullmag_fem)
target_include_directories(fem_transfer_audit PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fem_transfer_audit COMMAND fem_transfer_audit)

add_executable(fem_dmi_weak_residual tests/dmi_weak_residual.cpp)
target_link_libraries(fem_dmi_weak_residual PRIVATE fullmag_fem)
target_include_directories(fem_dmi_weak_residual PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fem_dmi_weak_residual COMMAND fem_dmi_weak_residual)

add_executable(fem_anisotropy_contract tests/anisotropy_contract.cpp)
target_link_libraries(fem_anisotropy_contract PRIVATE fullmag_fem)
target_include_directories(fem_anisotropy_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_anisotropy_contract COMMAND fem_anisotropy_contract)

add_executable(fem_exchange_contract tests/exchange_contract.cpp)
target_link_libraries(fem_exchange_contract PRIVATE fullmag_fem)
target_include_directories(fem_exchange_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_exchange_contract COMMAND fem_exchange_contract)

add_executable(fem_effective_field_contract tests/effective_field_contract.cpp)
target_link_libraries(fem_effective_field_contract PRIVATE fullmag_fem)
target_include_directories(fem_effective_field_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_effective_field_contract COMMAND fem_effective_field_contract)

add_executable(fem_zeeman_contract tests/zeeman_contract.cpp)
target_link_libraries(fem_zeeman_contract PRIVATE fullmag_fem)
target_include_directories(fem_zeeman_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_zeeman_contract COMMAND fem_zeeman_contract)

add_executable(fem_oersted_contract tests/oersted_contract.cpp)
target_link_libraries(fem_oersted_contract PRIVATE fullmag_fem)
target_include_directories(fem_oersted_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_oersted_contract COMMAND fem_oersted_contract)

add_executable(fem_thermal_brown_contract tests/thermal_brown_contract.cpp)
target_link_libraries(fem_thermal_brown_contract PRIVATE fullmag_fem)
target_include_directories(fem_thermal_brown_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_thermal_brown_contract COMMAND fem_thermal_brown_contract)

add_executable(fem_stt_contract tests/stt_contract.cpp)
target_link_libraries(fem_stt_contract PRIVATE fullmag_fem)
target_include_directories(fem_stt_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_stt_contract COMMAND fem_stt_contract)

add_executable(fem_magnetoelastic_contract tests/magnetoelastic_contract.cpp)
target_link_libraries(fem_magnetoelastic_contract PRIVATE fullmag_fem)
target_include_directories(fem_magnetoelastic_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_magnetoelastic_contract COMMAND fem_magnetoelastic_contract)

add_executable(fem_dmi_contract tests/dmi_contract.cpp)
target_link_libraries(fem_dmi_contract PRIVATE fullmag_fem)
target_include_directories(fem_dmi_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_dmi_contract COMMAND fem_dmi_contract)

add_executable(fem_llg_rhs_contract tests/llg_rhs_contract.cpp)
target_link_libraries(fem_llg_rhs_contract PRIVATE fullmag_fem)
target_include_directories(fem_llg_rhs_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_llg_rhs_contract COMMAND fem_llg_rhs_contract)

add_executable(fem_adaptive_dt_contract tests/adaptive_dt_contract.cpp)
target_link_libraries(fem_adaptive_dt_contract PRIVATE fullmag_fem)
target_include_directories(fem_adaptive_dt_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_adaptive_dt_contract COMMAND fem_adaptive_dt_contract)

add_executable(fem_rk_explicit_contract tests/rk_explicit_contract.cpp)
target_link_libraries(fem_rk_explicit_contract PRIVATE fullmag_fem)
target_include_directories(fem_rk_explicit_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_rk_explicit_contract COMMAND fem_rk_explicit_contract)

add_executable(fem_cpu_threads_contract tests/cpu_threads_contract.cpp)
target_link_libraries(fem_cpu_threads_contract PRIVATE fullmag_fem)
target_include_directories(fem_cpu_threads_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_cpu_threads_contract COMMAND fem_cpu_threads_contract)

add_executable(fem_step_metrics_contract tests/step_metrics_contract.cpp)
target_link_libraries(fem_step_metrics_contract PRIVATE fullmag_fem)
target_include_directories(fem_step_metrics_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_step_metrics_contract COMMAND fem_step_metrics_contract)

add_executable(fem_stage_completion_contract tests/stage_completion_contract.cpp)
target_link_libraries(fem_stage_completion_contract PRIVATE fullmag_fem)
target_include_directories(fem_stage_completion_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_stage_completion_contract COMMAND fem_stage_completion_contract)

add_executable(fem_aos_field_contract tests/aos_field_contract.cpp)
target_link_libraries(fem_aos_field_contract PRIVATE fullmag_fem)
target_include_directories(fem_aos_field_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_aos_field_contract COMMAND fem_aos_field_contract)

add_executable(fem_demag_poisson_contract tests/demag_poisson_contract.cpp)
target_link_libraries(fem_demag_poisson_contract PRIVATE fullmag_fem)
target_include_directories(fem_demag_poisson_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_demag_poisson_contract COMMAND fem_demag_poisson_contract)

add_executable(fem_demag_fem_bem_contract tests/demag_fem_bem_contract.cpp)
target_link_libraries(fem_demag_fem_bem_contract PRIVATE fullmag_fem)
target_include_directories(fem_demag_fem_bem_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_demag_fem_bem_contract COMMAND fem_demag_fem_bem_contract)

add_executable(fem_demag_contract tests/demag_contract.cpp)
target_link_libraries(fem_demag_contract PRIVATE fullmag_fem)
target_include_directories(fem_demag_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_demag_contract COMMAND fem_demag_contract)

add_executable(fem_interaction_docs_contract tests/interaction_docs_contract.cpp)
target_link_libraries(fem_interaction_docs_contract PRIVATE fullmag_fem)
target_include_directories(fem_interaction_docs_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_interaction_docs_contract COMMAND fem_interaction_docs_contract)

add_executable(fem_contract_validation tests/contract_validation.cpp)
target_link_libraries(fem_contract_validation PRIVATE fullmag_fem)
target_include_directories(fem_contract_validation PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fem_contract_validation COMMAND fem_contract_validation)

# S14: PA vs Assembled benchmark (opt-in)
if(FULLMAG_USE_MFEM_STACK)
    add_executable(pa_benchmark examples/pa_benchmark.cpp)
    target_link_libraries(pa_benchmark PRIVATE fullmag_fem)
    if(TARGET MFEM::mfem)
        target_link_libraries(pa_benchmark PRIVATE MFEM::mfem)
    else()
        target_link_libraries(pa_benchmark PRIVATE mfem)
    endif()
    if(FULLMAG_ENABLE_CUDA)
        target_link_libraries(pa_benchmark PRIVATE CUDA::cudart)
    endif()
    set_target_properties(pa_benchmark PROPERTIES EXCLUDE_FROM_ALL TRUE)
endif()
