#include "frequency_domain/canonical_digest.hpp"
#include "frequency_domain/linearized_dynamic_pencil.hpp"

#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {
void check(bool condition, const char *message) { if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); } }
void check_close(std::complex<double> actual, std::complex<double> expected, const char *message) { check(std::abs(actual - expected) < 1.0e-12, message); }

fd::LinearizedDynamicPencil nonnormal_pencil()
{
    fd::DynamicPencilMetadata metadata{};
    metadata.gamma0_m_per_a_s = 2.211e5;
    return fd::LinearizedDynamicPencil::from_dense_row_major(metadata, 2,
        {{2.0, 0.0}, {3.0, 0.0}, {0.0, 0.0}, {5.0, 0.0}},
        {{1.0, 0.0}, {0.25, 0.0}, {0.0, 0.0}, {2.0, 0.0}}, "nonnormal-v1");
}

void reference_and_fused_aomega_match_for_both_phasors()
{
    const auto pencil = nonnormal_pencil();
    const std::vector<std::complex<double>> x = {{0.7, -0.2}, {-0.4, 1.1}};
    for (const auto phase : {fd::FrequencyDomainPhaseConvention::exp_i_omega_t, fd::FrequencyDomainPhaseConvention::exp_minus_i_omega_t}) {
        std::vector<std::complex<double>> reference, fused;
        check(pencil.apply_Aomega(4.0, phase, x, &reference) == fd::FrequencyDomainStatus::ok, "reference Aomega must apply");
        check(pencil.apply_fused_Aomega(4.0, phase, x, &fused) == fd::FrequencyDomainStatus::ok, "fused Aomega must apply");
        check(reference.size() == fused.size(), "Aomega results must have equal extent");
        for (std::size_t i = 0; i < reference.size(); ++i) check_close(fused[i], reference[i], "fused Aomega must match canonical reference");
    }
}

void adjoint_actions_obey_the_complex_inner_product_identity()
{
    const auto pencil = nonnormal_pencil();
    const std::vector<std::complex<double>> x = {{0.2, -0.9}, {1.3, 0.4}}, y = {{-0.6, 0.7}, {0.5, -0.1}};
    std::vector<std::complex<double>> ax, ahy;
    check(pencil.apply_Aomega(3.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t, x, &ax) == fd::FrequencyDomainStatus::ok, "forward Aomega must apply");
    check(pencil.apply_Aomega_adjoint(3.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t, y, &ahy) == fd::FrequencyDomainStatus::ok, "adjoint Aomega must apply");
    std::complex<double> lhs{}, rhs{};
    for (std::size_t i = 0; i < x.size(); ++i) { lhs += std::conj(y[i]) * ax[i]; rhs += std::conj(ahy[i]) * x[i]; }
    check_close(lhs, rhs, "Aomega adjoint must satisfy the complex inner-product identity");
}

void digest_changes_when_each_physical_dependency_changes()
{
    const auto base = nonnormal_pencil();
    const auto digest = base.digest();
    check(fd::LinearizedDynamicPencil::from_dense_row_major(base.metadata(), 2, {{2.0, 0.0}, {3.0, 0.0}, {0.0, 0.0}, {5.0, 0.0}}, {{1.0, 0.0}, {0.25, 0.0}, {0.0, 0.0}, {2.0, 0.0}}, "nonnormal-v2").digest() != digest, "canonical operator identity must bind the versioned dependency descriptor");
    auto metadata = base.metadata(); metadata.gamma0_m_per_a_s *= 1.01;
    check(fd::LinearizedDynamicPencil::from_dense_row_major(metadata, 2, {{2.0, 0.0}, {3.0, 0.0}, {0.0, 0.0}, {5.0, 0.0}}, {{1.0, 0.0}, {0.25, 0.0}, {0.0, 0.0}, {2.0, 0.0}}, "nonnormal-v1").digest() != digest, "operator digest must bind metadata");
}

void digest_field_types_remain_distinct()
{
    fd::CanonicalDigestBuilder integer("typed-fields.v1"), floating("typed-fields.v1");
    integer.add_u64("value", 1);
    floating.add_double("value", 1.0);
    check(integer.sha256_hex() != floating.sha256_hex(),
          "canonical u64 and double fields must have distinct type tags");
}

