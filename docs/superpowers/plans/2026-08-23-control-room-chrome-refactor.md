# Control Room Ribbon, Menu, and UI Header Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przebudować Ribbon, App Menu i nagłówki `apps/control-room` na deklaratywne wkłady modułów oraz wspólną prezentację komend, zachowując aktualny wygląd i geometrię workspace’u.

**Architecture:** Kernel nadal posiada sloty, `ModuleRegistry`, layout i pojedynczy `CommandRegistry`. Moduły deklarują pozycje menu oraz leniwie montowane grupy Ribbonu, a renderery rozwiązują ich stan przez wspólne adaptery komend; rodzina wyspecjalizowanych nagłówków zachowuje istniejącą geometrię bez tworzenia uniwersalnego mega-komponentu.

**Tech Stack:** Next.js 16.2.11, React 19.2.4, TypeScript 5.8.3, Vitest 4.1.5, Radix UI, shadcn/ui-style shared primitives, Tailwind 4, Playwright 1.60, Catppuccin Mocha/Latte.

## Global Constraints

- Zakres implementacji: `apps/control-room` i powiązane dokumenty architektury.
- Bez zmian backendu, OpenAPI v2, generowanego transportu, Python DSL, `ProblemIR`, R3F, realtime i semantyki zasobów.
- HTTP v2 pozostaje źródłem prawdy; WebSocket pozostaje kanałem zdarzeń i invalidacji.
- Zachować jeden App Menu, jeden Ribbon, jeden `CommandRegistry` i jeden workspace FDM/FEM.
- Zachować kolejność tabów: Home, View, Definitions, Geometry, Materials, Physics, Mesh, Study, Results, Automation.
- Zachować wysokości: App Header 38 px, Ribbon 124 px, Status Bar 26 px, Dock Header 38 px.
- Zachować selektory `.fm-header`, `.fm-ribbon`, `.fm-ribbon__tab`, `[data-action-id]`, `.fm-dock-column__handle`, `.fm-viewport-tabs__trigger`, `.fm-inspector__header`, `.fm-footer__bar`, `.fm-status-bar`.
- Nowe klasy mają prefiks `fm-*`; kolory pochodzą z `--fm-*`; `app/globals.css` pozostaje import-only.
- Używać istniejących `Button`, `Tabs`, `Tooltip`, `DropdownMenu`, `Dialog`, `Slider` i `Switch`.
- Moduł nie importuje komponentu, hooka, store’u ani typu wewnętrznego innego modułu.
- Root modułu przyjmuje `ModuleProps`; resource hooks i stores pozostają przy właścicielu domeny.
- Niezarejestrowana komenda nie jest renderowana. Chwilowo niedostępna komenda pozostaje widoczna z `disabledReason`.
- Struktura chrome’u nie może zależeć od `NODE_ENV`.
- Wymagany jest `pnpm@10.8.1` z głównego `package.json`.
- Przed każdym przyszłym commitem uruchomić osobno `git diff --cached --name-only` i potwierdzić brak cudzych plików w stagingu.
- Dokument projektu: `docs/superpowers/specs/2026-08-23-control-room-chrome-refactor-design.md`.

---

## File Map

### Kernel i kontrakty

- Create `apps/control-room/src/kernel/chrome/chromeContributionTypes.ts`: typy regionów menu, węzłów menu i leniwych grup Ribbonu.
- Create `apps/control-room/src/kernel/chrome/collectChromeContributions.ts` i `.test.ts`: deterministyczne łączenie, sortowanie i walidacja wkładów.
- Modify `apps/control-room/src/kernel/types.ts`, `module/ModuleRegistry.ts` i testy: `contributes.menu`, `ribbon`, `status`.
- Create `apps/control-room/src/kernel/commands/commandPresentation.ts`, `dispatchCommand.ts`, `ui/CommandTrigger.tsx`, `ui/CommandMenuItem.tsx` i testy.
- Modify `commandTypes.ts`, `CommandRegistry.ts`, `eventTypes.ts` i runtime command tests: rozdzielenie `accepted`/`completed`.

### App Menu i overlay

- Create `apps/control-room/src/modules/app-menu/AppMenuBar.tsx`, `AppMenuItems.tsx`, `appMenuRegions.ts`, `useAppHeaderModel.ts` i testy.
- Modify `AppMenuModule.tsx` i `manifest.ts`.
- Create `apps/control-room/src/modules/overlay/tools/toolDialogStore.ts`, `toolDialogCommands.ts`, `ToolDialogHost.tsx`.
- Move dialogi narzędziowe z `src/kernel/layout` do `src/modules/overlay/tools`.
- Delete po przełączeniu kernelowe `AppMenuBar.tsx`, `AppMenuBarHeaderModel.ts`, `appMenuModel.tsx` i stare testy.

### Ribbon

- Create `apps/control-room/src/shared/ui/Ribbon.tsx`, `TooltipControl.tsx` i testy.
- Create `apps/control-room/src/modules/ribbon/RibbonTabContentHost.tsx`, `RibbonDialogs.tsx`.
- Create `apps/control-room/src/modules/ribbon/contributions/home.tsx`, `definitions.tsx`, `geometry.tsx`, `materials.tsx`, `physics.tsx`, `mesh.tsx`, `study.tsx`, `results.tsx`, `automation.tsx`.
- Create `apps/control-room/src/modules/ribbon/contributions/view/globalDisplay.tsx`, `orientation.tsx`, `slice.tsx`, `display.tsx`, `selectedTarget.tsx`.
- Create `apps/control-room/src/modules/viewport-3d/ribbonContributions.tsx`.
- Split `ribbonCommands.ts` na `commands/visualizationCommands.ts`, `physicsAuthoringCommands.ts`, `crossSectionCommands.ts`, `index.ts`.
- Delete po parity: `RibbonTabStrip.tsx`, `RibbonGroupsRow.tsx`, stary `RibbonMenuRenderer.tsx`, `ribbonContributions.tsx`, `ribbonTabViews.tsx`.

