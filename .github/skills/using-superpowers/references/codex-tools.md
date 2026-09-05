# Codex host adaptation

Use the callable tool schemas exposed in the current session. Tool names and orchestration modes vary between Codex hosts; do not infer an API from an old example or enable features just to run a workflow.

If delegation is available and authorized, use its actual spawn, messaging, and waiting tools. A configured model or inherited setting is valid; do not force model overrides. Keep existing authorization and shared-write constraints in the worker brief. Reuse or release workers only through supported tools.

For worktrees, inspect Git state, including dirty files and submodule status. Detached HEAD does not itself prove a sandbox restriction. Follow available native workspace tools or project-approved Git operations without moving an unrelated checkout.

When an operation is denied, respect the denial, report the actual boundary, and complete unaffected work. Do not respond by automatically staging or committing files, weakening permissions, or switching to another tool to bypass the same restriction. Prepare a concrete diff or proposed action when approval is needed.

On Windows, use the actual PowerShell/runtime paths. Build and cache locations come from the project instructions; generic host builds are not a substitute for managed FEM verification.
