#include "fullmag_fdm.h"
#include "context.hpp"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <type_traits>
#include <vector>

using fullmag::fdm::Context;
using fullmag::fdm::DeviceVectorField;

static_assert(std::is_standard_layout_v<fullmag_fdm_gpu_transport_llg_binding_v1>);
static_assert(std::is_standard_layout_v<fullmag_fdm_llg_checkpoint_info_v1>);
static_assert(sizeof(fullmag_fdm_llg_checkpoint_info_v1) == 96);
static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v1, cell_count) == 16);
static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v1, current_time) == 40);
static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v1,
                       transport_attempt_generation) == 56);
static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v1, abm_last_dt) == 72);
static_assert(offsetof(fullmag_fdm_llg_checkpoint_info_v1,
                       adaptive_previous_error) == 88);
static_assert(sizeof(fullmag_fdm_gpu_transport_llg_binding_v1) == 144);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, transport_context) == 32);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, charge_snapshot) == 64);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, accepted_sequence) == 96);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, source_revision) == 104);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, operator_revision) == 112);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, relative_tolerance) == 120);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, max_iterations) == 128);
static_assert(offsetof(fullmag_fdm_gpu_transport_llg_binding_v1, reserved1) == 136);

namespace {

constexpr uint64_t kCells = 3;

struct ControlledOperator {
    double *torque = nullptr;
    double *m_audit = nullptr;
    bool audit_m_stage_on_compute_stream = false;
    bool stage_dependent_torque = false;
    double torque_amplitude = 1.0;
    uint64_t evaluations = 0;
    std::vector<double> target_stage_my;
    std::vector<double> stage_times;
    std::vector<uint64_t> attempt_ids;
    std::vector<uint64_t> stage_ids;
    uint64_t fail_stage = 0;
};

ControlledOperator *active_operator = nullptr;

[[noreturn]] void fail(const char *message) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
}

void check(bool condition, const char *message) {
    if (!condition) fail(message);
}

void check_cuda(cudaError_t status, const char *message) {
    if (status != cudaSuccess) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message, cudaGetErrorString(status));
        std::exit(1);
    }
}

bool controlled_transport_rhs(
    Context &ctx,
    const DeviceVectorField &m_stage,
    double t_stage,
    uint64_t attempt_id,
    uint64_t stage_id,
    DeviceVectorField &torque_view)
{
    if (active_operator == nullptr || active_operator->torque == nullptr) return false;
    const void *pointers[3] = {m_stage.x, m_stage.y, m_stage.z};
    for (const void *pointer : pointers) {
        cudaPointerAttributes attributes{};
        if (cudaPointerGetAttributes(&attributes, pointer) != cudaSuccess ||
            attributes.type != cudaMemoryTypeDevice) {
            return false;
        }
    }
    double target_my = 0.0;
    if (active_operator->audit_m_stage_on_compute_stream) {
        if (active_operator->m_audit == nullptr) return false;
        const bool copied = fullmag::fdm::context_test_copy_f64_on_compute_stream(
            ctx, active_operator->m_audit,
            static_cast<const double *>(m_stage.y) + 1, 1);
        const cudaError_t read_status = copied
            ? cudaMemcpy(&target_my, active_operator->m_audit,
                         sizeof(target_my), cudaMemcpyDeviceToHost)
            : cudaErrorUnknown;
        if (!copied || read_status != cudaSuccess) {
            return false;
        }
    } else if (cudaMemcpy(&target_my,
                          static_cast<const double *>(m_stage.y) + 1,
                          sizeof(target_my), cudaMemcpyDeviceToHost) != cudaSuccess) {
        return false;
    }
    active_operator->target_stage_my.push_back(target_my);
    if (active_operator->stage_dependent_torque) {
        const double stage_torque = active_operator->torque_amplitude *
                                    ((stage_id & 1U) != 0U ? 1.0 : -1.0);
        check_cuda(cudaMemcpy(active_operator->torque + kCells + 1,
                              &stage_torque, sizeof(stage_torque),
                              cudaMemcpyHostToDevice),
                   "upload stage-dependent adaptive torque");
    }
    active_operator->stage_times.push_back(t_stage);
    active_operator->attempt_ids.push_back(attempt_id);
    active_operator->stage_ids.push_back(stage_id);
    ++active_operator->evaluations;
    if (stage_id == active_operator->fail_stage) return false;
    torque_view.x = active_operator->torque;
    torque_view.y = active_operator->torque + kCells;
    torque_view.z = active_operator->torque + 2 * kCells;
    return true;
}

