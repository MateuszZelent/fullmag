#pragma once

#include <mfem.hpp>

#include <array>
#include <limits>
#include <memory>

namespace fullmag::fem::transport {

enum class ChargeGauge {
    Missing,
    BoundaryReference,
    ZeroMeanPotential,
};

enum class SpinInterfaceModel {
    TransparentConformingH1,
    MixingBrokenH1,
};

enum class TransportConstitutiveModel {
    OneWay,
    Reciprocal,
};

struct SteadyTransportParameters {
    TransportConstitutiveModel constitutive_model = TransportConstitutiveModel::OneWay;
    double sigma_s_spm = 1.0;
    double sigma_parallel_spm = 1.0;
    double sigma_perpendicular_spm = 1.0;
    double sigma_ahe_spm = 0.0;
    double polarization_p = 0.0;
    double theta_sh = 0.0;
    double lambda_sf_m = 1.0;
    double lambda_j_m = std::numeric_limits<double>::infinity();
    double lambda_phi_m = std::numeric_limits<double>::infinity();
    double gamma_e_per_ts = 1.76085963023e11;
    double saturation_magnetization_apm = 1.0;
    double relative_tolerance = 1.0e-12;
    int maximum_iterations = 1000;
    SpinInterfaceModel interface_model = SpinInterfaceModel::TransparentConformingH1;
};

struct ChargeSolveDiagnostics {
    bool converged = false;
    int iterations = 0;
    double relative_residual = std::numeric_limits<double>::infinity();
    double net_boundary_current_a = std::numeric_limits<double>::infinity();
    std::array<double, 3> current_density_volume_average_apm2{};
};

struct SpinSolveDiagnostics {
    bool converged = false;
    int iterations = 0;
    double relative_residual = std::numeric_limits<double>::infinity();
    std::array<double, 3> boundary_spin_flux_a{};
    std::array<double, 3> reaction_integral_a{};
    std::array<double, 3> angular_momentum_balance_apm2{};
    std::array<double, 3> torque_volume_average_per_s{};
    double torque_l2_per_s = 0.0;
    std::array<double, 3> spin_potential_top_minus_bottom_v{};
};

struct ReciprocalSolveDiagnostics {
    ChargeSolveDiagnostics charge;
    SpinSolveDiagnostics spin;
};

// CPU-double M1/M2 reference oracle for transparent interfaces. It owns its MFEM spaces,
// forms, solves, projections and diagnostics; Context and mfem_bridge own none
// of this physics. Mixing/SML requires broken-H1 mortar coupling and is
// rejected until that separately versioned realization exists.
class SteadyTransportOracle {
public:
    static constexpr const char *formula_version =
        "transport_constitutive.one_way.fullmag.v1";
    static constexpr const char *operator_version =
        "fem_charge_spin_conforming_h1_p1.transparent.v1";

    SteadyTransportOracle(
        mfem::Mesh &mesh,
        mfem::Coefficient &charge_conductivity,
        mfem::VectorCoefficient &magnetization,
        const SteadyTransportParameters &parameters);
    ~SteadyTransportOracle();

    SteadyTransportOracle(const SteadyTransportOracle &) = delete;
    SteadyTransportOracle &operator=(const SteadyTransportOracle &) = delete;

    ChargeSolveDiagnostics solve_charge(
        const mfem::Array<int> &dirichlet_boundary_marker,
        mfem::Coefficient &boundary_potential,
        ChargeGauge gauge);

    SpinSolveDiagnostics solve_spin(
        const mfem::Array<int> &dirichlet_boundary_marker,
        mfem::VectorCoefficient *boundary_spin_potential);

    ReciprocalSolveDiagnostics solve_reciprocal(
        const mfem::Array<int> &charge_dirichlet_boundary_marker,
        mfem::Coefficient &boundary_potential,
        const mfem::Array<int> &spin_dirichlet_boundary_marker,
        mfem::VectorCoefficient *boundary_spin_potential,
        ChargeGauge gauge);

    const mfem::GridFunction &electric_potential() const;
    const mfem::GridFunction &charge_current_density() const;
    const mfem::GridFunction &spin_potential() const;
    const mfem::GridFunction &spin_current_tensor() const;
    const mfem::GridFunction &transport_torque() const;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace fullmag::fem::transport
