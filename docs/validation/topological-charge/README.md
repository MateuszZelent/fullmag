# Runtime evidence for planar topological charge

Runtime qualification stores one JSON document per scenario. The document has
schema version `topological_charge_runtime.v2` and records only the v2
oriented-triangle method.

The capture step reads the status resource and the object-scoped topological
charge resource through HTTP v2:

```bash
python3 scripts/capture_topological_charge_runtime.py \
  --api-base-url http://localhost:8181 \
  --object-id magnet \
  --scenario fdm \
  --output .fullmag/reports/topological-charge/fdm/summary.json
```

It rejects a resource without `topological_charge.v2`, the v2 method, or both
requested and resolved execution provenance. The stored document retains the
raw status and topological-charge responses for auditability.

Validate a completed evidence file with:

```bash
python3 scripts/validate_topological_charge_runtime.py \
  .fullmag/reports/topological-charge/fdm/summary.json
```

The validator rejects hidden lossy fallback, non-double execution, a FEM case
without `fe_order=1`, a noncanonical support frame, and a cross-backend result
whose sign, trust state, or charge differs by `0.05` or more.

This document defines the evidence contract only. A passing managed FDM/FEM
runtime recipe is still required before production qualification.

Use `just verify-topological-charge-cross-backend` to run both managed
scenarios, combine their independently captured resources, and validate their
agreement. The combined file is written to
`.fullmag/reports/topological-charge/cross-backend/summary.json`.
