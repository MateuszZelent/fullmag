"""Contract fixtures for the collector; synthetic data are never FEM proof."""
import json
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
import pytest
from collect_de_bv_thickness_comparison import collect_record


def fixture_run(tmp_path, geometry="damon_eshbach"):
    pilot = "de-smoke-k25" if geometry=="damon_eshbach" else "de-smoke-bv-k25"
    case=tmp_path/pilot; (case/"eigen/modes/sample_0000").mkdir(parents=True)
    job={"job_id":"b"*32,"source_digest":"c"*64,"profile":"fem-cpu-slepc-runtime-v2","worktree_id":"test"}
    identity={"job":job,"source":{"snapshot":"d"*64},"model_sha256":"e"*64,
              "model_source":{"commit":"f"*40},"thickness_layers_requested":"3"}
    request={**identity,"schema":"fullmag.de-smoke.request.v1","mesh_level_requested":"L2"}
    result={**identity,"schema":"fullmag.de-smoke.result.v1","pilot":pilot,"status":"completed_unqualified","return_code":0}
    model={"schema":"fullmag.de-smoke.v1","orientation":"M0=x,k=y,normal=z" if geometry=="damon_eshbach" else "M0=x,k=x,normal=z",
           "film_thickness_m":10e-9,"external_induction_t":.1,"mu0_t_m_a":4e-7*np.pi,
           "exchange_stiffness_j_per_m":13e-12,"saturation_magnetization_a_per_m":800000.,"gamma0_m_per_a_s":221100.,
           "air_padding_each_side_m":2e-6}
    metadata={"problem_meta":{"runtime_metadata":{"de_smoke":model}}}
    mode={"frequency_hz":10e9,"block_residuals":{"eps_full":1e-10}}
    for name,x in [("run-request.json",request),("run-result.json",result),(pilot+"/metadata.json",metadata),(pilot+"/eigen/modes/sample_0000/mode_0000.json",mode),(pilot+"/eigen/spectrum.v3.json",{})]:
        (tmp_path/name).write_text(json.dumps(x))
    kx,ky=(0,25e6) if geometry=="damon_eshbach" else (25e6,0)
    (case/"eigen/dispersion.csv").write_text("sample_index,raw_mode_index,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz\n"+f"0,0,{kx},{ky},0,10000000000\n")
    return job, result


@pytest.mark.parametrize("geometry,reference_ghz",[("damon_eshbach",13.673868175350407),("backward_volume",9.760535487542313)])
def test_parameters_and_orientation_come_from_run(tmp_path,geometry,reference_ghz):
    job,result=fixture_run(tmp_path,geometry)
    del result["thickness_layers_requested"]
    (tmp_path/"run-result.json").write_text(json.dumps(result))
    with patch("collect_de_bv_thickness_comparison.validate_rows"), patch("collect_de_bv_thickness_comparison.validate_thickness_layers_metadata",return_value={"thickness_resolution_verified":True}), patch("collect_de_bv_thickness_comparison.load_record",return_value=(SimpleNamespace(nodes=np.zeros((4,3))),None,np.array([[0,1,2,3]]),None,{"mode_metadata":"a"*64},.999)) as bound:
        record=collect_record(tmp_path,3,job)
    bound.assert_called_once()
    assert record["geometry"]==geometry
    assert record["analytic_frequency_hz"]/1e9==pytest.approx(reference_ghz)
    assert record["parameters"]["film_thickness_m"]==10e-9
    assert record["uniform_projection_squared_consistent_mass"]==.999


@pytest.mark.parametrize("mutation,reason",[("failed","completed"),("identity","identity"),("layers","layers")])
def test_rejects_wrong_receipt_before_field_loading(tmp_path,mutation,reason):
    job,result=fixture_run(tmp_path)
    if mutation=="failed":result["status"]="failed"
    if mutation=="identity":result["job"]={**job,"source_digest":"a"*64}
    if mutation=="layers":result["thickness_layers_requested"]="6"
    (tmp_path/"run-result.json").write_text(json.dumps(result))
    with patch("collect_de_bv_thickness_comparison.load_record") as bound:
        with pytest.raises(ValueError,match=reason):collect_record(tmp_path,3,job)
        bound.assert_not_called()


