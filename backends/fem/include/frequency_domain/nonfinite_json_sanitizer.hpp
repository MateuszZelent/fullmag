#pragma once

#include <cstddef>
#include <cstring>

namespace fullmag::fem::frequency_domain {
namespace detail {

inline bool nonfinite_json_whitespace(char value) noexcept
{
    return value == ' ' || value == '\t' || value == '\n' || value == '\r';
}

inline bool nonfinite_json_value_prefix(
    const char *json,
    std::size_t index) noexcept
{
    if (index == 0u) {
        return true;
    }
    const char previous = json[index - 1u];
    return previous == '[' || previous == '{' || previous == ':' ||
        previous == ',' || nonfinite_json_whitespace(previous);
}

inline bool nonfinite_json_value_suffix(
    const char *json,
    std::size_t length,
    std::size_t index) noexcept
{
    if (index == length) {
        return true;
    }
    const char next = json[index];
    return next == ',' || next == ']' || next == '}' ||
        nonfinite_json_whitespace(next);
}

inline std::size_t nonfinite_json_token_length(
    const char *json,
    std::size_t length,
    std::size_t index) noexcept
{
    if (!nonfinite_json_value_prefix(json, index)) {
        return 0u;
    }

    const bool negative = json[index] == '-';
    const std::size_t word_index = index + (negative ? 1u : 0u);
    if (word_index > length || length - word_index < 3u) {
        return 0u;
    }
    if (std::strncmp(json + word_index, "nan", 3u) != 0 &&
        std::strncmp(json + word_index, "inf", 3u) != 0) {
        return 0u;
    }

    const std::size_t token_end = word_index + 3u;
    if (!nonfinite_json_value_suffix(json, length, token_end)) {
        return 0u;
    }
    return token_end - index;
}

inline bool preflight_nonfinite_json(
    const char *json,
    std::size_t length,
    std::size_t *required_growth) noexcept
{
    if (required_growth == nullptr) {
        return false;
    }

    bool in_string = false;
    bool escaped = false;
    std::size_t growth = 0u;
    for (std::size_t index = 0u; index < length;) {
        const char current = json[index];
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else if (current == '\\') {
                escaped = true;
            } else if (current == '"') {
                in_string = false;
            }
            ++index;
            continue;
        }
        if (current == '"') {
            in_string = true;
            ++index;
            continue;
        }

        const std::size_t token_length =
            nonfinite_json_token_length(json, length, index);
        if (token_length != 0u) {
            if (token_length == 3u) {
                ++growth;
            }
            index += token_length;
        } else {
            ++index;
        }
    }

    if (in_string || escaped) {
        return false;
    }
    *required_growth = growth;
    return true;
}

} // namespace detail

// Normalize only complete, unquoted printf non-finite value tokens. Preflight
// keeps every failure path non-mutating and guarantees room for the longer
// JSON spelling "null".
inline bool sanitize_nonfinite_json(char *json, std::size_t capacity) noexcept
{
    if (json == nullptr || capacity == 0u) {
        return false;
    }

    std::size_t length = 0u;
    while (length < capacity && json[length] != '\0') {
        ++length;
    }
    if (length == capacity) {
        return false;
    }

    std::size_t required_growth = 0u;
    if (!detail::preflight_nonfinite_json(json, length, &required_growth) ||
        required_growth > capacity - length - 1u) {
        return false;
    }

    bool in_string = false;
    bool escaped = false;
    for (std::size_t index = 0u; index < length;) {
        const char current = json[index];
        if (in_string) {
            if (escaped) {
                escaped = false;
            } else if (current == '\\') {
                escaped = true;
            } else if (current == '"') {
                in_string = false;
            }
            ++index;
            continue;
        }
        if (current == '"') {
            in_string = true;
            ++index;
            continue;
        }

        const std::size_t token_length =
            detail::nonfinite_json_token_length(json, length, index);
        if (token_length == 0u) {
            ++index;
            continue;
        }

        constexpr char replacement[] = "null";
        constexpr std::size_t replacement_length = sizeof(replacement) - 1u;
        if (token_length < replacement_length) {
            const std::size_t tail_index = index + token_length;
            std::memmove(
                json + index + replacement_length,
                json + tail_index,
                length - tail_index + 1u);
            length += replacement_length - token_length;
        }
        std::memcpy(json + index, replacement, replacement_length);
        index += replacement_length;
    }
    return true;
}

} // namespace fullmag::fem::frequency_domain
