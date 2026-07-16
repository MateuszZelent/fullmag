# Stage Sampling Inspector Design

## Purpose

The stage inspectors for a field-drive antenna, `Table autosave`, `Autosave`,
`FFT response`, and `Run` must present a coherent sampling workflow rather
than a collection of raw SI inputs and repeated diagnostic tables.  The
authoring contract remains unchanged: stage instructions change state for a
following `Run`; the `Run` stage does not own or mutate that state.

## Scope

This design applies only to the Control Room authoring inspectors and their
shared presentation helpers.  It does not change `ProblemIR`, Python DSL,
planner, runtime, sampling policy, or OpenAPI semantics.

## Information hierarchy

Each affected inspector uses this order:

1. **Configuration** contains only editable inputs for that stage.
2. **Sampling plan** presents the effective state for the applicable next
   `Run`, without duplicating controls.
3. **Verification** presents the sinc waveform/source spectrum or response
   FFT clock only when the stage makes that information meaningful.
4. Warnings remain adjacent to the condition they explain and state the
   remediation.

`Run` shows a read-only effective sampling plan.  `Table autosave`,
`Autosave`, and `FFT response` show the plan resolved for their next `Run`.
The antenna inspector shows the source waveform and its compatibility with
the target `Run` clock.

## Sampling plan card

A shared, compact `SamplingPlan` presentation replaces the current repeated
`fm-sinc-preview__metrics` grids and individual diagnostic rows.  It has
three labelled groups:

| Group | Content |
| --- | --- |
| Source | explicit/automatic mode, originating stage, applicable sinc drives |
| Clock | `t_sampling`, sampling frequency, duration, sample count `N` |
| FFT limits | maximum sinc cutoff, target Nyquist, represented maximum bin, `df` |

Automatic mode uses a positive ready state when a valid source drive is
available.  An unresolved plan is a warning card with the exact reason and
source-drive status.  A manual plan is neutral and never described as an
automatic result.

## Units and numerical presentation

* All authored time, frequency, and field controls use a visible unit suffix.
* Internal values remain SI and are never rounded before being written to a
  draft or sent through a transaction.
* Read-only values use engineering prefixes (`fs`, `ps`, `ns`, `µs`; `MHz`,
  `GHz`, `THz`; `mT`) with up to four significant figures.
* Values outside the supported prefix range use scientific notation.
* Counts such as `N` remain integer, tabular numeric values without a unit.
* Chart axes and plot captions use the same formatter and explicit units.

## Visual and interaction rules

* Reuse `FormField` for stage controls so labels, units, focus treatment,
  help, disabled state, and validation follow the existing inspector system.
* Reuse the Catppuccin token system exclusively through `--fm-*` variables.
* Use compact cards with a clearly differentiated heading, description, and
  value.  Do not use a generic field-row table for scientific diagnostics.
* Keep the sinc waveform and source FFT visually paired, with a shared
  scientific plot treatment and understandable axis labels.
* Preserve native controls and their keyboard semantics; no custom select or
  toggle implementation is introduced by this work.

## Acceptance criteria

1. No affected stage inspector renders raw `Hz` or `s` numerical labels for
   time/frequency authoring controls where a unit-aware `FormField` is
   applicable.
2. One formatter is the source of truth for engineering/scientific display
   values in the sampling inspector family.
3. A ready automatic plan exposes source, cadence, `N`, `df`, and Nyquist
   information in one card; an unresolved plan exposes a remediation warning.
4. The stage workflow remains semantically identical: effective values are
   still calculated solely from preceding instructions for the next `Run`.
5. Focused inspector tests, formatting tests, TypeScript typecheck, lint, and
   a browser/screenshot check pass.
