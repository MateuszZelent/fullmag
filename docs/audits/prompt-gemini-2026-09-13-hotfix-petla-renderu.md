# Zadanie dla Gemini — FullMag: HOTFIX pętli renderu (LR-03 pole główne) + domknięcie B4

## 0. Gdzie pracujesz

**Repozytorium:** `C:\git\fullmag\fullmag`
**Gałąź:** `master`, bezpośrednio. Nie twórz gałęzi, nie pracuj w worktree.
**Oczekiwany commit bazowy:** `7effe3392b82e3bcfcfc0adf0b56a84a5124f01f`

```bash
git rev-parse HEAD
git status --porcelain
```

`HEAD` ≠ `7effe3392b82e3bcfcfc0adf0b56a84a5124f01f` albo niezacommitowane zmiany w `apps/control-room/` → **zatrzymaj się i zgłoś**.

**To jest hotfix.** Priorytet ma zadanie H1. Jeżeli zabraknie czasu lub czegokolwiek innego, H1 ma być skończone, przetestowane i zacommitowane osobno, zanim zaczniesz H3.

Nie normalizuj końców linii. `git diff --check` musi przechodzić.

---

## 1. Co jest zepsute i dlaczego

Commit `cb22087d29471885577c71435160b93d9dbd6b8f` (Część A, LR-03 na polu głównym) wprowadza **gwarantowaną pętlę renderu**. Przegląd kodu i symulacja logiki potwierdziły to jednoznacznie.

Mechanizm, `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`:

- **linia 4564** — `const [primaryFieldRetained, setPrimaryFieldRetained] = useState<…>(null);`
- **linie 4574–4602** — `useMemo(…)` wołający `resolvePrimaryFieldDisplayedEnvelope`, z `primaryFieldRetained` **w tablicy zależności**
- **linie 4603–4605** — zapis stanu w fazie renderu:

```ts
if (nextPrimaryFieldRetained !== primaryFieldRetained) {
  setPrimaryFieldRetained(nextPrimaryFieldRetained);
}
```

`resolvePrimaryFieldDisplayedEnvelope` (**linia 1897**) na **każdej ścieżce, która ma cokolwiek do pokazania**, alokuje świeże obiekty — zarówno `nextRetained: { … }`, jak i `envelope` przez spread (`{ ...incomingEnvelope, retained: false }`, `{ ...retained.envelope, retained: true }`).

Wynika z tego cykl: render → `useMemo` produkuje nowy `nextRetained` → nierówność referencji → `setState` w renderze → React renderuje ponownie → `primaryFieldRetained` się zmienił, więc `useMemo` przelicza → **znowu nowy obiekt** → `setState` → …

Symulacja tej logiki nie osiąga punktu stałego po 30 iteracjach. W Reakcie oznacza to `Too many re-renders` i wywrócony komponent — za każdym razem, gdy pole główne ma dane, czyli zawsze podczas aktywnej symulacji.

**Dlaczego bramki tego nie wykryły:** testy w `useViewport3DSceneModel.test.ts` sprawdzają wyeksportowaną funkcję czystą, nigdy nie renderują hooka. `typecheck`, `eslint` i `audit:idle-performance` tej klasy błędu nie widzą. Dlatego H2 dokłada bramkę, która ją widzi.

## 2. Obowiązkowa lektura

1. `docs/audits/2026-09-13-live-refresh-remediation-masterplan.md` — kontekst, rejestr LR-01…LR-26.
2. `docs/audits/prompt-gemini-2026-09-13-faza1b-faza2.md` — zadanie, z którego wyszedł ten regres; sekcja A2 punkt 1 mówiła o `useRef`.
3. `AGENTS.md` w katalogu głównym.

## 3. Reguły egzekwowane przez CI

Zero `any` / `as any`, zero nowych `@ts-expect-error`, zero `TODO`/`FIXME`/`HACK`, zero `console.log`/`console.debug`, zakaz importów między modułami z pominięciem `public.ts`, `eslint --max-warnings=0`.

---

## H1 — usuń pętlę renderu (P0)

**Plik:** `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`

Kotwice na `7effe3392`:
- `Viewport3DPrimaryFieldRetainedState` — **1886**
- `ResolvePrimaryFieldDisplayedEnvelopeResult` — **1891**
- `resolvePrimaryFieldDisplayedEnvelope` — **1897**
- `useState` retencji — **4564**
- `useMemo` z resolverem — **4574**
- zapis stanu w renderze — **4603–4605**
- `displayedFieldVector` — **4606**

**Wymagany niezmiennik, niezależnie od wybranego podejścia:**

> Podanie resolverowi jego własnego wyniku `nextRetained` jako wejścia `retained`, przy niezmienionych pozostałych argumentach, musi zwrócić **tę samą referencję** `nextRetained`. Innymi słowy resolver osiąga punkt stały w jednym kroku.

To jest warunek konieczny do poprawności całego wzorca „dopasuj stan do propsów" i H2 będzie go egzekwować testem.

