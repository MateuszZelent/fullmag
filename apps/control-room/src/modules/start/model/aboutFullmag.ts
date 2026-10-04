/**
 * What the About page says about FullMag itself (spelled as the README spells it). Everything here is taken from
 * the repository's `readme.md` ("Overview", "Citation and authors", "License",
 * "Funding"); nothing is added. `aboutFullmag.test.ts` fails when the README and
 * this file disagree, so the two cannot drift apart unnoticed.
 */

export const FULLMAG_TAGLINE =
  "FDM and FEM micromagnetics with Python, CPU/CUDA solvers, and an interactive Control Room";

export const FULLMAG_OVERVIEW = [
  "FullMag is active research software for finite-difference (FDM) and finite-element (FEM) micromagnetics. A model can be authored through the stage-oriented Python API or the Control Room, lowered to the canonical ProblemIR, checked against backend capabilities, and executed as an ordered study. The runtime records requested and resolved execution settings together with solver diagnostics and scientific artifacts.",
  "FullMag combines structured and conforming discretizations, CPU and CUDA implementations, time-domain dynamics, direct relaxation, hysteresis, FEM eigenmodes, driven frequency response, and interactive 2D/3D analysis in one workflow.",
] as const;

export interface FullmagEngine {
  readonly name: string;
  readonly bestFor: string;
}

export const FULLMAG_ENGINES: readonly FullmagEngine[] = [
  {
    name: "FDM",
    bestFor:
      "Regular films, nanowires, racetracks, disks, pillars, periodic cells, repeated time integration, and disconnected multilayers",
  },
  {
    name: "FEM",
    bestFor:
      "Curved or irregular 3D bodies, conforming multi-region structures, local refinement, magnetic-plus-air domains, and modal or driven-response studies",
  },
];

export interface FullmagAuthor {
  readonly name: string;
  readonly affiliation: string;
}

export const FULLMAG_AUTHORS: readonly FullmagAuthor[] = [
  {
    name: "Dr Mateusz Zelent",
    affiliation:
      "Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany",
  },
  {
    name: "Dr Mateusz Gołebiewski",
    affiliation: "Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland",
  },
  {
    name: "Prof. Philipp Pirro",
    affiliation:
      "Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany",
  },
];

export const FULLMAG_COORDINATION = "Mateusz Zelent, RPTU Kaiserslautern-Landau";

export const FULLMAG_CITATION_NOTE =
  "Until a versioned release with a persistent identifier is available, cite the repository and the exact commit used for the reported result";

export const FULLMAG_CITATION =
  "M. Zelent, M. Gołebiewski, and P. Pirro, FullMag: a computational framework for reproducible finite-difference and finite-element micromagnetics, research software, 2026.";

export const FULLMAG_BIBTEX = `@software{fullmag_2026,
  author = {Zelent, Mateusz and Gołebiewski, Mateusz and Pirro, Philipp},
  title  = {FullMag: A Computational Framework for Reproducible
            Finite-Difference and Finite-Element Micromagnetics},
  year   = {2026},
  url    = {https://github.com/MateuszZelent/fullmag},
  note   = {Research software; cite the exact release or commit used}
}`;

export const FULLMAG_REPOSITORY_URL = "https://github.com/MateuszZelent/fullmag";

export const FULLMAG_LICENSE =
  "The repository does not currently contain a root-level license file. Contact the project coordinator before reuse or redistribution.";

export const FULLMAG_FUNDING =
  "Mateusz Zelent acknowledges funding from the European Union's Horizon Europe programme under HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. 101208951 (CNMA).";