@pytest.mark.parametrize("changed",["magnetic_xy_sha256","air_padding_each_side_m","job","model_source","parameters"])
def test_batch_rejects_changes_to_controlled_inputs(changed):
    from copy import deepcopy
    from collect_de_bv_thickness_comparison import collect_batch
    base={"geometry":"damon_eshbach","thickness_layers":3,"job":{"id":"same"},"model_source":{},
          "mesh_level":"L2","air_padding_each_side_m":2e-6,"k_rad_per_m":25e6,
          "magnetic_xy_sha256":"same","parameters":{"geometry":"damon_eshbach","film_thickness_m":10e-9}}
    records=[]
    for g in ("damon_eshbach","backward_volume"):
        for n in (3,6,9):
            r=deepcopy(base);r.update(geometry=g,thickness_layers=n);r["parameters"]["geometry"]=g;records.append(r)
    assert collect_batch(records)["qualification"]=="NOT VERIFIED"
    records[-1][changed]={"film_thickness_m":20e-9} if changed=="parameters" else "different"
    with pytest.raises(ValueError):collect_batch(records)


@pytest.mark.parametrize("reason",["mode has no full descriptor certificate","packed cache does not match final modal topology","mode binary hash mismatch"])
def test_field_validation_failure_is_not_converted_to_an_accepted_record(tmp_path,reason):
    job,_=fixture_run(tmp_path)
    with patch("collect_de_bv_thickness_comparison.validate_rows"), patch("collect_de_bv_thickness_comparison.validate_thickness_layers_metadata",return_value={"thickness_resolution_verified":True}), patch("collect_de_bv_thickness_comparison.load_record",side_effect=ValueError(reason)):
        with pytest.raises(ValueError,match=reason):collect_record(tmp_path,3,job)


@pytest.mark.parametrize("residual",[True,False,float("nan"),-1e-10,2e-8])
def test_invalid_full_residual_is_rejected(tmp_path,residual):
    job,_=fixture_run(tmp_path)
    mode=tmp_path/"de-smoke-k25/eigen/modes/sample_0000/mode_0000.json"
    mode.write_text(json.dumps({"frequency_hz":10e9,"block_residuals":{"eps_full":residual}}))
    with patch("collect_de_bv_thickness_comparison.validate_rows"), patch("collect_de_bv_thickness_comparison.validate_thickness_layers_metadata"):
        with pytest.raises(ValueError,match="full residual"):collect_record(tmp_path,3,job)


def test_current_controller_report_is_normalized_without_restarting_runs(tmp_path):
    from collect_de_bv_thickness_comparison import normalize_controller_report
    job_id, digest, model_ref = "a"*32, "b"*64, "c"*40
    config={"job_id":job_id,"source_digest":digest,"model_ref":model_ref}
    (tmp_path/"controller-config.json").write_text(json.dumps(config))
    names=["gamma-t3","de-t3","bv-t3","de-t6","bv-t6","de-t9","bv-t9"]
    report={"qualification":"NOT VERIFIED","job_id":job_id,"source_digest":digest,
            "results":[{"case":name,"wrapper_exit":0,"output":str(tmp_path/name)} for name in names]}
    normalized=normalize_controller_report(tmp_path/"controller-results.json",report)
    assert normalized["status"]=="wrappers_terminal_requires_scientific_review"
    assert len(normalized["cases"])==6
    assert normalized["model_ref"]==model_ref
    assert normalized["gamma_control"]["output_dir"]==str(tmp_path/"gamma-t3")
    for mutation in ("incomplete","failure","identity","path","duplicate"):
        from copy import deepcopy
        bad=deepcopy(report)
        if mutation=="incomplete":bad["results"].pop()
        if mutation=="failure":bad["results"][0]["wrapper_exit"]=1
        if mutation=="identity":bad["source_digest"]="d"*64
        if mutation=="path":bad["results"][-1]["output"]=str(tmp_path.parent/"foreign")
        if mutation=="duplicate":bad["results"][-1]["case"]="de-t9"
        with pytest.raises(ValueError):normalize_controller_report(tmp_path/"controller-results.json",bad)


@pytest.mark.parametrize("mutation",["failed","foreign_job","model","source","hash"])
def test_gamma_control_rejects_bad_receipt_before_reading_fields(tmp_path,mutation):
    from collect_de_bv_thickness_comparison import validate_gamma_control
    job,result=fixture_run(tmp_path)
    result["pilot"]="de-smoke-k0"
    model_source=result["model_source"]
    if mutation=="failed":result["status"]="failed"
    if mutation=="foreign_job":result["job"]={**job,"job_id":"d"*32}
    if mutation=="model":result["model_source"]={"commit":"d"*40}
    if mutation=="source":result["source"]={"snapshot":"a"*64}
    if mutation=="hash":result["model_sha256"]="a"*64
    (tmp_path/"run-result.json").write_text(json.dumps(result))
    with patch("collect_de_bv_thickness_comparison.validate_smoke_potential_fields") as fields:
        with pytest.raises(ValueError,match="Gamma"):
            validate_gamma_control(tmp_path,job,model_source)
        fields.assert_not_called()
