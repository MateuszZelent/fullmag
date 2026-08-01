# Exchange publication API documentation design

## Objective

Make the Exchange page the reference implementation for public FullMag physics documentation. The page must render every inline symbol through MathJax and connect the scientific description to a complete, copyable Python DSL example and its canonical `ProblemIR` representation.

## Publication structure

The existing solver hierarchy remains authoritative: backend-neutral physics, FDM CPU, FDM GPU, FEM CPU, and FEM GPU. The page gains a Python authoring chapter before implementation details with four mandatory parts:

1. A complete `python` example organized as notebook-style `# %%` cells and executable without notebook prompts.
2. A parameter reference covering every public Exchange-facing constructor or object used by the example. Each row states type, default, SI unit, validation domain, physical meaning, and backend support.
3. A canonical `ProblemIR` excerpt generated from the example, followed by an explicit Python-to-IR mapping table.
4. Round-trip and failure semantics: normalization, validation errors, requested intent, planner-resolved execution, and unsupported combinations.

The documentation UI must expose a copy button for code blocks. The source remains ordinary MyST Markdown; Jupyter is an authoring pattern, not a second documentation runtime.

## Mathematical rendering

MyST is configured with `dollarmath`, so inline mathematics must use `$...$`. Display equations remain labelled `{math}` directives. The Exchange page must contain no `\\(...\\)` inline delimiters. A rendered-HTML check must prove that representative symbols in the parameter table become MathJax nodes rather than literal backslash text.

## Source-of-truth and completeness

Python examples and parameter tables must be derived from current public constructors, validation code, `ProblemIR` types, lowering code, planner capability checks, and tests. Documentation must not invent parameters or infer backend support from names. Stable references use repository path plus symbol; generated line numbers are supplementary.

The existing `scientific-documentation-contract` skill will be restored to the active skill set if absent and extended with mandatory gates for:

- executable or parsed copyable Python examples,
- exhaustive public parameter tables,
- Python DSL to `ProblemIR` mapping,
- requested-versus-resolved execution semantics,
- rendered MathJax verification,
- prohibition of raw inline LaTeX delimiters incompatible with the configured MyST extensions.

`physics-publication` will point to this contract so future physics pages cannot bypass it.

## Verification

The implementation is complete only when:

1. the strict public Sphinx build passes with warnings treated as errors;
2. the generated Exchange HTML contains rendered inline mathematics and copy controls;
3. every documented Python example parses and executes through lowering where runtime-independent;
4. documented `ProblemIR` output matches the current serializer or a normalized checked fixture;
5. the scientific documentation validator accepts the page and source map;
6. the skill validator and focused skill regression tests pass;
7. the GitHub Pages preview workflow succeeds before merge.

## Scope boundary

This change documents Exchange only and updates the reusable documentation contract. It does not add or alter physics, solver behavior, public Python API, `ProblemIR`, or backend capability.
