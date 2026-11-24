"""Build and optionally solve the documented ECE coplanar-waveguide reference.

This standalone reference records its own ports and material assumptions. Its
outputs are research artifacts, separate from Fullmag's production field API.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

import numpy as np


FREQUENCY_HZ = 22.12e9
SIGMA_COPPER = 5.88e7
STRIP_NAMES = ("left_ground", "signal", "right_ground")
MATERIAL_NAMES = ("air", "copper", "spacer", "passive_yig", "substrate")
PERMUTATIONS = tuple(itertools.permutations(range(3)))
TET_INDEX = {permutation: i for i, permutation in enumerate(PERMUTATIONS)}
TET_OFFSETS = []
for order in PERMUTATIONS:
    first = np.eye(3, dtype=int)[order[0]]
    second = first + np.eye(3, dtype=int)[order[1]]
    if sum(a > b for a, b in itertools.combinations(order, 2)) % 2:
        first, second = second, first
    TET_OFFSETS.append([np.zeros(3, dtype=int), first, second, np.ones(3, dtype=int)])
TET_OFFSETS = np.asarray(TET_OFFSETS)
NM = 1e-9


@dataclass(frozen=True)
class CpwCase:
    cpw: int
    refinement: int
    axial_refinement: int
    axes_m: tuple[np.ndarray, np.ndarray, np.ndarray]
    points_m: np.ndarray
    tetrahedra: np.ndarray
    material_id: np.ndarray
    conductivity_spm: np.ndarray
    relative_permittivity: np.ndarray
    strips_m: tuple[tuple[float, float], ...]
    terminals: dict[str, np.ndarray]
    voltages_v: dict[str, complex]
    loads_ohm: dict[str, complex]
    frequency_hz: float
    output_return: str
    floating_load: tuple[str, tuple[str, ...], complex] | None


def _divide_axis(knots_nm, subdivisions, refined_range=None):
    pieces = []
    for a, b in zip(knots_nm[:-1], knots_nm[1:]):
        center = (a + b)/2
        refine = refined_range is None or refined_range[0] <= center <= refined_range[1]
        intervals = subdivisions if refine else 1
        pieces.append(np.linspace(a, b, intervals + 1)[:-1])
    return NM * np.concatenate([*pieces, knots_nm[-1:]])


def _axes(signal_width_nm, half_length_nm, box_half_width_nm, refinement, axial_refinement):
    signal_edge = 0.5 * signal_width_nm
    ground_edge = signal_edge + 95
    positive = np.concatenate((
        np.linspace(0, signal_edge, 1 + int(np.ceil(signal_edge / 40))),
        np.linspace(signal_edge, ground_edge, 4)[1:],
        [ground_edge + 10, ground_edge + 20],
        np.linspace(ground_edge + 20, 750, 1 + int(np.ceil((730-ground_edge)/70)))[1:],
        750 + (box_half_width_nm - 750)*np.array([0.02, 0.065, 0.155, 0.33, 0.62, 1.0]),
    ))
    y_nm = np.concatenate((-positive[:0:-1], positive))
    side = np.array([0.0015, 0.005, 0.015, 0.04, 0.10, 0.22, 0.45, 0.72, 1.0])
    z_nm = np.concatenate((
        -25 - (box_half_width_nm - 25)*side[::-1],
        [-25, -15, -10, -5, -2.5, 0, 5, 10],
        10 + (box_half_width_nm - 10)*side,
    ))
    x_nm = half_length_nm*np.array([-1.0, -0.5, 0.0, 0.5, 1.0])
    # Preserve all existing knots and refine the cross section near the CPW.
    # Axial and enclosure studies remain independently controllable.
    subdivisions = 2**refinement
    return (
        _divide_axis(x_nm, 2**axial_refinement),
        _divide_axis(y_nm, subdivisions, (-750, 750)),
        _divide_axis(z_nm, subdivisions, (-25, 25)),
    )


def make_case(
    cpw=2, refinement=0, half_length_nm=1000.0, box_half_width_nm=3000.0,
    yig_epsilon_r=14.7, frequency_hz=FREQUENCY_HZ, load_ohm=50.0,
    axial_refinement=0, output_return="reference",
):
    if output_return not in ("reference", "local-gsg"):
        raise ValueError("Output return must be reference or local-gsg")
    if cpw not in (1, 2):
        raise ValueError("CPW geometry must be 1 or 2")
    if refinement not in (0, 1, 2) or axial_refinement not in (0, 1, 2):
        raise ValueError("Refinement levels must be 0, 1, or 2")
    if not np.all(np.isfinite([half_length_nm, box_half_width_nm, yig_epsilon_r, frequency_hz,
                               np.real(load_ohm), np.imag(load_ohm)])):
        raise ValueError("Geometry, material, frequency and load values must be finite")
    if (half_length_nm <= 0 or box_half_width_nm <= 1600 or yig_epsilon_r <= 0
            or frequency_hz <= 0 or np.real(load_ohm) < 0 or load_ohm == 0):
        raise ValueError("Invalid geometry, material, frequency, or passive load")

    signal_width_nm = (65, 260)[cpw - 1]
    axes_m = _axes(signal_width_nm, half_length_nm, box_half_width_nm, refinement,
                   axial_refinement)
    points = np.stack(np.meshgrid(*axes_m, indexing="ij"), axis=-1).reshape(-1, 3)
    grid_dimensions = tuple(len(axis) for axis in axes_m)
    pixel_grid = np.indices(tuple(n-1 for n in grid_dimensions)).reshape(3, -1).T
    corners = pixel_grid[:, None, None, :] + TET_OFFSETS
    tetrahedra = np.ravel_multi_index(corners.transpose(3, 0, 1, 2), grid_dimensions)
    tetrahedra = tetrahedra.reshape(-1, 4)

    signal = signal_width_nm * NM / 2
    ground = (signal_width_nm / 2 + 95) * NM
    strips_m = ((-750*NM, -ground), (-signal, signal), (ground, 750*NM))
    y_cell = (axes_m[1][pixel_grid[:, 1]] + axes_m[1][pixel_grid[:, 1]+1]) / 2
    z_cell = (axes_m[2][pixel_grid[:, 2]] + axes_m[2][pixel_grid[:, 2]+1]) / 2
    materials = np.select(
        [z_cell < -25*NM, z_cell < -5*NM, z_cell < 0],
        [4, 3, 2], default=0,
    ).astype(np.int8)
    for low, high in strips_m:
        metal = (y_cell > low) & (y_cell < high) & (z_cell > 0) & (z_cell < 10*NM)
        materials[metal] = 1
    material_id = np.repeat(materials, 6)

    terminals = {}
    for end, index in (("input", 0), ("output", -1)):
        exterior = (points[:, 0] == axes_m[0][index]) & (points[:, 2] >= 0) & (points[:, 2] <= 10*NM)
        for name, (low, high) in zip(STRIP_NAMES, strips_m):
            terminals[f"{name}_{end}"] = np.flatnonzero(
                exterior & (points[:, 1] >= low) & (points[:, 1] <= high)
            )
    voltages = {name: 0j for name in terminals if name != "signal_output"}
    voltages["signal_input"] = 1 + 0j
    loads = {"signal_output": complex(load_ohm)}
    floating_load = None
    if output_return == "local-gsg":
        returns = ("left_ground_output", "right_ground_output")
        for terminal in returns:
            del voltages[terminal]
        floating_load = ("signal_output", returns, loads.pop("signal_output"))
    return CpwCase(
        cpw, refinement, axial_refinement, axes_m, points, tetrahedra, material_id,
        np.where(material_id == 1, SIGMA_COPPER, 0.0),
        np.array([1.0, 1.0, 14.7, yig_epsilon_r, 14.7])[material_id],
        strips_m, terminals, voltages, loads, frequency_hz, output_return, floating_load,
    )


def locate_points(case, points_m):
    """Use the +axis cell on a grid plane, with a stable convention on diagonals."""
    points = np.asarray(points_m, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3 or not np.all(np.isfinite(points)):
        raise ValueError("Sampling points must be a finite array of XYZ coordinates")
    cell = np.empty(points.shape, dtype=np.intp)
    fractions = np.empty_like(points)
    for i, axis in enumerate(case.axes_m):
        if np.any(points[:, i] < axis[0]) or np.any(points[:, i] > axis[-1]):
            raise ValueError("Sampling point is outside the mesh")
        cell[:, i] = (np.searchsorted(axis, points[:, i], side="right") - 1).clip(0, len(axis)-2)
        low = axis[cell[:, i]]
        fractions[:, i] = (points[:, i] - low)/(axis[cell[:, i]+1] - low)
    tetra = np.fromiter(
        (TET_INDEX[tuple(row)] for row in np.argsort(-fractions, axis=1, kind="stable")),
        dtype=np.intp, count=len(points),
    )
    return 6*np.ravel_multi_index(cell.T, tuple(len(axis)-1 for axis in case.axes_m)) + tetra


def transverse_spectrum(y_m, hy, k_rad_per_m):
    y_m = np.asarray(y_m, dtype=np.float64)
    hy = np.asarray(hy, dtype=np.complex128)
    k = np.asarray(k_rad_per_m, dtype=np.float64)
    if (y_m.ndim != 1 or len(y_m) < 2 or k.ndim != 1 or hy.shape != y_m.shape
            or np.any(np.diff(y_m) <= 0)
            or not all(np.all(np.isfinite(a)) for a in (y_m, hy, k))):
        raise ValueError("Spectrum requires finite samples on an increasing transverse line")
    return np.trapezoid(hy*np.exp(-1j*k[:, None]*y_m), x=y_m, axis=1)


def _digest(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def _phasor(value):
    return [float(np.real(value)), float(np.imag(value))]


def _edge_count(cells):
    nx, ny, nz = cells
    return (nx*(ny+1)*(nz+1) + (nx+1)*ny*(nz+1) + (nx+1)*(ny+1)*nz
            + nx*ny*(nz+1) + nx*(ny+1)*nz + (nx+1)*ny*nz + nx*ny*nz)


def preflight(case):
    dimensions = [len(axis)-1 for axis in case.axes_m]
    materials = {
        name: {
            "tetrahedra": int(np.count_nonzero(case.material_id == i)),
            "conductivity_spm": float(case.conductivity_spm[case.material_id == i][0]),
            "relative_permittivity": float(case.relative_permittivity[case.material_id == i][0]),
        }
        for i, name in enumerate(MATERIAL_NAMES)
    }
    floating_load = None
    if case.floating_load is not None:
        signal, returns, impedance = case.floating_load
        floating_load = {"signal_terminal": signal, "return_terminals": list(returns),
                         "impedance_ohm": _phasor(impedance)}
    return {
        "cpw": case.cpw,
        "refinement": case.refinement,
        "axial_refinement": case.axial_refinement,
        "frequency_hz": case.frequency_hz,
        "phasor_convention": "peak, exp(+i omega t)",
        "boundary_model": "ECE terminal patches",
        "output_return": case.output_return,
        "floating_load": floating_load,
        "port_settings_origin": "declared reference assumptions; CST ports unavailable",
        "copper_strips_y_m": case.strips_m,
        "terminal_voltages_v": {name: _phasor(value) for name, value in case.voltages_v.items()},
        "terminal_loads_ohm": {name: _phasor(value) for name, value in case.loads_ohm.items()},
        "axis_endpoints_m": [[float(axis[0]), float(axis[-1])] for axis in case.axes_m],
        "smallest_axis_intervals_m": [float(np.diff(axis).min()) for axis in case.axes_m],
        "rectangular_cells_xyz": dimensions,
        "points": len(case.points_m),
        "tetrahedra": len(case.tetrahedra),
        "full_edge_dof_count": _edge_count(dimensions),
        "assembled_entries_before_coalescing_upper_bound": 36*len(case.tetrahedra),
        "mesh_arrays_bytes": sum(
            array.nbytes for array in (case.points_m, case.tetrahedra, case.material_id,
                                      case.conductivity_spm, case.relative_permittivity)
        ),
        "materials": materials,
        "terminal_vertices": {name: len(ids) for name, ids in case.terminals.items()},
        "sha256": {
            name: _digest(array) for name, array in (
                ("points_m", case.points_m), ("tetrahedra", case.tetrahedra),
                ("material_id", case.material_id), ("conductivity_spm", case.conductivity_spm),
                ("relative_permittivity", case.relative_permittivity),
            )
        },
    }


def _observation_line(step_nm):
    intervals = int(round(3200/step_nm))
    y = np.linspace(-1600*NM, 1600*NM, intervals+1)
    return np.column_stack((np.zeros_like(y), y, np.full_like(y, -7.5*NM)))


def _cross_section(case, system, solution, model):
    from scipy.constants import epsilon_0

    y, z = case.axes_m[1:]
    starts = np.stack(np.meshgrid(y[:-1], z[:-1], indexing="ij"), axis=-1).reshape(-1, 2)
    widths = np.stack(np.meshgrid(np.diff(y), np.diff(z), indexing="ij"), axis=-1).reshape(-1, 2)
    # Three fixed quadrature points per triangle. The complex Jx integral is
    # exact for the first-order field on x=0, while the |Jx| integral is quadrature.
    barycentric = np.full((3, 3), 1/6)
    np.fill_diagonal(barycentric, 2/3)
    faces = np.array([[[0, 0], [1, 0], [1, 1]], [[0, 0], [0, 1], [1, 1]]])
    unit_samples = np.einsum("qa,fab->fqb", barycentric, faces).reshape(6, 2)
    yz = starts[:, None, :] + widths[:, None, :]*unit_samples
    samples = np.column_stack((np.zeros(yz.size//2), yz.reshape(-1, 2)))
    cells = locate_points(case, samples)
    electric, _ = system.sample(solution.electric_edge_v, samples, cells,
                                curl_edge_v=solution.curl_edge_v)
    conduction = case.conductivity_spm[cells]*electric[:, 0]
    displacement_electric = electric[:, 0]
    displacement_model = "electric_full"
    if model == "darwin":
        from rf_fullwave_reference import gradient_incidence

        grad = gradient_incidence(len(system.points_m), system.edges)
        electrostatic, _ = system.sample(-grad @ solution.scalar_potential_v, samples, cells,
                                         curl_edge_v=np.zeros_like(solution.curl_edge_v))
        displacement_electric = electrostatic[:, 0]
        displacement_model = "scalar_potential_gradient"
    displacement = (1j*2*np.pi*case.frequency_hz*epsilon_0
                    *case.relative_permittivity[cells]*displacement_electric)
    weight = np.repeat(widths.prod(axis=1)/6, 6)

    y_mean, z_mean = (starts + widths/2).T
    branch_currents = {}
    for name, (low, high) in zip(STRIP_NAMES, case.strips_m):
        active = np.repeat((y_mean > low) & (y_mean < high) & (z_mean > 0) & (z_mean < 10*NM), 6)
        branch_currents[name] = _phasor(np.dot(weight[active], conduction[active]))

    y_edge = case.strips_m[-1][0]
    ground = (abs(samples[:, 1]) >= y_edge) & (case.material_id[cells] == 1)
    gap_edge = ground & (abs(samples[:, 1]) <= y_edge + 20*NM)
    magnitude = abs(conduction)
    return_norm = np.dot(weight[ground], magnitude[ground])
    return {
        "x_m": 0.0,
        "trace": "positive-x element",
        "conductor_currents_a": branch_currents,
        "displacement_model": displacement_model,
        "displacement_current_a": _phasor(np.dot(weight, displacement)),
        "total_current_a": _phasor(np.dot(weight, conduction + displacement)),
        "ground_gap_band_width_m": 20*NM,
        "ground_gap_fraction": float(np.dot(weight[gap_edge], magnitude[gap_edge])/return_norm)
        if return_norm > 0 else None,
    }


def _solve(case, output, step_nm, model):
    from scipy import __version__ as scipy_version
    from rf_fullwave_reference import assemble

    if output.exists():
        raise FileExistsError(f"Output directory already exists: {output}")
    inputs = preflight(case)
    started = perf_counter()
    system = assemble(
        case.points_m, case.tetrahedra, case.conductivity_spm,
        case.relative_permittivity, case.frequency_hz,
    )
    assembled = perf_counter()
    circuit = (case.terminals, case.voltages_v, case.loads_ohm)
    if model == "maxwell":
        solution = system.solve_ece(*circuit, floating_load=case.floating_load)
    else:
        from rf_darwin_reference import solve_darwin_ece

        solution = solve_darwin_ece(system, *circuit, floating_load=case.floating_load)
    solved = perf_counter()
    line = _observation_line(step_nm)
    line_cells = locate_points(case, line)
    electric, magnetic = system.sample(solution.electric_edge_v, line, line_cells,
                                       curl_edge_v=solution.curl_edge_v)

    is_copper = case.material_id == 1
    copper_indices = np.flatnonzero(is_copper)
    copper_centers = case.points_m[case.tetrahedra[is_copper]].mean(axis=1)
    copper_electric, copper_magnetic = system.sample(
        solution.electric_edge_v, copper_centers, copper_indices,
        curl_edge_v=solution.curl_edge_v,
    )
    section = _cross_section(case, system, solution, model)

    currents = solution.terminal_currents_a
    voltages = solution.terminal_voltages_v
    input_power = 0.5*sum((voltages[name]*np.conj(value)).real
                          for name, value in currents.items())
    power_terms = solution.power_joule_w
    if model == "darwin":
        power_terms += solution.power_mix_w
    current_ref = currents["signal_input"]
    load_residual = {name: float(abs(currents[name] + voltages[name]/impedance))
                     for name, impedance in case.loads_ohm.items()}
    floating_load_result = None
    if case.floating_load is not None:
        signal, returns, impedance = case.floating_load
        load_voltage = voltages[signal] - voltages[returns[0]]
        load_current = load_voltage / impedance
        load_residual[signal] = float(abs(currents[signal] + load_current))
        load_residual["tied_output_grounds"] = float(
            abs(sum(currents[name] for name in returns) - load_current))
        floating_load_result = {
            "voltage_v": _phasor(load_voltage),
            "signal_to_return_current_a": _phasor(load_current),
            "absorbed_power_w": float(0.5 * (load_voltage * np.conj(load_current)).real),
        }
    imbalance = abs(sum(currents.values()))
    reference_error_proxy = imbalance + solution.relative_residual*sum(map(abs, currents.values()))
    fields = {
        "probe_xyz_m": line, "probe_cell": line_cells,
        "probe_material_id": case.material_id[line_cells],
        "probe_E_Vpm": electric, "probe_H_Apm": magnetic,
        "copper_cell": copper_indices, "copper_center_xyz_m": copper_centers,
        "copper_center_E_Vpm": copper_electric,
        "copper_center_H_Apm": copper_magnetic,
        "copper_center_J_Apm2": case.conductivity_spm[is_copper, None]*copper_electric,
        "E_edge_dof_V": solution.electric_edge_v,
        "E_curl_edge_dof_V": solution.curl_edge_v,
        "edges_vertex_ids": system.edges,
    }
    # This gate uses only the available single-mesh error proxy. A mesh
    # convergence estimate is separately required for a qualified basis.
    basis_provisional = (np.isfinite(current_ref) and abs(current_ref) > 100*reference_error_proxy)
    if model == "darwin":
        fields["potential_nodes_V"] = solution.scalar_potential_v
        inputs.update(
            gauge_relative_residual=solution.gauge_relative_residual,
            gauge_force_relative_residual=solution.gauge_force_relative_residual,
            power_darwin_mix_w=solution.power_mix_w,
        )
    if basis_provisional:
        basis = magnetic/current_ref
        k = np.arange(0, 35.0001e6, 0.05e6)
        spectrum = transverse_spectrum(line[:, 1], basis[:, 1], k)
        fields.update(probe_H_over_I_per_m=basis, k_rad_per_m=k, FT_Hy_over_I=spectrum)
        mag = np.abs(spectrum)
        local_minima = np.flatnonzero(
            (mag[:-2] > mag[1:-1]) & (mag[2:] > mag[1:-1])
            & (k[1:-1] >= 15e6) & (k[1:-1] <= 23e6)
        ) + 1
        if len(local_minima) > 0 and mag.max() > 0:
            index = min(local_minima, key=lambda i: mag[i])
            inputs["local_minimum"] = {
                "search_interval_rad_per_m": [15e6, 23e6],
                "k_rad_per_m": float(k[index]),
                "relative_to_peak": float(mag[index]/mag.max()),
            }
    inputs.update({
        "execution": "standalone SciPy reference",
        "model": model,
        "scipy_version": scipy_version,
        "numpy_version": np.__version__,
        "probe_step_nm": step_nm,
        "probe_trace": "positive-axis cell, stable coordinate rank on tetrahedral ties",
        "evidence_status": "reference_candidate_unqualified",
        "terminals_v": {name: _phasor(value) for name, value in voltages.items()},
        "terminals_a_positive_into_domain": {name: _phasor(value) for name, value in currents.items()},
        "terminal_current_balance_a": float(imbalance),
        "relative_residual": float(solution.relative_residual),
        "power_net_ece_input_w": float(input_power),
        "power_joule_w": float(solution.power_joule_w),
        "power_balance_residual_w": float(abs(input_power-power_terms)),
        "load_law_residual_a": load_residual,
        "floating_load_result": floating_load_result,
        "reference_current_a": _phasor(current_ref),
        "reference_current_error_proxy_a": float(reference_error_proxy),
        "normalized_basis_status": "provisional" if basis_provisional else "unresolved",
        "cross_section": section,
        "timing_s": {"assemble": assembled-started, "solve": solved-assembled,
                     "postprocess": perf_counter()-solved},
    })
    source_files = [Path(__file__), Path(__file__).with_name("rf_fullwave_reference.py")]
    if model == "darwin":
        source_files.append(Path(__file__).with_name("rf_darwin_reference.py"))
    inputs["source_file_sha256"] = {
        source.name: hashlib.sha256(source.read_bytes()).hexdigest() for source in source_files
    }
    manifest = json.dumps(inputs, allow_nan=False, indent=2)
    output.mkdir(parents=True)
    np.savez(output/"mesh.npz", points_m=case.points_m, tetrahedra=case.tetrahedra,
             material_id=case.material_id, conductivity_spm=case.conductivity_spm,
             relative_permittivity=case.relative_permittivity,
             **{f"terminal_{name}": ids for name, ids in case.terminals.items()})
    np.savez(output/"fields.npz", **fields)
    (output/"manifest.json").write_text(manifest + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpw", choices=(1, 2), type=int, default=2)
    parser.add_argument("--model", choices=("maxwell", "darwin"), default="maxwell")
    parser.add_argument("--axial-refinement", choices=(0, 1, 2), type=int, default=0)
    parser.add_argument("--refinement", choices=(0, 1, 2), type=int, default=0)
    parser.add_argument("--box-half-width-nm", type=float, default=3000)
    parser.add_argument("--half-length-nm", type=float, default=1000)
    parser.add_argument("--yig-epsilon-r", type=float, default=14.7)
    parser.add_argument("--frequency-hz", type=float, default=FREQUENCY_HZ)
    parser.add_argument("--load-ohm", type=complex, default=50)
    parser.add_argument("--output-return", choices=("reference", "local-gsg"), default="reference",
                        help="Connect the load to global reference or the tied output ground strips")
    parser.add_argument("--sample-step-nm", choices=(20, 5, 2.5), type=float, default=20)
    parser.add_argument("--solve", action="store_true", help="Execute the electromagnetic solve")
    parser.add_argument("--output", type=Path, help="New directory for the solve artifacts")
    args = parser.parse_args()

    if args.solve != (args.output is not None):
        parser.error("--solve and --output must be supplied together")
    case = make_case(args.cpw, args.refinement, args.half_length_nm, args.box_half_width_nm,
                     args.yig_epsilon_r, args.frequency_hz, args.load_ohm, args.axial_refinement,
                     args.output_return)
    if args.solve:
        _solve(case, args.output, args.sample_step_nm, args.model)
    else:
        report = preflight(case)
        report.update(planned_model=args.model, execution="mesh_preflight_only")
        print(json.dumps(report, allow_nan=False, indent=2))


if __name__ == "__main__":
    main()
