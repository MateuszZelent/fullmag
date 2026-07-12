#include "frequency_domain/mesh_symmetry_certificate.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace fullmag::fem::frequency_domain {

namespace {

constexpr std::uint64_t kFnv1a64OffsetBasis = 14695981039346656037ull;
constexpr std::uint64_t kFnv1a64Prime = 1099511628211ull;

void reject(MeshSymmetryCertificate &certificate, const char *reason) noexcept
{
    certificate.accepted = false;
    std::strncpy(certificate.rejection_reason, reason, sizeof(certificate.rejection_reason) - 1);
    certificate.rejection_reason[sizeof(certificate.rejection_reason) - 1] = '\0';
}

void fnv1a_update_byte(std::uint64_t &hash, std::uint8_t value) noexcept
{
    hash ^= static_cast<std::uint64_t>(value);
    hash *= kFnv1a64Prime;
}

void fnv1a_update_u64(std::uint64_t &hash, std::uint64_t value) noexcept
{
    for (unsigned shift = 0; shift < 64; shift += 8) {
        fnv1a_update_byte(hash, static_cast<std::uint8_t>((value >> shift) & 0xffu));
    }
}

void fnv1a_update_literal(std::uint64_t &hash, const char *value) noexcept
{
    while (*value != '\0') {
        fnv1a_update_byte(hash, static_cast<std::uint8_t>(*value));
        ++value;
    }
    fnv1a_update_byte(hash, 0);
}

std::uint64_t pair_map_fingerprint(
    const char *tag,
    const PeriodicNodePair *pairs,
    std::uint64_t pair_count,
    std::uint64_t source_node_count,
    std::uint64_t destination_node_count)
{
    std::vector<PeriodicNodePair> sorted_pairs(
        pairs,
        pairs + static_cast<std::ptrdiff_t>(pair_count));
    std::sort(
        sorted_pairs.begin(),
        sorted_pairs.end(),
        [](const PeriodicNodePair &a, const PeriodicNodePair &b) {
            if (a.source_node != b.source_node) {
                return a.source_node < b.source_node;
            }
            return a.destination_node < b.destination_node;
        });

    std::uint64_t hash = kFnv1a64OffsetBasis;
    fnv1a_update_literal(hash, "periodic_mesh_certificate.v6");
    fnv1a_update_literal(hash, tag);
    fnv1a_update_u64(hash, source_node_count);
    fnv1a_update_u64(hash, destination_node_count);
    fnv1a_update_u64(hash, pair_count);
    for (const PeriodicNodePair &pair : sorted_pairs) {
        fnv1a_update_u64(hash, pair.source_node);
        fnv1a_update_u64(hash, pair.destination_node);
    }
    return hash;
}

void write_pair_map_fingerprint(
    char *destination,
    std::size_t destination_size,
    std::uint64_t fingerprint) noexcept
{
    if (destination_size == 0) {
        return;
    }
    std::snprintf(
        destination,
        destination_size,
        "fnv1a64:%016llx",
        static_cast<unsigned long long>(fingerprint));
    destination[destination_size - 1] = '\0';
}

std::uint32_t sha256_rotr(std::uint32_t value, std::uint32_t shift) noexcept
{
    return (value >> shift) | (value << (32u - shift));
}

std::string sha256_hex(const std::string &input)
{
    static constexpr std::uint32_t k[64] = {
        0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
        0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
        0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
        0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
        0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
        0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
        0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
        0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
        0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
        0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
        0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
        0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
        0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
        0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
        0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
        0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
    };
    std::uint32_t h[8] = {
        0x6a09e667u,
        0xbb67ae85u,
        0x3c6ef372u,
        0xa54ff53au,
        0x510e527fu,
        0x9b05688cu,
        0x1f83d9abu,
        0x5be0cd19u,
    };

    std::vector<unsigned char> bytes(input.begin(), input.end());
    const std::uint64_t bit_length = static_cast<std::uint64_t>(bytes.size()) * 8ull;
    bytes.push_back(0x80u);
    while ((bytes.size() % 64u) != 56u) {
        bytes.push_back(0u);
    }
    for (int shift = 56; shift >= 0; shift -= 8) {
        bytes.push_back(static_cast<unsigned char>((bit_length >> shift) & 0xffu));
    }

    for (std::size_t chunk = 0; chunk < bytes.size(); chunk += 64u) {
        std::uint32_t w[64]{};
        for (std::size_t i = 0; i < 16; ++i) {
            const std::size_t offset = chunk + i * 4u;
            w[i] =
                (static_cast<std::uint32_t>(bytes[offset]) << 24u) |
                (static_cast<std::uint32_t>(bytes[offset + 1]) << 16u) |
                (static_cast<std::uint32_t>(bytes[offset + 2]) << 8u) |
                static_cast<std::uint32_t>(bytes[offset + 3]);
        }
        for (std::size_t i = 16; i < 64; ++i) {
            const std::uint32_t s0 =
                sha256_rotr(w[i - 15], 7u) ^
                sha256_rotr(w[i - 15], 18u) ^
                (w[i - 15] >> 3u);
            const std::uint32_t s1 =
                sha256_rotr(w[i - 2], 17u) ^
                sha256_rotr(w[i - 2], 19u) ^
                (w[i - 2] >> 10u);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }

        std::uint32_t a = h[0];
        std::uint32_t b = h[1];
        std::uint32_t c = h[2];
        std::uint32_t d = h[3];
        std::uint32_t e = h[4];
        std::uint32_t f = h[5];
        std::uint32_t g = h[6];
        std::uint32_t hh = h[7];
        for (std::size_t i = 0; i < 64; ++i) {
            const std::uint32_t s1 =
                sha256_rotr(e, 6u) ^ sha256_rotr(e, 11u) ^ sha256_rotr(e, 25u);
            const std::uint32_t ch = (e & f) ^ ((~e) & g);
            const std::uint32_t temp1 = hh + s1 + ch + k[i] + w[i];
            const std::uint32_t s0 =
                sha256_rotr(a, 2u) ^ sha256_rotr(a, 13u) ^ sha256_rotr(a, 22u);
            const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const std::uint32_t temp2 = s0 + maj;
            hh = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }

    char word_hex[9]{};
    std::string hex;
    hex.reserve(64);
    for (std::uint32_t word : h) {
        std::snprintf(word_hex, sizeof(word_hex), "%08x", word);
        hex += word_hex;
    }
    return hex;
}

std::string canonical_pair_map_payload(
    const char *tag,
    const PeriodicNodePair *pairs,
    std::uint64_t pair_count,
    std::uint64_t source_node_count,
    std::uint64_t destination_node_count)
{
    std::vector<PeriodicNodePair> sorted_pairs(
        pairs,
        pairs + static_cast<std::ptrdiff_t>(pair_count));
    std::sort(
        sorted_pairs.begin(),
        sorted_pairs.end(),
        [](const PeriodicNodePair &a, const PeriodicNodePair &b) {
            if (a.source_node != b.source_node) {
                return a.source_node < b.source_node;
            }
            return a.destination_node < b.destination_node;
        });

    std::string payload = "periodic_mesh_certificate_pair_map.v1\n";
    payload += "schema=periodic_mesh_certificate.v6\n";
    payload += "tag=";
    payload += tag;
    payload += "\nsource_node_count=" + std::to_string(source_node_count);
    payload += "\ndestination_node_count=" + std::to_string(destination_node_count);
    payload += "\npair_count=" + std::to_string(pair_count);
    payload += "\npairs=";
    for (const PeriodicNodePair &pair : sorted_pairs) {
        payload += "\n";
        payload += std::to_string(pair.source_node);
        payload += "->";
        payload += std::to_string(pair.destination_node);
    }
    payload += "\n";
    return payload;
}

void write_pair_map_sha256(
    char *destination,
    std::size_t destination_size,
    const char *tag,
    const PeriodicNodePair *pairs,
    std::uint64_t pair_count,
    std::uint64_t source_node_count,
    std::uint64_t destination_node_count) noexcept
{
    if (destination_size == 0) {
        return;
    }
    const std::string digest = sha256_hex(canonical_pair_map_payload(
        tag,
        pairs,
        pair_count,
        source_node_count,
        destination_node_count));
    std::snprintf(destination, destination_size, "sha256:%s", digest.c_str());
    destination[destination_size - 1] = '\0';
}

double norm3_local(const double value[3]) noexcept
{
    return std::sqrt(dot3(value, value));
}

double translation_residual(
    const double *source_xyz,
    const double *destination_xyz,
    std::uint64_t source_node,
    std::uint64_t destination_node,
    const double translation_m[3]) noexcept
{
    const double *source = source_xyz + source_node * 3;
    const double *destination = destination_xyz + destination_node * 3;
    const double residual[3] = {
        destination[0] - source[0] - translation_m[0],
        destination[1] - source[1] - translation_m[1],
        destination[2] - source[2] - translation_m[2],
    };
    return norm3_local(residual);
}

bool finite_xyz(const double *xyz, std::uint64_t node_count) noexcept
{
    if (node_count > 0 && xyz == nullptr) {
        return false;
    }
    for (std::uint64_t i = 0; i < node_count * 3; ++i) {
        if (!std::isfinite(xyz[i])) {
            return false;
        }
    }
    return true;
}

bool valid_poisson_gauge_policy(MeshSymmetryPoissonGaugePolicy policy) noexcept
{
    switch (policy) {
    case MeshSymmetryPoissonGaugePolicy::unspecified:
    case MeshSymmetryPoissonGaugePolicy::not_required:
    case MeshSymmetryPoissonGaugePolicy::mean_zero:
    case MeshSymmetryPoissonGaugePolicy::pinned_dof:
    case MeshSymmetryPoissonGaugePolicy::provider_responsibility:
        return true;
    }
    return false;
}

double frame_transport_error(
    const TangentFrameNode &source,
    const TangentFrameNode &destination) noexcept
{
    const double block00 = dot3(destination.e1, source.e1);
    const double block01 = dot3(destination.e1, source.e2);
    const double block10 = dot3(destination.e2, source.e1);
    const double block11 = dot3(destination.e2, source.e2);
    const double d00 = block00 - 1.0;
    const double d01 = block01;
    const double d10 = block10;
    const double d11 = block11 - 1.0;
    return std::sqrt(d00 * d00 + d01 * d01 + d10 * d10 + d11 * d11);
}

void append_frame_transfer_block(
    const TangentFrameNode &source,
    const TangentFrameNode &destination,
    std::vector<double> &blocks)
{
    blocks.push_back(dot3(destination.e1, source.e1));
    blocks.push_back(dot3(destination.e1, source.e2));
    blocks.push_back(dot3(destination.e2, source.e1));
    blocks.push_back(dot3(destination.e2, source.e2));
}

FrequencyDomainStatus validate_pair_map(
    const PeriodicNodePair *pairs,
    std::uint64_t pair_count,
    std::uint64_t source_node_count,
    std::uint64_t destination_node_count,
    MeshSymmetryCertificate &certificate) noexcept
{
    if (pair_count == 0 || pairs == nullptr) {
        reject(certificate, "periodic_mesh_pair_missing");
        return FrequencyDomainStatus::validation_error;
    }
    std::vector<bool> seen_source(static_cast<std::size_t>(source_node_count), false);
    std::vector<bool> seen_destination(static_cast<std::size_t>(destination_node_count), false);
    for (std::uint64_t i = 0; i < pair_count; ++i) {
        const PeriodicNodePair &pair = pairs[i];
        if (pair.source_node >= source_node_count ||
            pair.destination_node >= destination_node_count) {
            reject(certificate, "periodic_mesh_pair_out_of_range");
            return FrequencyDomainStatus::validation_error;
        }
        if (seen_source[static_cast<std::size_t>(pair.source_node)] ||
            seen_destination[static_cast<std::size_t>(pair.destination_node)]) {
            reject(certificate, "periodic_mesh_duplicate_node");
            return FrequencyDomainStatus::validation_error;
        }
        seen_source[static_cast<std::size_t>(pair.source_node)] = true;
        seen_destination[static_cast<std::size_t>(pair.destination_node)] = true;
    }
    if (pair_count != source_node_count || pair_count != destination_node_count) {
        reject(certificate, "periodic_mesh_pair_count_mismatch");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace

FrequencyDomainStatus build_mesh_symmetry_certificate(
    const MeshSymmetryCertificateRequest &request,
    MeshSymmetryCertificate &out_certificate) noexcept
{
    out_certificate = MeshSymmetryCertificate{};
    out_certificate.source_node_count = request.magnetic_source_node_count;
    out_certificate.destination_node_count = request.magnetic_destination_node_count;
    out_certificate.pair_count = request.magnetic_pair_count;
    out_certificate.airbox_pair_count = request.airbox_pair_count;
    out_certificate.poisson_gauge_policy = request.poisson_gauge_policy;
    out_certificate.poisson_gauge_policy_explicit =
        request.poisson_gauge_policy != MeshSymmetryPoissonGaugePolicy::unspecified;
    out_certificate.tangent_frame_transfer_blocks_row_major_2x2.reserve(
        static_cast<std::size_t>(request.magnetic_pair_count * 4));

    if (request.schema_version == nullptr ||
        std::strcmp(request.schema_version, "periodic_mesh_certificate.v6") != 0) {
        reject(out_certificate, "periodic_mesh_certificate_schema_not_v6");
        return FrequencyDomainStatus::validation_error;
    }

    if (!std::isfinite(request.translation_tolerance_m) ||
        request.translation_tolerance_m < 0.0 ||
        !std::isfinite(request.frame_transport_tolerance) ||
        request.frame_transport_tolerance < 0.0 ||
        !std::isfinite(request.m0_pair_tolerance) ||
        request.m0_pair_tolerance < 0.0 ||
        !std::isfinite(request.static_demag_pair_tolerance_a_per_m) ||
        request.static_demag_pair_tolerance_a_per_m < 0.0 ||
        !std::isfinite(request.translation_m[0]) ||
        !std::isfinite(request.translation_m[1]) ||
        !std::isfinite(request.translation_m[2])) {
        reject(out_certificate, "periodic_mesh_invalid_tolerance");
        return FrequencyDomainStatus::validation_error;
    }
    if (!valid_poisson_gauge_policy(request.poisson_gauge_policy)) {
        reject(out_certificate, "periodic_poisson_gauge_policy_invalid");
        return FrequencyDomainStatus::validation_error;
    }
    if (request.require_poisson_gauge_policy &&
        request.poisson_gauge_policy == MeshSymmetryPoissonGaugePolicy::unspecified) {
        reject(out_certificate, "periodic_poisson_gauge_policy_missing");
        return FrequencyDomainStatus::validation_error;
    }
    if (!finite_xyz(request.magnetic_source_xyz, request.magnetic_source_node_count) ||
        !finite_xyz(request.magnetic_destination_xyz, request.magnetic_destination_node_count) ||
        request.magnetic_source_material_ids == nullptr ||
        request.magnetic_destination_material_ids == nullptr ||
        request.magnetic_source_region_ids == nullptr ||
        request.magnetic_destination_region_ids == nullptr ||
        request.magnetic_source_frame_nodes == nullptr ||
        request.magnetic_destination_frame_nodes == nullptr) {
        reject(out_certificate, "periodic_mesh_missing_magnetic_inputs");
        return FrequencyDomainStatus::validation_error;
    }
    if (validate_pair_map(
            request.magnetic_pairs,
            request.magnetic_pair_count,
            request.magnetic_source_node_count,
            request.magnetic_destination_node_count,
            out_certificate) != FrequencyDomainStatus::ok) {
        return FrequencyDomainStatus::validation_error;
    }
    write_pair_map_fingerprint(
        out_certificate.magnetic_pair_map_fingerprint,
        sizeof(out_certificate.magnetic_pair_map_fingerprint),
        pair_map_fingerprint(
            "magnetic",
            request.magnetic_pairs,
            request.magnetic_pair_count,
            request.magnetic_source_node_count,
            request.magnetic_destination_node_count));
    out_certificate.magnetic_pair_map_fingerprint_available = true;
    write_pair_map_sha256(
        out_certificate.magnetic_pair_map_sha256,
        sizeof(out_certificate.magnetic_pair_map_sha256),
        "magnetic",
        request.magnetic_pairs,
        request.magnetic_pair_count,
        request.magnetic_source_node_count,
        request.magnetic_destination_node_count);
    out_certificate.magnetic_pair_map_sha256_available = true;
    if (request.airbox_pair_count > 0) {
        if (!finite_xyz(request.airbox_source_xyz, request.airbox_source_node_count) ||
            !finite_xyz(request.airbox_destination_xyz, request.airbox_destination_node_count)) {
            reject(out_certificate, "periodic_airbox_pair_missing");
            return FrequencyDomainStatus::validation_error;
        }
        if (validate_pair_map(
                request.airbox_pairs,
                request.airbox_pair_count,
                request.airbox_source_node_count,
                request.airbox_destination_node_count,
                out_certificate) != FrequencyDomainStatus::ok) {
            return FrequencyDomainStatus::validation_error;
        }
        write_pair_map_fingerprint(
            out_certificate.airbox_pair_map_fingerprint,
            sizeof(out_certificate.airbox_pair_map_fingerprint),
            pair_map_fingerprint(
                "airbox",
                request.airbox_pairs,
                request.airbox_pair_count,
                request.airbox_source_node_count,
                request.airbox_destination_node_count));
        out_certificate.airbox_pair_map_fingerprint_available = true;
        write_pair_map_sha256(
            out_certificate.airbox_pair_map_sha256,
            sizeof(out_certificate.airbox_pair_map_sha256),
            "airbox",
            request.airbox_pairs,
            request.airbox_pair_count,
            request.airbox_source_node_count,
            request.airbox_destination_node_count);
        out_certificate.airbox_pair_map_sha256_available = true;
    }
    const bool static_demag_requested =
        request.require_static_demag_pair_consistency ||
        request.static_demag_source_a_per_m != nullptr ||
        request.static_demag_destination_a_per_m != nullptr;
    out_certificate.static_demag_pair_consistency_available = static_demag_requested;
    if (static_demag_requested &&
        (!finite_xyz(request.static_demag_source_a_per_m, request.magnetic_source_node_count) ||
         !finite_xyz(
             request.static_demag_destination_a_per_m,
             request.magnetic_destination_node_count))) {
        reject(out_certificate, "periodic_static_demag_missing");
        return FrequencyDomainStatus::validation_error;
    }

    for (std::uint64_t i = 0; i < request.magnetic_pair_count; ++i) {
        const PeriodicNodePair &pair = request.magnetic_pairs[i];
        const double residual = translation_residual(
            request.magnetic_source_xyz,
            request.magnetic_destination_xyz,
            pair.source_node,
            pair.destination_node,
            request.translation_m);
        out_certificate.max_translation_residual_m =
            std::max(out_certificate.max_translation_residual_m, residual);
        if (residual > request.translation_tolerance_m) {
            reject(out_certificate, "periodic_mesh_translation_residual_too_large");
            return FrequencyDomainStatus::validation_error;
        }

        const bool material_mismatch =
            request.magnetic_source_material_ids[pair.source_node] !=
            request.magnetic_destination_material_ids[pair.destination_node];
        const bool region_mismatch =
            request.magnetic_source_region_ids[pair.source_node] !=
            request.magnetic_destination_region_ids[pair.destination_node];
        out_certificate.max_material_mismatch =
            std::max(out_certificate.max_material_mismatch, material_mismatch ? 1.0 : 0.0);
        out_certificate.max_region_mismatch =
            std::max(out_certificate.max_region_mismatch, region_mismatch ? 1.0 : 0.0);
        if (material_mismatch) {
            reject(out_certificate, "periodic_material_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (region_mismatch) {
            reject(out_certificate, "periodic_region_mismatch");
            return FrequencyDomainStatus::validation_error;
        }

        const TangentFrameNode &source_frame =
            request.magnetic_source_frame_nodes[pair.source_node];
        const TangentFrameNode &destination_frame =
            request.magnetic_destination_frame_nodes[pair.destination_node];
        const double m0_delta[3] = {
            destination_frame.m[0] - source_frame.m[0],
            destination_frame.m[1] - source_frame.m[1],
            destination_frame.m[2] - source_frame.m[2],
        };
        out_certificate.max_m0_pair_mismatch =
            std::max(out_certificate.max_m0_pair_mismatch, norm3_local(m0_delta));
        if (out_certificate.max_m0_pair_mismatch > request.m0_pair_tolerance) {
            reject(out_certificate, "periodic_m0_seam_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (static_demag_requested) {
            const double *source_h =
                request.static_demag_source_a_per_m + pair.source_node * 3;
            const double *destination_h =
                request.static_demag_destination_a_per_m + pair.destination_node * 3;
            const double h_delta[3] = {
                destination_h[0] - source_h[0],
                destination_h[1] - source_h[1],
                destination_h[2] - source_h[2],
            };
            out_certificate.max_h_demag0_pair_mismatch_a_per_m =
                std::max(
                    out_certificate.max_h_demag0_pair_mismatch_a_per_m,
                    norm3_local(h_delta));
            if (out_certificate.max_h_demag0_pair_mismatch_a_per_m >
                request.static_demag_pair_tolerance_a_per_m) {
                reject(out_certificate, "periodic_static_demag_seam_mismatch");
                return FrequencyDomainStatus::validation_error;
            }
        }
        const double transport_error =
            frame_transport_error(source_frame, destination_frame);
        out_certificate.max_frame_transport_error =
            std::max(out_certificate.max_frame_transport_error, transport_error);
        append_frame_transfer_block(
            source_frame,
            destination_frame,
            out_certificate.tangent_frame_transfer_blocks_row_major_2x2);
    }

    for (std::uint64_t i = 0; i < request.airbox_pair_count; ++i) {
        const PeriodicNodePair &pair = request.airbox_pairs[i];
        const double residual = translation_residual(
            request.airbox_source_xyz,
            request.airbox_destination_xyz,
            pair.source_node,
            pair.destination_node,
            request.translation_m);
        out_certificate.max_airbox_phi_pair_mismatch =
            std::max(out_certificate.max_airbox_phi_pair_mismatch, residual);
        if (residual > request.translation_tolerance_m) {
            reject(out_certificate, "periodic_airbox_translation_residual_too_large");
            return FrequencyDomainStatus::validation_error;
        }
    }

    out_certificate.accepted = true;
    out_certificate.tangent_frame_transfer_available = request.magnetic_pair_count > 0;
    const std::string content = std::string("periodic_mesh_certificate.v6\nmagnetic=") +
        out_certificate.magnetic_pair_map_sha256 + "\nairbox=" +
        out_certificate.airbox_pair_map_sha256;
    const std::string digest = sha256_hex(content);
    std::snprintf(
        out_certificate.content_sha256,
        sizeof(out_certificate.content_sha256),
        "sha256:%s",
        digest.c_str());
    std::snprintf(
        out_certificate.certificate_id,
        sizeof(out_certificate.certificate_id),
        "periodic_mesh_certificate.v6:%s",
        digest.c_str());
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
