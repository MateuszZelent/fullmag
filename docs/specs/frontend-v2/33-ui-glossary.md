# Control Room UI Glossary

**Status:** Accepted vocabulary for user-facing labels
**Date:** 2026-10-20
**Scope:** menu, ribbon, Explorer, Inspector, status bar, empty states and command feedback in `apps/control-room`.

This glossary fixes the meaning of user-facing terms. It does not change physics or API semantics. Physics is defined in `docs/physics/`, API shapes in `docs/specs/resource-first-control-room-api-v2.md`. When a label and this glossary disagree, fix the label. When this glossary and a physics note or API contract disagree, the physics note or contract wins and this file is updated.

## Rules for labels

- Use one term for one concept across menu, ribbon, Explorer, Inspector and messages. The ribbon may use a shorter label (for example "Compute") when its tooltip names the full term ("Compute Study").
- User-facing validation and feedback text uses the field label shown in the Inspector ("Adaptive dt max"), not the internal key (`dt_max`). Machine codes may appear only as secondary detail, for example "Code: bounded" under the message.
- A disabled action shows the reason for being disabled on hover and on keyboard focus. Where the reason is known, it replaces the static tooltip.
- An empty state either says what to do next or, when a registered command can do it, offers that command as a button (CTA). Correct instruction text on its own is acceptable; a CTA is added only when a real command exists.

## Domain and mesh

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Universe** | The whole simulated domain and its domain/mesh policy (`study.universe_mesh`, `GET /model/universe`). It bounds every scene object. In FDM it determines the grid extent; in FEM it determines the shared-domain mesh. | A scene object. The Universe is not authored as an object and has no `object_id`. |
| **Airbox** | The non-magnetic part of the Universe that surrounds the magnetic objects. In FEM it is meshed as the air region (mesh parts with `role="air"`, `scope_kind=airbox`) and carries the demagnetizing field outside magnets. In the Inspector it is edited through the Universe policy. | Universe as a whole. "Airbox policy" means the part of the Universe policy that controls the surrounding air region, not a separate resource. |
| **Object** | An authored scene entity with an immutable `object_id`, a user-facing `name` and a presentation `type`. Physics is activated only by explicitly authored modules, never by name or type. | Region. |
| **Region** | A sub-part of an object with its own geometry and optional material overrides or mesh policy. Region identity (`region_id`) is not an element marker or a global node index. | Mesh part. |

## Running work

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Compute Study** (ribbon: "Compute", command `study.run`, F5) | Runs the study stages on the solver. A submitted command is first *accepted* (ACK, shown as "submitted") and only later *completed*; the UI must not treat the ACK as completion. | Compute Fields. |
| **Compute Fields** (`study.compute-fields`) | Materializes field quantities (for example `H_demag`, `H_eff`) for the current magnetization. It does not advance time, does not run relaxation and does not change magnetization. | Compute Study, or switching the displayed quantity (switching already published data is local and never a command). |
| **Compute Energies** (`study.compute-energies`) | Evaluates energy terms for the current magnetization without running the study. | Compute Study. |
| **Prepare** (`study.prepare-live`) | Materializes the scene preparation (mesh, operators) for the live session without starting the solver. | Compute Study. |
| **Run stage** | A study stage that advances magnetization dynamics in time (full LLG, "until time"). Added with "Add run stage" (`study.add-run-stage`). | "Run" as a verb for any command. Avoid "run" for Compute Fields. |
| **Solve** | The backend execution of a study or command. Use it in technical messages ("the solve failed"), not as a separate button. | Compute Study (the button that requests a solve). |

## Equilibrium

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Relax** | Bringing magnetization to equilibrium by integrating damped dynamics, for example overdamped LLG (`llg_overdamped`) or LLG relaxation with stop criteria. It has a time step policy (fixed or adaptive dt). | Minimize. |
| **Minimize** | Direct energy minimization (for example projected-gradient Barzilai–Borwein, PG-BB) without physical time. It has iteration and tolerance controls but no time step. | Relax. A minimizer result has no physical trajectory. |

## Command feedback

| Term | Meaning |
|---|---|
| **Submitted** | The command was accepted (ACK) or is waiting for backend publication. It is not a success. |
| **Unavailable** | The command could not start; the message is the disabled reason. |
| **Failed** | The command, or the backend completion observed afterwards, reported an error. A failure has exactly one foreground presentation with a link to Diagnostics. |
| **Cancelled** | The session changed or the user cancelled. No foreground notice is shown. |

Surfaces that render a command result inline (Inspector status lines, chart panels) own its presentation. Menu, ribbon, shortcut, palette and Explorer invocations are presented by the shell feedback presenter (`CommandFeedbackController` → `CommandFeedbackPresenter`). Notices belong to one session scope and are discarded when the session changes.
