"""Check that the public documentation build cannot ingest internal docs by accident."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_ROOT = ROOT / "public_docs" / "site"
WORKFLOW = ROOT / ".github" / "workflows" / "documentation.yml"


def main() -> int:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    expected_build = "public_docs/site public_docs/site/_build/html"
    if expected_build not in workflow:
        print(f"missing public-only build command: {expected_build}", file=sys.stderr)
        return 1
    if "docs/source" in workflow:
        print("workflow references the internal docs/source tree", file=sys.stderr)
        return 1

    for path in PUBLIC_ROOT.rglob("*.md"):
        text = path.read_text(encoding="utf-8")
        if "docs/" in text and "source_of_truth:" not in text:
            print(f"review internal source references in: {path}", file=sys.stderr)
            return 1

    print("public documentation boundary: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

