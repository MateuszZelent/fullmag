#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"
#include "cpu/mfem/common/sparse_linear_solver.hpp"
#include "cpu/mfem/interactions/oersted/surface_rt0.hpp"
#include "cpu/mfem/transport/affine_rt0_element.hpp"

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.hpp"
#endif

#include <mfem.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace fullmag::fem::oersted {
namespace {

using Point = std::array<double, 3>;
using CurrentElement = fullmag::fem::transport::AffineRt0Element;

struct PreparedElement {
    CurrentElement current;
    std::array<Point, 4> vertices;
};

struct TetQuadPoint {
    double x;
    double y;
    double z;
    double weight;
};

struct SegQuadPoint {
    double x;
    double weight;
};

std::mutex &mfem_int_rules_mutex()
{
    static std::mutex mutex;
    return mutex;
}

std::mutex &failure_stderr_mutex()
{
    static std::mutex mutex;
    return mutex;
}

struct QuadratureRuleTable {
    int min_order = 0;
    int max_order = 0;
    std::vector<std::vector<TetQuadPoint>> tet_rules;
    std::vector<std::vector<SegQuadPoint>> seg_rules;

    static QuadratureRuleTable build(const DirectTetraQuadratureOptions &options)
    {
        QuadratureRuleTable table;
        table.min_order = options.base_quadrature_order;
        table.max_order = options.base_quadrature_order +
            2 * options.maximum_subdivision_depth + 2;
        const std::size_t count =
            static_cast<std::size_t>(table.max_order - table.min_order + 1);
        table.tet_rules.resize(count);
        table.seg_rules.resize(count);
        // Pre-extract flat immutable quadrature tables before spawning worker
        // threads because mfem::IntRules.Get mutates an unsynchronized cache.
        std::lock_guard<std::mutex> lock(mfem_int_rules_mutex());
        for (int order = table.min_order; order <= table.max_order; order += 2) {
            const std::size_t slot = static_cast<std::size_t>(order - table.min_order);
            const auto &tet = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, order);
            auto &tet_dst = table.tet_rules[slot];
            tet_dst.reserve(static_cast<std::size_t>(tet.GetNPoints()));
            for (int i = 0; i < tet.GetNPoints(); ++i) {
                const auto &ip = tet.IntPoint(i);
                tet_dst.push_back({ip.x, ip.y, ip.z, ip.weight});
            }
            const auto &seg = mfem::IntRules.Get(mfem::Geometry::SEGMENT, order);
            auto &seg_dst = table.seg_rules[slot];
            seg_dst.reserve(static_cast<std::size_t>(seg.GetNPoints()));
            for (int i = 0; i < seg.GetNPoints(); ++i) {
                const auto &ip = seg.IntPoint(i);
                seg_dst.push_back({ip.x, ip.weight});
            }
        }
        return table;
    }

    const std::vector<TetQuadPoint> &tetra_rule(int order) const
    {
        if (order < min_order || order > max_order || ((order - min_order) % 2) != 0) {
            throw std::runtime_error("quadrature_rule_order_out_of_range");
        }
        return tet_rules[static_cast<std::size_t>(order - min_order)];
    }

    const std::vector<SegQuadPoint> &segment_rule(int order) const
    {
        if (order < min_order || order > max_order || ((order - min_order) % 2) != 0) {
            throw std::runtime_error("quadrature_rule_order_out_of_range");
        }
        return seg_rules[static_cast<std::size_t>(order - min_order)];
    }
};

struct ParallelCancelled {};

struct SharedWorkBudget {
    explicit SharedWorkBudget(const DirectTetraQuadratureWorkLimits &limits_in)
        : limits(limits_in) {}

    const DirectTetraQuadratureWorkLimits limits;
    std::atomic<std::uint64_t> kernel_evaluations{0};
    std::atomic<std::uint64_t> ledger_leaf_visits{0};
    std::atomic<bool> stop_requested{false};
};

struct WorkBudget {
    static constexpr std::uint64_t kAtomicFlushStride = 256;

    explicit WorkBudget(
        const DirectTetraQuadratureOptions &options,
        SharedWorkBudget *shared_in = nullptr)
        : limits(DirectTetraQuadrature::ResolveWorkLimits(options)),
          shared(shared_in) {}

    const DirectTetraQuadratureWorkLimits limits;
    SharedWorkBudget *shared = nullptr;
    std::uint64_t kernel_evaluations = 0;
    std::uint64_t ledger_leaf_visits = 0;
    std::uint64_t pending_samples = 0;
    std::uint64_t pending_visits = 0;

    void flush_samples()
    {
        if (shared == nullptr || pending_samples == 0) return;
        const std::uint64_t delta = pending_samples;
        pending_samples = 0;
        const std::uint64_t previous = shared->kernel_evaluations.fetch_add(
            delta, std::memory_order_relaxed);
        if (previous > limits.maximum_kernel_evaluations ||
                delta > limits.maximum_kernel_evaluations - previous) {
            shared->stop_requested.store(true, std::memory_order_release);
            throw std::runtime_error("kernel_evaluation_budget_exceeded");
        }
    }

    void flush_visits()
    {
        if (shared == nullptr || pending_visits == 0) return;
        const std::uint64_t delta = pending_visits;
        pending_visits = 0;
        const std::uint64_t previous = shared->ledger_leaf_visits.fetch_add(
            delta, std::memory_order_relaxed);
        if (previous > limits.maximum_ledger_leaf_visits ||
                delta > limits.maximum_ledger_leaf_visits - previous) {
            shared->stop_requested.store(true, std::memory_order_release);
            throw std::runtime_error("ledger_leaf_visit_budget_exceeded");
        }
    }

    void flush_all()
    {
        flush_samples();
        flush_visits();
    }

    void sample()
    {
        if (shared != nullptr) {
            ++pending_samples;
            if (pending_samples >= kAtomicFlushStride) {
                flush_samples();
                if (shared->stop_requested.load(std::memory_order_acquire)) {
                    throw ParallelCancelled{};
                }
            }
        } else if (kernel_evaluations >= limits.maximum_kernel_evaluations) {
            throw std::runtime_error("kernel_evaluation_budget_exceeded");
        }
        ++kernel_evaluations;
    }

    void visit()
    {
        if (shared != nullptr) {
            ++pending_visits;
            if (pending_visits >= kAtomicFlushStride) {
                flush_visits();
                if (shared->stop_requested.load(std::memory_order_acquire)) {
                    throw ParallelCancelled{};
                }
            }
        } else if (ledger_leaf_visits >= limits.maximum_ledger_leaf_visits) {
            throw std::runtime_error("ledger_leaf_visit_budget_exceeded");
        }
        ++ledger_leaf_visits;
    }

    void charge_exact(std::uint64_t samples, std::uint64_t visits)
    {
        if (shared != nullptr) {
            pending_samples += samples;
            pending_visits += visits;
            flush_all();
            kernel_evaluations += samples;
            ledger_leaf_visits += visits;
            return;
        }
        if (kernel_evaluations > limits.maximum_kernel_evaluations ||
                samples > limits.maximum_kernel_evaluations - kernel_evaluations) {
            throw std::runtime_error("kernel_evaluation_budget_exceeded");
        }
        kernel_evaluations += samples;
        if (ledger_leaf_visits > limits.maximum_ledger_leaf_visits ||
                visits > limits.maximum_ledger_leaf_visits - ledger_leaf_visits) {
            throw std::runtime_error("ledger_leaf_visit_budget_exceeded");
        }
        ledger_leaf_visits += visits;
    }
};

struct ThreadJoinGuard {
    std::vector<std::thread> threads;
    std::atomic<bool> *stop_flag = nullptr;

    explicit ThreadJoinGuard(std::atomic<bool> *stop_flag_in = nullptr)
        : stop_flag(stop_flag_in) {}

    ~ThreadJoinGuard()
    {
        if (stop_flag != nullptr) {
            stop_flag->store(true, std::memory_order_release);
        }
        join_all();
    }

    void join_all()
    {
        for (auto &thread : threads) {
            if (thread.joinable()) {
                thread.join();
            }
        }
    }
};

std::optional<int> parse_positive_env_int(const char *name)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0') return std::nullopt;
    char *end = nullptr;
    const long parsed = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || parsed < 1) return std::nullopt;
    if (parsed > 1024) return 1024;
    return static_cast<int>(parsed);
}

bool env_requests_auto_threads(const char *name)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0') return false;
    return std::strcmp(raw, "auto") == 0 ||
        std::strcmp(raw, "AUTO") == 0 ||
        std::strcmp(raw, "Auto") == 0;
}

int resolve_available_worker_threads(int requested_worker_threads)
{
    if (requested_worker_threads > 0) {
        return std::min(requested_worker_threads, 1024);
    }
    int available = 1;
    if (env_requests_auto_threads("FULLMAG_CPU_THREADS")) {
        if (const auto resolved = parse_positive_env_int("FULLMAG_NATIVE_THREADS_AUTO_RESOLVED")) {
            available = *resolved;
        } else if (const auto legacy = parse_positive_env_int("FULLMAG_CPU_THREADS_AUTO_RESOLVED")) {
            available = *legacy;
        } else {
            available = static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
        }
    } else if (const auto from_omp = parse_positive_env_int("OMP_NUM_THREADS")) {
        available = *from_omp;
    } else if (const auto from_fullmag = parse_positive_env_int("FULLMAG_CPU_THREADS")) {
        available = *from_fullmag;
    } else {
        available = static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    }
    return std::clamp(available, 1, 64);
}

struct ScalarAccumulator {
    long double value = 0.0L;
    long double compensation = 0.0L;
    void add(long double term)
    {
        const long double corrected = term - compensation;
        const long double next = value + corrected;
        compensation = (next - value) - corrected;
        value = next;
    }
};

struct PairAccumulator {
    std::array<ScalarAccumulator, 3> components;
    void add(const Point &term)
    {
        for (int c = 0; c < 3; ++c) components[c].add(term[c]);
    }
    Point point() const
    {
        Point result{};
        for (int c = 0; c < 3; ++c) {
            result[c] = static_cast<double>(components[c].value);
            if (!std::isfinite(result[c]) ||
                    (components[c].value != 0.0L && result[c] == 0.0)) {
                throw std::runtime_error("field_sum_exceeds_binary64_range");
            }
        }
        return result;
    }
};

