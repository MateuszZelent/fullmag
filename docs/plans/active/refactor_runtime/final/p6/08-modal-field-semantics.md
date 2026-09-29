# P6-B — semantyka pól modalnych K18

Data: 29.09.2026
Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

`DatasetFieldDescriptor` rozróżnia teraz cztery reprezentacje wartości:

- pole fizyczne,
- modalne składowe fizyczne,
- modalne współczynniki przestrzeni funkcyjnej,
- modalne współczynniki lokalnej bazy stycznej.

Każda reprezentacja modalna wymaga `ModalFieldSemantics`. Kontrakt przypina
wynik do dokładnego `AcceptedStateId` stanu równowagi, identyfikatora
linearyzacji i bazy modalnej. Zachowuje również regułę rekonstrukcji, referencję
fazy, normalizację, semantykę amplitudy oraz wersję producenta.

Walidacja odrzuca:

- modalny payload bez danych rekonstrukcji,
- regułę rekonstrukcji niezgodną z deklarowaną reprezentacją,
- niepoprawną tożsamość zaakceptowanego stanu równowagi,
- pustą tożsamość linearyzacji, bazy, fazy lub producenta,
- nieskończoną, niedodatnią albo nieparsowalną skalę normalizacji,
- dane modalne dołączone do zwykłego pola fizycznego.

Porównanie pól obejmuje reprezentację wartości i pełną semantykę modalną.
Jawna projekcja przestrzenna nie może więc ukryć różnicy stanu równowagi,
linearyzacji, bazy, fazy, normalizacji ani znaczenia amplitudy.

Skala animacji nie należy do descriptoru pola. Jest parametrem prezentacji i
nie zamienia względnie znormalizowanego wektora własnego w fizyczną odpowiedź
wymuszoną.

## Dowody

- `rustfmt` dla zmienionych plików: **PASS**.
- `cargo check -p fullmag-quantities --lib`: **PASS**.
- `cargo clippy -p fullmag-quantities --lib -- -D warnings -A
  clippy::manual_is_multiple_of`: **PASS**. Wyjątek dotyczy istniejącego kodu
  `eval.rs`, poza zakresem przyrostu.
- `git diff --check` dla zmienionych plików: **PASS**.
- Dwie regresje walidacji zostały zapisane, ale pozostają **NOT RUN** zgodnie z
  tymczasowym zakazem budowania i uruchamiania testów jednostkowych w
  `AGENTS.md`.

## Otwarte elementy

Przyrost zamyka część kontraktową K18, ale nie FINAL-09. Nadal brakuje
producentów FDM/FEM, materializacji w CAS, publicznego API i generated clienta,
odtworzenia modalnego payloadu przez renderer, roundtripu artefaktu oraz
kwalifikacji CAE-22/23/24 na czterech lane'ach.