### Nagłówki, CSS i browser smoke

- Create `shared/ui/DockHeader.tsx`, `SurfaceHeader.tsx`, `SectionHeader.tsx` i testy.
- Create `kernel/layout/DockColumnFrame.tsx`, `WorkspaceDockHydrationFallback.tsx` i testy.
- Create `modules/inspector/InspectorIdentityHeader.tsx` i test.
- Modify `WorkspaceDockLayout.tsx`, `InspectorShell.tsx`, `AnalysisPlotsView.tsx`, `FieldMapModule.tsx`, `ExplorerModule.tsx`, `FooterModule.tsx`, `StatusBarModule.tsx`, `ViewportTabHost.tsx`.
- Delete nieużywany `shared/ui/PanelHeader.tsx` po migracji.
- Modify `header.css`, `ribbon.css`, `layout.css`, `tabs.css`, `primitives.css` i testy stylów bez zmiany geometrii.
- Create `scripts/smoke-ui-chrome.mjs`, jego test kontraktowy i script `smoke:ui-chrome` w `package.json`.

---

### Task 1: Zamrozić decyzję i obecną geometrię

**Files:**
- Modify: `docs/adr/0013-frontend-v2-module-kernel.md`
- Modify: `docs/adr/0015-frontend-v2-migration-governance-boundary.md`
- Modify: `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- Create: `apps/control-room/src/kernel/layout/UiChromeStructure.test.tsx`
- Create: `apps/control-room/src/design/styles/uiChromeGeometry.test.ts`

**Interfaces:**
- Produces: normatywna własność App Menu, Ribbonu, overlay i nagłówków.
- Produces: regresyjny kontrakt wysokości i selektorów dla następnych zadań.

- [ ] **Step 1: Dodać test źródłowej struktury chrome’u**

```ts
expect(shellSource.indexOf('slotId="app-menu"')).toBeLessThan(shellSource.indexOf('slotId="ribbon"'));
expect(shellSource.indexOf('slotId="ribbon"')).toBeLessThan(shellSource.indexOf("WorkspaceDockLayout"));
expect(tokensCss).toContain("--fm-menu-height: 38px");
expect(tokensCss).toContain("--fm-ribbon-height: 124px");
expect(tokensCss).toContain("--fm-status-height: 26px");
expect(tokensCss).toContain("--fm-panel-header-height: 38px");
```

- [ ] **Step 2: Uruchomić test bazowy**

```powershell
pnpm --dir apps/control-room exec vitest run src/kernel/layout/UiChromeStructure.test.tsx src/design/styles/uiChromeGeometry.test.ts
```

Expected: PASS dla aktualnej geometrii i kolejności globalnych rzędów.

- [ ] **Step 3: Uaktualnić decyzje**

ADR 0013 ma zapisać: manifest deklaruje `commands`, `menu`, `ribbon`, `status`;
App Menu/Ribbon są rendererami; aktywna grupa montuje własne hooki; każda akcja
wskazuje jeden command id. ADR 0015 usuwa wyjątki dużych plików wraz z usunięciem
monolitów Ribbonu i zabrania trwałego dual chrome’u.

- [ ] **Step 4: Sprawdzić dokumenty i commit**

```powershell
git diff --check
git add -- docs/adr/0013-frontend-v2-module-kernel.md docs/adr/0015-frontend-v2-migration-governance-boundary.md docs/specs/frontend-v2/01-module-kernel-architecture.md apps/control-room/src/kernel/layout/UiChromeStructure.test.tsx apps/control-room/src/design/styles/uiChromeGeometry.test.ts
git diff --cached --name-only
git commit -m "docs(ui): define unified chrome ownership"
```

### Task 2: Dodać typowane wkłady manifestów

**Files:**
- Create: `apps/control-room/src/kernel/chrome/chromeContributionTypes.ts`
- Create: `apps/control-room/src/kernel/chrome/collectChromeContributions.ts`
- Create: `apps/control-room/src/kernel/chrome/collectChromeContributions.test.ts`
- Modify: `apps/control-room/src/kernel/types.ts`
- Modify: `apps/control-room/src/kernel/module/ModuleRegistry.ts`
- Modify: `apps/control-room/src/kernel/module/ModuleRegistry.test.ts`

**Interfaces:**
- Produces: `MenuContribution`, `MenuNodeContribution`, `RibbonContribution`, `StatusContribution`.
- Produces: `collectMenuContributions()` i `collectRibbonContributions()`.

- [ ] **Step 1: Napisać failing tests sortowania i walidacji**

```ts
expect(collectMenuContributions([toolsManifest, appManifest], commands).map((item) => item.id))
  .toEqual(["app.theme", "tools.registry"]);
expect(() => collectRibbonContributions([first, duplicate], commands))
  .toThrow('Ribbon contribution "view.display" is already registered');
expect(() => collectMenuContributions([unknownCommand], commands))
  .toThrow('Menu contribution "file.export" references unknown command "missing"');
