---
title: Acknowledgements
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: readme.md
---

(public-docs-acknowledgements-root)=
# Acknowledgements

This page records FullMag's European Union funding acknowledgement, core institutional support,
and the open-source micromagnetic and numerical software ecosystem whose methods, abstractions, and
validation standards inspired the platform.

## European Union funding & grant acknowledgement

<div class="fm-eu-grant-card">
  <div class="fm-eu-grant-card__flag" aria-label="European Union emblem">
    <svg viewBox="0 0 54 36" role="img" aria-label="European Union flag: twelve golden stars on a reflex blue field" xmlns="http://www.w3.org/2000/svg">
      <rect width="54" height="36" rx="2" fill="#003399" />
      <defs>
        <polygon id="fm-eu-star" points="0,-1.65 0.37,-0.51 1.57,-0.51 0.60,0.20 0.97,1.33 0,0.63 -0.97,1.33 -0.60,0.20 -1.57,-0.51 -0.37,-0.51" fill="#FFCC00" />
      </defs>
      <use href="#fm-eu-star" transform="translate(27.00, 7.50)" />
      <use href="#fm-eu-star" transform="translate(32.25, 8.91)" />
      <use href="#fm-eu-star" transform="translate(36.09, 12.75)" />
      <use href="#fm-eu-star" transform="translate(37.50, 18.00)" />
      <use href="#fm-eu-star" transform="translate(36.09, 23.25)" />
      <use href="#fm-eu-star" transform="translate(32.25, 27.09)" />
      <use href="#fm-eu-star" transform="translate(27.00, 28.50)" />
      <use href="#fm-eu-star" transform="translate(21.75, 27.09)" />
      <use href="#fm-eu-star" transform="translate(17.91, 23.25)" />
      <use href="#fm-eu-star" transform="translate(16.50, 18.00)" />
      <use href="#fm-eu-star" transform="translate(17.91, 12.75)" />
      <use href="#fm-eu-star" transform="translate(21.75, 8.91)" />
    </svg>
  </div>
  <div class="fm-eu-grant-card__body">
    <p class="fm-home-eyebrow">Horizon Europe · Marie Skłodowska-Curie Actions (MSCA)</p>
    <p><strong>Mateusz Zelent</strong> acknowledges funding from the European Union's Horizon Europe programme under <strong>HORIZON-MSCA-2024-PF-01</strong>, Marie Skłodowska-Curie Grant Agreement No. <strong>101208951 (CNMA)</strong>.</p>
    <div class="fm-eu-grant-card__meta">
      <span><strong>Call:</strong> HORIZON-MSCA-2024-PF-01</span>
      <span><strong>Grant Agreement:</strong> 101208951</span>
      <span><strong>Project Acronym:</strong> CNMA</span>
      <span><strong>Host Institution:</strong> RPTU Kaiserslautern-Landau</span>
    </div>
    <p class="fm-eu-grant-card__disclaimer">Funded by the European Union. Views and opinions expressed are however those of the author(s) only and do not necessarily reflect those of the European Union or the European Research Executive Agency (REA). Neither the European Union nor the granting authority can be held responsible for them.</p>
  </div>
</div>

| Field | Value |
|---|---|
| Funding programme | European Union — Horizon Europe |
| Funding scheme | Marie Skłodowska-Curie Actions Postdoctoral Fellowships (`HORIZON-MSCA-2024-PF-01`) |
| Grant Agreement number | `101208951` |
| Project acronym | `CNMA` |
| Principal fellow & coordinator | **Dr Mateusz Zelent** |
| Host institution | Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany |

## Institutional support & core authors

FullMag is developed in collaboration between research groups in computational magnetism and
magnonics at:

- **Fachbereich Physik and Landesforschungszentrum OPTIMAS**, Rheinland-Pfälzische Technische
  Universität Kaiserslautern-Landau (**RPTU**), Kaiserslautern, Germany
- **Faculty of Physics and Astronomy**, Adam Mickiewicz University in Poznań (**AMU Poznań**),
  Poznań, Poland

| Contributor | Role | Affiliation |
|---|---|---|
| **Dr Mateusz Zelent** | Project Coordinator & Lead Architect | Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany |
| **Dr Mateusz Gołebiewski** | Co-Author & Numerical Architecture | Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| **Uladzislau Makartsou** | Co-Author & Computational Physics | Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| **Prof. Philipp Pirro** | Co-Author & Scientific Advisory | Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany |

## Scientific heritage & related micromagnetic software

