"""Strict closed-shell topology for imported STL, without repairing its geometry.

All predicates use translated/scaled float64 coordinates. Distances within
256 machine eps of the combined bounds maximum extent are treated as contact or
uncertainty, never as a proven gap. Winding must be within 1e-7 of 0 or +/-1.
The BVH visits potentially intersecting triangle pairs (including within each
shell); it is not a sample-based intersection check. These floating-point
predicates are conservative engineering checks, not exact-arithmetic proofs.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import fsum
from typing import Sequence

import numpy as np

_EPS = 256 * np.finfo(np.float64).eps
_WINDING_EPS = 1e-7


@dataclass(frozen=True)
class ShellInput:
    owner: str
    surface_tags: tuple[int, ...]
    triangles: np.ndarray


@dataclass(frozen=True)
class ShellTopology:
    shells: tuple[ShellInput, ...]
    parent_indices: tuple[int | None, ...]
    depths: tuple[int, ...]
    signed_volumes: tuple[float, ...]


@dataclass
class _Node:
    lo: np.ndarray
    hi: np.ndarray
    indices: np.ndarray | None = None
    left: _Node | None = None
    right: _Node | None = None


def _tree(lo: np.ndarray, hi: np.ndarray, indices: np.ndarray) -> _Node:
    node = _Node(lo[indices].min(axis=0), hi[indices].max(axis=0))
    if len(indices) <= 12:
        node.indices = indices
    else:
        centers = lo[indices] + hi[indices]
        axis = int(np.argmax(np.ptp(centers, axis=0)))
        mid = len(indices) // 2
        order = np.argpartition(centers[:, axis], mid)
        node.left = _tree(lo, hi, indices[order[:mid]])
        node.right = _tree(lo, hi, indices[order[mid:]])
    return node


def _candidate_pairs(a: _Node, b: _Node, same: bool):
    """Bounded leaf products; never allocate the full triangle-pair matrix."""
    stack = [(a, b)]
    while stack:
        x, y = stack.pop()
        if np.any(x.hi + _EPS < y.lo) or np.any(y.hi + _EPS < x.lo):
            continue
        if x.indices is not None and y.indices is not None:
            ia = np.repeat(x.indices, len(y.indices))
            ib = np.tile(y.indices, len(x.indices))
            if same and x is y:
                keep = ia < ib
                ia, ib = ia[keep], ib[keep]
            if len(ia):
                yield ia, ib
        elif same and x is y:
            stack.extend([(x.left, x.left), (x.left, x.right), (x.right, x.right)])
        elif y.indices is not None or (x.indices is None and np.max(x.hi-x.lo) >= np.max(y.hi-y.lo)):
            stack.extend([(x.left, y), (x.right, y)])
        else:
            stack.extend([(x, y.left), (x, y.right)])


def _intersects(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Triangle SAT, including in-plane axes for parallel/coplanar faces."""
    ea = np.roll(a, -1, axis=1) - a
    eb = np.roll(b, -1, axis=1) - b
    na = np.cross(ea[:, 0], ea[:, 1])
    nb = np.cross(eb[:, 0], eb[:, 1])
    axes = np.concatenate((na[:, None], nb[:, None],
        np.cross(ea[:, :, None], eb[:, None, :]).reshape(-1, 9, 3),
        np.cross(na[:, None], ea), np.cross(nb[:, None], eb)), axis=1)
    lengths = np.linalg.norm(axes, axis=2)
    axes = axes / np.where(lengths > 0, lengths, 1)[:, :, None]
    # Translation improves accuracy for small faces far from the global origin.
    origin = a[:, :1]
    pa = np.einsum('nvi,nki->nkv', a-origin, axes)
    pb = np.einsum('nvi,nki->nkv', b-origin, axes)
    separated = (pa.max(axis=2) + _EPS < pb.min(axis=2)) | (pb.max(axis=2) + _EPS < pa.min(axis=2))
    return ~np.any(separated & (lengths > 0), axis=1)


