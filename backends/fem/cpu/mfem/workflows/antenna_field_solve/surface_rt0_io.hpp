#pragma once

#include "fullmag_fem.h"
#include "cpu/mfem/interactions/oersted/surface_rt0.hpp"

namespace fullmag::fem::antenna_field_solve::surface_rt0_io {

// Caller owns the buffers and metadata; all alias/capacity checks precede entry.
struct Output {
    double *h_xyz_apm;
    std::uint64_t h_xyz_apm_capacity;
    std::uint64_t &h_xyz_apm_len;
    std::uint8_t *evidence_json;
    std::uint64_t evidence_json_capacity;
    std::uint64_t &evidence_json_len;
    char *error_message;
};

oersted::SurfaceRt0WorkLimits limits(const fullmag_fem_surface_rt0_work_limits_v1 &value);
std::array<std::uint8_t,32> digest(const char *text);
void validate_request(const fullmag_fem_surface_rt0_options_v1 &options,
    std::uint64_t cells, const double *target_points_xyz, std::uint64_t target_points_xyz_len);
void evaluate(const std::vector<transport::AffineRt0Element::FrozenInput> &source,
    const std::string &view_digest, const char *accepted_digest,
    const std::vector<std::array<double,3>> &targets,
    const fullmag_fem_surface_rt0_options_v1 &options, Output output,
    oersted::SurfaceRt0PhaseReport *phase_report,
    const oersted::SurfaceRt0ProgressObserver *observer);

} // namespace fullmag::fem::antenna_field_solve::surface_rt0_io
