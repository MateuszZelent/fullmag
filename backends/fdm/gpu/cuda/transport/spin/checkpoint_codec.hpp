#pragma once

#include "../charge/checkpoint_codec.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fdm::gpu::transport::spin {

struct SpinCheckpointData {
    std::string formula_id = "transport_constitutive.one_way.fullmag.v1";
    std::string operator_id = "fv_spin_drift_diffusion_v1";
    std::string electric_reconstruction_id = "accepted_face_current.v1";
    std::string interface_formula_id = "magnetoelectronic.fullmag.v2";
    std::string torque_operator_id = "transport_torque_balance.v1";
    std::string engine_id = "fdm_spin_block_gmres_cuda_v1";
    std::string preconditioner_id = "component_amg_block_jacobi.v1";
    std::string residual_id = "spin_balance_integrated_l2.v1";
    std::string local_residual_id = "spin_local_balance.v1";
    uint64_t source_revision = 0;
    uint64_t operator_revision = 0;
    uint64_t preconditioner_revision = 0;
    uint32_t convergence_reason = 1;
    uint64_t iterations = 0;
    uint64_t work_budget = 0;
    double local_balance = 0.0;
    double global_balance = 0.0;
    double interface_balance = 0.0;
    double torque_balance = 0.0;
    std::array<uint8_t, 32> deterministic_compute_digest{};
    std::vector<double> mu_s, qx, qy, qz;
    std::array<std::vector<double>, 9> reactions;
    std::vector<uint64_t> interface_source_ids, interface_topology_ids;
    std::vector<uint32_t> interface_axes;
    std::vector<uint64_t> interface_face_linear, interface_negative_cells,
        interface_positive_cells, interface_from_cells, interface_to_cells;
    std::vector<int32_t> interface_orientations;
    std::array<std::vector<double>, 18> interface_values;
    std::array<std::vector<double>, 10> torque;
    uint64_t restart_position = 0;
    uint64_t basis_count = 0;
    std::vector<double> warm_iterate, warm_basis;
    std::vector<uint8_t> deterministic_reduction_state;
    std::array<uint8_t, 32> snapshot_digest{}, spin_digest{}, warm_start_digest{},
        continuation_digest{};
};

bool build_checkpoint(const charge::CheckpointData &charge,
                      SpinCheckpointData &spin,
                      std::vector<uint8_t> *payload);
bool parse_checkpoint(const uint8_t *payload, uint64_t payload_size,
                      SpinCheckpointData *spin);

} // namespace fullmag::fdm::gpu::transport::spin
