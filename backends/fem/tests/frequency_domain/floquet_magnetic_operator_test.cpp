#include "cpu/frequency_domain/operators/floquet_magnetic_operator.hpp"

#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;
using Complex = std::complex<double>;

static void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

static bool close(Complex a, Complex b) { return std::abs(a - b) < 1.0e-12; }

struct Fixture {
    std::vector<fd::TangentFrameNode> frames{2};
    std::vector<fd::FloquetTangentClassEntry> entries{2};
    fd::FloquetTangentConstraintRequest request{};
    Fixture()
    {
        entries[1].full_node = 1;
        entries[1].translation_m[0] = 1.0;
        request.frames = frames.data();
        request.full_node_count = frames.size();
        request.reduced_node_count = 1;
        request.entries = entries.data();
        request.entry_count = entries.size();
        request.k_rad_per_m[0] = std::acos(-1.0) / 2.0;
    }
};

static void phase_basis_and_adjoint()
{
    Fixture f;
    // Same physical tangent plane, different nodal basis.
    f.frames[1].e1[0] = 0.0; f.frames[1].e1[1] = 1.0;
    f.frames[1].e2[0] = -1.0; f.frames[1].e2[1] = 0.0;
    fd::FloquetTangentProlongation c;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::ok, "valid classes");
    const Complex q[2] = {{2.0, 1.0}, {-3.0, 0.5}};
    Complex full[4]{};
    check(c.prolong(q, 2, full, 4), "prolongation applies");
    check(close(full[0], q[0]) && close(full[1], q[1]), "representative unchanged");
    check(close(full[2], Complex(0.0, -1.0) * q[1]), "negative phase and e1 rotation");
    check(close(full[3], Complex(0.0, 1.0) * q[0]), "negative phase and e2 rotation");
    const Complex v[4] = {{1.0, 2.0}, {-1.0, 3.0}, {0.7, -0.8}, {-1.0, -4.0}};
    Complex reduced[2]{};
    check(c.restrict_adjoint(v, 4, reduced, 2), "adjoint applies");
    Complex lhs{}, rhs{};
    for (int i = 0; i < 4; ++i) { lhs += std::conj(full[i]) * v[i]; }
    for (int i = 0; i < 2; ++i) { rhs += std::conj(q[i]) * reduced[i]; }
    check(close(lhs, rhs), "complex adjoint identity");
    check(c.restrict_adjoint(full, 4, reduced, 2), "adjoint roundtrip applies");
    check(close(reduced[0], 2.0 * q[0]) && close(reduced[1], 2.0 * q[1]),
          "C adjoint sums class contributions without unphysical averaging");
}

static void exchange_chain_uses_phase_only()
{
    Fixture f;
    fd::FloquetTangentProlongation c;
    const double length = 1.7;
    const double theta = 0.37;
    f.entries[1].translation_m[0] = length;
    f.request.k_rad_per_m[0] = theta / length;
    const Complex q[2] = {{1.0, 0.0}, {0.0, 0.0}};
    Complex full[4]{}, applied[4]{}, reduced[2]{};
    for (const double sign : {-1.0, 1.0}) {
        f.request.k_rad_per_m[0] = sign * theta / length;
        check(c.initialize(f.request) == fd::FrequencyDomainStatus::ok, "chain constraint");
        check(c.prolong(q, 2, full, 4), "chain prolong");
        // Ordinary P1 element stiffness; no shifted derivative or added k squared.
        for (int a = 0; a < 2; ++a) {
            applied[a] = (full[a] - full[2 + a]) / length;
            applied[2 + a] = -applied[a];
        }
        check(c.restrict_adjoint(applied, 4, reduced, 2), "chain restrict");
        const double expected = 2.0 * (1.0 - std::cos(theta)) / length;
        check(close(reduced[0], expected), "exchange phase yields reciprocal stiffness");
        const double mass = length * (2.0 + std::cos(theta)) / 3.0;
        const double k = theta / length;
        check(std::abs(expected / mass / (k * k) - 1.0) < 0.012,
              "P1 generalized exchange tends to k squared");
    }
    f.request.k_rad_per_m[0] = 0.0;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::ok, "gamma constraint");
    check(c.prolong(q, 2, full, 4), "gamma prolong");
    check(close(full[0], full[2]), "gamma recovers real periodic equality");
}

static void invalid_classes_fail_and_clear_state()
{
    Fixture f;
    fd::FloquetTangentProlongation c;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::ok, "initial valid state");
    f.entries[1].full_node = 0;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "duplicate full node rejected");
    check(c.full_dof_count() == 0 && c.reduced_dof_count() == 0, "failed init clears state");
    f.entries[1].full_node = 1;
    f.entries[1].representative_node = 1;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "conflicting representatives rejected");
    f.entries[1].representative_node = 0;
    f.entries[0].translation_m[0] = 0.1;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "representative cannot carry a lattice translation");
    f.entries[0].translation_m[0] = 0.0;
    f.frames[1].m[2] = -1.0;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "inconsistent periodic equilibrium rejected");
    f.frames[1] = fd::TangentFrameNode{};
    f.entries[1].spin_rotation[0] = -1.0;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "improper spin rotation rejected");
    f.entries[1].spin_rotation[0] = 1.0;
    f.request.k_rad_per_m[0] = std::numeric_limits<double>::infinity();
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "nonfinite wavevector rejected");
    f.request.k_rad_per_m[0] = 0.0;
    f.request.workspace_budget_bytes = 1;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "insufficient workspace rejected before input traversal");
    f.request.workspace_budget_bytes = fd::kDefaultFloquetWorkspaceBudgetBytes;
    f.request.full_node_count = std::numeric_limits<std::size_t>::max();
    f.request.entry_count = f.request.full_node_count;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::validation_error,
          "overflow-sized request rejected without accessing tiny fixture buffers");
}

