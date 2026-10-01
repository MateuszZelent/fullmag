"""Collect actual signed-k FEM pilots; never infer samples by reflection."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
from collect_de_bv_thickness_comparison import collect_record, read_json
from compare_de_bv_mode_profiles import sha256
from run_nonzero_k_validation_controller import validation_cases


def collect(control_path):
    control_path = Path(control_path).resolve()
    root = control_path.parent
    config = read_json(root / "controller-config.json")
    control = read_json(control_path)
    if config.get("series") != "signed-13":
        raise ValueError("expected pinned signed-13 series")
    for key, width in (("job_id", 32), ("source_digest", 64)):
        value = control.get(key)
        if (not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{%d}" % width, value) is None
                or value != config.get(key)):
            raise ValueError("controller identity mismatch")
    model_ref = config.get("model_ref")
    if not isinstance(model_ref, str) or re.fullmatch(r"[a-f0-9]{40}", model_ref) is None:
        raise ValueError("expected full model source commit")
    expected = validation_cases("signed-13")
    rows = control.get("results")
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise ValueError("signed-k controller is incomplete")
    points = []
    baseline = None
    for result, (name, pilot, layers) in zip(rows, expected):
        if (not isinstance(result, dict) or result.get("case") != name
                or type(result.get("wrapper_exit")) is not int or result["wrapper_exit"] != 0):
            raise ValueError("unsuccessful or reordered signed-k case")
        output = result.get("output")
        if not isinstance(output, str) or not Path(output).is_absolute() or Path(output).resolve() != root / name:
            raise ValueError("case output escapes pinned batch")
        request = read_json(Path(output) / "run-request.json")
        job = request.get("job")
        if (not isinstance(job, dict) or job.get("job_id") != control["job_id"]
                or job.get("source_digest") != control["source_digest"]):
            raise ValueError("case build source identity mismatch")
        if layers != "3":
            continue  # Separate thickness collector receives convergence-results.json.
        record = collect_record(output, 3, job, sampling=pilot.removeprefix("de-smoke-"))
        if record["model_source"].get("commit") != model_ref:
            raise ValueError("case model source mismatch")
        common = {"job": job, "model_source": record["model_source"],
                  "parameters": {k: v for k, v in record["parameters"].items() if k != "geometry"},
                  "mesh_level": record["mesh_level"],
                  "air_padding_each_side_m": record["air_padding_each_side_m"],
                  "magnetic_xy_sha256": record["magnetic_xy_sha256"]}
        if baseline is None:
            baseline = common
        elif common != baseline:
            raise ValueError("signed comparison changes controlled material, mesh or source")
        points.append(record)
    wanted = {0.0, *[sign * magnitude * 1e6 for magnitude in (2, 5, 10, 15, 20, 25) for sign in (-1, 1)]}
    for geometry in ("damon_eshbach", "backward_volume"):
        selected = [r for r in points if r["geometry"] == geometry]
        if len(selected) != 13 or {r["k_rad_per_m"] for r in selected} != wanted:
            raise ValueError("signed dispersion lacks actual samples")
    symmetry = []
    for geometry in ("damon_eshbach", "backward_volume"):
        by_k = {r["k_rad_per_m"]: r for r in points if r["geometry"] == geometry}
        for magnitude in (2, 5, 10, 15, 20, 25):
            positive, negative = by_k[magnitude * 1e6], by_k[-magnitude * 1e6]
            mean = (positive["frequency_hz"] + negative["frequency_hz"]) / 2
            symmetry.append({"geometry": geometry, "abs_k_rad_per_m": magnitude * 1e6,
                "f_positive_hz": positive["frequency_hz"], "f_negative_hz": negative["frequency_hz"],
                "signed_difference_hz": positive["frequency_hz"] - negative["frequency_hz"],
                "relative_difference_percent": 100 * (positive["frequency_hz"] - negative["frequency_hz"]) / mean})
    return {"schema": "fullmag.signed-de-bv-dispersion.v1", "qualification": "NOT VERIFIED",
            "scope": "actual signed-k samples; convergence and scientific qualification remain separate",
            "records": points, "symmetry_measurements": symmetry,
            "controller_sha256": sha256(control_path),
            "controller_config_sha256": sha256(root / "controller-config.json")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("control", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    report = collect(args.control)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
    print(json.dumps({"output": str(args.output), "actual_numerical_points": len(report["records"])}))


if __name__ == "__main__":
    main()
