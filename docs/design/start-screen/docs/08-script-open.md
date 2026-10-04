# Opening a Python script

How a person opens a Fullmag Python script (`.py`) from the desktop start screen:
what the repository does today, four candidate architectures, a recommendation
with phases, the exact new contracts, gates and the decisions still open.

Status: **design** (2026-10-04). Nothing here is implemented. Every claim about
current behaviour was read in the source of this worktree (commit `688f1f23c`);
what was *not* executed is marked **unverified**. Unit-test compilation is
suspended (`AGENTS.md`), so no existing test was run for this document.

Companions: `07-workspace-database.md` (items, events, `kv`, actors),
`06-implementation-status.md` (what the start screen already does).

---

## 1. Verified facts that shape the design

1. **The Control Room has no "open script" operation.** `ControlRoomApi` offers
   an empty scratch session (`POST /v2/sessions`, `sessions/create.rs:28`; only
   `fdm|fem`, `cpu`, `double`, see `validated_execution`), project operations
   and the script endpoints under `/v2/sessions/current/model/script|syncs`
   (`router_v2/mod.rs:269-275`). The desktop host already has
   `open_file_dialog` (`commands.rs:78`, filter includes `py`) that returns the
   *text* only; nothing consumes it for scripts.
2. **Scripts run through the CLI only**, and running is the default: `fullmag
   script.py` compiles, exports ProblemIR through the Python helper, plans,
   solves and streams to a live workspace (section 2). `ui [script]` exists but
   does not materialize (`orchestrator.rs:982-1014`, "authoring workspace
   without materializing a simulation").
3. **Python is not only rendered, it is also ingested**, which the earlier
   brief missed. For a session whose `script_path` is set, the API *executes*
   the script with `helper export-scene-document` to produce a `SceneDocument`
   lazily (`fullmag-api/src/main.rs:4480, 4603, 4695`; `script.rs:341`) and
   *rewrites the file in place* with `helper rewrite-script --write`
   (`script.rs:202-254`, `script_builder.py:368-389`: renders the whole file
   from the loaded problem and atomically replaces it).
4. **Hazard that blocks any "open script in the UI" design: the UI rewrites the
   user's file.** `workspace.export-python` calls `model.syncAuthoringScript({})`
   (`shellCommands.ts:314`) and the magnetic-texture inspector calls it after
   every save (`ObjectMagneticTexturePanel.tsx:883, 935`). On a script-backed
   session that regenerates the user's `.py` in canonical form: comments, helper
   functions and `os.environ` logic are, by inference from the renderer
   (`render_loaded_problem_as_script` emits a header, parameters and DSL calls),
   not preserved; the exact loss was not measured.
   There is no backup and no confirmation. The same hazard exists today for
   `fullmag script.py` followed by "Export Python DSL".
5. **A default run deletes a sibling directory.** With no `--output-dir`, results
   go to `<script>.zarr` next to the script and an existing directory of that
   name is removed with `remove_dir_all` before the run
   (`step_utils.rs:94-125`, called from `orchestrator.rs:6739`).
6. **Script mode opens the system browser, not the desktop window.**
   `spawn_control_room` ends in `open_in_browser` (`control_room.rs:1791`);
   only `launch_ui` calls `open_in_tauri` (`control_room.rs:1869`, which needs an
   API-instance pin from `prepare_for_authoring`).
7. **The pipeline is a singleton by default.** `resolve_api_port` prefers a
   compatible API already on `:8081` and reuses it (`control_room.rs:121-158,
   1521-1531`); the API holds one `current_live_state` and `POST /v2/sessions`
   answers 409 unless `replace_current`. A second `fullmag x.py` next to a
   running desktop hub would therefore publish into the hub's API and replace
   its session. Per-script isolation needs an explicit free `FULLMAG_API_PORT`.
8. **There is a proven "load, inspect, then compute" mode.** The scratch bridge
   runs `fullmag <script> --interactive --backend B --mode strict --precision
   double` with `FULLMAG_API_PORT`, `FULLMAG_ATTACHED_SESSION_ID`,
   `FULLMAG_ATTACHED_WAIT_FOR_SOLVE=1`, `FULLMAG_SKIP_CONTROL_ROOM=1`
   (`scratch_runtime.rs:799-840`). The wait gate is `orchestrator.rs:7858-7880`
   (also settable from the script, `fm.wait_for_solve`). That supervisor lives in
   the CLI's `launch_ui`; the Tauri host's `ApiSidecar` has none.
9. **Python resolution is duplicated and wrong on this Windows host.** CLI
   (`python_bridge.rs:956-1130`) and API (`script.rs:510-599`) each keep a
   candidate list ending in `["python3", "python"]`. Here `python3` is the Store
   alias (`...\WindowsApps\python3.exe`) and prints "nie znaleziono Python;
   uruchom bez argumentów..." while `python` is Miniconda 3.12.2 and `py.exe`
   exists. The alias **spawns successfully and exits non-zero**, so the
   spawn-error fallback loop never advances to `python`. This matches the
   reported local failure of the `fullmag-api` tests. **Unverified** by running
   those tests (suspended); the stub behaviour itself was probed in a shell.
10. **Packaged Windows is different on purpose** (ADR 0047,
    `python_runtime.rs:82-134`): bundled CPython 3.12 under `python/`, run with
    `-I -u`, `PYTHON*` removed, PATH limited to the app, and `FULLMAG_PYTHON` is
    *not* allowed to replace it. A user script there sees only the bundle's
    `site-packages` and cannot import its own sibling modules (isolated mode
    keeps the script directory off `sys.path`; the loader adds nothing,
    `loader.py:256-349`).
11. **Provenance already carries the key facts**: `SessionManifest` has
    `script_path`, requested and resolved backend/device/precision/mode,
    `resolved_runtime_family/engine_id/worker`, `resolved_fallback`
    (`orchestrator.rs:5563-5607`); `ProblemIR.problem_meta.source_hash` is
    `sha256(script_text)` (`problem.py:2702`). There is no interpreter record
    and no pick-time hash.
12. **No encoding contract.** The helper decodes scripts with `utf-8`
    (`helper.py:205`, `loader.py:273`; a BOM becomes U+FEFF and fails to
    compile). Nothing sets `PYTHONUTF8`/`-X utf8`, so on a Polish Windows
    console `print("α")` in a script encodes with the OEM/ANSI code page. In
    isolated mode `PYTHONUTF8` would be ignored (`-I` implies `-E`); `-X utf8`
    is the working switch.
13. **The desktop capability is wider than it looks.** `capabilities/default.json`
    grants every command to `http://localhost:*` and `http://127.0.0.1:*`, i.e.
    any local web page, not only Fullmag's. A command that executes a file must
    not be callable with an arbitrary path from the renderer.

Reported, **not re-run here**: `export-scene-document` / `render-scene-document`
do not round-trip `examples/mumax_standard_problem_5_fdm.py` (error "LLG
relaxation requires an explicit fixed or complete adaptive timestep policy"). The
example reads six `os.environ` variables at import time, which is exactly the
kind of script a canonical re-render cannot preserve.

---

## 2. Current script lifecycle, end to end

```
user                CLI process                      Python (child)                 API / UI
 |  fullmag [-i] x.py [--backend..]
 |-------------> main.rs:47 is_script_mode (851) -> 16 MiB worker thread
 |               orchestrator::run_script_mode (6635)
 |                 init_api_port (control_room.rs:160)  -> :8081 reuse or free port
 |                 canonicalize(script)  [\\?\ prefix on Windows]
 |                 check_script_syntax_via_python ----> python -c compile()      (no exec)
 |                 resolve_script_output_paths -> <x>.zarr (deleted+recreated)
 |                 LocalLiveWorkspace + CurrentLivePublisher(session_id)
 |                 phase 1 thread: helper export-run-config --skip-geometry-assets
 |                                              ---> exec_module(script)  EXECUTES USER CODE
 |                                              <--- ScriptExecutionConfig JSON (last {...} line)
 |                 spawn_control_room -> API child + web + open_in_browser -----> live snapshots
 |                 helper export-run-config (full, geometry assets) ---> exec again
 |                 plan -> solver init -> stages -> publish steps/fields ---------> viewport, charts
 |                 -i / script interactive: stay alive, accept run/relax commands
 |                 exit: summary, drop ControlRoomGuard (API/web children killed)
```

Facts per hop: the script is **executed twice** (phase 1 and the authoritative
pass, `orchestrator.rs:6870-6935` and the later full export), plus once more by
the API when the UI asks for a scene of a script-backed session. Working
directory is *inherited from the shell*; only the asset root is the script's
folder (`world.begin_script_capture(source_path.parent)`). Interpreter choice,
`PYTHONPATH` (repo `packages/fullmag-py/src`, packaged `site-packages`,
`.fullmag/local`, then inherited) and the mesh cache dir are decided per call in
`run_python_helper_with_progress`. Backend/mode/precision are CLI flags; the
*device* is only the env pair `FULLMAG_FDM_EXECUTION` / `FULLMAG_FEM_EXECUTION`
(`managed_execution_device`) or authored in the script.

Desktop today (`apps/desktop/src-tauri/src/main.rs:13-86`): either attach to
`FULLMAG_UI_URL` + `FULLMAG_API_BASE` + `FULLMAG_LAUNCH_INTENT` (set by
`fullmag ui`), or start a `fullmag-api` sidecar on the first free port of
`8081..8089` with an empty workspace. One window labelled `main`.

---

## 3. Requirements for any architecture

- **R1 explicit action.** Execution only after a user gesture on one concrete
  file; never at launch, list refresh, scan or index time.
- **R2 no renderer path authority.** The renderer holds an opaque ticket or a
  DB item id, never a path it can change between consent and execution.
- **R3 content-bound consent.** Consent is for `(path_key, sha256)`; a changed
  file asks again; the run verifies the hash it executes.
- **R4 user file is read-only** to Fullmag unless the person saves explicitly
  (fact 4). "UI must export a canonical editable script" is satisfied by
  exporting a *copy*.
- **R5 explicit interpreter**, one resolver for CLI, API and desktop, typed
  failure, no Store-stub dead end, bundle policy of ADR 0047 untouched.
- **R6 requested vs resolved, no silent fallback**: record what was asked
  (including `auto`) and what the runtime resolved; forced GPU that cannot run
  is a failed run, never a CPU run.
- **R7 destructive defaults are visible**: no implicit deletion of
  `<script>.zarr`.
- **R8 one typed client, no component endpoints** (`AGENTS.md`): the renderer
  talks to the host through the typed Tauri wrapper and to the runtime through
  `ControlRoomApi`.

---

## 4. Candidate architectures

### A. Host launches the script-first CLI in its own window (per-script process tree)

**New.** Host-side: find the CLI (`bin/fullmag[.exe]`, like `find_api_binary`),
spawn `fullmag --interactive --wait-for-solve --ui desktop --api-port P
--output-dir <managed> --expect-script-sha256 H --receipt R <script>` with
`current_dir = script folder`, in a job object. CLI-side: `--ui`, `--api-port`,
`--wait-for-solve`, `--expect-script-sha256`, `--receipt`, `--launched-by`
(section 6.2). The CLI opens `fullmag-ui` via `open_in_tauri` for that run's API.
Everything else (materialize, plan, run, live data plane) is the existing path.

- **Security.** Consent and path ownership in the host (R1-R3). The script runs
  as a child of the CLI, own process tree, killable as a tree. No HTTP surface
  executes code. Not a sandbox: the script has the user's file/network rights;
  the prompt says so.
- **Failure modes.** CLI missing; interpreter missing (exit 10, typed);
  syntax error (exit 12, line/col); script changed after consent (exit 11);
  port taken (`--api-port` bind failure, host retries once with another port);
  materialize/plan failure shows in the new window's preparation panel (already
  implemented); host crash leaves a receipt without a reader (reconciled at next
  start); window closed during a run stops it (documented, section 4.5).
- **Provenance.** Full: script path, sha256, interpreter, cwd, argv (redacted),
  requested, resolved, fallback, run/session ids, status, duration; one receipt
  JSON, one DB `run` event written by the host.
- **Effort.** CLI flags and `--ui desktop` wiring ~3-4 days; host commands,
  job object, receipt reconciliation ~4-5 days; start-screen UI ~3 days;
  resolver (Phase 0) counted separately.
- **Canonical script.** Needs Phase 0b (no in-place rewrite). Export becomes
  "Save canonical copy as...".
- **Windows.** `CREATE_NO_WINDOW` for the CLI, job object with kill-on-close
  for the tree, `\\?\` stripped from `path_key` and displayed paths, `-X utf8`.
- **DB.** Host writes `open` (pick/open) and `run` (from receipt), actor
  `desktop`.
- **Multi-window.** Natural: one process tree and one API per script, hub stays
  an independent window.

### B. Attach the script runtime to this window's API (same window, same session)

**New.** The host (or a shared crate extracted from `scratch_runtime.rs`) mints a
session with `POST /v2/sessions {replace_current: true}` and spawns the attached
runtime (`FULLMAG_ATTACHED_SESSION_ID`, `FULLMAG_API_PORT=<sidecar>`,
`FULLMAG_SKIP_CONTROL_ROOM=1`, `FULLMAG_ATTACHED_WAIT_FOR_SOLVE=1`) on the user
script; the hub window becomes the workspace.

- **Security.** As A, plus the replaced session's unsaved work is lost unless
  the host asks first.
- **Failure modes.** Whether the API accepts a script-backed snapshot for a
  pre-minted id when the current session is an idle hub is **unverified**; the
  bridge ignores script-backed sessions by design (`ignored_session`). Supervisor
  duplication or extraction is the real cost. Closing the window kills the run.
- **Provenance.** Same record, but the host must scrape resolved runtime from
  `GET /v2/sessions/current` instead of a receipt, or the same `--receipt` flag
  is added anyway.
- **Effort.** ~8-10 days (supervisor extraction, replace-current UX, handshake
  gate), more risk than A.
- **Canonical script.** Same as A.
- **Windows.** Same; one fewer window but one more shared-state race
  (session epoch, display selection) with the hub's own scratch authoring.
- **DB.** Same events.
- **Multi-window.** One session per window by construction; a second script means
  replace or a second desktop process.

### C. Import the script into a project (`.fms` with an opaque script document)

**New.** `Import script...` creates a project whose archive stores
`project/source/script.py` and `project/source/script.manifest.json`
(`{original_path, sha256, bytes, assets: [{path, sha256}]}`) as opaque documents
(`provenance.rs` and `OpaqueDocument` already guarantee they survive load and
save). Project open stays definition-only (ADR 0039). Running a project that has
only a script document still needs A or B underneath.

- **Security.** Storing is inert; executing still needs R1-R3. A project received
  from someone else carries a script: opening it must not run it (the prompt shows
  the stored hash and "from project").
- **Failure modes.** Scripts depend on siblings (`examples/bowl_3_cprt.stl`,
  `assets/`); a one-file freeze is incomplete, and the asset closure is only known
  after executing the script (lightweight capture). The 64 MiB archive cap
  (`MAX_PROJECT_ARCHIVE_BYTES`) applies. The accepted-run flow expects a
  scene/StudyPlan, which a script-only project does not have.
- **Provenance.** Strongest: immutable stored source, hash, assets, later runs in
  `project/provenance.json` (`kind: "run"`/`"import"`).
- **Effort.** ~6-8 days for a one-file freeze plus manifest, more for assets.
- **Canonical script.** Positive: the project *is* the editable record; export
  copies `script.py` out. It does not make the UI an editor.
- **Windows.** None specific beyond paths in the manifest (store relative,
  forward slashes, no `\\?\`).
- **DB.** `import` event, `kind: project` item with `meta.source = "script"`,
  plus the script item for the original path.
- **Multi-window.** Same as the runner underneath.

### D. Reconcile scene and script so scripts become authoring documents

**New.** A fidelity-graded round trip: `export-scene-document` already exists,
`render-scene-document` and `rewrite-script` already exist, but they are lossy
(fact 4 and the sp5 report). D would add a lossless-or-refuse contract: classify
script constructs (literal DSL calls vs computed values, env reads, helper
functions, loops), keep the original source as the document, and write back only
patches the classifier proved safe.

- **Security.** Unchanged execution risk; writing back adds a destructive
  surface, so it needs backup and diff preview.
- **Failure modes.** Most examples are ordinary Python. Honest outcome per file is
  "projectable", "partially projectable" or "run-only". Sync races with external
  editors (mtime/hash check required).
- **Provenance.** Per edit: base hash, patch, resulting hash.
- **Effort.** Research-grade, weeks to months; also changes the DSL conventions
  (declarative sections). No estimate is honest before a fidelity survey over the
  116 files in `examples/`.
- **Canonical script.** The only option that makes UI edits flow into the user's
  own file, and the only one that can break "human-editable".
- **Windows.** Newline and encoding preservation (CRLF, BOM) in write-back.
- **DB.** `save` events for scripts become meaningful.
- **Multi-window.** Needs a document lock/lease per script path.

### Comparison

| | A per-script window | B same window | C into project | D authoring doc |
|---|---|---|---|---|
| Reuses pipeline unchanged | CLI flags only | scratch bridge | needs A or B | no |
| Isolation of a bad script | best (own tree and API) | shares hub API | as runner | as runner |
| Replaces user work | never | asks, may lose | never | never |
| Provenance quality | high | high | highest | highest |
| Effort | medium | medium-high | medium | very high |
| Risk of touching user file | none (after 0b) | none (after 0b) | none | yes, by design |

---

## 5. Recommendation and phases

**Phase 0 (prerequisites, no start-screen UI).**
- 0a. One interpreter resolver (section 6.5) used by CLI, API and desktop. Fixes
  the Store-alias dead end and the API test failure on this host.
- 0b. Stop rewriting user files: session `script.origin = "user_file"`; sync
  writes a managed export copy; `workspace.export-python` becomes "Save
  canonical copy as..."; the texture panel's best-effort sync targets the same
  copy. Independent of the desktop and fixes today's `fullmag script.py` hazard.
- 0c. `fullmag script inspect <path> --json` (no execution, section 6.2).

**Phase 1: smallest honest slice (architecture A).** Pick (or choose a recent
script), see static facts without execution, press **Run in new window**, answer
the native trust prompt, get a Fullmag window with the model materialized and
waiting for COMPUTE, with the run recorded in the workspace database.

*Explicitly not promised in Phase 1:*
- editing the script inside the app, or any write to the user's `.py`;
- persisting scene edits made in that window back to the script;
- re-attaching to a running script after the hub or the window is closed
  (closing the window stops the run and records `cancelled`);
- one shared window (B), a run queue, GPU qualification, a sandbox;
- managing Python environments or installing packages (the resolver only reports);
- opening a script *without* executing it to view the scene (the scene needs the
  script's code; only static facts are available before consent);
- scripts that import their own sibling modules under the packaged isolated
  interpreter (reported by preflight, not supported).

**Phase 2.** Exact-bytes execution (loader executes the bytes it hashed),
"trust this file path" option, optional same-window mode B if the user wants it
and the handshake gate passes, run list on the start screen.

**Phase 3.** C: *Import script as project* with manifest and assets, re-run from
a frozen script, provenance in `project/provenance.json`.

**Phase 4 (research, no commitment).** D: fidelity survey of `examples/` against
the existing scene/script helpers; publish the pass rate; decide only then.

---

## 6. Exact contracts

### 6.1 Tauri commands (host, `apps/desktop/src-tauri`, typed wrapper in the kernel)

```ts
type ScriptTicket = string;               // 128-bit random, host-held, dies with the app

interface ScriptHandle {
  ticket: ScriptTicket;
  item_id: number | null;                 // workspace.db items.id once recorded
  name: string; display_path: string;     // no \\?\ prefix
  bytes: number; lines: number; sha256: string; modified_at: string;
  encoding: "utf-8" | "utf-8-bom" | "other";   // "other" => preflight error
}

script_pick(): Promise<ScriptHandle | null>              // native dialog, filter .py
script_open_recent(item_id: number): Promise<ScriptHandle>   // host re-reads path from DB; renderer sends no path
script_preflight(ticket): Promise<ScriptPreflight>       // no execution (6.2)
script_run(req: ScriptRunRequest): Promise<ScriptRunResult>
script_run_status(run_handle): Promise<ScriptRunStatus>
script_run_stop(run_handle): Promise<void>               // graceful, then tree kill after 10 s
script_trust_forget(item_id): Promise<void>
python_interpreter_status(): Promise<ResolvedInterpreter | InterpreterError>
python_interpreter_set(path: string | null): Promise<ResolvedInterpreter | InterpreterError>

interface ScriptRunRequest {
  ticket: ScriptTicket;
  requested: {                            // each field optional = "as written in the script"
    backend?: "auto" | "fdm" | "fem" | "hybrid";
    mode?: "strict" | "extended" | "hybrid";
    precision?: "single" | "double";
    device?: "auto" | "cpu" | "gpu";      // passed as FULLMAG_{FDM,FEM}_EXECUTION until the CLI has a flag
  };
  wait_for_solve: boolean;                // default true
  results: "managed" | "next_to_script";  // default managed; next_to_script requires confirm_overwrite
  confirm_overwrite?: boolean;
}
type ScriptRunResult =
  | { status: "started"; run_handle: string; pid: number; interpreter: ResolvedInterpreter }
  | { status: "declined" }                                    // native prompt cancelled; nothing spawned
  | { status: "refused"; code: "changed" | "syntax" | "interpreter" | "encoding" | "cli_missing"; detail: string };
```

The trust prompt is a **host-native** dialog inside `script_run` (title "Run
Python script?", body: file name, folder, first 12 hex of the hash, interpreter,
working directory, "runs with your user permissions; it can read and write files
and use the network", buttons *Run* / *Cancel*). The renderer cannot pre-answer
it. A remembered decision `(path_key, sha256)` skips the dialog only when the
person chose "remember" in a previous native prompt (open decision Q3).
Events: Tauri event `script-run:<run_handle>` with the `ScriptRunStatus` below.

```ts
interface ScriptRunStatus {
  state: "starting" | "materializing" | "waiting_for_solve" | "running" | "exited";
  exit_code?: number; receipt?: ScriptRunReceipt; window_open: boolean;
}
```

### 6.2 CLI (`fullmag-cli`)

New subcommand (must be added to `SUBCOMMANDS` in `main.rs:852` or it is parsed
as a script named `script`):

```
fullmag script inspect <path> --json [--python <abs path>]
  -> { "schema": "fullmag.script_inspect.v1",
       "sha256": "...", "bytes": N, "lines": N, "encoding": "utf-8",
       "syntax": {"ok": true} | {"ok": false, "line": N, "column": N, "message": "..."},
       "summary": "first docstring line" | null,
       "imports": {"fullmag": true, "unresolved": ["scipy"]},   // find_spec only
       "env_reads": ["FULLMAG_SP5_DEVICE", ...],                // literal os.environ keys via ast
       "declares": {"default_until": 1e-9 | null, "interactive": true | null},
       "interpreter": ResolvedInterpreter | InterpreterError }
```
Implementation: new helper command `inspect-script` (ast + `importlib.util.find_spec`,
never `exec_module`), plus a Rust-only degraded result when no interpreter is found.

Script-mode flags (additive; defaults keep today's behaviour):

| Flag | Meaning |
|---|---|
| `--ui <browser\|desktop\|none>` | default `browser`; `none` == `--headless` web side; `desktop` uses `open_in_tauri` with the API-instance pin |
| `--api-port <u16>` | explicit API port, replaces the `FULLMAG_API_PORT` env convention for this feature |
| `--wait-for-solve` | same gate as `FULLMAG_ATTACHED_WAIT_FOR_SOLVE`, as a flag |
| `--expect-script-sha256 <hex>` | abort with exit 11 before any execution if the bytes differ |
| `--receipt <path>` | write `fullmag.script_run_receipt.v1` on every exit path, atomically |
| `--launched-by <desktop\|cli\|python>` | hidden; when `desktop`, the CLI does **not** write the workspace DB |
| `--python <abs path>` | explicit interpreter, same validation as the resolver; ignored with a visible note when a packaged bundle owns Python |

Exit codes for a launched run: 0 ok, 1 other failure, 2 usage, 10 interpreter,
11 script changed, 12 syntax, 13 materialization or planning, 14 requested
runtime unavailable (no fallback was attempted), 130 stopped by user.

The run uses `-X utf8` (bundle) or `PYTHONUTF8=1` (otherwise) for the helper
children; this is a documented difference from a plain terminal run.

### 6.3 Receipt (`fullmag.script_run_receipt.v1`) and DB record

```json
{
  "schema": "fullmag.script_run_receipt.v1",
  "script": {"path": "C:/.../sp5.py", "path_key": "c:/.../sp5.py", "sha256": "...", "bytes": 4210,
             "modified_at": "2026-10-04T10:00:00Z"},
  "consent": {"mode": "prompt|remembered", "at": "...", "sha256_at_consent": "..."},
  "interpreter": {"path": "...", "version": "3.12.2", "source": "bundle|setting|env|venv|py-launcher|path",
                  "isolated": false, "fullmag": "0.1.0", "fullmag_import_ok": true},
  "process": {"cwd": "...", "argv_redacted": ["--interactive", "--wait-for-solve"], "pid": 1234},
  "requested": {"backend": "auto", "mode": "strict", "precision": "double", "device": "as_authored"},
  "resolved": {"backend": "fdm", "device": "cpu", "precision": "double", "mode": "strict",
               "runtime_family": "...", "engine_id": "...", "worker": "...", "fallback": null},
  "ids": {"session_id": "...", "run_id": "...", "problem_ir_source_hash": "..."},
  "results": {"dir": "...", "next_to_script": false},
  "outcome": {"status": "completed|failed|cancelled|not_started", "exit_code": 0,
              "duration_seconds": 12.3, "error": null}
}
```
`requested.*` records `auto` and "as_authored" literally; `resolved.fallback` is the
runtime's own record; a run whose `requested.device == "gpu"` and `resolved.device != "gpu"`
is `failed`. The host maps the receipt to DB: `open` on pick, `run` at the end
(`actor: desktop`, `detail` = the receipt without paths already in `items`,
`meta.last_run = {status, at, duration_seconds, device}`), single writer,
reconciled from `<state>/script-runs/*/receipt.json` after a crash. A hash mismatch
between `script.sha256` and `ids.problem_ir_source_hash` is surfaced in the
History view.

### 6.4 API (Phase 0b only; additive)

- `GET /v2/sessions/current` and the session status resource gain
  `script: { origin: "user_file" | "generated" | "none", path, sha256, writable }`.
- `POST /v2/sessions/current/model/syncs` for `origin == "user_file"` writes
  `<workspace_root>/exports/<name>.canonical.py` and returns
  `{ script_path, written_to: "export_copy", source_script_modified: false }`;
  `GET .../model/script` returns that copy. `rewrite-script --write` never
  targets a user file again.
- No operation that starts executing a file. Executing user code stays a host
  action behind native consent (R1, R2, fact 13). The API only reads/derives after
  a run was started by the host.

### 6.5 Interpreter resolver (`fullmag-runtime-control::python_runtime`)

```rust
pub struct ResolveRequest { pub root: PathBuf, pub explicit: Option<PathBuf>, pub need_fullmag: bool }
pub struct ResolvedInterpreter { path, version, source, isolated, fullmag_version: Option<String>, tried: Vec<Tried> }
pub enum InterpreterError { NotFound{tried: Vec<Tried>}, TooOld{found, min:"3.10"},
                            FullmagMissing{path}, BundleBroken{reason}, Unusable{path, reason} }
```
Order, first that **passes the probe** wins:
1. packaged bundle, whenever any ADR 0047 marker exists; no fallthrough, `explicit`
   and `FULLMAG_PYTHON` are reported as ignored;
2. `explicit` (setting `python.interpreter` in `kv`, or `--python`);
3. `FULLMAG_PYTHON`;
4. `<root>/.fullmag/local/python`, `<root>/.venv`;
5. Windows: `py -3.12`, then `py -3` (from `py -0p`); Unix: `python3`;
6. `python` on PATH; `python3` only on non-Windows.

Probe (timeout 10 s, `-I`-free, same env as the helper): `python -c "import sys,json;
print(json.dumps([sys.version_info[:3], sys.executable]))"`, then `import fullmag`
when `need_fullmag`. Reject any candidate under `\Microsoft\WindowsApps\` unless the
probe prints a parsable version (the alias answers with localized text and exit
9009). A candidate that spawns but fails the probe falls through to the next one
(the current bug). Result cached per process keyed by the request; the CLI, the
API and the host call this one function; `tried` goes into every error and into
the receipt.

---

## 7. Cross-cutting design decisions

**Execution boundaries.** Index, scan, list, inspector, `inspect`: parse only,
never import or execute. `export-scene-document`, `export-ir`, `export-run-config`
and a run execute user code and are reachable only from `script_run` (after
consent) or from sessions the host started. Child env: inherit the user's
environment (scripts legitimately read `FULLMAG_*`, see sp5) but add
`FULLMAG_LAUNCHED_BY=desktop`. The host must not forward its own private
runtime tokens (for example development-owner tokens) to the child; the exact
variable list is to be fixed when Phase 1 is implemented (not audited here).

**Working directory.** Script folder. Reason: relative reads in user code and
assets match the asset root the loader already uses. Differs from a CLI run
launched from the repo root; recorded in the receipt. Sibling imports work only
with a non-isolated interpreter (`python -m` puts the cwd on `sys.path`).

**Results location.** Managed: `<FULLMAG_STATE_ROOT>/script-runs/<run_id>/`. The
sibling `<script>.zarr` is opt-in with an overwrite confirmation naming the folder
that will be deleted (fact 5).

**Windows details.** `canonicalize()` yields `\\?\C:\...`: normalise before
`path_key` and before showing; paths with spaces and Polish characters must
survive argv (pass as separate args, never through a shell); BOM or non-UTF-8
scripts are rejected at pick with a precise message; job object with
kill-on-close; `CREATE_NO_WINDOW`; state root split: the workspace DB is under
`%APPDATA%\Fullmag` (07 §2) while runtime state is `%LOCALAPPDATA%\Fullmag`
(`python_runtime.rs:70`, `FULLMAG_STATE_ROOT`); receipts belong to the latter.

**Window lifecycle (A).** Closing the script window stops its run after the
window's own confirmation, records `cancelled`, kills the tree. Closing the hub
does not touch script windows; the hub's next start reconciles receipts. The
hub shows a "Running" chip per item from `script_run_status`.

**Trust store.** `items.meta.trust = {sha256, decided_at}`. The database is not a
security boundary against a local attacker (same user can edit it); it prevents
accidental runs and any use from a foreign local web page, which cannot answer a
native dialog.

**No silent fallback.** The desktop never rewrites a requested device. It
passes the request, reads `resolved.fallback`, and fails the run when GPU was
requested and not resolved. Selecting `auto` stays `auto` in the receipt.

---

## 8. Tests and gates

Unit tests cannot be compiled now; each gate names a non-unit check. Unit tests
should still be written and left unrun, as for the rest of the start screen.

| Phase | Gate | Pass condition |
|---|---|---|
| 0a | resolver probe on this host (`fullmag runtime python --json`, new) | resolves `python` (Miniconda 3.12.2) or `py`, never the Store alias; `tried` lists the alias as rejected |
| 0a | source check (extend `scripts/verify_control_room_sources.py`-style script) | no `"python3"` fallback literal outside the resolver; CLI and API call it |
| 0a | bundle fixture | a bundle marker with a missing `python.exe` returns `BundleBroken`, not a PATH fallback |
| 0b | managed fixture: open a script-backed session, call `model/syncs` | source file bytes identical before/after; export copy exists and parses |
| 0b | browser fixture | "Export Python DSL" on a user-file session produces a download from the copy and a file unchanged on disk |
| 0c | `inspect` on 5 examples incl. `mumax_standard_problem_5_fdm.py`, a syntax error, a BOM file | JSON schema valid; no marker file created by a script that writes on import (canary script) |
| 1 | consent | renderer cannot start a run without the native dialog; `script_run` with an unknown ticket is `refused`; changed bytes after consent give exit 11 and no Python process |
| 1 | isolation | a script run beside a running hub does not change the hub's current session (assert session id on both APIs) |
| 1 | requested vs resolved | receipt for `device: gpu` on a host without GPU is `failed`, `resolved.fallback` null, no CPU run started |
| 1 | results | default run leaves an existing `<script>.zarr` untouched; `next_to_script` without confirm is refused |
| 1 | Windows | path with spaces and `ł`, a UTF-8 BOM file, a script printing `α` and `µ`, kill of the tree on window close, receipt reconciliation after killing the host |
| 1 | browser (AGENTS viewport rule) | in the new window: visible canvas, WebGL context alive, non-zero drawing buffer, state `waiting_for_solve` reached |
| 1 | DB | after pick, run, crash: exactly one `open` and one `run` event, `use_count` +1, actor `desktop` |
| 2 | loader | file replaced between hash and exec: the executed bytes equal the hashed bytes |
| 3 | `.fms` | script document survives load/save unchanged; manifest hash matches; project open runs nothing |
| 4 | survey | pass-rate table over `examples/*.py` committed with the commands that produced it |

Anything not executed on a real packaged Windows install stays `NOT VERIFIED`.

---

## 9. Open questions for the user

1. **Window model.** Is a separate window per running script acceptable for Phase
   1, or must the script open in the hub window (architecture B, ~2x effort,
   replaces the current session)?
2. **Open without running.** Is "see the model" allowed to imply executing the
   script after consent (as designed), or do you want a view that never executes
   (then the scene preview is unavailable until Run)?
3. **Trust scope.** Per `(file, content hash)` with a prompt after every edit
   (default), per file path, or per folder? Which of these may be remembered?
4. **Results default.** Managed storage (default here) versus the CLI's sibling
   `<script>.zarr`. May the app ever delete an existing `<script>.zarr`?
5. **Interpreter policy.** On a development host, should the settings page let the
   person pick an interpreter (`python.interpreter`), and is "packaged Windows
   ignores it" acceptable given that user packages (numpy extras, own modules)
   then cannot be imported?
6. **Device selection.** The CLI has no `--device`; Phase 1 passes
   `FULLMAG_{FDM,FEM}_EXECUTION`. Do you want a first-class flag (a public CLI
   change) before Phase 1?
7. **Index scope.** Which `.py` files may the start screen list from scanned roots
   (only files importing `fullmag` in the first lines, or any)? Skipped
   directories (`.venv`, `site-packages`, `node_modules`)?
8. **Concurrent runs.** Cap on simultaneous script runs, and a warning when a GPU
   run is already active?
9. **State roots.** `FULLMAG_STATE_DIR` (07) and `FULLMAG_STATE_ROOT` (runtime)
   name two different roots; confirm that DB lives in the former and run
   receipts in the latter.
10. **Phase 0b first?** It changes behaviour of today's `fullmag script.py` +
    Export (file no longer rewritten). Confirm that is wanted before any desktop
    work.
