"""Closed STL shells are geometric domains, independent of winding and input order."""
import numpy as np
import pytest

from fullmag.meshing._stl_shells import ShellInput, classify_closed_shells


def cube(size=2., center=(0., 0., 0.), owner="body", reverse=False):
    v = np.array([[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],
                  [-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]], dtype=float)
    f = np.array([[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
                  [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]])
    t = (v * (size/2) + center)[f]
    return ShellInput(owner, (1,), t[:, ::-1] if reverse else t)


def test_nested_signed_volumes_and_global_reversal():
    for flip in (False, True):
        result = classify_closed_shells([cube(reverse=flip), cube(1, reverse=not flip)])
        assert result.parent_indices == (None, 0)
        assert result.depths == (0, 1)
        np.testing.assert_allclose(result.signed_volumes, np.array([8., -1.]) * (-1 if flip else 1))


def test_roots_and_owner_are_preserved():
    shells = (cube(owner="left"), cube(center=(5, 0, 0), owner="right"))
    result = classify_closed_shells(shells)
    assert result.shells == shells
    assert result.parent_indices == (None, None)


def test_depth_two_and_input_permutation():
    shells = [cube(6, owner="outer"), cube(4, owner="void"), cube(2, owner="island")]
    for order in ([0,1,2], [2,0,1], [1,2,0]):
        result = classify_closed_shells([shells[i] for i in order])
        assert dict(zip([s.owner for s in result.shells], result.depths)) == {"outer":0,"void":1,"island":2}
        parents = {s.owner: (None if p is None else result.shells[p].owner) for s,p in zip(result.shells,result.parent_indices)}
        assert parents == {"outer":None,"void":"outer","island":"void"}


@pytest.mark.parametrize("scale,offset", [(1e-12, 1e-7), (1e12, 1e17), (1., 1e9)])
def test_scale_and_translation(scale, offset):
    shells = [cube(2*scale, (offset,)*3), cube(scale, (offset,)*3)]
    result = classify_closed_shells(shells)
    assert result.depths == (0,1)
    np.testing.assert_allclose(result.signed_volumes, [8*scale**3,scale**3], rtol=1e-4)


@pytest.mark.parametrize("kind", ["open", "nonmanifold", "winding", "flat", "nan", "degenerate"])
def test_invalid_shells(kind):
    t = cube().triangles.copy()
    if kind == "open": t = t[:-1]
    elif kind == "nonmanifold": t = np.concatenate([t,t[:1]])
    elif kind == "winding": t[0] = t[0,::-1]
    elif kind == "flat": t[:,:,2] = 0
    elif kind == "nan": t[0,0,0] = np.nan
    else: t[0,1] = t[0,0]
    with pytest.raises(ValueError): classify_closed_shells([ShellInput("invalid", (1,), t)])


@pytest.mark.parametrize("center", [(1.,0.,0.), (2.,0.,0.), (2.,2.,0.), (2.,2.,2.), (0.,0.,0.)])
def test_crossing_touching_and_coplanar_overlap_rejected(center):
    with pytest.raises(ValueError): classify_closed_shells([cube(), cube(center=center)])


def test_concave_parent_uses_geometry_not_bounds():
    # A cube with a corner pushed inward forms a closed concave shell. The point
    # near the old corner remains inside its bounds but outside the solid.
    parent = cube(4)
    t = parent.triangles.copy()
    t[np.all(t == [2,2,2], axis=2)] = [0,0,0]
    result = classify_closed_shells([ShellInput("concave", (1,), t), cube(.1, (1.5,1.5,1.5))])
    assert result.depths == (0,0)


def test_disconnected_vertex_fans_rejected():
    a = cube().triangles
    b = cube(center=(2,2,2)).triangles
    with pytest.raises(ValueError):
        classify_closed_shells([ShellInput("pinched", (1,), np.concatenate([a,b]))])


def subdivide(triangles):
    a, b, c = triangles[:,0], triangles[:,1], triangles[:,2]
    ab, bc, ca = (a+b)/2, (b+c)/2, (c+a)/2
    return np.concatenate([np.stack(points,axis=1) for points in
                           ((a,ab,ca),(ab,b,bc),(ca,bc,c),(ab,bc,ca))])


def test_dense_planar_mesh_and_triangle_permutation():
    triangles = subdivide(subdivide(cube().triangles))
    rng = np.random.default_rng(947)
    triangles = triangles[rng.permutation(len(triangles))]
    result = classify_closed_shells([ShellInput("subdivided",(19,31),triangles), cube(.5)])
    assert result.depths == (0,1)
    assert result.shells[0].surface_tags == (19,31)
    np.testing.assert_allclose(result.signed_volumes,[8,.125])


def test_self_intersection_of_edge_closed_consistently_wound_shell():
    triangles = cube().triangles.copy()
    triangles[np.all(triangles == [1,1,1],axis=2)] = [-2.137,.231,.173]
    # Subdivision and shuffling force the BVH to compare different subtrees;
    # the intersection is not a missing-edge or inconsistent-winding error.
    triangles = subdivide(subdivide(triangles))
    triangles = triangles[np.random.default_rng(238).permutation(len(triangles))]
    with pytest.raises(ValueError, match="self-intersection"):
        classify_closed_shells([ShellInput("crossed",(1,),triangles)])


def test_numerically_unresolved_gap_fails_closed():
    with pytest.raises(ValueError, match="intersect|touch|ambiguous"):
        classify_closed_shells([cube(),cube(center=(2+1e-14,0,0))])


def test_resolved_small_gap_is_not_contact():
    result = classify_closed_shells([cube(),cube(center=(2+1e-8,0,0))])
    assert result.depths == (0,0)
