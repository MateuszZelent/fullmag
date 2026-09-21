# 02. Sprostowania do `raport_gemini/`

Raport Gemini jest w większości rzetelny i miejscami trafnie wzmacnia plan. Poniżej
wyłącznie te miejsca, które wymagają korekty, bo w obecnym brzmieniu **prowadziłyby do
błędnych decyzji wdrożeniowych**. Kolejność według wagi.

---

## S1 — `ViewportTabHost.tsx:76` nie jest usterką; rekomendowana „naprawa” łamie ADR-0016

**Co twierdzi Gemini:**
`raport_gemini/05-krytyczne-sprostowania-i-gleboka-analiza.md` §5 nazywa
`key={activeModule.id}` „kluczowym błędem” i „drugim, równie niszczycielskim źródłem utraty
stanu WebGL”. `raport_gemini/04-rekomendacje-dla-ui-comsol-cst.md` §5.1 i §7 podnoszą to do
rangi zadania Fazy P1: *„Zastąpić keyed mounting w `ViewportTabHost.tsx:76` trwałym
montowaniem zakładek (Persistent Viewport Surface)”*, z konkretnym kodem
`style={{ display: module.id === activeModule.id ? "contents" : "none" }}`.

**Stan faktyczny:**

`docs/adr/0016-center-viewport-tabbed-surfaces.md`, status **accepted**, data 2026-05-30,
amended 2026-08-03, sekcja *Consequences*:

> *„Switching to a non-3D center tab **must unmount** `Viewport3DModule`; hiding it with CSS
> is **not sufficient**.”*
> *„Inactive center tabs must not keep resource hooks, WebGL canvases, animation frames,
> object URLs, workers, or large render buffers alive.”*

sekcja *Implementation Obligations*:

> *„Add a generic `ViewportTabHost` in kernel layout. It reads manifests for `viewport-main`
> and **mounts only the active manifest**.”*

sekcja *Validation*:

> *„Browser smoke proves zero active 3D canvas nodes while cross-section or plot tabs are
> active and exactly one WebGL canvas when `3D Scene` is active.”*

`ViewportTabHost.tsx` jest zatem **dokładną, celową realizacją tego ADR**, a nie regresją.

**Istnieje działający strażnik tej reguły w CI:**
`apps/control-room/scripts/audit-viewport-main-tab-memory.mjs:397-408`

```js
export function assertInactiveTabObservation(observation) {
  const failures = [];
  ...
  if (observation.canvasCount > 0 || observation.rootCount > 0) {
    failures.push(
      `3D DOM remains mounted (canvas=${observation.canvasCount}, root=${observation.rootCount})`,
    );
  }
  ...
```

Audyt sprawdza także `threeDRequests`, `viewport3DRenderMeasuresDelta`,
`clientAckRequestsDelta` i `workerJobsDelta`. Wdrożenie rekomendacji Gemini **spowoduje
twardy failure tego audytu**.

**Rekomendacja Gemini jest ponadto sprzeczna z jego własnym raportem.**
W `05-krytyczne-sprostowania...md` §4.2 ten sam dokument argumentuje:

> *„Gdy solver GPU zaalokuje niemal cały dostępny VRAM (np. 15.5 GB z 16 GB), sterownik
> graficzny … zresetuje kontekst 3D przeglądarki.”*
> *„…solver powinien rezerwować margines bezpieczeństwa VRAM (np. 1.5–2.0 GB)…”*

To jest dosłownie uzasadnienie, dla którego ADR-0016 nakazuje zwalnianie kontekstu WebGL
nieaktywnych powierzchni. Nie można jednocześnie domagać się rezerwy VRAM i trzymać
zamontowanych wszystkich powierzchni renderujących.

