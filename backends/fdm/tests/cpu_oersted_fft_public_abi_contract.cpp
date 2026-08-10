#include "fullmag_fdm.h"

#include <fullmag/fdm/cpu/oersted_fft_open_v1.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace oe = fullmag::fdm::cpu::oersted::v1;

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

bool same_double_bits(double lhs, double rhs) {
    return std::memcmp(&lhs, &rhs, sizeof(lhs)) == 0;
}

bool same_double_vector_bits(const std::vector<double> &lhs,
                             const std::vector<double> &rhs) {
    return lhs.size() == rhs.size() &&
           std::equal(lhs.begin(), lhs.end(), rhs.begin(), same_double_bits);
}

void test_bit_exact_comparison_distinguishes_signed_zero() {
    const double positive_zero = 0.0;
    const double negative_zero = -0.0;
    check(positive_zero == negative_zero,
          "signed-zero regression requires numerically equal values");
    check(!same_double_bits(positive_zero, negative_zero),
          "bit-exact comparison must distinguish +0.0 from -0.0");
    check(!same_double_vector_bits({positive_zero}, {negative_zero}),
          "bit-exact vector comparison must distinguish +0.0 from -0.0");
}

struct Fixture {
    oe::Problem problem;
    std::vector<double> field;
    std::vector<std::uint64_t> source_face_ids;
    std::vector<std::int8_t> source_normals;
    fullmag_fdm_cpu_oersted_source_cut_v1 source_cut{};
    fullmag_fdm_cpu_oersted_certificate_v1 certificate{};
    fullmag_fdm_cpu_oersted_request_v1 request{};
    fullmag_fdm_cpu_oersted_result_v1 result{};

