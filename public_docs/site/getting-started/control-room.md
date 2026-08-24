---
title: Control Room User Guide
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-control-room)=
# Control Room User Guide

The **FullMag Control Room** is the interactive web interface and authoring companion for FullMag.
It exposes the current session through an Explorer, Inspector, ribbon, 3D viewport, analysis docks,
and runtime status surfaces. Supported authoring changes are committed through the v2 model API and
can be exported as the canonical stage-first Python DSL. A visible but disabled control is not an
implemented capability, and backend execution remains capability-gated.

## Start a session

After completing {doc}`installation`, save a stage-first study script and launch it from the
repository root. For example:

```console
just fullmag build=True fdm cpu first_fdm_simulation.py
```

The launcher reuses a ready FullMag API and a matching Control Room frontend when they are already
available; otherwise it starts the missing service for this launch. It tracks only the API or
frontend process that it starts, and opening the page does not give it ownership of the browser
process. The authored engine and device remain requested intent; the status surfaces report the
resolved runtime separately.

---

## Workspace Layout Overview

The Control Room interface is structured into an ergonomic, high-density scientific workspace divided into seven specialized regions:

```{image} /_static/images/ui/control-room-workspace-overview.png
:alt: FullMag Control Room Workspace Overview
:align: center
:width: 100%
```

| Region | Component | Primary Purpose |
|---|---|---|
| **Top** | Ribbon Toolbar Strip | Render active command-registry actions for authoring, mesh, study, visualization, and export; unavailable actions remain disabled. |
| **Left** | Explorer Tree Panel | Inspect and navigate the hierarchical semantic tree of model objects, regions, materials, interactions, meshes, stages, and outputs. |
| **Center** | 3D Interactive Viewport | High-performance WebGL canvas displaying geometry meshes, magnetization vector field glyphs, colormaps, and spatial bounding boxes. |
| **Right** | Inspector Panel | Contextual property editor for configuring selected tree nodes, editing parameters with explicit draft isolation, and applying changes. |
| **Bottom** | Analysis & Live Charts Panel | Plot materialized scalar, table, and analysis resources published by the active session. |
| **Footer** | Status & Governance Bar | Show session connectivity, requested/resolved execution summaries, and stage or solver state exposed by v2 resources. |
| **Overlay** | Command Palette | Global `Ctrl+Shift+P` launcher for currently registered and enabled commands. |

---

## Ribbon Toolbar Strip

The **Ribbon Toolbar Strip** (`.fm-ribbon-bar`) organizes authoring controls into contextual tabs located along the top of the workspace.

### Geometry Tab

The **Geometry Tab** provides tools for building and transforming physical simulation domains.

```{image} /_static/images/ui/ribbon-tabs-geometry.png
:alt: Geometry Ribbon Tab
:align: center
:width: 100%
```

- **Active primitive drafts**: Add **Box**, **Thin Film**, **Cylinder**, and **Sphere** objects, then
  commit the validated draft with **Apply Draft**.
- **Mesh lifecycle**: A committed primitive can be shown before topology exists; **Build Mesh** is a
  separate backend command.
- **Current boundary**: Ellipsoid, Boolean composition, and direct move/rotate/scale ribbon tools are
  present as disabled controls in the current UI. This guide does not present them as available.

### Physics & Interaction Tab

The **Physics Tab** enables physical interactions and external drive fields.

```{image} /_static/images/ui/ribbon-tabs-physics.png
:alt: Physics Ribbon Tab
:align: center
:width: 100%
```

The interaction catalog and Inspector expose supported authoring forms for exchange,
demagnetization, external fields, anisotropy, DMI, transport/torque, and Oersted sources. Authoring
availability and executable backend support are separate: the active-session capability resource
and disabled reason determine whether a command can be committed or run. See the canonical
{ref}`interaction pages <public-docs-physics-interactions-root>` for physical and lane-specific
support contracts.

---

## Explorer Tree Panel

The **Explorer Tree Panel** (`.fm-explorer-shell`) on the left side of the workspace presents the hierarchical semantic structure of the simulation.

```{image} /_static/images/ui/explorer-tree-structure.png
:alt: Explorer Tree Structure Panel
:align: center
:width: 320px
```

### Tree Node Hierarchy

1. **Model Objects**: Parent containers for geometric bodies (e.g., nanowires, thin films, magnetic dots).
2. **Sub-Regions**: Distinct material zones inside a geometry object (e.g., core, shell, free layer, pinned layer).
3. **Material Assignments**: Applied physical material profiles (e.g., Permalloy $\mathrm{Ni}_{80}\mathrm{Fe}_{20}$, CoFeB, YIG).
4. **Physical Interactions**: Active energy terms governing LLG dynamics.
5. **Discretization & Meshing**: Grid spacing $(dx, dy, dz)$ for FDM or tetrahedral mesh parameters for FEM.
6. **Stages & Execution Workflows**: Ordered simulation sequence (e.g., `Relaxation` $\rightarrow$ `Field Sweep` $\rightarrow$ `RF Drive`).
7. **Outputs & Diagnostics**: Configured field snapshots, scalar logs, and solver performance monitors.

