from pathlib import Path
import hashlib
import io
import json
import sys
import tarfile

root = Path(__file__).resolve().parents[2]
data_root = Path(__file__).resolve().parent
green = json.loads((data_root / "task-5-source-pins.json").read_text())
baseline = json.loads((data_root / "task-5-ui-baseline-pins.json").read_text())
wiring = json.loads((data_root / "task-5-wiring-pins.json").read_text())

def overlay(metadata, entries):
    packed = (data_root / metadata["archive"]).read_bytes()
    assert len(packed) == metadata["bytes"]
    assert hashlib.sha256(packed).hexdigest() == metadata["sha256"]
    with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as archive:
        members = archive.getmembers()
        assert len(members) == len(entries)
        assert len({entry.name for entry in members}) == len(members)
        for entry in members:
            assert entry.isfile() and not entry.name.startswith("/")
            assert ".." not in Path(entry.name).parts and entry.name in entries
            raw = archive.extractfile(entry).read()
            assert hashlib.sha256(raw).hexdigest() == entries[entry.name]["sha256"]
            path = root / entry.name
            assert not path.is_symlink(), entry.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)

def checked_data(name):
    raw = (data_root / name).read_bytes()
    assert len(raw) == wiring[name]["bytes"]
    assert hashlib.sha256(raw).hexdigest() == wiring[name]["sha256"]
    return raw

action = sys.argv[1]
if action == "ui-baseline":
    assert baseline["deletions"] == []
    entries = {row["path"]: row for row in baseline["entries"]}
    assert len(entries) == 78 and all(name.startswith("apps/control-room/") for name in entries)
    overlay(baseline, entries)
    print("Task 5 exact pre-change frontend dependency baseline: 78 pinned source files")
elif action == "task-5-green":
    assert len(green["files"]) == 7
    overlay(green, green["files"])
    for name, expected in green["files"].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected["sha256"]
    print("Task 5 exact reviewed GREEN: all 7 source pins match")
elif action == "install-wiring":
    for name, target in [
        ("run_retained_dtq_quantity_contract.sh", "scripts/ci/run_retained_dtq_quantity_contract.sh"),
    ]:
        path = root / target
        assert not path.is_symlink(), target
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(checked_data(name))
    helper = checked_data("apply-justfile-insertions.py")
    metadata = checked_data("task-5-justfile-insertions.json")
    namespace = {"__name__": "ci_recipe_insertions"}
    exec(compile(helper, "apply-justfile-insertions.py", "exec"), namespace)
    namespace["apply_insertions"](root / "justfile", metadata)
else:
    raise SystemExit("Unknown Task 5 CI action")
