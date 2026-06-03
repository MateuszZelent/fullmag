#pragma once

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct DmiElementData {
    double m_q[3]{};
    double grad_m[3][3]{};
    double shape = 0.0;
    double grad_shape[3]{};
    double weight = 0.0;
};

void dmi_accumulate_interfacial_residual(
    const DmiElementData &data,
    const double n_hat[3],
    double d,
    double residual[3]);

void dmi_accumulate_bulk_residual(
    const DmiElementData &data,
    double d,
    double residual[3]);

bool dmi_project_lumped_field(
    const double *residual_xyz,
    const double *lumped_mass,
    const double *ms_field,
    uint64_t node_count,
    double uniform_ms,
    double *out_h_xyz,
    std::string &error);

} // namespace fullmag::fem
