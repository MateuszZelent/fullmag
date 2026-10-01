"""Collect actual signed-k FEM pilots; never infer samples by reflection."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import re
from collect_de_bv_thickness_comparison import collect_record, collect_control, read_json
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
    if (len(root.parents) < 5 or root.name != control["job_id"] or root.parent.name != "nonzero-k-validation"
            or root.parents[1].name != "scientific-batches" or root.parents[3].name != "runs"):
        raise ValueError("controller report is outside its canonical batch")
    capsule = Path(config.get("capsule", "")).resolve()
    storage = root.parents[4]
    expected_prefix = "runs/" + root.parents[2].name + "/"
    try:
        relative = capsule.relative_to(storage).as_posix()
    except ValueError as error:
        raise ValueError("controller capsule escapes batch storage") from error
    if re.fullmatch(re.escape(expected_prefix) + r"[a-f0-9]{32}/source/tree", relative) is None:
        raise ValueError("controller capsule path is not canonical")
    controller_source = capsule / "scripts/run_nonzero_k_validation_controller.py"
    declared_controller_hash = config.get("controller_sha256")
    if (not isinstance(declared_controller_hash, str)
            or re.fullmatch(r"[a-f0-9]{64}", declared_controller_hash) is None
            or not controller_source.is_file() or controller_source.is_symlink()
            or sha256(controller_source) != declared_controller_hash):
        raise ValueError("controller source hash differs from pinned capsule")
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
        source = request.get("source")
        if (not isinstance(source, dict)
                or source.get("capsule_relative") != relative.removesuffix("/tree")):
            raise ValueError("case source capsule differs from pinned controller")
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
    indexed = {}
    for geometry in ("damon_eshbach", "backward_volume"):
        selected = [r for r in points if r["geometry"] == geometry]
        if len(selected) != 13:
            raise ValueError("signed dispersion lacks actual samples")
        by_k = {}
        for expected_k in wanted:
            matches = [r for r in selected if math.isclose(
                r["k_rad_per_m"], expected_k, rel_tol=1e-12, abs_tol=1e-12)]
            if len(matches) != 1:
                raise ValueError("signed dispersion lacks unique actual samples")
            by_k[expected_k] = matches[0]
        indexed[geometry] = by_k
    symmetry = []
    for geometry in ("damon_eshbach", "backward_volume"):
        by_k = indexed[geometry]
        for magnitude in (2, 5, 10, 15, 20, 25):
            positive, negative = by_k[magnitude * 1e6], by_k[-magnitude * 1e6]
            mean = (positive["frequency_hz"] + negative["frequency_hz"]) / 2
            symmetry.append({"geometry": geometry, "abs_k_rad_per_m": magnitude * 1e6,
                "actual_positive_k_rad_per_m": positive["k_rad_per_m"],
                "actual_negative_k_rad_per_m": negative["k_rad_per_m"],
                "f_positive_hz": positive["frequency_hz"], "f_negative_hz": negative["frequency_hz"],
                "signed_difference_hz": positive["frequency_hz"] - negative["frequency_hz"],
                "relative_difference_percent": 100 * (positive["frequency_hz"] - negative["frequency_hz"]) / mean})
    convergence = collect_control(root / "convergence-results.json")
    if convergence.get("controller_config_sha256") != sha256(root / "controller-config.json"):
        raise ValueError("convergence evidence differs from signed controller config")
    return {"schema": "fullmag.signed-de-bv-dispersion.v1", "qualification": "NOT VERIFIED",
            "scope": "actual signed-k samples; convergence and scientific qualification remain separate",
            "records": points, "symmetry_measurements": symmetry,
            "convergence_evidence": convergence,
            "controller_source_sha256": declared_controller_hash,
            "collector_source_sha256": sha256(Path(__file__)),
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
