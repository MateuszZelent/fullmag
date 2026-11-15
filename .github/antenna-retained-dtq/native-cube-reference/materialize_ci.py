"""CI-only materialization. Never run this script in a developer worktree."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
OUT = ROOT / "native-cube-reference-evidence"
TEST = "backends/fem/tests/oersted_direct_tetra_contract.cpp"

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def check_bytes(data, expected, name):
    require(len(data) == expected["bytes"] and sha(data) == expected["sha256"], "byte pin mismatch: " + name)

def regular_target(name):
    path = ROOT / name
    require(not Path(name).is_absolute() and ".." not in Path(name).parts, "unsafe path")
    require(path.resolve().is_relative_to(ROOT.resolve()), "path outside checkout")
    require(not path.is_symlink() and all(not p.is_symlink() for p in path.parents if p != ROOT.parent),
        "symlink target refused: " + name)
    return path

def main():
    require(os.environ.get("GITHUB_ACTIONS") == "true", "CI only")
    require(os.environ.get("GITHUB_EVENT_NAME") == "pull_request", "pull_request only")
    require(os.environ.get("GITHUB_REPOSITORY") == "MateuszZelent/fullmag", "repository mismatch")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    require(event["pull_request"]["number"] == 425, "PR425 only")
    head = event["pull_request"]["head"]["sha"]
    require(os.environ.get("NATIVE_SURFACE_EXPECTED_HEAD") == head, "event head mismatch")
    actual_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    require(actual_head == head and len(head) == 40, "checkout is not exact event head")
    pins = json.loads((BASE / "source-pins.json").read_text())
    payload = json.loads((BASE / "payload-pins.json").read_text())
    for name, expected in payload.items():
        check_bytes((BASE / name).read_bytes(), expected, name)
    OUT.mkdir(exist_ok=True)
    (OUT / "preregistered-inputs.json").write_bytes((BASE / "inputs.json").read_bytes())
    packed_path = ROOT / ".github/antenna-completed-receipt/source.patch.gz"
    packed = packed_path.read_bytes()
    check_bytes(packed, pins["source_patch_gz"], str(packed_path))
    with gzip.GzipFile(fileobj=io.BytesIO(packed)) as stream:
        patch = stream.read(pins["source_patch"]["bytes"]+1)
    check_bytes(patch, pins["source_patch"], "source.patch")
    subprocess.run(["git", "apply", "--check", "--whitespace=nowarn", "-"],
        cwd=ROOT, input=patch, check=True)
    subprocess.run(["git", "apply", "--whitespace=nowarn", "-"],
        cwd=ROOT, input=patch, check=True)
    archive_path = ROOT / ".github/antenna-retained-dtq/task-2-native-green.tar.gz"
    packed = archive_path.read_bytes()
    check_bytes(packed, pins["native_green"], str(archive_path))
    expected_files = pins["native_green"]["files"]
    staged = {}
    with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as archive:
        members = []
        for entry in archive:
            require(len(members) < 12, "native archive member count exceeded")
            members.append(entry)
        require(len(members) == 12 and len({m.name for m in members}) == 12, "native archive member count")
        require({m.name for m in members} == set(expected_files), "native archive allowlist mismatch")
        for entry in members:
            require(entry.isfile(), "native archive nonregular member")
            target = regular_target(entry.name)
            require(entry.size == expected_files[entry.name]["bytes"], "native archive member size")
            data = archive.extractfile(entry).read(expected_files[entry.name]["bytes"]+1)
            check_bytes(data, expected_files[entry.name], entry.name)
            staged[target] = data
    # Validate every archive member before writing any of them. No other overlays.
    for target, data in staged.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    verified = {}
    for collection in ("archive_final_sources", "protected_final_sources"):
        for name, expected in pins[collection].items():
            data = regular_target(name).read_bytes()
            check_bytes(data, expected, name)
            verified[name] = {"bytes": len(data), "sha256": sha(data)}
    text = regular_target("justfile").read_text()
    marker = "verify-fem-oersted-oef1-cpu-contract:\n"
    require(text.count(marker) == 1, "unique selected just recipe required")
    block = marker
    for line in text.split(marker,1)[1].splitlines(keepends=True):
        if line.strip() and not line[0].isspace():
            break
        block += line
    require(block.rstrip("\n")+"\n" == pins["selected_recipe"], "selected recipe changed")
    verified["justfile"] = {"bytes": len(regular_target("justfile").read_bytes()),
        "sha256": sha(regular_target("justfile").read_bytes()), "scope": "actual historical baseline; selected recipe exact WT match"}
    for name in ("backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp",
            "backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"):
        require(b"stroud" not in regular_target(name).read_bytes().lower(), "Stroud source refused")
    harness = (BASE / "native_surface_reference.cpp").read_bytes()
    require(harness.count(b"result=evaluate_surface_rt0(") == 1, "single surface call site required")
    for token in (b"DirectTetraQuadrature", b"run_dtq_ci_", b"stroud", b"prepare_session"):
        require(token.lower() not in harness.lower(), "unexpected harness dependency")
    require(harness.count(b"current.ProjectCoefficient(coefficient)") == 1 and
        harness.count(b"Affine(current,e).frozen_input()") == 1, "real MFEM RT0 export required")
    before_harness = pins["native_green"]["files"][TEST]
    check_bytes(regular_target(TEST).read_bytes(), before_harness, "before harness source")
    regular_target(TEST).write_bytes(harness)
    check_bytes(regular_target(TEST).read_bytes(), payload["native_surface_reference.cpp"], "after harness source")
    header = "backends/fem/tests/native_surface_inputs.hpp"
    require(not regular_target(header).exists(), "unexpected existing generated header")
    regular_target(header).write_bytes((BASE / "native_surface_inputs.hpp").read_bytes())
    verified[TEST] = {"bytes": len(harness), "sha256": sha(harness)}
    verified[header] = {"bytes": len((BASE / "native_surface_inputs.hpp").read_bytes()),
        "sha256": sha((BASE / "native_surface_inputs.hpp").read_bytes())}
    report = {"schema": "private.native-cube-reference-materialization.v1", "status": "PASS: source pins",
        "event_head": head, "prior_helper_head": pins["prior_helper_head"],
        "applied_only": ["source.patch.gz", "task-2-native-green.tar.gz", "test-only harness + generated header"],
        "source_pins": verified, "before_harness": before_harness,
        "after_harness": payload["native_surface_reference.cpp"], "production_gate": "PRODUCTION_DTQ_GATE_REMAINS_FAIL_FROM_RUN_43647488516",
        "native_execution": "NOT RUN at materialization", "recipe": "just verify-fem-oersted-oef1-cpu-contract"}
    (OUT / "materialization.json").write_text(json.dumps(report, indent=2)+"\n")
    (OUT / "source-pins.json").write_bytes((BASE / "source-pins.json").read_bytes())
    (OUT / "payload-pins.json").write_bytes((BASE / "payload-pins.json").read_bytes())
    print(json.dumps(report))

if __name__ == "__main__":
    main()
