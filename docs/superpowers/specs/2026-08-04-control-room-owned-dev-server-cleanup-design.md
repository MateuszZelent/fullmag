# Control Room owned dev-server cleanup

## Scope

When a non-interactive Fullmag script finishes, its Control Room API and any
frontend process started by that run must finish with it. A frontend that the
run merely reuses must remain untouched.

## Root cause

`fullmag-cli` starts `node apps/control-room/dev-server.mjs` in an owned Unix
process group. The Node wrapper then starts `pnpm ... dev` in a separate,
detached process group. If the wrapper exits before forwarding its termination
signal, the detached Next process can keep listening on port 3100 after its API
has gone away.

## Design

The development-server wrapper will spawn its `pnpm` child without creating a
separate process group. The child will therefore remain in the group owned by
`ControlRoomGuard`, which is already terminated when a non-interactive run
ends. Signal forwarding in the wrapper remains as a fallback for direct
wrapper termination.

`ControlRoomGuard` continues to terminate only a `frontend_child` it owns.
When the launcher finds and reuses a ready frontend, `frontend_child` remains
absent and the reused server is not stopped.

## Verification

1. Add a Node test that proves the wrapper does not request a detached child.
2. Run that focused test, first against the old setting to observe the expected
   failure, then with the production change.
3. Run the existing CLI Control Room ownership tests and the focused Node test.
4. Run the Control Room frontend typecheck and lint the changed file.

## Non-goals

- Do not kill arbitrary processes merely because they use port 3100.
- Do not change the `--interactive` lifecycle contract.
- Do not change WSL networking or port forwarding.
