"""Run a bounded BORIS reciprocal SHE smoke through the embedded NetSocks API.

This script is intended for the versioned BORIS build harness described in the
SHE comparison report.  It keeps the external solver's native quantities and
does not silently convert ``S`` into Fullmag ``mu_s``.
"""

from NetSocks import NSClient


def main() -> None:
    theta_sh = 0.10
    ns = NSClient()
    ns.configure(reset_to_default=True, script_verbose=True)
    conductor = ns.Conductor(
        [0.0, 0.0, 0.0, 1.0e-6, 4.0e-7, 1.0e-9],
        [1.0e-7, 1.0e-7, 1.0e-9],
        "conductor",
    )
    conductor.modules("transport")
    conductor.param.elC = 5.8e7
    conductor.param.De = 0.01
    conductor.param.SHA = theta_sh
    conductor.param.iSHA = theta_sh
    conductor.param.l_sf = 5.0e-9
    conductor.param.Gi = [0.0, 0.0]
    conductor.param.Gmix = [0.0, 0.0]

    ns.setode("LLGStatic-SA", "Euler")
    ns.tsolverconfig(1.0e-8, 2000)
    ns.ssolverconfig(1.0e-8, 2000)
    ns.setcurrentdensity(conductor, 1.0e11, 0.0, 0.0)
    ns.statictransportsolver(1)
    ns.setstages(["Relax", "iter", 1])
    ns.Run()

    probes = {
        "bottom": [5.0e-7, 5.0e-8, 5.0e-10],
        "center": [5.0e-7, 2.0e-7, 5.0e-10],
        "top": [5.0e-7, 3.5e-7, 5.0e-10],
    }
    print("RECIPROCAL_SHA", theta_sh)
    for label, probe in probes.items():
        print(f"{label}_V", conductor.quant.V.getvalue(probe))
        print(f"{label}_S", conductor.quant.S.getvalue(probe))
        print(f"{label}_Jc", conductor.quant.Jc.getvalue(probe))
        print(f"{label}_Jsy", conductor.quant.Jsy.getvalue(probe))
        print(f"{label}_Jsz", conductor.quant.Jsz.getvalue(probe))

    conductor.quant.V.saveovf2("text", "she_reciprocal_V.ovf")
    conductor.quant.S.saveovf2("text", "she_reciprocal_S.ovf")
    conductor.quant.Jc.saveovf2("text", "she_reciprocal_Jc.ovf")
    conductor.quant.Jsy.saveovf2("text", "she_reciprocal_Jsy.ovf")
    conductor.quant.Jsz.saveovf2("text", "she_reciprocal_Jsz.ovf")


if __name__ == "__main__":
    main()