struct RuleIntegral {
    Point value{};
    long double weighted_norm_sum = 0.0L;
};

class SampledSingularity final : public std::runtime_error {
public:
    SampledSingularity() : std::runtime_error("quadrature_sampled_singularity") {}
};

void validate_pair_budget(std::uint64_t source_count, std::uint64_t target_count,
    const DirectTetraQuadratureOptions &options)
{
    (void)DirectTetraQuadrature::ResolveWorkLimits(options);
    if (source_count > DirectTetraQuadrature::maximum_final_leaves_per_target ||
            target_count > 1'000'000) {
        throw std::invalid_argument("direct tetrahedral Oersted cardinality is invalid");
    }
    if (target_count != 0 && source_count >
            options.maximum_source_target_pairs / target_count) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted source-target pair budget exceeded");
    }
}

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kBarycentricTolerance = 1.0e-12;
constexpr double kGpuFarFieldNearRadiusFactor = 3.0;
constexpr std::size_t kSourceRootParallelThreshold = 128;

Point subtract(const Point &left, const Point &right)
{
    return {left[0] - right[0], left[1] - right[1], left[2] - right[2]};
}

Point add(const Point &left, const Point &right)
{
    return {left[0] + right[0], left[1] + right[1], left[2] + right[2]};
}

Point scale(const Point &value, double factor)
{
    return {factor * value[0], factor * value[1], factor * value[2]};
}

double dot(const Point &left, const Point &right)
{
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

Point cross(const Point &left, const Point &right)
{
    return {left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0]};
}

double norm(const Point &value)
{
    return std::hypot(std::hypot(value[0], value[1]), value[2]);
}

double inverse_kernel_denominator(double distance)
{
    const double denominator = 4.0 * kPi * distance * distance * distance;
    const double inverse = 1.0 / denominator;
    if (!(std::isfinite(denominator) && denominator > 0.0 &&
            std::isfinite(inverse) && inverse > 0.0)) {
        throw std::runtime_error("biot_savart_denominator_exceeds_binary64_range");
    }
    return inverse;
}

bool target_error_fits(double error, double roundoff, double tolerance)
{
    // FastTwoSum retains the residual when the rounded sum lies on the gate.
    const double larger = std::max(error, roundoff);
    const double smaller = std::min(error, roundoff);
    const double sum = larger + smaller;
    const double residual = smaller - (sum - larger);
    return sum < tolerance || (sum == tolerance && residual <= 0.0);
}

double determinant(const Point &a, const Point &b, const Point &c)
{
    return dot(a, cross(b, c));
}

Point physical_barycentric(
    const std::array<Point, 4> &vertices,
    double b1,
    double b2,
    double b3)
{
    return add(vertices[0], add(scale(subtract(vertices[1], vertices[0]), b1),
        add(scale(subtract(vertices[2], vertices[0]), b2),
            scale(subtract(vertices[3], vertices[0]), b3))));
}

Point evaluate_current(
    const CurrentElement &element,
    const Point &physical_point)
{
    return element.current_at(physical_point);
}

RuleIntegral integrate_once(
    const CurrentElement &source,
    const std::array<Point, 4> &vertices,
    const Point &target,
    int order,
    const QuadratureRuleTable &quad_tables,
    WorkBudget &work)
{
    const auto &rules = quad_tables.tetra_rule(order);
    const double jacobian = std::abs(determinant(
        subtract(vertices[1], vertices[0]),
        subtract(vertices[2], vertices[0]),
        subtract(vertices[3], vertices[0])));
    if (!(std::isfinite(jacobian) && jacobian > 0.0)) {
        throw std::runtime_error(
            "direct tetrahedral Oersted source tetrahedron is degenerate");
    }
    PairAccumulator integral;
    ScalarAccumulator weighted_norm;
    for (std::size_t point = 0; point < rules.size(); ++point) {
        work.sample();
        const auto &ip = rules[point];
        const Point physical = physical_barycentric(vertices,
            ip.x, ip.y, ip.z);
        const Point displacement = subtract(target, physical);
        const double distance = norm(displacement);
        if (distance == 0.0) throw SampledSingularity();
        if (!(std::isfinite(distance) && distance > 0.0)) {
            throw std::runtime_error(
                "direct tetrahedral Oersted distance is invalid");
        }
        const Point current = evaluate_current(source, physical);
        const Point kernel = scale(cross(current, displacement),
            inverse_kernel_denominator(distance));
        const double weight = jacobian * ip.weight;
        const Point term = scale(kernel, weight);
        const double magnitude = norm(term);
        if (!std::isfinite(magnitude)) {
            throw std::runtime_error("direct tetrahedral Oersted kernel is non-finite");
        }
        integral.add(term);
        weighted_norm.add(magnitude);
    }
    return {integral.point(), weighted_norm.value};
}

std::array<std::array<int, 4>, 8> child_indices()
{
    return {{{0, 4, 5, 6}, {1, 4, 7, 8}, {2, 5, 7, 9},
        {3, 6, 8, 9}, {4, 5, 6, 7}, {4, 6, 8, 7},
        {6, 9, 8, 7}, {5, 6, 9, 7}}};
}

std::array<Point, 10> midpoint_vertices(const std::array<Point, 4> &v)
{
    return {v[0], v[1], v[2], v[3],
        scale(add(v[0], v[1]), 0.5), scale(add(v[0], v[2]), 0.5),
        scale(add(v[0], v[3]), 0.5), scale(add(v[1], v[2]), 0.5),
        scale(add(v[1], v[3]), 0.5), scale(add(v[2], v[3]), 0.5)};
}

bool decompose_target_tetrahedron(
    const std::array<Point, 4> &vertices,
    const Point &target,
    Point *effective_target,
    std::array<std::array<Point, 4>, 4> *children,
    int *child_count)
{
    const Point edge1 = subtract(vertices[1], vertices[0]);
    const Point edge2 = subtract(vertices[2], vertices[0]);
    const Point edge3 = subtract(vertices[3], vertices[0]);
    const double determinant_value = determinant(edge1, edge2, edge3);
    if (!(std::isfinite(determinant_value) &&
            std::abs(determinant_value) > 0.0)) {
        return false;
    }
    const Point offset = subtract(target, vertices[0]);
    std::array<double, 4> barycentric{
        1.0 - determinant(offset, edge2, edge3) / determinant_value -
            determinant(edge1, offset, edge3) / determinant_value -
            determinant(edge1, edge2, offset) / determinant_value,
        determinant(offset, edge2, edge3) / determinant_value,
        determinant(edge1, offset, edge3) / determinant_value,
        determinant(edge1, edge2, offset) / determinant_value};
    if (!std::all_of(barycentric.begin(), barycentric.end(),
            [](double value) { return std::isfinite(value); }) ||
            std::any_of(barycentric.begin(), barycentric.end(),
                [](double value) { return value < -kBarycentricTolerance; })) {
        return false;
    }

    // A boundary target can differ from the algebraic simplex by a few ulps
    // after mesh/projection coordinate conversion.  Snap only those tiny
    // negative coordinates to the closed simplex; no physical cutoff is used
    // in the kernel below.
    for (double &value : barycentric) {
        if (value < 0.0) value = 0.0;
    }
    const double sum = barycentric[0] + barycentric[1] + barycentric[2] +
        barycentric[3];
    if (!(std::isfinite(sum) && sum > 0.0)) return false;
    for (double &value : barycentric) value /= sum;
    *effective_target = physical_barycentric(vertices,
        barycentric[1], barycentric[2], barycentric[3]);

    *child_count = 0;
    for (int omitted = 0; omitted < 4; ++omitted) {
        std::array<Point, 4> child{};
        child[0] = *effective_target;
        int local = 1;
        for (int vertex = 0; vertex < 4; ++vertex) {
            if (vertex != omitted) child[local++] = vertices[vertex];
        }
        const double child_det = determinant(
            subtract(child[1], child[0]), subtract(child[2], child[0]),
            subtract(child[3], child[0]));
        if (std::isfinite(child_det) &&
                std::abs(child_det) >
                    std::numeric_limits<double>::min()) {
            (*children)[static_cast<std::size_t>(*child_count)] = child;
            ++(*child_count);
        }
    }
    return *child_count > 0;
}

RuleIntegral integrate_duffy_once(
    const CurrentElement &source,
    const std::array<Point, 4> &vertices,
    const Point &target,
    int order,
    const QuadratureRuleTable &quad_tables,
    WorkBudget &work)
{
    const auto &rules = quad_tables.segment_rule(order);
    const Point edge1 = subtract(vertices[1], target);
    const Point edge2 = subtract(vertices[2], target);
    const Point edge3 = subtract(vertices[3], target);
    const double jacobian = std::abs(determinant(edge1, edge2, edge3));
    if (!(std::isfinite(jacobian) && jacobian > 0.0)) {
        throw std::runtime_error(
            "direct tetrahedral Oersted Duffy child is degenerate");
    }
    PairAccumulator integral;
    ScalarAccumulator weighted_norm;
    for (std::size_t xi_index = 0; xi_index < rules.size(); ++xi_index) {
        const auto &xi_point = rules[xi_index];
        const double xi = xi_point.x;
        for (std::size_t eta_index = 0; eta_index < rules.size(); ++eta_index) {
            const auto &eta_point = rules[eta_index];
            const double eta = eta_point.x;
            for (std::size_t zeta_index = 0; zeta_index < rules.size();
                    ++zeta_index) {
                const auto &zeta_point = rules[zeta_index];
                work.sample();
                const double zeta = zeta_point.x;
                const Point ray = add(scale(edge1, 1.0 - eta),
                    add(scale(edge2, eta * (1.0 - zeta)),
                        scale(edge3, eta * zeta)));
                const double ray_norm = norm(ray);
                if (!(std::isfinite(ray_norm) && ray_norm > 0.0)) {
                    throw std::runtime_error(
                        "direct tetrahedral Oersted Duffy ray is degenerate");
                }
                const Point physical = add(target, scale(ray, xi));
                const Point current = evaluate_current(source, physical);
                // The xi^2 Jacobian cancels the xi^-2 singularity in
                // cross(J, -xi*ray)/|xi*ray|^3 exactly. The displacement
                // is target-source; MFEM segment points/weights are [0,1].
                // The remaining
                // integrand is regular at xi=0 and contains no cutoff.
                const Point kernel = scale(cross(current, ray),
                    -inverse_kernel_denominator(ray_norm));
                const double weight = jacobian * eta *
                    xi_point.weight * eta_point.weight *
                    zeta_point.weight;
                const Point term = scale(kernel, weight);
                const double magnitude = norm(term);
                if (!std::isfinite(magnitude)) {
                    throw std::runtime_error("direct tetrahedral Oersted Duffy kernel is non-finite");
                }
                integral.add(term);
                weighted_norm.add(magnitude);
            }
        }
    }
    return {integral.point(), weighted_norm.value};
}