    Fixture() {
        problem.grid = {3U,
                        3U,
                        3U,
                        2.0e-9,
                        3.0e-9,
                        4.0e-9,
                        {1.0e-9, -2.0e-9, 3.0e-9},
                        {oe::AxisBoundary::open,
                         oe::AxisBoundary::open,
                         oe::AxisBoundary::open}};
        const std::size_t cells = 27U;
        problem.conductor_mask.assign(cells, 1U);
        problem.target_mask.assign(cells, 1U);
        problem.face_current_density_a_per_m2.x.assign(36U, 0.0);
        problem.face_current_density_a_per_m2.y.assign(36U, 0.0);
        problem.face_current_density_a_per_m2.z.assign(36U, 0.0);
        constexpr double current_a = 1.0e-3;
        const double jx = current_a / (problem.grid.dy_m * problem.grid.dz_m);
        const double jy = current_a / (problem.grid.dx_m * problem.grid.dz_m);
        problem.face_current_density_a_per_m2.x[13U] = jx;
        problem.face_current_density_a_per_m2.y[16U] = jy;
        problem.face_current_density_a_per_m2.x[17U] = -jx;
        problem.face_current_density_a_per_m2.y[15U] = -jy;
        problem.geometry_revision = 11U;
        problem.conductor_mask_revision = 12U;
        problem.target_mask_revision = 13U;
        problem.face_current_revision = 14U;
        problem.envelope_revision = 15U;
        problem.stage_identity = 16U;
        problem.source_identity = "charge-module-1";
        problem.envelope_digest = "sha256:fixture-envelope";
        problem.evaluation_time_s = 2.5e-12;
        problem.evaluated_envelope_multiplier = 0.75;
        problem.geometry_digest = oe::canonical_geometry_digest(problem.grid);
        problem.conductor_mask_digest =
            oe::canonical_mask_digest(problem.conductor_mask);
        problem.target_mask_digest = oe::canonical_mask_digest(problem.target_mask);
        problem.face_current_digest =
            oe::canonical_face_current_digest(problem.face_current_density_a_per_m2);

        auto &closure = problem.closure_certificate;
        closure.version = std::string(oe::certificate_version);
        closure.closure_kind = oe::ClosureKind::closed_geometry;
        closure.revision = problem.face_current_revision;
        closure.geometry_digest = problem.geometry_digest;
        closure.conductor_mask_revision = problem.conductor_mask_revision;
        closure.conductor_mask_digest = problem.conductor_mask_digest;
        closure.face_current_revision = problem.face_current_revision;
        closure.face_current_digest = problem.face_current_digest;
        closure.component_labels.assign(cells, 0U);
        closure.component_count = 1U;
        closure.global_continuity_passed = true;
        closure.exterior_flux_passed = true;
        closure.component_flux_passed = true;
        closure.return_path_complete = true;
        closure.divergence_tolerance_a_per_m3 = 1.0e10;
        closure.exterior_current_tolerance_a = 0.0;
        double measured_divergence = 0.0;
        for (std::size_t z = 0; z < problem.grid.nz; ++z) {
            for (std::size_t y = 0; y < problem.grid.ny; ++y) {
                for (std::size_t x = 0; x < problem.grid.nx; ++x) {
                    const std::size_t x_low =
                        (z * problem.grid.ny + y) * (problem.grid.nx + 1U) + x;
                    const std::size_t y_low =
                        (z * (problem.grid.ny + 1U) + y) * problem.grid.nx + x;
                    const std::size_t z_low =
                        (z * problem.grid.ny + y) * problem.grid.nx + x;
                    const double divergence =
                        (problem.face_current_density_a_per_m2.x[x_low + 1U] -
                         problem.face_current_density_a_per_m2.x[x_low]) /
                            problem.grid.dx_m +
                        (problem.face_current_density_a_per_m2.y
                             [y_low + problem.grid.nx] -
                         problem.face_current_density_a_per_m2.y[y_low]) /
                            problem.grid.dy_m +
                        (problem.face_current_density_a_per_m2.z
                             [z_low + problem.grid.nx * problem.grid.ny] -
                         problem.face_current_density_a_per_m2.z[z_low]) /
                            problem.grid.dz_m;
                    measured_divergence =
                        std::max(measured_divergence, std::abs(divergence));
                }
            }
        }
        closure.measured_max_abs_divergence_a_per_m3 = measured_divergence;
        closure.measured_component_exterior_current_a = {0.0};
        oe::SourceCutRecord cut;
        cut.stable_id = "source-cut-1";
        cut.component_label = 0U;
        cut.ordered_internal_face_ids = {13U, 13U};
        cut.ordered_normals = {1, -1};
        cut.drive_id = "drive-1";
        cut.drive_kind = "impressed_potential_jump.v1";
        cut.drive_value = 1.0;
        cut.drive_si_unit = "V";
        cut.revision = problem.face_current_revision;
        cut.digest = oe::canonical_source_cut_digest(cut);
        closure.source_cuts = {cut};
        closure.digest = oe::canonical_certificate_digest(closure);
        problem.trusted_snapshot_revision = problem.face_current_revision;
        problem.trusted_snapshot_digest =
            oe::canonical_trusted_snapshot_digest(problem);

        certificate.abi_version = FULLMAG_FDM_CPU_OERSTED_ABI_V1;
        certificate.struct_size = sizeof(certificate);
        certificate.closure_kind =
            FULLMAG_FDM_CPU_OERSTED_CLOSURE_CLOSED_GEOMETRY;
        certificate.global_continuity_passed = 1U;
        certificate.exterior_flux_passed = 1U;
        certificate.component_flux_passed = 1U;
        certificate.return_path_complete = 1U;
        certificate.revision = closure.revision;
        certificate.version = closure.version.c_str();
        certificate.digest = closure.digest.c_str();
        certificate.geometry_digest = closure.geometry_digest.c_str();
        certificate.conductor_mask_revision = closure.conductor_mask_revision;
        certificate.conductor_mask_digest = closure.conductor_mask_digest.c_str();
        certificate.face_current_revision = closure.face_current_revision;
        certificate.face_current_digest = closure.face_current_digest.c_str();
        certificate.component_labels = {closure.component_labels.data(), cells};
        certificate.component_count = closure.component_count;
        certificate.divergence_tolerance_a_per_m3 =
            closure.divergence_tolerance_a_per_m3;
        certificate.exterior_current_tolerance_a =
            closure.exterior_current_tolerance_a;
        certificate.measured_max_abs_divergence_a_per_m3 =
            closure.measured_max_abs_divergence_a_per_m3;
        certificate.measured_component_exterior_current_a = {
            closure.measured_component_exterior_current_a.data(), 1U};
        source_face_ids = closure.source_cuts[0].ordered_internal_face_ids;
        source_normals = closure.source_cuts[0].ordered_normals;
        source_cut.stable_id = closure.source_cuts[0].stable_id.c_str();
        source_cut.component_label = closure.source_cuts[0].component_label;
        source_cut.ordered_internal_face_ids = {
            source_face_ids.data(), source_face_ids.size()};
        source_cut.ordered_normals = {source_normals.data(), source_normals.size()};
        source_cut.drive_id = closure.source_cuts[0].drive_id.c_str();
        source_cut.drive_kind = closure.source_cuts[0].drive_kind.c_str();
        source_cut.drive_value = closure.source_cuts[0].drive_value;
        source_cut.drive_si_unit = closure.source_cuts[0].drive_si_unit.c_str();
        source_cut.revision = closure.source_cuts[0].revision;
        source_cut.digest = closure.source_cuts[0].digest.c_str();
        certificate.source_cuts = &source_cut;
        certificate.source_cut_count = 1U;

        request.abi_version = FULLMAG_FDM_CPU_OERSTED_ABI_V1;
        request.struct_size = sizeof(request);
        request.grid = {3U, 3U, 3U, 2.0e-9, 3.0e-9, 4.0e-9};
        std::copy(problem.grid.origin_m.begin(), problem.grid.origin_m.end(),
                  request.origin_m);
        request.boundaries[0] = FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN;
        request.boundaries[1] = FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN;
        request.boundaries[2] = FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN;
        request.conductor_mask = problem.conductor_mask.data();
        request.conductor_mask_len = cells;
        request.target_mask = problem.target_mask.data();
        request.target_mask_len = cells;
        request.jc_x_a_per_m2 = {
            problem.face_current_density_a_per_m2.x.data(), 36U};
        request.jc_y_a_per_m2 = {
            problem.face_current_density_a_per_m2.y.data(), 36U};
        request.jc_z_a_per_m2 = {
            problem.face_current_density_a_per_m2.z.data(), 36U};
        request.geometry_revision = problem.geometry_revision;
        request.geometry_digest = problem.geometry_digest.c_str();
        request.conductor_mask_revision = problem.conductor_mask_revision;
        request.conductor_mask_digest = problem.conductor_mask_digest.c_str();
        request.target_mask_revision = problem.target_mask_revision;
        request.target_mask_digest = problem.target_mask_digest.c_str();
        request.face_current_revision = problem.face_current_revision;
        request.face_current_digest = problem.face_current_digest.c_str();
        request.source_identity = problem.source_identity.c_str();
        request.envelope_revision = problem.envelope_revision;
        request.envelope_digest = problem.envelope_digest.c_str();
        request.stage_identity = problem.stage_identity;
        request.evaluation_time_s = problem.evaluation_time_s;
        request.evaluated_envelope_multiplier =
            problem.evaluated_envelope_multiplier;
        request.trusted_snapshot_revision = problem.trusted_snapshot_revision;
        request.trusted_snapshot_digest = problem.trusted_snapshot_digest.c_str();
        request.certificate = &certificate;

        field.assign(3U * cells, -1.0);
        result.abi_version = FULLMAG_FDM_CPU_OERSTED_ABI_V1;
        result.struct_size = sizeof(result);
        result.field_xyz_a_per_m = {field.data(), field.size(), 0U};
    }
};

