# ── FEM Backend ──
# Builds libfullmag_fem as a shared library.
# Current stage: canonical native FEM backend with CPU/MFEM production
# relaxation and gated CUDA runtime sources behind FULLMAG_ENABLE_CUDA.

option(FULLMAG_ENABLE_FEM_GPU "Build FEM GPU backend sources" ON)
option(FULLMAG_USE_MFEM_STACK "Build FEM backend against MFEM/libCEED/hypre" OFF)
option(FULLMAG_FEM_WITH_SLEPC "Build FEM frequency-domain dependency slice against PETSc/SLEPc" ON)
option(FULLMAG_ENABLE_NVTX "Enable phase-level FEM GPU NVTX ranges" OFF)

if(FULLMAG_ENABLE_CUDA AND FULLMAG_ENABLE_FEM_GPU AND NOT CMAKE_CUDA_ARCHITECTURES)
    message(FATAL_ERROR
        "FEM CUDA builds require a non-empty CMAKE_CUDA_ARCHITECTURES. "
        "Repo-managed recipes default it to 'native'; set "
        "FULLMAG_CUDA_ARCHITECTURES for a portable build matrix.")
endif()

option(FULLMAG_OET0_TSAN "Instrument the OE-T0 serial contract with ThreadSanitizer" OFF)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

set(FEM_PUBLIC_HEADERS
    ${CMAKE_SOURCE_DIR}/include/fullmag_fem.h
)