struct Leaf {
    std::array<Point, 4> vertices;
    std::size_t source_index = 0;
    std::uint64_t sequence = 0;
    int depth = 0;
    Point high{};
    double error = 0.0;
    long double weighted_norm_sum = 0.0L;
    bool needs_refine = false;
};

Leaf evaluate_leaf(
    const std::vector<PreparedElement> &elements,
    Leaf leaf,
    const Point &target,
    const DirectTetraQuadratureOptions &options,
    const QuadratureRuleTable &quad_tables,
    WorkBudget &work,
    DirectTetraQuadratureDiagnostics &diagnostics)
{
    const auto &source = elements.at(leaf.source_index).current;
    const int low_order = options.base_quadrature_order + 2 * leaf.depth;
    const int high_order = low_order + 2;
    RuleIntegral low, high;
    Point effective_target{};
    std::array<std::array<Point, 4>, 4> singular_children{};
    int count = 0;
    try {
        if (decompose_target_tetrahedron(leaf.vertices, target,
                &effective_target, &singular_children, &count)) {
            PairAccumulator low_sum, high_sum;
            ScalarAccumulator magnitude;
            for (int child = 0; child < count; ++child) {
                const auto lo = integrate_duffy_once(source, singular_children[child],
                    effective_target, low_order, quad_tables, work);
                const auto hi = integrate_duffy_once(source, singular_children[child],
                    effective_target, high_order, quad_tables, work);
                low_sum.add(lo.value);
                high_sum.add(hi.value);
                magnitude.add(lo.weighted_norm_sum);
                magnitude.add(hi.weighted_norm_sum);
            }
            low = {low_sum.point(), magnitude.value};
            high = {high_sum.point(), 0.0L};
        } else {
            low = integrate_once(source, leaf.vertices, target, low_order, quad_tables, work);
            high = integrate_once(source, leaf.vertices, target, high_order, quad_tables, work);
        }
    } catch (const SampledSingularity &) {
        leaf.needs_refine = true;
        return leaf;
    }
    leaf.high = high.value;
    leaf.error = norm(subtract(high.value, low.value));
    leaf.weighted_norm_sum = low.weighted_norm_sum + high.weighted_norm_sum;
    if (!std::isfinite(leaf.error) ||
            !std::isfinite(leaf.weighted_norm_sum) || leaf.weighted_norm_sum < 0.0L) {
        throw std::runtime_error("quadrature_leaf_is_non_finite");
    }
    diagnostics.maximum_pair_error_apm = std::max(
        diagnostics.maximum_pair_error_apm, leaf.error);
    return leaf;
}

struct TargetLedger {
    PairAccumulator field;
    ScalarAccumulator error;
    ScalarAccumulator magnitude;
    std::uint64_t unresolved = 0;

    void add(const Leaf &leaf, int sign)
    {
        if (leaf.needs_refine) {
            if (sign > 0) ++unresolved;
            else --unresolved;
            return;
        }
        field.add(scale(leaf.high, sign));
        error.add(sign * static_cast<long double>(leaf.error));
        magnitude.add(sign * (leaf.weighted_norm_sum + norm(leaf.high)));
    }
};

TargetLedger recompute_ledger(const std::vector<Leaf> &leaves, WorkBudget &work)
{
    TargetLedger result;
    for (const auto &leaf : leaves) {
        work.visit();
        result.add(leaf, 1);
    }
    return result;
}

double upward_nonnegative(long double value)
{
    if (!(std::isfinite(value) && value >= 0.0L)) {
        throw std::runtime_error("quadrature_ledger_is_invalid");
    }
    double result = static_cast<double>(value);
    if (static_cast<long double>(result) < value) {
        result = std::nextafter(result, std::numeric_limits<double>::infinity());
    }
    if (!std::isfinite(result)) {
        throw std::runtime_error("quadrature_ledger_exceeds_binary64_range");
    }
    return result;
}

template <typename T>
void reserve_bounded(std::vector<T> &values, std::size_t required)
{
    const auto limit = DirectTetraQuadrature::maximum_final_leaves_per_target;
    if (required > limit) throw std::runtime_error("final_leaf_budget_exceeded");
    if (required > values.capacity()) {
        values.reserve(std::min<std::size_t>(limit,
            std::max(required, 2u * values.capacity())));
    }
}

// Best-effort failure telemetry only; never change the exception or sample J/H.
void emit_failure_leaves(const char *reason, const std::vector<Leaf> &leaves,
    const Point &target, const DirectTetraQuadratureOptions &options) noexcept
{
    try {
        std::array<const Leaf *, 3> top{};
        std::size_t depth_limited = 0, unresolved = 0;
        ScalarAccumulator depth_error;
        for (const auto &leaf : leaves) {
            if (leaf.needs_refine) ++unresolved;
            if (leaf.depth >= options.maximum_subdivision_depth) {
                ++depth_limited;
                if (!leaf.needs_refine) depth_error.add(leaf.error);
            }
            for (std::size_t rank = 0; rank < top.size(); ++rank) {
                if (top[rank] == nullptr || leaf.error > top[rank]->error ||
                        (leaf.error == top[rank]->error && leaf.sequence < top[rank]->sequence)) {
                    for (std::size_t next = top.size() - 1; next > rank; --next) {
                        top[next] = top[next - 1];
                    }
                    top[rank] = &leaf;
                    break;
                }
            }
        }
        std::ostringstream record;
        record.imbue(std::locale::classic());
        record << "[oersted_failure_v1] reason=";
        for (std::size_t i = 0; i < 48 && reason[i] != '\0'; ++i) {
            const char c = reason[i];
            record << ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') || c == '_' || c == '-' ? c : '_');
        }
        record << std::setprecision(17) << "; target_m=(" << target[0] << ','
               << target[1] << ',' << target[2] << "); leaves=" << leaves.size()
               << "; depth_limited=" << depth_limited << "; unresolved=" << unresolved
               << std::scientific << std::setprecision(6)
               << "; depth_error_apm=" << depth_error.value << "; top_s_d_e_r=[";
        bool first = true;
        for (const auto *leaf : top) {
            if (leaf == nullptr) continue;
            Point effective_target{};
            std::array<std::array<Point, 4>, 4> children{};
            int count = 0;
            const bool duffy = decompose_target_tetrahedron(leaf->vertices, target,
                &effective_target, &children, &count);
            if (!first) record << ';';
            first = false;
            // Classification is recomputed from retained geometry, not a failing child.
            record << leaf->source_index << ',' << leaf->depth << ',' << leaf->error
                   << ',' << (leaf->needs_refine ? 'U' : duffy ? 'D' : 'R');
        }
        record << ']';
        // Keep room in the worker's 512-character failure prefix. Earlier stderr
        // can still displace this additive record; it is not a durable field artifact.
        std::lock_guard<std::mutex> lock(failure_stderr_mutex());
        std::cerr << record.str().substr(0, 479) << '\n';
    } catch (...) {
        // Diagnostics must not mask the original numerical/resource failure.
    }
}

void evaluate_root_leaves_parallel(
    const std::vector<PreparedElement> &elements,
    const Point &target,
    const DirectTetraQuadratureOptions &options,
    const QuadratureRuleTable &quad_tables,
    WorkBudget &work,
    DirectTetraQuadratureDiagnostics &diagnostics,
    int root_workers,
    std::vector<Leaf> &leaves)
{
    leaves.resize(elements.size());
    SharedWorkBudget shared_budget(work.limits);
    shared_budget.kernel_evaluations.store(work.kernel_evaluations, std::memory_order_relaxed);
    shared_budget.ledger_leaf_visits.store(work.ledger_leaf_visits, std::memory_order_relaxed);

    const std::size_t worker_count = static_cast<std::size_t>(
        std::min<std::size_t>(static_cast<std::size_t>(root_workers), elements.size()));
    std::vector<double> worker_max_error(worker_count, 0.0);
    std::vector<std::uint64_t> worker_samples(worker_count, 0);
    std::atomic<std::size_t> next_source{0};
    std::mutex exception_mutex;
    std::exception_ptr first_exception;

    constexpr std::size_t kSourceChunk = 16;
    {
        ThreadJoinGuard guard(&shared_budget.stop_requested);
        guard.threads.reserve(worker_count);
        for (std::size_t worker_id = 0; worker_id < worker_count; ++worker_id) {
            guard.threads.emplace_back([&, worker_id]() {
                try {
                    WorkBudget local_work(options, &shared_budget);
                    DirectTetraQuadratureDiagnostics local_diag;
                    for (;;) {
                        if (shared_budget.stop_requested.load(std::memory_order_acquire)) {
                            break;
                        }
                        const std::size_t begin = next_source.fetch_add(
                            kSourceChunk, std::memory_order_relaxed);
                        if (begin >= elements.size()) {
                            break;
                        }
                        const std::size_t end = std::min(begin + kSourceChunk, elements.size());
                        for (std::size_t source = begin; source < end; ++source) {
                            Leaf leaf;
                            leaf.vertices = elements[source].vertices;
                            leaf.source_index = source;
                            leaf.sequence = static_cast<std::uint64_t>(source);
                            leaves[source] = evaluate_leaf(
                                elements, leaf, target, options, quad_tables,
                                local_work, local_diag);
                        }
                    }
                    local_work.flush_all();
                    worker_samples[worker_id] = local_work.kernel_evaluations;
                    worker_max_error[worker_id] = local_diag.maximum_pair_error_apm;
                } catch (const ParallelCancelled &) {
                    // Sibling worker recorded the primary failure.
                } catch (...) {
                    std::lock_guard<std::mutex> lock(exception_mutex);
                    if (!first_exception) {
                        first_exception = std::current_exception();
                    }
                    shared_budget.stop_requested.store(true, std::memory_order_release);
                }
            });
        }
        guard.join_all();
    }

    if (first_exception) {
        std::rethrow_exception(first_exception);
    }

    std::uint64_t total_root_samples = 0;
    for (std::size_t worker_id = 0; worker_id < worker_count; ++worker_id) {
        total_root_samples += worker_samples[worker_id];
        diagnostics.maximum_pair_error_apm = std::max(
            diagnostics.maximum_pair_error_apm, worker_max_error[worker_id]);
    }
    work.charge_exact(total_root_samples, 0);
}

