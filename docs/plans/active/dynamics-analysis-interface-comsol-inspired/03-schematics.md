# 03 - Schematics

These diagrams are original Fullmag schematics derived from the COMSOL interface
pattern. They intentionally do not copy COMSOL screenshots.

## COMSOL Construction Pattern

```mermaid
flowchart LR
  Tree["Model Builder tree"] --> Node["Selected node"]
  Node --> Settings["Settings property grid"]
  Node --> Study["Study / Solver settings"]
  Study --> Solution["Solution dataset"]
  Solution --> Results["Results tree"]
  Results --> Plot["Plot group / Surface / Line"]
  Plot --> Graphics["Graphics viewport"]
  Plot --> Tables["Tables / Derived values"]
```

## Fullmag Dynamics Workbench Pattern

```mermaid
flowchart LR
  Explorer["Explorer: dynamics resources"] --> Selection["Kernel selection"]
  Selection --> Inspector["Inspector: selected-node contract"]
  Selection --> Charts["Analysis plots"]
  Selection --> Overlay["Analysis field overlay"]
  Overlay --> Viewport["Unified 3D viewport"]
  Charts --> Selection
  Inspector --> Commands["Kernel command registry"]
  Commands --> API["ControlRoomApi facade"]
  API --> Resources["Revision-aware resource hooks"]
  Resources --> Explorer
  Resources --> Charts
  Resources --> Inspector
  Resources --> Viewport
```

## Solver Product Split

```mermaid
flowchart TD
  Family["Dynamics / frequency-domain analysis family"] --> Modal["Eigenmodes"]
  Family --> Driven["FrequencyResponse"]
  Modal --> Spectrum["Modal spectrum"]
  Modal --> Modes["Mode fields"]
  Modal --> Dispersion["Dispersion / branches"]
  Driven --> Sweep["Driven response sweep"]
  Driven --> ResponseFields["Response field payloads"]
  Driven --> Peaks["Driven peaks"]
  Spectrum --> Compare["Modal-driven comparison"]
  Peaks --> Compare
```

## Explorer Node Families

```mermaid
flowchart TD
  Root["Results / Dynamics Analysis"] --> Manifest["Manifest"]
  Root --> Equilibrium["Equilibrium source"]
  Root --> Eigen["Modal Eigenmodes"]
  Root --> Response["Driven Frequency Response"]
  Root --> Comparison["Comparison"]
  Eigen --> Spectrum["Spectrum"]
  Eigen --> Modes["Modes"]
  Eigen --> Branches["Branches"]
  Eigen --> Dispersion["Dispersion"]
  Eigen --> ModeFields["Mode fields"]
  Eigen --> EigenDiag["Diagnostics"]
  Response --> Sweep["Response sweep"]
  Response --> Points["Frequency points"]
  Response --> RespPeaks["Peaks"]
  Response --> RespFields["Response fields"]
  Response --> Observables["Susceptibility / absorbed power"]
  Response --> RespDiag["Diagnostics"]
  Comparison --> ModalDriven["Modal vs Driven Peaks"]
  Comparison --> Validation["Validation / Capability"]
```

## Study Setup Explorer Node Families

```mermaid
flowchart TD
  Setup["Study Setup / Active Simulation Stage"] --> Config["Dynamics Study Configuration"]
  Config --> EigenSettings["Eigenfrequency Solver Settings"]
  Config --> SweepSettings["Frequency Sweep Settings"]
  Setup --> DepVar["Dependent Variable Inheritance"]
  Setup --> PhysSolve["Physics Solve Selection"]
  PhysSolve --> LaneMmf["Micromagnetics mmf - locked"]
  PhysSolve --> LaneSolid["Solid Mechanics - gated"]
  PhysSolve --> LaneRF["RF Cavity - gated"]
  Setup --> Boundary["Boundary and Floquet Setup"]
  Boundary --> Periodic["Periodic pair source"]
  Boundary --> BZPath["Brillouin Zone k-path"]
```

> **Note:** All Study Setup nodes are **Phase 2** — they require backend stage transaction schemas (`stage.study_type`, `stage.solver.*`, `stage.dependencies.*`, `stage.physics.*`) that do not yet exist.

## Inspector And Viewport Handoff

