# Physics-first Explorer, Results i Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Wdrożyć produkcyjną, physics-first architekturę Explorera, Results, Analysis, dedykowanych Inspectorów oraz wizualizacji modów zgodnie z zatwierdzoną specyfikacją.

**Architecture:** Revisioned resource hooks tworzą jawne typed snapshots, które przechodzą przez czyste klasyfikatory domenowe i czyste buildery drzewa. Selekcja przekazuje typed refs do dedykowanych Inspectorów, Analysis albo zunifikowanego Viewportu; UI nie zgaduje fizyki z nazw plików ani etykiet. Każdy wynik zachowuje run, stage, equilibrium, resource revision, kontekst k i provenance.

**Tech Stack:** Next.js 16, React, TypeScript, Vitest, Testing Library, Zustand, ECharts, Three.js/R3F, OpenAPI v2, Rust/Axum, CSS tokens `--fm-*`, Tailwind i współdzielone primitive shadcn/ui-style.

## Global Constraints

- Źródłem prawdy są `docs/physics/*`, `ProblemIR`, manifesty artefaktów i resource-first API v2.
- FMR, dyspersja i aktywność RF są nazywane wyłącznie przy wystarczającym dowodzie w typed kontrakcie.
- Wszystkie klasy CSS mają prefiks `fm-`; komponenty nie zawierają surowych kolorów.
- Nie wolno tworzyć fikcyjnych Recent Runs, Jobs, Resources ani wyników dla niewykonanego Study.
- Ustawienia koloru, gain, fazy i glifów są prezentacyjne i nie modyfikują danych ani fizyki.
- Każdy slice zaczyna się testem RED, kończy testami lokalnymi i ma mały, tematyczny commit.

---

### Task 1: Zamknąć kontrakt naukowy i decyzję architektoniczną

**Files:**
- Create: `docs/physics/0701-frequency-domain-result-classification.md`
- Create: `docs/adr/0023-physics-first-results-explorer.md`
- Modify: `docs/physics/index.md`
- Modify: `docs/adr/README.md`

- [ ] Opisać finite/open, Γ, fixed nonzero-k, path/grid, modal `f_n(k)`, driven `A(k,f)`, granicę nazw FMR oraz SI/display units.
- [ ] Dodać kompletne mapowanie producer → schema → API → frontend symbols i tabelę deferred contract gaps.
- [ ] Zapisać owner resources, status facets, migrację ID/preferences i removal gates w ADR.
- [ ] Uruchomić walidatory dokumentacji wskazane przez `scientific-documentation-contract` oraz test linków/indeksu.
- [ ] Commit: `docs: define physics-first result classification contract`.

### Task 2: Wprowadzić czysty klasyfikator częstotliwościowy

**Files:**
- Create: `apps/control-room/src/shared/domain/analysis/frequencyDomainResultClassification.ts`
- Create: `apps/control-room/src/shared/domain/analysis/frequencyDomainResultClassification.test.ts`
- Modify: `apps/control-room/src/shared/domain/analysis/analysisSurfaceDescriptor.ts`

- [ ] RED: fixture tests dla finite/open, Γ, fixed k, k path, k grid, modal coupling, qualified driven FMR i neutralnego response.
- [ ] Zdefiniować discriminated unions dla physical family, study product, k context, observable evidence i legalnych nazw.
- [ ] GREEN: zaimplementować funkcję czystą, fail-closed, bez analizy label/path/filename.
- [ ] Uruchomić pojedynczy test oraz typecheck dotkniętego modułu.
- [ ] Commit: `feat(control-room): classify frequency results by physics`.

### Task 3: Rozdzielić typed snapshots i trzy osie statusu

**Files:**
- Create: `apps/control-room/src/modules/explorer/builders/explorerTabSnapshots.ts`
- Create: `apps/control-room/src/modules/explorer/builders/explorerNodeState.ts`
- Create: `apps/control-room/src/modules/explorer/builders/explorerNodeState.test.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerStatusClass.ts`

- [ ] RED: przetestować priorytet prezentacji i zachowanie pełnych `resourceState`, `executionState`, `availability`.
- [ ] Wprowadzić typed snapshots Model/Results/Resources/Jobs/Diagnostics i immutable owner refs.
- [ ] Migrować descriptor węzła bez utraty diagnostyki i bez generycznego `status` jako źródła prawdy.
- [ ] Uruchomić test statusu, builderów oraz typecheck.
- [ ] Commit: `refactor(control-room): type explorer snapshots and status facets`.

### Task 4: Zbudować run/stage-scoped physics-first Results

**Files:**
- Create: `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.test.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`

- [ ] RED: utrwalić pełne drzewo Dynamics, Resonance & FMR, Dispersion, Hysteresis, Analysis Views, Derived Values, Tables, Exports.
- [ ] Przetestować stabilne ID oparte na run/stage/domain identity i brak wyników dla samej konfiguracji Study.
- [ ] Zbudować osobne gałęzie modal/driven, warunkowe coupling/FMR i fail-closed comparison.
- [ ] Usunąć stare równoległe drzewo po migracji selection refs.
- [ ] Uruchomić testy builderów i snapshot stabilności ID.
- [ ] Commit: `feat(control-room): build physics-first results tree`.

