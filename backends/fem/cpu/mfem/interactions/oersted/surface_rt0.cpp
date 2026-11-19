#include "cpu/mfem/interactions/oersted/surface_rt0.hpp"

#include <boost/math/special_functions/fpclassify.hpp>
#include <boost/multiprecision/cpp_dec_float.hpp>
#include <boost/multiprecision/cpp_int.hpp>
#include <boost/multiprecision/gmp.hpp>
#include <boost/multiprecision/mpfr.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <utility>
#include <iomanip>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <type_traits>

namespace fullmag::fem::oersted {
namespace {
using Integer = boost::multiprecision::mpz_int;
using Exact = boost::multiprecision::mpq_rational;
static_assert(std::numeric_limits<boost::multiprecision::limb_type>::digits ==
    std::numeric_limits<unsigned long>::digits,
    "GMP and cpp_int decimal conversion limb widths must match");
// Logical 80/120 passes retain more digits than the former guard-limb capacities.
// Disable expression-template FMA; keep explicit operation materialization.
using Decimal80 = boost::multiprecision::number<
    boost::multiprecision::mpfr_float_backend<128, boost::multiprecision::allocate_stack>,
    boost::multiprecision::et_off>;
using Decimal120 = boost::multiprecision::number<
    boost::multiprecision::mpfr_float_backend<160, boost::multiprecision::allocate_stack>,
    boost::multiprecision::et_off>;
static_assert(std::numeric_limits<Decimal80>::digits10 >=
    boost::multiprecision::cpp_dec_float<80>::cpp_dec_float_total_digits10);
static_assert(std::numeric_limits<Decimal120>::digits10 >=
    boost::multiprecision::cpp_dec_float<120>::cpp_dec_float_total_digits10);
template<class R> using Vector = std::array<R, 3>;
using ExactPoint = Vector<Exact>;
using Clock = std::chrono::steady_clock;
using Kind = SurfaceRt0WorkKind;

// One active phase at a time, including exception unwinding. Disabled calls
// perform no clock reads and never allocate, serialize or log diagnostics.
class PhaseProfiler {
public:
    explicit PhaseProfiler(SurfaceRt0PhaseReport *report) noexcept : report_(report)
    {
        if (!report_) return;
        *report_ = {};
        report_->started = true;
        started_ = last_ = Clock::now();
    }
    ~PhaseProfiler() noexcept
    {
        if (!report_) return;
        const auto now = Clock::now();
        record(now);
        report_->total_wall_time_ns = elapsed(started_,now);
        std::uint64_t attributed = 0;
        for (std::size_t i = 0; i < static_cast<std::size_t>(SurfaceRt0Phase::unattributed); ++i)
            add(attributed,report_->wall_time_ns[i]);
        const auto unattributed = static_cast<std::size_t>(SurfaceRt0Phase::unattributed);
        if (attributed > report_->total_wall_time_ns) {
            report_->accounting_issue = true;
            report_->wall_time_ns[unattributed] = 0;
        } else {
            const auto remainder = report_->total_wall_time_ns-attributed;
            if (report_->wall_time_ns[unattributed] != remainder)
                report_->accounting_issue = true;
            report_->wall_time_ns[unattributed] = remainder;
        }
    }
    void phase(SurfaceRt0Phase phase) noexcept
    {
        if (!report_) return;
        const auto now = Clock::now();
        record(now);
        active_ = phase;
    }
private:
    std::uint64_t elapsed(Clock::time_point from, Clock::time_point to) noexcept
    {
        const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(to-from).count();
        if (ns < 0) { report_->accounting_issue = true; return 0; }
        return static_cast<std::uint64_t>(ns);
    }
    void add(std::uint64_t &value, std::uint64_t amount) noexcept
    {
        if (amount > std::numeric_limits<std::uint64_t>::max()-value) {
            report_->accounting_issue = true;
            value = std::numeric_limits<std::uint64_t>::max();
        } else value += amount;
    }
    void record(Clock::time_point now) noexcept
    {
        add(report_->wall_time_ns[static_cast<std::size_t>(active_)],elapsed(last_,now));
        last_ = now;
    }
    SurfaceRt0PhaseReport *report_;
    SurfaceRt0Phase active_ = SurfaceRt0Phase::source_prepare;
    Clock::time_point started_{};
    Clock::time_point last_{};
};

class NumericRefusal : public std::runtime_error {
public:
    explicit NumericRefusal(const char *message) : std::runtime_error(message) {}
};

void require(bool condition, const char *message)
{
    if (!condition) throw std::invalid_argument(message);
}
void numeric(bool condition, const char *message)
{
    if (!condition) throw NumericRefusal(message);
}
std::uint64_t product(std::uint64_t a, std::uint64_t b)
{
    if (b && a > std::numeric_limits<std::uint64_t>::max() / b)
        throw std::runtime_error("surface RT0 checked size product overflow");
    return a * b;
}

class Work {
public:
    Work(const SurfaceRt0WorkLimits &limits, const SurfaceRt0PeakRss &rss,
        SurfaceRt0WorkReport &report, const SurfaceRt0ProgressObserver *observer = nullptr,
        std::uint64_t total_targets = 0, std::uint64_t source_cells = 0) :
        limits_(limits), rss_(rss), report_(report), observer_(observer),
        total_targets_(total_targets), source_cells_(source_cells),
        started_(Clock::now()), target_started_(started_)
    {
        for (std::size_t i = 0; i < surface_rt0_work_kind_count; ++i)
            require(limits.total[i] > 0 && limits.per_target[i] > 0,
                "surface RT0 count limits must all be positive");
        require(limits.maximum_raw_integer_bits > 0 && limits.maximum_reduced_fraction_bits > 0 &&
            limits.maximum_lifetime_peak_rss_bytes > 0 && limits.guard_interval_events > 0 &&
            std::isfinite(limits.maximum_total_seconds) && limits.maximum_total_seconds > 0 &&
            std::isfinite(limits.maximum_target_seconds) && limits.maximum_target_seconds > 0,
            "surface RT0 work limits must be positive and finite");
        require(static_cast<bool>(rss_), "surface RT0 requires a process peak RSS callback");
        guard();
    }
    void begin_target(std::size_t index)
    {
        active_ = true;
        report_.current_target_index = index;
        report_.current_target = {};
        target_started_ = Clock::now();
        guard();
    }
    void charge(Kind kind, std::uint64_t amount = 1, int precision = -1)
    {
        const auto i = static_cast<std::size_t>(kind);
        add(report_.total[i], amount);
        if (active_) add(report_.current_target[i], amount);
        if (precision >= 0) add(report_.by_precision[static_cast<std::size_t>(precision)][i], amount);
        if (report_.total[i] > limits_.total[i] ||
            (active_ && report_.current_target[i] > limits_.per_target[i]))
            throw std::runtime_error("surface RT0 named work limit exhausted");
        if (++events_ == limits_.guard_interval_events) { events_ = 0; guard(); }
    }
    void guard()
    {
        const auto before = Clock::now();
        report_.elapsed_seconds = std::chrono::duration<double>(before - started_).count();
        std::uint64_t sample;
        try { sample = rss_(); }
        catch (...) { throw std::runtime_error("surface RT0 process peak RSS callback failed"); }
        if (!sample) throw std::runtime_error("surface RT0 process peak RSS callback returned zero");
        report_.last_sampled_lifetime_peak_rss_bytes =
            std::max(report_.last_sampled_lifetime_peak_rss_bytes, sample);
        const auto now = Clock::now();
        report_.elapsed_seconds = std::chrono::duration<double>(now - started_).count();
        if (report_.elapsed_seconds > limits_.maximum_total_seconds ||
            (active_ && std::chrono::duration<double>(now - target_started_).count() > limits_.maximum_target_seconds))
            throw std::runtime_error("surface RT0 wall-time exhausted");
        if (report_.last_sampled_lifetime_peak_rss_bytes > limits_.maximum_lifetime_peak_rss_bytes)
            throw std::runtime_error("surface RT0 sampled process peak RSS exhausted");
        if (observer_ && now - last_progress_ >= std::chrono::milliseconds(500)) {
            last_progress_ = now;
            observer_->emit(AntennaProgressPhase::evaluating_field, completed_targets_, total_targets_, source_cells_);
        }
    }
    void complete_target()
    {
        if (!observer_) return;
        ++completed_targets_;
        last_progress_ = Clock::now();
        observer_->emit(AntennaProgressPhase::evaluating_field, completed_targets_, total_targets_, source_cells_);
    }
    void reserve_output(std::uint64_t count, std::uint64_t size)
    {
        const auto bytes = product(count, size);
        if (bytes > std::numeric_limits<std::size_t>::max())
            throw std::runtime_error("surface RT0 output reservation is not representable");
        charge(Kind::reserved_output_bytes, bytes);
        guard();
    }
    void raw_preflight(std::uint64_t bits)
    {
        // Conservative preallocation refusal, not a claim about Boost capacity.
        if (bits > limits_.maximum_raw_integer_bits)
            throw std::runtime_error("surface RT0 raw integer preallocation bound exhausted");
    }
    void raw_bits(std::uint64_t bits)
    {
        report_.maximum_raw_integer_bits = std::max(report_.maximum_raw_integer_bits, bits);
        if (bits > limits_.maximum_raw_integer_bits)
            throw std::runtime_error("surface RT0 raw integer bit limit exhausted");
    }
    void reduced_bits(std::uint64_t bits)
    {
        report_.maximum_reduced_fraction_bits = std::max(report_.maximum_reduced_fraction_bits, bits);
        if (bits > limits_.maximum_reduced_fraction_bits)
            throw std::runtime_error("surface RT0 reduced fraction bit limit exhausted");
    }
    const SurfaceRt0WorkCounts &target_counts() const { return report_.current_target; }
private:
    static void add(std::uint64_t &value, std::uint64_t amount)
    {
        if (amount > std::numeric_limits<std::uint64_t>::max() - value)
            throw std::runtime_error("surface RT0 work counter overflow");
        value += amount;
    }
    const SurfaceRt0WorkLimits &limits_;
    const SurfaceRt0PeakRss &rss_;
    SurfaceRt0WorkReport &report_;
    const SurfaceRt0ProgressObserver *observer_ = nullptr;
    std::uint64_t total_targets_ = 0, source_cells_ = 0, completed_targets_ = 0;
    Clock::time_point last_progress_{};
    Clock::time_point started_, target_started_;
    bool active_ = false;
    std::uint64_t events_ = 0;
};

class ExactArithmetic {
public:
    explicit ExactArithmetic(Work &work) : work_(work) {}
    Exact input(double value)
    {
        require(std::isfinite(value), "surface RT0 input must be finite binary64");
        // Counts original binary64 scalar copies, not derived Boost heap traffic.
        work_.charge(Kind::copied_input_bytes, sizeof(double));

        static_assert(sizeof(double) == sizeof(std::uint64_t) &&
            std::numeric_limits<double>::is_iec559 && std::numeric_limits<double>::digits == 53,
            "surface RT0 requires IEEE binary64 inputs");
        std::uint64_t encoded;
        std::memcpy(&encoded,&value,sizeof(encoded));
        const auto biased = static_cast<unsigned>((encoded >> 52) & 0x7ffU);
        std::uint64_t significand = encoded & ((std::uint64_t(1) << 52)-1);
        if (biased) significand |= std::uint64_t(1) << 52;
        int exponent = biased ? static_cast<int>(biased)-1023-52 : -1074;
        if (!significand) exponent = 0;
        else while (!(significand & 1U)) { significand >>= 1; ++exponent; }
        std::uint64_t significand_bits = 0;
        for (auto remaining = significand; remaining; remaining >>= 1) ++significand_bits;
        const auto numerator_bits = significand_bits + static_cast<std::uint64_t>(std::max(0,exponent));
        const auto denominator_bits = static_cast<std::uint64_t>(exponent < 0 ? 1-exponent : 1);
        const auto bound = std::max(numerator_bits,denominator_bits);
        work_.raw_preflight(bound); work_.reduced_bits(bound);
        Integer n(significand), d(1);
        work_.charge(Kind::exact_integer_operations);
        if (exponent >= 0) n <<= static_cast<unsigned>(exponent);
        else d <<= static_cast<unsigned>(-exponent);
        if (encoded >> 63) { work_.charge(Kind::exact_integer_operations); n = -n; }
        work_.charge(Kind::exact_fraction_operations);
        Exact result(n); result /= d;
        watch(result);
        return result;
    }
    std::uint64_t bits(mpz_srcptr value)
    {
        work_.charge(Kind::exact_integer_operations);
        return mpz_sgn(value) == 0 ? 0 : static_cast<std::uint64_t>(mpz_sizeinbase(value,2));
    }
    std::uint64_t bits(const Integer &value)
    {
        return bits(value.backend().data());
    }
    void watch(const Exact &value)
    {
        const auto n = bits(mpq_numref(value.backend().data()));
        const auto d = bits(mpq_denref(value.backend().data()));
        work_.raw_bits(std::max(n, d));
        work_.reduced_bits(std::max(n, d));
    }
    Integer multiply(const Integer &a, const Integer &b)
    {
        const auto first = bits(a), second = bits(b);
        if (second > std::numeric_limits<std::uint64_t>::max() - first)
            throw std::runtime_error("surface RT0 raw bit bound overflow");
        work_.raw_preflight(first + second);
        work_.charge(Kind::exact_integer_operations);
        Integer result = a * b;
        work_.raw_bits(bits(result));
        return result;
    }
    Integer sum(const Integer &a, const Integer &b, bool subtract)
    {
        const auto maximum = std::max(bits(a), bits(b));
        if (maximum == std::numeric_limits<std::uint64_t>::max())
            throw std::runtime_error("surface RT0 raw sum bound overflow");
        work_.raw_preflight(maximum + 1);
        work_.charge(Kind::exact_integer_operations);
        Integer result;
        if (subtract) result = a - b; else result = a + b;
        work_.raw_bits(bits(result));
        return result;
    }
    Exact operation(const Exact &a, const Exact &b, char operation)
    {
        work_.charge(Kind::exact_fraction_operations);
        watch(a); watch(b);
        const Integer an = boost::multiprecision::numerator(a), ad = boost::multiprecision::denominator(a);
        const Integer bn = boost::multiprecision::numerator(b), bd = boost::multiprecision::denominator(b);
        Integer n, d;
        if (operation == '+' || operation == '-') {
            n = sum(multiply(an, bd), multiply(bn, ad), operation == '-');
            d = multiply(ad, bd);
        } else if (operation == '*') { n = multiply(an, bn); d = multiply(ad, bd); }
        else {
            require(sign(b) != 0, "surface RT0 exact zero denominator");
            n = multiply(an, bd); d = multiply(ad, bn);
        }
        // Normalization/gcd is Boost-owned; explicit raw products above are bounded.
        Exact result(n); result /= d;
        watch(result);
        return result;
    }
    Exact add(const Exact &a, const Exact &b) { return operation(a, b, '+'); }
    Exact sub(const Exact &a, const Exact &b) { return operation(a, b, '-'); }
    Exact mul(const Exact &a, const Exact &b) { return operation(a, b, '*'); }
    Exact div(const Exact &a, const Exact &b) { return operation(a, b, '/'); }
    int sign(const Exact &a)
    {
        work_.charge(Kind::exact_comparisons); watch(a);
        return mpq_sgn(a.backend().data());
    }
    int compare(const Exact &a, const Exact &b)
    {
        work_.charge(Kind::exact_comparisons); watch(a); watch(b);
        const auto left = multiply(boost::multiprecision::numerator(a), boost::multiprecision::denominator(b));
        const auto right = multiply(boost::multiprecision::numerator(b), boost::multiprecision::denominator(a));
        return left == right ? 0 : left > right ? 1 : -1;
    }
    Exact absolute(const Exact &value) { return sign(value) < 0 ? sub(Exact(0), value) : value; }
    Exact power_of_two(int exponent)
    {
        const auto shift = static_cast<unsigned>(exponent < 0 ? -exponent : exponent);
        work_.raw_preflight(static_cast<std::uint64_t>(shift) + 1);
        work_.charge(Kind::exact_integer_operations);
        Integer value = Integer(1) << shift;
        work_.raw_bits(bits(value));
        return exponent >= 0 ? Exact(value) : div(Exact(1), Exact(value));
    }
    ExactPoint point(const std::array<double, 3> &p) { return {input(p[0]), input(p[1]), input(p[2])}; }
    ExactPoint subtract(const ExactPoint &a, const ExactPoint &b)
    { return {sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2])}; }
    ExactPoint cross(const ExactPoint &a, const ExactPoint &b)
    { return {sub(mul(a[1], b[2]), mul(a[2], b[1])), sub(mul(a[2], b[0]), mul(a[0], b[2])), sub(mul(a[0], b[1]), mul(a[1], b[0]))}; }
    Exact dot(const ExactPoint &a, const ExactPoint &b)
    {
        Exact result = 0;
        for (int i = 0; i < 3; ++i) result = add(result, mul(a[i], b[i]));
        return result;
    }
private:
    Work &work_;
};