FullMag builds upon decades of pioneering open-source micromagnetics and computational spintronics
software. While FullMag implements an independent canonical model (`ProblemIR`, explicit capability
planning, Rust/C++17/CUDA FDM & FEM solvers, live HTTP/WebSocket `fullmag.live` sessions, and the
browser Control Room), its numerical conventions, user workflows, standard-problem cross-checks,
and physics scope are directly inspired by the packages below. External reference codes maintained
alongside the repository are used strictly for clean-room traceability and independent benchmark
cross-validation — **without claiming solver code reuse or implicit cross-solver parity**.

| Software package | Key contribution to computational micromagnetics | Influence on FullMag | Reference |
|---|---|---|---|
| **MuMax3** (`mumax³`) | GPU-accelerated finite-difference LLG solver, Newell FFT demagnetization, analytic magnetic texture presets, and concise scripting ergonomics | Inspiration for GPU FDM FFT convolution architecture, interactive workflow responsiveness, analytical texture preset compatibility, and `µMAG` standard-problem verification | Vansteenkiste et al. (2014) [^1] |
| **Amumax** | Python-integrated fork of `mumax³` introducing Zarr (`pyzfn`) data pipelines and enhanced browser WebUI workflows | Inspiration for Zarr-native simulation bundles (`<stem>.zarr`), browser-based live session inspection, and Python-first result ergonomics | Moalic et al. [^2] |
| **mumax⁺** (`mumax+`) | Extensible C++/CUDA/Python micromagnetic framework for multi-layer and multi-physics extensions | Reference point for modern C++/CUDA micromagnetic modularity and Python composability | Moreels et al. (2026) [^3] |
| **Boris Computational Spintronics** | Multi-mesh CPU/CUDA micromagnetic and 3D drift-diffusion spin-transport framework (`STT`, `SOT`, `SHE`, multilayer convolution, thermoelasticity) | Clean-room mathematical traceability for multilayer demagnetization convolution and coupled spin-transport formulations | Lepadatu (2017–2023) [^4] [^5] [^6] [^7] |
| **OOMMF** | NIST's foundational object-oriented micromagnetic framework and standard benchmark suite (`µMAG` SP1–SP4) | Canonical sign/unit conventions, Runge–Kutta stepping diagnostics, exchange/magnetostatic reference baselines, and standard-problem benchmarks | Donahue & Porter (1999) [^8] |
| **TetraX** | Finite-element dynamic-matrix approach ($\omega(k)$) for propagating-wave and magnonic waveguide eigenmodes | Inspiration for linearized-LLG tangent-space FEM eigensolver workflows, Brillouin-zone `KPath` sweeps, and spatial mode profile visualization | Körber et al. (2021, 2022) [^9] [^10] |
| **Tetmag** | General-purpose conforming tetrahedral finite-element solver and hybrid `FEM/BEM` open-boundary magnetostatics | Reference baseline and independent open-boundary `FEM/BEM` cross-check fixture for arbitrary 3D conforming geometries | Hertel [^11] |
| **NeuralMag** | Modular Python and symbolic/autodiff nodal finite-difference micromagnetics with AI-assistant-first documentation | Inspiration for expressive Python problem composition, clean machine-readable contracts, and modern Python packaging | Abert et al. (2025) [^12] |

### Foundational open-source numerical infrastructure

FullMag's finite-element, meshing, linear-algebra, spectral, and visualization lanes rely on and
thank the maintainers of:

- **MFEM**, **hypre**, and **libCEED** — high-order modular finite-element discretizations, scalable algebraic multigrid preconditioning, and GPU operator execution [^13].
- **Gmsh** — conforming 3D tetrahedral, prism, mixed-element, and Poisson-airbox mesh generation and CAD geometry import [^14].
- **PETSc** and **SLEPc** — scalable generalized eigenvalue and Krylov/shift-invert spectral infrastructure for linearized-LLG modal analysis [^15].
- **Foundational magnetostatic & review formulations** — Newell cell-averaged demagnetizing tensor kernels [^16], the Fredkin–Koehler hybrid FEM/BEM open-boundary formulation [^17], and unified numerical micromagnetics reviews [^18].
- **Rust**, **NumPy**, **Zarr**, **PyO3**, **Next.js**, **React**, **Three.js**, and **ECharts** — powering the host runtime, Python DSL (`fullmag`), binary `FMVP`/`FMTB`/`FMCS` data plane, and browser Control Room.

## How to cite FullMag

