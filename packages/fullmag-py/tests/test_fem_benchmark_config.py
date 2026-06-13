import io
import importlib.util
import inspect
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
BENCHMARK_PATH = REPO_ROOT / "examples" / "bench_fem_gpu_long.py"
ANALYSIS_BENCHMARK_PATH = REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
FEM_CMAKE_PATH = REPO_ROOT / "backends" / "fem" / "CMakeLists.txt"
FEM_SOURCE_FACADE_CONTRACT_PATH = (
    REPO_ROOT / "backends" / "fem" / "tests" / "source_facade_contract.cpp"
)
GPU_RK_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step.cu"
)
GPU_RK_STEP_PREFLIGHT_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step_preflight.cu"
)
GPU_RK_STEP_PREFLIGHT_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step_preflight.hpp"
)
GPU_RK_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_plan.cpp"
)
GPU_RK_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk.hpp"
)
GPU_RK_ADAPTIVE_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "adaptive_error_kernels.cu"
)
GPU_RK_ADAPTIVE_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "adaptive_error_kernels.hpp"
)
GPU_RK_STAGE_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_kernels.cu"
)
GPU_RK_STAGE_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_kernels.hpp"
)
GPU_RK_STAGE_PREDICTOR_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_predictor_kernels.cu"
)
GPU_RK_STAGE_PREDICTOR_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_predictor_kernels.hpp"
)
GPU_RK_STAGE_ACCEPT_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_accept_kernels.cu"
)
GPU_RK_STAGE_ACCEPT_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_accept_kernels.hpp"
)
GPU_RK_HEUN_ACCEPT_KERNEL_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_heun_accept_kernel.cu"
)
GPU_RK_HEUN_ACCEPT_KERNEL_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_heun_accept_kernel.hpp"
)
GPU_RK_RK4_ACCEPT_KERNEL_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_rk4_accept_kernel.cu"
)
GPU_RK_RK4_ACCEPT_KERNEL_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_rk4_accept_kernel.hpp"
)
GPU_RK_BS23_ACCEPT_KERNEL_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_bs23_accept_kernel.cu"
)
GPU_RK_BS23_ACCEPT_KERNEL_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_bs23_accept_kernel.hpp"
)
GPU_RK_DP54_ACCEPT_KERNEL_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_dp54_accept_kernel.cu"
)
GPU_RK_DP54_ACCEPT_KERNEL_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_dp54_accept_kernel.hpp"
)
GPU_RK_STAGE_SCHEDULE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_schedule.cu"
)
GPU_RK_STAGE_SCHEDULE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_stage_schedule.hpp"
)
GPU_RK45_STAGE_SEQUENCE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk45_stage_sequence.cu"
)
GPU_RK45_STAGE_SEQUENCE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk45_stage_sequence.hpp"
)
GPU_RK4_RK23_STAGE_SEQUENCE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk4_rk23_stage_sequence.cu"
)
GPU_RK4_RK23_STAGE_SEQUENCE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk4_rk23_stage_sequence.hpp"
)
GPU_RK4_STAGE_SEQUENCE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk4_stage_sequence.cu"
)
GPU_RK4_STAGE_SEQUENCE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk4_stage_sequence.hpp"
)
GPU_RK23_STAGE_SEQUENCE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk23_stage_sequence.cu"
)
GPU_RK23_STAGE_SEQUENCE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk23_stage_sequence.hpp"
)
GPU_HEUN_STAGE_SEQUENCE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "heun_stage_sequence.cu"
)
GPU_HEUN_STAGE_SEQUENCE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "heun_stage_sequence.hpp"
)
GPU_RK23_ADAPTIVE_K3_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk23_adaptive_k3.cu"
)
GPU_RK23_ADAPTIVE_K3_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk23_adaptive_k3.hpp"
)
GPU_RK_ATTEMPT_SETUP_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_attempt_setup.cu"
)
GPU_RK_ATTEMPT_SETUP_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_attempt_setup.hpp"
)
GPU_RK_DEVICE_IO_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_device_io.cu"
)
GPU_RK_DEVICE_IO_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_device_io.hpp"
)
GPU_RK_SCALAR_READBACK_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_scalar_readback.cu"
)
GPU_RK_SCALAR_READBACK_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_scalar_readback.hpp"
)
GPU_RK_COMPONENT_COPY_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_component_copy.cu"
)
GPU_RK_COMPONENT_COPY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_component_copy.hpp"
)
GPU_RK_ADAPTIVE_RUNTIME_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_adaptive_runtime.cu"
)
GPU_RK_ADAPTIVE_RUNTIME_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_adaptive_runtime.hpp"
)
GPU_RK_ERROR_NORM_RUNTIME_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_error_norm_runtime.cu"
)
GPU_RK_ERROR_NORM_RUNTIME_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_error_norm_runtime.hpp"
)
GPU_RK_ADAPTIVE_DECISION_READBACK_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_adaptive_decision_readback.cu"
)
GPU_RK_ADAPTIVE_DECISION_READBACK_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_adaptive_decision_readback.hpp"
)
GPU_RK_ATTEMPT_LOOP_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_attempt_loop.cu"
)
GPU_RK_ATTEMPT_LOOP_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_attempt_loop.hpp"
)
GPU_RK_RHS_RUNTIME_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_rhs_runtime.cu"
)
GPU_RK_RHS_RUNTIME_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_rhs_runtime.hpp"
)
GPU_RK_FSAL_POLICY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_fsal_policy.cpp"
)
GPU_RK_FSAL_POLICY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_fsal_policy.hpp"
)
GPU_RK_EXCHANGE_DISPATCH_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_exchange_dispatch.cu"
)
GPU_RK_EXCHANGE_DISPATCH_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_exchange_dispatch.hpp"
)
GPU_RK_DEMAG_DISPATCH_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_demag_dispatch.cu"
)
GPU_RK_DEMAG_DISPATCH_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_demag_dispatch.hpp"
)
GPU_RK_LLG_RHS_DISPATCH_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_llg_rhs_dispatch.cu"
)
GPU_RK_LLG_RHS_DISPATCH_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_llg_rhs_dispatch.hpp"
)
GPU_RK_LOCAL_FIELDS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_local_fields.cu"
)
GPU_RK_LOCAL_FIELDS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_local_fields.hpp"
)
GPU_RK_ANISOTROPY_FIELD_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_anisotropy_field.cu"
)
GPU_RK_ANISOTROPY_FIELD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_anisotropy_field.hpp"
)
GPU_RK_MAGNETOELASTIC_FIELD_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_magnetoelastic_field.cu"
)
GPU_RK_MAGNETOELASTIC_FIELD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_magnetoelastic_field.hpp"
)
GPU_RK_THERMAL_FIELD_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_thermal_field.cu"
)
GPU_RK_THERMAL_FIELD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_thermal_field.hpp"
)
GPU_RK_EFFECTIVE_FIELD_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_effective_field.cu"
)
GPU_RK_EFFECTIVE_FIELD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_effective_field.hpp"
)
GPU_RK_OERSTED_FIELD_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_oersted_field.cu"
)
GPU_RK_OERSTED_FIELD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_oersted_field.hpp"
)
GPU_RK_DIRECT_TORQUES_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_direct_torques.cu"
)
GPU_RK_DIRECT_TORQUES_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_direct_torques.hpp"
)
GPU_RK_SLONCZEWSKI_TORQUE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_slonczewski_torque.cu"
)
GPU_RK_SLONCZEWSKI_TORQUE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_slonczewski_torque.hpp"
)
GPU_RK_ZHANG_LI_TORQUE_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_zhang_li_torque.cu"
)
GPU_RK_ZHANG_LI_TORQUE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_zhang_li_torque.hpp"
)
GPU_RK_DMI_FIELDS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_dmi_fields.cu"
)
GPU_RK_DMI_FIELDS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_dmi_fields.hpp"
)
FEM_DMI_DOC_PATH = REPO_ROOT / "docs" / "physics" / "fem_dmi.md"
FEM_DMI_INTERFACIAL_SOURCE = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "interactions"
    / "dmi_interfacial.cpp"
)
FEM_DMI_WEAK_RESIDUAL_TEST = (
    REPO_ROOT / "backends" / "fem" / "tests" / "dmi_weak_residual.cpp"
)
VERIFY_FEM_GPU_ENABLEMENT_SCRIPT = REPO_ROOT / "scripts" / "verify_fem_gpu_enablement.sh"
FEM_GPU_DOCKERFILE_PATH = REPO_ROOT / "docker" / "fem-gpu" / "Dockerfile"
GPU_RK_STEP_STATS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step_stats.cu"
)
GPU_RK_STEP_STATS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step_stats.hpp"
)
GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step_stats_publication.cpp"
)
GPU_RK_STEP_STATS_PUBLICATION_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_step_stats_publication.hpp"
)
GPU_RK_ENERGY_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_energy_reductions.cu"
)
GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_exchange_energy_reductions.cu"
)
GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_exchange_energy_reductions.hpp"
)
GPU_RK_EXTERNAL_ENERGY_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_external_energy_reductions.cu"
)
GPU_RK_EXTERNAL_ENERGY_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_external_energy_reductions.hpp"
)
GPU_RK_DEMAG_ENERGY_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_demag_energy_reductions.cu"
)
GPU_RK_DEMAG_ENERGY_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_demag_energy_reductions.hpp"
)
GPU_RK_DMI_ENERGY_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_dmi_energy_reductions.cu"
)
GPU_RK_DMI_ENERGY_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_dmi_energy_reductions.hpp"
)
GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_anisotropy_energy_reductions.cu"
)
GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_anisotropy_energy_reductions.hpp"
)
GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_magnetoelastic_energy_reductions.cu"
)
GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_magnetoelastic_energy_reductions.hpp"
)
GPU_RK_ENERGY_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_energy_reductions.hpp"
)
GPU_RK_OBSERVABLE_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_observable_reductions.cu"
)
GPU_RK_OBSERVABLE_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_observable_reductions.hpp"
)
GPU_RK_FIELD_METRIC_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_field_metric_reductions.cu"
)
GPU_RK_FIELD_METRIC_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_field_metric_reductions.hpp"
)
GPU_RK_MAGNETIZATION_REDUCTIONS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_magnetization_reductions.cu"
)
GPU_RK_MAGNETIZATION_REDUCTIONS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_magnetization_reductions.hpp"
)
GPU_MAGNETIZATION_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "magnetization_state.hpp"
)
GPU_MAGNETIZATION_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "magnetization_memory.hpp"
)
GPU_MAGNETIZATION_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "magnetization_memory.cpp"
)
GPU_MAGNETIZATION_TRANSFER_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "magnetization_transfer.hpp"
)
GPU_MAGNETIZATION_TRANSFER_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "magnetization_transfer.cpp"
)
GPU_RUNTIME_COEFFICIENTS_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "runtime_coefficients_state.hpp"
)
GPU_RUNTIME_COEFFICIENTS_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "runtime_coefficients_memory.hpp"
)
GPU_RUNTIME_COEFFICIENTS_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "runtime_coefficients_memory.cpp"
)
GPU_RUNTIME_COEFFICIENTS_UPLOAD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "runtime_coefficients_upload.hpp"
)
GPU_RUNTIME_COEFFICIENTS_UPLOAD_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "runtime_coefficients_upload.cpp"
)
GPU_RESIDENCY_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "residency_state.hpp"
)
GPU_LIFECYCLE_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "lifecycle_state.hpp"
)
GPU_DEVICE_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "device_memory.hpp"
)
GPU_DEVICE_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "state"
    / "device_memory.cpp"
)
GPU_FIELD_BUFFER_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "fields"
    / "field_buffer_state.hpp"
)
GPU_FIELD_BUFFER_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "fields"
    / "field_buffer_memory.hpp"
)
GPU_FIELD_BUFFER_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "fields"
    / "field_buffer_memory.cpp"
)
GPU_FIELD_BUFFER_UPLOAD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "fields"
    / "field_buffer_upload.hpp"
)
GPU_FIELD_BUFFER_UPLOAD_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "fields"
    / "field_buffer_upload.cpp"
)
GPU_RK_WORKSPACE_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_workspace_state.hpp"
)
GPU_RK_WORKSPACE_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_workspace_memory.hpp"
)
GPU_RK_WORKSPACE_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_workspace_memory.cpp"
)
GPU_REDUCTION_WORKSPACE_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "reductions"
    / "reduction_workspace_state.hpp"
)
GPU_REDUCTION_WORKSPACE_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "reductions"
    / "reduction_workspace_memory.hpp"
)
GPU_REDUCTION_WORKSPACE_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "reductions"
    / "reduction_workspace_memory.cpp"
)
GPU_RK_FINAL_REFRESH_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_final_refresh.cu"
)
GPU_RK_FINAL_REFRESH_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_final_refresh.hpp"
)
GPU_RK_SNAPSHOT_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_snapshot.cu"
)
GPU_RK_SNAPSHOT_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "rk"
    / "rk_snapshot.hpp"
)
KERNELS_CU_PATH = (
    REPO_ROOT / "backends" / "fem" / "gpu" / "cuda" / "kernels" / "kernels.cu"
)
KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "kernels"
    / "kernels.hpp"
)


def read_optional_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


GPU_VECTOR_FIELD_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "fields"
    / "vector_field_kernels.cu"
)
GPU_VECTOR_FIELD_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "fields"
    / "vector_field_kernels.hpp"
)
GPU_DEMAG_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "demag_poisson"
    / "demag_kernels.cu"
)
GPU_DEMAG_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "demag_poisson"
    / "demag_kernels.hpp"
)
GPU_DEMAG_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "demag_poisson"
    / "demag_state.hpp"
)
GPU_DEMAG_STAGE_COMPUTE_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "demag_poisson"
    / "stage_compute.cpp"
)
GPU_LLG_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "llg"
    / "llg_rhs_kernels.cu"
)
GPU_LLG_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "integrators"
    / "llg"
    / "llg_rhs_kernels.hpp"
)
GPU_EXCHANGE_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "exchange"
    / "exchange_plan.cpp"
)
GPU_EXCHANGE_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "exchange"
    / "exchange_kernels.cu"
)
GPU_EXCHANGE_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "exchange"
    / "exchange_kernels.hpp"
)
GPU_EXCHANGE_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "exchange"
    / "exchange_state.hpp"
)
GPU_EXCHANGE_UPLOAD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "exchange"
    / "exchange_upload.hpp"
)
GPU_EXCHANGE_UPLOAD_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "exchange"
    / "exchange_upload.cpp"
)
GPU_MESH_METRICS_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "mesh"
    / "mesh_metrics_state.hpp"
)
GPU_MESH_REGIONS_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "mesh"
    / "mesh_regions_state.hpp"
)
GPU_MESH_GEOMETRY_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "mesh"
    / "mesh_geometry_state.hpp"
)
GPU_MESH_GEOMETRY_UPLOAD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "mesh"
    / "mesh_geometry_upload.hpp"
)
GPU_MESH_GEOMETRY_UPLOAD_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "mesh"
    / "mesh_geometry_upload.cpp"
)
GPU_MATERIAL_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "materials"
    / "material_state.hpp"
)
GPU_ANISOTROPY_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "anisotropy"
    / "anisotropy_kernels.cu"
)
GPU_ANISOTROPY_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "anisotropy"
    / "anisotropy_kernels.hpp"
)
GPU_DMI_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "dmi"
    / "dmi_kernels.cu"
)
GPU_DMI_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "dmi"
    / "dmi_kernels.hpp"
)
GPU_MAGNETOELASTIC_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "magnetoelastic"
    / "magnetoelastic_kernels.cu"
)
GPU_MAGNETOELASTIC_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "magnetoelastic"
    / "magnetoelastic_kernels.hpp"
)
GPU_MAGNETOELASTIC_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "magnetoelastic"
    / "magnetoelastic_state.hpp"
)
GPU_MAGNETOELASTIC_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "magnetoelastic"
    / "magnetoelastic_memory.hpp"
)
GPU_MAGNETOELASTIC_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "magnetoelastic"
    / "magnetoelastic_memory.cpp"
)
GPU_MAGNETOELASTIC_UPLOAD_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "magnetoelastic"
    / "magnetoelastic_upload.hpp"
)
GPU_MAGNETOELASTIC_UPLOAD_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "magnetoelastic"
    / "magnetoelastic_upload.cpp"
)
GPU_LOCAL_INTERACTION_WORKSPACE_STATE_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "local_interaction_workspace_state.hpp"
)
GPU_LOCAL_INTERACTION_WORKSPACE_MEMORY_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "local_interaction_workspace_memory.hpp"
)
GPU_LOCAL_INTERACTION_WORKSPACE_MEMORY_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "local_interaction_workspace_memory.cpp"
)
GPU_STT_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "stt"
    / "stt_kernels.cu"
)
GPU_STT_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "stt"
    / "stt_kernels.hpp"
)
GPU_THERMAL_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "thermal"
    / "thermal_kernels.cu"
)
GPU_THERMAL_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "thermal"
    / "thermal_kernels.hpp"
)
GPU_ZEEMAN_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "zeeman"
    / "zeeman_kernels.cu"
)
GPU_ZEEMAN_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "zeeman"
    / "zeeman_kernels.hpp"
)
GPU_OERSTED_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "oersted"
    / "oersted_kernels.cu"
)
GPU_OERSTED_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "interactions"
    / "oersted"
    / "oersted_kernels.hpp"
)
GPU_OBSERVABLE_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "observables"
    / "observable_kernels.cu"
)
GPU_OBSERVABLE_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "observables"
    / "observable_kernels.hpp"
)
GPU_REDUCTION_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "reductions"
    / "reduction_kernels.cu"
)
GPU_REDUCTION_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "reductions"
    / "reduction_kernels.hpp"
)
GPU_TRANSFER_KERNELS_CU_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "transfer"
    / "transfer_kernels.cu"
)
GPU_TRANSFER_KERNELS_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "transfer"
    / "transfer_kernels.hpp"
)
GPU_COMPONENT_TRANSFER_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "transfer"
    / "component_transfer.cpp"
)
GPU_COMPONENT_TRANSFER_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "transfer"
    / "component_transfer.hpp"
)
GPU_STATE_CPP_PATH = (
    REPO_ROOT / "backends" / "fem" / "gpu" / "cuda" / "state" / "gpu_state.cpp"
)
GPU_STATE_HPP_PATH = (
    REPO_ROOT / "backends" / "fem" / "gpu" / "cuda" / "state" / "gpu_state.hpp"
)
GPU_STATE_RUNTIME_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "gpu"
    / "cuda"
    / "runtime"
    / "gpu_state_runtime.cpp"
)
MFEM_BRIDGE_CPP_PATH = REPO_ROOT / "backends" / "fem" / "src" / "mfem_bridge.cpp"
EXCHANGE_FIELD_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "interactions"
    / "exchange_field.cpp"
)
EXCHANGE_RUNTIME_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "interactions"
    / "exchange_runtime.cpp"
)
RK_EXPLICIT_STEP_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "integrators"
    / "rk_explicit_step.cpp"
)
SNAPSHOT_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "runtime"
    / "snapshot.cpp"
)
STAGE_COMPLETION_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "runtime"
    / "stage_completion.cpp"
)
STAGE_COMPLETION_HPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "runtime"
    / "stage_completion.hpp"
)
STEP_METRICS_CPP_PATH = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "mfem"
    / "runtime"
    / "step_metrics.cpp"
)
ALL_IN_GPU_RUNTIME_DOC = REPO_ROOT / "docs" / "physics" / "0560-all-in-gpu-fem-runtime.md"
ALL_IN_GPU_PLAN = (
    REPO_ROOT / "docs" / "plans" / "active" / "all-in-gpu-fem-rollout-plan-2026-05-15.md"
)


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location("bench_fem_gpu_long", BENCHMARK_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_analysis_benchmark_module():
    spec = importlib.util.spec_from_file_location(
        "fem_gpu_benchmark", ANALYSIS_BENCHMARK_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_benchmark_config_accepts_integrator_axis(monkeypatch):
    bench = load_benchmark_module()
    monkeypatch.setenv("FULLMAG_BENCH_INTEGRATOR", "rk4")

    _, _, _, _, integrator, _ = bench.benchmark_config()

    assert integrator == "rk4"


def test_benchmark_config_accepts_adaptive_timestep_policy(monkeypatch):
    bench = load_benchmark_module()
    monkeypatch.setenv("FULLMAG_BENCH_INTEGRATOR", "rk23")
    monkeypatch.setenv("FULLMAG_BENCH_TIMESTEP_POLICY", "adaptive")

    _, _, _, _, integrator, timestep_policy = bench.benchmark_config()

    assert integrator == "rk23"
    assert timestep_policy == "adaptive"


def test_default_until_follows_env_steps_and_dt(monkeypatch):
    monkeypatch.setenv("FULLMAG_BENCH_STEPS", "7")
    monkeypatch.setenv("FULLMAG_BENCH_DT", "2e-13")
    bench = load_benchmark_module()

    assert bench.DEFAULT_UNTIL == 14e-13


def test_build_is_no_arg_for_cli_loader():
    bench = load_benchmark_module()
    signature = inspect.signature(bench.build)

    for parameter in signature.parameters.values():
        assert parameter.default is not inspect.Parameter.empty


def test_exchange_demag_build_uses_shared_domain_mesh_contract():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag",
        integrator="heun",
    )

    assert problem.runtime.backend_target.value == "fem"
    assert problem.discretization.fem.mesh is None
    assert problem.runtime_metadata["study_universe"]["airbox_hmax"] > 0.0
    assert problem.runtime_metadata["mesh_workflow"]["build_target"] == "domain"


def test_exchange_only_box500_airbox_build_uses_requested_relaxation_contract():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=25,
        scenario="exchange_only_box500_airbox1um",
        integrator="heun",
    )

    magnet = problem.magnets[0]
    assert magnet.geometry.size == (500e-9, 100e-9, 10e-9)
    assert magnet.m0.to_ir() == {"kind": "uniform", "value": [1.0, 0.0, 0.0]}
    assert [term.to_ir()["kind"] for term in problem.energy] == ["exchange"]
    assert problem.study.to_ir()["kind"] == "relaxation"
    assert problem.study.max_steps == 25
    assert problem.discretization.fem.mesh is None
    assert problem.runtime_metadata["study_universe"]["size"] == [1e-6, 1e-6, 1e-6]
    assert problem.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert (
        problem.runtime_metadata["mesh_workflow"]["domain_mesh_mode"]
        == "generated_shared_domain_mesh"
    )


def test_box500_airbox_full_relaxation_tolerance_contract(monkeypatch):
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    assert bench.RELAX_TORQUE_TOLERANCE_T == pytest.approx(1e-4)
    assert bench.RELAX_TORQUE_TOLERANCE_APM == pytest.approx(
        bench.RELAX_TORQUE_TOLERANCE_T / bench.MU0
    )
    monkeypatch.setenv(
        "FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE",
        repr(bench.RELAX_TORQUE_TOLERANCE_APM),
    )

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=bench.FULL_RELAXATION_MAX_STEPS,
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
    )

    assert problem.study.to_ir()["kind"] == "relaxation"
    assert problem.study.max_steps == bench.FULL_RELAXATION_MAX_STEPS
    assert problem.study.torque_tolerance == pytest.approx(
        bench.RELAX_TORQUE_TOLERANCE_APM
    )


def test_exchange_demag_anisotropy_build_uses_shared_domain_and_material_ku():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        timestep_policy="adaptive",
    )

    material = problem.magnets[0].material
    assert problem.discretization.fem.mesh is None
    assert problem.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert material.Ku1 == 0.5e6
    assert material.anisU == (0.0, 0.0, 1.0)


def test_phase10_anisotropy_scenarios_use_expected_terms_and_materials():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    uniaxial = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_anis_uniaxial",
        integrator="heun",
    )
    cubic = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_anis_cubic",
        integrator="heun",
    )
    demag_uniaxial = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anis_uniaxial",
        integrator="heun",
    )
    demag_cubic = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anis_cubic",
        integrator="heun",
    )

    assert uniaxial.discretization.fem.mesh == str(mesh_path)
    assert uniaxial.magnets[0].material.Ku1 == 0.5e6
    assert uniaxial.magnets[0].material.anisU == (0.0, 0.0, 1.0)
    assert cubic.discretization.fem.mesh == str(mesh_path)
    assert cubic.magnets[0].material.Kc1 == 4.8e4
    assert cubic.magnets[0].material.anisC1 == (1.0, 0.0, 0.0)
    assert cubic.magnets[0].material.anisC2 == (0.0, 1.0, 0.0)
    assert demag_uniaxial.discretization.fem.mesh is None
    assert demag_uniaxial.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert demag_uniaxial.magnets[0].material.Ku1 == 0.5e6
    assert demag_cubic.discretization.fem.mesh is None
    assert demag_cubic.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert demag_cubic.magnets[0].material.Kc1 == 4.8e4


def test_benchmark_build_accepts_demag_solver_policy_env(monkeypatch):
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_RTOL", "1e-6")
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_ATOL", "1e-12")
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_MAX_ITERATIONS", "75")
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_PRINT_LEVEL", "2")

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        timestep_policy="adaptive",
    )

    policy = problem.discretization.fem.demag_solver_policy
    assert policy is not None
    assert policy.solver == "CG"
    assert policy.preconditioner == "AMG"
    assert policy.rtol == 1e-6
    assert policy.atol == 1e-12
    assert policy.max_iterations == 75
    assert policy.print_level == 2


def test_benchmark_build_can_omit_demag_solver_policy_env(monkeypatch):
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"
    monkeypatch.setenv("FULLMAG_BENCH_DEMAG_PRECONDITIONER", "OMIT")

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag",
        integrator="heun",
    )

    assert problem.discretization.fem.demag_solver_policy is None


def test_benchmark_build_can_request_adaptive_timestep():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=1,
        scenario="exchange_demag",
        integrator="rk23",
        timestep_policy="adaptive",
    )

    dynamics = problem.study.dynamics
    assert dynamics.integrator == "rk23"
    assert dynamics.fixed_timestep is None
    assert dynamics.adaptive_timestep is not None
    assert dynamics.adaptive_timestep.dt_initial == 1e-13


def test_analysis_benchmark_accepts_timestep_policy_axis():
    bench = load_analysis_benchmark_module()

    assert bench.resolve_timestep_policies("fixed,adaptive") == ["fixed", "adaptive"]


def test_build_uses_cli_safe_uniform_initializer():
    bench = load_benchmark_module()
    problem = bench.build()

    assert problem.magnets[0].m0.to_ir()["kind"] == "uniform"


def test_emit_summary_includes_integrator(capsys):
    bench = load_benchmark_module()

    class Step:
        time = 2e-13
        dt = 1e-13
        error_estimate = 0.25
        dt_suggested = 2e-13
        e_total = 1.0
        e_ex = 0.25
        e_demag = 0.0
        wall_time_ns = 10
        exchange_wall_time_ns = 2
        demag_wall_time_ns = 0
        demag_assemble_wall_time_ns = 0
        demag_solve_wall_time_ns = 0
        demag_recover_wall_time_ns = 0
        demag_energy_wall_time_ns = 0
        rhs_wall_time_ns = 3
        extra_energy_wall_time_ns = 1
        snapshot_wall_time_ns = 0
        rhs_evals = 5
        demag_solves = 0
        rejected_attempts = 0
        fsal_reused = False
        max_dm_dt = 4.0
        max_h_eff = 5.0
        max_h_demag = 0.0
        e_ani = 0.0
        e_dmi = 0.0

    class Value:
        value = "fem"

    class Result:
        status = "ok"
        backend = Value()
        mode = Value()
        precision = Value()
        steps = [Step()]

    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    bench.emit_summary(Result(), mesh_path, 1, 2e-13, "exchange_only", "rk4", "adaptive")

    output = capsys.readouterr().out.strip()
    assert output.startswith("BENCHMARK_RESULT=")
    payload = json.loads(output.split("=", 1)[1])
    assert payload["integrator"] == "rk4"
    assert payload["timestep_policy"] == "adaptive"
    assert payload["final_solver_dt_s"] == 1e-13
    assert payload["error_estimate"] == 0.25
    assert payload["dt_suggested_s"] == 2e-13
    assert payload["rhs_evals"] == 5


def test_emit_summary_includes_demag_phase_timing_fields(capsys):
    bench = load_benchmark_module()

    class Step:
        time = 2e-13
        e_total = 1.0
        e_ex = 0.25
        e_demag = 0.1
        wall_time_ns = 31
        exchange_wall_time_ns = 2
        demag_wall_time_ns = 29
        demag_assemble_wall_time_ns = 3
        demag_solve_wall_time_ns = 5
        demag_recover_wall_time_ns = 7
        demag_energy_wall_time_ns = 11
        rhs_wall_time_ns = 13
        extra_energy_wall_time_ns = 17
        snapshot_wall_time_ns = 19
        rhs_evals = 5
        demag_solves = 1
        rejected_attempts = 0
        fsal_reused = False
        max_dm_dt = 4.0
        max_h_eff = 5.0
        max_h_demag = 6.0
        e_ani = 0.0
        e_dmi = 0.0

    class Value:
        value = "fem"

    class Result:
        status = "ok"
        backend = Value()
        mode = Value()
        precision = Value()
        steps = [Step()]

    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    bench.emit_summary(Result(), mesh_path, 1, 2e-13, "exchange_demag", "heun")

    payload = json.loads(capsys.readouterr().out.strip().split("=", 1)[1])
    assert payload["demag_assemble_wall_time_ns"] == 3
    assert payload["demag_solve_wall_time_ns"] == 5
    assert payload["demag_recover_wall_time_ns"] == 7
    assert payload["demag_energy_wall_time_ns"] == 11


def test_preflight_finds_mfem_config_from_mfem_dir(tmp_path):
    bench = load_analysis_benchmark_module()
    mfem_prefix = tmp_path / "mfem"
    config_path = mfem_prefix / "lib" / "cmake" / "mfem" / "MFEMConfig.cmake"
    config_path.parent.mkdir(parents=True)
    config_path.write_text("# test mfem config\n", encoding="utf-8")

    report = bench.build_preflight_report({"MFEM_DIR": str(mfem_prefix)})

    assert report["status"] == "ok_mfem_config"
    assert report["mfem_config_path"] == str(config_path)
    assert bench.is_mfem_stack_ready(report)


def test_resolve_backends_accepts_cpu_only():
    bench = load_analysis_benchmark_module()

    assert bench.resolve_backends("cpu") == ["fem_cpu"]
    assert bench.resolve_backends("fem_cpu,gpu") == ["fem_cpu", "fem_gpu"]


def test_resolve_backends_rejects_unknown_backend():
    bench = load_analysis_benchmark_module()

    try:
        bench.resolve_backends("cpu,tpu")
    except ValueError as exc:
        assert "unsupported benchmark backend" in str(exc)
    else:
        raise AssertionError("resolve_backends should reject unknown backends")


def test_positive_int_arg_rejects_zero_gmsh_threads():
    bench = load_analysis_benchmark_module()

    try:
        bench.positive_int_arg("0")
    except bench.argparse.ArgumentTypeError as exc:
        assert ">= 1" in str(exc)
    else:
        raise AssertionError("positive_int_arg should reject zero")


def test_resolve_thread_count_specs_accepts_phase10_tokens():
    bench = load_analysis_benchmark_module()

    specs = bench.resolve_thread_count_specs(
        "1,physical_cores/2,physical_cores,auto",
        detected_physical_cores=8,
    )

    assert [(spec.label, spec.env_value) for spec in specs] == [
        ("1", "1"),
        ("physical_cores/2", "4"),
        ("physical_cores", "8"),
        ("auto", "auto"),
    ]


def test_positive_float_arg_rejects_zero_demag_residual_threshold():
    bench = load_analysis_benchmark_module()

    try:
        bench.positive_float_arg("0")
    except bench.argparse.ArgumentTypeError as exc:
        assert "> 0" in str(exc)
    else:
        raise AssertionError("positive_float_arg should reject zero")


def test_analysis_demag_policy_args_validate_known_values():
    bench = load_analysis_benchmark_module()

    assert bench.demag_solver_arg("gmres") == "GMRES"
    assert bench.demag_preconditioner_arg("jacobi") == "JACOBI"
    assert bench.demag_preconditioner_arg("omit") == "OMIT"
    assert bench.nonnegative_int_arg("0") == 0
    assert bench.parse_args(["--gpu-warmup"]).gpu_warmup is True
    assert (
        bench.parse_args(["--min-gpu-demag-total-speedup", "2.5"]).min_gpu_demag_total_speedup
        == 2.5
    )
    assert bench.resolve_demag_solvers("cg,gmres,cg", "CG") == ["CG", "GMRES"]
    assert bench.resolve_demag_preconditioners("amg,jacobi,none,omit", "AMG") == [
        "AMG",
        "JACOBI",
        "NONE",
        "OMIT",
    ]


def test_analysis_demag_policy_args_reject_unknown_values():
    bench = load_analysis_benchmark_module()

    for parser, value in (
        (bench.demag_solver_arg, "bicgstab"),
        (bench.demag_preconditioner_arg, "ilu"),
        (bench.nonnegative_int_arg, "-1"),
    ):
        try:
            parser(value)
        except bench.argparse.ArgumentTypeError:
            continue
        raise AssertionError(f"{parser.__name__} should reject {value!r}")


def test_phase10_analysis_accepts_medium_mesh_alias_and_scenario_names():
    bench = load_analysis_benchmark_module()

    assert bench.resolve_mesh_token("medium") == (
        REPO_ROOT / "examples" / "assets" / "bench_box_200x50x10nm.mesh.json"
    )
    assert bench.resolve_scenarios(
        "exchange_only,exchange_demag,exchange_anis_uniaxial,exchange_anis_cubic,"
        "exchange_demag_anis_uniaxial,exchange_demag_anis_cubic"
    ) == [
        "exchange_only",
        "exchange_demag",
        "exchange_anis_uniaxial",
        "exchange_anis_cubic",
        "exchange_demag_anis_uniaxial",
        "exchange_demag_anis_cubic",
    ]
    assert bench.row_is_fem_cpu_no_pbc_adaptive_scope(
        {
            "backend": "fem_cpu",
            "scenario": "exchange_demag_anis_uniaxial",
            "integrator": "rk23",
            "timestep_policy": "adaptive",
        }
    )
    assert bench.row_is_fem_cpu_no_pbc_adaptive_scope(
        {
            "backend": "fem_cpu",
            "scenario": "exchange_demag_anis_cubic",
            "integrator": "rk45",
            "timestep_policy": "adaptive",
        }
    )


def test_demag_policy_pairs_expand_only_demag_scenarios():
    bench = load_analysis_benchmark_module()

    assert bench.demag_policy_pairs_for_scenario(
        "exchange_demag_anisotropy",
        ["CG", "GMRES"],
        ["AMG", "JACOBI"],
    ) == [
        ("CG", "AMG"),
        ("CG", "JACOBI"),
        ("GMRES", "AMG"),
        ("GMRES", "JACOBI"),
    ]
    assert bench.demag_policy_pairs_for_scenario(
        "exchange_only",
        ["CG", "GMRES"],
        ["AMG", "JACOBI"],
    ) == [("CG", "AMG")]


def test_run_backend_carries_demag_phase_timing_from_payload(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=json.dumps(
                {
                    "executed_steps": 2,
                    "final_time_s": 2e-13,
                    "demag_assemble_wall_time_ns": 3_000_000,
                    "demag_solve_wall_time_ns": 5_000_000,
                    "demag_recover_wall_time_ns": 7_000_000,
                    "demag_energy_wall_time_ns": 11_000_000,
                }
            ).join(("BENCHMARK_RESULT=", "\n")),
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["demag_assemble_wall_time_ms"] == 3.0
    assert row["demag_solve_wall_time_ms"] == 5.0
    assert row["demag_recover_wall_time_ms"] == 7.0
    assert row["demag_energy_wall_time_ms"] == 11.0


def test_run_backend_propagates_requested_gmsh_threads(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        thread_spec=bench.ThreadCountSpec(label="physical_cores/2", env_value="4"),
        extra_env={
            "FULLMAG_FEM_EXECUTION": "cpu",
            "FULLMAG_GMSH_THREADS": "1",
            "FULLMAG_BENCH_DEMAG_SOLVER": "GMRES",
            "FULLMAG_BENCH_DEMAG_PRECONDITIONER": "JACOBI",
            "FULLMAG_BENCH_DEMAG_RTOL": "1e-6",
            "FULLMAG_BENCH_DEMAG_ATOL": "1e-12",
            "FULLMAG_BENCH_DEMAG_MAX_ITERATIONS": "75",
            "FULLMAG_BENCH_DEMAG_PRINT_LEVEL": "2",
        },
    )

    assert captured_env["FULLMAG_GMSH_THREADS"] == "1"
    assert captured_env["FULLMAG_CPU_THREADS"] == "4"
    assert captured_env["FULLMAG_BENCH_DEMAG_SOLVER"] == "GMRES"
    assert captured_env["FULLMAG_BENCH_DEMAG_PRECONDITIONER"] == "JACOBI"
    assert row["requested_gmsh_threads"] == "1"
    assert row["requested_cpu_thread_spec"] == "physical_cores/2"
    assert row["requested_cpu_threads"] == "4"
    assert row["requested_demag_solver"] == "GMRES"
    assert row["requested_demag_preconditioner"] == "JACOBI"
    assert row["requested_demag_relative_tolerance"] == "1e-6"
    assert row["requested_demag_absolute_tolerance"] == "1e-12"
    assert row["requested_demag_max_iterations"] == "75"
    assert row["requested_demag_print_level"] == "2"


def test_run_backend_does_not_apply_gpu_hot_loop_sync_gate_to_cpu_rows(
    monkeypatch,
    tmp_path,
):
    bench = load_analysis_benchmark_module()
    monkeypatch.setenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC", "1")
    monkeypatch.setenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC", "1")
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC" not in captured_env
    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC" not in captured_env


def test_run_backend_defaults_fullmag_python_to_benchmark_interpreter(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    monkeypatch.delenv("FULLMAG_PYTHON", raising=False)
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_PYTHON"] == bench.sys.executable
    assert row["requested_fullmag_python"] == bench.sys.executable


def test_run_backend_exports_bundled_openmpi_runtime_env(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    runtime_root = tmp_path / "fem-gpu-host"
    (runtime_root / "openmpi" / "share" / "openmpi").mkdir(parents=True)
    (runtime_root / "openmpi" / "lib" / "openmpi3").mkdir(parents=True)
    (runtime_root / "openmpi" / "bin").mkdir(parents=True)
    (runtime_root / "lib" / "pmix2" / "share" / "pmix").mkdir(parents=True)
    monkeypatch.setattr(bench, "MANAGED_FEM_RUNTIME_ROOT", runtime_root)
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    openmpi_root = runtime_root / "openmpi"
    pmix_root = runtime_root / "lib" / "pmix2"
    assert captured_env["OPAL_PREFIX"] == str(openmpi_root)
    assert captured_env["OMPI_MCA_mca_base_component_path"] == str(
        openmpi_root / "lib" / "openmpi3"
    )
    assert captured_env["OMPI_MCA_orte_launch_agent"] == str(
        openmpi_root / "bin" / "orted"
    )
    assert captured_env["OMPI_MCA_reachable"] == "weighted"
    assert captured_env["OMPI_MCA_mca_base_component_show_load_errors"] == "0"
    assert captured_env["PMIX_PREFIX"] == str(pmix_root)
    assert captured_env["PMIX_EXEC_PREFIX"] == str(pmix_root)
    assert captured_env["PMIX_MCA_pcompress_base_silence_warning"] == "1"


def test_run_backend_forces_gpu_execution_over_inherited_cpu_env(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    monkeypatch.setenv("FULLMAG_FEM_EXECUTION", "cpu")
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only_box500_airbox1um",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_FEM_EXECUTION"] == "gpu"
    assert row["requested_fem_execution"] == "gpu"


def test_run_backend_maps_final_torque_from_benchmark_payload(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=(
                'BENCHMARK_RESULT={"executed_steps": 3, "final_time_s": 3e-13, '
                '"max_torque_Apm": 1.25e-6, "max_torque_T": 1.5707963267948965e-12}\n'
            ),
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only_box500_airbox1um",
        integrator="heun",
        steps=3,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["final_torque_apm"] == 1.25e-6
    assert row["final_torque_t"] == 1.5707963267948965e-12


def test_run_backend_records_requested_relax_torque_tolerance(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 3, "final_time_s": 3e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only_box500_airbox1um",
        integrator="heun",
        steps=3,
        dt=1e-13,
        extra_env={
            "FULLMAG_FEM_EXECUTION": "cpu",
            "FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE": "79.57747154594767",
        },
    )

    assert (
        captured_env["FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE"]
        == "79.57747154594767"
    )
    assert row["requested_relax_torque_tolerance_apm"] == "79.57747154594767"


def test_run_backend_marks_case_timeout(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_timeout = None

    def fake_run(cmd, cwd, env, capture_output, text, check, timeout):
        nonlocal captured_timeout
        captured_timeout = timeout
        raise bench.subprocess.TimeoutExpired(
            cmd=cmd,
            timeout=timeout,
            output="partial stdout\n",
            stderr="partial stderr\n",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only_box500_airbox1um",
        integrator="heun",
        steps=1000,
        dt=1e-13,
        timeout_s=300.0,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert captured_timeout == 300.0
    assert row["status"] == "timeout"
    assert row["case_timeout_s"] == 300.0
    assert "timed out after 300.0 s" in row["error"]
    assert row["stdout_lines"] == 1
    assert row["stderr_lines"] == 1


def test_run_backend_missing_gpu_binary_still_reports_adaptive_acceptance_gate(tmp_path):
    bench = load_analysis_benchmark_module()
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=tmp_path / "missing-fullmag-fem-gpu",
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="rk45",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["status"] == "missing_binary"
    assert row["error"] == "GPU benchmark binary is missing"
    assert row["phase2_compute_assertion_enabled"] is True
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "gpu_binary=missing"
    assert row["adaptive_gpu_rk_acceptance_ready"] is False
    assert "nvcc" in row["adaptive_gpu_rk_acceptance_blockers"]


def test_run_backend_prefers_execution_plan_mesh_stats_from_metadata(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "input_magnetic_mesh",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_plan": {
                        "backend_plan": {
                            "kind": "fem",
                            "mesh_name": "study_domain",
                            "mesh": {
                                "nodes": [[0, 0, 0], [1, 0, 0]],
                                "elements": [[0, 1, 1, 1]],
                                "boundary_faces": [[0, 1, 1]],
                            },
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["mesh_name"] == "study_domain"
    assert row["node_count"] == 2
    assert row["element_count"] == 1
    assert row["boundary_face_count"] == 1
    assert row["solver_mesh_signature"]


def test_input_mesh_summary_distinguishes_input_asset_from_solver_mesh():
    bench = load_analysis_benchmark_module()

    summary = bench.input_mesh_summary(
        {
            "mesh_name": "box_40x20x10_coarse",
            "node_count": 8,
            "element_count": 6,
        }
    )

    assert summary == (
        "input_mesh=box_40x20x10_coarse "
        "input_nodes=8 "
        "input_elements=6 "
        "(solver mesh is reported per completed row)"
    )


def test_execution_plan_mesh_signature_changes_with_solver_mesh():
    bench = load_analysis_benchmark_module()
    first = {
        "execution_plan": {
            "backend_plan": {
                "kind": "fem",
                "mesh_name": "study_domain",
                "mesh": {
                    "nodes": [[0, 0, 0], [1, 0, 0]],
                    "elements": [[0, 1, 1, 1]],
                    "boundary_faces": [[0, 1, 1]],
                },
            }
        }
    }
    second = {
        "execution_plan": {
            "backend_plan": {
                "kind": "fem",
                "mesh_name": "study_domain",
                "mesh": {
                    "nodes": [[0, 0, 0], [2, 0, 0]],
                    "elements": [[0, 1, 1, 1]],
                    "boundary_faces": [[0, 1, 1]],
                },
            }
        }
    }

    first_stats = bench.execution_plan_mesh_stats(first)
    second_stats = bench.execution_plan_mesh_stats(second)

    assert first_stats["solver_mesh_signature"]
    assert second_stats["solver_mesh_signature"]
    assert first_stats["solver_mesh_signature"] != second_stats["solver_mesh_signature"]


def test_unstable_solver_mesh_groups_detects_repeated_case_drift():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "demag_relative_tolerance": 1e-6,
        "demag_absolute_tolerance": None,
        "demag_max_iterations": 100,
    }

    failures = bench.unstable_solver_mesh_groups(
        [
            {**base_row, "repeat_index": 0, "solver_mesh_signature": "mesh-a"},
            {**base_row, "repeat_index": 1, "solver_mesh_signature": "mesh-b"},
        ]
    )

    assert failures
    assert "exchange_demag_anisotropy" in failures[0]


def test_unstable_solver_mesh_groups_accepts_stable_repeats():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "demag_relative_tolerance": 1e-6,
        "demag_absolute_tolerance": None,
        "demag_max_iterations": 100,
        "solver_mesh_signature": "mesh-a",
    }

    assert bench.unstable_solver_mesh_groups([{**row, "repeat_index": 0}, {**row, "repeat_index": 1}]) == []


def test_benchmark_pass_fail_summary_groups_by_solver_mesh_signature():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "mesh_path": "coarse",
            "scenario": "exchange_demag",
            "integrator": "heun",
            "requested_cpu_thread_spec": "1",
            "solver_mesh_signature": "mesh-a",
            "status": "ok",
            "demag_final_residual_norm": 5e-9,
            "demag_actual_iterations": 8,
        },
        {
            "backend": "fem_cpu",
            "mesh_path": "coarse",
            "scenario": "exchange_demag",
            "integrator": "rk4",
            "requested_cpu_thread_spec": "auto",
            "solver_mesh_signature": "mesh-a",
            "status": "ok",
            "demag_final_residual_norm": 5e-7,
            "demag_actual_iterations": 8,
        },
        {
            "backend": "fem_cpu",
            "mesh_path": "medium",
            "scenario": "exchange_only",
            "integrator": "heun",
            "requested_cpu_thread_spec": "1",
            "solver_mesh_signature": "mesh-b",
            "status": "failed",
            "error_kind": "mpi_init_or_pmix_startup",
        },
    ]

    summary = bench.benchmark_pass_fail_summary(
        rows,
        gate_failures=["missing matrix row"],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert summary["status"] == "fail"
    assert summary["row_count"] == 3
    assert summary["ok_count"] == 2
    assert summary["failed_count"] == 1
    groups = {group["solver_mesh_signature"]: group for group in summary["solver_mesh_groups"]}
    assert groups["mesh-a"]["status"] == "fail"
    assert groups["mesh-a"]["row_count"] == 2
    assert groups["mesh-a"]["max_demag_final_residual_norm"] == 5e-7
    assert groups["mesh-a"]["thread_specs"] == ["1", "auto"]
    assert groups["mesh-b"]["status"] == "fail"
    assert groups["mesh-b"]["error_kinds"] == ["mpi_init_or_pmix_startup"]


def test_performance_regression_failures_detect_over_budget_identical_solver_mesh_signature():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anis_uniaxial",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "requested_cpu_thread_spec": "auto",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_relative_tolerance": "1e-8",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "solver_mesh_signature": "mesh-a",
        "status": "ok",
    }
    baseline = [
        {
            **base_row,
            "wall_time_ms": "100.0",
            "demag_solver_apply_wall_time_ms": "20.0",
        }
    ]
    current = [
        {
            **base_row,
            "wall_time_ms": 111.0,
            "demag_solver_apply_wall_time_ms": 21.0,
        },
        {
            **base_row,
            "solver_mesh_signature": "mesh-b",
            "wall_time_ms": 1000.0,
            "demag_solver_apply_wall_time_ms": 1000.0,
        },
    ]

    failures = bench.performance_regression_failures(
        current,
        baseline,
        max_regression_percent=10.0,
    )

    assert len(failures) == 1
    assert "wall_time_ms=111" in failures[0]
    assert "accepted baseline 100" in failures[0]
    assert "11.00%" in failures[0]
    assert "mesh-a" in failures[0]
    assert "mesh-b" not in failures[0]
    assert bench.comparable_baseline_case_count(current, baseline) == 1


def test_demag_convergence_failures_detect_residual_and_iteration_drift():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "demag_final_residual_norm": 5e-7,
        "demag_actual_iterations": 11,
    }

    failures = bench.demag_convergence_failures(
        [base_row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert len(failures) == 2
    assert "demag_final_residual_norm" in failures[0]
    assert "demag_actual_iterations" in failures[1]


def test_demag_convergence_failures_include_runtime_error_kind():
    bench = load_analysis_benchmark_module()

    failures = bench.demag_convergence_failures(
        [
            {
                "backend": "fem_cpu",
                "mesh_path": "coarse",
                "scenario": "exchange_demag_anisotropy",
                "integrator": "rk23",
                "timestep_policy": "adaptive",
                "status": "failed",
                "error_kind": "mpi_init_or_pmix_startup",
            }
        ],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert len(failures) == 1
    assert "mpi_init_or_pmix_startup" in failures[0]


def test_demag_convergence_failures_ignore_non_demag_scenarios():
    bench = load_analysis_benchmark_module()

    assert bench.demag_convergence_failures(
        [
            {
                "scenario": "exchange_only",
                "status": "ok",
            }
        ],
        max_residual=1e-8,
        max_iterations=1,
    ) == []


def test_demag_convergence_failures_accept_converged_demag_row():
    bench = load_analysis_benchmark_module()

    assert bench.demag_convergence_failures(
        [
            {
                "scenario": "exchange_demag",
                "status": "ok",
                "demag_final_residual_norm": "5e-9",
                "demag_actual_iterations": "6",
            }
        ],
        max_residual=1e-8,
        max_iterations=10,
    ) == []


def test_cpu_gpu_consistency_accepts_matching_box500_exchange_rows():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 2,
            "final_e_total_j": 1.0e-30,
            "final_e_ex_j": 1.0e-30,
            "final_torque_apm": 2.0e-9,
            "final_torque_t": 2.5132741228718346e-15,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 2,
            "final_e_total_j": 1.0000001e-30,
            "final_e_ex_j": 1.0000001e-30,
            "final_torque_apm": 2.0000001e-9,
            "final_torque_t": 2.5132742485355406e-15,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]

    assert bench.cpu_gpu_consistency_failures(rows) == []


def test_box500_airbox_manifest_records_physical_consistency_contract():
    bench = load_analysis_benchmark_module()

    manifest = bench.box500_airbox_exchange_manifest(
        steps=25,
        dt=2e-13,
        energy_rtol=1e-6,
        energy_atol=1e-30,
        torque_rtol=1e-6,
        torque_atol_apm=1e-9,
        torque_atol_t=1e-15,
        max_step_delta=0,
    )

    assert manifest["case_id"] == "exchange_only_box500_airbox1um"
    assert manifest["magnet_size_m"] == [500e-9, 100e-9, 10e-9]
    assert manifest["airbox_size_m"] == [1e-6, 1e-6, 1e-6]
    assert manifest["initial_magnetization"] == [1.0, 0.0, 0.0]
    assert manifest["interactions"] == ["exchange"]
    assert manifest["demag_enabled"] is False
    assert manifest["relaxation"]["algorithm"] == "llg_overdamped"
    assert manifest["relaxation"]["max_steps"] == 25
    assert manifest["relaxation"]["dt_s"] == 2e-13
    assert manifest["cpu_gpu_tolerances"]["energy_rtol"] == 1e-6
    assert manifest["cpu_gpu_tolerances"]["max_step_delta"] == 0
    assert "wall_time_ms" in manifest["observables"]


def test_box500_airbox_interaction_manifests_cover_deterministic_terms():
    bench = load_analysis_benchmark_module()
    scenarios = list(bench.BOX500_AIRBOX_CONSISTENCY_SCENARIOS)

    manifests = bench.cpu_gpu_case_manifests(
        scenarios=scenarios,
        steps=25,
        dt=1e-13,
        energy_rtol=1e-6,
        energy_atol=1e-30,
        torque_rtol=1e-6,
        torque_atol_apm=1e-9,
        torque_atol_t=1e-15,
        max_step_delta=0,
    )

    assert [manifest["case_id"] for manifest in manifests] == scenarios
    by_id = {manifest["case_id"]: manifest for manifest in manifests}
    for manifest in manifests:
        assert manifest["magnet_size_m"] == [500e-9, 100e-9, 10e-9]
        assert manifest["airbox_size_m"] == [1e-6, 1e-6, 1e-6]
        assert manifest["initial_magnetization"] == [1.0, 0.0, 0.0]
        assert manifest["relaxation"]["algorithm"] == "llg_overdamped"
        assert "executed_steps" in manifest["observables"]
        assert "wall_time_ms" in manifest["observables"]

    assert by_id["box500_airbox_exchange_demag"]["interactions"] == [
        "exchange",
        "demag",
        "zeeman",
    ]
    assert "final_e_demag_j" in by_id["box500_airbox_exchange_demag"]["observables"]
    assert by_id["box500_airbox_exchange_anis_uniaxial"]["interactions"] == [
        "exchange",
        "uniaxial_anisotropy",
    ]
    assert "final_e_ani_j" in by_id["box500_airbox_exchange_anis_uniaxial"]["observables"]
    assert by_id["box500_airbox_exchange_dmi"]["interactions"] == [
        "exchange",
        "interfacial_dmi",
        "zeeman",
    ]
    assert "final_e_dmi_j" in by_id["box500_airbox_exchange_dmi"]["observables"]
    assert "final_e_ext_j" in by_id["box500_airbox_exchange_dmi"]["observables"]
    assert by_id["box500_airbox_stt_oersted"]["interactions"] == [
        "exchange",
        "zeeman",
        "oersted",
        "zhang_li_stt",
    ]


def test_box500_airbox_interaction_builds_reuse_geometry_airbox_and_relaxation():
    bench = load_benchmark_module()
    mesh_path = REPO_ROOT / "examples" / "assets" / "box_40x20x10_coarse.mesh.json"

    problem = bench.build(
        mesh_path=mesh_path,
        dt=1e-13,
        steps=25,
        scenario="box500_airbox_exchange_demag_anis_cubic",
        integrator="heun",
    )

    assert problem.magnets[0].geometry.size == (500e-9, 100e-9, 10e-9)
    assert problem.study.to_ir()["kind"] == "relaxation"
    assert problem.study.max_steps == 25
    assert problem.discretization.fem.mesh is None
    assert problem.runtime_metadata["study_universe"]["size"] == [1e-6, 1e-6, 1e-6]
    assert problem.runtime_metadata["mesh_workflow"]["build_target"] == "domain"
    assert problem.magnets[0].material.Kc1 == 4.8e4
    assert [term.to_ir()["kind"] for term in problem.energy] == [
        "exchange",
        "demag",
        "zeeman",
    ]


def test_cpu_gpu_consistency_summary_reports_deltas_and_timing(capsys):
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 2,
            "final_e_total_j": 3.0,
            "final_e_ex_j": 3.0,
            "final_torque_apm": 4.0,
            "final_torque_t": 5.0,
            "wall_time_ms": 40.0,
            "step_wall_time_ms": 20.0,
            "exchange_wall_time_ms": 10.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 1.0,
            "final_e_ex_j": 1.0,
            "final_torque_apm": 1.0,
            "final_torque_t": 2.0,
            "wall_time_ms": 10.0,
            "step_wall_time_ms": 5.0,
            "exchange_wall_time_ms": 2.0,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]

    summary = bench.cpu_gpu_consistency_summary(rows)

    assert summary["pair_count"] == 1
    pair = summary["pairs"][0]
    assert pair["solver_mesh_signature"] == "mesh-a"
    assert pair["executed_step_delta"] == 1
    assert pair["final_e_total_j_abs_diff"] == 2.0
    assert pair["final_torque_apm_abs_diff"] == 3.0
    assert pair["wall_time_speedup_cpu_over_gpu"] == 4.0
    assert pair["step_wall_time_speedup_cpu_over_gpu"] == 4.0
    assert pair["exchange_wall_time_speedup_cpu_over_gpu"] == 5.0

    bench.emit_cpu_gpu_consistency_summary(rows)
    output = capsys.readouterr().out
    assert "FEM_CPU_GPU_CONSISTENCY_SUMMARY=" in output
    assert '"pair_count": 1' in output


def test_gpu_demag_total_speedup_failures_rejects_slow_total_demag():
    bench = load_analysis_benchmark_module()

    summary = {
        "pairs": [
            {
                "scenario": "box500_airbox_exchange_demag",
                "relaxation_algorithm": "llg_overdamped",
                "cpu_demag_wall_time_ms": 120.0,
                "gpu_demag_wall_time_ms": 100.0,
                "demag_wall_time_speedup_cpu_over_gpu": 1.2,
            }
        ]
    }

    failures = bench.gpu_demag_total_speedup_failures(summary, min_speedup=2.0)

    assert failures == [
        "box500_airbox_exchange_demag:llg_overdamped demag_wall_time_speedup_cpu_over_gpu=1.2 below required minimum 2"
    ]


def test_gpu_demag_total_speedup_failures_accepts_fast_total_demag():
    bench = load_analysis_benchmark_module()

    summary = {
        "pairs": [
            {
                "scenario": "box500_airbox_exchange_demag",
                "relaxation_algorithm": "llg_overdamped",
                "cpu_demag_wall_time_ms": 120.0,
                "gpu_demag_wall_time_ms": 30.0,
                "demag_wall_time_speedup_cpu_over_gpu": 4.0,
            }
        ]
    }

    assert bench.gpu_demag_total_speedup_failures(summary, min_speedup=2.0) == []


def test_cpu_gpu_consistency_summary_records_failure_reasons():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "failed",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "error_kind": "cuda_driver_runtime_mismatch",
        },
    ]

    summary = bench.cpu_gpu_consistency_summary(rows)

    assert summary["status"] == "fail"
    assert summary["row_count"] == 2
    assert summary["ok_count"] == 1
    assert summary["failed_count"] == 1
    assert summary["failure_count"] == 2
    assert summary["pair_count"] == 0
    assert any("cuda_driver_runtime_mismatch" in failure for failure in summary["failures"])
    assert any("missing a completed fem_gpu row" in failure for failure in summary["failures"])


def test_cpu_gpu_consistency_summary_reports_required_case_coverage():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]
    manifests = bench.cpu_gpu_case_manifests(
        scenarios=[
            "exchange_only_box500_airbox1um",
            "box500_airbox_exchange_demag",
        ],
        steps=2,
        dt=1e-13,
        energy_rtol=1e-6,
        energy_atol=1e-30,
        torque_rtol=1e-6,
        torque_atol_apm=1e-9,
        torque_atol_t=1e-15,
        max_step_delta=0,
    )

    summary = bench.cpu_gpu_consistency_summary(
        rows,
        case_manifests=manifests,
    )

    assert summary["required_case_count"] == 2
    assert summary["covered_case_count"] == 1
    assert summary["completed_pair_case_count"] == 1
    demag_case = next(
        case
        for case in summary["case_coverage"]
        if case["case_id"] == "box500_airbox_exchange_demag"
    )
    assert demag_case["status"] == "fail"
    assert demag_case["row_count"] == 0
    assert demag_case["pair_count"] == 0
    assert any(
        "required case_id=box500_airbox_exchange_demag produced no benchmark rows"
        in failure
        for failure in summary["failures"]
    )


def test_cpu_gpu_consistency_summary_reports_required_case_without_completed_gpu():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_e_demag_j": 0.0,
            "final_e_ext_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "failed",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "error_kind": "cuda_driver_runtime_mismatch",
        },
    ]
    manifests = bench.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_demag"],
        steps=2,
        dt=1e-13,
        energy_rtol=1e-6,
        energy_atol=1e-30,
        torque_rtol=1e-6,
        torque_atol_apm=1e-9,
        torque_atol_t=1e-15,
        max_step_delta=0,
    )

    summary = bench.cpu_gpu_consistency_summary(
        rows,
        case_manifests=manifests,
    )

    assert summary["required_case_count"] == 1
    assert summary["covered_case_count"] == 1
    assert summary["completed_pair_case_count"] == 0
    assert summary["case_coverage"][0]["status"] == "fail"
    assert summary["case_coverage"][0]["gpu_ok_count"] == 0
    assert any(
        "required case_id=box500_airbox_exchange_demag has no completed fem_gpu row"
        in failure
        for failure in summary["failures"]
    )


def test_cpu_gpu_consistency_summary_keeps_unpaired_case_timing_evidence():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_zeeman",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": -1.0,
            "final_e_ex_j": 0.0,
            "final_e_ext_j": -1.0,
            "final_torque_apm": 4.0,
            "final_torque_t": 5.0e-6,
            "wall_time_ms": 80.0,
            "step_wall_time_ms": 10.0,
            "rhs_wall_time_ms": 4.0,
            "exchange_wall_time_ms": 2.0,
            "extra_energy_wall_time_ms": 1.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "failed",
            "scenario": "box500_airbox_exchange_zeeman",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "error_kind": "cuda_driver_runtime_mismatch",
        },
    ]
    manifests = bench.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_zeeman"],
        steps=2,
        dt=1e-13,
        energy_rtol=1e-6,
        energy_atol=1e-30,
        torque_rtol=1e-6,
        torque_atol_apm=1e-9,
        torque_atol_t=1e-15,
        max_step_delta=0,
    )

    summary = bench.cpu_gpu_consistency_summary(
        rows,
        case_manifests=manifests,
    )

    case = summary["case_coverage"][0]
    assert case["cpu_average_timing_ms"]["wall_time_ms"] == 80.0
    assert case["cpu_average_timing_ms"]["step_wall_time_ms"] == 10.0
    assert case["cpu_average_timing_ms"]["rhs_wall_time_ms"] == 4.0
    assert case["cpu_average_timing_ms"]["exchange_wall_time_ms"] == 2.0
    assert case["cpu_average_timing_ms"]["extra_energy_wall_time_ms"] == 1.0
    assert case["gpu_average_timing_ms"] == {}
    assert case["cpu_observable_summary"]["executed_steps"] == 1.0
    assert case["cpu_observable_summary"]["final_torque_apm"] == 4.0


def test_write_cpu_gpu_consistency_summary_creates_json_artifact(tmp_path):
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 2,
            "final_e_total_j": 1.0,
            "final_e_ex_j": 1.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "wall_time_ms": 12.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 2,
            "final_e_total_j": 1.0,
            "final_e_ex_j": 1.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "wall_time_ms": 3.0,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]
    output_path = tmp_path / "nested" / "cpu_gpu_summary.json"

    manifest = bench.box500_airbox_exchange_manifest(
        steps=4,
        dt=1e-13,
        energy_rtol=1e-6,
        energy_atol=1e-30,
        torque_rtol=1e-6,
        torque_atol_apm=1e-9,
        torque_atol_t=1e-15,
        max_step_delta=0,
    )

    summary = bench.write_cpu_gpu_consistency_summary(
        rows,
        output_path,
        case_manifests=[manifest],
    )

    assert output_path.is_file()
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload == summary
    assert payload["pair_count"] == 1
    assert payload["case_manifests"] == [manifest]
    assert payload["pairs"][0]["wall_time_speedup_cpu_over_gpu"] == 4.0


def test_cpu_gpu_consistency_rejects_energy_torque_and_step_drift():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 2,
            "final_e_total_j": 1.0e-24,
            "final_e_ex_j": 1.0e-24,
            "final_torque_apm": 2.0e-6,
            "final_torque_t": 2.5132741228718344e-12,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 4,
            "reported_precision": "double",
            "executed_steps": 5,
            "final_e_total_j": 2.0e-24,
            "final_e_ex_j": 2.0e-24,
            "final_torque_apm": 8.0e-6,
            "final_torque_t": 1.0053096491487338e-11,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]

    failures = bench.cpu_gpu_consistency_failures(rows)

    assert any("final_e_total_j" in failure for failure in failures)
    assert any("final_torque_apm" in failure for failure in failures)
    assert any("executed_steps" in failure for failure in failures)


def test_cpu_gpu_consistency_rejects_gpu_request_that_resolves_to_cpu():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
    ]

    failures = bench.cpu_gpu_consistency_failures(rows)

    assert any("fem_gpu resolved execution" in failure for failure in failures)


def test_cpu_gpu_consistency_rejects_gpu_strict_residency_counter_drift():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "exchange_only_box500_airbox1um",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 0.0,
            "final_e_ex_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
            "fem_data_residency": "device_source_of_truth",
            "hot_loop_compute_h2d_bytes": 16,
            "hot_loop_compute_d2h_bytes": 0,
            "hot_loop_compute_host_sync_count": 0,
        },
    ]

    summary = bench.cpu_gpu_consistency_summary(
        rows,
        require_gpu_strict_residency=True,
    )

    assert summary["status"] == "fail"
    assert any("hot_loop_compute_h2d_bytes" in failure for failure in summary["failures"])


def test_gpu_control_readback_budget_allows_current_direct_minimizer_contract():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "projected_gradient_bb",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "executed_steps": 2,
            "rejected_attempts": "",
            "hot_loop_control_scalar_host_sync_count": 8,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "nonlinear_cg",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "executed_steps": 2,
            "rejected_attempts": "",
            "hot_loop_control_scalar_host_sync_count": 8,
        },
    ]

    failures = bench.gpu_control_readback_budget_failures(
        rows,
        base=2,
        per_step=4,
        llg_per_step=0,
        pgbb_per_step=3,
        ncg_per_step=3,
        per_rejected_attempt=2,
    )

    assert failures == []


def test_gpu_control_readback_budget_rejects_algorithm_specific_counter_growth():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "nonlinear_cg",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "executed_steps": 2,
            "rejected_attempts": "",
            "hot_loop_control_scalar_host_sync_count": 9,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "projected_gradient_bb",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "executed_steps": 2,
            "rejected_attempts": "",
            "hot_loop_control_scalar_host_sync_count": 9,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "llg_overdamped",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "executed_steps": 2,
            "rejected_attempts": "",
            "hot_loop_control_scalar_host_sync_count": 1,
        },
    ]

    failures = bench.gpu_control_readback_budget_failures(
        rows,
        base=2,
        per_step=4,
        llg_per_step=0,
        pgbb_per_step=3,
        ncg_per_step=3,
        per_rejected_attempt=2,
    )

    assert len(failures) == 3
    assert any("hot_loop_control_scalar_host_sync_count=9 > 8" in failure for failure in failures)
    assert any("hot_loop_control_scalar_host_sync_count=9 > 8" in failure for failure in failures)
    assert any("hot_loop_control_scalar_host_sync_count=1 > 0" in failure for failure in failures)


def test_gpu_phase_timing_failures_require_positive_executed_llg_phase_timings():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "llg_overdamped",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "executed_steps": 2,
            "uses_gpu_poisson": "True",
            "exchange_wall_time_ms": 0.0,
            "rhs_wall_time_ms": 0.0,
            "demag_wall_time_ms": 0.0,
        },
    ]

    failures = bench.gpu_phase_timing_failures(rows)

    assert len(failures) == 3
    assert any("exchange_wall_time_ms" in failure for failure in failures)
    assert any("rhs_wall_time_ms" in failure for failure in failures)
    assert any("demag_wall_time_ms" in failure for failure in failures)


def test_gpu_phase_timing_failures_allow_direct_minimizer_without_rhs_timing():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "nonlinear_cg",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "executed_steps": 2,
            "uses_gpu_poisson": True,
            "exchange_wall_time_ms": 0.15,
            "rhs_wall_time_ms": 0.0,
            "demag_wall_time_ms": 9.5,
        },
    ]

    assert bench.gpu_phase_timing_failures(rows) == []


def test_min_solver_node_failures_reject_completed_tiny_solver_mesh():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "llg_overdamped",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "node_count": 8,
        },
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "llg_overdamped",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "node_count": 64,
        },
    ]

    failures = bench.min_solver_node_failures(rows, min_nodes=50)

    assert len(failures) == 1
    assert "node_count=8" in failures[0]
    assert "required minimum 50" in failures[0]


def test_cpu_gpu_consistency_rejects_scenario_specific_energy_drift():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 3.0e-24,
            "final_e_ex_j": 1.0e-24,
            "final_e_demag_j": 2.0e-24,
            "final_e_ext_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 3.0e-24,
            "final_e_ex_j": 1.0e-24,
            "final_e_demag_j": 2.5e-24,
            "final_e_ext_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]

    failures = bench.cpu_gpu_consistency_failures(rows)

    assert any("final_e_demag_j" in failure for failure in failures)


def test_cpu_gpu_consistency_accepts_full_relaxation_stt_oersted_rk_drift_with_full_profile():
    bench = load_analysis_benchmark_module()
    rows = []
    for integrator in ("rk23", "rk4"):
        base = {
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_stt_oersted",
            "integrator": integrator,
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 1000,
            "reported_precision": "double",
            "executed_steps": 1000,
        }
        rows.append(
            {
                **base,
                "backend": "fem_cpu",
                "final_e_total_j": -6.760041e-18,
                "final_e_ex_j": 2.077427e-22,
                "final_e_ext_j": -6.760249e-18,
                "final_torque_apm": 38035.31061470528,
                "final_torque_t": 0.0477965809616656,
                "execution_engine": "fem_cpu_native",
                "fem_execution_mode": "cpu_native",
                "mfem_device": "cpu",
                "uses_cuda_kernels": False,
            }
        )
        rows.append(
            {
                **base,
                "backend": "fem_gpu",
                "final_e_total_j": -6.760155e-18,
                "final_e_ex_j": 2.083723e-22,
                "final_e_ext_j": -6.760363e-18,
                "final_torque_apm": 38034.46909469041,
                "final_torque_t": 0.04779552347642697,
                "execution_engine": "fem_native_gpu",
                "fem_execution_mode": "all_in_gpu_legacy_sparse",
                "mfem_device": "cuda",
                "uses_cuda_kernels": True,
            }
        )

    strict_failures = bench.cpu_gpu_consistency_failures(rows)
    full_profile_failures = bench.cpu_gpu_consistency_failures(
        rows,
        energy_rtol=5e-5,
        energy_atol=1e-24,
        torque_rtol=5e-5,
    )

    assert any("final_torque_t" in failure for failure in strict_failures)
    assert full_profile_failures == []


def test_cpu_gpu_consistency_summary_reports_interaction_energy_deltas():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 3.0,
            "final_e_ex_j": 1.0,
            "final_e_demag_j": 2.0,
            "final_e_ext_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 3.5,
            "final_e_ex_j": 1.0,
            "final_e_demag_j": 2.5,
            "final_e_ext_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]

    summary = bench.cpu_gpu_consistency_summary(rows)

    assert summary["pairs"][0]["final_e_demag_j_abs_diff"] == 0.5
    assert summary["pairs"][0]["final_e_ext_j_abs_diff"] == 0.0


def test_cpu_gpu_consistency_summary_marks_mismatched_case_coverage_failed():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_cpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 3.0,
            "final_e_ex_j": 1.0,
            "final_e_demag_j": 2.0,
            "final_e_ext_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "uses_cuda_kernels": False,
        },
        {
            "backend": "fem_gpu",
            "status": "ok",
            "solver_mesh_signature": "mesh-a",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "timestep_policy": "fixed",
            "dt_s": 1e-13,
            "steps": 2,
            "reported_precision": "double",
            "executed_steps": 1,
            "final_e_total_j": 3.5,
            "final_e_ex_j": 1.0,
            "final_e_demag_j": 2.5,
            "final_e_ext_j": 0.0,
            "final_torque_apm": 0.0,
            "final_torque_t": 0.0,
            "execution_engine": "fem_native_gpu",
            "fem_execution_mode": "all_in_gpu_legacy_sparse",
            "mfem_device": "cuda",
            "uses_cuda_kernels": True,
        },
    ]

    summary = bench.cpu_gpu_consistency_summary(
        rows,
        case_manifests=[
            {
                "case_id": "box500_airbox_exchange_demag",
            }
        ],
    )

    coverage = summary["case_coverage"][0]
    assert coverage["status"] == "fail"
    assert coverage["pair_count"] == 1
    assert any("final_e_demag_j mismatch" in failure for failure in coverage["failures"])


def test_run_backend_maps_final_external_energy_from_payload(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=(
                'BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13, '
                '"final_e_ext_j": -4.2e-24}\n'
            ),
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="box500_airbox_exchange_zeeman",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["final_e_ext_j"] == -4.2e-24


def test_fem_cpu_no_pbc_adaptive_readiness_requires_scope_and_runtime_evidence():
    bench = load_analysis_benchmark_module()
    incomplete_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_recover_wall_time_ms": 1.0,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [incomplete_row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("periodic_boundary_pair_count" in failure for failure in failures)
    assert any("final_e_ex_j" in failure for failure in failures)
    assert any("final_e_demag_j" in failure for failure in failures)
    assert any("demag_solver_setup_wall_time_ms" in failure for failure in failures)
    assert any("demag_energy_wall_time_ms" in failure for failure in failures)
    assert any("demag_solver_setup_reused" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_accepts_complete_row():
    bench = load_analysis_benchmark_module()
    complete_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ex_j": -2e-18,
        "final_e_demag_j": 3e-18,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [complete_row],
        max_residual=1e-8,
        max_iterations=10,
    ) == []


def test_fem_cpu_no_pbc_adaptive_readiness_accepts_phase10_anisotropy_names():
    bench = load_analysis_benchmark_module()
    for scenario in ("exchange_demag_anis_uniaxial", "exchange_demag_anis_cubic"):
        complete_row = {
            "backend": "fem_cpu",
            "mesh_path": "medium",
            "scenario": scenario,
            "integrator": "rk23",
            "timestep_policy": "adaptive",
            "dt_s": 1e-13,
            "steps": 2,
            "status": "ok",
            "reported_precision": "double",
            "reported_scenario": scenario,
            "reported_integrator": "rk23",
            "reported_timestep_policy": "adaptive",
            "execution_engine": "fem_cpu_native",
            "fem_execution_mode": "cpu_native",
            "mfem_device": "cpu",
            "fem_data_residency": "host_source_of_truth",
            "uses_cuda_kernels": False,
            "uses_gpu_poisson": False,
            "demag_model": "airbox",
            "demag_boundary_variant": "robin",
            "domain_mesh_mode": "shared_domain_mesh_with_air",
            "solver_mesh_has_air": True,
            "periodic_boundary_pair_count": 0,
            "periodic_node_pair_count": 0,
            "executed_steps": 2,
            "final_solver_dt_s": 8e-14,
            "error_estimate": 0.5,
            "dt_suggested_s": 9e-14,
            "demag_solves": 6,
            "rhs_evals": 6,
            "final_e_ex_j": -2e-18,
            "final_e_demag_j": 3e-18,
            "final_e_ani_j": -1e-19,
            "demag_final_residual_norm": 5e-9,
            "demag_actual_iterations": 8,
            "demag_assemble_wall_time_ms": 2.0,
            "demag_solve_wall_time_ms": 5.0,
            "demag_solver_setup_wall_time_ms": 3.0,
            "demag_solver_apply_wall_time_ms": 4.0,
            "demag_solver_setup_reused": True,
            "demag_recover_wall_time_ms": 1.0,
            "demag_energy_wall_time_ms": 0.5,
        }

        assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
            [complete_row],
            max_residual=1e-8,
            max_iterations=10,
        ) == []


def test_fem_cpu_no_pbc_adaptive_readiness_requires_requested_matrix_coverage():
    bench = load_analysis_benchmark_module()
    only_one_case = {
        "backend": "fem_cpu",
        "mesh_path": "medium",
        "scenario": "exchange_demag_anis_uniaxial",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "requested_cpu_thread_spec": "1",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "reported_scenario": "exchange_demag_anis_uniaxial",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [only_one_case],
        max_residual=1e-8,
        max_iterations=10,
        required_mesh_paths={"medium", "coarse"},
        required_scenarios={"exchange_demag_anis_uniaxial", "exchange_demag_anis_cubic"},
        required_integrators={"rk23", "rk45"},
        required_thread_specs={"1", "auto"},
    )

    assert any(
        "mesh_path=coarse scenario=exchange_demag_anis_uniaxial integrator=rk23 thread_count=1"
        in failure
        for failure in failures
    )
    assert any(
        "mesh_path=medium scenario=exchange_demag_anis_cubic integrator=rk23 thread_count=1"
        in failure
        for failure in failures
    )
    assert any(
        "mesh_path=medium scenario=exchange_demag_anis_uniaxial integrator=rk45 thread_count=1"
        in failure
        for failure in failures
    )
    assert any(
        "mesh_path=medium scenario=exchange_demag_anis_uniaxial integrator=rk23 thread_count=auto"
        in failure
        for failure in failures
    )


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_gpu_runtime_provenance():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "execution_engine": "fem_native_gpu",
        "fem_execution_mode": "hybrid_legacy_sparse",
        "mfem_device": "cuda",
        "fem_data_residency": "device_source_of_truth",
        "uses_cuda_kernels": True,
        "uses_gpu_poisson": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("execution_engine" in failure for failure in failures)
    assert any("fem_execution_mode" in failure for failure in failures)
    assert any("mfem_device" in failure for failure in failures)
    assert any("fem_data_residency" in failure for failure in failures)
    assert any("uses_cuda_kernels" in failure for failure in failures)
    assert any("uses_gpu_poisson" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_reported_case_mismatch():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag",
        "reported_integrator": "heun",
        "reported_timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("reported_scenario" in failure for failure in failures)
    assert any("reported_integrator" in failure for failure in failures)
    assert any("reported_timestep_policy" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_non_robin_or_no_air_mesh():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "bem",
        "demag_boundary_variant": "dirichlet",
        "domain_mesh_mode": "merged_magnetic_mesh",
        "solver_mesh_has_air": False,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("demag_model" in failure for failure in failures)
    assert any("demag_boundary_variant" in failure for failure in failures)
    assert any("domain_mesh_mode" in failure for failure in failures)
    assert any("solver_mesh_has_air" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_short_completed_run():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 1,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("executed_steps" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_requires_minimum_steps_or_torque_stop():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anis_uniaxial",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anis_uniaxial",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 50,
        "status": "ok",
        "reported_precision": "double",
        "execution_engine": "fem_cpu_native",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 50,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 150,
        "rhs_evals": 150,
        "final_e_ex_j": -2e-18,
        "final_e_demag_j": 3e-18,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
        min_qualified_steps=100,
    )

    assert any("minimum qualified steps=100" in failure for failure in failures)
    assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [{**row, "stop_reason": "torque"}],
        max_residual=1e-8,
        max_iterations=10,
        min_qualified_steps=100,
    ) == []


def test_fem_cpu_no_pbc_adaptive_readiness_requires_warm_solver_reuse_after_first_step():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 6,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": False,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("demag_solver_setup_reused" in failure for failure in failures)


def test_fem_cpu_no_pbc_adaptive_readiness_rejects_frozen_demag_refresh():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "reported_scenario": "exchange_demag_anisotropy",
        "reported_integrator": "rk23",
        "reported_timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "status": "ok",
        "reported_precision": "double",
        "fem_execution_mode": "cpu_native",
        "mfem_device": "cpu",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
        "demag_refresh_interval_s": 1e-12,
        "demag_model": "airbox",
        "demag_boundary_variant": "robin",
        "domain_mesh_mode": "shared_domain_mesh_with_air",
        "solver_mesh_has_air": True,
        "periodic_boundary_pair_count": 0,
        "periodic_node_pair_count": 0,
        "executed_steps": 2,
        "final_solver_dt_s": 8e-14,
        "error_estimate": 0.5,
        "dt_suggested_s": 9e-14,
        "demag_solves": 1,
        "rhs_evals": 6,
        "final_e_ani_j": -1e-19,
        "demag_final_residual_norm": 5e-9,
        "demag_actual_iterations": 8,
        "demag_assemble_wall_time_ms": 2.0,
        "demag_solve_wall_time_ms": 5.0,
        "demag_solver_setup_wall_time_ms": 3.0,
        "demag_solver_apply_wall_time_ms": 4.0,
        "demag_solver_setup_reused": True,
        "demag_recover_wall_time_ms": 1.0,
        "demag_energy_wall_time_ms": 0.5,
    }

    failures = bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    )

    assert any("demag_refresh_interval_s" in failure for failure in failures)


def test_run_backend_maps_benchmark_e_ani_to_readiness_energy(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny_no_pbc",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
                "periodic_boundary_pairs": [],
                "periodic_node_pairs": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_plan": {
                        "backend_plan": {
                            "kind": "fem",
                            "mesh": {
                                "mesh_name": "shared_domain",
                                "nodes": [[0, 0, 0], [1, 0, 0]],
                                "elements": [[0, 1, 1, 1], [1, 0, 0, 0]],
                                "element_markers": [0, 1],
                                "boundary_faces": [],
                                "periodic_boundary_pairs": [],
                                "periodic_node_pairs": [],
                                "domain_mesh_mode": "shared_domain_mesh_with_air",
                            },
                        },
                    },
                    "execution_provenance": {
                        "execution_engine": "fem_cpu_native",
                        "fem_execution_mode": "cpu_native",
                        "mfem_device": "cpu",
                        "fem_data_residency": "host_source_of_truth",
                        "uses_cuda_kernels": False,
                        "uses_gpu_poisson": False,
                    },
                    "demag_runtime": {
                        "model": "airbox",
                        "boundary_variant": "robin",
                        "actual_iterations": 8,
                        "final_residual_norm": 5e-9,
                    },
                    "fem_cpu_relaxation_qualification": {
                        "stop_reason": "max_steps",
                        "final_torque_apm": 4e-4,
                        "final_torque_t": 5e-10,
                        "norm_defect": 1e-12,
                    },
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=json.dumps(
                {
                    "status": "completed",
                    "precision": "double",
                    "executed_steps": 2,
                    "final_time_s": 2e-13,
                    "final_solver_dt_s": 8e-14,
                    "error_estimate": 0.5,
                    "dt_suggested_s": 9e-14,
                    "demag_solves": 6,
                    "rhs_evals": 6,
                    "final_e_ex_j": -2e-18,
                    "final_e_demag_j": 3e-18,
                    "e_ani": -1e-19,
                    "demag_assemble_wall_time_ns": 2_000_000,
                    "demag_solve_wall_time_ns": 5_000_000,
                    "demag_solver_setup_wall_time_ns": 3_000_000,
                    "demag_solver_apply_wall_time_ns": 4_000_000,
                    "demag_solver_setup_reused": True,
                    "demag_recover_wall_time_ns": 1_000_000,
                    "demag_energy_wall_time_ns": 500_000,
                },
                sort_keys=True,
            ).join(("BENCHMARK_RESULT=", "\n")),
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        steps=2,
        dt=1e-13,
        timestep_policy="adaptive",
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["final_e_ani_j"] == -1e-19
    assert row["final_e_ex_j"] == -2e-18
    assert row["final_e_demag_j"] == 3e-18
    assert row["execution_engine"] == "fem_cpu_native"
    assert row["stop_reason"] == "max_steps"
    assert row["final_torque_apm"] == 4e-4
    assert row["final_torque_t"] == 5e-10
    assert row["norm_defect"] == 1e-12
    assert bench.fem_cpu_no_pbc_adaptive_readiness_failures(
        [row],
        max_residual=1e-8,
        max_iterations=10,
    ) == []


def test_run_backend_classifies_mpi_pmix_startup_failures(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny_no_pbc",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr="MPI_Init_thread failed: PMIx socket is unavailable",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        steps=1,
        dt=1e-13,
        timestep_policy="adaptive",
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["status"] == "failed"
    assert row["error_kind"] == "mpi_init_or_pmix_startup"


def test_run_backend_classifies_missing_python_dependency(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny_no_pbc",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr="ModuleNotFoundError: No module named 'h5py'",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag_anisotropy",
        integrator="rk23",
        steps=1,
        dt=1e-13,
        timestep_policy="adaptive",
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["status"] == "failed"
    assert row["error_kind"] == "missing_python_dependency"


def test_run_backend_classifies_cuda_driver_runtime_mismatch(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny_no_pbc",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr=(
                "native FEM GPU backend is unavailable: cudaGetDeviceCount failed "
                "for fullmag_fem: CUDA driver version is insufficient for CUDA runtime version"
            ),
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only_box500_airbox1um",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert row["status"] == "failed"
    assert row["error_kind"] == "cuda_driver_runtime_mismatch"


def test_best_demag_policy_rows_selects_fastest_converged_policy():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "solver_mesh_signature": "mesh-a",
        "requested_demag_relative_tolerance": "1e-6",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "100",
        "requested_demag_print_level": "0",
        "status": "ok",
    }

    summaries = bench.best_demag_policy_rows(
        [
            {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "AMG",
                "demag_solver_apply_wall_time_ms": 7.0,
                "demag_final_residual_norm": 5e-7,
                "demag_actual_iterations": 9,
            },
            {
                **base_row,
                "requested_demag_solver": "GMRES",
                "requested_demag_preconditioner": "JACOBI",
                "demag_solver_apply_wall_time_ms": 4.0,
                "demag_final_residual_norm": 8e-7,
                "demag_actual_iterations": 12,
            },
            {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "NONE",
                "demag_solver_apply_wall_time_ms": 1.0,
                "demag_final_residual_norm": 2e-5,
                "demag_actual_iterations": 3,
            },
        ],
        max_residual=1e-6,
        max_iterations=20,
    )

    assert len(summaries) == 1
    assert summaries[0]["demag_solver"] == "GMRES"
    assert summaries[0]["demag_preconditioner"] == "JACOBI"
    assert summaries[0]["selection_timing_field"] == "demag_solver_apply_wall_time_ms"
    assert summaries[0]["average_demag_timing_ms"] == 4.0
    assert summaries[0]["average_demag_wall_time_ms"] is None
    assert summaries[0]["average_demag_solver_apply_wall_time_ms"] == 4.0
    assert summaries[0]["converged_policy_count"] == 2


def test_best_demag_policy_rows_selects_full_demag_wall_time_before_apply_time():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "coarse",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 2,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": "1e-8",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "status": "ok",
        "demag_final_residual_norm": 8e-9,
        "demag_actual_iterations": 12,
    }

    summaries = bench.best_demag_policy_rows(
        [
            {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "AMG",
                "demag_wall_time_ms": 90.0,
                "demag_solver_apply_wall_time_ms": 10.0,
            },
            {
                **base_row,
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "JACOBI",
                "demag_wall_time_ms": 40.0,
                "demag_solver_apply_wall_time_ms": 25.0,
            },
        ],
        max_residual=1e-8,
        max_iterations=100,
    )

    assert len(summaries) == 1
    assert summaries[0]["demag_solver"] == "CG"
    assert summaries[0]["demag_preconditioner"] == "JACOBI"
    assert summaries[0]["selection_timing_field"] == "demag_wall_time_ms"
    assert summaries[0]["average_demag_timing_ms"] == 40.0
    assert summaries[0]["average_demag_wall_time_ms"] == 40.0
    assert summaries[0]["average_demag_solver_apply_wall_time_ms"] == 25.0


def test_best_demag_policy_selection_ignores_policy_specific_mesh_signature():
    bench = load_analysis_benchmark_module()
    base_row = {
        "backend": "fem_gpu",
        "mesh_path": "coarse",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 5,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": "1e-8",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "status": "ok",
    }

    summaries = bench.best_demag_policy_rows(
        [
            {
                **base_row,
                "solver_mesh_signature": "signature-for-amg-policy",
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "AMG",
                "demag_solver_apply_wall_time_ms": 44.0,
                "demag_final_residual_norm": 8e-9,
                "demag_actual_iterations": 23,
            },
            {
                **base_row,
                "solver_mesh_signature": "signature-for-jacobi-policy",
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "JACOBI",
                "demag_solver_apply_wall_time_ms": 22.0,
                "demag_final_residual_norm": 9e-9,
                "demag_actual_iterations": 60,
            },
        ],
        max_residual=1e-8,
        max_iterations=100,
    )

    assert len(summaries) == 1
    assert summaries[0]["demag_solver"] == "CG"
    assert summaries[0]["demag_preconditioner"] == "JACOBI"
    assert summaries[0]["average_demag_timing_ms"] == 22.0


def test_best_demag_policy_failures_report_missing_converged_candidate():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "solver_mesh_signature": "mesh-a",
        "requested_demag_relative_tolerance": "1e-6",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "100",
        "requested_demag_print_level": "0",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "status": "ok",
        "demag_solver_apply_wall_time_ms": 7.0,
        "demag_final_residual_norm": 2e-5,
        "demag_actual_iterations": 9,
    }

    failures = bench.best_demag_policy_failures(
        [row],
        max_residual=1e-6,
        max_iterations=20,
    )

    assert len(failures) == 1
    assert "no converged demag policy" in failures[0]
    assert "exchange_demag_anisotropy" in failures[0]


def test_best_demag_policy_failures_require_policy_comparison():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_gpu",
        "mesh_path": "coarse",
        "scenario": "box500_airbox_exchange_demag",
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1e-13,
        "steps": 3,
        "requested_cpu_thread_spec": "auto",
        "requested_demag_relative_tolerance": "1e-8",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "500",
        "requested_demag_print_level": "0",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "JACOBI",
        "status": "ok",
        "demag_solver_apply_wall_time_ms": 23.0,
        "demag_final_residual_norm": 9e-9,
        "demag_actual_iterations": 12,
    }

    failures = bench.best_demag_policy_failures(
        [row],
        max_residual=1e-8,
        max_iterations=500,
    )

    assert len(failures) == 1
    assert "has 1 converged demag policy" in failures[0]
    assert "at least 2 are required" in failures[0]


def test_best_demag_policy_failures_include_runtime_error_kind():
    bench = load_analysis_benchmark_module()
    row = {
        "backend": "fem_cpu",
        "mesh_path": "coarse",
        "scenario": "exchange_demag_anisotropy",
        "integrator": "rk23",
        "timestep_policy": "adaptive",
        "dt_s": 1e-13,
        "steps": 2,
        "solver_mesh_signature": "mesh-a",
        "requested_demag_relative_tolerance": "1e-6",
        "requested_demag_absolute_tolerance": "",
        "requested_demag_max_iterations": "100",
        "requested_demag_print_level": "0",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "status": "failed",
        "error_kind": "mpi_init_or_pmix_startup",
    }

    failures = bench.best_demag_policy_failures(
        [row],
        max_residual=1e-6,
        max_iterations=20,
    )

    assert len(failures) == 1
    assert "mpi_init_or_pmix_startup" in failures[0]


def test_run_backend_loads_metadata_from_cli_artifact_dir(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "input_magnetic_mesh",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    (artifact_dir / "metadata.json").write_text(
        json.dumps(
            {
                "execution_plan": {
                    "backend_plan": {
                        "kind": "fem",
                        "mesh_name": "study_domain",
                        "mesh": {
                            "nodes": [[0, 0, 0], [1, 0, 0]],
                            "elements": [[0, 1, 1, 1]],
                            "boundary_faces": [[0, 1, 1]],
                        },
                    }
                },
                "demag_runtime": {
                    "linear_solver": "CG",
                    "preconditioner": "AMG",
                    "relative_tolerance": 1e-6,
                    "absolute_tolerance": 1e-12,
                    "max_iterations": 75,
                    "print_level": 2,
                    "timings_ns": {
                        "assemble": 3_000_000,
                        "solve": 5_000_000,
                        "solver_setup": 13_000_000,
                        "solver_apply": 17_000_000,
                        "recover": 7_000_000,
                        "energy": 11_000_000,
                    },
                    "solver_setup_reused": True,
                },
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=f"""
fullmag workspace summary
- status: completed
- total_steps: 1
- final_time: 1.000000e-13 s
- artifact_dir: {artifact_dir}
""",
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["mesh_name"] == "study_domain"
    assert row["node_count"] == 2
    assert row["demag_assemble_wall_time_ms"] == 3.0
    assert row["demag_solve_wall_time_ms"] == 5.0
    assert row["demag_solver_setup_wall_time_ms"] == 13.0
    assert row["demag_solver_apply_wall_time_ms"] == 17.0
    assert row["demag_solver_setup_reused"] is True
    assert row["demag_recover_wall_time_ms"] == 7.0
    assert row["demag_energy_wall_time_ms"] == 11.0
    assert row["demag_linear_solver"] == "CG"
    assert row["demag_preconditioner"] == "AMG"
    assert row["demag_relative_tolerance"] == 1e-6
    assert row["demag_absolute_tolerance"] == 1e-12
    assert row["demag_max_iterations"] == 75
    assert row["demag_print_level"] == 2


def test_run_backend_accepts_null_demag_runtime_for_non_demag_scenarios(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "input_magnetic_mesh",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {"fem_assembly_mode": "legacy_sparse"},
                    "demag_runtime": None,
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_cpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_dmi",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_EXECUTION": "cpu"},
    )

    assert row["status"] == "ok"
    assert row["fem_assembly_mode"] == "legacy_sparse"


def test_parse_cli_workspace_summary_as_benchmark_payload():
    bench = load_analysis_benchmark_module()
    output = """
fullmag workspace summary
- status: completed
- total_steps: 2
- final_time: 2.000000e-13 s
- final_E_ex: -5.115751e-35 J
- final_E_demag: 0.000000e0 J
- final_E_ext: 0.000000e0 J
- final_E_ani: 1.250000e-24 J
- final_E_dmi: -3.500000e-24 J
- final_E_total: -5.115751e-35 J
"""

    payload = bench.parse_benchmark_result(output)

    assert payload["status"] == "completed"
    assert payload["executed_steps"] == 2
    assert payload["final_time_s"] == 2.0e-13
    assert payload["final_e_total_j"] == -5.115751e-35
    assert payload["final_e_ani_j"] == 1.25e-24
    assert payload["final_e_dmi_j"] == -3.5e-24


def test_parse_cli_json_summary_as_benchmark_payload():
    bench = load_analysis_benchmark_module()
    output = """
fullmag diagnostic line
{
  "status": "completed",
  "session_id": "session-test",
  "total_steps": 2,
  "final_time": 2e-13,
  "final_e_total": -1e-30,
  "wall_time_ns": 3000000,
  "exchange_wall_time_ns": 1000000,
  "rhs_wall_time_ns": 2000000
}
warning: stderr line after json
"""

    payload = bench.parse_benchmark_result(output)

    assert payload["status"] == "completed"
    assert payload["total_steps"] == 2
    assert payload["executed_steps"] == 2
    assert payload["final_time_s"] == 2.0e-13
    assert payload["final_e_total_j"] == -1.0e-30
    assert payload["exchange_wall_time_ns"] == 1_000_000
    assert payload["rhs_wall_time_ns"] == 2_000_000


def test_cli_workspace_summary_prints_local_energy_terms():
    source = (REPO_ROOT / "crates" / "fullmag-cli" / "src" / "orchestrator.rs").read_text(
        encoding="utf-8"
    )
    function_start = source.index("fn print_script_summary(")
    function_end = source.index("fn refresh_problem_preview_state(", function_start)
    function_source = source[function_start:function_end]

    assert "final_E_ani" in function_source
    assert "final_E_dmi" in function_source


def test_run_backend_carries_gpu_state_provenance(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "fem_gpu_state_allocated": True,
                        "fem_gpu_state_node_count": 8,
                        "fem_gpu_state_dof_len": 24,
                        "fem_gpu_state_stage_count": 2,
                        "fem_gpu_state_device_bytes": 32768,
                        "fem_gpu_state_reduction_workspace_bytes": 512,
                        "hot_loop_exchange_host_sync_count": 2,
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_exchange_only_enabled": False,
                        "fem_gpu_qualification_status": "source_visible",
                        "fem_gpu_rk_stage_count": 2,
                        "fem_gpu_rk_uses_cuda_kernels": False,
                        "fem_gpu_rk_allows_exchange_host_sync": False,
                        "fem_gpu_rk_stage_exchange_device_resident": False,
                        "fem_exchange_operator_mode": "unsupported",
                        "fem_gpu_rk_block_reason": "requires CUDA",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["fem_gpu_state_allocated"] is True
    assert row["fem_gpu_state_node_count"] == 8
    assert row["fem_gpu_state_dof_len"] == 24
    assert row["fem_gpu_state_stage_count"] == 2
    assert row["fem_gpu_state_device_bytes"] == 32768
    assert row["fem_gpu_state_reduction_workspace_bytes"] == 512
    assert row["hot_loop_exchange_host_sync_count"] == 2
    assert row["hot_loop_compute_host_sync_count"] == 0
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=0;stage_exchange_device_resident=false;"
        "gpu_rk_block_reason=requires CUDA"
    )
    assert row["fem_gpu_rk_exchange_only_enabled"] is False
    assert row["fem_gpu_qualification_status"] == "source_visible"
    assert row["fem_gpu_rk_stage_count"] == 2
    assert row["fem_gpu_rk_uses_cuda_kernels"] is False
    assert row["fem_gpu_rk_allows_exchange_host_sync"] is False
    assert row["fem_gpu_rk_stage_exchange_device_resident"] is False
    assert row["fem_exchange_operator_mode"] == "unsupported"
    assert row["fem_gpu_rk_block_reason"] == "requires CUDA"
    assert row["adaptive_gpu_rk_acceptance_ready"] is False
    assert "nvcc" in row["adaptive_gpu_rk_acceptance_blockers"]


def test_run_backend_serializes_adaptive_gpu_rk_acceptance_gate(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps({"execution_provenance": {"hot_loop_compute_host_sync_count": 0}}),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="rk45",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["adaptive_gpu_rk_acceptance_ready"] is False
    assert isinstance(row["adaptive_gpu_rk_acceptance_blockers"], str)
    assert "nvcc" in row["adaptive_gpu_rk_acceptance_blockers"]
    assert row["adaptive_gpu_rk_hot_loop_scalar_readback_free"] is True
    assert row["adaptive_gpu_rk_hot_loop_compute_readback_free"] is True
    assert row["adaptive_gpu_rk_hot_loop_control_readback"] is True
    assert row["adaptive_gpu_rk_hot_loop_scalar_readback_path"].endswith(
        "backends/fem/gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu"
    )


def test_run_backend_flags_phase2_compute_hot_loop_sync_regression(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_exchange_host_sync_count": 1,
                        "hot_loop_compute_host_sync_count": 3,
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=3;stage_exchange_device_resident=false"
    )


def test_run_backend_preserves_gpu_rk_block_reason_when_compute_sync_is_missing(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "fem_gpu_rk_stage_exchange_device_resident": False,
                        "fem_gpu_rk_block_reason": "requires captured legacy sparse exchange metadata",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=missing;"
        "gpu_rk_block_reason=requires captured legacy sparse exchange metadata"
    )


def test_run_backend_marks_failed_gpu_run_without_phase2_provenance(monkeypatch, tmp_path):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=1,
            stdout="",
            stderr="native FEM GPU backend is not available",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["status"] == "failed"
    assert "native FEM GPU backend is not available" in row["error"]
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "run_failed_before_phase2_provenance"


def test_truncate_error_preserves_tail_for_failed_acceptance_diagnostics():
    bench = load_analysis_benchmark_module()
    message = "prefix " + ("x" * 800) + " fallback_reason=all_in_gpu_contract_unmet"

    truncated = bench.truncate_error(message, limit=160)

    assert len(truncated) <= 160
    assert "prefix" in truncated
    assert "fallback_reason=all_in_gpu_contract_unmet" in truncated


def test_run_backend_passes_phase2_gate_only_when_stage_exchange_is_device_resident(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_stage_exchange_device_resident": True,
                        "fem_exchange_operator_mode": "legacy_sparse_gpu",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is True
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=0;stage_exchange_device_resident=true"
    )


def test_run_backend_passes_phase2_gate_for_strict_device_demag(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_stage_exchange_device_resident": True,
                        "fem_exchange_operator_mode": "legacy_sparse_gpu",
                        "fem_demag_operator_mode": "device_hypre_poisson",
                        "hypre_execution_policy": "device",
                        "demag_residency": "device",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["fem_demag_operator_mode"] == "device_hypre_poisson"
    assert row["hypre_execution_policy"] == "device"
    assert row["demag_residency"] == "device"
    assert row["phase2_compute_hot_loop_sync_clean"] is True
    assert (
        row["phase2_gate_reason"]
        == "compute_hot_loop_host_sync_count=0;stage_exchange_device_resident=true"
    )


def test_run_backend_rejects_phase2_gate_for_host_device_demag(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_stage_exchange_device_resident": True,
                        "fem_exchange_operator_mode": "legacy_sparse_gpu",
                        "fem_demag_operator_mode": "hybrid_cpu_poisson",
                        "hypre_execution_policy": "host",
                        "demag_residency": "host_device_roundtrip",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "demag_device_residency=hybrid_cpu_poisson/host/host_device_roundtrip"
    )


def test_run_backend_rejects_phase2_gate_when_exchange_operator_mode_is_unsupported(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_stage_exchange_device_resident": True,
                        "fem_exchange_operator_mode": "unsupported",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "exchange_operator_mode=unsupported"


def test_run_backend_flags_inconsistent_gpu_rk_enabled_without_device_stage_exchange(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                        "fem_gpu_rk_exchange_only_enabled": True,
                        "fem_gpu_rk_stage_exchange_device_resident": False,
                        "fem_gpu_rk_block_reason": "stage H_ex device-resident exchange requires CUDA runtime support",
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={},
    )

    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert (
        row["phase2_gate_reason"]
        == "runtime_contract_violation=exchange_only_enabled_without_stage_exchange_device_resident;"
        "gpu_rk_block_reason=stage H_ex device-resident exchange requires CUDA runtime support"
    )


def test_run_backend_does_not_pass_phase2_gate_when_assertion_is_disabled(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_run(cmd, cwd, env, capture_output, text, check):
        run_dir = Path(env["FULLMAG_RUN_DIR"])
        (run_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "execution_provenance": {
                        "hot_loop_compute_host_sync_count": 0,
                    }
                }
            ),
            encoding="utf-8",
        )
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 2, "final_time_s": 2e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=2,
        dt=1e-13,
        extra_env={"FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC": "0"},
    )

    assert row["phase2_compute_assertion_enabled"] is False
    assert row["phase2_compute_hot_loop_sync_clean"] is False
    assert row["phase2_gate_reason"] == "compute_hot_loop_assertion=disabled"


def test_run_backend_enables_phase2_compute_sync_assertion_for_gpu_exchange_only(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC"] == "1"
    assert row["phase2_compute_assertion_enabled"] is True


def test_run_backend_enables_phase2_compute_sync_assertion_for_gpu_demag(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="box500_airbox_exchange_demag",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC"] == "1"
    assert row["phase2_compute_assertion_enabled"] is True


def test_run_backend_phase2_compute_sync_assertion_overrides_inherited_env(
    monkeypatch, tmp_path
):
    bench = load_analysis_benchmark_module()
    binary = tmp_path / "fullmag-fem-gpu"
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    mesh_path = tmp_path / "mesh.mesh.json"
    mesh_path.write_text(
        json.dumps(
            {
                "mesh_name": "tiny",
                "nodes": [[0, 0, 0]],
                "elements": [],
                "boundary_faces": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC", "0")
    captured_env = {}

    def fake_run(cmd, cwd, env, capture_output, text, check):
        captured_env.update(env)
        return bench.subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout='BENCHMARK_RESULT={"executed_steps": 1, "final_time_s": 1e-13}\n',
            stderr="",
        )

    monkeypatch.setattr(bench.subprocess, "run", fake_run)

    row = bench.run_backend(
        backend_label="fem_gpu",
        binary=binary,
        mesh_path=mesh_path,
        scenario="exchange_only",
        integrator="heun",
        steps=1,
        dt=1e-13,
        extra_env={},
    )

    assert captured_env["FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC"] == "1"
    assert row["phase2_compute_assertion_enabled"] is True


def test_gpu_rk_cuda_source_contains_kernel_call_sites():
    assert GPU_RK_CU_PATH.is_file()
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    schedule_source = GPU_RK_STAGE_SCHEDULE_CU_PATH.read_text(encoding="utf-8")
    rhs_source = GPU_RK_RHS_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    llg_source = GPU_RK_LLG_RHS_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    assert "gpu_rk_compute_llg_rhs(ctx, m, rhs, stream, n, reason)" in rhs_source
    assert "fullmag_cuda_llg_rhs_fused(" in llg_source
    assert "fullmag_cuda_normalize_vectors(" in schedule_source
    assert "fullmag_cuda_accumulate_heff(" in effective_source
    assert "fullmag_cuda_device_max(" in refresh_source
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    assert "gpu/cuda/integrators/rk/rk_step.cu" in cmake


def test_gpu_rk_step_surface_has_no_hot_loop_aos_transfer_calls():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_device_resident_step(")
    function_end = source.index("\n} // namespace fullmag::fem", function_start)
    function_source = source[function_start:function_end]

    assert "upload_aos_to_soa(" not in function_source
    assert "download_soa_to_aos(" not in function_source
    assert "record_host_to_device(" not in function_source
    assert "record_device_to_host(" not in function_source


def test_gpu_rk_step_surface_has_no_compute_side_stream_synchronization():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_device_resident_step(")
    function_end = source.index("\n} // namespace fullmag::fem", function_start)
    function_source = source[function_start:function_end]
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    schedule_source = GPU_RK_STAGE_SCHEDULE_CU_PATH.read_text(encoding="utf-8")

    assert "cudaStreamSynchronize" not in function_source
    assert "cudaPeekAtLastError" not in function_source
    assert "gpu_rk_run_accepted_attempt_loop(" in function_source
    assert "gpu_rk_run_stage_attempt(" in attempt_loop_source
    assert "cuda_launch_ok(" in schedule_source


def test_gpu_rk_step_promotes_clean_device_copy_without_hot_loop_transfer():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_device_resident_step(")
    function_end = source.index("\n} // namespace fullmag::fem", function_start)
    function_source = source[function_start:function_end]

    assert "gpu_rk_prepare_step_preflight(" in function_source
    assert "FemGpuSyncState::DeviceClean" in preflight_source
    assert "FemGpuSyncState::HostClean" in preflight_source
    assert "FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH" in preflight_source
    assert "GPU RK device-resident step requires FemGpuState device source of truth" in preflight_source
    assert "FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH" not in function_source
    assert "gpu_state_upload_magnetization_aos(" not in function_source


def test_gpu_rk_uses_preallocated_device_reduction_workspace():
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    function_start = refresh_source.index("bool gpu_rk_finalize_accepted_step(")
    function_end = refresh_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = refresh_source[function_start:function_end]
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    reduction_workspace_header = GPU_REDUCTION_WORKSPACE_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    reduction_workspace_memory_source = (
        GPU_REDUCTION_WORKSPACE_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )

    assert "FemGpuReductionWorkspaceDeviceState reductions{}" in gpu_state_header
    assert "temp_storage" in reduction_workspace_header
    assert "temp_storage_bytes" in reduction_workspace_header
    assert "fullmag_cuda_device_max(" in reduction_workspace_memory_source
    assert "gpu_device_allocate_bytes(\n            &reductions.temp_storage" in reduction_workspace_memory_source
    assert "fullmag_cuda_device_max(" not in gpu_state_source
    assert "gpu.reductions.temp_storage" in function_source
    assert "gpu.reductions.temp_storage_bytes" in function_source
    assert "nullptr,\n        reduce_bytes" not in function_source


def test_gpu_state_allocates_batched_scalar_result_slots():
    reduction_workspace_header = GPU_REDUCTION_WORKSPACE_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    reduction_workspace_memory_source = (
        GPU_REDUCTION_WORKSPACE_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )

    assert "FEM_GPU_SCALAR_RESULT_SLOTS" in reduction_workspace_header
    assert (
        "gpu_device_allocate_double(reductions.scalar_result, FEM_GPU_SCALAR_RESULT_SLOTS"
        in reduction_workspace_memory_source
    )
    assert "reduce_blocks + FEM_GPU_SCALAR_RESULT_SLOTS" in reduction_workspace_memory_source


def test_gpu_state_uploads_effective_fields_outside_hot_loop():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    field_buffer_upload_source = GPU_FIELD_BUFFER_UPLOAD_CPP_PATH.read_text(
        encoding="utf-8"
    )
    context_source = GPU_STATE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")

    assert "gpu_state_upload_effective_fields_aos" in gpu_state_header
    assert "gpu_state_upload_effective_fields_aos" in gpu_state_source
    assert "gpu_field_buffers_upload_effective_fields_aos(" in gpu_state_source
    assert "fields.h_ex" in field_buffer_upload_source
    assert "fields.h_demag" in field_buffer_upload_source
    assert "fields.h_ext" in field_buffer_upload_source
    assert "fields.h_eff" in field_buffer_upload_source
    assert "gpu_state_upload_effective_fields_aos(" in context_source


def test_gpu_state_uploads_local_vector_fields_outside_hot_loop():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    field_buffer_upload_source = GPU_FIELD_BUFFER_UPLOAD_CPP_PATH.read_text(
        encoding="utf-8"
    )
    context_source = GPU_STATE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")

    assert "gpu_state_upload_local_vector_fields_aos" in gpu_state_header
    assert "gpu_state_upload_local_vector_fields_aos" in gpu_state_source
    assert "gpu_field_buffers_upload_local_vector_fields_aos(" in gpu_state_source
    for member in (
        "fields.h_ani",
        "fields.h_cubic_ani",
        "fields.h_dmi",
        "fields.h_bulk_dmi",
        "fields.h_oe",
        "fields.h_therm",
        "fields.h_mel",
    ):
        assert member in field_buffer_upload_source
    for context_member in (
        "ctx.anisotropy.h_uniaxial_xyz.data()",
        "ctx.anisotropy.h_cubic_xyz.data()",
        "ctx.dmi.h_interfacial_xyz.data()",
        "ctx.dmi.h_bulk_xyz.data()",
        "ctx.oersted.h_xyz.data()",
        "ctx.thermal_brown.h_xyz.data()",
        "ctx.magnetoelastic.h_xyz.data()",
    ):
        assert context_member in context_source


def test_gpu_field_buffers_are_owned_by_fields_module():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    field_buffer_header = GPU_FIELD_BUFFER_STATE_HPP_PATH.read_text(encoding="utf-8")
    field_buffer_memory_header = GPU_FIELD_BUFFER_MEMORY_HPP_PATH.read_text(
        encoding="utf-8"
    )
    field_buffer_memory_source = GPU_FIELD_BUFFER_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    field_buffer_upload_header = GPU_FIELD_BUFFER_UPLOAD_HPP_PATH.read_text(
        encoding="utf-8"
    )
    field_buffer_upload_source = GPU_FIELD_BUFFER_UPLOAD_CPP_PATH.read_text(
        encoding="utf-8"
    )
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    demag_stage_source = GPU_DEMAG_STAGE_COMPUTE_CPP_PATH.read_text(
        encoding="utf-8"
    )
    exchange_source = GPU_RK_EXCHANGE_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    llg_source = GPU_RK_LLG_RHS_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    oersted_source = GPU_RK_OERSTED_FIELD_CU_PATH.read_text(encoding="utf-8")

    assert "GPU CUDA field-buffer device-state module header" in field_buffer_header
    assert "struct FemGpuFieldBufferDeviceState" in field_buffer_header
    for field in (
        "h_ex",
        "h_demag",
        "h_ext",
        "h_ani",
        "h_cubic_ani",
        "h_dmi",
        "h_bulk_dmi",
        "h_oe",
        "h_therm",
        "h_mel",
        "h_eff",
    ):
        assert f"FemGpuComponentField {field}" in field_buffer_header
        assert f"fields.{field}" in field_buffer_memory_source
        assert f"fields.{field}" in field_buffer_upload_source
        assert f"gpu_device_allocate_component(state.fields.{field}" not in gpu_state_source
        assert f"gpu_device_free_component(state.fields.{field}" not in gpu_state_source
    assert "GPU CUDA field-buffer memory module header" in field_buffer_memory_header
    assert "GPU CUDA field-buffer memory source contract" in field_buffer_memory_source
    assert "bool gpu_field_buffers_allocate(" in field_buffer_memory_header
    assert "void gpu_field_buffers_free(" in field_buffer_memory_header
    assert "bool gpu_field_buffers_allocate(" in field_buffer_memory_source
    assert "void gpu_field_buffers_free(" in field_buffer_memory_source
    assert "gpu_field_buffers_allocate(" in gpu_state_source
    assert "gpu_field_buffers_free(" in gpu_state_source
    assert "gpu/cuda/fields/field_buffer_memory.cpp" in cmake
    assert "GPU CUDA field-buffer upload module header" in field_buffer_upload_header
    assert "GPU CUDA field-buffer upload source contract" in field_buffer_upload_source
    for helper in (
        "gpu_field_buffers_upload_effective_fields_aos(",
        "gpu_field_buffers_upload_demag_field_aos(",
        "gpu_field_buffers_upload_local_vector_fields_aos(",
    ):
        assert helper in field_buffer_upload_header
        assert helper in field_buffer_upload_source
        assert helper in gpu_state_source
    assert "gpu/cuda/fields/field_buffer_upload.cpp" in cmake
    assert '#include "gpu/cuda/fields/field_buffer_state.hpp"' in gpu_state_header
    assert "FemGpuFieldBufferDeviceState fields{}" in gpu_state_header
    for flat_member in (
        "FemGpuComponentField h_ex",
        "FemGpuComponentField h_demag",
        "FemGpuComponentField h_ext",
        "FemGpuComponentField h_ani",
        "FemGpuComponentField h_cubic_ani",
        "FemGpuComponentField h_dmi",
        "FemGpuComponentField h_bulk_dmi",
        "FemGpuComponentField h_oe",
        "FemGpuComponentField h_therm",
        "FemGpuComponentField h_mel",
        "FemGpuComponentField h_eff",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "state.fields",
        "gpu_field_buffers_allocate(",
        "gpu_field_buffers_free(",
        "gpu_field_buffers_upload_effective_fields_aos(",
        "gpu_field_buffers_upload_demag_field_aos(",
        "gpu_field_buffers_upload_local_vector_fields_aos(",
    ):
        assert state_member in gpu_state_source
    assert "gpu_component_upload_aos(\n            state.lifecycle, state.fields" not in gpu_state_source
    assert "gpu_component_upload_optional_aos(\n            state.lifecycle, state.fields" not in gpu_state_source
    for source in (effective_source, demag_stage_source, exchange_source, llg_source, oersted_source):
        assert "gpu.fields." in source
        assert "gpu.h_" not in source


def test_gpu_magnetization_state_is_owned_by_gpu_state_module():
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    magnetization_header = GPU_MAGNETIZATION_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_memory_header = GPU_MAGNETIZATION_MEMORY_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_memory_source = GPU_MAGNETIZATION_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_transfer_header = GPU_MAGNETIZATION_TRANSFER_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_transfer_source = GPU_MAGNETIZATION_TRANSFER_CPP_PATH.read_text(
        encoding="utf-8"
    )
    attempt_setup_source = GPU_RK_ATTEMPT_SETUP_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    snapshot_source = GPU_RK_SNAPSHOT_CU_PATH.read_text(encoding="utf-8")
    magnetization_source = GPU_RK_MAGNETIZATION_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "GPU CUDA magnetization device-state module header" in magnetization_header
    assert "struct FemGpuMagnetizationDeviceState" in magnetization_header
    assert "FemGpuComponentField m" in magnetization_header
    assert "GPU CUDA magnetization memory module header" in magnetization_memory_header
    assert "GPU CUDA magnetization memory source contract" in magnetization_memory_source
    assert "gpu/cuda/state/magnetization_memory.cpp" in cmake
    assert "bool gpu_magnetization_allocate(" in magnetization_memory_header
    assert "void gpu_magnetization_free(" in magnetization_memory_header
    assert "bool gpu_magnetization_allocate(" in magnetization_memory_source
    assert "void gpu_magnetization_free(" in magnetization_memory_source
    assert "GPU CUDA magnetization transfer module header" in magnetization_transfer_header
    assert "GPU CUDA magnetization transfer source contract" in magnetization_transfer_source
    assert "gpu/cuda/state/magnetization_transfer.cpp" in cmake
    assert "bool gpu_magnetization_upload_aos(" in magnetization_transfer_header
    assert "bool gpu_magnetization_download_aos(" in magnetization_transfer_header
    assert "bool gpu_magnetization_upload_aos(" in magnetization_transfer_source
    assert "bool gpu_magnetization_download_aos(" in magnetization_transfer_source
    assert '#include "gpu/cuda/state/magnetization_state.hpp"' in gpu_state_header
    assert "FemGpuMagnetizationDeviceState magnetization{}" in gpu_state_header
    assert "FemGpuComponentField m;" not in gpu_state_header
    assert "state.magnetization" in gpu_state_source
    assert "state.m.x" not in gpu_state_source
    assert "gpu_magnetization_allocate(" in gpu_state_source
    assert "gpu_magnetization_free(" in gpu_state_source
    assert "gpu_magnetization_upload_aos(" in gpu_state_source
    assert "gpu_magnetization_download_aos(" in gpu_state_source
    assert "magnetization.m" in magnetization_memory_source
    assert "magnetization.m" in magnetization_transfer_source
    assert "gpu_device_allocate_component(" in magnetization_memory_source
    assert "gpu_device_free_component(" in magnetization_memory_source
    assert "gpu_component_upload_aos(" in magnetization_transfer_source
    assert "gpu_component_download_aos(" in magnetization_transfer_source
    assert "gpu_device_allocate_component(state.magnetization.m" not in gpu_state_source
    assert "gpu_device_free_component(state.magnetization.m" not in gpu_state_source
    assert "gpu_component_upload_aos(\n            state.lifecycle,\n            state.magnetization.m" not in gpu_state_source
    assert "gpu_component_download_aos(\n            state.lifecycle,\n            state.magnetization.m" not in gpu_state_source
    for source in (
        attempt_setup_source,
        refresh_source,
        snapshot_source,
        magnetization_source,
    ):
        assert "gpu.magnetization.m" in source
        assert "gpu.m.x" not in source
        assert "gpu.m," not in source


def test_gpu_residency_state_is_owned_by_gpu_state_module():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    residency_header = GPU_RESIDENCY_STATE_HPP_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    snapshot_source = GPU_RK_SNAPSHOT_CU_PATH.read_text(encoding="utf-8")
    stats_source = GPU_RK_STEP_STATS_CU_PATH.read_text(encoding="utf-8")

    assert "GPU CUDA residency device-state module header" in residency_header
    assert "enum class FemGpuSyncState" in residency_header
    assert "struct FemGpuResidencyDeviceState" in residency_header
    assert "fullmag_fem_data_residency source_of_truth" in residency_header
    assert "FemGpuSyncState host_state = FemGpuSyncState::HostClean" in residency_header
    assert "FemGpuSyncState device_state = FemGpuSyncState::HostStale" in residency_header
    assert '#include "gpu/cuda/state/residency_state.hpp"' in gpu_state_header
    assert "FemGpuResidencyDeviceState residency{}" in gpu_state_header
    for flat_member in (
        "fullmag_fem_data_residency source_of_truth",
        "FemGpuSyncState host_state",
        "FemGpuSyncState device_state",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "state.residency.source_of_truth",
        "state.residency.host_state",
        "state.residency.device_state",
    ):
        assert state_member in gpu_state_source
    for source in (preflight_source, refresh_source, snapshot_source, stats_source):
        assert "gpu.residency." in source
        assert "gpu.source_of_truth" not in source
        assert "gpu.host_state" not in source
        assert "gpu.device_state" not in source


def test_gpu_lifecycle_state_is_owned_by_gpu_state_module():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    lifecycle_header = GPU_LIFECYCLE_STATE_HPP_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")
    exchange_source = GPU_RK_EXCHANGE_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    snapshot_source = GPU_RK_SNAPSHOT_CU_PATH.read_text(encoding="utf-8")
    stats_source = GPU_RK_STEP_STATS_CU_PATH.read_text(encoding="utf-8")

    assert "GPU CUDA lifecycle device-state module header" in lifecycle_header
    assert "struct FemGpuLifecycleDeviceState" in lifecycle_header
    for member in (
        "bool initialized = false",
        "bool allocated = false",
        "uint64_t node_count = 0",
        "uint64_t dof_len = 0",
        "uint32_t stage_count = 0",
        "uint64_t device_bytes = 0",
        "uint64_t reduction_workspace_bytes = 0",
    ):
        assert member in lifecycle_header
    assert '#include "gpu/cuda/state/lifecycle_state.hpp"' in gpu_state_header
    assert "FemGpuLifecycleDeviceState lifecycle{}" in gpu_state_header
    for flat_member in (
        "bool initialized = false",
        "bool allocated = false",
        "uint64_t node_count = 0",
        "uint64_t dof_len = 0",
        "uint32_t stage_count = 0",
        "uint64_t device_bytes = 0",
        "uint64_t reduction_workspace_bytes = 0",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "state.lifecycle.initialized",
        "state.lifecycle.allocated",
        "state.lifecycle.node_count",
        "state.lifecycle.dof_len",
        "state.lifecycle.stage_count",
        "state.lifecycle.device_bytes",
        "state.lifecycle.reduction_workspace_bytes",
    ):
        assert state_member in gpu_state_source
    for source in (preflight_source, exchange_source, snapshot_source, stats_source):
        assert "gpu.lifecycle." in source
        assert "gpu.allocated" not in source
        assert "gpu.node_count" not in source
        assert "gpu.stage_count" not in source


def test_gpu_device_memory_helpers_are_owned_by_device_memory_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    component_transfer_source = GPU_COMPONENT_TRANSFER_CPP_PATH.read_text(
        encoding="utf-8"
    )
    field_buffer_memory_source = GPU_FIELD_BUFFER_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_memory_source = GPU_MAGNETIZATION_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_memory_source = GPU_MAGNETOELASTIC_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    rk_workspace_memory_source = GPU_RK_WORKSPACE_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    local_interaction_workspace_memory_source = (
        GPU_LOCAL_INTERACTION_WORKSPACE_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )
    reduction_workspace_memory_source = (
        GPU_REDUCTION_WORKSPACE_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )
    runtime_coefficients_memory_source = (
        GPU_RUNTIME_COEFFICIENTS_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )
    device_memory_header = GPU_DEVICE_MEMORY_HPP_PATH.read_text(encoding="utf-8")
    device_memory_source = GPU_DEVICE_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    device_memory_consumers = "\n".join(
        (
            gpu_state_source,
            component_transfer_source,
            field_buffer_memory_source,
            magnetization_memory_source,
            magnetoelastic_memory_source,
            rk_workspace_memory_source,
            local_interaction_workspace_memory_source,
            reduction_workspace_memory_source,
            runtime_coefficients_memory_source,
        )
    )

    assert "GPU CUDA device-memory helper module header" in device_memory_header
    assert "GPU CUDA device-memory helper source contract" in device_memory_source
    for declaration in (
        "bool gpu_device_checked_node_bytes(",
        "bool gpu_device_allocate_bytes(",
        "bool gpu_device_allocate_double(",
        "bool gpu_device_allocate_u8(",
        "bool gpu_device_allocate_u32(",
        "bool gpu_device_allocate_component(",
        "void gpu_device_free_double(",
        "void gpu_device_free_bytes(",
        "void gpu_device_free_u8(",
        "void gpu_device_free_u32(",
        "void gpu_device_free_component(",
    ):
        assert declaration in device_memory_header
    assert "cudaMalloc" in device_memory_source
    assert "cudaFree" in device_memory_source
    assert "gpu/cuda/state/device_memory.cpp" in cmake_source
    assert '#include "gpu/cuda/state/device_memory.hpp"' in gpu_state_source
    for helper in (
        "gpu_device_checked_node_bytes(",
        "gpu_device_allocate_bytes(",
        "gpu_device_allocate_double(",
        "gpu_device_allocate_u8(",
        "gpu_device_allocate_u32(",
        "gpu_device_allocate_component(",
        "gpu_device_free_double(",
        "gpu_device_free_bytes(",
        "gpu_device_free_u8(",
        "gpu_device_free_u32(",
        "gpu_device_free_component(",
    ):
        assert helper in device_memory_consumers
    for local_helper in (
        "bool checked_node_bytes(",
        "bool allocate_bytes(",
        "bool allocate_double(",
        "bool allocate_u8(",
        "bool allocate_u32(",
        "bool allocate_component(",
        "void free_double(",
        "void free_bytes(",
        "void free_u8(",
        "void free_u32(",
        "void free_component(",
    ):
        assert local_helper not in gpu_state_source


def test_gpu_state_uploads_runtime_coefficients_outside_hot_loop():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    runtime_coefficients_header = GPU_RUNTIME_COEFFICIENTS_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    runtime_coefficients_memory_header = (
        GPU_RUNTIME_COEFFICIENTS_MEMORY_HPP_PATH.read_text(encoding="utf-8")
    )
    runtime_coefficients_memory_source = (
        GPU_RUNTIME_COEFFICIENTS_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )
    runtime_coefficients_upload_header = (
        GPU_RUNTIME_COEFFICIENTS_UPLOAD_HPP_PATH.read_text(encoding="utf-8")
    )
    runtime_coefficients_upload_source = (
        GPU_RUNTIME_COEFFICIENTS_UPLOAD_CPP_PATH.read_text(encoding="utf-8")
    )
    material_state_header = GPU_MATERIAL_STATE_HPP_PATH.read_text(encoding="utf-8")
    mesh_metrics_header = GPU_MESH_METRICS_STATE_HPP_PATH.read_text(encoding="utf-8")
    mesh_regions_header = GPU_MESH_REGIONS_STATE_HPP_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    context_source = GPU_STATE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")
    exchange_source = GPU_EXCHANGE_CPP_PATH.read_text(encoding="utf-8")
    llg_source = GPU_RK_LLG_RHS_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    anisotropy_source = GPU_RK_ANISOTROPY_FIELD_CU_PATH.read_text(encoding="utf-8")
    thermal_source = GPU_RK_THERMAL_FIELD_CU_PATH.read_text(encoding="utf-8")
    exchange_dispatch_source = GPU_RK_EXCHANGE_DISPATCH_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu_state_upload_runtime_coefficients" in gpu_state_header
    assert "gpu_state_upload_runtime_coefficients" in gpu_state_source
    assert (
        "GPU CUDA runtime-coefficients upload module header"
        in runtime_coefficients_upload_header
    )
    assert (
        "GPU CUDA runtime-coefficients upload source contract"
        in runtime_coefficients_upload_source
    )
    assert "bool gpu_runtime_coefficients_upload(" in runtime_coefficients_upload_header
    assert "bool gpu_runtime_coefficients_upload(" in runtime_coefficients_upload_source
    assert "gpu/cuda/state/runtime_coefficients_upload.cpp" in cmake
    assert (
        "GPU CUDA runtime-coefficients memory module header"
        in runtime_coefficients_memory_header
    )
    assert (
        "GPU CUDA runtime-coefficients memory source contract"
        in runtime_coefficients_memory_source
    )
    assert "gpu/cuda/state/runtime_coefficients_memory.cpp" in cmake
    assert "bool gpu_runtime_coefficients_allocate(" in runtime_coefficients_memory_header
    assert "void gpu_runtime_coefficients_free(" in runtime_coefficients_memory_header
    assert "bool gpu_runtime_coefficients_allocate(" in runtime_coefficients_memory_source
    assert "void gpu_runtime_coefficients_free(" in runtime_coefficients_memory_source
    assert (
        "GPU CUDA runtime-coefficients readiness device-state module header"
        in runtime_coefficients_header
    )
    assert "struct FemGpuRuntimeCoefficientDeviceState" in runtime_coefficients_header
    assert "bool uploaded = false" in runtime_coefficients_header
    assert '#include "gpu/cuda/state/runtime_coefficients_state.hpp"' in gpu_state_header
    assert "FemGpuRuntimeCoefficientDeviceState runtime_coefficients{}" in gpu_state_header
    assert "bool runtime_coefficients_uploaded = false" not in gpu_state_header
    assert '#include "gpu/cuda/materials/material_state.hpp"' in gpu_state_header
    assert '#include "gpu/cuda/mesh/mesh_regions_state.hpp"' in gpu_state_header
    assert "GPU CUDA material device-state module header" in material_state_header
    assert "struct FemGpuMaterialDeviceState" in material_state_header
    assert "FemGpuMaterialDeviceState materials{}" in gpu_state_header
    assert "double *node_volumes" in mesh_metrics_header
    assert "GPU CUDA mesh region device-state module header" in mesh_regions_header
    assert "struct FemGpuMeshRegionDeviceState" in mesh_regions_header
    assert "uint8_t *magnetic_node_mask" in mesh_regions_header
    assert "uint32_t *periodic_reduced_node" in mesh_regions_header
    assert "uint32_t *periodic_representative_nodes" in mesh_regions_header
    assert "FemGpuMeshRegionDeviceState mesh_regions{}" in gpu_state_header
    for flat_member in (
        "double *node_volumes = nullptr",
        "double *ms = nullptr",
        "double *a = nullptr",
        "double *alpha = nullptr",
        "double *ku = nullptr",
        "double *ku2 = nullptr",
        "double *dind = nullptr",
        "double *dbulk = nullptr",
        "double *kc1 = nullptr",
        "double *kc2 = nullptr",
        "double *kc3 = nullptr",
        "uint8_t *magnetic_node_mask = nullptr",
        "uint32_t *periodic_reduced_node = nullptr",
        "uint32_t *periodic_representative_nodes = nullptr",
    ):
        assert flat_member not in gpu_state_header
    for member in (
        "mesh_metrics.node_volumes",
        "materials.ms",
        "materials.a",
        "materials.alpha",
        "materials.ku",
        "materials.ku2",
        "materials.dind",
        "materials.dbulk",
        "materials.kc1",
        "materials.kc2",
        "materials.kc3",
        "mesh_regions.magnetic_node_mask",
        "mesh_regions.periodic_reduced_node",
        "mesh_regions.periodic_representative_nodes",
        "runtime_coefficients.uploaded",
    ):
        assert member in runtime_coefficients_upload_source
    for memory_member in (
        "mesh_metrics.node_volumes",
        "materials.ms",
        "materials.a",
        "materials.alpha",
        "materials.ku",
        "materials.ku2",
        "materials.dind",
        "materials.dbulk",
        "materials.kc1",
        "materials.kc2",
        "materials.kc3",
        "mesh_regions.magnetic_node_mask",
        "mesh_regions.periodic_reduced_node",
        "mesh_regions.periodic_representative_nodes",
    ):
        assert memory_member in runtime_coefficients_memory_source
    for delegated_member in (
        "gpu_runtime_coefficients_upload(",
        "gpu_runtime_coefficients_allocate(",
        "gpu_runtime_coefficients_free(",
        "state.lifecycle",
        "state.runtime_coefficients",
        "state.materials",
        "state.mesh_metrics",
        "state.mesh_regions",
    ):
        assert delegated_member in gpu_state_source
    for forbidden_upload_detail in (
        "cudaMemcpy(state.mesh_metrics.node_volumes",
        "cudaMemcpy(state.materials.ms",
        "cudaMemcpy(state.materials.a",
        "cudaMemcpy(state.materials.alpha",
        "cudaMemcpy(state.materials.ku",
        "cudaMemcpy(state.materials.ku2",
        "cudaMemcpy(state.materials.dind",
        "cudaMemcpy(state.materials.dbulk",
        "cudaMemcpy(state.materials.kc1",
        "cudaMemcpy(state.materials.kc2",
        "cudaMemcpy(state.materials.kc3",
        "cudaMemcpy(state.mesh_regions.magnetic_node_mask",
        "cudaMemcpy(state.mesh_regions.periodic_reduced_node",
        "cudaMemcpy(state.mesh_regions.periodic_representative_nodes",
    ):
        assert forbidden_upload_detail not in gpu_state_source
    for forbidden_memory_detail in (
        "gpu_device_allocate_double(state.mesh_metrics.node_volumes",
        "gpu_device_allocate_double(state.materials.ms",
        "gpu_device_allocate_double(state.materials.a",
        "gpu_device_allocate_double(state.materials.alpha",
        "gpu_device_allocate_double(state.materials.ku",
        "gpu_device_allocate_double(state.materials.ku2",
        "gpu_device_allocate_double(state.materials.dind",
        "gpu_device_allocate_double(state.materials.dbulk",
        "gpu_device_allocate_double(state.materials.kc1",
        "gpu_device_allocate_double(state.materials.kc2",
        "gpu_device_allocate_double(state.materials.kc3",
        "gpu_device_allocate_u8(state.mesh_regions.magnetic_node_mask",
        "gpu_device_allocate_u32(state.mesh_regions.periodic_reduced_node",
        "gpu_device_allocate_u32(state.mesh_regions.periodic_representative_nodes",
        "gpu_device_free_double(state.mesh_metrics.node_volumes)",
        "gpu_device_free_double(state.materials.ms)",
        "gpu_device_free_double(state.materials.a)",
        "gpu_device_free_double(state.materials.alpha)",
        "gpu_device_free_double(state.materials.ku)",
        "gpu_device_free_double(state.materials.ku2)",
        "gpu_device_free_double(state.materials.dind)",
        "gpu_device_free_double(state.materials.dbulk)",
        "gpu_device_free_double(state.materials.kc1)",
        "gpu_device_free_double(state.materials.kc2)",
        "gpu_device_free_double(state.materials.kc3)",
        "gpu_device_free_u8(state.mesh_regions.magnetic_node_mask)",
        "gpu_device_free_u32(state.mesh_regions.periodic_reduced_node)",
        "gpu_device_free_u32(state.mesh_regions.periodic_representative_nodes)",
    ):
        assert forbidden_memory_detail not in gpu_state_source
    assert "state.runtime_coefficients_uploaded" not in gpu_state_source
    for context_member in (
        "ctx.material_fields.Ku_field.data()",
        "ctx.material_fields.Ku2_field.data()",
        "ctx.material_fields.Dind_field.data()",
        "ctx.material_fields.Dbulk_field.data()",
        "ctx.material_fields.Kc1_field.data()",
        "ctx.material_fields.Kc2_field.data()",
        "ctx.material_fields.Kc3_field.data()",
    ):
        assert context_member in context_source
    assert "gpu_state_upload_runtime_coefficients(" in context_source
    assert "ctx.gpu_state.device.runtime_coefficients.uploaded" in exchange_source
    assert "ctx.gpu_state.device.runtime_coefficients_uploaded" not in exchange_source
    assert "gpu.materials.alpha" in llg_source
    assert "gpu.materials.ms" in anisotropy_source
    assert "gpu.mesh_metrics.node_volumes" in thermal_source
    assert "gpu.mesh_regions.magnetic_node_mask" in anisotropy_source
    assert "gpu.mesh_regions.magnetic_node_mask" in thermal_source
    assert "gpu.mesh_regions.magnetic_node_mask" in exchange_dispatch_source


def test_gpu_mesh_geometry_device_state_is_owned_by_mesh_module():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    mesh_geometry_header = GPU_MESH_GEOMETRY_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    mesh_geometry_upload_header = GPU_MESH_GEOMETRY_UPLOAD_HPP_PATH.read_text(
        encoding="utf-8"
    )
    mesh_geometry_upload_source = GPU_MESH_GEOMETRY_UPLOAD_CPP_PATH.read_text(
        encoding="utf-8"
    )
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    dmi_field_source = GPU_RK_DMI_FIELDS_CU_PATH.read_text(encoding="utf-8")
    dmi_energy_source = GPU_RK_DMI_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    zhang_li_source = GPU_RK_ZHANG_LI_TORQUE_CU_PATH.read_text(encoding="utf-8")
    rk_plan_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")

    assert "GPU CUDA mesh geometry device-state module header" in mesh_geometry_header
    assert "struct FemGpuMeshGeometryDeviceState" in mesh_geometry_header
    assert "GPU CUDA mesh geometry upload module header" in mesh_geometry_upload_header
    assert "GPU CUDA mesh geometry upload source contract" in mesh_geometry_upload_source
    assert "bool gpu_mesh_geometry_upload(" in mesh_geometry_upload_header
    assert "bool gpu_mesh_geometry_upload(" in mesh_geometry_upload_source
    assert "gpu/cuda/mesh/mesh_geometry_upload.cpp" in cmake
    assert "double *nodes_xyz = nullptr" in mesh_geometry_header
    assert "uint32_t *elements = nullptr" in mesh_geometry_header
    assert "uint8_t *magnetic_element_mask = nullptr" in mesh_geometry_header
    assert "uint64_t element_count = 0" in mesh_geometry_header
    assert "bool uploaded = false" in mesh_geometry_header
    assert '#include "gpu/cuda/mesh/mesh_geometry_state.hpp"' in gpu_state_header
    assert "FemGpuMeshGeometryDeviceState mesh_geometry{}" in gpu_state_header
    for flat_member in (
        "double *nodes_xyz = nullptr",
        "uint32_t *elements = nullptr",
        "uint8_t *magnetic_element_mask = nullptr",
        "uint64_t mesh_element_count = 0",
        "bool mesh_geometry_uploaded = false",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "gpu_mesh_geometry_upload(",
        "state.lifecycle",
        "state.mesh_geometry",
    ):
        assert state_member in gpu_state_source
    for upload_member in (
        "mesh_geometry.nodes_xyz",
        "mesh_geometry.elements",
        "mesh_geometry.magnetic_element_mask",
        "mesh_geometry.element_count",
        "mesh_geometry.uploaded",
    ):
        assert upload_member in mesh_geometry_upload_source
    assert "cudaMemcpy(state.mesh_geometry.nodes_xyz" not in gpu_state_source
    assert "cudaMemcpy(state.mesh_geometry.elements" not in gpu_state_source
    assert "cudaMemcpy(state.mesh_geometry.magnetic_element_mask" not in gpu_state_source
    assert "state.nodes_xyz" not in gpu_state_source
    assert "state.mesh_element_count" not in gpu_state_source
    for source in (dmi_field_source, dmi_energy_source, zhang_li_source):
        assert "gpu.mesh_geometry.uploaded" in source
        assert "gpu.mesh_geometry.element_count" in source
        assert "gpu.mesh_geometry.nodes_xyz" in source
        assert "gpu.mesh_geometry.elements" in source
        assert "gpu.mesh_geometry.magnetic_element_mask" in source
        assert "gpu.nodes_xyz" not in source
        assert "gpu.mesh_element_count" not in source
    assert "ctx.gpu_state.device.mesh_geometry.uploaded" in rk_plan_source
    assert "ctx.gpu_state.device.mesh_geometry.element_count" in rk_plan_source
    assert "ctx.gpu_state.device.mesh_geometry_uploaded" not in rk_plan_source


def test_gpu_scalar_reduction_workspace_is_owned_by_reductions_module():
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    reduction_workspace_header = GPU_REDUCTION_WORKSPACE_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    reduction_workspace_memory_header = (
        GPU_REDUCTION_WORKSPACE_MEMORY_HPP_PATH.read_text(encoding="utf-8")
    )
    reduction_workspace_memory_source = (
        GPU_REDUCTION_WORKSPACE_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )
    error_norm_source = GPU_RK_ERROR_NORM_RUNTIME_CU_PATH.read_text(
        encoding="utf-8"
    )
    step_stats_source = GPU_RK_STEP_STATS_CU_PATH.read_text(encoding="utf-8")
    demag_stage_source = GPU_DEMAG_STAGE_COMPUTE_CPP_PATH.read_text(
        encoding="utf-8"
    )

    assert (
        "GPU CUDA scalar reduction workspace device-state module header"
        in reduction_workspace_header
    )
    assert "FEM_GPU_SCALAR_RESULT_SLOTS" in reduction_workspace_header
    assert "struct FemGpuReductionWorkspaceDeviceState" in reduction_workspace_header
    assert "double *scalar_workspace = nullptr" in reduction_workspace_header
    assert "double *scalar_result = nullptr" in reduction_workspace_header
    assert "void *temp_storage = nullptr" in reduction_workspace_header
    assert "uint64_t temp_storage_bytes = 0" in reduction_workspace_header
    assert (
        "GPU CUDA scalar reduction workspace memory module header"
        in reduction_workspace_memory_header
    )
    assert (
        "GPU CUDA scalar reduction workspace memory source contract"
        in reduction_workspace_memory_source
    )
    assert "gpu/cuda/reductions/reduction_workspace_memory.cpp" in cmake
    assert "bool gpu_reduction_workspace_allocate(" in reduction_workspace_memory_header
    assert "void gpu_reduction_workspace_free(" in reduction_workspace_memory_header
    assert "bool gpu_reduction_workspace_allocate(" in reduction_workspace_memory_source
    assert "void gpu_reduction_workspace_free(" in reduction_workspace_memory_source
    assert "fullmag_cuda_device_max(" in reduction_workspace_memory_source
    assert "fullmag_cuda_device_sum(" in reduction_workspace_memory_source
    assert "gpu_device_allocate_bytes(" in reduction_workspace_memory_source
    assert (
        '#include "gpu/cuda/reductions/reduction_workspace_state.hpp"'
        in gpu_state_header
    )
    assert "FemGpuReductionWorkspaceDeviceState reductions{}" in gpu_state_header
    assert (
        '#include "gpu/cuda/reductions/reduction_workspace_memory.hpp"'
        in gpu_state_source
    )
    for flat_member in (
        "double *scalar_reduce_workspace = nullptr",
        "double *scalar_reduce_result = nullptr",
        "void *scalar_reduce_temp_storage = nullptr",
        "uint64_t scalar_reduce_temp_storage_bytes = 0",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "reductions.scalar_workspace",
        "reductions.scalar_result",
        "reductions.temp_storage",
        "reductions.temp_storage_bytes",
    ):
        assert state_member in reduction_workspace_memory_source
    assert "gpu_reduction_workspace_allocate(" in gpu_state_source
    assert "gpu_reduction_workspace_free(" in gpu_state_source
    assert "gpu_device_allocate_double(state.reductions.scalar_workspace" not in gpu_state_source
    assert "gpu_device_allocate_double(state.reductions.scalar_result" not in gpu_state_source
    assert "gpu_device_allocate_bytes(\n            &state.reductions.temp_storage" not in gpu_state_source
    assert "gpu_device_free_double(state.reductions.scalar_workspace)" not in gpu_state_source
    assert "gpu_device_free_double(state.reductions.scalar_result)" not in gpu_state_source
    assert "gpu_device_free_bytes(state.reductions.temp_storage)" not in gpu_state_source
    assert "fullmag_cuda_device_max(" not in gpu_state_source
    assert "fullmag_cuda_device_sum(" not in gpu_state_source
    for source in (error_norm_source, demag_stage_source):
        assert "gpu.reductions.scalar_workspace" in source
        assert "gpu.reductions.scalar_result" in source
        assert "gpu.reductions.temp_storage" in source
        assert "gpu.reductions.temp_storage_bytes" in source
        assert "gpu.scalar_reduce_workspace" not in source
        assert "gpu.scalar_reduce_result" not in source
        assert "gpu.scalar_reduce_temp_storage" not in source
    assert "gpu.reductions.scalar_result" in step_stats_source
    assert "gpu.reductions.temp_storage" in step_stats_source
    assert "gpu.scalar_reduce_result" not in step_stats_source
    assert "gpu.scalar_reduce_temp_storage" not in step_stats_source


def test_gpu_magnetoelastic_strain_device_state_is_owned_by_magnetoelastic_module():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    magnetoelastic_state_header = GPU_MAGNETOELASTIC_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_memory_header = GPU_MAGNETOELASTIC_MEMORY_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_memory_source = GPU_MAGNETOELASTIC_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_upload_header = GPU_MAGNETOELASTIC_UPLOAD_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_upload_source = GPU_MAGNETOELASTIC_UPLOAD_CPP_PATH.read_text(
        encoding="utf-8"
    )
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    rk_plan_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    magnetoelastic_field_source = GPU_RK_MAGNETOELASTIC_FIELD_CU_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_energy_source = (
        GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    )

    assert (
        "GPU CUDA magnetoelastic device-state module header"
        in magnetoelastic_state_header
    )
    assert "struct FemGpuMagnetoelasticDeviceState" in magnetoelastic_state_header
    assert "double *strain_voigt = nullptr" in magnetoelastic_state_header
    assert "uint64_t strain_voigt_len = 0" in magnetoelastic_state_header
    assert "bool strain_uploaded = false" in magnetoelastic_state_header
    assert "GPU CUDA magnetoelastic memory module header" in magnetoelastic_memory_header
    assert "GPU CUDA magnetoelastic memory source contract" in magnetoelastic_memory_source
    assert "bool gpu_magnetoelastic_allocate(" in magnetoelastic_memory_header
    assert "void gpu_magnetoelastic_free(" in magnetoelastic_memory_header
    assert "bool gpu_magnetoelastic_allocate(" in magnetoelastic_memory_source
    assert "void gpu_magnetoelastic_free(" in magnetoelastic_memory_source
    assert "gpu/cuda/interactions/magnetoelastic/magnetoelastic_memory.cpp" in cmake
    assert "magnetoelastic.strain_voigt" in magnetoelastic_memory_source
    assert "GPU CUDA magnetoelastic upload module header" in magnetoelastic_upload_header
    assert "GPU CUDA magnetoelastic upload source contract" in magnetoelastic_upload_source
    assert "bool gpu_magnetoelastic_upload_strain(" in magnetoelastic_upload_header
    assert "bool gpu_magnetoelastic_upload_strain(" in magnetoelastic_upload_source
    assert "gpu/cuda/interactions/magnetoelastic/magnetoelastic_upload.cpp" in cmake
    assert (
        '#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_state.hpp"'
        in gpu_state_header
    )
    assert "FemGpuMagnetoelasticDeviceState magnetoelastic{}" in gpu_state_header
    for flat_member in (
        "double *mel_strain_voigt = nullptr",
        "uint64_t mel_strain_voigt_len = 0",
        "bool mel_strain_uploaded = false",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "gpu_magnetoelastic_allocate(",
        "gpu_magnetoelastic_free(",
        "gpu_magnetoelastic_upload_strain(",
        "state.lifecycle",
        "state.magnetoelastic",
        "state.magnetoelastic.strain_voigt_len",
        "state.magnetoelastic.strain_uploaded",
    ):
        assert state_member in gpu_state_source
    for upload_member in (
        "magnetoelastic.strain_voigt",
        "magnetoelastic.strain_voigt_len",
        "magnetoelastic.strain_uploaded",
    ):
        assert upload_member in magnetoelastic_upload_source
    assert "cudaMemcpy(state.magnetoelastic.strain_voigt" not in gpu_state_source
    assert "gpu_device_allocate_double(state.magnetoelastic.strain_voigt" not in gpu_state_source
    assert "gpu_device_free_double(state.magnetoelastic.strain_voigt)" not in gpu_state_source
    assert "state.mel_strain_voigt" not in gpu_state_source
    assert "ctx.gpu_state.device.magnetoelastic.strain_uploaded" in rk_plan_source
    assert "ctx.gpu_state.device.magnetoelastic.strain_voigt_len" in rk_plan_source
    assert "ctx.gpu_state.device.mel_strain_uploaded" not in rk_plan_source
    for source in (magnetoelastic_field_source, magnetoelastic_energy_source):
        assert "gpu.magnetoelastic.strain_voigt" in source
        assert "gpu.magnetoelastic.strain_voigt_len" in source
        assert "gpu.magnetoelastic.strain_uploaded" in source
        assert "gpu.mel_strain_voigt" not in source
        assert "gpu.mel_strain_uploaded" not in source


def test_gpu_local_interaction_workspace_is_owned_by_interactions_module():
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    workspace_header = GPU_LOCAL_INTERACTION_WORKSPACE_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    workspace_memory_header = (
        GPU_LOCAL_INTERACTION_WORKSPACE_MEMORY_HPP_PATH.read_text(encoding="utf-8")
    )
    workspace_memory_source = (
        GPU_LOCAL_INTERACTION_WORKSPACE_MEMORY_CPP_PATH.read_text(encoding="utf-8")
    )
    dmi_field_source = GPU_RK_DMI_FIELDS_CU_PATH.read_text(encoding="utf-8")
    dmi_energy_source = GPU_RK_DMI_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    zhang_li_source = GPU_RK_ZHANG_LI_TORQUE_CU_PATH.read_text(encoding="utf-8")

    assert (
        "GPU CUDA local interaction workspace device-state module header"
        in workspace_header
    )
    assert "struct FemGpuLocalInteractionWorkspaceDeviceState" in workspace_header
    assert "FemGpuComponentField vector" in workspace_header
    assert "double *node_weight = nullptr" in workspace_header
    assert (
        "GPU CUDA local interaction workspace memory module header"
        in workspace_memory_header
    )
    assert (
        "GPU CUDA local interaction workspace memory source contract"
        in workspace_memory_source
    )
    assert "gpu/cuda/interactions/local_interaction_workspace_memory.cpp" in cmake
    assert "bool gpu_local_interaction_workspace_allocate(" in workspace_memory_header
    assert "void gpu_local_interaction_workspace_free(" in workspace_memory_header
    assert "bool gpu_local_interaction_workspace_allocate(" in workspace_memory_source
    assert "void gpu_local_interaction_workspace_free(" in workspace_memory_source
    assert (
        '#include "gpu/cuda/interactions/local_interaction_workspace_state.hpp"'
        in gpu_state_header
    )
    assert (
        "FemGpuLocalInteractionWorkspaceDeviceState local_interactions{}"
        in gpu_state_header
    )
    for flat_member in (
        "FemGpuComponentField zhang_li_rhs",
        "double *zhang_li_node_weight = nullptr",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "state.local_interactions",
        "gpu_local_interaction_workspace_allocate(",
        "gpu_local_interaction_workspace_free(",
    ):
        assert state_member in gpu_state_source
    assert "local_interactions.vector" in workspace_memory_source
    assert "local_interactions.node_weight" in workspace_memory_source
    assert "gpu_device_allocate_component(state.local_interactions.vector" not in gpu_state_source
    assert "gpu_device_allocate_double(state.local_interactions.node_weight" not in gpu_state_source
    assert "gpu_device_free_component(state.local_interactions.vector" not in gpu_state_source
    assert "gpu_device_free_double(state.local_interactions.node_weight" not in gpu_state_source
    assert "state.zhang_li_rhs" not in gpu_state_source
    assert "state.zhang_li_node_weight" not in gpu_state_source
    for source in (dmi_field_source, dmi_energy_source, zhang_li_source):
        assert "gpu.local_interactions.vector.x" in source
        assert "gpu.local_interactions.vector.y" in source
        assert "gpu.local_interactions.vector.z" in source
        assert "gpu.zhang_li_rhs" not in source
    assert "gpu.local_interactions.node_weight" in zhang_li_source
    assert "gpu.zhang_li_node_weight" not in zhang_li_source


def test_gpu_rk_workspace_is_owned_by_rk_integrator_module():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    workspace_header = GPU_RK_WORKSPACE_STATE_HPP_PATH.read_text(encoding="utf-8")
    workspace_memory_header = GPU_RK_WORKSPACE_MEMORY_HPP_PATH.read_text(
        encoding="utf-8"
    )
    workspace_memory_source = GPU_RK_WORKSPACE_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    attempt_setup_source = GPU_RK_ATTEMPT_SETUP_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    adaptive_source = GPU_RK_ADAPTIVE_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    rk23_source = GPU_RK23_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")

    assert "GPU CUDA RK workspace device-state module header" in workspace_header
    assert "FEM_GPU_MAX_RK_STAGES" in workspace_header
    assert "struct FemGpuRkWorkspaceDeviceState" in workspace_header
    assert "FemGpuComponentField m_backup" in workspace_header
    assert "FemGpuComponentField m_stage" in workspace_header
    assert "FemGpuComponentField error" in workspace_header
    assert "std::array<FemGpuComponentField, FEM_GPU_MAX_RK_STAGES> k{}" in workspace_header
    assert "bool fsal_valid = false" in workspace_header
    assert "GPU CUDA RK workspace memory module header" in workspace_memory_header
    assert "GPU CUDA RK workspace memory source contract" in workspace_memory_source
    assert "gpu/cuda/integrators/rk/rk_workspace_memory.cpp" in cmake
    assert "bool gpu_rk_workspace_allocate(" in workspace_memory_header
    assert "void gpu_rk_workspace_free(" in workspace_memory_header
    assert "bool gpu_rk_workspace_allocate(" in workspace_memory_source
    assert "void gpu_rk_workspace_free(" in workspace_memory_source
    assert '#include "gpu/cuda/integrators/rk/rk_workspace_state.hpp"' in gpu_state_header
    assert "FemGpuRkWorkspaceDeviceState rk{}" in gpu_state_header
    for flat_member in (
        "FemGpuComponentField m_backup",
        "FemGpuComponentField m_stage",
        "FemGpuComponentField error",
        "std::array<FemGpuComponentField, FEM_GPU_MAX_RK_STAGES> k{}",
        "bool fsal_valid = false",
    ):
        assert flat_member not in gpu_state_header
    for state_member in (
        "state.rk.m_backup",
        "state.rk.m_stage",
        "state.rk.error",
        "state.rk.k",
        "state.rk.fsal_valid",
    ):
        assert state_member in gpu_state_source or state_member.replace("state.rk", "rk") in workspace_memory_source
    assert "gpu_rk_workspace_allocate(" in gpu_state_source
    assert "gpu_rk_workspace_free(" in gpu_state_source
    assert "gpu_device_allocate_component(state.rk" not in gpu_state_source
    assert "gpu_device_free_component(state.rk" not in gpu_state_source
    assert "gpu_device_allocate_component(rk.m_backup" in workspace_memory_source
    assert "gpu_device_allocate_component(rk.m_stage" in workspace_memory_source
    assert "gpu_device_allocate_component(rk.error" in workspace_memory_source
    assert "gpu_device_allocate_component(rk.k[stage]" in workspace_memory_source
    assert "gpu_device_free_component(rk.m_backup" in workspace_memory_source
    assert "for (auto &stage : rk.k)" in workspace_memory_source
    assert "gpu_device_free_component(stage)" in workspace_memory_source
    assert "gpu.rk.m_stage" in attempt_setup_source
    assert "gpu.rk.k" in attempt_setup_source
    assert "gpu.rk.m_stage" in rk23_source
    assert "gpu.rk.k" in rk23_source
    assert "gpu.rk.error" in refresh_source
    assert "gpu.rk.k[0]" in refresh_source
    assert "gpu.rk.fsal_valid" in refresh_source
    assert "gpu.rk.fsal_valid" in adaptive_source
    assert "gpu.rk.fsal_valid" in rk23_source
    for source in (attempt_setup_source, refresh_source, adaptive_source, rk23_source):
        assert "gpu.m_stage" not in source
        assert "gpu.k[" not in source
        assert "gpu.fsal_valid" not in source
    assert "gpu.rk.m_backup" in attempt_setup_source
    assert "gpu.rk.m_backup" in adaptive_source
    assert "gpu.m_backup" not in attempt_setup_source
    assert "gpu.m_backup" not in adaptive_source
    assert "gpu.error" not in refresh_source


def test_legacy_sparse_exchange_csr_upload_is_wired_before_gpu_exchange_plan_can_pass():
    gpu_state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    exchange_state_header = GPU_EXCHANGE_STATE_HPP_PATH.read_text(encoding="utf-8")
    exchange_upload_header = GPU_EXCHANGE_UPLOAD_HPP_PATH.read_text(encoding="utf-8")
    gpu_exchange_upload_source = GPU_EXCHANGE_UPLOAD_CPP_PATH.read_text(
        encoding="utf-8"
    )
    mesh_metrics_header = GPU_MESH_METRICS_STATE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    mfem_source = (
        REPO_ROOT
    / "backends"
    / "fem"
        / "cpu"
        / "mfem"
        / "runtime"
        / "mfem_context.cpp"
    ).read_text(encoding="utf-8")
    exchange_upload_source = (
        REPO_ROOT
    / "backends"
    / "fem"
        / "cpu"
        / "mfem"
        / "interactions"
        / "exchange_legacy_gpu_upload.cpp"
    ).read_text(encoding="utf-8")
    context_source = GPU_STATE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")
    exchange_source = GPU_EXCHANGE_CPP_PATH.read_text(encoding="utf-8")
    demag_stage_source = GPU_DEMAG_STAGE_COMPUTE_CPP_PATH.read_text(encoding="utf-8")
    anisotropy_field_source = GPU_RK_ANISOTROPY_FIELD_CU_PATH.read_text(
        encoding="utf-8"
    )
    exchange_dispatch_source = GPU_RK_EXCHANGE_DISPATCH_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu_state_upload_exchange_legacy_sparse" in gpu_state_header
    assert "gpu_state_upload_exchange_legacy_sparse" in gpu_state_source
    assert "GPU CUDA legacy sparse exchange upload module header" in exchange_upload_header
    assert "GPU CUDA legacy sparse exchange upload source contract" in gpu_exchange_upload_source
    assert "bool gpu_exchange_upload_legacy_sparse(" in exchange_upload_header
    assert "bool gpu_exchange_upload_legacy_sparse(" in gpu_exchange_upload_source
    assert "void gpu_exchange_reset_legacy_sparse(" in exchange_upload_header
    assert "void gpu_exchange_reset_legacy_sparse(" in gpu_exchange_upload_source
    assert "gpu/cuda/exchange/exchange_upload.cpp" in cmake
    assert '#include "gpu/cuda/exchange/exchange_state.hpp"' in gpu_state_header
    assert '#include "gpu/cuda/mesh/mesh_metrics_state.hpp"' in gpu_state_header
    assert "struct LegacyGpuExchangeDeviceState" in exchange_state_header
    assert "struct FemGpuMeshMetricsDeviceState" in mesh_metrics_header
    assert "LegacyGpuExchangeDeviceState legacy_exchange{}" in gpu_state_header
    assert "FemGpuMeshMetricsDeviceState mesh_metrics{}" in gpu_state_header
    assert "lumped_mass" not in exchange_state_header
    assert "inv_lumped_mass" not in exchange_state_header
    assert "bool exchange_legacy_sparse_uploaded" not in gpu_state_header
    assert "uint64_t exchange_legacy_sparse_rows" not in gpu_state_header
    assert "uint64_t exchange_legacy_sparse_cols" not in gpu_state_header
    assert "uint64_t exchange_legacy_sparse_nnz" not in gpu_state_header
    assert "uint64_t exchange_legacy_sparse_device_bytes" not in gpu_state_header
    for member in (
        "legacy_exchange.csr_row_offsets",
        "legacy_exchange.csr_col_indices",
        "legacy_exchange.csr_values",
        "mesh_metrics.lumped_mass",
        "mesh_metrics.inv_lumped_mass",
        "legacy_exchange.device_bytes",
        "mesh_metrics.device_bytes",
        "legacy_exchange.uploaded = true",
        "mesh_metrics.uploaded = true",
    ):
        assert member in gpu_exchange_upload_source
    for delegated_member in (
        "gpu_exchange_upload_legacy_sparse(",
        "gpu_exchange_reset_legacy_sparse(",
        "state.lifecycle",
        "state.legacy_exchange",
        "state.mesh_metrics",
    ):
        assert delegated_member in gpu_state_source
    for forbidden_upload_detail in (
        "cudaMemcpy(state.legacy_exchange.csr_row_offsets",
        "cudaMemcpy(state.legacy_exchange.csr_col_indices",
        "cudaMemcpy(state.legacy_exchange.csr_values",
        "cudaMemcpy(state.mesh_metrics.lumped_mass",
        "cudaMemcpy(state.mesh_metrics.inv_lumped_mass",
        "gpu_device_allocate_u32(state.legacy_exchange",
        "gpu_device_allocate_double(state.legacy_exchange",
        "gpu_device_allocate_double(state.mesh_metrics.lumped_mass",
        "gpu_device_allocate_double(state.mesh_metrics.inv_lumped_mass",
    ):
        assert forbidden_upload_detail not in gpu_state_source
    assert "legacy_exchange.lumped_mass" not in gpu_state_source
    assert "legacy_exchange.inv_lumped_mass" not in gpu_state_source
    assert "state.lifecycle.device_bytes -= previous_device_bytes" not in gpu_state_source
    assert "lifecycle.device_bytes -= previous_device_bytes" in gpu_exchange_upload_source
    assert "upload_legacy_sparse_exchange_to_gpu_state(" in mfem_source
    assert "exchange_form->SpMat()" in mfem_source
    assert "gpu_state_upload_exchange_legacy_sparse(" in exchange_upload_source
    assert "context_upload_mfem_exchange_to_gpu_state(" in mfem_source
    assert "context_upload_mfem_exchange_to_gpu_state(" in context_source
    assert "ctx.gpu_state.device.legacy_exchange.uploaded" in exchange_source
    assert "ctx.gpu_state.device.exchange_legacy_sparse_uploaded" not in exchange_source
    assert "gpu.mesh_metrics.lumped_mass" in demag_stage_source
    assert "gpu.mesh_metrics.lumped_mass" in anisotropy_field_source
    assert "gpu.mesh_metrics.inv_lumped_mass" in exchange_dispatch_source
    for source in (
        demag_stage_source,
        anisotropy_field_source,
        exchange_dispatch_source,
    ):
        assert "legacy_exchange.lumped_mass" not in source
        assert "legacy_exchange.inv_lumped_mass" not in source


def test_legacy_sparse_exchange_upload_runs_after_gpu_state_allocation():
    context_source = GPU_STATE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")
    mfem_source = (
        REPO_ROOT
    / "backends"
    / "fem"
        / "cpu"
        / "mfem"
        / "runtime"
        / "mfem_context.cpp"
    ).read_text(encoding="utf-8")

    init_start = context_source.index("bool initialize_context_gpu_state(")
    init_source = context_source[init_start:]
    gpu_initialize = init_source.index("gpu_state_initialize(")
    coefficient_upload = init_source.index("gpu_state_upload_runtime_coefficients(")
    exchange_upload = init_source.index("context_upload_mfem_exchange_to_gpu_state(")

    assert gpu_initialize < coefficient_upload < exchange_upload

    mfem_init_start = mfem_source.index("bool context_initialize_mfem(")
    mfem_init_end = mfem_source.index(
        "bool context_upload_mfem_exchange_to_gpu_state(",
        mfem_init_start,
    )
    mfem_init_source = mfem_source[mfem_init_start:mfem_init_end]

    assert "gpu_state_upload_exchange_legacy_sparse(" not in mfem_init_source


def test_gpu_exchange_plan_enables_only_after_device_sparse_exchange_is_ready():
    exchange_source = GPU_EXCHANGE_CPP_PATH.read_text(encoding="utf-8")

    assert "ctx.exchange.mfem.use_consistent_mass" in exchange_source
    assert "ctx.mesh.periodic_reduced_node.empty()" in exchange_source
    assert "ctx.gpu_state.device.runtime_coefficients.uploaded" in exchange_source
    assert "ctx.gpu_state.device.legacy_exchange.uploaded" in exchange_source
    assert "plan.stage_exchange_device_resident = true" in exchange_source
    assert "plan.operator_mode = \"legacy_sparse_gpu\"" in exchange_source


def test_gpu_rk_plan_supports_per_node_damping_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    llg_source = GPU_RK_LLG_RHS_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    llg_kernel_header = GPU_LLG_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    llg_kernel_source = GPU_LLG_KERNELS_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/llg/llg_rhs_kernels.cu" in cmake
    assert "per-node damping yet" not in rk_source
    assert "ctx.material_fields.material.damping" in llg_source
    assert "gpu.materials.alpha" in llg_source
    assert "!ctx.material_fields.alpha_field.empty()" in llg_source
    assert "const double *alpha_field" in llg_kernel_header
    assert "bool use_alpha_field" in llg_kernel_header
    assert "use_alpha_field ? alpha_field[i] : uniform_alpha" in llg_kernel_source


def test_gpu_cuda_transfer_kernels_are_owned_by_transfer_module():
    kernel_source = read_optional_text(KERNELS_CU_PATH)
    transfer_header = GPU_TRANSFER_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    transfer_source = GPU_TRANSFER_KERNELS_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/transfer/transfer_kernels.cu" in cmake
    assert "GPU CUDA transfer kernels module header" in transfer_header
    assert "fullmag_cuda_upload_aos_to_soa(" in transfer_header
    assert "fullmag_cuda_download_soa_to_aos(" in transfer_header
    assert "GPU CUDA transfer kernels source contract" in transfer_source
    assert '#include "gpu/cuda/transfer/transfer_kernels.hpp"' in transfer_source
    assert "cudaMemcpy2D" in transfer_source
    assert "cudaMemcpyHostToDevice" in transfer_source
    assert "cudaMemcpyDeviceToHost" in transfer_source
    assert "fullmag_cuda_upload_aos_to_soa(" not in kernel_source
    assert "fullmag_cuda_download_soa_to_aos(" not in kernel_source


def test_gpu_component_transfer_helpers_are_owned_by_transfer_module():
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    field_buffer_upload_source = GPU_FIELD_BUFFER_UPLOAD_CPP_PATH.read_text(encoding="utf-8")
    component_header = GPU_COMPONENT_TRANSFER_HPP_PATH.read_text(encoding="utf-8")
    component_source = GPU_COMPONENT_TRANSFER_CPP_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/transfer/component_transfer.cpp" in cmake
    assert "GPU CUDA component-transfer module header" in component_header
    assert "GPU CUDA component-transfer source contract" in component_source
    assert '#include "gpu/cuda/transfer/component_transfer.hpp"' in component_source
    for helper in (
        "gpu_component_download_aos(",
        "gpu_component_upload_aos(",
        "gpu_component_zero_device(",
        "gpu_component_upload_optional_aos(",
    ):
        assert helper in component_header
        assert helper in component_source
    assert "gpu_component_download_aos(" in gpu_state_source
    assert (
        "gpu_component_upload_aos(" in gpu_state_source
        or "gpu_component_upload_aos(" in field_buffer_upload_source
    )
    assert "gpu_component_upload_optional_aos(" in field_buffer_upload_source
    assert "fullmag_cuda_upload_aos_to_soa(" in component_source
    assert "fullmag_cuda_download_soa_to_aos(" in component_source
    assert "cudaMemset" in component_source
    assert "record_host_to_device" in component_source
    assert "record_device_to_host" in component_source
    assert "bool gpu_state_upload_component_aos(" not in gpu_state_source
    assert "bool gpu_state_upload_optional_component_aos(" not in gpu_state_source
    assert "bool gpu_state_zero_component_device(" not in gpu_state_source
    assert "fullmag_cuda_upload_aos_to_soa(\n            xyz" not in gpu_state_source
    assert "fullmag_cuda_download_soa_to_aos(\n            field.x" not in gpu_state_source
    assert "cudaMemset(field.x" not in gpu_state_source


def test_gpu_magnetization_transfers_delegate_to_component_transfer_module():
    gpu_state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    magnetization_transfer_source = GPU_MAGNETIZATION_TRANSFER_CPP_PATH.read_text(
        encoding="utf-8"
    )

    upload_start = gpu_state_source.index("bool gpu_state_upload_magnetization_aos(")
    upload_end = gpu_state_source.index("\nbool gpu_state_download_magnetization_aos(", upload_start)
    upload_body = gpu_state_source[upload_start:upload_end]
    download_start = gpu_state_source.index("bool gpu_state_download_magnetization_aos(")
    download_end = gpu_state_source.index("\nbool gpu_state_download_component_aos(", download_start)
    download_body = gpu_state_source[download_start:download_end]

    assert "gpu_magnetization_upload_aos(" in upload_body
    assert "gpu_component_upload_aos(" not in upload_body
    assert "state.lifecycle" in upload_body
    assert "state.magnetization" in upload_body
    assert "gpu_magnetization_download_aos(" in download_body
    assert "gpu_component_download_aos(" not in download_body
    assert "state.lifecycle" in download_body
    assert "state.magnetization" in download_body
    assert "gpu_component_upload_aos(" in magnetization_transfer_source
    assert "gpu_component_download_aos(" in magnetization_transfer_source
    assert "fullmag_cuda_upload_aos_to_soa(" not in upload_body
    assert "fullmag_cuda_download_soa_to_aos(" not in download_body
    assert "state.residency.device_state = FemGpuSyncState::DeviceClean" in upload_body
    assert "state.rk.fsal_valid = false" in upload_body
    assert "state.residency.host_state = FemGpuSyncState::HostClean" in download_body


def test_gpu_cuda_vector_field_kernels_are_owned_by_fields_module():
    kernel_source = read_optional_text(KERNELS_CU_PATH)
    vector_header = GPU_VECTOR_FIELD_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    vector_source = GPU_VECTOR_FIELD_KERNELS_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/fields/vector_field_kernels.cu" in cmake
    assert "gpu/cuda/kernels/kernels.cu" not in cmake
    assert not KERNELS_CU_PATH.exists()
    assert "GPU CUDA vector field kernels module header" in vector_header
    assert "fullmag_cuda_normalize_vectors(" in vector_header
    assert "fullmag_cuda_accumulate_heff(" in vector_header
    assert "fullmag_cuda_zero_indexed_values(" in vector_header
    assert "fullmag_cuda_add_field_inplace(" in vector_header
    assert "GPU CUDA vector field kernels source contract" in vector_source
    assert "normalize_unit_vectors_kernel" in vector_source
    assert "accumulate_heff_kernel" in vector_source
    assert "zero_indexed_values_kernel" in vector_source
    assert "add_field_inplace_kernel" in vector_source
    assert "fullmag_cuda_normalize_vectors(" not in kernel_source
    assert "fullmag_cuda_accumulate_heff(" not in kernel_source
    assert "fullmag_cuda_zero_indexed_values(" not in kernel_source
    assert "fullmag_cuda_add_field_inplace(" not in kernel_source


def test_gpu_cuda_demag_kernels_are_owned_by_demag_poisson_module():
    kernel_source = read_optional_text(KERNELS_CU_PATH)
    demag_header = GPU_DEMAG_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    demag_source = GPU_DEMAG_KERNELS_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/demag_poisson/demag_kernels.cu" in cmake
    assert "gpu/cuda/kernels/demag_kernels.cu" not in cmake
    assert "GPU CUDA demag kernels module header" in demag_header
    assert "fullmag_cuda_demag_rhs_csr(" in demag_header
    assert "fullmag_cuda_demag_recovery_csr(" in demag_header
    assert "fullmag_cuda_demag_energy_blocks(" in demag_header
    assert "fullmag_cuda_demag_robin_boundary_energy_blocks(" in demag_header
    assert "GPU CUDA demag kernels source contract" in demag_source
    assert '#include "gpu/cuda/demag_poisson/demag_kernels.hpp"' in demag_source
    assert "demag_rhs_csr_kernel" in demag_source
    assert "demag_recovery_csr_kernel" in demag_source
    assert "demag_energy_blocks_kernel" in demag_source
    assert "demag_robin_boundary_energy_blocks_kernel" in demag_source
    assert "fullmag_cuda_demag_rhs_csr(" not in kernel_source
    assert "fullmag_cuda_demag_recovery_csr(" not in kernel_source
    assert "fullmag_cuda_demag_energy_blocks(" not in kernel_source
    assert "fullmag_cuda_demag_robin_boundary_energy_blocks(" not in kernel_source


def test_gpu_demag_poisson_device_state_is_owned_by_demag_poisson_module():
    state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    demag_state_header = GPU_DEMAG_STATE_HPP_PATH.read_text(encoding="utf-8")
    demag_stage_source = GPU_DEMAG_STAGE_COMPUTE_CPP_PATH.read_text(encoding="utf-8")
    demag_dispatch_source = GPU_RK_DEMAG_DISPATCH_CU_PATH.read_text(encoding="utf-8")

    assert "GPU CUDA Poisson demag device-state module header" in demag_state_header
    assert '#include "gpu/cuda/state/component_field.hpp"' in demag_state_header
    assert "struct FemGpuDemagPoissonDeviceState" in demag_state_header
    assert "double *poisson_rhs = nullptr" in demag_state_header
    assert "double *poisson_solution = nullptr" in demag_state_header
    assert "FemGpuComponentField poisson_gradient" in demag_state_header
    assert "std::vector<double> hybrid_stage_m_xyz" in demag_state_header
    assert "std::vector<double> hybrid_demag_xyz" in demag_state_header
    assert "double hybrid_demag_energy_joules = 0.0" in demag_state_header
    assert '#include "gpu/cuda/demag_poisson/demag_state.hpp"' in state_header
    assert "FemGpuDemagPoissonDeviceState demag_poisson{}" in state_header
    for flat_member in (
        "double *poisson_rhs = nullptr",
        "double *poisson_solution = nullptr",
        "FemGpuComponentField poisson_gradient",
        "std::vector<double> hybrid_stage_m_xyz",
        "std::vector<double> hybrid_demag_xyz",
        "double hybrid_demag_energy_joules = 0.0",
    ):
        assert flat_member not in state_header
    for state_member in (
        "state.demag_poisson.poisson_rhs",
        "state.demag_poisson.poisson_solution",
        "state.demag_poisson.poisson_gradient",
        "state.demag_poisson.hybrid_stage_m_xyz",
        "state.demag_poisson.hybrid_demag_xyz",
        "state.demag_poisson.hybrid_demag_energy_joules",
    ):
        assert state_member in state_source
    assert "state.poisson_rhs" not in state_source
    assert "state.hybrid_demag_xyz" not in state_source
    assert "gpu.demag_poisson.poisson_rhs" in demag_stage_source
    assert "gpu.demag_poisson.poisson_solution" in demag_stage_source
    assert "gpu.poisson_rhs" not in demag_stage_source
    assert "gpu.demag_poisson.hybrid_stage_m_xyz" in demag_dispatch_source
    assert "gpu.demag_poisson.hybrid_demag_xyz" in demag_dispatch_source
    assert "gpu.demag_poisson.hybrid_demag_energy_joules" in demag_dispatch_source
    assert "gpu.hybrid_demag_xyz" not in demag_dispatch_source


def test_gpu_cuda_owner_modules_do_not_include_kernel_compatibility_umbrella():
    cuda_root = REPO_ROOT / "backends" / "fem" / "gpu" / "cuda"
    offenders = []
    for source_path in cuda_root.rglob("*"):
        if source_path == KERNELS_HPP_PATH or source_path.suffix not in {
            ".cpp",
            ".cu",
            ".hpp",
        }:
            continue
        source = source_path.read_text(encoding="utf-8")
        if '#include "gpu/cuda/kernels/kernels.hpp"' in source:
            offenders.append(source_path.relative_to(REPO_ROOT).as_posix())

    assert offenders == []


def test_gpu_cuda_kernel_compatibility_umbrella_is_removed():
    source_facade_contract = FEM_SOURCE_FACADE_CONTRACT_PATH.read_text(
        encoding="utf-8"
    )

    assert not KERNELS_HPP_PATH.exists()
    assert 'read_optional_text_file(root / "gpu" / "cuda" / "kernels"' not in source_facade_contract
    assert "kernels_header.find(" not in source_facade_contract
    assert "kernels_source.find(" not in source_facade_contract


def test_gpu_rk_stage_kernels_are_owned_by_rk_module():
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    predictor_header = GPU_RK_STAGE_PREDICTOR_KERNELS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    predictor_source = GPU_RK_STAGE_PREDICTOR_KERNELS_CU_PATH.read_text(
        encoding="utf-8"
    )
    heun_accept_header = GPU_RK_HEUN_ACCEPT_KERNEL_HPP_PATH.read_text(encoding="utf-8")
    heun_accept_source = GPU_RK_HEUN_ACCEPT_KERNEL_CU_PATH.read_text(encoding="utf-8")
    rk4_accept_header = GPU_RK_RK4_ACCEPT_KERNEL_HPP_PATH.read_text(encoding="utf-8")
    rk4_accept_source = GPU_RK_RK4_ACCEPT_KERNEL_CU_PATH.read_text(encoding="utf-8")
    bs23_accept_header = GPU_RK_BS23_ACCEPT_KERNEL_HPP_PATH.read_text(encoding="utf-8")
    bs23_accept_source = GPU_RK_BS23_ACCEPT_KERNEL_CU_PATH.read_text(encoding="utf-8")
    dp54_accept_header = GPU_RK_DP54_ACCEPT_KERNEL_HPP_PATH.read_text(encoding="utf-8")
    dp54_accept_source = GPU_RK_DP54_ACCEPT_KERNEL_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_stage_kernels.cu" not in cmake
    assert "gpu/cuda/integrators/rk/rk_stage_accept_kernels.cu" not in cmake
    assert not GPU_RK_STAGE_KERNELS_CU_PATH.exists()
    assert not GPU_RK_STAGE_KERNELS_HPP_PATH.exists()
    assert not GPU_RK_STAGE_ACCEPT_KERNELS_CU_PATH.exists()
    assert not GPU_RK_STAGE_ACCEPT_KERNELS_HPP_PATH.exists()
    assert "gpu/cuda/integrators/rk/rk_stage_predictor_kernels.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_heun_accept_kernel.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_rk4_accept_kernel.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_bs23_accept_kernel.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_dp54_accept_kernel.cu" in cmake
    assert "GPU CUDA RK stage predictor kernels module header" in predictor_header
    for predictor_wrapper in (
        "fullmag_cuda_euler_stage(",
        "fullmag_cuda_rk45_stage(",
    ):
        assert predictor_wrapper in predictor_header
        assert predictor_wrapper in predictor_source
    for accept_wrapper in (
        "fullmag_cuda_heun_accept(",
        "fullmag_cuda_rk4_accept(",
        "fullmag_cuda_bs23_accept(",
        "fullmag_cuda_dp54_accept(",
    ):
        assert accept_wrapper in (
            heun_accept_header
            + rk4_accept_header
            + bs23_accept_header
            + dp54_accept_header
        )
    assert "GPU CUDA RK Heun accept kernel module header" in heun_accept_header
    assert "GPU CUDA RK Heun accept kernel source contract" in heun_accept_source
    assert '#include "gpu/cuda/integrators/rk/rk_heun_accept_kernel.hpp"' in heun_accept_source
    assert "fullmag_cuda_heun_accept(" in heun_accept_header
    assert "fullmag_cuda_heun_accept(" in heun_accept_source
    assert "heun_accept_kernel" in heun_accept_source
    assert "GPU CUDA RK RK4 accept kernel module header" in rk4_accept_header
    assert "GPU CUDA RK RK4 accept kernel source contract" in rk4_accept_source
    assert '#include "gpu/cuda/integrators/rk/rk_rk4_accept_kernel.hpp"' in rk4_accept_source
    assert "fullmag_cuda_rk4_accept(" in rk4_accept_header
    assert "fullmag_cuda_rk4_accept(" in rk4_accept_source
    assert "rk4_accept_kernel" in rk4_accept_source
    assert "GPU CUDA RK BS23 accept kernel module header" in bs23_accept_header
    assert "GPU CUDA RK BS23 accept kernel source contract" in bs23_accept_source
    assert '#include "gpu/cuda/integrators/rk/rk_bs23_accept_kernel.hpp"' in bs23_accept_source
    assert "fullmag_cuda_bs23_accept(" in bs23_accept_header
    assert "fullmag_cuda_bs23_accept(" in bs23_accept_source
    assert "bs23_accept_kernel" in bs23_accept_source
    assert "GPU CUDA RK DP54 accept kernel module header" in dp54_accept_header
    assert "GPU CUDA RK DP54 accept kernel source contract" in dp54_accept_source
    assert '#include "gpu/cuda/integrators/rk/rk_dp54_accept_kernel.hpp"' in dp54_accept_source
    assert "fullmag_cuda_dp54_accept(" in dp54_accept_header
    assert "fullmag_cuda_dp54_accept(" in dp54_accept_source
    assert "dp54_accept_kernel" in dp54_accept_source
    assert "GPU CUDA RK stage predictor kernels source contract" in predictor_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_stage_predictor_kernels.hpp"'
        in predictor_source
    )
    for predictor_kernel in (
        "euler_stage_kernel",
        "rk45_stage_kernel",
    ):
        assert predictor_kernel in predictor_source
        assert f"__global__ void {predictor_kernel}" not in rk_step_source
    for accept_kernel in (
        "heun_accept_kernel",
        "rk4_accept_kernel",
        "bs23_accept_kernel",
        "dp54_accept_kernel",
    ):
        assert f"__global__ void {accept_kernel}" not in rk_step_source
    for non_owner in (
        "gpu_rk_device_resident_step(",
        "compute_rhs_for_magnetization(",
    ):
        assert non_owner not in predictor_source


def test_gpu_rk_stage_schedule_is_owned_by_rk_module():
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    schedule_header = GPU_RK_STAGE_SCHEDULE_HPP_PATH.read_text(encoding="utf-8")
    schedule_source = GPU_RK_STAGE_SCHEDULE_CU_PATH.read_text(encoding="utf-8")
    rk45_header = GPU_RK45_STAGE_SEQUENCE_HPP_PATH.read_text(encoding="utf-8")
    rk45_source = GPU_RK45_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    rk4_header = GPU_RK4_STAGE_SEQUENCE_HPP_PATH.read_text(encoding="utf-8")
    rk4_source = GPU_RK4_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    rk23_header = GPU_RK23_STAGE_SEQUENCE_HPP_PATH.read_text(encoding="utf-8")
    rk23_source = GPU_RK23_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    heun_header = GPU_HEUN_STAGE_SEQUENCE_HPP_PATH.read_text(encoding="utf-8")
    heun_source = GPU_HEUN_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    rk23_adaptive_header = GPU_RK23_ADAPTIVE_K3_HPP_PATH.read_text(encoding="utf-8")
    rk23_adaptive_source = GPU_RK23_ADAPTIVE_K3_CU_PATH.read_text(encoding="utf-8")
    attempt_setup_header = GPU_RK_ATTEMPT_SETUP_HPP_PATH.read_text(encoding="utf-8")
    attempt_setup_source = GPU_RK_ATTEMPT_SETUP_CU_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_stage_schedule.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk45_stage_sequence.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.cu" not in cmake
    assert not GPU_RK4_RK23_STAGE_SEQUENCE_CU_PATH.exists()
    assert not GPU_RK4_RK23_STAGE_SEQUENCE_HPP_PATH.exists()
    assert "gpu/cuda/integrators/rk/rk4_stage_sequence.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk23_stage_sequence.cu" in cmake
    assert "gpu/cuda/integrators/rk/heun_stage_sequence.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk23_adaptive_k3.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_attempt_setup.cu" in cmake
    assert '#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"' in attempt_loop_source
    assert '#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"' not in rk_step_source
    assert "GPU CUDA RK stage schedule module header" in schedule_header
    assert "struct GpuRkStageAttemptResult" in schedule_header
    assert "gpu_rk_run_stage_attempt(" in schedule_header
    assert "GPU CUDA RK stage schedule source contract" in schedule_source
    assert '#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"' in schedule_source
    assert '#include "gpu/cuda/integrators/rk/rk45_stage_sequence.hpp"' in schedule_source
    assert '#include "gpu/cuda/integrators/rk/rk4_stage_sequence.hpp"' in schedule_source
    assert '#include "gpu/cuda/integrators/rk/rk23_stage_sequence.hpp"' in schedule_source
    assert '#include "gpu/cuda/integrators/rk/rk4_rk23_stage_sequence.hpp"' not in schedule_source
    assert '#include "gpu/cuda/integrators/rk/heun_stage_sequence.hpp"' in schedule_source
    assert '#include "gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp"' in schedule_source
    assert '#include "gpu/cuda/integrators/rk/rk_attempt_setup.hpp"' in schedule_source
    assert (
        "gpu_rk_prepare_stage_attempt(ctx, stream, n, is_heun, is_rk45, fsal_method, active_dt, stage_rhs_evaluations, fsal_reused, reason)"
        in schedule_source
    )
    assert (
        "gpu_rk_run_rk45_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)"
        in schedule_source
    )
    assert (
        "gpu_rk_run_rk4_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)"
        in schedule_source
    )
    assert (
        "gpu_rk_run_rk23_stage_sequence(ctx, stream, n, active_dt, stage_rhs_evaluations, reason)"
        in schedule_source
    )
    assert "gpu_rk_run_heun_stage_sequence(ctx, stream, n, active_dt)" in schedule_source
    assert (
        "gpu_rk_compute_rk23_adaptive_k3(ctx, stream, n, stage_rhs_evaluations, reason)"
        in schedule_source
    )
    assert "GPU CUDA Heun stage sequence module header" in heun_header
    assert "gpu_rk_run_heun_stage_sequence(" in heun_header
    assert "GPU CUDA Heun stage sequence source contract" in heun_source
    assert '#include "gpu/cuda/integrators/rk/heun_stage_sequence.hpp"' in heun_source
    assert "fullmag_cuda_heun_accept(" in heun_source
    assert "GPU CUDA RK45 stage sequence module header" in rk45_header
    assert "gpu_rk_run_rk45_stage_sequence(" in rk45_header
    assert "GPU CUDA RK45 stage sequence source contract" in rk45_source
    assert '#include "gpu/cuda/integrators/rk/rk45_stage_sequence.hpp"' in rk45_source
    assert "fullmag_cuda_rk45_stage(" in rk45_source
    assert "fullmag_cuda_dp54_accept(" in rk45_source
    assert "launch GPU RK45 stage-6 h_eff accumulation" in rk45_source
    assert "stage_rhs_evaluations += 1" in rk45_source
    assert "GPU CUDA RK4 stage sequence module header" in rk4_header
    assert "gpu_rk_run_rk4_stage_sequence(" in rk4_header
    assert "GPU CUDA RK4 stage sequence source contract" in rk4_source
    assert '#include "gpu/cuda/integrators/rk/rk4_stage_sequence.hpp"' in rk4_source
    assert "fullmag_cuda_euler_stage(" in rk4_source
    assert "fullmag_cuda_rk4_accept(" in rk4_source
    assert "fullmag_cuda_bs23_accept(" not in rk4_source
    assert "launch GPU RK stage-2 h_eff accumulation" in rk4_source
    assert "launch GPU RK stage-3 h_eff accumulation" in rk4_source
    assert "stage_rhs_evaluations += 1" in rk4_source
    assert "GPU CUDA RK23 BS23 stage sequence module header" in rk23_header
    assert "gpu_rk_run_rk23_stage_sequence(" in rk23_header
    assert "GPU CUDA RK23 BS23 stage sequence source contract" in rk23_source
    assert '#include "gpu/cuda/integrators/rk/rk23_stage_sequence.hpp"' in rk23_source
    assert "fullmag_cuda_euler_stage(" in rk23_source
    assert "fullmag_cuda_bs23_accept(" in rk23_source
    assert "fullmag_cuda_rk4_accept(" not in rk23_source
    assert "launch GPU RK stage-2 h_eff accumulation" in rk23_source
    assert "stage_rhs_evaluations += 1" in rk23_source
    assert "GPU CUDA RK23 adaptive k3 module header" in rk23_adaptive_header
    assert "gpu_rk_compute_rk23_adaptive_k3(" in rk23_adaptive_header
    assert "GPU CUDA RK23 adaptive k3 source contract" in rk23_adaptive_source
    assert '#include "gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp"' in rk23_adaptive_source
    assert "gpu_rk_compute_rhs_for_magnetization(" in rk23_adaptive_source
    assert "launch GPU RK23 BS23 k3 for adaptive error estimate" in rk23_adaptive_source
    assert "stage_rhs_evaluations += 1" in rk23_adaptive_source
    assert "GPU CUDA RK attempt setup module header" in attempt_setup_header
    assert "gpu_rk_prepare_stage_attempt(" in attempt_setup_header
    assert "GPU CUDA RK attempt setup source contract" in attempt_setup_source
    assert '#include "gpu/cuda/integrators/rk/rk_attempt_setup.hpp"' in attempt_setup_source
    assert "gpu_rk_copy_component_device(" in attempt_setup_source
    assert "fsal_reused = fsal_method && gpu.rk.fsal_valid" in attempt_setup_source
    assert "gpu_rk_compute_rhs_for_magnetization(" in attempt_setup_source
    assert "fullmag_cuda_euler_stage(" in attempt_setup_source
    assert "launch GPU RK stage-0 h_eff accumulation" in attempt_setup_source
    assert "launch GPU RK stage-1 h_eff accumulation" in attempt_setup_source
    assert "stage_rhs_evaluations += 1" in attempt_setup_source
    assert "fullmag_cuda_rk45_stage(" not in schedule_source
    assert "fullmag_cuda_dp54_accept(" not in schedule_source
    assert "fullmag_cuda_rk4_accept(" not in schedule_source
    assert "fullmag_cuda_bs23_accept(" not in schedule_source
    assert "fullmag_cuda_heun_accept(" not in schedule_source
    assert "launch GPU RK23 BS23 k3 for adaptive error estimate" not in schedule_source
    assert "gpu_rk_copy_component_device(" not in schedule_source
    assert "fsal_reused = fsal_method && gpu.rk.fsal_valid" not in schedule_source
    assert "gpu_rk_compute_rhs_for_magnetization(" not in schedule_source
    assert "fullmag_cuda_euler_stage(" not in schedule_source
    assert "launch GPU RK stage-0 h_eff accumulation" not in schedule_source
    assert "launch GPU RK stage-1 h_eff accumulation" not in schedule_source
    assert "result.rhs_evaluations = stage_rhs_evaluations" in schedule_source
    assert "bool gpu_rk_device_resident_step(" not in schedule_source
    assert "gpu_rk_adaptive_pi_step(" not in schedule_source
    assert "gpu_rk_finalize_accepted_step(" not in schedule_source
    assert "bool gpu_rk_device_resident_step(" not in rk45_source
    assert "gpu_rk_adaptive_pi_step(" not in rk45_source
    assert "gpu_rk_finalize_accepted_step(" not in rk45_source
    assert "fullmag_cuda_bs23_accept(" not in rk45_source
    assert "fullmag_cuda_heun_accept(" not in rk45_source
    assert "fullmag_cuda_rk4_accept(" not in rk45_source
    assert "bool gpu_rk_device_resident_step(" not in heun_source
    assert "gpu_rk_adaptive_pi_step(" not in heun_source
    assert "gpu_rk_finalize_accepted_step(" not in heun_source
    assert "fullmag_cuda_rk45_stage(" not in heun_source
    assert "fullmag_cuda_dp54_accept(" not in heun_source
    assert "fullmag_cuda_rk4_accept(" not in heun_source
    assert "fullmag_cuda_bs23_accept(" not in heun_source
    assert "launch GPU RK23 BS23 k3 for adaptive error estimate" not in heun_source
    for sequence_source in (rk4_source, rk23_source):
        assert "bool gpu_rk_device_resident_step(" not in sequence_source
        assert "gpu_rk_adaptive_pi_step(" not in sequence_source
        assert "gpu_rk_finalize_accepted_step(" not in sequence_source
        assert "fullmag_cuda_rk45_stage(" not in sequence_source
        assert "fullmag_cuda_dp54_accept(" not in sequence_source
        assert "fullmag_cuda_heun_accept(" not in sequence_source
        assert "launch GPU RK23 BS23 k3 for adaptive error estimate" not in sequence_source
    assert "bool gpu_rk_device_resident_step(" not in rk23_adaptive_source
    assert "gpu_rk_adaptive_pi_step(" not in rk23_adaptive_source
    assert "gpu_rk_finalize_accepted_step(" not in rk23_adaptive_source
    assert "fullmag_cuda_heun_accept(" not in rk23_adaptive_source
    assert "fullmag_cuda_rk4_accept(" not in rk23_adaptive_source
    assert "fullmag_cuda_bs23_accept(" not in rk23_adaptive_source
    assert "fullmag_cuda_rk45_stage(" not in rk23_adaptive_source
    assert "fullmag_cuda_dp54_accept(" not in rk23_adaptive_source
    assert "bool gpu_rk_device_resident_step(" not in attempt_setup_source
    assert "gpu_rk_adaptive_pi_step(" not in attempt_setup_source
    assert "gpu_rk_finalize_accepted_step(" not in attempt_setup_source
    assert "fullmag_cuda_heun_accept(" not in attempt_setup_source
    assert "fullmag_cuda_rk4_accept(" not in attempt_setup_source
    assert "fullmag_cuda_bs23_accept(" not in attempt_setup_source
    assert "fullmag_cuda_rk45_stage(" not in attempt_setup_source
    assert "fullmag_cuda_dp54_accept(" not in attempt_setup_source
    assert "launch GPU RK23 BS23 k3 for adaptive error estimate" not in attempt_setup_source
    assert "fullmag_cuda_rk45_stage(" not in rk_step_source
    assert "fullmag_cuda_heun_accept(" not in rk_step_source
    assert "launch GPU RK23 BS23 k3 for adaptive error estimate" not in rk_step_source


def test_gpu_rk_step_preflight_is_owned_by_rk_module():
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    preflight_header = GPU_RK_STEP_PREFLIGHT_HPP_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_step_preflight.cu" in cmake
    assert '#include "gpu/cuda/integrators/rk/rk_step_preflight.hpp"' in rk_step_source
    assert "GPU CUDA RK step preflight module header" in preflight_header
    assert "struct GpuRkStepPreflight" in preflight_header
    assert "gpu_rk_prepare_step_preflight(" in preflight_header
    assert "GPU CUDA RK step preflight source contract" in preflight_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_preflight.hpp"' in preflight_source
    assert '#include "gpu/cuda/integrators/rk/rk.hpp"' in preflight_source
    assert '#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"' in preflight_source
    assert '#include "gpu/cuda/state/gpu_state.hpp"' in preflight_source
    assert "gpu_rk_plan_device_resident(ctx, reason)" in preflight_source
    assert "FULLMAG_FEM_INTEGRATOR_HEUN" in preflight_source
    assert "FULLMAG_FEM_INTEGRATOR_RK4" in preflight_source
    assert "FULLMAG_FEM_INTEGRATOR_RK23_BS" in preflight_source
    assert "FULLMAG_FEM_INTEGRATOR_RK45_DP54" in preflight_source
    assert (
        "GPU RK execution surface currently implements fixed-step Heun, RK4, RK23, and RK45 only"
    ) in preflight_source
    assert "GPU RK device-resident step requires a positive dt" in preflight_source
    assert "FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH" in preflight_source
    assert "GPU RK device-resident step requires FemGpuState device source of truth" in preflight_source
    assert "legacy_sparse_gpu" in preflight_source
    assert "GPU RK device-resident step requires legacy_sparse_gpu exchange operator mode" in preflight_source
    assert "reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream)" in preflight_source
    assert "result.adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled" in preflight_source
    assert (
        "result.fsal_method = (result.is_rk23 || result.is_rk45) && "
        "gpu_rk_rhs_allows_fsal_reuse(ctx)"
    ) in preflight_source
    assert "gpu_rk_prepare_step_preflight(" in rk_step_source
    assert "preflight.n" in rk_step_source
    assert "preflight.blocks" in rk_step_source
    assert "preflight.stream" in rk_step_source
    assert "preflight.is_heun" in rk_step_source
    assert "preflight.fsal_method" in rk_step_source
    for delegated in (
        "gpu_rk_plan_device_resident(ctx, reason)",
        "GPU RK device-resident step requires a positive dt",
        "FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH",
        "GPU RK device-resident step requires legacy_sparse_gpu exchange operator mode",
        "const bool adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled",
        "const bool fsal_method = (is_rk23 || is_rk45) && gpu_rk_rhs_allows_fsal_reuse(ctx)",
    ):
        assert delegated not in rk_step_source


def test_gpu_rk_device_io_helpers_are_owned_by_rk_module():
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    adaptive_source = GPU_RK_ADAPTIVE_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    demag_source = GPU_RK_DEMAG_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    attempt_setup_source = GPU_RK_ATTEMPT_SETUP_CU_PATH.read_text(encoding="utf-8")
    stats_source = GPU_RK_STEP_STATS_CU_PATH.read_text(encoding="utf-8")
    schedule_source = GPU_RK_STAGE_SCHEDULE_CU_PATH.read_text(encoding="utf-8")
    scalar_header = GPU_RK_SCALAR_READBACK_HPP_PATH.read_text(encoding="utf-8")
    scalar_source = GPU_RK_SCALAR_READBACK_CU_PATH.read_text(encoding="utf-8")
    component_header = GPU_RK_COMPONENT_COPY_HPP_PATH.read_text(encoding="utf-8")
    component_source = GPU_RK_COMPONENT_COPY_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_device_io.cu" not in cmake
    assert not GPU_RK_DEVICE_IO_CU_PATH.exists()
    assert not GPU_RK_DEVICE_IO_HPP_PATH.exists()
    assert "gpu/cuda/integrators/rk/rk_scalar_readback.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_component_copy.cu" in cmake
    for source in (
        adaptive_source,
        demag_source,
        refresh_source,
        attempt_setup_source,
        stats_source,
        schedule_source,
    ):
        assert '#include "gpu/cuda/integrators/rk/rk_device_io.hpp"' not in source
    for source in (
        adaptive_source,
        demag_source,
        refresh_source,
        attempt_setup_source,
    ):
        assert '#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"' in source
    assert '#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"' in stats_source
    assert "GPU CUDA RK scalar readback module header" in scalar_header
    assert "GPU CUDA RK component copy module header" in component_header
    for scalar_helper in (
        "gpu_rk_read_scalar_result(",
        "gpu_rk_read_scalar_results(",
    ):
        assert scalar_helper in scalar_header
        assert scalar_helper in scalar_source
    for component_helper in (
        "gpu_rk_copy_component_device(",
        "gpu_rk_download_component_device_to_aos(",
    ):
        assert component_helper in component_header
        assert component_helper in component_source
    assert "GPU CUDA RK scalar readback source contract" in scalar_source
    assert '#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"' in scalar_source
    assert "cudaMemcpyAsync" in scalar_source
    assert "cudaStreamSynchronize" in scalar_source
    assert "record_device_to_host" in scalar_source
    assert "GPU CUDA RK component copy source contract" in component_source
    assert '#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"' in component_source
    assert "cudaMemcpyAsync" in component_source
    assert "cudaMemcpy2DAsync" in component_source
    assert "record_device_to_host" in component_source
    for old_definition in (
        "bool read_scalar_result(",
        "bool read_scalar_results(",
        "bool copy_component_device(",
        "bool download_component_device_to_aos(",
    ):
        assert old_definition not in rk_step_source
    assert "cudaMemcpy2DAsync(" not in rk_step_source
    assert "gpu_rk_device_resident_step(" not in scalar_source
    assert "compute_rhs_for_magnetization(" not in scalar_source
    assert "gpu_rk_device_resident_step(" not in component_source
    assert "compute_rhs_for_magnetization(" not in component_source


def test_gpu_rk_adaptive_runtime_helpers_are_owned_by_rk_module():
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    adaptive_header = GPU_RK_ADAPTIVE_RUNTIME_HPP_PATH.read_text(encoding="utf-8")
    adaptive_source = GPU_RK_ADAPTIVE_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    error_norm_header = GPU_RK_ERROR_NORM_RUNTIME_HPP_PATH.read_text(encoding="utf-8")
    error_norm_source = GPU_RK_ERROR_NORM_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    decision_header = GPU_RK_ADAPTIVE_DECISION_READBACK_HPP_PATH.read_text(
        encoding="utf-8"
    )
    decision_source = GPU_RK_ADAPTIVE_DECISION_READBACK_CU_PATH.read_text(
        encoding="utf-8"
    )
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_adaptive_runtime.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_error_norm_runtime.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu" in cmake
    assert '#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"' in attempt_loop_source
    assert '#include "gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp"' in attempt_loop_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"'
        in attempt_loop_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"' not in rk_step_source
    assert '#include "gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp"' not in rk_step_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"'
        not in rk_step_source
    )
    assert "GPU CUDA RK adaptive runtime module header" in adaptive_header
    for helper in (
        "GpuAdaptiveResult",
        "gpu_rk_adaptive_pi_step(",
        "gpu_rk_restore_adaptive_reject_magnetization_device(",
    ):
        assert helper in adaptive_header
        assert helper in adaptive_source
    assert "GPU CUDA RK adaptive runtime source contract" in adaptive_source
    assert '#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"' in adaptive_source
    assert "gpu_rk_copy_component_device(" in adaptive_source
    assert "ctx.adaptive_dt.prev_error_norm" in adaptive_source
    assert "gpu_rk_compute_adaptive_error_norm_device(" not in adaptive_header
    assert "gpu_rk_compute_adaptive_error_norm_device(" not in adaptive_source
    assert "fullmag_cuda_adaptive_error_norm_blocks(" not in adaptive_source
    assert "fullmag_cuda_device_max(" not in adaptive_source
    assert "gpu_rk_read_scalar_result(" not in adaptive_source
    assert "GPU CUDA RK adaptive error-norm runtime module header" in error_norm_header
    assert "gpu_rk_reduce_adaptive_error_norm_device(" in error_norm_header
    assert "GPU CUDA RK adaptive error-norm runtime source contract" in error_norm_source
    assert '#include "gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp"' in error_norm_source
    assert "gpu_rk_reduce_adaptive_error_norm_device(" in error_norm_source
    assert "fullmag_cuda_adaptive_error_norm_blocks(" in error_norm_source
    assert "fullmag_cuda_device_max(" in error_norm_source
    assert "gpu.reductions.scalar_workspace" in error_norm_source
    assert "gpu.reductions.temp_storage" in error_norm_source
    assert "GPU RK adaptive error norm" in error_norm_source
    assert "gpu_rk_read_scalar_result(" not in error_norm_source
    assert "cudaMemcpyAsync GPU RK adaptive error norm scalar device->host" not in error_norm_source
    assert "GPU CUDA RK adaptive decision readback module header" in decision_header
    assert "struct GpuAdaptiveDecisionReadback" in decision_header
    assert "gpu_rk_read_adaptive_error_norm_decision_host(" in decision_header
    assert "GPU CUDA RK adaptive decision readback source contract" in decision_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"'
        in decision_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"' in decision_source
    assert '#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"' in decision_source
    assert "gpu_rk_read_scalar_result(" not in decision_source
    assert "gpu_rk_read_control_scalar_result(" in decision_source
    assert "gpu_rk_adaptive_pi_step(ctx, error_norm)" in decision_source
    assert "cudaMemcpyAsync GPU RK adaptive decision control scalar device->host" in decision_source
    assert "gpu_rk_copy_component_device(" not in error_norm_source
    assert "gpu_rk_adaptive_pi_step(" not in error_norm_source
    assert "GpuAdaptiveResult gpu_adaptive_pi_step(" not in rk_step_source
    assert "bool restore_adaptive_reject_magnetization_device(" not in rk_step_source
    assert "bool compute_adaptive_error_norm_device(" not in rk_step_source
    assert "gpu_rk_device_resident_step(" not in adaptive_source
    assert "compute_rhs_for_magnetization(" not in adaptive_source
    assert "gpu_rk_device_resident_step(" not in error_norm_source
    assert "compute_rhs_for_magnetization(" not in error_norm_source
    assert "gpu_rk_device_resident_step(" not in decision_source
    assert "compute_rhs_for_magnetization(" not in decision_source


def test_gpu_rk_rhs_runtime_helpers_are_owned_by_rk_module():
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")
    rhs_header = GPU_RK_RHS_RUNTIME_HPP_PATH.read_text(encoding="utf-8")
    rhs_source = GPU_RK_RHS_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    fsal_header = GPU_RK_FSAL_POLICY_HPP_PATH.read_text(encoding="utf-8")
    fsal_source = GPU_RK_FSAL_POLICY_CPP_PATH.read_text(encoding="utf-8")
    exchange_header = GPU_RK_EXCHANGE_DISPATCH_HPP_PATH.read_text(encoding="utf-8")
    exchange_source = GPU_RK_EXCHANGE_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    demag_header = GPU_RK_DEMAG_DISPATCH_HPP_PATH.read_text(encoding="utf-8")
    demag_source = GPU_RK_DEMAG_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    llg_header = GPU_RK_LLG_RHS_DISPATCH_HPP_PATH.read_text(encoding="utf-8")
    llg_source = GPU_RK_LLG_RHS_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_rhs_runtime.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_fsal_policy.cpp" in cmake
    assert "gpu/cuda/integrators/rk/rk_exchange_dispatch.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_demag_dispatch.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.cu" in cmake
    assert '#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"' in preflight_source
    assert '#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"' not in rk_step_source
    assert '#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"' not in rk_step_source
    assert "GPU CUDA RK RHS runtime module header" in rhs_header
    assert "gpu_rk_compute_rhs_for_magnetization(" in rhs_header
    assert "gpu_rk_compute_rhs_for_magnetization(" in rhs_source
    assert "gpu_rk_rhs_allows_fsal_reuse(" not in rhs_header
    assert "gpu_rk_rhs_allows_fsal_reuse(" not in rhs_source
    assert "GPU CUDA RK FSAL policy module header" in fsal_header
    assert "gpu_rk_rhs_allows_fsal_reuse(" in fsal_header
    assert "GPU CUDA RK FSAL policy source contract" in fsal_source
    assert '#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"' in fsal_source
    assert "gpu_rk_rhs_allows_fsal_reuse(" in fsal_source
    assert "ctx.thermal_brown.temperature > 0.0" in fsal_source
    assert "ctx.oersted.time_dep_kind != 0u" in fsal_source
    assert "GPU CUDA RK RHS runtime source contract" in rhs_source
    assert '#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"' in rhs_source
    assert '#include "gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp"' in rhs_source
    assert "gpu_rk_compute_legacy_sparse_exchange(" in rhs_source
    assert "GPU CUDA RK exchange dispatch module header" in exchange_header
    assert "gpu_rk_compute_legacy_sparse_exchange(" in exchange_header
    assert "GPU CUDA RK exchange dispatch source contract" in exchange_source
    assert '#include "gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp"' in exchange_source
    assert "fullmag_cuda_legacy_sparse_exchange(" in exchange_source
    assert "GPU legacy sparse exchange requires uploaded CSR/mass device buffers" in exchange_source
    assert "GPU legacy sparse exchange dimensions do not match RK node_count" in exchange_source
    assert "fullmag_cuda_legacy_sparse_exchange(" not in rhs_source
    assert "GPU legacy sparse exchange requires uploaded CSR/mass device buffers" not in rhs_source
    assert '#include "gpu/cuda/integrators/rk/rk_demag_dispatch.hpp"' in rhs_source
    assert "gpu_rk_compute_demag_for_device_stage(ctx, m, stream, reason)" in rhs_source
    assert "GPU CUDA RK demag dispatch module header" in demag_header
    assert "gpu_rk_compute_demag_for_device_stage(" in demag_header
    assert "GPU CUDA RK demag dispatch source contract" in demag_source
    assert '#include "gpu/cuda/integrators/rk/rk_demag_dispatch.hpp"' in demag_source
    assert "gpu_rk_compute_hybrid_cpu_demag_for_device_stage(" in demag_source
    assert "compute_device_demag_for_device_stage(ctx, m, stream, reason)" in demag_source
    assert "compute_demag_field_for_magnetization(" in demag_source
    assert "gpu_state_upload_demag_field_aos(" in demag_source
    assert "FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON" in demag_source
    assert "gpu_rk_compute_hybrid_cpu_demag_for_device_stage(" not in rhs_source
    assert "compute_device_demag_for_device_stage(" not in rhs_source
    assert "compute_demag_field_for_magnetization(" not in rhs_source
    assert "gpu_state_upload_demag_field_aos(" not in rhs_source
    assert '#include "gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp"' in rhs_source
    assert "gpu_rk_compute_llg_rhs(ctx, m, rhs, stream, n, reason)" in rhs_source
    assert "GPU CUDA RK LLG RHS dispatch module header" in llg_header
    assert "gpu_rk_compute_llg_rhs(" in llg_header
    assert "GPU CUDA RK LLG RHS dispatch source contract" in llg_source
    assert '#include "gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp"' in llg_source
    assert "fullmag_cuda_llg_rhs_fused(" in llg_source
    assert "launch GPU RK RHS" in llg_source
    assert "ctx.base_plan.precession_enabled" in llg_source
    assert "ctx.material_fields.material.gyromagnetic_ratio" in llg_source
    assert "ctx.material_fields.material.damping" in llg_source
    assert "fullmag_cuda_llg_rhs_fused(" not in rhs_source
    assert "launch GPU RK RHS" not in rhs_source
    assert '#include "gpu/cuda/integrators/rk/rk_local_fields.hpp"' in rhs_source
    assert (
        "gpu_rk_compute_local_field_contributions(ctx, m, stream, n, reason)"
        in rhs_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_effective_field.hpp"' in rhs_source
    assert (
        "gpu_rk_accumulate_effective_field(ctx, stream, n, label, reason)"
        in rhs_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_direct_torques.hpp"' in rhs_source
    assert (
        "gpu_rk_add_direct_torques(ctx, m, rhs, stream, n, reason)"
        in rhs_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"' in rhs_source
    assert (
        "gpu_rk_compute_dmi_field_contributions(ctx, m, stream, n, reason)"
        in rhs_source
    )
    assert "gpu_rk_device_resident_step(" not in rhs_source
    assert "gpu_rk_finalize_step_stats(" not in rhs_source
    for local_generation_label in (
        "launch GPU RK uniaxial anisotropy field",
        "launch GPU RK cubic anisotropy field",
        "launch GPU RK magnetoelastic field",
        "launch GPU RK deterministic thermal field",
    ):
        assert local_generation_label not in rhs_source
    for old_definition in (
        "bool compute_rhs_for_magnetization(",
        "bool compute_legacy_sparse_exchange(",
        "bool compute_hybrid_cpu_demag_for_device_stage(",
    ):
        assert old_definition not in rk_step_source
    for h_eff_detail in (
        "fullmag_cuda_accumulate_heff(",
        "fullmag_cuda_add_field_inplace(",
        "fullmag_cuda_add_scaled_field_inplace(",
        "gpu_rk_oersted_scale(",
    ):
        assert h_eff_detail not in rhs_source
    for direct_torque_detail in (
        "fullmag_cuda_add_slonczewski_stt_rhs(",
        "fullmag_cuda_add_zhang_li_stt_rhs(",
        "gpu_rk_current_density_magnitude(",
    ):
        assert direct_torque_detail not in rhs_source
    for dmi_field_detail in (
        "fullmag_cuda_dmi_field_energy(",
        "auto compute_dmi_field",
        "launch GPU RK interfacial DMI field",
        "launch GPU RK bulk DMI field",
    ):
        assert dmi_field_detail not in rhs_source


def test_gpu_rk_local_fields_are_owned_by_rk_module():
    local_header = GPU_RK_LOCAL_FIELDS_HPP_PATH.read_text(encoding="utf-8")
    local_source = GPU_RK_LOCAL_FIELDS_CU_PATH.read_text(encoding="utf-8")
    anisotropy_header = GPU_RK_ANISOTROPY_FIELD_HPP_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_source = GPU_RK_ANISOTROPY_FIELD_CU_PATH.read_text(encoding="utf-8")
    magnetoelastic_header = GPU_RK_MAGNETOELASTIC_FIELD_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_source = GPU_RK_MAGNETOELASTIC_FIELD_CU_PATH.read_text(
        encoding="utf-8"
    )
    thermal_header = GPU_RK_THERMAL_FIELD_HPP_PATH.read_text(encoding="utf-8")
    thermal_source = GPU_RK_THERMAL_FIELD_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_local_fields.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_anisotropy_field.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_magnetoelastic_field.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_thermal_field.cu" in cmake
    assert "GPU CUDA RK local field contributions module header" in local_header
    assert "gpu_rk_compute_local_field_contributions(" in local_header
    assert "GPU CUDA RK local field contributions source contract" in local_source
    assert '#include "gpu/cuda/integrators/rk/rk_local_fields.hpp"' in local_source
    assert '#include "gpu/cuda/integrators/rk/rk_anisotropy_field.hpp"' in local_source
    assert '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp"' in local_source
    assert '#include "gpu/cuda/integrators/rk/rk_thermal_field.hpp"' in local_source
    assert (
        "gpu_rk_compute_anisotropy_field_contributions(ctx, m, stream, n, reason)"
        in local_source
    )
    assert (
        "gpu_rk_compute_magnetoelastic_field_contribution(ctx, m, stream, n, reason)"
        in local_source
    )
    assert "gpu_rk_compute_thermal_field_contribution(ctx, stream, n, reason)" in local_source
    assert "GPU CUDA RK anisotropy local field module header" in anisotropy_header
    assert "gpu_rk_compute_anisotropy_field_contributions(" in anisotropy_header
    assert "GPU CUDA RK anisotropy local field source contract" in anisotropy_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_anisotropy_field.hpp"'
        in anisotropy_source
    )
    assert (
        '#include "gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp"'
        in anisotropy_source
    )
    assert "GPU CUDA RK magnetoelastic local field module header" in magnetoelastic_header
    assert "gpu_rk_compute_magnetoelastic_field_contribution(" in magnetoelastic_header
    assert "GPU CUDA RK magnetoelastic local field source contract" in magnetoelastic_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp"'
        in magnetoelastic_source
    )
    assert "GPU CUDA RK thermal local field module header" in thermal_header
    assert "gpu_rk_compute_thermal_field_contribution(" in thermal_header
    assert "GPU CUDA RK thermal local field source contract" in thermal_source
    assert '#include "gpu/cuda/integrators/rk/rk_thermal_field.hpp"' in thermal_source
    for wrapper in (
        "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(",
        "fullmag_cuda_cubic_anisotropy_field_energy_blocks(",
    ):
        assert wrapper in anisotropy_source
        assert wrapper not in local_source
    for delegated in (
        "launch GPU RK uniaxial anisotropy field",
        "launch GPU RK cubic anisotropy field",
        "GPU RK uniaxial anisotropy requires device-resident Ms, Ku, Ku2, lumped mass, and H_ani buffers",
        "GPU RK cubic anisotropy requires device-resident Ms, Kc1/Kc2/Kc3, lumped mass, and H_cubic buffers",
    ):
        assert delegated in anisotropy_source
        assert delegated not in local_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" in magnetoelastic_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" not in local_source
    assert "launch GPU RK magnetoelastic field" in magnetoelastic_source
    assert "launch GPU RK magnetoelastic field" not in local_source
    assert "fullmag_cuda_thermal_field_blocks(" in thermal_source
    assert "fullmag_cuda_thermal_field_blocks(" not in local_source
    assert "launch GPU RK deterministic thermal field" in thermal_source
    assert "launch GPU RK deterministic thermal field" not in local_source
    for non_owner in (
        "gpu_rk_compute_rhs_for_magnetization(",
        "gpu_rk_compute_legacy_sparse_exchange(",
        "compute_device_demag_for_device_stage(",
        "fullmag_cuda_llg_rhs_fused(",
    ):
        assert non_owner not in local_source


def test_gpu_rk_thermal_field_is_owned_by_rk_module():
    local_source = GPU_RK_LOCAL_FIELDS_CU_PATH.read_text(encoding="utf-8")
    thermal_header = GPU_RK_THERMAL_FIELD_HPP_PATH.read_text(encoding="utf-8")
    thermal_source = GPU_RK_THERMAL_FIELD_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_thermal_field.cu" in cmake
    assert '#include "gpu/cuda/integrators/rk/rk_thermal_field.hpp"' in local_source
    assert "gpu_rk_compute_thermal_field_contribution(ctx, stream, n, reason)" in local_source
    assert "GPU CUDA RK thermal local field module header" in thermal_header
    assert "gpu_rk_compute_thermal_field_contribution(" in thermal_header
    assert "GPU CUDA RK thermal local field source contract" in thermal_source
    assert '#include "gpu/cuda/integrators/rk/rk_thermal_field.hpp"' in thermal_source
    assert '#include "gpu/cuda/interactions/thermal/thermal_kernels.hpp"' in thermal_source
    assert "ctx.thermal_brown.temperature <= 0.0" in thermal_source
    assert "ctx.thermal_brown.seed == 0" in thermal_source
    assert "ctx.adaptive_dt.current_dt <= 0.0" in thermal_source
    assert "fullmag_cuda_thermal_field_blocks(" in thermal_source
    assert "launch GPU RK deterministic thermal field" in thermal_source
    assert (
        "GPU RK thermal field requires deterministic thermal seed"
        in thermal_source
    )
    assert "GPU RK thermal field requires positive timestep" in thermal_source
    assert (
        "GPU RK thermal field requires device-resident Ms, alpha, node volumes, and H_therm buffers"
        in thermal_source
    )
    for delegated in (
        "fullmag_cuda_thermal_field_blocks(",
        "launch GPU RK deterministic thermal field",
        "GPU RK thermal field requires deterministic thermal seed",
        "GPU RK thermal field requires positive timestep",
        "GPU RK thermal field requires device-resident Ms, alpha, node volumes, and H_therm buffers",
    ):
        assert delegated not in local_source


def test_gpu_rk_magnetoelastic_field_is_owned_by_rk_module():
    local_source = GPU_RK_LOCAL_FIELDS_CU_PATH.read_text(encoding="utf-8")
    magnetoelastic_header = GPU_RK_MAGNETOELASTIC_FIELD_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_source = GPU_RK_MAGNETOELASTIC_FIELD_CU_PATH.read_text(
        encoding="utf-8"
    )
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_magnetoelastic_field.cu" in cmake
    assert '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp"' in local_source
    assert (
        "gpu_rk_compute_magnetoelastic_field_contribution(ctx, m, stream, n, reason)"
        in local_source
    )
    assert "GPU CUDA RK magnetoelastic local field module header" in magnetoelastic_header
    assert "gpu_rk_compute_magnetoelastic_field_contribution(" in magnetoelastic_header
    assert "GPU CUDA RK magnetoelastic local field source contract" in magnetoelastic_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp"'
        in magnetoelastic_source
    )
    assert (
        '#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp"'
        in magnetoelastic_source
    )
    assert "ctx.magnetoelastic.enabled" in magnetoelastic_source
    assert "GPU RK magnetoelastic field requires prescribed strain data" in magnetoelastic_source
    assert (
        "GPU RK magnetoelastic field requires 6 prescribed strain Voigt values per node"
        in magnetoelastic_source
    )
    assert (
        "GPU RK magnetoelastic field requires device-resident per-node strain"
        in magnetoelastic_source
    )
    assert (
        "GPU RK magnetoelastic field requires device-resident Ms, lumped mass, and H_mel buffers"
        in magnetoelastic_source
    )
    assert (
        "use_per_node_strain ? gpu.magnetoelastic.strain_voigt : nullptr"
        in magnetoelastic_source
    )
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" in magnetoelastic_source
    assert "launch GPU RK magnetoelastic field" in magnetoelastic_source
    for delegated in (
        "fullmag_cuda_magnetoelastic_field_energy_blocks(",
        "launch GPU RK magnetoelastic field",
        "GPU RK magnetoelastic field requires prescribed strain data",
        "GPU RK magnetoelastic field requires 6 prescribed strain Voigt values per node",
        "GPU RK magnetoelastic field requires device-resident per-node strain",
        "GPU RK magnetoelastic field requires device-resident Ms, lumped mass, and H_mel buffers",
    ):
        assert delegated not in local_source


def test_gpu_rk_effective_field_is_owned_by_rk_module():
    effective_header = GPU_RK_EFFECTIVE_FIELD_HPP_PATH.read_text(encoding="utf-8")
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    oersted_header = GPU_RK_OERSTED_FIELD_HPP_PATH.read_text(encoding="utf-8")
    oersted_source = GPU_RK_OERSTED_FIELD_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_effective_field.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_oersted_field.cu" in cmake
    assert "GPU CUDA RK effective field accumulation module header" in effective_header
    assert "gpu_rk_accumulate_effective_field(" in effective_header
    assert "GPU CUDA RK effective field accumulation source contract" in effective_source
    assert '#include "gpu/cuda/integrators/rk/rk_effective_field.hpp"' in effective_source
    assert '#include "gpu/cuda/integrators/rk/rk_oersted_field.hpp"' in effective_source
    assert "gpu_rk_accumulate_oersted_field(ctx, stream, n, reason)" in effective_source
    assert "GPU CUDA RK Oersted field accumulation module header" in oersted_header
    assert "gpu_rk_accumulate_oersted_field(" in oersted_header
    assert "GPU CUDA RK Oersted field accumulation source contract" in oersted_source
    assert '#include "gpu/cuda/integrators/rk/rk_oersted_field.hpp"' in oersted_source
    assert '#include "gpu/cuda/interactions/oersted/oersted_kernels.hpp"' in oersted_source
    for wrapper in (
        "fullmag_cuda_accumulate_heff(",
        "fullmag_cuda_add_field_inplace(",
    ):
        assert wrapper in effective_source
    for oersted_detail in (
        "fullmag_cuda_add_scaled_field_inplace(",
        "double gpu_rk_oersted_scale(const Context &ctx)",
        "ctx.oersted.time_dep_kind",
        "GPU RK Oersted field requires device-resident H_oe buffers",
        "launch GPU RK Oersted h_eff accumulation",
    ):
        assert oersted_detail in oersted_source
        assert oersted_detail not in effective_source
    for non_owner in (
        "gpu_rk_compute_rhs_for_magnetization(",
        "gpu_rk_compute_local_field_contributions(",
        "fullmag_cuda_llg_rhs_fused(",
        "fullmag_cuda_add_slonczewski_stt_rhs(",
    ):
        assert non_owner not in effective_source


def test_gpu_rk_direct_torques_are_owned_by_rk_module():
    direct_header = GPU_RK_DIRECT_TORQUES_HPP_PATH.read_text(encoding="utf-8")
    direct_source = GPU_RK_DIRECT_TORQUES_CU_PATH.read_text(encoding="utf-8")
    slonczewski_header = GPU_RK_SLONCZEWSKI_TORQUE_HPP_PATH.read_text(
        encoding="utf-8"
    )
    slonczewski_source = GPU_RK_SLONCZEWSKI_TORQUE_CU_PATH.read_text(
        encoding="utf-8"
    )
    zhang_li_header = GPU_RK_ZHANG_LI_TORQUE_HPP_PATH.read_text(encoding="utf-8")
    zhang_li_source = GPU_RK_ZHANG_LI_TORQUE_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_direct_torques.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_slonczewski_torque.cu" in cmake
    assert "gpu/cuda/integrators/rk/rk_zhang_li_torque.cu" in cmake
    assert "GPU CUDA RK direct torque module header" in direct_header
    assert "gpu_rk_add_direct_torques(" in direct_header
    assert "GPU CUDA RK direct torque source contract" in direct_source
    assert '#include "gpu/cuda/integrators/rk/rk_direct_torques.hpp"' in direct_source
    assert '#include "gpu/cuda/integrators/rk/rk_slonczewski_torque.hpp"' in direct_source
    assert '#include "gpu/cuda/integrators/rk/rk_zhang_li_torque.hpp"' in direct_source
    assert (
        "gpu_rk_add_slonczewski_torque(ctx, m, rhs, stream, n, reason)"
        in direct_source
    )
    assert "gpu_rk_add_zhang_li_torque(ctx, m, rhs, stream, n, reason)" in direct_source
    assert "GPU CUDA RK Slonczewski torque module header" in slonczewski_header
    assert "gpu_rk_add_slonczewski_torque(" in slonczewski_header
    assert "GPU CUDA RK Slonczewski torque source contract" in slonczewski_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_slonczewski_torque.hpp"'
        in slonczewski_source
    )
    assert '#include "gpu/cuda/interactions/stt/stt_kernels.hpp"' in slonczewski_source
    assert "GPU CUDA RK Zhang-Li torque module header" in zhang_li_header
    assert "gpu_rk_add_zhang_li_torque(" in zhang_li_header
    assert "GPU CUDA RK Zhang-Li torque source contract" in zhang_li_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_zhang_li_torque.hpp"'
        in zhang_li_source
    )
    assert '#include "gpu/cuda/interactions/stt/stt_kernels.hpp"' in zhang_li_source
    for wrapper in (
        "fullmag_cuda_add_slonczewski_stt_rhs(",
        "gpu_rk_current_density_magnitude(ctx)",
        "gpu_rk_resolve_slonczewski_thickness(ctx)",
    ):
        assert wrapper in slonczewski_source
        assert wrapper not in direct_source
    for wrapper in (
        "fullmag_cuda_add_zhang_li_stt_rhs(",
        "requires device-resident mesh geometry",
    ):
        assert wrapper in zhang_li_source
        assert wrapper not in direct_source
    for non_owner in (
        "gpu_rk_compute_rhs_for_magnetization(",
        "gpu_rk_accumulate_effective_field(",
        "fullmag_cuda_llg_rhs_fused(",
        "compute_device_demag_for_device_stage(",
    ):
        assert non_owner not in direct_source


def test_gpu_rk_dmi_fields_are_owned_by_rk_module():
    dmi_header = GPU_RK_DMI_FIELDS_HPP_PATH.read_text(encoding="utf-8")
    dmi_source = GPU_RK_DMI_FIELDS_CU_PATH.read_text(encoding="utf-8")
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_dmi_fields.cu" in cmake
    assert "GPU CUDA RK DMI field contributions module header" in dmi_header
    assert "gpu_rk_compute_dmi_field_contributions(" in dmi_header
    assert "GPU CUDA RK DMI field contributions source contract" in dmi_source
    assert '#include "gpu/cuda/integrators/rk/rk_dmi_fields.hpp"' in dmi_source
    for wrapper in (
        "fullmag_cuda_dmi_field_energy(",
        "launch GPU RK interfacial DMI field",
        "launch GPU RK bulk DMI field",
        "requires device-resident mesh geometry",
    ):
        assert wrapper in dmi_source
    for non_owner in (
        "gpu_rk_compute_rhs_for_magnetization(",
        "gpu_rk_accumulate_effective_field(",
        "fullmag_cuda_llg_rhs_fused(",
        "compute_device_demag_for_device_stage(",
        "gpu_rk_compute_legacy_sparse_exchange(",
    ):
        assert non_owner not in dmi_source


def test_fem_gpu_enablement_script_runs_native_dmi_runtime_smoke():
    script = VERIFY_FEM_GPU_ENABLEMENT_SCRIPT.read_text(encoding="utf-8")

    assert "FEM GPU smoke: DMI fields and energy" in script
    assert (
        "native_fem_gpu_dmi_step_exposes_fields_and_energy_when_cuda_is_available"
        in script
    )
    assert "cargo test -p fullmag-runner" in script
    assert "--features fem-gpu" in script


def test_fem_gpu_dockerfile_builds_libceed_cuda_backend():
    dockerfile = FEM_GPU_DOCKERFILE_PATH.read_text(encoding="utf-8")

    assert "FULLMAG_FEM_MFEM_DEVICE=ceed-cuda:/gpu/cuda/shared" in dockerfile
    assert "make -C /tmp/build/libCEED CUDA_DIR=${CUDA_HOME}" in dockerfile
    assert "make -C /tmp/build/libCEED -j\"$(nproc)\"" not in dockerfile


def test_fem_dmi_docs_pin_public_surface_unit_policy():
    doc = FEM_DMI_DOC_PATH.read_text(encoding="utf-8")
    interfacial_source = FEM_DMI_INTERFACIAL_SOURCE.read_text(encoding="utf-8")

    assert "Public API: `Dind` / `InterfacialDMI(D=...)` is a surface DMI coefficient in `J/m^2`." in doc
    assert "The native FEM path passes this coefficient through unchanged; it does not divide by film thickness" in doc
    assert "thickness" not in interfacial_source.lower()


def test_fem_dmi_weak_residual_covers_production_physics_fixtures():
    source = FEM_DMI_WEAK_RESIDUAL_TEST.read_text(encoding="utf-8")

    assert "run_interfacial_domain_wall_handedness_fixture" in source
    assert "run_bulk_spiral_pitch_fixture" in source
    assert "run_interfacial_boundary_tilt_fixture" in source


def test_gpu_rk_final_refresh_is_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    refresh_header = GPU_RK_FINAL_REFRESH_HPP_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_final_refresh.cu" in cmake_source
    assert '#include "gpu/cuda/integrators/rk/rk_final_refresh.hpp"' in rk_step_source
    assert "GPU CUDA RK accepted-step final refresh module header" in refresh_header
    assert "gpu_rk_finalize_accepted_step(" in refresh_header
    assert "GPU CUDA RK accepted-step final refresh source contract" in refresh_source
    assert '#include "gpu/cuda/integrators/rk/rk_final_refresh.hpp"' in refresh_source
    assert '#include "gpu/cuda/kernels/kernels.hpp"' not in refresh_source
    assert '#include "gpu/cuda/reductions/reduction_kernels.hpp"' in refresh_source
    assert "gpu_rk_compute_rhs_for_magnetization(" in refresh_source
    assert "launch GPU RK final h_eff accumulation" in refresh_source
    assert "gpu_rk_copy_component_device(" in refresh_source
    assert "cudaMemcpyAsync GPU RK FSAL k0 device copy" in refresh_source
    assert "fullmag_cuda_device_max(" in refresh_source
    assert "gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)" in refresh_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in refresh_source
    assert "stats.fsal_reused = fsal_reused ? 1 : 0" in refresh_source
    assert "gpu.residency.device_state = FemGpuSyncState::DeviceDirty" in refresh_source
    assert "gpu.residency.host_state = FemGpuSyncState::HostStale" in refresh_source
    assert "bool gpu_rk_device_resident_step(" not in refresh_source
    assert "launch GPU RK final h_eff accumulation" not in rk_step_source
    assert "gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)" not in rk_step_source


def test_gpu_rk_plan_supports_heun_and_rk4_fixed_step_integrators():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    rk4_accept_source = GPU_RK_RK4_ACCEPT_KERNEL_CU_PATH.read_text(encoding="utf-8")
    heun_source = GPU_HEUN_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    rk4_source = GPU_RK4_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")

    assert "ctx.integrator != FULLMAG_FEM_INTEGRATOR_HEUN" not in rk_source
    assert "FULLMAG_FEM_INTEGRATOR_RK4" in rk_source
    assert "GPU RK device-resident path currently supports Heun, RK4, RK23, and RK45 only" in rk_source
    assert "gpu_rk_run_accepted_attempt_loop(" in cuda_source
    assert "gpu_rk_run_stage_attempt(" in attempt_loop_source
    assert "fullmag_cuda_heun_accept(" in heun_source
    assert "fullmag_cuda_rk4_accept(" in rk4_source
    assert "rk4_accept_kernel" in rk4_accept_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in refresh_source


def test_gpu_rk_plan_supports_uniform_external_field_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    publication_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(
        encoding="utf-8"
    )
    external_energy_source = GPU_RK_EXTERNAL_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    compact_publication_source = " ".join(publication_source.split())
    zeeman_kernel_header = GPU_ZEEMAN_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    zeeman_kernel_source = GPU_ZEEMAN_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "does not support external field energy yet" not in rk_source
    assert "fullmag_cuda_external_energy_blocks" in zeeman_kernel_header
    assert "external_energy_blocks_kernel" in zeeman_kernel_source
    assert "-kMu0 * ms[i] * mdoth * lumped_mass[i]" in zeeman_kernel_source
    assert "fullmag_cuda_external_energy_blocks(" in external_energy_source
    assert "launch GPU RK external energy reduction" in external_energy_source
    assert "stats.external_energy_joules = external_energy" in publication_source
    assert "stats.total_energy_joules =" in publication_source
    assert "exchange_energy + demag_energy + external_energy" in compact_publication_source


def test_gpu_rk_plan_supports_uniaxial_anisotropy_field_and_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    publication_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_energy_source = GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_field_source = GPU_RK_ANISOTROPY_FIELD_CU_PATH.read_text(
        encoding="utf-8"
    )
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    compact_publication_source = " ".join(publication_source.split())
    vector_kernel_header = GPU_VECTOR_FIELD_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    anis_kernel_header = GPU_ANISOTROPY_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    anis_kernel_source = GPU_ANISOTROPY_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "ctx.enable_anisotropy" not in rk_source
    assert "does not support anisotropy yet" not in rk_source
    assert "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks" in anis_kernel_header
    assert "uniaxial_anisotropy_field_energy_blocks_kernel" in anis_kernel_source
    assert "2.0 * ku_i / (kMu0 * ms_i)" in anis_kernel_source
    assert "4.0 * ku2_i / (kMu0 * ms_i)" in anis_kernel_source
    assert "fullmag_cuda_add_field_inplace" in vector_kernel_header
    assert (
        "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks("
        in anisotropy_field_source
    )
    assert "launch GPU RK uniaxial anisotropy h_eff accumulation" in effective_source
    assert "launch GPU RK uniaxial anisotropy energy reduction" in anisotropy_energy_source
    assert (
        "stats.anisotropy_energy_joules = anisotropy_energy + cubic_anisotropy_energy"
        in publication_source
    )
    assert (
        "exchange_energy + demag_energy + external_energy + anisotropy_energy"
        in compact_publication_source
    )


def test_gpu_rk_plan_supports_cubic_anisotropy_field_and_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    publication_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_energy_source = GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_field_source = GPU_RK_ANISOTROPY_FIELD_CU_PATH.read_text(
        encoding="utf-8"
    )
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    anis_kernel_header = GPU_ANISOTROPY_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    anis_kernel_source = GPU_ANISOTROPY_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "ctx.enable_cubic_anisotropy" not in rk_source
    assert "does not support cubic anisotropy yet" not in rk_source
    assert "fullmag_cuda_cubic_anisotropy_field_energy_blocks" in anis_kernel_header
    assert "cubic_anisotropy_field_energy_blocks_kernel" in anis_kernel_source
    assert "const double pf1 = -2.0 * kc1_i * inv_mu0_ms" in anis_kernel_source
    assert "const double pf2 = -2.0 * kc2_i * inv_mu0_ms" in anis_kernel_source
    assert "const double pf3 = -4.0 * kc3_i * inv_mu0_ms" in anis_kernel_source
    assert "kc1_i * sigma + kc2_i * m1sq * m2sq * m3sq + kc3_i * sigma * sigma" in anis_kernel_source
    assert "fullmag_cuda_cubic_anisotropy_field_energy_blocks(" in anisotropy_field_source
    assert "launch GPU RK cubic anisotropy h_eff accumulation" in effective_source
    assert "launch GPU RK cubic anisotropy energy reduction" in anisotropy_energy_source
    assert "cubic_anisotropy_energy" in publication_source
    assert "anisotropy_energy + cubic_anisotropy_energy" in publication_source


def test_gpu_rk_plan_supports_precomputed_oersted_field_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    oersted_source = GPU_RK_OERSTED_FIELD_CU_PATH.read_text(encoding="utf-8")
    oersted_kernel_header = GPU_OERSTED_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    oersted_kernel_source = GPU_OERSTED_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "does not support Oersted field yet" not in rk_source
    assert "requires precomputed Oersted field data" in rk_source
    assert "fullmag_cuda_add_scaled_field_inplace" in oersted_kernel_header
    assert "add_scaled_field_inplace_kernel" in oersted_kernel_source
    assert "scale * h_add[i]" in oersted_kernel_source
    assert "double gpu_rk_oersted_scale(const Context &ctx)" in oersted_source
    assert "ctx.oersted.time_dep_kind" in oersted_source
    assert "fullmag_cuda_add_scaled_field_inplace(gpu.fields.h_oe.x" in oersted_source
    assert "launch GPU RK Oersted h_eff accumulation" in oersted_source
    assert "gpu_rk_accumulate_oersted_field(ctx, stream, n, reason)" in effective_source


def test_gpu_rk_plan_supports_magnetoelastic_field_and_energy_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    publication_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_energy_source = (
        GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    )
    magnetoelastic_field_source = GPU_RK_MAGNETOELASTIC_FIELD_CU_PATH.read_text(
        encoding="utf-8"
    )
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    context_source = GPU_STATE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")
    state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    mel_kernel_header = GPU_MAGNETOELASTIC_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    mel_kernel_source = GPU_MAGNETOELASTIC_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "does not support magnetoelastic field yet" not in rk_source
    assert "requires 6 magnetoelastic strain Voigt values per node" in rk_source
    assert "requires device-resident per-node magnetoelastic strain" in rk_source
    assert "requires magnetoelastic strain data" in rk_source
    assert "FemGpuMagnetoelasticDeviceState magnetoelastic{}" in state_header
    assert "double *mel_strain_voigt" not in state_header
    assert "bool mel_strain_uploaded" not in state_header
    assert "gpu_state_upload_magnetoelastic_strain" in context_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks" in mel_kernel_header
    assert "magnetoelastic_field_energy_blocks_kernel" in mel_kernel_source
    assert "per_node_strain_voigt + static_cast<size_t>(i) * 6u" in mel_kernel_source
    assert "inv_mu0_ms = -1.0 / (kMu0 * ms_i)" in mel_kernel_source
    assert "2.0 * b1 * lmx * e11" in mel_kernel_source
    assert "energy_density * lumped_mass[i]" in mel_kernel_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" in magnetoelastic_field_source
    assert (
        "use_per_node_strain ? gpu.magnetoelastic.strain_voigt : nullptr"
        in magnetoelastic_field_source
    )
    assert "launch GPU RK magnetoelastic h_eff accumulation" in effective_source
    assert "launch GPU RK magnetoelastic energy reduction" in magnetoelastic_energy_source
    assert "stats.magnetoelastic_energy_joules = magnetoelastic_energy" in publication_source
    assert "magnetoelastic_energy" in publication_source


def test_gpu_rk_plan_supports_slonczewski_stt_rhs_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    slonczewski_source = GPU_RK_SLONCZEWSKI_TORQUE_CU_PATH.read_text(
        encoding="utf-8"
    )
    stt_kernel_header = GPU_STT_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    stt_kernel_source = GPU_STT_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "does not support Slonczewski STT yet" not in rk_source
    assert "gpu_rk_resolve_slonczewski_thickness" in rk_source
    assert "requires explicit or geometry-derived Slonczewski free-layer thickness" in rk_source
    assert "fullmag_cuda_add_slonczewski_stt_rhs" in stt_kernel_header
    assert "slonczewski_stt_rhs_kernel" in stt_kernel_source
    assert "kHbar = 1.054571817e-34" in stt_kernel_source
    assert "kElectronCharge = 1.60217662e-19" in stt_kernel_source
    assert "gpu_rk_current_density_magnitude(ctx)" in slonczewski_source
    assert "slonczewski_thickness" in slonczewski_source
    assert "ctx.stt.spin_polarization[0]" in slonczewski_source
    assert "launch GPU RK Slonczewski STT RHS" in slonczewski_source


def test_gpu_rk_plan_supports_rk23_adaptive_retry_scaffold():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    bs23_accept_source = GPU_RK_BS23_ACCEPT_KERNEL_CU_PATH.read_text(encoding="utf-8")
    rk23_source = GPU_RK23_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    rk23_adaptive_source = GPU_RK23_ADAPTIVE_K3_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")

    assert "FULLMAG_FEM_INTEGRATOR_RK23_BS" in rk_source
    assert "adaptive RK23/RK45" not in rk_source
    assert "GPU RK device-resident path currently supports Heun, RK4, RK23, and RK45 only" in rk_source
    assert "fullmag_cuda_bs23_accept(" in rk23_source
    assert "launch GPU RK23 BS23 k3 for adaptive error estimate" in rk23_adaptive_source
    assert "bs23_accept_kernel" in bs23_accept_source
    assert "is_rk23" in cuda_source
    assert "gpu_rk_reduce_adaptive_error_norm_device(" in attempt_loop_source
    assert "gpu_rk_read_adaptive_error_norm_decision_host(" in attempt_loop_source
    assert "gpu_rk_restore_adaptive_reject_magnetization_device(" in attempt_loop_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in refresh_source


def test_gpu_rk_plan_supports_rk45_adaptive_retry_scaffold():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    dp54_accept_source = GPU_RK_DP54_ACCEPT_KERNEL_CU_PATH.read_text(encoding="utf-8")
    step_source = RK_EXPLICIT_STEP_CPP_PATH.read_text(encoding="utf-8")
    rk45_source = GPU_RK45_STAGE_SEQUENCE_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")

    assert "FULLMAG_FEM_INTEGRATOR_RK45_DP54" in rk_source
    assert "GPU RK device-resident path currently supports Heun, RK4, RK23, and RK45 only" in rk_source
    assert "adaptive RK23/RK45" not in rk_source
    assert "fullmag_cuda_dp54_accept(" in rk45_source
    assert "dp54_accept_kernel" in dp54_accept_source
    assert "is_rk45" in cuda_source
    assert "gpu_rk_read_adaptive_error_norm_decision_host(" in attempt_loop_source
    assert "gpu_rk_adaptive_pi_step(ctx, error_estimate)" not in attempt_loop_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in refresh_source

    function_start = step_source.index("bool context_step_explicit_rk_mfem(")
    function_end = step_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = step_source[function_start:function_end]
    assert "FULLMAG_FEM_INTEGRATOR_RK45_DP54" in function_source
    assert "!ctx.adaptive_dt_enabled" not in function_source[
        function_source.index("if ((ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_HEUN") :
        function_source.index("const bool adaptive =")
    ]
    assert "tab.stages == 7" in function_source


def test_gpu_rk_plan_enables_only_from_exchange_plan_stage_residency():
    source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    cuda_branch_start = source.index("#if FULLMAG_HAS_CUDA_RUNTIME")
    cuda_branch_end = source.index("#else", cuda_branch_start)
    cuda_branch = source[cuda_branch_start:cuda_branch_end]

    assert "plan.enabled = true" not in cuda_branch
    assert "stage H_ex is recomputed device-resident" in cuda_branch
    assert "gpu_exchange_plan_stage_exchange(ctx" in source


def test_mfem_exchange_path_marks_transfer_audit_exchange_interop_scope():
    source = EXCHANGE_FIELD_CPP_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool compute_exchange_for_magnetization(")
    function_end = source.index(
        "\n} // namespace fullmag::fem",
        function_start,
    )
    function_source = source[function_start:function_end]

    assert "TransferAuditScopeKind::ExchangeInterop" in function_source


def test_mfem_exchange_stage_path_still_has_explicit_host_roundtrip_blocker():
    source = EXCHANGE_FIELD_CPP_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool compute_exchange_for_magnetization(")
    function_end = source.index(
        "\n} // namespace fullmag::fem",
        function_start,
    )
    function_source = source[function_start:function_end]

    assert "copy_host_vector_to_mfem(ctx.mfem_context.m_x" in function_source
    assert "copy_host_vector_to_mfem(ctx.mfem_context.m_y" in function_source
    assert "copy_host_vector_to_mfem(ctx.mfem_context.m_z" in function_source
    assert "pack_components_to_aos(" in function_source
    assert "gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH" not in function_source


def test_gpu_rk_cuda_step_recomputes_exchange_for_each_heun_stage():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    attempt_setup_source = GPU_RK_ATTEMPT_SETUP_CU_PATH.read_text(encoding="utf-8")
    schedule_source = GPU_RK_STAGE_SCHEDULE_CU_PATH.read_text(encoding="utf-8")
    exchange_source = GPU_RK_EXCHANGE_DISPATCH_CU_PATH.read_text(encoding="utf-8")
    rhs_source = GPU_RK_RHS_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_device_resident_step(")
    function_source = source[function_start:]
    helper_start = rhs_source.index(
        "bool gpu_rk_accumulate_effective_field_for_magnetization("
    )
    helper_end = rhs_source.index("} // namespace", helper_start)
    helper_source = rhs_source[helper_start:helper_end]
    rhs_helper_start = rhs_source.index("bool gpu_rk_compute_rhs_for_magnetization(")
    rhs_helper_end = rhs_source.index("} // namespace", rhs_helper_start)
    rhs_helper_source = rhs_source[rhs_helper_start:rhs_helper_end]

    assert "fullmag_cuda_legacy_sparse_exchange(" in exchange_source
    assert "gpu_rk_compute_legacy_sparse_exchange(ctx.gpu_state.device, m, stream, reason)" in helper_source
    assert "gpu_rk_accumulate_effective_field_for_magnetization(" in rhs_helper_source
    assert "gpu_rk_run_accepted_attempt_loop(" in function_source
    assert "gpu_rk_run_stage_attempt(" in attempt_loop_source
    assert "gpu_rk_prepare_stage_attempt(" in schedule_source
    assert attempt_setup_source.count("gpu_rk_compute_rhs_for_magnetization(") >= 2
    assert 'gpu.magnetization.m,\n            gpu.rk.error' in refresh_source
    assert "gpu.rk.m_stage" in attempt_setup_source
    assert "legacy_sparse_gpu" in preflight_source
    assert "legacy_sparse_gpu" not in function_source


def test_gpu_rk_cuda_step_refreshes_final_heff_after_accept():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    schedule_source = GPU_RK_STAGE_SCHEDULE_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_device_resident_step(")
    function_end = source.index("\n} // namespace fullmag::fem", function_start)
    function_source = source[function_start:function_end]

    accepted_loop_index = function_source.index("gpu_rk_run_accepted_attempt_loop(")
    final_refresh_call_index = function_source.index("gpu_rk_finalize_accepted_step(", accepted_loop_index)
    accept_index = schedule_source.index("launch GPU RK accept/normalize")
    final_rhs_call_index = refresh_source.index(
        "gpu_rk_compute_rhs_for_magnetization(\n            ctx,\n            gpu.magnetization.m",
    )
    final_heff_label_index = refresh_source.index(
        "launch GPU RK final h_eff accumulation",
        final_rhs_call_index,
    )
    reduce_index = refresh_source.index("fullmag_cuda_device_max(", final_heff_label_index)

    assert accept_index >= 0
    assert "gpu_rk_run_stage_attempt(" in attempt_loop_source
    assert accepted_loop_index < final_refresh_call_index
    assert final_rhs_call_index < final_heff_label_index < reduce_index


def test_gpu_rk_cuda_step_recomputes_final_rhs_metric_after_final_heff_refresh():
    source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    schedule_source = GPU_RK_STAGE_SCHEDULE_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool gpu_rk_device_resident_step(")
    function_end = source.index("\n} // namespace fullmag::fem", function_start)
    function_source = source[function_start:function_end]

    assert "launch GPU RK accept/normalize" in schedule_source
    accepted_loop_index = function_source.index("gpu_rk_run_accepted_attempt_loop(")
    assert "gpu_rk_finalize_accepted_step(" in function_source[accepted_loop_index:]
    final_rhs_call_index = refresh_source.index(
        "gpu_rk_compute_rhs_for_magnetization(\n            ctx,\n            gpu.magnetization.m",
    )
    final_heff_label_index = refresh_source.index(
        "launch GPU RK final h_eff accumulation",
        final_rhs_call_index,
    )
    reduce_index = refresh_source.index("fullmag_cuda_device_max(", final_heff_label_index)

    assert "gpu.rk.error,\n            stream" in refresh_source
    assert final_rhs_call_index < final_heff_label_index < reduce_index


def test_gpu_rk_rhs_evaluation_count_includes_final_rhs_metric():
    function_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")

    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in function_source


def test_gpu_rk_reuses_fsal_stage_zero_without_host_sync():
    header_source = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    rk_workspace_source = GPU_RK_WORKSPACE_STATE_HPP_PATH.read_text(encoding="utf-8")
    state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    attempt_setup_source = GPU_RK_ATTEMPT_SETUP_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    component_copy_source = GPU_RK_COMPONENT_COPY_CU_PATH.read_text(encoding="utf-8")
    function_start = cuda_source.index("bool gpu_rk_device_resident_step(")
    function_end = cuda_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = cuda_source[function_start:function_end]

    assert "FemGpuRkWorkspaceDeviceState rk{}" in header_source
    assert "bool fsal_valid = false" in rk_workspace_source
    assert "state.rk.fsal_valid = false" in state_source
    assert "fsal_reused = fsal_method && gpu.rk.fsal_valid" in attempt_setup_source
    assert "if (!fsal_reused)" in attempt_setup_source
    assert "fsal_reused = stage_attempt.fsal_reused" in attempt_loop_source
    assert "accepted_attempt.fsal_reused" in function_source
    assert "gpu_rk_copy_component_device(" in refresh_source
    assert "gpu.rk.error" in refresh_source
    assert "gpu.rk.k[0]" in refresh_source
    assert "cudaMemcpyDeviceToDevice" in component_copy_source
    assert "stats.fsal_reused = fsal_reused ? 1 : 0" in refresh_source
    assert "stats.rhs_evaluations = total_stage_rhs_evaluations + 1" in refresh_source
    assert "cudaStreamSynchronize" not in function_source


def test_gpu_rk_disables_fsal_reuse_for_stochastic_or_time_dependent_rhs():
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")
    fsal_source = GPU_RK_FSAL_POLICY_CPP_PATH.read_text(encoding="utf-8")
    assert "bool gpu_rk_rhs_allows_fsal_reuse(" in fsal_source
    function_start = fsal_source.index("bool gpu_rk_rhs_allows_fsal_reuse(")
    function_end = fsal_source.index("\n} // namespace fullmag::fem", function_start)
    helper_source = fsal_source[function_start:function_end]
    step_start = cuda_source.index("bool gpu_rk_device_resident_step(")
    step_end = cuda_source.index("\n} // namespace fullmag::fem", step_start)
    step_source = cuda_source[step_start:step_end]

    assert "ctx.thermal_brown.temperature > 0.0" in helper_source
    assert "ctx.oersted.time_dep_kind != 0u" in helper_source
    assert (
        "result.fsal_method = (result.is_rk23 || result.is_rk45) && "
        "gpu_rk_rhs_allows_fsal_reuse(ctx)"
    ) in preflight_source
    assert "preflight.fsal_method" in step_source
    assert "gpu_rk_rhs_allows_fsal_reuse(ctx)" not in step_source


def test_gpu_rk_keeps_device_backup_for_future_adaptive_reject_retry():
    header_source = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    state_source = GPU_STATE_CPP_PATH.read_text(encoding="utf-8")
    workspace_memory_source = GPU_RK_WORKSPACE_MEMORY_CPP_PATH.read_text(
        encoding="utf-8"
    )
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    attempt_setup_source = GPU_RK_ATTEMPT_SETUP_CU_PATH.read_text(encoding="utf-8")
    component_copy_source = GPU_RK_COMPONENT_COPY_CU_PATH.read_text(encoding="utf-8")
    function_start = cuda_source.index("bool gpu_rk_device_resident_step(")
    function_end = cuda_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = cuda_source[function_start:function_end]

    assert "FemGpuRkWorkspaceDeviceState rk{}" in header_source
    assert "gpu_rk_workspace_allocate(" in state_source
    assert "gpu_rk_workspace_free(" in state_source
    assert "allocate_component(rk.m_backup" in workspace_memory_source
    assert "free_component(rk.m_backup)" in workspace_memory_source
    assert "gpu_rk_run_accepted_attempt_loop(" in function_source
    assert "gpu_rk_run_stage_attempt(" in attempt_loop_source
    assert "gpu_rk_copy_component_device(" in attempt_setup_source
    assert "gpu.magnetization.m" in attempt_setup_source
    assert "gpu.rk.m_backup" in attempt_setup_source
    assert "GPU RK backup magnetization device copy" in attempt_setup_source
    assert "cudaMemcpyDeviceToDevice" in component_copy_source
    assert "cudaStreamSynchronize" not in function_source


def test_gpu_rk_has_device_restore_for_adaptive_reject_retry():
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    adaptive_source = GPU_RK_ADAPTIVE_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")

    assert "gpu_rk_run_accepted_attempt_loop(" in cuda_source
    assert "gpu_rk_restore_adaptive_reject_magnetization_device(" in attempt_loop_source
    helper_source = adaptive_source[
        adaptive_source.index("gpu_rk_restore_adaptive_reject_magnetization_device(") :
        adaptive_source.index("\n} // namespace fullmag::fem")
    ]

    assert "gpu_rk_copy_component_device(" in helper_source
    assert "gpu.rk.m_backup" in helper_source
    assert "gpu.magnetization.m" in helper_source
    assert "GPU RK restore rejected adaptive magnetization device copy" in helper_source
    assert "gpu.rk.fsal_valid = false" in helper_source
    assert "cudaStreamSynchronize" not in helper_source


def test_gpu_rk_has_adaptive_pi_decision_helper():
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    adaptive_header = GPU_RK_ADAPTIVE_RUNTIME_HPP_PATH.read_text(encoding="utf-8")
    adaptive_source = GPU_RK_ADAPTIVE_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    decision_source = GPU_RK_ADAPTIVE_DECISION_READBACK_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu_rk_read_adaptive_error_norm_decision_host(" in attempt_loop_source
    assert "gpu_rk_adaptive_pi_step(ctx, error_estimate)" not in attempt_loop_source
    assert "struct GpuAdaptiveResult" in adaptive_header
    assert "gpu_rk_adaptive_pi_step(" in adaptive_source
    assert "gpu_rk_adaptive_pi_step(ctx, error_norm)" in decision_source
    helper_source = adaptive_source[
        adaptive_source.index("gpu_rk_adaptive_pi_step(") :
        adaptive_source.index("bool gpu_rk_restore_adaptive_reject_magnetization_device(")
    ]

    assert "ctx.adaptive_dt.enabled" in helper_source
    assert "ctx.adaptive_dt.prev_error_norm" in helper_source
    assert "ctx.adaptive_dt.safety_factor" in helper_source
    assert "ctx.adaptive_dt.pi_alpha" in helper_source
    assert "ctx.adaptive_dt.pi_beta" in helper_source
    assert "ctx.adaptive_dt.dt_grow_max" in helper_source
    assert "ctx.adaptive_dt.dt_shrink_min" in helper_source
    assert "ctx.adaptive_dt.dt_max" in helper_source
    assert "ctx.adaptive_dt.dt_min" in helper_source
    assert "ctx.adaptive_dt.rejected_steps += 1" in helper_source
    assert "std::pow" in helper_source
    assert "return {true" in helper_source
    assert "return {false" in helper_source


def test_gpu_kernels_expose_device_adaptive_error_norm_blocks():
    adaptive_kernel_header = GPU_RK_ADAPTIVE_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    adaptive_kernel_source = GPU_RK_ADAPTIVE_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "fullmag_cuda_adaptive_error_norm_blocks" in adaptive_kernel_header
    assert "adaptive_error_norm_blocks_kernel" in adaptive_kernel_source
    assert "b_hi0" in adaptive_kernel_source
    assert "b_lo0" in adaptive_kernel_source
    assert "adaptive_atol" in adaptive_kernel_source
    assert "adaptive_rtol" in adaptive_kernel_source
    assert "sqrt(err_x * err_x + err_y * err_y + err_z * err_z)" in adaptive_kernel_source
    assert (
        "sqrt(new_mx[i] * new_mx[i] + new_my[i] * new_my[i] + new_mz[i] * new_mz[i])"
        in adaptive_kernel_source
    )
    assert "if (stages > 4)" in adaptive_kernel_source
    assert "if (stages > 6)" in adaptive_kernel_source
    assert "BlockReduce<double, 256>" in adaptive_kernel_source


def test_gpu_kernels_use_double_atomic_add_compatibility_helper():
    kernel_source = GPU_STT_KERNELS_CU_PATH.read_text(encoding="utf-8")
    kernel_start = kernel_source.index("zhang_li_element_rhs_kernel(")
    kernel_end = kernel_source.index("__global__ void zhang_li_normalize_add_rhs_kernel", kernel_start)
    kernel_body = kernel_source[kernel_start:kernel_end]

    assert "stt_atomic_add_double(double *address, double value)" in kernel_source
    assert "atomicCAS(" in kernel_source
    assert "atomicAdd(&work_" not in kernel_body
    assert "atomicAdd(&node_weight" not in kernel_body
    assert re.search(r"stt_atomic_add_double\(\s*&work_x\[node\]\s*,", kernel_body)
    assert re.search(r"stt_atomic_add_double\(\s*&node_weight\[node\]\s*,", kernel_body)


def test_gpu_rk_has_device_adaptive_error_norm_reduction_helper():
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    error_norm_source = GPU_RK_ERROR_NORM_RUNTIME_CU_PATH.read_text(encoding="utf-8")
    decision_source = GPU_RK_ADAPTIVE_DECISION_READBACK_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu_rk_reduce_adaptive_error_norm_device(" in attempt_loop_source
    assert "gpu_rk_read_adaptive_error_norm_decision_host(" in attempt_loop_source
    helper_source = error_norm_source[
        error_norm_source.index("gpu_rk_reduce_adaptive_error_norm_device(") :
        error_norm_source.index("\n} // namespace fullmag::fem")
    ]
    assert "fullmag_cuda_adaptive_error_norm_blocks(" in helper_source
    assert "fullmag_cuda_device_max(" in helper_source
    assert "gpu.reductions.scalar_workspace" in helper_source
    assert "gpu.reductions.temp_storage" in helper_source
    assert "temp_storage=nullptr" not in helper_source
    assert "ctx.adaptive_dt.atol" in helper_source
    assert "ctx.adaptive_dt.rtol" in helper_source
    assert "GPU RK adaptive error norm" in helper_source
    assert "gpu_rk_read_scalar_result(" not in helper_source
    assert "gpu_rk_read_scalar_result(" not in decision_source
    assert "gpu_rk_read_control_scalar_result(" in decision_source
    assert "gpu_rk_adaptive_pi_step(ctx, error_norm)" in decision_source


def test_gpu_rk_attempt_loop_is_owned_by_rk_module():
    cmake = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    gpu_rk_cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_header = GPU_RK_ATTEMPT_LOOP_HPP_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_attempt_loop.cu" in cmake
    assert '#include "gpu/cuda/integrators/rk/rk_attempt_loop.hpp"' in gpu_rk_cuda_source
    assert "GPU CUDA RK attempt loop module header" in attempt_loop_header
    assert "struct GpuRkAcceptedAttemptResult" in attempt_loop_header
    assert "gpu_rk_run_accepted_attempt_loop(" in attempt_loop_header
    assert "GPU CUDA RK attempt loop source contract" in attempt_loop_source
    assert '#include "gpu/cuda/integrators/rk/rk_attempt_loop.hpp"' in attempt_loop_source
    assert '#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"' in attempt_loop_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"'
        in attempt_loop_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp"' in attempt_loop_source
    assert '#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"' in attempt_loop_source
    assert "gpu_rk_run_stage_attempt(" in attempt_loop_source
    assert "gpu_rk_reduce_adaptive_error_norm_device(" in attempt_loop_source
    assert "gpu_rk_read_adaptive_error_norm_decision_host(" in attempt_loop_source
    assert "gpu_rk_adaptive_pi_step(ctx, error_estimate)" not in attempt_loop_source
    assert "gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)" in attempt_loop_source
    assert "for (;;) {" in attempt_loop_source
    assert "rejected_attempts += 1" in attempt_loop_source
    assert "ctx.adaptive_dt.max_reject" in attempt_loop_source
    assert "adaptive_config.max_reject" in attempt_loop_source
    assert "format_scientific(error_estimate)" in attempt_loop_source
    assert "result.active_dt = active_dt" in attempt_loop_source
    assert "result.total_stage_rhs_evaluations = total_stage_rhs_evaluations" in attempt_loop_source
    assert "result.fsal_reused = fsal_reused" in attempt_loop_source
    assert "gpu_rk_run_accepted_attempt_loop(" in gpu_rk_cuda_source
    assert "gpu_rk_finalize_accepted_step(" not in attempt_loop_source
    assert "for (;;) {" not in gpu_rk_cuda_source
    assert "gpu_rk_compute_adaptive_error_norm_device(" not in gpu_rk_cuda_source
    assert "gpu_rk_restore_adaptive_reject_magnetization_device(" not in gpu_rk_cuda_source
    assert "adaptive_config.max_reject" not in gpu_rk_cuda_source
    assert "format_scientific(" not in gpu_rk_cuda_source


def test_gpu_rk_step_contains_adaptive_retry_loop_scaffold():
    gpu_rk_cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    preflight_source = GPU_RK_STEP_PREFLIGHT_CU_PATH.read_text(encoding="utf-8")
    attempt_loop_source = GPU_RK_ATTEMPT_LOOP_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    function_start = gpu_rk_cuda_source.index("bool gpu_rk_device_resident_step(")
    function_end = gpu_rk_cuda_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = gpu_rk_cuda_source[function_start:function_end]

    assert "result.adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled" in preflight_source
    assert "preflight.adaptive" in function_source
    assert "const bool adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled" not in function_source
    assert "gpu_rk_run_accepted_attempt_loop(" in function_source
    assert "accepted_attempt.active_dt" in function_source
    assert "accepted_attempt.error_estimate" in function_source
    assert "accepted_attempt.suggested_dt" in function_source
    assert "accepted_attempt.rejected_attempts" in function_source
    assert "accepted_attempt.total_stage_rhs_evaluations" in function_source
    assert "accepted_attempt.fsal_reused" in function_source
    assert "for (;;) {" in attempt_loop_source
    assert "ctx.adaptive_dt.current_dt = active_dt" in attempt_loop_source
    assert "gpu_rk_reduce_adaptive_error_norm_device(" in attempt_loop_source
    assert "gpu_rk_read_adaptive_error_norm_decision_host(" in attempt_loop_source
    assert "gpu_rk_adaptive_pi_step(ctx, error_estimate)" not in attempt_loop_source
    assert "gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)" in attempt_loop_source
    assert "rejected_attempts += 1" in attempt_loop_source
    assert "ctx.adaptive_dt.max_reject" in attempt_loop_source
    assert "adaptive_config.max_reject" in attempt_loop_source
    assert "continue;" in attempt_loop_source
    assert "gpu_rk_finalize_accepted_step(" in function_source
    assert "stats.error_estimate = error_estimate" in refresh_source
    assert "stats.dt_suggested = suggested_dt" in refresh_source
    assert "stats.rejected_attempts = rejected_attempts" in refresh_source


def test_gpu_rk_scalar_stats_are_read_outside_hot_loop_scope():
    backend_step_source = (
        REPO_ROOT
    / "backends"
    / "fem"
        / "cpu"
        / "mfem"
        / "runtime"
        / "backend_step.cpp"
    ).read_text(encoding="utf-8")
    gpu_rk_stats_source = GPU_RK_STEP_STATS_CU_PATH.read_text(encoding="utf-8")
    scalar_readback_source = GPU_RK_SCALAR_READBACK_CU_PATH.read_text(encoding="utf-8")

    step_start = backend_step_source.index("int run_backend_step(")
    step_source = backend_step_source[step_start:]
    hot_loop_start = step_source.index("TransferAuditScope hot_loop")
    hot_loop_end = step_source.index("if (ctx.transfer_audit.audit.hot_loop_violation)")
    finalize = step_source.index("gpu_rk_finalize_step_stats(")

    assert hot_loop_start < hot_loop_end < finalize
    assert "stats.max_rhs_amplitude = 0.0" not in gpu_rk_stats_source
    assert "gpu_rk_read_scalar_results(" in gpu_rk_stats_source
    assert "cudaMemcpyAsync(" in scalar_readback_source
    assert (
        "record_device_to_host(ctx.transfer_audit.audit, count * sizeof(double))"
        in scalar_readback_source
    )


def test_gpu_rk_step_stats_are_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    plan_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    rk_header_source = GPU_RK_HPP_PATH.read_text(encoding="utf-8")
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    stats_header = GPU_RK_STEP_STATS_HPP_PATH.read_text(encoding="utf-8")
    stats_source = GPU_RK_STEP_STATS_CU_PATH.read_text(encoding="utf-8")
    publication_header = GPU_RK_STEP_STATS_PUBLICATION_HPP_PATH.read_text(
        encoding="utf-8"
    )
    publication_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(
        encoding="utf-8"
    )
    energy_header = GPU_RK_ENERGY_REDUCTIONS_HPP_PATH.read_text(encoding="utf-8")
    energy_source = GPU_RK_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    exchange_energy_header = GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    exchange_energy_source = GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    external_energy_header = GPU_RK_EXTERNAL_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    external_energy_source = GPU_RK_EXTERNAL_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    demag_energy_header = GPU_RK_DEMAG_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    demag_energy_source = GPU_RK_DEMAG_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    dmi_energy_header = GPU_RK_DMI_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    dmi_energy_source = GPU_RK_DMI_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_energy_header = GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_energy_source = GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    magnetoelastic_energy_header = (
        GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_HPP_PATH.read_text(
            encoding="utf-8"
        )
    )
    magnetoelastic_energy_source = (
        GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_CU_PATH.read_text(
            encoding="utf-8"
        )
    )
    observable_header = GPU_RK_OBSERVABLE_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    observable_source = GPU_RK_OBSERVABLE_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    field_metric_header = GPU_RK_FIELD_METRIC_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    field_metric_source = GPU_RK_FIELD_METRIC_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_header = GPU_RK_MAGNETIZATION_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_source = GPU_RK_MAGNETIZATION_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu/cuda/integrators/rk/rk_step_stats.cpp" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_step_stats_publication.cpp" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_step_stats.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_energy_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_external_energy_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_demag_energy_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_observable_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_field_metric_reductions.cu" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_magnetization_reductions.cu" in cmake_source
    assert "bool gpu_rk_finalize_step_stats(" not in plan_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in refresh_source
    assert "GPU CUDA RK final step stats module header" in stats_header
    assert "enum class GpuFinalScalarSlot" in stats_header
    assert "gpu_rk_final_scalar_result(" in stats_header
    assert "gpu_rk_finalize_step_stats(" in stats_header
    assert "GPU CUDA RK final step stats source contract" in stats_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in stats_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_step_stats_publication.hpp"'
        in stats_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"' in stats_source
    assert '#include "gpu/cuda/integrators/rk/rk_observable_reductions.hpp"' in stats_source
    assert "bool gpu_rk_finalize_step_stats(" in stats_source
    assert "gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)" in stats_source
    assert (
        "gpu_rk_reduce_final_observable_terms(ctx, stream, n, blocks, reason)"
        in stats_source
    )
    assert "gpu_rk_read_scalar_results(" in stats_source
    assert "gpu_rk_publish_final_step_stats(ctx, scalars, stats)" in stats_source
    assert "GPU CUDA RK final step stats publication module header" in publication_header
    assert "gpu_rk_publish_final_step_stats(" in publication_header
    assert (
        "GPU CUDA RK final step stats publication source contract"
        in publication_source
    )
    assert (
        '#include "gpu/cuda/integrators/rk/rk_step_stats_publication.hpp"'
        in publication_source
    )
    assert "#if FULLMAG_HAS_MFEM_STACK" in publication_source
    assert "#endif // FULLMAG_HAS_MFEM_STACK" in publication_source
    assert "stats.total_energy_joules =" in publication_source
    assert "stats.mx = mx_sum / magnetic_count" in publication_source
    assert "fill_demag_solver_stats(ctx, stats)" in publication_source
    assert "context_update_stage_completion_from_stats(ctx, stats)" in publication_source
    for publication_detail in (
        "stats.total_energy_joules =",
        "stats.mx = mx_sum / magnetic_count",
        "fill_demag_solver_stats(ctx, stats)",
        "context_update_stage_completion_from_stats(ctx, stats)",
    ):
        assert publication_detail not in stats_source
    assert "GPU CUDA RK final energy reductions module header" in energy_header
    assert "gpu_rk_reduce_final_energy_terms(" in energy_header
    assert "GPU CUDA RK final energy reductions source contract" in energy_source
    assert '#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"' in energy_source
    assert '#include "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp"' in energy_source
    assert '#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"' in energy_source
    assert '#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"' in energy_source
    assert '#include "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp"' in energy_source
    assert '#include "gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp"' in energy_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp"'
        in energy_source
    )
    assert "GPU CUDA RK exchange final energy reductions module header" in exchange_energy_header
    assert "gpu_rk_reduce_final_exchange_energy_terms(" in exchange_energy_header
    assert "GPU CUDA RK exchange final energy reductions source contract" in exchange_energy_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp"'
        in exchange_energy_source
    )
    assert "GPU CUDA RK external final energy reductions module header" in external_energy_header
    assert "gpu_rk_reduce_final_external_energy_terms(" in external_energy_header
    assert "GPU CUDA RK external final energy reductions source contract" in external_energy_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp"'
        in external_energy_source
    )
    assert "GPU CUDA RK anisotropy final energy reductions module header" in anisotropy_energy_header
    assert "gpu_rk_reduce_final_anisotropy_energy_terms(" in anisotropy_energy_header
    assert "GPU CUDA RK anisotropy final energy reductions source contract" in anisotropy_energy_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp"'
        in anisotropy_energy_source
    )
    assert "GPU CUDA RK demag final energy reductions module header" in demag_energy_header
    assert "gpu_rk_reduce_final_demag_energy_terms(" in demag_energy_header
    assert "GPU CUDA RK demag final energy reductions source contract" in demag_energy_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"'
        in demag_energy_source
    )
    assert "GPU CUDA RK DMI final energy reductions module header" in dmi_energy_header
    assert "gpu_rk_reduce_final_dmi_energy_terms(" in dmi_energy_header
    assert "GPU CUDA RK DMI final energy reductions source contract" in dmi_energy_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"'
        in dmi_energy_source
    )
    assert (
        "GPU CUDA RK magnetoelastic final energy reductions module header"
        in magnetoelastic_energy_header
    )
    assert (
        "gpu_rk_reduce_final_magnetoelastic_energy_terms("
        in magnetoelastic_energy_header
    )
    assert (
        "GPU CUDA RK magnetoelastic final energy reductions source contract"
        in magnetoelastic_energy_source
    )
    assert (
        '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp"'
        in magnetoelastic_energy_source
    )
    assert "GPU CUDA RK final observable reductions module header" in observable_header
    assert "gpu_rk_reduce_final_observable_terms(" in observable_header
    assert "GPU CUDA RK final observable reductions source contract" in observable_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_observable_reductions.hpp"'
        in observable_source
    )
    assert (
        '#include "gpu/cuda/integrators/rk/rk_field_metric_reductions.hpp"'
        in observable_source
    )
    assert (
        '#include "gpu/cuda/integrators/rk/rk_magnetization_reductions.hpp"'
        in observable_source
    )
    assert "gpu_rk_reduce_final_field_metric_terms(ctx, stream, n, blocks, reason)" in observable_source
    assert "gpu_rk_reduce_final_magnetization_terms(ctx, stream, n, blocks, reason)" in observable_source
    assert "GPU CUDA RK field metric final reductions module header" in field_metric_header
    assert "gpu_rk_reduce_final_field_metric_terms(" in field_metric_header
    assert "GPU CUDA RK field metric final reductions source contract" in field_metric_source
    assert '#include "gpu/cuda/kernels/kernels.hpp"' not in field_metric_source
    assert '#include "gpu/cuda/observables/observable_kernels.hpp"' in field_metric_source
    assert '#include "gpu/cuda/reductions/reduction_kernels.hpp"' in field_metric_source
    assert "fullmag_cuda_field_metric_blocks(" in field_metric_source
    assert "GpuFinalScalarSlot::MaxTorque" in field_metric_source
    assert "GPU CUDA RK magnetization final reductions module header" in magnetization_header
    assert "gpu_rk_reduce_final_magnetization_terms(" in magnetization_header
    assert "GPU CUDA RK magnetization final reductions source contract" in magnetization_source
    assert '#include "gpu/cuda/kernels/kernels.hpp"' not in magnetization_source
    assert '#include "gpu/cuda/observables/observable_kernels.hpp"' in magnetization_source
    assert '#include "gpu/cuda/reductions/reduction_kernels.hpp"' in magnetization_source
    assert "fullmag_cuda_magnetization_sum_blocks(" in magnetization_source
    assert "GpuFinalScalarSlot::MagneticCount" in magnetization_source
    assert "gpu_rk_reduce_final_exchange_energy_terms(ctx, stream, n, blocks, reason)" in energy_source
    assert "fullmag_cuda_legacy_sparse_exchange_energy_blocks(" in exchange_energy_source
    assert "GpuFinalScalarSlot::ExchangeEnergy" in exchange_energy_source
    assert "fullmag_cuda_legacy_sparse_exchange_energy_blocks(" not in energy_source
    assert "gpu_rk_reduce_final_external_energy_terms(ctx, stream, n, blocks, reason)" in energy_source
    assert "fullmag_cuda_external_energy_blocks(" in external_energy_source
    assert "GpuFinalScalarSlot::ExternalEnergy" in external_energy_source
    assert "fullmag_cuda_external_energy_blocks(" not in energy_source
    assert (
        "gpu_rk_reduce_final_demag_energy_terms(ctx, stream, n, blocks, reason)"
        in energy_source
    )
    assert "fullmag_cuda_demag_energy_blocks(" in demag_energy_source
    assert "GpuFinalScalarSlot::DemagEnergy" in demag_energy_source
    assert "GpuFinalScalarSlot::DemagRobinBoundaryEnergy" in demag_energy_source
    assert "fullmag_cuda_demag_energy_blocks(" not in energy_source
    assert (
        "gpu_rk_reduce_final_anisotropy_energy_terms(ctx, stream, n, blocks, reason)"
        in energy_source
    )
    assert "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(" in anisotropy_energy_source
    assert "fullmag_cuda_cubic_anisotropy_field_energy_blocks(" in anisotropy_energy_source
    assert "GpuFinalScalarSlot::AnisotropyEnergy" in anisotropy_energy_source
    assert "GpuFinalScalarSlot::CubicAnisotropyEnergy" in anisotropy_energy_source
    assert "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(" not in energy_source
    assert "fullmag_cuda_cubic_anisotropy_field_energy_blocks(" not in energy_source
    assert "gpu_rk_reduce_final_dmi_energy_terms(ctx, stream, n, reason)" in energy_source
    assert "fullmag_cuda_dmi_field_energy(" in dmi_energy_source
    assert "GpuFinalScalarSlot::DmiEnergy" in dmi_energy_source
    assert "GpuFinalScalarSlot::BulkDmiEnergy" in dmi_energy_source
    assert "fullmag_cuda_dmi_field_energy(" not in energy_source
    assert (
        "gpu_rk_reduce_final_magnetoelastic_energy_terms(ctx, stream, n, blocks, reason)"
        in energy_source
    )
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" in magnetoelastic_energy_source
    assert "GpuFinalScalarSlot::MagnetoelasticEnergy" in magnetoelastic_energy_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" not in energy_source
    assert "fullmag_cuda_legacy_sparse_exchange_energy_blocks(" not in stats_source
    assert "fullmag_cuda_external_energy_blocks(" not in stats_source
    assert "fullmag_cuda_dmi_field_energy(" not in stats_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" not in stats_source
    assert "fullmag_cuda_field_metric_blocks(" not in stats_source
    for delegated_observable_detail in (
        "fullmag_cuda_field_metric_blocks(",
        "fullmag_cuda_magnetization_sum_blocks(",
        "GpuFinalScalarSlot::MaxTorque",
        "GpuFinalScalarSlot::MagneticCount",
        "launch GPU RK max H_eff reduction",
        "launch GPU RK magnetic count reduction",
    ):
        assert delegated_observable_detail not in observable_source
    for delegated_stats_detail in (
        "fullmag_cuda_field_metric_blocks(",
        "fullmag_cuda_magnetization_sum_blocks(",
        "launch GPU RK max H_eff reduction",
        "launch GPU RK magnetic count reduction",
    ):
        assert delegated_stats_detail not in stats_source
    assert "gpu_rk_read_scalar_results(" in stats_source
    assert "bool gpu_rk_finalize_step_stats(" not in rk_step_source
    assert "enum class GpuFinalScalarSlot" not in rk_step_source


def test_gpu_rk_exchange_energy_reductions_are_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    energy_source = GPU_RK_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    exchange_header = GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    exchange_source = GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.cu" in cmake_source
    assert '#include "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp"' in energy_source
    assert "gpu_rk_reduce_final_exchange_energy_terms(ctx, stream, n, blocks, reason)" in energy_source
    assert "GPU CUDA RK exchange final energy reductions module header" in exchange_header
    assert "gpu_rk_reduce_final_exchange_energy_terms(" in exchange_header
    assert "GPU CUDA RK exchange final energy reductions source contract" in exchange_source
    assert '#include "gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp"' in exchange_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in exchange_source
    assert "fullmag_cuda_legacy_sparse_exchange_energy_blocks(" in exchange_source
    assert "GpuFinalScalarSlot::ExchangeEnergy" in exchange_source
    assert "launch GPU RK exchange energy blocks" in exchange_source
    assert "launch GPU RK exchange energy reduction" in exchange_source
    assert "fullmag_cuda_device_sum(" in exchange_source
    for delegated in (
        "fullmag_cuda_legacy_sparse_exchange_energy_blocks(",
        "GpuFinalScalarSlot::ExchangeEnergy",
        "launch GPU RK exchange energy blocks",
        "launch GPU RK exchange energy reduction",
    ):
        assert delegated not in energy_source


def test_gpu_rk_external_energy_reductions_are_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    energy_source = GPU_RK_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    external_header = GPU_RK_EXTERNAL_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    external_source = GPU_RK_EXTERNAL_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu/cuda/integrators/rk/rk_external_energy_reductions.cu" in cmake_source
    assert '#include "gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp"' in energy_source
    assert "gpu_rk_reduce_final_external_energy_terms(ctx, stream, n, blocks, reason)" in energy_source
    assert "GPU CUDA RK external final energy reductions module header" in external_header
    assert "gpu_rk_reduce_final_external_energy_terms(" in external_header
    assert "GPU CUDA RK external final energy reductions source contract" in external_source
    assert '#include "gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp"' in external_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in external_source
    assert "ctx.zeeman.has_external_field" in external_source
    assert "fullmag_cuda_external_energy_blocks(" in external_source
    assert "GpuFinalScalarSlot::ExternalEnergy" in external_source
    assert "launch GPU RK external energy blocks" in external_source
    assert "launch GPU RK external energy reduction" in external_source
    assert "GPU RK external energy requires device-resident Ms, lumped mass, and H_ext" in external_source
    assert "fullmag_cuda_device_sum(" in external_source
    for delegated in (
        "fullmag_cuda_external_energy_blocks(",
        "GpuFinalScalarSlot::ExternalEnergy",
        "launch GPU RK external energy blocks",
        "launch GPU RK external energy reduction",
        "GPU RK external energy requires device-resident Ms, lumped mass, and H_ext",
    ):
        assert delegated not in energy_source


def test_gpu_rk_demag_energy_reductions_are_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    energy_source = GPU_RK_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    demag_header = GPU_RK_DEMAG_ENERGY_REDUCTIONS_HPP_PATH.read_text(encoding="utf-8")
    demag_source = GPU_RK_DEMAG_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_demag_energy_reductions.cu" in cmake_source
    assert '#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"' in energy_source
    assert "gpu_rk_reduce_final_demag_energy_terms(ctx, stream, n, blocks, reason)" in energy_source
    assert "GPU CUDA RK demag final energy reductions module header" in demag_header
    assert "gpu_rk_reduce_final_demag_energy_terms(" in demag_header
    assert "GPU CUDA RK demag final energy reductions source contract" in demag_source
    assert '#include "gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp"' in demag_source
    assert '#include "gpu/cuda/demag_poisson/stage_compute.hpp"' in demag_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in demag_source
    assert "fullmag_cuda_demag_energy_blocks(" in demag_source
    assert "ctx.demag.enabled" in demag_source
    assert "ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN" in demag_source
    assert "reduce_device_demag_robin_boundary_energy(" in demag_source
    assert "GpuFinalScalarSlot::DemagEnergy" in demag_source
    assert "GpuFinalScalarSlot::DemagRobinBoundaryEnergy" in demag_source
    assert "launch GPU RK demag energy blocks" in demag_source
    assert "launch GPU RK demag energy reduction" in demag_source
    assert (
        "GPU RK demag energy requires device-resident Ms, lumped mass, and H_demag"
        in demag_source
    )
    assert "fullmag_cuda_device_sum(" in demag_source
    for delegated in (
        "fullmag_cuda_demag_energy_blocks(",
        "GpuFinalScalarSlot::DemagEnergy",
        "GpuFinalScalarSlot::DemagRobinBoundaryEnergy",
        "GPU RK demag energy requires device-resident Ms, lumped mass, and H_demag",
        "reduce_device_demag_robin_boundary_energy(",
    ):
        assert delegated not in energy_source


def test_gpu_rk_dmi_energy_reductions_are_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    energy_source = GPU_RK_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    dmi_header = GPU_RK_DMI_ENERGY_REDUCTIONS_HPP_PATH.read_text(encoding="utf-8")
    dmi_source = GPU_RK_DMI_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu" in cmake_source
    assert '#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"' in energy_source
    assert "gpu_rk_reduce_final_dmi_energy_terms(ctx, stream, n, reason)" in energy_source
    assert "GPU CUDA RK DMI final energy reductions module header" in dmi_header
    assert "gpu_rk_reduce_final_dmi_energy_terms(" in dmi_header
    assert "GPU CUDA RK DMI final energy reductions source contract" in dmi_source
    assert '#include "gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp"' in dmi_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in dmi_source
    assert "fullmag_cuda_dmi_field_energy(" in dmi_source
    assert "GPU RK DMI energy requires device-resident mesh geometry, Ms, lumped mass, and residual buffers" in dmi_source
    assert "ctx.dmi.interfacial_enabled" in dmi_source
    assert "ctx.dmi.bulk_enabled" in dmi_source
    assert "GpuFinalScalarSlot::DmiEnergy" in dmi_source
    assert "GpuFinalScalarSlot::BulkDmiEnergy" in dmi_source
    assert "launch GPU RK interfacial DMI energy blocks" in dmi_source
    assert "launch GPU RK bulk DMI energy blocks" in dmi_source
    assert "fullmag_cuda_device_sum(" in dmi_source
    for delegated in (
        "auto compute_dmi_energy",
        "fullmag_cuda_dmi_field_energy(",
        "GpuFinalScalarSlot::DmiEnergy",
        "GpuFinalScalarSlot::BulkDmiEnergy",
        "GPU RK DMI energy requires device-resident mesh geometry",
    ):
        assert delegated not in energy_source


def test_gpu_rk_anisotropy_energy_reductions_are_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    energy_source = GPU_RK_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    anisotropy_header = GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_HPP_PATH.read_text(
        encoding="utf-8"
    )
    anisotropy_source = GPU_RK_ANISOTROPY_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )

    assert "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu" in cmake_source
    assert '#include "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp"' in energy_source
    assert "gpu_rk_reduce_final_anisotropy_energy_terms(ctx, stream, n, blocks, reason)" in energy_source
    assert "GPU CUDA RK anisotropy final energy reductions module header" in anisotropy_header
    assert "gpu_rk_reduce_final_anisotropy_energy_terms(" in anisotropy_header
    assert "GPU CUDA RK anisotropy final energy reductions source contract" in anisotropy_source
    assert '#include "gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp"' in anisotropy_source
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in anisotropy_source
    assert "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(" in anisotropy_source
    assert "fullmag_cuda_cubic_anisotropy_field_energy_blocks(" in anisotropy_source
    assert "GPU RK uniaxial anisotropy energy requires device-resident Ms, Ku, Ku2, lumped mass, and H_ani buffers" in anisotropy_source
    assert "GPU RK cubic anisotropy energy requires device-resident Ms, Kc1/Kc2/Kc3, lumped mass, and H_cubic buffers" in anisotropy_source
    assert "ctx.anisotropy.uniaxial_enabled" in anisotropy_source
    assert "ctx.anisotropy.cubic_enabled" in anisotropy_source
    assert "GpuFinalScalarSlot::AnisotropyEnergy" in anisotropy_source
    assert "GpuFinalScalarSlot::CubicAnisotropyEnergy" in anisotropy_source
    assert "launch GPU RK uniaxial anisotropy energy blocks" in anisotropy_source
    assert "launch GPU RK cubic anisotropy energy blocks" in anisotropy_source
    assert "fullmag_cuda_device_sum(" in anisotropy_source
    for delegated in (
        "fullmag_cuda_uniaxial_anisotropy_field_energy_blocks(",
        "fullmag_cuda_cubic_anisotropy_field_energy_blocks(",
        "GpuFinalScalarSlot::AnisotropyEnergy",
        "GpuFinalScalarSlot::CubicAnisotropyEnergy",
        "GPU RK uniaxial anisotropy energy requires device-resident",
        "GPU RK cubic anisotropy energy requires device-resident",
    ):
        assert delegated not in energy_source


def test_gpu_rk_magnetoelastic_energy_reductions_are_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    energy_source = GPU_RK_ENERGY_REDUCTIONS_CU_PATH.read_text(encoding="utf-8")
    magnetoelastic_header = (
        GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_HPP_PATH.read_text(
            encoding="utf-8"
        )
    )
    magnetoelastic_source = (
        GPU_RK_MAGNETOELASTIC_ENERGY_REDUCTIONS_CU_PATH.read_text(
            encoding="utf-8"
        )
    )

    assert "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.cu" in cmake_source
    assert (
        '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp"'
        in energy_source
    )
    assert (
        "gpu_rk_reduce_final_magnetoelastic_energy_terms(ctx, stream, n, blocks, reason)"
        in energy_source
    )
    assert (
        "GPU CUDA RK magnetoelastic final energy reductions module header"
        in magnetoelastic_header
    )
    assert "gpu_rk_reduce_final_magnetoelastic_energy_terms(" in magnetoelastic_header
    assert (
        "GPU CUDA RK magnetoelastic final energy reductions source contract"
        in magnetoelastic_source
    )
    assert (
        '#include "gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp"'
        in magnetoelastic_source
    )
    assert '#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"' in magnetoelastic_source
    assert "fullmag_cuda_magnetoelastic_field_energy_blocks(" in magnetoelastic_source
    assert "ctx.magnetoelastic.enabled" in magnetoelastic_source
    assert (
        "use_per_node_strain ? gpu.magnetoelastic.strain_voigt : nullptr"
        in magnetoelastic_source
    )
    assert "GpuFinalScalarSlot::MagnetoelasticEnergy" in magnetoelastic_source
    assert "launch GPU RK magnetoelastic energy blocks" in magnetoelastic_source
    assert "launch GPU RK magnetoelastic energy reduction" in magnetoelastic_source
    assert (
        "GPU RK magnetoelastic energy requires prescribed strain data"
        in magnetoelastic_source
    )
    assert (
        "GPU RK magnetoelastic energy requires 6 prescribed strain Voigt values per node"
        in magnetoelastic_source
    )
    assert (
        "GPU RK magnetoelastic energy requires device-resident per-node strain"
        in magnetoelastic_source
    )
    assert (
        "GPU RK magnetoelastic energy requires device-resident Ms, lumped mass, and H_mel buffers"
        in magnetoelastic_source
    )
    assert "fullmag_cuda_device_sum(" in magnetoelastic_source
    for delegated in (
        "fullmag_cuda_magnetoelastic_field_energy_blocks(",
        "GpuFinalScalarSlot::MagnetoelasticEnergy",
        "GPU RK magnetoelastic energy requires prescribed strain data",
        "GPU RK magnetoelastic energy requires 6 prescribed strain Voigt values per node",
        "GPU RK magnetoelastic energy requires device-resident per-node strain",
        "GPU RK magnetoelastic energy requires device-resident Ms, lumped mass, and H_mel buffers",
    ):
        assert delegated not in energy_source


def test_gpu_rk_finalize_batches_scalar_device_to_host_readback():
    stats_source = GPU_RK_STEP_STATS_CU_PATH.read_text(encoding="utf-8")
    exchange_energy_source = GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    magnetization_source = GPU_RK_MAGNETIZATION_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    function_start = stats_source.index("bool finalize_step_stats_impl(")
    function_end = stats_source.index("\n} // namespace fullmag::fem", function_start)
    function_source = stats_source[function_start:function_end]

    assert "enum class GpuFinalScalarSlot" in GPU_RK_STEP_STATS_HPP_PATH.read_text(encoding="utf-8")
    assert "read_scalar_results(" in stats_source
    assert "std::array<double, kGpuFinalScalarSlots>" in function_source
    assert "gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)" in function_source
    assert (
        "gpu_rk_reduce_final_observable_terms(ctx, stream, n, blocks, reason)"
        in function_source
    )
    assert "gpu_rk_read_scalar_results(" in function_source
    assert "gpu_rk_read_control_scalar_results(" in function_source
    assert "read_scalar_result(" not in function_source
    assert (
        "gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::ExchangeEnergy)"
        in exchange_energy_source
    )
    assert (
        "gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MagneticCount)"
        in magnetization_source
    )


def test_gpu_rk_final_max_rhs_uses_named_scalar_result_slot():
    refresh_source = GPU_RK_FINAL_REFRESH_CU_PATH.read_text(encoding="utf-8")
    snapshot_source = GPU_RK_SNAPSHOT_CU_PATH.read_text(encoding="utf-8")

    assert "gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)" in refresh_source
    assert "gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)" in snapshot_source


def test_gpu_rk_snapshot_is_owned_by_rk_module():
    cmake_source = FEM_CMAKE_PATH.read_text(encoding="utf-8")
    plan_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    rk_header_source = GPU_RK_HPP_PATH.read_text(encoding="utf-8")
    rk_step_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    snapshot_header = GPU_RK_SNAPSHOT_HPP_PATH.read_text(encoding="utf-8")
    snapshot_source = GPU_RK_SNAPSHOT_CU_PATH.read_text(encoding="utf-8")

    assert "gpu/cuda/integrators/rk/rk_snapshot.cpp" in cmake_source
    assert "gpu/cuda/integrators/rk/rk_snapshot.cu" in cmake_source
    assert "bool gpu_rk_snapshot_current_state(" not in plan_source
    assert "bool gpu_rk_snapshot_current_state(" not in rk_step_source
    assert '#include "gpu/cuda/integrators/rk/rk_snapshot.hpp"' in rk_header_source
    assert "GPU CUDA RK snapshot module header" in snapshot_header
    assert "gpu_rk_snapshot_current_state(" in snapshot_header
    assert "GPU CUDA RK snapshot source contract" in snapshot_source
    assert '#include "gpu/cuda/integrators/rk/rk_snapshot.hpp"' in snapshot_source
    assert '#include "gpu/cuda/kernels/kernels.hpp"' not in snapshot_source
    assert '#include "gpu/cuda/reductions/reduction_kernels.hpp"' in snapshot_source
    assert "bool gpu_rk_snapshot_current_state(" in snapshot_source
    assert "gpu_rk_compute_rhs_for_magnetization(" in snapshot_source
    assert "gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs)" in snapshot_source
    assert "gpu_rk_finalize_step_stats(ctx, stats, reason)" in snapshot_source
    assert "bool gpu_rk_device_resident_step(" not in snapshot_source


def test_gpu_rk_finalize_step_stats_fills_exchange_only_device_metrics():
    observable_kernel_header = GPU_OBSERVABLE_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    observable_kernel_source = GPU_OBSERVABLE_KERNELS_CU_PATH.read_text(encoding="utf-8")
    reduction_kernel_header = GPU_REDUCTION_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    reduction_kernel_source = GPU_REDUCTION_KERNELS_CU_PATH.read_text(encoding="utf-8")
    exchange_kernel_header = GPU_EXCHANGE_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    exchange_kernel_source = GPU_EXCHANGE_KERNELS_CU_PATH.read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(encoding="utf-8")
    exchange_energy_source = GPU_RK_EXCHANGE_ENERGY_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    field_metric_source = GPU_RK_FIELD_METRIC_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )
    compact_gpu_rk_source = " ".join(gpu_rk_source.split())

    assert "fullmag_cuda_legacy_sparse_exchange_energy_blocks" in exchange_kernel_header
    assert "fullmag_cuda_field_metric_blocks" in observable_kernel_header
    assert "fullmag_cuda_device_sum" in reduction_kernel_header
    assert "fullmag_cuda_device_max" in reduction_kernel_header
    assert "cub::DeviceReduce::Sum" in reduction_kernel_source
    assert "cub::DeviceReduce::Max" in reduction_kernel_source
    assert "legacy_sparse_exchange_energy_blocks_kernel" in exchange_kernel_source
    assert "field_metric_blocks_kernel" in observable_kernel_source
    assert "fullmag_cuda_device_sum(" in exchange_energy_source
    assert "fullmag_cuda_legacy_sparse_exchange_energy_blocks(" in exchange_energy_source
    assert "fullmag_cuda_field_metric_blocks(" in field_metric_source
    assert "fullmag_cuda_device_max(" in field_metric_source
    assert "GpuFinalScalarSlot::MaxTorque" in field_metric_source
    assert "stats.exchange_energy_joules = exchange_energy" in gpu_rk_source
    assert "stats.demag_energy_joules = demag_energy" in gpu_rk_source
    assert "stats.external_energy_joules = external_energy" in gpu_rk_source
    assert "stats.anisotropy_energy_joules = anisotropy_energy + cubic_anisotropy_energy" in gpu_rk_source
    assert "stats.dmi_energy_joules = dmi_energy + bulk_dmi_energy" in gpu_rk_source
    assert "stats.magnetoelastic_energy_joules = magnetoelastic_energy" in gpu_rk_source
    assert "stats.total_energy_joules =" in gpu_rk_source
    assert (
        "exchange_energy + demag_energy + external_energy + anisotropy_energy + cubic_anisotropy_energy"
        in compact_gpu_rk_source
    )
    assert "dmi_energy + bulk_dmi_energy + magnetoelastic_energy" in compact_gpu_rk_source
    assert "stats.max_effective_field_amplitude = max_h_eff" in gpu_rk_source
    assert "stats.max_torque_Apm = max_torque" in gpu_rk_source
    assert "stats.demag_solve_count = 0" in gpu_rk_source
    assert "stats.demag_linear_iterations = 0" in gpu_rk_source
    assert "stats.demag_linear_residual = 0.0" in gpu_rk_source
    assert "stats.requested_omp_threads = ctx.cpu_threads.requested_omp_threads" in gpu_rk_source
    assert "stats.effective_omp_threads = ctx.cpu_threads.effective_omp_threads" in gpu_rk_source


def test_gpu_rk_finalize_step_stats_fills_average_magnetization_without_field_readback():
    c_header = (REPO_ROOT / "native" / "include" / "fullmag_fem.h").read_text(
        encoding="utf-8"
    )
    rust_ffi = (REPO_ROOT / "crates" / "fullmag-fem-sys" / "src" / "lib.rs").read_text(
        encoding="utf-8"
    )
    native_fem = (
        REPO_ROOT / "crates" / "fullmag-runner" / "src" / "native_fem.rs"
    ).read_text(encoding="utf-8")
    observable_kernel_header = GPU_OBSERVABLE_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    observable_kernel_source = GPU_OBSERVABLE_KERNELS_CU_PATH.read_text(encoding="utf-8")
    step_metrics_source = STEP_METRICS_CPP_PATH.read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(encoding="utf-8")
    magnetization_source = GPU_RK_MAGNETIZATION_REDUCTIONS_CU_PATH.read_text(
        encoding="utf-8"
    )

    for source in (c_header, rust_ffi):
        assert "double mx;" in source or "pub mx: f64" in source
        assert "double my;" in source or "pub my: f64" in source
        assert "double mz;" in source or "pub mz: f64" in source

    assert "stats.mx = average[0]" in step_metrics_source
    assert "stats.my = average[1]" in step_metrics_source
    assert "stats.mz = average[2]" in step_metrics_source
    assert "mx: stats.mx" in native_fem
    assert "my: stats.my" in native_fem
    assert "mz: stats.mz" in native_fem
    assert "fullmag_cuda_magnetization_sum_blocks" in observable_kernel_header
    assert "magnetization_sum_blocks_kernel" in observable_kernel_source
    assert "fullmag_cuda_magnetization_sum_blocks(" in magnetization_source
    assert "GpuFinalScalarSlot::MagneticCount" in magnetization_source
    assert "stats.mx = mx_sum / magnetic_count" in gpu_rk_source
    assert "stats.my = my_sum / magnetic_count" in gpu_rk_source
    assert "stats.mz = mz_sum / magnetic_count" in gpu_rk_source


def test_gpu_average_magnetization_counts_magnetic_mask_not_nonzero_vectors():
    kernel_source = GPU_OBSERVABLE_KERNELS_CU_PATH.read_text(encoding="utf-8")

    function_start = kernel_source.index("__global__ void magnetization_sum_blocks_kernel(")
    function_end = kernel_source.index("void fullmag_cuda_field_metric_blocks(", function_start)
    function_source = kernel_source[function_start:function_end]

    assert "magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u" in function_source
    assert "local_count = 1.0" in function_source
    assert "fabs(local_x) > 1e-18" not in function_source
    assert "nonzero ? 1.0 : 0.0" not in function_source


def test_gpu_rk_finalize_updates_stage_completion_from_device_metrics():
    stage_completion_header = STAGE_COMPLETION_HPP_PATH.read_text(encoding="utf-8")
    stage_completion_source = STAGE_COMPLETION_CPP_PATH.read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(encoding="utf-8")

    assert "context_update_stage_completion_from_stats" in stage_completion_header
    assert "void context_update_stage_completion_from_stats(" in stage_completion_source
    assert "update_stage_completion_from_stats(ctx, stats)" in stage_completion_source
    assert "context_update_stage_completion_from_stats(ctx, stats)" in gpu_rk_source


def test_gpu_rk_step_records_nonzero_wall_time_before_early_return():
    source = RK_EXPLICIT_STEP_CPP_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool context_step_explicit_rk_mfem(")
    function_source = source[function_start:]
    gpu_call = function_source.index("gpu_rk_device_resident_step(")
    wall_time = function_source.index("stats.wall_time_ns = elapsed_ns(wall_start)", gpu_call)
    early_return = function_source.index("return true;", gpu_call)

    assert gpu_call < wall_time < early_return


def test_gpu_rk_plan_does_not_reject_external_field_after_gpu_energy_metric_support():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    gpu_rk_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(encoding="utf-8")

    assert "ctx.has_external_field" not in rk_source
    assert "external field energy" not in rk_source
    assert "ctx.zeeman.has_external_field" in gpu_rk_source
    assert "external_energy" in gpu_rk_source


def test_gpu_rk_plan_reports_specific_unsupported_term_reasons():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")

    assert "does not support DMI yet" not in rk_source
    assert "does not support bulk DMI yet" not in rk_source
    assert "requires device-resident mesh geometry for DMI" in rk_source
    assert "requires deterministic thermal seed for device thermal field" in rk_source
    assert "requires device-resident mesh geometry for Zhang-Li STT" in rk_source
    assert "local terms or torques" not in rk_source


def test_gpu_rk_plan_supports_dmi_with_device_mesh_geometry():
    cuda_source = GPU_RK_STEP_STATS_PUBLICATION_CPP_PATH.read_text(encoding="utf-8")
    dmi_runtime_source = GPU_RK_DMI_FIELDS_CU_PATH.read_text(encoding="utf-8")
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    dmi_kernel_header = GPU_DMI_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    dmi_kernel_source = GPU_DMI_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "fullmag_cuda_dmi_field_energy" in dmi_kernel_header
    assert "dmi_element_residual_kernel" in dmi_kernel_source
    assert "dmi_project_field_kernel" in dmi_kernel_source
    assert "dmi_tetra_gradients_device" in dmi_kernel_source
    assert "bulk_mode" in dmi_kernel_source
    assert "inv_projection_mass = -1.0 / (kMu0 * ms_i * mass" in dmi_kernel_source
    assert "launch GPU RK interfacial DMI field" in dmi_runtime_source
    assert "launch GPU RK bulk DMI field" in dmi_runtime_source
    assert "launch GPU RK interfacial DMI h_eff accumulation" in effective_source
    assert "launch GPU RK bulk DMI h_eff accumulation" in effective_source
    assert "stats.dmi_energy_joules = dmi_energy + bulk_dmi_energy" in cuda_source


def test_gpu_rk_plan_supports_zhang_li_stt_with_device_mesh_geometry():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    zhang_li_source = GPU_RK_ZHANG_LI_TORQUE_CU_PATH.read_text(encoding="utf-8")
    state_header = GPU_STATE_HPP_PATH.read_text(encoding="utf-8")
    context_source = GPU_STATE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")
    stt_kernel_header = GPU_STT_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    stt_kernel_source = GPU_STT_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "does not support Zhang-Li STT yet" not in rk_source
    assert "ctx.gpu_state.device.mesh_geometry.uploaded" in rk_source
    assert "FemGpuLocalInteractionWorkspaceDeviceState local_interactions{}" in state_header
    assert "FemGpuComponentField zhang_li_rhs" not in state_header
    assert "double *zhang_li_node_weight" not in state_header
    assert "gpu_state_upload_mesh_geometry" in context_source
    assert "fullmag_cuda_add_zhang_li_stt_rhs" in stt_kernel_header
    assert "zhang_li_element_rhs_kernel" in stt_kernel_source
    assert "stt_tetra_gradients_device" in stt_kernel_source
    assert "zhang_li_normalize_add_rhs_kernel" in stt_kernel_source
    assert re.search(r"stt_atomic_add_double\(\s*&work_x\[node\]\s*,", stt_kernel_source)
    assert "atomicAdd(&work_x[node]" not in stt_kernel_source
    assert "gpu.local_interactions.vector.x" in zhang_li_source
    assert "gpu.local_interactions.node_weight" in zhang_li_source
    assert "launch GPU RK Zhang-Li STT RHS" in zhang_li_source


def test_gpu_rk_plan_supports_deterministic_thermal_field_on_device():
    rk_source = GPU_RK_CPP_PATH.read_text(encoding="utf-8")
    thermal_source = GPU_RK_THERMAL_FIELD_CU_PATH.read_text(encoding="utf-8")
    effective_source = GPU_RK_EFFECTIVE_FIELD_CU_PATH.read_text(encoding="utf-8")
    thermal_kernel_header = GPU_THERMAL_KERNELS_HPP_PATH.read_text(encoding="utf-8")
    thermal_kernel_source = GPU_THERMAL_KERNELS_CU_PATH.read_text(encoding="utf-8")

    assert "does not support thermal field yet" not in rk_source
    assert "ctx.thermal_brown.seed == 0" in rk_source
    assert "fullmag_cuda_thermal_field_blocks" in thermal_kernel_header
    assert "thermal_field_blocks_kernel" in thermal_kernel_source
    assert "splitmix64_next" in thermal_kernel_source
    assert "deterministic_normal" in thermal_kernel_source
    assert "ctx.thermal_brown.seed" in thermal_source
    assert "ctx.state.step_count" in thermal_source
    assert "launch GPU RK deterministic thermal field" in thermal_source
    assert "launch GPU RK thermal h_eff accumulation" in effective_source


def test_snapshot_stats_syncs_device_source_magnetization_before_cpu_field_recompute():
    exchange_source = EXCHANGE_RUNTIME_CPP_PATH.read_text(encoding="utf-8")
    snapshot_source = SNAPSHOT_CPP_PATH.read_text(encoding="utf-8")

    refresh_start = exchange_source.index("bool context_refresh_exchange_field_mfem(")
    refresh_end = exchange_source.index("\n} // namespace fullmag::fem", refresh_start)
    refresh_source = exchange_source[refresh_start:refresh_end]
    snapshot_start = snapshot_source.index("bool context_snapshot_stats_mfem(")
    snapshot_end = snapshot_source.index("\n} // namespace fullmag::fem", snapshot_start)
    snapshot_function_source = snapshot_source[snapshot_start:snapshot_end]

    assert "context_sync_gpu_magnetization_to_host(ctx, error)" in refresh_source
    assert "context_sync_gpu_magnetization_to_host(ctx, error)" in snapshot_function_source
    assert snapshot_function_source.index("context_sync_gpu_magnetization_to_host(ctx, error)") < snapshot_function_source.index(
        "compute_effective_fields_for_magnetization("
    )


def test_explicit_rk_stepper_has_controlled_gpu_rk_call_site():
    source = RK_EXPLICIT_STEP_CPP_PATH.read_text(encoding="utf-8")
    header_source = GPU_RK_HPP_PATH.read_text(encoding="utf-8")
    cuda_source = GPU_RK_CU_PATH.read_text(encoding="utf-8")
    function_start = source.index("bool context_step_explicit_rk_mfem(")
    function_end = source.index("\n} // namespace fullmag::fem", function_start)
    function_source = source[function_start:function_end]
    gpu_call_start = function_source.index("gpu_rk_plan_device_resident(")
    workspace_start = function_source.index("stepper_workspace_allocate(")

    assert '#include "gpu/cuda/integrators/rk/rk.hpp"' in source
    assert "bool gpu_rk_device_resident_step(" in header_source
    assert "bool gpu_rk_device_resident_step(" in cuda_source
    assert "bool gpu_rk_exchange_only_step(" not in header_source
    assert "bool gpu_rk_exchange_only_step(" not in cuda_source
    assert gpu_call_start < workspace_start
    assert "gpu_rk_device_resident_step(" in function_source
    assert "gpu_rk_plan.enabled" in function_source
    assert "FULLMAG_FEM_INTEGRATOR_HEUN" in function_source
    assert "FULLMAG_FEM_INTEGRATOR_RK23_BS" in function_source
    assert "FULLMAG_FEM_INTEGRATOR_RK45_DP54" in function_source
    gpu_gate = function_source[gpu_call_start:workspace_start]
    assert "!ctx.adaptive_dt_enabled" not in gpu_gate


def test_preflight_reports_gpu_rk_cuda_source_and_compiler_state():
    bench = load_analysis_benchmark_module()

    report = bench.build_preflight_report(
        {"FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC": "1"}
    )

    assert report["gpu_rk_cuda_source_path"] == str(GPU_RK_CU_PATH)
    assert report["gpu_rk_cuda_source_present"] is True
    assert report["gpu_rk_cmake_wired"] is True
    assert report["assert_no_hot_loop_compute_sync"] is True
    assert isinstance(report["cuda_compiler_available"], bool)
    assert "cuda_compiler_path" in report
    assert "cuda_compiler_source" in report
    assert "adaptive_gpu_rk_acceptance_ready" in report
    assert "adaptive_gpu_rk_acceptance_blockers" in report


def test_preflight_requires_cuda_mfem_and_compute_gate_for_adaptive_gpu_rk(tmp_path, monkeypatch):
    bench = load_analysis_benchmark_module()
    mfem_prefix = tmp_path / "mfem"
    mfem_config_dir = mfem_prefix / "lib" / "cmake" / "mfem"
    mfem_config_dir.mkdir(parents=True)
    (mfem_config_dir / "MFEMConfig.cmake").write_text("# fake mfem config\n", encoding="utf-8")

    missing_gate = bench.build_preflight_report({"MFEM_DIR": str(mfem_prefix)})
    assert missing_gate["adaptive_gpu_rk_acceptance_ready"] is False
    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1" in missing_gate[
        "adaptive_gpu_rk_acceptance_blockers"
    ]

    monkeypatch_nvcc = "/opt/cuda/bin/nvcc"

    gated = bench.build_preflight_report(
        {
            "MFEM_DIR": str(mfem_prefix),
            "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC": "1",
        }
    )
    if not gated["cuda_compiler_available"]:
        assert gated["adaptive_gpu_rk_acceptance_ready"] is False
        assert any(
            "nvcc" in blocker
            for blocker in gated["adaptive_gpu_rk_acceptance_blockers"]
        )
    else:
        assert gated["adaptive_gpu_rk_acceptance_ready"] is True

    monkeypatch.setattr(
        bench.shutil,
        "which",
        lambda name: monkeypatch_nvcc if name == "nvcc" else None,
    )
    gated_with_cuda = bench.build_preflight_report(
        {
            "MFEM_DIR": str(mfem_prefix),
            "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC": "1",
        }
    )

    assert gated_with_cuda["cuda_compiler_available"] is True
    assert gated_with_cuda["adaptive_gpu_rk_acceptance_ready"] is True
    assert gated_with_cuda["adaptive_gpu_rk_hot_loop_scalar_readback_free"] is True
    assert gated_with_cuda["adaptive_gpu_rk_hot_loop_compute_readback_free"] is True
    assert gated_with_cuda["adaptive_gpu_rk_hot_loop_control_readback"] is True
    assert gated_with_cuda["adaptive_gpu_rk_hot_loop_scalar_readback_path"].endswith(
        "backends/fem/gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu"
    )
    assert gated_with_cuda["adaptive_gpu_rk_acceptance_blockers"] == []


def test_preflight_resolves_cuda_compiler_from_container_env_paths(tmp_path, monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(bench.shutil, "which", lambda name: None)
    cuda_home = tmp_path / "cuda"
    nvcc = cuda_home / "bin" / "nvcc"
    nvcc.parent.mkdir(parents=True)
    nvcc.write_text("#!/bin/sh\n", encoding="utf-8")

    cuda_home_report = bench.build_preflight_report({"CUDA_HOME": str(cuda_home)})

    assert cuda_home_report["cuda_compiler_available"] is True
    assert cuda_home_report["cuda_compiler_path"] == str(nvcc)
    assert cuda_home_report["cuda_compiler_source"] == "CUDA_HOME"

    cudacxx = tmp_path / "custom" / "nvcc"
    cudacxx.parent.mkdir()
    cudacxx.write_text("#!/bin/sh\n", encoding="utf-8")

    cudacxx_report = bench.build_preflight_report({"CUDACXX": str(cudacxx)})

    assert cudacxx_report["cuda_compiler_available"] is True
    assert cudacxx_report["cuda_compiler_path"] == str(cudacxx)
    assert cudacxx_report["cuda_compiler_source"] == "CUDACXX"


def test_required_preflight_can_enforce_adaptive_gpu_rk_acceptance(tmp_path):
    bench = load_analysis_benchmark_module()
    report = bench.build_preflight_report({})

    failures = bench.preflight_failures(
        report,
        require_mfem_stack=False,
        require_adaptive_gpu_rk_acceptance=True,
    )

    assert failures
    assert any("adaptive GPU RK acceptance is required" in failure for failure in failures)
    assert any("nvcc" in failure for failure in failures)


def test_benchmark_cli_accepts_preflight_alias(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--preflight"],
    )

    args = bench.parse_args()

    assert args.preflight_only is True
    completed = subprocess.run(
        [sys.executable, str(ANALYSIS_BENCHMARK_PATH), "--help"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "--preflight, --preflight-only" in completed.stdout


def test_benchmark_cli_applies_fem_cpu_no_pbc_adaptive_ready_preset(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--fem-cpu-no-pbc-adaptive-ready-preset"],
    )

    args = bench.parse_args()
    bench.apply_fem_cpu_no_pbc_adaptive_ready_preset(args)

    assert args.backends == "cpu"
    assert args.scenarios == "exchange_demag_anis_uniaxial,exchange_demag_anis_cubic"
    assert args.integrators == "rk23,rk45"
    assert args.timestep_policies == "adaptive"
    assert args.thread_counts == "1,physical_cores/2,physical_cores,auto"
    assert args.min_qualified_steps == 100
    assert args.require_mfem_stack is True
    assert args.require_demag_converged is True
    assert args.require_fem_cpu_no_pbc_adaptive_ready is True
    assert args.require_stable_solver_mesh is True
    assert args.emit_best_demag_policy is True
    assert args.require_best_demag_policy is True


def test_benchmark_cli_applies_box500_airbox_exchange_only_preset(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--box500-airbox-exchange-only-preset"],
    )

    args = bench.parse_args()
    bench.apply_box500_airbox_exchange_only_preset(args)

    assert args.backends == "cpu,gpu"
    assert args.scenarios == "exchange_only_box500_airbox1um"
    assert args.integrators == "heun"
    assert args.timestep_policies == "fixed"
    assert args.thread_counts == "auto"
    assert args.require_mfem_stack is True
    assert args.require_stable_solver_mesh is True
    assert args.require_cpu_gpu_consistency is True


def test_box500_airbox_exchange_only_preset_preserves_explicit_timestep_policy(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        [
            "fem_gpu_benchmark.py",
            "--box500-airbox-exchange-only-preset",
            "--timestep-policies",
            "adaptive",
        ],
    )

    args = bench.parse_args()
    bench.apply_box500_airbox_exchange_only_preset(args)

    assert args.timestep_policies == "adaptive"


def test_benchmark_cli_applies_box500_airbox_interaction_consistency_preset(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--box500-airbox-interaction-consistency-preset"],
    )

    args = bench.parse_args()
    bench.apply_box500_airbox_interaction_consistency_preset(args)

    assert args.backends == "cpu,gpu"
    assert args.meshes == "coarse"
    assert args.scenarios == ",".join(bench.BOX500_AIRBOX_CONSISTENCY_SCENARIOS)
    assert args.integrators == "heun"
    assert args.timestep_policies == "fixed"
    assert args.thread_counts == "auto"
    assert args.require_mfem_stack is True
    assert args.require_stable_solver_mesh is True
    assert args.require_cpu_gpu_consistency is True
    assert args.require_demag_converged is True
    assert args.require_gpu_strict_residency is True


def test_box500_airbox_interaction_preset_preserves_explicit_timestep_policy(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        [
            "fem_gpu_benchmark.py",
            "--box500-airbox-interaction-consistency-preset",
            "--timestep-policies",
            "adaptive",
        ],
    )

    args = bench.parse_args()
    bench.apply_box500_airbox_interaction_consistency_preset(args)

    assert args.timestep_policies == "adaptive"


def test_cpu_gpu_consistency_gate_defaults_to_single_threaded_gmsh(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--require-cpu-gpu-consistency"],
    )

    args = bench.parse_args()

    assert bench.benchmark_mesh_env(args) == {"FULLMAG_GMSH_THREADS": "1"}


def test_explicit_gmsh_threads_override_cpu_gpu_consistency_default(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        [
            "fem_gpu_benchmark.py",
            "--require-cpu-gpu-consistency",
            "--gmsh-threads",
            "4",
        ],
    )

    args = bench.parse_args()

    assert bench.benchmark_mesh_env(args) == {"FULLMAG_GMSH_THREADS": "4"}


def test_box500_airbox_interaction_preset_preserves_requested_integrators(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        [
            "fem_gpu_benchmark.py",
            "--box500-airbox-interaction-consistency-preset",
            "--integrators",
            "heun,rk4,rk23,rk45",
        ],
    )

    args = bench.parse_args()
    bench.apply_box500_airbox_interaction_consistency_preset(args)

    assert args.integrators == "heun,rk4,rk23,rk45"


def test_benchmark_cli_converts_relax_torque_tolerance_t_to_apm(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        [
            "fem_gpu_benchmark.py",
            "--relax-torque-tolerance-t",
            "1e-4",
        ],
    )

    args = bench.parse_args()

    assert bench.resolve_relax_torque_tolerance_apm(args) == pytest.approx(
        bench.RELAX_TORQUE_TOLERANCE_APM
    )


def test_benchmark_cli_accepts_case_timeout(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--case-timeout-s", "123.5"],
    )

    args = bench.parse_args()

    assert args.case_timeout_s == 123.5


def test_benchmark_cli_accepts_cpu_gpu_summary_output(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--cpu-gpu-summary-output", "summary.json"],
    )

    args = bench.parse_args()

    assert args.cpu_gpu_summary_output == "summary.json"


def test_benchmark_cli_accepts_human_and_pdf_report_outputs(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        [
            "fem_gpu_benchmark.py",
            "--human-report-output",
            "report.md",
            "--pdf-report-output",
            "report.pdf",
            "--quiet-json-summary",
        ],
    )

    args = bench.parse_args()

    assert args.human_report_output == "report.md"
    assert args.pdf_report_output == "report.pdf"
    assert args.quiet_json_summary is True


def test_cpu_gpu_human_report_summarizes_case_matrix():
    bench = load_analysis_benchmark_module()
    cpu_gpu_summary = {
        "status": "pass",
        "row_count": 2,
        "ok_count": 2,
        "failed_count": 0,
        "pair_count": 1,
        "completed_pair_case_count": 1,
        "covered_case_count": 1,
        "required_case_count": 1,
        "failure_count": 0,
        "failures": [],
        "case_coverage": [
            {
                "case_id": "box500_airbox_exchange_demag",
                "status": "pass",
                "cpu_average_timing_ms": {
                    "wall_time_ms": 10.0,
                    "demag_wall_time_ms": 6.0,
                    "demag_solver_apply_wall_time_ms": 4.0,
                },
                "gpu_average_timing_ms": {
                    "wall_time_ms": 5.0,
                    "demag_wall_time_ms": 3.0,
                    "demag_solver_apply_wall_time_ms": 2.0,
                },
                "cpu_observable_summary": {
                    "executed_steps": 2.0,
                    "final_e_demag_j": 3.0e-19,
                    "final_torque_t": 0.05,
                },
                "gpu_observable_summary": {
                    "executed_steps": 1.0,
                    "final_e_demag_j": 3.0e-19,
                    "final_torque_t": 0.05,
                },
            }
        ],
        "pairs": [
            {
                "scenario": "box500_airbox_exchange_demag",
                "executed_step_delta": 1,
                "wall_time_speedup_cpu_over_gpu": 2.0,
                "demag_wall_time_speedup_cpu_over_gpu": 2.0,
                "demag_solver_apply_wall_time_speedup_cpu_over_gpu": 2.0,
                "final_e_demag_j_abs_diff": 0.0,
                "final_torque_t_abs_diff": 0.0,
            }
        ],
    }
    pass_fail_summary = {
        "status": "pass",
        "solver_mesh_groups": [
            {
                "solver_mesh_signature": "mesh-a",
                "status": "pass",
                "row_count": 2,
                "ok_count": 2,
                "max_demag_final_residual_norm": 5e-9,
                "max_demag_actual_iterations": 8,
            }
        ],
    }

    report = bench.render_cpu_gpu_benchmark_report(
        cpu_gpu_summary,
        pass_fail_summary,
        csv_path="/tmp/results.csv",
        summary_path="/tmp/summary.json",
    )

    assert "Fullmag FEM CPU/GPU Benchmark Report" in report
    assert "status: pass" in report
    assert "box500_airbox_exchange_demag" in report
    assert "2.000x" in report
    assert "CPU steps" in report
    assert "GPU steps" in report
    assert "Step delta" in report
    assert "CPU steps/min" in report
    assert "GPU steps/min" in report
    assert "12000.000" in report
    assert "/tmp/results.csv" in report


def test_cpu_gpu_report_status_uses_pass_fail_gate_status():
    bench = load_analysis_benchmark_module()

    report = bench.render_cpu_gpu_benchmark_report(
        {
            "status": "fail",
            "row_count": 1,
            "ok_count": 1,
            "failed_count": 0,
            "failure_count": 1,
            "failures": ["no completed FEM CPU/GPU rows with solver_mesh_signature were produced"],
            "case_coverage": [],
            "pairs": [],
        },
        {
            "status": "pass",
            "gate_failure_count": 0,
            "group_failure_count": 0,
            "solver_mesh_groups": [],
        },
    )

    assert "- status: pass" in report
    assert "- cpu/gpu consistency: fail" in report


def test_gpu_only_report_can_skip_unrequested_cpu_gpu_summary():
    bench = load_analysis_benchmark_module()
    rows = [
        {
            "backend": "fem_gpu",
            "status": "ok",
            "scenario": "box500_airbox_exchange_demag",
            "integrator": "heun",
            "relaxation_algorithm": "llg_overdamped",
            "timestep_policy": "fixed",
            "requested_demag_solver": "CG",
            "requested_demag_preconditioner": "JACOBI",
            "wall_time_ms": 20.0,
            "demag_solver_apply_wall_time_ms": 7.0,
            "executed_steps": 3,
            "final_e_demag_j": 1.0e-19,
            "final_torque_t": 0.01,
        }
    ]

    assert (
        bench.benchmark_report_needs_cpu_gpu_summary(
            ["fem_gpu"],
            require_cpu_gpu_consistency=False,
            cpu_gpu_summary_output=None,
        )
        is False
    )
    assert (
        bench.benchmark_report_needs_cpu_gpu_summary(
            ["fem_cpu", "fem_gpu"],
            require_cpu_gpu_consistency=False,
            cpu_gpu_summary_output=None,
        )
        is True
    )

    summary = bench.cpu_gpu_not_requested_summary(rows)

    assert summary["status"] == "not_requested"
    assert summary["failure_count"] == 0
    assert summary["row_count"] == 1
    assert summary["ok_count"] == 1
    assert summary["required_case_count"] == 1
    assert summary["covered_case_count"] == 1
    assert summary["case_coverage"][0]["label"] == (
        "box500_airbox_exchange_demag:llg_overdamped fem_gpu CG/JACOBI"
    )
    assert summary["case_coverage"][0]["gpu_average_timing_ms"]["wall_time_ms"] == 20.0

    report = bench.render_cpu_gpu_benchmark_report(
        summary,
        {
            "status": "pass",
            "gate_failure_count": 0,
            "group_failure_count": 0,
            "solver_mesh_groups": [],
        },
    )

    assert "box500_airbox_exchange_demag:llg_overdamped fem_gpu CG/JACOBI" in report
    assert "- cases: 1/1 covered" in report
    assert "- pairs:" not in report
    assert "20.00" in report
    assert "7.000" in report
    assert "3" in report


def test_cpu_gpu_rich_report_prints_bordered_color_table():
    bench = load_analysis_benchmark_module()
    rich_console = pytest.importorskip("rich.console")

    cpu_gpu_summary = {
        "status": "pass",
        "row_count": 2,
        "ok_count": 2,
        "failed_count": 0,
        "pair_count": 1,
        "completed_pair_case_count": 1,
        "required_case_count": 1,
        "failure_count": 0,
        "case_coverage": [
            {
                "case_id": "box500",
                "status": "pass",
                "cpu_average_timing_ms": {
                    "wall_time_ms": 10.0,
                    "demag_solver_apply_wall_time_ms": 4.0,
                },
                "gpu_average_timing_ms": {
                    "wall_time_ms": 5.0,
                    "demag_solver_apply_wall_time_ms": 2.0,
                },
                "cpu_observable_summary": {"executed_steps": 2.0},
                "gpu_observable_summary": {"executed_steps": 1.0},
            }
        ],
        "pairs": [
            {
                "scenario": "box500",
                "executed_step_delta": 1,
                "wall_time_speedup_cpu_over_gpu": 2.0,
                "demag_solver_apply_wall_time_speedup_cpu_over_gpu": 2.0,
                "final_e_demag_j_abs_diff": 0.0,
                "final_torque_t_abs_diff": 0.0,
            }
        ],
    }
    pass_fail_summary = {
        "status": "pass",
        "gate_failure_count": 0,
        "group_failure_count": 0,
        "solver_mesh_groups": [],
    }
    output = io.StringIO()
    console = rich_console.Console(
        file=output,
        force_terminal=True,
        color_system="standard",
        width=260,
    )

    rendered = bench.print_cpu_gpu_benchmark_rich_report(
        cpu_gpu_summary,
        pass_fail_summary,
        csv_path="/tmp/results.csv",
        summary_path="/tmp/summary.json",
        console=console,
    )

    text = output.getvalue()
    assert rendered is True
    assert "\x1b[" in text
    assert "┏" in text
    assert "Case Runtime And Step Rate" in text
    assert "Demag And Numerical Parity" in text
    assert "CPU demag total ms" in text
    assert "GPU demag total ms" in text
    assert "CPU demag apply ms" in text
    assert "GPU demag apply ms" in text
    assert "12000.000" in text
    assert "2.000x" in text


def test_ensure_python_installs_rich_for_benchmark_reports():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")

    assert "'rich>=13.7'" in justfile_text


def just_recipe_block(justfile_text: str, recipe_name: str) -> str:
    marker = f"{recipe_name}:"
    start = justfile_text.index(marker)
    end = len(justfile_text)
    for next_recipe in re.finditer(r"(?m)^[A-Za-z0-9_-]+(?:\s+[^:\n]+)?:$", justfile_text[start + len(marker) :]):
        end = start + len(marker) + next_recipe.start()
        break
    return justfile_text[start:end]


def test_relaxation_consistency_smoke_passes_benchmark_env_into_container():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    production_recipe = just_recipe_block(
        justfile_text,
        "verify-fem-relaxation-production-benchmark",
    )

    assert "verify-fem-relaxation-cpu-gpu-consistency-smoke:" in justfile_text
    assert "verify-fem-relaxation-production-benchmark:" in justfile_text
    assert (
        '-e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg}"'
        in justfile_text
    )
    assert '-e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-16}"' in justfile_text
    assert '-e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-32}"' in justfile_text
    assert '-e FULLMAG_BENCH_DEMAG_SOLVERS="${FULLMAG_BENCH_DEMAG_SOLVERS:-CG}"' in justfile_text
    assert (
        '-e FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-AMG,JACOBI}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC="${FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC:-1}"'
        in justfile_text
    )
    assert '-e FULLMAG_FEM_STEP_PROFILE="${FULLMAG_FEM_STEP_PROFILE:-}"' in justfile_text
    assert (
        '-e FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP:-4}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP:-0}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP:-3}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP:-2}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_MIN_SOLVER_NODES="${FULLMAG_BENCH_MIN_SOLVER_NODES:-50}"'
        in justfile_text
    )
    assert '-e FULLMAG_BENCH_OUTPUT="${FULLMAG_BENCH_OUTPUT:-.fullmag/reports/fullmag_relaxation_cpu_gpu_consistency_smoke.csv}"' in justfile_text
    assert '-e FULLMAG_BENCH_OUTPUT="${FULLMAG_BENCH_OUTPUT:-.fullmag/reports/fullmag_relaxation_production_benchmark.csv}"' in justfile_text
    assert '--relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS"' in justfile_text
    assert '--demag-solvers "$FULLMAG_BENCH_DEMAG_SOLVERS"' in justfile_text
    assert '--demag-preconditioners "$FULLMAG_BENCH_DEMAG_PRECONDITIONERS"' in justfile_text
    assert "--require-adaptive-gpu-rk-acceptance" in justfile_text
    assert "--require-best-demag-policy" in justfile_text
    assert "--require-gpu-control-readback-budget" in justfile_text
    assert "--require-gpu-phase-timings" in justfile_text
    assert "--gpu-warmup" not in production_recipe
    assert (
        '--gpu-control-readback-per-step "$FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP"'
        in justfile_text
    )
    assert (
        '--gpu-llg-control-readback-per-step "$FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP"'
        in justfile_text
    )
    assert (
        '--gpu-pgbb-control-readback-per-step "$FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP"'
        in justfile_text
    )
    assert (
        '--gpu-ncg-control-readback-per-step "$FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP"'
        in justfile_text
    )
    assert '--require-min-solver-nodes "$FULLMAG_BENCH_MIN_SOLVER_NODES"' in justfile_text
    assert "--require-demag-converged" in justfile_text
    assert "--require-gpu-strict-residency" in justfile_text
    assert "--relax-algorithms \"${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg,tangent_plane_implicit}\"" not in justfile_text


def test_frequency_domain_eigen_runtime_recipe_runs_modal_artifact_verifier():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe = just_recipe_block(
        justfile_text,
        "verify-fem-frequency-domain-eigen-runtime",
    )

    assert "just ensure-managed-fem-runtime" in recipe
    assert "examples/fem_eigenmodes.py" in recipe
    assert "eigen/spectrum.v2.json" in recipe
    assert "eigen/branches.v2.json" in recipe
    assert "eigen/dispersion.csv" in recipe
    assert "eigen/modes/sample_0000/mode_0000.json" in recipe
    assert "eigen/mode_fields/sample_0000/mode_0000/vector.bin" in recipe
    assert "frequency_domain/manifest.v1.json" in recipe
    assert "scripts/verify_fem_frequency_domain_eigen_artifacts.py" in recipe


def test_frequency_domain_runtime_suite_runs_response_static_periodic_and_eigen_gates():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe = just_recipe_block(
        justfile_text,
        "verify-fem-frequency-domain-runtime-suite",
    )

    assert "just verify-fem-frequency-domain-runtime" in recipe
    assert "just verify-fem-frequency-domain-static-periodic-runtime" in recipe
    assert "just verify-fem-frequency-domain-eigen-runtime" in recipe


def test_frequency_domain_gpu_recipe_uses_native_contract_until_gpu_solver_lands():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe = just_recipe_block(justfile_text, "verify-fem-frequency-domain-gpu")
    native_contract = (
        REPO_ROOT / "backends/fem/tests/frequency_domain/frequency_domain_contract.cpp"
    ).read_text(encoding="utf-8")

    assert "just verify-fem-frequency-domain-native-contract" in recipe
    assert "production_gpu" in native_contract
    assert '\\"validation_fallback_used\\":false' in native_contract
    assert "production GPU lane reports unavailable" in native_contract


def test_fem_gpu_demag_performance_benchmark_is_a_larger_mesh_demag_gate():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    demag_recipe = just_recipe_block(
        justfile_text,
        "verify-fem-gpu-demag-performance-benchmark",
    )

    assert "verify-fem-gpu-demag-performance-benchmark:" in justfile_text
    assert '-e FULLMAG_BENCH_DOMAIN_HMAX="${FULLMAG_BENCH_DOMAIN_HMAX:-50e-9}"' in justfile_text
    assert '-e FULLMAG_BENCH_AIRBOX_HMAX="${FULLMAG_BENCH_AIRBOX_HMAX:-100e-9}"' in justfile_text
    assert (
        '-e FULLMAG_BENCH_SCENARIOS="${FULLMAG_BENCH_SCENARIOS:-box500_airbox_exchange_demag,box500_airbox_exchange_demag_anis_uniaxial,box500_airbox_exchange_demag_anis_cubic}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,nonlinear_cg}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-OMIT,AMG,JACOBI}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_MIN_SOLVER_NODES="${FULLMAG_BENCH_MIN_SOLVER_NODES:-800}"'
        in justfile_text
    )
    assert (
        '-e FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP="${FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP:-2}"'
        in justfile_text
    )
    assert '-e FULLMAG_FEM_STEP_PROFILE="${FULLMAG_FEM_STEP_PROFILE:-1}"' in justfile_text
    assert '--scenarios "$FULLMAG_BENCH_SCENARIOS"' in justfile_text
    assert "--gpu-warmup" in demag_recipe
    assert "--require-gpu-phase-timings" in justfile_text
    assert "--require-best-demag-policy" in justfile_text
    assert "--require-gpu-strict-residency" in justfile_text
    assert "--require-min-solver-nodes \"$FULLMAG_BENCH_MIN_SOLVER_NODES\"" in justfile_text
    assert "--min-gpu-demag-total-speedup \"$FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP\"" in justfile_text
    assert "--max-performance-regression-percent \"$FULLMAG_BENCH_MAX_PERFORMANCE_REGRESSION_PERCENT\"" in justfile_text
    assert 'baseline_args+=(--accepted-baseline "$FULLMAG_BENCH_ACCEPTED_BASELINE")' in justfile_text
    assert 'baseline_args+=(--require-accepted-baseline)' in justfile_text
    assert ".fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark.csv" in justfile_text


def test_box500_consistency_just_target_defaults_to_multistep_relaxation():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")

    assert 'bench-fem-box500-consistency mode="quick":' in justfile_text
    assert 'bench_integrators="${FULLMAG_BENCH_INTEGRATORS:-${FULLMAG_BENCH_SOLVERS:-heun,rk4,rk23,rk45}}"' in justfile_text
    assert 'bench_steps="${FULLMAG_BENCH_STEPS:-10}"' in justfile_text
    assert 'bench_step_cap="${FULLMAG_BENCH_STEP_CAP:-1000}"' in justfile_text
    assert 'bench_energy_rtol="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}"' in justfile_text
    assert 'bench_energy_atol_j="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}"' in justfile_text
    assert 'bench_torque_rtol="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}"' in justfile_text
    assert '--integrators "$bench_integrators"' in justfile_text
    assert '--case-timeout-s "$bench_case_timeout_s"' in justfile_text
    assert '--cpu-gpu-energy-rtol "$bench_energy_rtol"' in justfile_text
    assert '--cpu-gpu-energy-atol "$bench_energy_atol_j"' in justfile_text
    assert '--cpu-gpu-torque-rtol "$bench_torque_rtol"' in justfile_text
    assert 'bench_steps="${FULLMAG_BENCH_STEPS:-25}"' not in justfile_text
    assert 'bench_steps="${FULLMAG_BENCH_STEPS:-1}"' not in justfile_text


def test_box500_consistency_just_target_full_mode_runs_full_relaxation():
    justfile_text = (REPO_ROOT / "justfile").read_text(encoding="utf-8")

    assert '[ "{{mode}}" = "full" ]' in justfile_text
    assert 'bench_steps="${FULLMAG_BENCH_STEPS:-1000}"' in justfile_text
    assert (
        'bench_relax_tolerance_t="${FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE_T:-1e-4}"'
        in justfile_text
    )
    assert 'bench_energy_rtol="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-5e-5}"' in justfile_text
    assert 'bench_energy_atol_j="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-24}"' in justfile_text
    assert 'bench_torque_rtol="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-5e-5}"' in justfile_text
    assert 'if [ "$bench_steps" -gt "$bench_step_cap" ]; then' in justfile_text
    assert '--relax-torque-tolerance-t "$bench_relax_tolerance_t"' in justfile_text
    assert '--cpu-gpu-energy-rtol "$bench_energy_rtol"' in justfile_text
    assert '--cpu-gpu-energy-atol "$bench_energy_atol_j"' in justfile_text
    assert '--cpu-gpu-torque-rtol "$bench_torque_rtol"' in justfile_text


def test_write_benchmark_pdf_report_creates_pdf(tmp_path):
    bench = load_analysis_benchmark_module()
    pdf_path = tmp_path / "report.pdf"

    bench.write_benchmark_pdf_report(
        pdf_path,
        "Fullmag FEM CPU/GPU Benchmark Report\nstatus: pass\n",
    )

    data = pdf_path.read_bytes()
    assert data.startswith(b"%PDF-1.4")
    assert b"Fullmag FEM CPU/GPU Benchmark Report" in data


def test_benchmark_cli_rejects_implicit_preflight_abbreviation(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--pref"],
    )

    try:
        bench.parse_args()
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("implicit --pref abbreviation must be rejected")


def test_benchmark_cli_rejects_implicit_skip_preflight_abbreviation(monkeypatch):
    bench = load_analysis_benchmark_module()
    monkeypatch.setattr(
        bench.sys,
        "argv",
        ["fem_gpu_benchmark.py", "--skip"],
    )

    try:
        bench.parse_args()
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("implicit --skip abbreviation must be rejected")


def test_all_in_gpu_docs_describe_compute_only_hot_loop_gate():
    runtime_doc = ALL_IN_GPU_RUNTIME_DOC.read_text(encoding="utf-8")
    rollout_plan = ALL_IN_GPU_PLAN.read_text(encoding="utf-8")

    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1" in runtime_doc
    assert "phase2_compute_assertion_enabled" in runtime_doc
    assert "hot_loop_compute_host_sync_count" in runtime_doc
    assert "hot_loop_exchange_host_sync_count" in runtime_doc
    assert "FULLMAG_FEM_ALL_IN_GPU=1" in runtime_doc
    assert "FULLMAG_FEM_EXECUTION=all_in_gpu" in runtime_doc
    assert "all_in_gpu_contract_unmet" in runtime_doc
    assert "FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1" in rollout_plan
    assert "phase2_compute_assertion_enabled" in rollout_plan
    assert "FULLMAG_FEM_ALL_IN_GPU=1" in rollout_plan
    assert "all_in_gpu_contract_unmet" in rollout_plan
    assert "Samo istnienie hostowej sciezki `compute_exchange_for_magnetization`" in rollout_plan
    assert "dopoki te call-site'y istnieja w sciezce stage exchange" not in rollout_plan
    assert "obecny tryb to\n`unsupported`" not in runtime_doc


def test_preflight_searches_cmake_prefix_path(tmp_path):
    bench = load_analysis_benchmark_module()
    empty_prefix = tmp_path / "empty"
    mfem_prefix = tmp_path / "mfem"
    config_path = mfem_prefix / "share" / "mfem" / "cmake" / "mfem-config.cmake"
    empty_prefix.mkdir()
    config_path.parent.mkdir(parents=True)
    config_path.write_text("# test mfem config\n", encoding="utf-8")

    env = {
        "CMAKE_PREFIX_PATH": os.pathsep.join([str(empty_prefix), str(mfem_prefix)])
    }
    report = bench.build_preflight_report(env)

    assert report["status"] == "ok_mfem_config"
    assert report["mfem_config_path"] == str(config_path)


def test_preflight_accepts_prebuilt_native_library(tmp_path):
    bench = load_analysis_benchmark_module()
    lib_dir = tmp_path / "native"
    lib_dir.mkdir()
    lib_path = lib_dir / "libfullmag_fem.so"
    lib_path.write_text("", encoding="utf-8")

    report = bench.build_preflight_report({"FULLMAG_FEM_LIB_DIR": str(lib_dir)})

    assert report["status"] == "ok_prebuilt"
    assert report["prebuilt_library_path"] == str(lib_path)
    assert bench.is_mfem_stack_ready(report)
    assert "adaptive_gpu_rk_acceptance_ready" in report
    assert "adaptive_gpu_rk_acceptance_blockers" in report
    assert "MFEM stack or prebuilt native FEM library is required" not in report[
        "adaptive_gpu_rk_acceptance_blockers"
    ]


def test_required_preflight_failure_names_actionable_environment_variables():
    bench = load_analysis_benchmark_module()

    report = bench.build_preflight_report({})
    failures = bench.preflight_failures(report, require_mfem_stack=True)

    assert report["status"] == "missing"
    assert failures
    remediation = "\n".join(failures)
    assert "FULLMAG_FEM_LIB_DIR" in remediation
    assert "MFEM_DIR" in remediation
    assert "MFEM_PREFIX" in remediation
    assert "CMAKE_PREFIX_PATH" in remediation


def test_preflight_invalid_prebuilt_still_reports_adaptive_acceptance_gate(tmp_path):
    bench = load_analysis_benchmark_module()
    missing_lib_dir = tmp_path / "native"
    missing_lib_dir.mkdir()

    report = bench.build_preflight_report({"FULLMAG_FEM_LIB_DIR": str(missing_lib_dir)})

    assert report["status"] == "invalid_prebuilt"
    assert report["adaptive_gpu_rk_acceptance_ready"] is False
    assert "MFEM stack or prebuilt native FEM library is required" in report[
        "adaptive_gpu_rk_acceptance_blockers"
    ]


def test_fullmag_use_mfem_stack_env_makes_missing_stack_a_failure():
    bench = load_analysis_benchmark_module()

    report = bench.build_preflight_report({"FULLMAG_USE_MFEM_STACK": "ON"})
    failures = bench.preflight_failures(
        report,
        require_mfem_stack=report["fullmag_use_mfem_stack_enabled"],
    )

    assert report["fullmag_use_mfem_stack_enabled"] is True
    assert failures