```

- [ ] **Step 2: Potwierdzić RED**

```powershell
pnpm --dir apps/control-room exec vitest run src/kernel/chrome/collectChromeContributions.test.ts
```

Expected: FAIL, ponieważ `kernel/chrome` jeszcze nie istnieje.

- [ ] **Step 3: Zdefiniować kontrakty**

```ts
export type AppMenuRegionId =
  | "application" | "file" | "edit" | "view" | "simulation"
  | "tools" | "help" | "quick-access" | "run-control";

export type MenuNodeContribution =
  | { id: string; kind: "command"; commandId: CommandId; order: number; input?: unknown; presentation?: "default" | "checkbox" | "compact" | "run" }
  | { id: string; kind: "separator"; order: number }
  | { id: string; kind: "submenu"; label: string; order: number; items: readonly MenuNodeContribution[] };

export interface MenuContribution {
  id: string;
  region: AppMenuRegionId;
  order: number;
  items: readonly MenuNodeContribution[];
}

export interface RibbonContributionProps { commandContext: CommandContext; }
export interface RibbonContribution {
  id: string;
  tabId: RibbonTabId;
  groupId: string;
  title: string;
  order: number;
  tone?: "authoring" | "compose" | "compute" | "selection" | "sync" | "neutral";
  component: () => Promise<{ default: ComponentType<RibbonContributionProps> }>;
}
export interface StatusContribution { id: string; order: number; }
```

- [ ] **Step 4: Rozszerzyć manifest i kolektory**

```ts
contributes?: {
  commands?: readonly CommandContribution[];
  menu?: readonly MenuContribution[];
  ribbon?: readonly RibbonContribution[];
  status?: readonly StatusContribution[];
};
```

Kolektory spłaszczają manifesty, walidują unikalność, rekurencyjnie sprawdzają
command ids i sortują po `order`, następnie `id`.

- [ ] **Step 5: Zweryfikować i commit**

```powershell
pnpm --dir apps/control-room exec vitest run src/kernel/chrome/collectChromeContributions.test.ts src/kernel/module/ModuleRegistry.test.ts
pnpm --dir apps/control-room run typecheck
pnpm --dir apps/control-room run check:architecture-hygiene
git add -- apps/control-room/src/kernel/chrome apps/control-room/src/kernel/types.ts apps/control-room/src/kernel/module/ModuleRegistry.ts apps/control-room/src/kernel/module/ModuleRegistry.test.ts
git diff --cached --name-only
git commit -m "feat(ui): add module chrome contributions"
```

### Task 3: Ujednolicić prezentację, potwierdzenie i lifecycle komend

**Files:**
- Create: `apps/control-room/src/kernel/commands/commandPresentation.ts` i `.test.ts`
- Create: `apps/control-room/src/kernel/commands/dispatchCommand.ts` i `.test.ts`
- Create: `apps/control-room/src/kernel/commands/ui/CommandTrigger.tsx`, `CommandMenuItem.tsx` i testy.
- Modify: `apps/control-room/src/kernel/commands/commandTypes.ts`
- Modify: `apps/control-room/src/kernel/commands/CommandRegistry.ts` i test.
- Modify: `apps/control-room/src/kernel/events/eventTypes.ts`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts`

**Interfaces:**
- Produces: `resolveCommandPresentation(registry, commandId, context)`.
- Produces: `dispatchCommand(kernel, commandId, context, input)`.
- Produces: `CommandConfirmation` i wynik `accepted`.

- [ ] **Step 1: Napisać failing tests**

```ts
expect(resolveCommandPresentation(registry, "missing", context)).toMatchObject({
  available: false,
  disabled: true,
  disabledReason: "Command is unavailable: missing",
});
const result = await registry.execute("study.run", context);
expect(result.status).toBe("accepted");
expect(accepted).toHaveBeenCalledWith({ commandId: "study.run" });
expect(completed).not.toHaveBeenCalled();
```

- [ ] **Step 2: Potwierdzić RED**

```powershell
pnpm --dir apps/control-room exec vitest run src/kernel/commands/commandPresentation.test.ts src/kernel/commands/dispatchCommand.test.ts src/kernel/commands/CommandRegistry.test.ts
```

Expected: FAIL dla brakujących symboli i statusu `accepted`.

- [ ] **Step 3: Rozszerzyć typy i eventy**

```ts
export interface CommandConfirmation {
  kind: "generic" | "mesh-build";
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}
export interface CommandResult {
  status: "accepted" | "completed" | "failed" | "cancelled";
  message?: string;
}
```

Dodać `CommandContribution.confirmation(context, input)`. Registry emituje
`command:accepted` dla accepted; `command:completed` tylko dla terminalnych
wyników. `submitRuntimeCommand()` zwraca accepted po akceptacji backendu.

- [ ] **Step 4: Zaimplementować model i adaptery**

`CommandPresentation` zawiera `active`, `available`, `disabled`,
`disabledReason`, `icon`, `shortcut`, `title`. `CommandTrigger` używa `Button`
i `Tooltip`; niedostępność jest fokusowalnym `aria-disabled`, bez efektu.
`CommandMenuItem` używa tego samego modelu. Dispatcher emituje confirmation
request albo wywołuje registry bez rozgałęzień powierzchni.

- [ ] **Step 5: Zweryfikować i commit**

