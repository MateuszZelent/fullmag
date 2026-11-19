"""Collect a read-only camera diagnostic in the existing selected DEV group.

No unit-test suite or application build is run. Replaying the captured camera
changes only the function input in an isolated Node VM, never the live session.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay-captured-camera", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    base = "apps/control-room/src/modules/viewport-3d/"

    def git(*arguments):
        return subprocess.check_output(["git", *arguments], cwd=root, text=True).strip()

    baseline = git("rev-parse", "d87d42ed7^")
    payload = {"head": git("rev-parse", "HEAD"), "commit": baseline}
    for key, name in [("fit", "layers/CameraControls.tsx"), ("clip", "layers/Viewport3DScene.tsx")]:
        payload[key] = git("show", f"{baseline}:{base}{name}")
    if args.replay_captured_camera:
        payload["replayCamera"] = {
            "projection": "perspective",
            "position": [1.6710714031932422e-7, -6.101199092239823e-7, 2.0428454917790962e-7],
            "target": [0, 0, 1.5500000000000002e-7],
            "up": [0, 0, 1],
            "fov_degrees": 45,
            "orthographic_scale": None,
        }
        payload["replayCameraSource"] = (
            "GET visualization/state from fullmag-master during this audit, revision 11, "
            "before the live camera changed; preserved from the tool response. "
            "This is a replay of observed values, not an assertion of screenshot pose."
        )
    command = [
        "docker", "exec", "-i", "-w", "/state/development/workspace/apps/control-room",
        "fullmag-master-frontend-1", "node",
        "/opt/fullmag/source/docs/diagnostics/viewport-ring-depth-audit-2026-10-22/probe.cjs",
    ]
    result = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise SystemExit(result.stderr)
    report = json.loads(result.stdout)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in [
        "cameraInputSource", "nearestSphereDepthM", "ringCenterDepthM", "inputStability",
        "boundsSensitivity",
    ]}, indent=2))
    print(json.dumps(report["comparison"][0], indent=2))


if __name__ == "__main__":
    main()
