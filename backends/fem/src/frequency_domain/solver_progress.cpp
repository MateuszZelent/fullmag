#include "frequency_domain/solver_progress.hpp"

#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>

namespace fullmag::fem::frequency_domain {

namespace {

bool append_char(char **cursor, std::size_t *remaining, char value) noexcept
{
    if (*remaining <= 1) {
        return false;
    }
    **cursor = value;
    ++(*cursor);
    --(*remaining);
    **cursor = '\0';
    return true;
}

bool append_literal(char **cursor, std::size_t *remaining, const char *value) noexcept
{
    const std::size_t len = std::strlen(value);
    if (len >= *remaining) {
        return false;
    }
    std::memcpy(*cursor, value, len);
    *cursor += len;
    *remaining -= len;
    **cursor = '\0';
    return true;
}

bool append_int(char **cursor, std::size_t *remaining, int value) noexcept
{
    char buffer[32];
    const int written = std::snprintf(buffer, sizeof(buffer), "%d", value);
    if (written < 0 || static_cast<std::size_t>(written) >= sizeof(buffer)) {
        return false;
    }
    return append_literal(cursor, remaining, buffer);
}

bool append_json_string(char **cursor, std::size_t *remaining, const char *value) noexcept
{
    if (!append_char(cursor, remaining, '"')) {
        return false;
    }
    if (value != nullptr) {
        for (const unsigned char ch : std::string_view(value)) {
            switch (ch) {
            case '"':
                if (!append_literal(cursor, remaining, "\\\"")) {
                    return false;
                }
                break;
            case '\\':
                if (!append_literal(cursor, remaining, "\\\\")) {
                    return false;
                }
                break;
            case '\b':
                if (!append_literal(cursor, remaining, "\\b")) {
                    return false;
                }
                break;
            case '\f':
                if (!append_literal(cursor, remaining, "\\f")) {
                    return false;
                }
                break;
            case '\n':
                if (!append_literal(cursor, remaining, "\\n")) {
                    return false;
                }
                break;
            case '\r':
                if (!append_literal(cursor, remaining, "\\r")) {
                    return false;
                }
                break;
            case '\t':
                if (!append_literal(cursor, remaining, "\\t")) {
                    return false;
                }
                break;
            default:
                if (ch < 0x20) {
                    char escaped[7];
                    const int written = std::snprintf(escaped, sizeof(escaped), "\\u%04x", ch);
                    if (written != 6 || !append_literal(cursor, remaining, escaped)) {
                        return false;
                    }
                } else if (!append_char(cursor, remaining, static_cast<char>(ch))) {
                    return false;
                }
                break;
            }
        }
    }
    return append_char(cursor, remaining, '"');
}

} // namespace

std::size_t solver_progress_json(
    const SolverProgressState &state,
    char *out_json,
    std::size_t out_json_capacity) noexcept
{
    if (out_json == nullptr || out_json_capacity == 0) {
        return 0;
    }
    out_json[0] = '\0';
    char *cursor = out_json;
    std::size_t remaining = out_json_capacity;
    if (!append_literal(&cursor, &remaining, "{\"schema_version\":\"fem_frequency_domain_progress.v1\"") ||
        !append_literal(&cursor, &remaining, ",\"study_product\":") ||
        !append_json_string(&cursor, &remaining, state.study_product) ||
        !append_literal(&cursor, &remaining, ",\"solver_phase\":") ||
        !append_json_string(&cursor, &remaining, state.solver_phase) ||
        !append_literal(&cursor, &remaining, ",\"execution_lane\":") ||
        !append_json_string(&cursor, &remaining, state.execution_lane)) {
        out_json[0] = '\0';
        return 0;
    }
    if (state.contour_point_index >= 0) {
        if (!append_literal(&cursor, &remaining, ",\"contour_point_index\":") ||
            !append_int(&cursor, &remaining, state.contour_point_index) ||
            !append_literal(&cursor, &remaining, ",\"contour_point_count\":") ||
            !append_int(&cursor, &remaining, state.contour_point_count) ||
            !append_literal(&cursor, &remaining, ",\"linear_iteration\":") ||
            !append_int(&cursor, &remaining, state.linear_iteration) ||
            !append_literal(&cursor, &remaining, ",\"max_linear_iterations\":") ||
            !append_int(&cursor, &remaining, state.max_linear_iterations)) {
            out_json[0] = '\0';
            return 0;
        }
    }
    if (!append_literal(&cursor, &remaining, ",\"stop_reason\":")) {
        out_json[0] = '\0';
        return 0;
    }
    if (state.stop_reason == nullptr) {
        if (!append_literal(&cursor, &remaining, "null")) {
            out_json[0] = '\0';
            return 0;
        }
    } else if (!append_json_string(&cursor, &remaining, state.stop_reason)) {
        out_json[0] = '\0';
        return 0;
    }
    if (!append_char(&cursor, &remaining, '}')) {
        out_json[0] = '\0';
        return 0;
    }
    return static_cast<std::size_t>(cursor - out_json);
}

std::string solver_progress_json(const SolverProgressState &state)
{
    char buffer[1024];
    const std::size_t written = solver_progress_json(state, buffer, sizeof(buffer));
    if (written == 0) {
        return {};
    }
    return std::string(buffer, written);
}

} // namespace fullmag::fem::frequency_domain
