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

Wykonanie browser CI pozostaje wymagane przed uznaniem odbioru
interakcji za ukończony. Rzeczywisty zapis do runtime 3203 nie był wykonywany.
Bez nowego Solve, native buildu, restartu lub zwalniania rezerwacji.
Pełne E6/E12 i odtworzenie publikacji pozostają otwarte.
