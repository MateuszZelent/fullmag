---
title: Current and Excitations
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-root)=
# Current and Excitations

Current and excitation pages cover current transport, prescribed currents, regional field drives,
and radio-frequency or microwave drives such as a microstrip or coplanar waveguide antenna.

```{toctree}
:maxdepth: 1

current-transport
prescribed-current
regional-field-drive
rf-drive
microstrip-antenna
cpw-antenna
```
## Control Room crosswalk

Control Room splits excitation and current authoring across dedicated Semantic Inspectors governed by
active-lane capabilities:

- **Antennas & RF Waveforms (`Model Explorer -> Objects -> <antenna>`)**: `AntennaObjectPanel` and its `antenna/*` sub-panels (`AntennaPortComposer`, `AntennaFieldSolveAuthoring`, `AntennaConductorAuthoring`, `AntennaExternalLeadInspectionPanel`, `AntennaFieldBasisPreview`) configure conductors, ports, piecewise or analytical waveforms (`sinc`, `sinusoidal`), and solved magnetic field-basis overlays, while `RegionalFieldDrivePanel` handles spatially localized field drives with `SincPulsePreview`.
- **Current & Spin Transport / Spin Torques**: `TransportAuthoringInspector` authors `current_transport` and `spin_transport` records and validation requests (`transport-authoring-validation.v1`), while `SpinAuthoringInspector` configures Slonczewski, Zhang–Li, prescribed SOT, and Oersted sources.

`TODO: frontend support` applies to excitation parameters or specialized solver closures without a
matching inspector control; child pages identify exact boundaries. See {doc}`/frontend/capability-register`
and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

```{image} /_static/images/ui/inspector-antenna-rf-and-waveforms.png
:alt: Antenna and RF Waveform inspector showing conductor placement, port composition, and waveform settings
:align: center
:width: 100%
```

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Current transport, spin transport, and SOT/STT spin-torque inspectors in Control Room
:align: center
:width: 100%
```

## API and source scope

This is a navigation page with no standalone constructor. Each child page owns its exact Python signature, units, failure semantics, bibliography, and source-code index.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
