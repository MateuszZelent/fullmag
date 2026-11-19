"""Lossless Brown-noise configuration for builder/scene transport."""
from collections.abc import Mapping
import math


def canonical_thermal_noise(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) - {'temperature', 'seed'}:
        raise ValueError('thermal_noise must contain only temperature and optional seed')
    temperature = value.get('temperature')
    if (isinstance(temperature, bool) or not isinstance(temperature, (int, float))
            or not math.isfinite(temperature) or temperature <= 0):
        raise ValueError('thermal_noise.temperature must be finite and positive kelvin')
    result: dict[str, object] = {'temperature': float(temperature)}
    seed = value.get('seed')
    if seed is not None:
        # Decimal strings retain all u64 bits through browser JSON round-trips.
        if (not isinstance(seed, str) or not seed.isascii() or not seed.isdecimal()
                or seed.startswith('0') or len(seed) > 20 or int(seed) > 2**64 - 1):
            raise ValueError('thermal_noise.seed must be a canonical positive u64 decimal string')
        result['seed'] = seed
    return result
