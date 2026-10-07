"""Receipt identity checks for offline DE comparison, not solver qualification."""
from __future__ import annotations


def validate_de_pilot_receipts(request, result, pilot):
    """Bind an accepted process result to its model, build and requested case."""
    schema = "de100-pilot" if pilot == "de100" else "de-smoke"
    if (not isinstance(request, dict) or not isinstance(result, dict) or
            request.get("schema") != f"fullmag.{schema}.request.v1" or
            result.get("schema") != f"fullmag.{schema}.result.v1" or
            result.get("status") != "completed_unqualified" or
            type(result.get("return_code")) is not int or result["return_code"] != 0):
        raise ValueError("Expected a completed managed numerical DE pilot")
    if result.get("pilot") != pilot:
        raise ValueError("Run identity mismatch: pilot")
    # Older receipts did not expose these case fields. If present they must
    # agree with the result; missing fields never supply model identity.
    for key, expected in (("cases", [pilot]), ("operation", pilot + "-numerical-pilot")):
        if key in request and request[key] != expected:
            raise ValueError(f"Run identity mismatch: {key}")
    for key in ("model_sha256", "job", "source"):
        if not request.get(key) or request[key] != result.get(key):
            raise ValueError(f"Run identity mismatch: {key}")
    # A separately pinned model is optional on the legacy capsule-owned route,
    # but one-sided or changed provenance must not silently fall back to it.
    if "model_source" in request or "model_source" in result:
        identity = request.get("model_source")
        if not isinstance(identity, dict) or not identity or identity != result.get("model_source"):
            raise ValueError("Run identity mismatch: model_source")