fullmag_fdm_backend *create_backend(
    fullmag_fdm_integrator integrator,
    double alpha,
    fullmag_fdm_stats_mode stats_mode = FULLMAG_FDM_STATS_NONE,
    double adaptive_max_error = 0.0)
{
    std::vector<double> m0(3 * kCells, 0.0);
    for (uint64_t cell = 0; cell < kCells; ++cell) m0[3 * cell] = 1.0;
    fullmag_fdm_plan_desc plan{};
    plan.grid = {static_cast<uint32_t>(kCells), 1, 1, 1.0, 1.0, 1.0};
    plan.material = {8.0e5, 0.0, alpha, 2.211e5};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = integrator;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = m0.size();
    plan.stats_mode = stats_mode;
    plan.adaptive_max_error = adaptive_max_error;
    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "backend creation returned null");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "backend creation reported an error");
    return handle;
}

ControlledOperator create_controlled_operator(double torque_amplitude = 1.0) {
    ControlledOperator result{};
    result.torque_amplitude = torque_amplitude;
    std::vector<double> torque(3 * kCells, 0.0);
    torque[kCells + 1] = torque_amplitude; // target FM cell only.
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&result.torque),
                          torque.size() * sizeof(double)),
               "allocate controlled torque");
    check_cuda(cudaMemcpy(result.torque, torque.data(),
                          torque.size() * sizeof(double),
                          cudaMemcpyHostToDevice),
               "upload controlled torque");
    return result;
}

void bind_controlled_operator(fullmag_fdm_backend *handle, ControlledOperator &op) {
    auto *ctx = reinterpret_cast<Context *>(handle);
    ctx->gpu_transport_rhs = {};
    ctx->gpu_transport_rhs.active = true;
    ctx->gpu_transport_rhs.evaluate = &controlled_transport_rhs;
    active_operator = &op;
}

std::vector<double> read_m(fullmag_fdm_backend *handle) {
    std::vector<double> result(3 * kCells, 0.0);
    check(fullmag_fdm_backend_copy_field_f64(
              handle, FULLMAG_FDM_OBSERVABLE_M, result.data(), result.size()) ==
              FULLMAG_FDM_OK,
          "magnetization readback failed");
    return result;
}

std::vector<double> read_device_field(const DeviceVectorField &field) {
    std::vector<double> result(3 * kCells, 0.0);
    check_cuda(cudaMemcpy(result.data(), field.x, kCells * sizeof(double),
                          cudaMemcpyDeviceToHost), "read device field x");
    check_cuda(cudaMemcpy(result.data() + kCells, field.y,
                          kCells * sizeof(double), cudaMemcpyDeviceToHost),
               "read device field y");
    check_cuda(cudaMemcpy(result.data() + 2 * kCells, field.z,
                          kCells * sizeof(double), cudaMemcpyDeviceToHost),
               "read device field z");
    return result;
}

