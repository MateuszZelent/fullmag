"""Managed, explicitly pinned invocation of native preclaim cancellation; no lifecycle."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

def validate_options(args):
    for name, pattern in (("backend_container_id", r"[0-9a-f]{64}"),
                          ("image_id", r"sha256:[0-9a-f]{64}"),
                          ("request_sha256", r"[0-9a-f]{64}"),
                          ("candidate_receipt_sha256", r"[0-9a-f]{64}")):
        if re.fullmatch(pattern, getattr(args,name,"")) is None:
            raise ValueError("Full immutable pin required: "+name)
    if args.candidate_basename != "published" and re.fullmatch(r"\.backend-package-candidate-[A-Za-z0-9._-]+",args.candidate_basename) is None:
        raise ValueError("Exact managed candidate basename required")
    if not args.request.startswith("verification/") or ".." in Path(args.request).parts:
        raise ValueError("Request must be a relative control verification artifact")

INSIDE = r"""
import hashlib,json,os,subprocess,sys
from pathlib import Path
sys.path.insert(0,"/opt/fullmag")
import backend_dev as backend
import runtime_service as runtime
x=json.loads(sys.argv[1])
with backend._runtime_build_lock(Path("/build")):
 if os.environ.get("FULLMAG_COMPOSE_PROJECT")!=x["compose_project"]:
     raise RuntimeError("Compose identity changed")
 if x["candidate_basename"]=="published":
    candidate=backend.PACKAGE_ROOT
    backend._assert_no_links(candidate,"published recovery package")
    receipt,raw,_=backend._validated_package(candidate,"published preclaim recovery package",exclude_development_control=True)
    provenance=backend._snapshot_bound_provenance()
    if provenance is None:
        raise RuntimeError("Published package has no bound provenance")
    bound=json.loads(provenance)
    if bound.get("build_receipt_sha256")!=x["candidate_receipt_sha256"] or bound.get("package_root")!=str(candidate):
        raise RuntimeError("Published package provenance differs from pinned receipt")
 else:
    candidate=backend.PACKAGE_ROOT/".development"/backend.PACKAGE_CANDIDATES_DIRNAME/x["candidate_basename"]
    backend._assert_no_links(candidate,"recovery candidate")
    marker=backend._validate_candidate_marker(candidate,backend.PACKAGE_ROOT,Path("/build"),state="ready")
    if marker["artifact_inventory_sha256"]!=backend._sha256_bytes(backend._canonical(backend._hash_package(candidate))):
        raise RuntimeError("Ready marker differs from the candidate artifact inventory")
    receipt,raw,_=backend._validated_package(candidate,"preclaim recovery candidate",exclude_candidate_marker=True)
 if hashlib.sha256(raw).hexdigest()!=x["candidate_receipt_sha256"]:
     raise RuntimeError("Candidate receipt changed")
 request=Path(x["request_path"])
 data,_=backend._read_regular(request,"preclaim operator request",16*1024*1024)
 if hashlib.sha256(data).hexdigest()!=x["request_sha256"]:
     raise RuntimeError("Operator request changed")
 command=[str(candidate/"bin/fullmag-runtime-service"),"--cancel-failed-preclaim",
          "--config",str(runtime.canonical_paths().config),"--request",str(request),
          "--request-sha256",x["request_sha256"]]
 if not x["apply"]:command.append("--verify-only")
 result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)
 sys.stdout.buffer.write(result.stdout)
 sys.stderr.buffer.write(result.stderr)
 raise SystemExit(result.returncode)
"""

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("source-root","backend-container-id","image-id","candidate-basename",
                 "candidate-receipt-sha256","request","request-sha256"):
        parser.add_argument("--"+name,required=True)
    parser.add_argument("--apply",action="store_true")
    args=parser.parse_args()
    validate_options(args)
    from docker_dev import _select_source,_compose_identity
    from docker_build_control import BuildControl,BuildControlError,docker_capture
    from docker_dev_recovery_build import inspect_one,validate_backend,backend_control_path
    from docker_volume_reconcile import fingerprint
    selected,layout=_select_source(Path(args.source_root),args.source_root)
    identity=_compose_identity(layout)
    control=BuildControl(identity,args.image_id)
    actual=inspect_one("container",args.backend_container_id)
    validate_backend(actual,identity,args.backend_container_id,args.image_id)
    inputs=vars(args)|{"compose_project":control.project,"source_root":str(selected),
                      "container_fingerprint":fingerprint(actual),
                      "controller_sha256":hashlib.sha256(INSIDE.encode()).hexdigest()}
    # An unknown apply retains the managed operation lease; never retry automatically.
    with control.operation("preclaim-cancellation",inputs) as operation:
        if fingerprint(inspect_one("container",args.backend_container_id))!=inputs["container_fingerprint"]:
            raise BuildControlError("Backend incarnation changed")
        payload=inputs|{"request_path":backend_control_path(control.path(args.request))}
        operation["daemon_pending"]=True
        result=docker_capture("exec",args.backend_container_id,"/usr/local/bin/python3","-B",
                              "-c",INSIDE,json.dumps(payload),allow_failure=True)
        control.write_bytes(operation["root"]+"/stdout.log",result.stdout)
        control.write_bytes(operation["root"]+"/stderr.log",result.stderr)
        if result.returncode:
            if not args.apply:
                operation["daemon_pending"]=False
                operation["receipt"]["state"]="failed-confirmed"
            raise BuildControlError("Native preclaim recovery refused; inspect retained evidence")
        response=json.loads(result.stdout)
        if response.get("request_sha256")!=args.request_sha256 or response.get("state")!=("cancelled" if args.apply else "verified"):
            raise BuildControlError("Native completion does not match operator request")
        operation["daemon_pending"]=False
        operation["receipt"].update(state="succeeded",result=response)
        print(json.dumps(response))

if __name__=="__main__":
    main()
