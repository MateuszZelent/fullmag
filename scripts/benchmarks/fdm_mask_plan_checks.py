#!/usr/bin/env python3
"""Plan-only checks of hand-written mask antennas on the FDM planner.

Plan Task 5 (`docs/superpowers/plans/2026-11-13-field-masks.md`). Each case
writes a short study, lowers it with `python3 -m fullmag.runtime.helper
export-run-config`, plans the IR of its `run` stage with `fullmag-bin plan-json
--execution-plan` and compares `backend_plan.mask_field_term_bases` with the
case's own Python functions evaluated at the cell centres. Time programs are
compared with the independent oracle
`crates/fullmag-expr/tests/fixtures/generate_time_program_golden.py`, and the
oracle's values with the Python time functions. No solver runs; no GPU is used.

Usage, inside the worktree's backend container:
    python3 /opt/fullmag/source/scripts/benchmarks/fdm_mask_plan_checks.py [--bin PATH] [--case NAME ...]
Prints one JSON report; exit status 0 when every case passes.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

MU0 = 4.0 * math.pi * 1e-7
SOURCE_ROOT = Path(__file__).resolve().parents[2]
ORACLE_PATH = SOURCE_ROOT / "crates/fullmag-expr/tests/fixtures/generate_time_program_golden.py"
DEFAULT_BIN = "/opt/fullmag/package/bin/fullmag-bin"
FIELD_RTOL = 1e-13  # relative to the largest |H| of the term
TIME_RTOL = 1e-12
TIME_SAMPLES_S = (0.0, 1e-12, 2.5e-10, 1.7e-9)
STATIC_PROGRAM = [1.0, 1.0, 0.0]

# Functions written in the study scripts; the probe calls the same source for
# the expected values.
FUNCTIONS = '''
def uniform(x, y, z, b):
    return (0.0, 0.0, b)


def ramp(x, y, z, B, L):
    return (B * x / L, 0.0, 0.0)


def formula(x, y, z, B, L):
    return (B * x / L, 0.0, B * cos(2 * pi * y / L))


def mask_sin_kx(x, y, z, B, k):
    return (B * sin(k * x), 0.0, 0.0)


def mask_minus_cos_kx(x, y, z, B, k):
    return (-B * cos(k * x), 0.0, 0.0)


def cos_wt(t, f):
    return cos(2 * pi * f * t)


def sin_wt(t, f):
    return sin(2 * pi * f * t)


def reassigned(x, y, z, B01, wavelength, fwhm_y, xs):
    k = 2 * pi / wavelength
    sigma_y = fwhm_y / (2 * sqrt(2 * log(2)))
    g = exp(-(x + xs) ** 2 / (2 * wavelength ** 2))
    g = g * exp(-y ** 2 / (2 * sigma_y ** 2))
    g *= B01
    return (g * sin(k * x - pi / 2), 0.0, g * sin(k * x))


def delayed_sine(t, frequency, t0):
    t = t - t0
    return sin(2 * pi * frequency * t)


def log_time(t):
    return log(t)
'''

HEADER = """\
from math import pi, sin, cos, exp, log, sqrt
import fullmag as fm

