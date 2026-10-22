"""Versioned fixed-domain BORIS common case and raw observations; no solver qualification."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

from verify_boris_nf_interface import (MeshFields, ScenarioParameters, compute_field_residuals,
    compute_interface_balance, compute_interface_slice, read_text_ovf)

FIXED_M_EXECUTION = dict(mode="fixed_m_transport_only", ode="LLGStatic-SA", transport_call="computefields",
    static_transport=False, magnetization_relative_tolerance=1.0e-6,
    magnetization_absolute_tolerance_apm=1.0e-6, l_J_relative_tolerance=1.0e-6)
CASE_SCHEMA = "fullmag.boris_nf_common.case.v3"
NATIVE_SCHEMA = "fullmag.boris_nf_common.native.v3"
SUMMARY_SCHEMA = "fullmag.boris_nf_common.summary.v3"
CLOSURE_SCHEMA = "fullmag.boris_nf_common.output_closure.v3"
EXIT_PROTOCOL = "fullmag.boris_nf_common.pinned-headless-exit.v3"
MARKER = "BORIS_NF_COMMON_V3_STAGE_COMPLETE"
ELECTRODES_BEGIN = "BORIS_NF_COMMON_V3_ELECTRODES_BEGIN"
ELECTRODES_END = "BORIS_NF_COMMON_V3_ELECTRODES_END"
CASE_KEYS = ("r0", "r1", "r2")
RESOLUTIONS = CASE_KEYS
SHAPES = {"r0": (4, 100, 2), "r1": (4, 200, 4), "r2": (4, 400, 8)}
PHYSICAL_GEOMETRY = dict(length_x_m=1.0e-6, length_y_m=4.0e-7,
    normal_thickness_m=2.0e-9, ferromagnet_thickness_m=2.0e-9)
VOLTAGE_V = 1.0e11 * PHYSICAL_GEOMETRY["length_x_m"] / 5.8e7
OBSERVATION_RELATIVE_TOLERANCE = 1.0e-6
READBACK_DATA_PRECISION = 17
SOLVER_TIMEOUT_SECONDS = 180
RUNTIME_TIMEOUT_SECONDS = 240
RESOURCE_LIMITS = dict(cpus=2, memory_bytes=2 << 30, pids=128, tmpfs_bytes=256 << 20,
    solver_timeout_seconds=SOLVER_TIMEOUT_SECONDS, runtime_timeout_seconds=RUNTIME_TIMEOUT_SECONDS)
PARAMETERS = dict(
    boris_normal=dict(elC=5.8e7, De=0.01, SHA=0.1, iSHA=0.1, l_sf=5.0e-9,
        Gi=[0.0, 0.0], Gmix=[0.0, 0.0]),
    boris_ferromagnet=dict(Ms=8.0e5, A=1.3e-11, damping=0.02, elC=5.8e7, De=0.01,
        SHA=0.0, l_sf=5.0e-9, l_J=2.0e-9, l_phi=4.0e-9,
        P=0.4, betaD=0.4, beta=0.01, Gi=[5.0e14, 0.0], Gmix=[1.5e15, 0.0]),
    fullmag_normal=dict(conductivity_spm=5.8e7, de_m2_per_s=0.01, theta_sh=-0.1,
        lambda_sf_m=5.0e-9, polarization_p=0.0),
    fullmag_ferromagnet=dict(conductivity_spm=5.8e7, de_m2_per_s=0.01, theta_sh=0.0,
        lambda_sf_m=5.0e-9, lambda_j_m=2.0e-9, lambda_phi_m=4.0e-9,
        polarization_p=-0.4, saturation_magnetization_apm=8.0e5),
    fullmag_interface=dict(g_up_spm2=0.0, g_down_spm2=5.0e14,
        g_mix_real_spm2=1.5e15, g_mix_imag_spm2=0.0),
    magnetization=[1.0, 0.0, 0.0], transport_tolerance=1.0e-5, transport_max_iterations=200)


def canonical_hash(value):
    return hashlib.sha256((json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(",",":"))+"\n").encode()).hexdigest()


def case_descriptor(case_key):
    if case_key not in CASE_KEYS:
        raise ValueError("BORIS common case must be r0, r1 or r2")
    nx, ny, nz = SHAPES[case_key]
    lx, ly = PHYSICAL_GEOMETRY["length_x_m"], PHYSICAL_GEOMETRY["length_y_m"]
    tn, tf = PHYSICAL_GEOMETRY["normal_thickness_m"], PHYSICAL_GEOMETRY["ferromagnet_thickness_m"]
    return dict(schema_version=CASE_SCHEMA, case_key=case_key, workload="N/F common operator",
        family="fixed-domain-affine-x-4x100x4-4x200x8-4x400x16.v1",
        physical_geometry=dict(PHYSICAL_GEOMETRY), parameters=json.loads(json.dumps(PARAMETERS)),
        geometry=dict(normal_shape=[nx, ny, nz], ferromagnet_shape=[nx, ny, nz],
            cell_m=[lx/nx, ly/ny, tn/nz], normal_origin_m=[0.0, 0.0, 0.0],
            ferromagnet_origin_m=[0.0, 0.0, tn], normal_extent_m=[lx, ly, tn],
            ferromagnet_extent_m=[lx, ly, tf], interface_normal="+z",
            fullmag_minus_boris_translation_m=[-lx/2, -ly/2, -(tn+tf)/2]),
        boundary=dict(control="fixed_voltage", voltage_v=VOLTAGE_V, normal_axis="x",
            boris_electrode_count=2, boris_xmin_potential_v=-VOLTAGE_V/2,
            boris_xmax_potential_v=VOLTAGE_V/2, fullmag_xmin_potential_v=0.0,
            fullmag_xmax_potential_v=VOLTAGE_V,
            fullmag_minus_boris_potential_offset_v=VOLTAGE_V/2,
            spin_xterminals="homogeneous_normal_spin_potential_gradient",
            spin_other_faces="total_spin_current_normal_zero"),
        execution=dict(FIXED_M_EXECUTION), resource_limits=dict(RESOURCE_LIMITS),
        observation_gate=dict(relative_tolerance=OBSERVATION_RELATIVE_TOLERANCE,
            zero_scale="exact_zero", voltage_scale="fixed_voltage_v", field_scale="actual_max_vector_norm",
            scope="raw geometry/affine/x-invariance observation; not mesh or physics qualification"),
        conventions=dict(spin_mapping="mu_s=2*De*S/(sigma*kappa), Q=Js/kappa", kappa_m2_per_s=5.788381608e-5,
            spin_current_component_order="flow-major Jsx,Jsy,Jsz; each vector is spin polarization",
            material_readback_contract=dict(schema="fullmag.boris_nf_common.material-readback.v1",
                upstream_commit="048503d2ca6475e91b073eb1762ecf9d3634c3e1",
                ferromagnet_iSHA=dict(status="not_applicable_unsupported_mesh_parameter",
                    numeric_substitution=False,
                    source_registry="Boris/SimSharedData.cpp::params_for_meshtype[MESH_FERROMAGNETIC]",
                    source_realization="Boris/Transport_Spin.cpp::Transport::IterateSpinSolver_Charge_SOR")),
            serialization=dict(schema="fullmag.boris_nf_common.serialization.v1",
                dataprecision=READBACK_DATA_PRECISION, scope="socket replies and ToString OVF headers; not solver precision",
                ovf_text_payload="upstream ostream default precision; unaffected by dataprecision",
                source="Boris/OVF2_Handlers.cpp::OVF2::Write_OVF2_VEC/Write_OVF2_SCA"),
            interface_normal="N +z to F -z", torque_comparable=False,
            terminal_physical_current="cell quadrature of actual full Jc on every x section; not electrode face integral"),
        qualification="NOT VERIFIED")


def fixed_inputs(case_key):
    descriptor = case_descriptor(case_key)
    raw = (json.dumps(descriptor, sort_keys=True, indent=2, allow_nan=False)+"\n").encode()
    return descriptor, render_script(descriptor).encode(), raw


def render_script(descriptor):
    if descriptor != case_descriptor(descriptor.get("case_key")):
        raise ValueError("BORIS common descriptor differs")
    from boris_nf_interface_smoke import _field_exports
    g = descriptor["geometry"]
    nx, ny, nz = g["normal_shape"]
    lx, ly, tn = g["normal_extent_m"]
    tf = g["ferromagnet_extent_m"][2]
    return f'''# Generated common case v3; inputs are separate from the immutable native build.
import json
import sys
from pathlib import Path
from NetSocks import NSClient

print("BORIS_EMBEDDED_IDENTITY:"+json.dumps({{"python_version":sys.version}}), flush=True)
output = Path("/export")
scenario = {descriptor!r}
ns = NSClient()
ns.configure(reset_to_default=True, script_verbose=True)
ns.dataprecision({READBACK_DATA_PRECISION!r})
observed_dataprecision = ns.dataprecision()
if type(observed_dataprecision) not in (int, float) or observed_dataprecision != {READBACK_DATA_PRECISION!r}:
    raise ValueError("BORIS actual data serialization precision differs")
conductor = ns.Conductor([0.0,0.0,0.0,{lx!r},{ly!r},{tn!r}], {g["cell_m"]!r}, "conductor")
ferromagnet = ns.Ferromagnet([0.0,0.0,{tn!r},{lx!r},{ly!r},{tn+tf!r}], {g["cell_m"]!r}, "ferromagnet")
conductor.modules("transport")
ferromagnet.modules("transport")
ferromagnet.ecellsize({g["cell_m"]!r})
for mesh, params in (("conductor",scenario["parameters"]["boris_normal"]),
                     ("ferromagnet",scenario["parameters"]["boris_ferromagnet"])):
    for name, value in params.items():
        ns.setparam(mesh, name, value)
ferromagnet.setangle(90.0, 0.0)
ns.setode("LLGStatic-SA", "Euler")
ns.tsolverconfig({PARAMETERS["transport_tolerance"]!r}, {PARAMETERS["transport_max_iterations"]!r})
ns.ssolverconfig({PARAMETERS["transport_tolerance"]!r}, {PARAMETERS["transport_max_iterations"]!r})
ns.setdefaultelectrodes("x")
ns.setpotential({VOLTAGE_V!r})
ferromagnet.quant.M.saveovf2("text", str(output/"f_M_before.ovf"))
ns.statictransportsolver(0)
ns.computefields()
ferromagnet.quant.M.saveovf2("text", str(output/"f_M_after.ovf"))
{_field_exports()}

# These are native readbacks; no requested value is substituted for a reply.
readbacks = {{"dataprecision":observed_dataprecision}}
for label, mesh, params in (("normal","conductor",scenario["parameters"]["boris_normal"]),
                            ("ferromagnet","ferromagnet",scenario["parameters"]["boris_ferromagnet"])):
    readbacks[label] = {{name:ns.setparam(mesh,name) for name in params}}
readbacks["transport_config"] = ns.tsolverconfig()
readbacks["spin_config"] = ns.ssolverconfig()
readbacks["potential_v"] = ns.setpotential()
readbacks["electrode_potentials_v"] = [ns.setelectrodepotential(0),ns.setelectrodepotential(1)]
readbacks["native_corrected_ground_and_net_sigmaE_a"] = ns.setcurrent()
print({ELECTRODES_BEGIN!r}, flush=True)
ns.electrodes()
print({ELECTRODES_END!r}, flush=True)
native = {{"schema_version":{NATIVE_SCHEMA!r}, "scenario":scenario, "stage_complete":True,
    "readbacks":readbacks,
    "fixed_m":{{"schema_version":"fullmag.boris_fixed_m.v1", "M_before":"f_M_before.ovf",
        "M_after":"f_M_after.ovf", "l_J_readback_m":readbacks["ferromagnet"]["l_J"],
        "execution_mode":"fixed_m_transport_only"}},
    "fields":sorted(path.name for path in output.glob("*.ovf"))}}
(output/"boris_native_samples.json").write_text(json.dumps(native,sort_keys=True,indent=2,allow_nan=False),encoding="utf-8")
print({MARKER!r}, flush=True)
'''


def finite(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("BORIS actual observation must be a finite number")
    return float(value)


def close_vector(actual, expected, *, relative=OBSERVATION_RELATIVE_TOLERANCE):
    left = actual if isinstance(actual, (list, tuple)) else [actual]
    right = expected if isinstance(expected, (list, tuple)) else [expected]
    if len(left) != len(right) or any(not math.isclose(finite(a), finite(b), rel_tol=relative, abs_tol=0.0)
                                    for a, b in zip(left, right)):
        raise ValueError("BORIS actual native readback differs from the preregistered input")


def read_fields(root, descriptor):
    result = {}
    for label, prefix in (("normal", "n"), ("ferromagnet", "f")):
        names = ("V", "S", "Jc", "Jsx", "Jsy", "Jsz") + (("Ts", "Tsi", "M_before", "M_after") if prefix == "f" else ())
        result[label] = {}
        g = descriptor["geometry"]
        for name in names:
            field = read_text_ovf(root/f"{prefix}_{name}.ovf")
            expected_dim = 1 if name == "V" else 3
            expected_layout = (*g[label+"_origin_m"], *g["cell_m"])
            if (field.shape != tuple(g[label+"_shape"]) or field.valuedim != expected_dim
                    or any(not math.isclose(a,b,rel_tol=1.0e-12,abs_tol=1.0e-18)
                           for a,b in zip((*field.origin_m,*field.step_m),expected_layout))):
                raise ValueError("BORIS actual OVF carrier/origin/dimension differs")
            result[label][name] = field
    return result


def check_affine_x_invariance(fields, *, voltage_v, length_x_m, origin_x_m, voltage_at_xmin_v):
    """Check actual cells against the preregistered affine family, without fitting."""
    voltage_v, length_x_m = finite(voltage_v), finite(length_x_m)
    if voltage_v <= 0 or length_x_m <= 0:
        raise ValueError("Positive fixed voltage and length required")
    by_mesh = {}
    for label, payload in fields.items():
        voltage = payload["V"]
        error = max(abs(row[0] - (voltage_at_xmin_v + voltage_v *
            (voltage.origin_m[0]+(i % voltage.shape[0]+0.5)*voltage.step_m[0]-origin_x_m)/length_x_m))
            for i,row in enumerate(voltage.values))
        if error > OBSERVATION_RELATIVE_TOLERANCE * voltage_v:
            raise ValueError("BORIS actual voltage is not the preregistered affine field")
        checks = {}
        for name in ("S", "Jc", "Jsx", "Jsy", "Jsz"):
            field = payload[name]; nx,ny,nz = field.shape
            scale = max(math.sqrt(sum(v*v for v in row)) for row in field.values)
            spread = max(math.sqrt(sum((a-b)**2 for a,b in zip(field.values[i+nx*(j+ny*k)],
                         field.values[nx*(j+ny*k)]))) for k in range(nz) for j in range(ny) for i in range(nx))
            if spread > OBSERVATION_RELATIVE_TOLERANCE * scale:
                raise ValueError("BORIS actual field violates preregistered x invariance")
            checks[name] = dict(maximum_x_difference=spread, actual_max_vector_norm=scale,
                                relative_difference=spread/scale if scale else 0.0)
        by_mesh[label] = dict(maximum_affine_voltage_error_v=error, x_invariance=checks)
    return dict(status="observed", relative_tolerance=OBSERVATION_RELATIVE_TOLERANCE,
                fitted_parameters=False, by_mesh=by_mesh)


def _si(text, unit):
    match = re.fullmatch(r"\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:([fpnumkMGTµμ]?)"+re.escape(unit)+r")?\s*",text)
    if match is None:
        raise ValueError("BORIS native console SI value differs from pinned format")
    factors = {"f":1e-15,"p":1e-12,"n":1e-9,"u":1e-6,"µ":1e-6,"μ":1e-6,"m":1e-3,"k":1e3,"M":1e6,"G":1e9,"T":1e12}
    return finite(float(match[1]) * factors.get(match[2],1.0))


def electrode_observation(stdout, readbacks, descriptor):
    lines = stdout.splitlines()
    if lines.count(ELECTRODES_BEGIN) != 1 or lines.count(ELECTRODES_END) != 1:
        raise ValueError("BORIS actual electrode console readback is missing/duplicated")
    start,end = lines.index(ELECTRODES_BEGIN),lines.index(ELECTRODES_END)
    if not start < end:
        raise ValueError("BORIS electrode readback markers are reversed")
    rows = [line.strip() for line in lines[start+1:end] if line.strip()]
    if len(rows) != 3 or rows[0] != "Using":
        raise ValueError("BORIS actual electrode count/readback differs")
    parsed = []
    for line in rows[1:]:
        match = re.fullmatch(r"Electrode rectangle (.+) Potential (.+) Grnd", line)
        if match is None:
            raise ValueError("BORIS actual electrode row differs")
        coordinates = re.split(r"\s*[,;]\s*", match[1])
        if len(coordinates) != 6:
            raise ValueError("BORIS electrode rectangle must contain six coordinates")
        parsed.append(dict(rectangle_m=[_si(value,"m") for value in coordinates], potential_v=_si(match[2],"V")))
    physical = descriptor["physical_geometry"]
    lx,ly = physical["length_x_m"],physical["length_y_m"]
    total_z = physical["normal_thickness_m"]+physical["ferromagnet_thickness_m"]
    expected = ([0,0,0,0,ly,total_z],[lx,0,0,lx,ly,total_z])
    potentials = [-VOLTAGE_V/2,VOLTAGE_V/2]
    for index,row in enumerate(parsed):
        close_vector(row["rectangle_m"],expected[index])
        # Console formatting has finite display precision; numeric socket readback is authoritative.
        if abs(row["potential_v"]-potentials[index]) > OBSERVATION_RELATIVE_TOLERANCE*VOLTAGE_V:
            raise ValueError("BORIS actual electrode console potential differs")
    close_vector(readbacks["electrode_potentials_v"],potentials)
    pair = readbacks["native_corrected_ground_and_net_sigmaE_a"]
    if not isinstance(pair,list) or len(pair) != 2:
        raise ValueError("BORIS native corrected-ground/net readback must contain two values")
    corrected,net = map(finite,pair)
    return dict(actual_electrode_count=2, electrodes=parsed,
        ground=dict(index=0, method="indirect: actual negative-half potential under pinned SetPotential/adjust_potential",
                    direct_native_ground_flag_available=False),
        native_corrected_ground_sigmaE_a=corrected, native_net_sigmaE_a=net,
        reconstructed_raw_ground_sigmaE_a=corrected+net/2,
        reconstruction="corrected_ground + actual_net/actual_electrode_count; not an independent raw electrode API",
        native_flux_scope="sigma*E only; excludes reciprocal display-Jc contributions",
        native_net_balance=dict(absolute_a=abs(net), relative=abs(net)/max(abs(corrected),abs(net)) if max(abs(corrected),abs(net)) else 0.0,
                               status="observed; no qualification threshold or forced cancellation"),
        outward_normals=dict(x_min=[-1,0,0],x_max=[1,0,0]))


def section_currents(fields):
    by_mesh = {}; nx = fields["normal"]["Jc"].shape[0]
    for label,payload in fields.items():
        field = payload["Jc"]; sx,ny,nz = field.shape
        if sx != nx:
            raise ValueError("BORIS section x grids differ")
        area = field.step_m[1]*field.step_m[2]
        currents = [sum(field.values[i+nx*(j+ny*k)][0]*area for k in range(nz) for j in range(ny)) for i in range(nx)]
        by_mesh[label] = dict(cell_face_area_m2=area, section_area_m2=area*ny*nz, section_current_a=currents)
    total = [sum(item["section_current_a"][i] for item in by_mesh.values()) for i in range(nx)]
    scale = max(abs(v) for v in total)
    return dict(method="actual full-Jc cell quadrature; not native face/electrode integral", units="A",
        x_cell_centers_m=[fields["normal"]["Jc"].origin_m[0]+(i+0.5)*fields["normal"]["Jc"].step_m[0] for i in range(nx)],
        by_mesh=by_mesh, total_section_current_a=total, section_spread_a=max(total)-min(total),
        relative_section_spread=(max(total)-min(total))/scale if scale else 0.0,
        terminal_outward_cell_quadrature_a=dict(x_min=-total[0],x_max=total[-1]),
        boundary_integral_available=False, independent_native_net_used_for_sigmaE_balance=True)


SOURCE_PINS = {
    "Boris/Commands.h": "f1230a092c76a5acbce0707b698fd057d626b22b71587d05f5a308e7f0e4e311",
    "NetSocks.py": "4246d87c2c561062ade40d0946ccd044bd1933fb65c542dbe30cfb6b12b10016",
    "Boris/Commands.cpp": "30e7f625c1a5c4c841a87f840fb41dde098153ef2efdd9051093547162d0bf08",
    "Boris/Commands_PythonScripting.cpp": "d7e1eaf2e141cbc0c66cf1a7f0a391470760e709d301c880e43457ec504def47",
    "Boris/STransport.cpp": "86f34c0724409f42086a65dedd5779a3dd3a8d4fc3e084f7ca1e2c84747417d9",
    "Boris/TransportBase.cpp": "af4617f8e712e0ab16c1141a30425911af4fd6544d00b06df630f646ae42d163",
    "Boris/Transport.cpp": "13adf748f02f9e1fda47c6208b4637e1f1dfa9e439c045d7bd87318e4c43681c",
    "Boris/Transport_Charge_Display.cpp": "bfeb99fcc112470f2bdc541d70cccc10fb9896a8b02922905b091763af398669",
    "Boris/Transport_Spin_Display.cpp": "fefbc95a5c8f0b95611302dd2a992b3aae8e903c10a9631b53b332b2c905d791",
    "Boris/BorisIOGenerators.cpp": "e1d7bf39ffa9e20388cc0bddb9f1d481e542ede6b8e15a3b99bad69641f78559",
    "Boris/BorisIO_Make.h": "435b788975341dbc0d147cb14512d076b747cd8033f6520aa87e107ee9395ba0",
    "Boris/BorisDisplayNonGraphical.cpp": "4651ebe11456288a3795edf5948f520f47b4b8a230dc1e72e29feb2d981c4948",
    "BorisLib/Types_Rect.h": "d38c951ceb36bb8aa2b57a67d57bb875a74bc522296f5b4fe6febbb35772d15a",
    "BorisLib/Types_Conversion.h": "61263349c765f6dbc8ba1e2fa40ebae02e955d3ee2a288da9054a4c39f9df6d7",
}


def verify_source_contract(proof):
    original = proof.get("original_source", {})
    entries = original.get("files", [])
    if (original.get("upstream_commit") != "048503d2ca6475e91b073eb1762ecf9d3634c3e1"
            or any([e.get("sha256") for e in entries if isinstance(e,dict) and e.get("path") == name] != [sha]
                   for name,sha in SOURCE_PINS.items())):
        raise ValueError("BORIS common operator/readback/normal-exit pinned source differs")


def family_binding(binding, tools_sha256, worker_sha256):
    return dict(schema="fullmag.boris_nf_common.capacity-family.v3", native_binding=binding,
        tools_manifest_sha256=tools_sha256, worker_sha256=worker_sha256,
        parameter_set_sha256=canonical_hash(PARAMETERS), physical_geometry_sha256=canonical_hash(PHYSICAL_GEOMETRY),
        fixed_family_shapes={key:list(shape) for key,shape in SHAPES.items()}, resource_limits=dict(RESOURCE_LIMITS))


def fixed_m_observation(fields, native, descriptor):
    fixed = native.get("fixed_m")
    expected = dict(schema_version="fullmag.boris_fixed_m.v1", M_before="f_M_before.ovf",
        M_after="f_M_after.ovf", l_J_readback_m=native["readbacks"]["ferromagnet"]["l_J"],
        execution_mode="fixed_m_transport_only")
    if fixed != expected:
        raise ValueError("BORIS common fixed-M native readback differs")
    before,after = fields["ferromagnet"]["M_before"],fields["ferromagnet"]["M_after"]
    ms = finite(native["readbacks"]["ferromagnet"]["Ms"])
    maximum_before = max(abs(v-(ms if axis == 0 else 0.0)) for row in before.values for axis,v in enumerate(row))
    maximum_after = max(abs(v-(ms if axis == 0 else 0.0)) for row in after.values for axis,v in enumerate(row))
    maximum_change = max(abs(a-b) for left,right in zip(before.values,after.values) for a,b in zip(left,right))
    tolerance = FIXED_M_EXECUTION["magnetization_absolute_tolerance_apm"]+FIXED_M_EXECUTION["magnetization_relative_tolerance"]*ms
    if max(maximum_before,maximum_after,maximum_change) > tolerance:
        raise ValueError("BORIS common all-F-cell fixed-M gate failed")
    return dict(schema_version="fullmag.boris_fixed_m.proof.v1", M_before_sha256=before.sha256,
        M_after_sha256=after.sha256, sample_count=len(before.values), maximum_before_error_apm=maximum_before,
        maximum_after_error_apm=maximum_after, maximum_change_apm=maximum_change, l_J_readback_m=fixed["l_J_readback_m"])


def validate_material_readbacks(readbacks, descriptor):
    # This is data serialization precision, never the solver's floating-point type.
    precision = readbacks.get("dataprecision")
    if type(precision) not in (int, float) or finite(precision) != READBACK_DATA_PRECISION:
        raise ValueError("BORIS actual data serialization precision differs")
    for label in ("normal","ferromagnet"):
        expected = descriptor["parameters"]["boris_"+label]
        if not isinstance(readbacks[label],dict) or set(readbacks[label]) != set(expected):
            raise ValueError("BORIS common material readback membership differs")
        for name,value in expected.items():
            close_vector(readbacks[label][name],value)


def raw_observations(root, descriptor):
    import run_managed_boris_nf as legacy
    if descriptor != case_descriptor(descriptor.get("case_key")):
        raise ValueError("BORIS common scenario differs")
    entries = legacy.output_closure(root)
    members = {entry["path"]:entry["sha256"] for entry in entries}
    native = legacy.read_json(root/"boris_native_samples.json",expected_sha256=members["boris_native_samples.json"])
    if (set(native) != {"schema_version","scenario","stage_complete","readbacks","fixed_m","fields"}
            or native.get("schema_version") != NATIVE_SCHEMA or native.get("scenario") != descriptor
            or native.get("stage_complete") is not True or native.get("fields") != sorted(legacy.RAW_FIELDS)):
        raise ValueError("BORIS common actual native stage differs")
    readbacks = native["readbacks"]
    expected_keys = {"normal","ferromagnet","dataprecision","transport_config","spin_config","potential_v",
                     "electrode_potentials_v","native_corrected_ground_and_net_sigmaE_a"}
    if not isinstance(readbacks,dict) or set(readbacks) != expected_keys:
        raise ValueError("BORIS common native readback membership differs")
    validate_material_readbacks(readbacks,descriptor)
    for key in ("transport_config","spin_config"):
        close_vector(readbacks[key],[PARAMETERS["transport_tolerance"],PARAMETERS["transport_max_iterations"]])
    close_vector(readbacks["potential_v"],VOLTAGE_V)
    fields = read_fields(root,descriptor)
    for label,prefix in (("normal","n"),("ferromagnet","f")):
        if any(field.sha256 != members[f"{prefix}_{name}.ovf"] for name,field in fields[label].items()):
            raise ValueError("BORIS parsed OVF bytes differ from the closed raw outputs")
    stdout_bytes = (root/"solver.stdout.log").read_bytes()
    if hashlib.sha256(stdout_bytes).hexdigest() != members["solver.stdout.log"]:
        raise ValueError("BORIS native console changed during raw observation")
    affine = check_affine_x_invariance(fields,voltage_v=VOLTAGE_V,
        length_x_m=PHYSICAL_GEOMETRY["length_x_m"],origin_x_m=0.0,voltage_at_xmin_v=-VOLTAGE_V/2)
    fixed = fixed_m_observation(fields,native,descriptor)
    current = dict(native_sigmaE=electrode_observation(stdout_bytes.decode("utf-8"),readbacks,descriptor),
                   full_jc_cell_quadrature=section_currents(fields))
    parameters = ScenarioParameters(5.8e7,0.01,5e-9,2e-9,4e-9,(1.0,0.0,0.0))
    by_mesh = {}; mesh_fields = {}
    for label in ("normal","ferromagnet"):
        f = fields[label]
        mesh_fields[label] = MeshFields(f["Jc"],f["Jsx"],f["Jsy"],f["Jsz"],f["S"])
        count = math.prod(max(n-2,0) for n in f["Jc"].shape)
        by_mesh[label] = (dict(status="available", **compute_field_residuals(mesh_fields[label],parameters,material=label))
            if count else dict(status="unavailable",interior_cell_count=0,reason="no_bulk_interior_cells",
                               charge_scaled_l2=None,spin_scaled_l2=None))
    available = all(item["status"] == "available" for item in by_mesh.values())
    residuals = dict(status="available" if available else "unavailable", by_mesh=by_mesh,
        charge_scaled_l2=max(item["charge_scaled_l2"] for item in by_mesh.values()) if available else None,
        spin_scaled_l2=max(item["spin_scaled_l2"] for item in by_mesh.values()) if available else None,
        physics_qualified=False, numerical_tolerance_is_not_a_qualification_threshold=True)
    interface = compute_interface_slice(mesh_fields["normal"],mesh_fields["ferromagnet"],fields["ferromagnet"]["Tsi"],normal_axis="z",normal_sign=1)
    balances = dict(compute_interface_balance(interface),normal="N +z to F -z",physics_qualified=False,
        torque_comparable=False,scope="raw adjacent-cell diagnostic; not an independent native interface-face flux")
    return dict(raw_outputs_sha256=canonical_hash(entries), fixed_m=fixed, material_readbacks=readbacks,
        grid=dict(actual_raw_carriers=True,geometry=descriptor["geometry"],storage_order="x-fast"),
        affine_and_x_invariant=affine, current=current, residuals=residuals, interface_balances=balances)


def validate_outputs(root, descriptor, proof):
    import run_managed_boris_nf as legacy
    verify_source_contract(proof)
    probe = legacy.read_json(root/"runtime_probe.json",8192)
    if (probe.get("solver_exit_protocol") != EXIT_PROTOCOL or type(probe.get("solver_exit_code")) is not int
            or probe["solver_exit_code"] not in (0,-15)):
        raise ValueError("BORIS common actual raw exit protocol differs")
    entries = legacy.output_closure(root)
    stdout = (root/"solver.stdout.log").read_text(encoding="utf-8")
    if [line for line in stdout.splitlines() if MARKER in line] != [MARKER]:
        raise ValueError("BORIS common final marker missing/malformed/duplicated")
    embedded = [json.loads(line.split(":",1)[1]) for line in stdout.splitlines() if line.startswith("BORIS_EMBEDDED_IDENTITY:")]
    if embedded != [dict(python_version=probe.get("embedded_python_version"))] or not isinstance(probe.get("embedded_python_version"),str) or not probe["embedded_python_version"]:
        raise ValueError("BORIS common actual embedded interpreter differs")
    observations = raw_observations(root,descriptor)
    legacy.require_fixed_m_members(observations["fixed_m"],entries)
    if observations["raw_outputs_sha256"] != canonical_hash(entries):
        raise ValueError("BORIS common raw closure changed during independent observation")
    return entries,probe,observations


def artifact_summary(root, descriptor, identity, retained_outputs):
    import run_managed_boris_nf as legacy
    observations = raw_observations(root,descriptor)
    legacy.require_fixed_m_members(observations["fixed_m"],retained_outputs)
    if observations["raw_outputs_sha256"] != canonical_hash(retained_outputs):
        raise ValueError("BORIS common summary parsed bytes differ from retained outputs")
    return dict(schema_version=SUMMARY_SCHEMA,runtime=dict(identity),scenario=descriptor,
        case_sha256=canonical_hash(descriptor), fields={label:{name:f"{prefix}_{name}.ovf" for name in
            (("V","S","Jc","Jsx","Jsy","Jsz")+(("Ts","Tsi") if prefix=="f" else ()))}
            for label,prefix in (("normal","n"),("ferromagnet","f"))},
        fixed_m_proof=observations["fixed_m"], residuals=observations["residuals"],
        interface_balances=observations["interface_balances"],observables=observations,
        qualification=dict(status="NOT VERIFIED",physics_qualified=False,mesh_converged=False,
            capacity_raw_completion_only=descriptor["case_key"]=="r0",torque_comparable=False))


def _worker():
    import fullmag_storage as storage
    from local_runner import boris_cpu as boris
    import run_managed_boris_nf as legacy
    if os.name != "posix" or Path(__file__).resolve() != Path("/tools/scripts/boris_nf_common_case_v3.py"):
        raise ValueError("BORIS common worker requires its fixed managed path")
    inputs = legacy.read_json(Path("/input/run_input.json"))
    if set(inputs) != {"schema","case_key","binding","tools_manifest_sha256","family_binding","previous_capacity"} or inputs["schema"] != "fullmag.boris_nf_common.input.v3":
        raise ValueError("BORIS common closed worker input differs")
    descriptor,script,scenario = fixed_inputs(inputs["case_key"])
    if Path("/input/scenario.py").read_bytes() != script or Path("/input/scenario.json").read_bytes() != scenario:
        raise ValueError("BORIS common frozen authoring input differs")
    actual_tools_sha = legacy.digest(Path("/tools/manifest.json"))
    if (inputs["tools_manifest_sha256"] != actual_tools_sha
            or inputs["family_binding"] != family_binding(inputs["binding"],actual_tools_sha,legacy.digest(Path(__file__)))):
        raise ValueError("BORIS common worker/tools/family binding differs")
    manifest = legacy.read_json(Path("/tools/manifest.json"))
    if (set(manifest) != {"schema","solver_capsule_attribution","files"}
            or manifest.get("schema") != "fullmag.boris.runtime-tools.v1" or manifest.get("solver_capsule_attribution") is not False
            or not isinstance(manifest.get("files"),dict) or not 1 <= len(manifest["files"]) <= 64
            or any(not isinstance(name,str) or not name.startswith("scripts/") or "\\" in name or ":" in name
                   or any(part in ("", ".", "..") for part in name.split("/")) for name in manifest["files"])
            or any(legacy.digest(Path("/tools")/name) != sha for name,sha in manifest["files"].items())):
        raise ValueError("BORIS common captured tools changed")
    proof = boris.load_manifest(Path("/boris/source_manifest.json"))
    if proof != inputs["binding"]["boris_build_proof"] or legacy.digest(Path("/boris/BorisLin")) != proof["binary_sha256"]:
        raise ValueError("BORIS common actual native binary/build proof differs")
    verify_source_contract(proof)
    boris.verify_source(boris.SOURCE_ROOT,boris.load_manifest(boris.SOURCE_MANIFEST))
    if boris.load_manifest(boris.SOURCE_MANIFEST) != proof["original_source"]:
        raise ValueError("BORIS common installed upstream source differs")
    import numpy,matplotlib
    version = subprocess.run(["/boris/BorisLin","-version"],capture_output=True,text=True,timeout=15,check=True)
    if "BORIS" not in version.stdout+version.stderr:
        raise ValueError("BORIS common actual version probe missing")
    with Path("/export/solver.stdout.log").open("x") as out,Path("/export/solver.stderr.log").open("x") as err:
        completed = subprocess.run(["/boris/BorisLin","-s","/input/scenario.py","-g","-1"],stdout=out,stderr=err,
            timeout=SOLVER_TIMEOUT_SECONDS,check=False)
    if Path("/export/solver.stdout.log").stat().st_size > 64 << 20:
        raise ValueError("BORIS common actual stdout exceeds bound")
    stdout = Path("/export/solver.stdout.log").read_text(encoding="utf-8")
    embedded = [json.loads(line.split(":",1)[1]) for line in stdout.splitlines() if line.startswith("BORIS_EMBEDDED_IDENTITY:")]
    embedded_python = embedded[0].get("python_version") if len(embedded)==1 and isinstance(embedded[0],dict) else None
    if legacy.digest(Path("/boris/BorisLin")) != proof["binary_sha256"]:
        raise ValueError("BORIS common binary changed during execution")
    storage.atomic_json(Path("/export/runtime_probe.json"),dict(binary_sha256=proof["binary_sha256"],
        binary_version=(version.stdout+version.stderr).strip(),external_python_version=sys.version,
        embedded_python_version=embedded_python,solver_exit_code=completed.returncode,solver_exit_protocol=EXIT_PROTOCOL,
        device="cpu",precision_abi=boris.load_manifest(Path("/boris/cpu_abi_witness.json")),
        numpy_version=numpy.__version__,matplotlib_version=matplotlib.__version__))
    entries,_,_ = validate_outputs(Path("/export"),descriptor,proof)
    print(json.dumps(dict(schema=CLOSURE_SCHEMA,outputs=entries)),flush=True)


_LOADED_SOURCE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


if __name__ == "__main__":
    if sys.argv[1:] != ["_worker"]:
        raise ValueError("BORIS common worker accepts only its fixed action")
    _worker()