set(FEM_SOURCES
    core/fem_field_buffers.cpp
    core/fem_context_builder.cpp
    core/demag_linear_solve_validation.cpp
    core/demag_solver_policy.cpp
    core/fem_element_quadrature_material.cpp
    core/fem_material_fields.cpp
    core/fem_material_runtime.cpp
    core/fem_mesh.cpp
    core/fem_plan_fields.cpp
    core/fem_state.cpp
    cpu/mfem/transport/steady_transport_c_api.cpp
    gpu/cuda/exchange/exchange_plan.cpp
    gpu/cuda/exchange/exchange_upload.cpp
    gpu/cuda/fields/field_buffer_memory.cpp
    gpu/cuda/fields/field_buffer_upload.cpp
    gpu/cuda/demag_poisson/hypre_stream_interop.cpp
    gpu/cuda/integrators/rk/rk_fsal_policy.cpp
    gpu/cuda/integrators/rk/rk_plan.cpp
    gpu/cuda/integrators/rk/rk_snapshot.cpp
    gpu/cuda/integrators/rk/rk_step_stats.cpp
    gpu/cuda/integrators/rk/rk_step_stats_publication.cpp
    gpu/cuda/integrators/rk/rk_workspace_memory.cpp
    gpu/cuda/interactions/local_interaction_workspace_memory.cpp
    gpu/cuda/interactions/magnetoelastic/magnetoelastic_memory.cpp
    gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp
    gpu/cuda/mesh/mesh_geometry_upload.cpp
    gpu/cuda/reductions/reduction_workspace_memory.cpp
    gpu/cuda/relaxation/direct_energy_increment.cpp
    gpu/cuda/relaxation/nonlinear_cg.cpp
    gpu/cuda/relaxation/pgbb.cpp
    gpu/cuda/relaxation/relaxation_memory.cpp
    gpu/cuda/state/device_memory.cpp
    gpu/cuda/state/gpu_state.cpp
    gpu/cuda/state/magnetization_memory.cpp
    gpu/cuda/state/magnetization_transfer.cpp
    gpu/cuda/state/runtime_coefficients_memory.cpp
    gpu/cuda/state/runtime_coefficients_upload.cpp
    gpu/cuda/transfer/component_transfer.cpp
    gpu/cuda/transfer/snapshot_pool.cpp
    gpu/cuda/transfer/transfer_audit.cpp
    cpu/mfem/interactions/anisotropy.cpp
    cpu/mfem/interactions/anisotropy_cubic.cpp
    cpu/mfem/interactions/anisotropy_uniaxial.cpp
    cpu/mfem/interactions/demag.cpp
    cpu/mfem/interactions/demag_fem_bem.cpp
    cpu/mfem/interactions/demag_fem_bem_boundary_values.cpp
    cpu/mfem/interactions/demag_fem_bem_energy.cpp
    cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp
    cpu/mfem/interactions/demag_fem_bem_operator.cpp
    cpu/mfem/interactions/demag_fem_bem_potential.cpp
    cpu/mfem/interactions/demag_fem_bem_rhs.cpp
    cpu/mfem/interactions/demag_fem_bem_solve.cpp
    cpu/mfem/interactions/demag_fem_bem_surface.cpp
    cpu/mfem/interactions/demag_fem_bem_telemetry.cpp
    cpu/mfem/interactions/demag_fem_bem_workspace.cpp
    cpu/mfem/interactions/demag_poisson.cpp
    cpu/mfem/interactions/demag_poisson_boundary.cpp
    cpu/mfem/interactions/demag_poisson_cache.cpp
    cpu/mfem/interactions/demag_poisson_energy.cpp
    cpu/mfem/interactions/demag_poisson_field.cpp
    cpu/mfem/interactions/demag_poisson_hypre.cpp
    cpu/mfem/interactions/demag_poisson_lifecycle.cpp
    cpu/mfem/interactions/demag_poisson_periodic.cpp
    cpu/mfem/interactions/demag_poisson_ready.cpp
    cpu/mfem/interactions/demag_poisson_recovery.cpp
    cpu/mfem/interactions/demag_poisson_rhs.cpp
    cpu/mfem/interactions/demag_poisson_solve.cpp
    cpu/mfem/interactions/demag_poisson_telemetry.cpp
    cpu/mfem/interactions/dmi.cpp
    cpu/mfem/interactions/dmi_bulk.cpp
    cpu/mfem/interactions/dmi_interfacial.cpp
    cpu/mfem/interactions/dmi_workspace.cpp
    cpu/mfem/interactions/effective_field.cpp
    cpu/mfem/interactions/exchange.cpp
    cpu/mfem/interactions/exchange_energy_difference.cpp
    cpu/mfem/interactions/exchange_fallback.cpp
    cpu/mfem/interactions/exchange_field.cpp
    cpu/mfem/interactions/exchange_legacy_gpu_upload.cpp
    cpu/mfem/interactions/exchange_mass_projection.cpp
    cpu/mfem/interactions/exchange_operator.cpp
    cpu/mfem/interactions/exchange_runtime.cpp
    cpu/mfem/interactions/magnetoelastic.cpp
    cpu/mfem/interactions/magnetoelastic_field.cpp
    cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp
    cpu/mfem/interactions/oersted.cpp
    cpu/mfem/interactions/transport_stage.cpp
    cpu/mfem/interactions/oersted_cylinder.cpp
    cpu/mfem/interactions/oersted_explicit.cpp
    cpu/mfem/interactions/stt.cpp
    cpu/mfem/interactions/stt_slonczewski.cpp
    cpu/mfem/interactions/stt_zhang_li.cpp
    cpu/mfem/interactions/sot.cpp
    cpu/mfem/interactions/thermal_brown.cpp
    cpu/mfem/interactions/thermal_brown_field.cpp
    cpu/mfem/interactions/thermal_brown_sampler.cpp
    cpu/mfem/interactions/thermal_brown_sigma.cpp
    cpu/mfem/interactions/zeeman.cpp
    cpu/mfem/interactions/zeeman_time_dependence.cpp
    cpu/mfem/interactions/zeeman_regional_field.cpp
    cpu/mfem/interactions/zeeman_energy.cpp
    cpu/mfem/interactions/zeeman_field.cpp
    cpu/mfem/interactions/zeeman_uniform_field.cpp
    cpu/mfem/integrators/adaptive_dt.cpp
    cpu/mfem/integrators/heun.cpp
    cpu/mfem/integrators/llg_rhs.cpp
    cpu/mfem/integrators/rk_explicit.cpp
    cpu/mfem/integrators/rk_explicit_step.cpp
    cpu/mfem/integrators/rk_step_failure_injection.cpp
    cpu/mfem/integrators/rk_step_transaction.cpp
    cpu/mfem/integrators/rk_stage_rhs.cpp
    cpu/mfem/integrators/rk4.cpp
    cpu/mfem/integrators/rk23.cpp
    cpu/mfem/integrators/rk45.cpp
    cpu/mfem/relaxation/direct_energy_increment.cpp
    cpu/mfem/relaxation/nonlinear_cg.cpp
    cpu/mfem/relaxation/projected_gradient_bb.cpp
    cpu/mfem/relaxation/relaxation_math.cpp
    cpu/mfem/relaxation/relaxation_step.cpp
    cpu/mfem/relaxation/tangent_plane_implicit.cpp
    cpu/mfem/runtime/aos_field.cpp
    cpu/mfem/runtime/availability.cpp
    cpu/mfem/runtime/backend_lifecycle.cpp
    cpu/mfem/runtime/backend_step.cpp
    cpu/mfem/runtime/cpu_threads.cpp
    cpu/mfem/runtime/eigen_dense.cpp
    cpu/mfem/runtime/field_refresh.cpp
    gpu/cuda/runtime/gpu_state_runtime.cpp
    cpu/mfem/runtime/interrupt.cpp
    cpu/mfem/runtime/mfem_context.cpp
    cpu/mfem/runtime/mfem_device.cpp
    cpu/mfem/runtime/runtime_build_info.cpp
    cpu/mfem/runtime/mfem_mesh_builder.cpp
    cpu/mfem/runtime/snapshot.cpp
    cpu/mfem/runtime/stage_completion.cpp
    cpu/mfem/runtime/state_io.cpp
    cpu/mfem/runtime/step_metrics.cpp
    cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp
    cpu/frequency_domain/floquet_bloch_scalar.cpp
    cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp
    cpu/frequency_domain/poisson_airbox_modal_eigen.cpp
    cpu/frequency_domain/poisson_airbox_schur_matshell.cpp
    cpu/frequency_domain/dense_driven_response.cpp
    cpu/frequency_domain/modal_response.cpp
    cpu/frequency_domain/engines/field_split/full_coupled_field_split_engine.cpp
    cpu/frequency_domain/engines/sparse_direct/assemble_real_split_csr.cpp
    src/frequency_domain/real_frequency_rotated_pencil.cpp
    cpu/frequency_domain/engines/sparse_direct/cpu_sparse_direct_engine.cpp
    cpu/frequency_domain/contour_interval_solver.cpp
    cpu/frequency_domain/contour_quadrature.cpp
    cpu/frequency_domain/mfem_driven_response_validation.cpp
    cpu/frequency_domain/mfem_dmi_operator.cpp
    cpu/frequency_domain/mfem_modal_operator_payload.cpp
    cpu/frequency_domain/production_cpu_modal_eigen.cpp
    cpu/frequency_domain/production_cpu_driven_response.cpp
    cpu/frequency_domain/slepc_modal_eigen.cpp
    cpu/frequency_domain/spectral_transform.cpp
    gpu/cuda/demag_poisson/hypre_device_solver.cpp
    gpu/cuda/demag_poisson/operators.cpp
    gpu/cuda/demag_poisson/poisson.cpp
    gpu/cuda/demag_poisson/stage_compute.cpp
    cpu/frequency_domain/mfem_exchange_operator.cpp
    cpu/frequency_domain/mfem_linearized_operator.cpp
    cpu/frequency_domain/mfem_operator_context.cpp
    cpu/frequency_domain/mfem_tangent_space.cpp
    cpu/frequency_domain/mfem_zeeman_operator.cpp
    cpu/frequency_domain/mode_deduplication.cpp
    cpu/frequency_domain/mode_filter.cpp
    cpu/frequency_domain/window_partition.cpp
    src/frequency_domain/anisotropy_operator.cpp
    src/frequency_domain/canonical_digest.cpp
    src/frequency_domain/dense_full_coupled_oracle.cpp
    src/frequency_domain/driven_response_solver.cpp
    src/frequency_domain/equilibrium_state.cpp
    src/frequency_domain/excitation.cpp
    src/frequency_domain/frequency_domain_contract.cpp
    src/frequency_domain/linearization_state.cpp
    src/frequency_domain/linearized_dynamic_pencil.cpp
    src/frequency_domain/mesh_symmetry_certificate.cpp
    src/frequency_domain/mode_kinematics.cpp
    src/frequency_domain/modal_eigen_solver.cpp
    src/frequency_domain/operator_contract.cpp
    src/frequency_domain/operator_terms.cpp
    src/frequency_domain/solver_progress.cpp
    src/frequency_domain/tangent_frame.cpp
    src/frequency_domain/zeeman_operator.cpp
    src/api.cpp
    src/context.cpp
    src/dmi_weak_residual.cpp
    src/error.cpp
)