def _check_intersections(ta, tb, va, vb, tree_a, tree_b, same):
    pending_a, pending_b, count = [], [], 0

    def check(ia, ib):
        a, b = ta[ia], tb[ib]
        overlap = np.all(a.max(axis=1)+_EPS >= b.min(axis=1), axis=1) & np.all(b.max(axis=1)+_EPS >= a.min(axis=1), axis=1)
        ia, ib, a, b = ia[overlap], ib[overlap], a[overlap], b[overlap]
        if not len(ia):
            return
        hit = _intersects(a, b)
        if not same and np.any(hit):
            raise ValueError('STL shells intersect, touch, or have numerically ambiguous separation')
        if not same:
            return
        ia, ib, a, b = ia[hit], ib[hit], a[hit], b[hit]
        if not len(ia):
            return
        shared = va[ia,:,None] == vb[ib,None,:]
        common_count = shared.sum(axis=(1,2))
        if np.any((common_count == 0) | (common_count == 3)):
            raise ValueError('STL shell self-intersection or duplicate face')
        normals_a = np.cross(a[:,1]-a[:,0], a[:,2]-a[:,0])
        normals_b = np.cross(b[:,1]-b[:,0], b[:,2]-b[:,0])
        normals_a /= np.linalg.norm(normals_a,axis=1)[:,None]
        normals_b /= np.linalg.norm(normals_b,axis=1)[:,None]
        direction = np.cross(normals_a,normals_b)
        coplanar = np.linalg.norm(direction,axis=1) <= _EPS
        # Nonparallel faces with a shared edge meet only along that edge.
        legal = (common_count == 2) & ~coplanar
        planar_edges = np.flatnonzero((common_count == 2) & coplanar)
        if len(planar_edges):
            mask_a = shared[planar_edges].any(axis=2)
            mask_b = shared[planar_edges].any(axis=1)
            common = a[planar_edges][mask_a].reshape(-1,2,3)
            other_a = a[planar_edges][~mask_a]
            other_b = b[planar_edges][~mask_b]
            edge = common[:,1]-common[:,0]
            edge /= np.linalg.norm(edge,axis=1)[:,None]
            normal = normals_a[planar_edges]
            side_a = np.einsum('ni,ni->n',np.cross(edge,other_a-common[:,0]),normal)
            side_b = np.einsum('ni,ni->n',np.cross(edge,other_b-common[:,0]),normal)
            legal[planar_edges] = (side_a*side_b < 0) & (abs(side_a)>_EPS) & (abs(side_b)>_EPS)
        singles = np.flatnonzero(common_count == 1)
        if len(singles):
            sa, sb = shared[singles].any(axis=2), shared[singles].any(axis=1)
            origin = a[singles][sa]
            aa = (a[singles][~sa].reshape(-1,2,3)-origin[:,None])
            bb = (b[singles][~sb].reshape(-1,2,3)-origin[:,None])
            nn_a, nn_b = normals_a[singles], normals_b[singles]
            dd = direction[singles]
            dd /= np.where(np.linalg.norm(dd,axis=1)>0,np.linalg.norm(dd,axis=1),1)[:,None]
            da = np.einsum('nvi,ni->nv',aa,nn_b)
            db = np.einsum('nvi,ni->nv',bb,nn_a)
            intervals = []
            for points, distances in ((aa,da),(bb,db)):
                projected = np.einsum('nvi,ni->nv',points,dd)
                low = np.minimum(0,np.where(abs(distances)<=_EPS,projected,0).min(axis=1))
                high = np.maximum(0,np.where(abs(distances)<=_EPS,projected,0).max(axis=1))
                crossing = distances[:,0]*distances[:,1] < 0
                if np.any(crossing):
                    d = distances[crossing]
                    values = projected[crossing,0] + (projected[crossing,1]-projected[crossing,0])*d[:,0]/(d[:,0]-d[:,1])
                    low[crossing] = np.minimum(low[crossing],values)
                    high[crossing] = np.maximum(high[crossing],values)
                intervals.append((low,high))
            low = np.maximum(intervals[0][0],intervals[1][0])
            high = np.minimum(intervals[0][1],intervals[1][1])
            allowed = (low >= 0) & (high <= 0)
            # A coplanar extra contact exists exactly when a noncommon ray
            # lies in the other triangle's closed angular sector. Testing all
            # four rays also handles opposite collinear rays, whose intersection
            # is only the legal common vertex. Near-boundary angles fail closed.
            planar = coplanar[singles]
            sector_overlap = np.zeros(len(singles),dtype=bool)
            for own, other, normal in ((aa,bb,nn_a),(bb,aa,nn_b)):
                own = own/np.linalg.norm(own,axis=2)[:,:,None]
                other = other/np.linalg.norm(other,axis=2)[:,:,None]
                sense = np.sign(np.einsum('ni,ni->n',np.cross(own[:,0],own[:,1]),normal))
                left = np.einsum('nvi,ni->nv',np.cross(own[:,0,None],other),normal)*sense[:,None]
                right = np.einsum('nvi,ni->nv',np.cross(other,own[:,1,None]),normal)*sense[:,None]
                sector_overlap |= np.any((left>=-_EPS) & (right>=-_EPS),axis=1)
            allowed[planar] = ~sector_overlap[planar]
            legal[singles] = allowed
        if not np.all(legal):
            raise ValueError('STL shell self-intersection beyond a shared edge/vertex')

    for ia, ib in _candidate_pairs(tree_a, tree_b, same):
        pending_a.append(ia)
        pending_b.append(ib)
        count += len(ia)
        if count >= 8192:
            check(np.concatenate(pending_a), np.concatenate(pending_b))
            pending_a, pending_b, count = [], [], 0
    if count:
        check(np.concatenate(pending_a), np.concatenate(pending_b))


