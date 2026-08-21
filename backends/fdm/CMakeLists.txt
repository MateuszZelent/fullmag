# ── FDM Backend ──
# Builds libfullmag_fdm as a shared library.
# When CUDA is enabled: real GPU implementation.
# When CUDA is disabled: stub that returns "unavailable".

set(FDM_PUBLIC_HEADERS
    ${CMAKE_SOURCE_DIR}/include/fullmag_fdm.h
)

set(FDM_SOURCES
    api/c_api.cpp
    api/error.cpp
    gpu/cuda/transport/layout_abi_v1.cpp
    gpu/cuda/transport/checkpoint_abi_v1.cpp
    gpu/cuda/transport/charge/checkpoint_codec.cpp
    gpu/cuda/transport/spin/checkpoint_codec.cpp
    gpu/cuda/transport/spin/memory_policy.cpp
)

if(FULLMAG_ENABLE_CUDA)
    list(APPEND FDM_SOURCES
        gpu/cuda/transport/context.cu
        gpu/cuda/transport/charge/device_solver.cu
        gpu/cuda/transport/spin/device_solver.cu
        gpu/cuda/transport/spin/sparse_solver.cu
        gpu/cuda/runtime/context.cu
        gpu/cuda/runtime/llg_checkpoint.cpp
        gpu/cuda/runtime/telemetry.cu
        gpu/cuda/runtime/device_info.cpp
        gpu/cuda/runtime/streams.cu
        gpu/cuda/runtime/reductions_fp64.cu
        gpu/cuda/interactions/exchange_fp64.cu
        gpu/cuda/interactions/exchange_fp32.cu
        gpu/cuda/interactions/multilayer_exchange.cu
        gpu/cuda/interactions/multilayer_dmi.cu
        gpu/cuda/interactions/multilayer_anisotropy.cu
        gpu/cuda/interactions/multilayer_effective_field.cu
        gpu/cuda/interactions/exchange_t0_fp64.cu
        gpu/cuda/interactions/exchange_t1_fp64.cu
        gpu/cuda/interactions/demag_fp64.cu
        gpu/cuda/interactions/demag_fp32.cu
        gpu/cuda/interactions/energy_density_fp64.cu
        gpu/cuda/interactions/demag_boundary_fp64.cu
        gpu/cuda/integrators/llg_fp64.cu
        gpu/cuda/integrators/transport_rhs_fp64.cu
        gpu/cuda/integrators/llg_fp32.cu
        gpu/cuda/integrators/llg_dp45_fp64.cu
        gpu/cuda/integrators/llg_dp45_fp32.cu
        gpu/cuda/integrators/llg_rk4_fp64.cu
        gpu/cuda/integrators/llg_rk4_fp32.cu
        gpu/cuda/integrators/llg_rk23_fp64.cu
        gpu/cuda/integrators/llg_rk23_fp32.cu
        gpu/cuda/integrators/llg_abm3_fp64.cu
        gpu/cuda/integrators/llg_abm3_fp32.cu
        gpu/cuda/integrators/multilayer_heun.cu
        gpu/cuda/integrators/multilayer_explicit_rk.cu
        gpu/cuda/demag/multilayer_convolution.cu
        gpu/cuda/demag/newell_gpu_fp64.cu
        gpu/cuda/demag/newell_gpu_fp32.cu
    )
else()
    list(APPEND FDM_SOURCES
        gpu/cpu_only/transport_abi_v1_stubs.cpp
    )
endif()

add_library(fullmag_fdm SHARED ${FDM_SOURCES})

