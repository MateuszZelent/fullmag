# Interaction-first physics documentation implementation plan

**Goal:** Replace backend-duplicated interaction documentation with one canonical page per physical interaction, preserve explicit FDM/FEM CPU/GPU realization truth, and publish the resulting menu on GitHub Pages.

**Design:** Follow `docs/superpowers/specs/2026-07-30-interaction-first-physics-documentation-design.md`. The public information-architecture manifest remains the executable source of the scaffold, while authored Exchange content and source-map evidence move to the canonical interaction path. Legacy backend URLs remain compatibility redirects, not scientific owners.

## Task 1: Encode the interaction-first contract in tests

**Files:**
- Modify: `scripts/test_public_docs_information_architecture.py`
- Modify: `scripts/public_docs_information_architecture.py`

1. Add failing assertions for unique canonical interaction ownership, the approved interaction list, the demagnetization and DMI subtrees, and absence of canonical backend-specific interaction pages.
2. Add assertions for legacy redirect coverage and sufficient rendered navigation depth.
3. Run the focused information-architecture tests and confirm they fail for the old tree.
4. Update the manifest model only far enough to make the new structural assertions pass.

## Task 2: Generate and migrate the public tree

**Files:**
- Modify: `public_docs/site/index.md`
- Modify: `public_docs/site/physics/index.md`
- Add: `public_docs/site/physics/interactions/**`
- Move: `public_docs/site/physics/exchange.md`
- Move: `public_docs/site/physics/exchange.md.sources.yaml`
- Remove from canonical ownership: `public_docs/site/physics/solvers/*/*/interactions/**`
- Modify/add redirect configuration or redirect pages as selected from existing Sphinx patterns

1. Generate the approved interaction-first scaffold from the manifest.
2. Move Exchange without losing equations, Python examples, source identities, labels, or source-map evidence.
3. Create focused planned scaffolds for all approved interactions and the detailed demagnetization/DMI subtrees.
4. Remove duplicated solver/backend interaction entries from public navigation.
5. Preserve every old published interaction URL through a redirect to the corresponding canonical interaction page.
6. Run structural, source-map, link, and strict Sphinx checks.

## Task 3: Align documentation governance

**Files:**
- Modify: `.agents/skills/scientific-documentation-contract/SKILL.md`
- Modify: `.github/skills/scientific-documentation-contract/SKILL.md`
- Modify if required: `AGENTS.md`
- Modify related documentation validators/tests where paths are encoded

1. Replace the old `domain → solver → backend → interaction` ownership rule with one canonical interaction owner.
2. Require an explicit FDM/FEM CPU/GPU support and qualification matrix inside authored interaction documentation.
3. Require separate realization chapters only for material implementation differences and subtrees for scientifically large topics.
4. Keep both skill copies byte-identical and validators fail-closed.
5. Run skill-mirror and scientific-documentation validation tests.

## Task 4: Verify rendered behavior and compatibility

1. Build the public site in strict mode with warnings treated as errors.
2. Inspect generated HTML to prove the sidebar contains `Physics → Interactions`, exposes the active branch, and does not list four backend copies.
3. Verify the canonical Exchange page renders equations, tables, API examples, and source links.
4. Verify all legacy interaction URLs redirect or resolve to canonical pages and none return 404.
5. Run the complete public-documentation gate set and review the final diff for unrelated changes.

## Task 5: Publish and verify production

1. Fetch `origin/master`, confirm the branch is not behind, and resolve only relevant drift if present.
2. Push the verified commit range directly to `master`, as explicitly authorized.
3. Monitor the `Public documentation` GitHub Actions workflow through deployment.
4. Verify the production canonical URLs, legacy redirects, and menu at `https://fullmag.mzelent.pl/`.

## Completion criteria

- One canonical page owns every interaction.
- The public menu is interaction-first and contains the approved demagnetization/DMI subtrees.
- Exchange content and evidence are preserved at the new canonical URL.
- FDM/FEM CPU/GPU truth remains explicit without duplicated equations.
- Strict local and GitHub Pages builds pass.
- Production and legacy URLs are verified after deployment.
