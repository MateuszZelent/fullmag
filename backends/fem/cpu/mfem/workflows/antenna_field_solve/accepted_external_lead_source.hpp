#pragma once

#include "cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.hpp"
#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"

namespace fullmag::fem::antenna_field_solve {

enum class ExternalLeadSourceBoundaryRole : std::uint8_t {
    Insulating = 1,
    OuterElectrode = 2,
    DeviceLeadInterface = 3,
};

struct ExternalLeadSourceBoundaryFace {
    std::array<std::uint64_t, 3> vertex_ids{};
    ExternalLeadSourceBoundaryRole role = ExternalLeadSourceBoundaryRole::Insulating;
    std::string circuit_id;
};

struct ExternalLeadBranchObservation {
    std::string id;
    std::vector<std::string> interface_pair_ids;
    double requested_device_outward_current_a = 0.0;
};

struct AcceptedExternalLeadSourceRequest {
    AcceptedTerminalChargeSource::Ptr accepted_source;
    std::string required_charge_content_digest;
    std::string closure_revision;
    std::vector<std::uint64_t> device_vertex_ids;
    std::vector<std::uint64_t> lead_vertex_ids;
    std::vector<ExternalLeadSourceBoundaryFace> boundary_faces;
    std::vector<ExternalLeadBranchObservation> branch_observations;
};

struct ExternalLeadBranchCurrentMeasurement {
    std::string id;
    double requested_outward_current_a = 0.0;
    double h1_outward_current_a = 0.0;
    double rt0_outward_current_a = 0.0;
};

struct ExternalLeadComponentCurrentMeasurement {
    std::uint64_t component_vertex_id = 0;
    double requested_outward_current_sum_a = 0.0;
    double h1_outward_current_sum_a = 0.0;
    double rt0_outward_current_sum_a = 0.0;
};

// A certified modeled-domain contribution, NOT a complete closed circuit.
class AcceptedExternalLeadCurrentSource {
public:
    using Ptr = std::shared_ptr<const AcceptedExternalLeadCurrentSource>;
    static constexpr const char *operator_version = "fem_accepted_external_lead_current_source.v2";
    static constexpr const char *field_scope = "external_electrode_truncation";
    static constexpr const char *digest_schema = "accepted_external_lead_current_source.ordered.v2";
    ~AcceptedExternalLeadCurrentSource();
    AcceptedExternalLeadCurrentSource(const AcceptedExternalLeadCurrentSource &) = delete;
    AcceptedExternalLeadCurrentSource &operator=(const AcceptedExternalLeadCurrentSource &) = delete;

    static Ptr Finalize(const AcceptedExternalLeadSourceRequest &request);
    const AcceptedTerminalChargeSource &charge_source() const;
    const transport::TerminalRt0PhysicalMeasurements &physical_measurements() const;
    const std::vector<ExternalLeadBranchCurrentMeasurement> &branch_measurements() const;
    const std::vector<ExternalLeadComponentCurrentMeasurement> &component_measurements() const;
    const std::string &content_digest() const;
    const std::string &canonical_content_bytes() const;

private:
    class Impl;
    explicit AcceptedExternalLeadCurrentSource(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};

struct AcceptedExternalLeadFieldResult {
    oersted::DirectTetraQuadratureResult quadrature;
    std::string accepted_external_source_digest;
    std::string field_scope;
    std::string charge_content_digest;
    std::string operator_version;
    std::string evaluation_content_digest;
    std::string canonical_evaluation_bytes;
};

AcceptedExternalLeadFieldResult evaluate_accepted_external_lead_field(
    const AcceptedExternalLeadCurrentSource &source,
    const std::vector<std::array<double, 3>> &target_points,
    const oersted::DirectTetraQuadratureOptions &options = {});

struct AcceptedExternalLeadBundle {
    static constexpr const char *operator_version = "fem_accepted_external_lead_bundle.v1";
    static constexpr const char *digest_schema = "accepted_external_lead_bundle.ordered.v1";
    std::string content_digest;
    std::string canonical_content_bytes;
};

// Closure must not carry an existing owner/pin: this workflow resolves both.
AcceptedExternalLeadBundle solve_accepted_external_lead_bundle(
    const AcceptedTerminalChargeRequest &charge_request,
    AcceptedExternalLeadSourceRequest closure_request,
    const std::vector<std::array<double, 3>> &target_points,
    const oersted::DirectTetraQuadratureOptions &options = {});

} // namespace fullmag::fem::antenna_field_solve
