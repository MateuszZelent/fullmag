#pragma once

#include <cmath>
#include <cstdlib>
#include <cstring>

namespace fullmag {
namespace fem {
namespace frequency_domain {

struct ModalKrylovTuning {
    double eps_prefilter_abs;
    double shifted_ksp_rtol;
    int gmres_restart;
    const char *shifted_ksp_type;
};

struct ModalKrylovTuningValues {
    const char *eps_prefilter_abs;
    const char *shifted_ksp_rtol;
    const char *gmres_restart;
    const char *shifted_ksp_type;
};

namespace modal_krylov_tuning_detail {

inline bool is_valid_tolerance(double value) noexcept
{
    return std::isfinite(value) && value > 0.0;
}

inline const char *canonical_ksp_type(const char *value) noexcept
{
    if (value == nullptr) {
        return nullptr;
    }
    if (std::strcmp(value, "gmres") == 0) {
        return "gmres";
    }
    if (std::strcmp(value, "fgmres") == 0) {
        return "fgmres";
    }
    return nullptr;
}

inline bool select_token(
    const char *common,
    const char *legacy,
    bool allow_legacy,
    const char **selected) noexcept
{
    if (selected == nullptr) {
        return false;
    }
    if (allow_legacy && common != nullptr && legacy != nullptr &&
        std::strcmp(common, legacy) != 0) {
        return false;
    }
    *selected = common != nullptr ? common : (allow_legacy ? legacy : nullptr);
    return true;
}

inline bool parse_tolerance(const char *token, double *value) noexcept
{
    if (token == nullptr || value == nullptr) {
        return false;
    }
    struct Choice {
        const char *token;
        double value;
    };
    static const Choice choices[] = {
        {"1e-6", 1.0e-6},
        {"1e-7", 1.0e-7},
        {"1e-8", 1.0e-8},
        {"1e-9", 1.0e-9},
        {"1e-10", 1.0e-10},
        {"1e-11", 1.0e-11},
        {"1e-12", 1.0e-12},
        {"1e-13", 1.0e-13},
    };
    for (const Choice &choice : choices) {
        if (std::strcmp(token, choice.token) == 0) {
            *value = choice.value;
            return true;
        }
    }
    return false;
}

inline bool parse_gmres_restart(const char *token, int *value) noexcept
{
    if (token == nullptr || value == nullptr) {
        return false;
    }
    struct Choice {
        const char *token;
        int value;
    };
    static const Choice choices[] = {
        {"8", 8},
        {"10", 10},
        {"12", 12},
        {"16", 16},
        {"30", 30},
    };
    for (const Choice &choice : choices) {
        if (std::strcmp(token, choice.token) == 0) {
            *value = choice.value;
            return true;
        }
    }
    return false;
}

} // namespace modal_krylov_tuning_detail

inline bool resolve_modal_krylov_tuning_values(
    const ModalKrylovTuning &defaults,
    const ModalKrylovTuningValues &common_values,
    const ModalKrylovTuningValues &legacy_values,
    bool allow_legacy_floquet_aliases,
    ModalKrylovTuning *out) noexcept
{
    using namespace modal_krylov_tuning_detail;
    if (out == nullptr || !is_valid_tolerance(defaults.eps_prefilter_abs) ||
        !is_valid_tolerance(defaults.shifted_ksp_rtol) ||
        defaults.gmres_restart <= 0) {
        return false;
    }

    ModalKrylovTuning resolved = defaults;
    resolved.shifted_ksp_type = canonical_ksp_type(defaults.shifted_ksp_type);
    if (resolved.shifted_ksp_type == nullptr) {
        return false;
    }

    const char *token = nullptr;
    double tolerance = 0.0;
    if (!select_token(
            common_values.eps_prefilter_abs,
            legacy_values.eps_prefilter_abs,
            allow_legacy_floquet_aliases,
            &token)) {
        return false;
    }
    if (token != nullptr) {
        if (!parse_tolerance(token, &tolerance)) {
            return false;
        }
        resolved.eps_prefilter_abs = tolerance;
    }

    if (!select_token(
            common_values.shifted_ksp_rtol,
            legacy_values.shifted_ksp_rtol,
            allow_legacy_floquet_aliases,
            &token)) {
        return false;
    }
    if (token != nullptr) {
        if (!parse_tolerance(token, &tolerance)) {
            return false;
        }
        resolved.shifted_ksp_rtol = tolerance;
    }

    if (!select_token(
            common_values.gmres_restart,
            legacy_values.gmres_restart,
            allow_legacy_floquet_aliases,
            &token)) {
        return false;
    }
    if (token != nullptr &&
        !parse_gmres_restart(token, &resolved.gmres_restart)) {
        return false;
    }

    if (!select_token(
            common_values.shifted_ksp_type,
            legacy_values.shifted_ksp_type,
            allow_legacy_floquet_aliases,
            &token)) {
        return false;
    }
    if (token != nullptr) {
        resolved.shifted_ksp_type = canonical_ksp_type(token);
        if (resolved.shifted_ksp_type == nullptr) {
            return false;
        }
    }

    *out = resolved;
    return true;
}

inline bool resolve_modal_krylov_tuning(
    const ModalKrylovTuning &defaults,
    bool allow_legacy_floquet_aliases,
    ModalKrylovTuning *out) noexcept
{
    if (out == nullptr) {
        return false;
    }

    const ModalKrylovTuningValues common_values = {
        std::getenv("FULLMAG_MODAL_EPS_PREFILTER_ABS"),
        std::getenv("FULLMAG_MODAL_SHIFTED_KSP_RTOL"),
        std::getenv("FULLMAG_MODAL_GMRES_RESTART"),
        std::getenv("FULLMAG_MODAL_SHIFTED_KSP_TYPE"),
    };
    ModalKrylovTuningValues legacy_values = {
        nullptr,
        nullptr,
        nullptr,
        nullptr,
    };
    if (allow_legacy_floquet_aliases) {
        legacy_values.eps_prefilter_abs =
            std::getenv("FULLMAG_FLOQUET_EPS_PREFILTER_ABS");
        legacy_values.shifted_ksp_rtol =
            std::getenv("FULLMAG_FLOQUET_SHIFTED_KSP_RTOL");
        legacy_values.gmres_restart =
            std::getenv("FULLMAG_FLOQUET_GMRES_RESTART");
        legacy_values.shifted_ksp_type =
            std::getenv("FULLMAG_FLOQUET_SHIFTED_KSP_TYPE");
    }
    return resolve_modal_krylov_tuning_values(
        defaults,
        common_values,
        legacy_values,
        allow_legacy_floquet_aliases,
        out);
}

} // namespace frequency_domain
} // namespace fem
} // namespace fullmag
