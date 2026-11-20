"""Verify the extracted release against its build identity and complete inventory."""
import argparse
import hashlib
import json
from pathlib import Path


def verify(root: Path, tag: str, commit: str, platform: str) -> None:
    manifest_path = root / "release-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if (manifest["tag"], manifest["git_sha"], manifest["source_identity"]["head_commit_full"],
            manifest["platform"]) != (tag, commit, commit, platform):
        raise ValueError("release manifest does not match the requested tag, build SHA or platform")
    expected = manifest["files_sha256"]
    files = {
        path.relative_to(root).as_posix(): path for path in root.rglob("*")
        if path.is_file() and path != manifest_path
    }
    if not expected or set(expected) != files.keys():
        raise ValueError(f"release file inventory differs: {sorted(set(expected) ^ files.keys())}")
    for name, path in files.items():
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(2**20), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected[name]:
            raise ValueError(f"SHA-256 mismatch: {name}")
    print(f"Verified {len(files)} files for {tag} ({platform}, {commit})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("tag")
    parser.add_argument("commit")
    parser.add_argument("platform")
    args = parser.parse_args()
    verify(args.root, args.tag, args.commit, args.platform)
