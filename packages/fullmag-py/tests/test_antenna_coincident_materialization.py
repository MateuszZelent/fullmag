"""Actual Gmsh public lowering, exact owner bindings and cache regressions."""
from dataclasses import replace
from unittest.mock import patch

import numpy as np
import pytest
import fullmag as fm
from fullmag.model.problem import BackendTarget, DeviceTarget

from test_antenna_coincident_cut import loop_geometry, closure
from fullmag.runtime.antenna_coincident_materialization import _exact_identity_preimage
from fullmag.runtime.transport_identity import tagged_json_digest
from fullmag.meshing._antenna_coincident_cut import _faces


def authored_problem(*, geometry=None, assignments=None, ports=True):
    geometry = geometry or loop_geometry()
    if assignments is None:
        assignments = [fm.ChargeTransportMaterialAssignment(fm.RegionRef("object", part),
            fm.ChargeTransportMaterial(sigma)) for part, sigma in (
                (geometry.signal_part_id, geometry.conductivity_s_per_m),
                (geometry.return_part_id, geometry.conductivity_s_per_m),
                (geometry.inlet_connection_part_id, geometry.inlet_connection_conductivity_s_per_m),
                (geometry.outlet_connection_part_id, geometry.outlet_connection_conductivity_s_per_m))]
    transport = fm.CurrentTransport(name="charge", model="ohmic_poisson", domain=[fm.RegionRef("object")],
        materials=assignments, boundaries=[], gauge=fm.ChargePotentialGauge("zero_mean"),
        solver=fm.ChargeSolverPolicy(relative_tolerance=1e-12,
            operator_version="fem_charge_conforming_h1_p1.transparent.v1"), structured_current_closure=closure())
    port = fm.AntennaPortMode(id="port", source_object_id="object", current_transport_id="charge",
        schema_version="antenna_port_mode.v3", normalization=fm.AntennaSourceCutRt0("cut"),
        branches=[fm.AntennaPortBranch(geometry.signal_part_id,"signal-in","signal-out",1.),
                  fm.AntennaPortBranch(geometry.return_part_id,"return-in","return-out",-1.)])
    stage = fm.AntennaFieldSolveStage(id="solve", source_object_id="object", current_transport_id="charge",
        port_mode_ids=["port"], field_sampling_domain=fm.FieldTarget.object("object"),
        target_refs=[fm.FieldTarget.object("object")], outputs=[fm.AntennaNamedOutput("inspection","H_ant_basis")])
    return fm.Problem(name="coincident_public", magnets=[], energy=[], study=fm.FieldOnly(),
        auxiliary_geometries=[geometry], auxiliary_geometry_roles={geometry.geometry_name:"antenna"},
        auxiliary_geometry_object_ids={geometry.geometry_name:"object"}, current_modules=[transport],
        antenna_port_modes=[port] if ports else [], antenna_field_solve_stages=[stage] if ports else [],
        discretization=fm.DiscretizationHints(fem=fm.FEM(maximum_element_size=0.15e-6,order=1)),
        runtime=fm.RuntimeSelection(backend_target=BackendTarget.FEM, device_target=DeviceTarget.CPU),
        runtime_metadata={"script_api_surface":"study"})


@pytest.fixture
def cached_execution(tmp_path, monkeypatch):
    monkeypatch.setenv("FULLMAG_FEM_MESH_CACHE_DIR",str(tmp_path / "mesh-cache"))
    problem=authored_problem()
    authored=problem.to_ir(include_geometry_assets=False)
    execution=problem.to_ir(include_geometry_assets=True)
    return problem,authored,execution