void test_layout_and_closed_zero_fixture() {
    const auto *layout = fullmag_fdm_cpu_oersted_abi_layout_get_v1();
    check(layout != nullptr, "layout manifest is required");
    check(layout->request_size == sizeof(fullmag_fdm_cpu_oersted_request_v1),
          "request layout mismatch");
    check(layout->result_size == sizeof(fullmag_fdm_cpu_oersted_result_v1),
          "result layout mismatch");

    Fixture fixture;
    const int status =
        fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result);
    check(status == FULLMAG_FDM_CPU_OERSTED_OK, fixture.result.error_message);
    check(fixture.result.field_xyz_a_per_m.length == fixture.field.size(),
          "field length mismatch");
    check(std::all_of(fixture.field.begin(), fixture.field.end(),
                      [](double value) { return std::isfinite(value); }),
          "closed-loop field must be finite");
    check(std::any_of(fixture.field.begin(), fixture.field.end(),
                      [](double value) { return value != 0.0; }),
          "nonzero closed loop must produce nonzero field");
    oe::Solver direct_owner;
    const oe::SolveResult &direct = direct_owner.solve(fixture.problem);
    check(direct.ok(), direct.message.c_str());
    for (std::size_t cell = 0U; cell < direct.solution.field_a_per_m.size();
         ++cell) {
        for (std::size_t component = 0U; component < 3U; ++component) {
            const double expected =
                direct.solution.field_a_per_m[cell][component];
            const double actual = fixture.field[3U * cell + component];
            check(same_double_bits(actual, expected),
                  "public adapter must preserve every owner H component bit-exactly");
        }
    }
    check(std::strcmp(fixture.result.operator_version,
                      "fdm_oersted_cell_integrated_open.v1") == 0,
          "operator identity mismatch");
    check(std::strcmp(fixture.result.realization_version,
                      "oersted_fdm_fft_open.v1") == 0,
          "realization identity mismatch");
    check(std::strcmp(fixture.result.engine_version,
                      "fdm_oersted_fft_open_v1") == 0,
          "engine identity mismatch");
    check(fixture.result.face_current_revision ==
              fixture.problem.face_current_revision &&
              fixture.result.certificate_revision ==
                  fixture.problem.closure_certificate.revision &&
              fixture.result.trusted_snapshot_revision ==
                  fixture.problem.trusted_snapshot_revision &&
              fixture.result.envelope_revision == fixture.problem.envelope_revision &&
              fixture.result.stage_identity == fixture.problem.stage_identity,
          "revision or stage provenance mismatch");
    check(fixture.result.evaluation_time_s == fixture.problem.evaluation_time_s &&
              fixture.result.evaluated_envelope_multiplier ==
                  fixture.problem.evaluated_envelope_multiplier,
          "time or envelope provenance mismatch");
    check(std::strcmp(fixture.result.face_current_digest,
                      fixture.problem.face_current_digest.c_str()) == 0 &&
              std::strcmp(fixture.result.certificate_digest,
                          fixture.problem.closure_certificate.digest.c_str()) == 0 &&
              std::strcmp(fixture.result.trusted_snapshot_digest,
                          fixture.problem.trusted_snapshot_digest.c_str()) == 0 &&
              std::strcmp(fixture.result.source_identity,
                          fixture.problem.source_identity.c_str()) == 0,
          "source or certificate digest provenance mismatch");
    check(fixture.result.resolved_field_cache_key_digest[0] != '\0' &&
              fixture.result.kernel_plan_cache_key_digest[0] != '\0',
          "cache-key provenance is required");
    if (const char *path = std::getenv("FULLMAG_FDM_CPU_OERSTED_PUBLIC_EVIDENCE_PATH");
        path != nullptr && path[0] != '\0') {
        const char *source_digest =
            std::getenv("FULLMAG_FDM_CPU_OERSTED_PUBLIC_SOURCE_DIGEST");
        check(source_digest != nullptr &&
                  std::strncmp(source_digest, "sha256:", 7U) == 0 &&
                  std::strlen(source_digest) == 71U,
              "evidence requires the current task-scoped sha256 source digest");
        std::ofstream evidence(path, std::ios::trunc);
        check(evidence.good(), "cannot open public ABI evidence path");
        evidence << "{\n"
                 << "  \"schema\": \"fullmag.fdm.cpu.oersted.public_binding.v1\",\n"
                 << "  \"status\": \"contract_passed\",\n"
                 << "  \"source_digest\": \"" << source_digest << "\",\n"
                 << "  \"source_digest_scope\": [\n"
                 << "    \"native/include/fullmag_fdm.h\",\n"
                 << "    \"backends/fdm/api/cpu_oersted_fft_v1.cpp\",\n"
                 << "    \"backends/fdm/tests/cpu_oersted_fft_public_abi_contract.cpp\",\n"
                 << "    \"crates/fullmag-fdm-sys/src/lib.rs\",\n"
                 << "    \"backends/fdm/include/fullmag/fdm/cpu/oersted_fft_open_v1.hpp\",\n"
                 << "    \"backends/fdm/cpu/interactions/oersted/fft_open_v1.cpp\",\n"
                 << "    \"backends/fdm/cpu/interactions/oersted/digest_v1.cpp\",\n"
                 << "    \"backends/fdm/cpu/interactions/oersted/cell_integrated_kernel_v1.cpp\"\n"
                 << "  ],\n"
                 << "  \"field_unit\": \"A/m\",\n"
                 << "  \"operator\": \"" << fixture.result.operator_version << "\",\n"
                 << "  \"realization\": \"" << fixture.result.realization_version << "\",\n"
                 << "  \"engine\": \"" << fixture.result.engine_version << "\",\n"
                 << "  \"face_current_digest\": \""
                 << fixture.result.face_current_digest << "\",\n"
                 << "  \"certificate_digest\": \""
                 << fixture.result.certificate_digest << "\",\n"
                 << "  \"trusted_snapshot_digest\": \""
                 << fixture.result.trusted_snapshot_digest << "\",\n"
                 << "  \"source_identity\": \""
                 << fixture.result.source_identity << "\",\n"
                 << "  \"face_current_revision\": "
                 << fixture.result.face_current_revision << ",\n"
                 << "  \"certificate_revision\": "
                 << fixture.result.certificate_revision << ",\n"
                 << "  \"trusted_snapshot_revision\": "
                 << fixture.result.trusted_snapshot_revision << ",\n"
                 << "  \"envelope_revision\": "
                 << fixture.result.envelope_revision << ",\n"
                 << "  \"stage_identity\": " << fixture.result.stage_identity
                 << ",\n"
                 << "  \"evaluation_time_s\": "
                 << fixture.result.evaluation_time_s << ",\n"
                 << "  \"evaluated_envelope_multiplier\": "
                 << fixture.result.evaluated_envelope_multiplier << ",\n"
                 << "  \"resolved_field_cache_key_digest\": \""
                 << fixture.result.resolved_field_cache_key_digest << "\",\n"
                 << "  \"kernel_plan_cache_key_digest\": \""
                 << fixture.result.kernel_plan_cache_key_digest << "\",\n"
                 << "  \"closure_kind\": \"closed_geometry\",\n"
                 << "  \"source_cut_count\": 1,\n"
                 << "  \"source_cut_id\": \"source-cut-1\",\n"
                 << "  \"abi_layout_record_count\": 8,\n"
                 << "  \"field_owner_parity\": \"bit_exact_all_components\",\n"
                 << "  \"cache_lifetime\": \"persistent_immutable_snapshot\",\n"
                 << "  \"source_identity_policy\": \"lossless_95_bytes_max\",\n"
                 << "  \"qualification_scope\": \"direct_public_c_abi_prerequisite\",\n"
                 << "  \"public_problem_ir_chain\": \"separate_cross_layer_milestone\",\n"
                 << "  \"capability_status\": \"semantic_only\"\n"
                 << "}\n";
        check(evidence.good(), "cannot write public ABI evidence");
    }
}

