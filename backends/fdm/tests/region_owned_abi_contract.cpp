/*
 * region_owned_abi_contract.cpp - native FDM region-owned ABI guard.
 *
 * This test is source-level by design: it must run even on hosts without CUDA.
 * It guards against accidentally accepting authored/runtime material fields
 * before the FDM kernels actually consume them.
 */

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path repo_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path().parent_path().parent_path();
    }
    return std::filesystem::current_path() /
        this_file.parent_path().parent_path().parent_path().parent_path();
}

void region_owned_material_fields_are_public_abi() {
    const std::string header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fdm.h");

    check(header.find("const double              *ms_field") != std::string::npos,
          "fullmag_fdm_plan_desc must include ms_field");
    check(header.find("uint64_t                   ms_field_len") != std::string::npos,
          "fullmag_fdm_plan_desc must include ms_field_len");
    check(header.find("const double              *a_field") != std::string::npos,
          "fullmag_fdm_plan_desc must include a_field");
    check(header.find("const double              *alpha_field") != std::string::npos,
          "fullmag_fdm_plan_desc must include alpha_field");
    check(header.find("const double              *dind_field") != std::string::npos,
          "fullmag_fdm_plan_desc must include dind_field");
    check(header.find("const double              *dbulk_field") != std::string::npos,
          "fullmag_fdm_plan_desc must include dbulk_field");
}

void complete_plan_descriptor_is_versioned_and_checked() {
    const std::string header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fdm.h");
    const std::string source =
        read_text_file(repo_root() / "backends" / "fdm" / "api" / "c_api.cpp") +
        read_text_file(repo_root() / "backends" / "fdm" / "api" / "plan_ingestion_v2.cpp");

    check(header.find("FULLMAG_FDM_PLAN_DESC_ABI_V2") != std::string::npos,
          "complete FDM descriptor must publish its ABI version");
    check(header.find("fullmag_fdm_backend_create_time_policy_v2_checked") != std::string::npos,
          "complete FDM descriptor must use a typed checked constructor");
    check(source.find("header.struct_size != sizeof(fullmag_fdm_plan_desc_v2)") !=
              std::string::npos,
          "checked constructor must reject truncated and oversized descriptors");
    check(source.find("return FULLMAG_FDM_ERR_ABI") != std::string::npos,
          "checked constructor must return the typed ABI error");
}

void exchange_pair_descriptors_are_public_abi() {
    const std::string header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fdm.h");

    check(header.find("FULLMAG_FDM_EXCHANGE_PAIR_UNSPECIFIED   = 0") != std::string::npos,
          "exchange pair default must preserve zero-initialized legacy compatibility");
    check(header.find("FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN = 1") != std::string::npos,
          "exchange pair ABI must expose harmonic mean");
    check(header.find("typedef struct {\n    uint32_t region_i;") != std::string::npos,
          "exchange pair descriptor struct must be public ABI");
    check(header.find("const fullmag_fdm_exchange_pair_desc *exchange_pairs") != std::string::npos,
          "fullmag_fdm_plan_desc must carry exchange pair descriptors");
    check(header.find("uint64_t                   exchange_pair_count") != std::string::npos,
          "fullmag_fdm_plan_desc must carry exchange_pair_count");
}

