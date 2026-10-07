#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"
#include "cpu/mfem/transport/affine_rt0_element.hpp"

#include <mfem.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace fullmag::fem::oersted {
namespace {

using Point = std::array<double, 3>;
using CurrentElement = fullmag::fem::transport::AffineRt0Element;
struct PreparedElement {
    CurrentElement current;
    std::array<Point, 4> vertices;
};

struct WorkBudget {
    std::uint64_t kernel_evaluations = 0;
    std::uint64_t ledger_leaf_visits = 0;

    void sample()
    {
        if (kernel_evaluations >= DirectTetraQuadrature::maximum_kernel_evaluations) {
            throw std::runtime_error("kernel_evaluation_budget_exceeded");
        }
        ++kernel_evaluations;
    }
    void visit()
    {
        if (ledger_leaf_visits >= DirectTetraQuadrature::maximum_ledger_leaf_visits) {
            throw std::runtime_error("ledger_leaf_visit_budget_exceeded");
        }
        ++ledger_leaf_visits;
    }
};

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

DirectTetraQuadratureResult evaluate_prepared(
    const std::vector<PreparedElement> &elements,
    const std::vector<Point> &target_points,
    const DirectTetraQuadratureOptions &options,
    WorkBudget &work);

void validate_pair_budget(std::uint64_t source_count, std::uint64_t target_count,
    const DirectTetraQuadratureOptions &options)
{
    if (options.base_quadrature_order < 2 || options.base_quadrature_order > 16 ||
            options.maximum_subdivision_depth < 0 || options.maximum_subdivision_depth > 6 ||
            !(std::isfinite(options.absolute_tolerance_apm) && options.absolute_tolerance_apm >= 0.0) ||
            !(std::isfinite(options.relative_tolerance) && options.relative_tolerance >= 0.0) ||
            source_count > DirectTetraQuadrature::maximum_final_leaves_per_target ||
            target_count > 1'000'000 || options.maximum_source_target_pairs > 1'000'000) {
        throw std::invalid_argument("direct tetrahedral Oersted options or cardinality are invalid");
    }
    if (options.maximum_source_target_pairs == 0 ||
            (target_count != 0 && source_count >
                options.maximum_source_target_pairs / target_count)) {
        throw std::invalid_argument(
            "direct tetrahedral Oersted source-target pair budget exceeded");
    }
}
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kBarycentricTolerance = 1.0e-12;

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
    WorkBudget &work)
{
    const auto &rules = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, order);
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
    for (int point = 0; point < rules.GetNPoints(); ++point) {
        work.sample();
        const auto &ip = rules.IntPoint(point);
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
        const double weight = jacobian * rules.IntPoint(point).weight;
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
    WorkBudget &work)
{
    const auto &rules = mfem::IntRules.Get(mfem::Geometry::SEGMENT, order);
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
    for (int xi_index = 0; xi_index < rules.GetNPoints(); ++xi_index) {
        const auto &xi_point = rules.IntPoint(xi_index);
        const double xi = xi_point.x;
        for (int eta_index = 0; eta_index < rules.GetNPoints(); ++eta_index) {
            const auto &eta_point = rules.IntPoint(eta_index);
            const double eta = eta_point.x;
            for (int zeta_index = 0; zeta_index < rules.GetNPoints();
                    ++zeta_index) {
                const auto &zeta_point = rules.IntPoint(zeta_index);
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

class DirectScalarCoefficient final : public mfem::Coefficient {
public:
    DirectScalarCoefficient(
        const std::vector<PreparedElement> &source,
        const DirectTetraQuadratureOptions &options,
        int component,
        WorkBudget &work)
        : source_(source), options_(options), component_(component), work_(work)
    {
        if (component_ < 0 || component_ >= 3) {
            throw std::invalid_argument(
                "direct tetrahedral Oersted scalar projection component is invalid");
        }
    }

    double Eval(
        mfem::ElementTransformation &transformation,
        const mfem::IntegrationPoint &point) override
    {
        mfem::Vector physical(3);
        transformation.Transform(point, physical);
        const std::vector<std::array<double, 3>> targets{
            {physical[0], physical[1], physical[2]}};
        const auto result = evaluate_prepared(source_, targets, options_, work_);
        diagnostics_.source_target_pairs +=
            result.diagnostics.source_target_pairs;
        diagnostics_.refined_pairs += result.diagnostics.refined_pairs;
        diagnostics_.kernel_evaluations += result.diagnostics.kernel_evaluations;
        diagnostics_.ledger_leaf_visits += result.diagnostics.ledger_leaf_visits;
        diagnostics_.unconverged_pair_count +=
            result.diagnostics.unconverged_pair_count;
        diagnostics_.maximum_pair_error_apm = std::max(
            diagnostics_.maximum_pair_error_apm,
            result.diagnostics.maximum_pair_error_apm);
        return result.h_xyz_apm[static_cast<std::size_t>(component_)];
    }

    const DirectTetraQuadratureDiagnostics &diagnostics() const
    {
        return diagnostics_;
    }

private:
    const std::vector<PreparedElement> &source_;
    const DirectTetraQuadratureOptions &options_;
    int component_;
    WorkBudget &work_;
    DirectTetraQuadratureDiagnostics diagnostics_;
};

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
                    effective_target, low_order, work);
                const auto hi = integrate_duffy_once(source, singular_children[child],
                    effective_target, high_order, work);
                low_sum.add(lo.value);
                high_sum.add(hi.value);
                magnitude.add(lo.weighted_norm_sum);
                magnitude.add(hi.weighted_norm_sum);
            }
            low = {low_sum.point(), magnitude.value};
            high = {high_sum.point(), 0.0L};
        } else {
            low = integrate_once(source, leaf.vertices, target, low_order, work);
            high = integrate_once(source, leaf.vertices, target, high_order, work);
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

std::pair<Point, DirectTetraTargetDiagnostics> evaluate_target(
    const std::vector<PreparedElement> &elements,
    const Point &target,
    const DirectTetraQuadratureOptions &options,
    WorkBudget &work,
    DirectTetraQuadratureDiagnostics &diagnostics)
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
        for (std::size_t source = 0; source < elements.size(); ++source) {
            Leaf leaf;
            leaf.vertices = elements[source].vertices;
            leaf.source_index = source;
            leaf.sequence = sequence++;
            leaves.push_back(evaluate_leaf(elements, leaf, target, options, work, diagnostics));
            ledger.add(leaves.back(), 1);
            enqueue(leaves.size() - 1u);
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
                children[child] = evaluate_leaf(elements, leaf, target, options, work, diagnostics);
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

} // namespace

DirectTetraQuadratureResult DirectTetraQuadrature::Evaluate(
    const fullmag::fem::transport::ConservativeCurrentView &source,
    const std::vector<std::array<double, 3>> &target_points,
    const DirectTetraQuadratureOptions &options)
{
    auto result = EvaluateField(*source.space().GetMesh(), source.field(),
        target_points, options);
    result.source_view_identity_digest = source.identity().view_identity_digest;
    return result;
}

namespace {

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

DirectTetraQuadratureResult evaluate_prepared(
    const std::vector<PreparedElement> &elements,
    const std::vector<Point> &target_points,
    const DirectTetraQuadratureOptions &options,
    WorkBudget &work)
{
    const auto source_count = static_cast<std::uint64_t>(elements.size());
    const auto target_count = static_cast<std::uint64_t>(target_points.size());
    validate_pair_budget(source_count, target_count, options);
    for (const auto &target : target_points) {
        for (const double coordinate : target) {
            if (!std::isfinite(coordinate)) {
                throw std::invalid_argument("direct tetrahedral Oersted target is non-finite");
            }
        }
    }
    const auto initial_samples = work.kernel_evaluations;
    const auto initial_visits = work.ledger_leaf_visits;
    DirectTetraQuadratureResult result;
    result.operator_version = DirectTetraQuadrature::operator_version;
    result.h_xyz_apm.assign(target_points.size() * 3u, 0.0);
    result.target_diagnostics.reserve(target_points.size());
    result.diagnostics.source_target_pairs = source_count * target_count;
    for (std::size_t target_index = 0; target_index < target_points.size();
            ++target_index) {
        const auto target_result = evaluate_target(elements, target_points[target_index],
            options, work, result.diagnostics);
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
    }
    result.diagnostics.kernel_evaluations = work.kernel_evaluations - initial_samples;
    result.diagnostics.ledger_leaf_visits = work.ledger_leaf_visits - initial_visits;
    return result;
}

} // namespace

DirectTetraQuadratureResult DirectTetraQuadrature::EvaluateField(
    const mfem::Mesh &mesh,
    const mfem::GridFunction &rt0_field,
    const std::vector<std::array<double, 3>> &target_points,
    const DirectTetraQuadratureOptions &options)
{
    validate_pair_budget(static_cast<std::uint64_t>(mesh.GetNE()),
        static_cast<std::uint64_t>(target_points.size()), options);
    const auto elements = prepare_source(mesh, rt0_field, options);
    WorkBudget work;
    return evaluate_prepared(elements, target_points, options, work);
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
    // Freeze one source snapshot for all target points and Cartesian components.
    const auto elements = prepare_source(source_mesh, rt0_field, options);

    const int target_order = std::max(2, options.base_quadrature_order + 2);
    const auto &target_rule = mfem::IntRules.Get(
        mfem::Geometry::TETRAHEDRON, target_order);

    // MFEM's VectorFEMassIntegrator is for vector finite elements (ND/RT),
    // not a scalar H1 space with vdim=3.  Assemble one scalar H1 mass system
    // per Cartesian component and lift the three solutions into byVDIM data.
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
    mass_integrator->SetIntRule(&target_rule);
    mass.AddDomainIntegrator(mass_integrator);
    mass.Assemble();
    mass.Finalize();

    target_field = 0.0;
    mfem::GSSmoother smoother(mass.SpMat());
    DirectTetraQuadratureDiagnostics diagnostics;
    mfem::Vector solution(scalar_dofs);
    mfem::Vector residual(scalar_dofs);
    WorkBudget work;
    for (int component = 0; component < 3; ++component) {
        DirectScalarCoefficient direct_component(
            elements, options, component, work);
        mfem::LinearForm rhs(&scalar_space);
        auto *rhs_integrator = new mfem::DomainLFIntegrator(direct_component);
        rhs_integrator->SetIntRule(&target_rule);
        rhs.AddDomainIntegrator(rhs_integrator);
        rhs.Assemble();

        solution = 0.0;
        mfem::PCG(mass, smoother, rhs, solution,
            0, 1000, 1.0e-12, 1.0e-24);
        mass.Mult(solution, residual);
        residual -= rhs;
        const double residual_norm = residual.Norml2();
        const double residual_scale = std::max(1.0, rhs.Norml2());
        if (!(std::isfinite(residual_norm) &&
                residual_norm <= 1.0e-10 * residual_scale)) {
            throw std::runtime_error(
                "direct tetrahedral Oersted H1 projection mass residual exceeds tolerance");
        }
        diagnostics.source_target_pairs +=
            direct_component.diagnostics().source_target_pairs;
        diagnostics.refined_pairs += direct_component.diagnostics().refined_pairs;
        diagnostics.kernel_evaluations += direct_component.diagnostics().kernel_evaluations;
        diagnostics.ledger_leaf_visits += direct_component.diagnostics().ledger_leaf_visits;
        diagnostics.unconverged_pair_count +=
            direct_component.diagnostics().unconverged_pair_count;
        diagnostics.maximum_pair_error_apm = std::max(
            diagnostics.maximum_pair_error_apm,
            direct_component.diagnostics().maximum_pair_error_apm);
        for (int dof = 0; dof < scalar_dofs; ++dof) {
            target_field[component * scalar_dofs + dof] = solution[dof];
        }
    }
    for (int dof = 0; dof < target_field.Size(); ++dof) {
        if (!std::isfinite(target_field[dof])) {
            throw std::runtime_error(
                "direct tetrahedral Oersted H1 projection is non-finite");
        }
    }
    return diagnostics;
}

} // namespace fullmag::fem::oersted
