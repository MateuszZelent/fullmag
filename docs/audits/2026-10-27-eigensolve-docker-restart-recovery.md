# Odzyskanie runtime po restarcie Dockera — 27.10.2026

## Przyczyna i naprawa

Stary zapis właściciela pozostawał `ready`, mimo że jego procesy nie istniały po restarcie Dockera. Nowa konfiguracja wymagała autentycznego potwierdzenia drain. Pozostawało wyłącznie API diagnostyczne; nie było workera. Nie zmieniano ręcznie OWNER, lease ani dowodów zwolnienia.

Dodano `stop-restarted-terminal-volume`: przypięcie dokładnej instancji, obrazu, konfiguracji i nieudanego wznowienia; kontrola drzewa procesów oraz błędu inicjalizacji; wymóg terminalnych zadań i zwolnionych rezerwacji z dowodami; ponowna kontrola pod lease operacji. Logi i inspect zakończonego helpera cgroup zachowuje się przed jego usunięciem bez wolumenów. Zatrzymywany jest wyłącznie diagnostyczny backend tej grupy. Następnie istniejący `recreate-volume --fresh-state` archiwizuje poprzedni namespace.

## Dowody runtime

- Kontrola: 3 terminalne runy, 11 zwolnionych rezerwacji.
- Stop: `3b28bc0792a24d519004550ec1c763f4`, succeeded / stopped-confirmed.
- Archiwizacja i recreate: `41945589f89a4c4c9de020e0db257ecf`, succeeded.
- Pierwszy start `bc5d85fa241c4cd39bc86c68094ffd8c` odmówił działania po zmianie stanu kontenera między listowaniem a inspect. Nie uruchomił symulacji. Wyścig inwentaryzacji pozostaje punktem dalszej poprawy.
- Kolejny zarządzany start: `960fd7ff62384547b115a2864b19bc1a`, succeeded. Build aplikacji: 111028 ms; API i runtime gotowe.
- Konfiguracja: `c843adbbbc4f1ad8f3ef0301242f0c0b770aa71a1a78e9ad1068cff95e77e6f5`.
- Aktywacja Gamma: `d4736b4b18274db395001f59d2a9ea7d`, succeeded.
- Run `run-live-bd97005a548d5c04af6632cf8a995b9af55a2adc55df1c301b9b25210acfcfb3`: completed, FEM CPU double, 7134 elementy, pełny demag.
- k=0: **9,299249697 GHz**, residual pełnego deskryptora **2,735576599e-13**, próg 1e-8. Pole modu opublikowane, `assembly_kind=mfem_weak_form_shared_domain`.

To pojedynczy mod wybrany najbliżej 10 GHz, a nie dowód kompletności okna widma. Nie rozwiązuje zarejestrowanego wcześniej SIGSEGV ścieżki frequency-window przy k=0. Pełny nowy sweep i kontrola zbieżności pozostają do wykonania.

## Testy

14 testów Python przeszło: nowe bramki odzyskiwania oraz istniejące testy startup-iteration. Nie kompilowano lokalnie testów Rust/C++/TS. Pierwsza próba przeglądarkowa przekroczyła 60 s podczas pierwszej kompilacji strony; widok zwrócił potem HTTP 200 po 68 s. Odbiór renderowania jest osobną bramką.

## Odbiór UI

Ponowna kontrola po rozgrzaniu frontendu: **passed**, rzeczywista generacja i zasób FMVP przypięte do runu Gamma. Sprawdzono Real, Imag, Abs i Phase oraz 1709 zespolonych próbek. Trzy z czterech porównań animowanych klatek wykazały zmianę w obszarze filmu; dwie klatki po zatrzymaniu identyczne. Widoczne okno Chromium pozostawiono z uruchomioną animacją pod `http://127.0.0.1:3217/session/eigen-mode-ui-de-gamma-selected`. Nie jest to kwalifikacja obliczeń GPU.
