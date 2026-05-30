#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PYTHONPATH=packages/fullmag-py/src

python3 -m py_compile \
  packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py \
  packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py \
  packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py \
  packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py

python3 scripts/verify_fem_meshing_production.py

cargo test -p fullmag-api router_v2 --no-fail-fast

pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test

git diff --check -- \
  packages/fullmag-py/src/fullmag/meshing \
  packages/fullmag-py/tests/test_meshing.py \
  packages/fullmag-py/tests/test_api.py \
  crates/fullmag-api/src \
  apps/control-room/src \
  docs/physics \
  docs/plans
