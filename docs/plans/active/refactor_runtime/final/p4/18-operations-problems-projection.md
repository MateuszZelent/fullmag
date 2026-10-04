# P4-C — wspólne Operations i Problems w Control Room

Data: 28.09.2026
Status: zaimplementowany i zweryfikowany przekrój UI; bramka P4 pozostaje otwarta

## Zakres

Dolny panel Control Room ma teraz jawne zakładki `Operations` i `Problems`.
Zastępują one osobną zakładkę `Mesh Jobs`; szczegółowe dane meshu pozostają
częścią Operations. Istniejący zapis UI z `activeBottomPanelTab="mesh"` jest
migrowany do `operations`, więc aktualizacja nie pozostawia niewidocznej
zakładki.

Obie powierzchnie są wyłącznie projekcjami zasobów runtime. Nie dodano nowego
task store ani lokalnego dziennika:

- Operations łączy kolejkę komend, status preparacji i stan buildów meshu;
- Problems łączy diagnostykę geometrii, failure preparacji, błąd kandydata
  meshu z tożsamością last-good oraz nieudane lub odrzucone komendy;
- błąd albo stale źródło jest pokazane jako `Projection incomplete`, a nie jako
  fałszywe zero problemów;
- kolejność problemów jest deterministyczna: error, warning, info;
- UI pokazuje tylko status, opis i rewizję opublikowane przez źródło. Nie
  wylicza procentu z liczby etapów;
- przyjęcie `mesh_build` albo `fdm_grid_refresh` invaliduje zasób kolejki
  komend, dzięki czemu Operations odświeża przyjętą operację również bez
  oczekiwania na realtime;
- akcje meshu i wskaźnik status bar otwierają teraz Operations.

## Dowód przeglądarkowy

Scenariusz `CONTROL_ROOM_INSPECTOR_FDM_BUILD_GRID=1` potwierdził w jednym
zamontowanym workspace:

1. `Build Grid` wysłał `fdm_grid_refresh` z
   `precondition.scene_revision=12`;
2. dolny panel automatycznie przełączył się na Operations;
3. Operations pokazał komendę `fixture-fdm-grid-command` jako `completed`;
4. Problems pokazał źródłowy
   `GRID_EXTENT_REVIEW_REQUIRED` jako error z rewizją 12;
5. nie wystąpiły odpowiedzi 404 ani błędy konsoli;
6. canvas pozostał widoczny, `contextLost=false`, drawing buffer `703×478`.

## Weryfikacja

| Kontrola | Wynik |
|---|---:|
| TypeScript | PASS |
| Scoped ESLint | PASS |
| Składnia skryptów Node | PASS |
| Browser smoke Operations/Problems/Build Grid/WebGL | PASS |
| `git diff --check` | PASS |
| Testy jednostkowe | NOT RUN — aktywny zakaz kompilowania i uruchamiania testów jednostkowych |

Dodane regresje źródłowe modelu obejmują wspólną projekcję operacji, brak
syntetycznego pola procentowego, problemy z czterech rodzin źródeł, zachowaną
tożsamość last-good meshu i oddzielne raportowanie luk projekcji. Pozostają
nieuruchomione do czasu zniesienia zakazu testów jednostkowych.

## Granica etapu

Przekrój realizuje wymagane powierzchnie Operations/Problems bez nowego
frontendowego store’a. Następny przyrost dodał trwały journal komend Live;
pozostałe typowane źródła preparation/mesh i ich wspólna projekcja zdarzeń,
managed process E2E preparacji FEM, native FEM, kwalifikacja naukowa oraz release
pozostają otwarte. Szczegóły:
[`19-live-command-journal.md`](19-live-command-journal.md). Stan pozostaje:
**P4 50%**, cały plan około **49%**.
