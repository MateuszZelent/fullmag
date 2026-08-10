#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace fullmag::fdm::cpu::transport::v1 {

inline constexpr std::string_view api_version = "fullmag.fdm.cpu.charge.v1";
inline constexpr std::string_view operator_version = "fv_charge_harmonic_v1";
inline constexpr std::string_view mixing_operator_version =
    "fv_charge_mixing_series_trace.v1";
inline constexpr std::string_view solver_version = "fdm_charge_cg_matrix_free_v1";
inline constexpr std::string_view residual_version = "charge_balance_integrated_l2.v1";

enum class Face : std::uint32_t {
    x_min = 0,
    x_max = 1,
    y_min = 2,
    y_max = 3,
    z_min = 4,
    z_max = 5,
};

enum class BoundaryKind : std::uint32_t {
    unset = 0,
    insulating = 1,
    voltage_electrode = 2,
    total_current_electrode = 3,
    specified_outward_current_density = 4,
};

struct BoundaryCondition {
    BoundaryKind kind = BoundaryKind::unset;
    double value = 0.0;

    static BoundaryCondition insulating() noexcept;
    static BoundaryCondition voltage(double potential_v) noexcept;
    static BoundaryCondition total_current(double outward_current_a) noexcept;
    static BoundaryCondition specified_outward_current_density() noexcept;
};

struct BoundaryConditions {
    std::array<BoundaryCondition, 6> values{};

    BoundaryCondition &operator[](Face face) noexcept;
    const BoundaryCondition &operator[](Face face) const noexcept;
};

enum class Gauge : std::uint32_t {
    none = 0,
    zero_mean = 1,
};

struct Grid {
    std::size_t nx = 0;
    std::size_t ny = 0;
    std::size_t nz = 0;
    double dx_m = 0.0;
    double dy_m = 0.0;
    double dz_m = 0.0;
};

struct StructuredFace {
    std::size_t axis = 0;
    std::size_t negative_cell = 0;
    std::size_t positive_cell = 0;
};

struct OrientedMixingInterface {
    StructuredFace face;
    std::size_t from_cell = 0;
    std::size_t to_cell = 0;
    double g_up_s_per_m2 = 0.0;
    double g_down_s_per_m2 = 0.0;

    static OrientedMixingInterface one_way(StructuredFace face,
                                           std::size_t from_cell,
                                           std::size_t to_cell,
                                           double g_up_s_per_m2,
                                           double g_down_s_per_m2) noexcept;
};

struct StructuredExternalFace {
    std::size_t axis = 0;
    std::size_t face_index = 0;
    std::size_t adjacent_cell = 0;
    std::int32_t outward_normal_sign = 0;
    double area_m2 = 0.0;
};

struct SpecifiedOutwardCurrentDensityFace {
    StructuredExternalFace face;
    double outward_current_density_a_per_m2 = 0.0;
};

struct Problem {
    Grid grid;
    std::vector<double> conductivity_s_per_m;
    std::vector<std::uint8_t> active_cells;
    BoundaryConditions boundary;
    Gauge gauge = Gauge::none;
    std::vector<OrientedMixingInterface> interfaces;
    std::vector<SpecifiedOutwardCurrentDensityFace>
        specified_outward_current_density_faces;
};

struct SolverOptions {
    double relative_tolerance = 1.0e-12;
    double absolute_tolerance_a_per_m3 = 1.0e-14;
    std::size_t max_iterations = 10000;
};

struct FaceCurrentDensity {
    std::vector<double> x;
    std::vector<double> y;
    std::vector<double> z;
};

using CellCurrentDensity = std::array<double, 3>;

std::vector<CellCurrentDensity>
reconstruct_cell_current_density(const Grid &grid,
                                 const FaceCurrentDensity &face_current_density);

struct ChargeInterfaceFluxObservation {
    StructuredFace face;
    std::size_t from_cell = 0;
    std::size_t to_cell = 0;
    double g_up_s_per_m2 = 0.0;
    double g_down_s_per_m2 = 0.0;
    double from_potential_trace_v = 0.0;
    double to_potential_trace_v = 0.0;
    double delta_potential_trace_v = 0.0;
    double from_to_current_density_a_per_m2 = 0.0;
    double global_face_current_density_a_per_m2 = 0.0;
};

struct SolveResult;

