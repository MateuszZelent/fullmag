#pragma once

/*
 * GPU CUDA Poisson demag stage compute header.
 *
 * Declares strict device-resident FEM GPU Poisson demag stage compute. Lifecycle
 * and readiness remain in poisson.hpp; operator workspace records live in
 * operators.hpp.
 */

#include "gpu/cuda/state/gpu_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

// A demag field solve is useful for more than one consumer.  Keep the
// expensive energy reduction out of RK stage RHS evaluations, while retaining
// the four-argument entrypoints below for legacy direct-field callers.
enum class GpuDemagEvaluationMode : uint32_t {
    FieldOnly = 0,
    FieldAndRecoveredEnergy = 1,
};

enum class GpuDemagSolvePurpose : uint32_t {
    IntermediateRkStage = 0,
    EndpointRkStage = 1,
    RelaxationTrial = 2,
    RelaxationAcceptedState = 3,
    ObservableRefresh = 4,
    ValidationOracle = 5,
    // Internal field-only consumer for the frequency-domain tangent path;
    // it is not a public capability or a tolerance policy selector.
    FrequencyTangent = 6,
};

struct GpuDemagApplyRequest {
    bool reset_initial_solution = false;
    GpuDemagEvaluationMode evaluation_mode = GpuDemagEvaluationMode::FieldOnly;
    GpuDemagSolvePurpose purpose = GpuDemagSolvePurpose::IntermediateRkStage;
};

// Resolve/validate a request at the module boundary so unsupported enum values
// fail closed instead of silently selecting a more expensive or less strict
// path.  The function is CUDA-independent and is covered by a source contract.
bool validate_gpu_demag_evaluation_request(
    const GpuDemagApplyRequest &request,
    std::string &reason);

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *stream,
    const GpuDemagApplyRequest &request,
    std::string &reason);

bool compute_device_demag_for_device_stage(
    Context &ctx,
    const FemGpuComponentField &m,
    void *stream,
    std::string &reason);

bool compute_device_demag_for_device_stage_fresh(
    Context &ctx,
    const FemGpuComponentField &m,
    void *stream,
    const GpuDemagApplyRequest &request,
    std::string &reason);

bool compute_device_demag_for_device_stage_fresh(
    Context &ctx,
    const FemGpuComponentField &m,
    void *stream,
    std::string &reason);

bool recover_device_demag_full_domain_field_device(
    Context &ctx,
    void *stream,
    std::string &reason);

bool recover_device_demag_visual_field(
    Context &ctx,
    void *stream,
    std::string &reason);

bool reduce_device_demag_robin_boundary_energy(
    Context &ctx,
    double *result,
    void *stream,
    std::string &reason);

bool reduce_device_demag_robin_boundary_difference(
    Context &ctx,
    double *delta_result,
    double *absolute_result,
    void *stream,
    std::string &reason);

} // namespace fullmag::fem
