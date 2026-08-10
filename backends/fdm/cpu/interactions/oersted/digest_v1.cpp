#include "oersted_internal_v1.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fullmag::fdm::cpu::oersted::v1::detail {
namespace {

constexpr std::array<std::uint32_t, 64> sha256_constants{
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
    0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
    0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
    0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

std::uint32_t rotate_right(std::uint32_t value, std::uint32_t amount) noexcept {
    return (value >> amount) | (value << (32U - amount));
}

std::array<std::uint8_t, 32> sha256_raw(const std::vector<std::uint8_t> &input) {
    std::vector<std::uint8_t> message = input;
    const std::uint64_t bit_length = static_cast<std::uint64_t>(message.size()) * 8U;
    message.push_back(0x80U);
    while ((message.size() % 64U) != 56U) {
        message.push_back(0U);
    }
    for (int shift = 56; shift >= 0; shift -= 8) {
        message.push_back(static_cast<std::uint8_t>(bit_length >> shift));
    }

    std::array<std::uint32_t, 8> state{
        0x6a09e667U,
        0xbb67ae85U,
        0x3c6ef372U,
        0xa54ff53aU,
        0x510e527fU,
        0x9b05688cU,
        0x1f83d9abU,
        0x5be0cd19U,
    };
    std::array<std::uint32_t, 64> words{};
    for (std::size_t offset = 0; offset < message.size(); offset += 64U) {
        for (std::size_t i = 0; i < 16; ++i) {
            const std::size_t at = offset + 4U * i;
            words[i] = (static_cast<std::uint32_t>(message[at]) << 24U) |
                       (static_cast<std::uint32_t>(message[at + 1]) << 16U) |
                       (static_cast<std::uint32_t>(message[at + 2]) << 8U) |
                       static_cast<std::uint32_t>(message[at + 3]);
        }
        for (std::size_t i = 16; i < words.size(); ++i) {
            const std::uint32_t s0 = rotate_right(words[i - 15], 7U) ^
                                     rotate_right(words[i - 15], 18U) ^
                                     (words[i - 15] >> 3U);
            const std::uint32_t s1 = rotate_right(words[i - 2], 17U) ^
                                     rotate_right(words[i - 2], 19U) ^
                                     (words[i - 2] >> 10U);
            words[i] = words[i - 16] + s0 + words[i - 7] + s1;
        }

        std::uint32_t a = state[0];
        std::uint32_t b = state[1];
        std::uint32_t c = state[2];
        std::uint32_t d = state[3];
        std::uint32_t e = state[4];
        std::uint32_t f = state[5];
        std::uint32_t g = state[6];
        std::uint32_t h = state[7];
        for (std::size_t i = 0; i < words.size(); ++i) {
            const std::uint32_t s1 = rotate_right(e, 6U) ^ rotate_right(e, 11U) ^
                                     rotate_right(e, 25U);
            const std::uint32_t choose = (e & f) ^ ((~e) & g);
            const std::uint32_t temp1 =
                h + s1 + choose + sha256_constants[i] + words[i];
            const std::uint32_t s0 = rotate_right(a, 2U) ^ rotate_right(a, 13U) ^
                                     rotate_right(a, 22U);
            const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const std::uint32_t temp2 = s0 + majority;
            h = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }
        state[0] += a;
        state[1] += b;
        state[2] += c;
        state[3] += d;
        state[4] += e;
        state[5] += f;
        state[6] += g;
        state[7] += h;
    }

    std::array<std::uint8_t, 32> digest{};
    for (std::size_t i = 0; i < state.size(); ++i) {
        digest[4U * i] = static_cast<std::uint8_t>(state[i] >> 24U);
        digest[4U * i + 1] = static_cast<std::uint8_t>(state[i] >> 16U);
        digest[4U * i + 2] = static_cast<std::uint8_t>(state[i] >> 8U);
        digest[4U * i + 3] = static_cast<std::uint8_t>(state[i]);
    }
    return digest;
}

void append_source_cut(CanonicalBytes &bytes, const SourceCutRecord &source_cut) {
    bytes.text(source_cut.stable_id);
    bytes.u64(source_cut.component_label);
    bytes.u64_vector(source_cut.ordered_internal_face_ids);
    bytes.i8_vector(source_cut.ordered_normals);
    bytes.text(source_cut.drive_id);
    bytes.text(source_cut.drive_kind);
    bytes.f64(source_cut.drive_value);
    bytes.text(source_cut.drive_si_unit);
    bytes.u64(source_cut.revision);
}

} // namespace

void CanonicalBytes::tag(std::string_view value) {
    text(value);
}

void CanonicalBytes::u8(std::uint8_t value) {
    data_.push_back(value);
}

void CanonicalBytes::u64(std::uint64_t value) {
    for (int shift = 56; shift >= 0; shift -= 8) {
        data_.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

void CanonicalBytes::f64(double value) {
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value), "binary64 representation required");
    std::memcpy(&bits, &value, sizeof(bits));
    u64(bits);
}

void CanonicalBytes::boolean(bool value) {
    u8(value ? 1U : 0U);
}

void CanonicalBytes::text(std::string_view value) {
    u64(static_cast<std::uint64_t>(value.size()));
    data_.insert(data_.end(), value.begin(), value.end());
}

void CanonicalBytes::bytes(const std::vector<std::uint8_t> &value) {
    u64(static_cast<std::uint64_t>(value.size()));
    data_.insert(data_.end(), value.begin(), value.end());
}

void CanonicalBytes::f64_vector(const std::vector<double> &value) {
    u64(static_cast<std::uint64_t>(value.size()));
    for (double scalar : value) {
        f64(scalar);
    }
}

void CanonicalBytes::u64_vector(const std::vector<std::uint64_t> &value) {
    u64(static_cast<std::uint64_t>(value.size()));
    for (std::uint64_t scalar : value) {
        u64(scalar);
    }
}

void CanonicalBytes::i8_vector(const std::vector<std::int8_t> &value) {
    u64(static_cast<std::uint64_t>(value.size()));
    for (std::int8_t scalar : value) {
        u8(static_cast<std::uint8_t>(scalar));
    }
}

std::string sha256_digest(const std::vector<std::uint8_t> &bytes) {
    const auto raw = sha256_raw(bytes);
    std::ostringstream output;
    output << "sha256:" << std::hex << std::setfill('0');
    for (std::uint8_t byte : raw) {
        output << std::setw(2) << static_cast<unsigned int>(byte);
    }
    return output.str();
}

std::string sha256_text(std::string_view text) {
    return sha256_digest(
        std::vector<std::uint8_t>(text.begin(), text.end()));
}

std::size_t checked_cell_count(const Grid &grid, bool &ok) noexcept {
    ok = false;
    if (grid.nx == 0 || grid.ny == 0 || grid.nz == 0) {
        return 0;
    }
    const std::size_t maximum = std::numeric_limits<std::size_t>::max();
    if (grid.nx > maximum / grid.ny) {
        return 0;
    }
    const std::size_t xy = grid.nx * grid.ny;
    if (xy > maximum / grid.nz) {
        return 0;
    }
    ok = true;
    return xy * grid.nz;
}

std::array<std::size_t, 3> padded_shape(const Grid &grid) noexcept {
    return {2U * grid.nx, 2U * grid.ny, 2U * grid.nz};
}

std::size_t cell_index(const Grid &grid,
                       std::size_t x,
                       std::size_t y,
                       std::size_t z) noexcept {
    return (z * grid.ny + y) * grid.nx + x;
}

std::size_t x_face_index(const Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) noexcept {
    return (z * grid.ny + y) * (grid.nx + 1U) + x;
}

std::size_t y_face_index(const Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) noexcept {
    return (z * (grid.ny + 1U) + y) * grid.nx + x;
}

std::size_t z_face_index(const Grid &grid,
                         std::size_t x,
                         std::size_t y,
                         std::size_t z) noexcept {
    return (z * grid.ny + y) * grid.nx + x;
}

} // namespace fullmag::fdm::cpu::oersted::v1::detail