if(FULLMAG_USE_MFEM_STACK)
    find_package(MFEM CONFIG REQUIRED)
    if(FULLMAG_FEM_WITH_SLEPC)
        find_package(PETSc REQUIRED)
        find_package(SLEPc REQUIRED)
    endif()

    list(APPEND FEM_SOURCES
        src/mfem_bridge.cpp
        cpu/mfem/transport/steady_transport.cpp
        cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp
        cpu/mfem/interactions/oersted/vector_potential.cpp
    )

    # S11: CUDA fused kernels (LLG RHS, normalize, accumulate)
    if(FULLMAG_ENABLE_CUDA)
        enable_language(CUDA)
        find_package(CUDAToolkit REQUIRED)
        list(APPEND FEM_SOURCES
            gpu/cuda/exchange/exchange_kernels.cu
            gpu/cuda/fields/vector_field_kernels.cu
            gpu/cuda/frequency_domain/driven_response_gpu.cu
            gpu/cuda/frequency_domain/modal_krylov.cu
            gpu/cuda/integrators/llg/llg_rhs_kernels.cu
            gpu/cuda/integrators/rk/adaptive_error_kernels.cu
            gpu/cuda/integrators/rk/heun_stage_sequence.cu
            gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu
            gpu/cuda/integrators/rk/rk_adaptive_runtime.cu
            gpu/cuda/integrators/rk/rk_anisotropy_field.cu
            gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu
            gpu/cuda/integrators/rk/rk_attempt_loop.cu
            gpu/cuda/integrators/rk/rk_attempt_setup.cu
            gpu/cuda/integrators/rk/rk_bs23_accept_kernel.cu
            gpu/cuda/integrators/rk/rk_component_copy.cu
            gpu/cuda/integrators/rk/rk_demag_energy_reductions.cu
            gpu/cuda/integrators/rk/rk_demag_dispatch.cu
            gpu/cuda/integrators/rk/rk_direct_torques.cu
            gpu/cuda/integrators/rk/rk_dmi_fields.cu
            gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu
            gpu/cuda/integrators/rk/rk_dp54_accept_kernel.cu
            gpu/cuda/integrators/rk/rk_effective_field.cu
            gpu/cuda/integrators/rk/rk_error_norm_runtime.cu
            gpu/cuda/integrators/rk/rk_energy_reductions.cu
            gpu/cuda/integrators/rk/rk_exchange_energy_reductions.cu
            gpu/cuda/integrators/rk/rk_exchange_dispatch.cu
            gpu/cuda/integrators/rk/rk_external_energy_reductions.cu
            gpu/cuda/integrators/rk/rk_field_metric_reductions.cu
            gpu/cuda/integrators/rk/rk_heun_accept_kernel.cu
            gpu/cuda/integrators/rk/rk23_adaptive_k3.cu
            gpu/cuda/integrators/rk/rk23_stage_sequence.cu
            gpu/cuda/integrators/rk/rk4_stage_sequence.cu
            gpu/cuda/integrators/rk/rk45_stage_sequence.cu
            gpu/cuda/integrators/rk/rk_final_refresh.cu
            gpu/cuda/integrators/rk/rk_local_fields.cu
            gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.cu
            gpu/cuda/integrators/rk/rk_magnetization_reductions.cu
            gpu/cuda/integrators/rk/rk_magnetoelastic_field.cu
            gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.cu
            gpu/cuda/integrators/rk/rk_observable_reductions.cu
            gpu/cuda/integrators/rk/rk_oersted_field.cu
            gpu/cuda/integrators/rk/rk_rhs_runtime.cu
            gpu/cuda/integrators/rk/rk_rk4_accept_kernel.cu
            gpu/cuda/integrators/rk/rk_snapshot.cu
            gpu/cuda/integrators/rk/rk_slonczewski_torque.cu
            gpu/cuda/integrators/rk/rk_sot_torque.cu
            gpu/cuda/integrators/rk/rk_scalar_readback.cu
            gpu/cuda/integrators/rk/rk_stage_predictor_kernels.cu
            gpu/cuda/integrators/rk/rk_stage_schedule.cu
            gpu/cuda/integrators/rk/rk_step_preflight.cu
            gpu/cuda/integrators/rk/rk_step_transaction_device.cu
            gpu/cuda/integrators/rk/rk_step_stats.cu
            gpu/cuda/integrators/rk/rk_thermal_field.cu
            gpu/cuda/integrators/rk/rk_total_energy_reduction.cu
            gpu/cuda/integrators/rk/rk_zhang_li_torque.cu
            gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu
            gpu/cuda/interactions/dmi/dmi_kernels.cu
            gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.cu
            gpu/cuda/interactions/oersted/oersted_kernels.cu
            gpu/cuda/interactions/stt/stt_kernels.cu
            gpu/cuda/interactions/sot/sot_kernels.cu
            gpu/cuda/interactions/thermal/thermal_kernels.cu
            gpu/cuda/interactions/zeeman/zeeman_kernels.cu
            gpu/cuda/interactions/zeeman/regional_field_kernels.cu
            gpu/cuda/demag_poisson/demag_kernels.cu
            gpu/cuda/observables/observable_kernels.cu
            gpu/cuda/relaxation/pgbb_kernels.cu
            gpu/cuda/reductions/reduction_kernels.cu
            gpu/cuda/transfer/transfer_kernels.cu
            gpu/cuda/integrators/rk/rk_step.cu
        )
        if(FULLMAG_FEM_WITH_SLEPC)
            # The GPU modal lane calls PETSc/SLEPc directly.  Keep it out of
            # demag-only builds, whose contract intentionally disables the
            # PETSc/SLEPc dependency slice.
            list(APPEND FEM_SOURCES gpu/frequency_domain/modal_petsc_slepc.cpp)
        endif()
    endif()
endif()

add_library(fullmag_fem SHARED ${FEM_SOURCES})

if(FULLMAG_ENABLE_NVTX)
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_ENABLE_NVTX=1)
else()
    target_compile_definitions(fullmag_fem PRIVATE FULLMAG_ENABLE_NVTX=0)
endif()

function(fullmag_private_string_define target macro value)
    string(REPLACE "\\" "\\\\" escaped "${value}")
    string(REPLACE "\"" "\\\"" escaped "${escaped}")
    target_compile_definitions(${target} PRIVATE ${macro}="${escaped}")
endfunction()

