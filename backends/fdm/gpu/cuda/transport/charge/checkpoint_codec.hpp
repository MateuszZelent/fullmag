#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fdm::gpu::transport::charge {

struct CheckpointData {
    std::array<uint8_t, 16> device_uuid{};
    std::array<uint8_t, 32> build_digest{};
    std::array<uint8_t, 32> static_digest{};
    std::array<uint8_t, 16> lineage{};
    std::array<uint64_t, 3> grid{};
    std::array<double, 3> cell_size{};
    uint32_t compute_major = 0;
    uint32_t compute_minor = 0;
    uint32_t cuda_driver = 0;
    uint32_t cuda_runtime = 0;
    uint64_t descriptor_revision = 0;
    uint64_t source_revision = 0;
    uint64_t operator_revision = 0;
    uint64_t accepted_sequence = 0;
    uint64_t iterations = 0;
    uint32_t convergence_reason = 0;
    double component_balance = 0.0;
    double physical_residual = 0.0;
    std::vector<uint8_t> active;
    std::vector<double> conductivity;
    std::vector<double> potential;
    std::vector<double> jx;
    std::vector<double> jy;
    std::vector<double> jz;
    std::vector<uint64_t> charge_adjacent_cells;
    std::vector<uint32_t> charge_axes;
    std::vector<int32_t> charge_sides;
    std::vector<double> charge_areas;
    std::vector<double> charge_values;
    std::vector<std::string> charge_source_ids;
    std::vector<uint64_t> interface_source_ids;
    std::vector<uint64_t> interface_topology_ids;
    std::vector<uint32_t> interface_axes;
    std::vector<uint64_t> interface_face_linear;
    std::vector<uint64_t> interface_negative_cells;
    std::vector<uint64_t> interface_positive_cells;
    std::vector<uint64_t> interface_from_cells;
    std::vector<uint64_t> interface_to_cells;
    std::vector<int32_t> interface_orientations;
    std::vector<double> interface_from_trace_v;
    std::vector<double> interface_to_trace_v;
    std::vector<double> interface_delta_trace_v;
    std::vector<double> interface_charge_current_density;
    std::array<uint8_t, 32> snapshot_digest{};
    std::array<uint8_t, 32> continuation_digest{};
};

bool build_checkpoint(CheckpointData *data, std::vector<uint8_t> *payload);
bool parse_checkpoint(const uint8_t *payload, uint64_t payload_size,
                      CheckpointData *data);
void checkpoint_sha256(const void *payload, uint64_t payload_size,
                       uint8_t digest[32]);
bool checkpoint_content_digest_v2(const CheckpointData &data, uint8_t digest[32]);

} // namespace fullmag::fdm::gpu::transport::charge
