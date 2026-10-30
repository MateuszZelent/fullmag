#pragma once

#include <mfem.hpp>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace fullmag::fem::frequency_domain {

class TrackingMassCsrSnapshot;
struct TrackingMassProviderResult;

enum class TrackingMassProviderStatus {
    success,
    invalid_argument,
    unsupported_space,
    empty_magnetic_domain,
    assembly_failed,
    invalid_matrix,
};

class TrackingMassCsrSnapshot final {
public:
    const std::vector<std::size_t> &row_offsets() const noexcept { return row_offsets_; }
    const std::vector<std::uint32_t> &column_indices() const noexcept { return column_indices_; }
    const std::vector<double> &values_m3() const noexcept { return values_m3_; }
    const std::vector<std::uint32_t> &canonical_vertex_ids() const noexcept
    {
        return canonical_vertex_ids_;
    }
    const std::vector<std::uint32_t> &scalar_dof_ids() const noexcept { return scalar_dof_ids_; }
    double magnetic_volume_m3() const noexcept { return magnetic_volume_m3_; }
    std::size_t rows() const noexcept { return canonical_vertex_ids_.size(); }

private:
    friend TrackingMassProviderResult assemble_consistent_p1_tracking_mass(
        mfem::FiniteElementSpace &space,
        const std::vector<int> &magnetic_volume_attributes);

    TrackingMassCsrSnapshot(
        std::vector<std::size_t> row_offsets,
        std::vector<std::uint32_t> column_indices,
        std::vector<double> values_m3,
        std::vector<std::uint32_t> canonical_vertex_ids,
        std::vector<std::uint32_t> scalar_dof_ids,
        double magnetic_volume_m3);

    std::vector<std::size_t> row_offsets_;
    std::vector<std::uint32_t> column_indices_;
    std::vector<double> values_m3_;
    std::vector<std::uint32_t> canonical_vertex_ids_;
    std::vector<std::uint32_t> scalar_dof_ids_;
    double magnetic_volume_m3_;
};

struct TrackingMassProviderResult {
    TrackingMassProviderStatus status{TrackingMassProviderStatus::assembly_failed};
    std::unique_ptr<const TrackingMassCsrSnapshot> snapshot;
    std::string diagnostic;

    bool ok() const noexcept
    {
        return status == TrackingMassProviderStatus::success && snapshot != nullptr;
    }
};

// Assemble the unweighted geometric P1 metric on exactly the requested MFEM
// volume attributes. Preserve every canonical physical vertex row; vertices
// outside the selected domain have empty, exactly zero rows.
// The input space must retain canonical scalar vertex DOFs.
TrackingMassProviderResult assemble_consistent_p1_tracking_mass(
    mfem::FiniteElementSpace &space,
    const std::vector<int> &magnetic_volume_attributes);

} // namespace fullmag::fem::frequency_domain