void verify_single_rhs_gilbert_transform() {
    fullmag_fdm_backend *handle = create_backend(FULLMAG_FDM_INTEGRATOR_HEUN, 0.5);
    ControlledOperator op = create_controlled_operator();
    bind_controlled_operator(handle, op);
    auto *ctx = reinterpret_cast<Context *>(handle);
    check(fullmag::fdm::context_evaluate_gpu_transport_rhs(
              *ctx, ctx->m, 0.0, 1, 1),
          "single RHS transport callback failed");
    check_cuda(cudaMemset(ctx->k1.x, 0, kCells * sizeof(double)), "clear RHS x");
    check_cuda(cudaMemset(ctx->k1.y, 0, kCells * sizeof(double)), "clear RHS y");
    check_cuda(cudaMemset(ctx->k1.z, 0, kCells * sizeof(double)), "clear RHS z");
    fullmag::fdm::launch_add_gpu_transport_torque_fp64(*ctx, ctx->m, ctx->k1);
    std::vector<double> y(kCells), z(kCells);
    check_cuda(cudaMemcpy(y.data(), ctx->k1.y, kCells * sizeof(double),
                          cudaMemcpyDeviceToHost), "read RHS y");
    check_cuda(cudaMemcpy(z.data(), ctx->k1.z, kCells * sizeof(double),
                          cudaMemcpyDeviceToHost), "read RHS z");
    check(op.evaluations == 1, "single RHS must evaluate transport exactly once");
    check(std::fabs(y[1] - 0.8) < 1.0e-14,
          "Gilbert transport source y component is wrong");
    check(std::fabs(z[1] - 0.4) < 1.0e-14,
          "Gilbert transport source z component is wrong");
    check(y[0] == 0.0 && y[2] == 0.0 && z[0] == 0.0 && z[2] == 0.0,
          "transport target mask leaked torque outside the FM target");
    check(fullmag_fdm_context_unbind_gpu_transport_v1(handle) == FULLMAG_FDM_OK,
          "unbind after single RHS failed");
    check_cuda(cudaFree(op.torque), "free controlled torque");
    fullmag_fdm_backend_destroy(handle);
    active_operator = nullptr;
}

void verify_default_compute_stream_handoff() {
    fullmag_fdm_backend *handle = create_backend(FULLMAG_FDM_INTEGRATOR_HEUN, 0.0);
    ControlledOperator op = create_controlled_operator();
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&op.m_audit), sizeof(double)),
               "allocate stream handoff m_stage audit");
    bind_controlled_operator(handle, op);
    auto *ctx = reinterpret_cast<Context *>(handle);
    double *source = nullptr;
    void *release_work = nullptr;
    check_cuda(cudaMalloc(reinterpret_cast<void **>(&source), sizeof(double)),
               "allocate gated producer source");
    const double m_value = 0.25;
    check_cuda(cudaMemcpy(source, &m_value, sizeof(m_value), cudaMemcpyHostToDevice),
               "upload gated m_stage source");
    constexpr size_t release_work_bytes = size_t{256} << 20;
    check_cuda(cudaMalloc(&release_work, release_work_bytes),
               "allocate gated device workload");
    check_cuda(cudaMemsetAsync(release_work, 0x5a, release_work_bytes,
                               nullptr),
               "enqueue gated device workload");
    check_cuda(cudaMemcpyAsync(static_cast<double *>(ctx->m.y) + 1, source,
                               sizeof(m_value), cudaMemcpyDeviceToDevice, nullptr),
               "enqueue gated default-stream m_stage producer");
    op.audit_m_stage_on_compute_stream = true;
    check(fullmag::fdm::context_evaluate_gpu_transport_rhs(
              *ctx, ctx->m, 0.0, 1, 1),
          "transport evaluation after m_stage handoff failed");
    check(op.target_stage_my.size() == 1 && op.target_stage_my[0] == m_value,
          "transport callback missed the default-stream m_stage update");
    op.audit_m_stage_on_compute_stream = false;

    const double rhs_value = 2.0;
    check_cuda(cudaMemcpy(source, &rhs_value, sizeof(rhs_value), cudaMemcpyHostToDevice),
               "upload gated RHS source");
    check_cuda(cudaMemset(ctx->k1.y, 0, kCells * sizeof(double)),
               "clear delayed RHS target");
    check_cuda(cudaMemsetAsync(release_work, 0xa5, release_work_bytes, nullptr),
               "enqueue default-stream RHS workload");
    check_cuda(cudaMemcpyAsync(static_cast<double *>(ctx->k1.y) + 1, source,
                               sizeof(rhs_value), cudaMemcpyDeviceToDevice, nullptr),
               "enqueue default-stream base RHS producer");
    check(fullmag::fdm::launch_add_gpu_transport_torque_fp64(
              *ctx, ctx->m, ctx->k1),
          "delayed base RHS torque addition failed");
    double rhs_y = 0.0;
    check_cuda(cudaMemcpy(&rhs_y, static_cast<double *>(ctx->k1.y) + 1,
                          sizeof(rhs_y), cudaMemcpyDeviceToHost),
               "read delayed combined RHS");
    check(rhs_y == 3.0,
          "transport torque lost the delayed default-stream base RHS update");
    check_cuda(cudaFree(release_work), "free gated device workload");
    check_cuda(cudaFree(source), "free gated producer source");
    check_cuda(cudaFree(op.m_audit), "free stream handoff m_stage audit");
    check_cuda(cudaFree(op.torque), "free stream handoff torque");
    fullmag_fdm_backend_destroy(handle);
    active_operator = nullptr;
}

