import hashlib
import pytest
from comsol_linearization_binding import validate_linearization_binding
from verify_fem_frequency_domain_eigen_artifacts import equilibrium_artifact_v7_digest, serde_json_compact_bytes


def fixture():
    eq = {"schema_version":"equilibrium_artifact.v7", "accepted_for_linearization":True,
          "m0":[[1.,0.,0.],[0.,0.,0.]], "mesh_signature":"mesh"}
    for key in ("material_signature", "physics_signature", "boundary_signature", "static_demag_signature"):eq[key]=key
    eq["content_sha256"]=equilibrium_artifact_v7_digest(eq)
    eq["equilibrium_id"]="equilibrium_artifact.v7:"+eq["content_sha256"].removeprefix("sha256:")
    state={key:eq[key] for key in ("mesh_signature", "material_signature", "physics_signature", "boundary_signature", "static_demag_signature")}
    state.update(schema_version="LinearizationState.v6", accepted_for_frequency_operator=True,
                 source_equilibrium_id=eq["equilibrium_id"],source_equilibrium_artifact=eq["content_sha256"],m0=[[1.,0.,0.],[0.,0.,1.]])
    mode={"equilibrium_artifact_sha256":eq["content_sha256"],"source_mesh_topology_sha256":"mesh"}
    rehash(state,mode)
    return eq,state,mode


def rehash(state, mode):
    pre={key:value for key,value in state.items() if key not in ("content_sha256","linearization_state_id")}
    digest="sha256:"+hashlib.sha256(serde_json_compact_bytes(pre)).hexdigest()
    state["content_sha256"]=digest;state["linearization_state_id"]="LinearizationState.v6:"+digest.removeprefix("sha256:")
    mode["linearization_state_sha256"]=digest


def test_air_extension_is_excluded_from_magnetic_state_comparison():
    eq,state,mode=fixture()
    result=validate_linearization_binding(eq,state,mode,[0],node_count=2,mesh_signature="mesh")
    assert result["magnetic_m0"] == [[1.,0.,0.]]


@pytest.mark.parametrize("defect",["m0_rehashed", "stale_state", "wrong_mesh", "wrong_source", "missing_m0"])
def test_inconsistent_actual_state_is_rejected(defect):
    eq,state,mode=fixture()
    if defect=="m0_rehashed":state["m0"][0]=[0.,1.,0.];rehash(state,mode)
    elif defect=="stale_state":state["m0"][0]=[0.,1.,0.]
    elif defect=="wrong_mesh":mode["source_mesh_topology_sha256"]="other"
    elif defect=="wrong_source":state["source_equilibrium_id"]="other";rehash(state,mode)
    else:state.pop("m0");rehash(state,mode)
    with pytest.raises(ValueError):validate_linearization_binding(eq,state,mode,[0],node_count=2,mesh_signature="mesh")
