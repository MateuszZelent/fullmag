# DE: 15 obliczonych punktów, 27.10.2026

Wykres obejmuje k=0 (completed w API) oraz 14 punktów nonzero-k (oba native tasks succeeded; pakiet generacji zapisany, odrzucony w UI przez błędny session_id). Nie oznacza pełnej kwalifikacji solvera.

| ky [rad/µm] | f [GHz] | residual | różnica względem n=0 [%] |
|---:|---:|---:|---:|
| -25 | 13.560765017 | 2.717e-11 | -0.827148 |
| -20 | 12.819133185 | 9.903e-12 | -0.612335 |
| -15 | 12.041290552 | 1.715e-12 | -0.400444 |
| -10 | 11.211849792 | 2.415e-11 | -0.209733 |
| -7 | 10.681045692 | 2.461e-11 | -0.117943 |
| -5 | 10.310201976 | 7.495e-12 | -0.069533 |
| -2 | 9.724035208 | 5.226e-13 | -0.014065 |
| 0 | 9.299249697 | 2.736e-13 | -0.000000 |
| 2 | 9.724074783 | 2.092e-13 | -0.013658 |
| 5 | 10.310352014 | 1.713e-11 | -0.068078 |
| 7 | 10.681152764 | 1.820e-11 | -0.116942 |
| 10 | 11.211886650 | 1.255e-11 | -0.209405 |
| 15 | 12.041315830 | 4.268e-12 | -0.400235 |
| 20 | 12.819200391 | 1.475e-11 | -0.611814 |
| 25 | 13.560913969 | 1.263e-11 | -0.826059 |

Analityka n=0: continuum dla skończonego airboxu Dirichleta; referencja 1D open-air basis16 pochodzi z zachowanej tabeli 04.10.2026 i nie jest tu ponownie wyliczana. Największa różnica: 0,82715% względem n=0 oraz 0,59363% względem 1D. Mały residual nie jest dowodem zbieżności siatki.

Poprawka producenta manifestu `96cd1a9bda80792cf1999dcc2f7567a692869327`: CI https://github.com/MateuszZelent/fullmag/actions/runs/40470001642 success. Managed iteration `c88a597660e142269f241dd13f4f8466` odmówiła restartu: API-running nie spełnia terminalnego preflight. Wymagane jest kontrolowane drain na podstawie trwałego terminalnego katalogu i pustej kolejki, bez fałszowania stanu API ani modyfikacji wyników.
