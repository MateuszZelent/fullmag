from pathlib import Path
import hashlib
import io
import json
import sys
import tarfile

root = Path(__file__).resolve().parents[2]
data_root = Path(__file__).resolve().parent
pins = json.loads((data_root / "task-3-source-pins.json").read_text())
wiring = json.loads((data_root / "task-3-wiring-pins.json").read_text())
action = sys.argv[1]

def checked_data(name):
    raw = (data_root / name).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == wiring[name]["sha256"], name
    assert len(raw) == wiring[name]["bytes"], name
    return raw

if action == "install-contract-tests":
    for name, target in [
        ("historical_v7_contract.rs", "crates/fullmag-application/tests/retained_dtq_historical_v7_contract.rs"),
        ("historical_worker_contract.rs", "crates/fullmag-ir/tests/retained_dtq_historical_worker_contract.rs"),
        ("run_retained_dtq_public_contract.sh", "scripts/ci/run_retained_dtq_public_contract.sh"),
    ]:
        path = root / target
        assert not path.is_symlink(), target
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(checked_data(name))
    helper = checked_data("apply-justfile-insertions.py")
    metadata = checked_data("task-3-justfile-insertions.json")
    namespace = {"__name__": "ci_recipe_insertions"}
    exec(compile(helper, "apply-justfile-insertions.py", "exec"), namespace)
    namespace["apply_insertions"](root / "justfile", metadata)
elif action == "append-real-backend-fixture":
    target = root / "crates/fullmag-application/src/script_pipeline_acceptance.rs"
    raw = target.read_bytes()
    expected = next(p for p in pins["archives"]["task-3-green.tar.gz"]["entries"] if p["path"] == target.relative_to(root).as_posix())
    assert hashlib.sha256(raw).hexdigest() == expected["sha256"]
    assert raw.rstrip().endswith(b"}")
    position = raw.rfind(b"}")
    assert raw[position + 1:].strip() == b""
    target.write_bytes(raw[:position] + checked_data("emit_real_backend_fixture.rs") + raw[position:])
    print("Task 3 CI-only fixture emitter appended to the existing test module")
elif action in pins["archives"]:
    expected = pins["archives"][action]
    packed = (data_root / action).read_bytes()
    assert hashlib.sha256(packed).hexdigest() == expected["sha256"]
    assert len(packed) == expected["bytes"]
    entries = {p["path"]: p for p in expected["entries"]}
    with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as archive:
        members = archive.getmembers()
        assert len(members) == len(entries)
        assert len({p.name for p in members}) == len(members)
        for member in members:
            assert member.isfile()
            assert not member.name.startswith("/") and ".." not in Path(member.name).parts
            assert member.name in entries
            raw = archive.extractfile(member).read()
            assert hashlib.sha256(raw).hexdigest() == entries[member.name]["sha256"], member.name
            path = root / member.name
            assert not path.is_symlink(), member.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    print("Applied exact Task 3 CI source snapshot:", action, expected["sha256"])
else:
    raise SystemExit("Unknown Task 3 CI action")
