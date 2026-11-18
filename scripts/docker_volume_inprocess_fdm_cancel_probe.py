"""Read-only proof for an accepted FDM GPU run cancelled after in-process prep.

This deliberately uses the existing locked cancellation probe and adds a
separate proof branch. It never represents the in-process receipt as a failed
external preparation process.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

from docker_build_control import BuildControlError, docker_capture
from docker_volume_dev import (
    _cancelled_activation_id,
    _cancelled_activation_preparation_evidence,
    _cancelled_activation_preparation_host_reservations,
    _cancelled_activation_probe_script,
    _cancelled_activation_sha,
)


PROBE_SCHEMA = "fullmag.docker-activation-cancel-probe.v1"
EVIDENCE_SCHEMA = "fullmag.inprocess-fdm-preparation-evidence.v1"
PREPARATION_KIND = "in-process-fdm"
CERTIFICATE_PRODUCERS = ["geometry", "display", "grid", "mesh", "space"]
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_PREF_SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\Z")


def _fail(message: str) -> BuildControlError:
    return BuildControlError("In-process FDM cancellation proof " + message)


def _inprocess_fdm_probe_script() -> str:
    """Build a guarded variant of the existing locked, read-only probe."""
    source = _cancelled_activation_probe_script()
    import_line = "import fcntl, hashlib, json, os, pathlib, stat, sys, time, urllib.error, urllib.request, uuid"
    if source.count(import_line) != 1:
        raise _fail("existing cancellation probe import set changed")
    source = source.replace(import_line, import_line.replace("json, os", "json, math, os"))
    producer_constant = 'MAX_PREPARATION_EVIDENCE_RECORDS=6\n'
    if source.count(producer_constant) != 1:
        raise _fail("existing cancellation probe evidence bounds changed")
    source = source.replace(
        producer_constant,
        producer_constant
        + 'CERTIFICATE_PRODUCERS=("geometry","display","grid","mesh","space")\n'
        + 'FDM_PRODUCER_FAMILY={"geometry":("fullmag.geometry","geometry_projection.v1","1"),'
          '"display":("fullmag.display","display_projection.v1","1"),'
          '"grid":("fullmag.fdm.grid","fdm_grid_certificate.v1","fullmag-plan.fdm.v1"),'
          '"mesh":("fullmag.fdm.cell_domain","fdm_cell_domain.v1","1"),'
          '"space":("fullmag.fdm.grid_space","fdm_grid_space.v1","1")}\n',
    )
    strict_object_definition = 'def strict_obj(raw, label):\n'
    if source.count(strict_object_definition) != 1:
        raise _fail("existing cancellation probe strict JSON parser changed")
    source = source.replace(
        strict_object_definition,
        'def strict_obj(raw, label, parse_float=None):\n',
    )
    strict_json_load = 'json.loads(raw.decode("utf-8"),object_pairs_hook=unique)'
    if source.count(strict_json_load) != 1:
        raise _fail("existing cancellation probe strict JSON decoder changed")
    source = source.replace(
        strict_json_load,
        'json.loads(raw.decode("utf-8"),object_pairs_hook=unique,parse_float=parse_float)',
    )
    start_marker = "    preparation_records=task_receipts+stage_receipts+prep_launches+prep_exits+prep_leases\n"
    end_marker = "    solver_matches=matching_json("
    start = source.find(start_marker)
    end = source.find(end_marker, start + len(start_marker))
    if start < 0 or end < 0 or source.find(start_marker, start + 1) >= 0:
        raise _fail("existing cancellation probe preparation evidence block changed")

    preparation_block = '''    preparation_records=task_receipts+stage_receipts+prep_launches+prep_exits+prep_leases
    preparation_evidence=[]
    if (len(task_receipts)!=1
            or task_receipts[0]["path"]!="task_preparation_receipts/"+task_id+".json"
            or len(stage_receipts)>1 or prep_launches or prep_exits or prep_leases):
        fail("in-process preparation receipt is not unique or external process records exist")
    receipt_record=task_receipts[0]
    receipt=receipt_record["value"]
    step_id=receipt.get("step_id")
    input_fingerprint=target.get("input_fingerprint")
    if (set(receipt)!={"schema_version","run_id","task_id","step_id","input_fingerprint",
                       "preparation_id","plan_fingerprint","payload_sha256","payload","created_at"}
            or not isinstance(receipt.get("created_at"),str)
            or not isinstance(step_id,str) or not step_id or len(step_id.encode("utf-8"))>256
            or any(ord(char)<32 or 127<=ord(char)<=159 or char in "/\\\\" for char in step_id)):
        fail("task preparation receipt step identity is invalid")
    expected_task_id="task-"+digest((run_id+"\\0"+step_id).encode("utf-8"))
    if (receipt.get("schema_version")!="task_preparation_receipt.v1"
            or receipt.get("run_id")!=run_id or receipt.get("task_id")!=task_id
            or expected_task_id!=task_id or not is_sha(input_fingerprint)
            or receipt.get("input_fingerprint")!=input_fingerprint
            or receipt.get("preparation_id")!="prep-"+task_id):
        fail("task preparation receipt run/task/step/fingerprint differs")
    payload=receipt.get("payload")
    plan_fingerprint=receipt.get("plan_fingerprint")
    payload_sha=receipt.get("payload_sha256")
    payload_fields={"schema_version","preparation_id","plan_fingerprint","plan","certificates","reuse","accepted_run_source"}
    if (not isinstance(payload,dict) or set(payload)!=payload_fields
            or payload.get("schema_version")!="preparation_receipt.v1"
            or not is_prefixed_sha(plan_fingerprint) or payload_sha!=digest(canon(payload))):
        fail("in-process preparation receipt is not the closed typed accepted receipt")
    plan=payload.get("plan")
    if (payload.get("preparation_id")!="prep-"+task_id
            or payload.get("plan_fingerprint")!=plan_fingerprint or not isinstance(plan,dict)):
        fail("in-process preparation receipt plan identity differs")
    plan_bytes=preparation_plan_v2_bytes(plan)
    if ("sha256:"+digest(plan_bytes))!=plan_fingerprint:
        fail("in-process preparation plan fingerprint differs")
    if plan.get("requested_backend")!="fdm" or plan.get("resolved_backend")!="fdm":
        fail("preparation plan requested or resolved backend is not FDM")
    for kind,expected in FDM_PRODUCER_FAMILY.items():
        producer=plan.get(kind)
        if (not isinstance(producer,dict)
                or (producer.get("producer_id"),producer.get("schema_version"),producer.get("producer_version"))!=expected):
            fail("accepted FDM producer family is not the qualified cell-space family")
    if (plan["mesh"].get("input_fingerprint")!=plan["grid"].get("output_fingerprint")
            or plan["space"].get("input_fingerprint")!=plan["mesh"].get("output_fingerprint")):
        fail("accepted FDM mesh/space producer fingerprints are not chained")
    source=plan.get("source")
    accepted_source=payload.get("accepted_run_source")
    if (not isinstance(source,dict) or not isinstance(accepted_source,dict)
            or source.get("kind")!="accepted_run_step"
            or accepted_source.get("schema_version")!="accepted_run_preparation_source.v1"
            or source.get("run_id")!=run_id or accepted_source.get("run_id")!=run_id
            or source.get("step_id")!=step_id or accepted_source.get("step_id")!=step_id
            or source.get("specification_fingerprint")!=accepted_spec_fingerprint
            or accepted_source.get("specification_fingerprint")!=accepted_spec_fingerprint
            or plan.get("problem_fingerprint")!=accepted_source.get("problem_fingerprint")
            or not is_prefixed_sha(plan.get("problem_fingerprint"))):
        fail("preparation receipt is not bound to the accepted RunSpec and step")
    if payload.get("reuse")!=[]:
        fail("in-process FDM preparation receipt contains a reuse decision")
    certificates=payload.get("certificates")
    if not isinstance(certificates,list) or len(certificates)!=5:
        fail("in-process preparation certificates are incomplete")
    def positive_u64(value,label):
        if type(value) is not int or value<=0 or value>18446744073709551615:
            fail(label+" must be a positive u64")
        return value
    def valid_fingerprint(value,label):
        if not is_prefixed_sha(value): fail(label+" must be sha256:<64 lowercase hex>")
    def finite_number(value):
        if type(value) not in (int,float): return False
        try: return math.isfinite(value)
        except (OverflowError,ValueError): return False
    def validate_quality(quality,certificate_cell_count):
        required={"cell_count","invalid_cell_count","quality_fingerprint"}
        allowed=required|{"min_quality","max_aspect_ratio","jacobian","mesh_source"}
        if (not isinstance(quality,dict) or not required.issubset(quality)
                or not set(quality).issubset(allowed)):
            fail("preparation quality evidence fields are malformed")
        quality_count=positive_u64(quality.get("cell_count"),"quality cell_count")
        invalid=quality.get("invalid_cell_count")
        if type(invalid) is not int or invalid<0 or invalid>18446744073709551615 or invalid!=0:
            fail("FDM quality evidence contains invalid cells")
        minimum=quality.get("min_quality")
        aspect=quality.get("max_aspect_ratio")
        if (not finite_number(minimum) or minimum<=0
                or not finite_number(aspect) or aspect<1):
            fail("FDM quality metrics are non-finite or outside their accepted range")
        if quality.get("jacobian") is not None or quality.get("mesh_source") is not None:
            fail("FDM quality evidence cannot carry FEM Jacobian or mesh-source data")
        valid_fingerprint(quality.get("quality_fingerprint"),"quality_fingerprint")
        if certificate_cell_count is not None and quality_count!=certificate_cell_count:
            fail("quality cell_count differs from its preparation certificate")
        return quality_count
    def validate_marker_map(marker_map):
        fields={"marker_map_fingerprint","marker_ids"}
        if not isinstance(marker_map,dict) or set(marker_map)!=fields:
            fail("preparation marker-map evidence fields are malformed")
        valid_fingerprint(marker_map.get("marker_map_fingerprint"),"marker_map_fingerprint")
        markers=marker_map.get("marker_ids")
        if (not isinstance(markers,list) or not markers
                or any(type(marker) is not int or marker<0 or marker>4294967295 for marker in markers)
                or any(markers[index-1]>=markers[index] for index in range(1,len(markers)))):
            fail("preparation marker IDs must be nonempty, increasing, unique u32 values")
        return marker_map["marker_map_fingerprint"]
    def validate_space(space,producer,mesh_fingerprint):
        required={"mesh_fingerprint","dof_count","space_fingerprint"}
        allowed=required|{"marker_map_fingerprint","fe_family","fe_order","local_dof_count","true_dof_count"}
        if not isinstance(space,dict) or not required.issubset(space) or not set(space).issubset(allowed):
            fail("FDM space evidence fields are malformed")
        positive_u64(space.get("dof_count"),"space dof_count")
        valid_fingerprint(space.get("mesh_fingerprint"),"space mesh_fingerprint")
        valid_fingerprint(space.get("space_fingerprint"),"space_fingerprint")
        valid_fingerprint(space.get("marker_map_fingerprint"),"space marker_map_fingerprint")
        if (space.get("space_fingerprint")!=producer.get("output_fingerprint")
                or space.get("mesh_fingerprint")!=mesh_fingerprint):
            fail("FDM space fingerprints differ from the accepted mesh or producer")
        if any(space.get(key) is not None for key in
               ("fe_family","fe_order","local_dof_count","true_dof_count")):
            fail("qualified FDM cell-space evidence cannot claim FEM finite-element metadata")
        return space["dof_count"]
    certificate_kinds=[]
    certificates_by_kind={}
    space_dof_count=None
    space_marker_fingerprint=None
    for certificate in certificates:
        certificate_fields={"schema_version","producer","quality","marker_map","cell_count","space"}
        if not isinstance(certificate,dict) or not {"schema_version","producer"}.issubset(certificate):
            fail("in-process preparation certificate is malformed")
        if not set(certificate).issubset(certificate_fields):
            fail("in-process preparation certificate has unknown fields")
        if certificate.get("schema_version")!="preparation_certificate.v1":
            fail("in-process preparation certificate schema differs")
        producer=certificate.get("producer")
        if not isinstance(producer,dict): fail("in-process preparation certificate producer is malformed")
        kind=producer.get("kind")
        if kind not in CERTIFICATE_PRODUCERS or producer!=plan.get(kind):
            fail("in-process preparation certificate does not match its plan producer")
        if kind in certificates_by_kind:
            fail("in-process preparation certificate producer is duplicated")
        certificate_kinds.append(kind)
        cell_count=certificate.get("cell_count")
        if cell_count is not None:
            cell_count=positive_u64(cell_count,"preparation certificate cell_count")
        quality=certificate.get("quality")
        marker_map=certificate.get("marker_map")
        space=certificate.get("space")
        if kind!="space" and space is not None:
            fail("space evidence is only valid for the space producer")
        if quality is not None:
            validate_quality(quality,cell_count)
        if marker_map is not None:
            validate_marker_map(marker_map)
        if kind=="grid":
            if cell_count is None:
                fail("qualified FDM grid certificate requires cell_count")
        elif kind=="mesh":
            if cell_count is None or quality is None or marker_map is None:
                fail("qualified FDM mesh certificate requires cell_count, quality and marker map")
        elif kind=="space":
            if space is None or marker_map is None:
                fail("qualified FDM space certificate requires space and marker-map evidence")
            space_dof_count=validate_space(space,producer,plan["mesh"]["output_fingerprint"])
            space_marker_fingerprint=space.get("marker_map_fingerprint")
        certificates_by_kind[kind]=certificate
    if sorted(certificate_kinds)!=sorted(CERTIFICATE_PRODUCERS):
        fail("in-process preparation certificate producer set is incomplete")
    grid_count=certificates_by_kind["grid"].get("cell_count")
    mesh_certificate=certificates_by_kind["mesh"]
    mesh_count=mesh_certificate.get("cell_count")
    mesh_marker_fingerprint=mesh_certificate.get("marker_map",{}).get("marker_map_fingerprint")
    space_certificate_marker_fingerprint=certificates_by_kind["space"].get("marker_map",{}).get("marker_map_fingerprint")
    if (grid_count is None or mesh_count is None or space_dof_count is None
            or grid_count!=mesh_count or grid_count!=space_dof_count):
        fail("qualified FDM grid, mesh and cell-space counts differ")
    if (space_certificate_marker_fingerprint!=mesh_marker_fingerprint
            or space_marker_fingerprint!=space_certificate_marker_fingerprint):
        fail("FDM space evidence references a different marker map")
    if stage_receipts:
        stage_record=stage_receipts[0]
        stage=stage_record["value"]
        if (set(stage)!={"schema_version","run_id","step_id","task_id","input_fingerprint",
                         "preparation_id","plan_fingerprint","task_receipt_payload_sha256"}
                or stage_record["path"]!="accepted_stage_preparation_receipts/"+task_id+".json"
                or stage.get("schema_version")!="accepted_stage_preparation_receipt.v1"
                or stage.get("run_id")!=run_id or stage.get("task_id")!=task_id
                or stage.get("step_id")!=step_id
                or stage.get("input_fingerprint")!=receipt.get("input_fingerprint")
                or stage.get("preparation_id")!=receipt.get("preparation_id")
                or stage.get("plan_fingerprint")!=plan_fingerprint
                or stage.get("task_receipt_payload_sha256")!=payload_sha):
            fail("accepted stage preparation receipt differs from its task receipt")
    accepted_source_summary=validate_accepted_fdm_source(intent,specification,plan,run_id,step_id)
    if (accepted_source_summary["specification_fingerprint"]!=accepted_spec_fingerprint
            or accepted_source_summary["problem_fingerprint"]!=plan.get("problem_fingerprint")):
        fail("accepted CAS source fingerprint differs from the preparation receipt")
    prepared_observations=read_records(run/"task_prepared_observations","task prepared observations")
    if len(prepared_observations)>1:
        fail("task prepared observation is not unique")
    prepared_observation=None
    if prepared_observations:
        observation_record=prepared_observations[0]
        observation=observation_record["value"]
        outcome=observation.get("outcome")
        observation_fields={"schema_version","run_id","task_id","step_id","preparation_id",
                            "plan_fingerprint","magnetization_values_sha256","evaluation_lane",
                            "requested_lane","outcome","created_at"}
        if (set(observation)!=observation_fields
                or observation_record["path"]!="task_prepared_observations/"+task_id+".json"
                or observation.get("schema_version")!="task_prepared_observation.v1"
                or observation.get("run_id")!=run_id or observation.get("task_id")!=task_id
                or observation.get("step_id")!=step_id
                or observation.get("preparation_id")!="prep-"+task_id
                or observation.get("plan_fingerprint")!=plan_fingerprint
                or observation.get("requested_lane")!="fdm_gpu"
                or observation.get("evaluation_lane") not in {"fdm_cpu","fdm_gpu"}
                or not is_sha(observation.get("magnetization_values_sha256"))
                or not isinstance(observation.get("created_at"),str)
                or not isinstance(outcome,dict) or outcome.get("state") not in {"published","unavailable"}):
            fail("task prepared observation differs from the accepted FDM GPU preparation")
        if outcome.get("state")=="published":
            refs=outcome.get("object_refs")
            bundle=outcome.get("bundle_object_ref")
            if (set(outcome)!={"state","bundle_object_ref","object_refs"}
                    or not isinstance(refs,list) or not refs or len(refs)>4096
                    or not is_sha(bundle) or bundle not in refs
                    or any(not is_sha(ref) for ref in refs) or len(set(refs))!=len(refs)):
                fail("published task prepared observation object identity is invalid")
        elif (set(outcome)!={"state","reason"}
                or not isinstance(outcome.get("reason"),str)
                or not outcome["reason"].strip() or len(outcome["reason"].encode("utf-8"))>2048):
            fail("unavailable task prepared observation reason is invalid")
        prepared_observation={"sha256":digest(observation_record["raw"]),
                              "evaluation_lane":observation["evaluation_lane"],
                              "requested_lane":observation["requested_lane"]}
    preparation_evidence=sorted(
        ({"path":record["path"],"sha256":digest(record["raw"])} for record in preparation_records),
        key=lambda item:item["path"],
    )
    preparation_summary={
        "schema_version":"fullmag.inprocess-fdm-preparation-evidence.v1",
        **accepted_source_summary,
        "preparation_id":payload["preparation_id"],
        "plan_fingerprint":plan_fingerprint,
        "certificate_producers":list(CERTIFICATE_PRODUCERS),
        "external_preparation_records":{"launches":0,"exits":0,"leases":0,"retry_decisions":0},
        "start_gate_closed":True,
        "task_admissions":0,"claims":0,"worker_attempts":0,"solver_leases":0,"host_reservations":0,
        "compute_queue_empty":True,
        "prepared_observation":prepared_observation,
    }
'''
    source = source[:start] + preparation_block + source[end:]

    cas_validator = '''class CanonicalFloat(float):
    def __new__(cls,token):
        value=float.__new__(cls,token)
        value.token=token
        return value
def canonical_cas_value(value):
    if isinstance(value,CanonicalFloat): return value.token.encode("ascii")
    if value is None: return b"null"
    if value is True: return b"true"
    if value is False: return b"false"
    if isinstance(value,str): return json.dumps(value,ensure_ascii=False,separators=(",",":")).encode("utf-8")
    if isinstance(value,int): return str(value).encode("ascii")
    if isinstance(value,list): return b"["+b",".join(canonical_cas_value(item) for item in value)+b"]"
    if isinstance(value,dict):
        return b"{"+b",".join(json.dumps(key,ensure_ascii=False).encode("utf-8")+b":"+canonical_cas_value(value[key]) for key in sorted(value))+b"}"
    fail("accepted CAS contains an unsupported JSON value")
def validate_accepted_fdm_source(intent,specification,plan,run_id,step_id):
    def cas_raw(object_ref,label):
        if not is_sha(object_ref): fail(label+" reference is not a bare SHA-256")
        objects=store/"objects"; sha_root=objects/"sha256"
        if (objects.is_symlink() or not objects.is_dir() or objects.resolve(strict=True)!=objects
                or sha_root.is_symlink() or not sha_root.is_dir() or sha_root.resolve(strict=True)!=sha_root):
            fail("accepted CAS object root is unsafe")
        path=sha_root/object_ref
        raw=regular(path,"accepted CAS "+label,MAX)
        if digest(raw)!=object_ref: fail("accepted CAS "+label+" digest differs from its reference")
        return raw
    def cas_obj(object_ref,label):
        raw=cas_raw(object_ref,label)
        return raw,strict_obj(raw,"accepted CAS "+label)
    if not isinstance(specification,dict): fail("accepted RunSpec is malformed")
    if specification.get("schema_version") not in {"run_spec.v1","run_spec.v2"} or specification.get("run_id")!=run_id:
        fail("accepted RunSpec identity or schema differs")
    snapshot=specification.get("snapshot"); study_ref_record=specification.get("study")
    requested=specification.get("requested_execution")
    if not isinstance(snapshot,dict) or not isinstance(study_ref_record,dict) or not isinstance(requested,dict):
        fail("accepted RunSpec snapshot, study or execution intent is missing")
    if (requested.get("backend")!="fdm" or requested.get("device")!="gpu"
            or requested.get("precision")!="double" or requested.get("mode")!="strict"):
        fail("accepted RunSpec is not explicitly FDM GPU strict double")
    definition_ref=intent.get("definition_object_ref")
    study_ref=intent.get("study_object_ref")
    catalog_ref=intent.get("study_catalog_object_ref")
    if (not is_sha(definition_ref) or snapshot.get("definition_sha256")!=definition_ref
            or not is_sha(study_ref) or study_ref_record.get("plan_sha256")!=study_ref
            or not is_sha(catalog_ref) or specification.get("study_catalog_sha256")!=catalog_ref):
        fail("accepted RunSpec CAS references differ from its immutable intent")
    cas_raw(definition_ref,"project definition")
    study_raw,study=cas_obj(study_ref,"StudyPlan")
    catalog_raw=cas_raw(catalog_ref,"ProblemIR catalog")
    catalog=strict_obj(catalog_raw,"accepted CAS ProblemIR catalog",parse_float=CanonicalFloat)
    if canonical_cas_value(catalog)!=catalog_raw:
        fail("accepted ProblemIR catalog is not in canonical JSON form")
    if (study.get("schema_version")!=study_ref_record.get("plan_version")
            or study.get("study_id")!=study_ref_record.get("study_id")
            or type(study.get("revision")) is not int or study.get("revision",0)<=0
            or not isinstance(study.get("steps"),list)):
        fail("accepted StudyPlan identity is invalid")
    study_steps=[row for row in study["steps"] if isinstance(row,dict) and row.get("step_id")==step_id]
    if len(study_steps)!=1 or study_steps[0].get("enabled",True) is not True:
        fail("preparation step is not one enabled accepted StudyPlan step")
    step=study_steps[0]
    if (catalog.get("schema_version") not in {"study_problem_catalog.v1","study_problem_catalog.v2","study_problem_catalog.v3"}
            or catalog.get("study_id")!=study.get("study_id")
            or catalog.get("study_revision")!=study.get("revision")
            or catalog.get("study_plan_sha256")!=study_ref
            or not isinstance(catalog.get("entries"),list)):
        fail("accepted ProblemIR catalog is not linked to its StudyPlan")
    entries=[row for row in catalog["entries"] if isinstance(row,dict) and row.get("step_id")==step_id]
    if len(entries)!=1: fail("accepted ProblemIR catalog step is missing or ambiguous")
    entry=entries[0]
    for key in ("model","solver_config","discretization","execution_profile"):
        if not isinstance(step.get(key),dict) or canon(step.get(key))!=canon(entry.get(key)):
            fail("accepted ProblemIR catalog "+key+" reference differs from the StudyPlan")
    problem=entry.get("problem")
    if not isinstance(problem,dict): fail("accepted ProblemIR is missing")
    problem_fingerprint="sha256:"+digest(canonical_cas_value(problem))
    if plan.get("problem_fingerprint")!=problem_fingerprint:
        fail("accepted ProblemIR fingerprint differs from the preparation plan")
    backend_policy=problem.get("backend_policy")
    validation=problem.get("validation_profile")
    problem_meta=problem.get("problem_meta")
    metadata=problem_meta.get("runtime_metadata") if isinstance(problem_meta,dict) else None
    selection=metadata.get("runtime_selection") if isinstance(metadata,dict) else None
    if (not isinstance(backend_policy,dict)
            or backend_policy.get("requested_backend")!="fdm"
            or backend_policy.get("execution_precision")!="double"
            or not isinstance(validation,dict) or validation.get("execution_mode")!="strict"
            or not isinstance(selection,dict) or selection.get("device") not in {"gpu","cuda"}
            or ("explicit_selection" in selection and selection.get("explicit_selection") is not True)
            or ("gpu_count" in selection and (type(selection.get("gpu_count")) is not int or selection.get("gpu_count",0)<0))):
        fail("accepted ProblemIR does not preserve explicit FDM GPU strict-double intent")
    precision_policy=backend_policy.get("fdm_precision_policy")
    if precision_policy is not None and (
            not isinstance(precision_policy,dict)
            or any(precision_policy.get(key)!="double" for key in ("storage","compute","fft","reduction"))
            or precision_policy.get("realization_id")!="fullmag.fdm.cuda.precision.full_double.v1"):
        fail("accepted ProblemIR has a non-full-double FDM precision policy")
    materialization=entry.get("execution_materialization")
    if catalog.get("schema_version") in {"study_problem_catalog.v2","study_problem_catalog.v3"} and not isinstance(materialization,dict):
        fail("accepted ProblemIR catalog has no pinned execution materialization")
    if materialization is not None:
        materialized=materialization.get("requested") if isinstance(materialization,dict) else None
        profile=materialization.get("profile") if isinstance(materialization,dict) else None
        profile_ref=entry.get("execution_profile")
        if (not isinstance(materialized,dict)
                or materialized.get("backend")!="fdm" or materialized.get("device")!="gpu"
                or materialized.get("precision")!="double" or materialized.get("mode")!="strict"
                or not isinstance(profile,dict) or not isinstance(profile_ref,dict)
                or profile.get("profile_id")!=profile_ref.get("profile_id")
                or profile.get("version")!=profile_ref.get("version")
                or materialization.get("profile_sha256")!=digest(canon(profile))):
            fail("accepted execution materialization differs from FDM GPU strict-double intent")
    return {
        "step_id":step_id,
        "specification_fingerprint":"sha256:"+digest(canon(specification)),
        "definition_sha256":definition_ref,
        "study_plan_sha256":study_ref,
        "study_catalog_sha256":catalog_ref,
        "problem_fingerprint":problem_fingerprint,
        "requested_execution":{"backend":"fdm","device":"gpu","precision":"double","mode":"strict"},
        "resolved_backend":"fdm",
    }
'''
    insert_point = 'store=pathlib.Path(store_root)\n'
    if source.count(insert_point) != 1:
        raise _fail("existing cancellation probe CAS insertion point changed")
    source = source.replace(insert_point, cas_validator + insert_point)

    for old, new, label in (
        ('intent=obj(intent_path,"accepted RunIntent")', 'intent=strict_obj(intent_raw,"accepted RunIntent")', "RunIntent"),
        ('catalog=obj(catalog_path,"run catalog")', 'catalog=strict_obj(catalog_raw,"run catalog")', "run catalog"),
        ('cancellation=obj(cancellation_path,"cancellation intent")', 'cancellation=strict_obj(cancellation_raw,"cancellation intent")', "cancellation intent"),
        ('marker=obj(marker_path,"startup activation marker")', 'marker=strict_obj(marker_raw,"startup activation marker")', "startup activation marker"),
    ):
        if source.count(old) != 1:
            raise _fail("existing cancellation probe " + label + " parser point changed")
        source = source.replace(old, new)

    old_owner_fields = 'for key in ("attempt_id","resource_id","resolved_input_fingerprint","coordinator_watermark","coordinator_genesis"):'
    if source.count(old_owner_fields) != 1:
        raise _fail("existing cancellation probe task ownership guard changed")
    source = source.replace(
        old_owner_fields,
        'for key in ("attempt_id","ownership_epoch","resource_id","resolved_input_fingerprint","coordinator_watermark","coordinator_genesis"):',
    )
    old_admissions = '    ensure_empty_tree(run/"task_admissions","cancelled run task admissions")'
    extra_closed_state = '''    ensure_empty_tree(run/"task_admissions","cancelled run task admissions")
    ensure_empty_tree(run/"worker-attempts","cancelled run worker attempts")
    ensure_empty_tree(run/"worker_process_exit_receipts","cancelled worker exit receipts")
    ensure_empty_tree(run/"retry_decisions","cancelled run retry decisions")
    ensure_empty_tree(run/"preparation_retry_decisions","cancelled preparation retry decisions")
    ensure_empty_tree(run/"coordinator_journal","cancelled run coordinator journal")
    start_release=run/"start_release.json"
    if start_release.is_symlink() or start_release.exists(): fail("manual accepted start gate is not closed")'''
    if source.count(old_admissions) != 1:
        raise _fail("existing cancellation probe admission guard changed")
    source = source.replace(old_admissions, extra_closed_state)

    old_solver = '    solver_matches=matching_json(run/"resource_leases","solver resource leases",lambda value: value.get("run_id")==run_id and value.get("task_id") in task_ids and value.get("state")!="released")\n    if solver_matches: fail("task has an active or uncertain solver lease")\n'
    new_solver = '    solver_matches=matching_json(run/"resource_leases","solver resource leases",lambda value: value.get("run_id")==run_id and value.get("task_id") in task_ids)\n    if solver_matches: fail("in-process preparation task has a solver lease")\n'
    if source.count(old_solver) != 1:
        raise _fail("existing cancellation probe solver lease check changed")
    source = source.replace(old_solver, new_solver)

    reservation_start = '    matching=[]\n    preparation_host_reservations=[]\n'
    reservation_end = '    expected_scene_revision=int(expected_scene_revision)\n'
    begin = source.find(reservation_start)
    finish = source.find(reservation_end, begin + len(reservation_start))
    if begin < 0 or finish < 0 or source.find(reservation_start, begin + 1) >= 0:
        raise _fail("existing cancellation probe host reservation block changed")
    no_reservations = '''    matching=[]
    preparation_host_reservations=[]
    for row in reservations:
        if not isinstance(row,dict): fail("host resource ledger reservation is malformed")
        identity=row.get("identity")
        if isinstance(identity,dict) and identity.get("run_id")==run_id and identity.get("task_id") in task_ids:
            matching.append(row)
    if matching: fail("in-process preparation task has a host resource reservation")
'''
    source = source[:begin] + no_reservations + source[finish:]

    run_check = '            if (retained_run.get("run_id")!=run_id'
    if source.count(run_check) != 1:
        raise _fail("existing cancellation probe current-run validation point changed")
    source = source.replace(
        run_check,
        '            if (type(retained_run.get("total_steps")) is not int or retained_run.get("total_steps")!=len(tasks)\n'
        '                    or retained_run.get("run_id")!=run_id',
    )
    run_output = '    if retained_current_run_sha256 is not None: probe["retained_current_run_sha256"]=retained_current_run_sha256'
    if source.count(run_output) != 1:
        raise _fail("existing cancellation probe current-run output point changed")
    source = source.replace(
        run_output,
        '    if retained_current_run_sha256 is not None:\n'
        '        probe["retained_current_run_sha256"]=retained_current_run_sha256\n'
        '        probe["retained_current_run_task_count"]=retained_run.get("total_steps")',
    )
    output_marker = '    print(json.dumps(probe,sort_keys=True))'
    output = '''    probe["preparation_kind"]="in-process-fdm"
    probe["in_process_fdm"]=preparation_summary
    print(json.dumps(probe,sort_keys=True))'''
    if source.count(output_marker) != 1:
        raise _fail("existing cancellation probe output point changed")
    source = source.replace(output_marker, output)
    return source


def _validate_inprocess_fdm_probe(
    probe: Mapping[str, object],
    *,
    request_id: str,
    source_sha256: str,
    expected_run_id: str,
    expected_task_id: str,
    expected_session_id: str,
    expected_api_instance_id: str,
) -> dict[str, object]:
    if probe.get("schema") != PROBE_SCHEMA or probe.get("preparation_kind") != PREPARATION_KIND:
        raise _fail("schema or preparation kind differs")
    for key, expected in {
        "request_id": request_id,
        "source_sha256": source_sha256,
        "run_id": expected_run_id,
        "task_id": expected_task_id,
        "live_session_id": expected_session_id,
        "live_api_instance_id": expected_api_instance_id,
    }.items():
        if probe.get(key) != expected:
            raise _fail(f"{key} differs from the pinned activation incarnation")
    for key in ("run_id", "task_id", "cancellation_id"):
        _cancelled_activation_id(probe.get(key), key)
    for key in (
        "run_intent_sha256", "run_catalog_sha256", "cancellation_intent_sha256",
        "activation_marker_sha256", "live_workspace_sha256", "retained_current_run_sha256",
    ):
        _cancelled_activation_sha(probe.get(key), key)
    for key in ("live_session_epoch", "live_scene_revision", "catalog_revision", "task_count"):
        value = probe.get(key)
        if type(value) is not int or value < 0:
            raise _fail(f"{key} is invalid")
    if probe.get("catalog_revision", 0) <= 0 or probe.get("task_count") != 1:
        raise _fail("proof does not identify one accepted task")
    if probe.get("retained_current_run_task_count") != 1:
        raise _fail("retained current run planned task count differs")
    if probe.get("matching_reservations") != 0:
        raise _fail("task still has a host resource reservation")
    queue = probe.get("compute_queue")
    if (not isinstance(queue, Mapping) or queue.get("schema_version") != "compute_queue.v1"
            or queue.get("items") != []):
        raise _fail("compute queue is not empty")
    runtime = probe.get("runtime_service")
    if (not isinstance(runtime, Mapping) or runtime.get("configured") is not True
            or runtime.get("state") != "ready" or not isinstance(runtime.get("reason"), Mapping)
            or runtime["reason"].get("code") != "service_ready"):
        raise _fail("native runtime service is not Ready")
    health = probe.get("health")
    if (not isinstance(health, Mapping) or health.get("status") != "ok"
            or health.get("active_session") is not True):
        raise _fail("pinned active session is not healthy")
    evidence = _cancelled_activation_preparation_evidence(
        probe.get("preparation_evidence"), "in-process FDM preparation evidence",
    )
    expected_receipt_path = "task_preparation_receipts/" + str(probe["task_id"]) + ".json"
    evidence_paths = {entry["path"] for entry in evidence}
    if expected_receipt_path not in evidence_paths:
        raise _fail("task preparation receipt digest is missing")
    host_reservations = _cancelled_activation_preparation_host_reservations(
        probe.get("preparation_host_reservations", []), "in-process FDM host reservation evidence",
    )
    if host_reservations:
        raise _fail("task retains a host reservation")
    if "failed_preparation" in probe:
        raise _fail("in-process preparation was mislabeled as a failed external preparation")

    summary = probe.get("in_process_fdm")
    required_summary = {
        "schema_version", "step_id", "specification_fingerprint", "definition_sha256",
        "study_plan_sha256", "study_catalog_sha256", "problem_fingerprint", "requested_execution",
        "resolved_backend", "preparation_id", "plan_fingerprint", "certificate_producers",
        "external_preparation_records", "start_gate_closed", "task_admissions", "claims",
        "worker_attempts", "solver_leases", "host_reservations", "compute_queue_empty",
        "prepared_observation",
    }
    if not isinstance(summary, Mapping) or set(summary) != required_summary:
        raise _fail("accepted FDM source summary fields differ")
    if summary.get("schema_version") != EVIDENCE_SCHEMA:
        raise _fail("accepted FDM source summary schema differs")
    for key in ("step_id", "preparation_id"):
        value = summary.get(key)
        if not isinstance(value, str) or _IDENTIFIER_RE.fullmatch(value) is None:
            raise _fail(f"{key} is invalid")
    if summary.get("preparation_id") != "prep-" + str(probe["task_id"]):
        raise _fail("preparation identity differs from the accepted task")
    for key in ("specification_fingerprint", "problem_fingerprint", "plan_fingerprint"):
        value = summary.get(key)
        if not isinstance(value, str) or _PREF_SHA256_RE.fullmatch(value) is None:
            raise _fail(f"{key} is invalid")
    for key in ("definition_sha256", "study_plan_sha256", "study_catalog_sha256"):
        value = summary.get(key)
        if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
            raise _fail(f"{key} is invalid")
    if summary.get("resolved_backend") != "fdm":
        raise _fail("resolved backend is not FDM")
    if summary.get("requested_execution") != {
        "backend": "fdm", "device": "gpu", "precision": "double", "mode": "strict",
    }:
        raise _fail("requested execution does not preserve FDM GPU strict-double intent")
    producers = summary.get("certificate_producers")
    if producers != CERTIFICATE_PRODUCERS:
        raise _fail("five typed preparation certificates are not present")
    external = summary.get("external_preparation_records")
    if external != {"launches": 0, "exits": 0, "leases": 0, "retry_decisions": 0}:
        raise _fail("external preparation process or retry records exist")
    if summary.get("start_gate_closed") is not True or summary.get("compute_queue_empty") is not True:
        raise _fail("manual start gate or compute queue is open")
    for key in ("task_admissions", "claims", "worker_attempts", "solver_leases", "host_reservations"):
        if type(summary.get(key)) is not int or summary.get(key) != 0:
            raise _fail(f"{key} evidence is not empty")
    observation = summary.get("prepared_observation")
    if observation is not None:
        if (not isinstance(observation, Mapping)
                or set(observation) != {"sha256", "evaluation_lane", "requested_lane"}
                or not isinstance(observation.get("sha256"), str)
                or _SHA256_RE.fullmatch(observation["sha256"]) is None
                or observation.get("evaluation_lane") not in {"fdm_cpu", "fdm_gpu"}
                or observation.get("requested_lane") != "fdm_gpu"):
            raise _fail("prepared-state observation is not bound to the requested FDM GPU lane")

    stable_probe: dict[str, object] = {
        "schema": PROBE_SCHEMA,
        "preparation_kind": PREPARATION_KIND,
        "run_id": probe["run_id"],
        "task_id": probe["task_id"],
        "request_id": request_id,
        "source_sha256": source_sha256,
        "catalog_revision": probe["catalog_revision"],
        "cancellation_id": probe["cancellation_id"],
        "run_intent_sha256": probe["run_intent_sha256"],
        "run_catalog_sha256": probe["run_catalog_sha256"],
        "cancellation_intent_sha256": probe["cancellation_intent_sha256"],
        "activation_marker_sha256": probe["activation_marker_sha256"],
        "matching_reservations": 0,
        "task_count": 1,
        "live_api_instance_id": probe["live_api_instance_id"],
        "live_session_id": probe["live_session_id"],
        "live_session_epoch": probe["live_session_epoch"],
        "live_scene_revision": probe["live_scene_revision"],
        "live_workspace_sha256": probe["live_workspace_sha256"],
        "retained_current_run_sha256": probe["retained_current_run_sha256"],
        "retained_current_run_task_count": 1,
        "preparation_evidence": evidence,
        "preparation_host_reservations": [],
        "in_process_fdm": dict(summary),
        "compute_queue_empty": True,
        "runtime_ready": True,
        "api_healthy": True,
    }
    return {
        "run_id": probe["run_id"],
        "task_id": probe["task_id"],
        "session_id": probe["live_session_id"],
        "cancellation_id": probe["cancellation_id"],
        "request_id": request_id,
        "source_sha256": source_sha256,
        "catalog_revision": probe["catalog_revision"],
        "run_intent_sha256": probe["run_intent_sha256"],
        "run_catalog_sha256": probe["run_catalog_sha256"],
        "cancellation_intent_sha256": probe["cancellation_intent_sha256"],
        "activation_marker_sha256": probe["activation_marker_sha256"],
        "live_api_instance_id": probe["live_api_instance_id"],
        "live_session_epoch": probe["live_session_epoch"],
        "live_scene_revision": probe["live_scene_revision"],
        "live_workspace_sha256": probe["live_workspace_sha256"],
        "retained_current_run_sha256": probe["retained_current_run_sha256"],
        "preparation_evidence": evidence,
        "preparation_host_reservations": [],
        "preparation_kind": PREPARATION_KIND,
        "in_process_fdm": dict(summary),
        "probe": stable_probe,
    }


def _inprocess_fdm_store_probe(
    backend_id: str,
    *,
    run_id: str,
    task_id: str,
    request_id: str,
    source_sha256: str,
    marker_path: str,
    expected_scene_revision: int,
    environment: Mapping[str, str],
) -> dict[str, object]:
    store_root = environment.get("FULLMAG_RUNS_ROOT", "/state/runs/docker-all") + "/session-store"
    ledger_root = environment.get("FULLMAG_HOST_LEDGER_ROOT", "/host-ledger/ledger")
    result = docker_capture(
        "exec", "-i", backend_id, "/usr/local/bin/python3", "-B", "-",
        run_id, task_id, request_id, source_sha256, marker_path,
        store_root, ledger_root, str(expected_scene_revision),
        data=_inprocess_fdm_probe_script().encode("utf-8"),
        timeout=90, allow_failure=True,
    )
    if result.returncode:
        raise _fail(
            "locked accepted-store probe failed: "
            + result.stderr.decode("utf-8", "replace")[-4096:]
        )
    try:
        probe = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("locked accepted-store probe returned invalid JSON") from error
    if not isinstance(probe, dict) or probe.get("schema") != PROBE_SCHEMA:
        raise _fail("locked accepted-store probe returned an invalid schema")
    return probe


def probe_and_validate(
    backend_id: str,
    *,
    run_id: str,
    task_id: str,
    request_id: str,
    source_sha256: str,
    marker_path: str,
    expected_scene_revision: int,
    expected_session_id: str,
    expected_api_instance_id: str,
    environment: Mapping[str, str],
) -> tuple[dict[str, object], dict[str, object]]:
    probe = _inprocess_fdm_store_probe(
        backend_id,
        run_id=run_id,
        task_id=task_id,
        request_id=request_id,
        source_sha256=source_sha256,
        marker_path=marker_path,
        expected_scene_revision=expected_scene_revision,
        environment=environment,
    )
    cancellation = _validate_inprocess_fdm_probe(
        probe,
        request_id=request_id,
        source_sha256=source_sha256,
        expected_run_id=run_id,
        expected_task_id=task_id,
        expected_session_id=expected_session_id,
        expected_api_instance_id=expected_api_instance_id,
    )
    if cancellation.get("live_scene_revision") != expected_scene_revision:
        raise _fail("scene revision differs from the exact stopped activation scope")
    return probe, cancellation