### Task 5: Dodać prawdziwy Result context bez fikcyjnej historii

**Files:**
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Create: `apps/control-room/src/modules/explorer/ResultContextSelector.tsx`
- Create: `apps/control-room/src/modules/explorer/ResultContextSelector.test.tsx`
- Modify: `apps/control-room/src/modules/explorer/explorerStore.ts`
- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`

- [ ] RED: selector pokazuje current run i tylko jawnie dostępne run identities; brak katalogu daje uczciwy unavailable state.
- [ ] Zaimplementować compact selector nad Results z SSR-safe state i migracją preference.
- [ ] Nie dodawać endpointu historii bez kanonicznego backend ownera; udokumentować contract gap w UI/Diagnostics.
- [ ] Uruchomić testy store, hydration i Result selector.
- [ ] Commit: `feat(control-room): scope results to explicit run context`.

### Task 6: Zmigrować selection refs i zagwarantować dedykowany Inspector routing

**Files:**
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.test.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorTypes.ts`

- [ ] RED: każdy selekcjonowalny kind ma dokładnie jeden typed route lub jawny unsupported route.
- [ ] Przenieść run/stage/equilibrium/resource/k/f/observable refs przez selection adapter.
- [ ] Usunąć generyczne fallbacki udające semantycznie poprawny panel.
- [ ] Uruchomić completeness, selection i Inspector registry tests.
- [ ] Commit: `refactor(control-room): route result selections to typed inspectors`.

### Task 7: Ujednolicić profesjonalny template Inspectorów

**Files:**
- Create: `apps/control-room/src/modules/inspector/components/ScientificInspectorTemplate.tsx`
- Create: `apps/control-room/src/modules/inspector/components/ScientificInspectorTemplate.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/InspectorShell.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`

- [ ] RED: breadcrumb, physical/method badges, trzy statusy, właściwości z jednostkami, akcje, provenance i diagnostics są dostępne oraz responsywne.
- [ ] Wyodrębnić wyłącznie wspólne primitive, typography, spacing, status rows i action bar ze wzorca Visualization.
- [ ] Sprawdzić 200% zoom, narrow dock, keyboard order i brak poziomego overflow.
- [ ] Uruchomić DOM/accessibility/CSS contract tests.
- [ ] Commit: `feat(control-room): add scientific inspector template`.

### Task 8: Wdrożyć dedykowane Inspectory częstotliwościowe

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainEigenSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainResponseSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/FrequencyDomainResultInspectors.test.tsx`

- [ ] RED: osobne modele/panele dla spectrum, mode, coupling, response, peak, point, field, dispersion, k sampling, branch, map i comparison mismatch.
- [ ] Pokazać equilibrium, phasor convention, normalization, backend/device/precision, readiness, validated scope i contract gaps.
- [ ] Zagwarantować, że eigenmode bez coupling nie jest FMR-active, driven point nie jest eigenmodem, a fixed k nie jest dispersion relation.
- [ ] Uruchomić testy paneli i route coverage.
- [ ] Commit: `feat(control-room): add dedicated frequency result inspectors`.

### Task 9: Dokończyć Inspector wizualizacji modów

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainModeDisplayControls.tsx`
- Modify: `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts`
- Modify: `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayPhaseAnimation.ts`
- Modify: `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayPhaseAnimation.test.ts`

- [ ] RED: płynny slider fazy, wpis numeryczny, play/pause, speed, direction, loop i reset mają spójny, keyboard-accessible stan.
- [ ] Dodać reprezentacje Real/Imag/Amplitude/Phase/phase-rotated real oraz komponenty magnitude/x/y/z capability-aware.
- [ ] Dodać palette, auto/manual range, symmetric signed range, clamp, display gain, vector scale i bounded vector density z legendą oraz jednostką.
- [ ] Rozdzielić artifact normalization od visualization gain i oznaczyć oba w provenance.
- [ ] Rekonstruować fazor lokalnie z cache; faza/animacja nie wykonuje refetch ani time integration.
- [ ] Uszanować reduced motion i zatrzymywać RAF po ukryciu/unmount.
- [ ] Uruchomić unit, interaction i lifecycle tests.
- [ ] Commit: `feat(control-room): complete interactive mode visualization inspector`.

### Task 10: Przebudować Analysis na stabilne powierzchnie fizyczne

**Files:**
- Modify: `apps/control-room/src/kernel/workspace/analysisViewPreferences.ts`
- Modify: `apps/control-room/src/kernel/workspace/analysisViewPreferences.test.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisSurfaceTabs.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.comparison.test.tsx`