void canonical_digest_known_vector_is_stable_across_language_boundaries()
{
    fd::CanonicalDigestBuilder digest("mfem_linearized_jvp_dependencies.v2");
    digest.add_string("label", "cross-language");
    digest.add_u64("count", 7);
    digest.add_double("negative_zero", -0.0);
    digest.add_double("nan", std::numeric_limits<double>::quiet_NaN());
    constexpr std::uint8_t bytes[] = {0x01, 0x02, 0xfe};
    digest.add_bytes("bytes", bytes, sizeof(bytes));
    check(digest.sha256_hex() == "1167f46ac77502f652f4fc5464070023419244dbd654d907970bd73e504afcbc",
          "canonical digest known vector must remain stable across the native and Rust boundary");
}

void macrospin_eigenvalue_and_driven_residual_use_the_same_pencil()
{
    fd::DynamicPencilMetadata metadata{};
    metadata.gamma0_m_per_a_s = 2.211e5;
    constexpr double omega_rad_per_s = 7.0;
    const auto pencil = fd::LinearizedDynamicPencil::from_dense_row_major(
        metadata, 1, {{0.0, omega_rad_per_s}}, {{1.0, 0.0}}, "macrospin-v1");
    std::vector<std::complex<double>> residual;
    check(pencil.apply_Aomega(omega_rad_per_s,
                              fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                              {{1.0, 0.0}},
                              &residual) == fd::FrequencyDomainStatus::ok,
          "macrospin driven residual must apply through the pencil");
    check_close(residual[0], {0.0, 0.0},
                "macrospin eigenvalue must null the same driven Aomega pencil");
}

struct RealCallbackOperator { double l[4]; double b[4]; };
fd::FrequencyDomainStatus apply_real_l(void *context, const double *in, double *out, char[128]) noexcept { const auto *op = static_cast<const RealCallbackOperator *>(context); for (int r = 0; r < 2; ++r) out[r] = op->l[2 * r] * in[0] + op->l[2 * r + 1] * in[1]; return fd::FrequencyDomainStatus::ok; }
fd::FrequencyDomainStatus apply_real_b(void *context, const double *in, double *out, char[128]) noexcept { const auto *op = static_cast<const RealCallbackOperator *>(context); for (int r = 0; r < 2; ++r) out[r] = op->b[2 * r] * in[0] + op->b[2 * r + 1] * in[1]; return fd::FrequencyDomainStatus::ok; }
fd::FrequencyDomainStatus apply_real_pair(void *context, const double *in, double *out_l, double *out_b, char error[128]) noexcept { const auto l = apply_real_l(context, in, out_l, error); return l == fd::FrequencyDomainStatus::ok ? apply_real_b(context, in, out_b, error) : l; }
void matrix_free_real_split_is_the_same_canonical_aomega()
{
    fd::DynamicPencilMetadata metadata{};
    RealCallbackOperator op{{2.0, 3.0, 0.0, 5.0}, {1.0, .25, 0.0, 2.0}};
    const auto pencil = fd::LinearizedDynamicPencil::from_real_callbacks(
        metadata, 2, {&op, apply_real_l, apply_real_b, nullptr, nullptr},
        "real-callback-dependencies.v1", "test_real_callback.v1");
    const double real[] = {.7, -.4}, imag[] = {-.2, 1.1};
    double out_real[2]{}, out_imag[2]{}, b_real[2]{}, b_imag[2]{};
    char error[128]{};
    check(pencil.apply_Aomega_real_split(4.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                                         real, imag, out_real, out_imag,
                                         out_real, out_imag, b_real, b_imag, error) == fd::FrequencyDomainStatus::ok,
          "matrix-free real callback Aomega applies without materialization");
    std::vector<std::complex<double>> expected;
    const auto dense = fd::LinearizedDynamicPencil::from_dense_row_major(
        metadata, 2, {{2.0, 0.0}, {3.0, 0.0}, {0.0, 0.0}, {5.0, 0.0}},
        {{1.0, 0.0}, {.25, 0.0}, {0.0, 0.0}, {2.0, 0.0}}, "real-callback-dependencies.v1");
    check(dense.apply_Aomega(4.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                             {{.7, -.2}, {-.4, 1.1}}, &expected) == fd::FrequencyDomainStatus::ok,
          "dense canonical Aomega applies");
    std::vector<std::complex<double>> callback_reference;
    check(pencil.apply_Aomega(4.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                              {{.7, -.2}, {-.4, 1.1}}, &callback_reference) == fd::FrequencyDomainStatus::ok,
          "callback reference Aomega applies");
    check_close(callback_reference[0], expected[0], "callback reference matches dense Aomega row 0");
    check_close(callback_reference[1], expected[1], "callback reference matches dense Aomega row 1");
    check_close({out_real[0], out_imag[0]}, expected[0], "matrix-free real split matches dense Aomega row 0");
    check_close({out_real[1], out_imag[1]}, expected[1], "matrix-free real split matches dense Aomega row 1");

    const auto paired = fd::LinearizedDynamicPencil::from_real_callbacks(
        metadata, 2, {&op, nullptr, nullptr, nullptr, nullptr, apply_real_pair},
        "real-callback-dependencies.v1", "test_real_callback.v1");
    check(paired.digest() == dense.digest(),
          "dense modal and callback driven pencils with one dependency descriptor must publish one canonical identity");
    check(paired.representation_digest() != dense.representation_digest(),
          "dense and callback implementations must retain distinct representation identities");
    check(paired.apply_Aomega_real_split(4.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                                         real, imag, out_real, out_imag,
                                         out_real, out_imag, b_real, b_imag, error) == fd::FrequencyDomainStatus::ok,
          "paired callback Aomega applies without materialization");
    check(paired.apply_Aomega(4.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                              {{.7, -.2}, {-.4, 1.1}}, &callback_reference) == fd::FrequencyDomainStatus::ok,
          "paired callback reference Aomega applies");
    check_close(callback_reference[0], expected[0], "paired callback reference matches dense Aomega row 0");
    check_close(callback_reference[1], expected[1], "paired callback reference matches dense Aomega row 1");
    check_close({out_real[0], out_imag[0]}, expected[0], "paired callback matches dense Aomega row 0");
    check_close({out_real[1], out_imag[1]}, expected[1], "paired callback matches dense Aomega row 1");

    std::vector<std::complex<double>> unavailable_adjoint;
    check(paired.apply_Aomega_adjoint(4.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                                      {{.7, -.2}, {-.4, 1.1}}, &unavailable_adjoint) == fd::FrequencyDomainStatus::unavailable,
          "callback pencil without adjoint callbacks must explicitly report unavailable");
}