void test_fail_closed_boundaries() {
    {
        Fixture fixture;
        fixture.request.certificate = nullptr;
        check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
                  FULLMAG_FDM_CPU_OERSTED_ERR_MISSING_CERTIFICATE,
              "missing certificate must fail closed");
        check(fixture.result.field_xyz_a_per_m.length == 0U,
              "missing certificate must not publish a field");
    }
    {
        Fixture fixture;
        fixture.problem.closure_certificate.source_cuts.clear();
        fixture.problem.closure_certificate.digest =
            oe::canonical_certificate_digest(fixture.problem.closure_certificate);
        fixture.problem.trusted_snapshot_digest =
            oe::canonical_trusted_snapshot_digest(fixture.problem);
        fixture.certificate.digest =
            fixture.problem.closure_certificate.digest.c_str();
        fixture.certificate.source_cuts = nullptr;
        fixture.certificate.source_cut_count = 0U;
        fixture.request.trusted_snapshot_digest =
            fixture.problem.trusted_snapshot_digest.c_str();
        check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
                  FULLMAG_FDM_CPU_OERSTED_ERR_OPEN_CIRCUIT,
              "driven closed geometry without source_cut must fail open-circuit");
        check(fixture.result.field_xyz_a_per_m.length == 0U,
              "open circuit must not publish a field");
    }
    {
        Fixture fixture;
        fixture.problem.face_current_density_a_per_m2.x[0] = 1.0;
        check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
                  FULLMAG_FDM_CPU_OERSTED_ERR_STALE_CERTIFICATE,
              "mutated accepted face current must fail stale");
        check(fixture.result.field_xyz_a_per_m.length == 0U,
              "stale certificate must not publish a field");
    }
    {
        Fixture fixture;
        fixture.request.boundaries[0] =
            FULLMAG_FDM_CPU_OERSTED_BOUNDARY_PERIODIC;
        check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
                  FULLMAG_FDM_CPU_OERSTED_ERR_PERIODIC,
              "periodic grid must fail closed");
        check(fixture.result.field_xyz_a_per_m.length == 0U,
              "periodic request must not publish a field");
    }
    {
        Fixture fixture;
        fixture.certificate.closure_kind = 99U;
        check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
                  FULLMAG_FDM_CPU_OERSTED_ERR_INVALID,
              "unknown closure kind must fail before solve");
        check(fixture.result.field_xyz_a_per_m.length == 0U,
              "invalid closure kind must not publish a field");
    }
    {
        Fixture fixture;
        fixture.result.field_xyz_a_per_m.capacity = 1U;
        check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
                  FULLMAG_FDM_CPU_OERSTED_ERR_BUFFER,
              "short output buffer must fail closed");
        check(fixture.result.field_xyz_a_per_m.length == 0U,
              "short output buffer must not publish a field");
    }
    {
        Fixture fixture;
        fixture.request.struct_size = sizeof(fixture.request) - 1U;
        check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
                  FULLMAG_FDM_CPU_OERSTED_ERR_ABI,
              "short request must fail ABI validation");
        check(fixture.result.field_xyz_a_per_m.length == 0U,
              "invalid ABI request must not publish a field");
    }
}

