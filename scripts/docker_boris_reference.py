"""Optional BORIS CPU producer in the existing backend; no benchmark admission."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

BUILD = Path("/build")
CONTROL = Path("/opt/fullmag/control/verification/boris-volume-reference")
PACKAGE = Path("/opt/fullmag/package")
SOURCE = Path("/opt/fullmag/source")
EXPECTED_TREE = "0d0d924321c6b0d664f3e862a7a73d7c31a1c4c14d2a7f973b6238e2a58161a6"
EXPECTED_MANIFEST = "ec08ad80f8225df2d6d0f44ac51ed5685357f0a57b2bb749f5a4e39260c29ac3"
SHA = re.compile(r"[0-9a-f]{64}")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")


def require(ok,message):
    if not ok:raise ValueError("BORIS volume producer: "+message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stage_runner(deadline,maximum_log_bytes,receipt):
    # Same pre-write slicing as the control executor, with local file sinks and
    # an owned POSIX process group instead of a Docker-client outcome.
    require(type(maximum_log_bytes) is int and 0<maximum_log_bytes<=64*1024*1024,"invalid shared log limit")
    used=0;probe_ordinal=0
    def run_stage(name,command,*,workspace,artifacts,environment,timeout=None):
        nonlocal used
        require(time.monotonic()<deadline,"build deadline exhausted before stage")
        require(re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,63}",name),"invalid fixed stage name")
        logs=artifacts/"logs";logs.mkdir(exist_ok=True)
        out,err=logs/(name+".stdout.log"),logs/(name+".stderr.log")
        started=time.monotonic();process=None;failure=None
        stage_deadline=min(deadline,started+timeout) if timeout is not None else deadline
        counts={"stdout":0,"stderr":0};tails={"stdout":b"","stderr":b""}
        record=dict(name=name,command=list(command),stdout_log=out.relative_to(artifacts).as_posix(),
                    stderr_log=err.relative_to(artifacts).as_posix())
        try:
            with out.open("xb") as stdout,err.open("xb") as stderr,selectors.DefaultSelector() as selector:
                process=subprocess.Popen(command,cwd=workspace,env=environment,stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0)
                for stream,key,sink in ((process.stdout,"stdout",stdout),(process.stderr,"stderr",stderr)):
                    os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ,(key,sink))
                while selector.get_map() or os.waitid(os.P_PID,process.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
                    remaining_time=stage_deadline-time.monotonic()
                    if remaining_time<=0:raise ValueError("BORIS volume producer build deadline exceeded")
                    for ready,_ in selector.select(min(.05,remaining_time)):
                        if time.monotonic()>=stage_deadline:raise ValueError("BORIS volume producer build deadline exceeded")
                        try:chunk=os.read(ready.fd,65536)
                        except BlockingIOError:continue
                        if not chunk:
                            selector.unregister(ready.fileobj);continue
                        key,sink=ready.data;tails[key]=(tails[key]+chunk)[-4096:]
                        remaining=maximum_log_bytes-used
                        accepted=chunk[:remaining]
                        # No child holds the file descriptors; only this bounded writer can append.
                        sink.write(accepted);used+=len(accepted);counts[key]+=len(accepted)
                        if len(chunk)>remaining:raise ValueError("BORIS volume producer shared log bound exceeded")
            return record
        except BaseException as error:
            failure=type(error).__name__+": "+str(error)
            raise
        finally:
            cleanup_errors=[];reaped=False
            if process is not None:
                # WNOWAIT reserves the leader PID until its own group is killed and reaped.
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                except BaseException as error:cleanup_errors.append("killpg: "+repr(error))
                try:process.wait(timeout=5);reaped=True
                except BaseException as error:cleanup_errors.append("wait: "+repr(error))
                finally:
                    for stream in (process.stdout,process.stderr):
                        if stream is not None:
                            try:stream.close()
                            except BaseException as error:cleanup_errors.append("pipe close: "+repr(error))
            record.update(pid=process.pid if process is not None else None,
                          process_returncode=process.returncode if process is not None else None,
                          exit_code=process.returncode if process is not None else None,child_reaped=reaped,
                          duration_ms=1000*(time.monotonic()-started),log_bytes=counts,
                          total_build_log_bytes=used,maximum_build_log_bytes=maximum_log_bytes,
                          tail_hex={key:value.hex() for key,value in tails.items()},tail_limit_bytes_per_stream=4096)
            if cleanup_errors:record["cleanup_errors"]=cleanup_errors
            if failure is not None or cleanup_errors:
                record["failure"]=failure or "BORIS volume producer cleanup failed"
                receipt["stages"].append(record)
                if failure is None:raise ValueError(record["failure"]+": "+"; ".join(cleanup_errors))
    def run_probe(command,*,workspace,artifacts,environment,timeout=30,text=False,check=True):
        nonlocal probe_ordinal
        name=f"boris-cpu-probe-{probe_ordinal:05d}";probe_ordinal+=1
        record=run_stage(name,command,workspace=workspace,artifacts=artifacts,environment=environment,timeout=timeout)
        receipt["stages"].append(record)
        stdout=(artifacts/record["stdout_log"]).read_bytes();stderr=(artifacts/record["stderr_log"]).read_bytes()
        if text:stdout=stdout.decode();stderr=stderr.decode()
        result=subprocess.CompletedProcess(command,record["exit_code"],stdout,stderr)
        if check:result.check_returncode()
        return result
    return run_stage,run_probe


def validate_admission(value,environment,hostname):
    keys={"schema","compose_project","container_id","container_hostname","image_id","toolchain_image_id",
          "source_host_root","package_receipt_sha256","producer_sha256","maximum_build_seconds",
          "mount_attestation_sha256","attempt_id","prefix_root","payload_image_id","supplier_sha256","controller_sha256","module_manifest_sha256"}
    require(isinstance(value,dict) and set(value)==keys,"closed admission fields differ")
    require(value["schema"]=="fullmag.boris.volume-producer-admission.v2","admission schema differs")
    require(re.fullmatch(r"fullmag-(master|worktree-[a-z0-9_.-]+)",value["compose_project"]),"invalid group")
    require(SHA.fullmatch(value["container_id"]) and hostname==value["container_hostname"],"backend identity differs")
    require(environment.get("FULLMAG_DOCKER_ROLE")=="backend" and
            environment.get("FULLMAG_COMPOSE_PROJECT")==value["compose_project"] and
            environment.get("FULLMAG_SOURCE_HOST_ROOT")==value["source_host_root"] and
            environment.get("FULLMAG_TOOLCHAIN_IMAGE_ID")==value["toolchain_image_id"],"existing backend namespace differs")
    for key in ("image_id","toolchain_image_id"):require(IMAGE.fullmatch(value[key]),"image must be immutable")
    for key in ("package_receipt_sha256","producer_sha256","mount_attestation_sha256","controller_sha256","module_manifest_sha256"):
        require(SHA.fullmatch(value[key]),"missing immutable owner pin")
    require(type(value["maximum_build_seconds"]) is int and 0<value["maximum_build_seconds"]<=28800,
            "explicit bounded build duration required")
    require(re.fullmatch(r"[0-9a-f]{32}",value["attempt_id"]),"invalid attempt")
    require(value["prefix_root"]==str(BUILD/"external-reference-boris"/value["attempt_id"]/"prefix"),"prefix escapes admitted build attempt")
    require(value["payload_image_id"]=="sha256:545279e00703d60dcaf33d455461ba90e0dea7ec5647e96392bbc9246c21b6a6" and SHA.fullmatch(value["supplier_sha256"]),"payload/supplier identity differs")
    # Actual image/mount/container IDs are checked by the future group controller, not inferred in this worker.
    return value


def produce(admission,admission_raw,backend,boris,common,supplier):
    require(os.name=="posix","existing Linux backend required")
    validate_admission(admission,os.environ,os.uname().nodename)
    require(sha(Path(__file__).read_bytes())==admission["producer_sha256"],"producer changed")
    require(sha(Path(supplier.__file__).read_bytes())==admission["supplier_sha256"],"supplier changed")
    require(sys.version.split()[0]=="3.10.12" and os.environ.get("PYTHONDONTWRITEBYTECODE")=="1","pinned Python/write policy differs")
    helper_files=[Path(boris.__file__),Path(common.__file__),Path(backend.__file__),Path(supplier.__file__),Path(__file__)]
    helper_pins={str(p):boris.digest(p) for p in helper_files}
    cases={key:common.case_descriptor(key) for key in common.CASE_KEYS}
    attempt=admission["attempt_id"];root=BUILD/"external-reference-boris"/attempt;prefix=Path(admission["prefix_root"])
    with backend._runtime_build_lock(BUILD):
        backend._assert_no_links(root,"BORIS build attempt")
        require(root.is_dir() and set(p.name for p in root.iterdir())=={"prefix"},"attempt is not fresh copied payload")
        package,package_raw,_=backend._validated_package(PACKAGE,"current Fullmag package",exclude_development_control=True)
        require(sha(package_raw)==admission["package_receipt_sha256"],"Fullmag package changed")
        provenance,provenance_raw=backend._read_json(backend.PROVENANCE_PATH,"current runtime provenance")
        require(provenance.get("build_receipt_sha256")==sha(package_raw),"runtime/package receipt differ")
        artifacts=root/"artifacts";artifacts.mkdir();workspace=root/"workspace";workspace.mkdir()
        receipt=dict(schema="fullmag.boris.volume-build-receipt.v2",state="building",attempt_id=attempt,job_id=attempt,
            job_id_scope="local volume attempt; NOT queued runner job",image_digest=admission["image_id"],
            admission=admission,admission_sha256=sha(admission_raw),stages=[],qualification="NOT VERIFIED",
            physics_qualified=False,benchmark_executed=False)
        previous_environment={key:os.environ.get(key) for key in ("HOME","TMPDIR","MPLCONFIGDIR")}
        for key,child in (("HOME","home"),("TMPDIR","tmp"),("MPLCONFIGDIR","matplotlib")):
            directory=root/child;directory.mkdir();os.environ[key]=str(directory)
        try:
            run_stage,run_probe=stage_runner(time.monotonic()+admission["maximum_build_seconds"],backend.MAX_BUILD_LOG_BYTES,receipt)
            dependency=supplier.prepare_prefix(prefix,run_probe,artifacts=artifacts,environment=dict(os.environ))
            dependency_raw=(prefix/"receipt.json").read_bytes()
            original=boris.verify_source(prefix/"source",boris.load_manifest(prefix/"source_manifest.json"))
            require(original["source_tree_sha256"]==EXPECTED_TREE and sha(boris.canonical(original))==EXPECTED_MANIFEST,"pinned BORIS source differs")
            binding=dict(schema="fullmag.boris.volume-producer-inputs.v2",admission=admission,
                admission_sha256=sha(admission_raw),source_manifest_sha256=sha(boris.canonical(original)),
                tool_sha256=helper_pins,common_cases=cases,fullmag_package_sha256=sha(package_raw),
                runtime_provenance_sha256=sha(provenance_raw),dependency_receipt_sha256=sha(dependency_raw))
            receipt.update(binding=binding,source_digest=sha(boris.canonical(binding)),source_digest_kind="volume-producer-inputs.v2")
            boris.run_build(workspace,artifacts,receipt,run_stage,run_probe=run_probe,reference_root=prefix)
            boris.validate_outputs(artifacts,receipt)
            require({str(p):boris.digest(p) for p in helper_files}==helper_pins,"producer/helper changed")
            boris.verify_source(prefix/"source",original)
            require((prefix/"receipt.json").read_bytes()==dependency_raw,"dependency receipt changed")
            require([r for r in supplier.inventory(prefix) if r["path"]!="receipt.json"]==dependency["files"],"prefix content changed")
            _,again,_=backend._validated_package(PACKAGE,"current Fullmag package",exclude_development_control=True)
            _,again_provenance=backend._read_json(backend.PROVENANCE_PATH,"current runtime provenance")
            require(again==package_raw and again_provenance==provenance_raw,"Fullmag package/provenance changed")
            receipt["outputs"]={n:boris.digest(artifacts/"outputs/boris"/n) for n in boris.OUTPUTS}
            receipt["state"]="native_build_and_abi_verified_not_benchmark"
        except BaseException as error:
            receipt.update(state="failed_resources_retained",error=type(error).__name__+": "+str(error))
            raise
        finally:
            for key,value in previous_environment.items():
                if value is None:os.environ.pop(key,None)
                else:os.environ[key]=value
            backend._write_json(root/"build-receipt.json",receipt,"BORIS volume producer receipt")
            backend._assert_no_links(CONTROL,"BORIS control root");CONTROL.mkdir(parents=True,exist_ok=True)
            backend._write_json(CONTROL/(attempt+".json"),dict(schema="fullmag.boris.volume-build-pointer.v2",
                compose_project=admission["compose_project"],state=receipt["state"],build_root=str(root),
                build_receipt_sha256=boris.digest(root/"build-receipt.json"),benchmark_executed=False,
                physics_qualified=False),"BORIS volume receipt pointer")
        return root/"build-receipt.json"


# Invoked only by the group-owned fixed wrapper after full host admission.
