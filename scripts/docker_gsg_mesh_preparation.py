"""Prepare one pinned GSG junction input through the public CLI; never Submit."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import stat
import subprocess
import threading

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, toolchain_configuration
from docker_dev_host import docker_argv, require_host
import docker_gsg_reference as reference

INPUTS = "/opt/fullmag/control/verification/gsg-junction-preparation-20261106/runtime-free-inputs-v1"
OUTPUTS = "verification/gsg-junction-preparation-20261106/attempts"
LEVELS = {"50": "6da40fc7342d7c3b78223c7ae21b14111a3172be3adcea697ccef1d37f734050",
          "35": "c35b0c0f6b7314f097c9ce65b77a8409d24a6c5050097631074b8faa8ecf1e8f",
          "25": "3ef4acba44f12490f886dd9c316a53d2f19501b91efc6854af6400b6db0dfef6",
          "corner25": "d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148"}
CARRIER = "gsg-convergence-targets.fullmag-mesh"
CARRIER_SHA = "c0db256c8bf0d5c545123ac9d4154388c74081a74304f02912151ea8d9a52178"
VALIDATION_SHA = "9bfb62d363aa14632829fa55b369d5c12c9403dc9f378d41814b38ec50fb623a"
PUBLIC = "/opt/fullmag/control/verification/retained-current-h-only-20261102/accepted-store-v2/"
PROJECT = PUBLIC + "public-launch-input/retained-parent-definition.fms"
PROFILE = PUBLIC + "public-launch-input/execution-profile.json"
RESOURCES = PUBLIC + "public-source-input-gsg-universe-275-v1/resources-compute.json"
FIXED_FILES = {PROJECT: "df3eb73b3cf3c2858d46653f7b13a5823fd7e1c55a1af394801c9095a139acda",
               PROFILE: "6c88e13526ec18ba0ba2b8f11d200e83ab21f6cea94194af250cf567c298b786",
               RESOURCES: "aa994c72762e534f059310e821af35470d894ed13cfe3cbd5f7b3b235cf8adcc",
               INPUTS + "/input-validation.json": VALIDATION_SHA, INPUTS + "/" + CARRIER: CARRIER_SHA,
               **{INPUTS + "/gsg_junction_prepare_" + level + "nm.py": pin for level, pin in LEVELS.items()},
               INPUTS + "/corner-input-validation.json": "0539442bb331a432a19a0acafa57102540cebe606662cfa69d977d29a1aef3d5"}

RETAINED_LEVEL = "retained-corner25"
RETAINED_INPUT = "/opt/fullmag/script-output/sushruth_2020_closed_gsg/restart_20261111/input"
RETAINED_STEM = "fem_antenna_gsg_corner25_restart_20261111"
RETAINED_SCRIPT = RETAINED_STEM + ".py"
RETAINED_CACHE = ".fullmag/local/cache/fem_meshes/1673b40a6b14d4732336229340b5d063e2252f2652a27cdcc5d3e8d8a8e05f7a.npz"
RETAINED_FILES = {
    RETAINED_SCRIPT: "329e08ac9f9ee41f564fc59a25c385966311c9aeac457a603c8cf51957fb898e",
    CARRIER: CARRIER_SHA,
    RETAINED_CACHE: "0ff7085b80bc326876d9a49b3ad80d246ef7bad376da5ff43344edfdc892606a",
}
RETAINED_MESH_SHA = "0e6b3734506c702af79644a7b7f8991794ff83708c60b4b35b1d94888fbaf666"
RETAINED_MODULES_SHA = "140d78990f3261ac5624acf5eeae5353db0f7d658910239b6e655690b2abe0aa"
RETAINED_CARRIER_SHA = "4a778b78b74a7f63c72071bc86f1e05499a440c97a2ab738e43aa493e16f5791"
RETAINED_SOURCE_REVISION = "sha256:c002bb3d68d431f0b173f5eb3fb686a990529e9a725685f3cea4d062ec4669f7"

H_ONLY_LEVEL = "retained-edges92"
H_ONLY_INPUT = "/opt/fullmag/script-output/sushruth_2020_closed_gsg/edge_field_20261111/input"
H_ONLY_STEM = "fem_antenna_gsg_edges92_h_only"
H_ONLY_CARRIER = "gsg-edge-targets.fullmag-mesh"
H_ONLY_FILES = {'fem_antenna_gsg_edges92_h_only.py': '72e881926b98568ad8dec811d5fda6dac2b0d1f2618f2de374010b1fcd113373', 'gsg-edge-targets.fullmag-mesh': '1e8e60b2bd5ee1a47473b9ed003de6b7568d85fceb597f8946ff9014c3836911', 'gsg-source-preparation.json': '74875b82f956a68b73b9b9f909c6abee0c82b4ce650ed779e8b29c386efcd4ef', 'source-locator.json': '83b3a7e58aef1fed943773bae6a99b549195512f7e22694edc98d872e2c9ff24', 'proposed-surface-policy.json': '5a2a124e56e1fb0525914285649c8de7a78f96f40337c25fff736b35fd4e20ca', 'edge-targets.json': '634ff9c5167ddb508202504881cd571021fd936b20afe49c2148af685cf2edde'}
H_ONLY_LOCATOR = {'artifact_id': 'artifact-9a5e85de0dcc86514ae0db3ef3a50718622d56c4421bba3657ae554def8311aa', 'attempt_id': 'attempt-1b17059c50114e0d8ef7bbdec714e887', 'kind': 'published_inspection', 'object_ref': '05df2b7c899b92686ccb54ab62bfd62ffea3b0cc5710fa7d3dfdd0f8dfa67d3a', 'ownership_epoch': '1', 'project_id': 'project-live-66cd495ce3ccc80762d5bb0ee6652a43966f7c0ecd7989a3b0a52457a800781a', 'run_id': 'run-8f1144dd8f74eb7f2799ce192fef164dd9d8859c9c4ae2807244d62da88fc0e8', 'task_id': 'task-9f8631548b4225fc621db3ca38984f4874a725a5028e820395d6bc13f6774215'}
H_ONLY_PREPARED_SHA = "39874371fa4c08c1133b312f7397252899a3b1b534b6cc147cab5fa1047823d4"
H_ONLY_PREPARATION_SHA = "152bc2f4b72736afbe819f3da46d12474324bf330e5071a137298f8c4436bdcb"
H_ONLY_CLOSURE_SHA = "626defc5c94b183aefcbea1b90d2360192e409cc12809a0871e50f4cce99f40c"
H_ONLY_POLICY_SHA = "4c2f2cac698a88e16de918620e8fe034370d274b3a648b7acda3d26fa6a475b2"
H_ONLY_POSITIONS_SHA = "9002f78bfeeceba4bfb7eacfc1264a2252f1a02c7389fe3e92e1f3cb8c9838f2"

CORNER12P5_LEVEL = "corner12p5"
CORNER12P5_INPUT = "/opt/fullmag/script-output/sushruth_2020_closed_gsg/corner12p5_20261112/input"
CORNER12P5_SCRIPT = "fem_antenna_gsg_corner12p5.py"
CORNER12P5_FILES = {
    CORNER12P5_SCRIPT: "b94a9b2801f6156453dacc9f0d53d6db1c49a8917db5c93f56908796dc7b2ae9",
    CARRIER: CARRIER_SHA,
}

RETAINED_FINE_LEVEL = "retained-corner12p5"
RETAINED_FINE_CACHE = ".fullmag/local/cache/fem_meshes/dacaba1125dd882384c3a62f87ca63e7d3a6cc72f550488ae782ecadff384412.npz"
RETAINED_FINE_FILES = {**CORNER12P5_FILES,
    RETAINED_FINE_CACHE: "6b439c33e06d4d64706ffbb0d8518d279dfe55b259ddcbcef79397418843d086"}

CLI = "/opt/fullmag/package/bin/fullmag-bin"
MAX_REQUEST = 96 * 1024 * 1024
MAX_STDOUT = 256 * 1024 * 1024  # Bounded pretty-JSON spool, not a public transport policy.
MAX_METADATA = 1024 * 1024


def require(ok, message):
    if not ok:
        raise BuildControlError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def file_pin(path, maximum, *, sealed=False):
    path = Path(path)
    require(path.is_absolute() and all(not item.is_symlink() for item in (path, *path.parents)), "Input path contains a symlink")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum and
                (before.st_nlink == 1 or sealed and not before.st_mode & 0o222), "Input is not a bounded regular file")
        sha = hashlib.sha256()
        total = 0
        while block := stream.read(min(1024 * 1024, maximum + 1 - total)):
            total += len(block)
            require(total <= maximum, "Input grew past its byte bound")
            sha.update(block)
        after = os.fstat(stream.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), "Input changed while hashing")
        return {"sha256": sha.hexdigest(), "bytes": after.st_size}


def publish(path, value):
    raw = canonical(value) + b"\n"
    require(Path(path).parent.resolve(strict=True) == Path(path).parent, "Publication parent contains a symlink")
    with Path(path).open("xb") as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    sync_directories(Path(path).parent)
    return digest(raw)


def sync_directories(path):
    stop = Path("/opt/fullmag/control")
    require(path.is_relative_to(stop), "Output is outside control")
    while True:
        require(path.resolve(strict=True) == path, "Output directory contains a symlink")
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        if path == stop:
            break
        path = path.parent


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON field")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda value: require(False, "Nonfinite JSON"))


def normalize_request(raw):
    require(0 < len(raw) <= MAX_STDOUT, "Pretty request exceeds spool bound")
    value = decode(raw)
    require(isinstance(value, dict) and set(value) == {"archive_base64", "run_intent", "study_plan", "study_problem_catalog", "asset_paths"},
            "Public prepared request fields differ")
    compact = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode() + b"\n"
    require(0 < len(compact) <= MAX_REQUEST, "Compact request exceeds public file limit")
    require(decode(compact) == value, "Whitespace normalization changed request values")
    return value, compact


def cell_percentiles(values):
    """Linear count-weighted quantiles of a nonempty, validated cell sample."""
    ordered = sorted(values)
    result = {}
    for name, quantile in (("p05", 0.05), ("p50", 0.5), ("p95", 0.95)):
        position = (len(ordered) - 1) * quantile
        lower = int(position)
        upper = min(lower + 1, len(ordered) - 1)
        result[name] = ordered[lower] + (position - lower) * (ordered[upper] - ordered[lower])
    return result


def mesh_report(problem, carrier, *, level=None):
    require(problem["backend_policy"]["requested_backend"] == "fem" and
            problem["backend_policy"]["execution_precision"] == "double" and
            problem["validation_profile"]["execution_mode"] == "strict", "Prepared execution family differs")
    modules = problem["current_modules"]
    require(len(modules) == 1, "One complete current source required")
    transport = modules[0]; source = transport["conservative_current_source"]
    graph = [module for module in problem["physics_graph"]["modules"] if module["kind"] == "current_transport"]
    require(len(graph) == 1 and graph[0]["family_payload"] == transport, "Physics graph/source mapping differs")
    require(source["schema_version"] == "conservative_current_source.v2" and
            source["kind"] == "closed_geometry_potential_jump" and source["object_id"] == "antenna", "Prepared source family differs")
    assets = problem["geometry_assets"]
    meshes = [a["mesh"] for a in assets["fem_mesh_assets"] if a["geometry_name"] == source["geometry_id"]]
    require(len(meshes) == 1, "Complete source mesh is missing or ambiguous")
    mesh = meshes[0]; xyz = mesh["nodes"]; cells = mesh["cells"]
    count = len(cells["types"])
    require(count > 0 and cells["types"] == ["tet4"] * count and cells["offsets"] == list(range(0, 4 * count + 1, 4)) and
            len(cells["nodes"]) == 4 * count and all(len(point) == 3 and all(math.isfinite(v) for v in point) for point in xyz),
            "Source must contain full finite Tet4 connectivity")
    ids = source["stable_vertex_ids"]
    require(len(ids) == len(xyz) and len(set(ids)) == len(ids) and
            all(type(i) is int and 0 <= i < 2**64 for i in ids), "Stable source vertex identities differ")
    parts = source["material_parts"]
    require(len(parts) == 5 and len({p["part_id"] for p in parts}) == 5, "All five conductor/connection parts required")
    owners = [None] * count
    stats = {}
    volumes, cell_edges = {}, {}
    for part in parts:
        name = part["part_id"]; ordinals = part["element_ordinals"]
        volumes[name], cell_edges[name] = [], []
        require(ordinals and transport["materials"][part["material_assignment_index"]]["material"]["sigma_Spm"] == 35000000., "Material binding differs")
        stats[name] = {"cells": len(ordinals), "minimum_volume_m3": math.inf, "maximum_volume_m3": 0.,
                       "minimum_edge_m": math.inf, "maximum_edge_m": 0.}
        for ordinal in ordinals:
            require(type(ordinal) is int and 0 <= ordinal < count and owners[ordinal] is None, "Material coverage overlaps or escapes mesh")
            owners[ordinal] = name
    require(all(name is not None for name in owners), "Material coverage omitted source cells")
    for ordinal in range(count):
        connectivity = cells["nodes"][4*ordinal:4*ordinal+4]
        require(len(set(connectivity)) == 4 and all(type(i) is int and 0 <= i < len(xyz) for i in connectivity), "Invalid Tet4 vertices")
        vertices = [xyz[i] for i in connectivity]
        a, b, c = ([vertices[j][k] - vertices[0][k] for k in range(3)] for j in (1, 2, 3))
        volume = (a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0])) / 6
        require(math.isfinite(volume) and volume > 0., "Nonpositive Tet4 orientation/volume")
        name = owners[ordinal]
        row = stats[name]
        volumes[name].append(volume)
        maximum_edge = 0.
        row["minimum_volume_m3"] = min(row["minimum_volume_m3"], volume)
        row["maximum_volume_m3"] = max(row["maximum_volume_m3"], volume)
        for i in range(4):
            for j in range(i):
                edge = math.dist(vertices[i], vertices[j])
                require(math.isfinite(edge), "Nonfinite source edge")
                row["minimum_edge_m"] = min(row["minimum_edge_m"], edge)
                row["maximum_edge_m"] = max(row["maximum_edge_m"], edge)
                maximum_edge = max(maximum_edge, edge)
        cell_edges[name].append(maximum_edge)
    for name, row in stats.items():
        row["maximum_cell_edge_percentiles_m"] = cell_percentiles(cell_edges[name])
        row["cell_volume_percentiles_m3"] = cell_percentiles(volumes[name])
    closure = source["closure"]
    require(closure["operator_version"] == "fem_closed_current_geometry.v2" and len(closure["source_cuts"]) == 1, "Sourcecut closure differs")
    cut = closure["source_cuts"][0]; by_id = dict(zip(ids, xyz)); pairs = cut["face_pairs"]
    require(cut["translation_m"] == [0., 0., 0.] and cut["potential_drop_v"] == 0.001 and pairs, "Potential-jump sourcecut differs")
    for pair in pairs:
        minus, plus = (pair[key] for key in ("minus_face_vertex_ids", "plus_face_vertex_ids"))
        require(len(set(minus)) == len(set(plus)) == 3 and set(minus).isdisjoint(plus) and
                sorted(tuple(by_id[i]) for i in minus) == sorted(tuple(by_id[i]) for i in plus), "Sourcecut world mapping differs")
    target = assets["fem_domain_mesh_asset"]["mesh"]
    require(target["nodes"] == carrier["nodes"] and target["cells"] == carrier["cells"] and
            len(target["nodes"]) == 20 and len(target["cells"]["types"]) == 24, "Observation carrier changed")
    metadata = problem["problem_meta"]["runtime_metadata"]
    receipts = metadata["antenna_coincident_preparations"]
    require(len(receipts) == 1 and receipts[0]["object_id"] == source["object_id"] and
            receipts[0]["geometry_id"] == source["geometry_id"], "Prepared source receipt differs")
    result = {"source_vertices": len(xyz), "source_cells": count, "parts": stats, "source_cut_face_pairs": len(pairs),
            "source_mesh_sha256": digest(canonical(mesh)), "source_sha256": digest(canonical(source)),
            "carrier_sha256": CARRIER_SHA, "carrier_world_nodes_sha256": digest(canonical(target["nodes"])),
            "carrier_cells_sha256": digest(canonical(target["cells"])), "preparation": receipts[0],
            "mesh_workflow": metadata["mesh_workflow"], "eta_helper_admitted": False,
            "exceeds_eta_cell_limit": count > 72911, "exceeds_native_20_target_pair_budget": count * 20 > 4000000}
    if level in (CORNER12P5_LEVEL, RETAINED_FINE_LEVEL):
        profile = "gsg_junction_refinement_86k.v1" if level == RETAINED_FINE_LEVEL else "gsg_junction_refinement_80k.v1"
        result["corner_refinement"] = corner12p5_refinement_report(mesh,cell_limit_profile=profile)
        result["exceeds_eta_cell_limit"] = count > (86000 if level == RETAINED_FINE_LEVEL else 80000)
    return result


def producer_script(level):
    if level == CORNER12P5_LEVEL:
        return CORNER12P5_SCRIPT
    require(level in LEVELS, "Invalid fresh producer level")
    return "gsg_junction_prepare_" + level + "nm.py"


def verify_corner12p5_script(raw):
    require(digest(raw) == CORNER12P5_FILES[CORNER12P5_SCRIPT],
            "Frozen corner12p5 script changed")


def corner12p5_refinement_report(mesh, *, cell_limit_profile="gsg_junction_refinement_80k.v1"):
    cells = mesh["cells"]; xyz = mesh["nodes"]
    limits = {"gsg_junction_refinement_80k.v1":80000,"gsg_junction_refinement_86k.v1":86000}
    require(type(cell_limit_profile) is str and cell_limit_profile in limits,"Unknown corner source profile")
    require(0 < len(cells["types"]) <= limits[cell_limit_profile],
            "corner12p5 source exceeds " + str(limits[cell_limit_profile]) + " Tet4")
    corners = [(x, y) for x in (-350e-9, -100e-9, 100e-9, 350e-9)
               for y in (-11.8e-6, 11.8e-6)]
    rows = [{"edge_xy_m": [x,y], "cells": 0, "maximum_edge_m": 0.}
            for x,y in corners]
    for ordinal in range(len(cells["types"])):
        vertices = [xyz[i] for i in cells["nodes"][4*ordinal:4*ordinal+4]]
        center = [sum(v[k] for v in vertices)/4 for k in range(3)]
        distance_z = max(30e-9-center[2], center[2]-120e-9, 0.)
        selected = [i for i,(x,y) in enumerate(corners)
                    if math.hypot(center[0]-x, center[1]-y, distance_z) <= 100e-9]
        if not selected:
            continue
        maximum = max(math.dist(vertices[i],vertices[j]) for i in range(4) for j in range(i))
        require(math.isfinite(maximum) and maximum > 0,
                "corner12p5 realized corner edge is invalid")
        for i in selected:
            rows[i]["cells"] += 1
            rows[i]["maximum_edge_m"] = max(rows[i]["maximum_edge_m"],maximum)
    require(all(row["cells"] > 0 for row in rows), "corner12p5 region has no source cells")
    return {"corners": rows, "centroid_radius_m": 100e-9, "requested_corner_size_m": 12.5e-9,
            "maximum_edge_m": max(row["maximum_edge_m"] for row in rows),
            "cell_limit_profile": cell_limit_profile, "field_error_bound": False}


def cli_command(level, operation_id, *, input_root=None):
    require((level in LEVELS or level in (RETAINED_LEVEL, H_ONLY_LEVEL, CORNER12P5_LEVEL, RETAINED_FINE_LEVEL)) and len(operation_id) == 32 and all(c in "0123456789abcdef" for c in operation_id), "Invalid preparation selection")
    if level in (CORNER12P5_LEVEL, RETAINED_FINE_LEVEL):
        require(input_root is None or Path(input_root) == Path(CORNER12P5_INPUT),
                "corner12p5 capture cwd differs")
        source = str(Path(CORNER12P5_INPUT) / CORNER12P5_SCRIPT)
        key = ("gsg-retained-corner12p5-prepare-" if level == RETAINED_FINE_LEVEL else "gsg-corner12p5-prepare-") + operation_id
    elif level == H_ONLY_LEVEL:
        require(input_root is None or Path(input_root) == Path(H_ONLY_INPUT), "H-only capture cwd differs")
        source = str(Path(H_ONLY_INPUT) / (H_ONLY_STEM + ".py"))
        key = "gsg-retained-edges92-prepare-" + operation_id
    elif level == RETAINED_LEVEL:
        require(input_root is None or Path(input_root) == Path(RETAINED_INPUT), "Retained capture cwd differs")
        source = str(Path(RETAINED_INPUT) / RETAINED_SCRIPT)
        key = "gsg-retained-corner25-prepare-" + operation_id
    else:
        source = str(input_root or INPUTS) + "/gsg_junction_prepare_" + level + "nm.py"
        key = "gsg-junction-prepare-" + operation_id
    return [CLI, "run-script-accepted", source, "--project", PROJECT,
            "--execution-profile", PROFILE, "--resources", RESOURCES, "--idempotency-key", key,
            "--prepare-only"]


def capture_cli(command, output, environment, *, input_root=None):
    errors = []; observed = {}
    child = subprocess.Popen(command, cwd=input_root or INPUTS, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    def spool(stream, name, maximum):
        target = None; total = 0
        try:
            target = (output / name).open("xb")
        except OSError as error:
            errors.append(str(error))
        try:
            while block := stream.read(65536):
                if target is not None and total < maximum:
                    try:
                        target.write(block[:maximum-total])
                    except OSError as error:
                        errors.append(str(error)); target.close(); target = None
                total += len(block)
            if target is not None:
                target.flush(); os.fsync(target.fileno())
        except BaseException as error:
            errors.append(str(error))
        finally:
            if target is not None:target.close()
            stream.close()
            observed[name] = total
    threads = [threading.Thread(target=spool, args=(stream, name, limit)) for stream, name, limit in
               ((child.stdout, "request.pretty.json", MAX_STDOUT), (child.stderr, "stderr.log", MAX_METADATA))]
    for thread in threads:thread.start()
    code = child.wait()
    for thread in threads:thread.join()
    return code, observed, errors, child.pid


def configure_guest_resources():
    # Capture clears environment variables; affinity survives fork/exec.
    selected = {min(os.sched_getaffinity(0))}
    os.sched_setaffinity(0, selected)
    require(os.sched_getaffinity(0) == selected, "Preparation CPU affinity differs")
    os.environ.update(OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")
    resource.setrlimit(resource.RLIMIT_AS, (4*1024**3, 4*1024**3))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return sorted(selected)


PYTHON = "/usr/local/bin/python3"
FULLMAG = "/opt/fullmag/source/packages/fullmag-py/src/fullmag"
CAPTURE = FULLMAG + "/runtime/accepted_source_capture.py"
CAPTURE_METADATA = 12 * 1024 * 1024


def capture_environment():
    # Match capture; inherited cache and source-snapshot overrides change the mesh key.
    return {"PATH": str(Path(PYTHON).parent), "PYTHONHASHSEED": "0",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"}


def check_cache_inventory(before, after, level):
    old = {row["relative_path"]: row for row in before["records"]}
    new = {row["relative_path"]: row for row in after["records"]}
    require(len(old) == len(before["records"]) and len(new) == len(after["records"]), "Duplicate inventory record")
    expected = {"source/" + producer_script(level):
                CORNER12P5_FILES[CORNER12P5_SCRIPT] if level == CORNER12P5_LEVEL else LEVELS[level],
                "source/" + CARRIER: CARRIER_SHA}
    require({key: row["sha256"] for key, row in old.items() if row["role"] == "source"} == expected,
            "Producer source closure differs")
    require(all(new.get(key) == row for key, row in old.items()), "Producer changed a captured source/runtime input")
    additions = {key: row for key, row in new.items() if key not in old}
    prefix = "source/.fullmag/local/cache/fem_meshes/"
    require(bool(additions), "Producer did not publish mesh cache")
    for key, row in additions.items():
        name = key.removeprefix(prefix)
        require(key.startswith(prefix) and len(name) == 68 and name.endswith(".npz") and
                all(c in "0123456789abcdef" for c in name[:-4]) and row["role"] == "source",
                "Producer wrote an unexpected source file")
    old_runtime = {key: value for key, value in before["runtime"].items() if key != "source_bytes"}
    new_runtime = {key: value for key, value in after["runtime"].items() if key != "source_bytes"}
    require(old_runtime == new_runtime and after["runtime"]["source_bytes"] <= 8 * 1024 * 1024,
            "Producer runtime or capture budget differs")
    return additions


def require_same_inventory(expected, actual):
    require(actual == expected, "Public CLI changed producer source/runtime inventory")


def require_same_mesh(producer, accepted):
    for key in ("source_mesh_sha256", "source_sha256", "carrier_world_nodes_sha256", "carrier_cells_sha256"):
        require(producer[key] == accepted[key], "Public prepared mesh/source/carrier differs: " + key)


def produce_mesh(input_root, level, report_path):
    import sys
    import sysconfig
    sys.path[:0] = [str(Path(FULLMAG).parent), sysconfig.get_path("purelib")]
    from fullmag.runtime.loader import load_problem_from_script
    from fullmag.meshing.persistence import load_mesh_artifact
    loaded = load_problem_from_script(Path(input_root) / producer_script(level), lightweight_assets=False)
    problem = loaded.to_ir(requested_backend=None, execution_mode=None, execution_precision=None,
                           asset_cache=loaded.problem.geometry_asset_cache, include_geometry_assets=True,
                           _copy_cached_geometry_assets=False)
    carrier = load_mesh_artifact(Path(input_root) / CARRIER, expected_sha256=CARRIER_SHA).mesh.to_ir("sampling")
    gmsh = sys.modules.get("gmsh")
    require(gmsh is not None, "Fresh source producer did not report its mesher")
    wrapper = Path(gmsh.__file__).resolve(strict=True)
    library = Path(gmsh.lib._name).resolve(strict=True)
    publish(Path(report_path), {"mesh": mesh_report(problem, carrier, level=level), "new_solve": False,
            "gmsh": {"version": gmsh.__version__, "wrapper": str(wrapper), "library": str(library),
                     "wrapper_pin": file_pin(wrapper, 32*1024*1024), "library_pin": file_pin(library, 2*1024**3)}})


def preparation_phase(output, input_root, proof, name, command, *, json_output=True):
    directory = output / name
    directory.mkdir(); sync_directories(directory)
    proof["child_reaped"] = False
    code, totals, errors, pid = capture_cli(command, directory, capture_environment(), input_root=input_root)
    proof.update(child_reaped=True, child_pid=pid, child_exit_code=code, last_phase=name)
    publish(directory / "exit.json", {"child_reaped": True, "child_pid": pid, "exit_code": code,
            "stream_bytes": totals, "spool_errors": errors, "new_solve": False})
    require(code == 0 and not errors and totals["request.pretty.json"] <= CAPTURE_METADATA and
            totals["stderr.log"] <= MAX_METADATA, "Preparation phase refused: " + name)
    return decode((directory / "request.pretty.json").read_bytes()) if json_output else None

def inventory_command(input_root, level):
    script = Path(input_root) / (H_ONLY_STEM + ".py" if level == H_ONLY_LEVEL else RETAINED_SCRIPT if level == RETAINED_LEVEL else CORNER12P5_SCRIPT if level == RETAINED_FINE_LEVEL else producer_script(level))
    return [PYTHON, "-X", "utf8", "-B", "-S", CAPTURE, "--phase", "inventory",
            "--script", str(script), "--fullmag-root", FULLMAG]



def verify_retained_inventory(inventory, input_root):
    require(input_root == Path(RETAINED_INPUT), "Retained capture cwd differs")
    records = inventory["records"]
    require(len({row["relative_path"] for row in records}) == len(records), "Retained inventory duplicates a path")
    source = {row["relative_path"]: row for row in records if row["role"] == "source"}
    require({name: row["sha256"] for name, row in source.items()} ==
            {"source/" + name: pin for name, pin in RETAINED_FILES.items()}, "Retained script/carrier/cache inventory differs")
    require(all(row["absolute_path"] == str(input_root / name.removeprefix("source/"))
                for name, row in source.items()), "Retained inventory cwd/source alias differs")
    require(inventory["runtime"]["source_bytes"] == sum(row["byte_count"] for row in source.values()) <= 8*1024*1024,
            "Retained source inventory budget differs")



def verify_h_only_inventory(inventory, input_root):
    require(input_root == Path(H_ONLY_INPUT), "H-only capture cwd differs")
    records = inventory["records"]
    require(len({row["relative_path"] for row in records}) == len(records), "H-only inventory duplicates a path")
    source = {row["relative_path"]: row for row in records if row["role"] == "source"}
    require({name: row["sha256"] for name, row in source.items()} ==
            {"source/" + name: pin for name, pin in H_ONLY_FILES.items()}, "H-only source inventory differs")
    require(all(row["absolute_path"] == str(input_root / name.removeprefix("source/"))
                for name, row in source.items()), "H-only inventory cwd/source alias differs")
    require(inventory["runtime"]["source_bytes"] == sum(row["byte_count"] for row in source.values()) <= 8*1024*1024,
            "H-only source inventory budget differs")



def verify_h_only_request(value, carrier, input_root, operation_id):
    import struct
    require(input_root == Path(H_ONLY_INPUT), "H-only capture cwd differs")
    intent = value["run_intent"]
    key = "gsg-retained-edges92-prepare-" + operation_id
    require(intent["idempotency_key"] == key and intent["specification"]["run_id"] == "run-" + digest(key.encode()),
            "H-only run identity differs")
    require(intent["specification"]["requested_execution"] == {
        "backend":"fem", "device":"cpu", "mode":"strict", "precision":"double",
        "minimum_resources":{"cpu_millis":1000, "memory_bytes":4294967296,
                             "gpu_memory_bytes":0, "storage_bytes":536870912}}, "H-only execution/resources differ")
    entries = value["study_problem_catalog"]["entries"]
    require(len(entries) == 1, "Exactly one H-only problem required")
    problem = entries[0]["problem"]
    require(problem["backend_policy"]["requested_backend"] == "fem" and
            problem["backend_policy"]["execution_precision"] == "double" and
            problem["validation_profile"]["execution_mode"] == "strict" and
            problem["study"]["kind"] == "antenna_field_solve" and
            problem["study"].get("selection") == {"port_mode_id":"gsg_port", "stage_id":"inspect_gsg_edges92"},
            "H-only execution family differs")
    stages = problem["antenna_field_solve_stages"]
    require(len(stages) == 1, "Exactly one H-only stage required")
    stage = stages[0]
    require(stage["id"] == "inspect_gsg_edges92" and stage["source_object_id"] == "antenna" and
            stage["current_transport_id"] == "gsg_charge" and stage["oersted_realization"] == "analytic_rt0_surface" and
            stage.get("conservative_current_view_ref") is None, "H-only stage/source realization differs")
    require(stage["retained_current_source"] == H_ONLY_LOCATOR, "H-only retained parent differs")
    require(digest(canonical(stage["surface_field_policy"])) == H_ONLY_POLICY_SHA, "H-only policy differs")
    expected_asset = {"asset_id":"script-file-" + digest(b"source/gsg-source-preparation.json"),
                      "content_sha256":H_ONLY_FILES["gsg-source-preparation.json"]}
    require(stage["retained_source_preparation"] == expected_asset, "H-only preparation asset differs")
    modules = problem["current_modules"]
    require(len(modules) == 1 and modules[0]["name"] == "gsg_charge", "H-only current module differs")
    source = modules[0]["conservative_current_source"]
    require(source["kind"] == "retained_preparation_asset" and
            source["schema_version"] == "retained_preparation_asset_source.v1" and
            source["object_id"] == "antenna" and source["preparation_asset"] == expected_asset,
            "H-only frozen projection differs")
    require(digest(canonical(source["historical_prepared_source"])) == H_ONLY_PREPARED_SHA and
            digest(canonical(source["historical_preparation"])) == H_ONLY_PREPARATION_SHA and
            digest(canonical(source["authored_closure"])) == H_ONLY_CLOSURE_SHA, "H-only historical source differs")
    graph = [m for m in problem["physics_graph"]["modules"] if m["kind"] == "current_transport"]
    require(modules[0].get("boundaries") == [], "H-only source boundaries differ")
    expected = dict(modules[0])
    if len(graph) == 1 and "boundaries" not in graph[0]["family_payload"]:
        del expected["boundaries"]
    require(len(graph) == 1 and graph[0]["family_payload"] == expected, "H-only graph/source mapping differs")
    target = problem["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
    require(target["nodes"] == carrier["nodes"] and target["cells"] == carrier["cells"] and
            len(target["nodes"]) == 92 and len(target["cells"]["types"]) == 132 and
            digest(b"".join(struct.pack("<3d", *point) for point in target["nodes"])) == H_ONLY_POSITIONS_SHA,
            "H-only target carrier differs")
    metadata = problem["problem_meta"]["runtime_metadata"]
    require(not metadata.get("antenna_coincident_preparations"), "H-only must not remesh source")
    require(metadata.get("output_storage") == {"output_dir":H_ONLY_STEM+".zarr", "temp_dir":None,
            "data_format":"zarr", "cleanup":"on_success", "existing_output":"error"} and
            metadata.get("output_storage_source_dir") == str(input_root) and
            metadata.get("output_storage_source_stem") == H_ONLY_STEM, "H-only sibling storage differs")
    return {"source_vertices":14194, "source_cells":40728, "target_count":92,
            "source_preparation_asset_sha256":H_ONLY_FILES["gsg-source-preparation.json"],
            "carrier_sha256":H_ONLY_FILES[H_ONLY_CARRIER], "reused_source_preparation":True,
            "charge_solve_count":0, "qualified_basis":False}


def verify_retained_request(value, report, input_root, operation_id):
    require(input_root == Path(RETAINED_INPUT), "Retained capture cwd differs")
    intent = value["run_intent"]
    key = "gsg-retained-corner25-prepare-" + operation_id
    require(intent["idempotency_key"] == key and intent["specification"]["run_id"] == "run-" + digest(key.encode()),
            "Retained public CLI run identity differs")
    require(intent["specification"]["requested_execution"] == {
        "backend": "fem", "device": "cpu", "mode": "strict", "precision": "double",
        "minimum_resources": {"cpu_millis": 1000, "memory_bytes": 4294967296,
                              "gpu_memory_bytes": 0, "storage_bytes": 536870912}},
        "Retained execution/resources differ")
    problem = value["study_problem_catalog"]["entries"][0]["problem"]
    require((report["source_vertices"], report["source_cells"]) == (14194, 40728) and
            report["source_mesh_sha256"] == RETAINED_MESH_SHA, "Retained source mesh differs")
    require(digest(canonical(problem["current_modules"])) == RETAINED_MODULES_SHA, "Retained current module differs")
    require(problem["current_modules"][0]["conservative_current_source"]["revision"] == RETAINED_SOURCE_REVISION,
            "Retained source revision differs")
    target = problem["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
    carrier = {name: target[name] for name in ("nodes", "cells", "facets", "mesh_name", "boundary_markers", "element_markers")}
    require(len(target["nodes"]) == 20 and digest(canonical(carrier)) == RETAINED_CARRIER_SHA,
            "Retained sampling carrier differs")
    metadata = problem["problem_meta"]["runtime_metadata"]
    require(metadata.get("output_storage") == {
        "output_dir": RETAINED_STEM + ".zarr", "temp_dir": None, "data_format": "zarr",
        "cleanup": "on_success", "existing_output": "error"} and
        metadata.get("output_storage_source_dir") == str(input_root) and
        metadata.get("output_storage_source_stem") == RETAINED_STEM, "Retained sibling output storage differs")


def verify_retained_fine_inventory(inventory, input_root):
    require(input_root == Path(CORNER12P5_INPUT), "Retained fine capture cwd differs")
    rows = inventory["records"]
    require(len({row["relative_path"] for row in rows}) == len(rows),"Retained fine inventory duplicates a path")
    source = {row["relative_path"]:row for row in rows if row["role"] == "source"}
    require({name:row["sha256"] for name,row in source.items()} ==
            {"source/"+name:pin for name,pin in RETAINED_FINE_FILES.items()},
            "Retained fine script/carrier/cache inventory differs")
    require(all(row["absolute_path"] == str(input_root/name.removeprefix("source/"))
                for name,row in source.items()),"Retained fine source alias differs")
    require(inventory["runtime"]["source_bytes"] ==
            sum(row["byte_count"] for row in source.values()) <= 8*1024*1024,
            "Retained fine capture budget differs")


def verify_retained_fine_cache_mesh(mesh, cache_path):
    from collections import Counter
    import struct
    import numpy as np
    before = file_pin(cache_path,8*1024*1024)
    require(before["sha256"] == RETAINED_FINE_FILES[RETAINED_FINE_CACHE],"Retained fine cache changed")
    with np.load(cache_path,allow_pickle=False) as cache:
        nodes = cache["nodes"].tolist()
        types = cache["cell_types"].tolist()
        offsets = cache["cell_offsets"].tolist()
        connectivity = cache["cell_nodes"].tolist()
    require(types == mesh["cells"]["types"] == ["tet4"]*85980 and
            offsets == mesh["cells"]["offsets"] == list(range(0,4*85980+1,4)) and
            len(connectivity) == len(mesh["cells"]["nodes"]) == 4*85980,
            "Retained fine cache/public source count or shape differs")
    def geometry(xyz, indices):
        require(all(type(i) is int and 0 <= i < len(xyz) for i in indices),"Retained fine connectivity differs")
        return Counter(tuple(sorted(struct.pack("<3d",*xyz[i]) for i in indices[j:j+4]))
                       for j in range(0,len(indices),4))
    cached = geometry(nodes,connectivity)
    require(all(n == 1 for n in cached.values()) and cached == geometry(mesh["nodes"],mesh["cells"]["nodes"]),
            "Retained fine public tetrahedra differ from cache")
    require(file_pin(cache_path,8*1024*1024) == before,"Retained fine cache changed during read")
    return {"cells":85980,"cache_sha256":before["sha256"],"geometry_equal":True,"new_mesh":False}


def verify_retained_fine_physics(problem):
    expected_stage = {
        "id":"inspect_gsg","source_object_id":"antenna","current_transport_id":"gsg_charge",
        "port_mode_ids":["gsg_port"],"model":"quasistatic_conduction_biot_savart3d",
        "oersted_realization":"direct_tetra_quadrature","conductor_mesh_policy":"authored_shared_domain",
        "field_sampling_domain":{"kind":"global"},"target_refs":[{"kind":"global"}],
        "solver_policy":"volume_inspection_v1","outputs":[{"id":"gsg_inspection","quantity":"H_ant_basis"}]}
    expected_transport = {
        "kind":"current_transport","name":"gsg_charge","model":"ohmic_poisson","coupling":"one_way",
        "domain":[{"object_id":"antenna"}],"boundaries":[],"gauge":"zero_mean",
        "solver":{"engine":"cg","linear":{"absolute_tolerance":0.0,"max_iterations":10000,
                  "relative_tolerance":1e-12},
                  "operator_version":"fem_charge_conforming_h1_p1.transparent.v1",
                  "physical_residual_version":"charge_balance_integrated_l2.v1"}}
    expected_port = {
        "branches":[{"id":part,"inlet_terminal_ref":part+"_in","outlet_terminal_ref":part+"_out",
                     "signed_weight":0.0} for part in ("signal","ground_left","ground_right")],
        "current_transport_id":"gsg_charge","id":"gsg_port",
        "normalization":{"kind":"source_cut_rt0","orientation":"minus_outward","source_cut_ref":"inlet_cut"},
        "normalization_current_a":1.0,"schema_version":"antenna_port_mode.v3","source_object_id":"antenna"}
    require(problem.get("antenna_field_solve_stages") == [expected_stage],
            "Retained fine antenna stage/field policy differs")
    modules = problem.get("current_modules", [])
    require(len(modules) == 1 and
            {key:modules[0].get(key) for key in expected_transport} == expected_transport,
            "Retained fine current operator/gauge/tolerances differ")
    require(problem.get("antenna_port_modes") == [expected_port],
            "Retained fine port normalization differs")
    require(problem.get("magnets") == [] and problem.get("energy_terms") == [],
            "Retained fine field-only physics differs")


def verify_retained_fine_request(value, report, input_root, operation_id):
    require(input_root == Path(CORNER12P5_INPUT),"Retained fine source alias differs")
    key = "gsg-retained-corner12p5-prepare-"+operation_id
    intent = value["run_intent"]
    require(intent["idempotency_key"] == key and
            intent["specification"]["run_id"] == "run-"+digest(key.encode()),
            "Retained fine run identity differs")
    require(intent["specification"]["requested_execution"] == {
        "backend":"fem","device":"cpu","mode":"strict","precision":"double",
        "minimum_resources":{"cpu_millis":1000,"memory_bytes":4294967296,
                             "gpu_memory_bytes":0,"storage_bytes":536870912}},
        "Retained fine execution/resources differ")
    require(report["source_cells"] == 85980,"Retained fine source cell count differs")
    problem=value["study_problem_catalog"]["entries"][0]["problem"]
    verify_retained_fine_physics(problem)
    metadata=problem["problem_meta"]["runtime_metadata"]
    stem=Path(CORNER12P5_SCRIPT).stem
    require(metadata.get("output_storage") == {
        "output_dir":stem+".zarr","temp_dir":None,"data_format":"zarr",
        "cleanup":"on_success","existing_output":"error"} and
        metadata.get("output_storage_source_dir") == str(input_root) and
        metadata.get("output_storage_source_stem") == stem,
        "Retained fine sibling output storage differs")
    geometry=problem["geometry_assets"]
    source=problem["current_modules"][0]["conservative_current_source"]
    mesh=next(a["mesh"] for a in geometry["fem_mesh_assets"] if a["geometry_name"] == source["geometry_id"])
    return verify_retained_fine_cache_mesh(mesh,input_root/RETAINED_FINE_CACHE)


def warm_input(output, request, proof):
    level = request["level"]
    if level == CORNER12P5_LEVEL:
        input_root = Path(CORNER12P5_INPUT)
        verify_corner12p5_script((input_root / CORNER12P5_SCRIPT).read_bytes())
    else:
        input_root = output / "input"
        input_root.mkdir()
        for name, pin in ((producer_script(level), LEVELS[level]), (CARRIER, CARRIER_SHA)):
            source = Path(INPUTS) / name
            require(file_pin(source, 8*1024*1024)["sha256"] == pin, "Original producer input changed")
            raw = source.read_bytes()
            require(digest(raw) == pin, "Producer input changed while copying")
            with (input_root / name).open("xb") as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        sync_directories(input_root)
    command = inventory_command(input_root, level)
    before = preparation_phase(output, input_root, proof, "inventory-before", command)["capture"]
    if level == CORNER12P5_LEVEL:
        require(not any(".fullmag/local/cache/" in row["relative_path"] for row in before["records"]),
                "corner12p5 requires a fresh producer, not an existing mesh cache")
    bootstrap = ("import hashlib,sys;sys.path.insert(0,'/opt/fullmag/source/scripts');"
                 "p=sys.argv[1];b=open(p,'rb').read();assert hashlib.sha256(b).hexdigest()==sys.argv[2];"
                 "n={'__name__':'gsg_cache_producer','__file__':p};exec(compile(b,p,'exec'),n);"
                 "n['produce_mesh'](sys.argv[3],sys.argv[4],sys.argv[5])")
    report_path = output / "producer-report.json"
    preparation_phase(output, input_root, proof, "mesh-producer", [PYTHON, "-X", "utf8", "-B", "-S", "-c", bootstrap, __file__,
          request["controller_sha256"], str(input_root), level, str(report_path)], json_output=False)
    require(file_pin(report_path, MAX_METADATA)["bytes"] <= MAX_METADATA, "Producer report exceeds bound")
    producer = decode(report_path.read_bytes())
    after = preparation_phase(output, input_root, proof, "inventory-after", command)["capture"]
    added = check_cache_inventory(before, after, level)
    caches = {row["absolute_path"]: file_pin(row["absolute_path"], 8*1024*1024) for row in added.values()}
    require(all(caches[row["absolute_path"]] == {"sha256": row["sha256"], "bytes": row["byte_count"]}
                for row in added.values()), "Produced mesh cache changed before capture")
    proof.update(producer_report_sha256=file_pin(report_path, MAX_METADATA)["sha256"],
                 producer_inventory_sha256=after["inventory_sha256"], cache_pins=caches, input_root=str(input_root))
    return input_root, producer, after


def frozen_files(level):
    h_only = level == H_ONLY_LEVEL
    fine_retained = level == RETAINED_FINE_LEVEL
    retained = level in (RETAINED_LEVEL, H_ONLY_LEVEL, RETAINED_FINE_LEVEL)
    fixed_files = ({**{path: FIXED_FILES[path] for path in (PROJECT, PROFILE, RESOURCES)},
                    **{str(Path(H_ONLY_INPUT if h_only else CORNER12P5_INPUT if fine_retained else RETAINED_INPUT) / name): pin
                        for name, pin in (H_ONLY_FILES if h_only else RETAINED_FINE_FILES if fine_retained else RETAINED_FILES).items()}}
                   if retained else FIXED_FILES)
    if level == CORNER12P5_LEVEL:
        fixed_files = {**{path: FIXED_FILES[path] for path in (PROJECT, PROFILE, RESOURCES)},
                       **{str(Path(CORNER12P5_INPUT) / name): pin for name,pin in CORNER12P5_FILES.items()}}
    return fixed_files


def preflight_inputs(pins, level, source_sha):
    # Verify the same bounded input pins before acquiring the operation lease.
    bootstrap = ("import hashlib,sys;sys.path.insert(0,'/opt/fullmag/source/scripts');"
                 "p='/opt/fullmag/source/scripts/docker_gsg_mesh_preparation.py';b=open(p,'rb').read();"
                 "assert hashlib.sha256(b).hexdigest()==sys.argv[1];n={'__name__':'gsg_input_preflight','__file__':p};"
                 "exec(compile(b,p,'exec'),n);files=n['frozen_files'](sys.argv[2]);"
                 "assert all(n['file_pin'](p,64*1024*1024)['sha256']==sha for p,sha in files.items());"
                 "print('INPUTS_VERIFIED')")
    result = docker_capture("exec", pins["backend_container_id"], "/usr/local/bin/python3", "-B", "-c",
                            bootstrap, source_sha, level, timeout=60)
    require(result.stdout.strip() == b"INPUTS_VERIFIED", "Preparation input preflight did not pass")


def guest(request_path, request_sha):
    raw = Path(request_path).read_bytes(); require(digest(raw) == request_sha, "Guest request pin differs")
    request = decode(raw); output = Path(request_path).parent
    require(output.is_relative_to(Path("/opt/fullmag/control") / OUTPUTS) and output.name == request["operation_id"], "Guest output escaped operation")
    h_only = request["level"] == H_ONLY_LEVEL
    fine_retained = request["level"] == RETAINED_FINE_LEVEL
    retained = request["level"] == RETAINED_LEVEL or h_only or fine_retained
    require((request["level"] in LEVELS or retained or request["level"] == CORNER12P5_LEVEL) and request["schema"] == "fullmag.gsg-junction-preparation.v1", "Guest request family differs")
    fixed_files = frozen_files(request["level"])
    def inputs():
        values = {path: file_pin(path, 64*1024*1024) for path in fixed_files}
        require(all(values[path]["sha256"] == pin for path, pin in fixed_files.items()), "Frozen preparation input changed")
        controller = file_pin(__file__, MAX_METADATA)
        require(controller["sha256"] == request["controller_sha256"], "Controller source changed")
        receipt = Path("/opt/fullmag/package/backend-build-receipt.json")
        require(file_pin(receipt, 16*1024*1024)["sha256"] == request["backend_build_receipt_sha256"], "Current package receipt changed")
        package = decode(receipt.read_bytes())
        artifact = next(row for row in package["artifacts"] if row["path"] == "bin/fullmag-bin")
        binary = file_pin(CLI, 2*1024*1024*1024, sealed=True)
        require(binary["sha256"] == artifact["sha256"], "Packaged CLI differs from successful receipt")
        return {"files": values, "cli": binary, "controller": controller}
    proof = {"schema": "fullmag.gsg-junction-preparation-result.v1", "request_sha256": request_sha,
             "child_reaped": True, "child_pid": None, "child_exit_code": None, "exit_code": 2, "new_solve": False,
             "qualified_basis": False, "qualification": "NOT VERIFIED", "inputs": None}
    try:
        before = inputs()
        proof["inputs"] = before
        affinity = configure_guest_resources()
        publish(output / "started.json", {"request_sha256": request_sha, "pid": os.getpid(), "new_solve": False,
                "affinity": affinity,
                "process_start_token": Path("/proc/self/stat").read_text().rsplit(")",1)[1].split()[19]})
        temporary = output / "tmp"; temporary.mkdir(); sync_directories(temporary)
        environment = {**os.environ, "TMPDIR": str(temporary), "PYTHONDONTWRITEBYTECODE": "1"}
        if retained:
            input_root = Path(H_ONLY_INPUT if h_only else CORNER12P5_INPUT if fine_retained else RETAINED_INPUT)
            warmed_inventory = preparation_phase(output, input_root, proof, "inventory-before",
                inventory_command(input_root, request["level"]))["capture"]
            (verify_h_only_inventory if h_only else verify_retained_fine_inventory if fine_retained else verify_retained_inventory)(warmed_inventory, input_root)
            proof.update(input_root=str(input_root), reused_mesh=True,
                cache_pins={} if h_only else {str(input_root / (RETAINED_FINE_CACHE if fine_retained else RETAINED_CACHE)): before["files"][str(input_root / (RETAINED_FINE_CACHE if fine_retained else RETAINED_CACHE))]})
        else:
            input_root, producer, warmed_inventory = warm_input(output, request, proof)
        require(inputs() == before, "Preparation inputs drifted before public CLI")
        proof["child_reaped"] = False
        code, totals, spool_errors, child_pid = capture_cli(
            cli_command(request["level"], request["operation_id"], input_root=input_root), output, environment, input_root=input_root)
        proof.update(child_reaped=True, child_pid=child_pid, child_exit_code=code, stream_bytes=totals, last_phase="public-cli",
                     public_cli={"child_reaped": True, "child_pid": child_pid, "exit_code": code})
        require(inputs() == before, "Preparation inputs drifted after public CLI")
        require(not spool_errors, "Bounded spool failed after child reap: " + str(spool_errors))
        require(code == 0, "Public CLI preparation refused")
        require(totals["request.pretty.json"] <= MAX_STDOUT and totals["stderr.log"] <= MAX_METADATA,
                "CLI output exceeded bounded complete spool")
        pretty = (output / "request.pretty.json").read_bytes()
        value, compact = normalize_request(pretty)
        with (output / "request.compact.json").open("xb") as stream:
            stream.write(compact);stream.flush();os.fsync(stream.fileno())
        from fullmag.meshing.persistence import load_mesh_artifact
        carrier_name = H_ONLY_CARRIER if h_only else CARRIER
        carrier_pin = H_ONLY_FILES[H_ONLY_CARRIER] if h_only else CARRIER_SHA
        carrier_source = str(input_root / carrier_name) if retained or request["level"] == CORNER12P5_LEVEL else INPUTS + "/" + CARRIER
        carrier = load_mesh_artifact(carrier_source, expected_sha256=carrier_pin).mesh.to_ir("sampling")
        entries = value["study_problem_catalog"]["entries"]
        require(len(entries) == 1, "Exactly one complete antenna stage required")
        proof.update(status="PREPARED INPUT ONLY / NOT VERIFIED", exit_code=0,
            pretty_request_sha256=digest(pretty), compact_request_sha256=digest(compact), compact_request_bytes=len(compact),
            catalog_sha256=digest(canonical(value["study_problem_catalog"])),
            mesh=verify_h_only_request(value, carrier, input_root, request["operation_id"]) if h_only else mesh_report(entries[0]["problem"], carrier, level=request["level"]))
        if fine_retained:
            proof["cache_geometry"] = verify_retained_fine_request(value,proof["mesh"],input_root,request["operation_id"])
        elif retained and not h_only:
            verify_retained_request(value, proof["mesh"], input_root, request["operation_id"])
        elif not retained:
            require_same_mesh(producer["mesh"], proof["mesh"])
        final_inventory = preparation_phase(output, input_root, proof, "inventory-final",
            inventory_command(input_root, request["level"]))["capture"]
        require_same_inventory(warmed_inventory, final_inventory)
        for path, pin in proof["cache_pins"].items():
            require(file_pin(path, 8*1024*1024) == pin, "Readonly capture changed produced cache")
        require(inputs() == before, "Preparation inputs changed during result validation")
    except Exception as error:
        proof.update(status="REFUSED / NOT PREPARED", exit_code=2, error=type(error).__name__ + ": " + str(error))
    publish(output / "result.json", proof)
    return proof["exit_code"]


def run(args):
    from docker_dev import _select_source, _compose_identity
    require_host()
    require(args.level in LEVELS or args.level in (RETAINED_LEVEL, H_ONLY_LEVEL, CORNER12P5_LEVEL, RETAINED_FINE_LEVEL), "Only frozen 50/35/25 nm, corner25 or retained-corner25 inputs allowed")
    selected, layout = _select_source(args.source_root, args.source_root); identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    control.prepare()
    if getattr(args, "close_prestart", False):
        return close_prestart(args, control, selected, identity)
    source = Path(__file__).read_bytes(); source_sha = digest(source)
    admission = {"allow_no_archive": True} if args.level in (RETAINED_LEVEL, H_ONLY_LEVEL, CORNER12P5_LEVEL, RETAINED_FINE_LEVEL) else {}
    pins = reference.qualified_backend(control, selected, identity, args.attempt, args.config_sha256, **admission)
    preflight_inputs(pins, args.level, source_sha)
    with control.operation("gsg-mesh-preparation", {**pins, "level": args.level, "controller_sha256": source_sha, "new_solve": False}) as operation:
        require(reference.qualified_backend(control, selected, identity, args.attempt, args.config_sha256, **admission) == pins, "Backend changed during admission")
        identifier = operation["receipt"]["attempt"]; root = OUTPUTS + "/" + identifier
        request = {**pins, "schema": "fullmag.gsg-junction-preparation.v1", "operation_id": identifier,
                   "level": args.level, "controller_sha256": source_sha}
        if args.level not in (RETAINED_LEVEL, H_ONLY_LEVEL, CORNER12P5_LEVEL, RETAINED_FINE_LEVEL):
            request["input_validation_sha256"] = VALIDATION_SHA
        raw = canonical(request) + b"\n"; pin = digest(raw)
        reference.immutable(control, root + "/controller.py", source)
        reference.immutable(control, root + "/request.json", raw)
        bootstrap = "import hashlib,sys;sys.path.insert(0,'/opt/fullmag/source/scripts');p=sys.argv[1];b=open(p,'rb').read();assert hashlib.sha256(b).hexdigest()==sys.argv[2];n={'__name__':'gsg_mesh_worker','__file__':p};exec(compile(b,p,'exec'),n);sys.exit(n['guest'](sys.argv[3],sys.argv[4]))"
        operation["daemon_pending"] = True
        result = docker_capture("exec", pins["backend_container_id"], "/usr/local/bin/python3", "-B", "-c", bootstrap,
            "/opt/fullmag/control/" + root + "/controller.py", source_sha, "/opt/fullmag/control/" + root + "/request.json", pin,
            timeout=43200, allow_failure=True)
        for stream in ("stdout", "stderr"):
            data = getattr(result, stream, b"")
            require(isinstance(data, bytes) and len(data) <= MAX_METADATA, "Bootstrap output exceeds byte bound")
            reference.immutable(control, root + "/bootstrap." + stream + ".log", data)
        proof_raw = control.read_bytes(root + "/result.json", optional=True)
        require(proof_raw is not None, "Child completion is unknown; resources retained")
        proof = decode(proof_raw)
        require(proof.get("schema") == "fullmag.gsg-junction-preparation-result.v1" and proof.get("request_sha256") == pin and
                proof.get("child_reaped") is True and proof.get("new_solve") is False and proof.get("exit_code") == result.returncode,
                "CLI/client completion differs; resources retained")
        operation["daemon_pending"] = False
        require(Path(__file__).read_bytes() == source and reference.qualified_backend(control, selected, identity, args.attempt, args.config_sha256, **admission) == pins,
                "Source/backend changed during preparation")
        operation["receipt"].update(state="succeeded" if result.returncode == 0 else "failed-confirmed", exit_code=result.returncode,
            result_sha256=digest(proof_raw), qualification="NOT VERIFIED", output_root=root)
        print(json.dumps({"status": proof["status"], "exit_code": result.returncode, "output_root": root, "new_solve": False}))
        return result.returncode


PRESTART_SCHEMA = "fullmag.gsg-prestart-input-failure.v1"
PRESTART_ATTEMPT = "aa71dbaad5104e3f81870156ffca0a70"
PRESTART_RECEIPT = "1b5a0e53c3107623320b2e7652fcbcda53822e669a04a7b21a19a6be64551d68"
PRESTART_CONTROLLER = "dd2c7e31bcfacc6eac9b930989b439816c00680c5b4f37ef51900c340f6e0fcf"
PRESTART_REQUEST = "8f416327d1029ad3430cc9c996d0bc548465c1abc009ce3ffd223ddb097610db"
PRESTART_EXEC_SHA = "fd52088da7e4cf5f05ef0621bb58b559ffa5a8a810b91206d1505218dfb9710b"
PRESTART_HISTORY = ".superpowers/sdd/2026-11-12-gsg-retained-corner12p5-86k-continuation-proposal/historical-aa71-exec-inspect.json"
PRESTART_PROBE = r"""import hashlib,json,os,sys,urllib.request
from pathlib import Path
root=Path(sys.argv[1]); tokens={str(root/'controller.py').encode(),str(root/'request.json').encode()}
assert root.resolve(strict=True)==root
files={}
for p in root.iterdir():
 assert not p.is_symlink() and p.is_file() and p.stat().st_size<=1024*1024
 files[p.name]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
