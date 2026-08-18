# Przebudowa Inspectora wizualizacji — plan wdrożenia

> **Dla agentów:** wykonuj zadania kolejno, test-first. Każdy punkt kończy się niezależną weryfikacją.

**Cel:** Przenieść `Status`, `Physical properties`, `Provenance` i `Target` pod operacyjne kontrolki Inspectora wizualizacji, zachowując wspólny kontrakt pozostałych Inspectorów.

**Architektura:** Wspólny komponent naukowego Inspectora dostanie rozdzielone elementy tożsamości i kontekstu, ale jego istniejący komponent kompozytowy zachowa dotychczasowy układ dla innych paneli. `VisualizationTargetInspectorPanel` użyje nagłówka na początku i kontekstu na końcu; zmiana będzie w DOM, bez CSS `order` i bez zmian resource hooków.

**Technologie:** React 19, TypeScript, Vitest, `renderToStaticMarkup`, istniejące `InspectorGroup` i tokenowy CSS `fm-*`.

## Ograniczenia globalne

- Zakres funkcjonalny pozostaje ograniczony do Inspectora wizualizacji.
- `ScientificInspectorTemplate` nie może zmienić kolejności innych paneli.
- Wszystkie cztery sekcje kontekstu są zwijalne i domyślnie zamknięte w panelu wizualizacji.
- Zachować `Apply edits to child regions` w grupie `Target`.
- Nie dodawać fetchowania, endpointów ani nowych zasobów.
- Nie zmieniać domyślnej jakości ani ustawień renderowania.
- Nowe klasy CSS muszą mieć prefiks `fm-`; preferować istniejące klasy.

---

### Zadanie 1: Rozdzielenie tożsamości i kontekstu komponentu naukowego

**Pliki:**

- Zmodyfikuj: `apps/control-room/src/modules/inspector/components/ScientificInspectorTemplate.tsx`
- Test: `apps/control-room/src/modules/inspector/components/ScientificInspectorTemplate.test.tsx`

**Interfejs:**

- Dodaj eksport `ScientificInspectorIdentityProps` oraz komponent `ScientificInspectorIdentity`, który renderuje breadcrumbs, tytuł i badges.
- Dodaj eksport `ScientificInspectorContextProps` oraz komponent `ScientificInspectorContext`, który renderuje Status, Physical properties, Provenance i Diagnostics; przyjmij opcjonalne `collapsible` i `defaultOpen`.
- `ScientificInspectorTemplate` ma używać obu nowych elementów w dotychczasowej kolejności, z domyślnym `collapsible=false`, aby istniejące Inspectory nie zmieniły zachowania.

- [ ] **Krok 1: Dodaj test RED dla rozdzielonych fragmentów.**

```tsx
it("renders identity separately from an optionally collapsed context", () => {
  const identity = renderToStaticMarkup(
    <ScientificInspectorIdentity
      breadcrumbs={["Model", "Visualization"]}
      methodLabel="Display controls"
      physicalLabel="Airbox"
      title="Airbox visualization"
    />,
  );
  const context = renderToStaticMarkup(
    <ScientificInspectorContext
      collapsible
      defaultOpen={false}
      properties={[{ label: "Target scope", value: "Airbox" }]}
      provenance={[{ label: "Target ID", value: "airbox" }]}
      status={{ availability: "available", execution: "interactive", resource: "ready" }}
    />,
  );

  expect(identity).toContain("Airbox visualization");
  expect(identity).toContain("Display controls");
  expect(context).toContain('data-collapsible="true"');
  expect(context).toContain('data-open="false"');
  expect(context).toContain("Status");
  expect(context).toContain("Provenance");
});
```

- [ ] **Krok 2: Uruchom test RED.**

Uruchom:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/inspector/components/ScientificInspectorTemplate.test.tsx
```

Oczekiwany wynik: FAIL, ponieważ nowe eksporty jeszcze nie istnieją.

- [ ] **Krok 3: Wprowadź minimalną implementację.**

Przenieś istniejące fragmenty JSX do dwóch komponentów bez zmiany tekstów, wartości pól ani klas. `ScientificInspectorTemplate` składaj tak:

```tsx
<div className="fm-scientific-inspector">
  <ScientificInspectorIdentity
    breadcrumbs={breadcrumbs}
    methodLabel={methodLabel}
    physicalLabel={physicalLabel}
    title={title}
  />
  <ScientificInspectorContext
    diagnostics={diagnostics}
    properties={properties}
    provenance={provenance}
    status={status}
  />
  {children ? <div className="fm-scientific-inspector__content">{children}</div> : null}
  {actions ? <div className="fm-scientific-inspector__actions">{actions}</div> : null}
</div>
```

`ScientificInspectorContext` ma przekazać `collapsible` i `defaultOpen` do każdej z obecnych grup kontekstu; przy `defaultOpen=false` wszystkie grupy otrzymują `collapsible` i są zamknięte.

- [ ] **Krok 4: Uruchom test GREEN i regresję komponentu.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/inspector/components/ScientificInspectorTemplate.test.tsx
```

