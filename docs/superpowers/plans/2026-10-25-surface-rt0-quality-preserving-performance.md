# Wydajność surface RT0 bez zmiany jakości — 25.10.2026

## Cel i stan początkowy

Poprzedni celowy turn przyniósł postęp: commit aplikacji 498a36ae, udany managed
build 3abcda48 oraz rzeczywiste regresje projektu i odczytu V/J/H. Pełna próba
Universe pozostaje Failed po natywnym limicie czasu, nie jest aktywnym oczekiwaniem.
Skonfigurowano 1800 s łącznie i 90 s na target; dawny tekst błędu nie
rozróżnia obu przyczyn, więc sam komunikat nie dowodzi wyczerpania 1800 s.

Następny etap ma doprowadzić do pełnej mapy, bez zmniejszania liczby 1154
targetów, dokładności, budżetów ani kontroli whole-face/fan i 80/120.
Najpierw osobny mały benchmark istniejącej metody. Nie kwalifikuje on bazy
ani pełnego Universe.

## Prerejestracja porównania

Scenariusz: `examples/antenna_universe/fem_antenna_closed_loop_surface_benchmark.py`.
Geometria przewodnika, sigma, źródło i siatka przewodnika odpowiadają pełnemu
przykładowi; osobny niemagnetyczny sampling ma rozmiar 0.08 mikrometra i środek
(1, 0, 0.3) mikrometra. Publiczna metoda analytic_rt0_surface i wszystkie pola
polityki pozostają identyczne z przykładem Universe. To diagnostyka, nie
redukcja docelowego zadania. Nie ma Relax, Run, LLG ani FFT.

1. Przed edycją kernela wykonać mały przypadek w obecnej grupie managed.
   Zachować pełne V/J/H, wszystkie precision records, work report, package
   provenance, uporządkowane punkty i źródło.
2. Dla pierwszej poprawki przenieść wyłącznie powtarzane wyznaczanie czterech pi
   z każdej ściany do zakresu targetu/precyzji; ta sama formuła i typ.
   Nie zmieniać kolejności sumowania, predykatów, tolerancji i publicznego ABI.
3. Porównać ten sam nośnik i zaakceptowane źródło. Jeżeli generowanie siatki
   zmieni wejścia, porównanie nie jest zaliczone i wymaga przypięcia wejść.
   Wymagać identycznego H binary64 i wszystkich zapisanych wartości precyzji
   oraz niezmienionych refusal/qualification. Raportować rzeczywisty czas
   i peak RSS; liczniki atan2 mają uczciwie maleć. Bez pomiaru nie deklarować
   przyspieszenia.
4. Po potwierdzeniu efektu kontynuować kolejne ograniczone optymalizacje
   lub pełną próbę z niezmienionymi targetami i polityką, zależnie od pomiaru.

Wariant współdzielenia ścian odłożono: wymaga oddzielnego dowodu mapowania
winding i ownerów. Równoleglenie zmieniałoby kontrolę pracy i porządek sum,
więc nie jest pierwszą poprawką. Podniesienie limitu czasu albo obniżenie
jakości nie stanowi rozwiązania.

## Granice weryfikacji

Build tylko w tej samej grupie przez just Docker DEV. Zakaz kompilowania
natywnych testów jednostkowych pozostaje. UI/WebGL nadal NOT VERIFIED.
Canonical physics owner: docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md, rozdział surface RT0.
Mapa implementacji: surface_rt0.cpp + face_pass, Arithmetic::angle i
evaluate_surface_rt0; accepted_surface_rt0.cpp + evaluate_accepted_surface_rt0.
Nie zmieniamy równań ani statusu inspection_only.


## Rzeczywiste przygotowanie i pomiar początkowy

Dwie aktywacje zostały odrzucone przed zmianą solvera: pełny własny authoring
nie jest idle scratch (`live_retirement_busy`), a pusta sesja bez prawdziwego
runu nie pasuje do terminalnego retirement (`live_retirement_current_mismatch`).
To nadal luka produktu; nie zmieniono tej bramki. Zapisano własną scenę
w archiwum, wykonano standardowe przejście do scratch i dopiero istniejący
managed restart z checkpointem. Dane i 13 historii zachowano.