std::pair<Point, DirectTetraTargetDiagnostics> evaluate_target(
    const std::vector<PreparedElement> &elements,
    const Point &target,
    const DirectTetraQuadratureOptions &options,
    const QuadratureRuleTable &quad_tables,
    WorkBudget &work,
    DirectTetraQuadratureDiagnostics &diagnostics,
    int root_workers = 1)
{
    const auto initial_samples = work.kernel_evaluations;
    const auto initial_visits = work.ledger_leaf_visits;
    std::vector<Leaf> leaves;
    std::vector<std::size_t> heap;
    reserve_bounded(leaves, elements.size());
    reserve_bounded(heap, elements.size());
    std::uint64_t sequence = 0;
    TargetLedger ledger;
    Point high{};
    double estimated_error_apm = 0.0, roundoff_indicator_apm = 0.0, tolerance_apm = 0.0;
    auto priority = [&leaves](std::size_t left, std::size_t right) {
        const auto &a = leaves[left];
        const auto &b = leaves[right];
        if (a.needs_refine != b.needs_refine) return !a.needs_refine;
        if (a.error != b.error) return a.error < b.error;
        return a.sequence > b.sequence;
    };
    auto enqueue = [&](std::size_t index) {
        if (leaves[index].depth < options.maximum_subdivision_depth) {
            reserve_bounded(heap, heap.size() + 1u);
            heap.push_back(index);
            std::push_heap(heap.begin(), heap.end(), priority);
        } else if (leaves[index].needs_refine) {
            throw std::runtime_error("sampled_singularity_at_depth_limit");
        }
    };
    auto totals = [&]() {
        high = ledger.field.point();
        estimated_error_apm = upward_nonnegative(ledger.error.value);
        roundoff_indicator_apm = upward_nonnegative(
            std::numeric_limits<double>::epsilon() * ledger.magnitude.value);
        tolerance_apm = std::fma(options.relative_tolerance,
            norm(high), options.absolute_tolerance_apm);
        if (!std::isfinite(tolerance_apm)) {
            throw std::runtime_error("target_tolerance_is_non_finite");
        }
    };
    try {
        // Populate every source root before any acceptance decision.
        if (root_workers > 1 && elements.size() >= kSourceRootParallelThreshold) {
            evaluate_root_leaves_parallel(
                elements, target, options, quad_tables, work, diagnostics,
                root_workers, leaves);
            sequence = static_cast<std::uint64_t>(elements.size());
            // Deterministic ascending source accumulation preserves 0-ULP parity.
            for (std::size_t source = 0; source < elements.size(); ++source) {
                ledger.add(leaves[source], 1);
                enqueue(source);
            }
        } else {
            for (std::size_t source = 0; source < elements.size(); ++source) {
                Leaf leaf;
                leaf.vertices = elements[source].vertices;
                leaf.source_index = source;
                leaf.sequence = sequence++;
                leaves.push_back(evaluate_leaf(
                    elements, leaf, target, options, quad_tables, work, diagnostics));
                ledger.add(leaves.back(), 1);
                enqueue(leaves.size() - 1u);
            }
        }
        for (;;) {
            if (!(std::isfinite(ledger.error.value) && ledger.error.value >= 0.0L &&
                    std::isfinite(ledger.magnitude.value) && ledger.magnitude.value >= 0.0L)) {
                ledger = recompute_ledger(leaves, work);
            }
            totals();
            const auto meets_budget = [&]() {
                return ledger.unresolved == 0 &&
                    target_error_fits(estimated_error_apm, roundoff_indicator_apm, tolerance_apm);
            };
            if (meets_budget() || heap.empty()) {
                // This final-leaf recomputation, not incremental drift, is authoritative.
                ledger = recompute_ledger(leaves, work);
                totals();
                if (meets_budget()) {
                    return {high, {estimated_error_apm, tolerance_apm, roundoff_indicator_apm,
                        static_cast<std::uint64_t>(leaves.size()),
                        work.kernel_evaluations - initial_samples,
                        work.ledger_leaf_visits - initial_visits}};
                }
            }
            if (heap.empty()) throw std::runtime_error("global_target_depth_exhausted");
            if (!leaves[heap.front()].needs_refine && leaves[heap.front()].error == 0.0) {
                throw std::runtime_error(estimated_error_apm > tolerance_apm ?
                    "global_target_depth_exhausted" : "roundoff_indicator_exceeds_tolerance");
            }
            // Eight temporary children; the retained parent is replaced, never accumulated.
            if (leaves.size() > DirectTetraQuadrature::maximum_final_leaves_per_target - 7u) {
                throw std::runtime_error("final_leaf_budget_exceeded");
            }
            std::pop_heap(heap.begin(), heap.end(), priority);
            const auto index = heap.back();
            heap.pop_back();
            const Leaf parent = leaves[index];
            const auto midpoints = midpoint_vertices(parent.vertices);
            std::array<Leaf, 8> children;
            const auto indices = child_indices();
            for (std::size_t child = 0; child < children.size(); ++child) {
                Leaf leaf;
                leaf.vertices = {midpoints[indices[child][0]], midpoints[indices[child][1]],
                    midpoints[indices[child][2]], midpoints[indices[child][3]]};
                leaf.source_index = parent.source_index;
                leaf.depth = parent.depth + 1;
                leaf.sequence = sequence++;
                children[child] = evaluate_leaf(
                    elements, leaf, target, options, quad_tables, work, diagnostics);
            }
            reserve_bounded(leaves, leaves.size() + 7u);
            ledger.add(parent, -1);
            for (std::size_t child = 0; child < children.size(); ++child) {
                const auto child_index = child == 0 ? index : leaves.size();
                if (child == 0) leaves[index] = children[child];
                else leaves.push_back(children[child]);
                ledger.add(children[child], 1);
                enqueue(child_index);
            }
            ++diagnostics.refined_pairs;
        }
    } catch (const std::exception &error) {
        emit_failure_leaves(error.what(), leaves, target, options);
        ++diagnostics.unconverged_pair_count;
        std::ostringstream detail;
        detail << std::setprecision(17) << error.what() << "; target_m=("
               << target[0] << ',' << target[1] << ',' << target[2]
               << "); estimated_error_apm=" << estimated_error_apm
               << "; roundoff_indicator_apm=" << roundoff_indicator_apm
               << "; tolerance_apm=" << tolerance_apm
               << "; final_leaves=" << leaves.size()
               << "; kernel_evaluations=" << work.kernel_evaluations
               << "; ledger_leaf_visits=" << work.ledger_leaf_visits;
        throw std::runtime_error(detail.str());
    }
}

struct TargetEvalOutput {
    Point field{};
    DirectTetraTargetDiagnostics target_diag{};
    std::uint64_t refined_pairs = 0;
    double maximum_pair_error_apm = 0.0;
    std::uint64_t gpu_farfield_pairs = 0;
    std::uint64_t cpu_near_singular_pairs = 0;
};

#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME

GpuDirectTetraSourceHostData build_gpu_source_host_data(
    const std::vector<PreparedElement> &elements)
{
    GpuDirectTetraSourceHostData data;
    const std::size_t n = elements.size();
    data.source_count = n;
    data.vertex_x.resize(4u * n);
    data.vertex_y.resize(4u * n);
    data.vertex_z.resize(4u * n);
    data.signed_coefficients_a.resize(4u * n);
    data.center_x.resize(n);
    data.center_y.resize(n);
    data.center_z.resize(n);
    data.bounding_radius.resize(n);
    data.volume.resize(n);
    data.abs_det.resize(n);

    for (std::size_t s = 0; s < n; ++s) {
        const auto frozen = elements[s].current.frozen_input();
        long double cx_ld = 0.0L;
        long double cy_ld = 0.0L;
        long double cz_ld = 0.0L;
        for (int k = 0; k < 4; ++k) {
            const std::size_t idx = static_cast<std::size_t>(k) * n + s;
            data.vertex_x[idx] = frozen.vertices_m[k][0];
            data.vertex_y[idx] = frozen.vertices_m[k][1];
            data.vertex_z[idx] = frozen.vertices_m[k][2];
            data.signed_coefficients_a[idx] = frozen.signed_coefficients_a[k];
            cx_ld += static_cast<long double>(frozen.vertices_m[k][0]);
            cy_ld += static_cast<long double>(frozen.vertices_m[k][1]);
            cz_ld += static_cast<long double>(frozen.vertices_m[k][2]);
        }
        const double cx = static_cast<double>(cx_ld * 0.25L);
        const double cy = static_cast<double>(cy_ld * 0.25L);
        const double cz = static_cast<double>(cz_ld * 0.25L);
        data.center_x[s] = cx;
        data.center_y[s] = cy;
        data.center_z[s] = cz;

        double radius = 0.0;
        for (int k = 0; k < 4; ++k) {
            const double dx = frozen.vertices_m[k][0] - cx;
            const double dy = frozen.vertices_m[k][1] - cy;
            const double dz = frozen.vertices_m[k][2] - cz;
            radius = std::max(radius, std::hypot(std::hypot(dx, dy), dz));
        }
        data.bounding_radius[s] = radius;

        const auto &v = frozen.vertices_m;
        const long double e1x = static_cast<long double>(v[1][0]) - v[0][0];
        const long double e1y = static_cast<long double>(v[1][1]) - v[0][1];
        const long double e1z = static_cast<long double>(v[1][2]) - v[0][2];
        const long double e2x = static_cast<long double>(v[2][0]) - v[0][0];
        const long double e2y = static_cast<long double>(v[2][1]) - v[0][1];
        const long double e2z = static_cast<long double>(v[2][2]) - v[0][2];
        const long double e3x = static_cast<long double>(v[3][0]) - v[0][0];
        const long double e3y = static_cast<long double>(v[3][1]) - v[0][1];
        const long double e3z = static_cast<long double>(v[3][2]) - v[0][2];
        const long double det_ld =
            e1x * (e2y * e3z - e2z * e3y) +
            e1y * (e2z * e3x - e2x * e3z) +
            e1z * (e2x * e3y - e2y * e3x);
        const double abs_det = static_cast<double>(std::abs(det_ld));
        if (!(std::isfinite(abs_det) && abs_det > 0.0)) {
            throw std::runtime_error(
                "direct tetrahedral Oersted source tetrahedron is degenerate");
        }
        data.abs_det[s] = abs_det;
        data.volume[s] = abs_det / 6.0;
    }
    return data;
}