def test_public_execution_materializes_actual_full_mesh_and_preserves_authoring(cached_execution):
    problem,authored,execution=cached_execution
    current=execution["current_modules"][0]
    source=current["conservative_current_source"]
    assert source["kind"]=="closed_geometry_potential_jump"
    assert source["schema_version"]=="conservative_current_source.v2"
    assert "structured_current_closure" not in current
    assert current["boundaries"]==[]
    assert problem.to_ir(include_geometry_assets=False)==authored
    graph=next(module for module in execution["physics_graph"]["modules"] if module["id"]=="charge")
    assert graph["family_payload"]==current
    assert graph["family_payload"] is not current
    assert "source_field_digest" not in source and "pins" not in source
    assert "conductivity_spm_per_element" not in source
    assert source["revision"]==source["authored_input_digest"]
    receipt=execution["problem_meta"]["runtime_metadata"]["antenna_coincident_preparations"][0]["preparation"]
    assert receipt["status"]=="materialized_not_solved"
    assert not receipt["current_certificate"] and not receipt["basis_qualified"] and not receipt["antenna_completion"]
    mesh=execution["geometry_assets"]["fem_mesh_assets"][0]["mesh"]
    cells=np.asarray(mesh["cells"]["nodes"]).reshape(-1,4)
    nodes=np.asarray(mesh["nodes"])
    ids=source["stable_vertex_ids"]
    assert len(ids)==len(nodes) and len(set(ids))==len(ids)
    coverage=[cell for part in source["material_parts"] for cell in part["element_ordinals"]]
    assert sorted(coverage)==list(range(len(cells)))
    topology=_faces(cells)
    id_nodes={identity:index for index,identity in enumerate(ids)}
    assert {item["id"] for item in source["terminal_observations"]}=={"signal-in","signal-out","return-in","return-out"}
    for observation in source["terminal_observations"]:
        assert observation["normal_convention"]=="outward_from_part" and observation["faces"]
        for face in observation["faces"]:
            carrier=[id_nodes[identity] for identity in face["face_vertex_ids"]]
            owners=topology[tuple(sorted(carrier))]
            assert {cell for cell,_ in owners}=={face["part_cell_ordinal"],face["bridge_cell_ordinal"]}
            xyz=nodes[carrier]
            normal=np.cross(xyz[1]-xyz[0],xyz[2]-xyz[0])
            assert np.linalg.norm(normal)>0
            opposite=next(vertex for vertex in cells[face["part_cell_ordinal"]] if vertex not in carrier)
            assert np.dot(normal,nodes[opposite]-xyz[0])<0
    xyz_by_id=dict(zip(ids,nodes))
    for cut in source["closure"]["source_cuts"]:
        assert cut["translation_m"]==[0.,0.,0.]
        for pair in cut["face_pairs"]:
            assert set(pair["minus_face_vertex_ids"]).isdisjoint(pair["plus_face_vertex_ids"])
            assert {xyz_by_id[value].tobytes() for value in pair["minus_face_vertex_ids"]}=={
                xyz_by_id[value].tobytes() for value in pair["plus_face_vertex_ids"]}


def test_public_cache_reuses_raw_mesh_without_gmsh_and_keeps_identity(cached_execution):
    problem,_,execution=cached_execution
    with patch("fullmag.meshing._antenna_coincident_cut.realize_antenna_coincident_loop_mesh",side_effect=AssertionError("cache missed")):
        repeated=problem.to_ir(include_geometry_assets=True)
    assert repeated["current_modules"]==execution["current_modules"]
    assert repeated["geometry_assets"]==execution["geometry_assets"]


def test_material_and_observation_failures_are_explicit(cached_execution):
    problem,_,_=cached_execution
    with pytest.raises(ValueError,match="one authored port"):
        replace(problem,antenna_port_modes=[]).to_ir(include_geometry_assets=True)
    port=problem.antenna_port_modes[0]
    bad_port=fm.AntennaPortMode(id=port.id,source_object_id=port.source_object_id,current_transport_id=port.current_transport_id,
        schema_version=port.schema_version, normalization=port.normalization,
        branches=[fm.AntennaPortBranch("foreign","x","y",1.),port.branches[1]])
    with pytest.raises(ValueError,match="exact signal and return"):
        replace(problem,antenna_port_modes=[bad_port]).to_ir(include_geometry_assets=True)
    assignments=list(problem.current_modules[0].materials)
    assignments[-1]=fm.ChargeTransportMaterialAssignment(fm.RegionRef("object","outlet"),fm.ChargeTransportMaterial(1.))
    with pytest.raises(ValueError,match="differs"):
        authored_problem(assignments=assignments).to_ir(include_geometry_assets=True)
    with pytest.raises(ValueError,match="cover all four"):
        authored_problem(assignments=assignments[:-1]).to_ir(include_geometry_assets=True)
    overlap=[fm.ChargeTransportMaterialAssignment(fm.RegionRef("object"),fm.ChargeTransportMaterial(5.8e7)),assignments[0]]
    with pytest.raises(ValueError,match="overlap"):
        authored_problem(assignments=overlap).to_ir(include_geometry_assets=True)


def test_transformed_contacts_and_geometry_invalidation(tmp_path,monkeypatch):
    monkeypatch.setenv("FULLMAG_FEM_MESH_CACHE_DIR",str(tmp_path / "mesh-cache"))
    geometry=loop_geometry(transform=fm.RigidTransform(rotation_matrix=((0.,-1.,0.),(1.,0.,0.),(0.,0.,1.)),translation_m=(2e-6,-3e-6,1e-6)))
    problem=authored_problem(geometry=geometry)
    first=problem.to_ir(include_geometry_assets=True)["current_modules"][0]["conservative_current_source"]
    changed=authored_problem(geometry=loop_geometry(transform=geometry.transform,inlet_connection_length_m=0.25e-6))
    second=changed.to_ir(include_geometry_assets=True)["current_modules"][0]["conservative_current_source"]
    assert first["revision"]!=second["revision"] and first["mesh_digest"]!=second["mesh_digest"]
    assert len(first["terminal_observations"])==4


def test_exact_u64_preimage_and_existing_codec():
    payload={"stable_vertex_ids":[2**64-1],"terminal_observations":[{"faces":[{
        "face_vertex_ids":[2**64-1,2**53+1,7],"part_cell_ordinal":2**53+1,"bridge_cell_ordinal":9}]}]}
    exact=_exact_identity_preimage(payload)
    assert exact["stable_vertex_ids"]==["18446744073709551615"]
    assert tagged_json_digest(exact).startswith("sha256:")
    with pytest.raises(ValueError):tagged_json_digest(payload)




