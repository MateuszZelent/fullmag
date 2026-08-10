#pragma once

#include <fullmag/fdm/cpu/charge_transport_v1.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace fullmag::fdm::cpu::transport::spin::v1 {

using Vector3 = std::array<double, 3>;

inline constexpr std::string_view api_version = "fullmag.fdm.cpu.steady_spin.v1";
inline constexpr std::string_view formula_version =
    "transport_constitutive.one_way.fullmag.v1";
inline constexpr std::string_view operator_version = "fv_spin_upwind_v1";
inline constexpr std::string_view electric_reconstruction_version =
    "fdm_exact_face_current_electric_reconstruction.v1";
inline constexpr std::string_view engine_version =
    "fdm_spin_block_gmres_matrix_free_reference_v1";
inline constexpr std::string_view residual_version =
    "transport_balance_integrated_l2.v1";
inline constexpr std::string_view local_residual_version =
    "transport_balance_local_fv.v1";
inline constexpr std::string_view interface_version =
    "magnetoelectronic.fullmag.v2";
inline constexpr std::string_view torque_operator_version =
    "fdm_transport_torque_cell_surface_balance.v1";

enum class BoundaryKind : std::uint32_t {
    unset = 0,
    insulating = 1,
    sink = 2,
    specified_potential = 3,
};

struct BoundaryCondition {
    BoundaryKind kind = BoundaryKind::unset;
    Vector3 potential_v{};

    static BoundaryCondition insulating() noexcept;
    static BoundaryCondition sink() noexcept;
    static BoundaryCondition specified_potential(Vector3 potential_v) noexcept;
};

struct BoundaryConditions {
    std::array<BoundaryCondition, 6> values{};

    BoundaryCondition &operator[](transport::v1::Face face) noexcept;
    const BoundaryCondition &operator[](transport::v1::Face face) const noexcept;
};

struct ReactionLengths {
    // Zero means that the named reaction is explicitly disabled.
    double spin_flip_m = 0.0;
    double exchange_m = 0.0;
    double dephasing_m = 0.0;
};

struct StructuredFace {
    std::size_t axis = 0;
    std::size_t negative_cell = 0;
    std::size_t positive_cell = 0;
};

enum class InterfaceKind : std::uint32_t {
    transparent = 0,
    mixing_conductance_v2 = 1,
    sml_reservoir_v2 = 2,
};

struct Interface {
    StructuredFace face;
    std::size_t from_cell = 0;
    std::size_t to_cell = 0;
    InterfaceKind kind = InterfaceKind::transparent;
    double g_up_s_per_m2 = 0.0;
    double g_down_s_per_m2 = 0.0;
    double g_r_s_per_m2 = 0.0;
    double g_i_s_per_m2 = 0.0;
    Vector3 magnetization{0.0, 0.0, 1.0};

    static Interface transparent(StructuredFace face,
                                 std::size_t from_cell,
                                 std::size_t to_cell) noexcept;
    static Interface mixing_conductance_v2(StructuredFace face,
                                           std::size_t from_cell,
                                           std::size_t to_cell,
                                           double g_up_s_per_m2,
                                           double g_down_s_per_m2,
                                           double g_r_s_per_m2,
                                           double g_i_s_per_m2,
                                           Vector3 magnetization) noexcept;
    static Interface sml_reservoir_v2(StructuredFace face,
                                      std::size_t from_cell,
                                      std::size_t to_cell) noexcept;
};

struct TorqueTargets {
    std::vector<std::uint8_t> target_cells;
    std::vector<double> saturation_magnetization_a_per_m;
    double gamma_e_rad_per_s_t = 0.0;
};

struct Problem {
    transport::v1::Grid grid;
    // Only a successful charge solve can construct this immutable snapshot.
    std::shared_ptr<const transport::v1::AcceptedChargeSnapshot> accepted_charge_snapshot;
    std::vector<double> spin_conductivity_s_per_m;
    std::vector<double> polarization;
    std::vector<double> spin_hall_angle;
    std::vector<Vector3> magnetization;
    std::vector<ReactionLengths> reactions;
    std::vector<std::uint8_t> active_cells;
    std::vector<std::uint32_t> region_ids;
    BoundaryConditions boundary;
    std::vector<Interface> interfaces;
    TorqueTargets torque_targets;
};

