#include "frequency_domain/mesh_symmetry_certificate.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <set>
#include <string>
#include <tuple>
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

struct BindingPairMapValidation {
    std::vector<PeriodicNodePair> sorted_pairs;
};

void reject_map_binding(
    MeshSymmetryCertificateMapBinding &binding,
    const char *reason) noexcept
{
    binding.accepted = false;
    std::strncpy(binding.rejection_reason, reason, sizeof(binding.rejection_reason) - 1);
    binding.rejection_reason[sizeof(binding.rejection_reason) - 1] = '\0';
}

bool safe_binding_count(std::uint64_t count) noexcept
{
    return count <= static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max()) &&
        count <= static_cast<std::uint64_t>(std::numeric_limits<std::ptrdiff_t>::max());
}

bool valid_binding_identity(const char *identity) noexcept
{
    if (identity == nullptr || identity[0] == '\0') {
        return false;
    }
    for (const char *cursor = identity; *cursor != '\0'; ++cursor) {
        // Newlines are rejected because they would make the canonical
        // line-oriented preimage ambiguous across producers.
        if (*cursor == '\n' || *cursor == '\r') {
            return false;
        }
    }
    return true;
}

bool valid_binding_digest(const char *digest) noexcept
{
    if (digest == nullptr || std::strlen(digest) != 71 ||
        std::strncmp(digest, "sha256:", 7) != 0) {
        return false;
    }
    for (std::size_t i = 7; i < 71; ++i) {
        const char value = digest[i];
        const bool is_hex =
            (value >= '0' && value <= '9') ||
            (value >= 'a' && value <= 'f');
        if (!is_hex) {
            return false;
        }
    }
    return true;
}

FrequencyDomainStatus validate_binding_pair_map(
    const MeshSymmetryCertificatePairMap &map,
    bool require_region_markers,
    MeshSymmetryCertificateMapBinding &binding,
    BindingPairMapValidation &out_validation) noexcept
{
    if (map.pair_count == 0 || map.pairs == nullptr) {
        reject_map_binding(binding, "periodic_mesh_map_binding_pair_map_missing");
        return FrequencyDomainStatus::validation_error;
    }
    if (!safe_binding_count(map.pair_count) ||
        !safe_binding_count(map.source_node_count) ||
        !safe_binding_count(map.destination_node_count)) {
        reject_map_binding(binding, "periodic_mesh_map_binding_pair_count_overflow");
        return FrequencyDomainStatus::validation_error;
    }
    if (map.pair_count != map.source_node_count ||
        map.pair_count != map.destination_node_count) {
        reject_map_binding(binding, "periodic_mesh_map_binding_pair_count_mismatch");
        return FrequencyDomainStatus::validation_error;
    }
    const bool has_source_markers = map.source_region_ids != nullptr;
    const bool has_destination_markers = map.destination_region_ids != nullptr;
    if (require_region_markers && (!has_source_markers || !has_destination_markers)) {
        reject_map_binding(binding, "periodic_mesh_map_binding_region_markers_missing");
        return FrequencyDomainStatus::validation_error;
    }
    if (has_source_markers != has_destination_markers) {
        reject_map_binding(binding, "periodic_mesh_map_binding_region_markers_missing");
        return FrequencyDomainStatus::validation_error;
    }

    try {
        std::vector<bool> seen_source(static_cast<std::size_t>(map.source_node_count), false);
        std::vector<bool> seen_destination(
            static_cast<std::size_t>(map.destination_node_count), false);
        out_validation.sorted_pairs.assign(
            map.pairs,
            map.pairs + static_cast<std::ptrdiff_t>(map.pair_count));
        for (const PeriodicNodePair &pair : out_validation.sorted_pairs) {
            if (pair.source_node >= map.source_node_count ||
                pair.destination_node >= map.destination_node_count) {
                reject_map_binding(binding, "periodic_mesh_map_binding_pair_out_of_range");
                return FrequencyDomainStatus::validation_error;
            }
            if (seen_source[static_cast<std::size_t>(pair.source_node)] ||
                seen_destination[static_cast<std::size_t>(pair.destination_node)]) {
                reject_map_binding(binding, "periodic_mesh_map_binding_duplicate_node");
                return FrequencyDomainStatus::validation_error;
            }
            seen_source[static_cast<std::size_t>(pair.source_node)] = true;
            seen_destination[static_cast<std::size_t>(pair.destination_node)] = true;
            if (has_source_markers &&
                map.source_region_ids[pair.source_node] !=
                    map.destination_region_ids[pair.destination_node]) {
                reject_map_binding(
                    binding,
                    "periodic_mesh_map_binding_region_marker_mismatch");
                return FrequencyDomainStatus::validation_error;
            }
        }
        std::sort(
            out_validation.sorted_pairs.begin(),
            out_validation.sorted_pairs.end(),
            [](const PeriodicNodePair &a, const PeriodicNodePair &b) {
                if (a.source_node != b.source_node) {
                    return a.source_node < b.source_node;
                }
                return a.destination_node < b.destination_node;
            });
    } catch (...) {
        reject_map_binding(binding, "periodic_mesh_map_binding_internal_error");
        return FrequencyDomainStatus::validation_error;
    }
    return FrequencyDomainStatus::ok;
}

bool binding_maps_equal(
    const MeshSymmetryCertificatePairMap &mesh_map,
    const MeshSymmetryCertificatePairMap &payload_map,
    const BindingPairMapValidation &mesh_validation,
    const BindingPairMapValidation &payload_validation,
    MeshSymmetryCertificateMapBinding &binding) noexcept
{
    if (mesh_map.source_node_count != payload_map.source_node_count ||
        mesh_map.destination_node_count != payload_map.destination_node_count ||
        mesh_validation.sorted_pairs.size() != payload_validation.sorted_pairs.size()) {
        reject_map_binding(binding, "periodic_mesh_map_binding_pair_count_mismatch");
        return false;
    }
    for (std::size_t i = 0; i < mesh_validation.sorted_pairs.size(); ++i) {
        const PeriodicNodePair &mesh_pair = mesh_validation.sorted_pairs[i];
        const PeriodicNodePair &payload_pair = payload_validation.sorted_pairs[i];
        if (mesh_pair.source_node != payload_pair.source_node ||
            mesh_pair.destination_node != payload_pair.destination_node) {
            reject_map_binding(binding, "periodic_mesh_map_binding_map_mismatch");
            return false;
        }
        if (payload_map.source_region_ids != nullptr &&
            payload_map.destination_region_ids != nullptr &&
            (mesh_map.source_region_ids[mesh_pair.source_node] !=
                 payload_map.source_region_ids[payload_pair.source_node] ||
             mesh_map.destination_region_ids[mesh_pair.destination_node] !=
                 payload_map.destination_region_ids[payload_pair.destination_node])) {
            reject_map_binding(
                binding,
                "periodic_mesh_map_binding_region_marker_mismatch");
            return false;
        }
    }
    return true;
}