**Diagnoza jest także technicznie niepełna.** `ViewportTabHost.tsx:74-81` renderuje
wyłącznie `activeModule` — nie listę modułów. Usunięcie samego `key` **nie zmieniłoby
niczego**: przy zmianie zakładki zmienia się `manifest`, więc i tak montowany jest inny
moduł. Postulat „usunięcia `key`” jako osobnego kroku jest bezprzedmiotowy.

**Co jest prawdziwym problemem UX i co należy zrobić zamiast tego:**

Koszt ponownego montowania 3D po powrocie z zakładki 2D/wykresów jest realny — ale
rozwiązaniem zgodnym z ADR-0016 jest **skrócenie ścieżki rehydratacji**, nie utrzymywanie
kanwy:

1. Trwały, poza-modułowy cache geometrii/topologii i deskryptorów w `ResourceRuntimeStore`,
   tak by powrót do 3D nie wywoływał ponownego pobrania po sieci (audyt już dziś sprawdza
   `threeDRequests` **tylko dla zakładek nieaktywnych**, więc cache jest dozwolony).
2. Zapamiętanie stanu kamery/`OrbitControls` w `viewport3dStore` (store przeżywa unmount
   modułu), żeby powrót nie resetował widoku — to jest realna część skargi Gemini i **da
   się ją spełnić bez naruszenia ADR**.
3. Prekompilacja materiałów/shaderów przy pierwszym montowaniu i cache po stronie modułu.
4. Jeśli mimo to zespół uzna, że trwała kanwa jest konieczna: **wymagany jest nowy ADR**
   superseding ADR-0016 (jego własna sekcja *Rollback* mówi: *„Reintroducing live WebGL 2D
   rendering would require a new ADR and the same active-only lifecycle proof”*).
   Nie wolno tego zrobić jako „naprawy usterki” w P1.

**Plan `01-architektura-cae.md` §23.3 jest tu poprawny** i nie wymaga zmiany:
*„Podstawowy workspace ma jeden aktywny viewport.”*

---

## S2 — „50+ komponentów frontendu używa `/v2/sessions/current/*`” jest nieprawdą

**Co twierdzi Gemini:** `raport_gemini/03-ocena-planu-migracji-i-ryzyk.md` §3.3:
*„W `apps/control-room` ponad 50 komponentów korzysta z endpointów `/v2/sessions/current/*`.
Zmiana wszystkich endpointów … w jednym kroku spowoduje paraliż frontendu.”*
Na tej podstawie proponuje `VirtualSessionAdapter` w Axum jako jedną z czterech
„krytycznych strategii implementacyjnych”.

**Pomiar w `apps/control-room/src`:**

```text
pliki zawierające 'sessions/current'                              : 22
wystąpień łącznie                                                 : 1235
  w tym kernel/api/generated/openapi-v2.json                      :  239
       kernel/api/generated/openapi-v2-types.ts                   :  239
       kernel/api/generated/openapi-v2-paths.ts                   :  239
       kernel/api/apiPaths.ts                                     :  239
       kernel/api/ControlRoomApi.test.ts                          :  219
       pozostałe – wyłącznie pliki *.test.*                       :   ~60

pliki produkcyjne, nie-generowane                                 :    2
  kernel/api/apiPaths.ts
  kernel/visualization/VisualizationRegistrySyncController.ts
```

Frontend ma **jeden punkt styku** ze ścieżkami: `apiPaths.ts` (995 linii), zasilany
z `generated/openapi-v2-paths.ts`. Istnieje nawet strażnik higieny:
`apps/control-room/scripts/check-api-hygiene.mjs` — a ADR-0016 wymienia w *Validation*:
*„API hygiene checks prove no direct component `fetch()` and no hand-built `/v2/...`
strings in modules.”*

**Konsekwencja:** migracja ścieżek po stronie frontendu sprowadza się do regeneracji
kontraktu OpenAPI i zmiany jednego pliku fasady. `VirtualSessionAdapter` **nie jest
potrzebny do ochrony frontendu**.