def _validate(triangles: np.ndarray):
    vertices, inverse = np.unique(triangles.reshape(-1, 3), axis=0, return_inverse=True)
    faces = inverse.reshape(-1, 3)
    edges = np.stack((faces, np.roll(faces, -1, axis=1)), axis=2).reshape(-1, 2)
    unordered = np.sort(edges, axis=1)
    _, edge_ids, counts = np.unique(unordered, axis=0, return_inverse=True, return_counts=True)
    if np.any(counts != 2):
        raise ValueError('STL shell is open or nonmanifold: every edge must have two faces')
    signs = np.where(edges[:, 0] < edges[:, 1], 1, -1)
    if np.any(np.bincount(edge_ids, weights=signs) != 0):
        raise ValueError('STL shell has inconsistent face winding')
    # In a closed edge-manifold mesh, each vertex link must be one cycle.
    # Union incident face corners through their edge neighbours; a pinched
    # vertex has several components despite each edge having two faces.
    order = np.argsort(edge_ids)
    pairs = (order.reshape(-1, 2)//3)
    parent = np.arange(len(faces))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for x, y in pairs:
        rx, ry = find(x), find(y)
        parent[rx] = ry
    if len({find(i) for i in range(len(faces))}) != 1:
        raise ValueError('A ShellInput must contain one edge-connected shell')
    # Euler counts alone do not detect vertex pinches. Check each link using
    # corner-neighbour walks, linear in the number of corners.
    adjacency = np.empty((len(faces), 3), dtype=np.int64)
    adjacency.reshape(-1)[order[0::2]] = order[1::2]//3
    adjacency.reshape(-1)[order[1::2]] = order[0::2]//3
    corner_order = np.argsort(faces.reshape(-1))
    starts = np.r_[0, np.cumsum(np.bincount(faces.reshape(-1), minlength=len(vertices)))]
    for vertex in range(len(vertices)):
        incident = corner_order[starts[vertex]:starts[vertex+1]]
        first = int(incident[0]//3)
        current, previous, visited = first, -1, 0
        while True:
            local = int(np.flatnonzero(faces[current] == vertex)[0])
            left, right = int(adjacency[current, local]), int(adjacency[current, (local-1)%3])
            following = right if left == previous else left
            previous, current = current, following
            visited += 1
            if current == first:
                break
            if visited > len(incident):
                raise ValueError('STL shell has a nonmanifold vertex link')
        if visited != len(incident):
            raise ValueError('STL shell has disconnected nonmanifold vertex fans')
    return faces


def _winding(point, triangles):
    # One bounded chunk at a time, with compensated final summation.
    sums = []
    for start in range(0, len(triangles), 16384):
        vectors = triangles[start:start+16384] - point
        lengths = np.linalg.norm(vectors, axis=2)
        if np.any(lengths <= _EPS):
            raise ValueError('Ambiguous winding query on shell surface')
        a, b, c = (vectors[:, k]/lengths[:, k, None] for k in range(3))
        numerator = np.einsum('ni,ni->n', a, np.cross(b, c))
        denominator = 1 + np.einsum('ni,ni->n', a,b) + np.einsum('ni,ni->n', b,c) + np.einsum('ni,ni->n', c,a)
        sums.append(float(np.sum(2*np.arctan2(numerator, denominator))))
    value = abs(fsum(sums)/(4*np.pi))
    if value <= _WINDING_EPS:
        return False
    if abs(value-1) <= _WINDING_EPS:
        return True
    raise ValueError(f'Ambiguous STL shell winding number: {value}')


def classify_closed_shells(shells: Sequence[ShellInput]) -> ShellTopology:
    """Validate disjoint closed boundaries and return strict containment depth.

    Original objects, owner identities, surface tags, order, and signed winding
    are preserved. Coordinates must be exactly welded at STL shared vertices;
    no tolerance welding, orientation reversal, or topology repair is performed.
    """
    shells = tuple(shells)
    if not shells:
        return ShellTopology((), (), (), ())
    raw = []
    for shell in shells:
        t = np.asarray(shell.triangles, dtype=np.float64)
        if t.ndim != 3 or t.shape[1:] != (3,3) or not len(t) or not np.all(np.isfinite(t)):
            raise ValueError('STL shell triangles must be a finite nonempty (N,3,3) array')
        raw.append(t)
    lower = np.min([t.min(axis=(0,1)) for t in raw], axis=0)
    upper = np.max([t.max(axis=(0,1)) for t in raw], axis=0)
    scale = float(np.max(upper-lower))
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError('STL shell coordinate extent is zero or unrepresentable')
    normalized = [(t-lower)/scale for t in raw]
    faces, trees, volumes, bounds = [], [], [], []
    for t in normalized:
        e1, e2 = t[:,1]-t[:,0], t[:,2]-t[:,0]
        area = np.linalg.norm(np.cross(e1,e2), axis=1)
        if np.any(area <= _EPS*np.linalg.norm(e1,axis=1)*np.linalg.norm(e2,axis=1)) or np.any(np.linalg.norm(e1,axis=1) <= _EPS) or np.any(np.linalg.norm(e2,axis=1) <= _EPS):
            raise ValueError('STL shell has degenerate or numerically unresolved triangles')
        faces.append(_validate(t))
        origin = t[0,0]
        shifted = t-origin
        terms = np.einsum('ni,ni->n', shifted[:,0], np.cross(shifted[:,1],shifted[:,2]))/6
        volume = fsum(terms.tolist())
        if abs(volume) <= _EPS*fsum(np.abs(terms).tolist()) or volume == 0:
            raise ValueError('STL shell has zero or numerically ambiguous signed volume')
        physical = (volume*scale)*scale*scale
        if not np.isfinite(physical) or physical == 0:
            raise ValueError('STL shell signed volume is not representable in input units')
        volumes.append(physical)
        lo, hi = t.min(axis=1), t.max(axis=1)
        trees.append(_tree(lo, hi, np.arange(len(t))))
        bounds.append((lo.min(axis=0), hi.max(axis=0)))
    for i, t in enumerate(normalized):
        _check_intersections(t,t,faces[i],faces[i],trees[i],trees[i],True)
        for j in range(i):
            _check_intersections(t,normalized[j],faces[i],faces[j],trees[i],trees[j],False)
    contains = np.zeros((len(shells),len(shells)), dtype=bool)
    for i, outer in enumerate(normalized):
        lo, hi = bounds[i]
        for j, inner in enumerate(normalized):
            if i == j:
                continue
            child_lo, child_hi = bounds[j]
            if np.all(child_lo > lo+_EPS) and np.all(child_hi < hi-_EPS):
                # After exhaustive boundary separation and connectedness checks,
                # one boundary point establishes containment of the whole shell.
                contains[i,j] = _winding(inner[0,0],outer)
    depths = tuple(int(contains[:,i].sum()) for i in range(len(shells)))
    parents = []
    for j in range(len(shells)):
        ancestors = np.flatnonzero(contains[:,j])
        if len(ancestors):
            candidates = [int(i) for i in ancestors if depths[i] == depths[j]-1]
            if len(candidates) != 1:
                raise ValueError('Ambiguous STL shell containment tree')
            parents.append(candidates[0])
        else:
            parents.append(None)
    return ShellTopology(shells, tuple(parents), depths, tuple(volumes))
