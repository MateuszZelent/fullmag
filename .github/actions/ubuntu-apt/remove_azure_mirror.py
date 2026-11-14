#!/usr/bin/env python3
"""Remove only the runner's unavailable Azure apt mirror entry."""

from pathlib import Path
import sys


MIRROR_LIST_PATH = Path("/etc/apt/apt-mirrors.txt")
AZURE_MIRROR_LINE = b"http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
FALLBACK_MIRROR_LINES = {
    "archive": b"https://archive.ubuntu.com/ubuntu/\tpriority:2\n",
    "security": b"https://security.ubuntu.com/ubuntu/\tpriority:3\n",
}


def transform_mirror_list(contents: bytes) -> bytes:
    """Remove exact Azure mirror entries after validating both HTTPS fallbacks."""
    lines = contents.splitlines(keepends=True)
    missing = [name for name, line in FALLBACK_MIRROR_LINES.items() if line not in lines]
    if missing:
        raise ValueError(
            "missing required canonical HTTPS fallback declaration(s): "
            + ", ".join(missing)
        )
    return b"".join(line for line in lines if line != AZURE_MIRROR_LINE)


def main() -> int:
    try:
        original = MIRROR_LIST_PATH.read_bytes()
    except OSError as error:
        print(
            f"Cannot read required Ubuntu apt mirror list {MIRROR_LIST_PATH}: {error}",
            file=sys.stderr,
        )
        return 1

    try:
        updated = transform_mirror_list(original)
    except ValueError as error:
        print(
            f"Refusing to change {MIRROR_LIST_PATH}: {error}",
            file=sys.stderr,
        )
        return 1

    if updated != original:
        try:
            MIRROR_LIST_PATH.write_bytes(updated)
        except OSError as error:
            print(
                f"Cannot update Ubuntu apt mirror list {MIRROR_LIST_PATH}: {error}",
                file=sys.stderr,
            )
            return 1

    print(f"Verified canonical HTTPS apt fallbacks in {MIRROR_LIST_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
