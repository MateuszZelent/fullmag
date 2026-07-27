/*
 * Native FEM relaxation source-layout contract.
 *
 * Production FEM energy minimizers must live in backends/fem, not in Rust
 * runner reference/orchestration paths. Keep algorithm files split so BB, NCG,
 * and tangent-plane work can evolve without recreating a monolith.
 */

#include "source_facade_contract_utils.hpp"

#include <cctype>

namespace {

using fullmag::fem::tests::check;
using fullmag::fem::tests::fem_source_root;
using fullmag::fem::tests::read_text_file;
using fullmag::fem::tests::repo_root;

std::string compact_source(const std::string &source) {
    std::string compact;
    compact.reserve(source.size());
    for (const unsigned char character : source) {
        if (!std::isspace(character)) {
            compact.push_back(static_cast<char>(character));
        }
    }
    return compact;
}

size_t count_occurrences(
    const std::string &source,
    const std::string &needle) {
    size_t count = 0;
    size_t position = 0;
    while ((position = source.find(needle, position)) != std::string::npos) {
        ++count;
        position += needle.size();
    }
    return count;
}

void native_relaxation_algorithms_live_under_mfem_relaxation() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path relaxation_root =
        root / "cpu" / "mfem" / "relaxation";

    check(
        std::filesystem::exists(relaxation_root / "relaxation_step.hpp"),
        "native FEM relaxation must expose a module-owned relaxation_step.hpp");
    check(
        std::filesystem::exists(relaxation_root / "relaxation_step.cpp"),
        "native FEM relaxation must own production minimizer step dispatch");
    check(
        std::filesystem::exists(relaxation_root / "relaxation_math.hpp") &&
            std::filesystem::exists(relaxation_root / "relaxation_math.cpp"),
        "native FEM relaxation must keep shared tangent-space math out of algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "projected_gradient_bb.hpp") &&
            std::filesystem::exists(relaxation_root / "projected_gradient_bb.cpp"),
        "native FEM projected-gradient BB must live in dedicated algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "nonlinear_cg.hpp") &&
            std::filesystem::exists(relaxation_root / "nonlinear_cg.cpp"),
        "native FEM nonlinear CG must live in dedicated algorithm files");
    check(
        std::filesystem::exists(relaxation_root / "tangent_plane_implicit.hpp") &&
            std::filesystem::exists(relaxation_root / "tangent_plane_implicit.cpp"),
        "native FEM tangent-plane implicit relaxation must have dedicated native files");
}

void cuda_term_complete_energy_difference_migration_is_atomic() {
    const std::filesystem::path root = fem_source_root();
    const std::string relaxation_numerics =
        read_text_file(root / "src" / "relaxation_numerics.hpp");
    const std::string direct_energy_header = read_text_file(
        root / "gpu" / "cuda" / "relaxation" / "direct_energy_increment.hpp");
    const std::string direct_energy_source = read_text_file(
        root / "gpu" / "cuda" / "relaxation" / "direct_energy_increment.cpp");
    const std::string pgbb_source = read_text_file(
        root / "gpu" / "cuda" / "relaxation" / "pgbb.cpp");
    const std::string kernels_source = read_text_file(
        root / "gpu" / "cuda" / "relaxation" / "pgbb_kernels.cu");
    const std::string exchange_header = read_text_file(
        root / "gpu" / "cuda" / "exchange" / "exchange_kernels.hpp");
    const std::string exchange_source = read_text_file(
        root / "gpu" / "cuda" / "exchange" / "exchange_kernels.cu");
    const std::string dmi_header = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.hpp");
    const std::string dmi_source = read_text_file(
        root / "gpu" / "cuda" / "interactions" / "dmi" / "dmi_kernels.cu");
    const std::string reduction_workspace_header = read_text_file(
        root / "gpu" / "cuda" / "reductions" /
        "reduction_workspace_state.hpp");
    const auto term_complete_start = relaxation_numerics.find(
        "inline EnergyDifference compose_term_complete_energy_difference(");
    const auto legacy_start = relaxation_numerics.find(
        "inline EnergyDifference compose_direct_energy_difference(");
    const std::string term_complete =
        term_complete_start == std::string::npos
            ? std::string()
            : relaxation_numerics.substr(
                  term_complete_start,
                  legacy_start == std::string::npos
                      ? std::string::npos
                      : legacy_start - term_complete_start);

    check(
        !term_complete.empty() &&
            term_complete.find(
                "double endpoint_residual_operand_absolute_sum_joules") !=
                std::string::npos &&
            term_complete.find(
                "endpoint_residual_operand_absolute_sum_joules +") !=
                std::string::npos &&
            term_complete.find("direct_absolute_term_sum_joules") !=
                std::string::npos &&
            term_complete.find(
                "std::abs(endpoint_residual_delta_joules)") ==
                std::string::npos,
        "term-complete FEM Armijo composition must use explicit endpoint operand magnitudes instead of the cancelled residual delta");
    check(
        legacy_start == std::string::npos &&
            relaxation_numerics.find("endpoint_replaced_delta_joules") ==
                std::string::npos,
        "Task 3 must atomically delete the cancellation-prone legacy direct-energy helper");
    check(
        direct_energy_header.find("enum class GpuEnergyIncrementOwner") !=
                std::string::npos &&
            direct_energy_header.find("NotEnergy") != std::string::npos &&
            direct_energy_header.find("Direct") != std::string::npos &&
            direct_energy_header.find("EndpointResidual") != std::string::npos &&
            direct_energy_header.find("Unsupported") != std::string::npos &&
            direct_energy_header.find("gpu_energy_increment_owner(") !=
                std::string::npos,
        "CUDA Armijo must expose one exhaustive Context-derived owner classification");
    check(
        direct_energy_source.find("for (int raw_slot = 0;") !=
                std::string::npos &&
            direct_energy_source.find(
                "static_cast<int>(GpuFinalScalarSlot::Count)") !=
                std::string::npos &&
            direct_energy_source.find(
                "GpuEnergyIncrementOwner::Unsupported") !=
                std::string::npos,
        "CUDA Armijo composition must visit every current/future final scalar slot and fail closed on an unclassified semantic");
    check(
        direct_energy_source.find(
            "relaxation::compose_term_complete_energy_difference(") !=
                std::string::npos &&
            direct_energy_source.find("trial.total_energy_j -") ==
                std::string::npos &&
            direct_energy_source.find("endpoint_replaced") ==
                std::string::npos &&
            pgbb_source.find("endpoint_replaced") == std::string::npos,
        "production CUDA Armijo and diagnostics must remove endpoint-total reconstruction and replacement vocabulary together");
    const auto direct_kernel_start =
        kernels_source.find("__global__ void direct_energy_difference_kernel(");
    const auto direct_kernel_end =
        kernels_source.find("__global__ void tangent_gradient_norm_kernel(");
    const std::string direct_kernel =
        direct_kernel_start == std::string::npos
            ? std::string()
            : kernels_source.substr(
                  direct_kernel_start,
                  direct_kernel_end == std::string::npos
                      ? std::string::npos
                      : direct_kernel_end - direct_kernel_start);
    check(
        !direct_kernel.empty() && direct_kernel.find("h_drive") == std::string::npos &&
            direct_energy_source.find("GpuFinalScalarSlot::DriveEnergy") !=
                std::string::npos &&
            direct_energy_source.find(
                "GpuEnergyIncrementOwner::EndpointResidual") !=
                std::string::npos,
        "regional drive must remain an endpoint residual until the real local direct kernel consumes H_drive");
    check(
        direct_energy_source.find(
            "result.endpoint_residual_operand_absolute_sum_j > 0.0") !=
                std::string::npos,
        "endpoint-residual ambiguity must not be misrepresented as refinable demag uncertainty");
    check(
        direct_kernel.find(
            "gpu_relax_dd::magnitude(demag_x_dd)") !=
                std::string::npos &&
            direct_kernel.find(
                "gpu_relax_dd::magnitude(zeeman_x_dd)") !=
                std::string::npos &&
            direct_kernel.find(
                "gpu_relax_dd::magnitude(anisotropy_ku_dd)") !=
                std::string::npos &&
            direct_kernel.find("gpu_relax_dd::magnitude(cubic_delta_dd)") !=
                std::string::npos &&
            direct_kernel.find(
                "DBL_EPSILON * (zeeman_scale + anisotropy_scale + cubic_scale)") !=
                std::string::npos &&
            direct_kernel.find("block_demag_delta") != std::string::npos &&
            direct_kernel.find("block_demag_absolute") != std::string::npos,
        "CUDA local direct-energy uncertainty must retain double-double scalar terms, residual scales, and demag-owned reduction before cancellation");
    check(
        exchange_header.find("double *block_absolute_terms") !=
                std::string::npos &&
            exchange_source.find(
                "exchange_polarized_edge_term") != std::string::npos &&
            exchange_source.find(
                "fabs(term_x_dd.hi) + fabs(term_x_dd.lo)") !=
                std::string::npos &&
            exchange_source.find("DBL_EPSILON * fabs(edge_weight)") !=
                std::string::npos,
        "CUDA exchange direct-energy uncertainty must use error-free polarized edge terms and retain their residual scale before cancellation");
    check(
        dmi_header.find("double *element_absolute_terms") !=
                std::string::npos &&
            dmi_source.find("const double bulk_terms[6]") !=
                std::string::npos &&
            dmi_source.find("const double interfacial_terms[8]") !=
                std::string::npos &&
            dmi_source.find("fabs(bulk_terms[0])") != std::string::npos &&
            dmi_source.find("fabs(interfacial_terms[0])") !=
                std::string::npos &&
            dmi_source.find(
                "dmi_atomic_add_double(absolute_out, absolute_delta)") !=
                std::string::npos,
        "CUDA DMI direct-energy uncertainty must accumulate every polarized scalar-product magnitude before cancellation");
    check(
        direct_energy_source.find("kDirectEnergyTailSlots = 12") !=
                std::string::npos &&
            reduction_workspace_header.find(
                "FEM_GPU_SCALAR_RESULT_SLOTS = 32") !=
                std::string::npos &&
            direct_energy_source.find("kDirectDemagAbsoluteTailSlot") !=
                std::string::npos &&
            direct_energy_source.find("kDirectExchangeAbsoluteTailSlot") !=
                std::string::npos &&
            direct_energy_source.find(
                "kDirectInterfacialDmiAbsoluteTailSlot") !=
                std::string::npos &&
            direct_energy_source.find("kDirectBulkDmiAbsoluteTailSlot") !=
                std::string::npos &&
            direct_energy_source.find("kDirectActiveStateChangeTailSlot") !=
                std::string::npos &&
            direct_energy_source.find("kDirectRepresentableChordTailSlot") !=
                std::string::npos &&
            direct_energy_source.find("std::abs(exchange_delta)") ==
                std::string::npos &&
            direct_energy_source.find("std::abs(interfacial_dmi_delta)") ==
                std::string::npos &&
            direct_energy_source.find("std::abs(bulk_dmi_delta)") ==
                std::string::npos,
        "CUDA direct Armijo must batch owner-specific signed and pre-cancellation absolute reductions without reconstructing scales from aggregate deltas");
    check(
        direct_energy_header.find(
            "gpu_direct_armijo_demag_refinement_eligible(") !=
                std::string::npos &&
            direct_energy_source.find(
                "non_demag_difference.roundoff_bound_joules") !=
                std::string::npos &&
            direct_energy_source.find(
                "ArmijoDifferenceDecision::Accept;") !=
                std::string::npos,
        "CUDA direct Armijo may refine only when removing demag-owned uncertainty resolves the aggregate decision to Accept");
}

void cpu_pgbb_exchange_difference_owner_is_focused_and_term_complete() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path header_path = root / "cpu" / "mfem" /
        "interactions" / "exchange_energy_difference.hpp";
    const std::filesystem::path source_path = root / "cpu" / "mfem" /
        "interactions" / "exchange_energy_difference.cpp";
    check(
        std::filesystem::exists(header_path) && std::filesystem::exists(source_path),
        "CPU/MFEM polarized exchange difference must have a focused interaction owner");
    const std::string header = read_text_file(header_path);
    const std::string source = read_text_file(source_path);
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string projected_gradient = read_text_file(
        root / "cpu" / "mfem" / "relaxation" / "projected_gradient_bb.cpp");
    const std::string derivative_contract = read_text_file(
        root / "tests" / "relaxation_energy_derivative_contract.cpp");
    const auto count_occurrences = [](const std::string &text, const std::string &needle) {
        size_t count = 0u;
        size_t position = 0u;
        while ((position = text.find(needle, position)) != std::string::npos) {
            ++count;
            position += needle.size();
        }
        return count;
    };

    check(
        header.find("polarized_exchange_difference_from_applied_sum(") !=
                std::string::npos &&
            header.find("exchange_energy_difference(") != std::string::npos &&
            cmake.find("cpu/mfem/interactions/exchange_energy_difference.cpp") !=
                std::string::npos,
        "CPU/MFEM exchange difference helper and owner must be production-built");
    check(
        source.find("exchange_form->Mult(sum, applied)") != std::string::npos &&
            source.find("polarized_exchange_difference_from_applied_sum(") !=
                std::string::npos &&
            source.find("audited_host_write(") != std::string::npos &&
            source.find("audited_host_read(") != std::string::npos &&
            source.find("mfem::Device::IsEnabled()") != std::string::npos &&
            source.find("poll_interrupt(ctx)") != std::string::npos &&
            source.find("TransferAuditScope exchange_audit_scope(") !=
                std::string::npos &&
            source.find("TransferAuditScopeKind::ExchangeInterop") !=
                std::string::npos,
        "CPU/MFEM exchange difference must use the assembled form with audited MFEM access, interruption, and one exchange interop scope");
    check(
        source.find("apply_exchange_component_mass_projection") ==
                std::string::npos &&
            source.find("ctx.exchange.h_xyz") == std::string::npos,
        "CPU/MFEM exchange difference must not derive its identity from mass-projected H_ex");
    check(
        count_occurrences(
            projected_gradient,
            "const auto exchange = exchange_energy_difference(") == 1u &&
            count_occurrences(
                projected_gradient,
                "demag_poisson_energy_difference_from_endpoint_fields(") == 1u &&
            count_occurrences(
                projected_gradient,
                "zeeman_energy_difference_from_field(") == 1u &&
            count_occurrences(
                projected_gradient,
                "uniaxial_anisotropy_energy_difference(") == 1u &&
            projected_gradient.find("trial_stats.exchange_energy_joules") ==
                std::string::npos &&
            projected_gradient.find("current_stats.exchange_energy_joules") ==
                std::string::npos,
        "CPU PG-BB must own direct demag, Zeeman, uniaxial, and exchange increments exactly once without exchange endpoint subtraction");
    check(
        projected_gradient.find("residual_operand_abs +=") != std::string::npos &&
            projected_gradient.find("std::abs(base) + std::abs(trial)") !=
                std::string::npos &&
            count_occurrences(
                projected_gradient,
                "current_stats.drive_energy_joules") == 1u &&
            count_occurrences(
                projected_gradient,
                "trial_stats.drive_energy_joules") == 1u &&
            projected_gradient.find("current_stats.dmi_energy_joules") !=
                std::string::npos &&
            projected_gradient.find("trial_stats.dmi_energy_joules") !=
                std::string::npos &&
            projected_gradient.find("current_stats.magnetoelastic_energy_joules") !=
                std::string::npos &&
            projected_gradient.find("trial_stats.magnetoelastic_energy_joules") !=
                std::string::npos &&
            projected_gradient.find("current_cubic_energy") != std::string::npos &&
            projected_gradient.find("trial_cubic_energy") != std::string::npos &&
            projected_gradient.find("std::abs(residual_delta)") ==
                std::string::npos,
        "CPU PG-BB residual drive, DMI, magnetoelastic, and cubic terms must each retain one explicit base/trial operand scale");
    check(
        count_occurrences(
            projected_gradient,
            "current_stats.exchange_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "trial_stats.exchange_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "current_stats.demag_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "trial_stats.demag_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "current_stats.external_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "trial_stats.external_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "current_stats.anisotropy_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "trial_stats.anisotropy_energy_joules") == 0u &&
            count_occurrences(
                projected_gradient,
                "current_stats.total_energy_joules") == 2u &&
            count_occurrences(
                projected_gradient,
                "trial_stats.total_energy_joules") == 1u,
        "CPU PG-BB must replace exchange, demag, external, and aggregate anisotropy endpoints with their direct/subterm owners while reserving total energy for diagnostics only");
    check(
        projected_gradient.find("demag.roundoff_bound_joules +") !=
                std::string::npos &&
            projected_gradient.find("zeeman.roundoff_bound_joules +") !=
                std::string::npos &&
            projected_gradient.find("uniaxial.roundoff_bound_joules +") !=
                std::string::npos &&
            projected_gradient.find("exchange.roundoff_bound_joules +") !=
                std::string::npos,
        "CPU PG-BB must sum independent direct-owner roundoff bounds");
    check(
        derivative_contract.find(
            "production_exchange_energy_difference_uses_assembled_mfem_form") !=
                std::string::npos &&
            derivative_contract.find(
                "production_exchange_energy_difference_uses_assembled_mfem_form();") !=
                std::string::npos,
        "the relaxation derivative contract must execute the production assembled-MFEM exchange difference owner");
}

