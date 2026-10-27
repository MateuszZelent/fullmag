"""Compare accepted and checkpoint FEM data with historical DE references."""
from pathlib import Path
import csv
import hashlib
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from finite_dirichlet_thin_film_oracle import finite_dirichlet_n0_frequency_hz


def main():
    root = Path(__file__).resolve().parents[1]
    evidence = root / "docs/audits/2026-10-27-eigensolve-k10-mode-identity.evidence.json"
    data = json.loads(evidence.read_text())
    assert data["run"]["status"] == "completed"
    mode = data["spectrum"]["payload"]["samples"][0]["modes"][0]
    assert mode["block_residuals"]["full_descriptor_certified"]
    assert mode["block_residuals"]["eps_full"] <= mode["block_residuals"]["certification_tolerance"]
    historical_path = root / "docs/raports/2026-10-04-de-signed15-runtime.csv"
    with historical_path.open() as stream:
        historical = list(csv.DictReader(stream))
    checkpoint_path = root / "docs/audits/2026-10-27-eigensolve-signed14-publication-failure.evidence.json"
    checkpoint_data = json.loads(checkpoint_path.read_text())
    checkpoints = checkpoint_data["checkpoint_samples"]
    for sample in checkpoints:
        residual = sample["residuals"]
        assert residual["full_descriptor_certified"]
        assert residual["eps_full"] <= residual["certification_tolerance"]
    checkpoint_k = [row["k_vector_rad_m"][1] / 1e6 for row in checkpoints]
    checkpoint_f = [row["frequency_hz"] / 1e9 for row in checkpoints]
    out = root / "docs/raports/assets/de-reproduction-20261027"
    out.mkdir(parents=True, exist_ok=True)
    parameters = dict(geometry="DE", bias_field_a_per_m=mode["external_field_a_per_m"][0],
        film_thickness_m=10e-9, air_padding_each_side_m=2e-6,
        exchange_stiffness_j_per_m=13e-12, saturation_magnetisation_a_per_m=800000.,
        gamma0_rad_s_per_a_m=mode["gamma0_rad_s_per_A_m"], mu0_t_m_a=mode["mu0_T_m_per_A"])
    ks = [i / 10 for i in range(-250, 251)]
    analytic = [finite_dirichlet_n0_frequency_hz(k_rad_m=k*1e6, **parameters)/1e9 for k in ks]
    k = mode["k_vector"][1] / 1e6
    f = mode["frequency_hz"] / 1e9
    reference = finite_dirichlet_n0_frequency_hz(k_rad_m=k*1e6, **parameters)/1e9
    historical_k = [float(r["k_y_rad_per_um"]) for r in historical]
    historical_f = [float(r["frequency_hz"])/1e9 for r in historical]
    open_air = [float(r["open_air_1d_basis16_hz"])/1e9 for r in historical]
    matching = [r for r in historical if float(r["k_y_rad_per_um"]) == k]
    assert len(matching) == 1, "New point needs an exact reference sample"
    open_air_reference = float(matching[0]["open_air_1d_basis16_hz"])/1e9
    fig, (ax, errors) = plt.subplots(2, 1, figsize=(9, 7), sharex=True,
        gridspec_kw={"height_ratios": [3, 1]}, layout="constrained")
    ax.plot(historical_k, open_air, color="black", linewidth=1.3,
        label="Referencja 1D open-air, basis16 — zachowana tabela 04.10")
    ax.plot(ks, analytic, color="#17638d", label="Analityka n=0, skończony airbox Dirichleta")
    ax.scatter(historical_k, historical_f,
               facecolors="none", edgecolors="#777777", label="Historyczne FEM — 04.10 (15 punktów)", zorder=3)
    ax.scatter([k], [f], color="#d44827", marker="D", s=65,
               label="Nowe FEM — 27.10, zapisane pole modu (1 punkt)", zorder=4)
    ax.scatter(checkpoint_k, checkpoint_f, color="#7d3c98", marker="x", s=65,
               label="Nowe checkpointy FEM — błąd publikacji (14 punktów)", zorder=5)
    ax.annotate(f"FEM: {f:.6f} GHz\nΔ względem 1D: {100*(f/open_air_reference-1):+.3f}%",
                xy=(k, f), xytext=(-5, 12.4), arrowprops={"arrowstyle":"->", "color":"#d44827"})
    ax.set(ylabel="Częstotliwość [GHz]",
           title="DE: M ∥ x, k ∥ y; film 10 nm, B = 0,1 T", xlim=(-26,26))
    ax.grid(alpha=.2); ax.legend(loc="upper center", fontsize=8)
    errors.scatter(historical_k, [100*(fem/ref-1) for fem,ref in zip(historical_f,open_air)],
        facecolors="none", edgecolors="#777777")
    errors.scatter([k], [100*(f/open_air_reference-1)], color="#d44827", marker="D", s=50)
    references = {float(row["k_y_rad_per_um"]): float(row["open_air_1d_basis16_hz"])
                  for row in historical}
    errors.scatter(checkpoint_k,
        [100*(row["frequency_hz"]/references[k]-1) for k,row in zip(checkpoint_k,checkpoints)],
        color="#7d3c98", marker="x", s=50)
    errors.axhline(0, color="black", linewidth=.6)
    errors.set(xlabel="Wektor falowy ky [rad/µm]", ylabel="FEM − 1D [%]")
    errors.grid(alpha=.2)
    fig.text(.5, -.015, "Różne siatki powietrza; historyczne Γ: selected-only. Nie jest to nowy pełny sweep ani kwalifikacja solvera.", ha="center", fontsize=8)
    for ext in ("png", "pdf"):
        fig.savefig(out / f"de-reproduction-checkpoint.{ext}", dpi=180, bbox_inches="tight")
    plt.close(fig)
    (out / "provenance.json").write_text(json.dumps({
        "runtime_commit": data["runtime_commit"], "run_id": data["run"]["run_id"],
        "evidence_sha256": hashlib.sha256(evidence.read_bytes()).hexdigest(),
        "historical_csv_sha256": hashlib.sha256(historical_path.read_bytes()).hexdigest(),
        "new_points": [{"ky_rad_per_um": k, "frequency_hz": f*1e9,
            "analytic_n0_hz": reference*1e9, "relative_error_n0_percent":100*(f/reference-1),
            "open_air_1d_basis16_hz":open_air_reference*1e9,
            "relative_error_open_air_1d_percent":100*(f/open_air_reference-1)}],
        "checkpoint_run_id": checkpoint_data["run"]["run_id"],
        "checkpoint_evidence_sha256": hashlib.sha256(checkpoint_path.read_bytes()).hexdigest(),
        "checkpoint_samples": checkpoints,
        "checkpoint_scope": "raw saved samples from failed sweep; not a completed accepted run",
        "analytic_parameters":parameters, "qualification":"NOT VERIFIED",
        "mode_ui_verified":False}, indent=2)+"\n")
    print(out)


if __name__ == "__main__":
    main()
