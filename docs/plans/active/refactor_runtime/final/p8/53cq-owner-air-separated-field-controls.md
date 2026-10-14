# P8-53CQ — oddzielne kontrole pól owner/air

Data: 14.10.2026. HEAD pomiaru `720fcda2765029911ee66965541666c978272e0f`.
Receipt `1afdf5583b934111baf0f15c1b22daec`, profil resolvera
`windows-exact-layer-mesh-diagnostics`. Wszystkie 10 obserwacji wykonane,
bez skip/error; PID 173872 odczekany, exit 0, bez timeout/terminate/kill.
Fingerprints źródeł przed/po identyczne. To diagnostyka interpretowana,
nie kwalifikacja meshera lub solvera.

Dodane kontrole zachowują authored airbox 50 nm, jego plan poziomów,
owner hmax 20 nm, hint 10 nm, L=3 i XY PBC:

| Kontrola | Zmieniony parametr realizacji | Body XY SHA256 |
|---|---|---|
| `air_field_only_30` | Tylko outer target pola air grading na 30 nm | `0ae106a140d56625f95ac4d164271684cfe44bf1a751db36fe69359f546360f5` |
| `owner_ceiling_only_30` | Tylko owner VOut i global air ceiling na 30 nm | ten sam digest |

Obie mają też ten sam interface facet digest:
`858a1144ada12ceda9d614eb540bb0b86630fa1989fa873d590070909a1aa23a`.
Jest to wynik wcześniejszego `fixed_fields`; różni się od obu oryginalnych
baseline'ów 30/50 nm. Oryginały, niezmienione klony i późniejsze powtórzenia
ponownie dały dokładnie odciski zapisane w 53CN.

Nie można więc uznać jednej z dwóch kontroli za odtworzenie referencji ani
przypisać całego defektu jednej gałęzi pola. Rezultat jest zgodny z zależnością
wspólnej triangulacji od geometrii i aktywnych ograniczeń rozmiaru; nie dowodzi
jeszcze mechanizmu wystarczającego do zaprojektowania bezpiecznej poprawki.
Następny krok powinien obserwować powstanie magnetycznej triangulacji przed
siatkowaniem powietrza i sprawdzić możliwość zachowania jej wraz z PBC,
lokalnymi polami 3D, L+1 planes i zamkniętym wspólnym interfejsem. Każdą zmianę
trasy konstrukcji trzeba najpierw opisać w kanonicznej nocie i zweryfikować
na pełnym publicznym Box oraz owner-fields; nie wystarczy sam ring.

Pozostają: rzeczywisty FAIL owner XY ring i Box **44/45 PASS**, pełny pakiet
native Windows oraz P8 A→B→C. Fixture anteny dostał **3/3 PASS w CI**; kolejną
naprawę typów testu workera zapisano na remote master jako `720fcda27`.
CI `38578366031` tego commita pozostaje aktywne w chwili checkpointu.
Cały plan **IN PROGRESS**, bez awansu procentów.
