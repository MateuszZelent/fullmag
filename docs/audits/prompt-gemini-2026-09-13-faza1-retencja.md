# Zadanie dla Gemini — FullMag, Faza 1: granica retencji pola (LR-03 + LR-04 + LR-02 + LR-14)

## 0. Gdzie pracujesz

**Repozytorium:** `C:\git\fullmag\fullmag`
**Gałąź:** `master`. Pracujesz **bezpośrednio na `master`**, nie na worktree. Nie twórz nowej gałęzi, nie przełączaj HEAD, nie używaj `C:\git\fullmag\worktrees\*`.
**Oczekiwany commit bazowy:** `6e047055c9615ab15cc88a638d6e93101972dcf8`.

Zanim cokolwiek zmienisz, wykonaj:

```bash
cd /mnt/c/git/fullmag/fullmag   # albo C:\git\fullmag\fullmag w PowerShell
git rev-parse HEAD
git status --porcelain
```

- Jeśli `HEAD` ≠ `6e047055c9615ab15cc88a638d6e93101972dcf8` — **zatrzymaj się i zgłoś**. Numery linii w tym zadaniu odnoszą się do tego commita.
- Jeśli `git status --porcelain` pokazuje niezacommitowane zmiany w `apps/control-room/` — **zatrzymaj się i zgłoś**, co widzisz. Nie nadpisuj cudzej pracy.
- Zmiany w innych obszarach (`crates/`, `docs/`) możesz zignorować, ale **nie włączaj ich do swojego commita**.

**Uwaga o końcach linii:** repozytorium ma mieszane końce linii (część blobów zawiera CRLF). Nie uruchamiaj żadnej masowej normalizacji EOL, nie zmieniaj `.gitattributes`, nie formatuj plików, których nie dotyczy zadanie. `git diff --check` musi przechodzić.

---

## 1. Obowiązkowa lektura przed rozpoczęciem

Przeczytaj w tej kolejności — bez tego nie masz kompletu informacji:

