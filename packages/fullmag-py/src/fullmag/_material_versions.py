"""Scoped read-only access to a snapshot of published material versions."""
from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from fullmag.runtime.material_assets import _source, _version_key


class MaterialVersionLookupError(LookupError):
    """The bound catalog has no material with this dotted key."""

    def __init__(self, family: str, version: str) -> None:
        self.key = f"{family}.{version}"
        super().__init__(f"Published material version {self.key!r} was not found in the bound catalog")


@dataclass(frozen=True, slots=True, eq=False)
class PublishedMaterialVersion:
    """Read-only published material selected through ``fm.materials``."""

    family: str
    version: str
    display_name: str
    archived: bool
    _source: Mapping[str, Any]

    def _copy_source(self) -> dict[str, Any]:
        source = self._source
        return {
            **source,
            "properties": dict(source["properties"]),
            "references": [dict(reference) for reference in source["references"]],
            "version": dict(source["version"]),
        }


_catalog: ContextVar[Mapping[tuple[str, str], PublishedMaterialVersion]] = ContextVar(
    "fullmag_material_catalog", default=MappingProxyType({})
)


@contextmanager
def _bind_catalog(versions: Iterable[Mapping[str, object]]) -> Iterator[None]:
    snapshot: dict[tuple[str, str], PublishedMaterialVersion] = {}
    for entry in versions:
        if not isinstance(entry, Mapping):
            raise ValueError("published material version must be an object")
        source = _source(entry.get("source"), "published material source")
        if "version" not in source:
            raise ValueError("published material source requires a version key")
        identity = source["version"]
        key = (identity["family"], identity["version"])
        if key in snapshot:
            raise ValueError(f"duplicate published material version {key[0]}.{key[1]}")
        display_name = entry.get("display_name")
        archived = entry.get("archived")
        if not isinstance(display_name, str) or not display_name.strip() or len(display_name) > 240:
            raise ValueError(f"invalid published material display name for {key[0]}.{key[1]}")
        if not isinstance(archived, bool):
            raise ValueError(f"invalid published material archive state for {key[0]}.{key[1]}")
        source["version"] = MappingProxyType(identity)
        source["properties"] = MappingProxyType(source["properties"])
        source["references"] = tuple(MappingProxyType(reference) for reference in source["references"])
        snapshot[key] = PublishedMaterialVersion(*key, display_name, archived, MappingProxyType(source))
    token = _catalog.set(MappingProxyType(snapshot))
    try:
        yield
    finally:
        _catalog.reset(token)


@dataclass(frozen=True, slots=True)
class _MaterialFamily:
    _key: str

    def __getattr__(self, name: str) -> PublishedMaterialVersion:
        if name.startswith("_"):
            raise AttributeError(name)
        version = _version_key(name, "material version")
        try:
            return _catalog.get()[self._key, version]
        except KeyError:
            raise MaterialVersionLookupError(self._key, version) from None


class _MaterialCatalog:
    """Read-only namespace of published materials, keyed by family and version."""

    __slots__ = ()

    def __getattr__(self, name: str) -> _MaterialFamily:
        if name.startswith("_"):
            raise AttributeError(name)
        return _MaterialFamily(_version_key(name, "material family"))


materials = _MaterialCatalog()