```powershell
pnpm --dir apps/control-room exec vitest run src/kernel/commands/commandPresentation.test.ts src/kernel/commands/dispatchCommand.test.ts src/kernel/commands/CommandRegistry.test.ts src/kernel/commands/ui/CommandTrigger.test.tsx
pnpm --dir apps/control-room run typecheck
git add -- apps/control-room/src/kernel/commands apps/control-room/src/kernel/events/eventTypes.ts apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts
git diff --cached --name-only
git commit -m "refactor(ui): unify command presentation and dispatch"
```

### Task 4: Przenieść App Menu do modułu i narzędzia do overlay

**Files:**
- Create: `apps/control-room/src/modules/app-menu/AppMenuBar.tsx`
- Create: `apps/control-room/src/modules/app-menu/AppMenuItems.tsx`
- Create: `apps/control-room/src/modules/app-menu/appMenuRegions.ts`
- Create: `apps/control-room/src/modules/app-menu/useAppHeaderModel.ts`
- Create: `apps/control-room/src/modules/app-menu/AppMenuBar.test.tsx`
- Modify: `apps/control-room/src/modules/app-menu/AppMenuModule.tsx`, `manifest.ts`
- Create: `apps/control-room/src/modules/overlay/tools/toolDialogStore.ts`, `toolDialogCommands.ts`, `ToolDialogHost.tsx`
- Modify: `apps/control-room/src/modules/overlay/CommandPaletteModule.tsx`, `manifest.ts`
- Modify: `apps/control-room/src/modules/explorer/manifest.ts`, `inspector/manifest.ts`
- Delete after migration: `apps/control-room/src/kernel/layout/AppMenuBar.tsx`, `AppMenuBarHeaderModel.ts`, `appMenuModel.tsx` i stare testy.

**Interfaces:**
- Consumes: kolektory Task 2 oraz command adapters Task 3.
- Produces: cienki root `AppMenuModule` i modułowy `ToolDialogHost`.
- Produces: prawdziwe Tools commands widoczne także w palecie.

- [ ] **Step 1: Napisać test nowego właściciela**

```ts
expect(appMenuManifest.contributes?.menu?.map((item) => item.region))
  .toEqual(expect.arrayContaining(["application", "file", "edit", "view", "simulation", "help", "quick-access", "run-control"]));
expect(overlayManifest.contributes?.menu?.some((item) => item.region === "tools")).toBe(true);
expect(appMenuSource).not.toContain('commandId === "tools.');
```

- [ ] **Step 2: Potwierdzić RED**

```powershell
pnpm --dir apps/control-room exec vitest run src/modules/app-menu/AppMenuBar.test.tsx
```

Expected: FAIL, ponieważ renderer nadal należy do kernel layout.

- [ ] **Step 3: Przenieść App Menu bez zmiany hydration**

Przenieść selektory session/API error do `useAppHeaderModel.ts`. Zachować
`useSessionStatusSelector(selectHeaderSessionSource, { isEqual })` i server
snapshot odpowiadający loading. Root ma być cienki:

```tsx
export default function AppMenuModule(props: ModuleProps) {
  return <AppMenuBar kernel={props.kernel} />;
}
```

`AppMenuItems` grupuje wkłady po regionie i renderuje te same dane w desktop
menus oraz compact application dropdown.

- [ ] **Step 4: Przenieść dialogi do overlay**

```ts
export const TOOL_DIALOG_COMMANDS: readonly CommandContribution[] = [
  toolDialogCommand("tools.registry-inspector", "Registry Inspector", "registry"),
  toolDialogCommand("tools.thread-manager", "Diagnostic Recorder", "diagnostic-recorder"),
  toolDialogCommand("tools.material-library", "Material Library", "material-library"),
  toolDialogCommand("tools.data-preview", "Data Preview", "data-preview"),
  toolDialogCommand("tools.communication", "Communication", "communication"),
];
```

`ToolDialogHost` subskrybuje prywatny store overlay i montuje przeniesione
dialogi. App Menu wykonuje wszystko przez `dispatchCommand`.

- [ ] **Step 5: Usunąć duplikaty panel commands**

Pozostawić `panels:explorer:toggle`, `panels:inspector:toggle`,
`panels:footer:toggle`. Usunąć `workspace.toggle-left-panel` i
`workspace.toggle-right-panel`; wkłady wskazują identyfikatory kanoniczne.

- [ ] **Step 6: Zweryfikować i commit**

```powershell
pnpm --dir apps/control-room exec vitest run src/modules/app-menu/AppMenuBar.test.tsx src/kernel/chrome/collectChromeContributions.test.ts src/modules/overlay/CommandPaletteModule.test.tsx
pnpm --dir apps/control-room run check:architecture-hygiene
pnpm --dir apps/control-room run typecheck
git add -- apps/control-room/src/modules/app-menu apps/control-room/src/modules/overlay apps/control-room/src/modules/explorer/manifest.ts apps/control-room/src/modules/inspector/manifest.ts apps/control-room/src/kernel/layout apps/control-room/src/design/styles/header.css
git diff --cached --name-only
git commit -m "refactor(ui): move app menu into module contributions"
```

Expected: brak AppMenuBar w kernel layout; pięć Tools commands jest osiągalne z
menu i palety; SSR i pierwszy client render mają ten sam session fallback.

### Task 5: Przełączyć szkielet Ribbonu na shared primitives

