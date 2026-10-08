# CPW — produkcyjny kreator i szczegóły przewodnika

## Zakres przyrostu T04/T15

Praca w `D:/git/fullmag/worktrees/microwave-antenna-latest-20260909`, branch
`codex/microwave-antenna-latest-20260909`, baza
`28c9cea2eccf675df0e297118d6deec6bfbd5c12`. To przyrost authoringu,
nie kwalifikacja obliczeń pola ani ukończenie T00–T18.
Implementację i regresje zapisano w commicie
`3bd70357362e09de45f9d7b98f40bb3cb3ad9d94`.
Bramka changed scientific docs od wskazanej bazy do commita: exit 0;
checkpoint jest wewnętrznym raportem wdrożenia, nie nową notą fizyczną.

`apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts::GEOMETRY_LIFECYCLE_COMMANDS`
rejestruje `geometry.add-cpw-antenna` obok microstrip. Obie komendy zachowują
istniejący atomowy merge-patch, revision precondition, session guards,
historię, selekcję po ACK i invalidation zasobów. Nie dodano osobnego API
ani drugiego systemu komend.

`defaultCpwAntennaObject` tworzy `CPWAntennaLayout` z trzema identyfikatorami
`signal`, `ground_left`, `ground_right`, dwiema stacjami 0/1 oraz kompletem
terminal_faces. Długość wynosi 1 µm, grubość 10 nm, szerokość sygnału 50 nm,
szczeliny po 50 nm, szerokości groundów po 200 nm, przewodność 5,8×10⁷ S/m.
Wspólny obrót Rz(+90°) i przesunięcie centrują długość wzdłuż world Y.
Obwiednia wynosi ±275 nm w X, ±500 nm w Y i ±5 nm w Z.
To domyślny kształt autorski, nie rozwiązanie prądowe ani wybór falowodu.

`defaultMicrostripCurrentTransport` i `defaultMicrostripPortMode` przyjmują
jawny zestaw przewodników. Dla CPW powstają sześć granic
`equipotential_current_terminal`, jedna granica `insulating`, jawny moduł
`current_transport/ohmic_poisson` oraz port v2 z wagami 1, −0,5, −0,5 i
normalizacją 1 A. Normalne outward grounds mają ten sam kierunek co sygnał;
ujemne wagi nie odwracają orientacji geometrii.

Nowy draft CPW zachowuje istniejący kanoniczny target `global`, zgodny
z `field_sampling_domain` i publicznym Python. Nie wybiera automatycznie
magnetycznego falowodu. Nie tworzono `conservative_current_view`, closure ani
certyfikatu. Referencja `:current:rt0` pozostaje symboliczna; nie jest
dowodem producenta źródła. Nie przypisano magnetyzacji ani fake Ms do miedzi.
Nie jest to domknięcie polityki niekompletnych draftów bez targetu: obecny
publiczny `AntennaFieldSolveStage` nie dopuszcza pustego `target_refs`.
Review wykrył próbę zapisu takiego payloadu CPW; usunięto ją przed commitem.
Nie osłabiano walidacji Python ani nie przedstawiano kontrolowanego ACK
jako dowodu round-trip. Brak mesh-exact prądu nadal uniemożliwia solve.

`apps/control-room/src/modules/ribbon/ribbonContributions.tsx::geometryTab`
i `physicsTab` wskazują tę samą komendę CPW. Nie zmieniono backendu użytkownika:
geometria solverowa CPW nadal wymaga obsługiwanej realizacji FEM.

`apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx::conductorDetails`
pokazuje długość, grubość, przewodność i wszystkie pięć wymiarów każdej
stacji CPW w osobnych wierszach z jednostkami. Nie pokazuje nieistniejących
parametrów return microstrip. `AntennaConductorDetails` jest tym samym
komponentem podsumowania używanym przez produkcyjny panel i fixture.
W CPW korzysta z istniejącego stylu `fm-antenna-inspection` dla zawijania
długich identyfikatorów; nie dodano nowego systemu CSS. Długi zbiorczy tekst
stacji byłby obcinany przez podstawowy `FieldRow`, dlatego nie pozostawiono go
jako docelowej prezentacji pięciu wymiarów.
`AntennaPlacementEditor` opisuje odstęp całego zespołu przewodników.
Nie zmieniono jego mutacji ani wyznaczania położenia.

## Dowody i granice weryfikacji

`apps/control-room/scripts/check-antenna-creator-model.mjs`: sześć interpretowanych
kontroli rzeczywistych fabryk, modelu szczegółów i walidatora stage PASS.
Sprawdzono dodatnie
wymiary, niezależny wzorzec obwiedni, ID, terminale, normalne, wagi i brak
przypisań magnetycznych oraz zachowanie dotychczasowego microstrip.
Bez kompilacji testów jednostkowych i bez solvera.

