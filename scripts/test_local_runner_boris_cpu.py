"""Interpreted BORIS build route guards; no compiler, Docker or provisioning."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from local_runner import boris_cpu as b, build_entrypoint as entry, build_executor as executor, container_client as client

class BorisCpuRouteTests(unittest.TestCase):
    def test_existing_profiles_and_default_admission_unchanged(self):
        self.assertEqual(tuple(client.ALLOWED_PROFILES), ("fem-cpu-release","fem-gpu-release","fdm-cpu-release"))
        self.assertEqual(len(client.SLEPC_MODAL_PROFILES),6)
        self.assertNotIn(b.PROFILE,client.SLEPC_MODAL_PROFILES)
        self.assertEqual(executor.profile_lane(b.PROFILE),("external-reference","cpu"))
        self.assertEqual(entry.required_outputs_for_profile(b.PROFILE),b.OUTPUTS)
        with self.assertRaises(ValueError):executor.dependency_cache_paths(Path("x"),b.PROFILE)
        self.assertEqual(entry.required_outputs_for_profile("fem-cpu-release"),entry.REQUIRED_OUTPUTS)
        self.assertEqual(entry.required_outputs_for_profile("fem-cpu-current-contracts-v1"),entry.BASE_REQUIRED_OUTPUTS)

    def test_opt_in_coexists_with_modal_and_preserves_secret_pair(self):
        with tempfile.TemporaryDirectory() as temp:
            layout={"storage_root":str(Path(temp).resolve())}
            image="sha256:"+"a"*64
            with patch.object(client.coordinator,"docker",side_effect=AssertionError("no Docker")):
                first=client.configure(layout,image_id=image,owner="alice",enable_slepc_modal=True)
                self.assertNotIn(b.PROFILE,first["allowed_profiles"])
                enabled=client.configure(layout,image_id=image,owner="alice",enable_boris_cpu=True)
                self.assertEqual(enabled["allowed_profiles"],list(client.CATALOG_PROFILES))
                preserved=client.configure(layout,image_id=image,owner="alice",enable_current_contracts=True)
                self.assertIn(b.PROFILE,preserved["allowed_profiles"])
            secret=json.loads((Path(temp)/"index/local-runner-container-secret.json").read_text())
            self.assertEqual(secret["allowed_profiles"],preserved["allowed_profiles"])

    def test_missing_activation_fails_before_capsule_read(self):
        from local_runner.container_main import Application
        app=Application.__new__(Application)
        app._assert_submission_ready=lambda:None
        with self.assertRaisesRegex(ValueError,"operator activation"):
            app.submit(dict(worktree_id="wt",source_digest="a"*64,profile=b.PROFILE,
                            operation="build",request_key="test",payload={}))

    def test_exact_overlay_rejects_drift(self):
        cpu=b"#define COMPILECUDA\t1\n#define GRAPHICS 0\n#define PYTHON_EMBEDDING 1\n"
        fixed=b.overlay_flags(cpu,"COMPILECUDA",1,0)
        self.assertIn(b"#define COMPILECUDA 0",fixed)
        for value in (b"#define COMPILECUDA 2\n",b"#define COMPILECUDA 1\n#define COMPILECUDA 1\n"):
            with self.assertRaises(ValueError):b.overlay_flags(value,"COMPILECUDA",1,0)

    def test_fixed_cpp_commands_no_cuda_no_host_build(self):
        command=b.compile_commands(["Boris/Transport.cpp"],compiler="/usr/bin/g++",includes=["-I/usr/include/python3.10"],objects=Path("/workspace/objects"))[0]
        self.assertEqual(command[0],"/usr/bin/g++")
        self.assertIn("-std=c++17",command)
        self.assertFalse(any(b.cuda_toolchain_argument(part) for part in command))
        for bad in ("nvcc","-lcudart","-lnvidia-ml","-I/usr/local/cuda/include"):
            self.assertTrue(b.cuda_toolchain_argument(bad))
        with self.assertRaises(ValueError):b.compile_commands(["../../escape.cpp"],compiler="g++",includes=[],objects=Path("x"))

    def test_source_pin_membership_hash_and_bounds(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/"Boris").mkdir();path=root/"Boris/test.cpp";path.write_bytes(b"test")
            files=[dict(path="Boris/test.cpp",size=4,sha256=hashlib.sha256(b"test").hexdigest(),mode="100644")]
            manifest=dict(schema_version="fullmag.boris.image_source.v1",upstream_commit=b.PIN,files=files,source_tree_sha256=hashlib.sha256(b.canonical(files)).hexdigest())
            self.assertEqual(b.verify_source(root,manifest),manifest)
            with self.assertRaises(ValueError):b.verify_source(root,{**manifest,"upstream_commit":"0"*40})
            path.write_bytes(b"bad")
            with self.assertRaises(ValueError):b.verify_source(root,manifest)
            path.write_bytes(b"test");(root/"unexpected").write_bytes(b"x")
            with self.assertRaises(ValueError):b.verify_source(root,manifest)

    def test_missing_image_source_fails_before_toolchain_or_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with patch.object(b,"SOURCE_MANIFEST",root/"missing"),patch.object(b.subprocess,"run",side_effect=AssertionError("no compiler")):
                with self.assertRaises(ValueError):b.run_build(root,root,{},lambda *a,**k:None)

    def test_fabricated_receipt_missing_members_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):b.validate_outputs(Path(temp),{"profile":b.PROFILE})

class BorisCpuAbiTests(unittest.TestCase):
    # Pure verifier fixture, never compilation or a qualified runtime identity.
    def fixture(self, temp):
        artifacts=Path(temp);root=artifacts/"outputs/boris";root.mkdir(parents=True)
        logs=artifacts/"logs";logs.mkdir()
        (logs/"boris-cpu-abi-observe.stdout.log").write_bytes(b.canonical(b.ABI_FACTS))
        receipt=dict(job_id="a"*32,source_digest="b"*64,image_digest="sha256:"+"c"*64,stages=[])
        proof=dict(compile_flags_sha256="d"*64,cuda_flags_sha256="e"*64,
                   original_source={"files":[dict(path=name,sha256=value) for name,value in b.TYPE_SOURCE_SHA256.items()]})
        (root/"cpu_abi_witness.cpp").write_bytes(b.ABI_SOURCE)
        (root/"cpu_abi_witness").write_bytes(b"synthetic ABI binary; not executable proof")
        (root/"cpu_abi_witness.json").write_bytes(b.canonical(b.abi_binding(receipt,"d"*64,"e"*64,b.ABI_FACTS)))
        proof["cpu_abi_sha256"]={name:b.digest(root/name) for name in b.OUTPUTS if name.startswith("cpu_abi_")}
        prefix=["g++","-c","-Ofast","-std=c++17","-IBorisLib","-IBorisCUDALib","-fopenmp","-Ipython"]
        commands={"boris-cpu-compile-00000":[*prefix,"Boris/Transport.cpp","-o","/workspace/0.o"],
                  "boris-cpu-abi-compile":[*prefix,"Boris/FullmagCpuAbiWitness.cpp","-o","/workspace/abi.o"],
                  "boris-cpu-link":["g++","/workspace/0.o","-fopenmp","-lpython","-ltbb","-lfftw3","-lX11","-o","/workspace/BorisLin"],
                  "boris-cpu-abi-link":["g++","/workspace/abi.o","-fopenmp","-lpython","-ltbb","-lfftw3","-lX11","-o","/workspace/witness"],
                  "boris-cpu-abi-observe":["/workspace/witness"]}
        receipt["stages"]=[dict(name=name,command=command,exit_code=0) for name,command in commands.items()]
        return root,artifacts,receipt,proof,["Boris/Transport.cpp"]

    def test_fixed_source_inspects_actual_transport_types(self):
        for field in ("V[0]", "E[0].x", "S[0].x"):
            self.assertIn(field.encode(),b.ABI_SOURCE)
        self.assertIn(b'#include "MeshBase.h"',b.ABI_SOURCE)
        self.assertNotIn(b"identity_complete",b.ABI_SOURCE)
        self.assertIn("boris-cpu-abi-observe",b.REQUIRED_STAGES)

    def test_observation_rejects_precision_bool_duplicate_and_bounds(self):
        self.assertEqual(b.abi_observation(b.canonical(b.ABI_FACTS)),b.ABI_FACTS)
        for raw in (b.canonical({**b.ABI_FACTS,"double_bytes":4}),
                    b.canonical({**b.ABI_FACTS,"char_bit":True}),
                    b'{"char_bit":8,"char_bit":8}',b"x"*4097,b"[]",b"{}"):
            with self.subTest(raw=raw[:90]),self.assertRaises(ValueError):b.abi_observation(raw)

    def test_pure_fixture_checks_exact_owner_source_and_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            args=self.fixture(temp)
            b.validate_abi_outputs(*args)
            self.assertNotIn("identity_complete",args[2])

    def test_foreign_owner_and_flags_refused(self):
        for key in ("job_id","source_digest","image_digest"):
            with self.subTest(key=key),tempfile.TemporaryDirectory() as temp:
                args=self.fixture(temp);args[2][key]="foreign"
                with self.assertRaisesRegex(ValueError,"owner/flags"):b.validate_abi_outputs(*args)
        with tempfile.TemporaryDirectory() as temp:
            args=self.fixture(temp);args[3]["compile_flags_sha256"]="f"*64
            with self.assertRaisesRegex(ValueError,"owner/flags"):b.validate_abi_outputs(*args)

    def test_stage_missing_duplicate_failed_compiler_linker_and_run_refused(self):
        for case in ("missing","duplicate","failed","compiler","flags","linker","run"):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temp:
                args=self.fixture(temp);stages=args[2]["stages"]
                abi=next(x for x in stages if x["name"]=="boris-cpu-abi-compile")
                if case=="missing":stages.remove(abi)
                elif case=="duplicate":stages.append(dict(abi))
                elif case=="failed":abi["exit_code"]=1
                elif case=="compiler":abi["command"][0]="foreign-g++"
                elif case=="flags":abi["command"].insert(1,"-DSINGLEPRECISION=1")
                elif case=="linker":next(x for x in stages if x["name"]=="boris-cpu-abi-link")["command"].insert(2,"-lforeign")
                else:next(x for x in stages if x["name"]=="boris-cpu-abi-observe")["command"]=["/foreign/witness"]
                with self.assertRaises(ValueError):b.validate_abi_outputs(*args)

    def test_tampered_binary_source_typepin_or_oversized_log_refused(self):
        for case in ("binary","source","typepin","log"):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temp:
                args=self.fixture(temp)
                if case=="binary":(args[0]/"cpu_abi_witness").write_bytes(b"tamper")
                elif case=="source":
                    (args[0]/"cpu_abi_witness.cpp").write_bytes(b"tamper")
                    args[3]["cpu_abi_sha256"]["cpu_abi_witness.cpp"]=b.digest(args[0]/"cpu_abi_witness.cpp")
                elif case=="typepin":args[3]["original_source"]["files"][0]["sha256"]="f"*64
                else:(args[1]/"logs/boris-cpu-abi-observe.stdout.log").write_bytes(b"x"*4097)
                with self.assertRaises(ValueError):b.validate_abi_outputs(*args)

class BorisSourceImageTests(unittest.TestCase):
    def fixture(self, root):
        source = root/"source"; (source/"Boris").mkdir(parents=True)
        (source/"Boris/example.cpp").write_bytes(b"source")
        entries = [dict(path="Boris/example.cpp", size=6, mode="100644", sha256=b.digest(source/"Boris/example.cpp"))]
        manifest = dict(schema_version="fullmag.boris.image_source.v1", upstream_commit=b.PIN, files=entries,
                        source_tree_sha256=hashlib.sha256(b.canonical(entries)).hexdigest())
        (root/"source_manifest.json").write_bytes(b.canonical(manifest))
        image = "sha256:"+"a"*64
        context = dict(example="frozen toolchain")
        (root/"toolchain_context.json").write_bytes(b.canonical(context))
        proof = dict(qualification="TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED", gxx="g++", readelf="readelf", linker_paths={"libtbb.so":"/lib/tbb"}, context_sha256=b.digest(root/"toolchain_context.json"))
        (root/"toolchain_proof.json").write_bytes(b.canonical(proof))
        (root/"toolchain_container.json").write_bytes(b.canonical(dict(Image=image, State=dict(ExitCode=0))))
        (root/"toolchain_inspect.json").write_bytes(b.canonical(dict(Id=image)))
        (root/"boris_cpu.py").write_bytes(Path(b.__file__).read_bytes())
        (root/"Dockerfile").write_bytes(Path(b.__file__).with_name("Dockerfile.boris-cpu").read_bytes())
        files = [dict(path=p.relative_to(root).as_posix(), size=p.stat().st_size, sha256=b.digest(p)) for p in root.rglob("*") if p.is_file()]
        files.sort(key=lambda e:e["path"])
        value = dict(schema="fullmag.boris.source-context.v1", upstream_commit=b.PIN, toolchain_image=image,
                     worktree_id="test", producer_sha256=b.digest(Path(b.__file__)), files=files, source_tree_sha256=manifest["source_tree_sha256"])
        (root/"source_context.json").write_bytes(b.canonical(value))
        return value

    def test_clean_git_filter_preserves_crlf_bytes(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            subprocess.run(["git", "init", str(root)], check=True, capture_output=True)
            (root/".gitattributes").write_bytes(b"*.cpp text eol=crlf\n")
            raw=b"line one\r\nline two\r\n"; (root/"example.cpp").write_bytes(raw)
            ids=b.clean_blob_ids(root,["example.cpp"])
            canonical=b"line one\nline two\n"
            self.assertEqual(ids["example.cpp"],hashlib.sha1(b"blob "+str(len(canonical)).encode()+b"\0"+canonical).hexdigest())
            self.assertEqual((root/"example.cpp").read_bytes(),raw)
            self.assertNotEqual(ids["example.cpp"],hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest())

    def test_frozen_context_rejects_tamper_unlisted_duplicate_escape(self):
        for case in ("valid", "tamper", "unlisted", "duplicate", "escape"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root=Path(temp); value=self.fixture(root)
                if case=="valid":
                    self.assertEqual(b.validate_context(root),value)
                    continue
                if case=="tamper":(root/"source/Boris/example.cpp").write_bytes(b"changed")
                elif case=="unlisted":(root/"unexpected").write_bytes(b"new")
                elif case=="duplicate":
                    value["files"].append(value["files"][0]);(root/"source_context.json").write_bytes(b.canonical(value))
                else:
                    value["files"][0]["path"]="../escape";(root/"source_context.json").write_bytes(b.canonical(value))
                with self.assertRaises(ValueError):b.validate_context(root)

    def test_source_dockerfile_is_offline_and_has_no_compilation(self):
        text=Path(b.__file__).with_name("Dockerfile.boris-cpu").read_text()
        self.assertIn("RUN --network=none python3 -B",text)
        self.assertIn("USER 65532:65532",text)
        for forbidden in ("g++", "apt-get", "pip install", "cargo", "cmake"):
            self.assertNotIn(forbidden,text)

    def test_build_alias_offline_and_layer_prefix_admission(self):
        import fullmag_storage as storage
        import contextlib, types
        for foreign_layers in (False,True):
            with self.subTest(foreign_layers=foreign_layers), tempfile.TemporaryDirectory() as temp:
                root=Path(temp);context=root/"tmp/boris-cpu-image-test";context.mkdir(parents=True)
                value=self.fixture(context); image=value["toolchain_image"]; built="sha256:"+"b"*64
                layout=dict(storage_root=str(root),build_root=str(root/"builds"),worktree_id="test")
                base=dict(Id=image,RootFS=dict(Layers=["layer-a"]),Config=dict(User="65532:65532"))
                (context/"toolchain_inspect.json").write_bytes(b.canonical(base))
                actual=dict(Id=built,RootFS=dict(Layers=["foreign" if foreign_layers else "layer-a","layer-b"]),Config=dict(User="65532:65532"))
                commands=[]
                def run(command,**kwargs):
                    commands.append(command)
                    if "build" in command:
                        self.assertIn("--pull=false",command)
                        self.assertEqual(command[command.index("--network")+1],"none")
                        self.assertTrue(command[command.index("--build-arg")+1].startswith("TOOLCHAIN_IMAGE=fullmag/boris-cpu-base:"))
                        Path(command[command.index("--iidfile")+1]).write_text(built)
                    return types.SimpleNamespace(returncode=0)
                with patch.object(storage,"resolve_layout",return_value=layout),patch.object(storage,"validate_path",side_effect=lambda p,*a:Path(p)),patch.object(storage,"file_lock",return_value=contextlib.nullcontext()),patch.object(b,"validate_context",return_value=value),patch.object(b,"image_inspect",side_effect=[base,actual]),patch.object(b.subprocess,"check_output",return_value=json.dumps([dict(Id=image)]).encode()),patch.object(b.subprocess,"run",side_effect=run):
                    if foreign_layers:
                        with self.assertRaisesRegex(ValueError,"layers"):
                            b.build_image(root,context,"fullmag/boris-cpu:test")
                    else:b.build_image(root,context,"fullmag/boris-cpu:test")
                receipt=json.loads(next((root/"builds").glob("*/terminal-receipt.json")).read_text())
                self.assertEqual(receipt["status"],"FAILED" if foreign_layers else "SUCCEEDED_SOURCE_IMAGE_ONLY")
                self.assertFalse(receipt["native_compilation_executed"])
                self.assertEqual(len(commands),2)

    def test_failed_admission_has_terminal_receipt_without_docker(self):
        import fullmag_storage as storage
        import contextlib
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);context=root/"tmp/boris-cpu-image-test";context.mkdir(parents=True)
            layout=dict(storage_root=str(root),build_root=str(root/"builds"),worktree_id="test")
            with patch.object(storage,"resolve_layout",return_value=layout), patch.object(storage,"validate_path",side_effect=lambda p,*a:Path(p)), patch.object(storage,"file_lock",return_value=contextlib.nullcontext()), patch.object(b,"validate_context",side_effect=ValueError("tampered")), patch.object(b.subprocess,"run",side_effect=AssertionError("no Docker mutation")):
                with self.assertRaisesRegex(ValueError,"tampered"):
                    b.build_image(root,context,"fullmag/boris-cpu:test")
            receipts=list((root/"builds").glob("*/terminal-receipt.json"))
            self.assertEqual(len(receipts),1)
            receipt=json.loads(receipts[0].read_text())
            self.assertEqual(receipt["status"],"FAILED")
            self.assertFalse(receipt["native_compilation_executed"])
            self.assertFalse(receipt["operator_changed"])

if __name__=="__main__":unittest.main()