template<class R> R absolute(const R &value) { return value < 0 ? R(-value) : value; }
template<class R> Vector<R> subtract(const Vector<R> &a, const Vector<R> &b)
{ return {R(a[0]-b[0]), R(a[1]-b[1]), R(a[2]-b[2])}; }
template<class R> R dot(const Vector<R> &a, const Vector<R> &b)
{ R value = 0; for (int i = 0; i < 3; ++i) value += a[i]*b[i]; return value; }
template<class R> Vector<R> cross(const Vector<R> &a, const Vector<R> &b)
{ return {R(a[1]*b[2]-a[2]*b[1]), R(a[2]*b[0]-a[0]*b[2]), R(a[0]*b[1]-a[1]*b[0])}; }

template<class R> class Arithmetic {
public:
    Arithmetic(Work &work, int precision) : work_(work), precision_(precision) {}
    R finite(const R &value) const { numeric(boost::math::isfinite(value), "surface RT0 nonfinite arithmetic"); return value; }
    R number(const Exact &value)
    {
        R result;
        if constexpr (std::is_same_v<R, double>) result = value.convert_to<double>();
        else result = divide(boost::multiprecision::numerator(value).template convert_to<R>(),
            boost::multiprecision::denominator(value).template convert_to<R>());
        finite(result);
        work_.charge(Kind::exact_comparisons,1,precision_);
        numeric(value == 0 || result != 0, "surface RT0 exact nonzero rounded to zero");
        return result;
    }
    Vector<R> point(const ExactPoint &p) { return {number(p[0]), number(p[1]), number(p[2])}; }
    R divide(const R &a, const R &b)
    {
        work_.charge(Kind::real_divisions, 1, precision_);
        numeric(b != 0, "surface RT0 rounded zero denominator");
        return finite(R(a/b));
    }
    R square_root(const R &value)
    {
        work_.charge(Kind::sqrt_calls, 1, precision_);
        numeric(value >= 0, "surface RT0 negative squared norm");
        using std::sqrt; return finite(R(sqrt(value)));
    }
    R logarithm(const R &value)
    {
        work_.charge(Kind::log_calls, 1, precision_);
        numeric(value > 0, "surface RT0 nonpositive logarithm");
        using std::log; return finite(R(log(value)));
    }
    R log_one_plus(const R &value)
    {
        work_.charge(Kind::log1p_calls, 1, precision_);
        numeric(value > -1, "surface RT0 invalid log1p");
        using std::log1p; return finite(R(log1p(value)));
    }
    R angle(const R &y, const R &x)
    {
        work_.charge(Kind::atan2_calls, 1, precision_);
        numeric(y != 0 || x != 0, "surface RT0 ambiguous angle");
        using std::atan2; return finite(R(atan2(y,x)));
    }
    R four_pi()
    {
        if (!four_pi_) four_pi_ = R(4)*angle(R(0),R(-1));
        return *four_pi_;
    }
    R norm(const Vector<R> &v)
    {
        const R result = square_root(dot(v,v));
        bool nonzero = false;
        for (const auto &value : v) nonzero = nonzero || value != 0;
        numeric(!nonzero || result > 0, "surface RT0 nonzero vector norm underflow");
        return result;
    }
    std::string text(const R &value)
    {
        finite(value);
        constexpr std::uint64_t capacity = std::numeric_limits<R>::max_digits10 + 64;
        // Bounded requested serialization storage; stream/Boost allocator internals
        // remain covered only by sampled process RSS, not this byte counter.
        work_.reserve_output(capacity, sizeof(char));
        std::ostringstream output;
        output << std::scientific << std::setprecision(std::numeric_limits<R>::digits10 + 5) << value;
        std::string result = output.str();
        numeric(result.size() <= capacity, "surface RT0 scalar serialization bound exceeded");
        work_.guard();
        return result;
    }
    int precision() const { return precision_; }
    Work &work() { return work_; }
private:
    Work &work_; int precision_;
    std::optional<R> four_pi_;
};