def test_cached_cut_plane_and_missing_contact_are_rejected(cached_execution,tmp_path):
    from fullmag.meshing._gmsh_types import MeshData
    from fullmag.meshing._antenna_coincident_cut import prepare_antenna_coincident_loop, coincident_terminal_observations
    from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker
    problem,_,_=cached_execution
    raw_candidates=[MeshData.load(path) for path in (tmp_path / "mesh-cache").glob("*.npz")]
    raw=next(mesh for mesh in raw_candidates if np.any(mesh.boundary_markers==2))
    original=closure()
    cut=original.source_cuts[0]
    bad=fm.StructuredCurrentClosure(original.closure_id,[replace(cut,plane=replace(cut.plane,offset_m=-0.25e-6))],schema_version=original.schema_version)
    with pytest.raises(ValueError,match="cached sourcecut"):
        prepare_antenna_coincident_loop(bad,geometry=problem.auxiliary_geometries[0],object_id="object",hmax_m=0.15e-6,raw_mesh=raw)
    prepared=prepare_antenna_coincident_loop(original,geometry=problem.auxiliary_geometries[0],object_id="object",hmax_m=0.15e-6,raw_mesh=raw)
    marker=antenna_terminal_marker("object","signal","local_u_min")
    missing=replace(raw,boundary_markers=np.where(raw.boundary_markers==marker,1,raw.boundary_markers))
    with pytest.raises(ValueError,match="missing actual"):
        coincident_terminal_observations(missing,prepared,geometry=problem.auxiliary_geometries[0],object_id="object",port=problem.antenna_port_modes[0])


def test_material_order_changes_binding_and_whole_object_requires_matching_bridges(cached_execution):
    problem,_,execution=cached_execution
    assignments=list(reversed(problem.current_modules[0].materials))
    changed=authored_problem(assignments=assignments).to_ir(include_geometry_assets=True)
    first=execution["current_modules"][0]["conservative_current_source"]
    second=changed["current_modules"][0]["conservative_current_source"]
    assert first["mesh_digest"]==second["mesh_digest"]
    assert first["materials_digest"]!=second["materials_digest"] and first["revision"]!=second["revision"]
    geometry=loop_geometry(inlet_connection_conductivity_s_per_m=5.8e7,outlet_connection_conductivity_s_per_m=5.8e7)
    assignment=fm.ChargeTransportMaterialAssignment(fm.RegionRef("object"),fm.ChargeTransportMaterial(5.8e7))
    whole=authored_problem(geometry=geometry,assignments=[assignment]).to_ir(include_geometry_assets=True)
    assert {part["material_assignment_index"] for part in whole["current_modules"][0]["conservative_current_source"]["material_parts"]}=={0}


def test_unsupported_lanes_and_wrong_sourcecut_fail_before_prepare(cached_execution):
    import copy
    from fullmag.runtime.antenna_coincident_materialization import materialize_antenna_coincident_loops
    problem,authored,_=cached_execution
    for section,key,value in (("backend_policy","requested_backend","fdm"),
                              ("backend_policy","execution_precision","single"),
                              ("validation_profile","execution_mode","approximate")):
        bad=copy.deepcopy(authored)
        bad[section][key]=value
        with pytest.raises(ValueError,match="explicit FEM"):
            materialize_antenna_coincident_loops(problem,bad,geometries=problem.auxiliary_geometries,
                discretization=problem.discretization,mesh_workflow=None)
    with pytest.raises(ValueError,match="explicit FEM"):
        materialize_antenna_coincident_loops(problem,copy.deepcopy(authored),geometries=problem.auxiliary_geometries,
            discretization=problem.discretization,mesh_workflow=None,runtime_device_override="gpu")
    port=replace(problem.antenna_port_modes[0],normalization=fm.AntennaSourceCutRt0("another-cut"))
    with pytest.raises(ValueError,match="bound to its sourcecut"):
        replace(problem,antenna_port_modes=[port]).to_ir(include_geometry_assets=True)




def test_antenna_owner_identity_preserves_legacy_parameters_and_rejects_nonrigid():
    from fullmag.runtime.scene_document import _compose_antenna_owner_transform
    params=loop_geometry().to_ir()
    assert _compose_antenna_owner_transform(params,{},"object") is params
    legacy_ir=dict(params)
    legacy_ir.pop("loop")
    legacy=fm.MicrostripAntennaLayout.from_ir(legacy_ir).to_ir()
    assert "loop" not in legacy
    assert _compose_antenna_owner_transform(legacy,{},"object") is legacy
    for transform in ({"scale":[2.,1.,1.]},{"rotation_quat":[0.,0.,0.,0.]},{"pivot":[1e-6,0.,0.]}):
        with pytest.raises(ValueError):
            _compose_antenna_owner_transform(params,transform,"object")
