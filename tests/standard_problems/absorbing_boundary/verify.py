"""Measure normal-incidence packet reflection from Fullmag stage artifacts."""
import argparse
import csv
import json
import math
from pathlib import Path
import re

import numpy as np

from prepare import DEVICES, ENGINES, PROFILES, RESOLUTIONS_NM, case_name, cases, packet


DT = 2.0**-45
PERIOD = 128 * DT
END = 65536 * DT
ENGINES_EXECUTED = {
    ("fdm", "cpu"): {"fdm_cpu_reference", "cpu_reference"},
    ("fdm", "gpu"): {"cuda_fdm", "fdm_cuda"},
    ("fem", "cpu"): {"fem_cpu_native", "native_fem_cpu"},
    ("fem", "gpu"): {"fem_native_gpu"},
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def measure(times, amplitude):
    """Peak transverse envelope at x=0 in disjoint arrival windows."""
    t = np.asarray(times, float)
    a = np.asarray(amplitude, float)
    require(t.ndim == 1 and t.shape == a.shape and t.size >= 500, "incomplete probe trace")
    require(np.isfinite(t).all() and np.isfinite(a).all() and (a >= 0).all(), "invalid probe trace")
    require(0 <= t[0] <= PERIOD + DT and abs(t[-1] - END) <= PERIOD + DT
            and (np.diff(t) > 0).all() and max(np.diff(t)) <= PERIOD + 2 * DT,
            "probe time coverage or cadence differs from the physical run")
    incident = (0.09e-9 <= t) & (t <= 0.45e-9)
    reflected = (0.78e-9 <= t) & (t <= 1.85e-9)
    peak = float(a[incident].max())
    require(4e-4 < peak < 1.2e-3, "incident packet amplitude outside small-signal envelope")
    incident_time = float(t[incident][np.argmax(a[incident])])
    require(0.15e-9 < incident_time < 0.34e-9, "incident pulse missing its predicted arrival")
    returned = float(a[reflected].max())
    return {"incident": peak, "incident_peak_s": incident_time, "reflected": returned,
            "reflected_peak_s": float(t[reflected][np.argmax(a[reflected])]),
            "amplitude_ratio": returned / peak}


def document(path):
    return json.loads(path.read_text(encoding="utf-8"))


def provenance(meta, engine, device):
    requested = meta["requested_execution"]
    require(requested == {"backend": engine, "device": device, "precision": "double",
                          "mode": "strict", "fallback_policy": "forbidden"}, "wrong requested lane")
    executed = meta["execution_provenance"]
    require(executed["execution_engine"] in ENGINES_EXECUTED[engine, device]
            and executed["precision"] == "double" and executed["lossy_fallback_used"] is False
            and executed["execution_resolution"]["fallback_occurred"] is False,
            "missing strict runtime execution evidence")
    if device == "gpu":
        receipt = executed[f"{engine}_gpu_execution_receipt"]
        require(receipt["executed"] == f"cuda_{engine}" and receipt["fallback_count"] == 0
                and receipt["required_operator_mask"] > 0
                and receipt["executed_device_operator_mask"] == receipt["required_operator_mask"]
                and receipt["executed_host_operator_mask"] == receipt["executed_unknown_operator_mask"] == 0,
                "missing device operator execution evidence")
        if engine == "fem":
            require(receipt["accounting_valid"] is True and receipt["resolved"] == "device_resident"
                    and receipt["accepted_step_count"] > 0 and receipt["device_ordinal"] >= 0,
                    "incomplete FEM device receipt")
        else:
            require(receipt["validation_state"] == "validated", "unvalidated FDM device receipt")
    identity = meta["build_identity"]
    require(meta["status"] == "completed", "incomplete solver stage")
    snapshot = identity["source_snapshot_sha256"]
    require(isinstance(snapshot, str) and re.fullmatch(r"[a-f0-9]{64}", snapshot),
            "unidentified runtime source snapshot")
    commit = identity["git_commit"]
    require(isinstance(commit, str) and re.fullmatch(r"[a-fA-F0-9]{40}", commit),
            "unidentified runtime commit")
    return {"engine": executed["execution_engine"], "commit": commit, "snapshot": snapshot,
            "source_hash": meta["source_hash"], "device": device}


def positions_and_material(plan, engine, h_nm, profile):
    require(plan["enable_exchange"] and not plan["enable_demag"], "wrong magnetic interactions")
    if engine == "fdm":
        nx = 1280 // h_nm
        require(plan["grid"]["cells"] == [nx, 1, 1], "wrong FDM geometry")
        x = plan["origin_m"][0] + (np.arange(nx) + 0.5) * plan["cell_size"][0]
    else:
        x = np.array(plan["mesh"]["nodes"])[:, 0]
        require(x.size == 4 * (1280 // h_nm + 1), "wrong FEM mesh")
    unique = np.unique(x)
    require(np.allclose(np.diff(unique), h_nm * 1e-9, rtol=1e-7, atol=1e-18)
            and np.isclose(x.min() + x.max(), 0., atol=1e-16), "misplaced or wrong-resolution sample coordinates")
    m0 = np.asarray(plan["initial_magnetization"], dtype=float)
    require(np.allclose(m0, [packet(v) for v in x], atol=1e-9, rtol=0),
            "initial state differs from the travelling packet")
    material = plan["material"]
    require(math.isclose(material["damping"], 0.001) and math.isclose(material["saturation_magnetisation"], 800e3)
            and math.isclose(material["exchange_stiffness"], 13e-12), "unexpected material")
    u = np.clip((160e-9 - (x.max() - x)) / 96e-9, 0., 1.)
    weights = {"off": np.zeros_like(u), "custom": u**3, "logarithmic": np.log1p(9*u)/math.log(10),
               "tanh": (1 + np.tanh(4*u - 2)/math.tanh(2))/2}[profile]
    raw_alpha = material.get("alpha_field")
    actual = np.full(x.shape, material["damping"]) if raw_alpha is None else np.asarray(raw_alpha)
    require(actual.shape == x.shape and np.allclose(actual, 0.001 + 0.6*weights, rtol=0, atol=1e-9),
            "resolved damping differs from the requested profile")
    # Average symmetrically about x=0 to place both discretizations' probe at the same position.
    return x, np.abs(x) <= np.min(np.abs(x)) + 1e-16


def snapshots(stage, metadata, count):
    folder = stage / "fields" / "m.zarr"
    if folder.is_dir():
        fmt = document(folder / ".zarray")
        attrs = document(folder / ".zattrs")
        require(attrs["storage_layout"] == "soa_component_major" and attrs["observable"] == "m"
                and attrs["component_order"] == ["x", "y", "z"]
                and fmt["shape"][1:] == [3, count] and fmt["chunks"] == [1, 3, count]
                and fmt["dtype"] == "<f8" and fmt["compressor"] is None and fmt["order"] == "C",
                "unsupported native m layout")
        require(attrs["provenance"]["source_hash"] == metadata["source_hash"], "foreign Zarr field")
        with (folder / "samples.csv").open(newline="", encoding="utf-8") as f:
            records = list(csv.DictReader(f))
        require(len(records) == fmt["shape"][0], "incomplete native field index")
        for index, row in enumerate(records):
            key = f"{index}.0.0"
            require(int(row["sample"]) == index and row["chunk_key"] == key, "out-of-order Zarr index")
            values = np.fromfile(folder / key, dtype="<f8").reshape(3, count).T
            yield float(row["time"]), values
    else:
        files = (stage / "fields" / "m").glob("step_*.json")
        for path in sorted(files, key=lambda p: int(p.stem.split("_")[-1])):
            record = document(path)
            require(record["observable"] == "m" and record["component_count"] == 3
                    and record["provenance"]["source_hash"] == metadata["source_hash"], "foreign m field")
            yield float(record["time"]), np.asarray(record["values"], float).reshape(count, 3)


def inspect_case(root, engine, device, h_nm, profile, artifact_directory=None):
    name = case_name(engine, device, h_nm, profile)
    bundle = root / name / f"{name}.zarr"
    matches = []
    require(bundle.is_dir(), f"{name}: missing adjacent result bundle {bundle}")
    paths = [artifact_directory / "metadata.json"] if artifact_directory is not None else bundle.rglob("metadata.json")
    for path in paths:
        if (path.parent / "fields").is_dir():
            meta = document(path)
            if meta.get("problem_name") == name and "execution_plan" in meta:
                matches.append((path.parent, meta))
    require(len(matches) == 1, f"{name}: expected one completed simulation stage in {bundle}")
    stage, meta = matches[0]
    evidence = provenance(meta, engine, device)
    require(isinstance(evidence["source_hash"], str) and evidence["source_hash"], "missing source hash")
    x, probe = positions_and_material(meta["execution_plan"]["backend_plan"], engine, h_nm, profile)
    times, envelope = [], []
    for t, vectors in snapshots(stage, meta, len(x)):
        require(np.isfinite(vectors).all() and np.max(np.abs(np.linalg.norm(vectors, axis=1)-1)) < 1e-4,
                "nonfinite or unnormalized trajectory")
        times.append(t)
        envelope.append(np.linalg.norm(vectors[probe, 1:].mean(axis=0)))
    return {**evidence, **measure(times, envelope)}


def compare(results, expected_commit):
    require(set(results) == set(cases()), "incomplete qualification matrix")
    require({r["commit"] for r in results.values()} == {expected_commit}, "wrong solver commit")
    require(len({r["snapshot"] for r in results.values()}) == 1, "mixed solver snapshots")
    for engine in ENGINES:
        for device in DEVICES:
            for h in RESOLUTIONS_NM:
                control = results[engine, device, h, "off"]
                require(0.25 <= control["amplitude_ratio"] <= 1.3 and
                        1.0e-9 < control["reflected_peak_s"] < 1.7e-9, "missing free-end reflection")
                for profile in PROFILES[1:]:
                    r = results[engine, device, h, profile]
                    require(abs(r["incident"]/control["incident"] - 1) <= 0.03, "unmatched incident pulse")
                    require(r["amplitude_ratio"] <= 0.25 * control["amplitude_ratio"],
                            f"{engine}/{device}/{h}nm/{profile}: insufficient reflection reduction")
            for profile in PROFILES:
                coarse = results[engine, device, 4, profile]["amplitude_ratio"]
                fine = results[engine, device, 2, profile]["amplitude_ratio"]
                require(abs(coarse - fine) <= 0.07, f"{engine}/{device}/{profile}: mesh sensitivity")
        for h in RESOLUTIONS_NM:
            for profile in PROFILES:
                cpu = results[engine, "cpu", h, profile]["amplitude_ratio"]
                gpu = results[engine, "gpu", h, profile]["amplitude_ratio"]
                require(abs(cpu-gpu) <= 0.02, f"{engine}/{h}nm/{profile}: CPU/GPU disagreement")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--commit", required=True, help="expected full solver Git commit")
    parser.add_argument("--artifact-index", type=Path,
                        help="JSON map from case name to exact managed stage artifact directory")
    args = parser.parse_args()
    paths = {}
    if args.artifact_index:
        index = document(args.artifact_index)
        require(set(index) == {case_name(*case) for case in cases()}, "incomplete artifact index")
        paths = {name: args.artifact_index.parent / value for name, value in index.items()}
    results = {case: inspect_case(args.directory, *case, artifact_directory=paths.get(case_name(*case)))
               for case in cases()}
    print(json.dumps({case_name(*c): r for c, r in results.items()}, indent=2))
    compare(results, args.commit)
    print("PASS: reflection, longitudinal refinement and within-solver CPU/GPU comparisons")
