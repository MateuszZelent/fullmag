"""Color mapping and complex phasor evaluation aligned with Fullmag Control Room.

Every RGB palette and direction-to-HSL mapping in this module matches
``apps/control-room/src/shared/visualization/directionColor.ts``,
``apps/control-room/src/shared/visualization/scalarColorPalette.ts``,
``apps/control-room/src/shared/domain/analysis/phasorConventionAdapter.ts``, and
``apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts``.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np
from numpy.typing import ArrayLike, NDArray

DIRECTION_HSL_SATURATION = 1.0
DIRECTION_HSL_ZERO_NORM = 1e-30
DIRECTION_HSL_NEUTRAL_RGB = (0.6, 0.6, 0.6)

SUPPORTED_COLOR_MODES = (
    "orientation",
    "x",
    "y",
    "z",
    "magnitude",
    "scalar",
    "monochrome",
)

SUPPORTED_COMPLEX_REPRESENTATIONS = (
    "phase_rotated_real",
    "real",
    "imag",
    "abs",
    "phase",
)

SCALAR_PALETTES: dict[str, tuple[tuple[float, float, float], ...]] = {
    "coolwarm": (
        (0x3B / 255.0, 0x4C / 255.0, 0xC0 / 255.0),
        (0xDD / 255.0, 0xDD / 255.0, 0xDD / 255.0),
        (0xB4 / 255.0, 0x04 / 255.0, 0x26 / 255.0),
    ),
    "inferno": (
        (0x00 / 255.0, 0x00 / 255.0, 0x04 / 255.0),
        (0x42 / 255.0, 0x0A / 255.0, 0x68 / 255.0),
        (0x93 / 255.0, 0x2B / 255.0, 0x5D / 255.0),
        (0xDD / 255.0, 0x51 / 255.0, 0x3A / 255.0),
        (0xFC / 255.0, 0xFF / 255.0, 0xA4 / 255.0),
    ),
    "jet": (
        (0x00 / 255.0, 0x00 / 255.0, 0x7F / 255.0),
        (0x00 / 255.0, 0x7F / 255.0, 0xFF / 255.0),
        (0x7F / 255.0, 0xFF / 255.0, 0x7F / 255.0),
        (0xFF / 255.0, 0x7F / 255.0, 0x00 / 255.0),
        (0x7F / 255.0, 0x00 / 255.0, 0x00 / 255.0),
    ),
    "magma": (
        (0x00 / 255.0, 0x00 / 255.0, 0x04 / 255.0),
        (0x3B / 255.0, 0x0F / 255.0, 0x70 / 255.0),
        (0x8C / 255.0, 0x29 / 255.0, 0x80 / 255.0),
        (0xDE / 255.0, 0x49 / 255.0, 0x68 / 255.0),
        (0xFC / 255.0, 0xFD / 255.0, 0xBF / 255.0),
    ),
    "viridis": (
        (0x44 / 255.0, 0x01 / 255.0, 0x54 / 255.0),
        (0x31 / 255.0, 0x68 / 255.0, 0x8E / 255.0),
        (0x35 / 255.0, 0xB7 / 255.0, 0x79 / 255.0),
        (0xFD / 255.0, 0xE7 / 255.0, 0x25 / 255.0),
    ),
    "plasma": (
        (0x0D / 255.0, 0x08 / 255.0, 0x87 / 255.0),
        (0x7E / 255.0, 0x03 / 255.0, 0xA8 / 255.0),
        (0xCC / 255.0, 0x47 / 255.0, 0x78 / 255.0),
        (0xF8 / 255.0, 0x95 / 255.0, 0x40 / 255.0),
        (0xF0 / 255.0, 0xF9 / 255.0, 0x21 / 255.0),
    ),
    "cividis": (
        (0x00 / 255.0, 0x20 / 255.0, 0x4C / 255.0),
        (0x42 / 255.0, 0x4D / 255.0, 0x6B / 255.0),
        (0x7D / 255.0, 0x7C / 255.0, 0x78 / 255.0),
        (0xBC / 255.0, 0xAE / 255.0, 0x6C / 255.0),
        (0xFE / 255.0, 0xE8 / 255.0, 0x38 / 255.0),
    ),
    "turbo": (
        (0x30 / 255.0, 0x12 / 255.0, 0x3B / 255.0),
        (0x46 / 255.0, 0x6B / 255.0, 0xE3 / 255.0),
        (0x28 / 255.0, 0xBB / 255.0, 0xEC / 255.0),
        (0x32 / 255.0, 0xF2 / 255.0, 0x98 / 255.0),
        (0xA4 / 255.0, 0xFC / 255.0, 0x3C / 255.0),
        (0xFA / 255.0, 0xBA / 255.0, 0x39 / 255.0),
        (0xE6 / 255.0, 0x5F / 255.0, 0x0D / 255.0),
        (0x7A / 255.0, 0x04 / 255.0, 0x03 / 255.0),
    ),
    "grayscale": (
        (0.0, 0.0, 0.0),
        (1.0, 1.0, 1.0),
    ),
    "rdbu": (
        (0x67 / 255.0, 0x00 / 255.0, 0x1F / 255.0),
        (0xB2 / 255.0, 0x18 / 255.0, 0x2B / 255.0),
        (0xD6 / 255.0, 0x60 / 255.0, 0x4D / 255.0),
        (0xF4 / 255.0, 0xA5 / 255.0, 0x82 / 255.0),
        (0xFD / 255.0, 0xDB / 255.0, 0xC7 / 255.0),
        (0xF7 / 255.0, 0xF7 / 255.0, 0xF7 / 255.0),
        (0xD1 / 255.0, 0xE5 / 255.0, 0xF0 / 255.0),
        (0x92 / 255.0, 0xC5 / 255.0, 0xDE / 255.0),
        (0x43 / 255.0, 0x93 / 255.0, 0xC3 / 255.0),
        (0x21 / 255.0, 0x66 / 255.0, 0xAC / 255.0),
        (0x05 / 255.0, 0x30 / 255.0, 0x61 / 255.0),
    ),
    "twilight": (
        (0.184, 0.079, 0.213),
        (0.384, 0.461, 0.731),
        (0.886, 0.85, 0.886),
        (0.698, 0.338, 0.322),
        (0.184, 0.079, 0.213),
    ),
}

_COLOR_MODE_ALIASES = {
    "hsl": "orientation",
    "hslsphere": "orientation",
    "hsl_sphere": "orientation",
    "hsl_direction": "orientation",
}


def normalize_palette_name(palette: str | None, fallback: str = "viridis") -> str:
    """Normalize a scalar palette identifier, falling back when unset or unknown."""
    if palette is None:
        return fallback
    normalized = palette.strip().lower().replace(" ", "_").replace("-", "_")
    if normalized in SCALAR_PALETTES:
        return normalized
    return fallback


def normalize_color_mode(color_mode: str | None, fallback: str = "orientation") -> str:
    """Normalize a vector/scalar color mode string."""
    if color_mode is None:
        return fallback
    normalized = color_mode.strip().lower().replace(" ", "_").replace("-", "_")
    normalized = _COLOR_MODE_ALIASES.get(normalized, normalized)
    if normalized in SUPPORTED_COLOR_MODES:
        return normalized
    return fallback


def srgb_to_linear(values: ArrayLike) -> NDArray[np.float64]:
    """Convert display sRGB values in ``[0, 1]`` to linear-sRGB."""
    arr = np.asarray(values, dtype=np.float64)
    clamped = np.clip(arr, 0.0, 1.0)
    safe_high = np.maximum(clamped, 0.04045)
    return np.where(
        clamped <= 0.04045,
        clamped / 12.92,
        np.power((safe_high + 0.055) / 1.055, 2.4),
    )


def linear_to_srgb(values: ArrayLike) -> NDArray[np.float64]:
    """Convert linear-sRGB values in ``[0, 1]`` to display sRGB."""
    arr = np.asarray(values, dtype=np.float64)
    clamped = np.clip(arr, 0.0, 1.0)
    safe_high = np.maximum(clamped, 0.0031308)
    return np.where(
        clamped <= 0.0031308,
        clamped * 12.92,
        1.055 * np.power(safe_high, 1.0 / 2.4) - 0.055,
    )


def direction_hsl_srgb(vectors: ArrayLike) -> NDArray[np.float64]:
    """Map 3D vectors to mumax3-style HSL colors in display sRGB ``[0, 1]``.

    ``hue = atan2(vy, vx)``, ``saturation = 1.0``, ``lightness = 0.5 * vz/|v| + 0.5``.
    Vectors with norm ``<= 1e-30`` or non-finite components map to ``[0.6, 0.6, 0.6]``.
    """
    arr = np.asarray(vectors, dtype=np.float64)
    if arr.shape == (3,):
        result = direction_hsl_srgb(arr[np.newaxis, :])[0]
        return result
    if arr.ndim < 1 or arr.shape[-1] != 3:
        raise ValueError(f"expected vector array with last dimension 3, got shape {arr.shape}")

    flat = arr.reshape(-1, 3)
    vx = flat[:, 0]
    vy = flat[:, 1]
    vz = flat[:, 2]

    magnitude = np.sqrt(vx * vx + vy * vy + vz * vz)
    valid = np.isfinite(magnitude) & (magnitude > DIRECTION_HSL_ZERO_NORM)
    safe_mag = np.where(valid, magnitude, 1.0)

    nz = np.where(valid, vz / safe_mag, 0.0)
    lightness = np.clip(0.5 * nz + 0.5, 0.0, 1.0)
    hue_rad = np.where(valid, np.arctan2(vy / safe_mag, vx / safe_mag), 0.0)

    h = np.mod((hue_rad * 180.0 / math.pi) / 60.0, 6.0)
    c = (1.0 - np.abs(2.0 * lightness - 1.0)) * DIRECTION_HSL_SATURATION
    x = c * (1.0 - np.abs(np.mod(h, 2.0) - 1.0))
    m = lightness - 0.5 * c

    r = np.empty_like(h)
    g = np.empty_like(h)
    b = np.empty_like(h)

    s0 = h < 1.0
    s1 = (~s0) & (h < 2.0)
    s2 = (~s0) & (~s1) & (h < 3.0)
    s3 = (~s0) & (~s1) & (~s2) & (h < 4.0)
    s4 = (~s0) & (~s1) & (~s2) & (~s3) & (h < 5.0)
    s5 = ~(s0 | s1 | s2 | s3 | s4)

    r[s0], g[s0], b[s0] = c[s0] + m[s0], x[s0] + m[s0], m[s0]
    r[s1], g[s1], b[s1] = x[s1] + m[s1], c[s1] + m[s1], m[s1]
    r[s2], g[s2], b[s2] = m[s2], c[s2] + m[s2], x[s2] + m[s2]
    r[s3], g[s3], b[s3] = m[s3], x[s3] + m[s3], c[s3] + m[s3]
    r[s4], g[s4], b[s4] = x[s4] + m[s4], m[s4], c[s4] + m[s4]
    r[s5], g[s5], b[s5] = c[s5] + m[s5], m[s5], x[s5] + m[s5]

    rgb = np.stack((r, g, b), axis=-1)
    if not np.all(valid):
        rgb[~valid] = DIRECTION_HSL_NEUTRAL_RGB
    return rgb.reshape(*arr.shape[:-1], 3)


def direction_hsl_linear(vectors: ArrayLike) -> NDArray[np.float64]:
    """Map 3D vectors to mumax3-style HSL colors in linear-sRGB."""
    return srgb_to_linear(direction_hsl_srgb(vectors))


def scalar_color_srgb(
    t: ArrayLike,
    palette: str | None = "viridis",
) -> NDArray[np.float64]:
    """Evaluate a scalar palette at normalized coordinates ``t`` in display sRGB."""
    palette_id = normalize_palette_name(palette)
    stops = np.asarray(SCALAR_PALETTES[palette_id], dtype=np.float64)
    arr = np.asarray(t, dtype=np.float64)
    scalar_input = arr.ndim == 0
    flat = np.atleast_1d(arr).ravel()

    finite = np.isfinite(flat)
    clamped = np.clip(np.where(finite, flat, 0.5), 0.0, 1.0)
    n_segments = stops.shape[0] - 1
    scaled = clamped * n_segments
    idx = np.minimum(np.floor(scaled).astype(np.int64), n_segments - 1)
    frac = (scaled - idx)[:, np.newaxis]
    rgb = stops[idx] + (stops[idx + 1] - stops[idx]) * frac

    if scalar_input:
        return rgb[0]
    return rgb.reshape(*arr.shape, 3)


def scalar_color_linear(
    t: ArrayLike,
    palette: str | None = "viridis",
) -> NDArray[np.float64]:
    """Evaluate a scalar palette at normalized coordinates ``t`` in linear-sRGB."""
    return srgb_to_linear(scalar_color_srgb(t, palette=palette))


def normalize_scalar_values(
    values: ArrayLike,
    scalar_range: tuple[float, float] | None = None,
) -> tuple[NDArray[np.float64], tuple[float, float]]:
    """Normalize scalar values into ``[0, 1]`` and return ``(normalized, (vmin, vmax))``."""
    arr = np.asarray(values, dtype=np.float64)
    finite_mask = np.isfinite(arr)
    if scalar_range is None:
        if np.any(finite_mask):
            vmin = float(np.min(arr[finite_mask]))
            vmax = float(np.max(arr[finite_mask]))
        else:
            vmin, vmax = 0.0, 1.0
    else:
        vmin = float(scalar_range[0])
        vmax = float(scalar_range[1])

    if not (math.isfinite(vmin) and math.isfinite(vmax)) or vmin >= vmax:
        normalized = np.full(arr.shape, 0.5, dtype=np.float64)
        return normalized, (vmin, vmax)

    span = vmax - vmin
    if math.isfinite(span) and span > 0.0:
        normalized = np.where(finite_mask, (arr - vmin) / span, 0.5)
    else:
        scale = max(abs(vmin), abs(vmax), 1.0)
        scaled_span = (vmax / scale) - (vmin / scale)
        normalized = np.where(
            finite_mask,
            ((arr / scale) - (vmin / scale)) / scaled_span,
            0.5,
        )
    return np.clip(normalized, 0.0, 1.0), (vmin, vmax)


def phasor_animation_sign(phasor_convention: str | None) -> int:
    """Return temporal phase animation sign matching ``phasorConventionAdapter.ts``."""
    if phasor_convention is None:
        return 1
    normalized = phasor_convention.strip().lower()
    if normalized in {"exp_i_omega_t", "exp_plus_i_omega_t", "not_applicable_real_reference"}:
        return 1
    if normalized == "exp_minus_i_omega_t":
        return -1
    raise ValueError(
        f"unsupported phasor_convention '{phasor_convention}'; expected "
        "'exp_i_omega_t', 'exp_plus_i_omega_t', or 'exp_minus_i_omega_t'"
    )


def floquet_spatial_sign(floquet_spatial_convention: str | None) -> int:
    """Return Floquet spatial phase sign matching ``phasorConventionAdapter.ts``."""
    if floquet_spatial_convention is None:
        return -1
    normalized = floquet_spatial_convention.strip().lower()
    if normalized == "dst_equals_src_exp_minus_i_k_dot_delta_r":
        return -1
    if normalized == "dst_equals_src_exp_plus_i_k_dot_delta_r":
        return 1
    raise ValueError(
        f"unsupported floquet_spatial_convention '{floquet_spatial_convention}'"
    )


def _wrap_phase(theta: NDArray[np.float64]) -> NDArray[np.float64]:
    two_pi = 2.0 * math.pi
    return np.mod(theta + math.pi, two_pi) - math.pi


def evaluate_complex_vector_field(
    real: ArrayLike,
    imag: ArrayLike,
    *,
    phase_rad: float = 0.0,
    representation: str = "phase_rotated_real",
    amplitude_scale: float = 1.0,
    wavevector_kf: Sequence[float] | None = None,
    positions_m: ArrayLike | None = None,
    cell_origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    phasor_convention: str | None = "exp_i_omega_t",
    floquet_spatial_convention: str | None = "dst_equals_src_exp_minus_i_k_dot_delta_r",
) -> NDArray[np.float64]:
    """Evaluate a complex spatial vector field at phase ``phase_rad`` and optional Floquet ``k_F``.

    Matches ``viewport3dScalarSurfaceShader.ts``:
    ``theta = temporal_sign * phase_rad + spatial_sign * dot(k_F, pos - origin)``
    and ``phase_rotated_real = amplitude_scale * (real * cos(theta) - imag * sin(theta))``.
    """
    re_arr = np.asarray(real, dtype=np.float64)
    im_arr = np.asarray(imag, dtype=np.float64)
    if re_arr.shape != im_arr.shape:
        raise ValueError(
            f"real and imag arrays must have identical shape, got {re_arr.shape} vs {im_arr.shape}"
        )
    if re_arr.ndim != 2 or re_arr.shape[1] != 3:
        raise ValueError(f"expected complex vector field shape (N, 3), got {re_arr.shape}")

    rep = representation.strip().lower()
    if rep == "amplitude":
        rep = "abs"
    if rep not in SUPPORTED_COMPLEX_REPRESENTATIONS:
        raise ValueError(
            f"unsupported complex representation '{representation}'; expected one of {SUPPORTED_COMPLEX_REPRESENTATIONS}"
        )

    amp = float(amplitude_scale)
    if rep == "real":
        return amp * re_arr
    if rep == "imag":
        return amp * im_arr
    if rep == "abs":
        return amp * np.sqrt(re_arr * re_arr + im_arr * im_arr)
    if rep == "phase":
        zero_mask = (np.abs(re_arr) < DIRECTION_HSL_ZERO_NORM) & (
            np.abs(im_arr) < DIRECTION_HSL_ZERO_NORM
        )
        return np.where(zero_mask, 0.0, np.arctan2(im_arr, re_arr))

    temporal_sign = phasor_animation_sign(phasor_convention)
    theta = np.full((re_arr.shape[0],), float(temporal_sign) * float(phase_rad), dtype=np.float64)
    if wavevector_kf is not None:
        kf = np.asarray(wavevector_kf, dtype=np.float64)
        if kf.shape != (3,) or not np.all(np.isfinite(kf)):
            raise ValueError("wavevector_kf must be a finite 3-vector in rad/m")
        if np.any(kf != 0.0):
            if positions_m is None:
                raise ValueError("positions_m is required when wavevector_kf is non-zero")
            pos = np.asarray(positions_m, dtype=np.float64)
            if pos.shape != re_arr.shape:
                raise ValueError(
                    f"positions_m shape {pos.shape} must match vector shape {re_arr.shape}"
                )
            origin = np.asarray(cell_origin_m, dtype=np.float64)
            if origin.shape != (3,):
                raise ValueError("cell_origin_m must be a 3-vector in meters")
            spatial_sign = floquet_spatial_sign(floquet_spatial_convention)
            theta = _wrap_phase(theta + float(spatial_sign) * ((pos - origin) @ kf))

    cos_t = np.cos(theta)[:, np.newaxis]
    sin_t = np.sin(theta)[:, np.newaxis]
    return amp * (re_arr * cos_t - im_arr * sin_t)


def extract_scalar_from_vectors(
    vectors: ArrayLike,
    *,
    color_mode: str,
    complex_phase_mode: bool = False,
    imag_vectors: ArrayLike | None = None,
) -> NDArray[np.float64]:
    """Extract scalar quantity (x, y, z, or magnitude) from a 3D vector field."""
    arr = np.asarray(vectors, dtype=np.float64)
    if arr.ndim == 1:
        if color_mode in {"x", "y", "z"}:
            raise ValueError(f"color_mode='{color_mode}' requires a 3-component vector field")
        return arr

    if arr.ndim != 2 or arr.shape[1] != 3:
        raise ValueError(f"expected shape (N,) or (N, 3), got {arr.shape}")

    if complex_phase_mode and imag_vectors is not None:
        im = np.asarray(imag_vectors, dtype=np.float64)
        if color_mode == "x":
            zero = (np.abs(arr[:, 0]) < DIRECTION_HSL_ZERO_NORM) & (
                np.abs(im[:, 0]) < DIRECTION_HSL_ZERO_NORM
            )
            return np.where(zero, 0.0, np.arctan2(im[:, 0], arr[:, 0]))
        if color_mode == "y":
            zero = (np.abs(arr[:, 1]) < DIRECTION_HSL_ZERO_NORM) & (
                np.abs(im[:, 1]) < DIRECTION_HSL_ZERO_NORM
            )
            return np.where(zero, 0.0, np.arctan2(im[:, 1], arr[:, 1]))
        if color_mode == "z":
            zero = (np.abs(arr[:, 2]) < DIRECTION_HSL_ZERO_NORM) & (
                np.abs(im[:, 2]) < DIRECTION_HSL_ZERO_NORM
            )
            return np.where(zero, 0.0, np.arctan2(im[:, 2], arr[:, 2]))
        dot_re_im = np.sum(arr * im, axis=1)
        sign_dot = np.where(dot_re_im > 0.0, 1.0, np.where(dot_re_im < 0.0, -1.0, 0.0))
        norm_re = np.linalg.norm(arr, axis=1)
        norm_im = np.linalg.norm(im, axis=1)
        zero = (norm_re < DIRECTION_HSL_ZERO_NORM) & (norm_im < DIRECTION_HSL_ZERO_NORM)
        return np.where(zero, 0.0, np.arctan2(sign_dot * norm_im, norm_re))

    if color_mode == "x":
        return arr[:, 0]
    if color_mode == "y":
        return arr[:, 1]
    if color_mode == "z":
        return arr[:, 2]
    return np.linalg.norm(arr, axis=1)


def evaluate_field_colors(
    values: ArrayLike,
    *,
    color_mode: str | None = None,
    color_palette: str | None = "viridis",
    scalar_range: tuple[float, float] | None = None,
    color_space: str = "linear",
    monochrome_rgb: tuple[float, float, float] = (0.8, 0.8, 0.8),
) -> tuple[NDArray[np.float64], tuple[float, float]]:
    """Evaluate RGB colors in ``linear`` or ``srgb`` for scalar or 3D vector arrays.

    Returns ``(rgb_array, (vmin, vmax))`` where ``rgb_array`` has shape ``(N, 3)``.
    """
    arr = np.asarray(values, dtype=np.float64)
    if arr.ndim == 1:
        default_mode = "scalar"
    elif arr.ndim == 2 and arr.shape[1] == 3:
        default_mode = "orientation"
    else:
        raise ValueError(f"expected scalar array (N,) or vector array (N, 3), got {arr.shape}")

    mode = normalize_color_mode(color_mode, fallback=default_mode)
    if arr.ndim == 1 and mode == "orientation":
        mode = "scalar"
    if arr.ndim == 1 and mode in {"x", "y", "z"}:
        raise ValueError(f"color_mode='{mode}' requires a 3-component vector field")

    cs = color_space.strip().lower()
    if cs not in {"linear", "srgb"}:
        raise ValueError(f"color_space must be 'linear' or 'srgb', got '{color_space}'")

    n_points = arr.shape[0]
    if mode == "monochrome":
        mono = np.asarray(monochrome_rgb, dtype=np.float64)
        if mono.shape != (3,):
            raise ValueError("monochrome_rgb must be a 3-tuple in sRGB [0, 1]")
        srgb = np.broadcast_to(mono, (n_points, 3)).copy()
        rgb = srgb_to_linear(srgb) if cs == "linear" else srgb
        return rgb, (0.0, 1.0)

    if mode == "orientation":
        srgb = direction_hsl_srgb(arr)
        rgb = srgb_to_linear(srgb) if cs == "linear" else srgb
        return rgb, (0.0, 1.0)

    scalars = extract_scalar_from_vectors(arr, color_mode=mode)
    normalized, resolved_range = normalize_scalar_values(scalars, scalar_range=scalar_range)
    palette = normalize_palette_name(color_palette)
    rgb = (
        scalar_color_linear(normalized, palette=palette)
        if cs == "linear"
        else scalar_color_srgb(normalized, palette=palette)
    )
    return rgb, resolved_range
