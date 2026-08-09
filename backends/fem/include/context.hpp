#pragma once

#include "core/fem_field_buffers.hpp"
#include "core/fem_material_fields.hpp"
#include "core/fem_mesh.hpp"
#include "core/fem_state.hpp"
#include "core/fem_plan_fields.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/integrators/rk_stepper_workspace.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"
#include "cpu/mfem/interactions/demag.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_workspace.hpp"
#include "cpu/mfem/interactions/demag_poisson_runtime.hpp"
#include "cpu/mfem/interactions/dmi.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/exchange.hpp"
#include "cpu/mfem/interactions/magnetoelastic_prescribed_strain.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/transport_stage.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/interactions/sot.hpp"
#include "cpu/mfem/interactions/thermal_brown_sampler.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"
#include "cpu/mfem/runtime/cpu_threads.hpp"
#include "cpu/mfem/relaxation/relaxation_step.hpp"
#include "gpu/cuda/runtime/gpu_state_runtime.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/mfem_context.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "fullmag_fem.h"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class BilinearForm;
class Coefficient;
class FiniteElementCollection;
class FiniteElementSpace;
class GridFunction;
class H1_FECollection;
class HypreParMatrix;
class HypreSolver;
class LinearForm;
class Mesh;
class SparseMatrix;
class Vector;
}

namespace fullmag::fem {

struct DemagRecoveryWorkspace;
struct PoissonHypreWorkspace;
struct PoissonRhsWorkspace;

struct Context {
    FemBasePlanRuntimeState base_plan{};

    AdaptiveDtRuntimeState adaptive_dt{};

    AnisotropyRuntimeState anisotropy{};

    // ── Magnetoelastic coupling (prescribed-strain) ──────────────────
    MagnetoelasticRuntimeState magnetoelastic{};

    FemMaterialFieldsRuntimeState material_fields{};

    StageCompletionRuntimeState stage_completion{};

    FemMeshRuntimeState mesh{};
    FemStateRuntimeState state{};
    ExchangeRuntimeState exchange{};
    DemagRuntimeState demag{};
    ZeemanRuntimeState zeeman{};
    DmiRuntimeState dmi{};
    EffectiveFieldRuntimeState effective_field{};

    SttRuntimeState stt{};
    SotRuntimeState sot{};

    // ── Oersted field (cylindrical conductor or explicit nodal H field) ──
    OerstedRuntimeState oersted{};
    TransportStageRuntimeState stage_transport{};

    ThermalBrownRuntimeState thermal_brown{};

    FemIntegrationWeightsRuntimeState integration_weights{};

    MfemDeviceRuntimeState mfem_device{};

    // CPU OpenMP runtime diagnostics for Poisson/Robin demag and telemetry.
    CpuThreadRuntimeState cpu_threads{};
    MfemContextRuntimeState mfem_context{};

#if FULLMAG_HAS_MFEM_STACK
    // ── Poisson demag (S02-S05) ──
    PoissonDemagRuntimeState poisson_demag{};

    // Body-only Fredkin-Koehler FEM/BEM demag subsystem.
    DemagFemBemRuntimeState demag_fem_bem{};
#endif

    TransferAuditRuntimeState transfer_audit{};
    GpuStateRuntimeState gpu_state{};

    // ── Unified RK stepper runtime workspace ──
    RkStepperRuntimeState stepper{};

    FemRelaxationRuntimeState relaxation{};

    InterruptRuntimeState interrupt{};
};

bool context_from_plan(Context &ctx, const fullmag_fem_plan_desc &plan, std::string &error);

} // namespace fullmag::fem
