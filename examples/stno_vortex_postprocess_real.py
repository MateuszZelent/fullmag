"""Compatibility entrypoint for the real STNO artifact postprocess."""

from __future__ import annotations

from stno_vortex_mtj_postprocess import main


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
