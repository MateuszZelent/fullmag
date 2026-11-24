#!/usr/bin/env bash
# The CI launcher uses this Chromium client as the window owned by 'fullmag ui'.
# After the client exits, the CLI joins its observer and stops its API and frontend.
set -euo pipefail
cd "$GITHUB_WORKSPACE"
exec > "$ABL_EVIDENCE/browser.log" 2>&1
trap 'echo "$?" > "$ABL_EVIDENCE/browser.exit"' EXIT
python tests/fixtures/abl_browser_fdm/seed.py --url "$FULLMAG_QA_URL" \
  --fixture "$FULLMAG_QA_FIXTURE" --backend "$ABL_BACKEND" --allow-create-session
case "$ABL_BACKEND" in
  fdm) specs=(abl.spec.ts session-previews.spec.ts) ;;
  fem) specs=(fem.spec.ts) ;;
  *) exit 2 ;;
esac
pnpm --dir apps/control-room exec playwright test "${specs[@]/#/tests/abl-browser/}" \
  --workers=1 --reporter=line --output="$ABL_EVIDENCE/render"