Oczekiwany wynik: wszystkie testy pliku PASS.

---

### Zadanie 2: Zastosowanie wariantu A w panelu wizualizacji

**Pliki:**

- Zmodyfikuj: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx`

**Interfejs:**

- `VisualizationTargetInspectorPanel` renderuje `ScientificInspectorIdentity` na początku.
- Dla gotowego targetu renderuje wszystkie istniejące kontrolki i override'y, a następnie `ScientificInspectorContext collapsible defaultOpen={false}`.
- Dla braku targetu, baseline loading i kontekstu planar zachowuje tę samą treść, ale przenosi kontekst na dół danego drzewa JSX.

- [ ] **Krok 1: Dodaj test RED kolejności DOM.**

W `ObjectVisualizationPanel.route.test.tsx` rozszerz mock `InspectorGroup` o `data-collapsible` i `data-open`, a następnie dodaj test sprawdzający indeksy:

```tsx
it("places visualization controls before scientific context", () => {
  testState.discretization = "fdm";
  const html = renderResolvedInspector(selection);

  expect(html.indexOf("Display controls")).toBeLessThan(html.indexOf("Display passes"));
  expect(html.indexOf("Display passes")).toBeLessThan(html.indexOf("Status"));
  expect(html.indexOf("Status")).toBeLessThan(html.indexOf("Target"));
  expect(html).toContain('data-collapsible="true" data-open="false"');
});
```

Jeżeli mock sekcji nie emituje tekstu `Display passes`, zastąp go stabilnym `data-slot="visualization-display-passes"`; test ma sprawdzać realny DOM kolejności, nie implementację CSS.

- [ ] **Krok 2: Uruchom test RED.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx
```

Oczekiwany wynik: FAIL, ponieważ Status i Target są jeszcze renderowane przed kontrolkami.

- [ ] **Krok 3: Zmień tylko kompozycję panelu.**

W każdej gałęzi `VisualizationTargetInspectorPanel` zastąp pełny `ScientificInspectorTemplate` fragmentem identity. W głównej gałęzi umieść context po `VisualizationOverridesSection`; w gałęziach `no target`, `loading` i `planar` umieść go po ich ostatnim fragmencie treści. Nie zmieniaj funkcji `patch`, `resetTarget`, `useObjectVisualizationPanelState`, wartości statusu ani propsów sekcji.

- [ ] **Krok 4: Uruchom test GREEN i testy stanów.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx src/modules/inspector/components/ScientificInspectorTemplate.test.tsx src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx
```

Oczekiwany wynik: wszystkie testy PASS, a routing Airbox/object/mesh-part pozostaje rozdzielony.

---

### Zadanie 3: Weryfikacja jakości UI i lifecycle

**Pliki:**

- Sprawdź bez zmian: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Sprawdź bez zmian: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Testy: `apps/control-room/src/modules/inspector`, `apps/control-room/src/modules/viewport-3d`

- [ ] **Krok 1: Sprawdź kontrakt CSS i formatowanie.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/inspector/inspectorCssContract.test.ts src/modules/inspector/inspectorRouteCoverage.test.ts
git diff --check
```

- [ ] **Krok 2: Uruchom typecheck aplikacji.**

```bash
pnpm --dir apps/control-room typecheck
```

Oczekiwany wynik: exit code 0.

- [ ] **Krok 3: Uruchom kontrolę React Doctor dla zmienionych plików.**

```bash
cd apps/control-room && npx react-doctor@latest --verbose --scope changed
```

Nie akceptuj regresji wyniku względem stanu bazowego.

- [ ] **Krok 4: Wykonaj browser smoke Inspectora i viewportu.**

Sprawdź w przeglądarce: kolejność nagłówka, kontrolek i zamkniętych grup kontekstu; po przełączeniu Points/Wireframe/Vectors potwierdź widoczny canvas, brak utraty WebGL i niezerowy drawing buffer.

- [ ] **Krok 5: Zatrzymaj się przed commit jeżeli live browser pozostaje niedostępny.**

W takim przypadku raportuj brak dowodu browserowego; nie nazywaj zmiany produkcyjnie zweryfikowaną na podstawie samego Vitest/typecheck.

## Kryteria akceptacji

- Nagłówek pozostaje na górze, a pierwsze operacyjne sekcje są kontrolkami wizualizacji.
- `Status`, `Physical properties`, `Provenance` i `Target` są po kontrolkach oraz domyślnie zamknięte.
- Pozostałe użycia `ScientificInspectorTemplate` zachowują dotychczasowy DOM.
- Zmiana nie dodaje requestów i nie zmienia stanu renderera.
- Testy targeted, typecheck, kontrakt CSS i browser smoke spełniają swoje bramki.
