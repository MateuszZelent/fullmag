import json
import math
import pytest
from comsol_n0_field_certificate import measure_n0_field
from test_comsol_modal_field_certificate import write_case


def cube_case(tmp_path):
    # A tetrahedralizable cube; x-periodic traces, uniform demodulated yz.
    nodes = [[x,y,z] for z in (0.,1.) for y in (0.,1.) for x in (0.,1.)]
    vectors = [(0j, complex(math.cos(-math.pi/2*x), math.sin(-math.pi/2*x)), 0j) for x,y,z in nodes]
    root, payload = write_case(tmp_path, vectors=vectors)
    path = root / "metadata.json"
    metadata = json.loads(path.read_text())
    plan = metadata["execution_plan"]["backend_plan"]
    mesh = plan["mesh"]
    mesh["nodes"] = nodes
    mesh["periodic_node_pairs"] = [{"pair_id":"x_faces", "node_a":i, "node_b":i+1} for i in (0,2,4,6)]
    tets = [[0,1,3,7], [0,3,2,7], [0,2,6,7], [0,6,4,7], [0,4,5,7], [0,5,1,7]]
    mesh["cells"] = {"types":["tet4"]*6,"offsets":list(range(0,25,4)),"nodes":[i for tet in tets for i in tet]}
    plan["mesh_parts"] = [{"id":"film","role":"magnetic_object","element_selector":{"kind":"element_range","start":0,"count":6}}]
    path.write_text(json.dumps(metadata))
    return root, payload


def test_real_binary_field_is_measured_without_qualification_claim(tmp_path):
    root, _ = cube_case(tmp_path)
    result = measure_n0_field(root, 0, 7, expected_k=[math.pi/2,0.,0.])
    assert result["status"] == "measured", result["reasons"]
    assert result["metrics"]["projection_residual"] < 1e-25
    assert result["metrics"]["threshold"] is None
    assert result["raw_mode_index"] == 7


@pytest.mark.parametrize("defect", ["wrong_k", "missing_support", "corrupted_payload"])
def test_bad_field_inputs_are_unverified(tmp_path, defect):
    root, payload = cube_case(tmp_path)
    k = [math.pi/2,0.,0.]
    if defect == "wrong_k": k = [0.,0.,0.]
    elif defect == "missing_support":
        path=root/"metadata.json"; metadata=json.loads(path.read_text()); metadata["execution_plan"]["backend_plan"].pop("mesh_parts"); path.write_text(json.dumps(metadata))
    else: payload.write_bytes(b"broken")
    result = measure_n0_field(root, 0, 7, expected_k=k)
    assert result["status"] == "unverified"
    assert result["reasons"]


def test_changed_payload_between_phase_check_and_projection_is_rejected(tmp_path, monkeypatch):
    import comsol_n0_field_certificate as module
    root, payload = cube_case(tmp_path)
    original = module.validate_modal_field_certificate
    def certify_then_change(*args, **kwargs):
        result = original(*args, **kwargs)
        data = bytearray(payload.read_bytes())
        data[-1] ^= 1
        payload.write_bytes(data)
        return result
    monkeypatch.setattr(module, "validate_modal_field_certificate", certify_then_change)
    result = module.measure_n0_field(root, 0, 7, expected_k=[math.pi/2,0.,0.])
    assert result["status"] == "unverified"
    assert any("changed after phase certification" in reason for reason in result["reasons"])


@pytest.mark.parametrize("manifest", [{}, {"artifacts": {}}])
def test_requested_equilibrium_binding_cannot_fall_back_to_field_only(tmp_path, manifest):
    root, _ = cube_case(tmp_path)
    result = measure_n0_field(root, 0, 7, expected_k=[math.pi/2, 0., 0.], equilibrium_manifest=manifest)
    assert result["status"] == "unverified"
    assert result["reasons"]
    assert "metrics" not in result


def test_acceptance_validator_exit_is_a_failed_measurement(tmp_path, monkeypatch):
    import comsol_n0_field_certificate as module
    root, _ = cube_case(tmp_path)
    def rejected(*args, **kwargs):
        raise SystemExit("equilibrium certificate did not converge")
    monkeypatch.setattr(module, "read_sample_equilibrium", rejected)
    result = module.measure_n0_field(root, 0, 7, expected_k=[math.pi/2, 0., 0.], equilibrium_manifest={})
    assert result["status"] == "unverified"
    assert any("did not converge" in item for item in result["reasons"])


@pytest.mark.parametrize("m0, expected", [([1., 0., 0.], "measured"), ([0., 1., 0.], "unverified")])
def test_profile_uses_accepted_magnetic_orientation(tmp_path, monkeypatch, m0, expected):
    import comsol_n0_field_certificate as module
    root, _ = cube_case(tmp_path)
    # The loader has separate on-disk certificate tests. This isolates the
    # consumer's use of its accepted state instead of metadata plan m0.
    binding = {"magnetic_m0": [m0], "sample_index": 0}
    monkeypatch.setattr(module, "read_sample_equilibrium", lambda *a, **kw: binding)
    result = module.measure_n0_field(root, 0, 7, expected_k=[math.pi/2, 0., 0.], equilibrium_manifest={})
    assert result["status"] == expected, result["reasons"]
    if expected == "measured":
        assert result["equilibrium_binding"] == binding
    else:
        assert any("outside the C1" in item for item in result["reasons"])