Stop `5b751743267d4c0f84c328c5c305271c` i resume/build
`1ab5205c9e59421e87f4b30ff47d199d` zakończyły się sukcesem. Aktywacja
`578a868f803744f2936f4eadef5acc12` przeszła, a Prepare ma status ready.
Pojedyncze Solve zostało przyjęte HTTP 200, command
`fm-916f837c-af6a-4193-91da-0127c7c7e227`.

Run `run-live-255fa587f4084d187d7e690f4d75076a4889fcf685a044ee02e4e8486a06b2da`,
attempt `attempt-35f480a608e6427ebebf02d127657ab8`, epoch 1.
Ostatnia obserwacja 1792926369512 ms: Running i rzeczywiście żywy PID 3830
z tokenem startu 13297839. Nie ma jeszcze terminalnego wyniku ani pomiaru
kernela; nie deklarujemy przyspieszenia. Kod solvera pozostaje niezmieniony.

Katalog CAS `5402dbf7ec87f2fee4f110f1da67fe4eaab45ce6102ea76e3097fb4806dd72f9`
został sprawdzony SHA256. Źródło ma 678 węzłów i 1865 Tet4; sampling
14 węzłów i 24 Tet4. Zatem pełny benchmark ma 26110 par źródło–target.
Przy odtwarzaniu trzeba użyć tych dokładnych nośników: nowy meshing nie daje
automatycznie tej samej siatki. Raport wejść: `before-frozen-inputs-v3.json`;
dwie wcześniejsze wersje miały błędny odczyt liczby komórek CSR i nie są
dowodem tej liczby. V3 sprawdza types/offsets/connectivity/global_ordinals
oraz zgodność z natywnym receiptem Prepare. Skróty siatek zachowano.
Wszystkie powyższe receipty pomiaru: wolumen kontrolny grupy,
`verification/surface-rt0-performance-20261025/`.

Strukturalny baseline noty 0950 przeszedł istniejący validator (exit 0),
bez zmiany noty lub kernela. Nie kompilowano natywnych testów jednostkowych.


## Wynik terminalny — pierwszeństwo przed wcześniejszym Running

Próba zakończyła się **Failed** 25.10.2026 o 11:06:49 UTC. PID 3830 już
nie istnieje. Worker zakończył się kodem 1, timed_out=false i
stop_requested=false. Nie powstał przyjęty wynik ani benchmark wydajności.
Nie wykonywano ponowienia. Powód: `closed-loop field v2: certificate canonical
flux differs from local J`. Zdarzenie końcowe ma sequence 171, ścieżkę
`coordinator_journal/event/705a9b28213a4548847c301dd159a41e.json`.
Nie ma opublikowanych artifact_ids.

Przegląd kodu potwierdził dwie różne kontrole zgodności tych reprezentacji:
`closed_loop_identity_v2.rs + verify_owned_geometry` uwzględnia skalę składników
iloczynu J przez normalną, natomiast `closed_loop_balance_v2.rs +
verify_balance_certificate` porównuje wynik względem samych prawie znoszących
się strumieni. Natywny `AffineRt0Element::face_moment` liczy dokładnie
z signed RT0 coefficients, a `retained_current_at` eksportuje zaokrąglone
binary64 ślady. Sam ten przegląd nie ustala jeszcze wartości błędu konkretnej
ściany. Następna praca: niezależny reproducer i właściwe powiązanie
kanonicznych momentów RT0 ze śladami J; bez podnoszenia bramek fizycznych
i bez pomijania kontroli źródła. Hoist pi pozostaje niewykonany.

Osobny proces preparation wcześniej zakończył się błędem:
`preparation scheduler: reconcile task cancellations: compute-node snapshot
content-addressed payload is missing or invalid: No such file or directory`.
OWNER wskazuje preparation=exited_failure, state=unknown. Backend pozostawił
API w trybie diagnostycznym; compute/queue zwraca 503 runtime_unavailable.
Nie wolno opisywać tego jako pustej kolejki lub dowodu zwolnienia rezerwacji.
Nie wykonywano restartu ani ręcznego recovery po tym zdarzeniu.

Dokładny checkpoint: `before-terminal-failure.json` w katalogu dowodów tego
etapu. Zachowuje zdarzenie końcowe, receipt wyjścia, log preparation i
rzeczywiste odpowiedzi API. Potwierdzenie zwolnienia rezerwacji pozostaje
NOT VERIFIED. API diagnostyczne działa, ale nowe operacje są zablokowane.