```mermaid
sequenceDiagram
  participant User
  participant Chart
  participant Selection
  participant Inspector
  participant Overlay
  participant Viewport

  User->>Chart: click peak or mode
  Chart->>Selection: set frequency-domain selection ref
  Selection->>Inspector: render node-specific details (including overlap integral and Q-factor)
  Inspector->>Overlay: command plot selected field
  Overlay->>Viewport: selected field id + component + complex view + phase + wavevector k_F + floquetSpatialConvention
  Viewport->>Viewport: fetch/decode field resource, adapt phase sign via convention adapter, and render overlay
```

## Study Setup Transaction Handoff

```mermaid
sequenceDiagram
  participant User
  participant Inspector
  participant DraftStore
  participant CommandRegistry
  participant API
  participant Backend

  User->>Inspector: modify solver parameter (e.g. mode count)
  Inspector->>DraftStore: update draft stage field
  User->>Inspector: click Apply
  Inspector->>CommandRegistry: dispatch stage transaction command
  CommandRegistry->>CommandRegistry: check capability gate
  alt Capability supported
    CommandRegistry->>API: PATCH /v2/sessions/current/stages/{stageId}
    API->>Backend: commit transaction
    Backend-->>API: updated stage revision
    API-->>Inspector: success + new revision
  else Capability unsupported
    CommandRegistry-->>Inspector: rejection with stable diagnostic ID
    Inspector->>Inspector: render Capability Gated warning card
  end
```

> **Note:** The PATCH endpoint and backend transaction schemas are **Phase 2** and do not yet exist.

## Response Spectrum Controls

```mermaid
flowchart LR
  Sweep["magnetic_response_sweep.v2"] --> Points["Frequency points"]
  Points --> Component["Component selector: δmx / δmy / δmz / |δm|"]
  Component --> Quantity["Quantity selector: amplitude/phase/power/susceptibility"]
  Quantity --> Chart["One-unit chart series"]
  Points --> Table["Exact point table"]
  Chart --> Peak["Peak marker"]
  Peak --> Field["Response field resource"]
  Field --> ComplexView["real/imag/abs/phase/phase_rotated_real"]
  ComplexView --> Viewport["3D overlay with Floquet spatial phase"]
```

## Modal Spectrum Controls

```mermaid
flowchart LR
  Spectrum["eigen/spectrum.v2.json"] --> Mode["Selected mode"]
  Mode --> Component["Component selector: δmx / δmy / δmz / |δm|"]
  Mode --> Metrics["Freq (real/imag), Q-factor, damping, linewidth, residual, leakage"]
  Component --> ComplexView["real/imag/abs/phase/phase_rotated_real"]
  ComplexView --> ModeField["mode field resource"]
  ModeField --> Viewport["3D overlay / animation with exp(i k_F . (r - r0)) local phase shift"]
```

## Mode Visualization Under Model Tree

```mermaid
flowchart TD
  Model["Model"] --> Objects["Objects"]
  Objects --> Film["film"]
  Film --> Viz["Visualization"]
  Viz --> Surface["Surface / vectors / wireframe"]
  Viz --> ModeViz["Mode visualization"]
  ModeViz --> DrivenGroup["Driven response"]
  DrivenGroup --> Freq1["Frequency 2.875 GHz"]
  Freq1 --> Freq1Real["Real"]
  Freq1 --> Freq1Imag["Imag"]
  Freq1 --> Freq1Abs["Abs"]
  Freq1 --> Freq1Phase["Phase"]
  Freq1 --> Freq1PRR["Phase-rotated real"]
  ModeViz --> EigenGroup["Eigenmodes"]
  EigenGroup --> Mode0["Sample 0 mode 2"]
  Mode0 --> Mode0Real["Real"]
  Mode0 --> Mode0Imag["Imag"]
  Mode0 --> Mode0Abs["Abs"]
  Mode0 --> Mode0Phase["Phase"]
  Mode0 --> Mode0PRR["Phase-rotated real"]
```

> **Implementation status:** The Explorer tree nodes and `SelectionRef` types for mode visualization **already exist** in the codebase (`buildModelTree.ts`, `selectionTypes.ts`, `explorerSelection.ts`). The **missing piece** is inspector panel registration — `object.mode_visualization*` kinds fall through to `PlaceholderPanel`.