- [ ] RED: top-level Dynamics, Resonance & FMR, Dispersion, Hysteresis, Comparison oraz legalne kontekstowe subviews.
- [ ] Migrować preferences atomowo ze starych IDs i nie utrzymywać dwóch aktywnych słowników.
- [ ] Pokazać dataset, run/stage/equilibrium, k context, observable, osie, SI/display units i compatibility verdict.
- [ ] Zapewnić scrollable tabs i compact subview control dla narrow dock.
- [ ] Uruchomić Analysis unit/integration/accessibility tests.
- [ ] Commit: `feat(control-room): organize analysis by physical result family`.

### Task 11: Domknąć handoff 3D i Active Analysis Overlay

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts`
- Modify: `apps/control-room/src/kernel/visualization/analysisFieldOverlayCommandContributions.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Create: `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayContext.test.ts`

- [ ] RED: overlay zachowuje run/stage/field/source/k/f/representation/phase/provenance i wykrywa obcy result context.
- [ ] Zastąpić katalog wyników w Model → Visualization jednym Active Analysis Overlay.
- [ ] Dodać ostrzeżenie i jawne clear/rebind po zmianie context; bez cichego pozostawienia obcego pola.
- [ ] Zachować jakość renderingu, opacity contracts i complex projection cache.
- [ ] Uruchomić overlay, viewport-model i browser WebGL smoke.
- [ ] Commit: `feat(control-room): bind active analysis overlay to result context`.

### Task 12: Zastąpić placeholdery Resources, Jobs i Diagnostics typed zasobami

**Files:**
- Create: `apps/control-room/src/modules/explorer/builders/resourceExplorerNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/jobExplorerNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/diagnosticExplorerNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/runtimeExplorerNodes.test.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`

- [ ] RED: empty/unavailable states nie wyglądają jak opublikowane dane lub kolejka.
- [ ] Budować Resources z resource key/schema/revision/generation/owner/size/cache/location.
- [ ] Budować Jobs wyłącznie z realnego run/stage/command lifecycle oraz requested/resolved execution.
- [ ] Budować Diagnostics z problemów, health, capability, solver, mesh, frequency-domain i performance evidence.
- [ ] Uruchomić builder i stale/error tests.
- [ ] Commit: `feat(control-room): build runtime-backed resource and job trees`.

### Task 13: Uczynić postprocessing first-class bez fałszywej trwałości

**Files:**
- Create: `apps/control-room/src/shared/domain/analysis/postprocessingDefinitions.ts`
- Create: `apps/control-room/src/shared/domain/analysis/postprocessingDefinitions.test.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`

- [ ] RED: Analysis View, Derived Value, Table i Export odnoszą się do dataset/resource identity i nie kopiują payloadów.
- [ ] Wykorzystać wyłącznie istniejących właścicieli; brak persistent ownera pokazać jako jawny contract gap.
- [ ] Dodać dedykowane Inspectory i legalne akcje dla dostępnych definicji.
- [ ] Uruchomić domain, builder i Inspector coverage tests.
- [ ] Commit: `feat(control-room): expose owned postprocessing definitions`.

### Task 14: Performance, responsive i końcowa weryfikacja produkcyjna

**Files:**
- Modify: `apps/control-room/scripts/audit-chart-performance.mjs`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisPlotsPerformanceAuditScript.test.ts`
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`
- Modify: `apps/control-room/src/modules/inspector/inspectorSmokeScript.test.ts`

- [ ] Zachować istniejące niezależne zmiany w dwóch plikach audytu performance i zintegrować je bez nadpisania.
- [ ] Uruchomić formatter, lint, typecheck, API/resource hygiene, architecture checks i pełny zakres dotkniętych testów.
- [ ] Uruchomić desktop i narrow browser smoke: drzewo, każdy Inspector, Analysis, handoff 3D, widoczny canvas, zdrowy WebGL, niezerowy drawing buffer.
- [ ] Uruchomić stress audit przełączający surfaces, result contexts i 3D; potwierdzić powrót instancji, requestów, observerów, workerów i chart-owned RAF do baseline.
- [ ] Uruchomić `react-doctor`, naprawić regresje w zakresie zmiany i ponowić wszystkie bramki.
- [ ] Sprawdzić `git diff`, brak orphan kinds, starych IDs, generycznych fallbacków, placeholderów runtime i nieprefiksowanych klas.
- [ ] Commit: `test(control-room): verify physics-first results workflow`.

## Definition of Done

- Wszystkie 14 kryteriów akceptacji specyfikacji ma bezpośredni test lub browser evidence.
- Implemented, production-executable i validated są potwierdzone oddzielnie.
- Branch zawiera dokumentację fizyki, ADR, kod, testy i dowody smoke/performance; nie zawiera fikcyjnych zasobów ani niezamkniętych regresji.
- Zatrzymany zostaje wyłącznie proces dev-server uruchomiony przez ten plan; cudze procesy pozostają nietknięte.
