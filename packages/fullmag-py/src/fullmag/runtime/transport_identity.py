"""Language-neutral identities for transport inputs and accepted artifacts."""
from __future__ import annotations

import hashlib
import math
import struct


def tagged_json_digest(value: object) -> str:
    """Hash the established E11 transport tagged-JSON v1 byte contract.

    Mesh ordinals and stable u64 identities use topology v3 or decimal strings
    in the preimage; JSON integer values must remain exactly representable.
    """
    digest = hashlib.sha256(b"fullmag:transport-tagged-json:v1")

    def encode(item: object) -> None:
        if item is None:
            digest.update(b"N")
        elif isinstance(item, bool):
            digest.update(b"T" if item else b"F")
        elif isinstance(item, (int, float)):
            if isinstance(item, int) and abs(item) > 2**53:
                raise ValueError("transport identity integer exceeds exact f64 range")
            number = float(item)
            if not math.isfinite(number):
                raise ValueError("transport identity requires finite numbers")
            digest.update(b"D" + struct.pack("<d", 0.0 if number == 0.0 else number))
        elif isinstance(item, str):
            encoded = item.encode("utf-8")
            digest.update(b"S" + struct.pack("<Q", len(encoded)) + encoded)
        elif isinstance(item, list):
            digest.update(b"A" + struct.pack("<Q", len(item)))
            for entry in item:
                encode(entry)
        elif isinstance(item, dict) and all(isinstance(key, str) for key in item):
            digest.update(b"O" + struct.pack("<Q", len(item)))
            for key in sorted(item):
                encode(key)
                encode(item[key])
        else:
            raise ValueError("unsupported transport identity value")

    encode(value)
    return "sha256:" + digest.hexdigest()