struct IntegratorObservation {
    std::vector<double> result;
    std::vector<double> target_stage_my;
    std::vector<double> stage_times;
    std::vector<uint64_t> attempt_ids;
    std::vector<uint64_t> stage_ids;
};

IntegratorObservation run_integrator(
    fullmag_fdm_integrator integrator,
    fullmag_fdm_stats_mode stats_mode)
{
    fullmag_fdm_backend *handle = create_backend(integrator, 0.0, stats_mode);
    ControlledOperator op = create_controlled_operator();
    bind_controlled_operator(handle, op);
    constexpr double dt = 1.0e-3;
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
          "transport-coupled integrator step failed");
    IntegratorObservation observation{
        read_m(handle),
        op.target_stage_my,
        op.stage_times,
        op.attempt_ids,
        op.stage_ids,
    };
    check_cuda(cudaFree(op.torque), "free controlled torque");
    fullmag_fdm_backend_destroy(handle);
    active_operator = nullptr;
    return observation;
}

void verify_integrator(fullmag_fdm_integrator integrator, uint64_t expected_stages) {
    constexpr double dt = 1.0e-3;
    const IntegratorObservation no_stats =
        run_integrator(integrator, FULLMAG_FDM_STATS_NONE);
    const IntegratorObservation full_stats =
        run_integrator(integrator, FULLMAG_FDM_STATS_FULL);
    check(no_stats.result == full_stats.result,
          "enabling diagnostics changed the accepted magnetization");

    for (const IntegratorObservation *observation : {&no_stats, &full_stats}) {
        const auto &result = observation->result;
        const auto &target_stage_my = observation->target_stage_my;
        const auto &stage_times = observation->stage_times;
        const auto &attempt_ids = observation->attempt_ids;
        const auto &stage_ids = observation->stage_ids;
        const uint64_t evaluations = target_stage_my.size();
        check(evaluations == expected_stages,
              "transport callback count does not match scientific RHS stages");
        check(target_stage_my.size() == expected_stages,
              "stage magnetization audit has the wrong length");
        check(std::fabs(target_stage_my.front()) < 1.0e-15,
              "first stage did not receive m(t_n)");
        check(std::fabs(target_stage_my[1]) > 1.0e-6,
              "later stage reused frozen m(t_n) instead of current m_stage");
        check(attempt_ids.size() == expected_stages &&
                  stage_ids.size() == expected_stages &&
                  stage_times.size() == expected_stages,
              "transport stage diagnostics have inconsistent lengths");
        for (uint64_t stage = 0; stage < expected_stages; ++stage) {
            check(attempt_ids[stage] == 1,
                  "transport callback received an inconsistent attempt id");
            check(stage_ids[stage] == stage + 1,
                  "transport callback received an inconsistent stage id");
        }
        check(stage_times.front() == 0.0,
              "first transport callback received the wrong stage time");
        check(std::fabs(stage_times.back() - dt) < 1.0e-18,
              "last transport callback received the wrong stage time");
        check(std::fabs(target_stage_my.back() - result[4]) < 1.0e-15,
              "accepted spin solve did not use the final accepted magnetization");

        const double inverse_norm = 1.0 / std::sqrt(1.0 + dt * dt);
        check(std::fabs(result[3] - inverse_norm) < 2.0e-9,
              "target cell mx indicates torque was not added exactly once");
        check(std::fabs(result[4] - dt * inverse_norm) < 2.0e-9,
              "target cell my indicates torque was not added exactly once");
        check(std::fabs(result[5]) < 1.0e-14,
              "target cell received an unexpected z torque");
        check(result[0] == 1.0 && result[1] == 0.0 && result[2] == 0.0 &&
                  result[6] == 1.0 && result[7] == 0.0 && result[8] == 0.0,
              "HM or outside-FM cell changed despite zero transport torque");
    }
}

