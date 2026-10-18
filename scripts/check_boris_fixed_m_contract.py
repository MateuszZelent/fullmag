"""Controlled source/raw-OVF checks; never executes BORIS or grants runtime identity."""
from __future__ import annotations
import argparse
import ast
from copy import deepcopy
import json
import hashlib
import shutil
import uuid
from pathlib import Path
from boris_nf_interface_smoke import NfCaseConfig, render_boris_script, scenario_manifest
from verify_boris_nf_interface import validate_fixed_m, validate_boris_artifact, read_text_ovf
from run_managed_boris_nf import require_fixed_m_members, fixed_inputs


def check_retained_reopen_guards(output, config, scenario, native):
    """Synthetic admission dependencies; execute real final publication/reopen gates."""
    import run_managed_boris_nf as managed
    import run_boris_nf_interface as interface
    cases = []
    for mode in ("publication", "identity_reopen", "public_reopen"):
        run_root = output / (mode + "-" + uuid.uuid4().hex)
        export = run_root / "export"
        export.mkdir(parents=True)
        for name in ("f_M_before.ovf", "f_M_after.ovf", "f_V.ovf"):
            shutil.copyfile(output / name, export / name)
        (export / "boris_native_samples.json").write_text(json.dumps(native), encoding="utf-8")
        pins = [dict(path=name, sha256=hashlib.sha256((export / name).read_bytes()).hexdigest())
                for name in ("f_M_before.ovf", "f_M_after.ovf", "boris_native_samples.json")]
        proof_a = validate_fixed_m(export, scenario, native)
        summary = dict(schema_version="fullmag.boris_she_nf.v2", scenario=scenario,
                       runtime=dict(schema_version="fullmag.boris.runtime.v2", identity_complete=True),
                       fixed_m_proof=proof_a)
        (export / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
        def drift():
            path = export / "f_M_after.ovf"
            path.write_bytes(path.read_bytes().replace(b"800000.0 0.0 0.0", b"800000.0 0.1 0.0", 1))
            # Still passes the physical tolerance; only the retained-byte fence rejects B.
            assert validate_fixed_m(export, scenario, native)["maximum_after_error_apm"] == .1
        saved = {}
        def patch(module, name, value):
            saved[(module, name)] = getattr(module, name)
            setattr(module, name, value)
        try:
            if mode == "public_reopen":
                def admitted(*args, **kwargs):
                    drift()
                    return pins
                patch(interface, "validate_runtime_identity", admitted)
                action = lambda: validate_boris_artifact(export)
            else:
                binding = {"synthetic": True}
                receipt = dict(state="starting" if mode == "publication" else "runtime_succeeded_identity_verified",
                               resolution="coarse", build_job_id="synthetic", binding=binding,
                               outputs=pins, probe={}, container_attestation_sha256="synthetic")
                observed = {"State": {"Running": False, "Status": "exited"}}
                patch(managed, "checked_run", lambda *args: (run_root, receipt, observed))
                def outputs(*args):
                    drift()
                    return pins, {}
                patch(managed, "verified_outputs", outputs)
                patch(managed, "resolved_boris_build", lambda *args: (None, None, None, binding))
                patch(managed, "fixed_inputs", lambda *args: (config, b"", b""))
                patch(managed, "attestation_digest", lambda *args: "synthetic")
                patch(managed, "identity_from_receipt", lambda *args, **kwargs: summary["runtime"])
                def no_commit(*args):
                    raise AssertionError("success receipt committed despite M drift")
                patch(managed, "commit_receipt", no_commit)
                action = (lambda: managed._observe_locked(run_root, "synthetic")) if mode == "publication" else (
                    lambda: managed.verify_runtime_identity(summary["runtime"], run_root, export))
            try:
                action()
            except ValueError as error:
                assert "retained output closure" in str(error), str(error)
                cases.append(mode + "_A_to_B_M_hash_rejected")
            else:
                raise AssertionError(mode + " accepted M drift after admission")
            if mode == "publication":
                assert managed.read_json(run_root / "receipt.json")["state"] == "failed_resources_retained"
                cases.append("publication_drift_never_commits_success")
        finally:
            for (module, name), original in saved.items():
                setattr(module, name, original)
    return cases


def check_fixed_m_contract(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    config = NfCaseConfig(nx=2, ny=1, nz_n=1, nz_f=2, l_ex_m=7e-9)
    scenario = scenario_manifest(config)
    script = render_boris_script(config)
    ast.parse(script, feature_version=(3, 10))
    assert "ferromagnet.param.l_J = 7e-09" in script
    assert "ns.computefields()" in script and "ns.Run()" not in script
    assert script.index("f_M_before.ovf") < script.index("ns.computefields()") < script.index("f_M_after.ovf")
    assert 'ns.setparam("ferromagnet", "l_J")' in script
    # Existing experimental authoring remains available, without N/T/F admission.
    render_boris_script(NfCaseConfig(use_tunnel_barrier=True, barrier_m=1e-9, barrier_conductance_spm2=1e12))
    cases = ["rendered_fixed_m_source"]
    original_resolve = Path.resolve
    try:
        Path.resolve = lambda self, *a, **k: Path("D:/export")
        _, windows_script, windows_scenario = fixed_inputs("coarse")
        assert "output = Path(" + repr(str(Path("D:/export"))) + ")" in render_boris_script(config)
        Path.resolve = lambda self, *a, **k: Path("/export")
        _, linux_script, linux_scenario = fixed_inputs("coarse")
    finally:
        Path.resolve = original_resolve
    assert windows_script == linux_script and windows_scenario == linux_scenario
    assert b"output = Path('/export')" in windows_script
    cases.append("managed_Windows_Linux_bytes_identical_and_fixed_export")
    try:
        render_boris_script(config, execution_output_dir="D:/export")
    except ValueError:
        cases.append("arbitrary_output_override_rejected")
    else:
        raise AssertionError("arbitrary managed override accepted")
    # Execute the exact worker byte guard in isolation; never run the worker.
    managed_source = Path(__file__).with_name("run_managed_boris_nf.py").read_text()
    worker = next(node for node in ast.parse(managed_source).body
                  if isinstance(node, ast.FunctionDef) and node.name == "_worker")
    guard = next(node for node in worker.body if isinstance(node, ast.If)
                 and "BORIS fixed input differs" in ast.unparse(node))
    input_dir = output / "input_guard"
    input_dir.mkdir(exist_ok=True)
    (input_dir / "scenario.py").write_bytes(windows_script)
    (input_dir / "scenario.json").write_bytes(windows_scenario)
    guard_globals = dict(Path=lambda path: input_dir / Path(path).name,
                         script=windows_script, scenario=windows_scenario)
    guard_code = compile(ast.fix_missing_locations(ast.Module(body=[guard], type_ignores=[])),
                         "actual_worker_byte_guard", "exec")
    exec(guard_code, guard_globals)
    (input_dir / "scenario.py").write_bytes(windows_script + b"# drift")
    try:
        exec(guard_code, guard_globals)
    except ValueError:
        cases.append("actual_worker_byte_guard_still_rejects_drift")
    else:
        raise AssertionError("worker byte guard accepted drift")
    def ovf(name, rows, dimension=3, step=1e-9):
        text = "\n".join(" ".join(map(str, row)) for row in rows)
        (output / name).write_text(f"""# OOMMF OVF 2.0
# Begin: Segment
# Begin: Header
# meshtype: rectangular
# xnodes: 2
# ynodes: 1
# znodes: 2
# xmin: 0
# ymin: 0
# zmin: 1e-9
# xstepsize: 1e-7
# ystepsize: 1e-7
# zstepsize: {step}
# valuedim: {dimension}
# End: Header
# Begin: Data Text
{text}
# End: Data Text
# End: Segment
""", encoding="utf-8")
    m = [(8e5, 0., 0.)] * 4
    def reset():
        ovf("f_M_before.ovf", m)
        ovf("f_M_after.ovf", m)
        ovf("f_V.ovf", [(0.,)] * 4, 1)
    reset()
    native = dict(schema_version="fullmag.boris_she_nf.native.v2", scenario=scenario,
                  stage_complete=True, fixed_m=dict(schema_version="fullmag.boris_fixed_m.v1",
                  M_before="f_M_before.ovf", M_after="f_M_after.ovf", l_J_readback_m=7e-9,
                  execution_mode="fixed_m_transport_only"))
    proof = validate_fixed_m(output, scenario, native)
    assert proof["sample_count"] == 4 and proof["maximum_change_apm"] == 0.
    cases.append("all_four_raw_cells_pass")
    crlf_path = output / "f_M_before.ovf"
    crlf = crlf_path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    crlf_path.write_bytes(crlf)
    class OneRead:
        def __init__(self, path): self.path = path; self.reads = 0
        def is_file(self): return self.path.is_file()
        def read_bytes(self):
            self.reads += 1
            if self.reads != 1: raise AssertionError("OVF parser read bytes twice")
            return self.path.read_bytes()
    witness = OneRead(crlf_path)
    parsed = read_text_ovf(witness)
    assert witness.reads == 1 and parsed.sha256 == hashlib.sha256(crlf).hexdigest()
    assert parsed.values == tuple(m)
    cases.append("single_read_CRLF_parsed_hash_identity")
    reset()
    entries = [dict(path=name, sha256=proof[key]) for name, key in (
        ("f_M_before.ovf", "M_before_sha256"), ("f_M_after.ovf", "M_after_sha256"))]
    require_fixed_m_members(proof, entries)
    cases.append("parsed_M_hashes_bound_to_closure")
    def refused(name, action):
        try:
            action()
        except (ValueError, FileNotFoundError):
            cases.append(name)
        else:
            raise AssertionError(name + " was accepted")
    bad_entries = deepcopy(entries); bad_entries[-1]["sha256"] = "0" * 64
    refused("closure_M_hash_mismatch", lambda: require_fixed_m_members(proof, bad_entries))
    bad = deepcopy(native); sc = deepcopy(scenario); sc["execution"]["static_transport"] = 0; bad["scenario"] = sc
    refused("integer_static_false_alias", lambda: validate_fixed_m(output, sc, bad))
    # The public comparison must distinguish booleans from numeric diagnostics.
    bad_proof = dict(proof, maximum_change_apm=False)
    assert json.dumps(bad_proof, sort_keys=True) != json.dumps(proof, sort_keys=True)
    cases.append("JSON_proof_bool_number_distinction")
    for value in [True, "7e-9", [7e-9], float("nan"), float("inf"), 0., 2e-9]:
        bad = deepcopy(native); bad["fixed_m"]["l_J_readback_m"] = value
        refused("invalid_readback_" + repr(value), lambda: validate_fixed_m(output, scenario, bad))
    for label, family, schema in [("legacy_native", "native", "fullmag.boris_she_nf.native.v1"),
                                  ("legacy_scenario", "scenario", "fullmag.boris_she_nf.scenario.v1")]:
        bad = deepcopy(native); sc = deepcopy(scenario)
        if family == "native": bad["schema_version"] = schema
        else: sc["schema_version"] = schema; bad["scenario"] = sc
        refused(label, lambda: validate_fixed_m(output, sc, bad))
    for filename in ["f_M_before.ovf", "f_M_after.ovf"]:
        rows = list(m); rows[-1] = (8e5, 2., 0.)
        ovf(filename, rows)
        refused("last_cell_defect_" + filename, lambda: validate_fixed_m(output, scenario, native)); reset()
    ovf("f_M_after.ovf", m, step=2e-9)
    refused("carrier_step_drift", lambda: validate_fixed_m(output, scenario, native)); reset()
    # Both snapshots individually within the threshold, but their difference is not.
    ovf("f_M_before.ovf", [(8e5, .6, 0.)] * 4)
    ovf("f_M_after.ovf", [(8e5, -.6, 0.)] * 4)
    refused("before_after_drift", lambda: validate_fixed_m(output, scenario, native)); reset()
    (output / "f_M_after.ovf").unlink()
    refused("missing_M_after", lambda: validate_fixed_m(output, scenario, native)); reset()
    bad = deepcopy(native); bad.pop("fixed_m")
    refused("missing_fixed_m", lambda: validate_fixed_m(output, scenario, bad))
    for direction in [(0., 1., 0.), (2., 0., 0.), (float("nan"), 0., 0.)]:
        refused("unsupported_direction_" + repr(direction), lambda: NfCaseConfig(magnetization=direction))
    refused("nonfinite_l_ex", lambda: NfCaseConfig(l_ex_m=float("nan")))
    (output / "summary.json").write_text(json.dumps(dict(schema_version="fullmag.boris_she_nf.v1")))
    refused("public_legacy_rejected_before_identity", lambda: validate_boris_artifact(output))
    (output / "summary.json").unlink()
    (output / "boris_native_samples.json").write_text(json.dumps(native), encoding="utf-8")
    native_bytes = (output / "boris_native_samples.json").read_bytes()
    from run_managed_boris_nf import read_json
    native_sha = hashlib.sha256(native_bytes).hexdigest()
    read_json(output / "boris_native_samples.json", expected_sha256=native_sha)
    changed_native = deepcopy(native); changed_native["fixed_m"]["l_J_readback_m"] = 7.000001e-9
    (output / "boris_native_samples.json").write_text(json.dumps(changed_native), encoding="utf-8")
    refused("native_readback_bytes_A_to_B_rejected", lambda: read_json(
        output / "boris_native_samples.json", expected_sha256=native_sha))
    (output / "boris_native_samples.json").write_bytes(native_bytes)
    cases.extend(check_retained_reopen_guards(output, config, scenario, native))
    return dict(schema_version="fullmag.boris_fixed_m.source_checks.v1", status="PASS",
                synthetic_fixture=True, solver_executed=False, runtime_identity_granted=False,
                checks=cases, fixed_m_proof=proof)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    result = check_fixed_m_contract(args.output_dir)
    (args.output_dir / "source-checks.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(dict(status=result["status"], checks=len(result["checks"]), solver_executed=False)))


if __name__ == "__main__":
    main()
