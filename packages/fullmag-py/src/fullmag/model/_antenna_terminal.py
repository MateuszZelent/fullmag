from __future__ import annotations

import hashlib


_ANTENNA_TERMINAL_MARKER_BASE = 1_000
_ANTENNA_TERMINAL_MARKER_SPAN = 1_000_000_000
_ANTENNA_TERMINAL_MARKER_SCHEMA = b"fullmag.antenna-terminal-marker.v1\0"


def antenna_terminal_marker(
    object_id: str,
    conductor_part_id: str,
    selector: str,
) -> int:
    """Return the stable MeshIR marker for one authored antenna terminal.

    The marker is deliberately derived from semantic identity rather than
    Gmsh entity ordering.  Rust's surface selector resolver implements the
    same byte-level digest contract.
    """
    normalized_selector = selector.strip().lower()
    if normalized_selector not in {"local_u_min", "local_u_max"}:
        raise ValueError(
            "antenna terminal selector must be local_u_min or local_u_max"
        )
    payload = (
        _ANTENNA_TERMINAL_MARKER_SCHEMA
        + object_id.encode("utf-8")
        + b"\0"
        + conductor_part_id.encode("utf-8")
        + b"\0"
        + normalized_selector.encode("ascii")
    )
    digest = hashlib.sha256(payload).digest()
    value = int.from_bytes(digest[:4], byteorder="big", signed=False)
    return _ANTENNA_TERMINAL_MARKER_BASE + value % _ANTENNA_TERMINAL_MARKER_SPAN
