#!/usr/bin/env bash
# Create a missing release tag without replacing an existing tag.
set -euo pipefail
tag=${1:?release tag required}
commit=${2:?build SHA required}
ref="refs/tags/$tag"
git check-ref-format "$ref"
[[ "$(git rev-parse --verify 'HEAD^{commit}')" == "$commit" ]]
# A competing publisher can create the same tag. In both cases read back the
# authoritative remote tag, including the commit inside an annotated tag.
status=0
git ls-remote --exit-code --refs origin "$ref" >/dev/null || status=$?
if [[ "$status" == 2 ]]; then
  git push origin "$commit:$ref" || echo "Tag creation failed; verifying remote ref" >&2
elif [[ "$status" != 0 ]]; then
  exit "$status"
fi
git fetch --no-tags origin "$ref"
actual=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
if [[ "$actual" != "$commit" ]]; then
  echo "Release tag $tag resolves to $actual, expected $commit" >&2
  exit 1
fi
