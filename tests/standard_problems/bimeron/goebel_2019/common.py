from __future__ import annotations

import os


TRACK_SIZE = (500e-9, 40e-9, 0.5e-9)
MS = 0.58e6
AEX = 15e-12
D_ROTATED = 3e-3
KU_X = 0.8e6
ALPHA = 0.3
TEMPERATURE = 0.0
CELL = (0.5e-9, 0.5e-9, 0.5e-9)
BIMERON_RADIUS = 10e-9
BIMERON_WALL_WIDTH = 3e-9
LLG_HOLD_TIME = 1e-10

RELAX_MAX_STEPS = int(os.environ.get("FULLMAG_GOEBEL_RELAX_MAX_STEPS", "8000"))
RELAX_TIME = float(os.environ.get("FULLMAG_GOEBEL_RELAX_TIME", "2e-11"))
HOLD_TIME = float(os.environ.get("FULLMAG_GOEBEL_HOLD_TIME", str(LLG_HOLD_TIME)))
LLG_DT = float(os.environ.get("FULLMAG_GOEBEL_DT", "2.5e-15"))
RELAX_FIELD_EVERY_STEPS = int(
    os.environ.get("FULLMAG_GOEBEL_RELAX_FIELD_EVERY_STEPS", "2000")
)
HOLD_SAMPLE_PERIOD = float(
    os.environ.get("FULLMAG_GOEBEL_HOLD_SAMPLE_PERIOD", "1e-11")
)


def _requested_device(default: str) -> str:
    device = os.environ.get("FULLMAG_GOEBEL_DEVICE", default).strip().lower()
    if device not in {"cpu", "gpu"}:
        raise ValueError("FULLMAG_GOEBEL_DEVICE must be 'cpu' or 'gpu'")
    return device


def requested_device() -> str:
    """Resolve the Goebel FDM device, retaining its GPU default."""
    return _requested_device("gpu")


def requested_fem_device() -> str:
    """Resolve the Goebel FEM device, rejecting unsupported mixed-DMI GPU."""
    device = _requested_device("cpu")
    if device == "gpu":
        raise ValueError(
            "FULLMAG_GOEBEL_DEVICE=gpu is unsupported for the Goebel 2019 FEM "
            "mixed-topology rotated-DMI scenario; refusing the request without "
            "a CPU fallback; use FULLMAG_GOEBEL_DEVICE=cpu"
        )
    return device
