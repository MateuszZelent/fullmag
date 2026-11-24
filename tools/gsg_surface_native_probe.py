"""Private retained-GSG numerical probe; never publishes an accepted field."""
from __future__ import annotations

import ctypes as C
from fractions import Fraction
import hashlib
import math
import struct


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def pack_rt0(cells, faces, expected_cells, expected_vertices):
    """Pack existing canonical moments, without substituting saved/display J."""
    require(len(cells) == expected_cells * 280 and len(faces) % 32 == 0,
            "RT0 carrier lengths differ")
    moments, usage, vertices = {}, {}, {}
    previous = None
    for a, b, c, moment in struct.iter_unpack("<3Qd", faces):
        key = (a, b, c)
        require(a < b < c and (previous is None or previous < key) and math.isfinite(moment),
                "Canonical faces are duplicate, unordered or nonfinite")
        moments[key] = moment
        usage[key] = [0, 0]
        previous = key
    frozen = bytearray(expected_cells * 128)
    winding = ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1))
    for ordinal, row in enumerate(struct.iter_unpack("<5Q30d", cells)):
        ids, xyz = row[1:5], row[5:17]
        require(row[0] == ordinal and len(set(ids)) == 4 and all(map(math.isfinite, xyz)),
                "Source ordinal, vertex identity or coordinates differ")
        points = []
        for i, vertex in enumerate(ids):
            point = tuple(xyz[3*i:3*i+3])
            bits = struct.pack("<3d", *point)
            if vertex not in vertices:
                vertices[vertex] = (bits, tuple(map(Fraction.from_float, point)))
            require(vertices[vertex][0] == bits, "Stable vertex has inconsistent coordinates")
            points.append(vertices[vertex][1])
        edges = [tuple(p[k]-points[0][k] for k in range(3)) for p in points[1:]]
        a, b, c = edges
        determinant = (a[0]*(b[1]*c[2]-b[2]*c[1]) -
                       a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0]))
        require(determinant > 0, "Source Tet4 is degenerate or negatively oriented")
        coefficients = []
        for local in winding:
            ordered = tuple(ids[i] for i in local)
            inversions = sum(ordered[i] > ordered[j] for i in range(3) for j in range(i+1,3))
            key = tuple(sorted(ordered))
            require(key in moments, "Missing canonical RT0 face moment")
            sign = -1 if inversions % 2 else 1
            oriented = -moments[key] if sign == -1 else moments[key]
            coefficient = 2.0 * oriented
            require(math.isfinite(coefficient) and struct.pack("<d", coefficient*.5) == struct.pack("<d", oriented),
                    "Face moment scaling is not exactly reversible")
            coefficients.append(coefficient)
            usage[key][0] += 1
            usage[key][1] += sign
        struct.pack_into("<16d", frozen, ordinal*128, *xyz, *coefficients)
    require(len(vertices) == expected_vertices, "Stable vertex count differs")
    require(all(n == 1 or (n == 2 and signs == 0) for n, signs in usage.values()),
            "Unused, nonmanifold or inconsistently oriented canonical face")
    return bytes(frozen), {"source_cells": expected_cells, "vertices": len(vertices),
                           "canonical_faces": len(moments), "frozen_bytes": len(frozen),
                           "frozen_sha256": digest(frozen)}


U32, U64, D = C.c_uint32, C.c_uint64, C.c_double


class Limits(C.Structure):
    _fields_ = [("total", U64*14), ("per_target", U64*14),
                ("maximum_raw_integer_bits", U64), ("maximum_reduced_fraction_bits", U64),
                ("maximum_lifetime_peak_rss_bytes", U64), ("guard_interval_events", U64),
                ("maximum_total_seconds", D), ("maximum_target_seconds", D)]


class Tolerances(C.Structure):
    _fields_ = [(name, D) for name in (
        "absolute_field_apm", "relative_field", "cancellation_floor_apm",
        "scalar_relative_80", "scalar_relative_120", "angle_relative_80", "angle_relative_120",
        "binary_scalar_epsilon_factor", "binary_roundoff_epsilon_factor",
        "binary_cancellation_limit", "highprecision_cancellation_limit")]


class Options(C.Structure):
    _fields_ = [("work_limits", Limits), ("tolerances", Tolerances), ("policy_version", C.c_char_p)]