target_include_directories(fullmag_fem
    PUBLIC
        ${CMAKE_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(FULLMAG_USE_MFEM_STACK)
    target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_MFEM_STACK=1)
    if(FULLMAG_ENABLE_CUDA)
        target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_CUDA_RUNTIME=1)
        target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_CUSOLVER=1)
        target_link_libraries(fullmag_fem PRIVATE CUDA::cudart CUDA::cusolver)
    else()
        target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_CUDA_RUNTIME=0)
        target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_CUSOLVER=0)
    endif()
    if(TARGET MFEM::mfem)
        target_link_libraries(fullmag_fem PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fullmag_fem PRIVATE mfem)
    endif()
    if(FULLMAG_FEM_WITH_SLEPC)
        target_compile_definitions(fullmag_fem PUBLIC FULLMAG_FEM_WITH_SLEPC=1)
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_VERSION "${PETSc_VERSION}")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_VERSION "${SLEPc_VERSION}")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_PKGCONFIG_DIR "${PETSc_PKGCONFIG_DIR}")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_PKGCONFIG_DIR "${SLEPc_PKGCONFIG_DIR}")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_FIND_MODULE_FILE "${PETSc_FIND_MODULE_FILE}")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_FIND_MODULE_FILE "${SLEPc_FIND_MODULE_FILE}")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_LIBRARY_PATH "${PETSc_LIBRARY}")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_LIBRARY_PATH "${SLEPc_LIBRARY}")
        target_link_libraries(fullmag_fem PRIVATE PETSC::petsc SLEPC::slepc)
    else()
        target_compile_definitions(fullmag_fem PUBLIC FULLMAG_FEM_WITH_SLEPC=0)
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_VERSION "")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_VERSION "")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_PKGCONFIG_DIR "")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_PKGCONFIG_DIR "")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_FIND_MODULE_FILE "")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_FIND_MODULE_FILE "")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_LIBRARY_PATH "")
        fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_LIBRARY_PATH "")
    endif()
else()
    target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_MFEM_STACK=0)
    target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_CUDA_RUNTIME=0)
    target_compile_definitions(fullmag_fem PUBLIC FULLMAG_HAS_CUSOLVER=0)
    target_compile_definitions(fullmag_fem PUBLIC FULLMAG_FEM_WITH_SLEPC=0)
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_VERSION "")
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_VERSION "")
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_PKGCONFIG_DIR "")
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_PKGCONFIG_DIR "")
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_FIND_MODULE_FILE "")
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_FIND_MODULE_FILE "")
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_PETSC_LIBRARY_PATH "")
    fullmag_private_string_define(fullmag_fem FULLMAG_FEM_SLEPC_LIBRARY_PATH "")
endif()

set_target_properties(fullmag_fem PROPERTIES
    VERSION 0.1.0
    SOVERSION 0
    PUBLIC_HEADER "${FEM_PUBLIC_HEADERS}"
)

# ── Tests ──
enable_testing()