TargetEvalOutput evaluate_target_gpu_hybrid(
    const std::vector<PreparedElement> &elements,
    const Point &target,
    std::size_t target_index,
    const GpuDirectTetraTargetResult &gpu_out,
    const DirectTetraQuadratureOptions &options,
    const QuadratureRuleTable &quad_tables,
    WorkBudget &work,
    int root_workers)
{
    const bool force_full_cpu =
        gpu_out.target_requires_full_cpu_fallback[target_index] != 0 ||
        gpu_out.far_pair_count[target_index] == 0;
    if (force_full_cpu) {
        DirectTetraQuadratureDiagnostics local_diag;
        const auto evaluated = evaluate_target(
            elements, target, options, quad_tables, work, local_diag, root_workers);
        return {
            evaluated.first,
            evaluated.second,
            local_diag.refined_pairs,
            local_diag.maximum_pair_error_apm,
            0,
            static_cast<std::uint64_t>(elements.size())};
    }

    const Point far_h{
        gpu_out.far_h_xyz_apm[3u * target_index + 0u],
        gpu_out.far_h_xyz_apm[3u * target_index + 1u],
        gpu_out.far_h_xyz_apm[3u * target_index + 2u]};
    const double far_err = gpu_out.far_error_sum_apm[target_index];
    const double far_wn = gpu_out.far_weighted_norm_sum_apm[target_index];
    const double far_max_err = gpu_out.far_max_pair_error_apm[target_index];
    const std::uint64_t far_pairs = gpu_out.far_pair_count[target_index];
    const std::uint64_t far_evals = gpu_out.far_kernel_evaluations[target_index];
    const std::uint64_t cpu_begin = gpu_out.cpu_pair_offsets[target_index];
    const std::uint64_t cpu_end = gpu_out.cpu_pair_offsets[target_index + 1u];
    const std::uint64_t cpu_root_count = cpu_end - cpu_begin;

    const bool far_valid =
        std::isfinite(far_h[0]) && std::isfinite(far_h[1]) && std::isfinite(far_h[2]) &&
        std::isfinite(far_err) && far_err >= 0.0 &&
        std::isfinite(far_wn) && far_wn >= 0.0 &&
        std::isfinite(far_max_err) && far_max_err >= 0.0 &&
        (far_pairs + cpu_root_count == static_cast<std::uint64_t>(elements.size()));
    if (!far_valid) {
        DirectTetraQuadratureDiagnostics local_diag;
        const auto evaluated = evaluate_target(
            elements, target, options, quad_tables, work, local_diag, root_workers);
        return {
            evaluated.first,
            evaluated.second,
            local_diag.refined_pairs,
            local_diag.maximum_pair_error_apm,
            0,
            static_cast<std::uint64_t>(elements.size())};
    }

    const auto initial_samples = work.kernel_evaluations;
    const auto initial_visits = work.ledger_leaf_visits;
    work.charge_exact(far_evals, far_pairs);

    // Fast path when every source pair for this target converged on GPU at depth 0.
    if (cpu_root_count == 0) {
        const double estimated_error_apm = upward_nonnegative(static_cast<long double>(far_err));
        const double roundoff_indicator_apm = upward_nonnegative(
            std::numeric_limits<double>::epsilon() * static_cast<long double>(far_wn));
        const double tolerance_apm = std::fma(
            options.relative_tolerance, norm(far_h), options.absolute_tolerance_apm);
        if (std::isfinite(tolerance_apm) &&
                target_error_fits(estimated_error_apm, roundoff_indicator_apm, tolerance_apm)) {
            return {
                far_h,
                {estimated_error_apm, tolerance_apm, roundoff_indicator_apm,
                    far_pairs,
                    work.kernel_evaluations - initial_samples,
                    work.ledger_leaf_visits - initial_visits},
                0,
                far_max_err,
                far_pairs,
                0};
        }
        // Global target cancellation or tight tolerance requires subdividing far pairs.
        DirectTetraQuadratureDiagnostics local_diag;
        const auto full_eval = evaluate_target(
            elements, target, options, quad_tables, work, local_diag, root_workers);
        auto merged_target_diag = full_eval.second;
        merged_target_diag.kernel_evaluations = work.kernel_evaluations - initial_samples;
        merged_target_diag.ledger_leaf_visits = work.ledger_leaf_visits - initial_visits;
        return {
            full_eval.first,
            merged_target_diag,
            local_diag.refined_pairs,
            local_diag.maximum_pair_error_apm,
            0,
            static_cast<std::uint64_t>(elements.size())};
    }

    DirectTetraQuadratureDiagnostics local_diag;
    local_diag.maximum_pair_error_apm = far_max_err;
    std::vector<Leaf> leaves;
    std::vector<std::size_t> heap;
    reserve_bounded(leaves, static_cast<std::size_t>(cpu_root_count));
    reserve_bounded(heap, static_cast<std::size_t>(cpu_root_count));
    std::uint64_t sequence = 0;
    auto init_far_ledger = [&]() {
        TargetLedger result;
        result.field.add(far_h);
        result.error.add(static_cast<long double>(far_err));
        result.magnitude.add(static_cast<long double>(far_wn));
        return result;
    };
    auto recompute_hybrid_ledger = [&]() {
        TargetLedger result = init_far_ledger();
        for (const auto &leaf : leaves) {
            work.visit();
            result.add(leaf, 1);
        }
        return result;
    };
    TargetLedger ledger = init_far_ledger();
    Point high{};
    double estimated_error_apm = 0.0, roundoff_indicator_apm = 0.0, tolerance_apm = 0.0;
    auto priority = [&leaves](std::size_t left, std::size_t right) {
        const auto &a = leaves[left];
        const auto &b = leaves[right];
        if (a.needs_refine != b.needs_refine) return !a.needs_refine;
        if (a.error != b.error) return a.error < b.error;
        return a.sequence > b.sequence;
    };
    auto enqueue = [&](std::size_t index) {
        if (leaves[index].depth < options.maximum_subdivision_depth) {
            reserve_bounded(heap, heap.size() + 1u);
            heap.push_back(index);
            std::push_heap(heap.begin(), heap.end(), priority);
        } else if (leaves[index].needs_refine) {
            throw std::runtime_error("sampled_singularity_at_depth_limit");
        }
    };
    auto totals = [&]() {
        high = ledger.field.point();
        estimated_error_apm = upward_nonnegative(ledger.error.value);
        roundoff_indicator_apm = upward_nonnegative(
            std::numeric_limits<double>::epsilon() * ledger.magnitude.value);
        tolerance_apm = std::fma(options.relative_tolerance,
            norm(high), options.absolute_tolerance_apm);
        if (!std::isfinite(tolerance_apm)) {
            throw std::runtime_error("target_tolerance_is_non_finite");
        }
    };

    bool requeue_full_cpu = false;
    try {
        for (std::uint64_t pos = cpu_begin; pos < cpu_end; ++pos) {
            const std::size_t source =
                static_cast<std::size_t>(gpu_out.cpu_pair_sources[static_cast<std::size_t>(pos)]);
            Leaf leaf;
            leaf.vertices = elements[source].vertices;
            leaf.source_index = source;
            leaf.sequence = sequence++;
            leaves.push_back(evaluate_leaf(
                elements, leaf, target, options, quad_tables, work, local_diag));
            ledger.add(leaves.back(), 1);
            enqueue(leaves.size() - 1u);
        }
        for (;;) {
            if (!(std::isfinite(ledger.error.value) && ledger.error.value >= 0.0L &&
                    std::isfinite(ledger.magnitude.value) && ledger.magnitude.value >= 0.0L)) {
                ledger = recompute_hybrid_ledger();
            }
            totals();
            const auto meets_budget = [&]() {
                return ledger.unresolved == 0 &&
                    target_error_fits(estimated_error_apm, roundoff_indicator_apm, tolerance_apm);
            };
            if (meets_budget() || heap.empty()) {
                ledger = recompute_hybrid_ledger();
                totals();
                if (meets_budget()) {
                    return {
                        high,
                        {estimated_error_apm, tolerance_apm, roundoff_indicator_apm,
                            far_pairs + static_cast<std::uint64_t>(leaves.size()),
                            work.kernel_evaluations - initial_samples,
                            work.ledger_leaf_visits - initial_visits},
                        local_diag.refined_pairs,
                        local_diag.maximum_pair_error_apm,
                        far_pairs,
                        cpu_root_count};
                }
            }
            if (heap.empty() ||
                    (!leaves[heap.front()].needs_refine && leaves[heap.front()].error == 0.0)) {
                if (far_err > 0.0) {
                    // Far-field root pairs must enter adaptive subdivision on CPU to
                    // certify the global target tolerance without losing accuracy.
                    requeue_full_cpu = true;
                    break;
                }
                if (heap.empty()) throw std::runtime_error("global_target_depth_exhausted");
                throw std::runtime_error(estimated_error_apm > tolerance_apm ?
                    "global_target_depth_exhausted" : "roundoff_indicator_exceeds_tolerance");
            }
            if (far_pairs + leaves.size() >
                    DirectTetraQuadrature::maximum_final_leaves_per_target - 7u) {
                throw std::runtime_error("final_leaf_budget_exceeded");
            }
            std::pop_heap(heap.begin(), heap.end(), priority);
            const auto index = heap.back();
            heap.pop_back();
            const Leaf parent = leaves[index];
            const auto midpoints = midpoint_vertices(parent.vertices);
            std::array<Leaf, 8> children;
            const auto indices = child_indices();
            for (std::size_t child = 0; child < children.size(); ++child) {
                Leaf leaf;
                leaf.vertices = {midpoints[indices[child][0]], midpoints[indices[child][1]],
                    midpoints[indices[child][2]], midpoints[indices[child][3]]};
                leaf.source_index = parent.source_index;
                leaf.depth = parent.depth + 1;
                leaf.sequence = sequence++;
                children[child] = evaluate_leaf(
                    elements, leaf, target, options, quad_tables, work, local_diag);
            }
            reserve_bounded(leaves, leaves.size() + 7u);
            ledger.add(parent, -1);
            for (std::size_t child = 0; child < children.size(); ++child) {
                const auto child_index = child == 0 ? index : leaves.size();
                if (child == 0) leaves[index] = children[child];
                else leaves.push_back(children[child]);
                ledger.add(children[child], 1);
                enqueue(child_index);
            }
            ++local_diag.refined_pairs;
        }
    } catch (const std::exception &error) {
        emit_failure_leaves(error.what(), leaves, target, options);
        ++local_diag.unconverged_pair_count;
        std::ostringstream detail;
        detail << std::setprecision(17) << error.what() << "; target_m=("
               << target[0] << ',' << target[1] << ',' << target[2]
               << "); estimated_error_apm=" << estimated_error_apm
               << "; roundoff_indicator_apm=" << roundoff_indicator_apm
               << "; tolerance_apm=" << tolerance_apm
               << "; final_leaves=" << (far_pairs + leaves.size())
               << "; kernel_evaluations=" << work.kernel_evaluations
               << "; ledger_leaf_visits=" << work.ledger_leaf_visits;
        throw std::runtime_error(detail.str());
    }

    if (requeue_full_cpu) {
        DirectTetraQuadratureDiagnostics full_diag;
        const auto full_eval = evaluate_target(
            elements, target, options, quad_tables, work, full_diag, root_workers);
        auto merged_target_diag = full_eval.second;
        merged_target_diag.kernel_evaluations = work.kernel_evaluations - initial_samples;
        merged_target_diag.ledger_leaf_visits = work.ledger_leaf_visits - initial_visits;
        return {
            full_eval.first,
            merged_target_diag,
            full_diag.refined_pairs,
            full_diag.maximum_pair_error_apm,
            0,
            static_cast<std::uint64_t>(elements.size())};
    }

    throw std::runtime_error("direct tetrahedral Oersted hybrid target terminated unexpectedly");
}