1. `docs/audits/2026-09-13-live-refresh-remediation-masterplan.md` — **dokument nadrzędny**. Rejestr ustaleń LR-01…LR-26, errata, plan faz, kryteria akceptacji. Twoje zadanie to **Faza 1** oraz część instrumentacji z **Fazy 0** (§6 tego dokumentu).
2. `docs/audits/2026-09-11-active-simulation-render-synchronization-audit.md` — audyt Codeksa. Istotne sekcje: **R1** (§5, „`ready` z odrzuconą odpowiedzią może usunąć zgodną poprzednią warstwę") i **R4** (§5, „Walidacja retencji nie obejmuje całej semantyki zapytania").
3. `docs/audits/2026-09-11-viewport-3d-live-refresh-flicker-audit.md` — audyt Claude. Istotna sekcja: **VPF-002** („`publish(null)` gasi kolory, mimo że dane na GPU są poprawne").
4. `docs/audits/2026-09-11-live-refresh-audits-comparison.md` — rozstrzygnięcia rozbieżności. Istotne: **§4.2 „Null i bezpieczna retencja"** — wyjaśnia, dlaczego **nie wolno** poluzować klucza retencji do `geometry + vertexCount`.
5. `AGENTS.md` w katalogu głównym repozytorium — obowiązujące konwencje pracy w tym repo.

Mapowanie identyfikatorów: `LR-03` = `R1`, `LR-04` = `R4`, `LR-02` = `VPF-002`, `LR-14` = `S3`.

---

## 2. Zasady, których repozytorium pilnuje automatycznie

Naruszenie któregokolwiek wywali CI:

- **Zero `any` / `as any`** w `src/`. Zero nowych `@ts-expect-error`.
- **Zero `TODO` / `FIXME` / `HACK`** w kodzie źródłowym. Dług śledzony jest w dokumentach, nie w komentarzach.
- **Zero `console.log` / `console.debug`** w kodzie produkcyjnym.
- Zakaz importów między modułami z pominięciem `public.ts`; zakaz importów z kernela do wnętrza modułów. Egzekwuje `scripts/check-architecture-hygiene.mjs`.
- `eslint . --max-warnings=0` — zero ostrzeżeń, nie tylko zero błędów.
- Każda zmiana zachowania ma mieć test. Repo trzyma ~73 % gęstości testów; nie obniżaj jej.

---

## 3. Kontekst merytoryczny — co naprawiasz i dlaczego

Podczas aktywnej symulacji backend publikuje próbki pól co ~2 s (`field_sample_publish_ms = 2000`). Przy każdej takiej aktualizacji shadery obiektów i nakładka pola demagnetyzującego na chwilę znikają i wracają do stanu bazowego. Cała animacja mruga.

Faza 1 domyka **jedną decyzję**: *kiedy wolno pokazać poprzednią klatkę pola*. Dziś ta decyzja jest rozstrzygana w trzech miejscach niespójnie:

- **LR-03** — kolekcja pól przy statusie `ready` i niezgodnym identity **porzuca** poprzedni zgodny envelope zamiast go zachować;
- **LR-04** — matcher tożsamości nie sprawdza `snapshot_id`, `stage_id`, `phase_rad` ani `view`, więc retencja może pokazać starą fazę pod etykietą nowej;
- **LR-02** — upload kolorów publikuje `null`, co gasi próbkowanie kolorów w materiale, mimo że atrybut GPU nadal zawiera poprawne dane.

Te trzy trzeba zrobić **razem i w tej kolejności**. Sam LR-03 bez LR-04 to regresja poprawności: zaczniesz zachowywać klatki, które semantycznie nie pasują do nowego żądania.

---

## 4. Zadanie 1 — LR-04: domknięcie tożsamości żądania pola

**Plik:** `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
**Funkcja:** `viewport3DFieldVectorMatchesRequestIdentity`, **linia 267**.

Obecnie porównuje: kanoniczne `quantityId`, `scope_kind` / `scope_id`, `expected_generation_id`, `expected_carrier_revision`, `component`.

**Nie porównuje** — i to jest błąd: `snapshot_id`, `stage_id`, `phase_rad`, `view`.

Pełna lista selektorów semantycznych jest w `apps/control-room/src/kernel/api/fieldQueryIdentity.ts`, interfejs `CanonicalFieldVectorQuery`:

```ts
component, componentExplicit, expectedCarrierRevision, expectedGenerationId,
geometryScope, maxSamples, ownerObjectId, phaseRad, quantityId,
scopeId, scopeKind, scopeKindExplicit, snapshotId, stageId, view
```

**Do zrobienia:**

1. Odczytaj aktualną definicję `FieldVectorQuery` w `apps/control-room/src/kernel/api/apiTypes.ts` (znajdź po nazwie symbolu — nie polegaj na numerze linii, ten plik zmieniał się ostatnio).
2. Rozszerz matcher o porównanie `snapshot_id`, `stage_id`, `phase_rad`, `view`. Dla każdego: brak wartości w żądaniu i brak w odpowiedzi = zgodne; wartość w żądaniu i inna/brakująca w odpowiedzi = **niezgodne**.
3. `max_samples` i `geometry_scope` **celowo pomiń** — to parametry budżetu/próbkowania, nie semantyki; ich zmiana nie czyni poprzedniej klatki fałszywą. Udokumentuj tę decyzję jednozdaniowym komentarzem w kodzie (komentarz wyjaśniający, nie `TODO`).
4. Zwracana wartość ma się zmienić z `boolean` na dyskryminowany wynik, żeby dało się zaraportować **powód** odrzucenia — jest potrzebny w Zadaniu 4:

```ts
export type Viewport3DFieldIdentityMismatchReason =
  | "quantity" | "scope" | "generation" | "carrier"
  | "component" | "snapshot" | "stage" | "phase" | "view";

export type Viewport3DFieldIdentityMatch =
  | { readonly matches: true }
  | { readonly matches: false; readonly reason: Viewport3DFieldIdentityMismatchReason };
```

Zachowaj cienki wrapper `viewport3DFieldVectorMatchesRequestIdentity(...): boolean` dla istniejących wywołań, a nową funkcję nazwij `resolveViewport3DFieldVectorIdentityMatch(...)`. Zaktualizuj wszystkie miejsca wywołania w `viewport3dResources.ts` i w `useViewport3DSceneModel.ts` (szukaj po nazwie symbolu).

**Test:** `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts` — dopisz zestaw przypadków: dla każdego z czterech nowych selektorów zmiana wartości przy niezmienionej reszcie tożsamości daje `matches: false` z właściwym `reason`. Dodaj przypadek negatywny: zmiana samego `max_samples` **nie** psuje zgodności.

---

## 5. Zadanie 2 — LR-03: zachowanie zgodnej poprzedniej klatki przy `ready`

**Plik:** ten sam.
**Funkcja:** `resolveViewport3DFieldVectorCollectionLastGood`, **linia 359**.
**Wadliwa linia:** **385** — `if (status === "ready") continue;`

Obecna logika: gdy `status === "ready"`, a bieżący envelope nie pasuje do żądania (albo go nie ma), pętla robi `continue` i **pomija fallback na `previous`**. Fallback działa tylko dla `error` / `loading` / `stale`. W efekcie odpowiedź zakończona transportowo, ale semantycznie niezgodna, kasuje poprawną widoczną warstwę.

**Do zrobienia:**

1. Usuń wczesne `continue` dla `ready`. W tej gałęzi spróbuj tak samo jak w pozostałych: jeśli `previousEnvelope` istnieje **i** przechodzi `resolveViewport3DFieldVectorIdentityMatch` względem bieżącego żądania — zachowaj go.
2. Rozszerz `Viewport3DFieldVectorEnvelope` (**linia 113** tego samego pliku) o pole informujące, że wpis jest retencjonowany, a nie świeży:

```ts
readonly retained?: boolean;   // true = ostatnia zgodna klatka, nie odpowiedź na bieżące żądanie
```

Envelope zachowany w tej ścieżce oznaczaj `retained: true`. Envelope przyjęty jako świeży pozostaje bez tej flagi (lub `retained: false`).
3. **Granica bezpieczeństwa — nie do pominięcia:** retencja nie może przeżyć zmiany domeny, remeshu, zmiany sesji ani usunięcia targetu. Te przypadki są już pokryte przez `expected_generation_id` / `expected_carrier_revision` w matcherze z Zadania 1 — upewnij się, że nowa ścieżka `ready` **przechodzi przez ten sam matcher**, a nie przez jakiekolwiek luźniejsze porównanie.

**Test:** w `viewport3dResources.test.ts` scenariusz A → B → C:
- A: odpowiedź zgodna, przyjęta;
- B: `status === "ready"`, envelope o **niezgodnym** identity (np. inna `quantityId`), przy `previous` = A;
- C: odpowiedź zgodna.

Asercja: w kroku B kolekcja **nadal zawiera A** oznaczone `retained: true`; w kroku C zawiera C bez flagi. Drugi scenariusz: zmiana `expected_generation_id` w kroku B ma dać **pustą** kolekcję (retencja słusznie odrzucona).

---

## 6. Zadanie 3 — LR-02: rozdzielenie „brak danych" od „dane nieświeże"

**Plik:** `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts`

Kotwice:
- `interface Viewport3DScalarColorUploadSnapshot` — **linia 57**
- `canRetainViewport3DScalarUploadBuffer` — **linia 82**
- `useViewport3DScalarColorUpload` — **linia 159**, z `store.publish(null, geometry, null)` w **liniach 219 i 243**
- `useViewport3DScalarShaderColorUpload` — **linia 350**, z `store.publish(null, geometry, null)` w **liniach 406 i 440**

Problem: te cztery publikacje `null` powodują, że hook zwraca `buffer: null`. Konsument (`MeshPartLayer`) bramkuje próbkowanie kolorów **na zwracanej wartości hooka**, a nie na stanie atrybutu geometrii. Atrybut GPU nadal zawiera poprawne dane poprzedniej klatki — `viewport3dGeometryColors.ts` celowo go nie zeruje (jest tam komentarz opisujący wcześniejszy błąd „flash to black") — ale materiał i tak przestaje je próbkować i powierzchnia wraca do płaskiego koloru.

**Do zrobienia:**

1. Rozszerz snapshot publikowany przez store o rozróżnienie:

```ts
interface Viewport3DScalarColorUploadSnapshot {
  buffer: ScalarColorBuffer | null;
  fresh: boolean;          // false = ostatni dobry bufor, nie odpowiedź na bieżące żądanie
  geometry: BufferGeometry | null;
  retentionKey: string | null;
  version: number;
}
```

2. W czterech miejscach publikacji `null`: jeżeli w store jest bufor dla **tej samej** `geometry` i przechodzi `canRetainViewport3DScalarUploadBuffer`, publikuj go z `fresh: false` zamiast `null`. `buffer: null` zostaw wyłącznie dla sytuacji, w której naprawdę nie ma czego pokazać (inna geometria, brak jakiegokolwiek wcześniejszego bufora).
3. **Nie zmieniaj `canRetainViewport3DScalarUploadBuffer`** — w szczególności **nie wprowadzaj** fallbackowego `retentionKey` z `geometry + vertexCount`. To zalecenie zostało wycofane jako niebezpieczne (`docs/audits/2026-09-11-live-refresh-audits-comparison.md`, §4.2 — ta sama geometria i liczba wierzchołków mogą dotyczyć innej quantity, snapshotu, fazy lub etapu). Retencja ma nadal wymagać jawnego, pełnego `retentionKey`.
4. Publiczny typ zwracany przez oba hooki zmień tak, żeby konsument widział `fresh`. Zaktualizuj konsumentów:
   - `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx` — wywołania w **liniach 868** (`useViewport3DScalarShaderColorUpload`) i **887** (`useViewport3DScalarColorUpload`), scalanie w **linii 908** (`resolveMeshPartCommittedScalarColorState`), konsumpcja `hasUploadedVertexScalarColors` w **liniach 956, 1069, 1140, 1162**.
   - `apps/control-room/src/modules/viewport-3d/layers/meshPartScalarTransition.ts` — funkcja `resolveMeshPartCommittedScalarColorState` ma przepuszczać `fresh` dalej.
   - `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx` — **tylko dostosowanie typów**, żeby się kompilowało. Tego komponentu nie naprawiaj merytorycznie (to LR-11, osobne zadanie, komponent nie jest renderowany produkcyjnie).
5. **Reguła docelowa:** materiał gasi `vertexColors` / shader scalar colors **wyłącznie** gdy `buffer === null`. `fresh: false` znaczy „pokazuj dalej, oznacz jako nieaktualne" — nie „przestań pokazywać".

**Test:** `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.test.ts` — sekwencja rewizji z jedną przerwą w dostępności `colorBuffer` przy niezmienionej `geometry` i niezmienionym `retentionKey` **nie** daje `buffer === null`; daje `fresh: false`. Drugi przypadek: zmiana `geometry` daje `buffer === null`. W `MeshPartLayer.test.ts` dopisz asercję, że taka przerwa **nie** przełącza `vertexColors` na `false`.

---

## 7. Zadanie 4 — LR-14: diagnostyka, bez której nie da się tego domknąć

Wszystkie ustalenia są potwierdzone w kodzie, żadne w runtime. Ta instrumentacja jest warunkiem zamknięcia Fazy 1 i wejściem do Fazy 0 z planu.

**Pliki:**
- `apps/control-room/src/modules/viewport-3d/viewport3dTypes.ts` — `VIEWPORT_3D_DIRTY_REASONS` / `Viewport3DDirtyReason`, **linia 80**
- `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts` — tracker, `recordDirtyFrame` w **linii 233**, `Viewport3DDirtyReasonCounts` w **linii 133**

**Do zrobienia:**

1. Dodaj do trackera licznik odrzuceń retencji z podziałem na powód — użyj `Viewport3DFieldIdentityMismatchReason` z Zadania 1. Proponowana metoda: `recordRetentionRejection(reason)`.
2. Wywołuj ją z obu miejsc, w których retencja zostaje odrzucona: `resolveViewport3DFieldVectorCollectionLastGood` (Zadanie 2) i ścieżki `publish(null, …)` w uploadzie kolorów (Zadanie 3 — tu powód `"geometry"` albo `"retention-key"`, rozszerz typ o te dwa warianty, jeśli trzeba).
3. Wyeksponuj czwórkę rewizji w istniejącym kanale diagnostyki viewportu: `requestedRevision`, `receivedRevision`, `preparedRevision`, `displayedRevision`. Trzy pierwsze są już dostępne w `viewport3dResources.ts` i w snapshotach zasobów; `displayedRevision` weź z envelope faktycznie przekazanego do warstwy (po Zadaniu 2 rozróżnisz świeży od retencjonowanego).
4. Nie dodawaj `setInterval`, nowego store'u ani nowego transportu. Wpinaj się w istniejący `Viewport3DResourceTracker` i istniejący publisher diagnostyki.

**Test:** `viewport3dDiagnostics.test.ts` — liczniki rosną dla właściwych powodów i nie rosną dla ścieżki zgodnej.

---

## 8. Bramki do uruchomienia przed commitem

Uruchom **wszystkie**, w tej kolejności, z katalogu głównego repozytorium:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d src/kernel/resources src/kernel/api
pnpm --dir apps/control-room audit:idle-performance
git diff --check
```

Jeżeli pełny `vitest run` jest wykonalny czasowo — uruchom go zamiast zawężonego. Każda bramka musi przejść. **Nie commituj przy czerwonej bramce** — zgłoś, co nie przechodzi i dlaczego.

---

## 9. Commit

Po zielonych bramkach, na `master`:

```bash
git add apps/control-room/src
git commit
```

Do commita włącz **wyłącznie** pliki, które zmieniłeś w ramach zadań 1–4. Nie dodawaj `docs/`, `crates/`, plików budowania, cache'y ani niczego z `.next*`.

Treść komunikatu:

```
fix(viewport-3d): domknij granicę retencji pola live (LR-02, LR-03, LR-04, LR-14)

- LR-04: matcher tożsamości żądania pola porównuje teraz snapshot_id,
  stage_id, phase_rad i view; zwraca powód niezgodności
- LR-03: przy status=ready i niezgodnym envelope zachowywana jest
  ostatnia zgodna klatka (retained: true) zamiast pustej kolekcji
- LR-02: upload kolorów rozróżnia brak danych (buffer=null) od danych
  nieświeżych (fresh=false); materiał gasi kolory tylko w pierwszym
  przypadku
- LR-14: liczniki odrzuceń retencji z powodem oraz czwórka rewizji
  requested/received/prepared/displayed w diagnostyce viewportu

Plan: docs/audits/2026-09-13-live-refresh-remediation-masterplan.md, Faza 1
```

Nie pushuj. Nie merguj. Nie twórz PR.

---

## 10. Czego nie robić

- Nie dotykaj `layers/Viewport3DScene.tsx` — staged reveal to LR-01, Faza 2, osobne zadanie.
- Nie dotykaj `build-engine/gpu/viewport3dGpuUploadManager.ts` — to LR-05, Faza 3.
- Nie dotykaj `hooks/useViewport3DChunkedScalarColors.ts` — to LR-06, Faza 4.
- Nie dotykaj `kernel/realtime/RealtimeInvalidationBridge.ts` — to LR-07, Faza 5.
- Nie dotykaj `layers/VectorFieldLayer.tsx` ani plików `vectorGlyph*` — są aktywnie edytowane na gałęzi `codex/frontend-refactoring-20260912`, dostaniesz konflikt.
- Nie zmieniaj `field_sample_publish_ms` ani żadnych interwałów. Wydłużenie okna schowa objaw i pogorszy płynność.
- Nie zamieniaj `frameloop="demand"` na stałą pętlę, nie maskuj przejść opóźnieniem CSS, nie dodawaj cross-fade w tej fazie.
- Nie luzuj `canRetainViewport3DScalarUploadBuffer`. Pokazanie starej fazy pod nową etykietą jest gorsze niż mignięcie.
- Nie refaktoryzuj `useViewport3DSceneModel.ts` (6575 linii) przy okazji — to osobny dług z ADR 0015.

---

## 11. Raport końcowy

Po commicie napisz zwięzłe podsumowanie:

1. SHA commita bazowego i SHA utworzonego commita.
2. Lista zmienionych plików z krótkim opisem zmiany w każdym.
3. Wynik każdej bramki z §8 (PASS/FAIL, przy FAIL — pełny komunikat).
4. Nowe testy: nazwy plików i nazwy przypadków.
5. Decyzje projektowe, które podjąłeś sam, bo zadanie ich nie rozstrzygało — szczególnie sposób propagacji `fresh` przez `resolveMeshPartCommittedScalarColorState` i wybór wariantów powodu odrzucenia retencji.
6. Wszystko, co napotkałeś, a co jest niezgodne z opisem w tym zadaniu — w szczególności jeśli numery linii nie zgadzały się z rzeczywistością (to znaczy, że `HEAD` nie jest tym, czego oczekiwano).
