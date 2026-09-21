# ADR 0031 — Runner observability and storage UI contract

**Status:** accepted for implementation (polityka i kontrakt API)

**Date:** 2026-09-13

**Decision makers:** Fullmag core

## Kontekst

Runner `Fullmag_build_runner` jest jedynym zaufanym zarządcą kolejki i wykonawcą kompilacji w kontenerze. Dotychczasowa komunikacja odbywała się wyłącznie za pośrednictwem lokalnego API CLI (`scripts/local_runner_cli.py`) przez bearer token. Brakowało wizualnego interfejsu operacyjnego dla operatora, który pozwalałby ocenić:
- stan aktywnego buildu i jego poszczególnych etapów,
- obciążenie zasobów (CPU, RAM kontenera i hosta, I/O),
- zapas wolnego miejsca na dysku oraz rezerwacje na wzrost,
- rejestr i inwentaryzację storage z podziałem na klasy (kapsuły źródeł, kopie robocze wykonania, trwałe targety, współdzielony cache, artefakty i logi),
- powody ochrony zasobów przed usunięciem („dlaczego zostaje”),
- plany retencji w trybie bezpiecznego podglądu (preview).

Plan `docs/superpowers/plans/2026-09-13-runner-observability-storage-ui-plan.md` definiuje architekturę panelu operatorskiego `apps/runner-console` oraz rozszerzenie API koordynatora o wersjonowaną przestrzeń `/api/v1/`.

## Decyzja

### 1. Granica architektoniczna i lokalizacja

- Tworzona jest dedykowana aplikacja operatorska `apps/runner-console`, niezależna od aplikacji naukowej `apps/control-room`.
- UI jest statycznie serwowane bezpośrednio przez koordynatora pod ścieżką `/ui/`.
- UI działa w 100% offline, z tego samego originu co API (`127.0.0.1:48765` lub port z `FULLMAG_RUNNER_PORT`), bez zewnętrznych zależności od sieci Internet ani CDN.
- Statyczne zasoby są kopiowane do obrazu koordynatora (`/opt/runner/scripts/local_runner/ui_dist`), dzięki czemu UI jest dostępne natychmiast po uruchomieniu kontenera.

### 2. Uwierzytelnianie i bezpieczeństwo przeglądarki

- Zaufana granica: API pozostaje powiązane wyłącznie z loopback (`127.0.0.1` / `0.0.0.0:48765` wewnątrz prywatnej sieci kontenera, konfigurowalny przez `FULLMAG_RUNNER_PORT`).
- Istniejące uwierzytelnienie CLI przez nagłówek `Authorization: Bearer <token>` pozostaje nienaruszone.
- Dla przeglądarki wprowadzona zostaje wymiana tokena na krótkotrwałą sesję za pośrednictwem endpointu `POST /api/v1/auth/session`, zabezpieczoną ciasteczkiem `HttpOnly`, `SameSite=Strict`.
- Ochrona przed CSRF: zapytania zawierające nagłówek `Origin` są akceptowane wyłącznie wtedy, gdy zgadzają się z lokalnym hostem serwera (`Host`). Wszystkie obce originy (np. próby ataku z zewnątrz) są natychmiast odrzucane ze statusem `403 origin_not_allowed` bez nagłówków CORS.
- Token ani poświadczenia nie trafiają do URL-i, logów ani pakietu JS.

### 3. Kontrakt wersjonowanego API `/api/v1/`

Wprowadzone zostają wersjonowane endpointy tylko do odczytu oraz bezpieczne mutacje:
- `GET /api/v1/overview` — podsumowanie KPI (aktywny build, kolejka, wolny dysk, RAM workera, ostatni cleanup, incydenty).
- `GET /api/v1/jobs` — stronicowana lista zadań z filtrowaniem i wyszukiwaniem.
- `GET /api/v1/jobs/{id}` — szczegółowy stan zadania, czasy etapów, kod wyjścia, receipt.
- `GET /api/v1/jobs/{id}/events` — strukturalne zdarzenia cyklu życia zadania.
- `GET /api/v1/jobs/{id}/logs` — logi etapów (stdout/stderr) ze stronicowaniem i filtrowaniem.
- `GET /api/v1/jobs/{id}/metrics` — szeregi czasowe zasobów (CPU, RAM, I/O).
- `GET /api/v1/jobs/{id}/resources` — inwentaryzacja plików i katalogów przypisanych do zadania.
- `GET /api/v1/storage/volumes` — pojemność, wolne miejsce, rezerwacje i progi dyskowe.
- `GET /api/v1/storage/resources` — podział zasobów na kategorie wraz ze wskaźnikami ochrony („dlaczego zostaje”).
- `GET /api/v1/processes` — procesy koordynatora i workera ze zredagowanymi parametrami.
- `GET /api/v1/alerts` — alerty i incydenty operacyjne.
- `GET /api/v1/events` — strumień/historia zdarzeń koordynatora.
- `GET /api/v1/retention/plans` oraz `POST /api/v1/retention/plans` — asynchroniczny podgląd planu retencji.
- `GET /api/v1/retention/policy` oraz `PUT /api/v1/retention/policy` — odczyt i aktualizacja progów i TTL.
- `POST /api/v1/resources/{id}/pin` — ochrona konkretnego zasobu przed retencją.

### 4. Wymagania wizualne i dostępność

- Stała lewa nawigacja z 8 widokami: Przegląd, Kolejka, Historia, Storage, Procesy i zasoby, Logi, Polityki, Diagnostyka.
- Górny pasek z informacją o hoście, zdrowiu API i workera, trybie kolejki, czasie aktualizacji i banerem blokad.
- Spokojny motyw jasny i ciemny z zachowaniem wysokiego kontrastu, czcionkami o stałej szerokości dla identyfikatorów i liczb (`tabular-nums`), monospace dla ścieżek.
- Brak danych pokazywany jawnie jako „niedostępne” (`n/a`), nigdy jako fałszywe zero.

## Konsekwencje i testy

- Istniejące testy kontraktowe (`test_container_api.py`, `test_container_main.py`, `test_service.py`) przechodzą bez zmian.
- Dodane zostają testy sprawdzające serwowanie UI pod `/ui/`, uwierzytelnianie sesyjne, zabezpieczenie przed obcym Origin oraz nowe endpointy `/api/v1/`.