void test_stateless_boundary_preserves_only_a_truly_identical_snapshot() {
    Fixture fixture;
    const auto solve_from_same_callsite = [&fixture]() {
        fixture.result.field_xyz_a_per_m.length = 0U;
        return fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result);
    };

    check(solve_from_same_callsite() == FULLMAG_FDM_CPU_OERSTED_OK,
          fixture.result.error_message);
    const std::vector<double> accepted_field = fixture.field;
    const std::uint64_t accepted_fast_hits =
        fixture.result.trusted_fast_path_hit_count;

    check(solve_from_same_callsite() == FULLMAG_FDM_CPU_OERSTED_OK,
          fixture.result.error_message);
    check(fixture.result.resolved_field_reused == 1U,
          "bit-identical ABI request must reuse the resolved field");
    check(fixture.result.trusted_fast_path_hit_count == accepted_fast_hits + 1U,
          "bit-identical ABI request must use the trusted immutable fast path");
    check(same_double_vector_bits(fixture.field, accepted_field),
          "bit-identical ABI cache hit must preserve the exact field");

    fixture.problem.face_current_density_a_per_m2.x[13U] += 1.0;
    check(solve_from_same_callsite() ==
              FULLMAG_FDM_CPU_OERSTED_ERR_STALE_CERTIFICATE,
          "same-callsite raw-current mutation with stale identity must be rejected");
    check(fixture.result.field_xyz_a_per_m.length == 0U,
          "stale same-callsite mutation must not publish the cached field");
}