template<class R> struct Sum {
    R total = 0, correction = 0;
    void add(const R &value)
    {
        const R next = total + value;
        if (absolute(total) >= absolute(value)) correction += (total-next)+value;
        else correction += (value-next)+total;
        total = next;
        numeric(boost::math::isfinite(total) && boost::math::isfinite(correction), "surface RT0 compensated sum range");
    }
    R value() const { return R(total + correction); }
};

template<class R> R summed(const std::array<R, 3> &values)
{ Sum<R> result; for (const auto &v : values) result.add(v); return result.value(); }

struct FaceGeometry {
    std::array<ExactPoint, 3> vectors, edges;
    ExactPoint normal, qvector;
    Exact scale, normal_squared, hnum;
    std::array<Exact, 3> dnums, fan_numerators;
    Exact whole_numerator;
    std::array<bool, 3> radius_zero, d_zero;
    bool h_zero;
};

struct PreparedFace {
    std::array<ExactPoint, 3> vertices, edges, edge_normals;
    ExactPoint normal;
    Exact normal_squared;
};

PreparedFace prepare_face(const std::array<ExactPoint, 3> &vertices, ExactArithmetic &e)
{
    PreparedFace face;
    face.vertices = vertices;
    face.normal = e.cross(e.subtract(vertices[1],vertices[0]),e.subtract(vertices[2],vertices[0]));
    face.normal_squared = e.dot(face.normal,face.normal);
    require(e.sign(face.normal_squared) > 0, "surface RT0 original face area is zero");
    for (int i = 0; i < 3; ++i) {
        face.edges[i] = e.subtract(vertices[(i+1)%3],vertices[i]);
        require(e.sign(e.dot(face.edges[i],face.edges[i])) > 0, "surface RT0 original edge is zero");
        face.edge_normals[i] = e.cross(face.edges[i],face.normal);
    }
    return face;
}

