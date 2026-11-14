"""Ready antennas: functions that return ``(field, drive)`` pairs for ``antenna.add``.

They are ordinary user modules shipped with fullmag (design layer L1)::

    from fullmag.antennas import gaussian_k_source

    for field, drive in gaussian_k_source(amplitude=0.2 * mT, wavelength=279 * nm,
                                          frequency=3.6 * GHz, fwhm_y=240 * nm,
                                          center_x=-6000 * nm / 2.3, t0=2e-9):
        antenna.add(field, drive)

``style="function"`` (default) returns hand-written-style mask and time
functions. Their terms remember the call (``MaskTermIR.origin``: the function
and its arguments), so an exported script repeats the import and the call, and
the Control Room can change the arguments and rebuild the terms with
:func:`rebuild`. ``style="loop"`` fills ``study.new_vector_mask()`` in the loop
of the mumax3 script instead; such a term is stored as data, like any array mask.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass
from math import exp, log, pi, sin, sqrt
from typing import Callable, Mapping

from fullmag.model.mask_function import LibraryCall, MaskFunction, TimeFunction
from fullmag.model.mask_function import mask as _mask
from fullmag.model.mask_function import time as _time
from fullmag.model.vector_mask import VectorMask

_CALLS = itertools.count()


def gaussian_k_source_mask(x, y, z, amplitude, wavelength, sigma_x, fwhm_y, center_x, center_y):
    k = 2 * pi / wavelength
    sigma_y = fwhm_y / (2 * sqrt(2 * log(2)))
    g = exp(-(x - center_x) ** 2 / (2 * sigma_x ** 2)) * exp(-(y - center_y) ** 2 / (2 * sigma_y ** 2))
    return (amplitude * g * sin(k * x - pi / 2), 0.0, amplitude * g * sin(k * x))


def delayed_sine(t, frequency, t0):
    return sin(2 * pi * frequency * (t - t0))


def gaussian_k_source(
    study=None,
    *,
    amplitude: float,
    wavelength: float,
    frequency: float,
    fwhm_y: float,
    center_x: float,
    center_y: float = 0.0,
    sigma_x: float | None = None,
    t0: float = 0.0,
    n_layers: int | None = None,
    style: str = "function",
) -> tuple[tuple[MaskFunction | VectorMask, TimeFunction], ...]:
    """A spin-wave source with a chosen wave number (the mumax3 racetrack antenna).

    B(r, t) = amplitude g(x, y) (sin(k x - pi/2), 0, sin(k x)) sin(2 pi f (t - t0)),
    g = exp(-(x - center_x)^2 / (2 sigma_x^2)) exp(-(y - center_y)^2 / (2 sigma_y^2)),
    k = 2 pi / wavelength, sigma_y = fwhm_y / (2 sqrt(2 ln 2)), sigma_x = wavelength
    unless given; x, y are world coordinates (use ``frame="world"`` on the antenna).

    ``style="loop"`` fills ``study.new_vector_mask()`` on z-layers
    ``0..n_layers-1`` (all layers when ``n_layers`` is None). A function mask has
    no layers: limit it with the antenna's shape.
    """
    # The call as written: an omitted sigma_x follows the wavelength when rebuilt.
    arguments = {
        "amplitude": amplitude,
        "wavelength": wavelength,
        "frequency": frequency,
        "fwhm_y": fwhm_y,
        "center_x": center_x,
        "center_y": center_y,
        **({} if sigma_x is None else {"sigma_x": sigma_x}),
        "t0": t0,
    }
    if sigma_x is None:
        sigma_x = wavelength
    drive = _time(delayed_sine, frequency=frequency, t0=t0)
    if style == "function":
        if n_layers is not None:
            raise ValueError(
                "gaussian_k_source: n_layers applies to style='loop'; limit a function mask "
                "with the antenna's shape"
            )
        field = _mask(
            gaussian_k_source_mask,
            amplitude=amplitude,
            wavelength=wavelength,
            sigma_x=sigma_x,
            fwhm_y=fwhm_y,
            center_x=center_x,
            center_y=center_y,
        )
        call = LibraryCall(
            function=f"{__name__}.gaussian_k_source",
            arguments=tuple((name, float(value)) for name, value in arguments.items()),
            call_token=next(_CALLS),
            output_index=0,
        )
        return ((field.with_library_call(call), drive),)
    if style != "loop":
        raise ValueError(f"gaussian_k_source: style must be 'function' or 'loop', got {style!r}")
    if study is None or not hasattr(study, "new_vector_mask"):
        raise ValueError("gaussian_k_source: style='loop' needs the study: gaussian_k_source(study, ...)")
    field = study.new_vector_mask()
    k = 2 * pi / wavelength
    sigma_y = fwhm_y / (2.0 * sqrt(2.0 * log(2.0)))
    nx, ny, nz = field.size
    layers = nz if n_layers is None else min(int(n_layers), nz)
    # The loop of the mumax3 script (same operations, so the same float32 values).
    for i in range(nx):
        x = field.index2coord(i, 0, 0)[0]
        gaussx = exp(-((x - center_x) * (x - center_x)) / (2.0 * sigma_x * sigma_x))
        z_sin_kx = sin(k * x) * gaussx
        x_sin_kx = sin(k * x - pi / 2) * gaussx
        for j in range(ny):
            y = field.index2coord(0, j, 0)[1]
            ymask = exp(-((y - center_y) * (y - center_y)) / (2.0 * sigma_y * sigma_y))
            for layer in range(layers):
                field.set_vector(i, j, layer, (amplitude * ymask * x_sin_kx, 0.0, amplitude * ymask * z_sin_kx))
    return ((field, drive),)


@dataclass(frozen=True, slots=True)
class ReadyAntennaArgument:
    name: str
    unit: str
    doc: str
    default: float | None = None


@dataclass(frozen=True, slots=True)
class ReadyAntennaSpec:
    """A ready antenna for the Control Room: its function and numeric arguments."""

    name: str
    function: Callable[..., tuple]
    summary: str
    arguments: tuple[ReadyAntennaArgument, ...]


READY_ANTENNAS: dict[str, ReadyAntennaSpec] = {
    spec.name: spec
    for spec in (
        ReadyAntennaSpec(
            name=f"{__name__}.gaussian_k_source",
            function=gaussian_k_source,
            summary="Gaussian spin-wave source with a chosen wave number (mumax3 racetrack antenna)",
            arguments=(
                ReadyAntennaArgument("amplitude", "T", "peak field"),
                ReadyAntennaArgument("wavelength", "m", "carrier wavelength, k = 2 pi / wavelength"),
                ReadyAntennaArgument("frequency", "Hz", "drive frequency"),
                ReadyAntennaArgument("fwhm_y", "m", "full width at half maximum along y"),
                ReadyAntennaArgument("center_x", "m", "source centre along x (world)"),
                ReadyAntennaArgument("center_y", "m", "source centre along y (world)", 0.0),
                ReadyAntennaArgument("sigma_x", "m", "Gaussian width along x; default: wavelength"),
                ReadyAntennaArgument("t0", "s", "phase origin of sin(2 pi f (t - t0))", 0.0),
            ),
        ),
    )
}


def rebuild(function: str, arguments: Mapping[str, float]) -> tuple[tuple[MaskFunction, TimeFunction], ...]:
    """Call a ready antenna again from a term's ``origin`` (function name and arguments)."""
    spec = READY_ANTENNAS.get(function)
    if spec is None:
        raise ValueError(f"unknown ready antenna {function!r}; known: {sorted(READY_ANTENNAS)}")
    known = {argument.name for argument in spec.arguments}
    unknown = sorted(set(arguments) - known)
    if unknown:
        raise ValueError(f"{function}: unknown arguments {unknown}")
    return spec.function(**{name: float(value) for name, value in arguments.items()})


__all__ = [
    "READY_ANTENNAS",
    "ReadyAntennaArgument",
    "ReadyAntennaSpec",
    "delayed_sine",
    "gaussian_k_source",
    "gaussian_k_source_mask",
    "rebuild",
]
