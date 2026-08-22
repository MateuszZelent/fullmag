#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import zlib

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD_ROOT = ROOT / ".docs-restructure"
EXPECTED_SHA256 = "d4982427336f5dae2c568b0e3bb6637e82dce1e744467fb808dfb8b65dd33f78"
EXPECTED_FILES = 67

encoded = "".join(
    path.read_text(encoding="utf-8").strip()
    for path in sorted(PAYLOAD_ROOT.glob("payload-*.b64"))
)
compressed = base64.b64decode(encoded, validate=True)
actual_sha256 = hashlib.sha256(compressed).hexdigest()
if actual_sha256 != EXPECTED_SHA256:
    raise SystemExit(
        f"documentation payload checksum mismatch: {actual_sha256} != {EXPECTED_SHA256}"
    )

mapping = json.loads(zlib.decompress(compressed).decode("utf-8"))
if not isinstance(mapping, dict) or len(mapping) != EXPECTED_FILES:
    raise SystemExit(
        f"documentation payload must contain {EXPECTED_FILES} files, got {len(mapping)}"
    )

for relative_path, content in sorted(mapping.items()):
    if not isinstance(relative_path, str) or not isinstance(content, str):
        raise SystemExit("documentation payload entries must map UTF-8 paths to text")
    target = (ROOT / relative_path).resolve()
    if not target.is_relative_to(ROOT.resolve()):
        raise SystemExit(f"unsafe payload path: {relative_path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

print(f"Applied structured documentation tree: {len(mapping)} files")
