# FDM multilayer convolution documentation correction — implementation plan

> **For agents:** execute this plan inline with documentation-validator checks. All reports and documents are in English; symbol names, paths, and code remain in their original form.

**Goal:** Align the canonical physics note, public page, and source maps with the current `master`, showing real `two_d_stack`, `three_d`, `identity`, `push_pull`, supercell, and test examples with their evidence scope.

**Architecture:** Do not change the solver or API contract. Separate Lepadatu/BORIS theory, the computational FFT supercell, layered native/scratch grids, and CPU/GPU evidence status in the documentation. Pin every example to an existing test or scenario, and label missing independent evidence explicitly.

**Technologies:** Markdown/MyST, JSON source maps, Fullmag Python scenarios, Rust Cargo tests, and the `scientific-documentation-contract` validator.

## Global constraints

- Do not change Rust/CUDA/Python code or runtime semantics.
- Do not promote a GPU lane to `runtime-verified`, `physically-validated`, or `production-qualified` without managed device evidence.
- Describe the FFT supercell as a computational layout, never as a physical material mesh.
- For unequal `h_z`, distinguish pair-kernel evidence from the absence of a continuum/native-cell proof of composed `push_pull`.
- Every new claim in the note must have a `path + symbol` and test/evidence in the source map.

### Task 1: Establish current evidence

**Pliki:**
- Odczyt: `crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs`
- Odczyt: `crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs`
- Odczyt: `crates/fullmag-fdm-demag/tests/descriptors.rs`
- Odczyt: `crates/fullmag-engine/src/multilayer.rs`
- Odczyt: `tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/`

- [x] Run the kernel, descriptor, planner, and Python-scenario tests.
- [x] Record test names, results, and evidence scope; do not add numbers that the test does not emit.

### Task 2: Update the canonical physics note

**Pliki:**
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.md`
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.source-map.json`

- [x] Add a “How to read the supercell” section with the linear-extent equation, insertion offset, lag-zero, crop, and native/scratch distinction.
- [x] Add copyable test examples: unequal-Z Newell pair, `+z/-z` control, 3D reciprocity, unequal-XY rejection, and a `three_d` scenario with `push_pull`.
- [x] For every example, describe what it checks, its tolerance/condition, what it does not prove, and which lane remains open.
- [x] Correct the CPU/GPU matrix and map it to the current `HEAD` and stable test symbols.

### Task 3: Update the public page

**Pliki:**
- Modyfikuj: `public_docs/site/physics/interactions/demagnetization/multilayer-convolution.md`
- Modyfikuj: `public_docs/site/physics/interactions/demagnetization/multilayer-convolution.source-map.json`

- [x] Preserve the stage-first Python workflow and add separate examples for equal `two_d_stack`, full `three_d`, unequal grids with `push_pull`, and intentional rejections.
- [x] Explain the supercell with the small `[3,2,1]`/`[5,4,1]` example, `linear_extent=[7,5,1]`, crop, and `physical_mesh=false`.
- [x] Add a “test → observation → interpretation → boundary” table and the current CUDA-assisted/D-07/H2D-D2H status.
- [x] Update the source map without relying on handwritten lines as the sole identifier; current claims use the full SHA of the current `HEAD`, while historical sources retain full SHAs of the commits that introduced their symbols.

### Task 4: Publication validation

- [x] Run `validate_scientific_docs.py` for both pages and maps.
- [x] Run `validate_changed_scientific_docs.py` against the `HEAD` parent.
- [x] Run the public-example guard, validator tests, and strict/rendered-HTML Sphinx checks when the build environment is available.
- [x] Check `git diff --check`, the change status, and preservation of the existing `external_solvers/3` state.