namespace fullmag::fdm::cpu::oersted::v1 {

std::string canonical_geometry_digest(const Grid &grid) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_oersted_union_grid_geometry.v1");
    bytes.u64(static_cast<std::uint64_t>(grid.nx));
    bytes.u64(static_cast<std::uint64_t>(grid.ny));
    bytes.u64(static_cast<std::uint64_t>(grid.nz));
    bytes.f64(grid.dx_m);
    bytes.f64(grid.dy_m);
    bytes.f64(grid.dz_m);
    for (double coordinate : grid.origin_m) {
        bytes.f64(coordinate);
    }
    for (AxisBoundary boundary : grid.boundaries) {
        bytes.u64(static_cast<std::uint64_t>(boundary));
    }
    return detail::sha256_digest(bytes.data());
}

std::string canonical_mask_digest(const std::vector<std::uint8_t> &mask) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_oersted_boolean_mask.v1");
    bytes.bytes(mask);
    return detail::sha256_digest(bytes.data());
}

std::string canonical_face_current_digest(const FaceCurrentDensity &face_current) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_oriented_face_current_density.v1");
    bytes.f64_vector(face_current.x);
    bytes.f64_vector(face_current.y);
    bytes.f64_vector(face_current.z);
    return detail::sha256_digest(bytes.data());
}