Kontrole przed dołożeniem komponentu wizualnego przeszły: produkcyjny
source-check `bbeb14a788474905ba2d5aff90d30cb7`, browser 23/23
`46a23f558a7b427b89d530f7984734bb`, pełny lint
`08de4b6edc3042648d478a322c687a81`. Są historyczne dla tego przyrostu;
finalne wyniki po ekstrakcji podsumowania podano poniżej na podstawie
terminalnych receipts, nie samego uruchomienia kontroli.

Finalny production source-check: **passed/0**, receipt
`b899a49d89994bff94ffd0bc7f1bbc82`. Finalny browser: **passed/0, 23/23**,
receipt `e29905b8278148f6b7e87984da1b4c08`, własny serwer zakończony.
Obie kontrole mają identyczny digest przed/po:
`3df6643c786bbf093a16929f84dd0eaa829c5c9c70d80ed0abb81eedfe15f39a`,
`source_changed_during_run=false`. Łączny workflow strony microstrip wykonał
14 żądań, CPW 15; bez błędów strony i konsoli.
Pełny lint tego samego digestu: **passed/0**, receipt
`adaebe0bd6e144e7b0cc03d9d0f31422`.
Później zmieniono wyłącznie `ribbonStructure.test.ts`: usunięto nieaktualne
oczekiwanie „CPW disabled” i dodano asercję obu wejść CPW do jednej komendy.
Testu nie kompilowano ani nie wykonywano. Production source i browser smoke
nie uległy zmianie; dlatego nie powtarzano ich po samej korekcie nieuruchamianej
asercji. Końcowy lint obejmujący również tę korektę: **passed/0**, receipt
`10a86d762c664dce8d7fb4d00fa66788`, digest przed/po
`0f411fb83d9c611e0a732ad2fbe25da5fe228d34e698d1002e13b03315050b1a`,
`source_changed_during_run=false`. Różnica digestu względem powyższych
kontroli produkcyjnych wynika wyłącznie z korekty `ribbonStructure.test.ts`.
Końcowa bramka `scripts/check-architecture-hygiene.mjs` z katalogu
`apps/control-room`: PASS; scoped `git diff --check`: PASS.

Obejrzano `browser/cpw-15-created-cpw-details.png` z finalnego runu.
Pod edytorem stacji widoczne jest podsumowanie nowej anteny CPW: wspólne
parametry, dwie stacje, każda z pięcioma oddzielnymi wymiarami i jednostkami,
brak wierszy return microstrip. W szerokości 320 px wartości nie są obcięte.
Obraz całej fixture, z poszerzonym pionowo kontenerem po zakończeniu testów
scroll/focus, nie jest screenshotem całego produkcyjnego workspace.
Raport i screenshoty przechowuje resolverowy profil
`storage/builds/<worktree-id>/windows-control-room-browser-fixture/antenna-microstrip-stations-browser/e29905b8278148f6b7e87984da1b4c08/browser/`.

Rozszerzona istniejąca fixture station-editor wywołuje rzeczywistą komendę
z produkcyjnego rejestru przez `ControlRoomApi` i kontrolowany transport.
Smoke sprawdza kolejne utworzenie obu typów anten oraz zachowanie już
istniejących objects/transports/ports/stages, komplet merge-patch i starą scenę przed ACK,
jedną transakcję na tworzoną antenę, spójne ID/terminale/wagi i nową rewizję
po ACK. Renderuje podsumowanie prawdziwego komponentu przy szerokości 320 px,
sprawdza etykiety wymiarów i brak poziomego clippingu oraz zapisuje screenshoty.
To nie dowód wykonania backendowego endpointu, kliknięcia pełnej wstążki,
pełnego workflow Inspectora ani eksportu i ponownego importu tej sceny.
Nie kwalifikuje Undo ani stale ACK komendy tworzenia.

Niezależny review potwierdził usunięcie błędu pustego targetu, zachowanie
microstrip i bezstanowy charakter podsumowania. Nie dodano subskrypcji,
kluczy zależnych od rewizji ani mutacji; edytory pozostały w swoich miejscach
drzewa. Brak nowych Required/Blocker w przejrzanym zakresie nie jest
review całego modułu ani zamknięciem bramek integracji.

## Nadal otwarte

- Browser odbiór pełnej wstążki, zintegrowanego Inspectora i eksport/import.
- Rzeczywisty conductor/current bridge i zamknięcie obwodu.
- Mesh-exact źródło, obliczenie i ponowne użycie bazy pola.
- End-to-end LLG/Relax, źródłowe widmo i odpowiedź spinowa FFT.
- Trwały zapis, cztery realizacje wykonania i końcowe bramki T00–T18.

PR #147 pozostaje Draft. Nie restartowano aktywnego workspace na 3197.