study = fm.study("mask_plan_{name}")
study.engine("{engine}")
study.device("cpu", precision="double")
study.universe(mode="manual", size={universe_size}, center=(0.0, 0.0, {universe_cz}), padding=(0.0, 0.0, 0.0))
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(size=(80e-9, 40e-9, 20e-9), name="film"), name="film")
film.mesh(maximum_element_size=5e-9, order=1)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
"""
ADD_AND_RUN = """
study.stages.add_field_drive(antenna, stage_id="source_on")
study.stages.add_run(stage_id="run", until=1e-12)
"""
WHOLE = "fm.Box(80e-9, 40e-9, 20e-9)"
REGION_A = 'film.add_region("a", fm.Box(40e-9, 40e-9, 20e-9).translate((-20e-9, 0.0, 0.0)), region_id="film:a", priority={priority})'
REGION_B = 'film.add_region("b", fm.Box(80e-9, 40e-9, 20e-9), region_id="film:b", priority=2)'


@dataclass(frozen=True)
class Term:
    mask: str
    values: dict[str, float]
    time: str | None = None
    time_values: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Case:
    name: str
    body: str
    terms: tuple[Term, ...] = ()
    support: Callable[[tuple[float, float, float], int, dict], bool] | None = None
    count: int | None = None
    frame_origin: tuple[float, float, float] = (0.0, 0.0, 0.0)
    error: str | None = None
    engine: str = "fdm"
    universe_size: str = "(80e-9, 40e-9, 20e-9)"
    universe_cz: str = "0.0"
    regional_only: bool = False


def inside_box(centre, size, point) -> bool:
    """Inclusive box membership, as the planner's support shapes."""
    return all(abs(p - c) <= s / 2 for p, c, s in zip(point, centre, size))


def cell_centres(plan: dict) -> list[tuple[float, float, float]]:
    """World cell centres of an FDM backend plan, x fastest."""
    nx, ny, nz = plan["grid"]["cells"]
    ox, oy, oz = plan["origin_m"]
    dx, dy, dz = plan["cell_size"]
    return [
        (ox + (i + 0.5) * dx, oy + (j + 0.5) * dy, oz + (k + 0.5) * dz)
        for k in range(nz)
        for j in range(ny)
        for i in range(nx)
    ]


def region_marker(plan: dict, region_id: str) -> int:
    legend = (plan.get("grid_certificate") or {}).get("region_legend") or []
    return next(entry["numeric_id"] for entry in legend if entry["region_id"] == region_id)


def in_region(region_id: str):
    return lambda point, index, plan: plan["region_mask"][index] == region_marker(plan, region_id)


def expected_field(plan, case, term, functions) -> list[list[float]]:
    """H = B/μ0 of the term at every supported active cell, zero elsewhere."""
    active = plan.get("active_mask") or [True] * len(cell_centres(plan))
    mask = functions[term.mask]
    origin = case.frame_origin
    result = []
    for index, point in enumerate(cell_centres(plan)):
        if active[index] and case.support(point, index, plan):
            local = tuple(p - o for p, o in zip(point, origin))
            result.append([value / MU0 for value in mask(*local, **term.values)])
        else:
            result.append([0.0, 0.0, 0.0])
    return result


def field_error(got: list[list[float]], expected: list[list[float]]) -> float:
    """Largest component difference relative to the largest expected |H|."""
    scale = max((abs(v) for row in expected for v in row), default=0.0) or 1.0
    return max(abs(a - b) for g, e in zip(got, expected) for a, b in zip(g, e)) / scale


def load_oracle():
    spec = importlib.util.spec_from_file_location("time_program_oracle", ORACLE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def oracle_program(oracle, function_ir: dict):
    """Program and expression tree of a time function IR, by the oracle."""
    names = {item["name"]: ("num", float(item["value"])) for item in function_ir.get("parameters", [])}
    for local in function_ir.get("locals", []):
        names[local["name"]] = oracle.Parser(local["expression"], names).expression()
    tree = oracle.Parser(function_ir["outputs"][0], names).expression()
    code: list[float] = []
    oracle.emit(tree, code)
    code.append(oracle.OPCODES["RETURN"])
    return [float(word) for word in code], tree


def same_program(got: list[float], expected: list[float]) -> bool:
    """Opcodes equal; literals equal to 4 ulp (libm may differ in the last bit)."""
    return len(got) == len(expected) and all(
        a == b or math.isclose(a, b, rel_tol=1e-15, abs_tol=0.0) for a, b in zip(got, expected)
    )


def script_of(case: Case) -> str:
    header = HEADER.format(
        name=case.name, engine=case.engine, universe_size=case.universe_size,
        universe_cz=case.universe_cz,
    )
    tail = "" if case.regional_only else ADD_AND_RUN
    return header + FUNCTIONS + "\n" + case.body.strip() + "\n" + tail


def run_stage_ir(case: Case, workdir: Path) -> dict:
    script = workdir / f"{case.name}.py"
    script.write_text(script_of(case), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "fullmag.runtime.helper", "export-run-config", "--script", script.name],
        cwd=workdir, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"export-run-config failed: {proc.stderr[-2000:]}")
    config = first_json_object(proc.stdout)
    for stage in config.get("stages") or []:
        metadata = stage["ir"].get("problem_meta", {}).get("runtime_metadata", {})
        if metadata.get("active_stage_id") == "run":
            return stage["ir"]
    raise RuntimeError("no stage with active_stage_id 'run'")


