"""Exact arithmetic diagnostics of saved canonical fluxes, never a new solve.

Only face moments and the cut potential are audited. Rounded cell-local J traces
and the old rounded-J power integral are not certified by this diagnostic.
"""
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import struct

BUNDLE_SHA = "05df2b7c899b92686ccb54ab62bfd62ffea3b0cc5710fa7d3dfdd0f8dfa67d3a"
ASSET_SHA = "74875b82f956a68b73b9b9f909c6abee0c82b4ce650ed779e8b29c386efcd4ef"
SELECTED = {"cells", "faces", "vertex_xyz", "stable_vertex_ids", "v_raw"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_selected_bundle(path, expected_sha256):
    """Stream every payload hash, retaining only the five diagnostic arrays."""
    path = Path(path)
    require(path.resolve(strict=True) == path, "linked or noncanonical bundle")
    before = path.stat()
    require(20 <= before.st_size <= 256*1024**2, "bundle size differs")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        def read(size):
            value = stream.read(size)
            require(len(value) == size, "truncated bundle")
            digest.update(value)
            return value
        require(read(8) == b"FMACLB01", "bundle magic differs")
        length, count = struct.unpack("<QI", read(12))
        require(0 < length <= 16*1024**2 and 0 < count <= 256, "manifest bounds differ")
        manifest = json.loads(read(length))
        require(manifest["schema_version"] == "antenna_field_solution.v2"
                and manifest["status"] == "inspection_only", "bundle family differs")
        descriptors = manifest["payloads"]
        require(len(descriptors) == count and SELECTED <= descriptors.keys(), "payload closure differs")
        expected = {v["path"]: (k, v) for k, v in descriptors.items()}
        require(len(expected) == count, "duplicate payload descriptor")
        previous, data = "", {}
        for _ in range(count):
            n, = struct.unpack("<H", read(2))
            require(0 < n <= 1024, "payload path length differs")
            name = read(n).decode("ascii")
            size, = struct.unpack("<Q", read(8))
            require(name > previous and name in expected, "unordered or foreign payload")
            key, descriptor = expected[name]
            require(name == f"antenna/field_solutions/{manifest['solution_id']}/{key}.bin"
                    and 0 < size <= before.st_size and size == descriptor["byte_length"],
                    "payload descriptor differs")
            payload_hash, chunks, remaining = hashlib.sha256(), [], size
            while remaining:
                block = read(min(remaining, 1024**2))
                payload_hash.update(block)
                if key in SELECTED:
                    chunks.append(block)
                remaining -= len(block)
            require(payload_hash.hexdigest() == descriptor["sha256"], "payload digest differs")
            if key in SELECTED:
                data[key] = b"".join(chunks)
            previous = name
        require(not stream.read(1), "trailing bundle bytes")
    after = path.stat()
    identity = lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    require(identity(before) == identity(after) and digest.hexdigest() == expected_sha256,
            "bundle changed or digest differs")
    return manifest, data


def exact(value):
    require(type(value) is float and math.isfinite(value), "expected finite binary64")
    return Fraction.from_float(value)


def sub(a, b):
    return tuple(x-y for x, y in zip(a, b))


def dot(a, b):
    return sum((x*y for x, y in zip(a, b)), Fraction(0))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def residual_summary(values, unit):
    """Serialize exact fractions as text as well as a display-only float."""
    values = list(values)
    largest = max(map(abs, values), default=Fraction(0))
    return dict(count=len(values), nonzero_count=sum(v != 0 for v in values),
                maximum_absolute_exact=str(largest), maximum_absolute_approx=float(largest), unit=unit)


def audit_fluxes(nodes, cells, face_fluxes, cut):
    """Check exact signed incidence sums for the field defined by face DOFs."""
    incidence, balances = {}, []
    for cell in cells:
        require(len(cell) == len(set(cell)) == 4 and all(i in nodes for i in cell), "invalid Tet4")
        points = [nodes[i] for i in cell]
        determinant = dot(sub(points[1],points[0]),cross(sub(points[2],points[0]),sub(points[3],points[0])))
        require(determinant != 0, "degenerate Tet4")
        total = Fraction(0)
        for opposite in range(4):
            local = [cell[i] for i in range(4) if i != opposite]
            face = tuple(sorted(local))
            require(face in face_fluxes, "missing canonical face")
            inversions = sum(local[i] > local[j] for i in range(3) for j in range(i+1,3))
            sign = (-1 if (opposite+inversions)%2 else 1)*(1 if determinant > 0 else -1)
            incidence.setdefault(face, []).append(sign)
            total += sign*face_fluxes[face]
        balances.append(total)
    require(incidence.keys() == face_fluxes.keys(), "unreferenced canonical face")
    require(all(len(s) in (1,2) and (len(s) == 1 or sum(s) == 0)
                for s in incidence.values()), "nonmanifold or inconsistently oriented faces")
    cuts, pair_residuals, areas, currents = set(), [], [], {"minus":Fraction(0), "plus":Fraction(0)}
    for pair in cut["face_pairs"]:
        outward, area_vectors = {}, []
        for side in currents:
            face = tuple(sorted(pair[side+"_face_vertex_ids"]))
            require(face not in cuts and face in incidence and len(incidence[face]) == 1,
                    "duplicate, absent or interior cut face")
            cuts.add(face)
            outward[side] = incidence[face][0]*face_fluxes[face]
            currents[side] += outward[side]
            a,b,c = [nodes[i] for i in face]
            area_vectors.append(tuple(incidence[face][0]*v/2 for v in cross(sub(b,a),sub(c,a))))
        pair_residuals.append(outward["minus"]+outward["plus"])
        areas.extend(x+y for x,y in zip(*area_vectors))
    exterior = [face_fluxes[f] for f, s in incidence.items() if len(s) == 1 and f not in cuts]
    return dict(cell_balance=audit_summary(balances), insulating_boundary=audit_summary(exterior),
                paired_cut_balance=audit_summary(pair_residuals),
                paired_cut_area_opposition=residual_summary(areas,"m^2"),
                face_count=len(incidence), interior_face_count=sum(len(s)==2 for s in incidence.values()),
                cut_face_count=len(cuts), signed_outward_current_exact_A={k:str(v) for k,v in currents.items()},
                total_cut_current_exact_A=str(sum(currents.values(), Fraction(0))))


def audit_summary(values):
    return residual_summary(values, "A")


def audit_cut_potential(nodes, potentials, cut):
    """Pair nodes by exact translated geometry, then test the exact P1 jump."""
    translation = tuple(exact(float(x)) for x in cut["translation_m"])
    jump = exact(cut["potential_drop_v"])
    mapping = {}
    for pair in cut["face_pairs"]:
        minus_ids, plus_ids = (pair[k+"_face_vertex_ids"] for k in ("minus","plus"))
        require(len(set(minus_ids)) == len(set(plus_ids)) == 3, "invalid cut triangle")
        minus = {tuple(x+t for x,t in zip(nodes[i],translation)):i for i in minus_ids}
        plus = {nodes[i]:i for i in plus_ids}
        require(len(minus) == len(plus) == 3 and minus.keys() == plus.keys(), "cut geometry differs")
        for coordinate, pid in plus.items():
            mid = minus[coordinate]
            require(pid not in mapping or mapping[pid] == mid, "inconsistent cut mapping")
            mapping[pid] = mid
    require(len(set(mapping.values())) == len(mapping), "nonbijective cut mapping")
    residuals = [potentials[pid]-potentials[mid]-jump for pid,mid in mapping.items()]
    return dict(paired_vertices=len(mapping), jump=residual_summary(residuals,"V"),
                geometry_exactly_matched=True)


def run_saved_audit(bundle_path, asset_path):
    """Audit the single pinned corner25 artifact, without altering its status."""
    asset_raw = Path(asset_path).read_bytes()
    require(hashlib.sha256(asset_raw).hexdigest() == ASSET_SHA, "source preparation digest differs")
    asset = json.loads(asset_raw)
    manifest, data = read_selected_bundle(bundle_path, BUNDLE_SHA)
    require((manifest["cell_count"],manifest["vertex_count"]) == (40728,14194), "source counts differ")
    require(asset["parent_owner"]["package"]["object_ref"] == BUNDLE_SHA
            and manifest["full_closure"] == asset["prepared_source"]["closure"], "source owner or closure differs")
    require(all(v.startswith("sha256:") and manifest["source"][k] == v[7:]
                for k,v in asset["source_pins"].items()), "source pins differ")
    cut, = manifest["full_closure"]["source_cuts"]
    require(cut["translation_m"] == [0.,0.,0.] and cut["potential_drop_v"] == .001
            and len(cut["face_pairs"]) == 18, "pinned cut differs")
    require(len(data["stable_vertex_ids"]) == 14194*8 and len(data["vertex_xyz"]) == 14194*24
            and len(data["v_raw"]) == 14194*8 and len(data["cells"]) == 40728*280, "carrier lengths differ")
    ids = [r[0] for r in struct.iter_unpack("<Q",data["stable_vertex_ids"])]
    require(len(set(ids)) == 14194 and ids == asset["prepared_source"]["stable_vertex_ids"], "vertex IDs differ")
    nodes = dict(zip(ids,(tuple(map(exact,r)) for r in struct.iter_unpack("<3d",data["vertex_xyz"]))))
    potentials = dict(zip(ids,(exact(r[0]) for r in struct.iter_unpack("<d",data["v_raw"]))))
    cells = []
    for ordinal,row in enumerate(struct.iter_unpack("<5Q30d",data["cells"])):
        require(row[0] == ordinal and all(tuple(map(exact,row[5+3*j:8+3*j])) == nodes[i]
                for j,i in enumerate(row[1:5])), "cell coordinate carrier differs")
        cells.append(row[1:5])
    fluxes = {}
    for row in struct.iter_unpack("<3Qd",data["faces"]):
        face = row[:3]
        require(face == tuple(sorted(set(face))) and face not in fluxes, "noncanonical duplicate face")
        fluxes[face] = exact(row[3])
    flux = audit_fluxes(nodes,cells,fluxes,cut)
    potential = audit_cut_potential(nodes,potentials,cut)
    source_current = exact(manifest["source"]["source_current_a"])
    minus = Fraction(flux["signed_outward_current_exact_A"]["minus"])
    return dict(bundle_sha256=BUNDLE_SHA,source_preparation_sha256=ASSET_SHA,
                arithmetic="exact dyadic Fraction.from_float",flux=flux,cut_potential=potential,
                source_current_exact_A=str(source_current),minus_source_difference_exact_A=str(minus-source_current),
                complete_admissibility_verified=False,raw_J_trace_checked=False,
                rigorous_energy_bound_computed=False,new_solve=False,qualified_basis=False,
                publication_reproduced=False,
                ograniczenia="Audyt stopni swobody strumienia i skoku potencjału; nie sprawdza zaokrąglonych śladów J. Stara energia dotyczy zaokrąglonego raw J, nie tego kandydata z momentów.")
