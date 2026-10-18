"""Print or execute the fixed, UI-visible post-audit validation matrix.

Execution requires an already matching managed runtime. This driver never
starts an implicit host build when the trusted build queue is unavailable.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[5]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def validation_matrix() -> list[dict]:
    cases = [{"name": "paired-free-ring", "kind": "paired", "radius_nm": 6.5,
              "ring_width_nm": 0.5, "ring_offset_nm": 0.0}]
    for radius in (1.5, 5.0, 6.5, 8.0, 10.0):
        cases.append({"name": f"long-R{radius:g}", "kind": "sweep",
                      "radius_nm": radius, "ring_width_nm": 0.5, "ring_offset_nm": 0.0})
    for radius in (5.0, 6.5, 8.0):
        for width, offset, label in ((0.75, 0.0, "wide"), (0.5, -0.125, "inner"),
                                     (0.5, 0.125, "outer")):
            cases.append({"name": f"{label}-R{radius:g}", "kind": "sweep",
                          "radius_nm": radius, "ring_width_nm": width,
                          "ring_offset_nm": offset})
    cases.append({"name": "profile-R1p5-10-step0p5", "kind": "profile",
                  "radius_nm": 1.5, "radius_stop_nm": 10.0,
                  "ring_width_nm": 0.5, "ring_offset_nm": 0.0})
    return cases


def command_for(case: dict, output_root: Path, web_port: int) -> list[str]:
    base = Path(__file__).parent
    command = [sys.executable, str(base / ("paired_validation.py" if case["kind"] == "paired"
                                         else "run_sweep.py")), "--run", "--device", "gpu",
               "--cell-nm", "0.5", "--wall-width-nm", "1.5", "--track-x-nm", "100",
               "--track-y-nm", "80", "--run-mode", "interactive", "--web-port", str(web_port),
               "--ring-width-nm", str(case["ring_width_nm"]), "--tol-t", "0.001",
               "--vorticity", "-1", "--background-sign", "1", "--helicity-rad", "0",
               "--relax-time-s", "2e-10", "--relax-max-steps", "20000",
               "--hold-time-s", "2e-12", "--field-every-steps", "1000",
               "--table-every-steps", "100", "--output-root", str(output_root / case["name"])]
    if case["kind"] == "paired":
        command += ["--seed-radius-nm", str(case["radius_nm"]), "--frozen-protocol", "ring"]
    else:
        command += ["--series", "dense", "--protocols", "ring", "--with-background",
                    "--radius-start-nm", str(case["radius_nm"]),
                    "--radius-stop-nm", str(case.get("radius_stop_nm", case["radius_nm"])), "--radius-step-nm", "0.5",
                    "--thresholds", str(base / "thresholds.working.v2.json")]
        if case["kind"] != "profile":
            # Diagnostic controls remain visible without suppressing their
            # failures in the receipts. Failed execution still stops the run.
            command += ["--allow-diagnostic"]
        if case["kind"] == "profile":
            command += ["--free-reference", str(output_root / "paired-free-ring" / "baseline-p0" / "analysis.json")]
    return command


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--web-port", type=int, default=3114)
    args = parser.parse_args()
    cases = validation_matrix()
    environment = dict(os.environ)
    environment.update(FULLMAG_BIMERON_D_J_PER_M2="0.004", FULLMAG_BIMERON_AEX_J_PER_M="1.5e-11",
                       FULLMAG_BIMERON_MSAT_A_PER_M="580000", FULLMAG_BIMERON_KU_J_PER_M3="800000",
                       FULLMAG_BIMERON_RELAX_ALGORITHM="llg_overdamped", FULLMAG_BIMERON_DT_S="1e-14",
                       FULLMAG_BIMERON_ALPHA="1", FULLMAG_BIMERON_RELEASE="0")
    if not args.run:
        print(json.dumps({"status": "planned_not_executed", "cases": cases,
                          "commands": [command_for(c, args.output_root, args.web_port) for c in cases]}, indent=2))
        return 0
    from tests.standard_problems.bimeron.goebel_2019.frozen_size.run_sweep import (
        _assert_within, _managed_runtime_matches_source, _resolve_layout,
    )
    layout = _resolve_layout(ROOT)
    _assert_within(args.output_root.resolve(), Path(layout["runs_root"]).resolve())
    if not _managed_runtime_matches_source(ROOT, layout, device="gpu", needs_control_room_toolchain=True):
        raise RuntimeError("Managed Windows FDM GPU runtime does not match source; obtain a verified build through the approved route first")
    for case in cases:
        case_environment = {**environment, "FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM": str(case["ring_offset_nm"])}
        subprocess.run(command_for(case, args.output_root, args.web_port), cwd=ROOT,
                       env=case_environment, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
