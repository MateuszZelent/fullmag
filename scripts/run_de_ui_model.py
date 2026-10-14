"""Load the pinned DE pilot into a managed, volatile browser session.

This is model-preview evidence, not solver execution or durable session evidence.
The numerical pilot keeps its own independently validated output directory.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid

import run_comsol_dispersion_benchmark as managed
import de_smoke_model_input as model_input
from local_runner.build_executor import validate_build_receipt


def _without_nulls(value):
    if isinstance(value, dict):
        return {key: _without_nulls(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_without_nulls(item) for item in value]
    return value


def verify_loaded_scene(expected, observed):
    # SceneResource is a presentation DTO, not a lossless SceneDocument.
    # Check authored physics and pipeline rather than omitted editor defaults.
    objects = expected.get("objects")
    if not objects or len(observed.get("objects", [])) != len(objects):
        raise ValueError("Loaded scene objects differ or are empty")
    for source, loaded in zip(objects, observed["objects"]):
        for key in ("id", "name", "geometry", "transform", "material_ref", "magnetization_ref", "physics_stack"):
            if _without_nulls(source.get(key)) != _without_nulls(loaded.get(key)):
                raise ValueError("Loaded objects differ: " + key)
    source_study = expected.get("study", {})
    loaded_study = observed.get("study", {})
    for key in ("requested_backend", "requested_device", "requested_precision", "external_field",
                "exchange_enabled", "demag_enabled", "demag_realization", "study_pipeline"):
        if _without_nulls(source_study.get(key)) != _without_nulls(loaded_study.get(key)):
            raise ValueError("Loaded study differs: " + key)
    if "study_pipeline" not in source_study and source_study != loaded_study:
        raise ValueError("Loaded study differs")
    if _without_nulls(expected.get("materials")) != _without_nulls(observed.get("materials")):
        raise ValueError("Loaded material values differ")
    for key in ("mode", "size", "center", "padding", "airbox_hmax", "airbox_growth_rate", "airbox_grading"):
        if (expected.get("universe") or {}).get(key) != (observed.get("universe") or {}).get(key):
            raise ValueError("Loaded universe differs: " + key)


def signed_pair_scene(positive, negative):
    for key in ("objects", "materials", "universe"):
        if positive[key] != negative[key]:
            raise ValueError("Signed pilot models differ outside k: " + key)
    result = copy.deepcopy(positive)
    eigen = [stage for stage in negative["study"]["stages"] if stage["kind"] == "eigenmodes"]
    nodes = [node for node in negative["study"]["study_pipeline"]["nodes"] if node["stage_kind"] == "eigenmodes"]
    if len(eigen) != 1 or len(nodes) != 1:
        raise ValueError("Signed pilot requires one eigen stage")
    stage = copy.deepcopy(eigen[0]); stage["stage_id"] = "eigenmodes-km10"
    node = copy.deepcopy(nodes[0]); node["id"] = stage["stage_id"]
    node["payload"]["stage_id"] = stage["stage_id"]; node["label"] = "DE -10 rad/um"
    result["study"]["stages"].append(stage)
    result["study"]["study_pipeline"]["nodes"].append(node)
    return result


def require_matched_frontend(runtime_identity, frontend_identity):
    # Session scope and generated transport must agree with the API release.
    for key in ("head_commit_full", "source_snapshot_sha256", "source_snapshot_dirty"):
        if key not in runtime_identity or runtime_identity[key] != frontend_identity.get(key):
            raise ValueError("Frontend and API must come from the same managed source: " + key)


def browser_spec(image, source, package, state, port):
    env={"FULLMAG_REPO_ROOT":"/tmp/fullmag-workspace", "FULLMAG_STATE_ROOT":"/tmp/fullmag-workspace/.fullmag",
         "FULLMAG_WEB_STATIC_DIR":"/state/web", "FULLMAG_API_PORT":"8081",
         "FULLMAG_RUNTIME_ROOT":"/package", "FULLMAG_PYTHON":"/usr/local/bin/python3",
         "PYTHONPATH":"/source/packages/fullmag-py/src:/package", "PYTHONDONTWRITEBYTECODE":"1",
         "LD_LIBRARY_PATH":"/package/lib:/usr/local/cuda/compat:/opt/fullmag-mfem-cpu/lib:/opt/fullmag-deps/lib",
         "PATH":"/package/bin:/usr/local/bin:/usr/bin:/bin", "OMP_NUM_THREADS":"4",
         "FULLMAG_CPU_THREADS":"4", "FULLMAG_FEM_EXECUTION":"cpu",
         "FULLMAG_FEM_MFEM_DEVICE":"cpu", "FULLMAG_FORCE_LOCAL_FEM_CPU":"1",
         "FULLMAG_FEM_REQUIRE_GPU":"0", "FULLMAG_FEM_REQUIRE_CEED":"1",
         "FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME":"1"}
    mounts=[{"type":"bind", "source":str(path.resolve()), "target":target,"read_only":ro}
            for path,target,ro in ((source,"/source",True),(package,"/package",True),(state,"/state",False))]
    return {"services":{"browser":{"image":image,"pull_policy":"never","init":True,
      "network_mode":"bridge","entrypoint":[],
      "command":["bash","-c", ('set -eu; [ ! -L /state/workspace ] || exit 2; mkdir -p /state/workspace; mkdir -p /tmp/fullmag-workspace; '
          'for path in /source/* /source/.[!.]*; do '
          '[ -e "$path" ] || continue; name="${path##*/}"; '
          '[ "$name" != ".fullmag" ] || exit 2; '
          'ln -s "$path" "/tmp/fullmag-workspace/$name"; done; '
          'mkdir /tmp/fullmag-workspace/.fullmag; '
          'cd /tmp/fullmag-workspace; exec /package/bin/fullmag-api').replace("$", "$$")],
      "working_dir":"/source","read_only":True,"user":"65532:65532","cpus":4,
      "mem_limit":"2g","pids_limit":128,"cap_drop":["ALL"],
      "security_opt":["no-new-privileges:true"],"ports":[f"127.0.0.1:{port}:8081"],
      "volumes":mounts,"tmpfs":["/tmp:rw,nosuid,nodev,size=256m"],"environment":env}}}


def docker(*args):
    result=subprocess.run(["docker","--context","desktop-linux",*args],capture_output=True,
                          encoding="utf-8",errors="replace",timeout=60)
    if result.returncode:
        raise ValueError(result.stderr[-3000:] or "Docker command failed")
    return result.stdout.strip()


def request(url, body=None, method=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(url,data=data,method=method or ("GET" if body is None else "PUT"),
                               headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=15) as response:
        return json.load(response)


def copy_web(layout, build, destination):
    storage=Path(layout["storage_root"])
    build=managed.fullmag_storage.validate_path(build,storage)
    journal=managed._json_file(build/"receipt.json","web build journal")
    context=managed._json_file(build/"trusted/context.json","web build context")
    if (journal.get("state"),journal.get("phase"),journal.get("exit_code"),journal.get("profile")) != ("succeeded","terminal",0,"fem-cpu-release"):
        raise ValueError("Frontend requires a successful managed CPU release")
    for key in ("job_id","source_digest","profile","image_digest"):
        if journal.get(key)!=context.get(key) or (key=="job_id" and build.name!=context[key]):
            raise ValueError("Frontend build provenance mismatch")
    for name,digest in journal["trusted_hashes"].items():
        path=managed.fullmag_storage.validate_path(build/"trusted"/name,build/"trusted")
        if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
            raise ValueError("Frontend trusted document changed")
    job={**context,"payload":{"native_source_identity":context["native_source_identity"]}}
    receipt=validate_build_receipt(build/"artifacts",job,journal)
    prefix="outputs/.fullmag/local/web/"
    members=[entry for entry in receipt["artifacts"] if entry["path"].startswith(prefix)]
    if not members:
        raise ValueError("No attested frontend files")
    for entry in members:
        src=managed.fullmag_storage.validate_path(build/"artifacts"/entry["path"],build/"artifacts")
        dst=managed.fullmag_storage.validate_path(destination/entry["path"][len(prefix):],destination)
        dst.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(src,dst)
        if hashlib.sha256(dst.read_bytes()).hexdigest()!=entry["sha256"]:
            raise ValueError("Frontend copy changed")
    return {"job_id":context["job_id"],"native_source_identity":context["native_source_identity"],"file_count":len(members)}


def run(args):
    storage=managed.fullmag_storage
    layout=storage.resolve_layout(args.repo_root,"windows-native")
    storage.initialize(layout)
    with managed.runtime_package_use(layout):
        return _run_protected(args, layout)


def _run_protected(args, layout):
    storage=managed.fullmag_storage
    job=managed._read_job(layout,args.job_id)
    context=managed._validate_build_context(layout,job)
    data,identity=model_input.load_model(args.repo_root,args.model_ref)
    root=storage.validate_path(Path(layout["runs_root"])/"ui-model-previews"/uuid.uuid4().hex,Path(layout["storage_root"]))
    root.mkdir(parents=True)
    state=root/"state"; state.mkdir()
    model_input.stage_model(state,data)
    frontend=copy_web(layout,args.web_build_root,state/"web")
    require_matched_frontend(context.native_identity,frontend["native_source_identity"])
    with socket.socket() as probe:
        probe.bind(("127.0.0.1",0)); port=probe.getsockname()[1]
    project="fullmag-browser-"+root.name
    spec=browser_spec(context.image_digest,context.source_tree,context.runtime_root,state,port)
    compose=root/"compose.json"; storage.atomic_json(compose,spec)
    receipt={"schema":"fullmag.de-ui-model-preview.v1","state":"starting","url":f"http://localhost:{port}/workspace",
      "runtime_job_id":args.job_id,"runtime_identity":context.native_identity,"frontend":frontend,
      "model":identity,"sampling":args.sampling,"session_storage":"volatile_tmpfs",
      "solver_started":False,"model_loaded":False,"qualification":"NOT VERIFIED","run_root":str(root)}
    save=lambda:storage.atomic_json(root/"receipt.json",receipt)
    save()
    try:
        compose_args=["compose","-f",str(compose),"--project-name",project]
        docker(*compose_args,"up","--detach","--no-build","--pull","never")
        container=docker(*compose_args,"ps","--all","--quiet","browser")
        receipt["container_id"]=container
        observed=json.loads(docker("inspect",container))[0]
        if observed["Image"]!=context.image_digest:
            raise ValueError("Runtime image mismatch")
        actual={(m["Destination"],m["RW"]) for m in observed["Mounts"] if m["Type"]=="bind" and m["Destination"] not in {"/etc/hosts","/etc/hostname","/etc/resolv.conf"}}
        if actual!={("/source",False),("/package",False),("/state",True)}:
            raise ValueError("Runtime mount mismatch")
        for _ in range(30):
            try:
                request(f"http://127.0.0.1:{port}/healthz"); break
            except OSError: time.sleep(1)
        else: raise ValueError("API startup timeout")
        env={"FULLMAG_DE_SMOKE_SAMPLING":"k10" if args.sampling == "signed-pair" else args.sampling,"FULLMAG_DE_SMOKE_MESH_LEVEL":"L2",
             "FULLMAG_DE_SMOKE_THICKNESS_LAYERS":"3","FULLMAG_DE_SMOKE_MODAL_TARGET":"nearest",
             "FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ":"11"}
        extra=[item for key,value in env.items() for item in ("-e",key+"="+value)]
        scene=json.loads(docker("exec",*extra,container,"python3","-m","fullmag.runtime.helper",
                               "export-scene-document","--script","/state/model-input.py"))
        if args.sampling == "signed-pair":
            negative_extra=[item for key,value in {**env,"FULLMAG_DE_SMOKE_SAMPLING":"k-10"}.items()
                            for item in ("-e",key+"="+value)]
            negative=json.loads(docker("exec",*negative_extra,container,"python3","-m","fullmag.runtime.helper",
                                       "export-scene-document","--script","/state/model-input.py"))
            scene=signed_pair_scene(scene,negative)
        storage.atomic_json(root/"expected-scene.json",scene)
        endpoint=f"http://127.0.0.1:{port}/v2/sessions/current/model/scene"
        request(f"http://127.0.0.1:{port}/v2/sessions",
                {"name":"DE priority "+args.sampling,"backend":"fem","device":"cpu",
                 "precision":"double","replace_current":False}, method="POST")
        session = request(f"http://127.0.0.1:{port}/v2/sessions/current/status")["session"]
        if not session.get("request_scope_epoch"):
            raise ValueError("API lacks the session identity required by the frontend")
        scene["revision"]=request(endpoint)["revision"]
        storage.atomic_json(root/"expected-scene.json",scene)
        request(endpoint,scene)
        loaded=request(endpoint)
        verify_loaded_scene(scene,loaded)
        storage.atomic_json(root/"loaded-scene.json",loaded)
        model_input.verify_model(state,identity)
        receipt.update(state="model_loaded",model_loaded=True,object_count=len(loaded["objects"]),
                       scene_revision=loaded.get("revision"))
    except Exception as error:
        receipt.update(state="failed_resources_retained",error=str(error)); raise
    finally:
        save(); print(json.dumps(receipt,indent=2))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root",type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument("--job-id",required=True)
    parser.add_argument("--web-build-root",type=Path,required=True)
    parser.add_argument("--model-ref",required=True)
    parser.add_argument("--sampling",choices=("k10","k-10","signed-pair"),default="signed-pair")
    run(parser.parse_args())