FaceGeometry geometry(const PreparedFace &face,
    const ExactPoint &target, ExactArithmetic &e)
{
    FaceGeometry g;
    const auto &vertices = face.vertices;
    g.normal = face.normal;
    g.normal_squared = face.normal_squared;
    g.hnum = e.dot(g.normal,e.subtract(target,vertices[0])); g.h_zero = e.sign(g.hnum) == 0;
    for (int k = 0; k < 3; ++k) g.qvector[k] = e.div(e.mul(g.normal[k],g.hnum),g.normal_squared);
    Exact maximum = 0;
    for (int i = 0; i < 3; ++i) {
        g.vectors[i] = e.subtract(target,vertices[i]);
        g.edges[i] = face.edges[i];
        g.radius_zero[i] = e.sign(e.dot(g.vectors[i],g.vectors[i])) == 0;
        g.dnums[i] = e.dot(e.subtract(vertices[i],target),face.edge_normals[i]);
        g.d_zero[i] = e.sign(g.dnums[i]) == 0;
        for (const auto &value : g.vectors[i]) {
            const auto magnitude = e.absolute(value);
            if (e.compare(magnitude,maximum) > 0) maximum = magnitude;
        }
        for (const auto &value : g.edges[i]) {
            const auto magnitude = e.absolute(value);
            if (e.compare(magnitude,maximum) > 0) maximum = magnitude;
        }
    }
    // Exact triple-product identities, before the shared power-of-two scale.
    for (int i = 0; i < 3; ++i)
        g.fan_numerators[i] = e.div(e.mul(g.hnum,g.dnums[i]),g.normal_squared);
    g.whole_numerator = g.hnum;
    const auto nb = e.bits(boost::multiprecision::numerator(maximum));
    const auto db = e.bits(boost::multiprecision::denominator(maximum));
    require(nb <= static_cast<std::uint64_t>(std::numeric_limits<int>::max()) &&
        db <= static_cast<std::uint64_t>(std::numeric_limits<int>::max()), "surface RT0 scale exponent range");
    int exponent = static_cast<int>(nb)-static_cast<int>(db);
    if (e.compare(maximum,e.power_of_two(exponent)) < 0) --exponent;
    exponent = std::max(-1074,std::min(1023,exponent));
    g.scale = e.power_of_two(exponent);
    // Exact normalization is shared data, not a rounded geometry predicate.
    const Exact s2 = e.mul(g.scale,g.scale), s3 = e.mul(s2,g.scale), s4 = e.mul(s3,g.scale);
    for (auto &v : g.vectors) for (auto &x : v) x = e.div(x,g.scale);
    for (auto &v : g.edges) for (auto &x : v) x = e.div(x,g.scale);
    for (auto &x : g.qvector) x = e.div(x,g.scale);
    for (auto &x : g.normal) x = e.div(x,s2);
    g.normal_squared = e.dot(g.normal,g.normal);
    g.hnum = e.div(g.hnum,s3);
    for (auto &x : g.dnums) x = e.div(x,s4);
    for (auto &x : g.fan_numerators) x = e.div(x,s3);
    g.whole_numerator = e.div(g.whole_numerator,s3);
    return g;
}