if(FULLMAG_USE_MFEM_STACK)
    add_executable(
        fem_oersted_direct_tetra_contract
        tests/oersted_direct_tetra_contract.cpp
    )
    target_link_libraries(fem_oersted_direct_tetra_contract PRIVATE fullmag_fem)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_oersted_direct_tetra_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_oersted_direct_tetra_contract PRIVATE mfem)
    endif()
    target_include_directories(fem_oersted_direct_tetra_contract PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    add_test(
        NAME fem_oersted_direct_tetra_contract
        COMMAND fem_oersted_direct_tetra_contract)

    add_executable(
        fem_oersted_vector_potential_contract
        tests/oersted_vector_potential_contract.cpp
    )
    target_link_libraries(fem_oersted_vector_potential_contract PRIVATE fullmag_fem)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_oersted_vector_potential_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_oersted_vector_potential_contract PRIVATE mfem)
    endif()
    target_include_directories(fem_oersted_vector_potential_contract PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    add_test(
        NAME fem_oersted_vector_potential_contract
        COMMAND fem_oersted_vector_potential_contract)

    add_executable(
        fem_conservative_constraint_rank_contract
        tests/conservative_constraint_rank_contract.cpp
        cpu/mfem/transport/conservative_constraint_rank.cpp
    )
    target_include_directories(fem_conservative_constraint_rank_contract PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
    )
    target_compile_definitions(
        fem_conservative_constraint_rank_contract PRIVATE
        FULLMAG_CONSTRAINT_RANK_TESTING=1)
    add_test(
        NAME fem_conservative_constraint_rank_contract
        COMMAND fem_conservative_constraint_rank_contract)

    add_executable(
        fem_steady_transport_contract
        tests/steady_transport_contract.cpp
        cpu/mfem/transport/steady_transport.cpp
    )
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_steady_transport_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_steady_transport_contract PRIVATE mfem)
    endif()
    if(FULLMAG_ENABLE_CUDA)
        target_link_libraries(fem_steady_transport_contract PRIVATE CUDA::cusparse)
    endif()
    target_include_directories(fem_steady_transport_contract PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    add_test(NAME fem_steady_transport_contract COMMAND fem_steady_transport_contract)

    # OE-T0 TDD target. The three production TUs (rank, periodic potential,
    # and conservative current view) are added only in GREEN; keeping them out
    # lets CMake configure and makes RED occur on the first missing rank/view
    # public API rather than an unrelated existing target.
    add_executable(
        fem_conservative_current_view_contract
        tests/conservative_current_view_contract.cpp
    )
    set(FULLMAG_OET0_PRODUCTION_SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/cpu/mfem/transport/conservative_constraint_rank.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/cpu/mfem/transport/periodic_charge_potential.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/cpu/mfem/transport/conservative_current_view.cpp
    )
    set(FULLMAG_OET0_PRODUCTION_SOURCE_COUNT 0)
    foreach(FULLMAG_OET0_SOURCE IN LISTS FULLMAG_OET0_PRODUCTION_SOURCES)
        if(EXISTS "${FULLMAG_OET0_SOURCE}")
            math(EXPR FULLMAG_OET0_PRODUCTION_SOURCE_COUNT
                "${FULLMAG_OET0_PRODUCTION_SOURCE_COUNT} + 1")
        endif()
    endforeach()
    list(LENGTH FULLMAG_OET0_PRODUCTION_SOURCES
        FULLMAG_OET0_EXPECTED_SOURCE_COUNT)
    if(FULLMAG_OET0_PRODUCTION_SOURCE_COUNT GREATER 0 AND
            NOT FULLMAG_OET0_PRODUCTION_SOURCE_COUNT EQUAL
                FULLMAG_OET0_EXPECTED_SOURCE_COUNT)
        message(FATAL_ERROR
            "OE-T0 production source set is partial; rank, periodic potential, and current view must appear together")
    endif()
    if(FULLMAG_OET0_PRODUCTION_SOURCE_COUNT EQUAL
            FULLMAG_OET0_EXPECTED_SOURCE_COUNT)
        target_sources(fullmag_fem PRIVATE
            ${FULLMAG_OET0_PRODUCTION_SOURCES})
        target_sources(fem_conservative_current_view_contract PRIVATE
            ${FULLMAG_OET0_PRODUCTION_SOURCES})
    endif()
    find_package(Threads REQUIRED)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_conservative_current_view_contract PRIVATE
            MFEM::mfem Threads::Threads)
    else()
        target_link_libraries(fem_conservative_current_view_contract PRIVATE
            mfem Threads::Threads)
    endif()
    target_include_directories(fem_conservative_current_view_contract PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    if(FULLMAG_OET0_TSAN)
        target_compile_definitions(fem_conservative_current_view_contract PRIVATE
            FULLMAG_OET0_DISABLE_MPI=1)
        target_compile_options(fem_conservative_current_view_contract PRIVATE
            -fsanitize=thread -fno-omit-frame-pointer -fno-pie)
        target_link_options(fem_conservative_current_view_contract PRIVATE
            -fsanitize=thread -no-pie)
    endif()
    add_test(
        NAME fem_conservative_current_view_contract
        COMMAND fem_conservative_current_view_contract
    )
    # MPI qualification is registered only when the configured MFEM stack and
    # CMake both expose MPI C++ plus a launcher. Serial-only MFEM consumers may
    # configure this target without a globally REQUIRED mpiexec lookup.
    unset(FULLMAG_MFEM_MPI_QUALIFICATION CACHE)
    unset(FULLMAG_MFEM_MPI_QUALIFICATION)
    if(NOT FULLMAG_OET0_TSAN)
        find_package(MPI COMPONENTS CXX QUIET)
    endif()
    if(NOT FULLMAG_OET0_TSAN AND MPI_CXX_FOUND AND MPIEXEC_EXECUTABLE)
        include(CheckCXXSourceCompiles)
        if(TARGET MFEM::mfem)
            set(CMAKE_REQUIRED_LIBRARIES MFEM::mfem MPI::MPI_CXX)
        else()
            set(CMAKE_REQUIRED_LIBRARIES mfem MPI::MPI_CXX)
        endif()
        check_cxx_source_compiles(
            "#include <mfem.hpp>\n#ifndef MFEM_USE_MPI\n#error MFEM MPI disabled\n#endif\nint main(){return 0;}"
            FULLMAG_MFEM_MPI_QUALIFICATION
        )
        unset(CMAKE_REQUIRED_LIBRARIES)
    endif()
    if(NOT FULLMAG_OET0_TSAN AND FULLMAG_MFEM_MPI_QUALIFICATION)
        target_link_libraries(
            fem_conservative_current_view_contract PRIVATE MPI::MPI_CXX)
        set(FULLMAG_OET0_MPI_N1_BYTES
            "${CMAKE_CURRENT_BINARY_DIR}/oet0-mpi-n1.bin")
        set(FULLMAG_OET0_MPI_N2_BYTES
            "${CMAKE_CURRENT_BINARY_DIR}/oet0-mpi-n2.bin")
        add_test(
            NAME fem_conservative_current_view_mpi_n1
            COMMAND ${CMAKE_COMMAND} -E env
                OMPI_ALLOW_RUN_AS_ROOT=1
                OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1
                ${MPIEXEC_EXECUTABLE} ${MPIEXEC_NUMPROC_FLAG} 1
                $<TARGET_FILE:fem_conservative_current_view_contract>
                --emit-mpi-records ${FULLMAG_OET0_MPI_N1_BYTES}
        )
        add_test(
            NAME fem_conservative_current_view_mpi_n2
            COMMAND ${CMAKE_COMMAND} -E env
                OMPI_ALLOW_RUN_AS_ROOT=1
                OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1
                ${MPIEXEC_EXECUTABLE} ${MPIEXEC_NUMPROC_FLAG} 2
                $<TARGET_FILE:fem_conservative_current_view_contract>
                --emit-mpi-records ${FULLMAG_OET0_MPI_N2_BYTES}
        )
        set_tests_properties(
            fem_conservative_current_view_mpi_n1
            fem_conservative_current_view_mpi_n2
            PROPERTIES FIXTURES_SETUP fem_conservative_current_view_mpi_bytes
        )
        add_test(
            NAME fem_conservative_current_view_mpi_byte_identity
            COMMAND ${CMAKE_COMMAND} -E compare_files
                ${FULLMAG_OET0_MPI_N1_BYTES}
                ${FULLMAG_OET0_MPI_N2_BYTES}
        )
        set_tests_properties(
            fem_conservative_current_view_mpi_byte_identity
            PROPERTIES FIXTURES_REQUIRED fem_conservative_current_view_mpi_bytes
        )
    endif()

    add_executable(
        fem_steady_transport_abi_contract
        tests/steady_transport_abi_contract.cpp
    )
    target_link_libraries(fem_steady_transport_abi_contract PRIVATE fullmag_fem)
    target_include_directories(fem_steady_transport_abi_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
    )
    add_test(NAME fem_steady_transport_abi_contract COMMAND fem_steady_transport_abi_contract)

    add_executable(
        fem_steady_transport_rt0_contract
        tests/steady_transport_rt0_contract.cpp
    )
    target_link_libraries(fem_steady_transport_rt0_contract PRIVATE fullmag_fem)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_steady_transport_rt0_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_steady_transport_rt0_contract PRIVATE mfem)
    endif()
    target_include_directories(fem_steady_transport_rt0_contract PRIVATE
        ${CMAKE_SOURCE_DIR}/include
    )
    add_test(
        NAME fem_steady_transport_rt0_contract
        COMMAND fem_steady_transport_rt0_contract
    )
endif()

add_executable(fem_gpu_state_info tests/gpu_state_info.cpp)
target_link_libraries(fem_gpu_state_info PRIVATE fullmag_fem)
add_test(NAME fem_gpu_state_info COMMAND fem_gpu_state_info)

add_executable(fem_gpu_rk_plan tests/gpu_rk_plan.cpp)
target_link_libraries(fem_gpu_rk_plan PRIVATE fullmag_fem)
target_include_directories(fem_gpu_rk_plan PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_gpu_rk_plan COMMAND fem_gpu_rk_plan)

add_executable(fem_cuda_tetra_gradient_contract tests/cuda_tetra_gradient_contract.cpp)
target_link_libraries(fem_cuda_tetra_gradient_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_cuda_tetra_gradient_contract PRIVATE CUDA::cudart)
endif()
target_include_directories(fem_cuda_tetra_gradient_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_cuda_tetra_gradient_contract COMMAND fem_cuda_tetra_gradient_contract)

