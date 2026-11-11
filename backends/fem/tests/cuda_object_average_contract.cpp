#include "backend_handle.hpp"
#include "gpu/cuda/reductions/object_average.hpp"
#include "gpu/cuda/reductions/object_average_state.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <chrono>
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
void setup(fullmag_fem_backend &backend, const std::vector<double> &m, uint32_t element_count = 0u)
{
    auto &ctx = backend.context;
    ctx.mesh.n_nodes = static_cast<uint32_t>(m.size() / 3);
    ctx.mesh.n_elements = element_count;
    ctx.state.m_xyz.assign(m.size(), 99.0); // deliberately stale host copy
    std::string error;
    check(fullmag::fem::gpu_state_initialize(
        ctx.gpu_state.device, m.size() / 3, FULLMAG_FEM_INTEGRATOR_RK23_BS,
        true, false, m.data(), m.size(), ctx.transfer_audit.audit, error), error.c_str());
    check(fullmag::fem::prepare_membership_shape(
        ctx.gpu_state.device.reductions.object_average,
        ctx.mesh.n_nodes,
        ctx.mesh.n_elements,
        ctx.transfer_audit.audit,
        error), error.c_str());
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
    std::vector<uint32_t> large(16384 + 7, 1u); // duplicate-heavy: exceeds mesh cache budget
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

// SP4-sized active selectors must prepare once and then reuse GPU records.
void large_active_selectors_reuse_records()
{
    using namespace fullmag::fem;
    constexpr size_t nodes = 18529, elements = 56047;
    for (bool dg0 : {false, true}) {
        fullmag_fem_backend backend{};
        std::vector<double> m(nodes * 3, 0.0);
        for (size_t node = 0; node < nodes; ++node) {
            const double position = static_cast<double>(node) / nodes;
            m[3 * node] = position;
            m[3 * node + 1] = 1.0 - position;
            m[3 * node + 2] = static_cast<double>(node % 17) / 32.0 - 0.25;
        }
        setup(backend, m, dg0 ? elements : 0u);
        auto &ctx = backend.context;
        std::array<long double, 3> integrals{};
        long double denominator = 0.0L;
        if (dg0) {
            std::vector<P1TetrahedronMaterialTopology> topology(elements);
            std::vector<size_t> active(elements);
            std::vector<double> ms(elements);
            for (size_t element = 0; element < elements; ++element) {
                active[element] = element;
                const size_t first = (element * 13) % (nodes - 3);
                topology[element].node_ids = {first, first + 1, first + 2, first + 3};
                topology[element].volume_m3 = 1.0 + static_cast<double>(element % 7) / 8.0;
                ms[element] = 1.0 + static_cast<double>(element % 11) / 16.0;
                const long double weight = static_cast<long double>(ms[element]) * topology[element].volume_m3;
                denominator += weight;
                for (size_t component = 0; component < 3; ++component) {
                    for (size_t local = 0; local < 4; ++local) {
                        integrals[component] += weight * m[3 * (first + local) + component] / 4.0L;
                    }
                }
            }
            ctx.material_fields.runtime.emplace(P1TetrahedralMaterialRealization(
                nodes, topology, active,
                {MaterialCoefficientLocation::element_dg0, ms},
                {MaterialCoefficientLocation::uniform, {0.0}}));
        } else {
            ctx.mesh.node_volumes.resize(nodes);
            ctx.material_fields.Ms_field.resize(nodes);
            for (size_t node = 0; node < nodes; ++node) {
                ctx.mesh.node_volumes[node] = 1.0 + static_cast<double>(node % 7) / 8.0;
                ctx.material_fields.Ms_field[node] = 1.0 + static_cast<double>(node % 11) / 16.0;
                const long double weight = static_cast<long double>(ctx.material_fields.Ms_field[node]) *
                    ctx.mesh.node_volumes[node];
                denominator += weight;
                for (size_t component = 0; component < 3; ++component) {
                    integrals[component] += weight * m[3 * node + component];
                }
            }
        }
        std::vector<uint32_t> selection(dg0 ? elements : nodes);
        for (size_t index = 0; index < selection.size(); ++index) { selection[index] = index; }
        const auto check_average = [&] {
            const auto actual = average(backend, selection, dg0);
            for (size_t component = 0; component < 3; ++component) {
                near(actual[component], static_cast<double>(integrals[component] / denominator), 5e-12);
            }
        };
        check_average();
        const auto uploads = ctx.transfer_audit.audit.counters.h2d_bytes;
        const auto bytes = ctx.gpu_state.device.lifecycle.device_bytes;
        const auto passes = ctx.gpu_state.device.reductions.object_average.record_generation_passes;
        {
            TransferAuditScope hot_loop(ctx.transfer_audit.audit, TransferAuditScopeKind::HotLoop);
            check_average();
        }
        check(ctx.transfer_audit.audit.counters.h2d_bytes == uploads,
              "large active prepared selector repeats without ownership upload");
        check(ctx.gpu_state.device.lifecycle.device_bytes == bytes,
              "large active prepared selector repeats without device allocation");
        check(ctx.gpu_state.device.reductions.object_average.record_generation_passes == passes,
              "prepared selector hit skips record generation");
        auto &state = ctx.gpu_state.device.reductions.object_average;
        std::array<bool, kObjectAverageCacheEntries> prepared_valid{};
        for (size_t i = 0; i < state.entries.size(); ++i) { prepared_valid[i] = state.entries[i].valid; }
        const auto measure_one = [&] {
            const auto start = std::chrono::steady_clock::now();
            TransferAuditScope hot_loop(ctx.transfer_audit.audit, TransferAuditScopeKind::HotLoop);
            check_average();
            return std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - start).count();
        };
        double cached_ms = 0.0, streaming_ms = 0.0;
        uint64_t cached_uploads = 0, stream_uploads = 0;
        // Alternate five cached/streaming pairs using unchanged private fixture
        // payloads; neither path allocates. Fixture construction is not timed.
        for (int pair = 0; pair < 5; ++pair) {
            for (size_t i = 0; i < state.entries.size(); ++i) { state.entries[i].valid = prepared_valid[i]; }
            const auto cached_upload_start = ctx.transfer_audit.audit.counters.h2d_bytes;
            cached_ms += measure_one();
            cached_uploads += ctx.transfer_audit.audit.counters.h2d_bytes - cached_upload_start;
            for (auto &entry : state.entries) { entry.valid = false; }
            const auto stream_upload_start = ctx.transfer_audit.audit.counters.h2d_bytes;
            streaming_ms += measure_one();
            stream_uploads += ctx.transfer_audit.audit.counters.h2d_bytes - stream_upload_start;
        }
        check(cached_uploads == 0 && stream_uploads > 0,
              "microbenchmark compares prepared reuse with real streaming uploads");
        check(ctx.gpu_state.device.lifecycle.device_bytes == bytes,
              "cached and streaming microbenchmark perform no device allocation");
        std::printf("object-average microbenchmark lane=%s records=%zu pairs=5 cached_total_ms=%.3f streaming_total_ms=%.3f cached_h2d=%llu streaming_h2d=%llu\n",
            dg0 ? "dg0" : "nodal", selection.size(), cached_ms, streaming_ms,
            static_cast<unsigned long long>(cached_uploads), static_cast<unsigned long long>(stream_uploads));
        gpu_state_destroy(ctx.gpu_state.device);
    }
}