template<class R> struct FacePass {
    R potential, whole, angle, cancellation;
    std::array<R, 3> fans;
    Vector<R> unit_normal;
    std::array<Vector<R>, 3> local_h;
    Vector<R> whole_h;
};

template<class R, class Products> R solid_angle(
    const std::array<R, 3> &radii, const Exact &numerator, Arithmetic<R> &a,
    Products products)
{
    const R n = a.number(numerator);
    numeric(n != 0, "surface RT0 exact angle numerator rounded to zero");
    const auto dots = products();
    const R d = radii[0]*radii[1]*radii[2] + radii[0]*dots[0] +
        radii[1]*dots[1] + radii[2]*dots[2];
    return R(2)*a.angle(n,d);
}

template<class R> FacePass<R> face_pass(const FaceGeometry &g,
    const ExactPoint &current, Arithmetic<R> &a, const SurfaceRt0Tolerances &t)
{
    auto &work = a.work(); work.guard();
    work.charge(Kind::face_precision_passes,1,a.precision());
    std::array<Vector<R>,3> vectors,edges;
    std::array<R,3> lengths,radii,d,logs,omegas;
    const auto normal = a.point(g.normal);
    const R norm = a.norm(normal), scale = a.number(g.scale);
    numeric(norm > 0, "surface RT0 nonzero face normal underflow");
    const R h = a.divide(a.number(g.hnum),norm);
    numeric(g.h_zero || h != 0, "surface RT0 nonzero face height underflow");
    for (int i = 0; i < 3; ++i) {
        vectors[i] = a.point(g.vectors[i]); edges[i] = a.point(g.edges[i]);
        lengths[i] = a.norm(edges[i]); radii[i] = a.norm(vectors[i]);
        numeric(lengths[i] > 0 && (radii[i] > 0 || g.radius_zero[i]), "surface RT0 edge/radius range");
        d[i] = a.divide(a.number(g.dnums[i]),R(lengths[i]*norm));
    }
    FacePass<R> result;
    std::optional<Vector<R>> qvector;
    // Demand each product only after the angle numerator passed its guard.
    std::array<std::optional<R>,3> neighbor_products, projection_products;
    auto neighbor_product = [&](int i) -> const R & {
        if (!neighbor_products[i]) neighbor_products[i] = dot(vectors[i],vectors[(i+1)%3]);
        return *neighbor_products[i];
    };
    auto projection_product = [&](int i) -> const R & {
        if (!projection_products[i]) projection_products[i] = dot(*qvector,vectors[i]);
        return *projection_products[i];
    };
    for (int i = 0; i < 3; ++i) {
        work.charge(Kind::signed_fan_panels,1,a.precision());
        if (g.d_zero[i]) { result.fans[i] = 0; logs[i] = 0; omegas[i] = 0; continue; }
        numeric(d[i] != 0, "surface RT0 nonzero edge coefficient underflow");
        const int j = (i+1)%3;
        const R xi = a.divide(R(-dot(vectors[i],edges[i])),lengths[i]);
        const R xj = xi+lengths[i], rho2 = h*h+d[i]*d[i];
        numeric(rho2 > 0, "surface RT0 nonzero transverse norm underflow");
        const R left = xi < 0 ? a.divide(rho2,R(radii[i]-xi)) : R(radii[i]+xi);
        const R right = xj > 0 ? a.divide(rho2,R(radii[j]+xj)) : R(radii[j]-xj);
        const R denominator = left+right;
        numeric(denominator > 0, "surface RT0 stable log denominator range");
        try { logs[i] = a.log_one_plus(a.divide(R(2)*lengths[i],denominator)); }
        catch (const NumericRefusal &) {
            if (a.precision() != 2) throw;
            logs[i] = a.logarithm(R(denominator+R(2)*lengths[i]))-a.logarithm(denominator);
        }
        if (g.h_zero) omegas[i] = 0;
        else {
            if (!qvector) qvector = a.point(g.qvector);
            omegas[i] = solid_angle(std::array<R,3>{{absolute(h),radii[i],radii[j]}},g.fan_numerators[i],a,
                [&] { return std::array<R,3>{{neighbor_product(i),projection_product(j),projection_product(i)}}; });
        }
        result.fans[i] = d[i]*logs[i]-h*omegas[i];
    }
    work.charge(Kind::whole_face_formulas,1,a.precision());
    result.angle = g.h_zero ? R(0) : solid_angle(radii,g.whole_numerator,a,
        [&] { return std::array<R,3>{{neighbor_product(1),neighbor_product(2),neighbor_product(0)}}; });
    const R potential = summed(result.fans);
    std::array<R,3> edge_terms{{R(d[0]*logs[0]),R(d[1]*logs[1]),R(d[2]*logs[2])}};
    const R whole = summed(edge_terms)-h*result.angle;
    numeric(potential > 0 && whole > 0, "surface RT0 nonpositive physical face potential");
    const R angle_delta = absolute(R(summed(omegas)-result.angle));
    result.potential = a.finite(R(potential*scale)); result.whole = a.finite(R(whole*scale));
    if constexpr (std::is_same_v<R,double>) {
        numeric(absolute(R(h*angle_delta*scale)) <= R(t.binary_scalar_epsilon_factor)*
            std::numeric_limits<double>::epsilon()*(scale+absolute(result.potential)), "surface RT0 weighted binary angle mismatch");
    } else {
        const R tolerance = a.precision() == 1 ? R(t.angle_relative_80) : R(t.angle_relative_120);
        numeric(angle_delta <= tolerance*(R(1)+absolute(result.angle)), "surface RT0 highprecision angle mismatch");
    }
    Sum<R> absolute_terms;
    for (const auto &v : edge_terms) absolute_terms.add(absolute(v));
    absolute_terms.add(absolute(R(h*result.angle)));
    result.cancellation = a.divide(absolute_terms.value(),potential);
    const auto j = a.point(current);
    for (int k = 0; k < 3; ++k) result.unit_normal[k] = a.divide(normal[k],norm);
    auto weight = cross(j,result.unit_normal);
    const R four_pi = a.four_pi();
    for (auto &value : weight) value = a.divide(value,four_pi);
    for (int i = 0; i < 3; ++i) {
        result.fans[i] *= scale;
        for (int k = 0; k < 3; ++k) result.local_h[i][k] = a.finite(R(weight[k]*result.fans[i]));
    }
    for (int k = 0; k < 3; ++k) result.whole_h[k] = a.finite(R(weight[k]*result.whole));
    work.guard();
    return result;
}

