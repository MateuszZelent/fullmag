#pragma once

#include "cpu/mfem/transport/terminal_constrained_rt0_projection.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/charge_terminal_current_constraints.hpp"

namespace fullmag::fem::antenna_field_solve {

struct AcceptedTerminalChargeRequest {
    mfem::Mesh *mesh = nullptr;
    transport::StableMeshVertexIdentities stable_vertex_identities;
    std::vector<double> conductivity_spm_per_element;
    std::vector<ResolvedChargeTerminal> terminals;
    std::vector<transport::Rt0InterfaceFacePair> interface_pairs;
    std::vector<transport::AffineTraceRelation> trace_relations;
    double absolute_jump_tolerance_v = 1.0e-12;
    double relative_jump_tolerance = 1.0e-12;
    double algebraic_relative_tolerance = 1.0e-12;
    int maximum_iterations = 1000;
};

// One frozen open-terminal V/material/RT0 result, not a closed Oersted source.
class AcceptedTerminalChargeSource {
public:
    using Ptr = std::shared_ptr<const AcceptedTerminalChargeSource>;
    static constexpr const char *operator_version = "fem_accepted_terminal_charge_source.v1";
    static constexpr const char *digest_schema = "accepted_terminal_charge_source.ordered.v1";
    static constexpr std::uint64_t maximum_digest_preimage_bytes = std::uint64_t{128} << 20;
    ~AcceptedTerminalChargeSource();
    AcceptedTerminalChargeSource(const AcceptedTerminalChargeSource &) = delete;
    AcceptedTerminalChargeSource &operator=(const AcceptedTerminalChargeSource &) = delete;

    const ChargeTerminalCurrentSolution &terminal_solution() const;
    const transport::TerminalConstrainedRt0Projection &rt0_projection() const;
    const mfem::GridFunction &potential() const;
    const std::vector<double> &conductivity_spm_per_element() const;
    const std::vector<transport::Rt0InterfaceFacePair> &interface_pairs() const;
    const std::string &content_digest() const;
    const std::string &canonical_content_bytes() const;

private:
    class Impl;
    explicit AcceptedTerminalChargeSource(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
    friend Ptr solve_accepted_terminal_charge_source(const AcceptedTerminalChargeRequest &request);
};

AcceptedTerminalChargeSource::Ptr solve_accepted_terminal_charge_source(
    const AcceptedTerminalChargeRequest &request);

} // namespace fullmag::fem::antenna_field_solve
