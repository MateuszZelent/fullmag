/*
 * Native GPU RK CUDA graph contract test.
 *
 * Verifies:
 * 1. RkGraphPlan::capture records a static RK step topology.
 * 2. RkGraphPlan::launch executes captured graph without host callbacks.
 * 3. Forced reject inside graph preserves last accepted state (transactional rollback).
 * 4. Graph invalidation safely destroys graph and instance.
 * 5. Fallback mode gracefully executes standard kernel path when graphs are disabled.
 */

#include "gpu/cuda/integrators/rk/rk_graph.hpp"
#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_output_control.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void test_graph_capture_and_rollback() {
    using namespace fullmag::fem;
    Context ctx{};
    ctx.mesh.n_nodes = 4;
    ctx.state.current_time = 0.0;
    ctx.state.step_count = 0;
    ctx.state.m_xyz = {1.0, 0.0, 0.0,
                       0.0, 1.0, 0.0,
                       0.0, 0.0, 1.0,
                       0.577, 0.577, 0.577};

    RkGraphPlan graph{};
    std::string error;

    // Test capture
    check(graph.capture(ctx, nullptr, error), "graph.capture should succeed");
    check(graph.is_captured(), "graph should be marked captured");
    check(graph.mode() == RkGraphMode::Captured, "graph mode should be Captured");
    check(graph.capture_count() == 1, "capture_count should be 1");
    check(graph.node_count() > 0, "captured graph must contain non-zero nodes");

    const auto last_accepted_m = ctx.state.m_xyz;
    const auto last_accepted_time = ctx.state.current_time;

    // Simulate forced reject on graph
    check(graph.simulate_forced_reject(ctx, nullptr, error), "simulate_forced_reject");

    // Verify last accepted state is completely unchanged
    check(ctx.state.m_xyz == last_accepted_m, "m_xyz must remain unchanged after reject");
    check(ctx.state.current_time == last_accepted_time, "time must remain unchanged after reject");
    check(graph.host_callback_count() == 0, "graph execution must have zero host callbacks");

    // Launch captured graph
    check(graph.launch(ctx, nullptr, error), "graph.launch");
    check(graph.launch_count() == 1, "launch_count should be 1");

    // Invalidate
    graph.invalidate();
    check(!graph.is_captured(), "graph should not be captured after invalidate");
    check(graph.mode() == RkGraphMode::Disabled, "graph mode should be Disabled after invalidate");
}

void test_graph_fallback_mode() {
    using namespace fullmag::fem;
    Context ctx{};
    RkGraphPlan graph{};
    graph.set_mode(RkGraphMode::Fallback);
    check(graph.mode() == RkGraphMode::Fallback, "mode is Fallback");

    std::string error;
    check(graph.launch(ctx, nullptr, error), "launch in fallback mode executes standard path");
    check(graph.launch_count() == 1, "launch_count incremented in fallback mode");
}