**Preferowane podejście — `useRef`.** Tak było w pierwotnym zadaniu i jest to najprostsza droga do poprawności: ref nie wymusza ponownego renderu, więc problem nie istnieje z definicji. Pamięć ostatniej zgodnej klatki trzymaj w `useRef<Viewport3DPrimaryFieldRetainedState | null>(null)`, aktualizowanym po wyliczeniu wyniku. Zadbaj o to, żeby zapis do refa był deterministyczny względem tego samego zestawu wejść (ten sam render nie może dać innego wyniku przy powtórzeniu).

**Podejście alternatywne — zachować `useState`, ale wyeliminować alokacje.** Dopuszczalne, jeżeli wolisz nie ruszać struktury:

1. W gałęzi „`status === "ready"` + zgodny incoming": jeżeli `retained` już opisuje dokładnie tę klatkę (`retained.envelope.data === incomingEnvelope.data` **i** `retained.revision === preparedRevision`), zwróć `nextRetained: retained` — tę samą referencję — zamiast budować nowy obiekt.
2. W gałęzi „zgodny `retained`": zwróć `nextRetained: retained` bez spreadu. Flagę `retained: true` ustaw **raz**, w momencie wejścia w stan retencji, a nie przy każdym odczycie.
3. `displayedEnvelope` może pozostać nowym obiektem, bo nie trafia do stanu — ale jeżeli da się go utrzymać stabilnym bez komplikacji, tym lepiej dla konsumentów niżej.

**Czego nie wolno zmienić przy okazji:**

- `resolveViewport3DFieldVectorIdentityMatch` i żaden inny matcher tożsamości — ani o linijkę, ani w stronę luźniejszą.
- Zachowanie funkcjonalne LR-03: przy `status === "ready"` z **niezgodnym** identity nadal pokazujemy ostatnią zgodną klatkę; przy niezgodności samej retencji (zmiana domeny, generacji, remesh) nadal `null` plus `tracker.recordRetentionRejection(reason)`.
- `fieldVectorDisplayedRevision` nadal musi wskazywać rewizję **faktycznie pokazanej** klatki, także gdy pochodzi z retencji.

Wyczyść pamięć retencji, gdy matcher odrzuca jej zawartość — nie trzymaj `DecodedFieldVector` po zmianie geometrii lub domeny.

---

## H2 — bramka regresyjna dla tej klasy błędu (P0, razem z H1)

Dwa testy. Pierwszy jest obowiązkowy, drugi silnie zalecany.

### H2.1 — test punktu stałego (obowiązkowy, bez Reacta)

W `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`:

Dla **każdej** ścieżki resolvera, która zwraca niepusty `nextRetained` (świeży odczyt przy `ready` + zgodność; retencja przy `ready` + niezgodność; retencja przy `stale`/`loading`), wywołaj resolver, weź jego `nextRetained`, podaj go z powrotem jako `retained` przy niezmienionych pozostałych argumentach i asercjonuj `toBe` — **tożsamość referencyjną**, nie `toEqual`.

Dodaj też wariant iteracyjny: pętla do 10 przebiegów, która przerywa, gdy `nextRetained === retained`, i zawodzi test, jeśli po 10 przebiegach nie ma stabilizacji. Nazwij go jednoznacznie, np. `"reaches a retention fixed point in one step (regression: render loop)"`.

### H2.2 — test na poziomie renderu (zalecany)

W repo nie ma `@testing-library/react`, ale jest działający wzorzec: `act` z `"react"` + `createRoot` z `"react-dom/client"` + `installSimulationPreparationTestDom` z `@/kernel/layout/simulationPreparationTestDom.test-support`. Przykład użycia: `apps/control-room/src/modules/viewport-3d/hooks/usePrimitiveDraftOverlay.test.tsx`.

Nie renderuj całego `useViewport3DSceneModel` — to zbyt duży graf zależności. Napisz **minimalny komponent**, który odtwarza sam wzorzec synchronizacji (useMemo z resolverem + zapis stanu w renderze), licz renderowania i asercjonuj, że ustabilizuje się w co najwyżej dwóch renderach.

Jeżeli uznasz, że H2.2 jest nieproporcjonalnie kosztowny, możesz go pominąć — ale **musisz to wprost uzasadnić w raporcie**, a H2.1 zostaje obowiązkowy.

---

## H3 — domknięcie B4 po stronie toru FEM (P1)

**Plik:** `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`

W commicie `7effe3392` bramkę montażu zamieniono na `<group visible={…}>` tylko dla dwóch poddrzew FDM: **linie 1290 i 1395**. Tor FEM nadal odmontowuje poddrzewa:

- **linie 1419–1421** — `{!fdmLaneActive && stageVisibility.baseGeometry && viewport3DAirboxLayerEnabledFromBrowserConfig() ? (<AirboxLayer …/>) : null}`
- **linie 1457–1459** — `{!fdmLaneActive && stageVisibility.baseGeometry && viewport3DTopologyMeshLayerEnabledFromBrowserConfig() ? (<TopologyMeshLayer …/>) : null}`