void callback_pencil_representation_digest_binds_operator_source()
{
    fd::DynamicPencilMetadata metadata{};
    RealCallbackOperator op{{2.0, 3.0, 0.0, 5.0}, {1.0, .25, 0.0, 2.0}};
    const auto first = fd::LinearizedDynamicPencil::from_real_callbacks(
        metadata, 2, {&op, apply_real_l, apply_real_b, nullptr, nullptr},
        "real-callback-dependencies.v1", "mfem_linearized_cpu_jvp.v1");
    const auto second = fd::LinearizedDynamicPencil::from_real_callbacks(
        metadata, 2, {&op, apply_real_l, apply_real_b, nullptr, nullptr},
        "real-callback-dependencies.v1", "mfem_linearized_cpu_jvp.v2");
    check(first.digest() == second.digest(),
          "callback source must not change the published semantic operator identity");
    check(first.representation_digest() != second.representation_digest(),
          "callback representation identity must bind the immutable operator source");
}

void unavailable_callback_operator_stays_unavailable()
{
    fd::DynamicPencilMetadata metadata{};
    const auto pencil = fd::LinearizedDynamicPencil::from_real_callbacks(
        metadata, 1, {}, "missing-callbacks.v1", "test_missing_callback.v1");
    std::vector<std::complex<double>> out;
    check(pencil.apply_Aomega(1.0, fd::FrequencyDomainPhaseConvention::exp_i_omega_t,
                              {{1.0, 0.0}}, &out) == fd::FrequencyDomainStatus::unavailable,
          "missing callback operator must remain unavailable");
}
} // namespace
int main() { reference_and_fused_aomega_match_for_both_phasors(); adjoint_actions_obey_the_complex_inner_product_identity(); digest_changes_when_each_physical_dependency_changes(); digest_field_types_remain_distinct(); canonical_digest_known_vector_is_stable_across_language_boundaries(); macrospin_eigenvalue_and_driven_residual_use_the_same_pencil(); matrix_free_real_split_is_the_same_canonical_aomega(); callback_pencil_representation_digest_binds_operator_source(); unavailable_callback_operator_stays_unavailable(); }