struct SolverOptions {
    double relative_tolerance = 1.0e-10;
    double absolute_tolerance_a = 1.0e-18;
    double local_relative_tolerance = 1.0e-10;
    double local_absolute_tolerance_a_per_m3 = 1.0e-6;
    std::size_t max_iterations = 2000;
    std::size_t gmres_restart = 40;
};

struct FaceSpinCurrentDensity {
    std::vector<Vector3> x;
    std::vector<Vector3> y;
    std::vector<Vector3> z;
};

using CellSpinCurrentTensor = std::array<double, 9>;

std::vector<CellSpinCurrentTensor>
reconstruct_cell_spin_current_tensor(const transport::v1::Grid &grid,
                                     const FaceSpinCurrentDensity &face_spin_current_density);

struct InterfaceFluxObservation {
    StructuredFace face;
    std::size_t from_cell = 0;
    std::size_t to_cell = 0;
    Vector3 incoming_longitudinal_a_per_m2{};
    Vector3 backflow_longitudinal_a_per_m2{};
    Vector3 absorbed_transverse_a_per_m2{};
    Vector3 negative_cell_flux_positive_axis_a_per_m2{};
    Vector3 positive_cell_flux_positive_axis_a_per_m2{};
};

struct ReactionObservation {
    Vector3 spin_flip_a_per_m3{};
    Vector3 exchange_a_per_m3{};
    Vector3 dephasing_a_per_m3{};
    Vector3 magnetic_torque_sink_a_per_m3{};
};

struct Diagnostics {
    std::size_t iterations = 0;
    std::size_t gmres_restart = 0;
    double initial_rhs_integrated_l2_a = 0.0;
    double recursive_residual_integrated_l2_a = 0.0;
    double recomputed_balance_integrated_l2_a = 0.0;
    double balance_tolerance_integrated_l2_a = 0.0;
    std::array<Vector3, 6> boundary_outward_current_a{};
    Vector3 net_boundary_current_a{};
    Vector3 spin_flip_sink_a{};
    Vector3 magnetic_torque_sink_a{};
    Vector3 interface_absorbed_sink_a{};
    Vector3 global_balance_closure_a{};
    double global_balance_scale_a = 0.0;
    double relative_global_balance = 0.0;
    double max_abs_residual_a_per_m3 = 0.0;
    double max_local_residual_tolerance_a_per_m3 = 0.0;
    double max_relative_local_residual = 0.0;
    std::string_view convergence_reason;
};

struct Provenance {
    std::string_view api_version;
    std::string_view formula_version;
    std::string_view operator_version;
    std::string_view electric_reconstruction_version;
    std::string_view engine_version;
    std::string_view residual_version;
    std::string_view local_residual_version;
    std::string_view interface_version;
    std::string_view torque_operator_version;
};

struct Solution {
    std::vector<Vector3> spin_potential_v;
    FaceSpinCurrentDensity face_spin_current_density_a_per_m2;
    std::vector<InterfaceFluxObservation> interface_fluxes;
    std::vector<ReactionObservation> reaction_channels;
    std::vector<Vector3> transport_gilbert_torque_per_s;
    Diagnostics diagnostics;
    Provenance provenance;
};

enum class Status : std::uint32_t {
    ok = 0,
    invalid_argument = 1,
    unsupported_model = 2,
    singular_operator = 3,
    did_not_converge = 4,
    balance_failure = 5,
    numerical_failure = 6,
};

struct SolveResult {
    Status status = Status::invalid_argument;
    std::string message;
    Solution solution;

    bool ok() const noexcept { return status == Status::ok; }
};

SolveResult solve(const Problem &problem, const SolverOptions &options = {});

} // namespace fullmag::fdm::cpu::transport::spin::v1
