#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace mfem {
class Coefficient;
class FiniteElementSpace;
class GridFunction;
class Mesh;
} // namespace mfem

namespace fullmag::fem::transport {

struct StableMeshVertexIdentities {
    std::string version;
    std::vector<std::uint64_t> local_to_stable;
};

enum class ConservativeCurrentBoundaryRole : std::uint8_t {
    InsulatingOuter = 1,
    SourceCut = 2,
    ClosureInterface = 3,
};

struct ConservativeCurrentBoundaryFace {
    int boundary_element = -1;
    ConservativeCurrentBoundaryRole role =
        ConservativeCurrentBoundaryRole::InsulatingOuter;
    std::string circuit_id;
};

struct PeriodicCurrentSourceCutFacePair {
    std::array<std::uint64_t, 3> minus_face_vertex_ids{};
    std::array<std::uint64_t, 3> plus_face_vertex_ids{};
};

struct PeriodicCurrentSourceCut {
    std::string id;
    std::array<double, 3> translation_m{};
    double potential_drop_v = 0.0;
    std::vector<PeriodicCurrentSourceCutFacePair> face_pairs;
};

struct PeriodicChargePotentialSolveRequest {
    mfem::Mesh *mesh = nullptr;
    mfem::Coefficient *conductivity = nullptr;
    StableMeshVertexIdentities stable_vertex_identities;
    std::vector<ConservativeCurrentBoundaryFace> boundary_faces;
    PeriodicCurrentSourceCut source_cut;
    std::string operator_version;
    std::string source_module_id;
    std::string source_state_revision;
    std::string source_field_digest;
    double evaluation_time_s = 0.0;
    std::uint64_t stage_identity = 0;
    std::string envelope_revision;
    std::string envelope_digest;
    double evaluated_envelope_multiplier = 1.0;
    std::string mesh_revision;
    std::string geometry_digest;
    std::string conductivity_digest;
    std::string source_cut_digest;
    double algebraic_relative_tolerance = 1.0e-12;
    int maximum_iterations = 1000;
    bool reference_mpi_gather_rank0_broadcast = false;
};

class PeriodicChargePotentialSnapshot {
public:
    ~PeriodicChargePotentialSnapshot();
    PeriodicChargePotentialSnapshot(const PeriodicChargePotentialSnapshot &) = delete;
    PeriodicChargePotentialSnapshot &operator=(
        const PeriodicChargePotentialSnapshot &) = delete;
    PeriodicChargePotentialSnapshot(PeriodicChargePotentialSnapshot &&) = delete;
    PeriodicChargePotentialSnapshot &operator=(
        PeriodicChargePotentialSnapshot &&) = delete;

    const mfem::FiniteElementSpace &potential_space() const;
    const mfem::GridFunction &potential_field() const;
    const StableMeshVertexIdentities &stable_vertex_identities() const;
    const std::string &operator_version() const;
    bool converged() const;
    double algebraic_relative_residual() const;
    double potential_jump_v() const;
    double gauge_mean_v() const;
    double max_paired_weak_flux_mismatch_a() const;
    const std::string &mesh_revision() const;
    const std::string &geometry_digest() const;
    const std::string &conductivity_digest() const;
    const std::string &source_cut_digest() const;
    const std::string &source_module_id() const;
    const std::string &source_state_revision() const;
    const std::string &source_field_digest() const;
    double evaluation_time_s() const;
    std::uint64_t stage_identity() const;
    const std::string &envelope_revision() const;
    const std::string &envelope_digest() const;
    double evaluated_envelope_multiplier() const;

private:
    class Impl;
    explicit PeriodicChargePotentialSnapshot(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
    friend class PeriodicChargePotentialSolver;
};

class PeriodicChargePotentialSolver {
public:
    static std::shared_ptr<const PeriodicChargePotentialSnapshot> Solve(
        const PeriodicChargePotentialSolveRequest &request);
};

} // namespace fullmag::fem::transport
