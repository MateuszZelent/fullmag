"""Geometry-only admission for the fixed closed-loop preregistration; never solve V/J/H."""
from __future__ import annotations

import argparse
from collections import defaultdict
from copy import deepcopy
from dataclasses import replace
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import struct

MESH_SIZES_M = (0.15e-6, 0.10e-6, 0.075e-6)
TET_FACES = ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1))
LIMITS = {"native_source_target_pairs": 1_000_000, "oracle_evaluations_per_target": 100_000_000,
          "oracle_evaluations_per_case": 2_000_000_000, "h1_free_dof": 100_000,
          "rt0_flux_dof": 400_000, "ram_bytes": 2 * 1024**3}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def exact(point):
    return tuple(Fraction.from_float(float(x)) for x in point)


def subtract(a, b):
    return tuple(x - y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def determinant(a, b, c):
    return dot(a, cross(b, c))


def on_triangle(point, triangle):
    p = exact(point)
    a, b, c = map(exact, triangle)
    normal = cross(subtract(b, a), subtract(c, a))
    require(any(normal), "degenerate boundary triangle")
    if dot(normal, subtract(p, a)) != 0:
        return False
    return all(dot(normal, cross(subtract(y, x), subtract(p, x))) >= 0
               for x, y in ((a, b), (b, c), (c, a)))


def on_segment(point, endpoints):
    p, a, b = exact(point), exact(endpoints[0]), exact(endpoints[1])
    ab, ap = subtract(b, a), subtract(p, a)
    return not any(cross(ab, ap)) and dot(ap, ab) >= 0 and dot(ap, ab) <= dot(ab, ab)


def in_tetrahedron(point, tetrahedron):
    v = tuple(map(exact, tetrahedron))
    p = exact(point)
    d = determinant(subtract(v[1], v[0]), subtract(v[2], v[0]), subtract(v[3], v[0]))
    require(d > 0, "non-positive exact Tet4")
    w = (determinant(subtract(v[1], p), subtract(v[2], p), subtract(v[3], p)),
         determinant(subtract(p, v[0]), subtract(v[2], v[0]), subtract(v[3], v[0])),
         determinant(subtract(v[1], v[0]), subtract(p, v[0]), subtract(v[3], v[0])),
         determinant(subtract(v[1], v[0]), subtract(v[2], v[0]), subtract(p, v[0])))
    return all(x >= 0 for x in w), any(x == 0 for x in w)


def point_record(identifier, scope, xyz, expression=None):
    xyz = [float(x) for x in xyz]
    require(all(math.isfinite(x) for x in xyz), "nonfinite probe")
    return {"id": identifier, "scope": scope, "xyz_m": xyz,
            "binary64_hex": [x.hex() for x in xyz],
            "binary64_le_hex": struct.pack("<3d", *xyz).hex(), "expression": expression}


def probes(geometry, cut):
    constants = {"signal_top": geometry.thickness_m/2,
                 "return_side": geometry.return_width_m/2,
                 "return_center": -(geometry.thickness_m+geometry.return_offset_m),
                 "return_top": -(geometry.thickness_m+geometry.return_offset_m)+geometry.thickness_m/2,
                 "inlet_x": -geometry.inlet_connection_length_m,
                 "inlet_y": geometry.inlet_connection_width_m/2,
                 "mid_x": geometry.stations[1].s*geometry.length_m,
                 "mid_signal_side": geometry.stations[1].signal_width_m/2,
                 "sourcecut_z": cut.plane.offset_m}
    records = []
    groups = {"far": [(1,0,3),(-2,1,1),(4,-1,1)],
              "near": [(1,0,.11),(1,.06,0),(1,0,-.49),(-.21,0,-.3)],
              "inside": [(.5,0,0),(1,0,-.6),(-.1,0,-.2),(2.1,0,-.3)]}
    for scope, points in groups.items():
        prefix = {"far":"F", "near":"N", "inside":"I"}[scope]
        records.extend(point_record(f"{prefix}{i}", scope, [v*1e-6 for v in xyz])
                       for i, xyz in enumerate(points, 1))
    c = constants
    boundaries = [("S1","face",(c["mid_x"],0,c["signal_top"]),"mid_x,0,signal_top"),
                  ("S2","face",(c["mid_x"],c["return_side"],c["return_center"]),"mid_x,return_side,return_center"),
                  ("S3","face",(c["inlet_x"],0,-.2e-6),"inlet_x,0,fixed(-.2um)"),
                  ("E1","edge",(c["mid_x"],c["mid_signal_side"],c["signal_top"]),"mid_x,mid_signal_side,signal_top"),
                  ("E2","edge",(c["mid_x"],c["return_side"],c["return_top"]),"mid_x,return_side,return_top"),
                  ("E3","edge",(c["inlet_x"],c["inlet_y"],-.2e-6),"inlet_x,inlet_y,fixed(-.2um)"),
                  ("C1","sourcecut",(-.1e-6,0,c["sourcecut_z"]),"fixed(-.1um),0,sourcecut_z")]
    records.extend(point_record(*r) for r in boundaries)
    require(len(records)==18, "fixed 18 probes required")
    return constants, records


def mesh_arrays(mesh):
    import numpy as np
    require(set(mesh["cells"]["types"])=={"tet4"}, "actual Tet4 mesh required")
    nodes = np.asarray(mesh["nodes"], dtype=float)
    cells = np.asarray(mesh["cells"]["nodes"], dtype=int).reshape(-1,4)
    require(nodes.shape[1:]==(3,) and np.isfinite(nodes).all(), "finite mesh xyz required")
    require(len(cells)>0 and cells.min()>=0 and cells.max()<len(nodes), "invalid cell indexing")
    require(mesh["cells"]["offsets"]==list(range(0,4*len(cells)+1,4)), "noncanonical Tet4 offsets")
    return nodes, cells


def topology(nodes, cells):
    topological, physical = defaultdict(list), defaultdict(list)
    for ci, cell in enumerate(cells):
        for local in TET_FACES:
            indices = tuple(int(cell[k]) for k in local)
            topological[tuple(sorted(indices))].append((ci,indices))
            key = tuple(sorted(struct.pack("<3d", *nodes[i]) for i in indices))
            physical[key].append((ci,indices))
    require(all(len(v)<=2 for v in topological.values()), "nonmanifold topology")
    require(all(len(v)<=2 for v in physical.values()), "overlapping physical face")
    return topological, physical


def cut_pairs(nodes, cells, source, topological):
    ids = source["stable_vertex_ids"]
    require(len(ids)==len(nodes) and len(set(ids))==len(ids), "invalid stable node identities")
    by_id = {identity:i for i,identity in enumerate(ids)}
    pairs, faces = {}, []
    for cut in source["closure"]["source_cuts"]:
        require(cut["translation_m"]==[0.,0.,0.], "sourcecut cannot translate")
        for face in cut["face_pairs"]:
            minus = face["minus_face_vertex_ids"]; plus = face["plus_face_vertex_ids"]
            require(set(minus).isdisjoint(plus), "sourcecut DOFs must be distinct")
            minus_xyz = {struct.pack("<3d",*nodes[by_id[x]]):x for x in minus}
            plus_xyz = {struct.pack("<3d",*nodes[by_id[x]]):x for x in plus}
            require(minus_xyz.keys()==plus_xyz.keys() and len(minus_xyz)==3, "sourcecut xyz drift")
            for xyz, a in minus_xyz.items():
                b=plus_xyz[xyz]
                require(a not in pairs or pairs[a]==b, "nonbijective cut pairing")
                pairs[a]=b
            minus_indices=tuple(by_id[x] for x in minus)
            plus_indices=tuple(by_id[x] for x in plus)
            owners=[topological[tuple(sorted(indices))] for indices in (minus_indices,plus_indices)]
            require(all(len(side)==1 for side in owners), "cut face must own one Tet4")
            a,b,c=map(exact,nodes[list(minus_indices)])
            normal=cross(subtract(b,a),subtract(c,a))
            side_signs=[]
            outward_normals=[]
            for indices,owner in zip((minus_indices,plus_indices),owners):
                ci,outward_face=owner[0]
                apex=next(int(v) for v in cells[ci] if int(v) not in indices)
                side_signs.append(dot(normal,subtract(exact(nodes[apex]),a)))
                u,v,w=map(exact,nodes[list(outward_face)])
                outward_normals.append(cross(subtract(v,u),subtract(w,u)))
            require(side_signs[0]*side_signs[1]<0, "cut Tet4 owners must occupy opposite physical sides")
            require(all(x==-y for x,y in zip(*outward_normals)), "cut outward winding must be opposite")
            for side in (minus,plus):
                indices=tuple(by_id[x] for x in side)
                require(len(topological[tuple(sorted(indices))])==1, "cut face must own one Tet4")
                faces.append(indices)
    require(pairs and len(set(pairs.values()))==len(pairs), "empty/nonbijective cut")
    return pairs, faces


def semantic_owner_admission():
    # The current canonical retained mesh carries no authored CAD-face ownership ledger.
    return {"status":"INCONCLUSIVE", "admitted":False,
            "reason":"missing canonical CAD semantic boundary-owner ledger",
            "diagnostic_selectors_are_semantic_proof":False}


def check_planes(nodes, cells, source, constants, measurements=None, physical=None):
    markers={part["part_id"]:part["element_ordinals"] for part in source["material_parts"]}
    specs=(("signal",2,"max","signal_top"),("return",1,"max","return_side"),
           ("return",2,"max","return_top"),("inlet",0,"min","inlet_x"),
           ("inlet",1,"max","inlet_y"))
    refusals=[]
    for part,axis,which,key in specs:
        selected=nodes[cells[markers[part]].reshape(-1),axis]
        bound=float(selected.max() if which=="max" else selected.min())
        matched=struct.pack("<d",bound)==struct.pack("<d",constants[key])
        if measurements is not None:
            part_vertices=sorted(set(int(v) for ci in markers[part] for v in cells[ci]))
            extreme_vertices=[i for i in part_vertices if float(nodes[i,axis])==bound]
            expected=Fraction.from_float(constants[key]);actual=Fraction.from_float(bound)
            delta=expected-actual
            measurements.append({"evidence_role":"DIAGNOSTIC_ONLY", "semantic_coverage":"NOT VERIFIED", "plane":key,"part":part,"axis":axis,"expected_binary64_hex":constants[key].hex(),
                                 "actual_extreme_binary64_hex":bound.hex(),"exact_match":matched,
                                 "actual_extreme_vertices":[{"node_index":i,"xyz_hex":[float(v).hex() for v in nodes[i]]}
                                                            for i in extreme_vertices],
                                 "expected_minus_actual_exact_m":{"numerator":str(delta.numerator),"denominator":str(delta.denominator)}})
        if physical is not None:
            selected_faces=[]
            part_cells=set(markers[part])
            sign=1 if which=="max" else -1
            for owners in physical.values():
                if len(owners)!=1 or owners[0][0] not in part_cells: continue
                ci,face=owners[0]
                a,b,c=map(exact,nodes[list(face)])
                normal=cross(subtract(b,a),subtract(c,a))
                # Diagnostic axis-facing selection cannot prove authored CAD boundary coverage.
                if sign*normal[axis]<=sum(abs(normal[k]) for k in range(3) if k!=axis): continue
                selected_faces.append(face)
            face_vertices=sorted({i for face in selected_faces for i in face})
            offending=[i for i in face_vertices if struct.pack("<d",float(nodes[i,axis]))!=struct.pack("<d",constants[key])]
            if measurements is not None:
                measurements[-1].update(axis_facing_boundary_face_count=len(selected_faces),
                    boundary_selection="part ownership plus exact outward normal dominant authored axis; diagnostic, no projection",
                    offending_boundary_vertices=[{"node_index":i,"xyz_hex":[float(v).hex() for v in nodes[i]]}
                                                 for i in offending])
            if not selected_faces or offending: refusals.append(f"diagnostic axis-facing boundary vertices drift/skew: {key}")
        if not matched: refusals.append(f"diagnostic extreme plane drift: {key}")
        # All source vertices on that authored extreme must share the same bit pattern.
        bound_bits={struct.pack("<d",float(v)) for v in selected if v==bound}
        if bound_bits!={struct.pack("<d",constants[key])}: refusals.append(f"diagnostic extreme plane bits: {key}")
    require(not refusals,"; ".join(refusals))


def classify_probes(nodes, cells, physical, cut_faces, constants, records):
    import numpy as np
    xyz=nodes[cells]; lo=xyz.min(axis=1); hi=xyz.max(axis=1)
    boundary=[v[0][1] for v in physical.values() if len(v)==1]
    boundary_xyz=nodes[np.asarray(boundary,dtype=int)]
    boundary_lo=boundary_xyz.min(axis=1);boundary_hi=boundary_xyz.max(axis=1)
    edges={tuple(sorted((face[i],face[(i+1)%3]))) for face in boundary for i in range(3)}
    predicates={"E1":((0,"mid_x"),(1,"mid_signal_side")),
                "E2":((1,"return_side"),(2,"return_top")),
                "E3":((0,"inlet_x"),(1,"inlet_y"))}
    for record in records:
        p=record["xyz_m"]
        candidates=np.flatnonzero(np.all(lo<=p,axis=1)&np.all(hi>=p,axis=1))
        owners=[]; mesh_boundary=False
        for ci in candidates:
            contained,on_boundary=in_tetrahedron(p,xyz[ci])
            if contained: owners.append(int(ci));mesh_boundary |= on_boundary
        face_candidates=np.flatnonzero(np.all(boundary_lo<=p,axis=1)&np.all(boundary_hi>=p,axis=1))
        boundary_faces=[list(boundary[int(fi)]) for fi in face_candidates
                        if on_triangle(p,boundary_xyz[int(fi)])]
        scope=record["scope"]
        if scope in ("far","near"): require(not owners, f"{record['id']} must be outside source")
        elif scope=="inside": require(owners and not boundary_faces,f"{record['id']} must be inside physical conductor")
        elif scope=="face": require(boundary_faces,f"{record['id']} not on exact physical face")
        elif scope=="edge":
            matches=[]
            for edge in edges:
                points=nodes[list(edge)]
                if all(all(struct.pack("<d",float(v[axis]))==struct.pack("<d",constants[key])
                           for v in points) for axis,key in predicates[record["id"]]) and on_segment(p,points):
                    matches.append(list(edge))
            require(matches,f"{record['id']} not on exact semantic edge")
            record["semantic_edge_segments"]=matches
        else: require(any(on_triangle(p,nodes[list(f)]) for f in cut_faces), "C1 not on exact sourcecut")
        record.update(cell_owners=owners,on_internal_mesh_face=mesh_boundary,physical_boundary_faces=boundary_faces)


def work_admission(cells, unique_faces, targets, h1_free, flux_dof):
    per_target=3*sum((16,32,64,128))*3*unique_faces
    measured={"native_source_target_pairs":cells*targets,"oracle_evaluations_per_target":per_target,
              "oracle_evaluations_per_case":per_target*targets,"h1_free_dof":h1_free,"rt0_flux_dof":flux_dof}
    failures=[f"{k}: {v} > {LIMITS[k]}" for k,v in measured.items() if v>LIMITS[k]]
    return {"fixed_pass_lower_bound":measured,"limits":LIMITS,"admitted":not failures,
            "refusals":failures,"refinement_evaluation_reserve":LIMITS["oracle_evaluations_per_case"]-per_target*targets}


def resized_problem(problem, h):
    import fullmag as fm
    meta=deepcopy(problem.runtime_metadata)
    workflow=meta["mesh_workflow"]
    workflow["fem"]["hmax"]=h
    for key in ("mesh_options","default_mesh"):
        for name in ("hmin","minimum_element_size","hmax","maximum_element_size"):
            if name in workflow[key]: workflow[key][name]=h
    require(not workflow["per_geometry"],"fixture must inherit public mesh defaults")
    return replace(problem,discretization=fm.DiscretizationHints(fem=fm.FEM(order=1,maximum_element_size=h)),
                   runtime_metadata=meta,geometry_asset_cache={})


def write_json(path, value):
    data=(json.dumps(value,ensure_ascii=False,allow_nan=False,sort_keys=True,indent=2)+"\n").encode()
    with path.open("xb") as stream: stream.write(data)
    return hashlib.sha256(data).hexdigest()


def preflight(repo, output):
    from fullmag.runtime.loader import load_problem_from_script
    example=repo/"examples/fem_antenna_closed_loop_nonmagnetic.py"
    loaded=load_problem_from_script(example,lightweight_assets=True)
    base=loaded.problem
    geometry=next(g for g in base.auxiliary_geometries if g.geometry_name=="antenna")
    require(geometry.transform.to_ir()=={"rotation_matrix":[[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]],"translation_m":[0.,0.,0.]},"fixed untransformed fixture required")
    cut=base.current_modules[0].structured_current_closure.source_cuts[0]
    constants, frozen_probes=probes(geometry,cut)
    source_hashes={p.relative_to(repo).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
                   for p in [example,Path(__file__).resolve(),repo/"scripts/test_preflight_antenna_closed_loop_qualification.py",repo/"scripts/fullmag_storage.py",*sorted((repo/"packages/fullmag-py/src/fullmag").rglob("*.py"))]}
    overall={"schema":"antenna_closed_loop_geometry_preflight.v1","qualification":"NOT VERIFIED",
             "status":"geometry_only","source_hashes":source_hashes,"mesh_sizes_m":MESH_SIZES_M,
             "prereg_hashes":{name:hashlib.sha256((repo/"docs/physics"/name).read_bytes()).hexdigest()
                 for name in ("0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md",
                              "0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.source-map.json")},
             "levels":[]}
    for index,h in enumerate(MESH_SIZES_M):
        level=output/f"mesh-{index+1}";level.mkdir()
        problem=resized_problem(base,h)
        authored=problem.to_ir(include_geometry_assets=False)
        ir=problem.to_ir(include_geometry_assets=True)
        assets={a["geometry_name"]:a["mesh"] for a in ir["geometry_assets"]["fem_mesh_assets"]}
        source=ir["current_modules"][0]["conservative_current_source"]
        nodes,cells=mesh_arrays(assets["antenna"]);sample_nodes,sample_cells=mesh_arrays(assets["sampling"])
        topo,physical=topology(nodes,cells);pairs,cut_faces=cut_pairs(nodes,cells,source,topo)
        records=deepcopy(frozen_probes)
        cut_vertices=sorted({v for face in cut_faces for v in face})
        cut_plane_values=sorted({float(nodes[i,2]).hex() for i in cut_vertices})
        admission=work_admission(len(cells),len(physical),len(sample_nodes)+18,len(nodes)-len(pairs)-1,len(topo))
        record={"mesh_size_m":h,"source_nodes":len(nodes),"source_tet4":len(cells),"h1_free_dof":len(nodes)-len(pairs)-1,
                "rt0_unconstrained_flux_dof":len(topo),"unique_physical_faces":len(physical),"sample_nodes":len(sample_nodes),
                "sample_tet4":len(sample_cells),"all_target_count":len(sample_nodes)+18,"cut_vertex_pairs":sorted(pairs.items()),
                "semantic_constants":{k:{"value_m":v,"binary64_hex":v.hex()} for k,v in constants.items()},
                "sourcecut_plane_diagnostics":{"expected_binary64_hex":constants["sourcecut_z"].hex(),
                    "actual_z_binary64_hex":cut_plane_values,
                    "vertices":[{"node_index":i,"stable_vertex_id":source["stable_vertex_ids"][i],
                                 "xyz_hex":[float(v).hex() for v in nodes[i]]} for i in cut_vertices]},
                "S3_readonly_plane_parameter":{"axis":"x","authored_probe_binary64_hex":records[13]["xyz_m"][0].hex(),
                    "policy":"inlet_x semantic-plane exact offset is in semantic_plane_checks; no nearest/project/snap"},
                "probes":records,"work_admission":admission,
                "semantic_owner_admission":semantic_owner_admission(),
                "geometry_refusals":[semantic_owner_admission()["reason"]],
                "semantic_plane_checks":[],"status":"geometry_only"}
        try:
            check_planes(nodes,cells,source,constants,record["semantic_plane_checks"],physical)
        except ValueError as error:
            record["geometry_refusals"].append(str(error))
        for probe in records:
            try:
                classify_probes(nodes,cells,physical,cut_faces,constants,[probe])
            except ValueError as error:
                probe["classification_refusal"]=str(error)
                record["geometry_refusals"].append(str(error))
        payload_estimate=8*sum(len(json.dumps(value,allow_nan=False)) for value in (authored,ir,assets["antenna"],assets["sampling"]))
        record["ram_estimated_retained_input_bytes"]=payload_estimate
        record["actual_runtime_peak_ram"]="NOT VERIFIED"
        record["ram_estimate_is_peak_memory_proof"]=False
        record["ram_estimate_model"]="8x serialized retained inputs; excludes Gmsh allocator; no runtime peak-memory proof"
        if payload_estimate>LIMITS["ram_bytes"]:
            record["geometry_refusals"].append("retained geometry RAM estimate exceeds 2GiB")
        record["admitted"]=admission["admitted"] and not record["geometry_refusals"]
        record["payload_hashes"]={"authored_ir":write_json(level/"authored-ir.json",authored),
                                  "execution_ir":write_json(level/"execution-ir.json",ir),
                                  "source_mesh":write_json(level/"source-mesh.json",assets["antenna"]),
                                  "sample_mesh":write_json(level/"sample-mesh.json",assets["sampling"])}
        record["source_mesh_identity"]=source["mesh_digest"]
        write_json(level/"preflight.json",record);overall["levels"].append(record)
        print(json.dumps({"level":index+1,"tet4":len(cells),"targets":len(sample_nodes)+18,"admitted":record["admitted"],
                          "geometry_refusals":record["geometry_refusals"],"work_refusals":admission["refusals"]}))
    for path,digest in source_hashes.items():
        require(hashlib.sha256((repo/path).read_bytes()).hexdigest()==digest,f"source changed during preflight: {path}")
    for name,digest in overall["prereg_hashes"].items():
        require(hashlib.sha256((repo/"docs/physics"/name).read_bytes()).hexdigest()==digest,"prereg changed during preflight")
    overall["admitted"]=all(x["admitted"] for x in overall["levels"])
    overall["status"]="geometry_preflight_admitted" if overall["admitted"] else "geometry_preflight_refused"
    write_json(output/"preflight.json",overall)
    return overall["admitted"]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-name",default="geometry-preflight-v3")
    args=parser.parse_args()
    import fullmag_storage
    repo=Path(__file__).resolve().parents[1]
    layout=fullmag_storage.resolve_layout(repo,profile="windows-source-contracts")
    require(args.output_name and args.output_name.replace("-","").replace("_","").isalnum(),"safe output name required")
    output=Path(layout["runs_root"])/"e2"/args.output_name
    fullmag_storage.validate_path(output,Path(layout["storage_root"]))
    output.mkdir(parents=True,exist_ok=False)
    os.environ["FULLMAG_FEM_MESH_CACHE_DIR"]=str(Path(layout["cache_root"])/"antenna-qualification-preflight")
    os.environ["PYTHONDONTWRITEBYTECODE"]="1"
    admitted=preflight(repo,output)
    print(f"Geometry-only {'ADMITTED' if admitted else 'REFUSED'}; qualification NOT VERIFIED; {output}")
    return 0 if admitted else 2


if __name__=="__main__":
    raise SystemExit(main())