matches=[]; unreadable=0
for p in Path('/proc').iterdir():
 if not p.name.isdigit() or int(p.name)==os.getpid():continue
 try:
  if tokens.intersection((p/'cmdline').read_bytes().split(b'\0')):matches.append(p.name)
 except FileNotFoundError:pass
 except PermissionError:unreadable+=1
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/compute/queue',timeout=10) as response:
 queue=json.load(response)
print(json.dumps({'files':files,'processes':matches,'unreadable':unreadable,
 'alias_missing':not os.path.lexists('/opt/fullmag/script-output'),'queue_items':queue['items']},sort_keys=True))
"""


def validate_prestart_probe(value):
    require(isinstance(value, dict) and set(value) ==
            {"files", "processes", "unreadable", "alias_missing", "queue_items"}, "Closed prestart probe required")
    require(value["files"] == {"controller.py": {"sha256": PRESTART_CONTROLLER, "bytes": 56049},
                               "request.json": {"sha256": PRESTART_REQUEST, "bytes": 1070}},
            "Preparation may have started or its frozen inputs changed")
    require(value["processes"] == [] and type(value["unreadable"]) is int and value["unreadable"] == 0
            and value["alias_missing"] is True and value["queue_items"] == [],
            "Prestart process/input/queue absence is not proven")


def prestart_preview(control, selected, identity, args):
    import docker_volume_reconcile as recovery
    from docker_volume_resume_preflight_recovery import LOCK_PROBE
    from docker_volume_activation_reconcile import _validate_helper_logged
    root = "gsg-mesh-preparation/attempts/" + PRESTART_ATTEMPT
    original_raw = recovery.read_raw(control, root + "/receipt.json")
    require(digest(original_raw) == PRESTART_RECEIPT, "Audited unknown receipt differs")
    original = decode(original_raw)
    require(original.get("state") == "outcome-unknown-resources-retained"
            and original.get("phase") == "gsg-mesh-preparation"
            and original.get("attempt") == PRESTART_ATTEMPT
            and original.get("compose_project") == control.project
            and original.get("control_volume") == control.volume, "Original operation identity differs")
    require(recovery.read_raw(control, "active").strip() == PRESTART_ATTEMPT.encode()
            and recovery.read_raw(control, root + "/terminal.json", True) is None
            and recovery.read_raw(control, root + "/build.log") == b"", "Original lease/log/terminal changed")
    pins = reference.qualified_backend(control, selected, identity, args.attempt, args.config_sha256, allow_no_archive=True)
    require(original["inputs"] == {**pins, "level": RETAINED_FINE_LEVEL,
            "controller_sha256": PRESTART_CONTROLLER, "new_solve": False}, "Original package/source pins differ")
    history = (selected / PRESTART_HISTORY).read_bytes()
    require(digest(history) == PRESTART_EXEC_SHA, "Historical Engine exit attestation changed")
    observed_exit = decode(history)
    require(observed_exit["Running"] is False and observed_exit["ExitCode"] == 1
            and observed_exit["ContainerID"] == pins["backend_container_id"], "Historical exec is not terminal")
    helper = control._inspect_operation_helper({"receipt": original},
        expected_id="11d592b5c1c2104ee98556cbe12f43d55d8bfa90fb06219edae1166b696b5571")
    helper_row = decode(docker_capture("inspect", helper).stdout)[0]
    require(helper_row["HostConfig"].get("ReadonlyRootfs") is True
            and helper_row["HostConfig"].get("Privileged") is False, "Original helper isolation differs")
    _validate_helper_logged(helper)
    locked = docker_capture("exec", helper, "/bin/bash", "-euo", "pipefail", "-c", LOCK_PROBE)
    require(locked.stdout.strip() == b"OWNER_LOCKED", "Original helper lock is not proven")
    output = "/opt/fullmag/control/" + OUTPUTS + "/" + PRESTART_ATTEMPT
    probe = decode(docker_capture("exec", pins["backend_container_id"], "/usr/local/bin/python3", "-B", "-c",
                                 PRESTART_PROBE, output, timeout=30).stdout)
    validate_prestart_probe(probe)
    # This absence supplements the historical exit; a missing Engine exec record alone is insufficient.
    verified = recovery.read_raw(control, "gsg-mesh-preparation/verified.json", True)
    preview = {"schema": PRESTART_SCHEMA, "attempt": PRESTART_ATTEMPT,
        "unknown_receipt_sha256": PRESTART_RECEIPT, "historical_exec_sha256": PRESTART_EXEC_SHA,
        "controller_sha256": digest(Path(__file__).read_bytes()), "pins": pins, "probe": probe,
        "helper_id": helper, "helper_fingerprint": recovery.fingerprint(helper_row),
        "helper_image": helper_row["Image"], "verified_sha256": None if verified is None else digest(verified)}
    return preview, original_raw


def close_prestart(args, control, selected, identity):
    import copy, time
    import docker_volume_reconcile as recovery
    from docker_build_control import ControlOutcomeUnknown
    request, original_raw = prestart_preview(control, selected, identity, args)
    raw = canonical(request) + b"\n"; request_sha = digest(raw)
    root = "gsg-mesh-preparation/attempts/" + PRESTART_ATTEMPT
    journal = root + "/reconciliation"
    recovery.write_immutable(control, journal + "/previews/" + request_sha + ".json", raw)
    if not args.preview_sha256:
        print(json.dumps({"status": "PREVIEW ONLY", "preview_sha256": request_sha, "attempt": PRESTART_ATTEMPT}))
        return 0
    require(args.preview_sha256 == request_sha, "Fresh preview differs; no apply")
    observer = "fullmag-gsg-prestart-close-" + PRESTART_ATTEMPT
    claim = subprocess.Popen(control.helper_args(recovery.claim_script(control, root, request, PRESTART_RECEIPT,
        phase="gsg-mesh-preparation", publish_verified=False), name=observer),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    begun = False
    try:
        require(control._line(claim) == "READY", "Observer lease was not acquired")
        rows = decode(docker_capture("inspect", observer).stdout); require(len(rows) == 1, "Ambiguous observer")
        recovery.validate_original_owner(rows[0], {"helper_container": observer}, control, request["helper_image"])
        require(rows[0]["State"]["Running"] is True, "Observer is not live")
        require(prestart_preview(control, selected, identity, args)[0] == request, "Proof changed before BEGIN")
        recovery.write_immutable(control, root + "/unknown-receipt.json", original_raw)
        recovery.write_immutable(control, journal + "/historical-exec.json", (selected/PRESTART_HISTORY).read_bytes())
        begun = True; claim.stdin.write(b"BEGIN\n"); claim.stdin.flush()
        require(control._line(claim) == "OBSERVING", "Observer BEGIN outcome unknown")
        result = copy.deepcopy(decode(original_raw))
        result.update(state="failed-confirmed", exit_code=1, qualification="NOT VERIFIED",
            reconciliation={"schema": PRESTART_SCHEMA, "preview_sha256": request_sha,
                            "historical_exec_sha256": PRESTART_EXEC_SHA, "new_solve": False,
                            "reason": "Audited guest exited before started.json; input alias absent"},
            finished_at=time.time())
        result_raw = canonical(result) + b"\n"; result_sha = digest(result_raw)
        recovery.write_immutable(control, journal + "/" + result_sha + "/result.json", result_raw)
        require(prestart_preview(control, selected, identity, args)[0] == request, "Proof changed before COMMIT")
        require(claim.poll() is None, "Observer disappeared before COMMIT")
        claim.stdin.write(("COMMIT " + result_sha + "\n").encode()); claim.stdin.flush(); claim.stdin.close()
        require(control._line(claim) == "COMMITTED", "Terminal publication outcome unknown")
        require(recovery.read_raw(control, root + "/terminal.json") == result_raw, "Published terminal differs")
        verified = recovery.read_raw(control, "gsg-mesh-preparation/verified.json", True)
        require((None if verified is None else digest(verified)) == request["verified_sha256"], "Verified result changed")
        deadline = time.monotonic() + 30
        while recovery.read_raw(control, "active", True) is not None:
            require(time.monotonic() < deadline, "Original helper has not confirmed release"); time.sleep(.25)
        require(claim.wait(timeout=5) == 0, "Observer exit unconfirmed")
        print(json.dumps({"state": "failed-confirmed", "attempt": PRESTART_ATTEMPT,
                          "result_sha256": result_sha, "original_helper_released": True, "new_solve": False}))
        return 0
    except BaseException as error:
        if begun:
            raise ControlOutcomeUnknown("GSG close outcome unknown; original/observer leases retained") from error
        raise
    finally:
        if claim.stdin is not None and not claim.stdin.closed: claim.stdin.close()
        if not begun: claim.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--level", choices=(*LEVELS, RETAINED_LEVEL, H_ONLY_LEVEL, CORNER12P5_LEVEL, RETAINED_FINE_LEVEL), required=True)
    parser.add_argument("--close-prestart", action="store_true")
    parser.add_argument("--preview-sha256", default="")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
