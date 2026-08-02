#pragma once

#include "cpu/mfem/transport/conservative_constraint_rank.hpp"
#include "cpu/mfem/transport/periodic_charge_potential.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <variant>
#include <vector>

namespace mfem {
class Coefficient;
class FiniteElementSpace;
class GridFunction;
class Mesh;
} // namespace mfem

namespace fullmag::fem::transport {

struct ClosedGeometryCurrentClosure {
    std::string operator_version;
    std::string revision;
    std::string digest;
    std::vector<PeriodicCurrentSourceCut> source_cuts;
};

struct ExternalLeadInterfacePair {
    std::array<std::uint64_t, 3> transport_face_vertex_ids{};
    std::array<std::uint64_t, 3> lead_face_vertex_ids{};
};

struct ExternalLeadExtensionCurrentClosure {
    std::string operator_version;
    std::string revision;
    std::string digest;
    std::string drive_id;
    double outer_electrode_potential_drop_v = 0.0;
    mfem::Mesh *lead_mesh = nullptr;
    mfem::Coefficient *lead_conductivity = nullptr;
    std::string lead_conductivity_digest;
    StableMeshVertexIdentities lead_vertex_identities;
    std::vector<ExternalLeadInterfacePair> interface_pairs;
    std::vector<std::array<std::uint64_t, 3>> minus_outer_electrode_faces;
    std::vector<std::array<std::uint64_t, 3>> plus_outer_electrode_faces;
};

using ConservativeCurrentClosure = std::variant<
    ClosedGeometryCurrentClosure,
    ExternalLeadExtensionCurrentClosure>;

struct ConservativeCurrentIdentityInput {
    std::string source_module_id;
    std::string source_state_revision;
    std::string source_field_digest;
    std::string mesh_revision;
    std::string topology_revision;
    std::string geometry_digest;
    std::string envelope_revision;
    std::string envelope_digest;
    double evaluated_envelope_multiplier = 1.0;
    double evaluation_time_s = 0.0;
    std::uint64_t stage_identity = 0;
};

struct ConservativeCurrentPins {
    std::string required_source_state_revision;
    std::string required_source_field_digest;
    std::string required_mesh_revision;
    std::string required_topology_revision;
};

struct ConservativeCurrentBuildRequest {
    mfem::Mesh *mesh = nullptr;
    mfem::Coefficient *conductivity = nullptr;
    StableMeshVertexIdentities stable_vertex_identities;
    std::vector<ConservativeCurrentBoundaryFace> boundary_faces;
    ConservativeCurrentClosure closure;
    std::shared_ptr<const PeriodicChargePotentialSnapshot>
        periodic_charge_potential;
    const mfem::GridFunction *raw_single_valued_potential = nullptr;
    ConservativeCurrentIdentityInput identity;
    ConservativeCurrentPins pins;
    double algebraic_relative_tolerance = 1.0e-12;
    double physical_relative_gate = 1.0e-10;
    double physical_absolute_gate_a = 1.0e-18;
    bool external_lead_coupled_solve = false;
    bool reference_mpi_gather_broadcast = false;
};

struct ConservativeCurrentImportRequest {
    mfem::Mesh *mesh = nullptr;
    const mfem::GridFunction *rt0_field = nullptr;
    StableMeshVertexIdentities stable_vertex_identities;
    std::vector<ConservativeCurrentBoundaryFace> boundary_faces;
    ConservativeCurrentClosure closure;
    ConservativeCurrentIdentityInput identity;
    ConservativeCurrentPins pins;
    double physical_relative_gate = 1.0e-10;
    double physical_absolute_gate_a = 1.0e-18;
    double scaled_kkt_residual = 0.0;
    double correction_norm_mw = 0.0;
    bool require_independent_physical_certificate = false;
    bool reference_mpi_gather_broadcast = false;
};

struct CanonicalFaceFluxRecord {
    std::array<std::uint64_t, 3> face_vertex_ids{};
    double flux_a = 0.0;
};

struct ConservativeCurrentBalanceCertificate {
    double max_element_divergence_a = 0.0;
    double max_internal_face_jump_a = 0.0;
    double net_outer_flux_a = 0.0;
    double electrode_balance_relative = 0.0;
    double max_closure_interface_mismatch_a = 0.0;
    double scaled_kkt_residual = 0.0;
    double correction_norm_mw = 0.0;
    bool closure_complete = false;
};

struct ConservativeCurrentIdentity {
    std::string operator_version;
    std::string source_module_id;
    std::string source_state_revision;
    std::string source_field_digest;
    std::string mesh_revision;
    std::string topology_revision;
    std::string geometry_digest;
    std::string closure_revision;
    std::string closure_digest;
    std::string envelope_revision;
    std::string envelope_digest;
    double evaluated_envelope_multiplier = 1.0;
    double evaluation_time_s = 0.0;
    std::uint64_t stage_identity = 0;
    std::uint64_t canonical_face_record_count = 0;
    std::string face_record_payload_sha256;
    std::string canonical_face_digest;
    std::string balance_certificate_digest;
    std::string view_identity_digest;
};

class ConservativeCurrentView {
public:
    using Ptr = std::shared_ptr<const ConservativeCurrentView>;
    static constexpr const char *operator_version =
        "fem_conservative_current_rt0_view.v1";

    ~ConservativeCurrentView();
    ConservativeCurrentView(const ConservativeCurrentView &) = delete;
    ConservativeCurrentView &operator=(const ConservativeCurrentView &) = delete;
    ConservativeCurrentView(ConservativeCurrentView &&) = delete;
    ConservativeCurrentView &operator=(ConservativeCurrentView &&) = delete;

    static Ptr Build(const ConservativeCurrentBuildRequest &request);
    static Ptr Import(const ConservativeCurrentImportRequest &request);
    const mfem::FiniteElementSpace &space() const;
    const mfem::GridFunction &field() const;
    const ConservativeCurrentIdentity &identity() const;
    const ConservativeCurrentBalanceCertificate &balance() const;
    const ConstraintRankCertificate &constraint_rank_certificate() const;
    const std::vector<CanonicalFaceFluxRecord> &
        canonical_face_flux_records() const;
    const std::vector<std::uint8_t> &
        canonical_balance_certificate_bytes() const;
    bool canonical_face_flux_records_are_global_and_broadcast() const;

private:
    class Impl;
    explicit ConservativeCurrentView(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};

class ConservativeCurrentViewOwner {
public:
    explicit ConservativeCurrentViewOwner(
        mfem::GridFunction &nodal_visualization);
    ~ConservativeCurrentViewOwner();
    ConservativeCurrentViewOwner(const ConservativeCurrentViewOwner &) = delete;
    ConservativeCurrentViewOwner &operator=(
        const ConservativeCurrentViewOwner &) = delete;
    ConservativeCurrentViewOwner(ConservativeCurrentViewOwner &&) = delete;
    ConservativeCurrentViewOwner &operator=(
        ConservativeCurrentViewOwner &&) = delete;

    ConservativeCurrentView::Ptr conservative_charge_current() const;
    const mfem::GridFunction &charge_current_density() const;
    void publish_accepted(ConservativeCurrentView::Ptr accepted);

private:
    mfem::GridFunction *nodal_visualization_ = nullptr;
    ConservativeCurrentView::Ptr accepted_;
};

} // namespace fullmag::fem::transport
