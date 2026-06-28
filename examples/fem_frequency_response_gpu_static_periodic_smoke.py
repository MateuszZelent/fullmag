"""Small FEM GPU k=0 static-periodic frequency-response smoke."""

from pathlib import Path
import sys

import fullmag as fm

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fem_frequency_response_static_periodic_smoke import build as _build_static_periodic


def build() -> fm.Problem:
    return _build_static_periodic(device="gpu")


if __name__ == "__main__":
    fm.Simulation(build(), backend="fem").run()
else:
    problem = build()