void test_source_identity_is_never_truncated() {
    Fixture fixture;
    fixture.problem.source_identity.assign(
        FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY - 1U, 's');
    fixture.problem.trusted_snapshot_digest =
        oe::canonical_trusted_snapshot_digest(fixture.problem);
    fixture.request.source_identity = fixture.problem.source_identity.c_str();
    fixture.request.trusted_snapshot_digest =
        fixture.problem.trusted_snapshot_digest.c_str();
    check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
              FULLMAG_FDM_CPU_OERSTED_OK,
          fixture.result.error_message);
    check(std::strcmp(fixture.result.source_identity,
                      fixture.problem.source_identity.c_str()) == 0,
          "maximum representable source identity must round-trip exactly");

    fixture.problem.source_identity.push_back('x');
    fixture.problem.trusted_snapshot_digest =
        oe::canonical_trusted_snapshot_digest(fixture.problem);
    fixture.request.source_identity = fixture.problem.source_identity.c_str();
    fixture.request.trusted_snapshot_digest =
        fixture.problem.trusted_snapshot_digest.c_str();
    fixture.result.field_xyz_a_per_m.length = 0U;
    check(fullmag_fdm_cpu_oersted_solve_v1(&fixture.request, &fixture.result) ==
              FULLMAG_FDM_CPU_OERSTED_ERR_INVALID,
          "unrepresentable source identity must be rejected, never truncated");
    check(fixture.result.field_xyz_a_per_m.length == 0U,
          "rejected source identity must not publish a field");
}

} // namespace

int main() {
    try {
        test_bit_exact_comparison_distinguishes_signed_zero();
        test_layout_and_closed_zero_fixture();
        test_fail_closed_boundaries();
        test_stateless_boundary_preserves_only_a_truly_identical_snapshot();
        test_source_identity_is_never_truncated();
        std::cout << "FDM CPU Oersted public ABI contract: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FDM CPU Oersted public ABI contract: FAIL: "
                  << error.what() << '\n';
        return 1;
    }
}
