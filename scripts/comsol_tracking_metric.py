"""Independent Tet4 modal algebra; no artifact or solver qualification.

Uses element bilinear forms rather than the producer's mass embedding.
All vectors are Cartesian nodal periodic envelopes on the full mesh.
"""
from __future__ import annotations

import numpy as np

from comsol_n0_projection import (
    _validate_mesh, _tet4_volume, _mass_inner_product, _as_real_array,
)


class Tet4TrackingMetric:
    """Consistent mass restricted to explicitly selected magnetic elements."""

    def __init__(self, nodes, cells, magnetic_element_indices):
        coordinates, connectivity, selected = _validate_mesh(
            nodes, cells, magnetic_element_indices
        )
        self.nodes = coordinates.copy()
        self.cells = connectivity[selected].copy()
        volumes = np.array([
            _tet4_volume(coordinates, connectivity[index], int(index))
            for index in selected
        ])
        self.volumes_m3 = volumes
        self.scaled_volumes = volumes / volumes.max()
        if np.any(self.scaled_volumes <= 0):
            raise ValueError("mass scaling underflow")
        self.support = np.unique(self.cells)

    def envelope(self, physical_field, k_vector_rad_per_m):
        field = np.asarray(physical_field, dtype=np.complex128)
        if any(isinstance(item, (bool, np.bool_))
               for item in np.asarray(k_vector_rad_per_m, dtype=object).flat):
            raise ValueError("k must not contain booleans")
        k = _as_real_array(k_vector_rad_per_m, name="k", ndim=1)
        if field.shape != self.nodes.shape or not np.all(np.isfinite(field)):
            raise ValueError("field must be finite Cartesian nodal XYZ")
        if k.shape != (3,) or not np.all(np.isfinite(k)):
            raise ValueError("k must be a finite three-vector in rad/m")
        with np.errstate(over="ignore", invalid="ignore"):
            phase = self.nodes @ k
        if not np.all(np.isfinite(phase)):
            raise ValueError("Bloch phase overflow")
        return field * np.exp(1j * phase)[:, None]

    def inner(self, left, right):
        return _mass_inner_product(left, right, self.cells, self.scaled_volumes)

    def normalized(self, vector):
        value = np.asarray(vector, dtype=np.complex128)
        if value.shape != self.nodes.shape or not np.all(np.isfinite(value)):
            raise ValueError("envelope must be finite Cartesian nodal XYZ")
        scale = np.max(np.abs(value[self.support]))
        if scale <= 0 or not np.isfinite(scale):
            raise ValueError("zero magnetic field")
        # Air has zero weight and must not overflow during magnetic scaling.
        supported = np.zeros_like(value)
        supported[self.support] = value[self.support] / scale
        value = supported
        norm = self.inner(value, value)
        if not np.isfinite(norm) or norm.real <= 0 or abs(norm.imag) > 1e-12 * norm.real:
            raise ValueError("invalid mass norm")
        return value / np.sqrt(norm.real)

    def overlap(self, left, right):
        """Amplitude overlap, not squared modal assurance criterion."""
        return float(np.clip(abs(self.inner(
            self.normalized(left), self.normalized(right)
        )), 0, 1))

    def basis(self, vectors):
        result = []
        for vector in vectors:
            candidate = self.normalized(vector)
            for _ in range(2):
                for previous in result:
                    candidate -= self.inner(previous, candidate) * previous
            norm = self.inner(candidate, candidate).real
            if not np.isfinite(norm) or norm <= 1e-20:
                raise ValueError("rank-deficient modal subspace")
            result.append(candidate / np.sqrt(norm))
        if not result:
            raise ValueError("empty modal subspace")
        return result

    def principal_cosines(self, previous, current):
        left, right = self.basis(previous), self.basis(current)
        if len(left) != len(right):
            raise ValueError("subspace ranks differ")
        cross = np.array([[self.inner(a, b) for b in right] for a in left])
        return np.sort(np.clip(np.linalg.svd(cross, compute_uv=False), 0, 1))