**Files:**
- Create: `apps/control-room/src/shared/ui/Ribbon.tsx`, `Ribbon.test.tsx`
- Create: `apps/control-room/src/shared/ui/TooltipControl.tsx`, `TooltipControl.test.tsx`
- Create: `apps/control-room/src/modules/ribbon/RibbonTabContentHost.tsx`, `RibbonTabContentHost.test.tsx`
- Create: `apps/control-room/src/modules/ribbon/RibbonDialogs.tsx`
- Modify: `apps/control-room/src/modules/ribbon/RibbonModule.tsx`, `manifest.ts`, `ribbonTypes.ts`, `ribbonResourcePolicy.ts`
- Modify: `apps/control-room/src/design/styles/ribbon.css`

**Interfaces:**
- Consumes: `RibbonContribution` i `CommandTrigger`.
- Produces: `RibbonRoot`, `RibbonTabList`, `RibbonTabTrigger`, `RibbonPanel`, `RibbonGroupFrame`, `RibbonActionControl`.
- Produces: host montujący tylko grupy aktywnej zakładki.

- [ ] **Step 1: Napisać failing tests primitives i aktywnego montowania**

```tsx
expect(rendered).toContain('role="tablist"');
expect(rendered).toContain('data-action-id="viewport-3d.fit"');
expect(rendered).toContain("fm-ribbon-action");
expect(mountedGroups).toEqual(["view.orientation", "view.display"]);
expect(mountedGroups).not.toContain("study.run");
```

Test `TooltipControl` wymaga fokusowalnego wrappera z `aria-describedby` dla
niedostępnej akcji.

- [ ] **Step 2: Potwierdzić RED**

```powershell
pnpm --dir apps/control-room exec vitest run src/shared/ui/Ribbon.test.tsx src/shared/ui/TooltipControl.test.tsx src/modules/ribbon/RibbonTabContentHost.test.tsx
```

Expected: FAIL dla brakujących primitives i hosta.

- [ ] **Step 3: Zbudować shared Ribbon**

`RibbonTabList` i `RibbonTabTrigger` komponują istniejące `TabsList` i
`TabsTrigger`. `RibbonActionControl` używa `CommandTrigger`; menu używa
`CommandMenuItem`, `DropdownMenu` i `Slider`. Zachować split-button,
`data-action-id`, klasy i wymiary.

- [ ] **Step 4: Odchudzić root Ribbonu**

```tsx
export default function RibbonModule({ kernel }: ModuleProps) {
  const activeTab = useLayoutSelector((layout) => layout.activeModuleTab);
  const { setActiveTab } = useLayoutActions();
  return (
    <RibbonRoot>
      <RibbonTabList value={activeTab} onValueChange={(value) => setActiveTab(value as RibbonTabId)} />
      <RibbonTabContentHost kernel={kernel} tabId={activeTab} />
      <RibbonDialogs kernel={kernel} />
    </RibbonRoot>
  );
}
```

Root nie importuje geometry/mesh/study hooks. Resource hooks należą do
aktywnych group components.

- [ ] **Step 5: Zweryfikować i commit**

```powershell
pnpm --dir apps/control-room exec vitest run src/shared/ui/Ribbon.test.tsx src/shared/ui/TooltipControl.test.tsx src/modules/ribbon/RibbonTabContentHost.test.tsx src/modules/ribbon/ribbonResourcePolicy.test.ts
pnpm --dir apps/control-room run typecheck
git add -- apps/control-room/src/shared/ui/Ribbon.tsx apps/control-room/src/shared/ui/Ribbon.test.tsx apps/control-room/src/shared/ui/TooltipControl.tsx apps/control-room/src/shared/ui/TooltipControl.test.tsx apps/control-room/src/modules/ribbon apps/control-room/src/design/styles/ribbon.css
git diff --cached --name-only
git commit -m "refactor(ui): render ribbon from active contributions"
```

### Task 6: Migrować zakładki domenami i usunąć monolity

**Files:**
- Create: `apps/control-room/src/modules/ribbon/contributions/home.tsx`, `definitions.tsx`, `geometry.tsx`, `materials.tsx`, `physics.tsx`, `mesh.tsx`, `study.tsx`, `results.tsx`, `automation.tsx`
- Create: `apps/control-room/src/modules/ribbon/contributions/view/globalDisplay.tsx`, `orientation.tsx`, `slice.tsx`, `display.tsx`, `selectedTarget.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/manifest.ts`
- Modify: `apps/control-room/src/modules/ribbon/manifest.ts`
- Create: `apps/control-room/src/modules/ribbon/commands/visualizationCommands.ts`, `physicsAuthoringCommands.ts`, `crossSectionCommands.ts`, `index.ts`
- Delete after parity: `ribbonContributions.tsx`, `ribbonTabViews.tsx`, `ribbonCommands.ts`, `RibbonTabStrip.tsx`, `RibbonGroupsRow.tsx`, stary `RibbonMenuRenderer.tsx`.

**Interfaces:**
- Consumes: leniwe contributions Task 5.
- Produces: jeden właściciel każdej grupy i jawna lista resource hooks.
- Preserves: command ids, labels, inputs, split buttons, menu nodes i kolejność.

- [ ] **Step 1: Rozdzielić giant test na kontrakty zakładek**

Utworzyć test na każdy tab oraz wspólny test duplikatów/unknown commands:

```ts
expect(commandIdsForTab("study")).toEqual([
  "study.run", "study.pause", "study.resume", "study.stop", "study.skip-stage",
]);
expect(findDuplicateActionIds(allRibbonContributions)).toEqual([]);
expect(findUnknownCommandIds(allRibbonContributions, kernel.commands)).toEqual([]);
```

- [ ] **Step 2: Migrować Home, Definitions, Automation**

