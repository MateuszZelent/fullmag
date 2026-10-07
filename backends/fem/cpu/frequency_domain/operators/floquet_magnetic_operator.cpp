#include "cpu/frequency_domain/operators/floquet_magnetic_operator.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <utility>

namespace fullmag::fem::frequency_domain {
namespace {
using Complex = std::complex<double>;

double dot(const double *a, const double *b) noexcept
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

bool orthonormal(const double *a, const double *b, const double *c, double tol) noexcept
{
    const double *vectors[3] = {a, b, c};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            if (!std::isfinite(vectors[i][j])) { return false; }
            if (std::abs(dot(vectors[i], vectors[j]) - (i == j ? 1.0 : 0.0)) > tol) {
                return false;
            }
        }
    }
    const double cross[3] = {a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2],
                            a[0]*b[1] - a[1]*b[0]};
    return std::abs(dot(cross, c) - 1.0) <= tol;
}

bool disjoint(const Complex *input, std::size_t n, const Complex *output, std::size_t m)
{
    if (input == nullptr || output == nullptr) { return false; }
    const auto a = reinterpret_cast<std::uintptr_t>(input);
    const auto b = reinterpret_cast<std::uintptr_t>(output);
    return a <= b ? b - a >= n * sizeof(Complex) : a - b >= m * sizeof(Complex);
}
} // namespace

std::size_t FloquetTangentProlongation::storage_bytes() const noexcept
{
    return entries_.size() * sizeof(Entry);
}

FrequencyDomainStatus FloquetTangentProlongation::initialize(
    const FloquetTangentConstraintRequest &r) noexcept
{
    // Release previous storage before the next request's admission/allocation.
    std::vector<Entry>().swap(entries_);
    reduced_nodes_ = 0;
    constexpr auto invalid = FrequencyDomainStatus::validation_error;
    const auto max_nodes = std::numeric_limits<std::size_t>::max() /
                          std::max(sizeof(Entry), 2 * sizeof(Complex));
    if (!r.frames || !r.entries || r.full_node_count == 0 ||
        r.full_node_count > max_nodes || r.reduced_node_count == 0 ||
        r.reduced_node_count > r.full_node_count || r.entry_count != r.full_node_count ||
        !std::isfinite(r.frame_tolerance) || r.frame_tolerance <= 0.0 ||
        r.frame_tolerance >= 1.0) { return invalid; }
    if (r.reduced_node_count > r.workspace_budget_bytes / sizeof(std::size_t)) { return invalid; }
    const auto remaining_budget = r.workspace_budget_bytes - r.reduced_node_count * sizeof(std::size_t);
    if (r.full_node_count > remaining_budget / (sizeof(Entry) + sizeof(std::size_t))) { return invalid; }
    for (const double k : r.k_rad_per_m) { if (!std::isfinite(k)) { return invalid; } }
    try {
        const auto sentinel = r.full_node_count;
        std::vector<std::size_t> by_node(r.full_node_count, sentinel);
        std::vector<std::size_t> representatives(r.reduced_node_count, sentinel);
        std::vector<Entry> entries(r.full_node_count);
        for (std::size_t i = 0; i < r.entry_count; ++i) {
            const auto &e = r.entries[i];
            if (e.full_node >= r.full_node_count || e.representative_node >= r.full_node_count ||
                e.reduced_node >= r.reduced_node_count || by_node[e.full_node] != sentinel) {
                return invalid;
            }
            by_node[e.full_node] = i;
            auto &rep = representatives[e.reduced_node];
            if (rep != sentinel && rep != e.representative_node) { return invalid; }
            rep = e.representative_node;
            const auto &f = r.frames[e.full_node];
            if (!orthonormal(f.e1, f.e2, f.m, r.frame_tolerance) ||
                !orthonormal(e.spin_rotation.data(), e.spin_rotation.data() + 3,
                             e.spin_rotation.data() + 6, r.frame_tolerance)) { return invalid; }
        }
        for (std::size_t cls = 0; cls < r.reduced_node_count; ++cls) {
            const auto rep = representatives[cls];
            if (rep == sentinel) { return invalid; }
            const auto &e = r.entries[by_node[rep]];
            if (e.reduced_node != cls || e.representative_node != rep) { return invalid; }
            // The representative anchors both coordinate translation and spin gauge.
            for (double t : e.translation_m) { if (t != 0.0) { return invalid; } }
            for (std::size_t j = 0; j < 9; ++j) {
                if (std::abs(e.spin_rotation[j] - (j % 4 == 0 ? 1.0 : 0.0)) > r.frame_tolerance) {
                    return invalid;
                }
            }
        }
        for (std::size_t i = 0; i < r.entry_count; ++i) {
            const auto &e = r.entries[i];
            const auto &dst = r.frames[e.full_node];
            const auto &src = r.frames[e.representative_node];
            double angle = 0.0;
            for (int axis = 0; axis < 3; ++axis) {
                if (!std::isfinite(e.translation_m[axis])) { return invalid; }
                angle += r.k_rad_per_m[axis] * e.translation_m[axis];
                const double rotated_m = dot(e.spin_rotation.data() + 3 * axis, src.m);
                if (std::abs(rotated_m - dst.m[axis]) > r.frame_tolerance) { return invalid; }
            }
            if (!std::isfinite(angle)) { return invalid; }
            const Complex phase(std::cos(angle), -std::sin(angle));
            auto &entry = entries[e.full_node];
            entry.reduced_node = e.reduced_node;
            const double *t_src[2] = {src.e1, src.e2};
            const double *t_dst[2] = {dst.e1, dst.e2};
            for (int col = 0; col < 2; ++col) {
                double rotated[3]{};
                for (int axis = 0; axis < 3; ++axis) {
                    rotated[axis] = dot(e.spin_rotation.data() + 3 * axis, t_src[col]);
                }
                for (int row = 0; row < 2; ++row) {
                    entry.tangent_map[2 * row + col] = phase * dot(t_dst[row], rotated);
                }
            }
        }
        entries_ = std::move(entries);
        reduced_nodes_ = r.reduced_node_count;
        return FrequencyDomainStatus::ok;
    } catch (...) {
        return FrequencyDomainStatus::operator_error;
    }
}