void region_ids_are_unbounded_and_lut_is_retired() {
    const std::string header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fdm.h");
    const std::string source = read_text_file(repo_root() / "backends" / "fdm" / "api" / "c_api.cpp");

    check(header.find("FULLMAG_FDM_MAX_REGION_ID") == std::string::npos &&
              header.find("FULLMAG_FDM_MAX_EXCHANGE_REGIONS") == std::string::npos,
          "FDM ABI must not publish a region-id limit");
    check(header.find("FULLMAG_FDM_EXCHANGE_OPERATOR_FACES") != std::string::npos &&
              header.find("const double *exchange_face_x_plus;") != std::string::npos,
          "FDM ABI must carry per-connection exchange coefficients in the v2 tail");
    check(source.find("fdm_exchange_lut_retired") != std::string::npos,
          "native FDM must reject the retired region-pair table instead of ignoring it");
    check(source.find("fdm_exchange_pair_unspecified_retired") != std::string::npos,
          "legacy UNSPECIFIED with a region mask must not silently re-couple regions");
    check(source.find("plan->enable_exchange != 0 && ctx->has_region_mask && !exchange_operator.faces") !=
              std::string::npos,
          "the legacy UNSPECIFIED gate must apply only while exchange runs");
    check(source.find("fdm_region_lut_capacity_exceeded") == std::string::npos,
          "native FDM must not cap region ids");
}

void native_backend_validates_cellwise_ms_and_alpha() {
    const std::string source = read_text_file(repo_root() / "backends" / "fdm" / "api" / "c_api.cpp");

    check(source.find("has_cellwise_dmi_field") != std::string::npos &&
              source.find("plan->dbulk_field_len != 0") != std::string::npos,
          "native FDM backend must keep rejecting cellwise DMI fields");
    check(source.find("{\"ms_field\", plan->ms_field, plan->ms_field_len, true}") != std::string::npos,
          "native FDM backend must validate ms_field length and positivity on active cells");
    check(source.find("{\"alpha_field\", plan->alpha_field, plan->alpha_field_len, false}") !=
              std::string::npos,
          "native FDM backend must validate alpha_field length and range");
    check(source.find("fdm_cuda_heterogeneous_material_unsupported:") != std::string::npos,
          "native FDM backend must fail closed for unsupported heterogeneous combinations");
    check(source.find("fdm_cuda_heterogeneous_material_unsupported:gpu_transport") !=
              std::string::npos,
          "a GPU transport binding attached after create must hit the material gate");
    check(source.find("a_field_requires_exchange_faces") != std::string::npos &&
              source.find("cellwise_values_equal_scalar(") != std::string::npos,
          "native FDM backend must reject a variable a_field that arrives without FACES");
}

void reviewed_gpu_abi_proof_is_semantic_and_strict() {
    const auto root = repo_root();
    const std::string sentinel =
        read_text_file(root / "backends" / "fdm" / "tests" / "plan_desc_sentinel_contract.cpp");
    const std::string construction = read_text_file(
        root / "crates" / "fullmag-runner" / "src" / "fdm" / "gpu" / "cuda" / "native" /
        "construction.rs");
    const std::string runner = read_text_file(
        root / "crates" / "fullmag-runner" / "src" / "fdm" / "gpu" / "cuda" / "native.rs");
    const std::string justfile = read_text_file(root / "justfile");

    check(sentinel.find("fullmag_fdm_plan_ingestion_v2_create_checked") != std::string::npos,
          "sentinel must exercise the canonical owner-side ingestion constructor");
    check(sentinel.find("std::memcmp(&plan, &receipt") == std::string::npos,
          "sentinel must compare semantic fields, not padding bytes");
    check(construction.find("fullmag_fdm_backend_create_time_policy_v2_checked") ==
              std::string::npos,
          "dead construction duplicate must not carry the canonical v2 ingestion path");
    check(runner.find("match create_status") != std::string::npos,
          "active runner must map every typed create status explicitly");
    check(justfile.find("--no-tests=error") != std::string::npos,
          "managed CTest invocation must fail when no ABI sentinel test is discovered");
}

} // namespace

int main() {
    region_owned_material_fields_are_public_abi();
    complete_plan_descriptor_is_versioned_and_checked();
    exchange_pair_descriptors_are_public_abi();
    region_ids_are_unbounded_and_lut_is_retired();
    native_backend_validates_cellwise_ms_and_alpha();
    reviewed_gpu_abi_proof_is_semantic_and_strict();
    std::printf("region-owned FDM ABI contract OK\n");
    return 0;
}
