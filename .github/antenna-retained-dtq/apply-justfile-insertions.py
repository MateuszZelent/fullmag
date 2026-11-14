from pathlib import Path
import hashlib
import json
import sys


def apply_insertions(target, metadata_raw):
    target = Path(target)
    if target.is_symlink() or not target.is_file():
        raise ValueError("Target must be an existing regular file")
    metadata = json.loads(metadata_raw)
    if set(metadata) != {"schema", "before", "after", "insertions"} or metadata["schema"] != 1:
        raise ValueError("Unsupported insertion metadata")
    original = target.read_bytes()
    def matches(raw, expected):
        return expected == {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    if not matches(original, metadata["before"]):
        raise ValueError("Exact-before size/hash mismatch; target unchanged")
    chunks = []
    previous = 0
    last_offset = -1
    if not metadata["insertions"]:
        raise ValueError("Missing insertions")
    for insertion in metadata["insertions"]:
        if set(insertion) != {"offset_bytes", "text"}:
            raise ValueError("Unsupported insertion")
        offset = insertion["offset_bytes"]
        text = insertion["text"]
        if type(offset) is not int or not last_offset < offset <= len(original):
            raise ValueError("Invalid insertion offset")
        if not isinstance(text, str) or not text:
            raise ValueError("Empty insertion text")
        chunks.extend((original[previous:offset], text.encode("utf-8")))
        previous = offset
        last_offset = offset
    result = b"".join(chunks) + original[previous:]
    if not matches(result, metadata["after"]):
        raise ValueError("Exact-after size/hash mismatch; target unchanged")
    target.write_bytes(result)
    print("Applied exact byte insertions:", metadata["after"]["sha256"])


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: apply-justfile-insertions.py TARGET METADATA_JSON")
    apply_insertions(sys.argv[1], Path(sys.argv[2]).read_bytes())
