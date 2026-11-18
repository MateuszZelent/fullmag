---
title: Start Screen & Workspace Hub
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-start-screen)=
# Start Screen & Workspace Hub

The Control Room Start Screen (`apps/control-room/src/modules/start/StartScreen.tsx`) is the
non-blocking workspace hub served at `/home`. When an active session is already loaded in the
same Control Room instance, opening **Home** overlays the workspace rather than closing or
halting the running session, so switching back to the active session tab restores the live
workspace immediately.

```{image} /_static/images/ui/start-screen-hub-overview.png
:alt: Control Room Start Screen overview with navigation rail, launch tiles, active simulations, and compute environment widget
:align: center
:width: 100%
```

## Navigation Rail and Launch Tiles

The left `StartRail` (`apps/control-room/src/modules/start/rail/StartRail.tsx`) provides keyboard-navigable access (`ArrowUp`/`ArrowDown`, `Home`/`End`) across seven sections:

| Section ID | Rail label | Shortcut | Purpose |
|---|---|---|---|
| `home` | Overview | `Ctrl+1` | Primary launch tiles, interrupted checkpoint recovery, active sessions, recent projects, scripts, and results, and discovered instances |
| `templates` | Templates | `Ctrl+2` | Curated template catalog (`STUDY_TEMPLATES`) saved as `.py` scripts or launched directly |
| `import` | Import | `Ctrl+3` | Import workflows for `.mif`, `.mx3`, `.mph`, and `.fms` archives |
| `learn` | Learn | `Ctrl+4` | Guided onboarding and example workflows |
| `docs` | Docs | `F1` | Embedded documentation search view |
| `settings` | Settings | `Ctrl+,` | Workspace, recent-item filter, and compute-node policy settings |
| `about` | About | — | Control Room build and environment summary |

On the **Overview** screen, `LaunchTiles` (`apps/control-room/src/modules/start/home/LaunchTiles.tsx`) exposes five creation and entry tiles:

- **FDM simulation** (`start.new-fdm`, `Ctrl+N`): empty structured finite-difference problem.
- **FEM simulation** (`start.new-fem`, `Ctrl+Shift+N`): empty unstructured tetrahedral mesh problem.
- **From template** (`start.templates`, `Ctrl+T`): opens the benchmark and study template catalog (`µMAG`, dispersion, FMR, skyrmion templates).
- **Import** (`start.import`, `Ctrl+I`): imports external `.mif`, `.mx3`, `.mph`, or `.fms` models.
- **Open script…** (`start.open-script`): registers a Python `.py` script in the recent-work list with last-use and execution provenance (available when the desktop/script host exposes file picking).

A live `ComputeEnvironmentWidget` in the rail reports resolved host compute capabilities, node inventory, and GPU availability gathered from the compute probe (`useComputeProbe` and `useExecutionAvailability`).

## Model Templates and Script Creation

Selecting a card in the **Templates** section previews the template summary, estimated grid/mesh characteristics, and generated Python source in `TemplateDetails` (`apps/control-room/src/modules/start/inspector/TemplateDetails.tsx`). Users can export or save the `.py` script cleanly, or run the template script to create and activate a live workspace project via `createAndActivateScriptProject`.

```{image} /_static/images/ui/start-screen-model-templates.png
:alt: Control Room Start Screen Templates section showing benchmark presets and script inspection pane
:align: center
:width: 100%
```

## Continue, Active Simulations, Recent Work & Multi-Instance Discovery

Below the launch tiles, `StartScreen` surfaces four live operational panels:

