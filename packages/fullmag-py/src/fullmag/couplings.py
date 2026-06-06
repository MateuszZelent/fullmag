from __future__ import annotations

from fullmag.model.couplings import CouplingEndpoint, CouplingRegistry


def object(name: str) -> CouplingEndpoint:
    return CouplingEndpoint.object(name)


def region(object_name: str, region_id: str) -> CouplingEndpoint:
    return CouplingEndpoint.region(object_name, region_id)


def surface(object_name: str, selector: str) -> CouplingEndpoint:
    return CouplingEndpoint.surface(object_name, selector)


def registry() -> CouplingRegistry:
    return CouplingRegistry()


__all__ = ["CouplingEndpoint", "CouplingRegistry", "object", "region", "surface", "registry"]
