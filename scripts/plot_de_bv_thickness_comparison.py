"""Plot bound fixed-k thickness pilots; this is not a dispersion curve."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from collect_de_bv_thickness_comparison import collect_record, collect_batch


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_comparison(comparison):
    if (comparison.get("schema")!="fullmag.de-bv.thickness-comparison.v1" or
            comparison.get("qualification")!="NOT VERIFIED"):
        raise ValueError("unsupported thickness comparison")
    records=comparison["records"]
    collect_batch(records)
    for record in records:
        actual=collect_record(record["run_path"],record["thickness_layers"],record["job"])
        if actual!=record:
            raise ValueError("comparison record differs from current certified artifacts")
    return records


def build_figure(records):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig,axes=plt.subplots(2,2,figsize=(10,7),sharex="col")
    for column,(geometry,label) in enumerate((("damon_eshbach","DE"),("backward_volume","BV"))):
        rows=sorted((r for r in records if r["geometry"]==geometry),key=lambda r:r["thickness_layers"])
        x=[r["thickness_layers"] for r in rows]
        axes[0,column].plot(x,[r["frequency_hz"]/1e9 for r in rows],"o-",label="FEM, demag")
        axes[0,column].axhline(rows[0]["analytic_frequency_hz"]/1e9,color="darkorange",linestyle="--",label="Analityka n=0")
        axes[0,column].set(title=label,ylabel="f [GHz]")
        axes[1,column].plot(x,[r["difference_percent"] for r in rows],"o-")
        axes[1,column].axhline(0,color="darkorange",linestyle="--")
        axes[1,column].set(xlabel="Liczba warstw filmu",ylabel="Roznica wzgledem n=0 [%]",xticks=x)
        axes[0,column].legend()
        for ax in axes[:,column]:ax.grid(alpha=.25)
    first=records[0]
    fig.suptitle(f"Stale k={first['k_rad_per_m']/1e6:g} rad/um, film {first['parameters']['film_thickness_m']*1e9:g} nm\nKontrola warstw; NOT VERIFIED")
    fig.text(.5,.015,"Referencja: otwarty film, przyblizenie n=0. Brak ekstrapolacji i kwalifikacji zbieznosci.",ha="center",fontsize=9)
    fig.tight_layout(rect=(0,.04,1,.92))
    return fig


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("comparison",type=Path)
    parser.add_argument("output",type=Path,help="new output directory")
    args=parser.parse_args(argv)
    raw=args.comparison.read_bytes()
    records=validate_comparison(json.loads(raw))
    fig=build_figure(records)
    import matplotlib.pyplot as plt
    try:
        args.output.mkdir(parents=True,exist_ok=False)
        png,pdf=args.output/"thickness-comparison.png",args.output/"thickness-comparison.pdf"
        fig.savefig(png,dpi=180);fig.savefig(pdf)
    finally:
        plt.close(fig)
    receipt={"schema":"fullmag.de-bv.thickness-plot.v1","qualification":"NOT VERIFIED",
             "scope":"fixed-k thickness diagnostic; not f(k)",
             "comparison_sha256":hashlib.sha256(raw).hexdigest(),"producer_sha256":digest(Path(__file__)),
             "records":records,"output_sha256":{png.name:digest(png),pdf.name:digest(pdf)}}
    (args.output/"plot-receipt.json").write_text(json.dumps(receipt,indent=2)+"\n",encoding="utf-8")
    print(args.output)
    return 0


if __name__=="__main__":
    raise SystemExit(main())