file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/context.cu" FDM_GPU_CONTEXT_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/charge/device_solver.cu" FDM_GPU_CHARGE_SOLVER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/charge/device_solver.hpp" FDM_GPU_CHARGE_SOLVER_HEADER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/device_solver.cu" FDM_GPU_SPIN_SOLVER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/device_solver.hpp" FDM_GPU_SPIN_SOLVER_HEADER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/sparse_solver.cu" FDM_GPU_SPIN_SPARSE_SOLVER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/sparse_solver.hpp" FDM_GPU_SPIN_SPARSE_SOLVER_HEADER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/memory_policy.cpp" FDM_GPU_SPIN_MEMORY_POLICY_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/memory_policy.hpp" FDM_GPU_SPIN_MEMORY_POLICY_HEADER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/charge/checkpoint_codec.cpp" FDM_GPU_CHARGE_CHECKPOINT_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/charge/checkpoint_codec.hpp" FDM_GPU_CHARGE_CHECKPOINT_HEADER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/checkpoint_codec.cpp" FDM_GPU_SPIN_CHECKPOINT_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin/checkpoint_codec.hpp" FDM_GPU_SPIN_CHECKPOINT_HEADER_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/layout_abi_v1.cpp" FDM_GPU_LAYOUT_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/checkpoint_abi_v1.cpp" FDM_GPU_CHECKPOINT_SHA256)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/include/fullmag/fdm/transport/gpu_abi_v1.h" FDM_GPU_HEADER_SHA256)
set(FDM_GPU_BUILD_FLAGS_IDENTITY
    "cxx=${CMAKE_CXX_COMPILER_ID}-${CMAKE_CXX_COMPILER_VERSION};cuda=${CMAKE_CUDA_COMPILER_ID}-${CMAKE_CUDA_COMPILER_VERSION};cxx_flags=${CMAKE_CXX_FLAGS};cuda_flags=${CMAKE_CUDA_FLAGS};arch=${CMAKE_CUDA_ARCHITECTURES}"
)
string(REPLACE ";" "," FDM_GPU_BUILD_FLAGS_IDENTITY "${FDM_GPU_BUILD_FLAGS_IDENTITY}")
string(SHA256 FDM_GPU_TRANSPORT_BUILD_DIGEST
    "${FDM_GPU_CONTEXT_SHA256};${FDM_GPU_CHARGE_SOLVER_SHA256};${FDM_GPU_CHARGE_SOLVER_HEADER_SHA256};${FDM_GPU_SPIN_SOLVER_SHA256};${FDM_GPU_SPIN_SOLVER_HEADER_SHA256};${FDM_GPU_SPIN_SPARSE_SOLVER_SHA256};${FDM_GPU_SPIN_SPARSE_SOLVER_HEADER_SHA256};${FDM_GPU_SPIN_MEMORY_POLICY_SHA256};${FDM_GPU_SPIN_MEMORY_POLICY_HEADER_SHA256};${FDM_GPU_CHARGE_CHECKPOINT_SHA256};${FDM_GPU_CHARGE_CHECKPOINT_HEADER_SHA256};${FDM_GPU_SPIN_CHECKPOINT_SHA256};${FDM_GPU_SPIN_CHECKPOINT_HEADER_SHA256};${FDM_GPU_LAYOUT_SHA256};${FDM_GPU_CHECKPOINT_SHA256};${FDM_GPU_HEADER_SHA256};${FDM_GPU_BUILD_FLAGS_IDENTITY}"
)
target_compile_definitions(fullmag_fdm PRIVATE
    FULLMAG_FDM_GPU_TRANSPORT_BUILD_DIGEST_HEX="${FDM_GPU_TRANSPORT_BUILD_DIGEST}"
)

add_library(fullmag_fdm_cpu_transport_abi OBJECT
    api/cpu_transport_v1.cpp
    api/cpu_oersted_fft_v1.cpp
)
set_target_properties(fullmag_fdm_cpu_transport_abi PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)
target_include_directories(fullmag_fdm_cpu_transport_abi PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fullmag_fdm_cpu_transport_abi PRIVATE
        -Wall -Wextra -Wpedantic -Werror
    )
endif()
target_sources(fullmag_fdm PRIVATE
    $<TARGET_OBJECTS:fullmag_fdm_cpu_transport_abi>
)

