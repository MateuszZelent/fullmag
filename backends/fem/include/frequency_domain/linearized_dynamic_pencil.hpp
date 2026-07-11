#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"
#include "frequency_domain/mode_kinematics.hpp"

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem::frequency_domain {

using LinearizedDynamicPencilRealApply = FrequencyDomainStatus (*) (
    void *context,
    const double *in,
    double *out,
    char error_message[128]) noexcept;

using LinearizedDynamicPencilRealApplyPair = FrequencyDomainStatus (*) (
    void *context,
    const double *in,
    double *out_l,
    double *out_b_alpha,
    char error_message[128]) noexcept;

struct LinearizedDynamicPencilRealCallbacks {
    void *context = nullptr;
    LinearizedDynamicPencilRealApply apply_l = nullptr;
    LinearizedDynamicPencilRealApply apply_b_alpha = nullptr;
    LinearizedDynamicPencilRealApply apply_l_adjoint = nullptr;
    LinearizedDynamicPencilRealApply apply_b_alpha_adjoint = nullptr;
    // Allows a JVP that naturally produces L and B_alpha together to remain
    // one apply per real/imaginary half.  This is the reference path for the
    // MFEM JVP; separate callbacks remain supported for dense-style adapters.
    LinearizedDynamicPencilRealApplyPair apply_l_and_b_alpha = nullptr;
};

class LinearizedDynamicPencil {
public:
    static LinearizedDynamicPencil from_dense_row_major(
        const DynamicPencilMetadata &metadata,
        std::uint64_t dimension,
        std::vector<std::complex<double>> l,
        std::vector<std::complex<double>> b_alpha,
        std::string dependency_digest);

    // The callback context is externally lifetime-managed.  This value type
    // snapshots only immutable contract metadata and callback values; it never
    // owns MFEM workspaces or callback context state.
    static LinearizedDynamicPencil from_real_callbacks(
        const DynamicPencilMetadata &metadata,
        std::uint64_t dimension,
        LinearizedDynamicPencilRealCallbacks callbacks,
        std::string dependency_digest,
        std::string operator_source);

    [[nodiscard]] const DynamicPencilMetadata &metadata() const noexcept { return metadata_; }
    // Semantic provenance shared by every realization of the same MFEM
    // linearization. This is the identity published by modal, driven, and
    // true-residual diagnostics.
    [[nodiscard]] const std::string &digest() const noexcept { return digest_; }
    // Realization-specific identity. Dense entries and callback source belong
    // here so they cannot split the published semantic operator identity.
    [[nodiscard]] const std::string &representation_digest() const noexcept { return representation_digest_; }
    [[nodiscard]] const std::string &dependency_digest() const noexcept { return dependency_digest_; }
    [[nodiscard]] std::uint64_t dimension() const noexcept { return dimension_; }
    FrequencyDomainStatus apply_L(const std::vector<std::complex<double>> &in, std::vector<std::complex<double>> *out) const noexcept;
    FrequencyDomainStatus apply_B_alpha(const std::vector<std::complex<double>> &in, std::vector<std::complex<double>> *out) const noexcept;
    FrequencyDomainStatus apply_Aomega(double omega_rad_per_s, FrequencyDomainPhaseConvention phase, const std::vector<std::complex<double>> &in, std::vector<std::complex<double>> *out) const noexcept;
    FrequencyDomainStatus apply_fused_Aomega(double omega_rad_per_s, FrequencyDomainPhaseConvention phase, const std::vector<std::complex<double>> &in, std::vector<std::complex<double>> *out) const noexcept;
    // Dense pencils provide an exact conjugate adjoint. Callback pencils return
    // unavailable until their owner supplies a real adjoint implementation.
    FrequencyDomainStatus apply_Aomega_adjoint(double omega_rad_per_s, FrequencyDomainPhaseConvention phase, const std::vector<std::complex<double>> &in, std::vector<std::complex<double>> *out) const noexcept;
    FrequencyDomainStatus apply_Aomega_real_split(
        double omega_rad_per_s,
        FrequencyDomainPhaseConvention phase,
        const double *in_real,
        const double *in_imag,
        double *out_real,
        double *out_imag,
        double *l_real_workspace,
        double *l_imag_workspace,
        double *b_real_workspace,
        double *b_imag_workspace,
        char error_message[128]) const noexcept;

private:
    DynamicPencilMetadata metadata_{};
    std::uint64_t dimension_ = 0;
    std::vector<std::complex<double>> l_;
    std::vector<std::complex<double>> b_alpha_;
    LinearizedDynamicPencilRealCallbacks real_callbacks_{};
    bool has_real_callbacks_ = false;
    std::string digest_;
    std::string representation_digest_;
    std::string dependency_digest_;
};

} // namespace fullmag::fem::frequency_domain
