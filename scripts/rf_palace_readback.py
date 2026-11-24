"""Import the pinned Palace driven-probe CSV output as SI complex vector fields."""
from __future__ import annotations

import argparse
import csv
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
from scipy.constants import mu_0

from rf_cpw_reference import MATERIAL_NAMES
from rf_palace_current import (
    CENTER_QUADRATURE_NAME, QUADRATURE_NAME, integrate_center_current, integrate_terminal_currents,
)
from rf_palace_preflight import PALACE_REVISION

CONVENTION = "peak, exp(+i omega t)"
SIGNAL_CURRENT_DEFINITION = "total current entering the signal strip in +x at the input plane"
UNITS = {"E": "V/m", "B": "Wb/m²"}


def read_driven_vector(path, field, probe_ids, frequency_hz, *, excitation=1):
    """Read one frequency and excitation in the requested probe order."""
    if field not in UNITS or type(excitation) is not int or excitation < 1:
        raise ValueError("Expected E or B with a positive integer excitation index")
    probe_ids = tuple(probe_ids)
    if not probe_ids or len(set(probe_ids)) != len(probe_ids):
        raise ValueError("Probe indices must be nonempty and unique")
    with Path(path).open(encoding="utf-8", newline="") as stream:
        rows = csv.reader(stream)
        header = [cell.strip() for cell in next(rows, [])]
        if "f (GHz)" not in header or len(header) != len(set(header)):
            raise ValueError(f"{path} requires unique columns and f (GHz)")
        units = UNITS[field]
        has_explicit_excitation = any("][" in label for label in header)
        suffix = f"[{excitation}]" if has_explicit_excitation else ""
        labels = [
            f"{phase}{{{field}_{axis}[{index}]{suffix}}} ({units})"
            for index in probe_ids for axis in "xyz" for phase in ("Re", "Im")
        ]
        lookup = {name: i for i, name in enumerate(header)}
        missing = [name for name in labels if name not in lookup]
        if missing:
            raise ValueError(f"{path} lacks required complex probe columns: {missing[:3]}")
        columns = [lookup[label] for label in labels]
        frequency_column = lookup["f (GHz)"]
        matched = None
        for row in rows:
            if not row:
                continue
            if len(row) != len(header):
                raise ValueError(f"{path} has an incomplete record")
            freq = float(row[frequency_column])*1e9
            if np.isclose(freq, frequency_hz, rtol=5e-9, atol=0):
                if matched is not None:
                    raise ValueError(f"{path} has more than one row at frequency {frequency_hz:g} Hz")
                matched = [float(row[i]) for i in columns]
    if matched is None:
        raise ValueError(f"{path} lacks requested frequency {frequency_hz:g} Hz")
    values = np.asarray(matched).reshape(len(probe_ids), 3, 2)
    if not np.all(np.isfinite(values)):
        raise ValueError(f"{path} contains a nonfinite probe field")
    return values[...,0] + 1j*values[...,1]


def file_sha(path):
    return sha256(path.read_bytes()).hexdigest()


def load_current(path, frequency, magnetic_sha):
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if (receipt.get("frequency_hz") != frequency
            or receipt.get("phasor_convention") != CONVENTION
            or receipt.get("probe_b_sha256") != magnetic_sha
            or receipt.get("definition") != SIGNAL_CURRENT_DEFINITION
            or not isinstance(receipt.get("provenance"), str)
            or not receipt["provenance"].strip()):
        raise ValueError("Current receipt must match the field data, frequency, phase and reference section")
    parts = np.asarray(receipt["reference_current_a"], dtype=float)
    if parts.shape != (2,) or not np.isfinite(parts).all() or not np.any(parts):
        raise ValueError("Expected a finite nonzero complex peak current in amperes")
    return complex(*parts), receipt["provenance"]


