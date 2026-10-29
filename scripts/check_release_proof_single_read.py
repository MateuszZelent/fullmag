"""Source-only regression for release-proof validation reuse; never compiles tests."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
RELATIVE = "crates/fullmag-session/src/host_resource_ledger.rs"
source = (ROOT / RELATIVE).read_text()
baseline = subprocess.check_output(["git", "show", "caad5331841d7895e8b124719746579d1cff7db3:" + RELATIVE], cwd=str(ROOT), text=True)

def function(text, name):
    start = text.index("fn " + name + "(")
    end = text.find("\nfn ", start + 1)
    return text[start:end if end >= 0 else len(text)].rstrip()

checks = 0

def check(condition, message):
    global checks
    assert condition, message
    checks += 1
    print("PASS " + message)

old = function(baseline, "validate_release_proof")
expected = old.replace("fn validate_release_proof(", "fn read_validated_release_proof(", 1)
expected = expected.replace(") -> Result<()> {", ") -> Result<HostResourceReleaseProof> {", 1)
assert expected.endswith("    }\n}")
expected = expected[:-len("    }\n}")] + "    }?;\n    Ok(proof)\n}"
validator = function(source, "read_validated_release_proof")
check(validator == expected, "every original digest, schema, identity and kind-specific rejection is preserved verbatim")
for operation in ["read_bounded_regular_file(", "Sha256::digest(", "serde_json::from_slice("]:
    check(validator.count(operation) == 1, "one canonical " + operation)
wrapper = function(source, "validate_release_proof")
check("read_validated_release_proof(root, policy, reservation).map(|_| ())" in wrapper, "legacy validation callers retain the same full validation")
epoch = function(source, "reservation_consumes_solver_epoch")
check("return Ok(true);" in epoch and "state != HostResourceReservationState::Released" in epoch, "nonreleased reservations always consume their epoch")
check(epoch.count("read_validated_release_proof(") == 1 and "proof.kind != HostResourceReleaseProofKind::AdmissionAbsent" in epoch, "only fully validated AdmissionAbsent permits epoch reuse")
check(all(op not in epoch for op in ["read_bounded_regular_file(", "serde_json::from_slice(", "validate_release_proof("]), "epoch check never rereads the proof")
body = function(source, "validate_ledger_document_body")
check(body.count("reservation_consumes_solver_epoch(") == 1 and "validate_release_proof(" not in body, "document checks each reservation proof once")
check(body.index("reservation_consumes_solver_epoch(") < body.index("identities.insert("), "proof remains validated before duplicate-identity checks")
check("if consumes_solver_epoch {" in body, "epoch uniqueness uses the already validated result")
print({"status": "passed", "checks": checks, "compiled_unit_tests": False, "runtime_qualification": False})