Dziś jest to nieszkodliwe, bo dla toru FEM `hasCompatibleContent` (**linia 1879**) to `Boolean(topologyModel && isViewport3DTopologyRenderable(topologyFreshness))`, więc reset etapu do 0 zachodzi tylko wtedy, gdy i tak nie ma czego pokazać. Ale ochrona strukturalna, o którą w B4 chodziło — przetrwanie materiałów, geometrii i buforów GPU przez przejście etapów — istnieje wyłącznie po stronie FDM.

**Do zrobienia:** przenieś `stageVisibility.baseGeometry` z warunku renderowania do sterowania widocznością, analogicznie do linii 1290 i 1395. Flagi `!fdmLaneActive` oraz `viewport3D*EnabledFromBrowserConfig()` zostają warunkami montażu — to są przełączniki konfiguracyjne i wyboru toru, nie etapowanie, i nie zmieniają się w trakcie live-refresh.

Nie dodawaj cross-fade ani animacji przejścia — to LR-12, poza zakresem.

**Test** w `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`: przy `stageVisibility.baseGeometry === false` i aktywnym torze FEM poddrzewa `AirboxLayer` / `TopologyMeshLayer` pozostają zamontowane i tylko niewidoczne. Jeżeli istniejąca struktura testów nie pozwala tego sprawdzić bez renderu, przetestuj wydzieloną funkcję rozstrzygającą widoczność i opisz ograniczenie w raporcie.

---

## 4. Bramki i commity

Bramki uruchom **po ostatniej edycji**, nie wcześniej:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d src/kernel/resources src/kernel/api
pnpm --dir apps/control-room audit:idle-performance
git diff --check
```

**Reguła bezwzględna:** żadnego `--amend` po zaraportowaniu wyniku. Jeżeli po commicie cokolwiek zmienisz, przepuść wszystkie bramki ponownie, dopiero potem amenduj, i zaraportuj SHA przed i po.

Dwa commity:

```
fix(viewport-3d): usuń pętlę renderu w retencji pola głównego (LR-03)

Resolver retencji osiąga punkt stały w jednym kroku, więc synchronizacja
pamięci ostatniej zgodnej klatki nie wymusza kolejnych renderów.
Zachowanie LR-03 bez zmian: ready + niezgodne identity nadal pokazuje
ostatnią zgodną klatkę, niezgodna retencja nadal daje null i licznik
odrzucenia.

Regres wprowadzony w cb22087d2.
Plan: docs/audits/2026-09-13-live-refresh-remediation-masterplan.md, Faza 1
```

```
fix(viewport-3d): nie odmontowuj warstw toru FEM przy etapowaniu (LR-01)

AirboxLayer i TopologyMeshLayer są sterowane widocznością zamiast
warunkowego montażu, symetrycznie do poddrzew FDM. Materiały, geometrie
i bufory GPU przetrwają przejście etapów w obu torach.

Plan: docs/audits/2026-09-13-live-refresh-remediation-masterplan.md, Faza 2
```

Nie pushuj, nie merguj, nie twórz PR.

## 5. Czego nie robić

- Nie cofaj `cb22087d2` ani `7effe3392` — Część B siedzi na Części A; poprawiaj na wierzchu.
- Nie dotykaj `build-engine/gpu/viewport3dGpuUploadManager.ts` (LR-05), `hooks/useViewport3DChunkedScalarColors.ts` (LR-06), `kernel/realtime/RealtimeInvalidationBridge.ts` (LR-07), `kernel/resources/planarFieldResources.ts` ani `modules/field-map/**` (LR-10).
- Nie dotykaj `layers/VectorFieldLayer.tsx` ani `vectorGlyph*` — konflikt z `codex/frontend-refactoring-20260912`.
- Nie zmieniaj `canRetainViewport3DScalarUploadBuffer` ani matcherów tożsamości.
- Nie zmieniaj `hasCompatibleContent` w `Viewport3DScene.tsx` — jego efekt uboczny (pominięcie etapowania przy remeshu z obecnymi danymi) jest znany i zostanie zmierzony w Fazie 0, nie zgadywany teraz.
- Nie refaktoryzuj `useViewport3DSceneModel.ts` przy okazji.

## 6. Raport końcowy

1. SHA bazowy i SHA obu commitów.
2. Wynik każdej bramki.
3. Które podejście wybrałeś w H1 (`useRef` czy stabilizacja referencji) i dlaczego.
4. Dowód punktu stałego: nazwa testu H2.1 i jego wynik. Jeżeli pominąłeś H2.2 — uzasadnienie.
5. Lista zmienionych plików z opisem zmiany.
6. Potwierdzenie, że zachowanie LR-03 nie uległo zmianie: który test to pokrywa.
7. Rozbieżności wobec podanych numerów linii.