add_executable(fem_cuda_slonczewski_contract tests/cuda_slonczewski_contract.cpp)
target_link_libraries(fem_cuda_slonczewski_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_cuda_slonczewski_contract PRIVATE CUDA::cudart)
endif()
target_include_directories(fem_cuda_slonczewski_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_cuda_slonczewski_contract COMMAND fem_cuda_slonczewski_contract)

add_executable(fem_cuda_sot_contract tests/cuda_sot_contract.cpp)
target_link_libraries(fem_cuda_sot_contract PRIVATE fullmag_fem)
if(FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_cuda_sot_contract PRIVATE CUDA::cudart)
endif()
target_include_directories(fem_cuda_sot_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/include
)
add_test(NAME fem_cuda_sot_contract COMMAND fem_cuda_sot_contract)

add_executable(fem_cuda_rk_guard_contract tests/cuda_rk_guard_contract.cpp)
target_link_libraries(fem_cuda_rk_guard_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_cuda_rk_guard_contract PRIVATE CUDA::cudart)
endif()
target_include_directories(fem_cuda_rk_guard_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_cuda_rk_guard_contract COMMAND fem_cuda_rk_guard_contract)

if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA AND FULLMAG_ENABLE_FEM_GPU)
    add_executable(
        fem_gpu_pageable_scalar_readback_contract
        tests/gpu_pageable_scalar_readback_contract.cpp
    )
    target_link_libraries(
        fem_gpu_pageable_scalar_readback_contract
        PRIVATE fullmag_fem CUDA::cudart
    )
    target_include_directories(fem_gpu_pageable_scalar_readback_contract PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    add_test(
        NAME fem_gpu_pageable_scalar_readback_contract
        COMMAND fem_gpu_pageable_scalar_readback_contract
    )
endif()

add_executable(fem_cuda_demag_robin_energy_contract tests/cuda_demag_robin_energy_contract.cpp)
add_test(NAME fem_cuda_demag_robin_energy_contract COMMAND fem_cuda_demag_robin_energy_contract)

add_executable(fem_cuda_demag_timing_contract tests/cuda_demag_timing_contract.cpp)
add_test(NAME fem_cuda_demag_timing_contract COMMAND fem_cuda_demag_timing_contract)

add_executable(fem_cuda_periodic_demag_contract tests/cuda_periodic_demag_contract.cpp)
target_link_libraries(fem_cuda_periodic_demag_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_cuda_periodic_demag_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_cuda_periodic_demag_contract PRIVATE mfem)
    endif()
    if(FULLMAG_ENABLE_CUDA)
        target_link_libraries(fem_cuda_periodic_demag_contract PRIVATE CUDA::cudart)
    endif()
endif()
target_include_directories(fem_cuda_periodic_demag_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_cuda_periodic_demag_contract COMMAND fem_cuda_periodic_demag_contract)

add_executable(fem_cuda_periodic_exchange_contract tests/cuda_periodic_exchange_contract.cpp)
add_test(NAME fem_cuda_periodic_exchange_contract COMMAND fem_cuda_periodic_exchange_contract)

add_executable(fem_transfer_audit tests/transfer_audit.cpp)
target_link_libraries(fem_transfer_audit PRIVATE fullmag_fem)
target_include_directories(fem_transfer_audit PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_transfer_audit COMMAND fem_transfer_audit)

function(add_fem_source_facade_contract target source)
    add_executable(${target} ${source})
    target_link_libraries(${target} PRIVATE fullmag_fem)
    target_include_directories(${target} PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    add_test(NAME ${target} COMMAND ${target})
endfunction()

add_fem_source_facade_contract(
    fem_source_facade_contract
    tests/source_facade_contract.cpp
)
add_fem_source_facade_contract(
    fem_source_facade_gpu_state_contract
    tests/source_facade_gpu_state_contract.cpp
)
add_fem_source_facade_contract(
    fem_source_facade_gpu_rk_contract
    tests/source_facade_gpu_rk_contract.cpp
)
add_fem_source_facade_contract(
    fem_source_facade_cuda_kernels_contract
    tests/source_facade_cuda_kernels_contract.cpp
)
add_fem_source_facade_contract(
    fem_source_facade_export_progress_contract
    tests/source_facade_export_progress_contract.cpp
)
add_fem_source_facade_contract(
    fem_dependency_stack_contract
    tests/dependency_stack_contract.cpp
)
add_fem_source_facade_contract(
    fem_gpu_solver_docs_contract
    tests/gpu_solver_docs_contract.cpp
)
add_fem_source_facade_contract(
    fem_relaxation_source_contract
    tests/relaxation_source_contract.cpp
)
add_fem_source_facade_contract(
    fem_relaxation_energy_derivative_contract
    tests/relaxation_energy_derivative_contract.cpp
)
add_fem_source_facade_contract(
    fem_relaxation_operator_contract
    tests/relaxation_operator_contract.cpp
)
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_relaxation_energy_derivative_contract PRIVATE MFEM::mfem)
        target_link_libraries(fem_relaxation_operator_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_relaxation_energy_derivative_contract PRIVATE mfem)
        target_link_libraries(fem_relaxation_operator_contract PRIVATE mfem)
    endif()
endif()
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_relaxation_energy_derivative_contract PRIVATE CUDA::cudart)
    target_link_libraries(fem_relaxation_operator_contract PRIVATE CUDA::cudart)