void verify_no_binding_preserves_rhs() {
    fullmag_fdm_backend *handle = create_backend(FULLMAG_FDM_INTEGRATOR_HEUN, 0.0);
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, 1.0e-3, &stats) == FULLMAG_FDM_OK,
          "unbound baseline integrator step failed");
    const std::vector<double> result = read_m(handle);
    for (uint64_t cell = 0; cell < kCells; ++cell) {
        check(result[3 * cell] == 1.0 && result[3 * cell + 1] == 0.0 &&
                  result[3 * cell + 2] == 0.0,
              "absence of a binding changed the historical RHS");
    }
    fullmag_fdm_gpu_transport_llg_binding_v1 invalid{};
    invalid.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    invalid.struct_version = 1;
    invalid.struct_size = sizeof(invalid);
    check(fullmag_fdm_context_bind_gpu_transport_v1(handle, &invalid) ==
              FULLMAG_FDM_ERR_INVALID,
          "invalid transport binding must fail closed");
    fullmag_fdm_backend_destroy(handle);
}

void verify_late_stage_failure_rolls_back(
    fullmag_fdm_integrator integrator, uint64_t fail_stage)
{
    fullmag_fdm_backend *handle = create_backend(integrator, 0.0);
    ControlledOperator op = create_controlled_operator();
    op.fail_stage = fail_stage;
    bind_controlled_operator(handle, op);
    auto *ctx = reinterpret_cast<Context *>(handle);
    if (integrator == FULLMAG_FDM_INTEGRATOR_RK23 ||
        integrator == FULLMAG_FDM_INTEGRATOR_DP45) {
        ctx->fsal_valid = true;
    }
    const std::vector<double> before = read_m(handle);
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, 1.0e-3, &stats) == FULLMAG_FDM_ERR_CUDA,
          "late transport stage failure was accepted");
    check(read_m(handle) == before,
          "late transport stage failure did not restore magnetization bitwise");
    check(ctx->step_count == 0 && ctx->current_time == 0.0,
          "late transport stage failure advanced accepted time or step");
    check(!ctx->fsal_valid,
          "bound rollback preserved an FSAL derivative that transport may mutate");
    const uint64_t failed_evaluations = op.evaluations;
    op.fail_stage = 0;
    check(fullmag_fdm_backend_step(handle, 1.0e-3, &stats) == FULLMAG_FDM_OK,
          "retry after late transport stage failure did not succeed");
    for (uint64_t evaluation = failed_evaluations;
         evaluation < op.attempt_ids.size(); ++evaluation) {
        check(op.attempt_ids[evaluation] == 2,
              "retry reused the rejected transport attempt identity");
    }
    const std::vector<double> retry_result = read_m(handle);
    check_cuda(cudaFree(op.torque), "free controlled rollback torque");
    fullmag_fdm_backend_destroy(handle);

    fullmag_fdm_backend *baseline = create_backend(integrator, 0.0);
    ControlledOperator baseline_op = create_controlled_operator();
    bind_controlled_operator(baseline, baseline_op);
    check(fullmag_fdm_backend_step(baseline, 1.0e-3, &stats) == FULLMAG_FDM_OK,
          "fresh deterministic baseline step failed");
    check(read_m(baseline) == retry_result,
          "retry after rollback differs bitwise from a fresh deterministic step");
    check_cuda(cudaFree(baseline_op.torque), "free deterministic baseline torque");
    fullmag_fdm_backend_destroy(baseline);
    active_operator = nullptr;
}

