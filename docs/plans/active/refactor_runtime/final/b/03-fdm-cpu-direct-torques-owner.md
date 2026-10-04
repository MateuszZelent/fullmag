# B-03 — właściciel momentów bezpośrednich FDM CPU

Data: 03.10.2026. Baza: `0a07b11ce67b14cb0a6bbaa9801531dbba0de451`.
Zakres B-CORE/B-FDM: ekstrakcja istniejącej realizacji `CpuReference`.

`fields/direct_torques.rs` skupia sześć helperów i czternaście metod:
dispatcher AoS/SoA; realizacje Zhang–Li, Slonczewski i SOT; warianty
allocating oraz add-into. `fields.rs` zachowuje orkiestrację RHS.
Reeksporty `slonczewski_torque_from_config` i
`prescribed_sot_torque_from_config` zachowują dotychczasową ścieżkę
wywołania przez `fem.rs`. Nie zmienia się publiczny dispatch ani runtime.

Wszystkie ciała, komentarze dokumentacyjne i atrybuty przeniesionych funkcji
są identyczne z bazą po normalizacji końców linii. Jedyny wyjątek sygnatury:
`slonczewski_prefactor` ma `pub(super)` zamiast prywatności lokalnej modułu,
aby istniejące testy rodzica mogły użyć go przez import `#[cfg(test)]`.
Pozostałe prywatne helpery i metody pozostają prywatne.

## Dowody i otwarte bramki

| Kontrola | Wynik |
|---|---|
| Porównanie dwudziestu ciał i deklaracji z HEAD | PASS; tylko jawny wyjątek widoczności prefactora. |
| Pozostały rodzic | PASS: tylko wiring, usunięcie przeniesionych definicji i odstępy; obcy import reflow zachowany poza stagingiem. |
| Rustfmt nowego modułu i layout contract | PASS, exit 0. |
| Niezależny review źródeł | PASS po uzupełnieniu importów `add` i `scale`; brak pozostałych P0/P1. |
| Source layout contract | Dodano ownership, brak duplikatów i granicę adaptera FEM; NOT COMPILED / NOT RUN. |
| Produkcyjny build | Build 218 QUEUED, przypięty do B-03; brak terminalnego wyniku. Build 217 obejmuje wcześniejszy commit P8-39. |
| Runtime i parity | NOT VERIFIED; nie awansowano kwalifikacji FDM/FEM ani procentów planu. |

SHA-256 `direct_torques.rs`:
`7fcbce6e373f9a814847f6045568aeefe03b07d382392a424414741c040c1499`.

## Kontrola adapterów

Bezpośredni odczyt przypiętego commita i aktualnego modułu oraz osobny
audyt potwierdzają jednakową kolejność `alpha, gyromagnetic_ratio, Ms`
w wywołaniach helpera Slonczewskiego przez allocating, add-into AoS/SoA
i FEM reference. Podejrzenie zamiany argumentów nie zostało potwierdzone.
Istniejące testy niezależnego oracle i lokalnego materiału pozostają
w rodzicu bez zmian; ich obecność nie zastępuje wykonania testów.

## Przypięty build produkcyjny

Build 218: `5a2659ca616448fdacd75e16f004e2af`, profil `fdm-cpu-release`,
operacja `build`. Źródło commit:
`9f7eadb06b7f4e9be3b0fed7b1c9006a4666ea04`, bez dirty paths.
Native snapshot:
`ce7fec0a8446178a03ae18c28128cd85c3c9dbe63c041c8a876f96198fa27097`.
Capsule digest:
`bedb167cb41845460cccf9634af8bfc8418f29641e27ac014f14cef05e2c71a8`.
Capture: `e4621a1fec4f4df1a28fc64a26b0894c`.
Request key: `b-03-demag-direct-torques-9f7eadb06b7f4e9`.

Przyjęcie do kolejki, exit 0 klienta submit, nie oznacza udanego buildu.
Po terminalnym wyniku trzeba sprawdzić dokładne źródło, receipt i artefakty.
Build obejmuje B-02/B-03; nie jest testem runtime ani nauki. Nie zmieniono
kolejności zadań 216/217 ani wdrożonego obrazu runnera.