def import_run(deck, results, output, current=None):
    deck, results, output = map(Path,(deck,results,output))
    preflight = json.loads((deck/"manifest.json").read_text(encoding="utf-8"))
    if preflight["solver"] != "Palace" or preflight["palace_revision"] != PALACE_REVISION:
        raise ValueError("Unsupported Palace input contract revision")
    expected = preflight["sha256"]
    files = ("cpw.msh","probes_xyz_m.csv","palace.json")
    has_quadrature = preflight.get("terminal_quadrature") == QUADRATURE_NAME
    if has_quadrature:
        files += (QUADRATURE_NAME,)
    has_center = preflight.get("center_quadrature") == CENTER_QUADRATURE_NAME
    if has_center:
        files += (CENTER_QUADRATURE_NAME,)
    input_hashes = {name:file_sha(deck/name) for name in files}
    if input_hashes != expected:
        raise ValueError("Palace input hashes differ from the pinned preflight")
    config = json.loads((deck/"palace.json").read_text(encoding="utf-8"))
    if config["Problem"]["Type"] != "Driven" or any(
        material["Permeability"] != 1 for material in config["Domains"]["Materials"]
    ):
        raise ValueError("CPW readback supports driven fields with scalar unit relative permeability")
    excitations = {p["Excitation"] for p in config["Boundaries"]["WavePort"] if p.get("Excitation")}
    if len(excitations) != 1:
        raise ValueError("Expected one declared wave-port excitation")
    excitation, = excitations
    probes = sorted(config["Domains"]["Postprocessing"]["Probe"],key=lambda p:p["Index"])
    ids = tuple(p["Index"] for p in probes)
    xyz = config["Model"]["L0"]*np.asarray([p["Center"] for p in probes],dtype=float)
    manifest_points = np.loadtxt(deck/"probes_xyz_m.csv",delimiter=",",skiprows=1,ndmin=2)
    if (xyz.shape != manifest_points.shape or xyz.shape != (len(ids),3)
            or not np.isfinite(xyz).all() or not np.allclose(xyz,manifest_points,rtol=1e-15,atol=0)):
        raise ValueError("Palace probe centres differ from archived SI coordinates")
    frequency = preflight["frequency_hz"]
    e_path, b_path = (results/f"probe-{field}.csv" for field in ("E","B"))
    count = preflight.get("observation_probe_count",len(ids))
    if type(count) is not int or not 0 < count <= len(ids):
        raise ValueError("Invalid observation-probe count")
    terminal_count = preflight.get("terminal_probe_count",0)
    center_count = preflight.get("center_probe_count",0)
    if (type(terminal_count) is not int or type(center_count) is not int
            or terminal_count<0 or center_count<0 or count+terminal_count+center_count!=len(ids)
            or has_quadrature != (terminal_count>0) or has_center != (center_count>0)):
        raise ValueError("Inconsistent Palace current-probe groups")
    e = read_driven_vector(e_path,"E",ids,frequency,excitation=excitation)
    b = read_driven_vector(b_path,"B",ids[:count],frequency,excitation=excitation)
    h = b/mu_0
    arrays = {"probe_xyz_m": xyz[:count], "probe_indices": ids[:count], "probe_E_Vpm": e[:count],
              "probe_B_T": b, "probe_H_Apm": h}
    manifest = {
        "source": "independent Palace solver probe readout",
        "requested_palace_revision": PALACE_REVISION,
        "normalized_basis_status": "unresolved",
        "evidence_status": "requires_mode_and_boundary_qualification",
        "phasor_convention": CONVENTION,
        "cpw": preflight["cpw"], "frequency_hz": frequency,
        "excitation_index": excitation, "mode_index": preflight["mode_index"],
        "input_file_sha256": input_hashes,
        "result_file_sha256": {path.name:file_sha(path) for path in (e_path,b_path)},
        "permeability_h_per_m": mu_0,
    }
    value, provenance = None, None
    if has_center or has_quadrature:
        if config["Solver"]["Order"] != 2:
            raise ValueError("Current probes require the order-two tetrahedral field")
        copper_attribute = MATERIAL_NAMES.index("copper") + 1
        copper, = (m for m in config["Domains"]["Materials"] if copper_attribute in m["Attributes"])
    terminal = slice(count,count+terminal_count)
    if has_quadrature:
        with np.load(deck/QUADRATURE_NAME,allow_pickle=False) as q:
            if not np.array_equal(q["xyz_m"],xyz[terminal]):
                raise ValueError("Terminal quadrature points differ from the declared probes")
            currents = integrate_terminal_currents(
                q["terminal_index"],q["weight_m2"],e[terminal,0],copper["Conductivity"],
                copper["Permittivity"],frequency)
        arrays.update(terminal_probe_xyz_m=xyz[terminal], terminal_probe_E_Vpm=e[terminal])
        manifest.update(terminal_currents_a_positive_x=currents,
                        terminal_probe_count=terminal_count)
        value = complex(*currents["signal_input"]["total_a"])
        if value == 0:
            value = None
        provenance = "One-sided quadratic integration of the same-run copper signal input"
    if has_center:
        central = slice(count+terminal_count,len(ids))
        with np.load(deck/CENTER_QUADRATURE_NAME,allow_pickle=False) as q:
            if not np.array_equal(q["xyz_m"],xyz[central]):
                raise ValueError("Central quadrature points differ from the declared probes")
            manifest["center_conduction"] = integrate_center_current(q,e[central,0],copper["Conductivity"])
        manifest["center_probe_count"] = center_count
        arrays.update(center_probe_xyz_m=xyz[central], center_probe_E_Vpm=e[central])
    if current is not None:
        path = Path(current)
        value, provenance = load_current(path, frequency, manifest["result_file_sha256"][b_path.name])
        manifest["reference_current_sha256"] = file_sha(path)
    if value is not None:
        normalized = h/value
        if not np.isfinite(normalized).all():
            raise ValueError("Nonfinite normalized magnetic field")
        arrays["probe_H_over_I_per_m"] = normalized
        manifest.update(
            normalized_basis_status="provisional", reference_current_a=[value.real,value.imag],
            reference_current_provenance=provenance,
        )
    output.mkdir(parents=True, exist_ok=False)
    np.savez(output/"fields.npz",**arrays)
    (output/"manifest.json").write_text(json.dumps(manifest,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deck",type=Path,required=True)
    parser.add_argument("--results",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--reference-current",type=Path,help="Matching complex signal current receipt")
    args = parser.parse_args()
    print(json.dumps(import_run(args.deck,args.results,args.output,args.reference_current),indent=2))


if __name__=="__main__":
    main()

