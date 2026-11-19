"""Closed r0 fixed-M iteration diagnostic; never a common-v3 comparison."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import boris_nf_common_case_v3 as common

PROFILE = "fixed-m-iterations-1248"
SCHEMA = "fullmag.boris_nf.fixed-m-iterations.v1"
INPUT_SCHEMA = SCHEMA + ".input"
EXIT_PROTOCOL = SCHEMA + ".pinned-headless-exit"
MARKER = "BORIS_NF_FIXED_M_ITERATIONS_COMPLETE"
COUNTS = (1, 2, 4, 8)
CHANGE_PAIRS = ((1, 2), (2, 4), (4, 8))
SOLVER_TIMEOUT_SECONDS = common.SOLVER_TIMEOUT_SECONDS
SOURCE_PINS = {
    'BorisLib/VEC_VC_Solve.h': '78bbb6299e439adc8b3772d75377d52d17926ddb0c1190dd2ec8898ec0886333',
    'Boris/STransport_Spin_GInterf.cpp': '14bed66bcc76af171dc9f2f15f7185cb6a34eb210ba996728a378021d46429cb',
    'Boris/Transport_Spin.cpp': '910e5304cb4a2645b6cdcf349eb30e77c7e278df64f2c68d871687e993d3cf8f',
    'Boris/STransport.h': 'eb4073d3dc6646d404ca1d84a4faa34035ac819751a73b743b1427043cd43498',
    'Boris/STransport_Spin.cpp': '2634586f2d09a12b3f858c4276dfff76e9b03650eac276e4ec8c3b24a73980bb',
    "Boris/Simulation.cpp": "affb2a00ab135f331b8aff7ec7b6b49a616b47ec18162098a5b17f69b693a21c",
    "Boris/SimulationData.cpp": "e4ba6c1acedc906e9f4f07096298399b5e2a29190de03593c09cf822ecfd48c0",
    "NetSocks.py": "4246d87c2c561062ade40d0946ccd044bd1933fb65c542dbe30cfb6b12b10016",
}
RAW_FIELDS = tuple(prefix + "_" + name + ".ovf" for prefix in ("n", "f")
    for name in ("V", "S", "Jc", "Jsx", "Jsy", "Jsz")) + (
    "f_M_before.ovf", "f_M_after.ovf", "f_Ts.ovf", "f_Tsi.ovf")


def family_binding(binding, tools_sha, worker_sha):
    return dict(schema=SCHEMA + ".family", native_binding=binding,
        tools_manifest_sha256=tools_sha, worker_sha256=worker_sha,
        descriptor_sha256=common.canonical_hash(descriptor()))


def descriptor():
    return dict(schema=SCHEMA + ".case", base_case=common.case_descriptor("r0"),
        command_counts=list(COUNTS), absolute_changes=dict(
            schema=SCHEMA+".absolute-changes.v1", pairs=[list(p) for p in CHANGE_PAIRS],
            reduction="per-domain component max absolute delta; x-fast first maximum",
            normalization=None, qualification_gate=None), native_counter_tokens=["v_iter", "s_iter", "ts_err"],
        counter_scope="last native block; initialization block count unknown; not cumulative",
        coupled_residual=dict(status="unavailable", value=None,
            reason="no final coupled V/S plus CMBND native-interface witness"),
        text_payload_precision=6, below_text_resolution="unresolved, never convergence",
        physics_qualified=False, comparison_v3=False)


def fixed_inputs(case_key="r0"):
    if case_key != "r0":
        raise ValueError("Iteration diagnostic is fixed to r0")
    case = descriptor()
    base = common.render_script(case["base_case"])
    anchor = 'ferromagnet.quant.M.saveovf2("text", str(output/"f_M_before.ovf"))\n'
    if base.count(anchor) != 1:
        raise ValueError("Pinned common rendering anchor differs")
    prefix = base.split(anchor)[0]
    # Reuse the existing owner's exact raw field exports, with a different output root.
    from boris_nf_interface_smoke import _field_exports
    exports = _field_exports()
    script = prefix + 'root = output\n' + anchor.replace('output/', 'root/')
    script += 'ns.statictransportsolver(0)\nsnapshots = []\n'
    script += 'for command_count in range(1, 9):\n    ns.computefields()\n'
    script += '    if command_count not in (1, 2, 4, 8):\n        continue\n'
    script += '    output = root / ("snapshot-" + str(command_count))\n    output.mkdir()\n'
    script += '    (output/"f_M_before.ovf").write_bytes((root/"f_M_before.ovf").read_bytes())\n'
    script += '    ferromagnet.quant.M.saveovf2("text", str(output/"f_M_after.ovf"))\n'
    script += ''.join('    ' + line + '\n' for line in exports.splitlines())
    script += '    counters = {key:ns.showdata("conductor", key) for key in ("v_iter","s_iter","ts_err")}\n'
    script += '    snapshots.append({"command_count":command_count,"native_counters":counters})\n'
    script += 'readbacks = {"dataprecision":observed_dataprecision}\n'
    script += 'for label,mesh,params in (("normal","conductor",scenario["parameters"]["boris_normal"]),("ferromagnet","ferromagnet",scenario["parameters"]["boris_ferromagnet"])):\n'
    script += '    readbacks[label] = {name:ns.setparam(mesh,name) for name in params}\n'
    script += 'readbacks["transport_config"] = ns.tsolverconfig()\nreadbacks["spin_config"] = ns.ssolverconfig()\n'
    script += 'readbacks["potential_v"] = ns.setpotential()\n'
    script += '(root/"diagnostic-native.json").write_text(json.dumps({"schema":' + repr(SCHEMA + '.native') + ',"scenario":' + repr(case) + ',"readbacks":readbacks,"snapshots":snapshots},sort_keys=True,allow_nan=False),encoding="utf-8")\n'
    script += 'print(' + repr(MARKER) + ',flush=True)\n'
    return case, script.encode(), (json.dumps(case,sort_keys=True,indent=2,allow_nan=False)+"\n").encode()


def verify_source_contract(proof):
    common.verify_source_contract(proof)
    entries = proof["original_source"]["files"]
    if any([entry.get("sha256") for entry in entries if entry.get("path") == name] != [sha]
           for name,sha in SOURCE_PINS.items()):
        raise ValueError("Diagnostic native counter source differs")


def output_closure(root):
    import fullmag_storage as storage
    allowed = {"f_M_before.ovf", "diagnostic-native.json", "runtime_probe.json",
               "solver.stdout.log", "solver.stderr.log"}
    allowed |= {"snapshot-"+str(count)+"/"+name for count in COUNTS for name in RAW_FIELDS}
    entries = []
    total = 0
    for path in sorted(root.rglob("*")):
        if any(storage.is_link(p) for p in (path,*path.parents)):
            raise ValueError("Diagnostic output alias refused")
        if path.is_dir():
            if path.relative_to(root).as_posix() not in {"snapshot-"+str(v) for v in COUNTS}:
                raise ValueError("Unknown diagnostic directory")
            continue
        relative = path.relative_to(root).as_posix()
        if relative == "diagnostic.json":
            continue  # Independently validated below, never included in its own hash.
        if relative not in allowed or not path.is_file() or path.stat().st_size > 8 << 20:
            raise ValueError("Diagnostic output membership/size differs")
        raw = path.read_bytes(); total += len(raw)
        if total > 64 << 20 or len(entries) >= 80:
            raise ValueError("Diagnostic closed output budget exceeded")
        entries.append(dict(path=relative,sha256=hashlib.sha256(raw).hexdigest(),size_bytes=len(raw)))
    if {v["path"] for v in entries} != allowed:
        raise ValueError("Diagnostic snapshot missing; partial is not complete")
    return entries


def absolute_field_changes(before, after, before_count, after_count):
    """Exact-carrier text-sample differences; no convergence or tolerance claim."""
    if (type(before_count) is not int or type(after_count) is not int
            or (before_count, after_count) not in CHANGE_PAIRS):
        raise ValueError("Diagnostic change pair/order differs")
    kappa = common.finite(common.case_descriptor("r0")["conventions"]["kappa_m2_per_s"])
    if kappa <= 0:
        raise ValueError("Diagnostic existing conversion differs")
    by_domain = {}
    for domain in ("normal", "ferromagnet"):
        carriers = []
        # Validate every mandatory carrier and scalar BEFORE any subtraction.
        for snapshot in (before, after):
            fields = snapshot[domain]
            reference = fields["V"]
            shape = tuple(reference.shape)
            if len(shape) != 3 or any(type(n) is not int or n < 1 for n in shape):
                raise ValueError("Diagnostic field shape differs")
            carrier = (shape, tuple(reference.origin_m), tuple(reference.step_m))
            if len(carrier[1]) != 3 or len(carrier[2]) != 3:
                raise ValueError("Diagnostic field carrier differs")
            for value in (*carrier[1], *carrier[2]):
                common.finite(value)
            if any(v <= 0 for v in carrier[2]):
                raise ValueError("Diagnostic field step differs")
            count = shape[0] * shape[1] * shape[2]
            for name in ("V", "S", "Jc", "Jsx", "Jsy", "Jsz"):
                field = fields[name]
                width = 1 if name == "V" else 3
                if ((tuple(field.shape), tuple(field.origin_m), tuple(field.step_m)) != carrier
                        or type(field.valuedim) is not int or field.valuedim != width
                        or len(field.values) != count):
                    raise ValueError("Diagnostic field carrier/count differs")
                if (not isinstance(field.sha256, str) or len(field.sha256) != 64
                        or any(v not in "0123456789abcdef" for v in field.sha256)):
                    raise ValueError("Diagnostic raw SHA differs")
                for row in field.values:
                    if len(row) != width:
                        raise ValueError("Diagnostic component count differs")
                    for value in row:
                        common.finite(value)
            carriers.append(carrier)
        if carriers[0] != carriers[1]:
            raise ValueError("Diagnostic snapshots have different carriers/order")
        shape = carriers[0][0]
        quantities = {}
        for quantity, unit, components in (("V", "V", 1), ("S", "A/m", 3),
                                            ("Jc", "A/m^2", 3), ("Q", "A/m^2", 9)):
            rows = []
            for component in range(components):
                name = ("Jsx", "Jsy", "Jsz")[component // 3] if quantity == "Q" else quantity
                column = component % 3 if quantity == "Q" else component
                scale = kappa if quantity == "Q" else 1.0
                left, right = before[domain][name], after[domain][name]
                maximum = -1.0
                maximum_index = 0
                observed_before = observed_after = 0.0
                for index, (a, z) in enumerate(zip(left.values, right.values)):
                    av = common.finite(a[column] / scale)
                    zv = common.finite(z[column] / scale)
                    delta = common.finite(abs(zv - av))
                    observed_before = max(observed_before, abs(av))
                    observed_after = max(observed_after, abs(zv))
                    if delta > maximum:
                        maximum, maximum_index = delta, index
                nx, ny, _ = shape
                entry = dict(component=component, maximum_absolute_delta=maximum,
                    cell_index=maximum_index,
                    cell_ijk=[maximum_index % nx, (maximum_index // nx) % ny, maximum_index // (nx * ny)],
                    before_raw_sha256=left.sha256, after_raw_sha256=right.sha256,
                    maximum_absolute_value_before=observed_before,
                    maximum_absolute_value_after=observed_after)
                if quantity == "Q":
                    entry.update(flow_axis=component // 3, spin_axis=component % 3)
                rows.append(entry)
            quantities[quantity] = dict(unit=unit, components=rows)
        by_domain[domain] = dict(shape=list(shape), origin_m=list(carriers[0][1]),
            step_m=list(carriers[0][2]), cell_order="x-fast", quantities=quantities)
    return dict(schema=SCHEMA+".absolute-changes.v1", before_command_count=before_count,
        after_command_count=after_count, by_domain=by_domain,
        interpretation="text6 observed changes only; zero is not convergence")


def validate_outputs(root, case, proof, binding):
    import run_managed_boris_nf as legacy
    if case != descriptor():
        raise ValueError("Diagnostic case differs")
    verify_source_contract(proof)
    entries = output_closure(root)
    native = legacy.read_json(root/"diagnostic-native.json", 1 << 20)
    if set(native) != {"schema","scenario","readbacks","snapshots"} or native["schema"] != SCHEMA+".native" or native["scenario"] != case:
        raise ValueError("Diagnostic native contract differs")
    reads = native["readbacks"]
    if set(reads) != {"dataprecision","normal","ferromagnet","transport_config","spin_config","potential_v"}:
        raise ValueError("Diagnostic readback membership differs")
    common.validate_material_readbacks(reads,case["base_case"])
    for key in ("transport_config","spin_config"):
        common.close_vector(reads[key],[common.PARAMETERS["transport_tolerance"],common.PARAMETERS["transport_max_iterations"]])
    common.close_vector(reads["potential_v"],common.VOLTAGE_V)
    probe = legacy.read_json(root/"runtime_probe.json",8192)
    if (probe.get("solver_exit_protocol") != EXIT_PROTOCOL or type(probe.get("solver_exit_code")) is not int
            or probe["solver_exit_code"] not in (0,-15) or probe.get("binary_sha256") != proof["binary_sha256"]):
        raise ValueError("Diagnostic actual native exit/proof differs")
    stdout = (root/"solver.stdout.log").read_text(encoding="utf-8")
    if [v for v in stdout.splitlines() if MARKER in v] != [MARKER]:
        raise ValueError("Diagnostic final marker missing or duplicated")
    embedded = [json.loads(v.split(":",1)[1]) for v in stdout.splitlines() if v.startswith("BORIS_EMBEDDED_IDENTITY:")]
    if embedded != [dict(python_version=probe.get("embedded_python_version"))] or not isinstance(probe.get("embedded_python_version"),str) or not probe["embedded_python_version"]:
        raise ValueError("Diagnostic embedded interpreter differs")
    if not isinstance(native["snapshots"],list) or len(native["snapshots"]) != len(COUNTS):
        raise ValueError("Diagnostic snapshot count differs")
    observations = []
    changes = []
    previous_fields = previous_count = None
    for count,row in zip(COUNTS,native["snapshots"]):
        if set(row) != {"command_count","native_counters"} or type(row["command_count"]) is not int or row["command_count"] != count:
            raise ValueError("Diagnostic snapshot order differs")
        counters = row["native_counters"]
        if set(counters) != {"v_iter","s_iter","ts_err"}:
            raise ValueError("Diagnostic counters differ")
        for key in ("v_iter","s_iter"):
            v=common.finite(counters[key])
            if int(v) != v or not 1 <= v <= 200:
                raise ValueError("Diagnostic actual block iteration count differs")
        if common.finite(counters["ts_err"]) < 0:
            raise ValueError("Diagnostic actual iterate error is negative")
        fields = common.read_fields(root/("snapshot-"+str(count)),case["base_case"])
        fixed_native = dict(readbacks=reads,fixed_m=dict(schema_version="fullmag.boris_fixed_m.v1",M_before="f_M_before.ovf",
            M_after="f_M_after.ovf",l_J_readback_m=reads["ferromagnet"]["l_J"],execution_mode="fixed_m_transport_only"))
        fixed = common.fixed_m_observation(fields,fixed_native,case["base_case"])
        if fixed["M_before_sha256"] != hashlib.sha256((root/"f_M_before.ovf").read_bytes()).hexdigest():
            raise ValueError("Diagnostic initial-M copy differs")
        gate = "observed_pass_not_qualification"
        try:
            common.check_affine_x_invariance(fields,voltage_v=common.VOLTAGE_V,length_x_m=common.PHYSICAL_GEOMETRY["length_x_m"],origin_x_m=0.0,voltage_at_xmin_v=-common.VOLTAGE_V/2)
        except ValueError as error:
            gate = "refused: " + str(error)
        if previous_fields is not None:
            changes.append(absolute_field_changes(previous_fields, fields, previous_count, count))
        previous_fields, previous_count = fields, count
        observations.append(dict(command_count=count,native_counters=counters,
            cap_hit={key:counters[key]==200 for key in ("v_iter","s_iter")},fixed_m=fixed,existing_scope_gate=gate))
    summary = dict(schema=SCHEMA,native=binding,scenario=case,status="diagnostic_complete_unqualified",
        snapshots=observations,absolute_field_changes=changes,raw_outputs=entries,raw_outputs_sha256=common.canonical_hash(entries),
        coupled_residual=case["coupled_residual"],below_text_resolution="unresolved",
        physics_qualified=False,comparison_v3=False)
    if (root/"diagnostic.json").exists() and legacy.read_json(root/"diagnostic.json",1 << 20) != summary:
        raise ValueError("Diagnostic summary differs from independent raw readback")
    if output_closure(root) != entries:
        raise ValueError("Diagnostic raw outputs changed during independent readback")
    return entries,probe,summary

def worker():
    import fullmag_storage as storage
    from local_runner import boris_cpu as boris
    import run_managed_boris_nf as legacy
    if os.name != "posix" or Path(__file__).resolve() != Path("/tools/scripts/boris_nf_iteration_diagnostic.py"):
        raise ValueError("BORIS common worker requires its fixed managed path")
    inputs = legacy.read_json(Path("/input/run_input.json"))
    if set(inputs) != {"schema","case_key","binding","tools_manifest_sha256","family_binding","previous_capacity"} or inputs["schema"] != INPUT_SCHEMA:
        raise ValueError("BORIS common closed worker input differs")
    if inputs["previous_capacity"] is not None:
        raise ValueError("Diagnostic has no common-case capacity predecessor")
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
    entries,_,summary = validate_outputs(Path("/export"),descriptor,proof,inputs["binding"])
    storage.atomic_json(Path("/export/diagnostic.json"),summary)
    print(json.dumps(dict(schema=SCHEMA+".closure",outputs=entries)),flush=True)