Selecting any node in the Explorer tree instantly focuses the corresponding properties in the **Inspector Panel**.

---

## Interactive 3D Viewport

The **3D Viewport** (`.fm-viewport-3d`) is a Three.js / WebGL rendering canvas that visualizes 3D magnetization vector fields, geometry meshes, and spatial field distribution.

```{image} /_static/images/ui/viewport-3d-interactive.png
:alt: Interactive 3D Viewport Displaying Magnetization Field
:align: center
:width: 100%
```

### Key Viewport Features

- **Vector Field Glyphs**: Render available vector quantities such as $\mathbf{m}$ or materialized
  field resources with bounded glyph budgets and explicit quantity identity.
- **Colormaps & Components**: Colorize supported scalar or vector-component views through the
  visualization resource, retaining the displayed quantity and unit.
- **Surface Projection Modes**: For thin films and multi-layer structures, switch between:
  - **Raw Nodal**: Direct node-based field interpolation.
  - **Surface Faces**: Projection onto top and bottom boundary faces.
  - **Thickness-Average ($z$)**: Depth-averaged 2D slice projection.
- **Bounding Box & Airbox Wireframe**: Overlay spatial dimensions, bounding box cages, and FEM Poisson airbox extent with hidden-edge visual semantics.
- **HUD & Camera Navigation**: Real-time HUD showing vector count, mesh element statistics, camera orientation gizmo, and view presets (Top, Front, Side, Isometric).

---

## Inspector Property Editor

The **Inspector Panel** (`.fm-inspector-shell`) on the right side of the workspace displays and edits properties of the currently selected tree node.

```{image} /_static/images/ui/inspector-panel-draft.png
:alt: Inspector Property Editor Panel
:align: center
:width: 340px
```

### Explicit Draft Editing Workflow

To prevent accidental simulation state corruption during live execution, the Inspector enforces an **Explicit Draft Workflow**:

1. Modifying numeric values or dropdown options puts the Inspector into **Draft Mode** (highlighted with an amber indicator border).
2. Click **Apply Draft** to submit the corresponding v2 model transaction. A successful commit
   refreshes the canonical scene; Python export serializes that authored state.
3. Click **Revert** to discard uncommitted edits and restore active session parameters.

### Configurable Parameter Groups

- **Material Parameters**: Saturation magnetization $M_{\text{s}}$, exchange constant $A_{\text{ex}}$, damping $\alpha$, gyromagnetic ratio $\gamma$.
- **Excitation Parameters**: Pulse rise time, frequency $f$, current density $\mathbf{J}$, bias field components.
- **Numerical Controls**: Integrator selection (`rk4`, `rk23`, `adaptive_heun`), error tolerances (`tolT`, `tolA`), maximum timestep $\Delta t_{\max}$.

---

## Status Bar & Session Governance

The **Status Bar** (`.fm-status-bar`) at the bottom footer of the window provides continuous operational feedback:

```{image} /_static/images/ui/status-bar-footer.png
:alt: Status Bar and Session Footer
:align: center
:width: 100%
```

- **Session Connectivity**: Indicates the live connection to the backend runtime. HTTP resources
  remain authoritative; realtime messages invalidate them rather than replacing them.
- **Active Engine & Device**: Displays active solver engine (**FDM** or **FEM**) and hardware lane (**CPU** or **GPU**).
- **Execution Progress**: Displays stage execution percentage, current step count, physical time $t$ (in picoseconds/nanoseconds), and solver speed (steps/sec).

---

## Command Palette & Keyboard Shortcuts

Press **`Ctrl + Shift + P`** anywhere in the workspace to launch the **Command Palette**:

- Search for commands by name (for example, *"Add Box"*, *"Export Python DSL"*, or
  *"Focus Primitive"*).
- Switch the workspace theme through **Toggle Theme**; the current themes are Catppuccin Mocha
  (dark) and Catppuccin Latte (light).
- Focus the selected primitive with **`F`** or frame the full scene with **`Shift + F`** when those
  commands are enabled for the current context.

## Current availability boundary

The Control Room is still capability-driven. It does not make every authored interaction,
visualization, solver, or device executable. Disabled controls and server rejection reasons are
part of the user contract; they must not be interpreted as hidden fallback. For the concise
ownership contract and links to detailed frontend pages, see {doc}`../frontend/control-room/index`.
