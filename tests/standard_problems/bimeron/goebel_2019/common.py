from __future__ import annotations

import os


TRACK_SIZE = (500e-9, 40e-9, 0.5e-9)
MS = 0.58e6
AEX = 15e-12
D_ROTATED = 3e-3
KU_X = 0.8e6
ALPHA = 0.3
TEMPERATURE = 0.0
CELL = (1e-9, 1e-9, 0.5e-9)
BIMERON_RADIUS = 10e-9
BIMERON_WALL_WIDTH = 3e-9
LLG_HOLD_TIME = 1e-9

RELAX_MAX_STEPS = int(os.environ.get("FULLMAG_GOEBEL_RELAX_MAX_STEPS", "20000"))
HOLD_TIME = float(os.environ.get("FULLMAG_GOEBEL_HOLD_TIME", str(LLG_HOLD_TIME)))
HOLD_DT = float(os.environ.get("FULLMAG_GOEBEL_HOLD_DT", "1e-13"))
RELAX_FIELD_EVERY_STEPS = int(
    os.environ.get("FULLMAG_GOEBEL_RELAX_FIELD_EVERY_STEPS", "500")
)
HOLD_SAMPLE_PERIOD = float(
    os.environ.get("FULLMAG_GOEBEL_HOLD_SAMPLE_PERIOD", "1e-10")
)


def requested_device() -> str:
    device = os.environ.get("FULLMAG_GOEBEL_DEVICE", "gpu").strip().lower()
    if device not in {"cpu", "gpu"}:
        raise ValueError("FULLMAG_GOEBEL_DEVICE must be 'cpu' or 'gpu'")
    return device