template<class R> Decimal120 promoted(const R &value)
{
    if constexpr (std::is_same_v<R, double>) return Decimal120(value);
    else return value.template convert_to<Decimal120>();
}
template<class R> Vector<Decimal120> promoted(const Vector<R> &value)
{ return {promoted(value[0]),promoted(value[1]),promoted(value[2])}; }

template<class R> struct FieldSum {
    std::array<Sum<R>,3> fan,whole;
    Sum<R> local_norm;
    R maximum_face_cancellation = 0;
    void add(const FacePass<R> &face, Arithmetic<R> &arithmetic)
    {
        for (int k = 0; k < 3; ++k) whole[k].add(face.whole_h[k]);
        for (const auto &local : face.local_h) {
            for (int k = 0; k < 3; ++k) fan[k].add(local[k]);
            local_norm.add(arithmetic.norm(local));
        }
        maximum_face_cancellation = std::max(maximum_face_cancellation,face.cancellation);
    }
    Vector<R> field() const { return {fan[0].value(),fan[1].value(),fan[2].value()}; }
    Vector<R> whole_field() const { return {whole[0].value(),whole[1].value(),whole[2].value()}; }
};

struct ExactElement {
    std::array<ExactPoint,4> vertices;
    std::array<Exact,4> coefficients;
    Exact determinant;
    int orientation;
    std::array<PreparedFace,4> faces;
};
ExactElement element(const transport::AffineRt0Element::FrozenInput &input,
    ExactArithmetic &e)
{
    ExactElement result;
    for (int i = 0; i < 4; ++i) result.vertices[i] = e.point(input.vertices_m[i]);
    Exact determinant = e.dot(e.subtract(result.vertices[1],result.vertices[0]),
        e.cross(e.subtract(result.vertices[2],result.vertices[0]),e.subtract(result.vertices[3],result.vertices[0])));
    result.orientation = e.sign(determinant);
    require(result.orientation != 0, "surface RT0 source Tet4 is degenerate");
    if (result.orientation < 0) determinant = e.sub(Exact(0),determinant);
    result.determinant = std::move(determinant);
    for (int i = 0; i < 4; ++i) result.coefficients[i] = e.input(input.signed_coefficients_a[i]);
    return result;
}

ExactPoint current_at_target(const ExactElement &cell, const ExactPoint &target, ExactArithmetic &e)
{
    ExactPoint current;
    for (int k = 0; k < 3; ++k) {
        Exact sum = 0;
        for (int i = 0; i < 4; ++i)
            sum = e.add(sum,e.mul(cell.coefficients[i],e.sub(target[k],cell.vertices[i][k])));
        current[k] = e.div(sum,cell.determinant);
    }
    return current;
}

std::array<ExactPoint,3> outward_face(const ExactElement &cell, int opposite, ExactArithmetic &e)
{
    constexpr std::array<std::array<int,3>,4> faces{{{{1,2,3}},{{0,3,2}},{{0,1,3}},{{0,2,1}}}};
    auto order = faces[static_cast<std::size_t>(opposite)];
    if (cell.orientation < 0) std::swap(order[1],order[2]);
    std::array<ExactPoint,3> face{{cell.vertices[order[0]],cell.vertices[order[1]],cell.vertices[order[2]]}};
    const auto normal = e.cross(e.subtract(face[1],face[0]),e.subtract(face[2],face[0]));
    require(e.sign(e.dot(normal,e.subtract(cell.vertices[opposite],face[0]))) < 0,
        "surface RT0 face is not exactly outward from its own cell");
    return face;
}

void tolerances_valid(const SurfaceRt0Tolerances &t)
{
    const std::array<double,11> values{{t.absolute_field_apm,t.relative_field,t.cancellation_floor_apm,
        t.scalar_relative_80,t.scalar_relative_120,t.angle_relative_80,t.angle_relative_120,
        t.binary_scalar_epsilon_factor,t.binary_roundoff_epsilon_factor,
        t.binary_cancellation_limit,t.highprecision_cancellation_limit}};
    for (double value : values) require(std::isfinite(value) && value > 0,
        "surface RT0 tolerances must all be finite and positive");
}

void preflight(const std::vector<transport::AffineRt0Element::FrozenInput> &source,
    const std::vector<std::array<double,3>> &targets, const SurfaceRt0WorkLimits &limits, Work &work)
{
    require(!source.empty() && !targets.empty(), "surface RT0 requires nonempty source and ordered targets");
    const auto source_count = static_cast<std::uint64_t>(source.size());
    const auto target_count = static_cast<std::uint64_t>(targets.size());
    const auto pairs = product(source_count,target_count);
    const auto fits = [&](Kind kind, std::uint64_t per_pair) {
        const auto i = static_cast<std::size_t>(kind);
        require(product(pairs,per_pair) <= limits.total[i] &&
            product(source_count,per_pair) <= limits.per_target[i],
            "surface RT0 full mandatory precision/formula work cannot fit caller limits");
    };
    fits(Kind::source_target_pairs,1);
    fits(Kind::face_precision_passes,12);
    fits(Kind::whole_face_formulas,12);
    fits(Kind::signed_fan_panels,36);
    // A fully evaluated source-target pair has 12 face/precision passes and
    // 48 formula branches (12 whole face + 36 signed fans), not 24 kernels.
    work.reserve_output(target_count,sizeof(SurfaceRt0TargetResult));
}

template<class R> SurfaceRt0PrecisionResult precision_result(const FieldSum<R> &sum,
    Arithmetic<R> &a, const SurfaceRt0Tolerances &t)
{
    SurfaceRt0PrecisionResult result;
    result.evaluated = true;
    const auto field = sum.field(), whole = sum.whole_field();
    for (int k = 0; k < 3; ++k) {
        result.h_xyz_apm[k] = a.text(field[k]);
        result.whole_h_xyz_apm[k] = a.text(whole[k]);
    }
    result.sum_local_norm_apm = a.text(sum.local_norm.value());
    const R denominator = std::max(a.norm(field),R(t.cancellation_floor_apm));
    result.cancellation = a.text(a.divide(sum.local_norm.value(),denominator));
    result.maximum_face_cancellation = a.text(sum.maximum_face_cancellation);
    return result;
}

void remember_binary_refusal(std::string &destination, const NumericRefusal &error, Work &work)
{
    if (!destination.empty()) return;
    const std::string::size_type size = std::char_traits<char>::length(error.what());
    if (size == std::numeric_limits<std::string::size_type>::max())
        throw std::runtime_error("surface RT0 refusal serialization size overflow");
    work.reserve_output(static_cast<std::uint64_t>(size)+1,sizeof(char));
    destination.assign(error.what(),size);
    work.guard();
}