void dg0_large_node_selection_uses_prepared_byte_mask()
{
    using namespace fullmag::fem;
    constexpr size_t node_count = 70003;
    fullmag_fem_backend backend{};
    std::vector<double> m(node_count * 3, 0.0);
    const std::array<double, 12> tetra_m = {1,0,0, 0,1,0, 0,0,1, -1,0,0};
    const size_t first_tetra_node = node_count - 4;
    for (size_t component = 0; component < tetra_m.size(); ++component) {
        m[first_tetra_node * 3 + component] = tetra_m[component];
    }
    setup(backend, m, 1u);
    auto &ctx = backend.context;
    const std::vector<P1TetrahedronMaterialTopology> topology = {
        {{{first_tetra_node, first_tetra_node + 1, first_tetra_node + 2, first_tetra_node + 3}}, 2.0}};
    ctx.material_fields.runtime.emplace(P1TetrahedralMaterialRealization(
        node_count, topology, {0},
        {MaterialCoefficientLocation::element_dg0, {5e5}},
        {MaterialCoefficientLocation::uniform, {0.0}}));

    std::vector<uint32_t> nodes(node_count);
    for (size_t node = 0; node < node_count; ++node) {
        nodes[node] = static_cast<uint32_t>(node);
    }
    const auto actual = average(backend, nodes);
    const auto &realization = ctx.material_fields.runtime->realization();
    const std::vector<uint8_t> node_mask(node_count, 1u);
    const auto oracle = realization.ms_weighted_aos3_average_reduction_for_node_set(m, node_mask);
    check(oracle.denominator > 0.0, "large node-set oracle has positive DG0 weight");
    for (int component = 0; component < 3; ++component) {
        near(actual[component], oracle.weighted_component_integrals[component] / oracle.denominator);
    }
    const auto &state = ctx.gpu_state.device.reductions.object_average;
    check(state.membership.size() == node_count && state.membership_node_count == node_count,
          "node mask is sized for every node beyond the former 65536-entry threshold");
    check(state.membership_element_count == 1 && state.membership.front() == 1 && state.membership.back() == 1,
          "large node selection marks its prepared mask without growing it");
    gpu_state_destroy(ctx.gpu_state.device);
}