class Frozen(C.Structure):
    _fields_ = [("vertices_m", D*12), ("signed_coefficients_a", D*4)]


class Request(C.Structure):
    _fields_ = [("abi_version", U32), ("reserved_flags", U32), ("struct_size", U64),
                ("execution_lane", C.c_int), ("reserved", U32), ("source", C.POINTER(Frozen)),
                ("source_count", U64), ("target_points_xyz", C.POINTER(D)), ("target_points_xyz_len", U64),
                ("source_view_identity_digest", C.c_char_p), ("accepted_source_state_digest", C.c_char_p),
                ("options", Options)]


class Result(C.Structure):
    _fields_ = [("abi_version", U32), ("reserved_flags", U32), ("struct_size", U64),
                ("h_xyz_apm", C.POINTER(D)), ("h_xyz_apm_capacity", U64), ("h_xyz_apm_len", U64),
                ("evidence_json", C.POINTER(C.c_uint8)), ("evidence_json_capacity", U64),
                ("evidence_json_len", U64), ("error_message", C.c_char*256)]


class Profile(C.Structure):
    _fields_ = [("abi_version", U32), ("reserved_flags", U32), ("struct_size", U64),
                ("available", U64), ("accounting_issue", U64), ("operator_wall_time_ns", U64),
                ("phase_wall_time_ns", U64*9)]


def abi_sizes():
    return {cls.__name__: C.sizeof(cls) for cls in (Limits,Tolerances,Options,Frozen,Request,Result,Profile)}


def evidence_json(raw):
    import json
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "Duplicate JSON key")
            value[key] = item
        return value
    def constant(value):
        raise ValueError("Nonfinite JSON constant: " + value)
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant,
                      parse_int=lambda value: -0.0 if value == "-0" else int(value))


def compare_reference(h, reference):
    from decimal import Decimal, localcontext
    require(len(h) == len(reference) == 3 and all(map(math.isfinite,h)), "Invalid H vector")
    with localcontext() as ctx:
        ctx.prec = 120
        a = list(map(Decimal.from_float,h))
        b = list(map(Decimal,reference))
        require(all(x.is_finite() for x in b), "Nonfinite reference")
        norm = sum(x*x for x in b).sqrt()
        error = sum((x-y)**2 for x,y in zip(a,b)).sqrt()
        gate = Decimal("1e-9") + Decimal("1e-5")*norm
        historical = Decimal("1e-3")*(Decimal(1)+norm)
        return {"difference_norm_apm":str(error),"reference_norm_apm":str(norm),
                "gate_apm":str(gate),"within_gate":error <= gate,
                "historical_gate_apm":str(historical),"within_historical_gate":error <= historical}


SOURCE = "/opt/fullmag/source"
CONTROL = "/opt/fullmag/control/verification/gsg-full-source-surface-native-20261115/one-approved-attempt"
DESIGN = ".superpowers/sdd/2026-11-13-retained-dtq-public-field-proposal/full-gsg-native-experiment-20261115/"
DESIGN_SHA = "71280d4f14fa16ea3bc660108eb9895a65e3d142a9b178af2ab13d2d42ec269f"
POLICY_SHA = "3a1f606f192f05ec40499d2d833b22f0ed89f1168a68dfbdb9ba7cb0ea649124"
FLAGS = {"private_numerical_probe":True, "accepted_parent_verified":False,
         "inspection_only":True, "error_certificate_available":False,
         "qualified_basis":False, "new_solve":False}


def checked(path, expected_sha, maximum):
    from pathlib import Path
    import stat
    path = Path(path)
    require(path.resolve(strict=True) == path, "Noncanonical input path")
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum, "Input size/type differs")
    raw = path.read_bytes()
    after = path.stat()
    attributes = ("st_dev","st_ino","st_size","st_mtime_ns","st_ctime_ns")
    require(all(getattr(before,k) == getattr(after,k) for k in attributes) and digest(raw) == expected_sha,
            "Input changed or hash differs: " + str(path))
    return raw


def source_path(relative):
    from pathlib import Path, PurePosixPath
    value = PurePosixPath(relative)
    require(not value.is_absolute() and str(value) == relative and
            all(part not in (".","..") for part in value.parts), "Invalid source-relative path")
    return Path(SOURCE) / relative


