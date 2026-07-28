#include "core/demag_solver_policy.hpp"

#include <climits>
#include <cmath>
#include <cstdlib>

namespace fullmag::fem {
namespace {

constexpr int kDefaultRelaxType = 18;
constexpr int kDefaultCoarsening = 8;
constexpr int kDefaultInterpolation = 6;
constexpr int kDefaultAggressiveCoarsening = 1;
constexpr double kUnsetStrengthThreshold = 0.0;
constexpr int kUnsetMaxLevels = 0;

int nonnegative_int_env(const char *name, int default_value)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') return default_value;
    char *end = nullptr;
    const long value = std::strtol(raw, &end, 10);
    return end == raw || *end != '\0' || value < 0 || value > INT_MAX
        ? default_value : static_cast<int>(value);
}

struct OptionalNonnegativeReal {
    double value;
    bool is_set;
};

OptionalNonnegativeReal optional_nonnegative_real_env(const char *name)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') return {kUnsetStrengthThreshold, false};
    char *end = nullptr;
    const double value = std::strtod(raw, &end);
    if (end == raw || *end != '\0' || !std::isfinite(value) || value < 0.0) {
        return {kUnsetStrengthThreshold, false};
    }
    return {value, true};
}

struct OptionalNonnegativeInt {
    int value;
    bool is_set;
};

OptionalNonnegativeInt optional_nonnegative_int_env(const char *name)
{
    const char *raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\0') return {kUnsetMaxLevels, false};
    char *end = nullptr;
    const long value = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0' || value < 0 || value > INT_MAX) {
        return {kUnsetMaxLevels, false};
    }
    return {static_cast<int>(value), true};
}

} // namespace

ResolvedDemagAmgPolicy resolve_demag_amg_policy_from_environment()
{
    const auto strength_threshold = optional_nonnegative_real_env(
        "FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD");
    const auto max_levels = optional_nonnegative_int_env(
        "FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS");
    return {
        nonnegative_int_env("FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE", kDefaultRelaxType),
        nonnegative_int_env("FULLMAG_FEM_DEMAG_AMG_COARSENING", kDefaultCoarsening),
        nonnegative_int_env("FULLMAG_FEM_DEMAG_AMG_INTERPOLATION", kDefaultInterpolation),
        nonnegative_int_env(
            "FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING",
            kDefaultAggressiveCoarsening),
        strength_threshold.value,
        strength_threshold.is_set,
        max_levels.value,
        max_levels.is_set,
    };
}

} // namespace fullmag::fem
