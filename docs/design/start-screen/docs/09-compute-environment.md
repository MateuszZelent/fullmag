# Compute environment — odczyt hosta runtime

Sekcja na ekranie startowym korzysta z istniejących zasobów v2 przez typowany
klient i wspólną warstwę resource hooks. Działa także w przeglądarce, bez
otwierania projektu. Odczyty dotyczą hosta backendu; nie opisują urządzenia,
na którym użytkownik uruchomił przeglądarkę.

## Zakres interfejsu

- Widget na dole nawigacji pokazuje wszystkie zgłoszone GPU, wykorzystaną,
  całkowitą i wolną pamięć VRAM, liczbę logicznych wątków CPU oraz RAM, jeżeli
  backend dostarczył pomiar. Wszystkie przeliczenia pamięci zachowują bajty
  jako jednostkę wewnętrzną.
- „Configure compute” otwiera sekcję Settings z pełnym podglądem hosta:
  modelem CPU, obciążeniem CPU, RAM, urządzeniami GPU, ich obciążeniem,
  temperaturą i czterema realizacjami FDM CPU/GPU oraz FEM CPU/GPU.
- Dostępność realizacji pochodzi z `platform/capabilities`, z publicznych,
  produkcyjnych wpisów w trybie strict. Brak wpisu oznacza „nie zgłoszono”,
  a nie potwierdzoną niedostępność. Sama obecność GPU nie dowodzi gotowości
  solvera ani jego kwalifikacji.
- Wybór backendu, urządzenia i precyzji pozostaje ustawieniem konkretnego
  study. Podgląd hosta nie zmienia requested intent i nie wymusza fallbacku.

## Dane i cykl życia

`StartScreen` jest jednym właścicielem odczytu. Widget, Settings, szablony
i ocena możliwości wznowienia korzystają z tego samego modelu. Zasoby to:

| Zasób | Zastosowanie |
|---|---|
| `diagnostics/cpu` | wątki, model, obciążenie CPU, pamięć systemowa |
| `diagnostics/gpu` | wszystkie urządzenia, pamięć, obciążenie, temperatura |
| `platform/capabilities` | zgłoszone realizacje, precyzje i powody niedostępności |
| `platform/compute/nodes` | trwałe identyfikatory hostów i stan świeżości snapshotu inventory |

Zasoby telemetryczne działają także przy pustym workspace. Inventory jest
odczytywane osobno przez wygenerowany klient v2, fasadę i resource hook; nie
zastępuje telemetrii i nie wyprowadza UUID urządzeń z indeksu lub nazwy.
Settings pokazuje także wersję snapshotu, źródło i czas próbki, topologię CPU
(identyfikatory logiczne, sockety, NUMA i znane rdzenie), dozwolone CPU,
obserwowaną pojemność, limit CPU i pamięć. Dla GPU pokazuje stabilny UUID,
nazwę, PCI ID, VRAM, partycję i NUMA, a także raportowane mechanizmy
egzekwowania ograniczeń. Wartości zachowane jako `last_known` są tak oznaczone;
inventory nie oznacza rezerwacji ani nie wybiera urządzenia dla solvera.
Sampler hosta odczytuje topologię Linux z sysfs i zbiór affinity wątku
wykonującego próbkę przez `sched_getaffinity`; to nie dowodzi affinity workerów.
Na Windows publikuje rdzenie, grupy procesorów i
NUMA, a zbiór dozwolony mierzy dla pojedynczej grupy procesu. Gdy proces należy
do wielu grup Windows, topologia pozostaje widoczna, ale allowed CPU set jest
`unavailable` zamiast niepełnego przydziału. Bieżąca pojemność CPU pozostaje
oddzielna od quota; Linux uwzględnia widoczne limity cgroup v1/v2, a brak
pomiaru quota na innym hoście jest pokazywany jako `unavailable`, nie zero.
Skaner NVIDIA uznaje GPU za pełne urządzenie tylko przy `mig.mode.current=Disabled`.
`Enabled`, `N/A` i odpowiedź starszego `nvidia-smi` zachowują telemetrię, ale
pozostawiają partycję `unknown`; taki wpis nie otwiera pełnego GPU do admission.
Format pola opisuje [NVIDIA MIG User Guide](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/getting-started-with-mig.html).

