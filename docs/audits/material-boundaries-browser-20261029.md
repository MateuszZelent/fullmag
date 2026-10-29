# Browserowa regresja granic materiałowych

**Wynik focused mode: PASS, wyłącznie na fixture. Pełny `smoke-inspector.mjs`: NOT VERIFIED.** Ten dowód nie potwierdza zachowania live API, poprawności naukowej, GPU ani produkcji.

## Zakres i źródła

- Worktree: `/home/kkingstoun/.codex/worktrees/material-boundaries-p1-20261029/fullmag`
- Branch / HEAD: `codex/material-boundaries-p1-20261029` / `6400acd42f4210a527a2fef2fc04a134261d6ac5`
- Harness `apps/control-room/scripts/smoke-inspector.mjs`, SHA-256: `5fd47276b526c013939d19d76c69b333e8e880dc4af7e4785186a4a583795e02`
- Panel `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.tsx`, SHA-256 na worktree i w aktywnym frontend shadow: `5be12f334560f55b33f32e565c19250a5f840876074f8c139d2bb244012e79b0`.
- Frontend: `http://127.0.0.1:3356/workspace`, usługa `fullmag-worktree-fullmag-033f6660666cdc47-frontend-1`. Przed uruchomieniem porównano SHA pliku panelu w worktree, `/opt/fullmag/source` i `/state/development/workspace`; były zgodne.
- Przeglądarka: obraz `mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`.

Tryb `CONTROL_ROOM_INSPECTOR_MATERIAL_AUDIT=1` działa jako osobny, opt-in scenariusz. Używa przechwytywanego API fixture, czeka na status FEM, wykonuje istniejącą kwalifikację Object/Airbox na świeżej topologii, a następnie test regionu. Liczby PATCH dla Object i Airbox są mierzone w oddzielnych przedziałach z barierą 500 ms ciszy żądań przed i po pętli każdego targetu. Zmiana nazwy regionu podnosi rewizję fixture, dlatego nie wykonuje się kwalifikacji wizualizacji po tym PATCH-u. Domyślny pełny smoke zachowuje dotychczasowy przepływ i asercje.

## Wynik przeglądarki

Focused run zakończył się kodem 0 i wypisał `material_boundaries_inspector_browser_proof.v1`.

- Region `material-audit-core`: opóźniony PATCH nazwy i ACK zachowały Aex=0 `J/m` i alpha=0 (kanoniczna pusta jednostka), priorytety 1/2 oraz konflikt `error`. UI nadal pokazywał oba zera. `Ms · linear` i `ku1 · radial` zachowały dokładne dane payloadu po PATCH-u i były widoczne jako profile tylko do odczytu: zero pól wejściowych oraz po jednym `Remove Override` na profil. Dwa edytowalne skalary również miały po jednym `Remove Override`; łącznie były cztery przyciski.
- Podczas pending i po ACK sprawdzono tożsamość root/owner, fokus `Region name`, scroll z tolerancją 1 px, opacity i brak animacji opacity. Kontrolka `Frame` pozostała włączona w czasie zapisu. Wykonano jeden region PATCH, jeden sync i 8 żądań w zakresie testu regionu.
- Istniejący kwalifikator wykonał 4 interakcje UI Object i 16 Airbox. Domknięte przedziały wykazały PATCH: Object 4, Airbox 8, łącznie 12; wartości są niezerowe i nie przekraczają liczby interakcji. Licznik całego focused zakresu również wykazał 12 PATCH-ów wizualizacji. Asercje root/focus/scroll/opacity, kontrolki niezwiązanej, pending i ACK przeszły.
- Request budget: brak naruszeń. Nieznane GET-y: 0; nieznane mutacje: 0; żądania preview: 0. Nieoczekiwane 404 i błędy przeglądarki: 0. Odnotowano jeden oczekiwany 409 w scenariuszu jednokrotnego odrzucenia PATCH-u.

Fixture odpowiada jawnie na odczyty `region-diagnostics` oraz listy i pojedynczego `mesh-region-membership`, wymagane przez UI. Odpowiedzi oznaczają wyłącznie syntetyczny stan testowy. Nie są realizacją ani pomiarem przynależności siatki w backendzie.

## Pełny smoke i granice dowodu

Wcześniejsza próba pełnego smoke z fixture materiałowym zatrzymała się na modalnym scenariuszu eigenmode z komunikatem UI `Resource load failed`. Nie wykonano porównania kontrolnego na niezmienionym baseline, więc nie ma podstaw, by uznać ten błąd za niezależny od fixture albo regresji. Pełny smoke pozostaje **NOT VERIFIED**. Focused mode celowo kończy się przed tym scenariuszem i nie kwalifikuje pozostałych ścieżek.

Playwright korzystał z fixture i tymczasowego kontenera z `--rm`. JSON proof i screenshot zapisano w `/tmp` kontenera `tmpfs`; kontener usunięto po runie, więc artefakty binarne nie są trwałe. Powyższe dane są zapisanym podsumowaniem JSON wypisanego na stdout.

## Weryfikacja

Focused browser run:

```sh
docker compose -p fullmag-inspector-material-qa-20261029 \
  -f /tmp/fullmag-inspector-material-qa-20261029.yaml \
  run --rm --no-deps browser-qa
```

Harness sprawdzenia źródłowe:

```sh
node --check apps/control-room/scripts/smoke-inspector.mjs
git diff --check -- apps/control-room/scripts/smoke-inspector.mjs
```

Po browser PASS uruchomiono tylko lint zmienionego harnessu w aktywnym frontendzie; zakończył się kodem 0:

```sh
docker exec fullmag-worktree-fullmag-033f6660666cdc47-frontend-1 \
  sh -lc 'cd /state/development/workspace/apps/control-room && pnpm exec eslint scripts/smoke-inspector.mjs'
```

Tymczasowy browser container został usunięty przez `--rm`. Nie uruchamiano pełnego smoke ponownie.
