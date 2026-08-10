# Naprawa błędów przy zmianie quantity w Control Room

## Cel

Usunąć błędy pojawiające się przy zmianie `quantity` w Control Room dla sesji
FDM oraz ograniczyć koszt tej operacji. Po zmianie frontend nie może pokazywać
ani żądać pól, których bieżący runtime nie udostępnia.

## Diagnoza

1. `ObjectVisualizationPanelModel` buduje listę ilości ze statycznego zbioru,
   mimo że `GET /v2/sessions/current/data/fields` zwraca katalog zależny od
   sesji. Dla reprodukcji FDM katalog zawiera tylko `m`.
2. Zmiana ilości może więc ustawić `H_demag`, po czym viewport żąda pola
   nieobecnego w pamięci i ponawia nieudane zasoby.
3. FDM target view jest przekazywany do colorbara z `targetKind` obiektu, choć
   jego dane są pełnopolowym polem strukturalnej siatki. Powoduje to żądanie
   `m/meta?scope_kind=object&scope_id=film`, mimo że taki scope nie ma
   zrealizowanych komórek.
4. Airbox ma domyślne `H_demag`; dla sesji FDM bez tego pola plan zapotrzebowania
   nadal tworzy żądanie wektora airboxa.
5. Ostrzeżenia `Forced reflow` są obecnie wtórnym sygnałem kaskady renderów,
   zasobów i retry. Nie zmieniam cyklu WebGL ani nie wyciszam konsoli bez
   odtworzenia niezależnego błędu lifecycle.

### Audyt rzeczywistego runtime FDM

Późniejszy odczyt live API z `172.17.101.240:3100` zwrócił HTTP 200, ale
wykazał błąd publikacji stanu po stronie backendu, a nie awarię transportu:

- katalog pól zawierał wyłącznie `m`, z `source_step=0`;
- `H_demag` i `H_eff` nie były zmaterializowane, więc ich metadata i wektory
  prawidłowo kończyły się 404 jako zasoby nieobecne w pamięci;
- scalars, energies i metrics raportowały krok 123 przy czasie fizycznym 0;
- solver status raportował `step_index=0`, a heartbeat nie odnotował żadnego
  callbacku solvera po kroku początkowym;
- stage był oznaczony jako `completed` mimo `converged=false`, po czym
  uruchamiano etap zapisu stanu.

To oznaczało, że interfejs odczytywał kilka niespójnych snapshotów: wizualnie
stabilny wektor i skalar nie były dowodem, że backend opublikował końcowy stan
relaksacji ani pola pochodne.

## Zakres techniczny

- React/TypeScript w `apps/control-room`.
- Resource-first API v2 przez `ControlRoomApi` i zasoby runtime.
- Katalog pól jako kanoniczne źródło dostępnych quantity.
- Zachowanie semantyki FEM i istniejących planów testowych, gdy katalog
  potwierdza dostępność pola.

## Plan wykonania

1. Dodać test modelu inspektora, który dla katalogu zawierającego wyłącznie
   `m` zwraca wyłącznie `m`, a aktywną niedostępną ilość zachowuje tylko jako
   oznaczoną opcję stanu, bez dopuszczania innych niedostępnych wartości.
2. Dodać test sekcji quantity, że FDM ładuje katalog przed umożliwieniem
   zmiany i przekazuje katalog do filtrowania opcji.
3. Dodać test colorbara, że FDM target view używa `fdm-domain`/scope `full`,
   a nie `object`/`film`.
4. Dodać test planera airbox/FDM, że niedostępna quantity nie tworzy żądania;
   dostępna quantity nadal tworzy dotychczasowy request.
5. Zaimplementować filtrowanie listy inspektora po `FieldCatalogResource`,
   ładowanie katalogu dla aktywnego targetu FDM i blokadę selecta do czasu
   poznania katalogu.
6. Zaimplementować mapowanie FDM target views na pełnopole w colorbarze oraz
   availability-gating dla airboxu i dodatkowych FDM field demands. Metadata
   pola nie może być pobierane dla niedostępnej quantity.