def first_json_object(text: str) -> dict:
    """The first JSON object in ``text`` (logs may precede or follow it)."""
    value, _ = json.JSONDecoder().raw_decode(text, text.index("{"))
    return value


def plan_ir(binary: str, ir: dict, workdir: Path, name: str) -> tuple[int, str, str]:
    """Exit status, stdout and stdout + stderr of ``plan-json`` for one IR."""
    path = workdir / f"{name}.ir.json"
    path.write_text(json.dumps(ir), encoding="utf-8")
    proc = subprocess.run([binary, "plan-json", "--execution-plan", str(path)], capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stdout + proc.stderr


def check_case(case: Case, binary: str, workdir: Path, oracle, functions: dict) -> dict:
    ir = run_stage_ir(case, workdir)
    status, stdout, output = plan_ir(binary, ir, workdir, case.name)
    if case.error is not None:
        ok = status != 0 and case.error in output
        return {"case": case.name, "passed": ok, "expected_error": case.error,
                "exit_status": status, "output_tail": output[-600:] if not ok else None}
    if status != 0:
        return {"case": case.name, "passed": False, "exit_status": status, "output_tail": output[-1500:]}
    plan = first_json_object(stdout)["backend_plan"]
    if case.regional_only:
        ok = "mask_field_term_bases" not in plan and len(plan.get("regional_field_drive_bases", [])) == 1
        return {"case": case.name, "passed": ok, "plan_keys_with_drive": sorted(k for k in plan if "drive" in k)}
    bases = plan.get("mask_field_term_bases", [])
    failures: list[str] = []
    if len(bases) != len(case.terms):
        failures.append(f"{len(bases)} bases for {len(case.terms)} terms")
    drive_ir = ir["mask_field_drives"][0]
    report_terms = []
    for index, (basis, term) in enumerate(zip(bases, case.terms)):
        if basis["term_index"] != index or basis["drive_id"] != drive_ir["id"]:
            failures.append(f"term {index}: wrong drive_id/term_index {basis['drive_id']}/{basis['term_index']}")
        error = field_error(basis["field_xyz"], expected_field(plan, case, term, functions))
        nonzero = sum(1 for row in basis["field_xyz"] if any(row))
        if error > FIELD_RTOL:
            failures.append(f"term {index}: field error {error:.3e} > {FIELD_RTOL:g}")
        if case.count is not None and nonzero != case.count:
            failures.append(f"term {index}: {nonzero} non-zero cells, expected {case.count}")
        time_ir = drive_ir["terms"][index].get("time")
        time_report = None
        if term.time is None:
            if basis["time_program"] != STATIC_PROGRAM or basis["time_dependent"]:
                failures.append(f"term {index}: static term has program {basis['time_program']}")
        else:
            program, tree = oracle_program(oracle, time_ir)
            if not same_program(basis["time_program"], program):
                failures.append(f"term {index}: program {basis['time_program']} != oracle {program}")
            # The plan keeps the resolved equation (values substituted); it must
            # compile to the same program.
            resolved, _ = oracle_program(oracle, {"outputs": [basis["time_expression"]]})
            if not same_program(resolved, program):
                failures.append(f"term {index}: time_expression {basis['time_expression']!r} gives {resolved}")
            if basis["time_dependent"] != oracle.depends_on_t(tree):
                failures.append(f"term {index}: time_dependent {basis['time_dependent']}")
            time_function = functions[term.time]
            worst = max(
                abs(oracle.evaluate(tree, t) - time_function(t, **term.time_values))
                for t in TIME_SAMPLES_S
            )
            if worst > TIME_RTOL:
                failures.append(f"term {index}: oracle vs Python time function differ by {worst:.3e}")
            time_report = {"program_words": len(program), "max_abs_difference": worst}
        if not str(basis.get("projection_signature", "")).startswith("sha256:"):
            failures.append(f"term {index}: projection_signature missing")
        report_terms.append({"term_index": index, "field_relative_error": error,
                             "nonzero_cells": nonzero, "time": time_report})
    return {"case": case.name, "passed": not failures, "failures": failures, "terms": report_terms}


def cases() -> list[Case]:
    whole = lambda point, index, plan: True  # noqa: E731
    one_ms = {"b": 1e-3}
    k = 2 * math.pi / 40e-9
    return [
        Case("uniform_static",
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE})\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             (Term("uniform", one_ms),), whole, count=512),
        Case("box_support",
             "antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(40e-9, 20e-9, 10e-9), "
             "position=(0.0, 0.0, -5e-9), frame='world')\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             (Term("uniform", one_ms),),
             lambda p, i, plan: inside_box((0.0, 0.0, -5e-9), (40e-9, 20e-9, 10e-9), p), count=64),
        Case("local_frame",
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE}, position=(20e-9, 0.0, 0.0), frame='local')\n"
             "antenna.add(fm.mask(ramp, B=1e-3, L=80e-9))",
             (Term("ramp", {"B": 1e-3, "L": 80e-9}),),
             lambda p, i, plan: inside_box((20e-9, 0.0, 0.0), (80e-9, 40e-9, 20e-9), p),
             count=384, frame_origin=(20e-9, 0.0, 0.0)),
        Case("formula",
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE}, frame='world')\n"
             "antenna.add(fm.mask(formula, B=1e-3, L=80e-9))",
             (Term("formula", {"B": 1e-3, "L": 80e-9}),), whole),
        Case("two_terms",
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE}, frame='world')\n"
             "antenna.add(fm.mask(mask_sin_kx, B=1e-3, k=2 * pi / 40e-9), fm.time(cos_wt, f=3.6e9), name='c')\n"
             "antenna.add(fm.mask(mask_minus_cos_kx, B=1e-3, k=2 * pi / 40e-9), fm.time(sin_wt, f=3.6e9), name='s')",
             (Term("mask_sin_kx", {"B": 1e-3, "k": k}, "cos_wt", {"f": 3.6e9}),
              Term("mask_minus_cos_kx", {"B": 1e-3, "k": k}, "sin_wt", {"f": 3.6e9})), whole),
        Case("reassigned_locals",
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE}, frame='world', time_origin='absolute')\n"
             "antenna.add(fm.mask(reassigned, B01=0.2e-3, wavelength=40e-9, fwhm_y=30e-9, xs=10e-9), "
             "fm.time(delayed_sine, frequency=3.6e9, t0=0.1e-9))",
             (Term("reassigned", {"B01": 0.2e-3, "wavelength": 40e-9, "fwhm_y": 30e-9, "xs": 10e-9},
                   "delayed_sine", {"frequency": 3.6e9, "t0": 0.1e-9}),), whole),
        Case("region_overlap",
             REGION_A.format(priority=1) + "\n" + REGION_B + "\n"
             "antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(40e-9, 40e-9, 20e-9), "
             "position=(-20e-9, 0.0, 0.0), frame='world')\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             (Term("uniform", one_ms),),
             lambda p, i, plan: inside_box((-20e-9, 0.0, 0.0), (40e-9, 40e-9, 20e-9), p), count=256),
        Case("region_target",
             "region_a = " + REGION_A.format(priority=1) + "\n"
             f"antenna = region_a.add_simpleantenna.arbitrary_mask({WHOLE}, frame='world')\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             (Term("uniform", one_ms),), in_region("film:a"), count=256),
        Case("region_target_shadowed",
             "region_a = " + REGION_A.format(priority=1) + "\n" + REGION_B + "\n"
             f"antenna = region_a.add_simpleantenna.arbitrary_mask({WHOLE}, frame='world')\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             error="mask_support_empty"),
        Case("global_target",
             "antenna = study.add_simpleantenna.arbitrary_mask('global', fm.Box(40e-9, 40e-9, 20e-9), "
             "position=(-20e-9, 0.0, 0.0))\n"
             "antenna.add(fm.mask(ramp, B=1e-3, L=80e-9))",
             (Term("ramp", {"B": 1e-3, "L": 80e-9}),),
             lambda p, i, plan: inside_box((-20e-9, 0.0, 0.0), (40e-9, 40e-9, 20e-9), p),
             count=256, frame_origin=(-20e-9, 0.0, 0.0)),
        Case("regional_unchanged",
             "drive = fm.RegionalFieldDrive(id='regional', name='Regional', target=fm.FieldTarget.global_domain(), "
             "amplitude_B_T=1e-3, direction=(0, 1, 0), spatial_profile=fm.UniformFieldProfile(), "
             "waveform=fm.Constant())\n"
             "study.stages.add_field_drive(drive, stage_id='source_on')\n"
             "study.stages.add_run(stage_id='run', until=1e-12)",
             regional_only=True),
        Case("empty_support",
             "antenna = film.add_simpleantenna.arbitrary_mask(fm.Box(10e-9, 10e-9, 10e-9), "
             "position=(500e-9, 0.0, 0.0), frame='world')\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             error="mask_support_empty"),
        Case("non_finite_time",
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE})\n"
             "antenna.add(fm.mask(uniform, b=1e-3), fm.time(log_time))",
             error="mask_expression_non_finite"),
        Case("fem",
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE})\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             error="mask_field_drive_unsupported_lane:fem", engine="fem",
             universe_size="(160e-9, 80e-9, 60e-9)"),
        Case("multilayer",
             "cap = study.geometry(fm.Box(size=(80e-9, 40e-9, 5e-9), name='cap').translate((0.0, 0.0, 20e-9)), name='cap')\n"
             "cap.Ms = 800e3\ncap.Aex = 13e-12\ncap.alpha = 0.01\ncap.m = fm.texture.uniform(1.0, 0.0, 0.0)\n"
             f"antenna = film.add_simpleantenna.arbitrary_mask({WHOLE})\n"
             "antenna.add(fm.mask(uniform, b=1e-3))",
             error="mask_field_drive_unsupported_lane:fdm_multilayer",
             universe_size="(80e-9, 40e-9, 40e-9)", universe_cz="7.5e-9"),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bin", default=DEFAULT_BIN, help="fullmag-bin to plan with")
    parser.add_argument("--case", action="append", help="run only these cases")
    args = parser.parse_args(argv)
    oracle = load_oracle()
    functions: dict = {name: getattr(math, name) for name in ("sin", "cos", "exp", "log", "sqrt")}
    functions["pi"] = math.pi
    exec(FUNCTIONS, functions)
    selected = [case for case in cases() if not args.case or case.name in args.case]
    results = []
    with tempfile.TemporaryDirectory(prefix="fdm-mask-plan-") as directory:
        for case in selected:
            workdir = Path(directory) / case.name
            workdir.mkdir()
            try:
                results.append(check_case(case, args.bin, workdir, oracle, functions))
            except Exception as error:  # report every case, then fail
                results.append({"case": case.name, "passed": False, "exception": repr(error)[-1500:]})
    passed = sum(1 for result in results if result["passed"])
    print(json.dumps({
        "schema": "fullmag.fdm-mask-plan-checks.v1",
        "state": "passed" if passed == len(results) else "failed",
        "summary": f"{passed}/{len(results)} cases passed",
        "field_relative_tolerance": FIELD_RTOL,
        "time_tolerance": TIME_RTOL,
        "cases": results,
    }, indent=1, sort_keys=True))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
