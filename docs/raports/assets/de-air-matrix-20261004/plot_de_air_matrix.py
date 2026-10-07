from __future__ import annotations

import argparse
import csv
from pathlib import Path
from datetime import datetime, timezone

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


GROWTH_STYLE = {
    "1.3": ("^", "#c2455d"),
    "1.15": ("s", "#168aad"),
    "1.075": ("P", "#7251a1"),
}
K_STYLE = {
    10: ("o", "#2673a8", "+10 rad/µm"),
    25: ("s", "#d47b23", "+25 rad/µm"),
}


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def plot_dispersion(repo_root: Path, output_dir: Path, actual_path: Path | None = None, historical_path: Path | None = None) -> None:
    historic_path = historical_path or (repo_root / "docs/raports/2026-10-04-de-signed15-runtime.csv")
    actual_path = actual_path or (repo_root / "docs/raports/2026-10-04-de-air-matrix-runtime231.csv")
    historic = read_rows(historic_path)
    actual = read_rows(actual_path)

    k_old = [float(row["k_y_rad_per_um"]) for row in historic]
    f_old = [float(row["frequency_hz"]) / 1e9 for row in historic]
    ref_old = [float(row["open_air_1d_basis16_hz"]) / 1e9 for row in historic]

    fig, ax = plt.subplots(figsize=(10.8, 6.2), constrained_layout=False)
    ax.plot(
        k_old,
        ref_old,
        color="#bd8b19",
        linestyle="--",
        linewidth=1.4,
        marker=".",
        markersize=4,
        label="Referencja 1D open-air, basis16 (15 próbek historycznych)",
        zorder=1,
    )
    ax.scatter(
        k_old,
        f_old,
        s=30,
        marker="o",
        color="#65748b",
        alpha=0.82,
        edgecolors="white",
        linewidths=0.35,
        label="FEM historyczne: #228 (k≠0) i Γ #227 (15 punktów)",
        zorder=2,
    )

    fresh_refs: dict[int, float] = {}
    for row in actual:
        k = int(float(row["k_y_rad_per_um"]))
        fresh_refs[k] = float(row["reference_basis32_frequency_hz"]) / 1e9
    ref_x = sorted(fresh_refs)
    ax.scatter(
        ref_x,
        [fresh_refs[k] for k in ref_x],
        s=68,
        marker="D",
        facecolors="white",
        edgecolors="#222222",
        linewidths=1.25,
        label="Świeża referencja open-air basis32 dla #231",
        zorder=4,
    )

    actual_handles = []
    for growth, (marker, color) in GROWTH_STYLE.items():
        group = [row for row in actual if row["actual_air_growth"] == growth]
        ax.scatter(
            [float(row["k_y_rad_per_um"]) for row in group],
            [float(row["frequency_hz"]) / 1e9 for row in group],
            s=91,
            marker=marker,
            color=color,
            edgecolors="white",
            linewidths=0.55,
            zorder=5,
        )
        actual_handles.append(
            Line2D(
                [], [],
                marker=marker,
                linestyle="None",
                markerfacecolor=color,
                markeredgecolor="white",
                markersize=8,
                label=f"Rzeczywisty runtime #231, growth {growth}",
            )
        )

    ax.axvline(0, color="#a7adb5", linewidth=0.8, zorder=0)
    ax.set_xticks(sorted(set(k_old)))
    ax.set_xlabel("Liczba falowa $k_y$ [rad/µm]")
    ax.set_ylabel("Częstotliwość $f$ [GHz]")
    ax.set_title("Damon–Eshbach: punkty signed i sześć wyników runtime #231")
    ax.grid(True, color="#d8dde3", linestyle=":", linewidth=0.7)
    ax.set_xlim(-27, 27)
    ax.set_ylim(8.9, 14.05)
    handles, labels = ax.get_legend_handles_labels()
    handles.extend(actual_handles)
    labels.extend(handle.get_label() for handle in actual_handles)
    fig.legend(
        handles,
        labels,
        loc="lower center",
        bbox_to_anchor=(0.5, 0.045),
        ncol=2,
        frameon=False,
        fontsize=8.2,
    )
    fig.text(
        0.5,
        0.012,
        "Linia łączy zapisane próbki referencji 1D; punkty FEM nie są interpolowane. "
        "Przy Γ referencja ma inne założenia brzegowe.",
        ha="center",
        va="bottom",
        fontsize=8,
        color="#4b5563",
    )
    fig.tight_layout(rect=(0.02, 0.13, 0.99, 0.94))
    fig.savefig(output_dir / "de-dispersion-runtime231.png", dpi=240, facecolor="white")
    fixed_date = datetime(2026, 10, 4, tzinfo=timezone.utc)
    fig.savefig(output_dir / "de-dispersion-runtime231.pdf", facecolor="white", metadata={"Creator": "plot_de_air_matrix.py", "CreationDate": fixed_date, "ModDate": fixed_date})
    plt.close(fig)