Przenieść modele bez zmiany etykiet. Każdy plik eksportuje readonly array
`RibbonContribution[]`; manifest wnosi je bez `ALL_TAB_CONTENT`.

- [ ] **Step 3: Migrować Geometry, Materials, Physics**

Każda grupa tworzy lokalny CommandContext. Geometry/Physics czytają active-lane
tylko z session status i nie pobierają mesh resources. Mutacje wskazują command ids.

- [ ] **Step 4: Migrować Mesh i Study**

Mesh montuje mesh hooks, Study runtime hooks. Potwierdzenie mesh przechodzi
przez dispatcher; usunąć ID branching z Ribbonu. Study zachowuje command detail,
a accepted state pochodzi z Task 3.

- [ ] **Step 5: Migrować Results i View**

Results ładuje quantity catalogs tylko aktywnie. View dzieli pięć wskazanych
grup. Grupy zależne od viewport-3d przechodzą do jego manifestu; Ribbon nie
importuje `viewport-3d/public` ani store’u.

- [ ] **Step 6: Usunąć filtry środowiskowe i stare pliki**

Usunąć `stripProductionRibbonPlaceholders()`, `isProductionRibbonBuild()`,
`ALL_TAB_CONTENT` i monolity po zielonej macierzy. Slider menu używa
`shared/ui/Slider`, nie surowego range input.

- [ ] **Step 7: Zweryfikować i commit**

```powershell
pnpm --dir apps/control-room exec vitest run src/modules/ribbon src/modules/viewport-3d/manifest.test.ts
pnpm --dir apps/control-room run check:architecture-hygiene
pnpm --dir apps/control-room run check:api-hygiene
pnpm --dir apps/control-room run typecheck
git add -- apps/control-room/src/modules/ribbon apps/control-room/src/modules/viewport-3d/manifest.ts apps/control-room/src/modules/viewport-3d/ribbonContributions.tsx
git diff --cached --name-only
git commit -m "refactor(ui): split ribbon contributions by domain"
```

Expected: brak monolitów i `NODE_ENV` w modelu Ribbonu; nieaktywne taby nie
subskrybują zasobów.

### Task 7: Wprowadzić taksonomię nagłówków i jeden DockColumnFrame