endif()
add_fem_source_facade_contract(
    fem_frequency_domain_contract
    tests/frequency_domain/frequency_domain_contract.cpp
)
add_fem_source_facade_contract(
    fem_frequency_domain_checked_extent_contract
    tests/frequency_domain/checked_extent_test.cpp
)
add_fem_source_facade_contract(
    fem_mode_kinematics_contract
    tests/frequency_domain/mode_kinematics_test.cpp
)
add_fem_source_facade_contract(
    fem_linearized_dynamic_pencil_contract
    tests/frequency_domain/linearized_dynamic_pencil_test.cpp
)
add_fem_source_facade_contract(
    fem_real_frequency_rotated_pencil_contract
    tests/frequency_domain/real_frequency_rotated_pencil_test.cpp
)
add_fem_source_facade_contract(
    fem_operator_contract
    tests/frequency_domain/operator_contract_test.cpp
)
add_fem_source_facade_contract(
    fem_modal_eigen_contract
    tests/frequency_domain/modal_eigen_contract_test.cpp
)
add_fem_source_facade_contract(
    fem_poisson_airbox_eigen_oracle_contract
    tests/frequency_domain/poisson_airbox_eigen_oracle_test.cpp
)
add_fem_source_facade_contract(
    fem_poisson_airbox_modal_eigen_slepc_contract
    tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
)
add_fem_source_facade_contract(
    fem_poisson_airbox_real_split_cpu_contract
    tests/frequency_domain/poisson_airbox_real_split_cpu_test.cpp
)
add_fem_source_facade_contract(
    fem_poisson_airbox_schur_matshell_contract
    tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp
)
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA AND FULLMAG_FEM_WITH_SLEPC)
    find_package(MPI REQUIRED COMPONENTS CXX)
    add_executable(
        fem_gpu_petsc_slepc_runtime_contract
        tests/frequency_domain/gpu_petsc_slepc_runtime_test.cpp
    )
    target_link_libraries(
        fem_gpu_petsc_slepc_runtime_contract
        PRIVATE
            PETSC::petsc
            SLEPC::slepc
            MPI::MPI_CXX
    )
    add_test(
        NAME fem_gpu_petsc_slepc_runtime_contract
        COMMAND fem_gpu_petsc_slepc_runtime_contract
    )
    add_executable(
        fem_gpu_k0_modal_petsc_slepc_contract
        tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp
    )
    target_link_libraries(
        fem_gpu_k0_modal_petsc_slepc_contract
        PRIVATE
            fullmag_fem
            PETSC::petsc
            SLEPC::slepc
            MPI::MPI_CXX
    )
    target_include_directories(
        fem_gpu_k0_modal_petsc_slepc_contract
        PRIVATE
            ${CMAKE_CURRENT_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}/include
    )
    add_test(
        NAME fem_gpu_k0_modal_petsc_slepc_contract
        COMMAND fem_gpu_k0_modal_petsc_slepc_contract
    )
endif()
add_fem_source_facade_contract(
    fem_floquet_bloch_scalar_contract
    tests/frequency_domain/floquet_bloch_scalar_test.cpp
)
add_fem_source_facade_contract(
    fem_poisson_airbox_shared_domain_contract
    tests/frequency_domain/poisson_airbox_shared_domain_test.cpp
)
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_poisson_airbox_shared_domain_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_poisson_airbox_shared_domain_contract PRIVATE mfem)
    endif()
endif()
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_floquet_bloch_scalar_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_floquet_bloch_scalar_contract PRIVATE mfem)
    endif()
endif()
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_floquet_bloch_scalar_contract PRIVATE CUDA::cudart)
endif()
add_fem_source_facade_contract(
    fem_driven_response_contract
    tests/frequency_domain/driven_response_contract_test.cpp
)
add_fem_source_facade_contract(
    fem_window_partition_contract
    tests/frequency_domain/window_partition_test.cpp
)
add_fem_source_facade_contract(
    fem_mode_deduplication_contract
    tests/frequency_domain/mode_deduplication_test.cpp
)
add_fem_source_facade_contract(
    fem_contour_interval_solver_contract
    tests/frequency_domain/contour_interval_solver_test.cpp
)

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
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_exchange_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_exchange_contract PRIVATE mfem)
    endif()
endif()
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_exchange_contract PRIVATE CUDA::cusparse)
endif()
target_include_directories(fem_exchange_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_exchange_contract COMMAND fem_exchange_contract)

add_executable(fem_mixed_p1_contract tests/fem_mixed_p1_contract.cpp)
target_link_libraries(fem_mixed_p1_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_mixed_p1_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_mixed_p1_contract PRIVATE mfem)
    endif()
endif()
target_include_directories(fem_mixed_p1_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_mixed_p1_contract COMMAND fem_mixed_p1_contract)

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

