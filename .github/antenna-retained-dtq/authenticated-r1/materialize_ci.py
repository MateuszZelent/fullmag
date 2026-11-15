"""Prepare only the reviewed R1 CI composition; execute exclusively in CI."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
OUT = ROOT / "task4-authenticated-evidence"
DATA = ROOT / ".github/antenna-retained-dtq"
FIXTURE = DATA / "task-4-fixture"

def pin(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

def regular(name):
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Unsafe relative path: " + name)
    path = ROOT / relative
    if not path.resolve().is_relative_to(ROOT.resolve()) or any(
        part.is_symlink() for part in (path, *path.parents) if part != ROOT.parent
    ):
        raise ValueError("Symlink or escaped target: " + name)
    return path

def write(name, raw):
    path = regular(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)

def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_EVENT_NAME") != "pull_request":
        raise ValueError("Approved pull-request CI only")
    if os.environ.get("GITHUB_REPOSITORY") != "MateuszZelent/fullmag":
        raise ValueError("Repository differs")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    head = event["pull_request"]["head"]["sha"]
    if event["pull_request"]["number"] != 425 or len(head) != 40:
        raise ValueError("PR425 exact event head required")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if actual != head:
        raise ValueError("Checkout differs from event head")
    metadata_raw = (BASE / "ci-pins.json").read_bytes()
    metadata = json.loads(metadata_raw)
    # Check every input and every archive member before application writes.
    checked = {}
    for name, expected in metadata["inputs"].items():
        raw = regular(name).read_bytes()
        if pin(raw) != expected:
            raise ValueError("Input byte pin differs: " + name)
        checked[name] = raw
    staged = {}
    for name, spec in metadata["archives"].items():
        raw = checked[name]
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
            members = archive.getmembers()
            if len(members) != len(spec["entries"]) or len({m.name for m in members}) != len(members):
                raise ValueError("Archive inventory differs: " + name)
            files = {}
            total = 0
            for member in members:
                regular(member.name)
                if not member.isfile() or member.name not in spec["entries"] or member.size > 32 * 1024 * 1024:
                    raise ValueError("Unexpected archive member")
                data = archive.extractfile(member).read()
                total += len(data)
                if total > 32 * 1024 * 1024 or pin(data) != spec["entries"][member.name]:
                    raise ValueError("Archive member byte pin/bound differs: " + member.name)
                files[member.name] = data
            staged[name] = {n: files[n] for n in spec["selected"]}
    patch = gzip.decompress(checked[".github/antenna-completed-receipt/source.patch.gz"])
    if pin(patch) != metadata["source_patch"]:
        raise ValueError("Uncompressed source patch pin differs")
    OUT.mkdir(exist_ok=True)
    (OUT / "ci-pins.json").write_bytes(metadata_raw)
    (OUT / "source-pins.json").write_bytes(checked[".github/antenna-retained-dtq/task-4-fixture/task-4-fix3-source-pins.json"])
    subprocess.run(["git", "apply", "--check", "--whitespace=nowarn", "-"], cwd=ROOT, input=patch, check=True)
    subprocess.run(["git", "apply", "--whitespace=nowarn", "-"], cwd=ROOT, input=patch, check=True)
    for name in metadata["overlay_order"]:
        for target, raw in staged[name].items():
            write(target, raw)
    write("crates/fullmag-antenna-artifacts/src/retained_current/tests_v2.rs",
          checked[".github/antenna-retained-dtq/task-1-fix1-tests.rs"])
    helper = {"__name__": "ci_recipe_insertions"}
    exec(compile(checked[".github/antenna-retained-dtq/apply-justfile-insertions.py"],
                 "apply-justfile-insertions.py", "exec"), helper)
    for number in (2, 3):
        helper["apply_insertions"](ROOT / "justfile", checked[f".github/antenna-retained-dtq/task-{number}-justfile-insertions.json"])
    # This exact existing action registers the legacy module and insertion 4;
    # its production 22-pin guard runs before the two reviewed Task5 API deltas.
    subprocess.run([sys.executable, "-B", str(DATA / "apply-task4-source.py"),
                    "install-compile-contract-module"], cwd=ROOT, check=True)
    for target, raw in staged[".github/antenna-retained-dtq/task-5-green.tar.gz"].items():
        write(target, raw)
    helper["apply_insertions"](ROOT / "justfile", checked[".github/antenna-retained-dtq/task-5-justfile-insertions.json"])
    subprocess.run([sys.executable, "-B", str(DATA / "apply-task4-fixture-ci.py"), "install"], cwd=ROOT, check=True)
    inputs = json.loads(checked[".github/antenna-retained-dtq/task-4-fixture/task-4-fixture-ci-inputs.json"])
    normalized = {}
    registration = b"\n#[cfg(test)]\nmod task4_authenticated_acceptance;\n"
    for name, expected in inputs["production_after"].items():
        raw = regular(name).read_bytes()
        if name == "crates/fullmag-runtime-control/src/lib.rs":
            if pin(raw) != inputs["registered_library"] or not raw.endswith(registration):
                raise ValueError("Exact registered library differs")
            raw = raw[:-len(registration)]
        elif name == "crates/fullmag-runner/src/antenna_field_solution/closed_loop_execution.rs":
            if pin(raw) != inputs["cfg_before"] or raw.count(b'feature = "fem-gpu"') != 4:
                raise ValueError("Exact CPU cfg before differs")
            raw = raw.replace(b'feature = "fem-gpu"', b'feature = "fem-native"')
        if pin(raw)["sha256"] != expected:
            raise ValueError("Final normalized production pin differs: " + name)
        normalized[name] = expected
    if len(normalized) != 23 or pin(regular("crates/fullmag-runtime-control/src/task4_authenticated_acceptance.rs").read_bytes()) != inputs["legacy_module"]:
        raise ValueError("Exact23/legacy module before state differs")
    if regular("crates/fullmag-runtime-control/src/task4_source_fixture.rs").exists():
        raise ValueError("Unexpected existing setup module")
    if pin((ROOT / "justfile").read_bytes()) != metadata["justfile_after"]:
        raise ValueError("Final composed justfile pin differs")
    report = {"schema": "fullmag.task4.authenticated_ci_materialization.v1",
              "event_head": head, "source_helper_base": metadata["helper_head"],
              "status": "PASS: source composition only", "production_23_pins": normalized,
              "justfile": metadata["justfile_after"], "authenticated_acceptance": "NOT RUN",
              "production_gate": "PRODUCTION_DTQ_GATE_REMAINS_FAIL_FROM_RUN_43647488516"}
    (OUT / "materialization-receipt.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))

if __name__ == "__main__":
    main()
