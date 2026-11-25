"""One-sided copper terminal current from quadratic tetrahedral field probes."""
from __future__ import annotations

import numpy as np
from scipy.constants import epsilon_0

from rf_cpw_reference import STRIP_NAMES

TERMINALS = tuple(f"{strip}_{end}" for end in ("input","output") for strip in STRIP_NAMES)
QUADRATURE_NAME = "terminal-current-quadrature.npz"


CENTER_QUADRATURE_NAME = "center-current-quadrature.npz"
GAP_BAND_M = 20e-9
EXTRAPOLATION = np.array([3,-3,1])


def copper_plane_probes(case, x_m, side):
    """Sample three interior offsets at each triangular face quadrature node."""
    copper = case.points_m[case.tetrahedra[case.material_id == 1]]
    is_on_face = copper[:,:,0] == x_m
    off = np.where(is_on_face,0.,copper[:,:,0]-x_m)
    selected = (is_on_face.sum(axis=1) == 3) & (side * off.sum(axis=1) > 0)
    corners = copper[selected][is_on_face[selected]].reshape(-1,3,3)
    interior = copper[selected][~is_on_face[selected]].reshape(-1,3)
    area = np.linalg.norm(np.cross(corners[:,1]-corners[:,0],corners[:,2]-corners[:,0]),axis=1)/2
    y = corners[:,:,1].mean(axis=1)
    barycentric = np.full((3,3),1/6)
    np.fill_diagonal(barycentric,2/3)
    face_points = np.einsum("qi,fij->fqj",barycentric,corners)[:,:,None,:]
    fraction = np.array([1/4,1/2,3/4])[None,None,:,None]
    points = (1-fraction)*face_points + fraction*interior[:,None,None,:]
    strips = []
    for lo, hi in case.strips_m:
        strip = (y>lo) & (y<hi)
        if not np.isclose(area[strip].sum(),(hi-lo)*10e-9,rtol=1e-12,atol=0):
            raise ValueError("Copper sample faces do not cover the specified strip")
        strips.append(strip)
    return points, area, y, strips


def terminal_quadrature(case):
    """Return interior probe coordinates and boundary-integration weights."""
    xyz, weight, terminal = [], [], []
    for end, (x, side) in enumerate(zip(case.axes_m[0][[0,-1]], (1,-1), strict=True)):
        points, area, _, strips = copper_plane_probes(case,x,side)
        weights = np.broadcast_to(area[:,None,None]*EXTRAPOLATION[None,None,:]/3,points.shape[:-1])
        for index, strip in enumerate(strips):
            xyz.append(points[strip].reshape(-1,3))
            weight.append(weights[strip].ravel())
            terminal.append(np.full(weight[-1].shape,end*3+index,dtype=int))
    return {"xyz_m":np.concatenate(xyz),"weight_m2":np.concatenate(weight),
            "terminal_index":np.concatenate(terminal)}


def center_quadrature(case):
    """Build copper probes for the positive-x trace of the central section."""
    points, area, y, strips = copper_plane_probes(case,0.,1)
    strip_index = np.argmax(strips,axis=0)
    if not np.all(np.count_nonzero(strips,axis=0)==1):
        raise ValueError("Central copper faces must each belong to one strip")
    edge = case.strips_m[2][0]
    gap_side = (strip_index != 1) & (abs(y) <= edge+GAP_BAND_M)
    for ground in (0, 2):
        if not np.isclose(area[gap_side & (strip_index==ground)].sum(), GAP_BAND_M*10e-9,
                          rtol=1e-12,atol=0):
            raise ValueError("Central faces must resolve the gap-side band")
    return {"xyz_m": points.reshape(-1,3),
            "face_weight_m2": np.repeat(area/3,3),
            "strip_index": np.repeat(strip_index,3),
            "is_gap_side": np.repeat(gap_side,3)}


def integrate_center_current(quadrature, electric_x_vpm, sigma_spm):
    """Extrapolate the complex trace before taking the current magnitude."""
    weights = quadrature["face_weight_m2"]
    strip = quadrature["strip_index"]
    band = quadrature["is_gap_side"]
    if (weights.ndim != 1 or weights.shape != strip.shape or weights.shape != band.shape
            or band.dtype != bool or electric_x_vpm.shape != (3*len(weights),)
            or not np.array_equal(np.unique(strip),np.arange(len(STRIP_NAMES)))
            or np.any(band & (strip==1)) or not np.isfinite(electric_x_vpm).all()
            or not np.isfinite(weights).all() or not np.all(weights>0)
            or not np.isfinite(sigma_spm) or sigma_spm<=0):
        raise ValueError("Invalid central copper quadrature or field")
    conduction_density = sigma_spm*(electric_x_vpm.reshape(-1,3) @ EXTRAPOLATION)
    magnitude = weights*abs(conduction_density)
    ground_norm = float(magnitude[strip!=1].sum())
    currents = {}
    for index, name in enumerate(STRIP_NAMES):
        selected = strip==index
        current = weights[selected] @ conduction_density[selected]
        currents[name] = [current.real,current.imag]
    return {"x_m":0., "trace_x":"+", "gap_side_band_width_m":GAP_BAND_M,
            "conductor_currents_a":currents,
            "ground_gap_fraction":float(magnitude[band].sum())/ground_norm if ground_norm else None}


def integrate_terminal_currents(terminal, weights_m2, electric_x_vpm, sigma_spm, epsilon_r, frequency_hz):
    """Integrate complex copper conduction and total current along +x at both ends."""
    if (terminal.shape != weights_m2.shape or weights_m2.shape != electric_x_vpm.shape
            or not np.array_equal(np.unique(terminal),np.arange(len(TERMINALS)))
            or not (np.isfinite(weights_m2).all() and np.isfinite(electric_x_vpm).all())):
        raise ValueError("Invalid copper terminal quadrature or field")
    admittivity = sigma_spm + 2j*np.pi*frequency_hz*epsilon_0*epsilon_r
    output = {}
    for index,name in enumerate(TERMINALS):
        selected = terminal == index
        integral = np.dot(weights_m2[selected],electric_x_vpm[selected])
        conduction, total = sigma_spm*integral, admittivity*integral
        output[name] = {"conduction_a":[conduction.real,conduction.imag],
                        "total_a":[total.real,total.imag]}
    return output