add_library(fullmag_fdm_cpu_transport STATIC
    cpu/transport/charge_transport_v1.cpp
    cpu/transport/spin_transport_gmres_v1.cpp
    cpu/transport/spin_transport_validation_v1.cpp
    cpu/transport/spin_transport_v1.cpp
)
set_target_properties(fullmag_fdm_cpu_transport PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)
target_include_directories(fullmag_fdm_cpu_transport
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fullmag_fdm_cpu_transport PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

add_library(fullmag_fdm_cpu_oersted STATIC
    cpu/interactions/oersted/digest_v1.cpp
    cpu/interactions/oersted/cell_integrated_kernel_v1.cpp
    cpu/interactions/oersted/fft_plan_v1.cpp
    cpu/interactions/oersted/differential_diagnostics_v1.cpp
    cpu/interactions/oersted/fft_open_v1.cpp
)
set_target_properties(fullmag_fdm_cpu_oersted PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)
target_include_directories(fullmag_fdm_cpu_oersted
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/cpu/interactions/oersted
)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fullmag_fdm_cpu_oersted PRIVATE
        -Wall -Wextra -Wpedantic -Werror
    )
endif()

target_include_directories(fullmag_fdm
    PUBLIC
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(FULLMAG_ENABLE_CUDA)
    target_compile_definitions(fullmag_fdm PRIVATE FULLMAG_HAS_CUDA=1)

    # Architecture targets: Ampere, Ada Lovelace, Hopper
    set_target_properties(fullmag_fdm PROPERTIES
        CUDA_ARCHITECTURES "80;86;89;90"
    )

    target_link_libraries(fullmag_fdm PRIVATE
        CUDA::cudart
        CUDA::cufft
    )
else()
    target_compile_definitions(fullmag_fdm PRIVATE FULLMAG_HAS_CUDA=0)
endif()

target_link_libraries(fullmag_fdm PRIVATE
    fullmag_fdm_cpu_transport
    fullmag_fdm_cpu_oersted
)

set_target_properties(fullmag_fdm PROPERTIES
    VERSION 0.1.0
    SOVERSION 0
    PUBLIC_HEADER "${FDM_PUBLIC_HEADERS}"
)

# ── Tests ──
enable_testing()

add_executable(fdm_gpu_m1_spin_memory_policy_contract
    tests/gpu_m1_spin_memory_policy_contract.cpp
    gpu/cuda/transport/spin/memory_policy.cpp
)
target_include_directories(fdm_gpu_m1_spin_memory_policy_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_gpu_m1_spin_memory_policy_contract PRIVATE
        -Wall -Wextra -Wpedantic -Werror
    )
endif()
add_test(NAME fdm_gpu_m1_spin_memory_policy_contract
         COMMAND fdm_gpu_m1_spin_memory_policy_contract)

add_executable(source_layout_contract tests/source_layout_contract.cpp)
add_test(NAME fdm_source_layout_contract COMMAND source_layout_contract)

add_executable(multilayer_abi_v2_contract tests/multilayer_abi_v2_contract.cpp)
target_include_directories(multilayer_abi_v2_contract PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fdm_multilayer_abi_v2_contract COMMAND multilayer_abi_v2_contract)

add_executable(frozen_spins_abi_contract tests/frozen_spins_abi_contract.cpp)
target_include_directories(frozen_spins_abi_contract PRIVATE
    ${CMAKE_SOURCE_DIR}/include
)
target_link_libraries(frozen_spins_abi_contract PRIVATE fullmag_fdm)
target_compile_definitions(frozen_spins_abi_contract PRIVATE
    FULLMAG_FDM_TEST_CUDA_BUILD=$<BOOL:${FULLMAG_ENABLE_CUDA}>
)
add_test(NAME fdm_frozen_spins_abi_contract COMMAND frozen_spins_abi_contract)

add_executable(region_owned_abi_contract tests/region_owned_abi_contract.cpp)
add_test(NAME fdm_region_owned_abi_contract COMMAND region_owned_abi_contract)

add_executable(periodic_exchange_fp32_contract tests/periodic_exchange_fp32_contract.cpp)
add_test(NAME fdm_periodic_exchange_fp32_contract COMMAND periodic_exchange_fp32_contract)

add_executable(fp32_subcell_contract tests/fp32_subcell_contract.cpp)
add_test(NAME fdm_fp32_subcell_contract COMMAND fp32_subcell_contract)

add_executable(demag_missing_spectra_contract tests/demag_missing_spectra_contract.cpp)
add_test(NAME fdm_demag_missing_spectra_contract COMMAND demag_missing_spectra_contract)

add_executable(bulk_dmi_sign_contract tests/bulk_dmi_sign_contract.cpp)
add_test(NAME fdm_bulk_dmi_sign_contract COMMAND bulk_dmi_sign_contract)

add_executable(inactive_torque_mask_contract tests/inactive_torque_mask_contract.cpp)
add_test(NAME fdm_inactive_torque_mask_contract COMMAND inactive_torque_mask_contract)

add_executable(thermal_brown_contract tests/thermal_brown_contract.cpp)
add_test(NAME fdm_thermal_brown_contract COMMAND thermal_brown_contract)

add_executable(sot_rhs_contract tests/sot_rhs_contract.cpp)
add_test(NAME fdm_sot_rhs_contract COMMAND sot_rhs_contract)

add_executable(stt_pbc_contract tests/stt_pbc_contract.cpp)
add_test(NAME fdm_stt_pbc_contract COMMAND stt_pbc_contract)

add_executable(oersted_energy_contract tests/oersted_energy_contract.cpp)
add_test(NAME fdm_oersted_energy_contract COMMAND oersted_energy_contract)

add_executable(partial_cell_energy_contract tests/partial_cell_energy_contract.cpp)
add_test(NAME fdm_partial_cell_energy_contract COMMAND partial_cell_energy_contract)

add_executable(fdm_llg_time_policy_contract tests/llg_time_policy_contract.cpp)
target_include_directories(fdm_llg_time_policy_contract PRIVATE ${CMAKE_SOURCE_DIR}/include)
target_link_libraries(fdm_llg_time_policy_contract PRIVATE fullmag_fdm)
if(FULLMAG_ENABLE_CUDA)
    target_compile_definitions(fdm_llg_time_policy_contract PRIVATE FULLMAG_FDM_CONTRACT_HAS_CUDA=1)
else()
    target_compile_definitions(fdm_llg_time_policy_contract PRIVATE FULLMAG_FDM_CONTRACT_HAS_CUDA=0)
endif()
add_test(NAME fdm_llg_time_policy_contract COMMAND fdm_llg_time_policy_contract)

add_executable(prescribed_sot_contract tests/prescribed_sot_contract.cpp)
target_include_directories(prescribed_sot_contract PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
add_test(NAME fdm_prescribed_sot_contract COMMAND prescribed_sot_contract)

add_executable(fdm_cpu_charge_transport_contract tests/cpu_charge_transport_contract.cpp)
target_include_directories(fdm_cpu_charge_transport_contract PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(fdm_cpu_charge_transport_contract PRIVATE fullmag_fdm_cpu_transport)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_cpu_charge_transport_contract PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME fdm_cpu_charge_transport_contract COMMAND fdm_cpu_charge_transport_contract)
add_test(NAME fdm_cpu_charge_parity_rejects_nonfinite
         COMMAND fdm_cpu_charge_transport_contract --compare-rust
                 ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/charge_parity_v1.txt
                 ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/charge_parity_nan_output_v1.txt)
set_tests_properties(fdm_cpu_charge_parity_rejects_nonfinite PROPERTIES WILL_FAIL TRUE)
add_test(NAME fdm_cpu_charge_parity_rejects_small_current_mismatch
         COMMAND fdm_cpu_charge_transport_contract --reject-small-current-mismatch)
set_tests_properties(fdm_cpu_charge_parity_rejects_small_current_mismatch PROPERTIES WILL_FAIL TRUE)

add_executable(fdm_cpu_spin_transport_contract tests/cpu_spin_transport_contract.cpp)
target_include_directories(fdm_cpu_spin_transport_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/cpu/transport
)
target_link_libraries(fdm_cpu_spin_transport_contract PRIVATE fullmag_fdm_cpu_transport)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_cpu_spin_transport_contract PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME fdm_cpu_spin_transport_contract COMMAND fdm_cpu_spin_transport_contract)

add_executable(fdm_cpu_spin_transport_parity tests/cpu_spin_transport_parity.cpp)
target_include_directories(fdm_cpu_spin_transport_parity PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(fdm_cpu_spin_transport_parity PRIVATE fullmag_fdm_cpu_transport)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_cpu_spin_transport_parity PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

add_executable(fdm_cpu_transport_abi_v1_contract tests/cpu_transport_abi_v1_contract.cpp)
target_include_directories(fdm_cpu_transport_abi_v1_contract PRIVATE
    ${CMAKE_SOURCE_DIR}/include
)
target_link_libraries(fdm_cpu_transport_abi_v1_contract PRIVATE fullmag_fdm)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_cpu_transport_abi_v1_contract PRIVATE
        -Wall -Wextra -Wpedantic -Werror
    )
endif()
add_test(NAME fdm_cpu_transport_abi_v1_contract COMMAND fdm_cpu_transport_abi_v1_contract)

if(FULLMAG_ENABLE_CUDA)
    add_executable(fdm_gpu_transport_layout_abi_v1_contract
        tests/gpu_transport_layout_abi_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_transport_layout_abi_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_transport_layout_abi_v1_contract PRIVATE fullmag_fdm CUDA::cudart)
    target_compile_definitions(fdm_gpu_transport_layout_abi_v1_contract PRIVATE
        FULLMAG_SOURCE_ROOT="${CMAKE_SOURCE_DIR}/.."
        FULLMAG_FDM_GPU_TRANSPORT_COMPILER_FLAGS="${FDM_GPU_BUILD_FLAGS_IDENTITY}"
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_transport_layout_abi_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_transport_layout_abi_v1_contract
             COMMAND fdm_gpu_transport_layout_abi_v1_contract)

    add_executable(fdm_gpu_transport_registry_fail_closed_v1_contract
        tests/gpu_transport_registry_fail_closed_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_transport_registry_fail_closed_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_transport_registry_fail_closed_v1_contract PRIVATE fullmag_fdm)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_transport_registry_fail_closed_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_transport_registry_fail_closed_v1_contract
             COMMAND fdm_gpu_transport_registry_fail_closed_v1_contract)

    add_executable(fdm_gpu_transport_checkpoint_semantic_v1_contract
        tests/checkpoint_abi_v1_semantic_contract.cpp
    )
    target_include_directories(fdm_gpu_transport_checkpoint_semantic_v1_contract PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_compile_definitions(fdm_gpu_transport_checkpoint_semantic_v1_contract PRIVATE
        FULLMAG_SOURCE_ROOT="${CMAKE_SOURCE_DIR}/.."
    )
    target_link_libraries(fdm_gpu_transport_checkpoint_semantic_v1_contract PRIVATE
        fullmag_fdm crypto
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_transport_checkpoint_semantic_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_transport_checkpoint_semantic_v1_contract
             COMMAND fdm_gpu_transport_checkpoint_semantic_v1_contract)

    add_executable(fdm_gpu_m1_charge_uniform_v1_contract
        tests/gpu_m1_charge_uniform_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_charge_uniform_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_m1_charge_uniform_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_charge_uniform_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_charge_uniform_v1_contract
             COMMAND fdm_gpu_m1_charge_uniform_v1_contract)
    set_tests_properties(fdm_gpu_m1_charge_uniform_v1_contract PROPERTIES
        ENVIRONMENT "FULLMAG_FDM_GPU_M1_CHARGE_EVIDENCE_PATH=${CMAKE_CURRENT_BINARY_DIR}/fdm-gpu-m1-charge-uniform-ctest-v1.json"
    )

    add_executable(fdm_gpu_m1_charge_scalability_v1_contract
        tests/gpu_m1_charge_scalability_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_charge_scalability_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_m1_charge_scalability_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart
    )
    target_compile_definitions(fdm_gpu_m1_charge_scalability_v1_contract PRIVATE
        FULLMAG_SOURCE_ROOT="${CMAKE_SOURCE_DIR}/.."
        FULLMAG_CXX_COMPILER="${CMAKE_CXX_COMPILER_ID}-${CMAKE_CXX_COMPILER_VERSION}"
        FULLMAG_CUDA_COMPILER="${CMAKE_CUDA_COMPILER_ID}-${CMAKE_CUDA_COMPILER_VERSION}"
        FULLMAG_FMA_POLICY="cuda-fp64-default"
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_charge_scalability_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_charge_scalability_v1_contract
             COMMAND fdm_gpu_m1_charge_scalability_v1_contract)
    set_tests_properties(fdm_gpu_m1_charge_scalability_v1_contract PROPERTIES
        ENVIRONMENT "FULLMAG_FDM_GPU_M1_CHARGE_SCALABILITY_EVIDENCE_PATH=${CMAKE_CURRENT_BINARY_DIR}/fdm-gpu-m1-charge-scalability-ctest-v1.json"
    )

    add_executable(fdm_gpu_m1_charge_layered_v1_contract
        tests/gpu_m1_charge_layered_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_charge_layered_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_m1_charge_layered_v1_contract PRIVATE
        fullmag_fdm fullmag_fdm_cpu_transport CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_charge_layered_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_charge_layered_v1_contract
             COMMAND fdm_gpu_m1_charge_layered_v1_contract)
    set_tests_properties(fdm_gpu_m1_charge_layered_v1_contract PROPERTIES
        ENVIRONMENT "FULLMAG_FDM_GPU_M1_CHARGE_LAYERED_EVIDENCE_PATH=${CMAKE_CURRENT_BINARY_DIR}/fdm-gpu-m1-charge-layered-ctest-v1.json"
    )

    add_executable(fdm_gpu_m1_charge_snapshot_v1_contract
        tests/gpu_m1_charge_snapshot_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_charge_snapshot_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport
    )
    target_link_libraries(fdm_gpu_m1_charge_snapshot_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart crypto
    )
    target_compile_definitions(fdm_gpu_m1_charge_snapshot_v1_contract PRIVATE
        FULLMAG_SOURCE_ROOT="${CMAKE_SOURCE_DIR}/.."
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_charge_snapshot_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_charge_snapshot_v1_contract
             COMMAND fdm_gpu_m1_charge_snapshot_v1_contract)
    set_tests_properties(fdm_gpu_m1_charge_snapshot_v1_contract PROPERTIES
        ENVIRONMENT "FULLMAG_FDM_GPU_M1_CHARGE_SNAPSHOT_EVIDENCE_PATH=${CMAKE_CURRENT_BINARY_DIR}/fdm-gpu-m1-charge-snapshot-ctest-v1.json"
    )

    add_executable(fdm_gpu_m1_charge_boundary_mutation_v1_contract
        tests/gpu_m1_charge_boundary_mutation_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_charge_boundary_mutation_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_m1_charge_boundary_mutation_v1_contract PRIVATE
        fullmag_fdm fullmag_fdm_cpu_transport CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_charge_boundary_mutation_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_charge_boundary_mutation_v1_contract
             COMMAND fdm_gpu_m1_charge_boundary_mutation_v1_contract)
    set_tests_properties(fdm_gpu_m1_charge_boundary_mutation_v1_contract PROPERTIES
        ENVIRONMENT "FULLMAG_FDM_GPU_M1_CHARGE_MUTATION_EVIDENCE_PATH=${CMAKE_CURRENT_BINARY_DIR}/fdm-gpu-m1-charge-mutation-ctest-v1.json"
    )

    add_executable(fdm_gpu_m1_charge_transfer_audit_v1_contract
        tests/gpu_m1_charge_transfer_audit_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_charge_transfer_audit_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_m1_charge_transfer_audit_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_charge_transfer_audit_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_charge_transfer_audit_v1_contract
             COMMAND fdm_gpu_m1_charge_transfer_audit_v1_contract)

    add_executable(fdm_gpu_m1_spin_diffusion_she_v1_contract
        tests/gpu_m1_spin_diffusion_she_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_spin_diffusion_she_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin
    )
    target_link_libraries(fdm_gpu_m1_spin_diffusion_she_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_spin_diffusion_she_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_spin_diffusion_she_v1_contract
             COMMAND fdm_gpu_m1_spin_diffusion_she_v1_contract)

    add_executable(fdm_gpu_m1_spin_operator_parity_v1_contract
        tests/gpu_m1_spin_operator_parity_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_spin_operator_parity_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/cpu/transport
    )
    target_link_libraries(fdm_gpu_m1_spin_operator_parity_v1_contract PRIVATE
        fullmag_fdm fullmag_fdm_cpu_transport CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_spin_operator_parity_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_spin_operator_parity_v1_contract
             COMMAND fdm_gpu_m1_spin_operator_parity_v1_contract)

    add_executable(fdm_gpu_m1_spin_sparse_dispatch_v1_contract
        tests/gpu_m1_spin_sparse_dispatch_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_spin_sparse_dispatch_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_m1_spin_sparse_dispatch_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_spin_sparse_dispatch_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_spin_sparse_dispatch_v1_contract
             COMMAND fdm_gpu_m1_spin_sparse_dispatch_v1_contract)

    add_executable(fdm_gpu_m1_spin_sparse_performance_v1_contract
        tests/gpu_m1_spin_sparse_performance_v1_contract.cu
    )
    target_include_directories(fdm_gpu_m1_spin_sparse_performance_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/gpu/cuda/transport/spin
    )
    target_link_libraries(fdm_gpu_m1_spin_sparse_performance_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart
    )
    if(CMAKE_CUDA_COMPILER_ID MATCHES "NVIDIA|Clang")
        target_compile_options(fdm_gpu_m1_spin_sparse_performance_v1_contract PRIVATE
            $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=-Wall,-Wextra,-Werror>
        )
    endif()
    add_test(NAME fdm_gpu_m1_spin_sparse_performance_v1_contract
             COMMAND fdm_gpu_m1_spin_sparse_performance_v1_contract)

    add_executable(fdm_gpu_m1_transport_llg_stage_v1_contract
        tests/gpu_m1_transport_llg_stage_v1_contract.cpp
    )
    target_include_directories(fdm_gpu_m1_transport_llg_stage_v1_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_m1_transport_llg_stage_v1_contract PRIVATE
        fullmag_fdm CUDA::cudart
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_m1_transport_llg_stage_v1_contract PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_m1_transport_llg_stage_v1_contract
             COMMAND fdm_gpu_m1_transport_llg_stage_v1_contract)
endif()

if(NOT FULLMAG_ENABLE_CUDA)
    add_executable(fdm_gpu_transport_cpu_only_symbol_graph
        tests/gpu_transport_cpu_only_symbol_graph.cpp
    )
    target_include_directories(fdm_gpu_transport_cpu_only_symbol_graph PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    target_link_libraries(fdm_gpu_transport_cpu_only_symbol_graph PRIVATE fullmag_fdm)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(fdm_gpu_transport_cpu_only_symbol_graph PRIVATE
            -Wall -Wextra -Wpedantic -Werror
        )
    endif()
    add_test(NAME fdm_gpu_transport_cpu_only_symbol_graph
             COMMAND ${CMAKE_COMMAND} -E env
                     LD_LIBRARY_PATH=$<TARGET_FILE_DIR:fullmag_fdm>
                     $<TARGET_FILE:fdm_gpu_transport_cpu_only_symbol_graph>)
endif()

add_executable(fdm_gpu_transport_layout_abi_v1_c11_contract
    tests/gpu_transport_layout_abi_v1_c11_contract.c
)
target_include_directories(fdm_gpu_transport_layout_abi_v1_c11_contract PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
set_target_properties(fdm_gpu_transport_layout_abi_v1_c11_contract PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED ON
    C_EXTENSIONS OFF
)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_gpu_transport_layout_abi_v1_c11_contract PRIVATE
        -Wall -Wextra -Wpedantic -Werror
    )
endif()
add_test(NAME fdm_gpu_transport_layout_abi_v1_c11_contract
         COMMAND fdm_gpu_transport_layout_abi_v1_c11_contract)

add_executable(fdm_cpu_oersted_fft_open_contract
    tests/cpu_oersted_fft_open_contract.cpp
    tests/oersted_direct_oracle_v1.cpp
)
target_include_directories(fdm_cpu_oersted_fft_open_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(fdm_cpu_oersted_fft_open_contract PRIVATE
    fullmag_fdm_cpu_oersted
)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_cpu_oersted_fft_open_contract PRIVATE
        -Wall -Wextra -Wpedantic -Werror
    )
endif()
add_test(NAME fdm_cpu_oersted_fft_open_contract COMMAND fdm_cpu_oersted_fft_open_contract)

add_executable(fdm_cpu_oersted_fft_public_abi_contract
    tests/cpu_oersted_fft_public_abi_contract.cpp
)
target_include_directories(fdm_cpu_oersted_fft_public_abi_contract PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(fdm_cpu_oersted_fft_public_abi_contract PRIVATE
    fullmag_fdm
)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(fdm_cpu_oersted_fft_public_abi_contract PRIVATE
        -Wall -Wextra -Wpedantic -Werror
    )
endif()
add_test(NAME fdm_cpu_oersted_fft_public_abi_contract
         COMMAND fdm_cpu_oersted_fft_public_abi_contract)

add_executable(demag_observable_contract tests/demag_observable_contract.cpp)
add_test(NAME fdm_demag_observable_contract COMMAND demag_observable_contract)

add_executable(energy_density_observable_contract
    tests/energy_density_observable_contract.cpp)
add_test(NAME fdm_energy_density_observable_contract
         COMMAND energy_density_observable_contract)

if(FULLMAG_ENABLE_CUDA)
    add_executable(smoke_context tests/smoke_context.cpp)
    target_link_libraries(smoke_context PRIVATE fullmag_fdm)
    add_test(NAME fdm_smoke_context COMMAND smoke_context)

    add_executable(exchange_fp64_parity tests/exchange_fp64_parity.cu)
    target_link_libraries(exchange_fp64_parity PRIVATE fullmag_fdm)
    add_test(NAME fdm_exchange_fp64_parity COMMAND exchange_fp64_parity)

    add_executable(heun_fp64_parity tests/heun_fp64_parity.cu)
    target_link_libraries(heun_fp64_parity PRIVATE fullmag_fdm)
    add_test(NAME fdm_heun_fp64_parity COMMAND heun_fp64_parity)

    add_executable(prescribed_sot_cuda_runtime tests/prescribed_sot_cuda_runtime.cu)
    target_include_directories(prescribed_sot_cuda_runtime PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    target_link_libraries(prescribed_sot_cuda_runtime PRIVATE fullmag_fdm)
    add_test(NAME fdm_prescribed_sot_cuda_runtime COMMAND prescribed_sot_cuda_runtime)

    add_executable(oersted_cuda_runtime tests/oersted_cuda_runtime.cu)
    target_include_directories(oersted_cuda_runtime PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    target_link_libraries(oersted_cuda_runtime PRIVATE fullmag_fdm)
    add_test(NAME fdm_oersted_cuda_runtime COMMAND oersted_cuda_runtime)

    add_executable(tier_a_compare tests/tier_a_compare.cu)
    target_link_libraries(tier_a_compare PRIVATE fullmag_fdm)
    add_test(NAME fdm_tier_a_compare COMMAND tier_a_compare)

    add_executable(tier_b_compare tests/tier_b_compare.cu)
    target_link_libraries(tier_b_compare PRIVATE fullmag_fdm)
    add_test(NAME fdm_tier_b_compare COMMAND tier_b_compare)

    add_executable(adaptive_error_reduction_contract tests/adaptive_error_reduction_contract.cpp)
    add_test(NAME fdm_adaptive_error_reduction_contract COMMAND adaptive_error_reduction_contract)

    add_executable(stats_mode_contract tests/stats_mode_contract.cpp)
    add_test(NAME fdm_stats_mode_contract COMMAND stats_mode_contract)

    add_executable(batched_demag_fft_contract tests/batched_demag_fft_contract.cpp)
    add_test(NAME fdm_batched_demag_fft_contract COMMAND batched_demag_fft_contract)

    add_executable(async_snapshot_contract tests/async_snapshot_contract.cpp)
    add_test(NAME fdm_async_snapshot_contract COMMAND async_snapshot_contract)

    add_executable(multilayer_create_v2_contract tests/multilayer_create_v2_contract.cpp)
    target_link_libraries(multilayer_create_v2_contract PRIVATE fullmag_fdm)
    set_target_properties(multilayer_create_v2_contract PROPERTIES
        BUILD_RPATH "$<TARGET_FILE_DIR:fullmag_fdm>"
    )
    add_test(NAME fdm_multilayer_create_v2_contract COMMAND multilayer_create_v2_contract)
    set_tests_properties(fdm_multilayer_create_v2_contract PROPERTIES
        ENVIRONMENT "LD_LIBRARY_PATH=$<TARGET_FILE_DIR:fullmag_fdm>"
    )
endif()