DirectTetraQuadratureResult evaluate_prepared_gpu_hybrid(
    const std::vector<PreparedElement> &elements,
    const std::vector<Point> &target_points,
    const DirectTetraQuadratureOptions &options,
    const QuadratureRuleTable &quad_tables,
    WorkBudget &work,
    const SurfaceRt0ProgressObserver *observer)
{
    const auto source_count = static_cast<std::uint64_t>(elements.size());
    const auto target_count = static_cast<std::uint64_t>(target_points.size());

    const auto gpu_sources = build_gpu_source_host_data(elements);
    std::vector<double> flat_targets;
    flat_targets.reserve(target_points.size() * 3u);
    for (const auto &target : target_points) {
        flat_targets.push_back(target[0]);
        flat_targets.push_back(target[1]);
        flat_targets.push_back(target[2]);
    }

    const auto &low_rule = quad_tables.tetra_rule(options.base_quadrature_order);
    const auto &high_rule = quad_tables.tetra_rule(options.base_quadrature_order + 2);
    std::vector<double> low_xyzw;
    low_xyzw.reserve(low_rule.size() * 4u);
    for (const auto &pt : low_rule) {
        low_xyzw.push_back(pt.x);
        low_xyzw.push_back(pt.y);
        low_xyzw.push_back(pt.z);
        low_xyzw.push_back(pt.weight);
    }
    std::vector<double> high_xyzw;
    high_xyzw.reserve(high_rule.size() * 4u);
    for (const auto &pt : high_rule) {
        high_xyzw.push_back(pt.x);
        high_xyzw.push_back(pt.y);
        high_xyzw.push_back(pt.z);
        high_xyzw.push_back(pt.weight);
    }

    GpuDirectTetraTargetResult gpu_out;
    std::string cuda_error;
    const bool cuda_ok = fullmag_cuda_direct_tetra_evaluate_root_farfield(
        gpu_sources,
        flat_targets.empty() ? nullptr : flat_targets.data(),
        target_points.size(),
        low_xyzw.data(),
        static_cast<int>(low_rule.size()),
        high_xyzw.data(),
        static_cast<int>(high_rule.size()),
        kGpuFarFieldNearRadiusFactor,
        options.relative_tolerance,
        options.absolute_tolerance_apm,
        gpu_out,
        cuda_error);
    if (!cuda_ok) {
        throw std::runtime_error(cuda_error.empty()
            ? "direct tetrahedral Oersted CUDA far-field evaluation failed"
            : cuda_error);
    }

    const auto initial_samples = work.kernel_evaluations;
    const auto initial_visits = work.ledger_leaf_visits;
    DirectTetraQuadratureResult result;
    result.operator_version = DirectTetraQuadrature::operator_version;
    result.h_xyz_apm.assign(target_points.size() * 3u, 0.0);
    result.target_diagnostics.reserve(target_points.size());
    result.diagnostics.source_target_pairs = source_count * target_count;
    result.diagnostics.resolved_execution_policy = "gpu_hybrid_farfield";

    const int requested_workers = resolve_available_worker_threads(options.worker_threads);
    const bool use_target_parallel = requested_workers > 1 &&
        target_points.size() >= static_cast<std::size_t>(2 * requested_workers);
    const int effective_workers = use_target_parallel ? requested_workers : 1;
    result.diagnostics.effective_worker_threads = effective_workers;

    if (observer) {
        observer->emit(AntennaProgressPhase::evaluating_field, 0, target_count, source_count);
    }

    if (use_target_parallel) {
        SharedWorkBudget shared_budget(work.limits);
        shared_budget.kernel_evaluations.store(work.kernel_evaluations, std::memory_order_relaxed);
        shared_budget.ledger_leaf_visits.store(work.ledger_leaf_visits, std::memory_order_relaxed);

        std::vector<TargetEvalOutput> per_target(target_points.size());
        std::atomic<std::size_t> next_target{0};
        std::mutex observer_mutex;
        std::uint64_t completed_targets = 0;
        std::mutex exception_mutex;
        std::exception_ptr first_exception;

        {
            ThreadJoinGuard guard(&shared_budget.stop_requested);
            guard.threads.reserve(static_cast<std::size_t>(effective_workers));
            for (int w = 0; w < effective_workers; ++w) {
                guard.threads.emplace_back([&]() {
                    try {
                        WorkBudget local_work(options, &shared_budget);
                        for (;;) {
                            if (shared_budget.stop_requested.load(std::memory_order_acquire)) {
                                break;
                            }
                            const std::size_t target_index =
                                next_target.fetch_add(1u, std::memory_order_relaxed);
                            if (target_index >= target_points.size()) {
                                break;
                            }
                            auto slot = evaluate_target_gpu_hybrid(
                                elements, target_points[target_index], target_index,
                                gpu_out, options, quad_tables, local_work, 1);
                            local_work.flush_all();
                            for (int component = 0; component < 3; ++component) {
                                if (!std::isfinite(slot.field[component])) {
                                    throw std::runtime_error(
                                        "direct tetrahedral Oersted field is non-finite");
                                }
                            }
                            per_target[target_index] = slot;
                            if (observer != nullptr) {
                                std::lock_guard<std::mutex> lock(observer_mutex);
                                const std::uint64_t done = ++completed_targets;
                                observer->emit(AntennaProgressPhase::evaluating_field,
                                    done, target_count, source_count);
                            }
                        }
                    } catch (const ParallelCancelled &) {
                        // Sibling worker recorded the primary failure.
                    } catch (...) {
                        std::lock_guard<std::mutex> lock(exception_mutex);
                        if (!first_exception) {
                            first_exception = std::current_exception();
                        }
                        shared_budget.stop_requested.store(true, std::memory_order_release);
                    }
                });
            }
            guard.join_all();
        }

        if (first_exception) {
            std::rethrow_exception(first_exception);
        }

        std::uint64_t total_samples = 0;
        std::uint64_t total_visits = 0;
        for (std::size_t target_index = 0; target_index < target_points.size(); ++target_index) {
            const auto &slot = per_target[target_index];
            result.target_diagnostics.push_back(slot.target_diag);
            for (int component = 0; component < 3; ++component) {
                result.h_xyz_apm[3u * target_index + static_cast<std::size_t>(component)] =
                    slot.field[component];
            }
            result.diagnostics.refined_pairs += slot.refined_pairs;
            result.diagnostics.maximum_pair_error_apm = std::max(
                result.diagnostics.maximum_pair_error_apm,
                slot.maximum_pair_error_apm);
            result.diagnostics.gpu_farfield_pairs += slot.gpu_farfield_pairs;
            result.diagnostics.cpu_near_singular_pairs += slot.cpu_near_singular_pairs;
            total_samples += slot.target_diag.kernel_evaluations;
            total_visits += slot.target_diag.ledger_leaf_visits;
        }
        work.charge_exact(total_samples, total_visits);
    } else {
        for (std::size_t target_index = 0; target_index < target_points.size(); ++target_index) {
            const auto slot = evaluate_target_gpu_hybrid(
                elements, target_points[target_index], target_index,
                gpu_out, options, quad_tables, work, 1);
            result.target_diagnostics.push_back(slot.target_diag);
            for (int component = 0; component < 3; ++component) {
                const double value = slot.field[component];
                if (!std::isfinite(value)) {
                    throw std::runtime_error(
                        "direct tetrahedral Oersted field is non-finite");
                }
                result.h_xyz_apm[3u * target_index + static_cast<std::size_t>(component)] = value;
            }
            result.diagnostics.refined_pairs += slot.refined_pairs;
            result.diagnostics.maximum_pair_error_apm = std::max(
                result.diagnostics.maximum_pair_error_apm,
                slot.maximum_pair_error_apm);
            result.diagnostics.gpu_farfield_pairs += slot.gpu_farfield_pairs;
            result.diagnostics.cpu_near_singular_pairs += slot.cpu_near_singular_pairs;
            if (observer) {
                observer->emit(AntennaProgressPhase::evaluating_field,
                    target_index + 1, target_count, source_count);
            }
        }
    }

    result.diagnostics.kernel_evaluations = work.kernel_evaluations - initial_samples;
    result.diagnostics.ledger_leaf_visits = work.ledger_leaf_visits - initial_visits;
    return result;
}