static void large_map_and_screw_rotation()
{
    // A proper pi rotation maps +z to -z and transports its tangent frame.
    Fixture f;
    f.frames[1].m[2] = -1.0;
    f.frames[1].e2[1] = -1.0;
    f.entries[1].spin_rotation[4] = -1.0;
    f.entries[1].spin_rotation[8] = -1.0;
    fd::FloquetTangentProlongation c;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::ok,
          "proper spin symmetry transports equilibrium and tangents");
    Complex screw_q[2] = {{1.0, 0.2}, {0.4, -0.7}}, screw_full[4]{};
    check(c.prolong(screw_q, 2, screw_full, 4), "screw map applies");
    check(close(screw_full[2], Complex(0.0, -1.0) * screw_q[0]) &&
          close(screw_full[3], Complex(0.0, -1.0) * screw_q[1]),
          "proper spin rotation and transported frame leave only Bloch phase");
    const std::size_t n = 4096;
    std::vector<fd::TangentFrameNode> frames(n);
    std::vector<fd::FloquetTangentClassEntry> entries(n);
    for (std::size_t i = 0; i < n; ++i) {
        entries[i].full_node = i;
        entries[i].translation_m[0] = static_cast<double>(i);
    }
    f.request.frames = frames.data();
    f.request.entries = entries.data();
    f.request.entry_count = n;
    f.request.full_node_count = n;
    check(c.initialize(f.request) == fd::FrequencyDomainStatus::ok,
          "more than 1024 DOFs uses the same sparse map");
    std::vector<Complex> full(2 * n);
    Complex q[2] = {{1.0, 2.0}, {-1.0, 0.4}}, reduced[2]{};
    check(c.prolong(q, 2, full.data(), full.size()), "large map prolong");
    check(c.restrict_adjoint(full.data(), full.size(), reduced, 2), "large map adjoint");
    check(std::abs(reduced[0] / double(n) - q[0]) < 1.0e-10, "large map norm");
    check(!c.prolong(q, 1, full.data(), full.size()), "wrong extent rejected");
    check(!c.prolong(full.data(), 2, full.data() + 1, full.size()), "overlapping buffers rejected");
}

#if FULLMAG_HAS_MFEM_STACK
static void mfem_matrix_free_reduction_and_transpose()
{
    std::vector<fd::TangentFrameNode> frames(3);
    std::vector<fd::FloquetTangentClassEntry> entries(3);
    entries[1].full_node = 1;
    entries[1].reduced_node = 1;
    entries[1].representative_node = 1;
    entries[2].full_node = 2;
    entries[2].translation_m[0] = 0.8;
    fd::FloquetTangentConstraintRequest request{};
    request.frames = frames.data(); request.full_node_count = frames.size();
    request.entries = entries.data(); request.entry_count = entries.size();
    request.reduced_node_count = 2; request.k_rad_per_m[0] = 0.73;
    fd::FloquetTangentProlongation c;
    check(c.initialize(request) == fd::FrequencyDomainStatus::ok, "MFEM classes");
    mfem::SparseMatrix a(6);
    for (int i = 0; i < 6; ++i) { a.Add(i, i, 2.0 + i); }
    a.Add(0, 5, 0.7); a.Add(4, 1, -0.2); a.Add(2, 4, 0.9);
    a.Finalize();
    fd::FloquetReducedMagneticOperator reduced(a, c);
    bool budget_rejected = false;
    try { fd::FloquetReducedMagneticOperator too_small(a, c, 1); }
    catch (const std::invalid_argument &) { budget_rejected = true; }
    check(budget_rejected, "MFEM workspace budget checked before scratch allocation");
    mfem::SparseMatrix wrong_shape(5);
    bool shape_rejected = false;
    try { fd::FloquetReducedMagneticOperator wrong(wrong_shape, c); }
    catch (const std::invalid_argument &) { shape_rejected = true; }
    check(shape_rejected, "MFEM full extent checked before scratch allocation");
    mfem::Vector x(8), y(8), v(8), adjoint_v(8);
    for (int i = 0; i < 8; ++i) { x[i] = 0.2 * i - 0.3; v[i] = 1.0 / (i + 1); }
    reduced.Mult(x, y);
    Complex q[4]{}, full[6]{}, applied[6]{}, expected[4]{};
    for (int i = 0; i < 4; ++i) { q[i] = {x[i], x[4 + i]}; }
    check(c.prolong(q, 4, full, 6), "reference prolongation");
    const mfem::SparseMatrix &reference_a = a;
    for (int i = 0; i < 6; ++i) {
        for (int j = 0; j < 6; ++j) { applied[i] += reference_a(i, j) * full[j]; }
    }
    check(c.restrict_adjoint(applied, 6, expected, 4), "reference restriction");
    for (int i = 0; i < 4; ++i) {
        check(close(Complex(y[i], y[4+i]), expected[i]), "MFEM action matches explicit oracle");
    }
    reduced.MultTranspose(v, adjoint_v);
    double lhs = 0.0, rhs = 0.0;
    for (int i = 0; i < 8; ++i) { lhs += y[i] * v[i]; rhs += x[i] * adjoint_v[i]; }
    check(std::abs(lhs - rhs) < 1.0e-12, "real-split transpose has conjugated Bloch coefficients");
}
#endif

int main()
{
    phase_basis_and_adjoint();
    exchange_chain_uses_phase_only();
    invalid_classes_fail_and_clear_state();
    large_map_and_screw_rotation();
#if FULLMAG_HAS_MFEM_STACK
    mfem_matrix_free_reduction_and_transpose();
#endif
    std::puts("PASS: native Floquet tangent constraint contracts (not a modal solve qualification)");
}
