/* Closed, allocation-free regional-drive waveform evaluation. */
#include "cpu/mfem/interactions/zeeman_time_dependence.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {
namespace {

double stable_sinc(double x)
{
    const double ax = std::abs(x);
    if (ax < 1.0e-4) {
        const double x2 = x * x;
        return 1.0 - x2 / 6.0 + x2 * x2 / 120.0 - x2 * x2 * x2 / 5040.0;
    }
    return std::sin(x) / x;
}

} // namespace

bool copy_time_dependence(
    const fullmag_fem_time_dependence_desc &source,
    OwnedTimeDependence &destination,
    std::string &error)
{
    if (source.abi_version != FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION ||
        source.struct_size != sizeof(fullmag_fem_time_dependence_desc)) {
        error = "regional field drive waveform ABI version/size mismatch";
        return false;
    }
    if (source.kind > FULLMAG_FEM_TIME_SINC_PULSE) {
        error = "regional field drive waveform kind is unsupported";
        return false;
    }
    if ((source.point_count == 0) != (source.points == nullptr)) {
        error = "regional field drive PWL points null/count mismatch";
        return false;
    }
    if (source.kind == FULLMAG_FEM_TIME_PIECEWISE_LINEAR && source.point_count < 2) {
        error = "regional field drive PWL waveform requires at least two points";
        return false;
    }
    destination.kind = source.kind;
    destination.parameters = source.parameters;
    destination.points.clear();
    if (source.point_count > 0) {
        destination.points.assign(source.points, source.points + source.point_count);
    }
    for (size_t i = 0; i < destination.points.size(); ++i) {
        if (!std::isfinite(destination.points[i].time_s) ||
            !std::isfinite(destination.points[i].value) ||
            (i > 0 && destination.points[i].time_s <= destination.points[i - 1].time_s)) {
            error = "regional field drive PWL points must be finite and strictly increasing";
            return false;
        }
    }
    return true;
}

double evaluate_time_dependence(const OwnedTimeDependence &waveform, double time_s)
{
    switch (waveform.kind) {
    case FULLMAG_FEM_TIME_CONSTANT:
        return 1.0;
    case FULLMAG_FEM_TIME_SINUSOIDAL: {
        const auto &p = waveform.parameters.sinusoidal;
        return p.offset + std::sin(2.0 * 3.14159265358979323846 * p.frequency_hz * time_s + p.phase_rad);
    }
    case FULLMAG_FEM_TIME_PULSE: {
        const auto &p = waveform.parameters.pulse;
        return time_s >= p.t_on_s && time_s < p.t_off_s ? 1.0 : 0.0;
    }
    case FULLMAG_FEM_TIME_PIECEWISE_LINEAR: {
        if (time_s <= waveform.points.front().time_s) return waveform.points.front().value;
        if (time_s >= waveform.points.back().time_s) return waveform.points.back().value;
        const auto upper = std::upper_bound(
            waveform.points.begin(), waveform.points.end(), time_s,
            [](double value, const fullmag_fem_time_point &point) { return value < point.time_s; });
        const auto &b = *upper;
        const auto &a = *(upper - 1);
        const double u = (time_s - a.time_s) / (b.time_s - a.time_s);
        return a.value + u * (b.value - a.value);
    }
    case FULLMAG_FEM_TIME_SINC_PULSE: {
        const auto &p = waveform.parameters.sinc_pulse;
        const double x = 2.0 * 3.14159265358979323846 * p.cutoff_hz * (time_s - p.t0_s);
        return p.amplitude * stable_sinc(x);
    }
    default:
        return 0.0;
    }
}

} // namespace fullmag::fem