#endif

std::array<Point, 4> element_vertices(const mfem::Mesh &mesh, int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    if (vertices.Size() != 4) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted requires tetrahedral sources");
    }
    std::array<Point, 4> result{};
    for (int local = 0; local < 4; ++local) {
        const auto *coordinate = mesh.GetVertex(vertices[local]);
        result[local] = {coordinate[0], coordinate[1], coordinate[2]};
    }
    return result;
}

std::vector<PreparedElement> prepare_source(
    const mfem::Mesh &mesh,
    const mfem::GridFunction &rt0_field,
    const DirectTetraQuadratureOptions &options)
{
    validate_pair_budget(static_cast<std::uint64_t>(mesh.GetNE()), 0, options);
    if (rt0_field.FESpace() == nullptr ||
            rt0_field.FESpace()->GetMesh() == nullptr ||
            rt0_field.FESpace()->FEColl() == nullptr ||
            rt0_field.FESpace()->FEColl()->Name() != std::string("RT_3D_P0") ||
            rt0_field.FESpace()->GetMesh() != &mesh) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted requires an RT0 source field");
    }
    std::vector<PreparedElement> elements;
    elements.reserve(mesh.GetNE());
    for (int element = 0; element < mesh.GetNE(); ++element) {
        elements.push_back({CurrentElement(rt0_field, element), element_vertices(mesh, element)});
    }
    return elements;
}

DirectTetraQuadratureResult evaluate_prepared_impl(
    const std::vector<PreparedElement> &elements,
    const std::vector<Point> &target_points,
    const DirectTetraQuadratureOptions &options,
    WorkBudget &work,
    bool enforce_pair_budget,
    const SurfaceRt0ProgressObserver *observer = nullptr)
{
    const auto source_count = static_cast<std::uint64_t>(elements.size());
    const auto target_count = static_cast<std::uint64_t>(target_points.size());
    if (enforce_pair_budget) {
        validate_pair_budget(source_count, target_count, options);
    } else {
        (void)DirectTetraQuadrature::ResolveWorkLimits(options);
        if (source_count > DirectTetraQuadrature::maximum_final_leaves_per_target) {
            throw std::invalid_argument("direct tetrahedral Oersted cardinality is invalid");
        }
    }
    for (const auto &target : target_points) {
        for (const double coordinate : target) {
            if (!std::isfinite(coordinate)) {
                throw std::invalid_argument("direct tetrahedral Oersted target is non-finite");
            }
        }
    }

    const auto quad_tables = QuadratureRuleTable::build(options);

    if (options.execution_policy == DirectTetraExecutionPolicy::GpuHybridFarField) {
#if defined(FULLMAG_HAS_CUDA_RUNTIME) && FULLMAG_HAS_CUDA_RUNTIME
        return evaluate_prepared_gpu_hybrid(
            elements, target_points, options, quad_tables, work, observer);
#else
        throw std::runtime_error(
            "direct tetrahedral Oersted GPU hybrid policy requires CUDA runtime");
#endif
    }

    const auto initial_samples = work.kernel_evaluations;
    const auto initial_visits = work.ledger_leaf_visits;
    DirectTetraQuadratureResult result;
    result.operator_version = DirectTetraQuadrature::operator_version;
    result.h_xyz_apm.assign(target_points.size() * 3u, 0.0);
    result.target_diagnostics.reserve(target_points.size());
    result.diagnostics.source_target_pairs = source_count * target_count;
    result.diagnostics.resolved_execution_policy = "cpu_deterministic";
    result.diagnostics.gpu_farfield_pairs = 0;
    result.diagnostics.cpu_near_singular_pairs = source_count * target_count;

    const int requested_workers = resolve_available_worker_threads(options.worker_threads);
    const bool use_target_parallel = requested_workers > 1 &&
        target_points.size() >= static_cast<std::size_t>(2 * requested_workers);
    const bool use_source_parallel = !use_target_parallel &&
        requested_workers > 1 &&
        !target_points.empty() &&
        elements.size() >= kSourceRootParallelThreshold;
    const int effective_workers = use_target_parallel
        ? requested_workers
        : (use_source_parallel
            ? std::min<int>(requested_workers, static_cast<int>(elements.size()))
            : 1);
    result.diagnostics.effective_worker_threads = effective_workers;

    if (observer) {
        observer->emit(AntennaProgressPhase::evaluating_field, 0, target_count, source_count);
    }

    if (use_target_parallel) {
        SharedWorkBudget shared_budget(work.limits);
        shared_budget.kernel_evaluations.store(work.kernel_evaluations, std::memory_order_relaxed);
        shared_budget.ledger_leaf_visits.store(work.ledger_leaf_visits, std::memory_order_relaxed);

        std::vector<TargetEvalOutput> per_target(target_points.size());
        std::atomic<std::size_t> next_target{0};
        std::mutex observer_mutex;
        std::uint64_t completed_targets = 0;
        std::mutex exception_mutex;
        std::exception_ptr first_exception;

        {
            ThreadJoinGuard guard(&shared_budget.stop_requested);
            guard.threads.reserve(static_cast<std::size_t>(effective_workers));
            for (int w = 0; w < effective_workers; ++w) {
                guard.threads.emplace_back([&]() {
                    try {
                        WorkBudget local_work(options, &shared_budget);
                        for (;;) {
                            if (shared_budget.stop_requested.load(std::memory_order_acquire)) {
                                break;
                            }
                            const std::size_t target_index =
                                next_target.fetch_add(1u, std::memory_order_relaxed);
                            if (target_index >= target_points.size()) {
                                break;
                            }
                            DirectTetraQuadratureDiagnostics local_diag;
                            const auto target_result = evaluate_target(
                                elements, target_points[target_index], options,
                                quad_tables, local_work, local_diag, 1);
                            local_work.flush_all();
                            for (int component = 0; component < 3; ++component) {
                                if (!std::isfinite(target_result.first[component])) {
                                    throw std::runtime_error(
                                        "direct tetrahedral Oersted field is non-finite");
                                }
                            }
                            per_target[target_index] = {
                                target_result.first,
                                target_result.second,
                                local_diag.refined_pairs,
                                local_diag.maximum_pair_error_apm,
                                0,
                                source_count};
                            if (observer != nullptr) {
                                std::lock_guard<std::mutex> lock(observer_mutex);
                                const std::uint64_t done = ++completed_targets;
                                observer->emit(AntennaProgressPhase::evaluating_field,
                                    done, target_count, source_count);
                            }
                        }
                    } catch (const ParallelCancelled &) {
                        // Sibling worker recorded the primary failure.
                    } catch (...) {
                        std::lock_guard<std::mutex> lock(exception_mutex);
                        if (!first_exception) {
                            first_exception = std::current_exception();
                        }
                        shared_budget.stop_requested.store(true, std::memory_order_release);
                    }
                });
            }
            guard.join_all();
        }

        if (first_exception) {
            std::rethrow_exception(first_exception);
        }

        std::uint64_t total_samples = 0;
        std::uint64_t total_visits = 0;
        for (std::size_t target_index = 0; target_index < target_points.size(); ++target_index) {
            const auto &slot = per_target[target_index];
            result.target_diagnostics.push_back(slot.target_diag);
            for (int component = 0; component < 3; ++component) {
                result.h_xyz_apm[3u * target_index + static_cast<std::size_t>(component)] =
                    slot.field[component];
            }
            result.diagnostics.refined_pairs += slot.refined_pairs;
            result.diagnostics.maximum_pair_error_apm = std::max(
                result.diagnostics.maximum_pair_error_apm,
                slot.maximum_pair_error_apm);
            total_samples += slot.target_diag.kernel_evaluations;
            total_visits += slot.target_diag.ledger_leaf_visits;
        }
        work.charge_exact(total_samples, total_visits);
    } else {
        const int root_workers = use_source_parallel ? effective_workers : 1;
        for (std::size_t target_index = 0; target_index < target_points.size();
                ++target_index) {
            const auto target_result = evaluate_target(
                elements, target_points[target_index], options, quad_tables,
                work, result.diagnostics, root_workers);
            result.target_diagnostics.push_back(target_result.second);
            for (int component = 0; component < 3; ++component) {
                const double value = target_result.first[component];
                if (!std::isfinite(value)) {
                    throw std::runtime_error(
                        "direct tetrahedral Oersted field is non-finite");
                }
                result.h_xyz_apm[3u * target_index +
                    static_cast<std::size_t>(component)] = value;
            }
            if (observer) {
                observer->emit(AntennaProgressPhase::evaluating_field,
                    target_index + 1, target_count, source_count);
            }
        }
    }

    result.diagnostics.kernel_evaluations = work.kernel_evaluations - initial_samples;
    result.diagnostics.ledger_leaf_visits = work.ledger_leaf_visits - initial_visits;
    return result;
}

} // namespace

DirectTetraQuadratureWorkLimits DirectTetraQuadrature::ResolveWorkLimits(
    const DirectTetraQuadratureOptions &options)
{
    if (options.base_quadrature_order < 2 || options.base_quadrature_order > 16 ||
            options.maximum_subdivision_depth < 0 || options.maximum_subdivision_depth > 6 ||
            !(std::isfinite(options.absolute_tolerance_apm) && options.absolute_tolerance_apm >= 0.0) ||
            !(std::isfinite(options.relative_tolerance) && options.relative_tolerance >= 0.0) ||
            options.worker_threads < 0 ||
            (options.execution_policy != DirectTetraExecutionPolicy::CpuDeterministic &&
             options.execution_policy != DirectTetraExecutionPolicy::GpuHybridFarField)) {
        throw std::invalid_argument("direct tetrahedral Oersted options are invalid");
    }
    if (options.maximum_source_target_pairs > 0 &&
            options.maximum_source_target_pairs <= 1'000'000) {
        return {maximum_kernel_evaluations, maximum_ledger_leaf_visits};
    }
    if (options.maximum_source_target_pairs == 4'000'000 &&
            options.base_quadrature_order == 4 && options.maximum_subdivision_depth == 6 &&
            options.absolute_tolerance_apm == 1.0e-9 && options.relative_tolerance == 1.0e-5) {
        return {500'000'000, 500'000'000};
    }
    throw std::invalid_argument("direct tetrahedral Oersted work profile is invalid");
}

