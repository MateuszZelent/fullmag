"""Run a reproducible full-wave FIT comparison for a straight CPW."""

import argparse
from dataclasses import replace
from hashlib import file_digest
import json
from pathlib import Path
from time import perf_counter

import numpy as np
from scipy import __version__ as scipy_version
from scipy.constants import epsilon_0, mu_0

from rf_cpw_reference import FREQUENCY_HZ, SIGMA_COPPER, STRIP_NAMES, TET_OFFSETS, _observation_line, make_case
from rf_fit_reference import assemble


def metal_conductivity(name, override):
    defaults = {"copper": (SIGMA_COPPER, "published_cpw_copper"),
                "gold": (1 / 2.44e-8, "nominal_bulk_gold")}
    nominal = defaults[name]
    if override is None:
        return nominal
    if not np.isfinite(override) or override <= 0:
        raise ValueError("Conductivity must be finite and positive")
    return float(override), "explicit"


def sha(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def phasor(value):
    return [float(np.real(value)), float(np.imag(value))]


def refine_gap_edges(case):
    """Bisect selected cells while preserving the canonical CPW material and port regions."""
    x, y, z = case.axes_m
    y_mid, z_mid = (y[:-1]+y[1:])/2, (z[:-1]+z[1:])/2
    edges = np.array([case.strips_m[0][1], *case.strips_m[1], case.strips_m[2][0]])
    gap = np.any(abs(y_mid[:, None] - edges) <= 20e-9, axis=1)
    axes = (x, np.sort(np.r_[y, y_mid[gap]]), np.sort(np.r_[z, z_mid[abs(z_mid) <= 10e-9]]))
    cell_shape = tuple(len(axis)-1 for axis in axes)
    base_shape = tuple(len(axis)-1 for axis in case.axes_m)
    parent = [np.searchsorted(coarse, (fine[1:]+fine[:-1])/2, side="right")-1
              for fine, coarse in zip(axes, case.axes_m, strict=True)]
    parent_index = np.ix_(*parent)
    points = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    cells = np.indices(cell_shape).reshape(3, -1).T
    corners = cells[:, None, None, :] + TET_OFFSETS
    tets = np.ravel_multi_index(corners.transpose(3, 0, 1, 2), tuple(len(a) for a in axes)).reshape(-1, 4)
    terminals = {}
    for name, group in case.terminals.items():
        bounds = case.points_m[group]
        select = ((points >= bounds.min(axis=0)) & (points <= bounds.max(axis=0))).all(axis=1)
        terminals[name] = np.flatnonzero(select)
    material = {
        key: np.repeat(getattr(case, key)[::6].reshape(base_shape)[parent_index].ravel(), 6)
        for key in ("material_id", "conductivity_spm", "relative_permittivity")
    }
    return replace(case, axes_m=axes, points_m=points, tetrahedra=tets, terminals=terminals, **material)


def cross_section(case, fit, solution):
    """Integrate the axial current on the x = 0 positive-side section."""
    _, y_axis, z_axis = case.axes_m
    width_y, width_z = np.meshgrid(np.diff(y_axis), np.diff(z_axis), indexing="ij")
    cy, cz = np.meshgrid((y_axis[:-1]+y_axis[1:])/2, (z_axis[:-1]+z_axis[1:])/2, indexing="ij")
    metal = (cz > 0.) & (cz < 10e-9) & np.logical_or.reduce([(cy > lo) & (cy < hi) for lo, hi in case.strips_m])
    width_y, width_z, cy, cz = (array[metal] for array in (width_y, width_z, cy, cz))
    area_quarter = np.tile(width_y * width_z / 4, 4)
    quadrature = np.array([-1., 1.]) / np.sqrt(12)
    y = np.concatenate([cy + dy*width_y for dy in quadrature for _ in quadrature])
    z = np.concatenate([cz + dz*width_z for _ in quadrature for dz in quadrature])
    target = np.column_stack((np.zeros_like(y), y, z))
    sampled_e, _ = fit.sample(solution.electric_edge_v, target, curl_edge_v=solution.curl_edge_v)
    j = fit.conductivity_spm[tuple(fit.locate(target)[0])] * sampled_e[:, 0]
    strips = [(y > low) & (y < high) for low, high in case.strips_m]
    branch = {name: phasor(area_quarter[strip] @ j[strip])
              for name, strip in zip(STRIP_NAMES, strips, strict=True)}
    ground = strips[0] | strips[2]
    near = ground & (abs(y) <= case.strips_m[2][0] + 20e-9)
    edge_fraction = (area_quarter[near] @ abs(j[near])) / (area_quarter[ground] @ abs(j[ground]))
    return branch, float(edge_fraction), target, j, area_quarter


def solve(case, metal, override, sample_step_nm, output, *, gap_refined=False):
    if output.exists():
        raise FileExistsError(f"Expected a new output directory: {output}")
    sigma, sigma_provenance = metal_conductivity(metal, override)
    shape = tuple(len(axis)-1 for axis in case.axes_m)
    mat = case.material_id.reshape(*shape, 6)
    assert np.all(mat == mat[..., :1]), "FIT input cells must each have one material"
    relative_eps = case.relative_permittivity.reshape(*shape, 6)
    assert np.all(relative_eps == relative_eps[..., :1])
    began = perf_counter()
    fit = assemble(case.axes_m, np.where(mat[..., 0] == 1, sigma, 0.), relative_eps[..., 0], case.frequency_hz)
    solution = fit.solve_ece(case.terminals, case.voltages_v, case.loads_ohm, floating_load=case.floating_load)
    line = _observation_line(sample_step_nm)
    e, h = fit.sample(solution.electric_edge_v, line, curl_edge_v=solution.curl_edge_v)
    branch, fraction, section, j_axial, weights = cross_section(case, fit, solution)

    currents = solution.terminal_currents_a
    voltages = solution.terminal_voltages_v
    signal = currents["signal_input"]
    if abs(signal) <= 1e-15:
        raise ValueError("Input current is too small for normalization")
    if case.floating_load is None:
        impedance, = case.loads_ohm.values()
        load_error = max(abs(currents[name] + voltages[name]/impedance)
                         for name, impedance in case.loads_ohm.items())
    else:
        name, returns, impedance = case.floating_load
        load_current = (voltages[name] - voltages[returns[0]]) / impedance
        load_error = max(abs(currents[name] + load_current), abs(sum(currents[r] for r in returns) - load_current))
    kcl = abs(sum(currents.values())) / abs(signal)
    if solution.power_joule_w <= 0:
        raise RuntimeError("FIT ohmic power must be positive for the lossy CPW case")
    power_error = abs(solution.power_in_w - solution.power_joule_w) / solution.power_joule_w
    if max(kcl, load_error/abs(signal), power_error) > 1e-5:
        raise RuntimeError("FIT circuit current or power balance did not qualify")

    output.mkdir(parents=True, exist_ok=False)
    arrays = output / "fields.npz"
    np.savez_compressed(arrays, probe_xyz_m=line, e_vpm=e, h_apm=h, h_per_amp_per_m=h/signal,
                        centre_plane_metal_xyz_m=section, centre_plane_jx_apm2=j_axial,
                        centre_plane_weights_m2=weights, x_m=case.axes_m[0], y_m=case.axes_m[1], z_m=case.axes_m[2],
                        material_id=mat[..., 0], relative_permittivity=relative_eps[..., 0],
                        electric_edge_v=solution.electric_edge_v, curl_edge_v=solution.curl_edge_v)
    report = {
        "status": "completed", "source": "Fullmag standalone research reference", "solver": "fullwave_fit_cpu_fp64",
        "boundary_model": "ECE, zero normal magnetic flux on exterior and floating nonterminal boundary potentials",
        "field_convention": "Peak phasors exp(+iωt). Port reaction current positive into simulation domain.",
        "measurement": False, "cpw": case.cpw, "frequency_hz": case.frequency_hz, "conductor": metal,
        "conductivity_s_per_m": sigma, "conductivity_provenance": sigma_provenance, "conductor_thickness_nm": 10,
        "metal_bulk_skin_depth_m": 1/np.sqrt(np.pi*case.frequency_hz*mu_0*sigma),
        "refinement": case.refinement, "axial_refinement": case.axial_refinement, "mesh_shape_xyz": shape,
        "local_gap_refinement": gap_refined,
        "geometry_extent_m": [[float(axis[0]), float(axis[-1])] for axis in case.axes_m],
        "axis_range_order": "minimum_m, maximum_m",
        "strips_m": case.strips_m, "conductor_permittivity_fpm": epsilon_0, "output_return": case.output_return,
        "port_impedance_ohm": phasor(impedance), "terminal_voltages_v": {n: phasor(v) for n, v in voltages.items()},
        "terminal_currents_a": {n: phasor(v) for n, v in currents.items()}, "probe_x_m": float(line[0, 0]),
        "probe_z_m": float(line[0, 2]), "probe_step_nm": sample_step_nm, "cell_tie_policy": "positive-side",
        "relative_residual": solution.relative_residual, "relative_terminal_kcl_error": kcl,
        "relative_load_error": load_error/abs(signal), "relative_power_error": power_error,
        "ohmic_power_w": solution.power_joule_w, "input_net_terminal_power_w": solution.power_in_w,
        "centre_plane_branch_conduction_current_a": branch,
        "centre_plane_fraction_ground_abs_current_in_first_20nm": fraction,
        "elapsed_seconds": perf_counter()-began, "scipy_version": scipy_version, "numpy_version": np.__version__,
        "output_sha256": sha(arrays), "source_sha256": {name: sha(Path(__file__).with_name(name)) for name in
                           ("run_rf_fit_cpw.py", "rf_fit_reference.py", "rf_fullwave_reference.py", "rf_cpw_reference.py")},
    }
    (output / "result.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"CPW{case.cpw} {metal}: {len(fit.edges)} FIT edges, residual {solution.relative_residual:.3e}, "
          f"gap return {fraction:.4%}, {report['elapsed_seconds']:.2f} s")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cpw", choices=(1, 2), type=int, required=True)
    p.add_argument("--metal", choices=("copper", "gold"), default="copper")
    p.add_argument("--conductivity-s-per-m", type=float)
    p.add_argument("--frequency-hz", type=float, default=FREQUENCY_HZ)
    p.add_argument("--refinement", type=int, choices=(0, 1, 2), default=0)
    p.add_argument("--refine-gap-edges", action="store_true")
    p.add_argument("--axial-refinement", type=int, choices=(0, 1, 2), default=0)
    p.add_argument("--half-length-nm", type=float, default=1000)
    p.add_argument("--box-half-width-nm", type=float, default=3000)
    p.add_argument("--load-ohm", type=complex, default=50+0j)
    p.add_argument("--output-return", choices=("reference", "local-gsg"), default="local-gsg")
    p.add_argument("--sample-step-nm", type=float, choices=(20., 5., 2.5), default=20.)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    case = make_case(cpw=args.cpw, refinement=args.refinement, axial_refinement=args.axial_refinement,
                     half_length_nm=args.half_length_nm, box_half_width_nm=args.box_half_width_nm,
                     frequency_hz=args.frequency_hz, load_ohm=args.load_ohm, output_return=args.output_return)
    if args.refine_gap_edges:
        case = refine_gap_edges(case)
    solve(case, args.metal, args.conductivity_s_per_m, args.sample_step_nm, args.output,
          gap_refined=args.refine_gap_edges)


if __name__ == "__main__":
    main()
