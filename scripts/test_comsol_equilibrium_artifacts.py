import pytest
from comsol_equilibrium_artifacts import sample_state_paths


def manifest(sample=7):
    return {"artifacts": {
        "equilibrium_artifact_v7_paths": [f"eigen/metadata/sample_{sample:04d}/equilibrium_artifact.v7.json"],
        "linearization_state_v6_paths": [f"eigen/metadata/sample_{sample:04d}/linearization_state.v6.json"],
    }}


def test_explicit_per_sample_pair_is_selected():
    assert sample_state_paths(manifest(),7) == ("eigen/metadata/sample_0007/equilibrium_artifact.v7.json", "eigen/metadata/sample_0007/linearization_state.v6.json")


@pytest.mark.parametrize("defect", ["missing", "duplicate", "wrong_sample", "ambiguous", "unsafe", "bool"])
def test_state_selection_cannot_fall_back_to_another_sample(defect):
    value=manifest(); sample=7
    paths=value["artifacts"]
    if defect=="missing":paths.pop("linearization_state_v6_paths")
    elif defect=="duplicate":paths["equilibrium_artifact_v7_paths"]*=2
    elif defect=="wrong_sample":sample=8
    elif defect=="ambiguous":paths["equilibrium_artifact_v7_path"]="eigen/metadata/equilibrium_artifact.v7.json"
    elif defect=="unsafe":paths["equilibrium_artifact_v7_paths"]=["../equilibrium_artifact.v7.json"]
    else:sample=True
    with pytest.raises(ValueError):sample_state_paths(value,sample)


def test_singular_native_artifact_is_only_valid_for_sample_zero():
    value={"artifacts":{"equilibrium_artifact_v7_path":"eigen/metadata/equilibrium_artifact.v7.json","linearization_state_v6_path":"eigen/metadata/linearization_state.v6.json"}}
    assert len(sample_state_paths(value,0))==2
    with pytest.raises(ValueError):sample_state_paths(value,1)


@pytest.mark.parametrize("invalid_certificate", [False, True])
def test_full_sample_loader_validates_acceptance_and_actual_state(tmp_path, invalid_certificate):
    import json
    import hashlib
    from comsol_equilibrium_artifacts import read_sample_equilibrium
    from test_equilibrium_payload_validation import _fresh_artifact, _refresh_digest
    from verify_fem_frequency_domain_eigen_artifacts import serde_json_compact_bytes
    eq = _fresh_artifact(tmp_path / "reference")
    eq["m0"] = [[1., 0., 0.]] * 4
    eq["mesh_signature"] = "mesh"
    for key in ("material_signature", "physics_signature", "boundary_signature", "static_demag_signature"):
        eq[key] = key
    if invalid_certificate:
        eq["acceptance_certificate"]["converged"] = False
    digest = _refresh_digest(eq)
    state = {key:eq[key] for key in ("mesh_signature", "material_signature", "physics_signature", "boundary_signature", "static_demag_signature")}
    state.update(schema_version="LinearizationState.v6", accepted_for_frequency_operator=True,
                 source_equilibrium_id=eq["equilibrium_id"],source_equilibrium_artifact=digest,m0=eq["m0"])
    state_digest="sha256:"+hashlib.sha256(serde_json_compact_bytes(state)).hexdigest()
    state.update(content_sha256=state_digest,linearization_state_id="LinearizationState.v6:"+state_digest.removeprefix("sha256:"))
    mode={"equilibrium_artifact_sha256":digest,"linearization_state_sha256":state_digest,"source_mesh_topology_sha256":"mesh"}
    declared=manifest(7)
    for relative, value in zip(sample_state_paths(declared,7), (eq,state)):
        path=tmp_path/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
    metadata={"execution_plan":{"backend_plan":{
        "mesh":{"nodes":[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]],"cells":{"types":["tet4"],"offsets":[0,4],"nodes":[0,1,2,3]}},
        "mesh_parts":[{"id":"film","role":"magnetic_object","element_selector":{"kind":"element_range","start":0,"count":1}}]
    }}}
    if invalid_certificate:
        with pytest.raises(SystemExit, match="converged"):
            read_sample_equilibrium(tmp_path,declared,metadata,mode,7,mesh_signature="mesh")
    else:
        result=read_sample_equilibrium(tmp_path,declared,metadata,mode,7,mesh_signature="mesh")
        assert result["magnetic_m0"] == eq["m0"]
        assert result["sample_index"] == 7
        assert len(result["file_hashes"]) == 2