def read_bundle(path, expected_sha):
    import stat
    require(path.resolve(strict=True) == path, "Noncanonical bundle")
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and 20 <= before.st_size <= 512*1024*1024, "Bundle size/type differs")
    whole = hashlib.sha256()
    kept = {}
    wanted = {"cells","faces","vertex_xyz","stable_vertex_ids","sample_xyz","sample_cells","h_raw"}
    with path.open("rb") as stream:
        def take(count):
            raw = stream.read(count)
            require(len(raw) == count, "Truncated bundle")
            whole.update(raw)
            return raw
        header = take(20)
        require(header[:8] == b"FMACLB01", "Bundle framing differs")
        length, count = struct.unpack_from("<QI",header,8)
        require(0 < length <= 16*1024*1024 and 0 < count <= 256, "Bundle header bounds differ")
        manifest = evidence_json(take(length))
        require(manifest["schema_version"] == "antenna_field_solution.v2" and
                manifest["status"] == "inspection_only", "Bundle family differs")
        descriptors = {v["path"]:(key,v) for key,v in manifest["payloads"].items()}
        require(len(descriptors) == len(manifest["payloads"]) == count and
                wanted <= manifest["payloads"].keys(), "Bundle closure differs")
        previous = ""
        for _ in range(count):
            n = struct.unpack("<H",take(2))[0]
            require(0 < n <= 1024, "Payload path bound differs")
            name = take(n).decode("ascii")
            size = struct.unpack("<Q",take(8))[0]
            require(name > previous and name in descriptors, "Unordered or foreign payload")
            key, descriptor = descriptors[name]
            require(name == f"antenna/field_solutions/{manifest['solution_id']}/{key}.bin" and
                    0 < size == descriptor["byte_length"] <= before.st_size, "Payload descriptor differs")
            out = bytearray() if key in wanted else None
            hasher = hashlib.sha256()
            remaining = size
            while remaining:
                raw = take(min(1024*1024,remaining))
                remaining -= len(raw)
                hasher.update(raw)
                if out is not None:
                    out.extend(raw)
            require(hasher.hexdigest() == descriptor["sha256"], "Payload digest differs: " + key)
            if out is not None:
                kept[key] = bytes(out)
            previous = name
        require(stream.read(1) == b"", "Trailing bundle bytes")
    after = path.stat()
    require(all(getattr(before,k) == getattr(after,k) for k in
                ("st_dev","st_ino","st_size","st_mtime_ns","st_ctime_ns")) and
            whole.hexdigest() == expected_sha, "Bundle changed or hash differs")
    return manifest, kept


