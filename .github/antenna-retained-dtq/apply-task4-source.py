from pathlib import Path
import hashlib
import io
import json
import sys
import tarfile

root = Path(__file__).resolve().parents[2]
data_root = Path(__file__).resolve().parent
pins = json.loads((data_root / "task-4-source-pins.json").read_text())
wiring = json.loads((data_root / "task-4-wiring-pins.json").read_text())
action = sys.argv[1]

def checked_data(name):
    raw = (data_root / name).read_bytes()
    assert len(raw) == wiring[name]["bytes"], name
    assert hashlib.sha256(raw).hexdigest() == wiring[name]["sha256"], name
    return raw

def verify_sources():
    assert len(pins["source_pins"]) == 22
    for name, digest in pins["source_pins"].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name

if action == "task-4-green":
    packed = (data_root / pins["archive"]).read_bytes()
    assert len(packed) == pins["bytes"]
    assert hashlib.sha256(packed).hexdigest() == pins["sha256"]
    with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as archive:
        members = archive.getmembers()
        assert len(members) == len(pins["source_pins"])
        assert len({entry.name for entry in members}) == len(members)
        for entry in members:
            assert entry.isfile() and not entry.name.startswith("/")
            assert ".." not in Path(entry.name).parts and entry.name in pins["source_pins"]
            raw = archive.extractfile(entry).read()
            assert hashlib.sha256(raw).hexdigest() == pins["source_pins"][entry.name]
            path = root / entry.name
            assert not path.is_symlink(), entry.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    verify_sources()
    print("Task 4: exact 22 production source pins match")
elif action == "install-compile-contract-module":
    verify_sources()
    library = root / "crates/fullmag-runtime-control/src/lib.rs"
    module = library.parent / "task4_authenticated_acceptance.rs"
    assert not module.exists() and not module.is_symlink()
    registration = b"\n#[cfg(test)]\nmod task4_authenticated_acceptance;\n"
    original = library.read_bytes()
    assert b"mod task4_authenticated_acceptance;" not in original
    with module.open("xb") as destination:
        destination.write(checked_data("task-4-authenticated-acceptance.rs"))
    library.write_bytes(original + registration)
    for name, target in [
        ("run_retained_dtq_publication_contract.sh", "scripts/ci/run_retained_dtq_publication_contract.sh"),
    ]:
        path = root / target
        assert not path.is_symlink(), target
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(checked_data(name))
    helper = checked_data("apply-justfile-insertions.py")
    metadata = checked_data("task-4-justfile-insertions.json")
    namespace = {"__name__": "ci_recipe_insertions"}
    exec(compile(helper, "apply-justfile-insertions.py", "exec"), namespace)
    namespace["apply_insertions"](root / "justfile", metadata)
    print("Task 4: compile-only authenticated module registered; positive round-trip is NOT RUN")
else:
    raise SystemExit("Unknown Task 4 CI action")
