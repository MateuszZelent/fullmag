from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_manifest(root: Path) -> dict[str, object]:
    value = json.loads((root / "documentation_manifest.json").read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("documentation manifest must be a JSON object")
    return value


def ordered_full_pack_documents(root: Path, manifest: dict[str, object]) -> list[Path]:
    entries = manifest.get("documents")
    if not isinstance(entries, list):
        raise ValueError("documentation manifest documents must be an array")
    selected: list[tuple[int, Path]] = []
    seen_orders: set[int] = set()
    full_pack = manifest.get("full_pack")
    if not isinstance(full_pack, str):
        raise ValueError("documentation manifest full_pack must be a string")
    full_pack_path = Path(full_pack)
    if full_pack_path.is_absolute() or ".." in full_pack_path.parts:
        raise ValueError(f"invalid full-pack output: {full_pack}")
    resolved_root = root.resolve()
    for raw in entries:
        if not isinstance(raw, dict):
            raise ValueError("documentation manifest entry must be an object")
        if raw.get("include_in_full_pack") is not True:
            continue
        if raw.get("role") == "historical":
            raise ValueError("historical documents cannot enter the full pack")
        order = raw.get("order")
        relative = raw.get("path")
        if not isinstance(order, int) or not isinstance(relative, str):
            raise ValueError("included document requires integer order and string path")
        relative_path = Path(relative)
        if order in seen_orders:
            raise ValueError(f"duplicate documentation order: {order}")
        if (
            relative_path == full_pack_path
            or not relative.endswith(".md")
            or relative.endswith(".json")
            or relative.endswith(".pdf")
            or (relative_path.parts and relative_path.parts[0] == "old")
            or relative_path.is_absolute()
            or ".." in relative_path.parts
        ):
            raise ValueError(f"invalid full-pack input: {relative}")
        path = (root / relative_path).resolve()
        if resolved_root not in path.parents:
            raise ValueError(f"full-pack input escapes documentation root: {relative}")
        if not path.is_file():
            raise ValueError(f"missing full-pack input: {relative}")
        seen_orders.add(order)
        selected.append((order, path))
    return [path for _, path in sorted(selected)]


def render_full_pack(root: Path, documents: list[Path]) -> str:
    chunks = ["# Frequency-driven solver - COMSOL-aligned V5.1 full pack\n"]
    resolved_root = root.resolve()
    for path in documents:
        relative = path.relative_to(resolved_root).as_posix()
        body = path.read_text(encoding="utf-8")
        separator = "" if body.endswith("\n") else "\n"
        chunks.append(f"<!-- BEGIN {relative} -->\n{body}{separator}<!-- END {relative} -->\n")
    return "\n".join(chunks)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("docs/plans/active/fd_sovler_masterplan"),
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    manifest = load_manifest(args.root)
    output_name = manifest.get("full_pack")
    if not isinstance(output_name, str):
        raise ValueError("documentation manifest full_pack must be a string")
    expected = render_full_pack(
        args.root,
        ordered_full_pack_documents(args.root, manifest),
    )
    output = (args.root / output_name).resolve()
    if args.root.resolve() not in output.parents:
        raise ValueError(f"full-pack output escapes documentation root: {output_name}")
    if args.check:
        if output.is_file() and output.read_text(encoding="utf-8") == expected:
            return 0
        print(f"full-pack drift: {output_name} differs from manifest inputs")
        return 1
    output.write_text(expected, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