def load_inputs(request):
    ir = evidence_json(checked(source_path(request["source_ir"]["path"]),request["source_ir"]["sha256"],12*1024*1024))
    manifest, data = read_bundle(source_path(request["source_bundle"]["path"]),request["source_bundle"]["sha256"])
    scope = request["scope"]
    require(scope["cells"] == 85980 and scope["vertex_count"] == 23263 and
            scope["canonical_face_count"] == 188926 and scope["target_indices"] == [0,8,16], "Approved source scope differs")
    current = ir["current_modules"][0]
    source = current["conservative_current_source"]
    ids = source["stable_vertex_ids"]
    mesh = next(a["mesh"] for a in ir["geometry_assets"]["fem_mesh_assets"]
                if a["geometry_name"] == source["geometry_id"])
    target = ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
    require(manifest["cell_count"] == scope["cells"] and manifest["vertex_count"] == len(ids) == scope["vertex_count"],
            "Source carrier counts differ")
    require(manifest["source_object_id"] == source["object_id"] and
            manifest["current_transport_id"] == current["name"] and manifest["full_closure"] == source["closure"],
            "Stored source identity differs")
    require(manifest["source"]["accepted_source_state_digest"] == request["source_state_sha256"] and
            struct.pack("<d",manifest["source"]["source_current_a"]) == struct.pack("<d",1.7551508469637155e-5),
            "Stored signed source state/current differs")
    require(data["stable_vertex_ids"] == struct.pack("<"+"Q"*len(ids),*ids) and
            data["vertex_xyz"] == b"".join(struct.pack("<3d",*p) for p in mesh["nodes"]), "Source vertices differ from IR")
    connectivity = mesh["cells"]
    require(connectivity["types"] == ["tet4"]*scope["cells"] and
            connectivity["offsets"] == list(range(0,scope["cells"]*4+1,4)), "IR Tet4 layout differs")
    for i,row in enumerate(struct.iter_unpack("<5Q30d",data["cells"])):
        local = [ids[j] for j in connectivity["nodes"][4*i:4*i+4]]
        require(sorted(local) == sorted(row[1:5]), "Cell identity differs from IR")
        # Coordinates are checked below against a stable-ID map, without a nodal J field.
    by_id = dict(zip(ids,mesh["nodes"]))
    for row in struct.iter_unpack("<5Q30d",data["cells"]):
        require(all(struct.pack("<3d",*row[5+3*j:8+3*j]) == struct.pack("<3d",*by_id[vertex])
                    for j,vertex in enumerate(row[1:5])), "Cell coordinates differ from IR")
    require(len(target["nodes"]) == manifest["target_count"] == 20 and
            data["sample_xyz"] == b"".join(struct.pack("<3d",*p) for p in target["nodes"]) and
            data["sample_cells"] == struct.pack("<"+"I"*len(target["cells"]["nodes"]),*target["cells"]["nodes"]),
            "Target carrier differs from IR")
    frozen, packing = pack_rt0(data["cells"],data["faces"],scope["cells"],scope["vertex_count"])
    require(packing["canonical_faces"] == scope["canonical_face_count"] and
            packing["frozen_sha256"] == scope["frozen_sha256"], "Packed source differs from independent readback")
    indices = scope["target_indices"]
    xyz = b"".join(data["sample_xyz"][24*i:24*(i+1)] for i in indices)
    references = []
    require([r["target_index"] for r in request["references"]] == indices, "Reference order differs")
    for record, point in zip(request["references"],struct.iter_unpack("<3d",xyz)):
        value = evidence_json(checked(source_path(record["path"]),record["sha256"],1024*1024))
        i = record["target_index"]
        require(value["target_index"] == i and value["cells_completed"] == scope["cells"] and
                struct.pack("<3d",*value["position_m"]) == struct.pack("<3d",*point) and
                struct.pack("<3d",*value["native_h_apm"]) == data["h_raw"][24*i:24*(i+1)] and
                value["unit"] == "A/m", "Reference source/target association differs")
        references.append(value)
    packing.update(target_xyz_binary64_hex=xyz.hex(),source_current_a=manifest["source"]["source_current_a"],
                   source_state_sha256=request["source_state_sha256"])
    return frozen, xyz, references, packing


def package_binding(request):
    from pathlib import Path
    receipt_raw = checked(Path("/opt/fullmag/package/backend-build-receipt.json"),request["backend_build_receipt_sha256"],8*1024*1024)
    receipt = evidence_json(receipt_raw)
    provenance = evidence_json(checked(Path("/opt/fullmag/control/backend/runtime-provenance.json"),request["backend_provenance_sha256"],8*1024*1024))
    require(receipt["state"] == provenance["state"] == "succeeded" and
            provenance["build_receipt_sha256"] == request["backend_build_receipt_sha256"], "Managed package binding differs")
    manifest_raw = checked(Path("/build/.fullmag-live-source/manifest.json"),request["source_manifest_sha256"],32*1024*1024)
    require(receipt["source"]["manifest_sha256"] == request["source_manifest_sha256"], "Source manifest is not bound to receipt")
    manifest = evidence_json(manifest_raw)
    rows = manifest["source_manifest"]["files"]
    files = {row["path"]:row for row in rows}
    require(len(files) == len(rows), "Source manifest contains duplicate paths")
    for path, expected in request["source_files"].items():
        require(path in files and files[path]["type"] == "file" and files[path]["sha256"] == expected,
                "Package was built from different native source: " + path)
        checked(source_path(path),expected,1024*1024)
    for name in ("lib/libfullmag_fem.so","lib/libfullmag_fem.so.0"):
        records = [v for v in receipt["artifacts"] if v["path"] == name]
        require(len(records) == 1 and records[0]["sha256"] == request["library_sha256"], "FEM library artifact binding differs")
        path = Path("/opt/fullmag/package") / name
        resolved = path.resolve(strict=True)
        require(resolved.is_relative_to(Path("/opt/fullmag/package")), "Library escapes package")
        checked(resolved,request["library_sha256"],512*1024*1024)
    return {"library_sha256":request["library_sha256"],"lib_sha256":request["library_sha256"],
            "backend_build_receipt_sha256":request["backend_build_receipt_sha256"],
            "source_manifest_sha256":request["source_manifest_sha256"],"source_files":request["source_files"]}



