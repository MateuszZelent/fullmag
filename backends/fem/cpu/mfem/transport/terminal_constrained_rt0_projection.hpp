#pragma once

#include "cpu/mfem/transport/conservative_constraint_rank.hpp"
#include "cpu/mfem/transport/periodic_charge_potential.hpp"

#include <memory>

namespace mfem {
class VectorCoefficient;
}

namespace fullmag::fem::transport {

// Shared preflight before any owned snapshot or H1 assembly.
void validate_terminal_current_mesh(const mfem::Mesh &mesh);
void validate_terminal_current_identifier(const std::string &value);

struct Rt0TerminalFluxConstraint {
    std::string id;
    std::vector<std::array<std::uint64_t, 3>> boundary_face_vertex_ids;
    double measured_outward_current_a = 0.0;
};

struct Rt0InterfaceFacePair {
    std::string id;
    std::array<std::uint64_t, 3> first_face_vertex_ids{};
    std::array<std::uint64_t, 3> second_face_vertex_ids{};
    std::array<std::array<std::uint64_t, 2>, 3> vertex_pairs{};
};

// Geometric/topological preflight shared by H1 and RT0, without current placeholders.
void validate_terminal_current_interfaces(const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const std::vector<std::array<std::uint64_t, 3>> &terminal_faces,
    const std::vector<Rt0InterfaceFacePair> &interfaces);

struct Rt0InterfaceFluxMeasurement {
    std::string id;
    double first_outward_current_a = 0.0;
    double second_outward_current_a = 0.0;
    double mismatch_a = 0.0;
};

struct Rt0ElementFluxMeasurement {
    std::array<std::uint64_t, 4> vertex_ids{};
    double outward_flux_sum_a = 0.0;
    double absolute_flux_sum_a = 0.0;
};

struct Rt0FaceFluxMeasurement {
    std::array<std::uint64_t, 3> vertex_ids{};
    std::uint8_t side_count = 0;
    double canonical_flux_a = 0.0;
    double first_outward_flux_a = 0.0;
    double second_outward_flux_a = 0.0;
    double canonical_jump_a = 0.0;
    double rt0_dof_to_canonical_flux_weight = 0.0;
};

// Independently integrated local quantities; no claim of a closed physical circuit.
struct TerminalRt0PhysicalMeasurements {
    std::vector<Rt0ElementFluxMeasurement> elements;
    std::vector<Rt0FaceFluxMeasurement> faces;
    std::vector<double> terminal_outward_currents_a;
    std::vector<Rt0InterfaceFluxMeasurement> interfaces;
};

// A numerical projection, not an accepted charge/closure/Oersted source.
class TerminalConstrainedRt0Projection {
public:
    using Ptr = std::shared_ptr<const TerminalConstrainedRt0Projection>;
    ~TerminalConstrainedRt0Projection();
    TerminalConstrainedRt0Projection(const TerminalConstrainedRt0Projection &) = delete;
    TerminalConstrainedRt0Projection &operator=(const TerminalConstrainedRt0Projection &) = delete;

    const mfem::GridFunction &field() const;
    const StableMeshVertexIdentities &stable_vertex_identities() const;
    const ConstraintRankCertificate &constraint_rank_certificate() const;
    const std::vector<std::string> &terminal_ids() const;
    const std::vector<double> &measured_outward_currents_a() const;
    const std::vector<double> &current_residuals_a() const;
    const std::vector<Rt0InterfaceFluxMeasurement> &interface_flux_measurements() const;
    const std::vector<Rt0TerminalFluxConstraint> &terminal_constraints() const;
    const std::vector<Rt0InterfaceFacePair> &interface_pairs() const;
    double scaled_kkt_residual() const;
    double correction_norm_mw() const;

private:
    class Impl;
    explicit TerminalConstrainedRt0Projection(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
    friend Ptr project_terminal_constrained_rt0(mfem::Mesh &mesh,
        const StableMeshVertexIdentities &ids, mfem::VectorCoefficient &raw_current,
        mfem::Coefficient &conductivity, const std::vector<Rt0TerminalFluxConstraint> &terminals,
        const std::vector<Rt0InterfaceFacePair> &interfaces);
    friend Ptr project_terminal_constrained_rt0_owned(std::unique_ptr<mfem::Mesh> mesh,
        const StableMeshVertexIdentities &ids, mfem::VectorCoefficient &raw_current,
        mfem::Coefficient &conductivity, const std::vector<Rt0TerminalFluxConstraint> &terminals,
        const std::vector<Rt0InterfaceFacePair> &interfaces);
};

TerminalRt0PhysicalMeasurements measure_terminal_current_projection(
    const TerminalConstrainedRt0Projection &projection);

TerminalConstrainedRt0Projection::Ptr project_terminal_constrained_rt0(
    mfem::Mesh &mesh, const StableMeshVertexIdentities &ids,
    mfem::VectorCoefficient &raw_current, mfem::Coefficient &conductivity,
    const std::vector<Rt0TerminalFluxConstraint> &terminals,
    const std::vector<Rt0InterfaceFacePair> &interfaces = {});

// Consumes one mesh; callers must not retain dependent FE spaces during transfer.
TerminalConstrainedRt0Projection::Ptr project_terminal_constrained_rt0_owned(
    std::unique_ptr<mfem::Mesh> mesh, const StableMeshVertexIdentities &ids,
    mfem::VectorCoefficient &raw_current, mfem::Coefficient &conductivity,
    const std::vector<Rt0TerminalFluxConstraint> &terminals,
    const std::vector<Rt0InterfaceFacePair> &interfaces = {});

} // namespace fullmag::fem::transport
