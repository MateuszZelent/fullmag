#include "frequency_domain/excitation.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr double kZeroTangentDriveTolerance = 1.0e-15;

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

void cross3(const double a[3], const double b[3], double out[3]) noexcept
{
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
}

double optional_component(const double *values, std::uint64_t node_index) noexcept
{
    return values != nullptr ? values[node_index] : 0.0;
}

} // namespace

FrequencyDomainStatus build_uniform_field_tangent_excitation(
    const TangentFrameNode *nodes,
    std::uint64_t node_count,
    const double uniform_field_a_per_m[3],
    double *out_tangent_drive,
    TangentExcitationDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentExcitationDiagnostics{};
        out_diagnostics->node_count = node_count;
        out_diagnostics->tangent_dof_count = node_count * 2;
    }
    if ((node_count > 0 && nodes == nullptr) || uniform_field_a_per_m == nullptr || out_tangent_drive == nullptr) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "excitation projection requires non-null buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_tangent_drive = 0.0;
    for (std::uint64_t node_index = 0; node_index < node_count; ++node_index) {
        const TangentFrameNode &node = nodes[node_index];
        const double e1_drive = dot3(uniform_field_a_per_m, node.e1);
        const double e2_drive = dot3(uniform_field_a_per_m, node.e2);
        out_tangent_drive[node_index * 2] = e1_drive;
        out_tangent_drive[node_index * 2 + 1] = e2_drive;
        max_abs_tangent_drive = std::max(max_abs_tangent_drive, std::abs(e1_drive));
        max_abs_tangent_drive = std::max(max_abs_tangent_drive, std::abs(e2_drive));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_tangent_drive = max_abs_tangent_drive;
    }
    if (!std::isfinite(max_abs_tangent_drive) || max_abs_tangent_drive <= kZeroTangentDriveTolerance) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "excitation has zero tangent drive");
        }
        return FrequencyDomainStatus::validation_error;
    }

    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus project_dynamic_field_drive_to_tangent_rhs(
    const TangentFrameNode *nodes,
    std::uint64_t node_count,
    double gamma0,
    FrequencyDomainPhaseConvention convention,
    const DynamicFieldPhasorView &drive,
    TangentComplexVectorView out_rhs,
    TangentExcitationDiagnostics *out_diagnostics) noexcept
{
    if (out_diagnostics != nullptr) {
        *out_diagnostics = TangentExcitationDiagnostics{};
        out_diagnostics->node_count = node_count;
        out_diagnostics->tangent_dof_count = node_count * 2;
    }
    if (convention != FrequencyDomainPhaseConvention::exp_i_omega_t &&
        convention != FrequencyDomainPhaseConvention::exp_minus_i_omega_t) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "dynamic drive projection requires a supported phase convention");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if ((node_count > 0 && nodes == nullptr) ||
        drive.node_count != node_count ||
        drive.hx_re == nullptr ||
        drive.hy_re == nullptr ||
        drive.hz_re == nullptr ||
        out_rhs.real == nullptr ||
        out_rhs.imag == nullptr ||
        out_rhs.tangent_dof_count != node_count * 2 ||
        !std::isfinite(gamma0)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "dynamic drive projection requires matching finite buffers");
        }
        return FrequencyDomainStatus::validation_error;
    }

    double max_abs_tangent_drive = 0.0;
    for (std::uint64_t node_index = 0; node_index < node_count; ++node_index) {
        const TangentFrameNode &node = nodes[node_index];
        const double drive_re[3] = {
            drive.hx_re[node_index],
            drive.hy_re[node_index],
            drive.hz_re[node_index],
        };
        const double drive_im[3] = {
            optional_component(drive.hx_im, node_index),
            optional_component(drive.hy_im, node_index),
            optional_component(drive.hz_im, node_index),
        };
        double torque_re[3]{};
        double torque_im[3]{};
        cross3(node.m, drive_re, torque_re);
        cross3(node.m, drive_im, torque_im);

        for (int axis = 0; axis < 3; ++axis) {
            torque_re[axis] *= -gamma0;
            torque_im[axis] *= -gamma0;
        }

        const std::uint64_t tangent_offset = node_index * 2;
        out_rhs.real[tangent_offset] = dot3(torque_re, node.e1);
        out_rhs.real[tangent_offset + 1] = dot3(torque_re, node.e2);
        out_rhs.imag[tangent_offset] = dot3(torque_im, node.e1);
        out_rhs.imag[tangent_offset + 1] = dot3(torque_im, node.e2);
        max_abs_tangent_drive =
            std::max(max_abs_tangent_drive, std::abs(out_rhs.real[tangent_offset]));
        max_abs_tangent_drive =
            std::max(max_abs_tangent_drive, std::abs(out_rhs.real[tangent_offset + 1]));
        max_abs_tangent_drive =
            std::max(max_abs_tangent_drive, std::abs(out_rhs.imag[tangent_offset]));
        max_abs_tangent_drive =
            std::max(max_abs_tangent_drive, std::abs(out_rhs.imag[tangent_offset + 1]));
    }

    if (out_diagnostics != nullptr) {
        out_diagnostics->max_abs_tangent_drive = max_abs_tangent_drive;
    }
    if (!std::isfinite(max_abs_tangent_drive)) {
        if (out_diagnostics != nullptr) {
            copy_error(out_diagnostics->error_message, "dynamic drive projection produced non-finite RHS");
        }
        return FrequencyDomainStatus::validation_error;
    }
    if (max_abs_tangent_drive <= kZeroTangentDriveTolerance && out_diagnostics != nullptr) {
        out_diagnostics->zero_drive_warning = true;
        copy_error(out_diagnostics->error_message, "dynamic drive projection produced zero response");
    }

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
