#include "frequency_domain/linearization_state.hpp"
#include "frequency_domain/canonical_digest.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>

namespace fullmag::fem::frequency_domain {

namespace {

bool present(const char *value) noexcept
{
    return value != nullptr && value[0] != '\0';
}

void copy_error(char out[128], const char *message) noexcept
{
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

void copy_reject(
    LinearizationDiagnostics &diagnostics,
    const char *reason,
    const char *message) noexcept
{
    std::strncpy(diagnostics.reject_reason, reason, 95);
    diagnostics.reject_reason[95] = '\0';
    copy_error(diagnostics.error_message, message);
}

double norm3(const double value[3]) noexcept
{
    return std::sqrt(dot3(value, value));
}

void cross3(const double a[3], const double b[3], double out[3]) noexcept
{
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
}

bool field_view_has_components(const CartesianVectorFieldView &view) noexcept
{
    return view.x != nullptr && view.y != nullptr && view.z != nullptr;
}

FrequencyDomainStatus require_signature(
    const char *value,
    const char *message,
    LinearizationDiagnostics &diagnostics) noexcept
{
    if (!present(value)) {
        copy_error(diagnostics.error_message, message);
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

bool is_demag_enabled(const EquilibriumArtifactDescriptor &artifact) noexcept
{
    return present(artifact.demag_model) &&
        std::strcmp(artifact.demag_model, "none") != 0 &&
        std::strcmp(artifact.demag_model, "disabled") != 0;
}

bool expected_signature_matches(const char *expected, const char *actual) noexcept
{
    return !present(expected) || (present(actual) && std::strcmp(expected, actual) == 0);
}

bool valid_sha256_digest(const char *value) noexcept
{
    if (value == nullptr || std::strlen(value) != 71u ||
        std::strncmp(value, "sha256:", 7u) != 0) {
        return false;
    }
    for (std::size_t index = 7u; index < 71u; ++index) {
        if (!std::isxdigit(static_cast<unsigned char>(value[index]))) {
            return false;
        }
    }
    return true;
}

} // namespace

FrequencyDomainStatus validate_equilibrium_acceptance_certificate(
    const EquilibriumAcceptanceCertificateDescriptor &certificate,
    char error_message[128]) noexcept
{
    copy_error(error_message, "");
    if (!present(certificate.certificate_sha256)) {
        copy_error(error_message, "equilibrium_acceptance_certificate_missing");
        return FrequencyDomainStatus::validation_error;
    }
    if (!valid_sha256_digest(certificate.certificate_sha256)) {
        copy_error(error_message, "equilibrium_acceptance_certificate_digest_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    if (!std::isfinite(certificate.metric_value) ||
        certificate.metric_value < 0.0 || !std::isfinite(certificate.threshold) ||
        certificate.threshold < 0.0 ||
        certificate.metric_value > certificate.threshold) {
        copy_error(error_message, "equilibrium_acceptance_certificate_metric_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    const bool torque = present(certificate.criterion) &&
        std::strcmp(certificate.criterion, "torque") == 0 &&
        present(certificate.metric_kind) &&
        std::strcmp(certificate.metric_kind, "max_torque_apm") == 0 &&
        present(certificate.unit) && std::strcmp(certificate.unit, "A/m") == 0;
    const bool energy = present(certificate.criterion) &&
        std::strcmp(certificate.criterion, "energy") == 0 &&
        present(certificate.metric_kind) &&
        std::strcmp(certificate.metric_kind, "total_energy_plateau_range_j") == 0 &&
        present(certificate.unit) && std::strcmp(certificate.unit, "J") == 0;
    if (!torque && !energy) {
        copy_error(error_message, "equilibrium_acceptance_certificate_incoherent");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

FrequencyDomainStatus build_linearization_state_from_equilibrium(
    const EquilibriumArtifactDescriptor &artifact,
    const LinearizationBuildOptions &options,
    LinearizationStateNative &out_state,
    LinearizationDiagnostics &out_diagnostics) noexcept
{
    out_state = LinearizationStateNative{};
    out_diagnostics = LinearizationDiagnostics{};
    out_diagnostics.node_count = artifact.magnetic_node_count;
    out_diagnostics.accepted_equilibrium = artifact.accepted_for_linearization;
    out_diagnostics.static_demag_available =
        field_view_has_components(artifact.h_demag0_a_per_m);

    if (!artifact.accepted_for_linearization) {
        copy_reject(
            out_diagnostics,
            "equilibrium_artifact_not_accepted_for_linearization",
            "frequency linearization requires an accepted equilibrium artifact");
        return FrequencyDomainStatus::validation_error;
    }
    if (!present(artifact.schema_version) ||
        std::strcmp(artifact.schema_version, "equilibrium_artifact.v7") != 0) {
        copy_reject(
            out_diagnostics,
            "equilibrium_artifact_schema_not_v7",
            "frequency linearization requires equilibrium_artifact.v7");
        return FrequencyDomainStatus::validation_error;
    }
    char acceptance_error[128]{};
    if (validate_equilibrium_acceptance_certificate(
            artifact.acceptance, acceptance_error) != FrequencyDomainStatus::ok) {
        copy_reject(
            out_diagnostics,
            acceptance_error,
            "frequency linearization requires a coherent accepted relaxation certificate");
        return FrequencyDomainStatus::validation_error;
    }
    std::strncpy(
        out_diagnostics.acceptance_certificate_sha256,
        artifact.acceptance.certificate_sha256,
        sizeof(out_diagnostics.acceptance_certificate_sha256) - 1u);
    if (!present(artifact.producer_run_id) || !present(artifact.content_sha256)) {
        copy_reject(
            out_diagnostics,
            "equilibrium_artifact_provenance_missing",
            "frequency linearization requires equilibrium producer and content hash");
        return FrequencyDomainStatus::validation_error;
    }
    if (artifact.magnetic_node_count == 0) {
        copy_error(out_diagnostics.error_message, "linearization requires magnetic nodes");
        return FrequencyDomainStatus::validation_error;
    }
    if (options.m0_norm_tolerance < 0.0 ||
        !std::isfinite(options.m0_norm_tolerance)) {
        copy_error(out_diagnostics.error_message, "linearization tolerances must be finite and non-negative");
        return FrequencyDomainStatus::validation_error;
    }
    if (require_signature(
            artifact.equilibrium_id,
            "linearization requires equilibrium id",
            out_diagnostics) != FrequencyDomainStatus::ok ||
        require_signature(
            artifact.mesh_snapshot_id,
            "linearization requires mesh snapshot id",
            out_diagnostics) != FrequencyDomainStatus::ok ||
        require_signature(
            artifact.material_snapshot_id,
            "linearization requires material snapshot id",
            out_diagnostics) != FrequencyDomainStatus::ok ||
        require_signature(
            artifact.physics_snapshot_id,
            "linearization requires physics snapshot id",
            out_diagnostics) != FrequencyDomainStatus::ok ||
        require_signature(
            artifact.boundary_snapshot_id,
            "linearization requires boundary snapshot id",
            out_diagnostics) != FrequencyDomainStatus::ok) {
        return FrequencyDomainStatus::validation_error;
    }
    if (!expected_signature_matches(
            options.expected_equilibrium_id,
            artifact.equilibrium_id)) {
        copy_reject(
            out_diagnostics,
            "equilibrium_id_mismatch",
            "linearization equilibrium id does not match requested frequency problem");
        return FrequencyDomainStatus::validation_error;
    }
    if (!expected_signature_matches(
            options.expected_mesh_snapshot_id,
            artifact.mesh_snapshot_id)) {
        copy_reject(
            out_diagnostics,
            "equilibrium_mesh_hash_mismatch",
            "linearization mesh snapshot does not match requested frequency problem");
        return FrequencyDomainStatus::validation_error;
    }
    if (!expected_signature_matches(
            options.expected_material_snapshot_id,
            artifact.material_snapshot_id)) {
        copy_reject(
            out_diagnostics,
            "equilibrium_material_hash_mismatch",
            "linearization material snapshot does not match requested frequency problem");
        return FrequencyDomainStatus::validation_error;
    }
    if (!expected_signature_matches(
            options.expected_boundary_snapshot_id,
            artifact.boundary_snapshot_id)) {
        copy_reject(
            out_diagnostics,
            "equilibrium_boundary_hash_mismatch",
            "linearization boundary snapshot does not match requested frequency problem");
        return FrequencyDomainStatus::validation_error;
    }
    if (!expected_signature_matches(
            options.expected_physics_snapshot_id,
            artifact.physics_snapshot_id)) {
        copy_reject(
            out_diagnostics,
            "equilibrium_physics_hash_mismatch",
            "linearization physics snapshot does not match requested frequency problem");
        return FrequencyDomainStatus::validation_error;
    }
    if (!field_view_has_components(artifact.m0_unit) ||
        artifact.m0_unit.node_count != artifact.magnetic_node_count) {
        copy_error(out_diagnostics.error_message, "linearization requires m0 on every magnetic node");
        return FrequencyDomainStatus::validation_error;
    }
    if (!field_view_has_components(artifact.h_eff0_a_per_m) ||
        artifact.h_eff0_a_per_m.node_count != artifact.magnetic_node_count) {
        copy_error(out_diagnostics.error_message, "linearization requires h_eff0 on every magnetic node");
        return FrequencyDomainStatus::validation_error;
    }
    if (options.require_static_demag_if_enabled &&
        is_demag_enabled(artifact) &&
        (!field_view_has_components(artifact.h_demag0_a_per_m) ||
         artifact.h_demag0_a_per_m.node_count != artifact.magnetic_node_count)) {
        copy_reject(
            out_diagnostics,
            "equilibrium_static_demag_required_but_missing",
            "linearization requires static demag for enabled demag model");
        return FrequencyDomainStatus::validation_error;
    }
    if (is_demag_enabled(artifact) && artifact.airbox_node_count > 0 && artifact.phi0 == nullptr) {
        copy_reject(
            out_diagnostics,
            "equilibrium_phi0_required_but_missing",
            "linearization requires phi0 for an airbox demag equilibrium");
        return FrequencyDomainStatus::validation_error;
    }

    const std::uint64_t node_count = artifact.magnetic_node_count;
    out_state.node_count = node_count;
    out_state.m0_xyz.resize(node_count * 3);
    out_state.h_eff0_xyz.resize(node_count * 3);
    if (field_view_has_components(artifact.h_demag0_a_per_m)) {
        out_state.h_demag0_xyz.resize(node_count * 3);
    }
    if (artifact.phi0 != nullptr) {
        out_state.phi0.assign(artifact.phi0, artifact.phi0 + artifact.airbox_node_count);
        for (double value : out_state.phi0) {
            if (!std::isfinite(value)) {
                copy_error(out_diagnostics.error_message, "phi0 must contain finite values");
                return FrequencyDomainStatus::validation_error;
            }
        }
    }
    if (artifact.tangent_lumped_mass == nullptr ||
        artifact.tangent_lumped_mass_count != node_count) {
        copy_reject(
            out_diagnostics,
            "equilibrium_tangent_lumped_mass_missing",
            "linearization requires one FE lumped-mass weight per magnetic node");
        return FrequencyDomainStatus::validation_error;
    }
    out_state.tangent_lumped_mass.assign(
        artifact.tangent_lumped_mass,
        artifact.tangent_lumped_mass + node_count);
    for (double weight : out_state.tangent_lumped_mass) {
        if (!std::isfinite(weight) || weight <= 0.0) {
            copy_reject(
                out_diagnostics,
                "equilibrium_tangent_lumped_mass_invalid",
                "linearization FE lumped-mass weights must be finite and positive");
            return FrequencyDomainStatus::validation_error;
        }
    }

    double max_norm_error = 0.0;
    double max_relative_torque = 0.0;
    long double weighted_torque_squared = 0.0L;
    long double weighted_field_scale_squared = 0.0L;
    for (std::uint64_t i = 0; i < node_count; ++i) {
        const double m[3] = {
            artifact.m0_unit.x[i],
            artifact.m0_unit.y[i],
            artifact.m0_unit.z[i],
        };
        const double h[3] = {
            artifact.h_eff0_a_per_m.x[i],
            artifact.h_eff0_a_per_m.y[i],
            artifact.h_eff0_a_per_m.z[i],
        };
        if (!std::isfinite(m[0]) || !std::isfinite(m[1]) || !std::isfinite(m[2]) ||
            !std::isfinite(h[0]) || !std::isfinite(h[1]) || !std::isfinite(h[2])) {
            copy_error(out_diagnostics.error_message, "linearization fields must contain finite values");
            return FrequencyDomainStatus::validation_error;
        }
        const double m_norm = norm3(m);
        const double norm_error = std::isfinite(m_norm) ? std::abs(m_norm - 1.0) : 1.0;
        max_norm_error = std::max(max_norm_error, norm_error);
        if (norm_error > options.m0_norm_tolerance && !options.allow_m0_renormalization) {
            out_diagnostics.max_m0_norm_error = max_norm_error;
            copy_error(out_diagnostics.error_message, "m0 norm exceeds linearization tolerance");
            return FrequencyDomainStatus::validation_error;
        }
        if (!std::isfinite(m_norm) || m_norm <= 0.0) {
            copy_error(out_diagnostics.error_message, "m0 must contain finite nonzero vectors");
            return FrequencyDomainStatus::validation_error;
        }
        double m_unit[3] = {m[0] / m_norm, m[1] / m_norm, m[2] / m_norm};
        double torque[3]{};
        cross3(m_unit, h, torque);
        const double h_norm = norm3(h);
        const double torque_norm = norm3(torque);
        const double scale = std::max(h_norm, 1.0);
        const double relative_torque = torque_norm / scale;
        if (!std::isfinite(relative_torque)) {
            copy_error(out_diagnostics.error_message, "equilibrium torque diagnostic must be finite");
            return FrequencyDomainStatus::validation_error;
        }
        max_relative_torque = std::max(max_relative_torque, relative_torque);
        const long double weight = static_cast<long double>(
            out_state.tangent_lumped_mass[static_cast<std::size_t>(i)]);
        weighted_torque_squared += weight * static_cast<long double>(torque_norm) *
            static_cast<long double>(torque_norm);
        weighted_field_scale_squared += weight * static_cast<long double>(scale) *
            static_cast<long double>(scale);

        double *m_dst = out_state.m0_xyz.data() + i * 3;
        double *h_dst = out_state.h_eff0_xyz.data() + i * 3;
        for (int axis = 0; axis < 3; ++axis) {
            m_dst[axis] = m_unit[axis];
            h_dst[axis] = h[axis];
        }
        if (!out_state.h_demag0_xyz.empty()) {
            const double h_demag[3] = {
                artifact.h_demag0_a_per_m.x[i],
                artifact.h_demag0_a_per_m.y[i],
                artifact.h_demag0_a_per_m.z[i],
            };
            if (!std::isfinite(h_demag[0]) ||
                !std::isfinite(h_demag[1]) ||
                !std::isfinite(h_demag[2])) {
                copy_error(out_diagnostics.error_message, "static demag field must contain finite values");
                return FrequencyDomainStatus::validation_error;
            }
            double *h_demag_dst = out_state.h_demag0_xyz.data() + i * 3;
            for (int axis = 0; axis < 3; ++axis) {
                h_demag_dst[axis] = h_demag[axis];
            }
        }
    }

    out_diagnostics.max_m0_norm_error = max_norm_error;
    out_diagnostics.max_m0_cross_heff0_relative = max_relative_torque;
    out_diagnostics.weighted_m0_cross_heff0_relative_l2 = std::sqrt(
        static_cast<double>(weighted_torque_squared / weighted_field_scale_squared));
    if (max_norm_error > options.m0_norm_tolerance && !options.allow_m0_renormalization) {
        copy_error(out_diagnostics.error_message, "m0 norm exceeds linearization tolerance");
        return FrequencyDomainStatus::validation_error;
    }
    out_state.tangent_frames.resize(node_count);
    TangentFrameDiagnostics frame_diagnostics{};
    const FrequencyDomainStatus frame_status = build_tangent_frame(
        out_state.m0_xyz.data(),
        node_count,
        out_state.tangent_frames.data(),
        &frame_diagnostics);
    out_diagnostics.max_tangent_basis_dot_abs = frame_diagnostics.max_basis_dot_abs;
    if (frame_status != FrequencyDomainStatus::ok) {
        copy_error(out_diagnostics.error_message, frame_diagnostics.error_message);
        return frame_status;
    }

    out_state.equilibrium_id = artifact.equilibrium_id;
    out_state.mesh_snapshot_id = artifact.mesh_snapshot_id;
    out_state.material_snapshot_id = artifact.material_snapshot_id;
    out_state.physics_snapshot_id = artifact.physics_snapshot_id;
    out_state.boundary_snapshot_id = artifact.boundary_snapshot_id;
    out_state.producer_run_id = artifact.producer_run_id;
    out_state.equilibrium_content_sha256 = artifact.content_sha256;
    out_state.demag_model = artifact.demag_model != nullptr ? artifact.demag_model : "";
    out_state.acceptance_criterion = artifact.acceptance.criterion;
    out_state.acceptance_metric_kind = artifact.acceptance.metric_kind;
    out_state.acceptance_unit = artifact.acceptance.unit;
    out_state.acceptance_metric_value = artifact.acceptance.metric_value;
    out_state.acceptance_threshold = artifact.acceptance.threshold;
    out_state.acceptance_certificate_sha256 = artifact.acceptance.certificate_sha256;
    out_state.accepted_m0_norm_tolerance = options.m0_norm_tolerance;

    CanonicalDigestBuilder signature("linearization_state.identity.v1");
    signature.add_string("equilibrium_id", artifact.equilibrium_id);
    signature.add_string("mesh_snapshot_id", artifact.mesh_snapshot_id);
    signature.add_string("material_snapshot_id", artifact.material_snapshot_id);
    signature.add_string("physics_snapshot_id", artifact.physics_snapshot_id);
    signature.add_string("boundary_snapshot_id", artifact.boundary_snapshot_id);
    signature.add_string("producer_run_id", artifact.producer_run_id);
    signature.add_string("equilibrium_content_sha256", artifact.content_sha256);
    signature.add_string("demag_model", artifact.demag_model);
    signature.add_string("acceptance_criterion", artifact.acceptance.criterion);
    signature.add_string("acceptance_metric_kind", artifact.acceptance.metric_kind);
    signature.add_string("acceptance_unit", artifact.acceptance.unit);
    signature.add_string("acceptance_certificate_sha256", artifact.acceptance.certificate_sha256);
    signature.add_double("accepted_m0_norm_tolerance", options.m0_norm_tolerance);
    for (std::uint64_t index = 0; index < node_count * 3u; ++index) {
        signature.add_double("m0_xyz", out_state.m0_xyz[static_cast<std::size_t>(index)]);
        signature.add_double("h_eff0_xyz", out_state.h_eff0_xyz[static_cast<std::size_t>(index)]);
        if (!out_state.h_demag0_xyz.empty()) {
            signature.add_double(
                "h_demag0_xyz",
                out_state.h_demag0_xyz[static_cast<std::size_t>(index)]);
        }
    }
    for (double value : out_state.phi0) {
        signature.add_double("phi0", value);
    }
    for (double weight : out_state.tangent_lumped_mass) {
        signature.add_double("tangent_lumped_mass", weight);
    }
    out_state.linearization_signature_hash = "sha256:" + signature.sha256_hex();

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
