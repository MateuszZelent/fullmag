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
        read_text_file(repo_root() / "backends" / "fdm" / "api" / "c_api.cpp");

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

void region_lut_capacity_is_explicit_and_fail_closed() {
    const std::string header =
        read_text_file(repo_root() / "native" / "include" / "fullmag_fdm.h");
    const std::string source = read_text_file(repo_root() / "backends" / "fdm" / "api" / "c_api.cpp");

    check(header.find("FULLMAG_FDM_MAX_REGION_ID") != std::string::npos,
          "FDM ABI must expose the non-background region-id limit");
    check(source.find("fdm_region_lut_capacity_exceeded") != std::string::npos,
          "native FDM must reject region ids before LUT access");
    check(source.find("plan->region_mask[index] > FULLMAG_FDM_MAX_REGION_ID") != std::string::npos,
          "native FDM must validate every uploaded region-mask value");
}

void native_backend_fails_fast_for_unimplemented_cellwise_material_fields() {
    const std::string source = read_text_file(repo_root() / "backends" / "fdm" / "api" / "c_api.cpp");

    check(source.find("has_cellwise_material_field") != std::string::npos,
          "native FDM backend must detect cellwise material fields explicitly");
    check(source.find("planner/runtime materialization must keep this path capability-gated") != std::string::npos,
          "native FDM backend must fail fast instead of silently dropping cellwise material fields");
    check(source.find("plan->ms_field_len != 0") != std::string::npos,
          "native FDM backend must reject non-zero ms_field_len even when pointer is null");
    check(source.find("plan->dbulk_field_len != 0") != std::string::npos,
          "native FDM backend must reject non-zero dbulk_field_len even when pointer is null");
}

} // namespace

int main() {
    region_owned_material_fields_are_public_abi();
    complete_plan_descriptor_is_versioned_and_checked();
    exchange_pair_descriptors_are_public_abi();
    region_lut_capacity_is_explicit_and_fail_closed();
    native_backend_fails_fast_for_unimplemented_cellwise_material_fields();
    std::printf("region-owned FDM ABI contract OK\n");
    return 0;
}