void verify_adaptive_retry_gets_fresh_transport_attempt(
    fullmag_fdm_integrator integrator)
{
    fullmag_fdm_backend *handle = create_backend(
        integrator, 0.0, FULLMAG_FDM_STATS_NONE, 1.0e-8);
    ControlledOperator op = create_controlled_operator(1.0e6);
    op.stage_dependent_torque = true;
    bind_controlled_operator(handle, op);
    fullmag_fdm_step_stats stats{};
    const int status = fullmag_fdm_backend_step(handle, 1.0e-3, &stats);
    if (status != FULLMAG_FDM_OK) {
        const char *error = fullmag_fdm_backend_last_error(handle);
        std::fprintf(stderr, "adaptive retry status=%d error=%s\n", status,
                     error != nullptr ? error : "<none>");
    }
    check(status == FULLMAG_FDM_OK,
          "adaptive transport retry did not reach an accepted step");
    check(!op.attempt_ids.empty(), "adaptive transport retry produced no stages");
    check(*std::max_element(op.attempt_ids.begin(), op.attempt_ids.end()) > 1,
          "adaptive rejection reused one transport attempt identity");
    uint64_t previous_attempt = 0;
    for (size_t index = 0; index < op.attempt_ids.size(); ++index) {
        if (op.attempt_ids[index] != previous_attempt) {
            check(op.stage_ids[index] == 1,
                  "adaptive transport retry did not restart at stage one");
            previous_attempt = op.attempt_ids[index];
        }
    }
    check_cuda(cudaFree(op.torque), "free adaptive retry torque");
    fullmag_fdm_backend_destroy(handle);
    active_operator = nullptr;
}

void verify_abm3_history_survives_full_step_rollback() {
    fullmag_fdm_backend *handle = create_backend(FULLMAG_FDM_INTEGRATOR_ABM3, 0.0);
    ControlledOperator op = create_controlled_operator();
    op.stage_dependent_torque = true;
    bind_controlled_operator(handle, op);
    fullmag_fdm_step_stats stats{};
    for (int startup = 0; startup < 3; ++startup) {
        check(fullmag_fdm_backend_step(handle, 1.0e-3, &stats) == FULLMAG_FDM_OK,
              "ABM3 transport warmup failed");
    }
    auto *ctx = reinterpret_cast<Context *>(handle);
    const std::vector<double> accepted_m = read_m(handle);
    const std::vector<double> accepted_fn = read_device_field(ctx->abm_f_n);
    const std::vector<double> accepted_fn1 = read_device_field(ctx->abm_f_n1);
    const std::vector<double> accepted_fn2 = read_device_field(ctx->abm_f_n2);
    const uint32_t accepted_startup = ctx->abm_startup;
    const double accepted_last_dt = ctx->abm_last_dt;
    op.fail_stage = 3;
    check(fullmag_fdm_backend_step(handle, 2.0e-3, &stats) == FULLMAG_FDM_ERR_CUDA,
          "ABM3 full-step transport failure was accepted");
    check(read_m(handle) == accepted_m &&
              read_device_field(ctx->abm_f_n) == accepted_fn &&
              read_device_field(ctx->abm_f_n1) == accepted_fn1 &&
              read_device_field(ctx->abm_f_n2) == accepted_fn2 &&
              ctx->abm_startup == accepted_startup &&
              ctx->abm_last_dt == accepted_last_dt,
          "ABM3 rollback changed accepted multistep history");
    op.fail_stage = 0;
    check(fullmag_fdm_backend_step(handle, 1.0e-3, &stats) == FULLMAG_FDM_OK,
          "ABM3 full-step retry failed");
    const std::vector<double> accepted_endpoint_rhs = read_device_field(ctx->abm_f_n);
    check(!op.target_stage_my.empty(), "ABM3 full step produced no transport stages");
    check(accepted_endpoint_rhs[kCells + 1] == -1.0,
          "ABM3 history contains predictor rather than corrected-endpoint derivative");
    check_cuda(cudaFree(op.torque), "free ABM3 history torque");
    fullmag_fdm_backend_destroy(handle);
    active_operator = nullptr;
}