add_executable(
    fem_rk_transaction_fault_injection_contract
    tests/rk_transaction_fault_injection_contract.cpp
)
target_link_libraries(fem_rk_transaction_fault_injection_contract PRIVATE fullmag_fem)
target_include_directories(fem_rk_transaction_fault_injection_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(
    NAME fem_rk_transaction_fault_injection_contract
    COMMAND fem_rk_transaction_fault_injection_contract
)

add_executable(
    fem_llg_time_domain_qualification
    tests/llg_time_domain_qualification.cpp
)
target_link_libraries(fem_llg_time_domain_qualification PRIVATE fullmag_fem)
target_include_directories(fem_llg_time_domain_qualification PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

add_executable(fem_heun_step_contract tests/heun_step_contract.cpp)
target_link_libraries(fem_heun_step_contract PRIVATE fullmag_fem)
target_include_directories(fem_heun_step_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_heun_step_contract COMMAND fem_heun_step_contract)

add_executable(fem_cpu_threads_contract tests/cpu_threads_contract.cpp)
target_link_libraries(fem_cpu_threads_contract PRIVATE fullmag_fem)
target_include_directories(fem_cpu_threads_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_cpu_threads_contract COMMAND fem_cpu_threads_contract)

add_executable(fem_availability_contract tests/availability_contract.cpp)
target_link_libraries(fem_availability_contract PRIVATE fullmag_fem)
target_include_directories(fem_availability_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_availability_contract COMMAND fem_availability_contract)

add_executable(fem_interrupt_contract tests/interrupt_contract.cpp)
target_link_libraries(fem_interrupt_contract PRIVATE fullmag_fem)
target_include_directories(fem_interrupt_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_interrupt_contract COMMAND fem_interrupt_contract)

add_executable(fem_mfem_device_contract tests/mfem_device_contract.cpp)
target_link_libraries(fem_mfem_device_contract PRIVATE fullmag_fem)
target_include_directories(fem_mfem_device_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_mfem_device_contract COMMAND fem_mfem_device_contract)

add_executable(fem_gpu_state_runtime_contract tests/gpu_state_runtime_contract.cpp)
target_link_libraries(fem_gpu_state_runtime_contract PRIVATE fullmag_fem)
target_include_directories(fem_gpu_state_runtime_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_gpu_state_runtime_contract COMMAND fem_gpu_state_runtime_contract)

add_executable(fem_state_io_contract tests/state_io_contract.cpp)
target_link_libraries(fem_state_io_contract PRIVATE fullmag_fem)
target_include_directories(fem_state_io_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_state_io_contract COMMAND fem_state_io_contract)

add_executable(fem_snapshot_contract tests/snapshot_contract.cpp)
target_link_libraries(fem_snapshot_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK AND FULLMAG_ENABLE_CUDA)
    target_link_libraries(fem_snapshot_contract PRIVATE CUDA::cudart)
endif()
target_include_directories(fem_snapshot_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_snapshot_contract COMMAND fem_snapshot_contract)

add_executable(fem_mfem_context_contract tests/mfem_context_contract.cpp)
target_link_libraries(fem_mfem_context_contract PRIVATE fullmag_fem)
target_include_directories(fem_mfem_context_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_mfem_context_contract COMMAND fem_mfem_context_contract)

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

add_executable(fem_field_refresh_contract tests/field_refresh_contract.cpp)
target_link_libraries(fem_field_refresh_contract PRIVATE fullmag_fem)
target_include_directories(fem_field_refresh_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_field_refresh_contract COMMAND fem_field_refresh_contract)

add_executable(fem_aos_field_contract tests/aos_field_contract.cpp)
target_link_libraries(fem_aos_field_contract PRIVATE fullmag_fem)
target_include_directories(fem_aos_field_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_aos_field_contract COMMAND fem_aos_field_contract)

add_executable(fem_mesh_contract tests/fem_mesh_contract.cpp)
target_link_libraries(fem_mesh_contract PRIVATE fullmag_fem)
target_include_directories(fem_mesh_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_mesh_contract COMMAND fem_mesh_contract)

add_executable(fem_plan_fields_contract tests/fem_plan_fields_contract.cpp)
target_link_libraries(fem_plan_fields_contract PRIVATE fullmag_fem)
target_include_directories(fem_plan_fields_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_plan_fields_contract COMMAND fem_plan_fields_contract)

add_executable(fem_state_contract tests/fem_state_contract.cpp)
target_link_libraries(fem_state_contract PRIVATE fullmag_fem)
target_include_directories(fem_state_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_state_contract COMMAND fem_state_contract)

add_executable(fem_material_fields_contract tests/fem_material_fields_contract.cpp)
target_link_libraries(fem_material_fields_contract PRIVATE fullmag_fem)
target_include_directories(fem_material_fields_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_material_fields_contract COMMAND fem_material_fields_contract)

add_executable(fem_element_dg0_workflow_contract tests/element_dg0_workflow_contract.cpp)
target_link_libraries(fem_element_dg0_workflow_contract PRIVATE fullmag_fem)
target_include_directories(fem_element_dg0_workflow_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_element_dg0_workflow_contract COMMAND fem_element_dg0_workflow_contract)

add_executable(
    fem_element_quadrature_material_contract
    tests/fem_element_quadrature_material_contract.cpp
)
target_link_libraries(fem_element_quadrature_material_contract PRIVATE fullmag_fem)
target_include_directories(fem_element_quadrature_material_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_element_quadrature_material_contract COMMAND fem_element_quadrature_material_contract)

add_executable(
    fem_zeeman_element_quadrature_contract
    tests/fem_zeeman_element_quadrature_contract.cpp
)
target_link_libraries(fem_zeeman_element_quadrature_contract PRIVATE fullmag_fem)
target_include_directories(fem_zeeman_element_quadrature_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_zeeman_element_quadrature_contract COMMAND fem_zeeman_element_quadrature_contract)

add_executable(
    fem_material_runtime_zeeman_contract
    tests/fem_material_runtime_zeeman_contract.cpp
)
target_link_libraries(fem_material_runtime_zeeman_contract PRIVATE fullmag_fem)
target_include_directories(fem_material_runtime_zeeman_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_material_runtime_zeeman_contract COMMAND fem_material_runtime_zeeman_contract)

add_executable(
    fem_uniaxial_element_quadrature_contract
    tests/fem_uniaxial_element_quadrature_contract.cpp
)
target_link_libraries(fem_uniaxial_element_quadrature_contract PRIVATE fullmag_fem)
target_include_directories(fem_uniaxial_element_quadrature_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_uniaxial_element_quadrature_contract COMMAND fem_uniaxial_element_quadrature_contract)

add_executable(
    fem_material_runtime_uniaxial_contract
    tests/fem_material_runtime_uniaxial_contract.cpp
)
target_link_libraries(fem_material_runtime_uniaxial_contract PRIVATE fullmag_fem)
target_include_directories(fem_material_runtime_uniaxial_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_material_runtime_uniaxial_contract COMMAND fem_material_runtime_uniaxial_contract)

add_executable(
    fem_cubic_element_quadrature_contract
    tests/fem_cubic_element_quadrature_contract.cpp
)
target_link_libraries(fem_cubic_element_quadrature_contract PRIVATE fullmag_fem)
target_include_directories(fem_cubic_element_quadrature_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_cubic_element_quadrature_contract COMMAND fem_cubic_element_quadrature_contract)

add_executable(
    fem_material_runtime_cubic_contract
    tests/fem_material_runtime_cubic_contract.cpp
)
target_link_libraries(fem_material_runtime_cubic_contract PRIVATE fullmag_fem)
target_include_directories(fem_material_runtime_cubic_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_material_runtime_cubic_contract COMMAND fem_material_runtime_cubic_contract)

add_executable(fem_field_buffers_contract tests/fem_field_buffers_contract.cpp)
target_link_libraries(fem_field_buffers_contract PRIVATE fullmag_fem)
target_include_directories(fem_field_buffers_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_field_buffers_contract COMMAND fem_field_buffers_contract)

add_executable(fem_demag_poisson_contract tests/demag_poisson_contract.cpp)
target_link_libraries(fem_demag_poisson_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_demag_poisson_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_demag_poisson_contract PRIVATE mfem)
    endif()
    if(FULLMAG_ENABLE_CUDA)
        target_link_libraries(fem_demag_poisson_contract PRIVATE CUDA::cudart)
    endif()
endif()
target_include_directories(fem_demag_poisson_contract PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
add_test(NAME fem_demag_poisson_contract COMMAND fem_demag_poisson_contract)

add_executable(
    fem_demag_delta_potential_contract
    tests/demag_delta_potential_contract.cpp
)
add_test(
    NAME fem_demag_delta_potential_contract
    COMMAND fem_demag_delta_potential_contract
)

add_executable(fem_demag_fem_bem_contract tests/demag_fem_bem_contract.cpp)
target_link_libraries(fem_demag_fem_bem_contract PRIVATE fullmag_fem)
if(FULLMAG_USE_MFEM_STACK)
    if(TARGET MFEM::mfem)
        target_link_libraries(fem_demag_fem_bem_contract PRIVATE MFEM::mfem)
    else()
        target_link_libraries(fem_demag_fem_bem_contract PRIVATE mfem)
    endif()
    if(FULLMAG_ENABLE_CUDA)
        target_link_libraries(fem_demag_fem_bem_contract PRIVATE CUDA::cudart)
    endif()
endif()
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
