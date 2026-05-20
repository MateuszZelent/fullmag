#pragma once

#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace fullmag::fem {

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;

inline double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

inline double vector_norm3(double x, double y, double z)
{
    return std::sqrt(x * x + y * y + z * z);
}

using FemSteadyClock = std::chrono::steady_clock;

inline uint64_t elapsed_ns(const FemSteadyClock::time_point &start)
{
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            FemSteadyClock::now() - start)
            .count());
}

inline bool debug_startup_env_enabled()
{
    static const bool enabled = [] {
        const char *raw = std::getenv("FULLMAG_FEM_DEBUG_STARTUP");
        if (raw == nullptr || *raw == '\0') {
            return false;
        }
        return std::strcmp(raw, "1") == 0 ||
               std::strcmp(raw, "true") == 0 ||
               std::strcmp(raw, "TRUE") == 0 ||
               std::strcmp(raw, "on") == 0 ||
               std::strcmp(raw, "ON") == 0 ||
               std::strcmp(raw, "yes") == 0 ||
               std::strcmp(raw, "YES") == 0;
    }();
    return enabled;
}

class ScopedPhaseTimer {
public:
    explicit ScopedPhaseTimer(uint64_t *accumulator)
        : accumulator_(accumulator)
    {
        if (accumulator_ != nullptr) {
            start_ = FemSteadyClock::now();
        }
    }

    ~ScopedPhaseTimer()
    {
        if (accumulator_ != nullptr) {
            *accumulator_ += elapsed_ns(start_);
        }
    }

private:
    uint64_t *accumulator_ = nullptr;
    FemSteadyClock::time_point start_{};
};

} // namespace fullmag::fem