bool FloquetTangentProlongation::prolong(const Complex *q, std::size_t n,
                                        Complex *full, std::size_t m) const noexcept
{
    if (entries_.empty() || n != reduced_dof_count() || m != full_dof_count() ||
        !disjoint(q, n, full, m)) { return false; }
    for (std::size_t node = 0; node < entries_.size(); ++node) {
        const auto &e = entries_[node];
        for (std::size_t row = 0; row < 2; ++row) {
            full[2 * node + row] = e.tangent_map[2 * row] * q[2 * e.reduced_node] +
                                  e.tangent_map[2 * row + 1] * q[2 * e.reduced_node + 1];
        }
    }
    return true;
}

bool FloquetTangentProlongation::restrict_adjoint(const Complex *full, std::size_t n,
                                                 Complex *q, std::size_t m) const noexcept
{
    if (entries_.empty() || n != full_dof_count() || m != reduced_dof_count() ||
        !disjoint(full, n, q, m)) { return false; }
    std::fill(q, q + m, Complex{});
    for (std::size_t node = 0; node < entries_.size(); ++node) {
        const auto &e = entries_[node];
        for (std::size_t col = 0; col < 2; ++col) {
            q[2 * e.reduced_node + col] += std::conj(e.tangent_map[col]) * full[2 * node] +
                std::conj(e.tangent_map[2 + col]) * full[2 * node + 1];
        }
    }
    return true;
}