7. Opublikować końcowy stan FDM przez wspólny terminalny callback: końcowe `m`,
   aktywne pola pochodne i cache preview muszą trafić do `latest_fields` z tym
   samym `source_step`; terminalny update CLI musi przejść przez tę samą ścieżkę
   co zwykły live update.
8. Przenieść wynik zakończenia etapu do statusu stage/session i nie uruchamiać
   etapu zapisu po nieudanej lub niezweryfikowanej relaksacji.
9. Uruchomić testy jednostkowe i kontraktowe, typecheck/lint oraz browser
   smoke. W smoke sprawdzić brak 404 dla `m/meta` object i `H_demag` airbox,
   brak błędów konsoli oraz `gl.isContextLost() === false` i niezerowy
   drawing buffer po zmianie quantity.

## Kryteria akceptacji

- Dla reprodukcji FDM z katalogiem `{ m }` selector nie pozwala ustawić
  `H_demag`, `H_eff` ani innych nieobecnych pól.
- Nie występują żądania `data/fields/m/meta` z `scope_kind=object` dla FDM.
- Nie występuje żądanie `data/fields/H_demag/samples/vector` dla airboxu,
  jeżeli katalog sesji nie zawiera dostępnego `H_demag`.
- Zmiana na dostępne pole nadal aktualizuje stan i renderuje dane.
- Po zakończeniu relaksacji `m`, `H_demag` i `H_eff` mają wspólny, końcowy
  `source_step`; status solvera i scalars wskazują ten sam krok.
- Etap zapisu nie jest uruchamiany, gdy relaksacja zakończyła się bez
  zbieżności albo błędem numerycznym.
- Nie ma regresji dla FEM, airboxa z dostępnym pełnodomenowym polem ani
  istniejących testów lifecycle WebGL.

## Weryfikacja

- focused Vitest dla modelu inspektora, planera pola i colorbara;
- `pnpm --dir apps/control-room test` oraz `pnpm --dir apps/control-room exec tsc --noEmit`;
- istniejący screenshot/smoke viewportu 3D i własny check WebGL po interakcji;
- ponowna kontrola live API dla reprodukcji FDM.

## Wynik wykonania

- `pnpm --dir apps/control-room test`: 495 plików, 4796 testów — OK;
- focused Vitest panelu, planera i viewportu: 324 testy — OK;
- `pnpm --dir apps/control-room typecheck` oraz ESLint zmienionych plików — OK;
- testy handlera pól API: 22 testy oraz regresja object-scope FDM — OK;
- końcowe callbacki FDM: 2 testy terminalnego stanu (`direct minimizer`, LLG)
  — OK; 5 testów live callbacków — OK;
- testy propagacji terminalnego `m` w CLI oraz zgodności `source_step` preview
  — OK;
- pełny `fullmag-runner`: 754/755 testów — OK; jedyny istniejący wyjątek to
  `active_mask_keeps_inactive_cells_zero_and_excludes_them_from_fields`, który
  koliduje z osobnym kontraktem zachowania stray `H_demag` w nieaktywnym
  airboxie; nie jest związany z publikacją terminalnego snapshotu;
- `FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 make install-cli` — OK; zainstalowano
  zaktualizowane binaria `.fullmag/local/bin/fullmag` i `fullmag-api` w trybie
  `cuda`;
- izolowany `smoke:viewport-3d` z brakującą sesją — OK; końcowy WebGL
  `contextLost=false`, drawing buffer `617x478`, `totalForcedStyleAndLayoutMs=0`;
- live runtime na `172.17.101.240:3100` odpowiadał HTTP 200, ale przed
  restartem wystawiał niespójny, częściowy snapshot opisany powyżej; ten
  proces nie został zdalnie przeładowany w tej sesji, więc jego stare dane nie
  są dowodem działania nowego binarium.

## Deferred work

Jeżeli po przeładowaniu usługi nadal wystąpi niezależny `Forced reflow` lub
`Context Lost`, zostanie to zbadane osobnym profilem Performance/Chrome i
osobną regresją lifecycle. Nie maskujemy tych sygnałów przez zmianę polityki
konsoli.