def plot_refinement(repo_root: Path, output_dir: Path, actual_path: Path | None = None) -> None:
    actual_path = actual_path or (repo_root / "docs/raports/2026-10-04-de-air-matrix-runtime231.csv")
    actual = read_rows(actual_path)
    growth_order = ["1.3", "1.15", "1.075"]
    nodes_by_growth = {
        growth: int(next(row["nodes"] for row in actual if row["actual_air_growth"] == growth))
        for growth in growth_order
    }
    tets_by_growth = {
        growth: int(next(row["tetrahedra"] for row in actual if row["actual_air_growth"] == growth))
        for growth in growth_order
    }

    x_by_growth = {growth: index for index, growth in enumerate(growth_order)}
    fig, ax = plt.subplots(figsize=(8.8, 5.8), constrained_layout=False)
    for k, (marker, color, label) in K_STYLE.items():
        group = [row for row in actual if int(float(row["k_y_rad_per_um"])) == k]
        for row in group:
            growth = row["actual_air_growth"]
            x = x_by_growth[growth]
            error = float(row["relative_difference_from_basis32_percent"])
            ax.scatter(
                x,
                error,
                s=76,
                marker=marker,
                color=color,
                edgecolors="white",
                linewidths=0.65,
                zorder=3,
            )
            ax.annotate(
                f"{error:.3f}%",
                (x, error),
                xytext=(0, 7 if k == 10 else -15),
                textcoords="offset points",
                ha="center",
                fontsize=8,
                color=color,
            )
        ax.scatter([], [], marker=marker, color=color, s=64, label=label)

    ax.axhline(0, color="#5b6470", linewidth=1.0, zorder=1)
    growth_labels = {"1.3": "1,30", "1.15": "1,15", "1.075": "1,075"}
    ax.set_xticks(
        list(range(len(growth_order))),
        [
            f"{growth_labels[growth]}\n{nodes_by_growth[growth]:,} węzłów\n"
            f"{tets_by_growth[growth]:,} tet".replace(",", " ")
            for growth in growth_order
        ],
    )
    ax.set_xlabel("Rzeczywisty wzrost warstw powietrza i rozmiar siatki")
    ax.set_ylabel("$(f_{FEM}-f_{1D,32})/f_{1D,32}$ [%]")
    ax.set_title("Izolowane zagęszczenie powietrza przy +10 i +25 rad/µm")
    ax.grid(True, axis="y", color="#d8dde3", linestyle=":", linewidth=0.7)
    ax.set_xlim(-0.35, len(growth_order) - 0.65)
    ax.set_ylim(-0.7, 0.03)
    ax.legend(frameon=False, loc="lower right")
    fig.text(
        0.5,
        0.025,
        "Sześć punktów z runtime #231; bez łączenia wyników FEM. "
        "Referencja basis32 jest diagnostyczną 1D referencją open-air, nie granicą błędu.",
        ha="center",
        va="bottom",
        fontsize=8,
        color="#4b5563",
    )
    fig.tight_layout(rect=(0.05, 0.11, 0.98, 0.94))
    fig.savefig(output_dir / "de-air-refinement-runtime231.png", dpi=240, facecolor="white")
    fixed_date = datetime(2026, 10, 4, tzinfo=timezone.utc)
    fig.savefig(output_dir / "de-air-refinement-runtime231.pdf", facecolor="white", metadata={"Creator": "plot_de_air_matrix.py", "CreationDate": fixed_date, "ModDate": fixed_date})
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description="Recreate the DE runtime #231 dispersion figures.")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[4],
        help="Fullmag checkout root (defaults to the repository containing this recipe).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Directory for PNG and PDF files.",
    )
    parser.add_argument("--actual-csv", type=Path, default=None, help="Runtime #231 six-row CSV.")
    parser.add_argument("--historical-csv", type=Path, default=None, help="Historical runtime #227/#228 signed15 CSV.")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 9,
            "axes.titlesize": 12,
            "axes.labelsize": 10,
            "legend.fontsize": 8,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
        }
    )
    plot_dispersion(args.repo_root, args.output_dir, args.actual_csv, args.historical_csv)
    plot_refinement(args.repo_root, args.output_dir, args.actual_csv)


if __name__ == "__main__":
    main()
