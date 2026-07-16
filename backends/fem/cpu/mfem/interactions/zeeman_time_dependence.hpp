#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct OwnedTimeDependence {
    uint32_t kind = FULLMAG_FEM_TIME_CONSTANT;
    fullmag_fem_time_dependence_parameters parameters{};
    std::vector<fullmag_fem_time_point> points;
};

bool copy_time_dependence(
    const fullmag_fem_time_dependence_desc &source,
    OwnedTimeDependence &destination,
    std::string &error);

double evaluate_time_dependence(const OwnedTimeDependence &waveform, double time_s);

} // namespace fullmag::fem