**Files:**
- Create: `apps/control-room/src/shared/ui/DockHeader.tsx`, `DockHeader.test.tsx`
- Create: `apps/control-room/src/shared/ui/SurfaceHeader.tsx`, `SurfaceHeader.test.tsx`
- Create: `apps/control-room/src/shared/ui/SectionHeader.tsx`
- Create: `apps/control-room/src/kernel/layout/DockColumnFrame.tsx`, `DockColumnFrame.test.tsx`
- Create: `apps/control-room/src/kernel/layout/WorkspaceDockHydrationFallback.tsx`
- Create: `apps/control-room/src/modules/inspector/InspectorIdentityHeader.tsx` i test.
- Modify: `apps/control-room/src/kernel/layout/WorkspaceDockLayout.tsx`
- Modify: `apps/control-room/src/modules/inspector/InspectorShell.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.tsx`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/modules/footer/FooterModule.tsx`
- Modify: `apps/control-room/src/modules/status-bar/StatusBarModule.tsx`
- Delete: `apps/control-room/src/shared/ui/PanelHeader.tsx`

**Interfaces:**
- Produces: stateless `DockHeader`, `SurfaceHeader`, `SectionHeader` bez zależności od kernela/modułów.
- Produces: `DockColumnFrame` używany w SSR i po hydratacji.
- Preserves: jeden zewnętrzny nagłówek docka oraz identity header Inspectora.

- [ ] **Step 1: Napisać failing tests semantyki**

```tsx
expect(dockHtml).toContain('class="fm-dock-column__handle"');
expect(dockHtml.match(/Explorer/g)).toHaveLength(1);
expect(inspectorHtml).toContain("fm-inspector__header");
expect(inspectorHtml).toContain('aria-label="Inspector options"');
expect(statusSource).not.toContain('role="button"');
```

- [ ] **Step 2: Potwierdzić RED**

```powershell
pnpm --dir apps/control-room exec vitest run src/shared/ui/DockHeader.test.tsx src/shared/ui/SurfaceHeader.test.tsx src/kernel/layout/DockColumnFrame.test.tsx src/modules/inspector/InspectorIdentityHeader.test.tsx
```

Expected: FAIL dla brakujących plików.

- [ ] **Step 3: Zaimplementować rodzinę nagłówków**

`DockHeader` przyjmuje `title`, `subtitle`, `actions`, `dragHandleProps`,
`className`. `SurfaceHeader` przyjmuje `title`, `context`, `actions`.
`SectionHeader` przyjmuje `title`, `meta`, `actions`, `headingLevel`. Żaden
primitive nie importuje kernela ani modułu.

- [ ] **Step 4: Usunąć duplikację dock fallbacku**

`SortableWorkspaceColumn` i `WorkspaceDockHydrationFallback` renderują jeden
`DockColumnFrame`. Fallback nie przekazuje drag listeners, lecz zachowuje
identyczny tytuł, klasę i slot content. Nie dodawać nowego rzędu nad Explorerem,
Viewportem i Footerem.

- [ ] **Step 5: Migrować pozostały chrome**

- Inspector: breadcrumbs/identity/badges do `InspectorIdentityHeader`.
- Analysis i Field Map: `SurfaceHeader` z obecnymi klasami.
- Explorer i Footer: lokalne akcje przez `Button`/`TooltipControl`.
- Status Bar: `span role="button"` zastąpić natywnymi `Button`.
- Subcharty, dialogi i nagłówki tabel pozostawić wyspecjalizowane i sklasyfikować
  w teście inventory.

- [ ] **Step 6: Zweryfikować i commit**

```powershell
pnpm --dir apps/control-room exec vitest run src/kernel/layout/WorkspaceDockLayout.test.tsx src/kernel/layout/DockColumnFrame.test.tsx src/modules/inspector/InspectorShell.test.ts src/modules/footer/FooterModule.quickChart.test.tsx src/modules/status-bar
pnpm --dir apps/control-room run smoke:inspector
git add -- apps/control-room/src/shared/ui apps/control-room/src/kernel/layout apps/control-room/src/modules/inspector apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx apps/control-room/src/modules/field-map/FieldMapModule.tsx apps/control-room/src/modules/explorer/ExplorerModule.tsx apps/control-room/src/modules/footer/FooterModule.tsx apps/control-room/src/modules/status-bar/StatusBarModule.tsx
git diff --cached --name-only
git commit -m "refactor(ui): standardize workspace header families"
```

Expected: SSR fallback nie montuje DnD; Inspector zachowuje root, scroll, focus i
drafty; brak martwego `PanelHeader`.

### Task 8: Domknąć responsywność, CSS i browser qualification

**Files:**
- Modify: `apps/control-room/src/design/styles/header.css`, `ribbon.css`, `layout.css`, `tabs.css`, `primitives.css`, `designStyles.test.ts`
- Create: `apps/control-room/scripts/smoke-ui-chrome.mjs`
- Create: `apps/control-room/src/kernel/layout/uiChromeSmokeScript.test.ts`
- Modify: `apps/control-room/scripts/capture-ui-docs-screenshots.mjs`
- Modify: `apps/control-room/package.json`

**Interfaces:**
- Produces: `pnpm --dir apps/control-room run smoke:ui-chrome`.
- Preserves: wartości geometryczne i brak raw Catppuccin colors.
- Fixes: kompletne menu przy 899 px oraz poprawne semantic run-control selectors.

- [ ] **Step 1: Dodać statyczne testy breakpointów**

Test wymaga breakpointów 1400, 1180, 900 i odrzuca ukrycie `.fm-header__nav`
bez widocznego `.fm-header__compact-menu`. Run controls używają
`data-command-intent="run|pause|stop|skip"`, nie pełnego command id.

- [ ] **Step 2: Naprawić overflow bez zmiany desktopu**

- `>= 1400`: pełne etykiety i obecny układ.
- `1180–1399`: kompaktowy Ribbon bez utraty działania.
- `900–1179`: search/quick access w overflow; desktop menu widoczne.
- `< 900`: app dropdown zawiera File/Edit/View/Simulation/Tools/Help.
- Ribbon groups używają poziomego scrolla; żadna akcja nie ma `display: none`.

Usunąć podwójne źródło stylu Tabs: `Tabs.tsx` zachowuje semantyczne klasy, a
`tabs.css` pozostaje właścicielem aktualnej geometrii.

- [ ] **Step 3: Utworzyć browser smoke**

Skrypt używa Playwright i istniejącego fixture mode. Dla 1400/1399,
1180/1179, 900/899 sprawdza:

```js
assert((await page.locator(".fm-header").count()) === 1, "exactly one app header");
assert((await page.locator(".fm-ribbon").count()) === 1, "exactly one ribbon");
assert((await page.locator('[data-slot-id="viewport-main"]').count()) === 1, "one center host");
assert((await page.getByRole("menuitem", { name: "Export Python DSL" }).count()) === 1, "narrow File menu remains reachable");
```

Sprawdzić Arrow/Home/End dla tabs, fokus disabled reason, drag, resize, reload,
Mocha/Latte, reduced motion, page overflow i screenshoty w
`.fullmag/reports/ui-chrome`.

- [ ] **Step 4: Naprawić screenshot selectors i package script**

```text
.fm-ribbon-bar -> .fm-ribbon
aside -> [data-slot-id="panel-left"] / [data-slot-id="panel-right"]
.fm-inspector-shell, .fm-inspector-panel -> .fm-inspector
```

```json
"smoke:ui-chrome": "node scripts/smoke-ui-chrome.mjs"
```

- [ ] **Step 5: Zweryfikować i commit**

```powershell
pnpm --dir apps/control-room exec vitest run src/design/styles/designStyles.test.ts src/design/styles/uiChromeGeometry.test.ts src/kernel/layout/uiChromeSmokeScript.test.ts
pnpm --dir apps/control-room run smoke:ui-chrome
git add -- apps/control-room/src/design/styles apps/control-room/scripts/smoke-ui-chrome.mjs apps/control-room/scripts/capture-ui-docs-screenshots.mjs apps/control-room/src/kernel/layout/uiChromeSmokeScript.test.ts apps/control-room/package.json
git diff --cached --name-only
git commit -m "test(ui): qualify responsive workspace chrome"
```

Expected: raport zawiera screenshoty sześciu granic breakpointów i obu themes
bez różnicy geometrii; menu jest osiągalne przy 899 px.

### Task 9: Zaktualizować governance i wykonać końcową kwalifikację

**Files:**
- Modify: `docs/specs/frontend-v2/02-module-catalog.md`
- Modify: `docs/specs/frontend-v2/07-migration-strategy.md`
- Modify: `docs/specs/frontend-v2/09-css-design-system.md`
- Modify: `docs/specs/frontend-v2/10-shell-menu-and-navigation.md`
- Modify: `docs/specs/frontend-v2/12-ribbon-toolbar-command-system.md`
- Modify: `docs/specs/frontend-v2/18-testing-quality-gates.md`
- Modify: `docs/specs/frontend-v2/21-cutover-acceptance.md`
- Modify: `docs/specs/frontend-v2/22-implementation-plan.md`
- Modify: `public_docs/site/architecture/ui-architecture.md`
- Modify: `public_docs/site/getting-started/control-room.md`
- Modify: `apps/control-room/scripts/check-architecture-hygiene.mjs`
- Create: `docs/audits/2026-08-23-control-room-chrome-refactor-closure.md`

**Interfaces:**
- Consumes: wdrożone symbole i dowody Tasks 1–8.
- Produces: aktualny opis manifestów, skrótu palety, invalidation-only realtime i hierarchii chrome’u.
- Produces: statyczną bramę przeciw ręcznym callbackom i raw interaktywnym elementom top-level chrome’u.

- [ ] **Step 1: Rozszerzyć architecture hygiene**

Skrypt kończy się błędem, jeżeli AppMenuBar jest poza `modules/app-menu`,
Ribbon root importuje domain resource hooks, powierzchnia rozpoznaje konkretne
command ids przed dispatch, wracają stare monolity, występuje cross-module
import albo top-level chrome używa raw `<button>`/`span role="button"`.

- [ ] **Step 2: Zaktualizować specyfikacje i ADR snapshot**

Zapisać rzeczywisty `registry.ts`, wkłady, taksonomię nagłówków, active-only
resources, responsywność i gates. `07`/`22` nazywają stan: v2 jest domyślne,
cutover acceptance niezamknięte, legacy formalnie niezamrożone. ADR 0011 i
resource-first API nie otrzymują endpointów; refaktor jest frontend-only.

- [ ] **Step 3: Zaktualizować public docs i audyty**

`ui-architecture.md` pokazuje prawdziwy manifest; skrót palety to
`Ctrl+Shift+P`; WebSocket jest event/invalidation. Audyty z 2026-08-16 oznaczyć
jako historyczne, a closure audit mapuje findings na testy i pliki.

- [ ] **Step 4: Uruchomić pełną kwalifikację**

```powershell
pnpm --dir apps/control-room run check:architecture-hygiene
pnpm --dir apps/control-room run check:api-hygiene
pnpm --dir apps/control-room run typecheck
pnpm --dir apps/control-room run lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room run build
pnpm --dir apps/control-room run smoke:ui-chrome
pnpm --dir apps/control-room run smoke:inspector
pnpm --dir apps/control-room run smoke:study-authoring-ui
pnpm --dir apps/control-room run smoke:study-runtime-control
pnpm --dir apps/control-room run smoke:viewport-3d-explorer-inspector-targets
git diff --check
```

Expected: wszystkie polecenia kończą się kodem 0. Browser smoke potwierdza
widoczny canvas, `gl.isContextLost() === false`, niezerowy drawing buffer,
pojedynczy center host i menu osiągalne przy 899 px.

- [ ] **Step 5: Sprawdzić brak starych ścieżek**

```powershell
rg -n "appMenuModel|ribbonContributions|stripProductionRibbonPlaceholders|isMeshBuildConfirmCommandId" apps/control-room/src/kernel/layout apps/control-room/src/modules/ribbon apps/control-room/src/modules/app-menu apps/control-room/src/modules/overlay
rg -n "fetch\(|/v1/live/current|/v2/" apps/control-room/src/modules/app-menu apps/control-room/src/modules/ribbon --glob "*.ts" --glob "*.tsx"
```

Expected: pierwsze wyszukanie zwraca tylko testy bram albo zero wyników; drugie
nie znajduje bezpośredniego transportu i endpoint strings w modułach.

- [ ] **Step 6: Commit**

```powershell
git add -- docs/adr docs/specs/frontend-v2 docs/audits/2026-08-23-control-room-chrome-refactor-closure.md public_docs/site/architecture/ui-architecture.md public_docs/site/getting-started/control-room.md apps/control-room/scripts/check-architecture-hygiene.mjs
git diff --cached --name-only
git commit -m "docs(ui): close control room chrome refactor"
```

---

## Completion Criteria

- App Menu istnieje wyłącznie w module `app-menu`; Ribbon wyłącznie w module `ribbon`.
- Każda akcja menu, Ribbonu, palety i skrótu wskazuje jeden istniejący command id.
- Potwierdzenia i disabled reasons są identyczne na wszystkich powierzchniach.
- `accepted` nie emituje `command:completed`; finalny runtime state pochodzi z zasobów.
- Nie istnieją ręczne listy placeholderów ani struktura zależna od `NODE_ENV`.
- Nieaktywne zakładki Ribbonu nie montują resource hooks.
- Nie istnieją stare monolity Ribbonu, kernelowy AppMenuBar ani martwy `PanelHeader`.
- Każdy top-level nagłówek jest App, Dock, Surface albo Inspector Identity; sekcje i dialogi mają jawnych właścicieli.
- Przy 899 px wszystkie regiony menu pozostają osiągalne.
- Mocha i Latte mają identyczną geometrię, reduced motion zachowuje funkcjonalność.
- Architecture/API hygiene, typecheck, lint, Vitest, build i browser smokes są zielone.
- Dokumentacja i ADR opisują wdrożony stan bez równoległego legacy chrome’u.
