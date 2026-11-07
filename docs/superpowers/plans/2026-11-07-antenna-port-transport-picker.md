# E6 — wybór istniejącego transportu w edytorze portu

## Problem i kryterium odbioru

AntennaPortEditor wymagał ręcznego wpisania technicznego ID transportu.
Kreator portu miał już listę istniejących zasobów. Edytor powinien korzystać
z tego samego inwentarza, zachować utracone ID jako niedostępne i nigdy
sam wybierać następcy ani zmieniać referencji terminali.

## Zmiana i właściciele

- apps/control-room/src/modules/inspector/panels/antenna/AntennaPortEditor.tsx::AntennaPortEditor
  używa istniejącego FormField type=select.
- AntennaPortComposerModel.ts::antennaPortCreationTransports pozostaje właścicielem
  filtrowania jednoznacznych, statycznych one-way Ohmic transportów obejmujących źródło.
  To lista możliwych zasobów, nie gwarancja poprawności całego portu.
- AntennaPortEditorModel.ts::buildAntennaPortTransaction i
  shared/domain/physics/antennaPortValidation.ts::antennaPortValidationMessages
  nadal sprawdzają cały wybrany port, terminale, transport i normalizację.
- Zapis pozostaje w api.model.commitTransaction, z historią, rewizją,
  sprawdzeniem ACK oraz invalidacją. Nie dodano endpointu, pola modelu ani stanu.
- Schema, normalizacja, wagi, terminale i fizyka nie zmieniają się po samym
  wybraniu transportu; zapis wymaga jawnego Apply i poprawnej walidacji.

Wyłączona opcja unavailable pokazuje historyczne ID, gdy transport zniknął,
jest niejednoznaczny lub nie mieści się w istniejącym profilu. Brak jest
jawnym błędem referencji, bez automatycznego przełączenia.

## Weryfikacja

Trzy testy renderowania produkcyjnego panelu odtwarzają brak selecta (RED),
następnie przechodzą (GREEN): lista poprawnych zasobów i wyłączenie
niezgodnych/obcych/powtórzonych, zachowanie utraconego ID i istniejący v3
zamkniętego źródła. To testy widoku, nie backendu.

Razem z 21 istniejącymi testami transakcji: 24 PASS.
Focused ESLint, TypeScript i architecture hygiene: PASS w istniejącym
frontendzie Docker grupy zadania. Dowody:
verification/antenna-port-transport-picker-20261107/ w jego prywatnym wolumenie.

Istniejący browser fixture antenna-port-editor rozszerzono o select oraz
nowszy wybór transportu wykonany podczas pending. Pełny smoke sprawdza
także brak automatycznego zapisu, niezmienione terminale, dokładny merge patch,
historię, session ABA, konflikty oraz błędne ACK. Selekcję inputa do pomiaru
fokusu oparto na etykiecie, ponieważ usunięcie tekstowego pola zmienia indeksy.

Niezależny przegląd nie wykrył wymaganej poprawki produkcyjnego pickera.
Wskazał dwa błędy dotychczasowego, teraz włączanego smoke v3: brak czterech
material_parts oraz zmianę branch ID zamiast edytowalnej wagi obserwacji.
Fixture uzupełniono i gest zmieniono na skończoną wagę; walidator pozostaje
bez zmian. Ponowny lint fixture/drivera PASS.

[CI 42384877648](https://github.com/MateuszZelent/fullmag/actions/runs/42384877648),
HEAD 59693f99d88f5fc3a0c6066b7ee1424bafa51bc9:
job inspector-actions-browser-smoke (128440048614) SUCCESS.
Pełny raport edytora: state=passed, 29/29 kontroli PASS, 18 zapisanych
przepływów, pageErrors=[], consoleErrors=[], error=null. Receipt:
exit_code=0, source_changed_during_run=false. Obejrzano screenshot
transport-picker.png z faktycznym selectem i niezmienionymi terminalami.
Kontrole obejmują też wcześniejsze Object/Airbox i saved-section.

Potwierdzono nowszy wybór transportu podczas opóźnionego ACK: pierwsze żądanie
wiąże alternative, nowszy draft wybiera transport i zachowuje ten wybór po
odpowiedzi. Kolejne jawne Apply używa już nowej rewizji i nowego wyboru.
Pomiary root/focus/scroll/disabled/opacity pozostały stabilne, animacje opacity=0.

Artefakt GitHub 13578139827: ZIP 1697249 B, 41 wpisów, SHA256
e117dd03036090bbb8e085b1990e443a76dcc55d2c6b112f349cfc94ea86beaa.
Log joba: 56778 B, SHA256
d1087b1cbbbb70bdaeb0a0082ac72272d860ed16af62550b52913daafaf99e9e.
Oba zachowano w prywatnym wolumenie frontendu jako
ci-42384877648-inspector.zip i ci-128440048614.log.

Odczyt rzeczywistej sesji 3203 w osobnej tymczasowej karcie:
Objects → GSG antenna → Antenna → Port 1 pokazuje Current transport jako
select z wybranym gsg_charge dla portu gsg_port i źródła antenna.
Otwarcie listy i Escape nie zmieniły wyboru; footer pozostał No unapplied changes.
Nie użyto Apply, nie zmieniono sceny. Karta kontrolna została zamknięta,
a dotychczasowa karta zapisanego H275 zachowana. Screenshoty CUA obejrzano
w rozmowie; nie zapisano oddzielnych lokalnych PNG.
To potwierdza rzeczywisty odczyt formularza, nie zapis do backendu.

Końcowy odczyt Actions potwierdził completed/success całego workflow
42384877648 (updated_at=2026-11-07T15:17:27Z), w tym
control-room-contracts i ogólny browser-fixture-smoke. Dowód jest przypięty
do testowanego HEAD; późniejsza aktualizacja raportów nie zmienia kodu.
Rzeczywisty zapis do runtime 3203 nie był wykonywany.
Bez nowego Solve, native buildu, restartu lub zwalniania rezerwacji.
Pełne E6/E12 i odtworzenie publikacji pozostają otwarte.
