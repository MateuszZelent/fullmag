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

# The ownership-oriented tree deliberately links the Backend landing page to
# canonical families outside its physical directory. Teach the common IA
# helper to emit a genuine relative path instead of requiring every child to
# be a lexical descendant of its parent directory.
architecture_path = ROOT / "scripts/public_docs_information_architecture.py"
architecture = architecture_path.read_text(encoding="utf-8")
if "import posixpath\n" not in architecture:
    architecture = architecture.replace(
        "import argparse\nimport sys\n",
        "import argparse\nimport posixpath\nimport sys\n",
        1,
    )
old_helper = '''def _relative_child(parent_path: str, child_path: str) -> str:
    parent = PurePosixPath(parent_path).parent
    return str(PurePosixPath(child_path).relative_to(parent).with_suffix(""))
'''
new_helper = '''def _relative_child(parent_path: str, child_path: str) -> str:
    parent = str(PurePosixPath(parent_path).parent)
    child = str(PurePosixPath(child_path).with_suffix(""))
    return posixpath.relpath(child, start=parent)
'''
if old_helper in architecture:
    architecture = architecture.replace(old_helper, new_helper, 1)
elif new_helper not in architecture:
    raise SystemExit("cannot patch cross-family documentation navigation helper")
architecture_path.write_text(architecture, encoding="utf-8")

# The historical manifest and the published Getting Started page had drifted
# only in navigation order. Preserve the published pedagogical sequence in the
# ownership-oriented overlay instead of rewriting that guide for an unrelated
# meshing reorganization.
v2_path = ROOT / "public_docs/site/_extensions/public_docs_information_architecture_v2.py"
v2 = v2_path.read_text(encoding="utf-8")
if "    'getting-started/index.md': PageSpec(" not in v2:
    marker = "    'python-api/index.md': PageSpec("
    replacement = (
        "    'getting-started/index.md': PageSpec(path='getting-started/index.md', "
        "title='Getting started', label='public-docs-getting-started-root', "
        "status='partial', doc_kind='reference', "
        "scope='the getting-started documentation family', "
        "children=('getting-started/installation.md', "
        "'getting-started/first-fdm-simulation.md', "
        "'getting-started/first-fem-simulation.md', "
        "'getting-started/choosing-a-solver.md', "
        "'getting-started/control-room.md'), navigation_maxdepth=1),\n"
    )
    if marker not in v2:
        raise SystemExit("cannot patch Getting Started navigation in IA overlay")
    v2 = v2.replace(marker, replacement + marker, 1)
v2_path.write_text(v2, encoding="utf-8")

print(f"Applied structured documentation tree: {len(mapping)} files")
