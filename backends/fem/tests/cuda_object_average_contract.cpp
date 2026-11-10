#include "backend_handle.hpp"
#include "gpu/cuda/reductions/object_average_state.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

namespace {
void check(bool condition, const char *message)
{
    if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); }
}
void near(double actual, double expected, double tolerance = 1e-15)
{
    // Binary64 tree/CUB/chunk reduction order differs from serial CPU order.
    // Fixtures have bounded condition numbers; this is an absolute+relative
    // observable parity gate, not a bitwise sum or speed qualification.
    check(std::abs(actual - expected) <= tolerance * std::max(1.0, std::abs(expected)),
          "GPU weighted average matches CPU oracle within reduction-order tolerance");
}
void setup(fullmag_fem_backend &backend, const std::vector<double> &m)
{
    auto &ctx = backend.context;
    ctx.mesh.n_nodes = static_cast<uint32_t>(m.size() / 3);
    ctx.state.m_xyz.assign(m.size(), 99.0); // deliberately stale host copy
    std::string error;
    check(fullmag::fem::gpu_state_initialize(
        ctx.gpu_state.device, m.size() / 3, FULLMAG_FEM_INTEGRATOR_RK23_BS,
        true, false, m.data(), m.size(), ctx.transfer_audit.audit, error), error.c_str());
    ctx.gpu_state.device.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    ctx.gpu_state.device.residency.host_state = fullmag::fem::FemGpuSyncState::HostStale;
}
std::array<double, 3> average(fullmag_fem_backend &backend,
    const std::vector<uint32_t> &selection, bool elements = false)
{
    std::array<double, 3> result{};
    const auto before = backend.context.transfer_audit.audit.counters.d2h_bytes;
    const int status = elements
        ? fullmag_fem_backend_average_m_for_elements_f64(&backend, selection.data(), selection.size(), result.data(), 3)
        : fullmag_fem_backend_average_m_for_nodes_f64(&backend, selection.data(), selection.size(), result.data(), 3);
    check(status == FULLMAG_FEM_OK, backend.last_error.c_str());
    check(backend.context.transfer_audit.audit.counters.d2h_bytes - before == 4 * sizeof(double),
          "object average downloads exactly four scalars");
    check(backend.context.state.m_xyz[0] == 99.0, "object average never refreshes stale host magnetization");
    return result;
}
void nodal_parity_cache_and_chunks()
{
    using namespace fullmag::fem;
    fullmag_fem_backend backend{};
    const std::vector<double> m = {1,0,0, 0,1,0, 0,0,1, -1,0,0};
    setup(backend, m);
    auto &ctx = backend.context;
    ctx.integration_weights.mfem_lumped_mass = {1,2,3,4};
    ctx.material_fields.Ms_field = {1,2,0,std::numeric_limits<double>::infinity()};
    const std::vector<uint32_t> nodes = {0,1,1,2,3};
    const auto setup_bytes = ctx.gpu_state.device.lifecycle.device_bytes;
    {
        TransferAuditScope hot_loop(ctx.transfer_audit.audit, TransferAuditScopeKind::HotLoop);
        average(backend, nodes);
    }
    check(ctx.gpu_state.device.lifecycle.device_bytes == setup_bytes,
          "cold ownership miss in hot loop uses setup scratch without allocation");
    for (const auto &entry : ctx.gpu_state.device.reductions.object_average.entries) {
        check(entry.records.capacity() == 0 && entry.device_capacity == 0,
              "cold hot-loop miss does not allocate host or device cache payload");
    }
    auto result = average(backend, nodes);
    near(result[0], 1.0 / 9.0); near(result[1], 8.0 / 9.0); near(result[2], 0.0);
    const auto hits = ctx.gpu_state.device.reductions.object_average.cache_hits;
    const auto bytes = ctx.gpu_state.device.lifecycle.device_bytes;
    const auto upload_bytes = ctx.transfer_audit.audit.counters.h2d_bytes;
    average(backend, nodes);
    check(ctx.transfer_audit.audit.counters.h2d_bytes == upload_bytes,
          "prepared cache hit performs no ownership or field upload");
    check(ctx.gpu_state.device.reductions.object_average.cache_hits == hits + 1,
          "unchanged ownership reuses prepared device weights");
    ctx.integration_weights.mfem_lumped_mass[1] = 1;
    result = average(backend, nodes);
    near(result[0], 1.0 / 5.0); near(result[1], 4.0 / 5.0);
    ctx.material_fields.Ms_field[1] = 1;
    result = average(backend, nodes);
    near(result[0], 1.0 / 3.0); near(result[1], 2.0 / 3.0);
    check(ctx.gpu_state.device.lifecycle.device_bytes == bytes,
          "weight invalidation never allocates more cache device memory");
    std::vector<uint32_t> large(kObjectAverageRecordLimit + 7, 1u);
    result = average(backend, large);
    near(result[0], 0, 2e-12); near(result[1], 1, 2e-12); near(result[2], 0, 2e-12);
    std::array<double, 3> unchanged = {7,8,9};
    const uint32_t invalid = 4;
    check(fullmag_fem_backend_average_m_for_nodes_f64(&backend, &invalid, 1, unchanged.data(), 3)
              == FULLMAG_FEM_ERR_INVALID, "invalid node index preserves API error code");
    check(unchanged == std::array<double, 3>{7,8,9}, "invalid selection does not publish output");
    ctx.material_fields.Ms_field.assign(4, 0);
    check(fullmag_fem_backend_average_m_for_nodes_f64(&backend, nodes.data(), nodes.size(), unchanged.data(), 3)
              == FULLMAG_FEM_OK, "zero effective weight is legal");
    check(unchanged == std::array<double, 3>{0,0,0}, "zero denominator produces zero vector");
    gpu_state_destroy(ctx.gpu_state.device);
}
void forced_gpu_without_device_state_never_reduces_on_cpu()
{
    fullmag_fem_backend backend{};
    auto &ctx = backend.context;
    ctx.mfem_device.device_string_override = "cuda";
    ctx.mesh.n_nodes = 1;
    ctx.state.m_xyz = {1, 0, 0};
    ctx.mesh.node_volumes = {1};
    ctx.material_fields.Ms_field = {1};
    std::array<double, 3> output = {7, 8, 9};
    const uint32_t node = 0;
    check(fullmag_fem_backend_average_m_for_nodes_f64(
              &backend, &node, 1, output.data(), 3) != FULLMAG_FEM_OK,
          "forced GPU mean requires device state rather than a CPU fallback");
    check(output == std::array<double, 3>{7, 8, 9},
          "missing GPU state does not publish a host-computed value");
}
void dg0_parity_membership_and_invalidation()
{
    using namespace fullmag::fem;
    fullmag_fem_backend backend{};
    const std::vector<double> m = {1,0,0, 0,1,0, 0,0,1, -1,0,0, 0,-1,0, 0,0,-1};
    setup(backend, m);
    auto &ctx = backend.context;
    std::vector<P1TetrahedronMaterialTopology> topology = {
        {{{0,1,2,3}}, 1.0}, {{{0,1,4,5}}, 2.0}, {{{0,2,3,4}}, 3.0}};
    auto material = [&](double second_ms) {
        ctx.material_fields.runtime.emplace(P1TetrahedralMaterialRealization(
            6, topology, {0,1}, {MaterialCoefficientLocation::element_dg0, {4e5,second_ms,0}},
            {MaterialCoefficientLocation::uniform, {0.0}}));
    };
    material(8e5);
    auto compare_oracle = [&](const std::vector<uint32_t> &selection, bool elements) {
        const auto result = average(backend, selection, elements);
        MsWeightedAos3AverageReduction oracle{};
        if (elements) {
            oracle = ctx.material_fields.runtime->ms_weighted_aos3_average_reduction_for_element_set(
                m, std::vector<size_t>(selection.begin(), selection.end()));
        } else {
            std::vector<uint8_t> mask(6, 0);
            for (auto node : selection) { mask[node] = 1; }
            oracle = ctx.material_fields.runtime->ms_weighted_aos3_average_reduction_for_node_set(m, mask);
        }
        for (int c = 0; c < 3; ++c) { near(result[c], oracle.weighted_component_integrals[c] / oracle.denominator); }
    };
    compare_oracle({0,1,2,3,4,5}, false);
    compare_oracle({0,1,2,3,3}, false);
    compare_oracle({0,0,2}, true); // duplicates collapse; inactive element is excluded
    compare_oracle({1,0}, true);
    const auto misses = ctx.gpu_state.device.reductions.object_average.cache_misses;
    material(3e5);
    compare_oracle({1,0}, true);
    check(ctx.gpu_state.device.reductions.object_average.cache_misses > misses,
          "replaced DG0 material invalidates ownership weights");
    topology[1].node_ids = {0,2,4,5};
    material(3e5);
    compare_oracle({1,0}, true);
    const uint32_t invalid = 3;
    std::array<double, 3> output = {7,8,9};
    check(fullmag_fem_backend_average_m_for_elements_f64(&backend, &invalid, 1, output.data(), 3)
              == FULLMAG_FEM_ERR_INVALID, "invalid element index preserves API error code");
    std::vector<double> nonfinite = m;
    nonfinite[5 * 3] = std::numeric_limits<double>::infinity();
    std::string error;
    check(gpu_state_upload_magnetization_aos(ctx.gpu_state.device, nonfinite.data(), nonfinite.size(),
          ctx.transfer_audit.audit, error), error.c_str());
    compare_oracle({0}, true); // nonfinite vertices outside the selected element are ignored
    nonfinite = m;
    nonfinite[0] = std::numeric_limits<double>::quiet_NaN();
    check(gpu_state_upload_magnetization_aos(ctx.gpu_state.device, nonfinite.data(), nonfinite.size(),
          ctx.transfer_audit.audit, error), error.c_str());
    const uint32_t first = 0;
    check(fullmag_fem_backend_average_m_for_elements_f64(&backend, &first, 1, output.data(), 3)
              == FULLMAG_FEM_ERR_INTERNAL, "DG0 selected nonfinite magnetization preserves reduction failure");
    check(output == std::array<double, 3>{7,8,9}, "failed DG0 reduction does not publish output");
    gpu_state_destroy(ctx.gpu_state.device);
}
} // namespace
int main()
{
    forced_gpu_without_device_state_never_reduces_on_cpu();
    nodal_parity_cache_and_chunks();
    dg0_parity_membership_and_invalidation();
    std::puts("PASS: CUDA per-object magnetization averages");
}