1. **Interrupted checkpoint recovery (`ContinueCard`)**: Checks the active checkpoint index against current build capabilities. When resumable, displays simulation time progress and offers one-click resume (`study.restore-checkpoint`) or two-step confirmed discard (`study.discard-checkpoint`); when incompatible or unopened, withholds broken actions and explains why.
2. **Active simulations (`ActiveSessions`)**: Lists open sessions in the current instance—including external sessions created by Python scripts—with live lifecycle badges (`running`, `awaiting_command`, `waiting_for_compute`, `completed`, `failed`, `closed`) and a primary **Open simulation** button (`fm-start-continue`) for the current session.
3. **Recent projects, scripts, and saved results (`RecentProjects`)**: Displays recently opened `.fms` / workspace projects, tracked `.py` scripts (with run-script execution and text preview in `ScriptInspector`), and materialized `SolutionSet` results (`ResultInspector`) with side-by-side detail inspection in `ProjectInspector`.
4. **Other instances on this computer (`OtherInstances`)**: Queries host instance discovery (`useInstanceDiscovery`) and lists sibling FullMag instances (such as concurrent Docker DEV groups or local ports) with their active session status, port badge, and an **Open in tab** button (`tabRoutes` `/instance/<port>` or `?port=<port>`).

```{image} /_static/images/ui/start-screen-recent-sessions.png
:alt: Start Screen active simulations, recent projects and scripts, and sibling Control Room instances on the host
:align: center
:width: 100%
```

## Connecting from Live Python (`fm.connect`)

Sessions initiated from Python via `fullmag.live` appear automatically inside **Active simulations** and in the top session tab strip without requiring a manual page reload. A connected Python script attaches with a unique `python-<hex>` client ID and maintains a periodic heartbeat (`/v2/sessions/current/clients/{client_id}`) while streaming scene transactions, stage launches, and field queries:

```pycon
>>> import fullmag as fm
>>> session = fm.connect()
>>> # The attached session appears live in Start Screen -> Active simulations
```

```{image} /_static/images/ui/start-screen-python-live-connect.png
:alt: Control Room reflecting an active session driven by a connected Python live script
:align: center
:width: 100%
```

## Routes, fallbacks, and Python interoperability

- **Primary workspace route**: `/home` (`InstanceTabStrip` Home tab, or `workspace.home` from the menu bar).
- **Primary components**: `StartScreen`, `StartRail`, `LaunchTiles`, `ContinueCard`, `ActiveSessions`, `RecentProjects`, `OtherInstances`, `TemplateDetails`, `ScriptInspector`, and `ProjectInspector`.
- **Desktop script host fallback**: Desktop-only actions such as native OS file-picker `Open script…` or script launch from the browser fall back gracefully with an explicit disabled reason when no desktop script host is bound (`scriptRunHost.ts`).
- **Live Python attachment & script export**: Interactive session attachment uses `fm.connect(...)` implemented by `LiveSession` (`packages/fullmag-py/src/fullmag/live/_session.py`). Start-screen template exports emit canonical `fullmag` study-and-stage Python scripts compatible with headless execution.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Start screen shell & workspace integration | `apps/control-room/src/modules/start/StartScreen.tsx` | `StartScreen` |
| Left navigation rail & shortcuts | `apps/control-room/src/modules/start/rail/StartRail.tsx` | `StartRail`, `RAIL_SECTIONS` |
| Problem/template/import launch tiles | `apps/control-room/src/modules/start/home/LaunchTiles.tsx` | `LaunchTiles`, `LAUNCH_TILES` |
| Checkpoint recovery card | `apps/control-room/src/modules/start/home/ContinueCard.tsx` | `ContinueCard` |
| Open sessions in current instance | `apps/control-room/src/modules/start/home/ActiveSessions.tsx` | `ActiveSessions` |
| Sibling instance discovery list | `apps/control-room/src/modules/start/home/OtherInstances.tsx` | `OtherInstances` |
| Template script preview & project creation | `apps/control-room/src/modules/start/inspector/TemplateDetails.tsx` | `TemplateDetails` |
| Tab routing & `?port=` resolution | `apps/control-room/src/kernel/layout/tabRoutes.ts` | `parseTabRoute`, `formatTabRoute` |