void dg0_element_set_larger_than_node_extent_uses_mask_and_rejects_shape_drift()
{
    using namespace fullmag::fem;
    fullmag_fem_backend backend{};
    const std::vector<double> m = {1,0,0, 0,1,0, 0,0,1, -1,0,0, 0,-1,0, 0,0,-1};
    setup(backend, m, 7u);
    auto &ctx = backend.context;
    const std::vector<P1TetrahedronMaterialTopology> topology = {
        {{{0,1,2,3}}, 1.0}, {{{0,1,4,5}}, 1.5}, {{{0,1,2,4}}, 2.0},
        {{{0,2,3,4}}, 2.5}, {{{1,2,3,5}}, 3.0}, {{{0,2,4,5}}, 3.5},
        {{{1,3,4,5}}, 4.0}};
    const std::vector<size_t> active = {1,3,5,6};
    auto install_material = [&](
        const std::vector<P1TetrahedronMaterialTopology> &elements,
        const std::vector<size_t> &active_elements) {
        std::vector<double> ms(elements.size());
        for (size_t element = 0; element < ms.size(); ++element) {
            ms[element] = static_cast<double>(element + 1) * 1e5;
        }
        ctx.material_fields.runtime.emplace(P1TetrahedralMaterialRealization(
            6, elements, active_elements,
            {MaterialCoefficientLocation::element_dg0, ms},
            {MaterialCoefficientLocation::uniform, {0.0}}));
    };
    install_material(topology, active);
    auto &state = ctx.gpu_state.device.reductions.object_average;
    const auto compare_oracle = [&](const std::vector<uint32_t> &selection, bool element_set) {
        const auto actual = average(backend, selection, element_set);
        const auto &realization = ctx.material_fields.runtime->realization();
        MsWeightedAos3AverageReduction oracle{};
        if (element_set) {
            const std::vector<size_t> selected_elements(selection.begin(), selection.end());
            oracle = realization.ms_weighted_aos3_average_reduction_for_element_set(m, selected_elements);
        } else {
            std::vector<uint8_t> mask(realization.node_count(), 0);
            for (const uint32_t node : selection) { mask[node] = 1; }
            oracle = realization.ms_weighted_aos3_average_reduction_for_node_set(m, mask);
        }
        check(oracle.denominator > 0.0, "alternating mask oracle has positive DG0 weight");
        for (int component = 0; component < 3; ++component) {
            near(actual[component], oracle.weighted_component_integrals[component] / oracle.denominator);
        }
    };

    compare_oracle({0,1,2,3,4,5}, false);
    compare_oracle({0,1,2,3,4,5,6,6,1}, true); // count exceeds N and E; duplicates collapse.
    compare_oracle({0,1,4,5}, false);
    compare_oracle({3,6}, true); // stale node bits 1 and 5 must not select extra elements.
    compare_oracle({0,1,4,5}, false); // stale element bit 3 must not add node 3.

    const auto membership_before_invalid = state.membership;
    const uint32_t invalid_element = 7;
    std::array<double, 3> output = {7,8,9};
    check(fullmag_fem_backend_average_m_for_elements_f64(
              &backend, &invalid_element, 1, output.data(), 3) == FULLMAG_FEM_ERR_INVALID,
          "element index validation precedes mask writes");
    check(state.membership == membership_before_invalid,
          "invalid element selection leaves the prepared mask unchanged");

    std::string error;
    const size_t membership_size = state.membership.size();
    const size_t membership_capacity = state.membership.capacity();
    const uint64_t membership_node_count = state.membership_node_count;
    const uint64_t membership_element_count = state.membership_element_count;
    {
        TransferAuditScope hot_loop(ctx.transfer_audit.audit, TransferAuditScopeKind::HotLoop);
        check(!prepare_membership_shape(state, 7, 7, ctx.transfer_audit.audit, error),
              "membership shape preparation refuses to run inside a hot loop");
    }
    check(state.membership.size() == membership_size &&
              state.membership_node_count == membership_node_count &&
              state.membership_element_count == membership_element_count,
          "hot-loop refusal preserves the prepared membership shape");
    error.clear();
    check(!prepare_membership_shape(
              state, std::numeric_limits<uint64_t>::max(), 7, ctx.transfer_audit.audit, error),
          "membership shape rejects an extent beyond vector max_size before allocation");
    check(state.membership.size() == membership_size &&
              state.membership_node_count == membership_node_count &&
              state.membership_element_count == membership_element_count,
          "oversized shape refusal preserves the prepared membership shape");

    auto drifted_topology = topology;
    drifted_topology.push_back({{{0,1,4,5}}, 4.5});
    install_material(drifted_topology, {1,3,5,6,7});
    const uint32_t newly_added_element = 7;
    output = {7,8,9};
    const int drift_status = fullmag_fem_backend_average_m_for_elements_f64(
        &backend, &newly_added_element, 1, output.data(), 3);
    check(drift_status == FULLMAG_FEM_ERR_INTERNAL,
          "GPU object average rejects runtime element-shape drift without resizing in the call");
    check(output == std::array<double, 3>{7,8,9}, "shape drift does not publish a result");
    check(state.membership.size() == membership_size && state.membership.capacity() == membership_capacity &&
              state.membership_node_count == membership_node_count &&
              state.membership_element_count == membership_element_count,
          "shape drift leaves the setup-owned mask allocation unchanged");
    check(std::any_of(state.entries.begin(), state.entries.end(),
                      [](const auto &entry) { return entry.valid; }),
          "same-shape object averages have a valid ownership-cache entry before reshape");
    const auto device_bytes = ctx.gpu_state.device.lifecycle.device_bytes;
    error.clear();
    check(prepare_membership_shape(state, 6, 8, ctx.transfer_audit.audit, error), error.c_str());
    check(state.membership.size() == 8 && state.membership_node_count == 6 &&
              state.membership_element_count == 8,
          "setup helper reshapes membership to max(N,E)");
    check(std::none_of(state.entries.begin(), state.entries.end(),
                       [](const auto &entry) { return entry.valid; }),
          "membership reshape invalidates ownership-cache entries");
    check(ctx.gpu_state.device.lifecycle.device_bytes == device_bytes,
          "membership reshape remains host-owned and does not alter device byte accounting");
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
    setup(backend, m, 3u);
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
            std::vector<uint8_t> mask(ctx.material_fields.runtime->realization().node_count(), 0);
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
    // Replacing the active scope at unchanged N/E must invalidate early hits.
    ctx.material_fields.runtime.emplace(P1TetrahedralMaterialRealization(
        6, topology, {0,2},
        {MaterialCoefficientLocation::element_dg0, {4e5,3e5,6e5}},
        {MaterialCoefficientLocation::uniform, {0.0}}));
    compare_oracle({1,0}, true);
    compare_oracle({0,1,2}, true);
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
    large_active_selectors_reuse_records();
    nodal_parity_cache_and_chunks();
    dg0_parity_membership_and_invalidation();
    dg0_large_node_selection_uses_prepared_byte_mask();
    dg0_element_set_larger_than_node_extent_uses_mask_and_rejects_shape_drift();
    std::puts("PASS: CUDA per-object magnetization averages");
}