def current_idle_status():
    from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler, Request as HttpRequest
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = build_opener(ProxyHandler({}),NoRedirect())
    with opener.open(HttpRequest("http://127.0.0.1:8081/v2/sessions/current/status",method="GET"),timeout=15) as response:
        require(response.status == 200, "Current runtime status is unavailable")
        raw = response.read(1024*1024+1)
        require(len(raw) <= 1024*1024, "Runtime status exceeds metadata bound")
    value = evidence_json(raw)
    require("run" in value and value["run"] is None, "Probe requires an idle runtime without an active run")
    return {"session":value.get("session"),"run":value["run"]}


def atomic_bytes(path, raw):
    import os
    temporary = path.with_name(path.name+".tmp")
    with temporary.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary,path)
    fd = os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def json_bytes(value):
    import json
    return (json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,indent=2)+"\n").encode()


def native_output(status, result, h, evidence, profile):
    require(result.abi_version == 1 and result.reserved_flags == 0 and result.struct_size == C.sizeof(Result) and
            C.cast(result.h_xyz_apm,C.c_void_p).value == C.addressof(h) and result.h_xyz_apm_capacity == len(h) and
            C.cast(result.evidence_json,C.c_void_p).value == C.addressof(evidence) and
            result.evidence_json_capacity == len(evidence), "Native result descriptor changed")
    require(profile.abi_version == 1 and profile.reserved_flags == 0 and profile.struct_size == C.sizeof(Profile) and
            profile.available in (0,1) and profile.accounting_issue in (0,1), "Native profile ABI differs")
    info = {"native_status":int(status),"error":bytes(result.error_message).decode("utf-8","replace"),
            "native_output_lengths":{"h":int(result.h_xyz_apm_len),"evidence":int(result.evidence_json_len)},
            "profile":{"available":bool(profile.available),"accounting_issue":bool(profile.accounting_issue),
                       "operator_wall_time_ns":int(profile.operator_wall_time_ns),
                       "phase_wall_time_ns":list(profile.phase_wall_time_ns)},
            "native_evidence":None,"work_report_availability":"NOT AVAILABLE"}
    if status != 0:
        return info, None
    require(result.h_xyz_apm_len == len(h) == 9 and all(map(math.isfinite,h)) and
            0 < result.evidence_json_len <= len(evidence), "Native H/evidence output is incomplete")
    raw = C.string_at(evidence,result.evidence_json_len)
    value = evidence_json(raw)
    info.update(h_xyz_apm=[list(h[i:i+3]) for i in range(0,9,3)],
                h_binary64_hex=struct.pack("<9d",*h).hex(),native_evidence=value,
                work_report_availability="AVAILABLE",native_evidence_sha256=digest(raw))
    return info, raw