**Gdzie naprawdę leży ryzyko (odwrócenie wektora):**

```text
pliki .rs w crates/ zawierające 'sessions/current'   : 59
  w tym crates/fullmag-runner (54 wystąpienia)
       crates/fullmag-api  (main.rs, openapi_v2.rs, ~35 handlerów)
       crates/fullmag-cli  (control_room, dev_smoke, interactive_runtime_host,
                            live_workspace, scratch_runtime)
pliki w scripts/                                     : 64
pliki w apps/control-room/scripts/                   : 43
```

Sprzężenie jest **backendowe**, a najbardziej niepokojące jest w `fullmag-runner` — czyli
w komponencie, o którym `03-migracja.md` §2 pisze: *„Nie odczytuje mutowalnego globalnego
modelu”*. To założenie planu jest dziś **niespełnione**, i to nie tylko w kodzie, ale
i w produkowanych danych (patrz luka L2 w `03-luki-i-bledy-planu.md`).

**Skorygowana rekomendacja:** adapter zgodności jest potrzebny, ale ma chronić
**skrypty CI/e2e (107 plików) i `fullmag-cli`**, nie Control Room. Priorytet ekstrakcji
w P3/P5 należy przesunąć z frontendu na `fullmag-runner` i generatory manifestów.

---

## S3 — „Repozytorium znajduje się na commicie 31bac…” — nieprawda dla tego checkoutu

`raport_gemini/01-weryfikacja-kodu-i-faktow.md`, E01: *„Potwierdzono. Repozytorium
znajduje się na commicie `31bac350a15c0af070287de92d4e0c1a6dabab0e`. Wszystkie ścieżki i
struktury plików odpowiadają stanowi z tego SHA.” — Ocena: Prawda (100% zgodności).*

Stan faktyczny lokalnego repozytorium, w którym te dokumenty leżą:

```text
HEAD                                        33aa26fe8b48b6df1bab77e96eb31afa6c6b90a8 (14.09.2026)
baza deklarowana                            31bac350a15c0af070287de92d4e0c1a6dabab0e (15.09.2026)
git merge-base --is-ancestor HEAD 31bac...  YES   # HEAD jest przodkiem bazy
git rev-list --count HEAD..31bac...         18    # 18 commitów różnicy
```

Weryfikacja Gemini nie mogła być wykonana „na commicie bazowym” bez `git show` — a treść
raportu nie wskazuje, by takie odczyty wykonano. Sprawdziłem, że dla 18 plików kluczowych
treść na `HEAD` i na bazie jest identyczna, więc **wnioski pozostają ważne**. Deklaracja
„100% zgodności” jednak nie została faktycznie zweryfikowana na deklarowanym commicie.

---

## S4 — „Meshing nie alokuje VRAM” — teza prawdopodobna, ale nieudowodniona cytowanym plikiem

Gemini (`05-…md` §4.1) twierdzi: *„Generowanie siatki w Fullmagu jest realizowane przez
pakiet `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` oraz silnik Gmsh…
**Meshing w Fullmagu nie alokuje ani jednego megabajta pamięci VRAM**”*.

Wniosek jest najprawdopodobniej prawdziwy (Gmsh jest CPU-bound), ale:
- `mesh_build_report.py` to, jak sama nazwa wskazuje, **raport** z budowy siatki, a nie
  miejsce alokacji pamięci — cytowanie nie dowodzi tezy;
- twierdzenia ilościowe w tym samym akapicie („4–8 GB VRAM przy 500k elementów FEM”,
  „16 GB”) nie mają w repozytorium żadnego oparcia pomiarowego;
- zgodnie z `04-scenariusze.md` §17 („Nie wpisujemy fikcyjnych wyników ani jednego limitu
  dla wszystkich hostów i rozmiarów modeli”) takie liczby nie powinny trafiać do raportu
  jako ustalenia.

