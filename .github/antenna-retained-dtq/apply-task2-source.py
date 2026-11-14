from pathlib import Path
import gzip
import hashlib
import io
import json
import sys
import tarfile

root = Path(__file__).resolve().parents[2]
data_root = Path(__file__).resolve().parent
pins = json.loads((data_root / "task-2-ci-source-pins.json").read_text())
if sys.argv[1:] == ["--verify"]:
    for name, expected in pins["task_pins"].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
    print("Task 2 GREEN: all 14 reviewed production source pins match")
else:
    assert len(sys.argv) == 2 and sys.argv[1] in pins["archives"]
    name = sys.argv[1]
    expected = pins["archives"][name]
    packed = (data_root / (name + ".tar.gz")).read_bytes()
    assert len(packed) == expected["bytes"]
    assert hashlib.sha256(packed).hexdigest() == expected["sha256"]
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(packed)), mode="r:") as archive:
        members = archive.getmembers()
        assert len(members) == len(expected["files"])
        assert len({member.name for member in members}) == len(members)
        for member in members:
            assert member.isfile() and not member.name.startswith("/")
            assert ".." not in Path(member.name).parts
            assert member.name in expected["files"]
            raw = archive.extractfile(member).read()
            assert hashlib.sha256(raw).hexdigest() == expected["files"][member.name]
            target = root / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    print("Applied exact Task 2 snapshot:", name, expected["sha256"])