void test_graph_stream_capture_source_contract() {
    std::ifstream file("/workspace/backends/fem/gpu/cuda/integrators/rk/rk_graph.cpp");
    if (!file.is_open()) {
        file.open("backends/fem/gpu/cuda/integrators/rk/rk_graph.cpp");
    }
    if (!file.is_open()) {
        file.open("../backends/fem/gpu/cuda/integrators/rk/rk_graph.cpp");
    }
    check(file.is_open(), "unable to open rk_graph.cpp");
    std::string src((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    check(src.find("cudaStreamBeginCapture") != std::string::npos,
          "rk_graph.cpp must use cudaStreamBeginCapture");
    check(src.find("cudaStreamEndCapture") != std::string::npos,
          "rk_graph.cpp must use cudaStreamEndCapture");
    check(src.find("cudaGraphGetNodes") != std::string::npos,
          "rk_graph.cpp must verify non-empty graph via cudaGraphGetNodes");
    check(src.find("cudaGraphCreate(&graph_, 0)") == std::string::npos,
          "rk_graph.cpp must not instantiate an empty graph created via cudaGraphCreate");

    std::ifstream step_file("/workspace/backends/fem/gpu/cuda/integrators/rk/rk_step.cu");
    if (!step_file.is_open()) step_file.open("backends/fem/gpu/cuda/integrators/rk/rk_step.cu");
    if (!step_file.is_open()) step_file.open("../backends/fem/gpu/cuda/integrators/rk/rk_step.cu");
    check(step_file.is_open(), "unable to open rk_step.cu");
    std::string step_src((std::istreambuf_iterator<char>(step_file)), std::istreambuf_iterator<char>());
    check(step_src.find("executed_via_graph") != std::string::npos,
          "rk_step.cu must gate standard attempt loop on !executed_via_graph");
}

void test_graph_captured_mode_falls_back_without_bypassing_rhs() {
    std::ifstream step_file("/workspace/backends/fem/gpu/cuda/integrators/rk/rk_step.cu");
    if (!step_file.is_open()) step_file.open("backends/fem/gpu/cuda/integrators/rk/rk_step.cu");
    if (!step_file.is_open()) step_file.open("../backends/fem/gpu/cuda/integrators/rk/rk_step.cu");
    check(step_file.is_open(), "unable to open rk_step.cu");
    std::string step_src((std::istreambuf_iterator<char>(step_file)), std::istreambuf_iterator<char>());

    check(step_src.find("gpu.rk.graph_plan.set_mode(RkGraphMode::Fallback)") != std::string::npos,
          "rk_step.cu must downgrade Captured mode to Fallback in production dispatch");
    check(step_src.find("accepted_attempt.total_stage_rhs_evaluations = static_cast<uint32_t>(tableau.stages)") == std::string::npos,
          "rk_step.cu must not fabricate RHS evaluation counts without running stages");

    using namespace fullmag::fem;
    Context ctx{};
    RkGraphPlan graph{};
    std::string error;
    check(graph.capture(ctx, nullptr, error), "capture graph");
    check(graph.mode() == RkGraphMode::Captured, "mode is Captured");
    graph.set_mode(RkGraphMode::Fallback);
    check(graph.mode() == RkGraphMode::Fallback, "mode transitioned to Fallback");
}

void test_commit_candidate_fault_injection_and_propagation() {
    using namespace fullmag::fem;
    Context ctx{};
    ctx.state.current_time = 1.0e-12;
    ctx.state.step_count = 10;
    RkCandidateState candidate{};
    candidate.node_count = 2;
    candidate.time = 1.0e-12;
    candidate.dt = 1.0e-13;
    candidate.force_commit_failure = true;

    std::string error;
    bool committed = commit_candidate(ctx, candidate, nullptr, error);
    check(!committed, "commit_candidate with force_commit_failure must return false");
    check(error.find("injected commit_candidate failure") != std::string::npos,
          "error diagnostic must report injected failure");
    check(ctx.state.current_time == 1.0e-12, "current_time must remain unchanged on commit failure");
    check(ctx.state.step_count == 10, "step_count must remain unchanged on commit failure");

    std::ifstream refresh_file("/workspace/backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu");
    if (!refresh_file.is_open()) refresh_file.open("backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu");
    if (!refresh_file.is_open()) refresh_file.open("../backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu");
    check(refresh_file.is_open(), "unable to open rk_final_refresh.cu");
    std::string refresh_src((std::istreambuf_iterator<char>(refresh_file)), std::istreambuf_iterator<char>());
    check(refresh_src.find("if (!commit_candidate") != std::string::npos,
          "rk_final_refresh.cu must propagate commit_candidate failure");
    check(refresh_src.find("gpu.rk.fsal_valid = false;") != std::string::npos,
          "rk_final_refresh.cu must invalidate FSAL on commit failure");
}

} // namespace

int main() {
    test_graph_capture_and_rollback();
    test_graph_fallback_mode();
    test_graph_stream_capture_source_contract();
    test_graph_captured_mode_falls_back_without_bypassing_rhs();
    test_commit_candidate_fault_injection_and_propagation();
    std::printf("PASS: gpu_rk_graph_contract\n");
    return 0;
}
