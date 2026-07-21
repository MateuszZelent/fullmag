#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
python3 "$root/scripts/verify_fem_mesh_hot_loop_source_contract.py" --self-test
python3 "$root/scripts/verify_fem_mesh_hot_loop_source_contract.py" --root "$root"