#if FULLMAG_HAS_MFEM_STACK
namespace {
int checked_dimension(std::size_t count)
{
    if (count == 0 || count > std::size_t(std::numeric_limits<int>::max()) / 2) {
        throw std::invalid_argument("Floquet magnetic operator dimension is invalid");
    }
    return static_cast<int>(count);
}

int validate_reduced_workspace(const mfem::Operator &a, const FloquetTangentProlongation &c,
                               std::size_t budget)
{
    const int full_dimension = checked_dimension(c.full_dof_count());
    const int reduced_dimension = checked_dimension(c.reduced_dof_count());
    if (a.Height() != full_dimension || a.Width() != full_dimension) {
        throw std::invalid_argument("Floquet magnetic operator requires a square full-domain operator");
    }
    if (c.storage_bytes() > budget) {
        throw std::invalid_argument("Floquet magnetic workspace budget exceeded");
    }
    budget -= c.storage_bytes();
    constexpr std::size_t full_bytes_per_dof = 2 * sizeof(Complex) + 4 * sizeof(double);
    if (c.full_dof_count() > budget / full_bytes_per_dof) {
        throw std::invalid_argument("Floquet magnetic workspace budget exceeded");
    }
    budget -= c.full_dof_count() * full_bytes_per_dof;
    if (c.reduced_dof_count() > budget / sizeof(Complex)) {
        throw std::invalid_argument("Floquet magnetic workspace budget exceeded");
    }
    return 2 * reduced_dimension;
}
} // namespace

FloquetReducedMagneticOperator::FloquetReducedMagneticOperator(
    const mfem::Operator &a, const FloquetTangentProlongation &c, std::size_t budget)
    : mfem::Operator(validate_reduced_workspace(a, c, budget)), full_operator_(a),
      constraint_(c), reduced_(c.reduced_dof_count()), full_(c.full_dof_count()),
      applied_(c.full_dof_count()), full_real_(checked_dimension(c.full_dof_count())),
      full_imag_(checked_dimension(c.full_dof_count())),
      out_real_(checked_dimension(c.full_dof_count())),
      out_imag_(checked_dimension(c.full_dof_count()))
{
}

void FloquetReducedMagneticOperator::apply(const mfem::Vector &x, mfem::Vector &y,
                                          bool transpose) const
{
    if (x.Size() != Width() || y.Size() != Height()) {
        throw std::invalid_argument("Floquet magnetic apply extent mismatch");
    }
    const double *input = x.HostRead();
    const auto n = reduced_.size();
    for (std::size_t i = 0; i < n; ++i) { reduced_[i] = {input[i], input[n + i]}; }
    if (!constraint_.prolong(reduced_.data(), n, full_.data(), full_.size())) {
        throw std::logic_error("Invalid Floquet magnetic prolongation");
    }
    double *real = full_real_.HostWrite();
    double *imag = full_imag_.HostWrite();
    for (std::size_t i = 0; i < full_.size(); ++i) {
        real[i] = full_[i].real(); imag[i] = full_[i].imag();
    }
    if (transpose) {
        full_operator_.MultTranspose(full_real_, out_real_);
        full_operator_.MultTranspose(full_imag_, out_imag_);
    } else {
        full_operator_.Mult(full_real_, out_real_);
        full_operator_.Mult(full_imag_, out_imag_);
    }
    const double *a_real = out_real_.HostRead();
    const double *a_imag = out_imag_.HostRead();
    for (std::size_t i = 0; i < full_.size(); ++i) { applied_[i] = {a_real[i], a_imag[i]}; }
    if (!constraint_.restrict_adjoint(applied_.data(), applied_.size(), reduced_.data(), n)) {
        throw std::logic_error("Invalid Floquet magnetic restriction");
    }
    double *output = y.HostWrite();
    for (std::size_t i = 0; i < n; ++i) {
        output[i] = reduced_[i].real(); output[n + i] = reduced_[i].imag();
    }
}

void FloquetReducedMagneticOperator::Mult(const mfem::Vector &x, mfem::Vector &y) const
{
    apply(x, y, false);
}

void FloquetReducedMagneticOperator::MultTranspose(const mfem::Vector &x, mfem::Vector &y) const
{
    apply(x, y, true);
}
#endif
} // namespace fullmag::fem::frequency_domain