**Rekomendacja:** przenieść tezę i liczby do spike'u „Data residency” jako hipotezy do
zmierzenia. Sama **rekomendacja architektoniczna** (semafor GPU per urządzenie, obsługa
`webglcontextlost`/`webglcontextrestored`) jest słuszna i warta wdrożenia niezależnie od
tego, czy liczby się potwierdzą.

---

## S5 — Narzut „600 ms – 2.5 s” jest estymacją, nie pomiarem

Liczba pojawia się trzykrotnie (`00-…md` §2.5, `05-…md` §6.3, `04-…md` §6 w tabeli
porównawczej z COMSOL/CST) i w tabeli jest podana jako fakt obok „Natychmiastowy
(<5 ms, in-memory kompilacja Rusta)” — czyli przyszłej, również niezmierzonej wartości.

Mechanizm jest potwierdzony (patrz E14 w `01-weryfikacja-dowodow-E01-E16.md` — w
rzeczywistości są **dwa** starty interpretera, nie jeden). Wielkość narzutu — nie.
Powinna zostać oznaczona jako `NOT_MEASURED` i zmierzona w P0 jako część charakterystyki
obecnego zachowania.

---

## S6 — Oceny punktowe (9.3/10, 10/10) nie mają zdefiniowanej skali

Raport przypisuje kontraktom K01–K18 oceny od 8.5 do 10 oraz rewiduje ocenę kompletności
planu z 8.2 na 9.3 po ponownym odczycie. Nie podano kryterium ani rubryki. Ponieważ
`05-dowody-i-adr.md` planu wprost odrzuca tezy nieudowodnione, sugeruję zastąpienie ocen
liczbowych **listą warunków przyjęcia** dla każdego kontraktu. Ocena „K11: 8.5/10” nic nie
mówi wdrożeniowcowi; „K11 nie jest gotowy do implementacji, dopóki nie rozstrzygnie
reprezentacji zespolonej i redundancji `TensorChunk.object_ref` vs `TensorChunk.sha256`”
— mówi.

---

## Co w raporcie Gemini jest trafne i warto zachować

Żeby nie przeważyć obrazu krytyką, poniżej ustalenia Gemini, które potwierdziłem
i które realnie wzbogacają plan:

1. **Brak Zustanda i opis rzeczywistej architektury stanu Control Room** — potwierdzone.
   `package.json` nie zawiera `zustand`; `react`/`react-dom` = 19.2.4;
   `ResourceRuntimeStore.ts` (865 linii) + klasowe store'y + `EventBus.ts` (37 linii).
   Zalecenie, by nowe moduły CAE trzymały się tego wzorca, jest słuszne.
2. **Pętla dyskowo-skryptowa w `scratch_runtime`** — potwierdzona i, jak pokazuję w E14,
   jeszcze kosztowniejsza niż opisano.
3. **Semafor GPU per fizyczne urządzenie** dla współbieżnych runów — brakuje tego w planie
   (§18 mówi o profilach i capabilities, ale nie o limicie współbieżności na urządzenie).
   Warto dopisać, patrz `04-poprawki-do-planu-i-migracji.md`, poprawka P-07.
4. **Obsługa `webglcontextlost` / `webglcontextrestored`** — brakuje w planie i w kodzie;
   słuszne uzupełnienie scenariuszy odbioru (proponuję CAE-63).
5. **`FunctionSpaceDescriptor` z rodziną przestrzeni (H1/L2/Nédélec/Raviart-Thomas)** —
   właściwe doprecyzowanie K11.
6. **Wariant `C64`/`C128` w `TensorDtype` lub jawna konwencja osi re/im** — właściwe,
   z zastrzeżeniem o redundancji `object_ref`/`sha256` (patrz E06–E08).
7. **Strangler Fig dla `orchestrator.rs` i `contextvars` dla `world.py`** — poprawne
   konkretyzacje intencji planu; nie mam do nich zastrzeżeń.