void scalar_agreement(const FaceGeometry &g, const FacePass<Decimal80> &medium,
    const FacePass<Decimal120> &high, Arithmetic<Decimal80> &medium_arithmetic,
    Arithmetic<Decimal120> &a, const SurfaceRt0Tolerances &t)
{
    const Decimal120 scale = a.number(g.scale);
    const Decimal80 medium_gate = Decimal80(t.scalar_relative_80)*(medium_arithmetic.number(g.scale)+absolute(medium.potential));
    numeric(absolute(Decimal80(medium.potential-medium.whole)) <= medium_gate,
        "surface RT0 80-digit scalar whole-face/fan disagreement");
    const Decimal120 high_gate = Decimal120(t.scalar_relative_120)*(scale+absolute(high.potential));
    numeric(absolute(Decimal120(high.potential-high.whole)) <= high_gate,
        "surface RT0 120-digit scalar whole-face/fan disagreement");
    const Decimal120 precision_gate = Decimal120(t.scalar_relative_80)*(scale+absolute(high.potential));
    Sum<Decimal120> local;
    for (int i = 0; i < 3; ++i) local.add(absolute(Decimal120(promoted(medium.fans[i])-high.fans[i])));
    numeric(absolute(Decimal120(promoted(medium.potential)-high.potential)) <= precision_gate &&
        local.value() <= precision_gate, "surface RT0 scalar 80/120 local/global disagreement");
    if (!g.h_zero) numeric(absolute(Decimal120(promoted(medium.angle)-high.angle)) <=
        Decimal120(t.angle_relative_80)*(Decimal120(1)+absolute(high.angle)),
        "surface RT0 angle 80/120 disagreement");
    numeric(high.cancellation <= Decimal120(t.highprecision_cancellation_limit),
        "surface RT0 highprecision face cancellation refused");
}

} // namespace