void verify_checkpoint_restart_is_bitwise_continuous(
    fullmag_fdm_integrator integrator)
{
    constexpr double dt = 1.0e-3;
    constexpr int prefix_steps = 4;
    constexpr int suffix_steps = 3;
    fullmag_fdm_step_stats stats{};

    fullmag_fdm_backend *continuous = create_backend(integrator, 0.0);
    ControlledOperator continuous_op = create_controlled_operator();
    continuous_op.stage_dependent_torque = true;
    bind_controlled_operator(continuous, continuous_op);
    for (int step = 0; step < prefix_steps; ++step) {
        check(fullmag_fdm_backend_step(continuous, dt, &stats) == FULLMAG_FDM_OK,
              "checkpoint prefix step failed");
    }
    auto *continuous_ctx = reinterpret_cast<Context *>(continuous);
    const double checkpoint_time = continuous_ctx->current_time;
    uint64_t checkpoint_bytes = 0;
    check(fullmag_fdm_backend_llg_checkpoint_query_size_v1(
              continuous, &checkpoint_bytes) == FULLMAG_FDM_OK &&
              checkpoint_bytes > sizeof(fullmag_fdm_llg_checkpoint_info_v1),
          "LLG checkpoint size query failed");
    std::vector<std::byte> payload(checkpoint_bytes);
    fullmag_fdm_llg_checkpoint_info_v1 info{};
    check(fullmag_fdm_backend_llg_checkpoint_export_v1(
              continuous, payload.data(), payload.size(), &info) == FULLMAG_FDM_OK,
          "LLG checkpoint export failed");
    check(info.schema_version == 1 && info.payload_bytes == checkpoint_bytes &&
              info.step_count == prefix_steps && info.current_time == checkpoint_time,
          "LLG checkpoint metadata does not describe the accepted state");
    for (int step = 0; step < suffix_steps; ++step) {
        check(fullmag_fdm_backend_step(continuous, dt, &stats) == FULLMAG_FDM_OK,
              "continuous suffix step failed");
    }
    const std::vector<double> expected_m = read_m(continuous);
    const uint64_t expected_attempt_generation =
        continuous_ctx->gpu_transport_attempt_generation;

    fullmag_fdm_backend *restored = create_backend(integrator, 0.0);
    check(fullmag_fdm_backend_llg_checkpoint_import_v1(
              restored, payload.data(), payload.size(), &info) == FULLMAG_FDM_OK,
          "LLG checkpoint import into a fresh matching context failed");
    ControlledOperator restored_op = create_controlled_operator();
    restored_op.stage_dependent_torque = true;
    bind_controlled_operator(restored, restored_op);
    for (int step = 0; step < suffix_steps; ++step) {
        check(fullmag_fdm_backend_step(restored, dt, &stats) == FULLMAG_FDM_OK,
              "restored suffix step failed");
    }
    auto *restored_ctx = reinterpret_cast<Context *>(restored);
    check(read_m(restored) == expected_m,
          "checkpoint restart diverged bitwise from continuous execution");
    check(restored_ctx->step_count == continuous_ctx->step_count &&
              restored_ctx->current_time == continuous_ctx->current_time &&
              restored_ctx->current_dt == continuous_ctx->current_dt &&
              restored_ctx->gpu_transport_attempt_generation ==
                  expected_attempt_generation,
          "checkpoint restart did not preserve accepted scalar state");

    fullmag_fdm_backend *nonfresh = create_backend(integrator, 0.0);
    check(fullmag_fdm_backend_step(nonfresh, dt, &stats) == FULLMAG_FDM_OK,
          "non-fresh import setup step failed");
    check(fullmag_fdm_backend_llg_checkpoint_import_v1(
              nonfresh, payload.data(), payload.size(), &info) ==
              FULLMAG_FDM_ERR_INVALID,
          "checkpoint import into a non-fresh context did not fail closed");
    std::vector<std::byte> corrupt = payload;
    corrupt.front() ^= std::byte{0x1};
    fullmag_fdm_backend *corrupt_target = create_backend(integrator, 0.0);
    check(fullmag_fdm_backend_llg_checkpoint_import_v1(
              corrupt_target, corrupt.data(), corrupt.size(), &info) ==
              FULLMAG_FDM_ERR_INVALID,
          "corrupt LLG checkpoint did not fail closed");

    check_cuda(cudaFree(continuous_op.torque), "free continuous checkpoint torque");
    check_cuda(cudaFree(restored_op.torque), "free restored checkpoint torque");
    fullmag_fdm_backend_destroy(continuous);
    fullmag_fdm_backend_destroy(restored);
    fullmag_fdm_backend_destroy(nonfresh);
    fullmag_fdm_backend_destroy(corrupt_target);
    active_operator = nullptr;
}

} // namespace

