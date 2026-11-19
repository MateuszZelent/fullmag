"""Typed source identity shared by project-owned imported-geometry adapters."""
from __future__ import annotations

from collections.abc import Mapping
import unicodedata


def imported_geometry_source_asset_fields(geometry: Mapping[str, object]) -> dict[str, object]:
    """Copy a validated reference; never infer identity from a source basename."""
    reference = geometry.get("source_asset")
    if reference is None:
        return {}
    if geometry.get("geometry_kind") != "ImportedGeometry":
        raise ValueError("source_asset requires ImportedGeometry")
    if not isinstance(reference, Mapping) or set(reference) != {
        "asset_id", "content_sha256", "archive_path",
    }:
        raise ValueError("source_asset must contain asset_id, content_sha256 and archive_path")
    asset_id = reference["asset_id"]
    digest = reference["content_sha256"]
    path = reference["archive_path"]
    if (
        not isinstance(asset_id, str) or not asset_id or asset_id.strip() != asset_id
        or len(asset_id.encode("utf-8")) > 256
        or any(c in "/\\" or unicodedata.category(c) == "Cc" for c in asset_id)
    ):
        raise ValueError("source_asset.asset_id must be a nonempty bounded identifier")
    if not isinstance(digest, str) or len(digest) != 64 or any(
        c not in "0123456789abcdef" for c in digest
    ):
        raise ValueError("source_asset.content_sha256 must be 64 lowercase hexadecimal digits")
    if (
        not isinstance(path, str) or not path.startswith("project/assets/")
        or any(c in "\\:" or unicodedata.category(c) == "Cc" for c in path)
        or any(part in ("", ".", "..") for part in path.split("/"))
    ):
        raise ValueError("source_asset.archive_path must be a normalized path under project/assets/")
    return {"source_asset": dict(reference)}
