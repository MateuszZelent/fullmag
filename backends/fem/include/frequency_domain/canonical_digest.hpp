#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace fullmag::fem::frequency_domain {

// A typed, length-prefixed canonical payload.  Its v1 byte stream is stable
// across hosts: integer and normalized IEEE-754 values are big endian.
class CanonicalDigestBuilder {
public:
    explicit CanonicalDigestBuilder(std::string_view schema);
    void add_string(std::string_view name, std::string_view value);
    void add_u64(std::string_view name, std::uint64_t value);
    void add_double(std::string_view name, double value);
    void add_bytes(std::string_view name, const std::uint8_t *value, std::uint64_t size);
    [[nodiscard]] std::string sha256_hex() const;

private:
    void add_field(std::string_view name, std::uint8_t type, const std::uint8_t *value, std::uint64_t size);
    std::string payload_;
};

} // namespace fullmag::fem::frequency_domain
