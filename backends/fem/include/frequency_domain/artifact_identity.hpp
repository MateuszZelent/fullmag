#pragma once

#include "fullmag_fem.h"
#include <cstddef>
#include <cstdio>
#include <string_view>

namespace fullmag::fem::frequency_domain {

// Fullmag's native ABI uses 64-bit pointers on its supported hosts.
static_assert(sizeof(FullmagFemFrequencyDomainArtifactIdentityV1) == 40);
static_assert(alignof(FullmagFemFrequencyDomainArtifactIdentityV1) == 8);
static_assert(offsetof(FullmagFemFrequencyDomainArtifactIdentityV1, abi_version) == 0);
static_assert(offsetof(FullmagFemFrequencyDomainArtifactIdentityV1, struct_size) == 4);
static_assert(offsetof(FullmagFemFrequencyDomainArtifactIdentityV1, session_id) == 8);
static_assert(offsetof(FullmagFemFrequencyDomainArtifactIdentityV1, run_id) == 16);
static_assert(offsetof(FullmagFemFrequencyDomainArtifactIdentityV1, stage_id) == 24);
static_assert(offsetof(FullmagFemFrequencyDomainArtifactIdentityV1, runtime_id) == 32);

inline bool identity_ascii_equal(std::string_view value, std::string_view expected) noexcept
{
    if (value.size() != expected.size()) return false;
    for (std::size_t i = 0; i < value.size(); ++i) {
        const auto ch = static_cast<unsigned char>(value[i]);
        const auto lower = ch >= 'A' && ch <= 'Z' ? ch + ('a' - 'A') : ch;
        if (lower != static_cast<unsigned char>(expected[i])) return false;
    }
    return true;
}

inline bool identity_unicode_whitespace(unsigned cp) noexcept
{
    return (cp >= 9 && cp <= 13) || cp == 0x20 || cp == 0x85 || cp == 0xa0 ||
        cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp == 0x2028 ||
        cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000;
}

inline bool validate_artifact_identity_value(const char *raw) noexcept
{
    if (raw == nullptr) return false;
    const std::string_view value(raw);
    std::size_t first = value.size(), last = 0;
    for (std::size_t i = 0; i < value.size();) {
        const std::size_t start = i;
        const auto lead = static_cast<unsigned char>(value[i++]);
        unsigned cp = lead, remaining = 0, minimum = 0;
        if (lead >= 0xc2 && lead <= 0xdf) { cp = lead & 0x1f; remaining = 1; minimum = 0x80; }
        else if (lead >= 0xe0 && lead <= 0xef) { cp = lead & 0x0f; remaining = 2; minimum = 0x800; }
        else if (lead >= 0xf0 && lead <= 0xf4) { cp = lead & 7; remaining = 3; minimum = 0x10000; }
        else if (lead >= 0x80) return false;
        if (remaining > value.size() - i) return false;
        for (; remaining > 0; --remaining) {
            const auto next = static_cast<unsigned char>(value[i++]);
            if ((next & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (next & 0x3f);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ||
            cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return false;
        if (!identity_unicode_whitespace(cp)) {
            if (first == value.size()) first = start;
            last = i;
        }
    }
    if (first == value.size()) return false;
    const auto normalized = value.substr(first, last - first);
    return !identity_ascii_equal(normalized, "current") &&
        !identity_ascii_equal(normalized, "run:current") &&
        !identity_ascii_equal(normalized, "runtime:not_provided") &&
        !(normalized.size() >= 8 &&
          identity_ascii_equal(normalized.substr(normalized.size() - 8), ":current"));
}

inline bool validate_artifact_identity_v1(
    const FullmagFemFrequencyDomainArtifactIdentityV1 *identity,
    char error_message[128]) noexcept
{
    if (identity == nullptr ||
        identity->abi_version != FULLMAG_FEM_FREQUENCY_DOMAIN_ARTIFACT_IDENTITY_V1 ||
        identity->struct_size != sizeof(FullmagFemFrequencyDomainArtifactIdentityV1)) {
        std::snprintf(error_message, 128, "invalid frequency-domain artifact identity ABI");
        return false;
    }
    const char *values[] = {identity->session_id, identity->run_id, identity->stage_id, identity->runtime_id};
    const char *labels[] = {"session_id", "run_id", "stage_id", "runtime_id"};
    for (std::size_t i = 0; i < 4; ++i) {
        if (!validate_artifact_identity_value(values[i])) {
            std::snprintf(error_message, 128, "frequency-domain artifact %s must be an exact UTF-8 identity", labels[i]);
            return false;
        }
    }
    return true;
}

} // namespace fullmag::fem::frequency_domain