std::string canonical_source_cut_digest(const SourceCutRecord &source_cut) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_oersted_source_cut.v1");
    detail::append_source_cut(bytes, source_cut);
    return detail::sha256_digest(bytes.data());
}

std::string canonical_certificate_digest(
    const GlobalClosedCurrentCertificate &certificate) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_global_closed_current_certificate_payload.v1");
    bytes.text(certificate.version);
    bytes.u64(static_cast<std::uint64_t>(certificate.closure_kind));
    bytes.u64(certificate.revision);
    bytes.text(certificate.geometry_digest);
    bytes.u64(certificate.conductor_mask_revision);
    bytes.text(certificate.conductor_mask_digest);
    bytes.u64(certificate.face_current_revision);
    bytes.text(certificate.face_current_digest);
    bytes.u64_vector(certificate.component_labels);
    bytes.u64(static_cast<std::uint64_t>(certificate.component_count));
    bytes.boolean(certificate.global_continuity_passed);
    bytes.boolean(certificate.exterior_flux_passed);
    bytes.boolean(certificate.component_flux_passed);
    bytes.boolean(certificate.return_path_complete);
    bytes.f64(certificate.divergence_tolerance_a_per_m3);
    bytes.f64(certificate.exterior_current_tolerance_a);
    bytes.f64(certificate.measured_max_abs_divergence_a_per_m3);
    bytes.f64_vector(certificate.measured_component_exterior_current_a);
    bytes.u64(static_cast<std::uint64_t>(certificate.source_cuts.size()));
    for (const SourceCutRecord &source_cut : certificate.source_cuts) {
        detail::append_source_cut(bytes, source_cut);
        bytes.text(source_cut.digest);
    }
    bytes.text(certificate.imported_certification_method);
    bytes.text(certificate.imported_field_digest);
    return detail::sha256_digest(bytes.data());
}

std::string canonical_trusted_snapshot_digest(const Problem &problem) {
    detail::CanonicalBytes bytes;
    bytes.tag("fdm_oersted_trusted_immutable_snapshot.v1");
    bytes.u64(problem.geometry_revision);
    bytes.text(problem.geometry_digest);
    bytes.u64(problem.conductor_mask_revision);
    bytes.text(problem.conductor_mask_digest);
    bytes.u64(problem.target_mask_revision);
    bytes.text(problem.target_mask_digest);
    bytes.u64(problem.face_current_revision);
    bytes.text(problem.face_current_digest);
    bytes.text(problem.closure_certificate.digest);
    bytes.u64(problem.closure_certificate.revision);
    bytes.text(problem.source_identity);
    bytes.u64(problem.envelope_revision);
    bytes.text(problem.envelope_digest);
    bytes.u64(problem.stage_identity);
    bytes.f64(problem.evaluation_time_s);
    bytes.f64(problem.evaluated_envelope_multiplier);
    return detail::sha256_digest(bytes.data());
}

} // namespace fullmag::fdm::cpu::oersted::v1
