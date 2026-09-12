/*
 * cuda_demag_field_only_contract.cpp - source contract for typed GPU demag
 * evaluation and pattern-safe XYZ recovery.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path)
{
    std::ifstream input(path);
    if (!input) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
}

std::filesystem::path fem_source_root()
{
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

} // namespace

int main()
{
    const std::filesystem::path root = fem_source_root();
    const std::string stage_header = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.hpp");
    const std::string stage_source = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
    const std::string kernels_header = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "demag_kernels.hpp");
    const std::string kernels_source = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "demag_kernels.cu");
    const std::string operators_header = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "operators.hpp");
    const std::string operators_source = read_text_file(
        root / "gpu" / "cuda" / "demag_poisson" / "operators.cpp");
    const std::string rk_dispatch = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_demag_dispatch.cu");
    const std::string api_source = read_text_file(root / "src" / "api.cpp");

    check(
            stage_header.find("enum class GpuDemagEvaluationMode") != std::string::npos &&
            stage_header.find("FieldOnly") != std::string::npos &&
            stage_header.find("FieldAndRecoveredEnergy") != std::string::npos &&
            stage_header.find("enum class GpuDemagSolvePurpose") != std::string::npos &&
            stage_header.find("struct GpuDemagApplyRequest") != std::string::npos,
        "GPU demag stage API must expose a typed mode and purpose request");
    check(
        stage_source.find("validate_gpu_demag_evaluation_request(") != std::string::npos &&
            stage_source.find("unsupported GPU demag evaluation mode") != std::string::npos &&
            stage_source.find("unsupported GPU demag evaluation purpose") != std::string::npos,
        "GPU demag requests must fail closed on unknown mode or purpose values");

    const std::size_t energy_gate = stage_source.find(
        "if (request.evaluation_mode == GpuDemagEvaluationMode::FieldAndRecoveredEnergy)");
    const std::size_t energy_launch = stage_source.find(
        "fullmag_cuda_demag_energy_blocks(", energy_gate);
    const std::size_t field_only_branch = stage_source.find(
        "} else if (gpu.reductions.scalar_result != nullptr)", energy_gate);
    check(
        energy_gate != std::string::npos &&
            energy_launch != std::string::npos &&
            field_only_branch != std::string::npos &&
            energy_gate < energy_launch && energy_launch < field_only_branch,
        "FieldOnly demag evaluation must skip the stage energy kernel and reduction");
    check(
        stage_source.find("GpuFinalScalarSlot::DemagEnergy") != std::string::npos &&
            stage_source.find("clear GPU demag FieldOnly energy publication slot") !=
                std::string::npos,
        "FieldOnly demag evaluation must clear the stale final energy publication slot");
    check(
        stage_source.find("demag_stage_energy_evaluations = 1") != std::string::npos &&
            stage_source.find("gpu_performance_note(") != std::string::npos,
        "demag stage energy telemetry must be emitted only from the energy branch");
    check(
        stage_source.find(
            "request.evaluation_mode == GpuDemagEvaluationMode::FieldAndRecoveredEnergy &&") !=
            std::string::npos,
        "Ms and node-volume requirements must be scoped to FieldAndRecoveredEnergy");

    check(
            rk_dispatch.find("kRkStageDemagRequest") != std::string::npos &&
            rk_dispatch.find("GpuDemagEvaluationMode::FieldOnly") != std::string::npos &&
            rk_dispatch.find("GpuDemagSolvePurpose::IntermediateRkStage") != std::string::npos &&
            rk_dispatch.find("compute_device_demag_for_device_stage_fresh(") !=
                std::string::npos,
        "RK demag dispatch must select typed FieldOnly/RkStage requests");
    check(
        api_source.find("GpuDemagSolvePurpose::FrequencyTangent") !=
            std::string::npos,
        "frequency-domain demag tangent must request FieldOnly semantics explicitly");

    check(
        kernels_header.find("fullmag_cuda_demag_recovery_xyz_csr(") != std::string::npos &&
            kernels_source.find("demag_recovery_xyz_csr_kernel") != std::string::npos &&
            kernels_source.find("value_x += csr_values_x[cursor] * potential") !=
                std::string::npos &&
            kernels_source.find("value_y += csr_values_y[cursor] * potential") !=
                std::string::npos &&
            kernels_source.find("value_z += csr_values_z[cursor] * potential") !=
                std::string::npos,
        "fused XYZ recovery must share the CSR pattern while retaining three value arrays");
    check(
        operators_header.find("enum class GpuDemagRecoveryMode") != std::string::npos &&
            operators_header.find("recovery_xyz_pattern_digest") != std::string::npos &&
            operators_header.find("recovery_mode") != std::string::npos &&
            operators_header.find("visual_recovery_xyz_pattern_digest") != std::string::npos,
        "demag workspace must retain recovery pattern telemetry");
    check(
        operators_source.find("csr_pattern_equal(") != std::string::npos &&
            operators_source.find("shared_xyz_csr_pattern(") != std::string::npos &&
            operators_source.find("workspace.recovery_mode =") !=
                std::string::npos &&
            operators_source.find("workspace.visual_recovery_mode =") !=
                std::string::npos,
        "recovery fusion must require full row-offset and column-index pattern equality");
    check(
        stage_source.find("if (workspace->recovery_mode == GpuDemagRecoveryMode::SharedPatternFusedXyz)") !=
                std::string::npos &&
            stage_source.find("fullmag_cuda_demag_recovery_xyz_csr(") !=
                std::string::npos &&
            stage_source.find("Keep the three-launch path for a pattern mismatch") !=
                std::string::npos,
        "demag recovery must retain a split fallback for incompatible CSR patterns");
    check(
        stage_source.find("if (workspace->visual_recovery_mode == GpuDemagRecoveryMode::SharedPatternFusedXyz)") !=
                std::string::npos,
        "full-domain visual recovery must use its own pattern qualification");

    return 0;
}