SurfaceRt0Result evaluate_surface_rt0(
    const std::vector<transport::AffineRt0Element::FrozenInput> &source,
    const std::array<std::uint8_t,32> &caller_source_digest,
    const std::vector<std::array<double,3>> &ordered_targets_m,
    const SurfaceRt0WorkLimits &limits,
    const SurfaceRt0Tolerances &tolerances,
    const SurfaceRt0PeakRss &peak_rss,
    SurfaceRt0WorkReport &report,
    SurfaceRt0PhaseReport *phase_report,
    const SurfaceRt0ProgressObserver *observer)
{
    PhaseProfiler phases(phase_report);
    report = {};
    tolerances_valid(tolerances);
    Work work(limits,peak_rss,report,observer,ordered_targets_m.size(),source.size());
    if (observer) observer->emit(AntennaProgressPhase::evaluating_field, 0, ordered_targets_m.size(), source.size());
    preflight(source,ordered_targets_m,limits,work);
    SurfaceRt0Result result;
    work.charge(Kind::copied_input_bytes,caller_source_digest.size());
    result.caller_source_digest = caller_source_digest;
    require(ordered_targets_m.size() <= result.targets.max_size(), "surface RT0 result vector size exceeds max_size");
    result.targets.reserve(ordered_targets_m.size());
    // Source-only exact geometry is immutable throughout this invocation.
    // Boost-owned limb allocations remain covered by sampled RSS guards.
    std::vector<ExactElement> prepared;
    require(source.size() <= prepared.max_size(), "surface RT0 prepared source size exceeds max_size");
    require(product(source.size(),sizeof(ExactElement)) <= limits.maximum_lifetime_peak_rss_bytes,
        "surface RT0 prepared source storage exceeds RSS budget");
    work.guard();
    prepared.reserve(source.size());
    ExactArithmetic source_exact(work);
    for (const auto &input : source) {
        work.guard();
        auto cell = element(input,source_exact);
        for (int opposite = 0; opposite < 4; ++opposite)
            cell.faces[opposite] = prepare_face(outward_face(cell,opposite,source_exact),source_exact);
        prepared.push_back(std::move(cell));
        work.guard();
    }
    for (std::size_t target_index = 0; target_index < ordered_targets_m.size(); ++target_index) {
        phases.phase(SurfaceRt0Phase::exact_geometry);
        work.begin_target(target_index);
        ExactArithmetic exact(work);
        const auto target = exact.point(ordered_targets_m[target_index]);
        Arithmetic<double> low_arithmetic(work,0);
        Arithmetic<Decimal80> medium_arithmetic(work,1);
        Arithmetic<Decimal120> high_arithmetic(work,2);
        FieldSum<double> low_sum;
        FieldSum<Decimal80> medium_sum;
        FieldSum<Decimal120> high_sum;
        Sum<Decimal120> local_precision_delta,local_formula_delta,local_medium_formula_delta,local_binary_delta,local_binary_formula_delta;
        bool binary_evaluated = true, binary_requires_high = false;
        std::string binary_refusal;
        for (const auto &cell : prepared) {
            work.guard();
            work.charge(Kind::source_target_pairs);
            phases.phase(SurfaceRt0Phase::exact_geometry);
            const auto current = current_at_target(cell,target,exact);
            for (int opposite = 0; opposite < 4; ++opposite) {
                work.guard();
                phases.phase(SurfaceRt0Phase::exact_geometry);
                const auto g = geometry(cell.faces[opposite],target,exact);
                work.guard();
                FacePass<double> low;
                bool low_ok = false;
                phases.phase(SurfaceRt0Phase::binary64);
                try {
                    low = face_pass(g,current,low_arithmetic,tolerances);
                    phases.phase(SurfaceRt0Phase::consistency);
                    low_sum.add(low,low_arithmetic);
                    low_ok = true;
                } catch (const NumericRefusal &error) {
                    binary_evaluated = false;
                    binary_requires_high = true;
                    phases.phase(SurfaceRt0Phase::serialization);
                    remember_binary_refusal(binary_refusal,error,work);
                }
                phases.phase(SurfaceRt0Phase::precision80);
                const auto medium = face_pass(g,current,medium_arithmetic,tolerances);
                phases.phase(SurfaceRt0Phase::precision120);
                const auto high = face_pass(g,current,high_arithmetic,tolerances);
                phases.phase(SurfaceRt0Phase::consistency);
                scalar_agreement(g,medium,high,medium_arithmetic,high_arithmetic,tolerances);
                medium_sum.add(medium,medium_arithmetic);
                high_sum.add(high,high_arithmetic);
                Vector<Decimal120> fan_sum{{0,0,0}},binary_fan_sum{{0,0,0}};
                std::array<Sum<Decimal80>,3> medium_face_sum;
                for (int i = 0; i < 3; ++i) {
                    local_precision_delta.add(high_arithmetic.norm(subtract(promoted(medium.local_h[i]),high.local_h[i])));
                    if (low_ok) {
                        local_binary_delta.add(high_arithmetic.norm(subtract(promoted(low.local_h[i]),high.local_h[i])));
                        for (int k = 0; k < 3; ++k) binary_fan_sum[k] += promoted(low.local_h[i][k]);
                    }
                    for (int k = 0; k < 3; ++k) {
                        fan_sum[k] += high.local_h[i][k];
                        medium_face_sum[k].add(medium.local_h[i][k]);
                    }
                }
                local_formula_delta.add(high_arithmetic.norm(subtract(fan_sum,high.whole_h)));
                const Vector<Decimal80> medium_fan_sum{{medium_face_sum[0].value(),medium_face_sum[1].value(),medium_face_sum[2].value()}};
                local_medium_formula_delta.add(promoted(medium_arithmetic.norm(subtract(medium_fan_sum,medium.whole_h))));
                if (low_ok) {
                    local_binary_formula_delta.add(high_arithmetic.norm(subtract(binary_fan_sum,promoted(low.whole_h))));
                    const Decimal120 scalar_gate = Decimal120(tolerances.binary_scalar_epsilon_factor)*
                        Decimal120(std::numeric_limits<double>::epsilon())*(high_arithmetic.number(g.scale)+absolute(high.potential));
                    Sum<Decimal120> local_scalar_delta;
                    for (int i = 0; i < 3; ++i) local_scalar_delta.add(absolute(Decimal120(promoted(low.fans[i])-high.fans[i])));
                    if (absolute(Decimal120(promoted(low.potential)-high.potential)) > scalar_gate ||
                        local_scalar_delta.value() > scalar_gate ||
                        low.cancellation > tolerances.binary_cancellation_limit)
                        binary_requires_high = true;
                }
                work.guard();
            }
        }
        phases.phase(SurfaceRt0Phase::reduction);
        const auto high_field = high_sum.field();
        const Decimal120 high_magnitude = high_arithmetic.norm(high_field);
        const Decimal120 gate = Decimal120(tolerances.absolute_field_apm)+Decimal120(tolerances.relative_field)*high_magnitude;
        numeric(local_precision_delta.value() <= gate &&
            high_arithmetic.norm(subtract(promoted(medium_sum.field()),high_field)) <= gate,
            "surface RT0 field 80/120 local/global disagreement");
        numeric(local_medium_formula_delta.value() <= gate &&
            promoted(medium_arithmetic.norm(subtract(medium_sum.whole_field(),medium_sum.field()))) <= gate,
            "surface RT0 80-digit field whole-face/fan local/global disagreement");
        numeric(local_formula_delta.value() <= gate &&
            high_arithmetic.norm(subtract(high_sum.whole_field(),high_field)) <= gate,
            "surface RT0 field whole-face/fan local/global disagreement");
        const Decimal120 high_condition = high_arithmetic.divide(high_sum.local_norm.value(),
            std::max(high_magnitude,Decimal120(tolerances.cancellation_floor_apm)));
        numeric(high_condition <= Decimal120(tolerances.highprecision_cancellation_limit),
            "surface RT0 highprecision field cancellation refused");
        SurfaceRt0TargetResult output;
        for (int k = 0; k < 3; ++k) {
            output.h_xyz_apm[k] = high_field[k].convert_to<double>();
            numeric(std::isfinite(output.h_xyz_apm[k]) && (high_field[k] == 0 || output.h_xyz_apm[k] != 0),
                "surface RT0 final H is not representable as binary64");
        }
        const Vector<Decimal120> quantized{{Decimal120(output.h_xyz_apm[0]),Decimal120(output.h_xyz_apm[1]),Decimal120(output.h_xyz_apm[2])}};
        numeric(high_arithmetic.norm(subtract(quantized,high_field)) <= gate,
            "surface RT0 binary64 output quantization exceeds field budget");
        if (binary_evaluated) {
            try {
                const auto low_field = low_sum.field();
                const double low_magnitude = low_arithmetic.norm(low_field);
                const Decimal120 roundoff = Decimal120(tolerances.binary_roundoff_epsilon_factor)*
                    Decimal120(std::numeric_limits<double>::epsilon())*promoted(low_sum.local_norm.value());
                const double low_condition = low_arithmetic.divide(low_sum.local_norm.value(),
                    std::max(low_magnitude,tolerances.cancellation_floor_apm));
                binary_requires_high |= low_condition > tolerances.binary_cancellation_limit ||
                    local_binary_delta.value() > gate || local_binary_formula_delta.value() > gate || roundoff > gate ||
                    high_arithmetic.norm(subtract(promoted(low_sum.whole_field()),promoted(low_field))) > gate ||
                    high_arithmetic.norm(subtract(promoted(low_field),high_field)) > gate;
                phases.phase(SurfaceRt0Phase::serialization);
                output.precisions[0] = precision_result(low_sum,low_arithmetic,tolerances);
                output.binary64_roundoff_indicator_apm = high_arithmetic.text(roundoff);
            } catch (const NumericRefusal &error) {
                phases.phase(SurfaceRt0Phase::serialization);
                binary_evaluated = false; binary_requires_high = true;
                remember_binary_refusal(binary_refusal,error,work);
            }
        }
        phases.phase(SurfaceRt0Phase::serialization);
        if (!binary_evaluated) {
            output.precisions[0].evaluated = false;
            output.precisions[0].refusal_reason = std::move(binary_refusal);
        }
        output.precisions[1] = precision_result(medium_sum,medium_arithmetic,tolerances);
        output.precisions[2] = precision_result(high_sum,high_arithmetic,tolerances);
        output.binary64_requires_highprecision = binary_requires_high;
        output.precision_budget_apm = high_arithmetic.text(gate);
        output.local_precision_delta_apm = high_arithmetic.text(local_precision_delta.value());
        output.local_formula_delta_apm = high_arithmetic.text(local_formula_delta.value());
        output.local_formula_delta_80_apm = high_arithmetic.text(local_medium_formula_delta.value());
        phases.phase(SurfaceRt0Phase::reduction);
        output.work = work.target_counts();
        result.targets.push_back(std::move(output));
        work.guard();
        work.complete_target();
    }
    phases.phase(SurfaceRt0Phase::unattributed);
    work.guard();
    return result;
}

} // namespace fullmag::fem::oersted