int main() {
    const auto bind_symbol = &fullmag_fdm_context_bind_gpu_transport_v1;
    const auto unbind_symbol = &fullmag_fdm_context_unbind_gpu_transport_v1;
    (void)bind_symbol;
    (void)unbind_symbol;
    if (fullmag_fdm_is_available() == 0) {
        std::puts("SKIP: CUDA device unavailable");
        return 0;
    }
    verify_default_compute_stream_handoff();
    verify_single_rhs_gilbert_transform();
    verify_integrator(FULLMAG_FDM_INTEGRATOR_HEUN, 3);
    verify_integrator(FULLMAG_FDM_INTEGRATOR_RK4, 5);
    verify_integrator(FULLMAG_FDM_INTEGRATOR_RK23, 4);
    verify_integrator(FULLMAG_FDM_INTEGRATOR_DP45, 7);
    verify_integrator(FULLMAG_FDM_INTEGRATOR_ABM3, 3);
    verify_late_stage_failure_rolls_back(FULLMAG_FDM_INTEGRATOR_HEUN, 3);
    verify_late_stage_failure_rolls_back(FULLMAG_FDM_INTEGRATOR_RK4, 5);
    verify_late_stage_failure_rolls_back(FULLMAG_FDM_INTEGRATOR_RK23, 4);
    verify_late_stage_failure_rolls_back(FULLMAG_FDM_INTEGRATOR_DP45, 7);
    verify_late_stage_failure_rolls_back(FULLMAG_FDM_INTEGRATOR_ABM3, 3);
    verify_adaptive_retry_gets_fresh_transport_attempt(
        FULLMAG_FDM_INTEGRATOR_RK23);
    verify_adaptive_retry_gets_fresh_transport_attempt(
        FULLMAG_FDM_INTEGRATOR_DP45);
    verify_abm3_history_survives_full_step_rollback();
    verify_checkpoint_restart_is_bitwise_continuous(FULLMAG_FDM_INTEGRATOR_RK23);
    verify_checkpoint_restart_is_bitwise_continuous(FULLMAG_FDM_INTEGRATOR_DP45);
    verify_checkpoint_restart_is_bitwise_continuous(FULLMAG_FDM_INTEGRATOR_ABM3);
    verify_no_binding_preserves_rhs();
    std::puts("PASS: GPU M1 transport LLG stage contract");
    return 0;
}