void append_binding_field(std::string &preimage, const char *name, const char *value)
{
    preimage += name;
    preimage += '=';
    preimage += std::to_string(std::strlen(value));
    preimage += ':';
    preimage += value;
    preimage += '\n';
}

void append_binding_map(
    std::string &preimage,
    const char *name,
    const MeshSymmetryCertificatePairMap &map,
    const BindingPairMapValidation &validation)
{
    preimage += name;
    preimage += ".source_node_count=";
    preimage += std::to_string(map.source_node_count);
    preimage += '\n';
    preimage += name;
    preimage += ".destination_node_count=";
    preimage += std::to_string(map.destination_node_count);
    preimage += '\n';
    preimage += name;
    preimage += ".pair_count=";
    preimage += std::to_string(map.pair_count);
    preimage += '\n';
    for (const PeriodicNodePair &pair : validation.sorted_pairs) {
        preimage += name;
        preimage += ".pair=";
        preimage += std::to_string(pair.source_node);
        preimage += "->";
        preimage += std::to_string(pair.destination_node);
        preimage += ",";
        preimage += std::to_string(map.source_region_ids[pair.source_node]);
        preimage += ",";
        preimage += std::to_string(map.destination_region_ids[pair.destination_node]);
        preimage += '\n';
    }
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

FrequencyDomainStatus verify_mesh_symmetry_certificate_map_binding(
    const MeshSymmetryCertificateMapBindingRequest &request,
    MeshSymmetryCertificateMapBinding &out_binding) noexcept
{
    out_binding = MeshSymmetryCertificateMapBinding{};
    try {
        if (request.schema_version == nullptr ||
            std::strcmp(request.schema_version, "periodic_mesh_certificate.v6") != 0) {
            reject_map_binding(
                out_binding,
                "periodic_mesh_map_binding_schema_not_v6");
            return FrequencyDomainStatus::validation_error;
        }
        if (!valid_binding_identity(request.mesh_magnetic_part_identity) ||
            !valid_binding_identity(request.payload_magnetic_part_identity) ||
            !valid_binding_identity(request.mesh_airbox_part_identity) ||
            !valid_binding_identity(request.payload_airbox_part_identity)) {
            reject_map_binding(
                out_binding,
                "periodic_mesh_map_binding_part_identity_missing");
            return FrequencyDomainStatus::validation_error;
        }
        if (std::strcmp(
                request.mesh_magnetic_part_identity,
                request.payload_magnetic_part_identity) != 0) {
            reject_map_binding(
                out_binding,
                "periodic_mesh_map_binding_magnetic_part_identity_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (std::strcmp(
                request.mesh_airbox_part_identity,
                request.payload_airbox_part_identity) != 0) {
            reject_map_binding(
                out_binding,
                "periodic_mesh_map_binding_airbox_part_identity_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        if (std::strcmp(
                request.mesh_magnetic_part_identity,
                request.mesh_airbox_part_identity) == 0) {
            reject_map_binding(
                out_binding,
                "periodic_mesh_map_binding_part_identity_collision");
            return FrequencyDomainStatus::validation_error;
        }

        BindingPairMapValidation mesh_magnetic_validation{};
        BindingPairMapValidation payload_magnetic_validation{};
        BindingPairMapValidation mesh_airbox_validation{};
        BindingPairMapValidation payload_airbox_validation{};
        if (validate_binding_pair_map(
                request.mesh_magnetic,
                true,
                out_binding,
                mesh_magnetic_validation) != FrequencyDomainStatus::ok ||
            validate_binding_pair_map(
                request.payload_magnetic,
                false,
                out_binding,
                payload_magnetic_validation) != FrequencyDomainStatus::ok ||
            validate_binding_pair_map(
                request.mesh_airbox,
                true,
                out_binding,
                mesh_airbox_validation) != FrequencyDomainStatus::ok ||
            validate_binding_pair_map(
                request.payload_airbox,
                false,
                out_binding,
                payload_airbox_validation) != FrequencyDomainStatus::ok) {
            return FrequencyDomainStatus::validation_error;
        }
        if (!binding_maps_equal(
                request.mesh_magnetic,
                request.payload_magnetic,
                mesh_magnetic_validation,
                payload_magnetic_validation,
                out_binding) ||
            !binding_maps_equal(
                request.mesh_airbox,
                request.payload_airbox,
                mesh_airbox_validation,
                payload_airbox_validation,
                out_binding)) {
            return FrequencyDomainStatus::validation_error;
        }

        out_binding.magnetic_pair_count = request.mesh_magnetic.pair_count;
        out_binding.airbox_pair_count = request.mesh_airbox.pair_count;
        std::string canonical_preimage =
            "periodic_mesh_map_binding.v1\n"
            "schema=periodic_mesh_certificate.v6\n";
        append_binding_field(
            canonical_preimage,
            "magnetic_part_identity",
            request.mesh_magnetic_part_identity);
        append_binding_field(
            canonical_preimage,
            "airbox_part_identity",
            request.mesh_airbox_part_identity);
        append_binding_map(
            canonical_preimage,
            "magnetic",
            request.mesh_magnetic,
            mesh_magnetic_validation);
        append_binding_map(
            canonical_preimage,
            "airbox",
            request.mesh_airbox,
            mesh_airbox_validation);
        const std::string digest = sha256_hex(canonical_preimage);
        std::snprintf(
            out_binding.canonical_preimage_sha256,
            sizeof(out_binding.canonical_preimage_sha256),
            "sha256:%s",
            digest.c_str());
        if (!valid_binding_digest(request.payload_map_binding_digest)) {
            reject_map_binding(
                out_binding,
                request.payload_map_binding_digest == nullptr
                    ? "periodic_mesh_map_binding_digest_missing"
                    : "periodic_mesh_map_binding_digest_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        if (std::strcmp(
                request.payload_map_binding_digest,
                out_binding.canonical_preimage_sha256) != 0) {
            reject_map_binding(
                out_binding,
                "periodic_mesh_map_binding_digest_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        out_binding.accepted = true;
        out_binding.rejection_reason[0] = '\0';
        return FrequencyDomainStatus::ok;
    } catch (...) {
        reject_map_binding(out_binding, "periodic_mesh_map_binding_internal_error");
        return FrequencyDomainStatus::validation_error;
    }
}

namespace {

constexpr const char *kPeriodicMeshCertificateV6 = "periodic_mesh_certificate.v6";
constexpr const char *kPeriodicModalEquivalenceMapBindingV1 =
    "periodic_modal_equivalence_map_binding.v1";

struct V6PairKey {
    std::uint64_t first = 0;
    std::uint64_t second = 0;

    bool operator<(const V6PairKey &other) const noexcept
    {
        return std::tie(first, second) < std::tie(other.first, other.second);
    }

    bool operator==(const V6PairKey &other) const noexcept
    {
        return first == other.first && second == other.second;
    }
};

struct V6RelationKey {
    V6PairKey pair{};
    std::uint32_t axis_mask = 0;
    MeshSymmetryCertificateRelationKind kind =
        MeshSymmetryCertificateRelationKind::face;

    bool operator<(const V6RelationKey &other) const noexcept
    {
        return std::tie(pair, axis_mask, kind) <
            std::tie(other.pair, other.axis_mask, other.kind);
    }

    bool operator==(const V6RelationKey &other) const noexcept
    {
        return pair == other.pair && axis_mask == other.axis_mask && kind == other.kind;
    }
};

V6PairKey v6_pair_key(const MeshSymmetryCertificateV6Relation &relation) noexcept
{
    return relation.source_node < relation.destination_node
        ? V6PairKey{relation.source_node, relation.destination_node}
        : V6PairKey{relation.destination_node, relation.source_node};
}

V6RelationKey v6_relation_key(const MeshSymmetryCertificateV6Relation &relation) noexcept
{
    return V6RelationKey{v6_pair_key(relation), relation.axis_mask, relation.kind};
}

std::size_t v6_popcount(std::uint32_t mask) noexcept
{
    std::size_t count = 0;
    while (mask != 0) {
        count += static_cast<std::size_t>(mask & 1u);
        mask >>= 1u;
    }
    return count;
}

std::uint32_t v6_kind_bit(MeshSymmetryCertificateRelationKind kind) noexcept
{
    switch (kind) {
    case MeshSymmetryCertificateRelationKind::face:
        return 1u;
    case MeshSymmetryCertificateRelationKind::edge:
        return 2u;
    case MeshSymmetryCertificateRelationKind::corner:
        return 4u;
    }
    return 0u;
}

bool v6_valid_view_kind(MeshSymmetryCertificateV6ViewKind kind) noexcept
{
    return kind == MeshSymmetryCertificateV6ViewKind::authoritative_mesh ||
        kind == MeshSymmetryCertificateV6ViewKind::compact_payload;
}

bool v6_valid_part_role(MeshSymmetryCertificatePartRole role) noexcept
{
    return role == MeshSymmetryCertificatePartRole::magnetic ||
        role == MeshSymmetryCertificatePartRole::scalar_airbox;
}

const char *v6_part_role_name(MeshSymmetryCertificatePartRole role) noexcept
{
    return role == MeshSymmetryCertificatePartRole::magnetic ? "magnetic" : "scalar_airbox";
}

void reject_v6(
    MeshSymmetryCertificateV6Binding &binding,
    const char *reason) noexcept
{
    binding.accepted = false;
    std::strncpy(binding.rejection_reason, reason, sizeof(binding.rejection_reason) - 1);
    binding.rejection_reason[sizeof(binding.rejection_reason) - 1] = '\0';
}

class V6DisjointSet {
public:
    explicit V6DisjointSet(std::size_t count)
        : parent_(count), rank_(count, 0)
    {
        for (std::size_t index = 0; index < count; ++index) {
            parent_[index] = static_cast<std::uint64_t>(index);
        }
    }

    std::uint64_t find(std::uint64_t node) noexcept
    {
        std::uint64_t root = node;
        while (parent_[static_cast<std::size_t>(root)] != root) {
            root = parent_[static_cast<std::size_t>(root)];
        }
        while (parent_[static_cast<std::size_t>(node)] != node) {
            const std::uint64_t next = parent_[static_cast<std::size_t>(node)];
            parent_[static_cast<std::size_t>(node)] = root;
            node = next;
        }
        return root;
    }

    std::uint64_t find_const(std::uint64_t node) const noexcept
    {
        while (parent_[static_cast<std::size_t>(node)] != node) {
            node = parent_[static_cast<std::size_t>(node)];
        }
        return node;
    }

    void unite(std::uint64_t lhs, std::uint64_t rhs) noexcept
    {
        lhs = find(lhs);
        rhs = find(rhs);
        if (lhs == rhs) {
            return;
        }
        if (rank_[static_cast<std::size_t>(lhs)] < rank_[static_cast<std::size_t>(rhs)]) {
            std::swap(lhs, rhs);
        }
        parent_[static_cast<std::size_t>(rhs)] = lhs;
        if (rank_[static_cast<std::size_t>(lhs)] == rank_[static_cast<std::size_t>(rhs)]) {
            ++rank_[static_cast<std::size_t>(lhs)];
        }
    }

private:
    std::vector<std::uint64_t> parent_;
    std::vector<std::uint8_t> rank_;
};

struct V6ViewState {
    std::vector<std::uint64_t> canonical_class_ids;
    std::map<std::uint64_t, std::vector<std::uint64_t>> members_by_class;
    std::vector<std::string> class_digests;
    std::string class_digest_sha256;
    std::vector<V6RelationKey> generator_relations;
    std::vector<V6RelationKey> closure_relations;
    std::vector<std::pair<std::uint32_t, MeshSymmetryCertificatePartRole>> region_roles;
};

std::vector<std::pair<std::uint64_t, const std::vector<std::uint64_t> *>>
v6_ordered_classes(const V6ViewState &state)
{
    std::vector<std::pair<std::uint64_t, const std::vector<std::uint64_t> *>> ordered;
    ordered.reserve(state.members_by_class.size());
    for (const auto &entry : state.members_by_class) {
        ordered.emplace_back(entry.second.front(), &entry.second);
    }
    std::sort(ordered.begin(), ordered.end(), [](const auto &lhs, const auto &rhs) {
        return lhs.first < rhs.first;
    });
    return ordered;
}

void append_v6_text_field(std::string &text, const char *name, const char *value)
{
    text += name;
    text += '=';
    text += std::to_string(std::strlen(value));
    text += ':';
    text += value;
    text += '\n';
}

void append_v6_relation(std::string &text, const char *prefix, const V6RelationKey &key)
{
    text += prefix;
    text += '=';
    text += std::to_string(key.pair.first);
    text += ',';
    text += std::to_string(key.pair.second);
    text += ',';
    text += std::to_string(key.axis_mask);
    text += ',';
    text += std::to_string(static_cast<std::uint32_t>(key.kind));
    text += '\n';
}

bool v6_valid_identity_for_role(
    const char *identity,
    MeshSymmetryCertificatePartRole role) noexcept
{
    if (!valid_binding_identity(identity)) {
        return false;
    }
    const char *prefix = role == MeshSymmetryCertificatePartRole::magnetic
        ? "magnetic:"
        : "airbox:";
    return std::strncmp(identity, prefix, std::strlen(prefix)) == 0;
}

bool v6_region_roles_valid(
    const MeshSymmetryCertificateV6View &view,
    std::vector<std::pair<std::uint32_t, MeshSymmetryCertificatePartRole>> &normalized,
    const char *&reason)
{
    if (view.region_role_count == 0 || view.region_roles == nullptr) {
        reason = "periodic_mesh_certificate_v6_region_roles_missing";
        return false;
    }
    if (!safe_binding_count(view.region_role_count)) {
        reason = "periodic_mesh_certificate_v6_region_roles_overflow";
        return false;
    }
    normalized.reserve(static_cast<std::size_t>(view.region_role_count));
    std::set<std::uint32_t> seen;
    for (std::uint64_t index = 0; index < view.region_role_count; ++index) {
        const MeshSymmetryCertificateRegionRole &role = view.region_roles[index];
        if (!v6_valid_part_role(role.part_role) || !seen.insert(role.region_id).second) {
            reason = "periodic_mesh_certificate_v6_region_role_invalid";
            return false;
        }
        if (role.part_role != view.part_role) {
            reason = "periodic_mesh_certificate_v6_region_role_mismatch";
            return false;
        }
        normalized.emplace_back(role.region_id, role.part_role);
    }
    std::sort(normalized.begin(), normalized.end());
    return true;
}

bool v6_region_id_is_known(
    const std::vector<std::pair<std::uint32_t, MeshSymmetryCertificatePartRole>> &roles,
    std::uint32_t region_id) noexcept
{
    return std::binary_search(
        roles.begin(),
        roles.end(),
        std::make_pair(region_id, MeshSymmetryCertificatePartRole::magnetic),
        [](const auto &lhs, const auto &rhs) { return lhs.first < rhs.first; });
}

bool v6_relation_valid(
    const MeshSymmetryCertificateV6View &view,
    const MeshSymmetryCertificateV6Relation &relation,
    const std::vector<std::pair<std::uint32_t, MeshSymmetryCertificatePartRole>> &roles,
    const char *&reason) noexcept
{
    if (relation.source_node >= view.node_count ||
        relation.destination_node >= view.node_count ||
        relation.source_node == relation.destination_node) {
        reason = "periodic_mesh_certificate_v6_relation_node_invalid";
        return false;
    }
    if (relation.axis_mask == 0 || relation.axis_mask > 7u ||
        !v6_kind_bit(relation.kind) ||
        v6_popcount(relation.axis_mask) != static_cast<std::size_t>(relation.kind)) {
        reason = "periodic_mesh_certificate_v6_relation_kind_invalid";
        return false;
    }
    if (view.region_ids[relation.source_node] != view.region_ids[relation.destination_node] ||
        !v6_region_id_is_known(roles, view.region_ids[relation.source_node])) {
        reason = "periodic_mesh_certificate_v6_relation_region_mismatch";
        return false;
    }
    const std::uint32_t expected_axis_mask =
        view.boundary_axis_masks[relation.source_node] ^
        view.boundary_axis_masks[relation.destination_node];
    if (expected_axis_mask != relation.axis_mask) {
        reason = "periodic_mesh_certificate_v6_relation_axis_mismatch";
        return false;
    }
    return true;
}

std::string v6_class_digest_preimage(
    const MeshSymmetryCertificateV6View &view,
    std::uint64_t class_id,
    const std::vector<std::uint64_t> &members)
{
    std::string preimage = "periodic_modal_equivalence_class.v1\n";
    preimage += "schema=";
    preimage += kPeriodicMeshCertificateV6;
    preimage += '\n';
    preimage += "part_role=";
    preimage += v6_part_role_name(view.part_role);
    preimage += '\n';
    append_v6_text_field(preimage, "part_identity", view.part_identity);
    append_v6_text_field(preimage, "topology_fingerprint", view.topology_fingerprint);
    preimage += "canonical_class_id=" + std::to_string(class_id) + '\n';
    preimage += "member_count=" + std::to_string(members.size()) + '\n';
    for (const std::uint64_t member : members) {
        preimage += "member=";
        preimage += std::to_string(member);
        preimage += ",region=";
        preimage += std::to_string(view.region_ids[member]);
        preimage += ",boundary_axis_mask=";
        preimage += std::to_string(view.boundary_axis_masks[member]);
        preimage += '\n';
    }
    return preimage;
}

bool v6_expected_class_ids_valid(
    const MeshSymmetryCertificateV6View &view,
    bool payload_required,
    const std::vector<std::uint64_t> &canonical_class_ids,
    const char *&reason) noexcept
{
    if (view.expected_class_id_count > 0 && view.expected_class_ids == nullptr) {
        reason = "periodic_mesh_certificate_v6_class_ids_missing";
        return false;
    }
    if (payload_required &&
        (view.expected_class_ids == nullptr ||
         view.expected_class_id_count != view.node_count)) {
        reason = "periodic_mesh_certificate_v6_payload_class_ids_required";
        return false;
    }
    if (view.expected_class_ids == nullptr) {
        return true;
    }
    if (view.expected_class_id_count != view.node_count) {
        reason = "periodic_mesh_certificate_v6_class_id_count_mismatch";
        return false;
    }
    for (std::uint64_t index = 0; index < view.node_count; ++index) {
        if (view.expected_class_ids[index] != canonical_class_ids[index]) {
            reason = "periodic_mesh_certificate_v6_class_id_mismatch";
            return false;
        }
    }
    return true;
}

bool v6_expected_class_digests_valid(
    const MeshSymmetryCertificateV6View &view,
    bool payload_required,
    const V6ViewState &state,
    const char *&reason)
{
    if (view.expected_class_digest_count > 0 && view.expected_class_digests == nullptr) {
        reason = "periodic_mesh_certificate_v6_class_digests_missing";
        return false;
    }
    if (payload_required &&
        (view.expected_class_digests == nullptr ||
         view.expected_class_digest_count != state.members_by_class.size())) {
        reason = "periodic_mesh_certificate_v6_payload_class_digests_required";
        return false;
    }
    if (view.expected_class_digests == nullptr) {
        return true;
    }
    if (view.expected_class_digest_count != state.members_by_class.size()) {
        reason = "periodic_mesh_certificate_v6_class_digest_count_mismatch";
        return false;
    }

    std::map<std::uint64_t, const MeshSymmetryCertificateV6ClassDigest *> supplied;
    for (std::uint64_t index = 0; index < view.expected_class_digest_count; ++index) {
        const auto &digest = view.expected_class_digests[index];
        if (!valid_binding_digest(digest.sha256) ||
            !supplied.emplace(digest.canonical_class_id, &digest).second) {
            reason = "periodic_mesh_certificate_v6_class_digest_invalid";
            return false;
        }
    }
    const auto ordered_classes = v6_ordered_classes(state);
    for (std::size_t index = 0; index < ordered_classes.size(); ++index) {
        const auto supplied_it = supplied.find(ordered_classes[index].first);
        if (supplied_it == supplied.end() ||
            supplied_it->second->member_count != ordered_classes[index].second->size() ||
            std::strcmp(supplied_it->second->sha256, state.class_digests[index].c_str()) != 0) {
            reason = "periodic_mesh_certificate_v6_class_digest_mismatch";
            return false;
        }
    }
    return true;
}

bool v6_validate_view(
    const MeshSymmetryCertificateV6View &view,
    bool payload_required,
    V6ViewState &state,
    const char *&reason)
{
    if (view.schema_version == nullptr ||
        std::strcmp(view.schema_version, kPeriodicMeshCertificateV6) != 0) {
        reason = "periodic_mesh_certificate_v6_schema_invalid";
        return false;
    }
    if (!v6_valid_view_kind(view.view_kind) ||
        (payload_required && view.view_kind != MeshSymmetryCertificateV6ViewKind::compact_payload) ||
        (!payload_required && view.view_kind != MeshSymmetryCertificateV6ViewKind::authoritative_mesh)) {
        reason = "periodic_mesh_certificate_v6_view_kind_invalid";
        return false;
    }
    if (!view.require_complete_closure) {
        reason = "periodic_mesh_certificate_v6_complete_closure_required";
        return false;
    }
    if (!v6_valid_part_role(view.part_role)) {
        reason = "periodic_mesh_certificate_v6_part_role_invalid";
        return false;
    }
    if (!v6_valid_identity_for_role(view.part_identity, view.part_role)) {
        reason = "periodic_mesh_certificate_v6_part_identity_invalid";
        return false;
    }
    if (!valid_binding_digest(view.topology_fingerprint)) {
        reason = "periodic_mesh_certificate_v6_topology_fingerprint_invalid";
        return false;
    }
    if (view.node_count == 0 || !safe_binding_count(view.node_count) ||
        view.region_ids == nullptr || view.boundary_axis_masks == nullptr) {
        reason = "periodic_mesh_certificate_v6_node_arrays_missing";
        return false;
    }
    for (std::uint64_t index = 0; index < view.node_count; ++index) {
        if (view.boundary_axis_masks[index] > 7u) {
            reason = "periodic_mesh_certificate_v6_boundary_axis_mask_invalid";
            return false;
        }
    }
    if (!v6_region_roles_valid(view, state.region_roles, reason)) {
        return false;
    }
    for (std::uint64_t index = 0; index < view.node_count; ++index) {
        if (!v6_region_id_is_known(state.region_roles, view.region_ids[index])) {
            reason = "periodic_mesh_certificate_v6_node_region_unknown";
            return false;
        }
    }
    if (view.generator_relation_count == 0 || view.generator_relations == nullptr ||
        !safe_binding_count(view.generator_relation_count) ||
        (view.require_complete_closure &&
         (view.closure_relation_count == 0 || view.closure_relations == nullptr)) ||
        !safe_binding_count(view.closure_relation_count)) {
        reason = "periodic_mesh_certificate_v6_relations_missing";
        return false;
    }

    V6DisjointSet disjoint_set(static_cast<std::size_t>(view.node_count));
    std::set<V6PairKey> generator_pairs;
    for (std::uint64_t index = 0; index < view.generator_relation_count; ++index) {
        const auto &relation = view.generator_relations[index];
        if (!v6_relation_valid(view, relation, state.region_roles, reason)) {
            return false;
        }
        if (!generator_pairs.insert(v6_pair_key(relation)).second) {
            reason = "periodic_mesh_certificate_v6_generator_duplicate";
            return false;
        }
        disjoint_set.unite(relation.source_node, relation.destination_node);
        state.generator_relations.push_back(v6_relation_key(relation));
    }
    std::sort(state.generator_relations.begin(), state.generator_relations.end());

    std::set<V6PairKey> closure_pairs;
    std::set<V6RelationKey> closure_keys;
    std::map<std::uint64_t, std::uint32_t> closure_kind_masks;
    for (std::uint64_t index = 0; index < view.closure_relation_count; ++index) {
        const auto &relation = view.closure_relations[index];
        if (!v6_relation_valid(view, relation, state.region_roles, reason)) {
            return false;
        }
        if (disjoint_set.find_const(relation.source_node) !=
            disjoint_set.find_const(relation.destination_node)) {
            reason = "periodic_mesh_certificate_v6_closure_not_in_class";
            return false;
        }
        if (!closure_pairs.insert(v6_pair_key(relation)).second ||
            !closure_keys.insert(v6_relation_key(relation)).second) {
            reason = "periodic_mesh_certificate_v6_closure_duplicate";
            return false;
        }
        closure_kind_masks[disjoint_set.find_const(relation.source_node)] |=
            v6_kind_bit(relation.kind);
        state.closure_relations.push_back(v6_relation_key(relation));
    }
    std::sort(state.closure_relations.begin(), state.closure_relations.end());
    for (const V6RelationKey &generator : state.generator_relations) {
        if (closure_keys.find(generator) == closure_keys.end()) {
            reason = "periodic_mesh_certificate_v6_generator_not_in_closure";
            return false;
        }
    }

    for (std::uint64_t index = 0; index < view.node_count; ++index) {
        const std::uint64_t root = disjoint_set.find_const(index);
        state.members_by_class[root].push_back(index);
    }
    state.canonical_class_ids.resize(static_cast<std::size_t>(view.node_count));
    std::map<std::uint64_t, std::uint32_t> class_axis_masks;
    for (auto &entry : state.members_by_class) {
        std::vector<std::uint64_t> &members = entry.second;
        std::sort(members.begin(), members.end());
        const std::uint64_t canonical_id = members.front();
        for (const std::uint64_t member : members) {
            state.canonical_class_ids[static_cast<std::size_t>(member)] = canonical_id;
            class_axis_masks[entry.first] |= view.boundary_axis_masks[member];
        }
        if (view.require_complete_closure && members.size() > 1) {
            const std::uint32_t kinds = closure_kind_masks[entry.first];
            const std::size_t axis_count = v6_popcount(class_axis_masks[entry.first]);
            const std::uint32_t required_kinds =
                1u | (axis_count >= 2 ? 2u : 0u) | (axis_count >= 3 ? 4u : 0u);
            if ((kinds & required_kinds) != required_kinds) {
                reason = axis_count >= 3
                    ? "periodic_mesh_certificate_v6_corner_closure_incomplete"
                    : (axis_count >= 2
                           ? "periodic_mesh_certificate_v6_edge_closure_incomplete"
                           : "periodic_mesh_certificate_v6_face_closure_incomplete");
                return false;
            }
        }
    }

    // A complete v6 closure contains every canonical pair implied by the
    // transitive class and the endpoint boundary-axis labels.  This catches a
    // single missing edge/corner record even when another relation of the
    // same kind remains in the class.
    if (view.require_complete_closure) {
        for (const auto &entry : state.members_by_class) {
            const std::vector<std::uint64_t> &members = entry.second;
            for (std::size_t lhs_index = 0; lhs_index < members.size(); ++lhs_index) {
                for (std::size_t rhs_index = lhs_index + 1; rhs_index < members.size(); ++rhs_index) {
                    const std::uint64_t lhs = members[lhs_index];
                    const std::uint64_t rhs = members[rhs_index];
                    const std::uint32_t axis_mask =
                        view.boundary_axis_masks[lhs] ^ view.boundary_axis_masks[rhs];
                    if (axis_mask == 0) {
                        continue;
                    }
                    const auto kind = static_cast<MeshSymmetryCertificateRelationKind>(
                        v6_popcount(axis_mask));
                    if (closure_keys.find(V6RelationKey{
                            V6PairKey{lhs, rhs},
                            axis_mask,
                            kind}) == closure_keys.end()) {
                        reason = v6_popcount(axis_mask) >= 3
                            ? "periodic_mesh_certificate_v6_corner_closure_incomplete"
                            : (v6_popcount(axis_mask) == 2
                                   ? "periodic_mesh_certificate_v6_edge_closure_incomplete"
                                   : "periodic_mesh_certificate_v6_face_closure_incomplete");
                        return false;
                    }
                }
            }
        }
    }

    const auto ordered_classes = v6_ordered_classes(state);
    for (const auto &entry : ordered_classes) {
        const std::uint64_t canonical_id = entry.first;
        const std::string class_digest = "sha256:" + sha256_hex(
            v6_class_digest_preimage(view, canonical_id, *entry.second));
        state.class_digests.push_back(class_digest);
    }
    std::string class_preimage = "periodic_modal_equivalence_classes.v1\n";
    class_preimage += "schema=";
    class_preimage += kPeriodicMeshCertificateV6;
    class_preimage += '\n';
    for (std::size_t index = 0; index < state.class_digests.size(); ++index) {
        class_preimage += "class=" + std::to_string(ordered_classes[index].first);
        class_preimage += ",members=" + std::to_string(ordered_classes[index].second->size());
        class_preimage += ",digest=" + state.class_digests[index] + '\n';
    }
    state.class_digest_sha256 = "sha256:" + sha256_hex(class_preimage);

    if (!v6_expected_class_ids_valid(view, payload_required, state.canonical_class_ids, reason) ||
        !v6_expected_class_digests_valid(view, payload_required, state, reason)) {
        return false;
    }
    return true;
}

bool v6_views_equal(
    const MeshSymmetryCertificateV6View &mesh,
    const MeshSymmetryCertificateV6View &payload,
    const V6ViewState &mesh_state,
    const V6ViewState &payload_state,
    const char *&reason) noexcept
{
    if (mesh.part_role != payload.part_role || mesh.node_count != payload.node_count ||
        std::strcmp(mesh.part_identity, payload.part_identity) != 0 ||
        std::strcmp(mesh.topology_fingerprint, payload.topology_fingerprint) != 0 ||
        mesh_state.canonical_class_ids != payload_state.canonical_class_ids ||
        mesh_state.class_digests != payload_state.class_digests ||
        mesh_state.generator_relations != payload_state.generator_relations ||
        mesh_state.closure_relations != payload_state.closure_relations ||
        mesh_state.region_roles != payload_state.region_roles) {
        reason = "periodic_mesh_certificate_v6_mesh_payload_mismatch";
        return false;
    }
    for (std::uint64_t index = 0; index < mesh.node_count; ++index) {
        if (mesh.region_ids[index] != payload.region_ids[index] ||
            mesh.boundary_axis_masks[index] != payload.boundary_axis_masks[index]) {
            reason = "periodic_mesh_certificate_v6_mesh_payload_node_mismatch";
            return false;
        }
    }
    return true;
}

void append_v6_view_to_preimage(
    std::string &preimage,
    const char *name,
    const MeshSymmetryCertificateV6View &view,
    const V6ViewState &state)
{
    preimage += name;
    preimage += ".part_role=";
    preimage += v6_part_role_name(view.part_role);
    preimage += '\n';
    std::string field_name = std::string(name) + ".part_identity";
    append_v6_text_field(preimage, field_name.c_str(), view.part_identity);
    field_name = std::string(name) + ".topology_fingerprint";
    append_v6_text_field(preimage, field_name.c_str(), view.topology_fingerprint);
    preimage += name;
    preimage += ".node_count=";
    preimage += std::to_string(view.node_count);
    preimage += '\n';
    for (const auto &role : state.region_roles) {
        preimage += name;
        preimage += ".region_role=";
        preimage += std::to_string(role.first);
        preimage += ",";
        preimage += std::to_string(static_cast<std::uint32_t>(role.second));
        preimage += '\n';
    }
    for (std::uint64_t index = 0; index < view.node_count; ++index) {
        preimage += name;
        preimage += ".node=";
        preimage += std::to_string(index);
        preimage += ",region=";
        preimage += std::to_string(view.region_ids[index]);
        preimage += ",boundary_axis_mask=";
        preimage += std::to_string(view.boundary_axis_masks[index]);
        preimage += '\n';
    }
    for (const V6RelationKey &relation : state.generator_relations) {
        append_v6_relation(preimage, (std::string(name) + ".generator").c_str(), relation);
    }
    for (const V6RelationKey &relation : state.closure_relations) {
        append_v6_relation(preimage, (std::string(name) + ".closure").c_str(), relation);
    }
    const auto ordered_classes = v6_ordered_classes(state);
    for (std::size_t index = 0; index < state.class_digests.size(); ++index) {
        preimage += name;
        preimage += ".class=";
        preimage += std::to_string(ordered_classes[index].first);
        preimage += ",members=";
        preimage += std::to_string(ordered_classes[index].second->size());
        preimage += ",digest=";
        preimage += state.class_digests[index];
        preimage += '\n';
    }
}

void populate_v6_diagnostics(
    MeshSymmetryCertificateV6Binding &binding,
    const MeshSymmetryCertificateV6BindingRequest &request,
    const V6ViewState &magnetic,
    const V6ViewState &scalar)
{
    binding.magnetic_class_count = magnetic.members_by_class.size();
    binding.scalar_class_count = scalar.members_by_class.size();
    binding.magnetic_generator_relation_count =
        request.mesh_magnetic.generator_relation_count;
    binding.scalar_generator_relation_count = request.mesh_scalar.generator_relation_count;
    binding.magnetic_closure_relation_count = request.mesh_magnetic.closure_relation_count;
    binding.scalar_closure_relation_count = request.mesh_scalar.closure_relation_count;
    binding.magnetic_canonical_class_ids = magnetic.canonical_class_ids;
    binding.scalar_canonical_class_ids = scalar.canonical_class_ids;
    binding.magnetic_class_digests = magnetic.class_digests;
    binding.scalar_class_digests = scalar.class_digests;
    if (!magnetic.class_digest_sha256.empty()) {
        std::snprintf(
            binding.magnetic_class_digest_sha256,
            sizeof(binding.magnetic_class_digest_sha256),
            "%s",
            magnetic.class_digest_sha256.c_str());
    }
    if (!scalar.class_digest_sha256.empty()) {
        std::snprintf(
            binding.scalar_class_digest_sha256,
            sizeof(binding.scalar_class_digest_sha256),
            "%s",
            scalar.class_digest_sha256.c_str());
    }
}

} // namespace

FrequencyDomainStatus verify_mesh_symmetry_certificate_v6(
    const MeshSymmetryCertificateV6BindingRequest &request,
    MeshSymmetryCertificateV6Binding &out_binding) noexcept
{
    try {
        out_binding = MeshSymmetryCertificateV6Binding{};
        if (request.schema_version == nullptr ||
            std::strcmp(request.schema_version, kPeriodicMeshCertificateV6) != 0) {
            reject_v6(out_binding, "periodic_mesh_certificate_v6_schema_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        if (!valid_binding_identity(request.mesh_generation_identity)) {
            reject_v6(out_binding, "periodic_mesh_certificate_v6_mesh_generation_identity_missing");
            return FrequencyDomainStatus::validation_error;
        }

        V6ViewState mesh_magnetic_state{};
        V6ViewState payload_magnetic_state{};
        V6ViewState mesh_scalar_state{};
        V6ViewState payload_scalar_state{};
        const char *reason = "periodic_mesh_certificate_v6_invalid";
        const bool mesh_magnetic_valid = v6_validate_view(
            request.mesh_magnetic,
            false,
            mesh_magnetic_state,
            reason);
        const bool payload_magnetic_valid = v6_validate_view(
            request.payload_magnetic,
            true,
            payload_magnetic_state,
            reason);
        const bool mesh_scalar_valid = v6_validate_view(
            request.mesh_scalar,
            false,
            mesh_scalar_state,
            reason);
        const bool payload_scalar_valid = v6_validate_view(
            request.payload_scalar,
            true,
            payload_scalar_state,
            reason);
        populate_v6_diagnostics(
            out_binding,
            request,
            mesh_magnetic_state,
            mesh_scalar_state);
        if (!mesh_magnetic_valid || !payload_magnetic_valid || !mesh_scalar_valid ||
            !payload_scalar_valid) {
            reject_v6(out_binding, reason);
            return FrequencyDomainStatus::validation_error;
        }
        if (!v6_views_equal(
                request.mesh_magnetic,
                request.payload_magnetic,
                mesh_magnetic_state,
                payload_magnetic_state,
                reason) ||
            !v6_views_equal(
                request.mesh_scalar,
                request.payload_scalar,
                mesh_scalar_state,
                payload_scalar_state,
                reason)) {
            reject_v6(out_binding, reason);
            return FrequencyDomainStatus::validation_error;
        }
        if (std::strcmp(
                request.mesh_magnetic.part_identity,
                request.mesh_scalar.part_identity) == 0 ||
            std::strcmp(
                request.payload_magnetic.part_identity,
                request.payload_scalar.part_identity) == 0) {
            reject_v6(out_binding, "periodic_mesh_certificate_v6_part_identity_collision");
            return FrequencyDomainStatus::validation_error;
        }

        std::string preimage = std::string(kPeriodicModalEquivalenceMapBindingV1) +
            "\nschema=" + kPeriodicMeshCertificateV6 + '\n';
        append_v6_text_field(
            preimage,
            "mesh_generation_identity",
            request.mesh_generation_identity);
        append_v6_view_to_preimage(
            preimage,
            "magnetic",
            request.mesh_magnetic,
            mesh_magnetic_state);
        append_v6_view_to_preimage(
            preimage,
            "scalar",
            request.mesh_scalar,
            mesh_scalar_state);
        out_binding.canonical_preimage = preimage;
        const std::string digest = "sha256:" + sha256_hex(preimage);
        std::snprintf(
            out_binding.magnetic_class_digest_sha256,
            sizeof(out_binding.magnetic_class_digest_sha256),
            "%s",
            mesh_magnetic_state.class_digest_sha256.c_str());
        std::snprintf(
            out_binding.scalar_class_digest_sha256,
            sizeof(out_binding.scalar_class_digest_sha256),
            "%s",
            mesh_scalar_state.class_digest_sha256.c_str());
        std::snprintf(
            out_binding.canonical_preimage_sha256,
            sizeof(out_binding.canonical_preimage_sha256),
            "%s",
            digest.c_str());
        out_binding.magnetic_class_count = mesh_magnetic_state.members_by_class.size();
        out_binding.scalar_class_count = mesh_scalar_state.members_by_class.size();
        out_binding.magnetic_generator_relation_count =
            request.mesh_magnetic.generator_relation_count;
        out_binding.scalar_generator_relation_count =
            request.mesh_scalar.generator_relation_count;
        out_binding.magnetic_closure_relation_count =
            request.mesh_magnetic.closure_relation_count;
        out_binding.scalar_closure_relation_count =
            request.mesh_scalar.closure_relation_count;
        out_binding.magnetic_canonical_class_ids =
            mesh_magnetic_state.canonical_class_ids;
        out_binding.scalar_canonical_class_ids = mesh_scalar_state.canonical_class_ids;

        if (!valid_binding_digest(request.payload_binding_digest)) {
            reject_v6(
                out_binding,
                request.payload_binding_digest == nullptr
                    ? "periodic_mesh_certificate_v6_binding_digest_missing"
                    : "periodic_mesh_certificate_v6_binding_digest_invalid");
            return FrequencyDomainStatus::validation_error;
        }
        if (std::strcmp(request.payload_binding_digest, digest.c_str()) != 0) {
            reject_v6(out_binding, "periodic_mesh_certificate_v6_binding_digest_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        out_binding.accepted = true;
        out_binding.rejection_reason[0] = '\0';
        return FrequencyDomainStatus::ok;
    } catch (...) {
        reject_v6(out_binding, "periodic_mesh_certificate_v6_internal_error");
        return FrequencyDomainStatus::validation_error;
    }
}

FrequencyDomainStatus verify_mesh_symmetry_certificate_v6_preimage(
    const char *preimage,
    std::uint64_t preimage_len,
    const char *expected_digest,
    char *out_digest,
    std::uint64_t out_digest_size,
    char *out_reason,
    std::uint64_t out_reason_size) noexcept
{
    const auto write_bounded = [](char *destination,
                                  std::uint64_t destination_size,
                                  const char *value) noexcept {
        if (destination == nullptr || destination_size == 0u) {
            return;
        }
        const std::size_t size = static_cast<std::size_t>(destination_size);
        std::snprintf(destination, size, "%s", value != nullptr ? value : "");
        destination[size - 1u] = '\0';
    };
    const auto reject_preimage = [&](const char *reason) noexcept {
        write_bounded(out_digest, out_digest_size, "");
        write_bounded(out_reason, out_reason_size, reason);
        return FrequencyDomainStatus::validation_error;
    };
    try {
        constexpr std::uint64_t kMaximumCanonicalPreimageBytes = 16ull * 1024ull * 1024ull;
        if (preimage == nullptr || preimage_len == 0u) {
            return reject_preimage("canonical_preimage_missing");
        }
        if (preimage_len > kMaximumCanonicalPreimageBytes ||
            preimage_len > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
            return reject_preimage("canonical_preimage_length_overflow");
        }
        if (!valid_binding_digest(expected_digest)) {
            return reject_preimage(
                expected_digest == nullptr
                    ? "canonical_preimage_digest_missing"
                    : "canonical_preimage_digest_invalid");
        }

        const std::size_t length = static_cast<std::size_t>(preimage_len);
        const auto byte_at = [&](std::size_t index) {
            return static_cast<std::uint8_t>(static_cast<unsigned char>(preimage[index]));
        };
        for (std::size_t index = 0; index < length;) {
            const std::uint8_t first = byte_at(index);
            if (first == 0u) {
                return reject_preimage("canonical_preimage_utf8_invalid");
            }
            if (first <= 0x7fu) {
                ++index;
                continue;
            }
            const auto continuation = [&](std::size_t offset) {
                return offset < length && (byte_at(offset) & 0xc0u) == 0x80u;
            };
            if (first >= 0xc2u && first <= 0xdfu) {
                if (!continuation(index + 1u)) {
                    return reject_preimage("canonical_preimage_utf8_invalid");
                }
                index += 2u;
                continue;
            }
            if (first >= 0xe0u && first <= 0xefu) {
                if (!continuation(index + 1u) || !continuation(index + 2u)) {
                    return reject_preimage("canonical_preimage_utf8_invalid");
                }
                const std::uint8_t second = byte_at(index + 1u);
                if ((first == 0xe0u && second < 0xa0u) ||
                    (first == 0xedu && second > 0x9fu)) {
                    return reject_preimage("canonical_preimage_utf8_invalid");
                }
                index += 3u;
                continue;
            }
            if (first >= 0xf0u && first <= 0xf4u) {
                if (!continuation(index + 1u) || !continuation(index + 2u) ||
                    !continuation(index + 3u)) {
                    return reject_preimage("canonical_preimage_utf8_invalid");
                }
                const std::uint8_t second = byte_at(index + 1u);
                if ((first == 0xf0u && second < 0x90u) ||
                    (first == 0xf4u && second > 0x8fu)) {
                    return reject_preimage("canonical_preimage_utf8_invalid");
                }
                index += 4u;
                continue;
            }
            return reject_preimage("canonical_preimage_utf8_invalid");
        }

        const std::string canonical(preimage, length);
        const std::string actual_digest = "sha256:" + sha256_hex(canonical);
        write_bounded(out_digest, out_digest_size, actual_digest.c_str());
        if (actual_digest != expected_digest) {
            write_bounded(out_reason, out_reason_size, "canonical_preimage_digest_mismatch");
            return FrequencyDomainStatus::validation_error;
        }
        write_bounded(out_reason, out_reason_size, "none");
        return FrequencyDomainStatus::ok;
    } catch (...) {
        return reject_preimage("canonical_preimage_internal_error");
    }
}

} // namespace fullmag::fem::frequency_domain