def evaluate_once(function, frozen, xyz, policy, packing, source_digest, claim):
    import resource, time
    sizes = abi_sizes()
    require(sizes == {"Limits":272,"Tolerances":88,"Options":368,"Frozen":128,"Request":440,"Result":320,"Profile":112},
            "Unsupported ctypes ABI layout")
    limits = Limits()
    for name,_type in Limits._fields_:
        value = policy["limits"][name]
        if name in ("total","per_target"):
            getattr(limits,name)[:] = value
        else:
            setattr(limits,name,value)
    tolerances = Tolerances(**policy["tolerances"])
    version = policy["policy_version"].encode("ascii")
    frozen_buffer = (Frozen*(len(frozen)//128)).from_buffer_copy(frozen)
    targets = (D*9).from_buffer_copy(xyz)
    h = (D*9)(*[math.nan]*9)
    evidence = (C.c_uint8*policy["limits"]["total"][9])()
    source_view = packing["frozen_sha256"].encode("ascii")
    accepted_content = source_digest.encode("ascii")
    request = Request(1,0,C.sizeof(Request),1,0,frozen_buffer,len(frozen_buffer),targets,9,
                      source_view,accepted_content,Options(limits,tolerances,version))
    result = Result(1,0,C.sizeof(Result),h,9,0,evidence,len(evidence),0,b"")
    profile = Profile(abi_version=1,struct_size=C.sizeof(Profile))
    # All fallible input preparation precedes the persistent one-call fence.
    claim()
    started = time.monotonic()
    status = function(C.byref(request),C.byref(result),C.byref(profile),None)
    elapsed = time.monotonic()-started
    try:
        info, raw = native_output(status,result,h,evidence,profile)
    except ValueError as error:
        info, raw = {"native_status":int(status),"error":bytes(result.error_message).decode("utf-8","replace"),
                     "output_validation_error":str(error),"native_evidence":None,
                     "work_report_availability":"NOT AVAILABLE"}, None
    info.update(native_call_elapsed_seconds=elapsed,
                process_lifetime_peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024)
    return info, raw


def validate_evidence(value, info, request, xyz):
    from decimal import Decimal
    import re
    policy = request["policy"]
    limits = policy["limits"]

    def counts(row, bound):
        require(isinstance(row,list) and len(row) == 14 and
                all(type(n) is int and 0 <= n <= min(limit,2**64-1) for n,limit in zip(row,bound)),
                "Native work ledger shape or bound differs")

    def number(text, nonnegative=False):
        require(isinstance(text,str) and 0 < len(text) <= 4096 and
                re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?",text) is not None,
                "Native precision decimal is incomplete")
        result = Decimal(text)
        require(result.is_finite() and (not nonnegative or result >= 0), "Native precision decimal is invalid")
        return result

    def precision(record, required):
        fields = {"evaluated","refusal_reason","h_xyz_apm","whole_h_xyz_apm",
                  "sum_local_norm_apm","cancellation","maximum_face_cancellation"}
        require(isinstance(record,dict) and set(record) == fields and type(record["evaluated"]) is bool and
                isinstance(record["refusal_reason"],str) and len(record["refusal_reason"]) <= 4096,
                "Native precision record is incomplete")
        vectors = [record["h_xyz_apm"],record["whole_h_xyz_apm"]]
        require(all(isinstance(row,list) and len(row) == 3 and all(isinstance(v,str) for v in row) for row in vectors),
                "Native precision vector shape differs")
        scalars = [record["sum_local_norm_apm"],record["cancellation"],record["maximum_face_cancellation"]]
        if record["evaluated"]:
            require(record["refusal_reason"] == "", "Evaluated precision has a refusal")
            for row in vectors:
                for component in row: number(component)
            for scalar in scalars: number(scalar,True)
        else:
            require(not required and bool(record["refusal_reason"]) and
                    all(v == "" for row in vectors for v in row) and all(v == "" for v in scalars),
                    "Native refused precision is not an explicit empty binary record")

    require(value["schema_version"] == "fem_rt0_surface_snapshot.v1" and
            value.get("operator_version") == "fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1" and
            value.get("basis_version") == "fem_generic_affine_rt0.v1" and
            value["inspection_only"] is True and value["error_certificate_available"] is False and
            value["source_view_identity_digest"] == request["scope"]["frozen_sha256"] and
            value["accepted_source_state_digest"] == request["source_state_sha256"] and
            value["policy_version"] == policy["policy_version"], "Native evidence identity differs")
    require(value["limits"] == limits and value["tolerances"] == policy["tolerances"] and
            struct.pack("<9d",*(c for row in value["targets_xyz_m"] for c in row)) == xyz,
            "Native evidence policy or targets differ")
    rows = value["targets"]
    require(isinstance(rows,list) and len(rows) == 3, "Native evidence target count differs")
    for i,row in enumerate(rows):
        require(struct.pack("<3d",*row["h_xyz_apm"]) == struct.pack("<3d",*info["h_xyz_apm"][i]) and
                isinstance(row["precisions"],list) and len(row["precisions"]) == 3 and
                type(row["binary64_requires_highprecision"]) is bool, "Native target precision evidence is incomplete")
        for index,record in enumerate(row["precisions"]): precision(record,index != 0)
        require(row["precisions"][0]["evaluated"] or row["binary64_requires_highprecision"],
                "Refused binary64 requires the explicit highprecision flag")
        counts(row["work"],limits["per_target"])
        require(row["work"][0] == 85980 and all(row["work"][k] >= factor*85980 for k,factor in ((1,8),(2,8),(3,24))),
                "Native mandatory per-target work is incomplete")
        budget = number(row["precision_budget_apm"],True)
        require(budget > 0 and all(number(row[key],True) <= budget for key in
                ("local_precision_delta_apm","local_formula_delta_apm","local_formula_delta_80_apm")),
                "Native retained precision/formula agreement exceeds budget")
        require(struct.pack("<3d",*(float(v) for v in row["precisions"][2]["h_xyz_apm"])) ==
                struct.pack("<3d",*row["h_xyz_apm"]), "Native highprecision H does not round to raw H")
        if row["precisions"][0]["evaluated"]: number(row["binary64_roundoff_indicator_apm"],True)
        else: require(row["binary64_roundoff_indicator_apm"] == "", "Refused binary roundoff is not empty")
    work = value["work_report"]
    counts(work["total"],limits["total"])
    require(isinstance(work["by_precision"],list) and len(work["by_precision"]) == 3, "Native precision work is incomplete")
    for row in work["by_precision"]: counts(row,limits["total"])
    # Shared source preparation is outside targets and precision: sums are bounded, not equal.
    for k,total in enumerate(work["total"]):
        require(sum(row["work"][k] for row in rows) <= total and sum(row[k] for row in work["by_precision"]) <= total,
                "Native aggregate work conservation differs")
    require(work["total"][0] == 3*85980 and type(work["current_target_index"]) is int and
            work["current_target_index"] == 2 and work["current_target"] == rows[-1]["work"],
            "Native final target or exact source-pair total differs")
    for row in work["by_precision"][1:]:
        require(all(row[k] >= factor*work["total"][0] for k,factor in ((1,4),(2,4),(3,12))),
                "Native mandatory highprecision work is incomplete")
    for key,limit in (("maximum_raw_integer_bits",limits["maximum_raw_integer_bits"]),
                      ("maximum_reduced_fraction_bits",limits["maximum_reduced_fraction_bits"]),
                      ("last_sampled_lifetime_peak_rss_bytes",limits["maximum_lifetime_peak_rss_bytes"])):
        require(type(work[key]) is int and 0 < work[key] <= limit, "Native measured resource bound differs")
    require(type(work["elapsed_seconds"]) in (int,float) and math.isfinite(work["elapsed_seconds"]) and
            0 <= work["elapsed_seconds"] <= limits["maximum_total_seconds"], "Native elapsed-time bound differs")


def main():
    import argparse, os, resource, time
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-sha256",required=True)
    parser.add_argument("--preflight",action="store_true")
    args = parser.parse_args()
    snapshot = Path(__file__).parent.parent
    expected = Path(CONTROL)/"snapshots"/args.request_sha256
    require(snapshot == expected and snapshot.resolve(strict=True) == snapshot, "Driver is outside the managed prepared snapshot")
    request = evidence_json(checked(snapshot/"request.json",args.request_sha256,1024*1024))
    require(request["schema"] == "fullmag.gsg-surface-native-probe-request.v1" and
            request["proposal_sha256"] == DESIGN_SHA and request["policy_sha256"] == POLICY_SHA and
            request["global_root"] == CONTROL and request["source_root_container"] == SOURCE, "Approved private request differs")
    checked(source_path(DESIGN+"projekt-proby.md"),DESIGN_SHA,1024*1024)
    policy = evidence_json(checked(source_path(DESIGN+"policy-proposal.json"),POLICY_SHA,1024*1024))
    require(policy == request["policy"], "Approved caller policy differs")
    checked(Path(__file__),request["driver_sha256"],1024*1024)
    os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
    for name in ("OMP_NUM_THREADS","OPENBLAS_NUM_THREADS","MKL_NUM_THREADS"):
        os.environ[name] = "1"
    resource.setrlimit(resource.RLIMIT_AS,(policy["process_proposal"]["rlimit_as_bytes"],)*2)
    report = {"schema":"fullmag.gsg-surface-native-probe-result.v1","request_sha256":args.request_sha256,
              **FLAGS,"native_evaluations":0,"target_indices":[0,8,16],"status":"REFUSED"}
    output = Path(request["output_directory"])/args.request_sha256
    require(output.is_relative_to(Path("/opt/fullmag/script-output/sushruth_2020_closed_gsg/corner12p5_20261112")),
            "Output is outside the approved examples grant")
    output.mkdir(parents=True,exist_ok=True)
    require(output.resolve(strict=True) == output, "Output path is linked")
    started = time.monotonic()
    try:
        before = current_idle_status()
        library_binding = package_binding(request)
        frozen, xyz, references, packing = load_inputs(request)
        require(not (Path(CONTROL)/"started.json").exists(), "The single native evaluation is already consumed")
        library = C.CDLL("/opt/fullmag/package/lib/libfullmag_fem.so")
        function = library.fullmag_fem_evaluate_frozen_rt0_surface_observed_v1
        function.argtypes = [C.POINTER(Request),C.POINTER(Result),C.POINTER(Profile),C.c_void_p]
        function.restype = C.c_int
        memory_max = Path("/sys/fs/cgroup/memory.max").read_text().strip()
        memory_current = int(Path("/sys/fs/cgroup/memory.current").read_text())
        require(memory_max == "max" or int(memory_max)-memory_current >= policy["limits"]["maximum_lifetime_peak_rss_bytes"],
                "Container has insufficient unallocated memory for the declared probe RSS budget")
        resources = {"affinity":sorted(os.sched_getaffinity(0)),"memory_max":memory_max,
                     "memory_current":memory_current,"rlimit_as_bytes":resource.getrlimit(resource.RLIMIT_AS)[0]}
        report.update(packing=packing,library_binding=library_binding,resources=resources)
        if args.preflight:
            value = {**report,"status":"PREFLIGHT PASS","native_evaluations":0}
            atomic_bytes(output/"preflight.json",json_bytes(value))
            print(json_bytes(value).decode(),flush=True)
            return 0
        require(current_idle_status() == before, "Runtime identity changed before the private probe")
        def claim():
            value = {"request_sha256":args.request_sha256,"pid":os.getpid(),"native_evaluations":1,
                     "process_start_token":Path("/proc/self/stat").read_text().rsplit(")",1)[1].split()[19],**FLAGS}
            raw = json_bytes(value)
            atomic_bytes(output/"native-started.json",raw)
            print('{"status":"NATIVE CALL ADMISSION","native_evaluations":0}',flush=True)
            with (Path(CONTROL)/"started.json").open("xb") as stream:
                stream.write(raw);stream.flush();os.fsync(stream.fileno())
            fd = os.open(CONTROL,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
            report["native_evaluations"] = 1
        info, raw = evaluate_once(function,frozen,xyz,policy,packing,request["source_state_sha256"],claim)
        report.update(info)
        if raw is not None:
            atomic_bytes(snapshot/"native-evidence.json",raw)
            atomic_bytes(output/"native-evidence.json",raw)
            validate_evidence(info["native_evidence"],info,request,xyz)
            comparisons = [dict(target_index=i,**compare_reference(h,r["h_xyz_apm"]))
                           for i,h,r in zip((0,8,16),info["h_xyz_apm"],references)]
            report["comparisons"] = comparisons
            require(all(row["within_gate"] for row in comparisons), "H is outside the declared comparison gate")
            report["status"] = "SUCCEEDED"
        require(package_binding(request) == library_binding and current_idle_status() == before,
                "Package or current runtime identity changed during evaluation")
    except Exception as error:
        report["status"] = "REFUSED"
        report["driver_error"] = type(error).__name__+": "+str(error)
    report.update(elapsed_seconds=time.monotonic()-started,
                  process_lifetime_peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024)
    if args.preflight:
        print(json_bytes(report).decode(),flush=True)
        return 2
    report["exit_code"] = 0 if report["status"] == "SUCCEEDED" else 2
    raw = json_bytes(report)
    atomic_bytes(snapshot/"result.json",raw)
    atomic_bytes(output/"result.json",raw)
    print(json_bytes({k:report[k] for k in ("status","native_evaluations","exit_code")}).decode(),flush=True)
    return report["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