void c_abi_exposes_native_relaxation_step() {
    const std::filesystem::path root = fem_source_root();
    const std::string public_header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fem.h");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string backend_step =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
    const std::string gpu_nonlinear_cg =
        read_text_file(root / "gpu" / "cuda" / "relaxation" / "nonlinear_cg.cpp");
    const std::string gpu_projected_gradient =
        read_text_file(root / "gpu" / "cuda" / "relaxation" / "pgbb.cpp");
    const std::string relaxation_step =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "relaxation_step.cpp");
    const std::string projected_gradient =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "projected_gradient_bb.cpp");
    const std::string nonlinear_cg =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "nonlinear_cg.cpp");
    const std::string relaxation_math =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "relaxation_math.cpp");
    const std::string tangent_plane =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "tangent_plane_implicit.cpp");
    const std::string mfem_context =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "mfem_context.cpp");
    const std::string demag =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.cpp");
    const std::string demag_hypre =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_hypre.cpp");
    const std::string dmi_workspace =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_workspace.cpp");
    const std::string dmi_interfacial =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_interfacial.cpp");
    const std::string dmi_bulk =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "dmi_bulk.cpp");
    const auto upload_snapshot_start =
        relaxation_math.find("int upload_and_snapshot(");
    const auto upload_snapshot_end =
        upload_snapshot_start == std::string::npos
            ? std::string::npos
            : relaxation_math.find("int restore_after_failed_line_search(", upload_snapshot_start);
    const std::string upload_and_snapshot =
        upload_snapshot_start == std::string::npos
            ? std::string()
            : relaxation_math.substr(
                  upload_snapshot_start,
                  upload_snapshot_end == std::string::npos
                      ? std::string::npos
                      : upload_snapshot_end - upload_snapshot_start);
    const auto upload_context_snapshot =
        upload_and_snapshot.find("context_snapshot_stats_mfem(ctx, stats, error)");
    const auto upload_state_validation =
        upload_and_snapshot.find("validate_relaxation_state_fields(ctx, algorithm_name, error)");
    const auto upload_energy_validation =
        upload_and_snapshot.find("validate_relaxation_step_energy(");
    check(
        dmi_workspace.find("bool refresh_dmi_grid_functions_from_magnetization(") !=
                std::string::npos &&
            dmi_workspace.find("audited_host_write(*gf_mx)") != std::string::npos &&
            dmi_workspace.find("audited_host_write(*gf_my)") != std::string::npos &&
            dmi_workspace.find("audited_host_write(*gf_mz)") != std::string::npos &&
            dmi_interfacial.find(
                "refresh_dmi_grid_functions_from_magnetization(ctx, m_xyz, error)") !=
                std::string::npos &&
            dmi_bulk.find(
                "refresh_dmi_grid_functions_from_magnetization(ctx, *exchange_input, error)") !=
                std::string::npos,
        "native FEM DMI field and energy owners must refresh MFEM grid functions from every trial magnetization before derivative evaluation");
    const auto tangent_gradient_start =
        relaxation_math.find("void tangent_gradient_from_field(");
    const auto tangent_gradient_end =
        tangent_gradient_start == std::string::npos
            ? std::string::npos
            : relaxation_math.find("std::vector<double> project_tangent(", tangent_gradient_start);
    const std::string tangent_gradient =
        tangent_gradient_start == std::string::npos
            ? std::string()
            : relaxation_math.substr(
                  tangent_gradient_start,
                  tangent_gradient_end == std::string::npos
                      ? std::string::npos
                      : tangent_gradient_end - tangent_gradient_start);
    const auto project_tangent_start =
        relaxation_math.find("std::vector<double> project_tangent(");
    const auto project_tangent_end =
        project_tangent_start == std::string::npos
            ? std::string::npos
            : relaxation_math.find("std::vector<double> negative_field(", project_tangent_start);
    const std::string project_tangent =
        project_tangent_start == std::string::npos
            ? std::string()
            : relaxation_math.substr(
                  project_tangent_start,
                  project_tangent_end == std::string::npos
                      ? std::string::npos
                      : project_tangent_end - project_tangent_start);

    check(
        public_header.find("fullmag_fem_relax_algorithm") != std::string::npos,
        "C ABI must expose native FEM relaxation algorithm selection");
    check(
        public_header.find("fullmag_fem_backend_relax_step(") != std::string::npos,
        "C ABI must expose a native FEM relaxation step entrypoint");
    check(
        public_header.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
            std::string::npos,
        "C ABI must expose a dedicated gradient-convergence stop reason for direct minimizers");
    check(
        api.find("fullmag::fem::run_backend_relaxation_step(") != std::string::npos,
        "api.cpp must delegate native relaxation step execution to runtime");
    check(
        backend_step.find("run_backend_relaxation_step(") != std::string::npos,
        "backend_step.cpp must own runtime delegation for native relaxation steps");
    check(
        backend_step.find("#include \"gpu/cuda/relaxation/pgbb.hpp\"") !=
                std::string::npos &&
            backend_step.find(
                "algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB") !=
                std::string::npos &&
            backend_step.find("gpu_relax_projected_gradient_bb_step(") !=
                std::string::npos,
        "backend_step.cpp must route only allocated-GPU projected-gradient BB requests to the native GPU relaxation boundary");
    const auto gpu_relax_dispatch_start =
        backend_step.find("algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB");
    const std::string gpu_relax_dispatch =
        gpu_relax_dispatch_start == std::string::npos
            ? std::string()
            : backend_step.substr(gpu_relax_dispatch_start);
    check(
        gpu_relax_dispatch.find("TransferAuditScope hot_loop") !=
                std::string::npos &&
            gpu_relax_dispatch.find("TransferAuditScopeKind::HotLoop") !=
                std::string::npos &&
            gpu_relax_dispatch.find("ctx.transfer_audit.audit.hot_loop_violation") !=
                std::string::npos &&
            gpu_relax_dispatch.find("ctx.transfer_audit.audit.hot_loop_violation_message") !=
                std::string::npos,
        "backend_step.cpp must wrap native GPU relaxation steps in transfer-audit hot-loop scope");
    check(
        backend_step.find("#include \"gpu/cuda/relaxation/nonlinear_cg.hpp\"") !=
                std::string::npos &&
            backend_step.find("algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG") !=
                std::string::npos &&
            backend_step.find("gpu_relax_nonlinear_cg_step(") !=
                std::string::npos,
        "backend_step.cpp must route allocated-GPU nonlinear CG requests to the native GPU relaxation boundary");
    check(
        gpu_nonlinear_cg.find("Routing remains disabled") == std::string::npos &&
            gpu_nonlinear_cg.find("unavailable stub") == std::string::npos,
        "native GPU nonlinear CG source contract must not describe the production CUDA lane as disabled or stubbed");
    check(
        gpu_nonlinear_cg.find("trial_active_state_unchanged") != std::string::npos &&
            gpu_nonlinear_cg.find("every_permitted_trial_unchanged") !=
                std::string::npos &&
            gpu_nonlinear_cg.find(
                "every_exhausted_search_terminal_interval_unrepresentable") ==
                std::string::npos,
        "native GPU nonlinear CG representability completion must require every active trial state to be bitwise unchanged");
    check(
        relaxation_step.find("run_projected_gradient_bb_step(") != std::string::npos,
        "relaxation_step.cpp must route projected-gradient BB to the native algorithm module");
    check(
        relaxation_step.find("run_nonlinear_cg_step(") != std::string::npos,
        "relaxation_step.cpp must route nonlinear CG to the native algorithm module");
    check(
        projected_gradient.find("energy_weighted_dot_fields(") != std::string::npos &&
            projected_gradient.find("validate_tangent_gradient_field(") !=
                std::string::npos,
        "native FEM projected-gradient BB must use the energy-weighted FEM product through shared gradient validation and descent products");
    check(
        relaxation_math.find("exchange_mass_preconditioned_gradient(") !=
                std::string::npos &&
            relaxation_math.find("assemble_exchange_mass_preconditioner(") !=
                std::string::npos &&
            relaxation_math.find("cached_exchange_mass_preconditioner(") !=
                std::string::npos &&
            relaxation_math.find("exchange_mass_preconditioner_weight == exchange_weight") !=
                std::string::npos &&
            relaxation_math.find("HypreBoomerAMG") != std::string::npos &&
            relaxation_math.find("HyprePCG") != std::string::npos,
        "native FEM direct minimizers must share a cached exchange-plus-mass Hypre-capable preconditioner");
    check(
        relaxation_math.find("out_stats.dt_seconds = accepted_step_size") ==
                std::string::npos &&
            relaxation_math.find("out_stats.dt_seconds = 0.0") !=
                std::string::npos,
        "native FEM direct minimizers must not publish their m/A line-search step as seconds");
    check(
        gpu_projected_gradient.find("dt_seconds = trial_step") == std::string::npos &&
            gpu_nonlinear_cg.find("dt_seconds = trial_step") == std::string::npos,
        "native CUDA FEM direct minimizers must not publish their m/A line-search step as seconds");
    check(
        mfem_context.find("relaxation::destroy_exchange_mass_preconditioner_cache(ctx)") !=
            std::string::npos,
        "native FEM MFEM context teardown must destroy the direct-minimizer exchange-plus-mass preconditioner cache");
    check(
        relaxation_math.find("solver.GetConverged()") != std::string::npos &&
            relaxation_math.find("solver.GetFinalNorm()") != std::string::npos &&
            relaxation_math.find("direct FEM relaxation MFEM preconditioner solve did not converge") !=
                std::string::npos,
        "native FEM direct-minimizer serial MFEM preconditioner solves must reject non-converged linear solves");
    check(
        relaxation_math.find("validate_hypre_relative_residual(") !=
                std::string::npos &&
            relaxation_math.find("final_relative_residual <= kPreconditionerSolveRelativeTolerance") !=
                std::string::npos &&
            relaxation_math.find("final_absolute_residual <= kPreconditionerSolveAbsoluteTolerance") !=
                std::string::npos &&
            relaxation_math.find("direct FEM relaxation Hypre preconditioner requires OpenMPI singleton socket support") !=
                std::string::npos &&
            relaxation_math.find("iterations >= kPreconditionerSolveMaximumIterations") ==
                std::string::npos,
        "native FEM direct-minimizer Hypre preconditioner solves must reject non-converged residuals before using the solution");
    check(
        relaxation_math.find("validate_relaxation_state_fields(") !=
                std::string::npos &&
            relaxation_math.find("mfem_lumped_mass.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("magnetic_node_mask.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("requires at least one active magnetic node") !=
                std::string::npos,
        "native FEM direct minimizers must validate full FEM field dimensions and metric readiness before stepping");
    check(
        relaxation_math.find("double invalid_metric_value()") !=
                std::string::npos &&
            relaxation_math.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos &&
            relaxation_math.find("a.size() != b.size()") !=
                std::string::npos &&
            relaxation_math.find("ctx.integration_weights.mfem_lumped_mass.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("ctx.mesh.magnetic_node_mask.size() != nodes") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(mass) || mass <= 0.0") !=
                std::string::npos &&
            relaxation_math.find("return dot_fields(a, b);") ==
                std::string::npos &&
            relaxation_math.find("std::min(a.size(), b.size())") ==
                std::string::npos,
        "native FEM mass-metric helpers must reject invalid field dimensions instead of silently truncating or falling back to an unweighted dot product");
    check(
        relaxation_math.find("m_xyz.size() != direction_xyz.size()") !=
                std::string::npos &&
            relaxation_math.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(norm)") !=
                std::string::npos &&
            relaxation_math.find("norm <= 0.0") != std::string::npos &&
            relaxation_math.find("retracted_step(") != std::string::npos,
        "native FEM retraction must reject mismatched or invalid step directions before uploading a trial state");
    check(
        tangent_gradient.find("m_xyz.size() != h_eff_xyz.size()") !=
                std::string::npos &&
            tangent_gradient.find("m_xyz.size() % 3u != 0u") !=
                std::string::npos &&
            tangent_gradient.find("ctx.mesh.magnetic_node_mask.size() != m_xyz.size() / 3u") !=
                std::string::npos &&
            tangent_gradient.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos,
        "native FEM tangent-gradient helper must reject mismatched H_eff/state dimensions before indexing field components");
    check(
        project_tangent.find("m_xyz.size() != vector_xyz.size()") !=
                std::string::npos &&
            project_tangent.find("m_xyz.size() % 3u != 0u") !=
                std::string::npos &&
            project_tangent.find("ctx.mesh.magnetic_node_mask.size() != m_xyz.size() / 3u") !=
                std::string::npos &&
            project_tangent.find("std::numeric_limits<double>::quiet_NaN()") !=
                std::string::npos,
        "native FEM tangent projection helper must reject mismatched vector/state dimensions before indexing field components");
    check(
        relaxation_math.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            relaxation_math.find("stats.total_energy_joules") !=
                std::string::npos &&
            relaxation_math.find("snapshot produced non-finite total energy") !=
                std::string::npos,
        "native FEM CPU direct minimizers must reject non-finite snapshot energies before Armijo or completion checks");
    check(
        demag_hypre.find("void reset_demag_poisson_hypre_initial_guess(Context &ctx)") !=
                std::string::npos &&
            demag_hypre.find("workspace->x_par = 0.0") != std::string::npos &&
            demag_hypre.find("workspace->x_par_contains_solution = true") !=
                std::string::npos &&
            relaxation_math.find("reset_demag_poisson_hypre_initial_guess(ctx);") !=
                std::string::npos &&
            projected_gradient.find("fresh_line_search_snapshot(") !=
                std::string::npos &&
            nonlinear_cg.find("fresh_line_search_snapshot(") !=
                std::string::npos &&
            tangent_plane.find("fresh_line_search_snapshot(") !=
                std::string::npos,
        "native FEM CPU Armijo current/trial energies must use the same history-independent zero-start demag oracle");
    check(
        relaxation_math.find("kMagnetizationUnitNormTolerance") !=
                std::string::npos &&
            relaxation_math.find("dot3(ctx.state.m_xyz, ctx.state.m_xyz, base)") !=
                std::string::npos &&
            relaxation_math.find("active magnetization is not unit length") !=
                std::string::npos,
        "native FEM CPU direct minimizer state validation must reject active magnetization vectors off the unit sphere");
    check(
        relaxation_math.find("validate_tangent_gradient_norm_sq(") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(gradient_norm_sq)") !=
                std::string::npos &&
            relaxation_math.find("gradient_norm_sq < 0.0") !=
                std::string::npos &&
            relaxation_math.find("non-finite or negative tangent-gradient norm") !=
                std::string::npos,
        "native FEM CPU direct minimizers must reject invalid tangent-gradient norms before preconditioning or completion classification");
    check(
        relaxation_math.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            relaxation_math.find("tangent gradient size mismatch") !=
                std::string::npos &&
            relaxation_math.find("tangent gradient contains non-finite values") !=
                std::string::npos &&
            relaxation_math.find("metric_gradient_norm_sq(ctx, gradient_xyz)") !=
                std::string::npos &&
            relaxation_math.find("tangent gradient produced a non-finite or negative metric norm") !=
                std::string::npos,
        "native FEM CPU direct minimizers must validate tangent-gradient vectors and metric norms before storing algorithm state");
    check(
        upload_context_snapshot != std::string::npos &&
            upload_state_validation != std::string::npos &&
            upload_energy_validation != std::string::npos &&
            upload_context_snapshot < upload_state_validation &&
            upload_state_validation < upload_energy_validation,
        "native FEM CPU direct-minimizer snapshots must validate refreshed H_eff/state fields before Armijo energy checks or next-step gradients");
    check(
        relaxation_math.find("m_xyz.size() != ctx.state.m_xyz.size()") !=
                std::string::npos &&
            relaxation_math.find("magnetization size mismatch") !=
                std::string::npos &&
            relaxation_math.find("!all_finite(m_xyz)") !=
                std::string::npos &&
            relaxation_math.find("magnetization contains non-finite values") !=
                std::string::npos &&
            upload_and_snapshot.find("set_relaxation_magnetization_state(") !=
                std::string::npos &&
            upload_and_snapshot.find("!all_finite(m_xyz)") <
                upload_and_snapshot.find("set_relaxation_magnetization_state("),
        "native FEM CPU direct minimizers must reject invalid trial magnetization before setting trial state");
    check(
        relaxation_math.find("sanitized_relaxation_step_size(") !=
                std::string::npos &&
            relaxation_math.find("!std::isfinite(step_size)") !=
                std::string::npos &&
            relaxation_math.find("step_size <= 0.0") != std::string::npos &&
            relaxation_math.find("return kDefaultStepSize") !=
                std::string::npos &&
            relaxation_math.find("std::clamp(step_size, kMinStepSize, kMaxStepSize)") !=
                std::string::npos,
        "native FEM CPU direct minimizers must sanitize invalid runtime step sizes before retraction");
    check(
        projected_gradient.find("complete_stage_from_current_stats(ctx, current_stats)") !=
                std::string::npos &&
            nonlinear_cg.find("complete_stage_from_current_stats(ctx, current_stats)") !=
                std::string::npos &&
            tangent_plane.find("complete_stage_from_current_stats(ctx, current_stats)") !=
                std::string::npos,
        "native FEM CPU direct minimizers must classify already-satisfied stop criteria before taking another accepted step");
    check(
        relaxation_math.find("#include \"cpu/mfem/runtime/stage_completion.hpp\"") !=
                std::string::npos &&
            relaxation_math.find("update_stage_completion_from_stats(ctx, out_stats)") !=
                std::string::npos &&
            relaxation_math.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos &&
            relaxation_math.find("publish_accepted_gradient_completion(") !=
                std::string::npos &&
            relaxation_math.find("accepted_gradient_norm_sq == 0.0") !=
                std::string::npos &&
            relaxation_math.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
                std::string::npos &&
            relaxation_math.find("\"tangent_gradient_norm_sq\"") !=
                std::string::npos,
        "native FEM CPU direct minimizers must publish accepted-step and gradient-converged stop state through the runtime stage-completion owner");
    check(
        relaxation_math.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            relaxation_math.find("restore_validated_relaxation_state(") !=
                std::string::npos &&
            relaxation_math.find(
                "validate_relaxation_state_fields(ctx, algorithm_name, restore_error)") !=
                std::string::npos &&
            relaxation_math.find("restore_after_rejected_trial(") !=
                std::string::npos &&
            relaxation_math.find("failed to restore previous state after") !=
                std::string::npos &&
            relaxation_math.find("original error:") != std::string::npos &&
            relaxation_math.find("error = original_error + \"; previous state restored\"") !=
                std::string::npos,
        "native FEM CPU direct minimizers must share checked and validated restore diagnostics for failed or rejected trial paths");
    check(
        projected_gradient.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos &&
            nonlinear_cg.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos &&
            tangent_plane.find("finish_degenerate_gradient_relaxation_step(") !=
                std::string::npos,
        "all native FEM CPU direct minimizers must publish gradient convergence instead of returning an unclassified no-op step");
    check(
        relaxation_math.find("bool take_cached_current_stats(") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats_valid = false") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats = trial_stats") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats.wall_time_ns = 0") !=
                std::string::npos &&
            relaxation_math.find("ctx.relaxation.cached_current_stats.demag_solve_count = 0") !=
                std::string::npos,
        "native FEM CPU direct minimizers must cache accepted current stats without carrying old solve timings into the next step");
    check(
        projected_gradient.find("relaxation::fresh_line_search_snapshot(") !=
                std::string::npos &&
            nonlinear_cg.find("relaxation::fresh_line_search_snapshot(") !=
                std::string::npos &&
            tangent_plane.find("relaxation::fresh_line_search_snapshot(") !=
                std::string::npos,
        "all native FEM CPU direct minimizers must recompute current energy with the same fresh demag oracle used by Armijo trials");
    check(
        projected_gradient.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            projected_gradient.find("validate_tangent_gradient_field(") <
            projected_gradient.find("g_norm_sq == 0.0"),
        "native FEM projected-gradient BB must reject invalid tangent-gradient vectors before gradient-completion classification");
    const auto pgbb_accepted_gradient_failure =
        projected_gradient.find("accepted-gradient validation failure");
    const auto pgbb_update_bb =
        projected_gradient.rfind("update_bb_step_size(");
    check(
        projected_gradient.find("relaxation::transported_bb_secant(") !=
                std::string::npos &&
            projected_gradient.find("relaxation::bb_step_decision(") !=
                std::string::npos,
        "native FEM CPU projected-gradient BB must transport its secant pair before the shared candidate, clamp, and reset policy");
    check(
        projected_gradient.find("\"accepted\"") != std::string::npos &&
            pgbb_accepted_gradient_failure != std::string::npos &&
            pgbb_update_bb != std::string::npos &&
            pgbb_accepted_gradient_failure < pgbb_update_bb &&
            projected_gradient.find("restore_previous_relaxation_state(") !=
                std::string::npos,
        "native FEM projected-gradient BB must validate accepted-step tangent gradients before BB state updates and restore on failure");
    check(
        projected_gradient.find("finish_accepted_relaxation_step(") !=
                std::string::npos &&
            projected_gradient.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)") !=
                std::string::npos &&
            projected_gradient.find("finish_accepted_relaxation_step(") <
                projected_gradient.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)"),
        "native FEM projected-gradient BB must publish accepted-step gradient completion from the validated accepted tangent-gradient norm");
    check(
        projected_gradient.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            projected_gradient.find("context_upload_magnetization_f64(") ==
                std::string::npos,
        "native FEM projected-gradient BB must not ignore restore failures after rejected or invalid trial states");
    check(
        projected_gradient.find("exchange_mass_preconditioned_gradient(") !=
                std::string::npos &&
            projected_gradient.find("direction_dot_gradient") != std::string::npos,
        "native FEM projected-gradient BB must use the preconditioned descent direction in Armijo");
    check(
        projected_gradient.find("descent_direction = relaxation::negative_field(previous_gradient);") !=
                std::string::npos &&
            projected_gradient.find(
                "relaxation::energy_weighted_dot_fields(\n                ctx,\n                descent_direction,\n                previous_gradient)",
                projected_gradient.find("descent_direction = relaxation::negative_field(previous_gradient);")) !=
                std::string::npos &&
            projected_gradient.find("direction_dot_gradient = -g_norm_sq;") ==
                std::string::npos,
        "native FEM projected-gradient BB raw-gradient fallback must recompute the energy-weighted Armijo slope instead of reusing the volume stop norm");
    check(
        projected_gradient.find("!std::isfinite(direction_dot_gradient)") !=
                std::string::npos &&
            projected_gradient.find("non-finite or non-descent direction") !=
                std::string::npos,
        "native FEM projected-gradient BB must fail with explicit diagnostics for invalid descent directions");
    check(
        projected_gradient.find("validate_relaxation_state_fields(") !=
                std::string::npos,
        "native FEM projected-gradient BB must validate state fields before computing gradients");
    check(
        projected_gradient.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            projected_gradient.find("\"current\"") != std::string::npos &&
            projected_gradient.find("\"trial\"") != std::string::npos,
        "native FEM projected-gradient BB must validate current and trial snapshot energies explicitly");
    check(
        projected_gradient.find("sanitized_relaxation_step_size(ctx.relaxation.step_size)") !=
                std::string::npos,
        "native FEM projected-gradient BB must sanitize runtime step size before Armijo");
    check(
        relaxation_math.find("restore_after_failed_line_search(") !=
                std::string::npos &&
            projected_gradient.find("line_search_accepted") != std::string::npos &&
            projected_gradient.find("kProjectedGradientMaxBacktracks") !=
                std::string::npos &&
            projected_gradient.find("restore_after_failed_line_search(") !=
                std::string::npos,
        "native FEM projected-gradient BB must reject exhausted Armijo searches and restore the previous state");
    const auto pgbb_main_start =
        projected_gradient.find("int run_projected_gradient_bb_step(");
    const auto pgbb_main_backtracks =
        pgbb_main_start == std::string::npos
            ? std::string::npos
            : projected_gradient.find("uint32_t backtracks = 0;", pgbb_main_start);
    const auto pgbb_first_armijo =
        pgbb_main_backtracks == std::string::npos
            ? std::string::npos
            : projected_gradient.find("bool armijo = false", pgbb_main_backtracks);
    const auto pgbb_backtrack_limit =
        pgbb_first_armijo == std::string::npos
            ? std::string::npos
            : projected_gradient.find(
                  "if (backtracks >= relaxation::kProjectedGradientMaxBacktracks)",
                  pgbb_first_armijo);
    const auto pgbb_monotone_escape =
        pgbb_first_armijo == std::string::npos
            ? std::string::npos
            : projected_gradient.find(
                  "strict_armijo_difference_decision(\n                direct_difference, 0.0)",
                  pgbb_first_armijo);
    check(
        projected_gradient.find("kLineSearchEnergyNoiseFloorJ") == std::string::npos &&
        projected_gradient.find("kLineSearchEnergyNoiseRelative") == std::string::npos &&
            pgbb_first_armijo != std::string::npos &&
            projected_gradient.find("pgbb_direct_energy_difference(", pgbb_main_backtracks) <
            pgbb_backtrack_limit != std::string::npos &&
            projected_gradient.find(
                "if (backtracks >= relaxation::kProjectedGradientMaxBacktracks)",
                pgbb_first_armijo) &&
            projected_gradient.find("strict_armijo_difference_decision(", pgbb_first_armijo) <
                projected_gradient.find(
                    "if (backtracks >= relaxation::kProjectedGradientMaxBacktracks)",
                    pgbb_first_armijo) &&
            projected_gradient.find(
                "pgbb_refined_armijo_accepts(",
                pgbb_first_armijo) <
                projected_gradient.find(
                    "if (backtracks >= relaxation::kProjectedGradientMaxBacktracks)",
                    pgbb_first_armijo) &&
            (pgbb_monotone_escape == std::string::npos ||
                pgbb_monotone_escape > pgbb_backtrack_limit),
        "native FEM projected-gradient BB must decide strict Armijo only from its direct energy difference before exhausting backtracks");
    check(
        projected_gradient.find("format_projected_gradient_bb_scalar(") !=
                std::string::npos &&
            projected_gradient.find("std::scientific") != std::string::npos &&
            projected_gradient.find("std::setprecision(17)") != std::string::npos &&
            projected_gradient.find("current_energy_j=") != std::string::npos &&
            projected_gradient.find("last_trial_energy_j=") != std::string::npos &&
            projected_gradient.find("armijo_rhs_j=") != std::string::npos &&
            projected_gradient.find("direction_dot_gradient=") != std::string::npos &&
            projected_gradient.find("gradient_norm_sq=") != std::string::npos,
        "native FEM projected-gradient BB exhausted Armijo diagnostics must preserve subattojoule scientific values");
    check(
        nonlinear_cg.find("not implemented yet") == std::string::npos,
        "native FEM nonlinear CG must not be an unavailable stub");
    check(
        nonlinear_cg.find("format_nonlinear_cg_scalar(") != std::string::npos &&
            nonlinear_cg.find("std::scientific") != std::string::npos &&
            nonlinear_cg.find("std::setprecision(17)") != std::string::npos &&
            nonlinear_cg.find("trial_energy_increment_j=") != std::string::npos &&
            nonlinear_cg.find("current_torque_apm=") != std::string::npos &&
            nonlinear_cg.find("torque_tolerance_apm=") != std::string::npos,
        "native FEM CPU nonlinear-CG exhausted Armijo diagnostics must preserve scientific values and the configured convergence criterion");
    check(
        nonlinear_cg.find("energy_weighted_dot_fields(") != std::string::npos &&
            nonlinear_cg.find("energy_weighted_dot_fields_with_absolute_term_sum(") !=
                std::string::npos &&
            nonlinear_cg.find("previous_preconditioned_product.absolute_term_sum") !=
                std::string::npos &&
            nonlinear_cg.find("validate_tangent_gradient_field(") !=
                std::string::npos,
        "native FEM nonlinear CG must use the actual absolute-term sum as its signed PR+ denominator error scale");
    check(
        nonlinear_cg.find(
            "p_dot_g = relaxation::energy_weighted_dot_fields(ctx, direction, previous_gradient);") !=
            std::string::npos,
        "native FEM nonlinear CG raw-gradient recovery must use the energy-weighted Armijo slope");
    const auto ncg_initial_step = nonlinear_cg.find("double initial_step_size(");
    const auto ncg_ensure_descent = nonlinear_cg.find("bool ensure_descent_direction(");
    const std::string ncg_initial_step_block =
        ncg_initial_step == std::string::npos ||
                ncg_ensure_descent == std::string::npos ||
                ncg_initial_step >= ncg_ensure_descent
            ? std::string{}
            : nonlinear_cg.substr(
                  ncg_initial_step,
                  ncg_ensure_descent - ncg_initial_step);
    check(
        ncg_initial_step_block.find("relaxation::metric_dot_fields(ctx, direction, direction)") !=
                std::string::npos &&
            ncg_initial_step_block.find("energy_weighted_dot_fields") ==
                std::string::npos,
        "native FEM CPU nonlinear-CG initial direction scaling must retain the same lumped-volume norm used by the CUDA lane");
    check(
        nonlinear_cg.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            nonlinear_cg.find("validate_tangent_gradient_field(") <
                nonlinear_cg.find("g_norm_sq == 0.0"),
        "native FEM nonlinear CG must reject invalid tangent-gradient vectors before gradient-completion classification");
    check(
        nonlinear_cg.find("\"accepted\"") != std::string::npos &&
            nonlinear_cg.find("std::vector<double> trial_preconditioned_gradient;") !=
                std::string::npos &&
            nonlinear_cg.rfind("validate_tangent_gradient_field(") <
                nonlinear_cg.find("std::vector<double> trial_preconditioned_gradient;") &&
            nonlinear_cg.find("restore_previous_relaxation_state(") !=
                std::string::npos,
        "native FEM nonlinear CG must validate accepted-step tangent gradients before PR+ state updates and restore on failure");
    check(
        nonlinear_cg.find("finish_accepted_relaxation_step(") !=
                std::string::npos &&
            nonlinear_cg.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)") !=
                std::string::npos &&
            nonlinear_cg.find("finish_accepted_relaxation_step(") <
                nonlinear_cg.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)"),
        "native FEM nonlinear CG must publish accepted-step gradient completion from the validated accepted tangent-gradient norm");
    check(
        nonlinear_cg.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            nonlinear_cg.find("context_upload_magnetization_f64(") ==
                std::string::npos,
        "native FEM nonlinear CG must not ignore restore failures after rejected or invalid trial states");
    check(
        nonlinear_cg.find("previous_preconditioned_gradient") !=
                std::string::npos &&
            nonlinear_cg.find("trial_preconditioned_gradient") !=
                std::string::npos &&
            nonlinear_cg.find("exchange_mass_preconditioned_gradient(") !=
                std::string::npos,
        "native FEM nonlinear CG must use preconditioned Polak-Ribiere+ directions");
    check(
        nonlinear_cg.find("bool ensure_descent_direction(") !=
                std::string::npos &&
            nonlinear_cg.find("!std::isfinite(direction_dot_gradient)") !=
                std::string::npos &&
            nonlinear_cg.find("non-finite or non-descent direction") !=
                std::string::npos,
        "native FEM nonlinear CG must fail with explicit diagnostics for invalid descent directions");
    check(
        nonlinear_cg.find("validate_relaxation_state_fields(") !=
                std::string::npos,
        "native FEM nonlinear CG must validate state fields before computing gradients");
    check(
        nonlinear_cg.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            nonlinear_cg.find("\"current\"") != std::string::npos &&
            nonlinear_cg.find("\"trial\"") != std::string::npos,
        "native FEM nonlinear CG must validate current and trial snapshot energies explicitly");
    check(
        nonlinear_cg.find("sanitized_relaxation_step_size(ctx.relaxation.step_size)") !=
                std::string::npos,
        "native FEM nonlinear CG must sanitize runtime step size before Armijo");
    const std::size_t nonlinear_cg_trial_preconditioner_update =
        nonlinear_cg.find("std::vector<double> trial_preconditioned_gradient;");
    const std::size_t nonlinear_cg_accepted_step_finish =
        nonlinear_cg.find("finish_accepted_relaxation_step(");
    const std::string nonlinear_cg_trial_preconditioner_block =
        nonlinear_cg_trial_preconditioner_update == std::string::npos ||
            nonlinear_cg_accepted_step_finish == std::string::npos ||
            nonlinear_cg_trial_preconditioner_update >= nonlinear_cg_accepted_step_finish
        ? std::string{}
        : nonlinear_cg.substr(
              nonlinear_cg_trial_preconditioner_update,
              nonlinear_cg_accepted_step_finish -
                  nonlinear_cg_trial_preconditioner_update);
    check(
        nonlinear_cg_trial_preconditioner_block.find("trial_preconditioner_error") !=
                std::string::npos &&
            nonlinear_cg_trial_preconditioner_block.find(
                "accepted-step preconditioner update failure") !=
                std::string::npos &&
            nonlinear_cg_trial_preconditioner_block.find(
                "restore_previous_relaxation_state(") != std::string::npos &&
            nonlinear_cg_trial_preconditioner_block.find(
                "relaxation::negative_field(trial_gradient)") ==
                std::string::npos,
        "native FEM nonlinear CG must treat accepted-step preconditioner update failures as atomic restore errors instead of silently downgrading to raw steepest descent");
    check(
        nonlinear_cg.find("line_search_accepted") != std::string::npos &&
            nonlinear_cg.find("kNonlinearCgMaxBacktracks") !=
                std::string::npos &&
            nonlinear_cg.find("restore_after_failed_line_search(") !=
                std::string::npos,
        "native FEM nonlinear CG must reject exhausted Armijo searches and restore the previous state");
    check(
        nonlinear_cg.find("every_permitted_trial_unchanged") !=
                std::string::npos &&
            nonlinear_cg.find("all_active_magnetic_dofs_bitwise_unchanged(") !=
                std::string::npos &&
            nonlinear_cg.find("publish_representability_stationary_completion(ctx)") !=
                std::string::npos,
        "native FEM nonlinear CG must classify an all-bitwise-unchanged Armijo sequence as representability stationary instead of exhausting backtracks");
    check(
        nonlinear_cg.find("retry_nonlinear_cg_line_search_with_restart(") !=
                std::string::npos &&
            nonlinear_cg.find("retry_nonlinear_cg_line_search_with_raw_gradient_restart(") !=
                std::string::npos &&
            nonlinear_cg.find("kNonlinearCgArmijoRecoveryCycles") !=
                std::string::npos &&
            nonlinear_cg.find("kLineSearchEnergyNoiseFloorJ") ==
                std::string::npos &&
            nonlinear_cg.find("strict_monotone_energy_accept(") !=
                std::string::npos &&
            nonlinear_cg.find("accept_monotone_recovery_step(") !=
                std::string::npos &&
            nonlinear_cg.find("trial_step = restart_step;") !=
                std::string::npos &&
            nonlinear_cg.find("relaxation::negative_field(previous_gradient)") !=
                std::string::npos &&
            nonlinear_cg.find("ctx.relaxation.nonlinear_cg_direction.clear()") <
                nonlinear_cg.find("restore_after_failed_line_search("),
        "native FEM nonlinear CG must attempt bounded Armijo recovery with restarted preconditioned and raw-gradient descent directions, fresh restart step, and monotone fallback before failing the step");
    check(
        relaxation_step.find("run_tangent_plane_implicit_step(") != std::string::npos,
        "relaxation_step.cpp must route tangent-plane implicit to the native algorithm module");
    check(
        tangent_plane.find("not implemented yet") == std::string::npos,
        "native FEM tangent-plane implicit relaxation must not be an unavailable stub");
    check(
        tangent_plane.find("energy_weighted_dot_fields(") != std::string::npos &&
            tangent_plane.find("validate_tangent_gradient_field(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must use the energy-weighted FEM product through shared gradient validation and tangent products");
    check(
        tangent_plane.find(
            "direction_dot_gradient =\n                relaxation::energy_weighted_dot_fields(ctx, direction, gradient);") !=
            std::string::npos,
        "native FEM tangent-plane implicit relaxation must use the energy-weighted Armijo slope at its production caller");
    check(
        tangent_plane.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            tangent_plane.find("validate_tangent_gradient_field(") <
                tangent_plane.find("g_norm_sq == 0.0"),
        "native FEM tangent-plane implicit relaxation must reject invalid tangent-gradient vectors before gradient-completion classification");
    check(
        tangent_plane.find("assemble_tangent_plane_operator(") != std::string::npos &&
            tangent_plane.find("solve_tangent_plane_linear_system(") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must assemble and solve a global tangent-plane system");
    check(
        tangent_plane.find("mass_form->SpMat()") != std::string::npos &&
            tangent_plane.find("exchange_form->SpMat()") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use MFEM mass and exchange operators");
    check(
        tangent_plane.find("HyprePCG") != std::string::npos &&
            tangent_plane.find("HypreBoomerAMG") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use Hypre solver/preconditioner support when available");
    check(
        tangent_plane.find("add_local_anisotropy_tangent_hessian(") !=
                std::string::npos &&
            tangent_plane.find("add_uniaxial_anisotropy_jacobian(") !=
                std::string::npos &&
            tangent_plane.find("add_cubic_anisotropy_jacobian(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must include local anisotropy curvature in the tangent operator");
    check(
        tangent_plane.find("add_local_zeeman_tangent_curvature(") !=
                std::string::npos &&
            tangent_plane.find("ctx.zeeman.h_ext_xyz") != std::string::npos &&
            tangent_plane.find("dot_array3(m, h_ext)") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must include local Zeeman curvature in the tangent operator");
    check(
        tangent_plane.find("class MatrixFreeTangentPlaneOperator") != std::string::npos &&
            tangent_plane.find("compute_interfacial_dmi_field(") !=
                std::string::npos &&
            tangent_plane.find("compute_bulk_dmi_field(") != std::string::npos &&
            tangent_plane.find("solve_tangent_plane_matrix_free_system(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must include DMI through a matrix-free weak-residual operator");
    check(
        tangent_plane.find("has_active_demag_tangent_operator(") !=
                std::string::npos &&
            tangent_plane.find("compute_fresh_demag_field_for_magnetization(") !=
                std::string::npos &&
            tangent_plane.find("ctx_.demag.h_xyz") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must include demag through a fresh-solve matrix-free tangent operator");
    check(
        demag.find("compute_fresh_demag_field_for_magnetization(") !=
                std::string::npos &&
            demag.find("FreshDemagSolveSideEffects") != std::string::npos &&
            demag.find("demag_poisson_operator_ready_for_fresh_solve(") !=
                std::string::npos,
        "native FEM demag must expose a fresh-solve path for tangent-plane linear-response operators");
    check(
        tangent_plane.find("MINRESSolver") != std::string::npos &&
            tangent_plane.find("GMRESSolver") != std::string::npos &&
            tangent_plane.find("HypreGMRES") != std::string::npos &&
            tangent_plane.find("has_local_indefinite_terms") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must use non-SPD-capable solvers for local and DMI curvature terms");
    check(
        tangent_plane.find("solver.GetConverged()") != std::string::npos &&
            tangent_plane.find("solver.GetFinalNorm()") != std::string::npos &&
            tangent_plane.find("tangent-plane implicit MFEM CG solve did not converge") !=
                std::string::npos &&
            tangent_plane.find("tangent-plane implicit MFEM MINRES solve did not converge") !=
                std::string::npos &&
            tangent_plane.find("tangent-plane implicit MFEM GMRES solve did not converge") !=
                std::string::npos,
        "native FEM tangent-plane implicit serial MFEM linear solves must reject non-converged solves");
    check(
        tangent_plane.find("validate_hypre_relative_residual(") !=
                std::string::npos &&
            tangent_plane.find("final_relative_residual <= kLinearSolveRelativeTolerance") !=
                std::string::npos &&
            tangent_plane.find("final_absolute_residual <= kLinearSolveAbsoluteTolerance") !=
                std::string::npos &&
            tangent_plane.find("tangent-plane implicit Hypre linear solve requires OpenMPI singleton socket support") !=
                std::string::npos &&
            tangent_plane.find("iterations >= kLinearSolveMaximumIterations") ==
                std::string::npos,
        "native FEM tangent-plane implicit Hypre linear solves must reject non-converged residuals before using the solution");
    check(
        tangent_plane.find("validate_relaxation_state_fields(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must validate state fields before computing gradients");
    check(
        tangent_plane.find("validate_relaxation_step_energy(") !=
                std::string::npos &&
            tangent_plane.find("\"current\"") != std::string::npos &&
            tangent_plane.find("\"trial\"") != std::string::npos,
        "native FEM tangent-plane implicit relaxation must validate current and trial snapshot energies explicitly");
    check(
        tangent_plane.find("\"accepted\"") != std::string::npos &&
            tangent_plane.find("validate_tangent_gradient_field(") !=
                std::string::npos &&
            tangent_plane.find("accepted-gradient validation failure") !=
                std::string::npos &&
            tangent_plane.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            tangent_plane.rfind("validate_tangent_gradient_field(") <
                tangent_plane.find("update_implicit_step_size(ctx.relaxation, trial_step, backtracks)"),
        "native FEM tangent-plane implicit relaxation must validate accepted-step tangent gradients before storing accepted-step state");
    check(
        tangent_plane.find("sanitized_relaxation_step_size(ctx.relaxation.step_size)") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must sanitize runtime step size before Armijo");
    check(
        tangent_plane.find("projected direction contains non-finite values") !=
                std::string::npos &&
            tangent_plane.find("!std::isfinite(direction_dot_gradient)") !=
                std::string::npos &&
            tangent_plane.find("non-finite or non-descent tangent direction") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must fail with explicit diagnostics for invalid tangent directions");
    check(
        tangent_plane.find("line_search_accepted") != std::string::npos &&
            tangent_plane.find("kTangentPlaneImplicitMaxBacktracks") !=
                std::string::npos &&
            tangent_plane.find("restore_after_failed_line_search(") !=
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must reject exhausted Armijo searches and restore the previous state");
    check(
        tangent_plane.find("restore_previous_relaxation_state(") !=
                std::string::npos &&
            tangent_plane.find("restore_after_rejected_trial(") !=
                std::string::npos &&
            tangent_plane.find("context_upload_magnetization_f64(") ==
                std::string::npos,
        "native FEM tangent-plane implicit relaxation must use shared validated restore helpers instead of direct state uploads after failed or rejected trial snapshots");
    check(
        tangent_plane.find("finish_accepted_relaxation_step(") !=
                std::string::npos &&
            tangent_plane.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)") !=
                std::string::npos &&
            tangent_plane.find("finish_accepted_relaxation_step(") <
                tangent_plane.find("publish_accepted_gradient_completion(ctx, trial_g_norm_sq)"),
        "native FEM tangent-plane implicit relaxation must publish accepted-step gradient completion from the validated accepted tangent-gradient norm");
    check(
        tangent_plane.find("implicit_tangent_direction(") == std::string::npos &&
            tangent_plane.find("node_norm(") == std::string::npos,
        "native FEM tangent-plane implicit relaxation must not regress to a local diagonal step");
}

void runner_does_not_claim_production_fem_minimizer_ownership() {
    const std::string runner_fem =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "direct_minimizer.rs");
    const std::string runner_algorithm =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "algorithm.rs");

    check(
        runner_fem.find("backend.relax_step(") != std::string::npos,
        "runner FEM direct-minimizer path must call the native production relaxation ABI");
    check(
        runner_fem.find("backend.stage_completion()?") != std::string::npos &&
            runner_fem.find("backend_completion") != std::string::npos,
        "runner FEM direct-minimizer path must forward native stage-completion snapshots instead of inferring all stop reasons in Rust");
    check(
        runner_fem.find("relaxation_stop_criteria_satisfied") ==
                std::string::npos &&
            runner_fem.find("energy_plateau") == std::string::npos,
        "runner FEM direct-minimizer path must not duplicate native stop-state ownership with Rust-side plateau or stop checks");
    check(
        runner_fem.find("current_stats.max_torque_Apm <= threshold") ==
            std::string::npos,
        "runner FEM direct-minimizer path must not short-circuit native initial torque completion");
    check(
        runner_fem.find("bootstrap") == std::string::npos,
        "runner FEM direct-minimizer path must not describe native production relaxation as bootstrap");
    check(
        runner_fem.find("projected_gradient_line_search(") == std::string::npos &&
            runner_fem.find("nonlinear_cg_line_search(") == std::string::npos,
        "runner must not own production FEM direct-minimizer line-search loops");
    check(
        runner_algorithm.find("RelaxationAlgorithmIR::TangentPlaneImplicit => true") !=
            std::string::npos ||
            runner_algorithm.find("| RelaxationAlgorithmIR::TangentPlaneImplicit => Some(control)") !=
            std::string::npos,
        "runner must route tangent-plane implicit relaxation through the native FEM ABI");
}

void gpu_relaxation_pgbb_building_blocks_live_under_native_cuda() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path relaxation_root =
        root / "gpu" / "cuda" / "relaxation";
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string pgbb_header =
        read_text_file(relaxation_root / "pgbb.hpp");
    const std::string pgbb_source =
        read_text_file(relaxation_root / "pgbb.cpp");
    const std::string nonlinear_cg_source =
        read_text_file(relaxation_root / "nonlinear_cg.cpp");
    const std::string direct_energy_header =
        read_text_file(relaxation_root / "direct_energy_increment.hpp");
    const std::string direct_energy_source =
        read_text_file(relaxation_root / "direct_energy_increment.cpp");
    const std::string relaxation_state =
        read_text_file(relaxation_root / "relaxation_state.hpp");
    const std::string relaxation_memory_source =
        read_text_file(relaxation_root / "relaxation_memory.cpp");
    const std::string gpu_rk_demag_dispatch =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_demag_dispatch.cu");
    const std::string gpu_rk_rhs_runtime =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_rhs_runtime.cu");
    const std::string scalar_readback_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_scalar_readback.hpp");
    const std::string step_stats_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_step_stats.hpp");
    const std::string kernels_header =
        read_text_file(relaxation_root / "pgbb_kernels.hpp");
    const std::string kernels_source =
        read_text_file(relaxation_root / "pgbb_kernels.cu");
    const auto direct_kernel_start =
        kernels_source.find("__global__ void direct_energy_difference_kernel(");
    const auto direct_kernel_end =
        kernels_source.find(
            "__global__ void tangent_gradient_norm_kernel(",
            direct_kernel_start);
    const std::string direct_kernel =
        direct_kernel_start == std::string::npos
            ? std::string()
            : kernels_source.substr(
                  direct_kernel_start,
                  direct_kernel_end == std::string::npos
                      ? std::string::npos
                      : direct_kernel_end - direct_kernel_start);
    const std::string gpu_demag_stage =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
    const std::string runner_algorithm =
        read_text_file(repo_root() / "crates" / "fullmag-runner" / "src" /
                       "fem" / "relax" / "algorithm.rs");
    const auto pgbb_current_metrics_start = pgbb_source.find(
        "bool gpu_relax_compute_current_metrics(");
    const auto pgbb_current_metrics_end =
        pgbb_current_metrics_start == std::string::npos
            ? std::string::npos
            : pgbb_source.find(
                  "bool gpu_relax_restore_previous_magnetization(",
                  pgbb_current_metrics_start);
    const std::string pgbb_current_metrics =
        pgbb_current_metrics_start == std::string::npos
            ? std::string()
            : pgbb_source.substr(
                  pgbb_current_metrics_start,
                  pgbb_current_metrics_end == std::string::npos
                      ? std::string::npos
                      : pgbb_current_metrics_end - pgbb_current_metrics_start);
    const auto pgbb_helpers_start = pgbb_source.find("namespace {");
    const auto pgbb_helpers_end =
        pgbb_helpers_start == std::string::npos
            ? std::string::npos
            : pgbb_source.find("} // namespace", pgbb_helpers_start);
    const std::string pgbb_helpers =
        pgbb_helpers_start == std::string::npos
            ? std::string()
            : pgbb_source.substr(
                  pgbb_helpers_start,
                  pgbb_helpers_end == std::string::npos
                      ? std::string::npos
                      : pgbb_helpers_end - pgbb_helpers_start);
    const auto pgbb_step_start =
        pgbb_source.find("int gpu_relax_projected_gradient_bb_step(");
    const auto pgbb_step_end =
        pgbb_step_start == std::string::npos
            ? std::string::npos
            : pgbb_source.find("#else", pgbb_step_start);
    const std::string pgbb_step =
        pgbb_step_start == std::string::npos
            ? std::string()
            : pgbb_source.substr(
                  pgbb_step_start,
                  pgbb_step_end == std::string::npos
                      ? std::string::npos
                      : pgbb_step_end - pgbb_step_start);

    check(
        cmake.find("gpu/cuda/relaxation/pgbb.cpp") != std::string::npos &&
            cmake.find("gpu/cuda/relaxation/direct_energy_increment.cpp") !=
                std::string::npos &&
            cmake.find("gpu/cuda/relaxation/pgbb_kernels.cu") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB and shared direct-energy sources must be built by the native FEM CMake target");
    check(
        direct_energy_header.find("struct GpuDirectEnergySnapshot") !=
                std::string::npos &&
            direct_energy_header.find("struct GpuPgbbCurrentMetrics") !=
                std::string::npos &&
            direct_energy_header.find("GpuDirectEnergySnapshot energy_snapshot") !=
                std::string::npos &&
            direct_energy_header.find("double gradient_norm_sq") !=
                std::string::npos &&
            direct_energy_header.find("double projected_gradient_norm_sq") !=
                std::string::npos &&
            direct_energy_header.find("bool energy_snapshot_finite") !=
                std::string::npos &&
            direct_energy_header.find("bool gradient_norm_finite") !=
                std::string::npos &&
            direct_energy_header.find("bool projected_gradient_norm_finite") !=
                std::string::npos &&
            direct_energy_header.find("struct GpuDirectArmijoResult") !=
                std::string::npos &&
            direct_energy_header.find("gpu_direct_armijo_evaluate(") !=
                std::string::npos &&
            direct_energy_source.find("gpu_direct_armijo_evaluate(") !=
                std::string::npos &&
            pgbb_source.find("gpu_direct_pgbb_armijo_evaluate(") !=
                std::string::npos &&
            nonlinear_cg_source.find("gpu_direct_armijo_evaluate(") !=
                std::string::npos,
        "native FEM GPU direct minimizers must use the shared direct energy-increment owner for Armijo decisions");
    check(
        kernels_header.find(
            "fullmag_cuda_relax_pgbb_current_metrics_finite_flags(") !=
                std::string::npos &&
            kernels_source.find(
                "pgbb_current_metrics_finite_flags_kernel") !=
                std::string::npos &&
            kernels_source.find("isfinite(energy_terms[slot])") !=
                std::string::npos &&
            kernels_source.find("gradient_norm_sq[0] >= 0.0") !=
                std::string::npos &&
            kernels_source.find("projected_gradient_norm_sq[0] >= 0.0") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must generate current energy/gradient finite flags on device for the packed current-state readback");
    check(
        direct_energy_source.find("kDirectEnergyTailSlots = 12") !=
                std::string::npos &&
            direct_energy_source.find(
                "kDirectActiveStateChangeTailSlot") != std::string::npos &&
            direct_energy_source.find(
                "result.trial_active_state_unchanged =") !=
                std::string::npos &&
            direct_energy_source.find(
                "track_active_state_change && changed_active_nodes == 0.0") !=
                std::string::npos &&
            direct_energy_source.find(
                "GPU direct minimizer energy batch device->host") !=
                std::string::npos &&
            direct_energy_source.find(
                "GPU direct minimizer local energy scalars device->host") ==
                std::string::npos &&
            direct_energy_source.find(
                "GPU direct minimizer exchange delta device->host") ==
                std::string::npos,
        "native FEM GPU direct Armijo evaluation must batch endpoint, direct-increment, and active-state scalars into one control readback");
    check(
        kernels_header.find("bool demag_enabled") != std::string::npos &&
            direct_energy_source.find("ctx.demag.enabled") != std::string::npos &&
            direct_energy_source.find(
                "case GpuFinalScalarSlot::DemagEnergy:") !=
                std::string::npos &&
            direct_energy_source.find(
                "ctx.demag.enabled ? GpuEnergyIncrementOwner::Direct") !=
                std::string::npos &&
            direct_kernel.find("block_demag_delta") != std::string::npos &&
            direct_kernel.find("block_demag_absolute") != std::string::npos &&
            direct_kernel.find("gpu_relax_dd::magnitude(demag_x_dd)") !=
                std::string::npos &&
            direct_kernel.find("gpu_relax_dd::magnitude(demag_y_dd)") !=
                std::string::npos &&
            direct_kernel.find("gpu_relax_dd::magnitude(demag_z_dd)") !=
                std::string::npos,
        "native FEM GPU direct Armijo evaluation must contribute zero signed and absolute demag energy when demag is disabled");
    check(
        relaxation_state.find("struct FemGpuAcceptedEvaluationToken") !=
                std::string::npos &&
            relaxation_state.find("state_generation") != std::string::npos &&
            relaxation_state.find("gpu_relax_invalidate_accepted_evaluation(") !=
                std::string::npos &&
            nonlinear_cg_source.find("consume_ncg_accepted_evaluation(") !=
                std::string::npos &&
            nonlinear_cg_source.find("publish_ncg_accepted_evaluation(") !=
                std::string::npos &&
            relaxation_state.find(
                "accepted_evaluation_cache_hits_current_step") !=
                std::string::npos &&
            relaxation_state.find(
                "accepted_evaluation_cache_misses_current_step") !=
                std::string::npos &&
            relaxation_state.find("direct_energy_refinements_current_step") !=
                std::string::npos &&
            nonlinear_cg_source.find(
                "uint32_t logical_rhs_evaluations = 1u;") !=
                std::string::npos &&
            nonlinear_cg_source.find(
                "uint32_t &logical_rhs_evaluations") !=
                std::string::npos &&
            nonlinear_cg_source.find(
                "logical_rhs_evaluations += 1u;") !=
                std::string::npos &&
            nonlinear_cg_source.find(
                "logical_rhs_evaluations += 1u;",
                nonlinear_cg_source.find(
                    "logical_rhs_evaluations += 1u;") + 1u) !=
                std::string::npos &&
            nonlinear_cg_source.find(
                "logical_rhs_evaluations + refinement_rhs_evaluations") !=
                std::string::npos &&
            nonlinear_cg_source.find("current_evaluation_count") ==
                std::string::npos &&
            nonlinear_cg_source.find(
                "gpu_relax_accept_monotone_recovery_step") ==
                std::string::npos,
        "native FEM GPU nonlinear-CG must consume accepted endpoint evaluations once while publishing one logical current-state record, every normal/recovery Armijo trial exactly once, and refinement evaluations");
    check(
        nonlinear_cg_source.find("gpu_rk_capture_step_transaction_device(ctx, reason)") !=
                std::string::npos &&
            nonlinear_cg_source.find("gpu_rk_restore_step_transaction_device(ctx, restore_reason)") !=
                std::string::npos &&
            nonlinear_cg_source.find("restore_gpu_relax_ncg_accepted_evaluation(") !=
                std::string::npos &&
            nonlinear_cg_source.find(
                "gpu_relax_invalidate_accepted_evaluation(ctx.gpu_state.device.relaxation)") ==
                std::string::npos,
        "native FEM GPU nonlinear-CG failure rollback must restore the complete published device transaction and prior accepted-endpoint token");
    check(
        pgbb_header.find("gpu_relax_projected_gradient_bb_step(") !=
                std::string::npos &&
            pgbb_source.find("GPU CUDA projected-gradient BB relaxation step source contract") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_pgbb_preflight(") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_plan_device_resident(ctx, reason)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must expose a native preflight/step boundary");
    check(
        pgbb_source.find("gpu.mesh_metrics.lumped_mass == nullptr") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB requires a device FEM lumped-mass metric") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must require the device FEM lumped-mass metric");
    check(
        pgbb_source.find("gpu.mesh_regions.magnetic_node_mask == nullptr") !=
                std::string::npos &&
            pgbb_source.find("gpu.mesh_regions.node_count != gpu.lifecycle.node_count") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB requires a device magnetic-node mask matching the FEM state") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must require a device magnetic-node mask matching the FEM state");
    check(
        pgbb_source.find("#include <limits>") != std::string::npos &&
            pgbb_source.find("std::numeric_limits<int>::max()") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB node count exceeds CUDA kernel launch index range") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must reject meshes too large for int-indexed CUDA kernels");
    check(
        pgbb_source.find("gpu.rk.m_backup.x == nullptr") !=
                std::string::npos &&
            pgbb_source.find("gpu.rk.m_backup.y == nullptr") !=
                std::string::npos &&
            pgbb_source.find("gpu.rk.m_backup.z == nullptr") !=
                std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB requires RK backup scratch for rollback") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB preflight must require rollback backup scratch before line-search trials");
    check(
        relaxation_state.find(
            "FemGpuComponentField projected_gradient_accepted_h_eff") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "relaxation.projected_gradient_accepted_h_eff") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "gpu_device_allocate_component(") != std::string::npos &&
            relaxation_memory_source.find(
                "gpu_device_free_component(relaxation.projected_gradient_accepted_h_eff)") !=
                std::string::npos &&
            pgbb_source.find(
                "gpu.relaxation.projected_gradient_accepted_h_eff.x == nullptr") !=
                std::string::npos,
        "native FEM GPU PG-BB must own, account for, preflight, and free persistent accepted-state H_eff storage");
    check(
        compact_source(pgbb_step).find(
            "gpu.fields.h_eff,gpu.relaxation.projected_gradient_accepted_h_eff") !=
                std::string::npos &&
            compact_source(pgbb_step).find(
                "gpu.relaxation.projected_gradient_accepted_h_eff,reason") !=
                std::string::npos &&
            pgbb_step.find("cudaMalloc") == std::string::npos &&
            pgbb_step.find("cudaFree") == std::string::npos,
        "native FEM GPU PG-BB must copy accepted H_eff once into persistent device storage and reuse it across all backtracks without hot-loop allocation");
    check(
        pgbb_current_metrics.find(
            "gpu_rk_compute_effective_field_for_magnetization_fresh_demag(") !=
                std::string::npos &&
            pgbb_current_metrics.find("gpu_rk_reduce_final_energy_terms(") !=
                std::string::npos &&
            pgbb_current_metrics.find(
                "fullmag_cuda_relax_pgbb_current_metrics_finite_flags(") !=
                std::string::npos &&
            pgbb_current_metrics.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            pgbb_current_metrics.find(
                "gpu_rk_read_control_scalar_results(",
                pgbb_current_metrics.find("gpu_rk_read_control_scalar_results(") + 1u) ==
                std::string::npos &&
            pgbb_current_metrics.find("gpu_direct_energy_snapshot(") ==
                std::string::npos &&
            pgbb_source.find("gpu_relax_compute_effective_field_and_energy(") ==
                std::string::npos &&
            pgbb_source.find(
                "gpu_relax_compute_effective_field_and_energy_terms(") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos &&
            pgbb_source.find("fullmag_cuda_relax_retract_field(") !=
                std::string::npos &&
            pgbb_source.find("kArmijoCoefficient") != std::string::npos &&
            pgbb_source.find("last_trial_energy_j =") != std::string::npos &&
            pgbb_source.find("armijo_result.trial_snapshot.total_energy_j;") !=
                std::string::npos &&
            pgbb_source.find(
                "GPU projected-gradient BB active-state change scalar device->host") ==
                std::string::npos &&
            pgbb_source.find("armijo_result.trial_active_state_unchanged") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must batch its current snapshot/gradient metrics into one readback and reuse the direct Armijo trial snapshot without a standalone trial-total readback");
    check(
        pgbb_source.find("uint32_t logical_rhs_evaluations = 1u;") !=
                std::string::npos &&
            pgbb_source.find("logical_rhs_evaluations += 1u;") !=
                std::string::npos &&
            pgbb_source.find("refinement_rhs_evaluations +=") !=
                std::string::npos &&
            pgbb_source.find(
                "logical_rhs_evaluations + refinement_rhs_evaluations") !=
                std::string::npos &&
            pgbb_source.find("backtracks + 2u") == std::string::npos,
        "native FEM GPU projected-gradient BB must publish two nominal logical RHS records per accepted step, every additional Armijo trial once, and direct-energy refinements additively");
    check(
        !pgbb_helpers.empty() &&
            !pgbb_step.empty() &&
            pgbb_helpers.find(
                "gpu_relax_retry_pgbb_line_search_with_reset") ==
                std::string::npos &&
            pgbb_helpers.find(
                "gpu_relax_retry_pgbb_line_search_with_raw_gradient_restart") ==
                std::string::npos &&
            pgbb_helpers.find("gpu_direct_energy_snapshot(") ==
                std::string::npos &&
            pgbb_step.find("gpu_direct_energy_snapshot(") ==
                std::string::npos,
        "native FEM GPU PG-BB helper and accepted-step regions must not retain stale recovery implementations or standalone trial-total readbacks");
    check(
        gpu_rk_rhs_runtime.find(
            "gpu_rk_compute_demag_for_device_stage_fresh(ctx, m, stream, reason)") !=
                std::string::npos &&
            gpu_rk_demag_dispatch.find(
                "compute_device_demag_for_device_stage_fresh(ctx, m, stream, reason)") !=
                std::string::npos,
        "native FEM GPU Armijo energy evaluations must route through the zero-start device demag solve");
    check(
        scalar_readback_header.find("gpu_rk_read_control_scalar_result(") !=
                std::string::npos &&
            scalar_readback_header.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            step_stats_header.find("gpu_rk_finalize_step_stats_control_readback(") !=
                std::string::npos,
        "native FEM GPU direct minimizers must have explicit control-scalar readback APIs separate from RK compute readbacks");
    check(
        pgbb_source.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            pgbb_source.find("gpu_rk_read_control_scalar_result(") ==
                std::string::npos &&
            pgbb_source.find("gpu_rk_read_scalar_result(") ==
                std::string::npos &&
            pgbb_source.find("gpu_rk_read_scalar_results(") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB must account scalar minimizer decisions as control readbacks, not compute D2H");
    check(
        pgbb_source.find("constexpr double kDefaultStepSize = 1.0e-6") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kMinStepSize = 1.0e-15") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kMaxStepSize = 1.0e-3") !=
                std::string::npos &&
            pgbb_source.find("constexpr double kArmijoCoefficient = 1.0e-4") !=
                std::string::npos &&
            pgbb_source.find("kGradientFloor") == std::string::npos &&
            pgbb_source.find("kBbCurvatureScale") == std::string::npos &&
            pgbb_source.find("relaxation::bb_step_decision(") !=
                std::string::npos &&
            pgbb_source.find("kLineSearchEnergyNoiseFloorJ") == std::string::npos &&
            pgbb_source.find("kLineSearchEnergyNoiseRelative") == std::string::npos &&
            pgbb_source.find("constexpr uint32_t kMaxBacktracks = 20") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must use the shared dimension-aware BB guard and keep CPU-compatible step/Armijo constants");
    check(
        pgbb_source.find("relaxation::bb_step_decision(") != std::string::npos,
        "native FEM CUDA projected-gradient BB must use the shared candidate, clamp, and reset policy");
    check(
        pgbb_source.find("double trial_step = kDefaultStepSize") !=
                std::string::npos &&
            pgbb_source.find("std::isfinite(ctx.relaxation.step_size)") !=
                std::string::npos &&
            pgbb_source.find("ctx.relaxation.step_size > 0.0") !=
                std::string::npos &&
            pgbb_source.find("std::clamp(ctx.relaxation.step_size, kMinStepSize, kMaxStepSize)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must sanitize invalid runtime step sizes before retraction");
    check(
        pgbb_source.find("gpu_relax_compute_accepted_bb_curvature(") !=
                std::string::npos &&
            pgbb_source.find("fullmag_cuda_relax_bb_curvature_blocks(") !=
                std::string::npos &&
            pgbb_source.find("accepted curvature scalars device->host") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_apply_bb_step_size_from_curvature(") !=
                std::string::npos &&
            pgbb_source.find("ctx.relaxation.use_bb1") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must update BB1/BB2 step size from device-reduced curvature");
    check(
        direct_energy_source.find("GPU projected-gradient BB produced non-finite total energy") !=
                std::string::npos &&
            direct_energy_source.find("!metrics.energy_snapshot_finite") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must report non-finite energy failures explicitly");
    check(
        direct_energy_source.find("GPU projected-gradient BB produced a non-finite or negative tangent-gradient norm") !=
                std::string::npos &&
            direct_energy_source.find("!metrics.gradient_norm_finite") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must reject invalid tangent-gradient reductions before Armijo");
    check(
        pgbb_source.find("GPU projected-gradient BB produced invalid BB curvature scalars") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(s_dot_s)") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(s_dot_y)") !=
                std::string::npos &&
            pgbb_source.find("!std::isfinite(y_dot_y)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must reject invalid BB curvature reductions before updating step size");
    check(
        pgbb_source.find("line_search_accepted") != std::string::npos &&
            pgbb_source.find("GPU projected-gradient BB failed Armijo line search") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_restore_previous_magnetization(") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must reject exhausted Armijo searches and restore the previous device state");
    const auto pgbb_main_start =
        pgbb_source.find("int gpu_relax_projected_gradient_bb_step(");
    const auto pgbb_first_armijo =
        pgbb_main_start == std::string::npos
            ? std::string::npos
            : pgbb_source.find("GpuDirectArmijoResult armijo_result", pgbb_main_start);
    const auto pgbb_backtrack_limit =
        pgbb_first_armijo == std::string::npos
            ? std::string::npos
            : pgbb_source.find("if (backtracks >= kMaxBacktracks)", pgbb_first_armijo);
    const auto pgbb_refinement =
        pgbb_first_armijo == std::string::npos
            ? std::string::npos
            : pgbb_source.find("gpu_direct_armijo_refine(", pgbb_first_armijo);
    const auto pgbb_monotone_escape =
        pgbb_first_armijo == std::string::npos
            ? std::string::npos
            : pgbb_source.find(
                  "strict_armijo_difference_decision(\n                direct_difference, 0.0)",
                  pgbb_first_armijo);
    check(
            pgbb_first_armijo != std::string::npos &&
            pgbb_source.find(
                "gpu_direct_pgbb_armijo_evaluate(",
                pgbb_first_armijo) <
                pgbb_refinement &&
            pgbb_refinement < pgbb_backtrack_limit &&
            pgbb_backtrack_limit != std::string::npos &&
            (pgbb_monotone_escape == std::string::npos ||
                pgbb_monotone_escape > pgbb_backtrack_limit),
        "native FEM GPU projected-gradient BB must decide strict Armijo only from its direct energy difference before exhausting backtracks");
    check(
        pgbb_source.find("current_energy_j=") != std::string::npos &&
            pgbb_source.find("last_trial_energy_j=") != std::string::npos &&
            pgbb_source.find("armijo_rhs_j=") != std::string::npos &&
            pgbb_source.find("last_trial_step=") != std::string::npos &&
            pgbb_source.find("gradient_norm_sq=") != std::string::npos &&
            pgbb_source.find("format_gpu_relax_pgbb_scalar(") != std::string::npos,
        "native FEM GPU projected-gradient BB exhausted Armijo failures must include actionable scientific line-search diagnostics");
    check(
        pgbb_source.find("gpu_relax_restore_previous_magnetization_after_failure(") !=
                std::string::npos &&
            pgbb_source.find("failed to restore previous device state after") !=
                std::string::npos &&
            pgbb_source.find("original error:") != std::string::npos &&
            pgbb_source.find("previous device state restored") !=
                std::string::npos &&
            pgbb_source.find("(void)gpu_relax_restore_previous_magnetization(") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB must check restore failures instead of masking them with best-effort device-state restore");
    check(
        pgbb_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            pgbb_source.find("FULLMAG_FEM_ERR_UNAVAILABLE") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must publish accepted stats while retaining no-CUDA unavailable fallback");
    check(
        pgbb_source.find("#include \"cpu/mfem/runtime/stage_completion.hpp\"") !=
                std::string::npos &&
            pgbb_source.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
                std::string::npos &&
            pgbb_source.find("\"tangent_gradient_norm_sq\"") !=
                std::string::npos &&
            pgbb_source.find("set_stage_completion(") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must publish gradient-converged stop state through the runtime stage-completion owner");
    const auto pgbb_degenerate_gradient =
        pgbb_source.find("if (gradient_norm_sq == 0.0)");
    const auto pgbb_degenerate_finalize =
        pgbb_degenerate_gradient == std::string::npos
            ? std::string::npos
            : pgbb_source.find(
                  "gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)",
                  pgbb_degenerate_gradient);
    check(
        pgbb_source.find("void mark_gpu_relax_pgbb_device_source_of_truth(") !=
                std::string::npos &&
            pgbb_degenerate_gradient != std::string::npos &&
            pgbb_degenerate_finalize != std::string::npos &&
            pgbb_source.find(
                "mark_gpu_relax_pgbb_device_source_of_truth(ctx)",
                pgbb_degenerate_gradient) < pgbb_degenerate_finalize,
        "native FEM GPU projected-gradient BB must publish device source-of-truth before zero-gradient stats/stage completion");
    check(
        pgbb_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            pgbb_source.find("update_stage_completion_from_stats(ctx, out_stats)") !=
                std::string::npos &&
            pgbb_source.rfind("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") <
                pgbb_source.find("update_stage_completion_from_stats(ctx, out_stats)"),
        "native FEM GPU projected-gradient BB accepted steps must update runtime stage completion from finalized native stats");
    const std::size_t pgbb_accepted_finalize =
        pgbb_source.find("if (!gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason))");
    const std::size_t pgbb_accepted_finalize_restore =
        pgbb_accepted_finalize == std::string::npos
        ? std::string::npos
        : pgbb_source.find(
              "return gpu_relax_restore_accepted_step_after_finalize_failure(",
              pgbb_accepted_finalize);
    const std::size_t pgbb_stage_completion_update =
        pgbb_source.find("update_stage_completion_from_stats(ctx, out_stats)");
    check(
        pgbb_source.find("struct GpuRelaxPgbbRollbackState") !=
                std::string::npos &&
            pgbb_source.find("capture_gpu_relax_pgbb_rollback_state(ctx)") !=
                std::string::npos &&
            pgbb_source.find("restore_gpu_relax_pgbb_metadata(ctx, rollback)") !=
                std::string::npos &&
            pgbb_source.find("gpu_relax_restore_accepted_step_after_finalize_failure(") !=
                std::string::npos &&
            pgbb_source.find("accepted-step stats finalization failure") !=
                std::string::npos &&
            pgbb_source.find("capture_gpu_relax_pgbb_rollback_state(ctx)") <
                pgbb_source.find("ctx.relaxation.accepted_steps += 1") &&
            pgbb_accepted_finalize != std::string::npos &&
            pgbb_accepted_finalize_restore != std::string::npos &&
            pgbb_stage_completion_update != std::string::npos &&
            pgbb_accepted_finalize < pgbb_accepted_finalize_restore &&
            pgbb_accepted_finalize_restore < pgbb_stage_completion_update,
        "native FEM GPU projected-gradient BB must roll back device state and step metadata if accepted-step stats finalization fails");
    check(
        kernels_source.find("GPU CUDA projected-gradient BB relaxation kernels source contract") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB kernels must document their source contract");
    check(
        kernels_header.find("fullmag_cuda_relax_tangent_gradient_and_norm_blocks(") !=
                std::string::npos &&
            kernels_source.find("tangent_gradient_norm_kernel") !=
                std::string::npos &&
            kernels_source.find("const double grad_x = -tx") !=
                std::string::npos &&
            kernels_source.find("return mask[i] != 0u") !=
                std::string::npos &&
            kernels_source.find("mask == nullptr || mask[i] != 0u") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB must expose CPU-compatible tangent-gradient kernels without all-active mask fallback");
    check(
        kernels_header.find("fullmag_cuda_relax_metric_dot_blocks(") !=
                std::string::npos &&
            kernels_source.find("node_weight(lumped_mass, i)") !=
                std::string::npos &&
            kernels_source.find("return lumped_mass[i]") !=
                std::string::npos &&
            kernels_source.find("lumped_mass == nullptr ? 1.0") ==
                std::string::npos &&
            kernels_source.find("block_reduce_sum(local)") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must expose FEM mass-metric reduction kernels without unweighted fallback");
    check(
        kernels_header.find("fullmag_cuda_relax_retract_field(") !=
                std::string::npos &&
            kernels_source.find("retract_field_kernel") != std::string::npos &&
            kernels_source.find("out_x[i] = x * inv") != std::string::npos &&
            kernels_source.find("!isfinite(norm)") != std::string::npos &&
            kernels_source.find("norm <= 0.0") != std::string::npos &&
            kernels_source.find("CUDART_NAN") != std::string::npos,
        "native FEM GPU projected-gradient BB must expose normalized nodal retraction kernels without invalid-norm no-op fallback");
    check(
        kernels_header.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos &&
            kernels_source.find("project_static_periodic_field_kernel") !=
                std::string::npos &&
            kernels_source.find("periodic_representative_nodes[i]") !=
                std::string::npos &&
            pgbb_source.find("gpu.mesh_regions.has_periodic_reduced_nodes") !=
                std::string::npos &&
            pgbb_source.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must project trial magnetization onto static periodic classes after retraction");
    check(
        gpu_demag_stage.find("#include \"gpu/cuda/relaxation/pgbb_kernels.hpp\"") !=
                std::string::npos &&
            gpu_demag_stage.find("gpu.mesh_regions.has_periodic_reduced_nodes") !=
                std::string::npos &&
            gpu_demag_stage.find("gpu.fields.h_demag.x") != std::string::npos &&
            gpu_demag_stage.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos,
        "native FEM GPU Poisson demag must project recovered H_demag onto static periodic classes before energy/snapshots");
    const auto invalid_norm_branch =
        kernels_source.find("if (!isfinite(norm) || norm <= 0.0)");
    const auto normalized_branch = kernels_source.find("const double inv = 1.0 / norm");
    const std::string invalid_norm_retraction =
        invalid_norm_branch == std::string::npos ||
                normalized_branch == std::string::npos ||
                invalid_norm_branch >= normalized_branch
            ? std::string()
            : kernels_source.substr(
                  invalid_norm_branch,
                  normalized_branch - invalid_norm_branch);
    check(
        invalid_norm_retraction.find("CUDART_NAN") != std::string::npos &&
            invalid_norm_retraction.find("out_x[i] = mx[i]") ==
                std::string::npos &&
            invalid_norm_retraction.find("out_y[i] = my[i]") ==
                std::string::npos &&
            invalid_norm_retraction.find("out_z[i] = mz[i]") ==
                std::string::npos,
        "native FEM GPU projected-gradient BB invalid-norm retraction branch must write NaNs instead of restoring the previous active vector");
    check(
        kernels_header.find("fullmag_cuda_relax_bb_curvature_blocks(") !=
                std::string::npos &&
            kernels_header.find(
                "const double *ms,\n    const double *lumped_mass",
                kernels_header.find("fullmag_cuda_relax_bb_curvature_blocks(")) !=
                std::string::npos &&
            kernels_source.find("bb_curvature_kernel") !=
                std::string::npos &&
            kernels_source.find(
                "const double energy_weight = kMu0 * ms[i] * node_weight(lumped_mass, i);",
                kernels_source.find("__global__ void bb_curvature_kernel(")) !=
                std::string::npos &&
            kernels_source.find(
                "project_node_tangent(",
                kernels_source.find("__global__ void bb_curvature_kernel(")) !=
                std::string::npos &&
            kernels_source.find(
                "double transported_previous_gx = 0.0;",
                kernels_source.find("__global__ void bb_curvature_kernel(")) !=
                std::string::npos &&
            kernels_source.find(
                "transported_previous_gx,",
                kernels_source.find("__global__ void bb_curvature_kernel(")) !=
                std::string::npos &&
            kernels_source.find("block_s_dot_s[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_s_dot_y[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_y_dot_y[blockIdx.x]") !=
                std::string::npos,
        "native FEM GPU projected-gradient BB must transport its secant pair into the accepted tangent space before device curvature reduction");
    check(
        runner_algorithm.find("ProjectedGradientBb, FemEngineKind::NativeGpu) => true") !=
                std::string::npos &&
            runner_algorithm.find("NonlinearCg, FemEngineKind::NativeGpu) => true") !=
                std::string::npos &&
            runner_algorithm.find("TangentPlaneImplicit, FemEngineKind::NativeGpu) => false") !=
                std::string::npos,
        "runner must advertise native GPU projected-gradient BB and nonlinear-CG while keeping TPI CPU-only");
}

void gpu_relaxation_ncg_direction_state_is_device_persistent() {
    const std::filesystem::path root = fem_source_root();
    const std::filesystem::path relaxation_root =
        root / "gpu" / "cuda" / "relaxation";
    const std::filesystem::path state_root = root / "gpu" / "cuda" / "state";
    const std::string cmake = read_text_file(root / "CMakeLists.txt");
    const std::string backend_step =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
    const std::string ncg_header =
        read_text_file(relaxation_root / "nonlinear_cg.hpp");
    const std::string ncg_source =
        read_text_file(relaxation_root / "nonlinear_cg.cpp");
    const std::string direct_energy_header =
        read_text_file(relaxation_root / "direct_energy_increment.hpp");
    const std::string direct_energy_source =
        read_text_file(relaxation_root / "direct_energy_increment.cpp");
    const std::string relaxation_numerics =
        read_text_file(root / "src" / "relaxation_numerics.hpp");
    const std::string scalar_readback_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_scalar_readback.hpp");
    const std::string step_stats_header =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" /
                       "rk_step_stats.hpp");
    const std::string kernels_header =
        read_text_file(relaxation_root / "pgbb_kernels.hpp");
    const std::string kernels_source =
        read_text_file(relaxation_root / "pgbb_kernels.cu");
    const std::string relaxation_state =
        read_text_file(relaxation_root / "relaxation_state.hpp");
    const std::string relaxation_memory_header =
        read_text_file(relaxation_root / "relaxation_memory.hpp");
    const std::string relaxation_memory_source =
        read_text_file(relaxation_root / "relaxation_memory.cpp");
    const std::string gpu_state_header =
        read_text_file(state_root / "gpu_state.hpp");
    const std::string gpu_state_source =
        read_text_file(state_root / "gpu_state.cpp");
    const auto compute_terms_start = direct_energy_source.find(
        "bool gpu_relax_compute_effective_field_and_energy_terms(");
    const auto compute_terms_end =
        compute_terms_start == std::string::npos
            ? std::string::npos
            : direct_energy_source.find(
                  "bool gpu_direct_energy_snapshot(", compute_terms_start);
    const std::string compute_terms =
        compute_terms_start == std::string::npos
            ? std::string()
            : direct_energy_source.substr(
                  compute_terms_start,
                  compute_terms_end == std::string::npos
                      ? std::string::npos
                      : compute_terms_end - compute_terms_start);

    check(
        cmake.find("gpu/cuda/relaxation/relaxation_memory.cpp") !=
                std::string::npos &&
            cmake.find("gpu/cuda/relaxation/nonlinear_cg.cpp") !=
                std::string::npos &&
            cmake.find("gpu/cuda/relaxation/pgbb_kernels.cu") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG source, kernels, and persistent relaxation memory must be built by the native FEM CMake target");
    check(
        backend_step.find("#include \"gpu/cuda/relaxation/nonlinear_cg.hpp\"") !=
                std::string::npos &&
            backend_step.find("algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG") !=
                std::string::npos &&
            backend_step.find("gpu_relax_nonlinear_cg_step(ctx, out_stats, error)") !=
                std::string::npos,
        "native FEM backend-step routing must dispatch allocated GPU nonlinear-CG to the native CUDA relaxation step");
    check(
        ncg_header.find("gpu_relax_nonlinear_cg_step(") !=
                std::string::npos &&
            ncg_source.find("GPU CUDA nonlinear-CG relaxation step source contract") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_ncg_preflight(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_plan_device_resident(ctx, reason)") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must expose a native preflight/step boundary");
    check(
        ncg_source.find("#include <limits>") != std::string::npos &&
            ncg_source.find("std::numeric_limits<int>::max()") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG node count exceeds CUDA kernel launch index range") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must reject meshes too large for int-indexed CUDA kernels");
    check(
        direct_energy_header.find(
            "bool gpu_relax_compute_effective_field_and_energy_terms(") !=
                std::string::npos &&
            compute_terms.find(
                "gpu_rk_compute_effective_field_for_magnetization_fresh_demag(") !=
                std::string::npos &&
            compute_terms.find("gpu_rk_reduce_final_energy_terms(") !=
                std::string::npos &&
            compute_terms.find("gpu.reductions.scalar_result") !=
                std::string::npos &&
            compute_terms.find("gpu_rk_reduce_total_energy_scalar(") ==
                std::string::npos &&
            compute_terms.find("gpu_rk_read_control_scalar_result(") ==
                std::string::npos &&
            compute_terms.find("gpu_rk_read_control_scalar_results(") ==
                std::string::npos &&
            compute_terms.find("cudaMemcpy") == std::string::npos,
        "native FEM GPU direct minimizers must expose a fresh-demag effective-field/energy-term compute helper without a host scalar readback");
    check(
        ncg_source.find("gpu_relax_compute_effective_field_and_energy_terms(") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_compute_effective_field_and_energy(") ==
                std::string::npos &&
            ncg_source.find("gpu_rk_compute_rhs_for_magnetization(") ==
                std::string::npos &&
            ncg_source.find("gpu_relax_prepare_descent_direction(") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_update_next_direction(") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_retract_field(") !=
                std::string::npos &&
            ncg_source.find("gpu.mesh_regions.has_periodic_reduced_nodes") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_project_static_periodic_field(") !=
                std::string::npos &&
            ncg_source.find("kArmijoCoefficient") != std::string::npos &&
            ncg_source.find("gpu_direct_armijo_evaluate(") !=
                std::string::npos &&
            ncg_source.find("ArmijoDifferenceDecision::Accept") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must own a device-resident Armijo/PR+ accepted-step loop with static periodic trial projection");
    const std::string compact_ncg_source = compact_source(ncg_source);
    const std::string ncg_trial_total_assignment =
        "last_trial_energy_j=armijo_result.trial_snapshot.total_energy_j;";
    check(
        direct_energy_source.find(
            "auto &trial = result.trial_snapshot;") !=
                std::string::npos &&
            (direct_energy_source.find(
                 "std::copy_n(scalars.begin(), kGpuFinalScalarSlots, trial.terms_j.begin());") !=
                 std::string::npos ||
             direct_energy_source.find(
                 "unpack_energy_snapshot(") !=
                 std::string::npos) &&
            count_occurrences(
                compact_ncg_source, ncg_trial_total_assignment) == 2 &&
            ncg_source.find(
                "gpu_copy_scalar_to_host") == std::string::npos,
        "native FEM GPU direct Armijo evaluation must populate the trial snapshot total and both normal and recovery nonlinear-CG consumers must use it without a separate scalar readback");
    check(
        scalar_readback_header.find("gpu_rk_read_control_scalar_result(") !=
                std::string::npos &&
            scalar_readback_header.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            step_stats_header.find("gpu_rk_finalize_step_stats_control_readback(") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must use explicit control-scalar readback APIs separate from RK compute readbacks");
    check(
        ncg_source.find("gpu_rk_read_control_scalar_result(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_read_control_scalar_results(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_read_scalar_result(") ==
                std::string::npos &&
            ncg_source.find("gpu_rk_read_scalar_results(") ==
                std::string::npos,
        "native FEM GPU nonlinear-CG must account scalar minimizer decisions as control readbacks, not compute D2H");
    check(
        ncg_source.find("gpu_relax_compute_effective_field_energy_gradient_and_direction(") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_ncg_gradient_direction_and_norm_blocks(") !=
                std::string::npos &&
            ncg_source.find("current gradient/direction scalars device->host") !=
                std::string::npos &&
            ncg_source.find("double scalars[4]") != std::string::npos &&
            ncg_source.find("total_energy = energy_snapshot.total_energy_j") !=
                std::string::npos &&
            ncg_source.find("gradient_energy_norm_sq = scalars[1]") !=
                std::string::npos &&
            ncg_source.find("reset_descent_direction") != std::string::npos &&
            ncg_source.find("gpu_relax_prepare_descent_direction(") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_ncg_reset_direction_if_not_descent(") !=
                std::string::npos &&
            ncg_source.find("reset direction scalars device->host") ==
                std::string::npos,
        "native FEM GPU nonlinear-CG must batch current gradient and descent-direction scalars while reusing the exact accepted energy snapshot and keeping reset fallback device-side");
    check(
        ncg_source.find("kNcgScalarTailCount = 3") != std::string::npos &&
            ncg_source.find("kNcgPreviousGradientEnergyNormTailSlot") !=
                std::string::npos &&
            ncg_source.find("fullmag_cuda_relax_ncg_update_direction_from_reduced_pr_plus(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_finalize_step_stats_control_readback_with_scalar_tail(") !=
                std::string::npos &&
            ncg_source.find("accepted gradient/PR+ scalars device->host") ==
                std::string::npos &&
            ncg_source.find("accepted-step gradient validation failure") !=
                std::string::npos &&
            ncg_source.find("accepted-step PR+ denominator validation failure") !=
                std::string::npos &&
            ncg_source.find("accepted-step PR+ validation failure") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must fold accepted PR+ validation into the final control readback instead of adding a separate host sync");
    check(
        ncg_source.find("constexpr double kDefaultStepSize = 1.0e-6") !=
                std::string::npos &&
            ncg_source.find("constexpr double kMinStepSize = 1.0e-15") !=
                std::string::npos &&
            ncg_source.find("constexpr double kMaxStepSize = 1.0e-3") !=
                std::string::npos &&
            ncg_source.find("constexpr double kArmijoCoefficient = 1.0e-4") !=
                std::string::npos &&
            ncg_source.find("kGradientFloor") == std::string::npos &&
            ncg_source.find("reduction_roundoff_bound(") != std::string::npos &&
            ncg_source.find("kLineSearchEnergyNoiseFloorJ") == std::string::npos &&
            ncg_source.find("kLineSearchEnergyNoiseRelative") == std::string::npos &&
            ncg_source.find("constexpr uint32_t kMaxBacktracks = 30") !=
                std::string::npos &&
            ncg_source.find("constexpr uint64_t kRestartInterval = 50") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must use the shared scale-relative PR+ guard and keep explicit Armijo/restart constants");
    check(
        ncg_source.find("relaxation::initial_step_from_volume_norm_sq(") !=
                std::string::npos,
        "native FEM CUDA nonlinear-CG must use the shared initial-step clamp policy");
    check(
        relaxation_numerics.find("reduction_roundoff_bound(") != std::string::npos &&
            relaxation_numerics.find("positive_bb_curvature_resolved(") != std::string::npos &&
            relaxation_numerics.find("positive_signed_reduction_resolved(") !=
                std::string::npos &&
            relaxation_numerics.find("positive_nonnegative_reduction_resolved(") !=
                std::string::npos &&
            relaxation_numerics.find("strict_monotone_energy_accept(") !=
                std::string::npos &&
            relaxation_numerics.find("std::numeric_limits<double>::epsilon()") !=
                std::string::npos,
        "native FEM CPU and GPU direct minimizers must share scale-relative double-precision reduction guards");
    check(
        kernels_source.find(
            "relative_roundoff_bound * previous_gradient_energy_norm_sq") !=
                std::string::npos &&
            kernels_source.find("fabs(pr_plus_numerator)") == std::string::npos,
        "native FEM GPU nonlinear-CG must guard its nonnegative square-sum denominator independently of the signed PR numerator");
    check(
        ncg_source.find("gpu.mesh_metrics.lumped_mass == nullptr") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG requires a device FEM lumped-mass metric") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must require the device FEM lumped-mass metric");
    check(
        ncg_source.find("gpu.materials.ms == nullptr") != std::string::npos &&
            ncg_source.find("GPU nonlinear-CG requires a device nodal saturation-magnetisation field") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must require the nodal Ms field used by energy products");
    check(
        ncg_source.find("gpu.mesh_regions.magnetic_node_mask == nullptr") !=
                std::string::npos &&
            ncg_source.find("gpu.mesh_regions.node_count != gpu.lifecycle.node_count") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG requires a device magnetic-node mask matching the FEM state") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must require a device magnetic-node mask matching the FEM state");
    check(
        ncg_source.find("gpu.relaxation.node_count != gpu.lifecycle.node_count") !=
                std::string::npos &&
            ncg_source.find("GPU nonlinear-CG requires persistent device search-direction state") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG preflight must require persistent device search-direction state matching the FEM state");
    check(
        ncg_source.find("gpu_relax_retry_ncg_line_search_with_restart(") !=
                std::string::npos &&
            ncg_source.find("kArmijoRecoveryCycles") != std::string::npos &&
            ncg_source.find("gpu_direct_armijo_evaluate(") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_accept_monotone_recovery_step(") ==
                std::string::npos &&
            ncg_source.find("trial_step = restart_step;") !=
                std::string::npos &&
            ncg_source.find("gpu.relaxation.nonlinear_cg_direction_valid = false") <
                ncg_source.find("GPU nonlinear-CG failed Armijo line search"),
        "native FEM GPU nonlinear-CG must attempt bounded direct-increment Armijo recovery with restarted descent direction and a fresh restart step before failing the device step");
    check(
        ncg_source.find("const bool reuse_gradient_scalars =") !=
                std::string::npos &&
            ncg_source.find("p_dot_g = -gradient_energy_norm_sq;") !=
                std::string::npos &&
            ncg_source.find("direction_norm_sq = gradient_norm_sq;") !=
                std::string::npos &&
            ncg_source.find("if (!reuse_gradient_scalars &&") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG forced restart must reuse current gradient scalars instead of adding a host control readback");
    check(
        ncg_source.find("current_energy_j=") != std::string::npos &&
            ncg_source.find("last_trial_energy_j=") != std::string::npos &&
            ncg_source.find("armijo_rhs_j=") != std::string::npos &&
            ncg_source.find("last_trial_step=") != std::string::npos &&
            ncg_source.find("direction_dot_gradient=") != std::string::npos &&
            ncg_source.find("gradient_norm_sq=") != std::string::npos,
        "native FEM GPU nonlinear-CG exhausted Armijo failures must include actionable line-search diagnostics");
    check(
        ncg_source.find("format_gpu_relax_ncg_scalar(") != std::string::npos &&
            ncg_source.find("std::scientific") != std::string::npos &&
            ncg_source.find("std::setprecision(17)") != std::string::npos &&
            ncg_source.find("trial_energy_increment_j=") != std::string::npos &&
            ncg_source.find("current_torque_apm=") != std::string::npos &&
            ncg_source.find("torque_tolerance_apm=") != std::string::npos,
        "native FEM GPU nonlinear-CG exhausted Armijo diagnostics must preserve scientific values and the configured convergence criterion");
    check(
        ncg_source.find("GPU nonlinear-CG produced non-finite total energy") !=
                std::string::npos &&
            ncg_source.find("!std::isfinite(total_energy)") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must report non-finite energy failures explicitly");
    check(
        ncg_source.find("GPU nonlinear-CG produced a non-finite or negative tangent-gradient norm") !=
                std::string::npos &&
            ncg_source.find("!std::isfinite(gradient_norm_sq)") !=
                std::string::npos &&
            ncg_source.find("gradient_norm_sq < 0.0") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must reject invalid tangent-gradient reductions before Armijo");
    check(
        ncg_source.find("GPU nonlinear-CG produced a non-finite or non-descent direction") !=
                std::string::npos &&
            ncg_source.find("!std::isfinite(p_dot_g)") !=
                std::string::npos &&
            ncg_source.find("p_dot_g >= 0.0") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must reject invalid or non-descent search directions before line search");
    check(
        ncg_source.find("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") !=
                std::string::npos &&
            ncg_source.find("update_stage_completion_from_stats(ctx, out_stats)") !=
                std::string::npos &&
            ncg_source.rfind("gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)") <
                ncg_source.find("update_stage_completion_from_stats(ctx, out_stats)"),
        "native FEM GPU nonlinear-CG accepted steps must update runtime stage completion from finalized native stats");
    check(
        ncg_source.find("#include \"cpu/mfem/runtime/stage_completion.hpp\"") !=
                std::string::npos &&
            ncg_source.find("FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT") !=
                std::string::npos &&
            ncg_source.find("\"tangent_gradient_norm_sq\"") !=
                std::string::npos &&
            ncg_source.find("set_stage_completion(") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must publish gradient-converged stop state through the runtime stage-completion owner");
    const auto ncg_degenerate_gradient =
        ncg_source.rfind("if (gradient_norm_sq == 0.0)");
    const auto ncg_degenerate_finalize =
        ncg_degenerate_gradient == std::string::npos
            ? std::string::npos
            : ncg_source.find(
                  "gpu_rk_finalize_step_stats_control_readback(ctx, out_stats, reason)",
                  ncg_degenerate_gradient);
    check(
        ncg_source.find("void mark_gpu_relax_ncg_device_source_of_truth(") !=
                std::string::npos &&
            ncg_degenerate_gradient != std::string::npos &&
            ncg_degenerate_finalize != std::string::npos &&
            ncg_source.find(
                "mark_gpu_relax_ncg_device_source_of_truth(ctx)",
                ncg_degenerate_gradient) < ncg_degenerate_finalize,
        "native FEM GPU nonlinear-CG must publish device source-of-truth before zero-gradient stats/stage completion");
    check(
        ncg_source.find("gpu_relax_restore_previous_state_after_failure(") !=
                std::string::npos &&
            ncg_source.find("gpu_rk_restore_step_transaction_device(") !=
                std::string::npos &&
            ncg_source.find("gpu_relax_restore_previous_direction(") !=
                std::string::npos &&
            ncg_source.find("previous device state restored") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must rollback both magnetization and persistent direction state on failed line-search/finalization paths");
    check(
        kernels_header.find("fullmag_cuda_relax_ncg_prepare_direction_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_gradient_direction_and_norm_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_pr_plus_numerator_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_update_direction_blocks(") !=
                std::string::npos &&
            kernels_header.find("fullmag_cuda_relax_ncg_reset_direction_if_not_descent(") !=
                std::string::npos &&
            kernels_source.find("ncg_prepare_direction_kernel") !=
                std::string::npos &&
            kernels_source.find("ncg_gradient_direction_and_norm_kernel") !=
                std::string::npos &&
            kernels_source.find("block_reduce_triple_sum(") !=
                std::string::npos &&
            kernels_source.find("block_gradient_norm_sq[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_gradient_energy_norm_sq[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_previous_energy_norm_sq[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_p_dot_g[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("block_direction_norm_sq[blockIdx.x]") !=
                std::string::npos &&
            kernels_source.find("ncg_pr_plus_numerator_kernel") !=
                std::string::npos &&
            kernels_source.find("ncg_update_direction_kernel") !=
                std::string::npos &&
            kernels_source.find("ncg_reset_direction_if_not_descent_kernel") !=
                std::string::npos &&
            kernels_source.find("kMu0 * ms[i] * node_weight(lumped_mass, i)") !=
                std::string::npos,
        "native FEM GPU nonlinear-CG must expose separate volume stop norms and nodal-Ms energy products for descent, PR+, and next-direction update");
    check(
        relaxation_state.find("GPU CUDA relaxation device-state module header") !=
                std::string::npos &&
            relaxation_state.find("struct FemGpuRelaxationDeviceState") !=
                std::string::npos &&
            relaxation_state.find("FemGpuComponentField nonlinear_cg_direction") !=
                std::string::npos &&
            relaxation_state.find("FemGpuComponentField nonlinear_cg_direction_backup") !=
                std::string::npos &&
            relaxation_state.find("bool nonlinear_cg_direction_valid = false") !=
                std::string::npos &&
            relaxation_state.find("host-side std::vector state") !=
                std::string::npos,
        "native FEM GPU nonlinear CG must reserve persistent device-state storage instead of relying on host vectors");
    check(
        relaxation_memory_header.find("gpu_relaxation_state_allocate(") !=
                std::string::npos &&
            relaxation_memory_header.find("gpu_relaxation_state_free(") !=
                std::string::npos &&
            relaxation_memory_source.find("gpu_device_allocate_component(") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "relaxation.nonlinear_cg_direction") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "relaxation.nonlinear_cg_direction_backup") !=
                std::string::npos &&
            relaxation_memory_source.find("gpu_device_free_component(") !=
                std::string::npos,
        "native FEM GPU relaxation memory must allocate and free nonlinear-CG direction and rollback storage on the device");
    check(
        relaxation_memory_source.find("relaxation.node_count = node_count") !=
                std::string::npos &&
            relaxation_memory_source.find(
                "relaxation.nonlinear_cg_direction_valid = false") !=
                std::string::npos &&
            relaxation_memory_source.find("gpu_relaxation_state_free(relaxation)") !=
                std::string::npos &&
            relaxation_memory_source.rfind(
                "relaxation.nonlinear_cg_direction_valid = false") >
                relaxation_memory_source.find("void gpu_relaxation_state_free"),
        "native FEM GPU relaxation memory must invalidate persistent NCG direction state on allocation failure and free");
    check(
        gpu_state_header.find("#include \"gpu/cuda/relaxation/relaxation_state.hpp\"") !=
                std::string::npos &&
            gpu_state_header.find("FemGpuRelaxationDeviceState relaxation{}") !=
                std::string::npos,
        "FemGpuState must own persistent native GPU relaxation state");
    check(
        gpu_state_source.find("#include \"gpu/cuda/relaxation/relaxation_memory.hpp\"") !=
                std::string::npos &&
            gpu_state_source.find("gpu_relaxation_state_allocate(") !=
                std::string::npos &&
            gpu_state_source.find("gpu_relaxation_state_free(state.relaxation)") !=
                std::string::npos &&
            gpu_state_source.find("state.relaxation.node_count = 0") !=
                std::string::npos &&
            gpu_state_source.find(
                "state.relaxation.nonlinear_cg_direction_valid = false") !=
                std::string::npos,
        "FemGpuState lifecycle must allocate, free, and invalidate persistent native GPU relaxation state");
}

void fem_relaxation_benchmark_recipes_prepare_required_binaries() {
    const std::string justfile = read_text_file(repo_root() / "justfile");
    const std::string benchmark_script =
        read_text_file(repo_root() / "scripts" / "analysis" / "fem_gpu_benchmark.py");
    const std::string fem_sys_build =
        read_text_file(repo_root() / "crates" / "fullmag-fem-sys" / "build.rs");
    const auto recipe_start =
        justfile.find("verify-fem-relaxation-cpu-gpu-consistency-smoke:");
    const auto recipe_end =
        recipe_start == std::string::npos
            ? std::string::npos
            : justfile.find("\nresource-first-gates ", recipe_start);
    const std::string recipe =
        recipe_start == std::string::npos
            ? std::string()
            : justfile.substr(
                  recipe_start,
                  recipe_end == std::string::npos
                      ? std::string::npos
                      : recipe_end - recipe_start);
    const auto managed_runtime = recipe.find("just ensure-managed-fem-runtime");
    const auto benchmark =
        recipe.find("python3 scripts/analysis/fem_gpu_benchmark.py");

    check(
        !recipe.empty(),
        "justfile must define verify-fem-relaxation-cpu-gpu-consistency-smoke");
    check(
        recipe.find("just build fullmag") == std::string::npos,
        "FEM relaxation CPU/GPU consistency smoke must not require a separate host-built CPU CLI");
    check(
        managed_runtime != std::string::npos && benchmark != std::string::npos &&
            managed_runtime < benchmark,
        "FEM relaxation CPU/GPU consistency smoke must prepare the managed FEM runtime before running the benchmark harness");
    check(
        benchmark_script.find("FULLMAG_BENCH_CPU_BIN") != std::string::npos &&
            benchmark_script.find("str(FULLMAG_GPU)") != std::string::npos &&
            benchmark_script.find(
                "FULLMAG_CPU = REPO_ROOT / \".fullmag\" / \"local\" / \"bin\" / \"fullmag\"") ==
                std::string::npos,
        "FEM CPU/GPU benchmark harness must default FEM CPU runs to the managed FEM runtime bundle, not a host-built local CLI");
    check(
        benchmark_script.find("REPO_ROOT / \"native\" / \"backends\" / \"fem\"") ==
                std::string::npos &&
            benchmark_script.find("REPO_ROOT / \"backends\" / \"fem\"") !=
                std::string::npos,
        "FEM CPU/GPU benchmark preflight must inspect the current backends/fem tree, not the retired native/backends/fem path");
    check(
        fem_sys_build.find("cargo:rerun-if-changed=../../backends/fem/gpu") !=
            std::string::npos,
        "fullmag-fem-sys build script must rerun native CMake when backends/fem/gpu changes");
}

void pgbb_accepted_armijo_proof_crosses_native_abi_only_after_acceptance() {
    const std::filesystem::path root = fem_source_root();
    const std::string abi = read_text_file(
        repo_root() / "native" / "include" / "fullmag_fem.h");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string cpu_pgbb = read_text_file(
        root / "cpu" / "mfem" / "relaxation" / "projected_gradient_bb.cpp");
    const std::string gpu_pgbb = read_text_file(
        root / "gpu" / "cuda" / "relaxation" / "pgbb.cpp");
    const std::string cpu_ncg = read_text_file(
        root / "cpu" / "mfem" / "relaxation" / "nonlinear_cg.cpp");
    const std::string gpu_ncg = read_text_file(
        root / "gpu" / "cuda" / "relaxation" / "nonlinear_cg.cpp");

    for (const std::string field : {
             "accepted_energy_proof_available",
             "accepted_energy_delta_j",
             "accepted_energy_roundoff_bound_j",
             "accepted_energy_delta_upper_j",
             "armijo_increment_rhs_j"}) {
        check(
            abi.find(field) != std::string::npos &&
                api.find(field) != std::string::npos,
            "PG-BB accepted Armijo proof fields must cross the versioned native query ABI");
    }
    check(
        abi.find("FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION 1u") !=
                std::string::npos &&
            abi.find("fullmag_fem_backend_take_accepted_energy_proof_v1") !=
                std::string::npos &&
            api.find("out_proof->struct_size != sizeof(fullmag_fem_accepted_energy_proof_v1)") !=
                std::string::npos &&
            api.find("handle->context.relaxation.accepted_energy_proof = {};") !=
                std::string::npos &&
            cpu_pgbb.find("accepted_energy_proof.available = true") !=
                std::string::npos &&
            gpu_pgbb.find("accepted_energy_proof.available = true") !=
                std::string::npos &&
            cpu_pgbb.find(
                "accepted_energy_delta_upper_j <= armijo_increment_rhs_j") !=
                std::string::npos &&
            gpu_pgbb.find(
                "accepted_energy_delta_upper_j <= armijo_increment_rhs_j") !=
                std::string::npos,
        "CPU/GPU PG-BB must validate and publish the exact accepted Armijo proof");
    check(
        cpu_ncg.find("accepted_energy_proof.available = true") ==
                std::string::npos &&
            gpu_ncg.find("accepted_energy_proof.available = true") ==
                std::string::npos,
        "NCG must remain explicitly unavailable until every acceptance path owns a direct proof");
}

} // namespace

int main() {
    native_relaxation_algorithms_live_under_mfem_relaxation();
    cuda_term_complete_energy_difference_migration_is_atomic();
    cpu_pgbb_exchange_difference_owner_is_focused_and_term_complete();
    c_abi_exposes_native_relaxation_step();
    runner_does_not_claim_production_fem_minimizer_ownership();
    gpu_relaxation_pgbb_building_blocks_live_under_native_cuda();
    gpu_relaxation_ncg_direction_state_is_device_persistent();
    pgbb_accepted_armijo_proof_crosses_native_abi_only_after_acceptance();
    fem_relaxation_benchmark_recipes_prepare_required_binaries();
    return 0;
}