Potwierdzone odczyty telemetryczne i stan inventory są odświeżane co 5 sekund,
gdy ekran jest widoczny. Ukryte okno nie odpytuje hosta. Timer i nasłuch
widoczności są zwalniane po odmontowaniu ekranu. Ręczne odświeżenie pobiera
również capabilities i inventory oraz pozwala ponowić nieudany odczyt.

Starszy host desktopowy, który nie udostępnia odczytów HTTP, zachowuje obsługę
istniejącego `compute_probe`. Źródło jest oznaczone w modelu. Wersja CUDA
pojawia się wyłącznie, kiedy host rzeczywiście ją zgłosił.

## Stany i ograniczenia

Trwający pierwszy odczyt, brak odpowiedzi, nieudane odświeżenie, brak GPU
i niedostępna telemetria GPU mają odrębne komunikaty. Po błędzie odświeżenia
ostatnie odebrane wartości pozostają widoczne z oznaczeniem ich stanu. Próbka
starsza niż 30 sekund jest oznaczana jako `stale`; przyszły lub niepoprawny
czas próbki nie jest uznawany za bieżący. Inventory publikuje ten sam limit
`stale_after_seconds`; Start i Settings pokazują jego stan oddzielnie od
telemetrii CPU/GPU i dostępności solvera. Gdy odświeżenie API zawiedzie,
zachowana próbka nadal starzeje się lokalnie według tego limitu: dokładnie
30 sekund pozostaje `current`, a później widok pokazuje `stale` bez czekania
na udany następny odczyt.
Odpowiedź `unavailable` nie staje się pomiarem 0% lub 0 GB. Stan węzła
uwzględnia również zgodność `boot_id`: snapshot może mieć próbkę świeżą
wiekowo, ale pozostać `unavailable` po restarcie hosta. Aging próbki nie
zmienia tej niedostępności; Settings pokazuje stan węzła osobno od świeżości
samej próbki.

Przed pierwszym udanym odczytem nagłówek ma stan `Not probed`; w czasie
oczekiwania opisuje trwający odczyt, a brak hosta lub błąd pozostaje odrębnym
stanem. Starszy `compute_probe` jest dostarczany przez host desktopowy.
Start screen pokazuje wykryty sprzęt i zgłoszone lanes, ale nie przypisuje
konkretnego urządzenia do solvera. Device jest rozstrzygany przy starcie runu.

Backend Windows może zgłosić liczbę logicznych CPU przy niedostępnej
telemetrii obciążenia i RAM. Takie pola pozostają jawnie niedostępne.
Nie potwierdza to braku CPU ani braku pamięci. Niedostępna telemetria GPU
nie jest dowodem braku GPU i nie może sama unieważniać urządzenia już
rozwiązanego przez otwartą sesję.

Nie stosujemy stałego mnożnika „CPU jest 40× wolniejsze”. Rzeczywisty czas
zależy od zadania i wybranej realizacji; podgląd nie ma wyników takiego
benchmarku.

## Weryfikacja

Regresję UI pokrywa `apps/control-room/scripts/smoke-start-compute.mjs`:
odczyt z działającego hosta oraz kontrolowane odpowiedzi dla wielu GPU,
CPU bez GPU, niedostępnej telemetrii, błędu odświeżenia i odzyskania danych.
Obejmuje oba motywy, wąski układ, mierniki pamięci i zakończenie odpytywania
po opuszczeniu strony. Raport i zrzuty trafiają do storage projektu.

Są to dowody interfejsu i kontraktu odczytu. Nie stanowią wykonania solvera,
walidacji fizyki, parytetu CPU/GPU ani kwalifikacji wydania. Zakaz
kompilowania testów jednostkowych pozostaje w mocy.

### Wynik na masterze — 2026-10-04

- Przeglądarka: **PASS**, 10 kontroli. Działający pusty workspace zgłosił
  NVIDIA GeForce RTX 4080 SUPER i 48 logicznych wątków CPU. Obciążenie CPU
  i RAM nie były dostępne, a pusty katalog capabilities pozostawił cztery
  realizacje jako „Not reported”.
