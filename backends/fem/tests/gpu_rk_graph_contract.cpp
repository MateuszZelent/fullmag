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

#include <cmath>
#include <cstdio>
#include <cstdlib>
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

} // namespace

int main() {
    test_graph_capture_and_rollback();
    test_graph_fallback_mode();
    std::printf("PASS: gpu_rk_graph_contract\n");
    return 0;
}