class AcceptedChargeSnapshot {
  public:
    std::uint64_t identity() const noexcept { return identity_; }
    const Grid &grid() const noexcept { return grid_; }
    const std::vector<double> &conductivity_s_per_m() const noexcept {
        return conductivity_s_per_m_;
    }
    const std::vector<std::uint8_t> &active_cells() const noexcept {
        return active_cells_;
    }
    const std::vector<double> &potential_v() const noexcept { return potential_v_; }
    const FaceCurrentDensity &face_current_density_a_per_m2() const noexcept {
        return face_current_density_a_per_m2_;
    }
    const std::vector<OrientedMixingInterface> &interfaces() const noexcept {
        return interfaces_;
    }
    const std::vector<ChargeInterfaceFluxObservation> &interface_fluxes() const noexcept {
        return interface_fluxes_;
    }

  private:
    AcceptedChargeSnapshot(std::uint64_t identity,
                           Grid grid,
                           std::vector<double> conductivity_s_per_m,
                           std::vector<std::uint8_t> active_cells,
                           std::vector<double> potential_v,
                           FaceCurrentDensity face_current_density_a_per_m2,
                           std::vector<OrientedMixingInterface> interfaces,
                           std::vector<ChargeInterfaceFluxObservation> interface_fluxes);

    std::uint64_t identity_ = 0;
    Grid grid_;
    std::vector<double> conductivity_s_per_m_;
    std::vector<std::uint8_t> active_cells_;
    std::vector<double> potential_v_;
    FaceCurrentDensity face_current_density_a_per_m2_;
    std::vector<OrientedMixingInterface> interfaces_;
    std::vector<ChargeInterfaceFluxObservation> interface_fluxes_;

    friend SolveResult solve(const Problem &, const SolverOptions &);
};

struct Provenance {
    std::string_view api_version;
    std::string_view operator_version;
    std::string_view interface_operator_version;
    std::string_view solver_version;
    std::string_view residual_version;
};

struct Diagnostics {
    std::size_t iterations = 0;
    // Recursive CG residual retained for solver diagnostics.
    double algebraic_residual_l2_a_per_m3 = 0.0;
    double recomputed_algebraic_residual_l2_a_per_m3 = 0.0;
    double algebraic_tolerance_l2_a_per_m3 = 0.0;
    // Canonical physical balance is cell-volume integrated and therefore in A.
    double physical_balance_integrated_l2_a = 0.0;
    double physical_balance_tolerance_l2_a = 0.0;
    double max_cell_current_imbalance_a = 0.0;
    double max_cell_current_imbalance_tolerance_a = 0.0;
    std::vector<double> component_net_current_a;
    std::vector<double> component_balance_integrated_l2_a;
    std::vector<double> component_boundary_current_l1_a;
    std::vector<double> component_net_current_tolerance_a;
    double physical_residual_l2_a_per_m3 = 0.0;
    std::array<double, 6> boundary_outward_current_a{};
    double net_boundary_current_a = 0.0;
    double net_boundary_tolerance_a = 0.0;
    double boundary_current_l1_a = 0.0;
    double max_abs_divergence_a_per_m3 = 0.0;
};

struct ResolvedElectrodePotential {
    Face face = Face::x_min;
    double potential_v = 0.0;
    double prescribed_outward_current_a = 0.0;
};

struct Solution {
    std::vector<double> potential_v;
    FaceCurrentDensity face_current_density_a_per_m2;
    std::vector<ResolvedElectrodePotential> resolved_electrode_potentials;
    Diagnostics diagnostics;
    Provenance provenance;

    std::shared_ptr<const AcceptedChargeSnapshot> accepted_snapshot() const noexcept {
        return accepted_snapshot_;
    }

  private:
    std::shared_ptr<const AcceptedChargeSnapshot> accepted_snapshot_;
    friend SolveResult solve(const Problem &, const SolverOptions &);
};

enum class Status : std::uint32_t {
    ok = 0,
    invalid_argument = 1,
    missing_gauge = 2,
    incompatible_boundary_current = 3,
    singular_operator = 4,
    did_not_converge = 5,
    balance_failure = 6,
    numerical_failure = 7,
};

struct SolveResult {
    Status status = Status::invalid_argument;
    std::string message;
    Solution solution;

    bool ok() const noexcept { return status == Status::ok; }
};

SolveResult solve(const Problem &problem, const SolverOptions &options = {});

} // namespace fullmag::fdm::cpu::transport::v1