DirectTetraQuadratureResult DirectTetraQuadrature::Evaluate(
    const fullmag::fem::transport::ConservativeCurrentView &source,
    const std::vector<std::array<double, 3>> &target_points,
    const DirectTetraQuadratureOptions &options,
    const SurfaceRt0ProgressObserver *observer)
{
    auto result = EvaluateField(*source.space().GetMesh(), source.field(),
        target_points, options, observer);
    result.source_view_identity_digest = source.identity().view_identity_digest;
    return result;
}

DirectTetraQuadratureResult DirectTetraQuadrature::EvaluateField(
    const mfem::Mesh &mesh,
    const mfem::GridFunction &rt0_field,
    const std::vector<std::array<double, 3>> &target_points,
    const DirectTetraQuadratureOptions &options,
    const SurfaceRt0ProgressObserver *observer)
{
    validate_pair_budget(static_cast<std::uint64_t>(mesh.GetNE()),
        static_cast<std::uint64_t>(target_points.size()), options);
    const auto elements = prepare_source(mesh, rt0_field, options);
    WorkBudget work(options);
    return evaluate_prepared_impl(elements, target_points, options, work,
        /*enforce_pair_budget=*/true, observer);
}

DirectTetraQuadratureResult DirectTetraQuadrature::EvaluateFrozenField(
    const std::vector<fullmag::fem::transport::AffineRt0Element::FrozenInput> &source,
    const std::vector<std::array<double, 3>> &target_points,
    const DirectTetraQuadratureOptions &options,
    const SurfaceRt0ProgressObserver *observer)
{
    validate_pair_budget(static_cast<std::uint64_t>(source.size()),
        static_cast<std::uint64_t>(target_points.size()), options);
    std::vector<PreparedElement> elements;
    elements.reserve(source.size());
    for (const auto &input : source) {
        elements.push_back({CurrentElement(input), input.vertices_m});
    }
    WorkBudget work(options);
    return evaluate_prepared_impl(elements, target_points, options, work,
        /*enforce_pair_budget=*/true, observer);
}

DirectTetraQuadratureDiagnostics DirectTetraQuadrature::ProjectField(
    const mfem::GridFunction &rt0_field,
    mfem::GridFunction &target_field,
    const DirectTetraQuadratureOptions &options)
{
    if (rt0_field.FESpace() == nullptr ||
            rt0_field.FESpace()->GetMesh() == nullptr) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted projection requires a source space");
    }
    if (target_field.FESpace() == nullptr ||
            target_field.FESpace()->GetMesh() == nullptr ||
            target_field.FESpace()->GetVDim() != 3 ||
            target_field.FESpace()->GetOrdering() != mfem::Ordering::byVDIM ||
            target_field.FESpace()->FEColl() == nullptr ||
            std::string(target_field.FESpace()->FEColl()->Name()).rfind(
                "H1_3D_", 0) != 0) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted projection requires a vector H1 target space");
    }
    const mfem::Mesh &source_mesh = *rt0_field.FESpace()->GetMesh();
    mfem::Mesh &target_mesh = *target_field.FESpace()->GetMesh();
    if (source_mesh.Dimension() != 3 || target_mesh.Dimension() != 3) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted projection requires 3D meshes");
    }
    for (int element = 0; element < target_mesh.GetNE(); ++element) {
        if (target_mesh.GetElementBaseGeometry(element) !=
                mfem::Geometry::TETRAHEDRON) {
            throw std::invalid_argument(
                "direct tetrahedral Oersted projection requires tetrahedral targets");
        }
    }
    // The volume profile is only for pointwise closed-loop inspection.
    if (options.maximum_source_target_pairs > 1'000'000) {
        throw std::invalid_argument("direct tetrahedral Oersted H1 projection requires a legacy work profile");
    }
    // Freeze one source snapshot for all target quadrature points and Cartesian components.
    const auto elements = prepare_source(source_mesh, rt0_field, options);

    const int target_order = std::max(2, options.base_quadrature_order + 2);
    const mfem::IntegrationRule *target_rule = nullptr;
    {
        std::lock_guard<std::mutex> lock(mfem_int_rules_mutex());
        target_rule = &mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, target_order);
    }

    // MFEM's VectorFEMassIntegrator is for vector finite elements (ND/RT),
    // not a scalar H1 space with vdim=3.  Assemble one scalar H1 mass system,
    // evaluate the 3-component Biot-Savart field once across all quadrature
    // points, assemble all 3 RHS vectors in one element pass, and reuse a
    // single sparse mass factorization across all 3 Cartesian components.
    mfem::FiniteElementSpace scalar_space(
        &target_mesh, target_field.FESpace()->FEColl(), 1,
        mfem::Ordering::byNODES);
    const int scalar_dofs = scalar_space.GetVSize();
    if (target_field.Size() != 3 * scalar_dofs) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted H1 projection target vector layout is invalid");
    }
    mfem::BilinearForm mass(&scalar_space);
    auto *mass_integrator = new mfem::MassIntegrator();
    mass_integrator->SetIntRule(target_rule);
    mass.AddDomainIntegrator(mass_integrator);
    mass.Assemble();
    mass.Finalize();

    const int num_target_elements = target_mesh.GetNE();
    const int npts = target_rule->GetNPoints();
    std::vector<Point> target_points;
    target_points.reserve(static_cast<std::size_t>(num_target_elements) *
        static_cast<std::size_t>(npts));
    mfem::Vector physical(3);
    for (int element = 0; element < num_target_elements; ++element) {
        mfem::ElementTransformation *tr = target_mesh.GetElementTransformation(element);
        for (int p = 0; p < npts; ++p) {
            tr->Transform(target_rule->IntPoint(p), physical);
            target_points.push_back({physical[0], physical[1], physical[2]});
        }
    }

    // Single shared WorkBudget across the entire fused 3-component projection;
    // bypass only the pointwise pair cap so large projection meshes do not hit
    // false pair-cap errors relative to single-point evaluation.
    WorkBudget work(options);
    const auto evaluated = evaluate_prepared_impl(
        elements, target_points, options, work,
        /*enforce_pair_budget=*/false, /*observer=*/nullptr);

    std::array<mfem::Vector, 3> rhs;
    for (int component = 0; component < 3; ++component) {
        rhs[static_cast<std::size_t>(component)].SetSize(scalar_dofs);
        rhs[static_cast<std::size_t>(component)] = 0.0;
    }

    mfem::Array<int> vdofs;
    mfem::Vector shape;
    std::array<mfem::Vector, 3> elvect;
    std::size_t point_cursor = 0;
    for (int element = 0; element < num_target_elements; ++element) {
        const mfem::FiniteElement *fe = scalar_space.GetFE(element);
        mfem::ElementTransformation *tr = target_mesh.GetElementTransformation(element);
        const int dof_count = fe->GetDof();
        shape.SetSize(dof_count);
        for (int component = 0; component < 3; ++component) {
            elvect[static_cast<std::size_t>(component)].SetSize(dof_count);
            elvect[static_cast<std::size_t>(component)] = 0.0;
        }
        for (int p = 0; p < npts; ++p) {
            const mfem::IntegrationPoint &ip = target_rule->IntPoint(p);
            tr->SetIntPoint(&ip);
            fe->CalcShape(ip, shape);
            const double weight = ip.weight * tr->Weight();
            for (int component = 0; component < 3; ++component) {
                const double h_val = evaluated.h_xyz_apm[
                    3u * point_cursor + static_cast<std::size_t>(component)];
                elvect[static_cast<std::size_t>(component)].Add(weight * h_val, shape);
            }
            ++point_cursor;
        }
        scalar_space.GetElementDofs(element, vdofs);
        for (int component = 0; component < 3; ++component) {
            rhs[static_cast<std::size_t>(component)].AddElementVector(
                vdofs, elvect[static_cast<std::size_t>(component)]);
        }
    }

    target_field = 0.0;
    if (scalar_dofs > 0) {
        fullmag::fem::multiphysics::SparseSolveConfig mass_config;
        mass_config.kind = fullmag::fem::multiphysics::SparseMatrixKind::Spd;
        mass_config.execution_target = fullmag::fem::multiphysics::SparseExecutionTarget::Cpu;
        mass_config.cpu_backend = fullmag::fem::multiphysics::SparseCpuBackendPolicy::Auto;
        mass_config.relative_tolerance = 1.0e-12;
        mass_config.absolute_tolerance = 0.0;
        mass_config.maximum_iterations = 2000;
        fullmag::fem::multiphysics::SparseLinearSolver mass_solver(mass.SpMat(), mass_config);

        mfem::Vector solution(scalar_dofs);
        mfem::Vector residual(scalar_dofs);
        for (int component = 0; component < 3; ++component) {
            solution = 0.0;
            const auto &component_rhs = rhs[static_cast<std::size_t>(component)];
            const auto solve_stats = mass_solver.solve(component_rhs, solution, 1.0);
            mass.Mult(solution, residual);
            residual -= component_rhs;
            const double residual_norm = residual.Norml2();
            const double residual_scale = std::max(1.0, component_rhs.Norml2());
            if (!(solve_stats.converged && std::isfinite(residual_norm) &&
                    residual_norm <= 1.0e-10 * residual_scale)) {
                throw std::runtime_error(
                    "direct tetrahedral Oersted H1 projection mass residual exceeds tolerance");
            }
            for (int dof = 0; dof < scalar_dofs; ++dof) {
                target_field[component * scalar_dofs + dof] = solution[dof];
            }
        }
    }
    for (int dof = 0; dof < target_field.Size(); ++dof) {
        if (!std::isfinite(target_field[dof])) {
            throw std::runtime_error(
                "direct tetrahedral Oersted H1 projection is non-finite");
        }
    }
    return evaluated.diagnostics;
}

} // namespace fullmag::fem::oersted
