#!/usr/bin/env python3
"""Render the deterministic BORIS N/F reciprocal-SHE workload.

The rendered source is executed by BORIS' embedded Python interpreter.  The
module itself is deliberately host-independent so unit tests can inspect the
scenario without importing BORIS' ``NetSocks`` extension.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path


Vector3 = tuple[float, float, float]


@dataclass(frozen=True)
class NfCaseConfig:
    nx: int = 10
    ny: int = 4
    nz_n: int = 2
    nz_f: int = 2
    output_dir: Path = Path(".")
    use_tunnel_barrier: bool = False
    barrier_m: float = 0.0
    barrier_conductance_spm2: float = 0.0
    cell_x_m: float = 1.0e-7
    cell_y_m: float = 1.0e-7
    cell_z_m: float = 1.0e-9
    theta_sh: float = 0.10
    conductivity_spm: float = 5.8e7
    de_m2_per_s: float = 0.01
    lambda_sf_m: float = 5.0e-9
    l_ex_m: float = 2.0e-9
    l_ph_m: float = 4.0e-9
    gi_spm2: float = 5.0e14
    gmix_real_spm2: float = 1.5e15
    gmix_imag_spm2: float = 0.0
    current_density_apm2: float = 1.0e11
    saturation_magnetization_apm: float = 8.0e5
    exchange_jpm: float = 1.3e-11
    polarization: float = 0.4
    magnetization: Vector3 = (1.0, 0.0, 0.0)
    transport_tolerance: float = 1.0e-5
    transport_max_iterations: int = 200

    def __post_init__(self) -> None:
        integer_fields = {
            "nx": self.nx,
            "ny": self.ny,
            "nz_n": self.nz_n,
            "nz_f": self.nz_f,
        }
        for name, value in integer_fields.items():
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        positive_fields = {
            "cell_x_m": self.cell_x_m,
            "cell_y_m": self.cell_y_m,
            "cell_z_m": self.cell_z_m,
            "conductivity_spm": self.conductivity_spm,
            "de_m2_per_s": self.de_m2_per_s,
            "lambda_sf_m": self.lambda_sf_m,
            "l_ex_m": self.l_ex_m,
            "l_ph_m": self.l_ph_m,
            "gi_spm2": self.gi_spm2,
            "gmix_real_spm2": self.gmix_real_spm2,
            "saturation_magnetization_apm": self.saturation_magnetization_apm,
            "exchange_jpm": self.exchange_jpm,
            "transport_tolerance": self.transport_tolerance,
        }
        for name, value in positive_fields.items():
            if not isinstance(value, (int, float)) or value <= 0.0:
                raise ValueError(f"{name} must be finite and positive")
        for name, value in {
            "theta_sh": self.theta_sh,
            "gmix_imag_spm2": self.gmix_imag_spm2,
            "current_density_apm2": self.current_density_apm2,
            "polarization": self.polarization,
        }.items():
            if not isinstance(value, (int, float)):
                raise ValueError(f"{name} must be numeric")
        if (
            isinstance(self.transport_max_iterations, bool)
            or not isinstance(self.transport_max_iterations, int)
            or self.transport_max_iterations < 1
        ):
            raise ValueError("transport_max_iterations must be a positive integer")
        if len(self.magnetization) != 3:
            raise ValueError("magnetization must have three components")
        if sum(component * component for component in self.magnetization) == 0.0:
            raise ValueError("magnetization must be non-zero")
        if self.use_tunnel_barrier:
            if self.barrier_m <= 0.0 or self.barrier_conductance_spm2 <= 0.0:
                raise ValueError(
                    "tunnel-barrier workloads require positive barrier thickness and conductance"
                )
        elif self.barrier_m != 0.0 or self.barrier_conductance_spm2 != 0.0:
            raise ValueError(
                "barrier thickness/conductance require use_tunnel_barrier=True"
            )

    @property
    def normal_thickness_m(self) -> float:
        return self.nz_n * self.cell_z_m

    @property
    def ferromagnet_thickness_m(self) -> float:
        return self.nz_f * self.cell_z_m

    @property
    def workload(self) -> str:
        return "N/T/F" if self.use_tunnel_barrier else "N/F"


def scenario_manifest(config: NfCaseConfig) -> dict[str, object]:
    """Return deterministic scenario metadata consumed by the verifier."""

    return {
        "schema_version": "fullmag.boris_she_nf.scenario.v1",
        "workload": config.workload,
        "geometry": {
            "cell_m": [config.cell_x_m, config.cell_y_m, config.cell_z_m],
            "normal_extent_m": [
                config.nx * config.cell_x_m,
                config.ny * config.cell_y_m,
                config.normal_thickness_m,
            ],
            "ferromagnet_extent_m": [
                config.nx * config.cell_x_m,
                config.ny * config.cell_y_m,
                config.ferromagnet_thickness_m,
            ],
            "normal_shape": [config.nx, config.ny, config.nz_n],
            "ferromagnet_shape": [config.nx, config.ny, config.nz_f],
            "interface_normal": "+z",
            "barrier_m": config.barrier_m,
        },
        "parameters": {
            "SHA": config.theta_sh,
            "iSHA": config.theta_sh,
            "elC_Spm": config.conductivity_spm,
            "De_m2_per_s": config.de_m2_per_s,
            "lambda_sf_m": config.lambda_sf_m,
            "l_ex_m": config.l_ex_m,
            "l_ph_m": config.l_ph_m,
            "Gi_Spm2": config.gi_spm2,
            "Gmix_Spm2": [config.gmix_real_spm2, config.gmix_imag_spm2],
            "barrier_conductance_Spm2": config.barrier_conductance_spm2,
            "Jc_apm2": [config.current_density_apm2, 0.0, 0.0],
            "Ms_apm": config.saturation_magnetization_apm,
            "A_Jpm": config.exchange_jpm,
            "P": config.polarization,
            "magnetization": list(config.magnetization),
            "transport_tolerance": config.transport_tolerance,
            "transport_max_iterations": config.transport_max_iterations,
        },
        "conventions": {
            "spin_quantity": "BORIS native S",
            "spin_voltage": "V_s=De*S/(elC*MUB_E)",
            "fullmag_mapping": "mu_s=2*V_s",
            "spin_current_component_order": "Jsx, Jsy, Jsz",
            "interface_normal_sign": "N plus-z to F minus-z",
        },
    }


def _python_literal(value: object) -> str:
    return repr(value)


def _field_exports() -> str:
    return "\n".join(
        f'{mesh}.quant.{quantity}.saveovf2("text", str(output / "{prefix}_{quantity}.ovf"))'
        for mesh, prefix in (("conductor", "n"), ("ferromagnet", "f"))
        for quantity in ("V", "S", "Jc", "Jsx", "Jsy", "Jsz")
    ) + "\nferromagnet.quant.Ts.saveovf2(\"text\", str(output / \"f_Ts.ovf\"))\nferromagnet.quant.Tsi.saveovf2(\"text\", str(output / \"f_Tsi.ovf\"))"


def _ovf_sample_function() -> str:
    return '''\
def _ovf_sample(path, position):
    header = {}
    rows = []
    in_data = False
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered == "# begin: data text":
            in_data = True
            continue
        if lowered == "# end: data text":
            in_data = False
            continue
        if in_data:
            if stripped and not stripped.startswith("#"):
                rows.append(tuple(float(value) for value in stripped.split()))
            continue
        if stripped.startswith("#") and ":" in stripped:
            key, value = stripped[1:].split(":", 1)
            normalized_key = key.strip().lower()
            if normalized_key in {
                "xmin", "ymin", "zmin", "xstepsize", "ystepsize", "zstepsize",
                "xnodes", "ynodes", "znodes",
            }:
                header[normalized_key] = float(value.strip())
    shape = tuple(int(header[key]) for key in ("xnodes", "ynodes", "znodes"))
    origin = tuple(header[key] for key in ("xmin", "ymin", "zmin"))
    step = tuple(header[key] for key in ("xstepsize", "ystepsize", "zstepsize"))
    indices = tuple(
        max(0, min(shape[axis] - 1, int(round((position[axis] - origin[axis]) / step[axis]))))
        for axis in range(3)
    )
    row = rows[indices[0] + shape[0] * (indices[1] + shape[1] * indices[2])]
    return row[0] if len(row) == 1 else list(row)


def _ovf_samples(prefix, position):
    return {
        "V": _ovf_sample(output / (prefix + "_V.ovf"), position),
        "S": _ovf_sample(output / (prefix + "_S.ovf"), position),
        "Jc": _ovf_sample(output / (prefix + "_Jc.ovf"), position),
        "Jsx": _ovf_sample(output / (prefix + "_Jsx.ovf"), position),
        "Jsy": _ovf_sample(output / (prefix + "_Jsy.ovf"), position),
        "Jsz": _ovf_sample(output / (prefix + "_Jsz.ovf"), position),
    }
'''


def render_boris_script(config: NfCaseConfig) -> str:
    """Render a self-contained NetSocks script for one workload."""

    manifest = scenario_manifest(config)
    output_dir = str(config.output_dir.resolve())
    normal_z_max = config.normal_thickness_m
    barrier_z_max = normal_z_max + (config.barrier_m if config.use_tunnel_barrier else 0.0)
    ferromagnet_z_min = barrier_z_max
    ferromagnet_z_max = ferromagnet_z_min + config.ferromagnet_thickness_m
    barrier_lines = ""
    barrier_manifest = "None"
    if config.use_tunnel_barrier:
        barrier_lines = f'''\nbarrier = ns.Insulator(\n    [0.0, 0.0, {normal_z_max!r}, {config.nx * config.cell_x_m!r},\n     {config.ny * config.cell_y_m!r}, {barrier_z_max!r}],\n    [{config.cell_x_m!r}, {config.cell_y_m!r}, {config.cell_z_m!r}],\n    "barrier",\n)\nbarrier.modules("transport")\nbarrier.param.RAtmr_p = {1.0 / config.barrier_conductance_spm2!r}\nbarrier.param.RAtmr_ap = {1.0 / config.barrier_conductance_spm2!r}\n'''
        barrier_manifest = "barrier"
    probe_x = 0.5 * config.cell_x_m
    probe_y = 0.5 * config.cell_y_m
    probe_z_n = 0.5 * config.cell_z_m
    probe_z_f = ferromagnet_z_min + 0.5 * config.cell_z_m
    return f'''# Generated by scripts/boris_nf_interface_smoke.py
import json
from pathlib import Path
from NetSocks import NSClient

output = Path({_python_literal(output_dir)})
output.mkdir(parents=True, exist_ok=True)
scenario = {_python_literal(manifest)}
ns = NSClient()
ns.configure(reset_to_default=True, script_verbose=True)

conductor = ns.Conductor(
    [0.0, 0.0, 0.0, {config.nx * config.cell_x_m!r}, {config.ny * config.cell_y_m!r}, {normal_z_max!r}],
    [{config.cell_x_m!r}, {config.cell_y_m!r}, {config.cell_z_m!r}],
    "conductor",
)
ferromagnet = ns.Ferromagnet(
    [0.0, 0.0, {ferromagnet_z_min!r}, {config.nx * config.cell_x_m!r}, {config.ny * config.cell_y_m!r}, {ferromagnet_z_max!r}],
    [{config.cell_x_m!r}, {config.cell_y_m!r}, {config.cell_z_m!r}],
    "ferromagnet",
)
conductor.modules("transport")
ferromagnet.modules("transport")
ferromagnet.ecellsize([{config.cell_x_m!r}, {config.cell_y_m!r}, {config.cell_z_m!r}])
{barrier_lines}

conductor.param.elC = {config.conductivity_spm!r}
conductor.param.De = {config.de_m2_per_s!r}
conductor.param.SHA = {config.theta_sh!r}
conductor.param.iSHA = {config.theta_sh!r}
conductor.param.l_sf = {config.lambda_sf_m!r}
conductor.param.Gi = [0.0, 0.0]
conductor.param.Gmix = [0.0, 0.0]

ferromagnet.param.Ms = {config.saturation_magnetization_apm!r}
ferromagnet.param.A = {config.exchange_jpm!r}
ferromagnet.param.damping = 0.02
ferromagnet.param.elC = {config.conductivity_spm!r}
ferromagnet.param.De = {config.de_m2_per_s!r}
ferromagnet.param.SHA = {config.theta_sh!r}
ferromagnet.param.l_sf = {config.lambda_sf_m!r}
ferromagnet.param.l_phi = {config.l_ph_m!r}
ferromagnet.param.P = {config.polarization!r}
ferromagnet.param.beta = 0.01
ferromagnet.param.Gi = [{config.gi_spm2!r}, 0.0]
ferromagnet.param.Gmix = [{config.gmix_real_spm2!r}, {config.gmix_imag_spm2!r}]
ferromagnet.setangle(90.0, 0.0)

ns.setode("LLGStatic-SA", "Euler")
ns.tsolverconfig({config.transport_tolerance!r}, {config.transport_max_iterations!r})
ns.ssolverconfig({config.transport_tolerance!r}, {config.transport_max_iterations!r})
ns.setdefaultelectrodes("x")
ns.setcurrent({config.current_density_apm2 * config.ny * config.cell_y_m * (config.normal_thickness_m + config.barrier_m + config.ferromagnet_thickness_m)!r})
ns.statictransportsolver(1)
ns.setstages(["Relax", "iter", 1])
ns.Run()

{_field_exports()}
{_ovf_sample_function()}

normal_position = [{probe_x!r}, {probe_y!r}, {probe_z_n!r}]
ferromagnet_position = [{probe_x!r}, {probe_y!r}, {probe_z_f!r}]

samples = {{
    "normal": _ovf_samples("n", normal_position),
    "ferromagnet": _ovf_samples("f", ferromagnet_position),
    "sample_source": "nearest cell from text OVF export",
}}
native = {{
    "schema_version": "fullmag.boris_she_nf.native.v1",
    "scenario": scenario,
    "stage_complete": True,
    "barrier_mesh": {barrier_manifest},
    "samples": samples,
    "fields": sorted(path.name for path in output.glob("*.ovf")),
}}
(output / "boris_native_samples.json").write_text(json.dumps(native, indent=2, sort_keys=True), encoding="utf-8")
print("BORIS_NF_STAGE_COMPLETE", flush=True)
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--nx", type=int, default=10)
    parser.add_argument("--ny", type=int, default=4)
    parser.add_argument("--nz-n", type=int, default=2)
    parser.add_argument("--nz-f", type=int, default=2)
    args = parser.parse_args()
    config = NfCaseConfig(
        nx=args.nx,
        ny=args.ny,
        nz_n=args.nz_n,
        nz_f=args.nz_f,
        output_dir=args.output_dir,
    )
    print(json.dumps(scenario_manifest(config), indent=2, sort_keys=True))
    print(render_boris_script(config))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