Until a versioned release with a persistent identifier is available, cite the repository and the
exact commit used for the reported result (together with the installed [`fullmag`](https://pypi.org/project/fullmag/) PyPI package version when applicable):

> M. Zelent, M. Gołebiewski, U. Makartsou, and P. Pirro, *FullMag: a computational framework for reproducible finite-difference and finite-element micromagnetics*, research software, 2026. Repository: [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag). Documentation: [fullmag.mzelent.pl](https://fullmag.mzelent.pl/).

```bibtex
@software{fullmag_2026,
  author = {Zelent, Mateusz and Gołebiewski, Mateusz and Makartsou, Uladzislau and Pirro, Philipp},
  title  = {FullMag: A Computational Framework for Reproducible
            Finite-Difference and Finite-Element Micromagnetics},
  year   = {2026},
  url    = {https://github.com/MateuszZelent/fullmag},
  note   = {Research software; cite the exact release or commit used}
}
```

When reporting results that compare against or build on methods from the packages above, please also
cite the original publications of those upstream projects.

## Bibliography

[^1]: A. Vansteenkiste, J. Leliaert, M. Dvornik, M. Helsen, F. Garcia-Sanchez, and B. Van Waeyenberge, “The design and verification of MuMax3,” *AIP Advances* **4**, 107133 (2014), [doi:10.1063/1.4899186](https://doi.org/10.1063/1.4899186). Homepage: <https://mumax.github.io/>.
[^2]: M. Moalic et al., *Amumax: Python-oriented MuMax3 fork with Zarr (`pyzfn`) storage and browser WebUI workflow enhancements*, <https://github.com/MathieuMoalic/amumax>.
[^3]: L. Moreels, I. Lateur, D. De Gusem, J. Mulkers, J. Maes, M. V. Milošević, J. Leliaert, and B. Van Waeyenberge, “mumax+: extensible GPU-accelerated micromagnetics and beyond,” *npj Computational Materials* (2026), [doi:10.1038/s41524-025-01893-y](https://doi.org/10.1038/s41524-025-01893-y).
[^4]: S. Lepadatu, “Boris computational spintronics — High performance multi-mesh magnetic and spin transport modeling software,” *Journal of Applied Physics* **128**, 243902 (2020). Homepage: <https://boris-spintronics.uk/>.
[^5]: S. Lepadatu, “Efficient computation of demagnetizing fields for magnetic multilayers using multilayered convolution,” *Journal of Applied Physics* **126**, 103903 (2019), [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
[^6]: S. Lepadatu, “Unified treatment of spin torques using a coupled magnetisation dynamics and three-dimensional spin current solver,” *Scientific Reports* **7**, 12937 (2017).
[^7]: S. Lepadatu, “Accelerating micromagnetic and atomistic simulations using multiple GPUs,” *Journal of Applied Physics* **134**, 163903 (2023), [doi:10.1063/5.0172657](https://doi.org/10.1063/5.0172657).
[^8]: M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, Interagency Report NISTIR 6376, National Institute of Standards and Technology, Gaithersburg, MD (1999). Homepage: <https://math.nist.gov/oommf/>.
[^9]: L. Körber, G. Quasebarth, A. Otto, and A. Kákay, “Finite-element dynamic-matrix approach for spin-wave dispersions in magnonic waveguides with arbitrary cross section,” *AIP Advances* **11**, 095006 (2021), [doi:10.1063/5.0054169](https://doi.org/10.1063/5.0054169).
[^10]: L. Körber, G. Quasebarth, A. Hempel, F. Zahn, A. Otto, E. Westphal, R. Hertel, and A. Kákay, “TetraX: Finite-Element Micromagnetic-Modeling Package,” Rodare (2022), [doi:10.14278/rodare.1418](https://doi.org/10.14278/rodare.1418). Homepage: <https://www.tetrax.software/>.
[^11]: R. Hertel, *tetmag: a finite-element software for general-purpose micromagnetic simulations*, CNRS – IPCMS and Université de Strasbourg, <https://github.com/R-Hertel/tetmag>.
[^12]: C. Abert, F. Bruckner, A. Voronov, M. Lang, S. A. Pathak, S. Holt, R. Kraft, R. Allayarov, P. Flauger, S. Koraltan, T. Schrefl, A. Chumak, H. Fangohr, and D. Suess, “NeuralMag: an open-source nodal finite-difference code for inverse micromagnetics,” *npj Computational Materials* **11**, 193 (2025), [doi:10.1038/s41524-025-01688-1](https://doi.org/10.1038/s41524-025-01688-1).
[^13]: R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics with Applications* **81**, 42–74 (2021), [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).
[^14]: C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**, 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
[^15]: V. Hernandez, J. E. Roman, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the solution of eigenvalue problems,” *ACM Transactions on Mathematical Software* **31**, 351–362 (2005).
[^16]: A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *Journal of Geophysical Research* **98**, 9551–9555 (1993), [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
[^17]: D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* **26**, 415–417 (1990), [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
[^18]: C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