- Kontrolowane odpowiedzi: wszystkie GPU, prawidłowe mierniki pamięci,
  odświeżenie bez wymiany panelu, błąd z zachowaniem danych, odzyskanie,
  potwierdzony brak GPU i niedostępna telemetria mają poprawne stany.
  Sprawdzono motywy dark/light, szerokości 1440/860/600 px oraz zakończenie
  odpytywania po opuszczeniu strony.
- Lint plików tej zmiany, architecture hygiene i API hygiene: **PASS**.
- Kontrola typów całej aplikacji: **BLOCKED**, sześć błędów poza zakresem
  compute w `ProjectInspector`, `aboutFullmag`, `AboutSection` i fixture
  development-restart-action. Kompilator nie zgłosił błędów w plikach compute.
  Pełny lint aplikacji również pozostaje zablokowany przez zmiany poza tym
  zadaniem.
- React Doctor: wynik globalny nie jest zielony. Zgłoszenia o braku cleanup
  i o resecie flagi poza `finally` w `useComputeProbe` zweryfikowano jako
  fałszywe alarmy: cleanup anuluje oczekujący odczyt i zwalnia timer, a flaga
  jest resetowana w `finally`. Pozostałe ostrzeżenia dotyczą m.in. istniejących
  eksportów, niestandardowych mierników ARIA i kluczy list; zgłoszenie
  hydration w `AboutSection` jest poza zakresem. Nie wyciszono reguł.
- Zachowana ścieżka `compute_probe` jest zgodnością źródłową; nie wykonano
  osobnej kwalifikacji hosta Tauri.

Raport `compute-environment.json` i osiem zrzutów znajdują się w katalogu
`<FULLMAG_PROJECT_STORAGE_ROOT>/runs/fullmag-0950f4dca4ffe38f/start-compute-20261004/browser-03/`.
Raport zawiera pełny commit bazowy i SHA-256 plików frontendu, ponieważ zmiana
pozostaje lokalnie na współdzielonym masterze. Do działającej, zarządzanej
kopii frontendu zsynchronizowano wyłącznie pliki tego zadania z kontrolą
hashy; nie restartowano backendu ani nie przenoszono storage.

### Uzupełnienie — lokalna edycja polityki operatora (2026-10-15)

Settings → Compute → Resources ma teraz edytor polityki lokalnego węzła.
Operator może zmienić dozwolone CPU IDs i GPU UUID, rezerwy CPU/RAM/scratch
i VRAM per urządzenie, limit aktywnych workerów oraz draining. Priorytety
admission i dozwolone wzorce równoległości są zachowywane z bieżącej polityki.
Zapis wpływa na przyszłe przyjęcia; nie zmienia istniejących rezerwacji.

Typed v2 API udostępnia GET/PUT dokument polityki. PUT wymaga ephemeral
capability wydanej przez lokalną aplikację desktopową oraz If-Match z rewizją
polityki; walidacja hosta i zapis CAS w ledgerze rozstrzygają zmianę. Zwykły
browser i tryb aplikacji z zewnętrznym UI pozostają tylko do odczytu.
Wygenerowanie OpenAPI i klienta, statyczna kontrola API oraz diff check
przeszły. Lint nie wystartował z powodu brakującego @eslint/compat, a scoped
React Doctor nie oddał wyniku. Nie uruchamiano testów jednostkowych zgodnie
z AGENTS.md. Browser proof edytora i runtime admission pozostają
**NOT VERIFIED**; wcześniejszy browser proof z 2026-10-04 dotyczy wyłącznie
odczytowego UI.

## Projekt dalszego rozwoju

[Settings i wiele urządzeń](10-compute-settings-and-multi-device.md) opisuje
docelowe powiązanie tych odczytów z profilami wykonania, polityką hosta,
ustawieniami solvera i równoległymi sweeps. Towarzyszą mu
[specyfikacja](../../../specs/compute-resource-execution-v1.md) oraz
[audyt justfile i plan etapów](../../../plans/active/compute-execution-20261004/README.md).
Są to propozycje architektury; nie rozszerzają powyższych dowodów obecnego UI
o runtime scheduling, multiGPU ani kwalifikację fizyki.
