#!/usr/bin/env bash
set -euo pipefail

# Compose project names are part of the managed FEM isolation boundary. Never
# derive them from a mutable branch name: two worktrees can share a branch but
# must not share containers, networks, or anonymous build state.
repo_root="${FULLMAG_REPO_ROOT:-}"
if [ -z "${repo_root}" ]; then
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
fi
repo_root="$(cd "${repo_root}" && pwd -P)"

slug="$(basename "${repo_root}" | sed 's/[^A-Za-z0-9._-]/-/g')"
digest="$(printf '%s' "${repo_root}" | sha256sum | cut -c1-16)"
project="fullmag-${slug}-${digest}"

if [ -n "${FULLMAG_COMPOSE_PROJECT_NAME:-}" ]; then
  project="${FULLMAG_COMPOSE_PROJECT_NAME}"
fi
case "${project}" in
  ''|*[!A-Za-z0-9_-]*)
    echo "invalid Compose project name: ${project}" >&2
    exit 2
    ;;
esac
printf '%s\n' "${project}"
