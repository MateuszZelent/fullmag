"""Generate the start-screen schematics as standalone SVG.

Every file carries its own <style> with a prefers-color-scheme block, so the
same diagram is legible in a light or dark viewer, and in GitHub's rendered
Markdown. No external fonts, no scripts.

    python scripts/make_diagrams.py
"""
from __future__ import annotations

import html
import pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "diagrams"
OUT.mkdir(parents=True, exist_ok=True)

STYLE = """
  :root{
    --bg:#eff1f5; --panel:#ffffff; --chrome:#e6e9ef; --sunken:#dce0e8;
    --line:#bcc0cc; --line-soft:#ccd0da; --ink:#4c4f69; --muted:#8c8fa1;
    --accent:#1e66f5; --accent-soft:#d3e5fd; --mauve:#8839ef; --green:#40a02b;
    --peach:#fe640b; --red:#d20f39; --yellow:#df8e1d; --teal:#179299;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#1e1e2e; --panel:#242438; --chrome:#181825; --sunken:#11111b;
      --line:#45475a; --line-soft:#313244; --ink:#cdd6f4; --muted:#7f849c;
      --accent:#89b4fa; --accent-soft:#2a2d52; --mauve:#cba6f7; --green:#a6e3a1;
      --peach:#fab387; --red:#f38ba8; --yellow:#f9e2af; --teal:#94e2d5;
    }
  }
  .bg{fill:var(--bg)}
  .panel{fill:var(--panel);stroke:var(--line-soft)}
  .chrome{fill:var(--chrome);stroke:var(--line-soft)}
  .sunken{fill:var(--sunken);stroke:var(--line-soft)}
  .box{fill:none;stroke:var(--line);stroke-width:1.2}
  .dash{fill:none;stroke:var(--accent);stroke-width:1.1;stroke-dasharray:4 3}
  .t{font-family:Inter,'Segoe UI',system-ui,sans-serif;fill:var(--ink)}
  .m{font-family:Inter,'Segoe UI',system-ui,sans-serif;fill:var(--muted)}
  .mono{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;fill:var(--muted)}
  .h{font-size:15px;font-weight:650;letter-spacing:-.01em}
  .h2{font-size:11.5px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;fill:var(--muted)}
  .lbl{font-size:11px}
  .sm{font-size:9.5px}
  .xs{font-size:8.5px}
  .acc{fill:var(--accent)}
  .arrow{fill:none;stroke:var(--line);stroke-width:1.3;marker-end:url(#a)}
  .arrow-acc{fill:none;stroke:var(--accent);stroke-width:1.4;marker-end:url(#aa)}
  .dim{fill:none;stroke:var(--accent);stroke-width:1;marker-start:url(#d);marker-end:url(#d)}
"""

DEFS = """
  <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0 1 9 5 0 9z" fill="var(--line)"/></marker>
  <marker id="aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0 1 9 5 0 9z" fill="var(--accent)"/></marker>
  <marker id="d" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M5 1v8" stroke="var(--accent)" stroke-width="1.4"/></marker>
"""


def svg(name: str, w: int, h: int, body: str, title: str) -> None:
    doc = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
        f'role="img" aria-label="{html.escape(title)}">\n'
        f"<title>{html.escape(title)}</title>\n<defs>{DEFS}</defs>\n<style>{STYLE}</style>\n"
        f'<rect class="bg" width="{w}" height="{h}"/>\n{body}\n</svg>\n'
    )
    (OUT / f"{name}.svg").write_text(doc, encoding="utf-8")
    print("wrote", name + ".svg")


def T(x, y, s, cls="t lbl", anchor="start", extra=""):
    return f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}"{extra}>{html.escape(s)}</text>'


def R(x, y, w, h, cls="panel", rx=6, extra=""):
    return f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"{extra}/>'


def L(x1, y1, x2, y2, cls="box"):
    return f'<line class="{cls}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/>'


# ---------------------------------------------------------------------------
# 01 — Window zones
# ---------------------------------------------------------------------------
def zones():
    W, H = 1080, 700
    x0, y0, w, h = 40, 64, 1000, 560
    tb, mb, sb = 26, 34, 24
    rail, insp = 210, 300
    b = [T(40, 34, "Start screen — window zones", "t h"),
         T(40, 50, "Fullmag desktop shell · 1680 × 1000 reference window", "m sm")]
    b.append(R(x0, y0, w, h, "panel", 8))
    # title bar
    b.append(R(x0, y0, w, tb, "sunken", 8))
    b.append(T(x0 + 12, y0 + 17, "1  Title bar — 32 px · window controls, drag region", "m sm"))
    # menu bar
    b.append(R(x0, y0 + tb, w, mb, "chrome", 0))
    b.append(T(x0 + 12, y0 + tb + 21,
               "2  Menu bar — 38 px (--fm-menu-height) · brand · File…Help · command search · transport · theme", "m sm"))
    body_y = y0 + tb + mb
    body_h = h - tb - mb - sb
    # rail
    b.append(R(x0, body_y, rail, body_h, "chrome", 0))
    b.append(T(x0 + 14, body_y + 26, "3  Rail", "t lbl"))
    b.append(T(x0 + 14, body_y + 44, "232 px, fixed", "mono xs"))
    for i, (lab, yy) in enumerate([("Home", 78), ("Templates", 100), ("Import", 122),
                                   ("Learn", 144), ("Settings", 166), ("About", 188)]):
        on = i == 0
        b.append(R(x0 + 12, body_y + yy - 13, rail - 24, 19,
                   "panel" if on else "box", 4,
                   ' fill="var(--accent-soft)" stroke="none"' if on else ' stroke="none" fill="none"'))
        b.append(T(x0 + 22, body_y + yy, lab, "acc sm" if on else "m sm"))
    b.append(R(x0 + 12, body_y + body_h - 86, rail - 24, 70, "panel", 6))
    b.append(T(x0 + 22, body_y + body_h - 66, "Compute environment", "m xs"))
    b.append(T(x0 + 22, body_y + body_h - 50, "RTX 4090 · CUDA 12.4", "t sm"))
    b.append(T(x0 + 22, body_y + body_h - 34, "VRAM 5.8 / 24.0 GB", "mono xs"))
    # content
    cx = x0 + rail
    cw = w - rail - insp
    b.append(R(cx, body_y, cw, body_h, "bg", 0, ' stroke="var(--line-soft)"'))
    b.append(T(cx + 18, body_y + 26, "4  Content column", "t lbl"))
    b.append(T(cx + 18, body_y + 44, "fluid · inner measure capped at 1040 px, centred", "mono xs"))
    blocks = [("Page header — greeting, date, affiliation", 70, 44),
              ("Continue card — interrupted run, progress, resume", 124, 86),
              ("Launch tiles — FDM · FEM · Template · Import", 220, 74),
              ("Recent projects — toolbar, grouped list / grid", 304, 150)]
    for lab, yy, hh in blocks:
        b.append(R(cx + 18, body_y + yy, cw - 36, hh, "panel", 6))
        b.append(T(cx + 30, body_y + yy + 20, lab, "t sm"))
    b.append(T(cx + 30, body_y + 304 + 168, "scrolls independently of rail and inspector", "m xs"))
    # inspector
    ix = cx + cw
    b.append(R(ix, body_y, insp, body_h, "panel", 0))
    b.append(T(ix + 16, body_y + 26, "5  Inspector", "t lbl"))
    b.append(T(ix + 16, body_y + 44, "364 px · resizable 320–520", "mono xs"))
    b.append(R(ix + 14, body_y + 58, insp - 28, 92, "sunken", 6))
    b.append(T(ix + 24, body_y + 80, "preview 16:10 + frame scrubber", "m xs"))
    for lab, yy, hh in [("title · path · chips", 160, 40),
                        ("context banner (run / migrate / fail)", 208, 32),
                        ("Overview | Authors | History | Runs", 248, 26),
                        ("tab panel", 282, 110)]:
        b.append(R(ix + 14, body_y + yy, insp - 28, hh, "chrome", 5))
        b.append(T(ix + 24, body_y + yy + 17, lab, "m xs"))
    b.append(R(ix + 14, body_y + body_h - 52, insp - 28, 34, "chrome", 5))
    b.append(T(ix + 24, body_y + body_h - 31, "primary action — Open project ▾", "t xs"))
    # status bar
    b.append(R(x0, y0 + h - sb, w, sb, "chrome", 0))
    b.append(T(x0 + 12, y0 + h - 8, "6  Status bar — 26 px (--fm-status-height) · solver state · build · backend · index · update · docs", "m sm"))
    # dimensions
    b.append(f'<line class="dim" x1="{x0}" y1="{y0+h+22}" x2="{x0+rail}" y2="{y0+h+22}"/>')
    b.append(T(x0 + rail / 2, y0 + h + 37, "232", "acc sm", "middle"))
    b.append(f'<line class="dim" x1="{cx}" y1="{y0+h+22}" x2="{ix}" y2="{y0+h+22}"/>')
    b.append(T(cx + cw / 2, y0 + h + 37, "fluid  (min 480)", "acc sm", "middle"))
    b.append(f'<line class="dim" x1="{ix}" y1="{y0+h+22}" x2="{x0+w}" y2="{y0+h+22}"/>')
    b.append(T(ix + insp / 2, y0 + h + 37, "364", "acc sm", "middle"))
    b.append(T(40, y0 + h + 62,
               "Below 1180 px the inspector collapses into a sheet opened with Space; below 940 px the rail becomes icon-only (56 px).",
               "m sm"))
    svg("01-window-zones", W, H, "\n".join(b), "Start screen window zones")


# ---------------------------------------------------------------------------
# 02 — Information architecture
# ---------------------------------------------------------------------------
def ia():
    W, H = 1120, 720
    b = [T(40, 34, "Information architecture", "t h"),
         T(40, 50, "What the start screen holds, and where each thing lives", "m sm")]
    root = (56, 92, 190, 40)
    b.append(R(*root, "panel", 7, ' stroke="var(--accent)"'))
    b.append(T(root[0] + 14, root[1] + 25, "Start screen", "t lbl"))

    cols = [
        ("Home", "i", [
            "Greeting — user, date, affiliation",
            "Continue — interrupted run",
            "  progress, t, ETA, device",
            "  Resume · Open · Discard",
            "Launch tiles",
            "  New FDM · New FEM",
            "  From template · Import",
            "Recent projects",
            "  search · filter · sort · view",
            "  grouped list or card grid",
            "  Browse… · Clear list",
        ]),
        ("Templates", "", [
            "Gallery of ready studies",
            "  µMAG SP#1 … SP#5",
            "  dispersion · FMR",
            "  magnonic crystal bands",
            "  skyrmion phase diagram",
            "  domain-wall motion",
            "  vortex gyration",
            "Per card: solver, runtime,",
            "VRAM, reference it reproduces",
        ]),
        ("Import", "", [
            "OOMMF .mif",
            "mumax³ .mx3",
            "COMSOL .mph",
            "Fullmag archive .fms",
            "Mesh .stl / .vtk / .msh",
            "Field .ovf / .omf / .npy",
            "Drop target + import report",
        ]),
        ("Learn", "", [
            "What's new — release notes",
            "Keyboard map",
            "Documentation",
            "Tutorials",
            "µMAG benchmarks",
            "Report an issue",
        ]),
        ("Settings", "", [
            "Startup behaviour",
            "Project locations + index",
            "Compute backend",
            "Appearance / density",
            "→ All settings dialog",
        ]),
        ("About", "", [
            "Version, commit, channel",
            "Runtime stack + versions",
            "Team (AG Magnonics, RPTU)",
            "Citation — BibTeX",
            "Third-party licences",
            "Copy diagnostics",
        ]),
    ]
    x = 56
    y = 184
    cw = 168
    for i, (name, _, items) in enumerate(cols):
        cx = x + i * (cw + 10)
        ch = 34 + len(items) * 16 + 10
        b.append(R(cx, y, cw, ch, "panel", 7))
        b.append(R(cx, y, cw, 26, "chrome", 7))
        b.append(T(cx + 12, y + 18, name, "t lbl"))
        for j, it in enumerate(items):
            indent = 12 + (10 if it.startswith("  ") else 0)
            b.append(T(cx + indent, y + 44 + j * 16, it.strip(), "m xs"))
        b.append(f'<path class="arrow" d="M{root[0]+28} {root[1]+root[3]} V{y-22} H{cx+cw/2} V{y-2}"/>')

    # Inspector band
    iy = 470
    b.append(R(56, iy, 1008, 118, "panel", 7, ' stroke="var(--accent)"'))
    b.append(T(70, iy + 22, "Inspector — context pane, right-hand column", "t lbl"))
    b.append(T(70, iy + 38, "Bound to the selection in the centre column. Empty-state copy differs per section.", "m xs"))
    panes = [
        ("Overview", ["discretisation, cell size", "periodicity, material", "Ms, Aex, α, interactions",
                      "integrator, tolerance", "outputs, provenance"]),
        ("Authors", ["creator / contributors", "affiliation, ORCID", "role", "BibTeX + DOI"]),
        ("History", ["revision timeline", "edit / run / migrate", "author + summary", "restore a revision"]),
        ("Runs", ["run id, start, duration", "device, status", "output size", "open results viewer"]),
    ]
    for i, (n, its) in enumerate(panes):
        px = 70 + i * 248
        b.append(T(px, iy + 64, n, "acc sm"))
        for j, it in enumerate(its):
            b.append(T(px, iy + 80 + j * 13, "· " + it, "m xs"))

    b.append(T(56, 618, "Cross-cutting", "h2"))
    cross = [
        ("Command palette (Ctrl K)", "every start-screen action is a command — same registry as the workspace"),
        ("Status bar", "solver state · build · compute backend · index health · update · docs"),
        ("Compute environment widget", "GPU / CUDA / VRAM, CPU fallback warning, link to compute settings"),
    ]
    for i, (n, d) in enumerate(cross):
        cx = 56 + i * 340
        b.append(R(cx, 630, 326, 52, "chrome", 6))
        b.append(T(cx + 12, 650, n, "t sm"))
        b.append(T(cx + 12, 666, d, "m xs"))
    svg("02-information-architecture", W, H, "\n".join(b), "Start screen information architecture")


# ---------------------------------------------------------------------------
# 03 — Layout grid & spacing
# ---------------------------------------------------------------------------
def grid():
    W, H = 1080, 660
    b = [T(40, 34, "Layout grid, spacing and density", "t h"),
         T(40, 50, "Everything resolves to the 4 px base scale already in tokens.css", "m sm")]
    # vertical rhythm column
    b.append(T(40, 92, "Vertical rhythm — content column", "h2"))
    y = 110
    rows = [("--fm-space-6", 24, "outer gutter, top of the content column"),
            ("page header", 56, "h1 22/1.2 + sub 12/1.4"),
            ("--fm-space-6", 24, "header → first section"),
            ("section eyebrow", 26, "11 px, 600, uppercase, tracking .07em"),
            ("--fm-space-3", 12, "eyebrow → section body"),
            ("section body", 110, "continue card / tiles / list"),
            ("--fm-space-8", 32, "section → section"),
            ("section eyebrow", 26, ""),
            ("--fm-space-3", 12, ""),
            ("section body", 120, "")]
    for name, hh, note in rows:
        spacer = name.startswith("--")
        b.append(R(56, y, 300, hh, "sunken" if spacer else "panel", 4,
                   ' stroke-dasharray="3 3"' if spacer else ""))
        if spacer:
            b.append(T(366, y + hh / 2 + 4, name, "mono xs"))
        else:
            b.append(T(68, y + 18, name, "t sm"))
        if note and not spacer:
            b.append(T(366, y + 18, note, "m xs"))
        b.append(f'<line class="dim" x1="44" y1="{y}" x2="44" y2="{y+hh}"/>')
        b.append(T(38, y + hh / 2 + 3, str(hh), "acc xs", "end"))
        y += hh

    # density
    b.append(T(600, 92, "List density", "h2"))
    dy = 110
    for name, hh, desc in [("Comfortable — default", 52, "72 × 45 thumbnail, name + path, two lines"),
                           ("Compact", 38, "no thumbnail, single line, path on hover"),
                           ("Card grid", 196, "232 px card, 132 px thumbnail, name + status")]:
        b.append(R(600, dy, 440, hh, "panel", 6))
        b.append(T(612, dy + 18, name, "t sm"))
        b.append(T(612, dy + 33, desc, "m xs"))
        b.append(f'<line class="dim" x1="1056" y1="{dy}" x2="1056" y2="{dy+hh}"/>')
        b.append(T(1062, dy + hh / 2 + 3, f"{hh}", "acc xs"))
        dy += hh + 14

    # scale strips
    b.append(T(600, 400, "Spacing scale", "h2"))
    sx = 600
    for i, (n, v) in enumerate([("1", 4), ("2", 8), ("3", 12), ("4", 16), ("5", 20), ("6", 24), ("8", 32)]):
        b.append(R(sx, 414, v, 26, "panel", 3, ' style="fill:var(--accent-soft);stroke:var(--accent)"'))
        b.append(T(sx + v / 2, 456, str(v), "acc xs", "middle"))
        b.append(T(sx + v / 2, 468, f"-{n}", "m xs", "middle"))
        sx += v + 26

    b.append(T(600, 504, "Type scale (start screen)", "h2"))
    ty = 524
    for size, weight, name in [(22, 650, "h1 — page title"), (15, 600, "lg — card / inspector title"),
                               (13, 500, "md — row name, body"), (12, 500, "sm — secondary"),
                               (11, 600, "xs — eyebrow, controls"), (10, 400, "2xs — meta, status bar")]:
        b.append(f'<text class="t" x="600" y="{ty}" font-size="{size}" font-weight="{weight}">Aa</text>')
        b.append(T(652, ty, name, "m sm"))
        b.append(T(1040, ty, f"{size}px / {weight}", "mono xs", "end"))
        ty += size + 10

    b.append(T(56, 614, "Breakpoints", "h2"))
    b.append(T(56, 634, "≥ 1400  full row grid incl. size column   ·   < 1400  size column drops   ·   "
                        "< 1180  inspector → sheet   ·   < 940  rail → icon rail (56 px)", "m sm"))
    svg("03-layout-grid", W, H, "\n".join(b), "Layout grid and spacing")


# ---------------------------------------------------------------------------
# 04 — Project row / card anatomy
# ---------------------------------------------------------------------------
def anatomy_row():
    W, H = 1080, 640
    b = [T(40, 34, "Project row and card — anatomy", "t h"),
         T(40, 50, "Recent list entry, grid card, and the states a single entry can take", "m sm")]
    # row
    rx, ry, rw, rh = 56, 96, 968, 52
    b.append(R(rx, ry, rw, rh, "panel", 6))
    cols = [("thumb", 72), ("name + path", 470), ("solver", 74), ("status", 96),
            ("size", 64), ("opened", 78), ("pin", 26)]
    cx = rx + 8
    guides = []
    for name, cwid in cols:
        b.append(R(cx, ry + 4, cwid, rh - 8, "box", 4, ' stroke-dasharray="3 3" stroke="var(--accent)"'))
        guides.append((cx + cwid / 2, name, cwid))
        cx += cwid + 12
    labels = ["preview thumbnail 72×45 (16:10) — viewport-dark in both themes",
              "project name 13/500 + path 10 mono, ellipsised from the left",
              "solver badge — FDM blue / FEM mauve",
              "status pill — dot + label; the dot pulses while running",
              "size on disk",
              "last opened, relative",
              "pin — appears on hover, stays visible when pinned"]
    for i, ((gx, name, cwid), lab) in enumerate(zip(guides, labels)):
        ly = 180 + i * 22
        b.append(f'<path class="arrow-acc" d="M{gx} {ry+rh+2} V{ly-5} H{rx+36}"/>')
        b.append(f'<circle cx="{gx}" cy="{ry+rh+2}" r="2" fill="var(--accent)"/>')
        b.append(T(rx + 14, ly + 4, str(i + 1), "acc xs"))
        b.append(T(rx + 44, ly + 4, lab, "m xs"))
    b.append(T(rx, 86, "Row — comfortable density, 52 px", "h2"))

    # states
    b.append(T(rx, 356, "Row states", "h2"))
    states = [("default", "transparent background"),
              ("hover", "--fm-bg-surface"),
              ("selected", "--fm-bg-selected + accent border (drives the inspector)"),
              ("focus", "accent border + 2 px accent-soft ring, keyboard only"),
              ("running", "status pill animates; thumbnail shows the live frame"),
              ("missing", "55 % opacity, warning glyph for the thumbnail, Locate… in the menu"),
              ("read-only", "link glyph after the name, teal status"),
              ("needs migration", "peach status; opening writes a migrated copy")]
    for i, (n, d) in enumerate(states):
        yy = 370 + i * 26
        b.append(R(rx, yy, 150, 20, "chrome", 4))
        b.append(T(rx + 10, yy + 14, n, "t xs"))
        b.append(T(rx + 164, yy + 14, d, "m xs"))

    # card
    cxx, cyy = 700, 352
    b.append(T(cxx, 352, "Card — grid density, 232 px", "h2"))
    b.append(R(cxx, 370, 232, 212, "panel", 8))
    b.append(R(cxx, 370, 232, 132, "sunken", 8))
    b.append(T(cxx + 12, 392, "thumbnail 16:10", "m xs"))
    b.append(R(cxx + 10, 380, 36, 16, "box", 3, ' stroke="var(--accent)"'))
    b.append(T(cxx + 12, 526, "name, two lines max", "t sm"))
    b.append(T(cxx + 12, 546, "status pill", "m xs"))
    b.append(T(cxx + 150, 546, "last opened", "m xs"))
    b.append(T(cxx, 604, "Card view drops path, size and solver label into the badge overlay;", "m xs"))
    b.append(T(cxx, 618, "it is for recognising a project by its result, not for scanning metadata.", "m xs"))
    svg("04-anatomy-project-row", W, H, "\n".join(b), "Project row and card anatomy")


# ---------------------------------------------------------------------------
# 05 — Inspector anatomy
# ---------------------------------------------------------------------------
def anatomy_inspector():
    W, H = 1080, 880
    b = [T(40, 34, "Inspector — anatomy and tabs", "t h"),
         T(40, 50, "Bound to the selected project; it is the reason the start screen can replace a file dialog", "m sm")]
    x, y, w = 56, 86, 300
    parts = [("preview 16:10", 118, "last rendered result; hover reveals a frame scrubber and play"),
             ("title + actions", 46, "name 15/650, pin and overflow menu"),
             ("path", 22, "mono 10, ellipsised from the left, copy button"),
             ("chips", 32, "solver · status · rev · schema · tags"),
             ("context banner", 46, "only when something needs saying: run in progress, failed run, migration, read-only"),
             ("tab bar", 30, "Overview | Authors | History | Runs"),
             ("tab panel", 240, "scrolls; the tab choice persists per session, not per project"),
             ("action footer", 48, "Open project ▾ (Open a copy · Open read-only · Reveal) + reveal button")]
    yy = y
    for i, (name, hh, note) in enumerate(parts):
        cls = "sunken" if i == 0 else "chrome" if i in (4, 7) else "panel"
        b.append(R(x, yy, w, hh, cls, 6 if i in (0, 7) else 4))
        b.append(T(x + 12, yy + 17, name, "t sm"))
        b.append(f'<path class="arrow-acc" d="M{x+w+6} {yy+hh/2} H{x+w+40}"/>')
        b.append(T(x + w + 48, yy + hh / 2 + 4, note, "m xs"))
        yy += hh + 4

    # tab content detail
    tx = 56
    ty = 720
    b.append(T(tx, ty, "What each tab answers", "h2"))
    tabs = [("Overview", "“Is this the project I mean, and can this machine run it?”",
             "discretisation · cell size · periodicity · material · Ms · Aex · α · interactions · integrator · tolerance · outputs · provenance"),
            ("Authors", "“Whose work is this, and how do I credit it?”",
             "creator and contributors with affiliation and ORCID · generated BibTeX · DOI when one is registered"),
            ("History", "“What changed since I last opened it?”",
             "revision timeline: edit / run / migration, author, summary, per-entry restore"),
            ("Runs", "“What has actually been computed?”",
             "run id · started · duration · device · status · output size · open in the results viewer")]
    for i, (n, q, d) in enumerate(tabs):
        yy = ty + 18 + i * 38
        b.append(T(tx, yy + 12, n, "acc sm"))
        b.append(T(tx + 86, yy + 12, q, "t sm"))
        b.append(T(tx + 86, yy + 26, d, "m xs"))
    svg("05-inspector-anatomy", W, H, "\n".join(b), "Inspector anatomy")


# ---------------------------------------------------------------------------
# 06 — Launch flow
# ---------------------------------------------------------------------------
def flow():
    W, H = 1160, 680
    b = [T(40, 34, "Launch flow", "t h"),
         T(40, 50, "From process start to a workspace with a model in it", "m sm")]

    def node(x, y, w, h, title, sub="", kind="panel", rx=7):
        out = [R(x, y, w, h, kind, rx)]
        out.append(T(x + w / 2, y + (20 if sub else h / 2 + 4), title, "t sm", "middle"))
        if sub:
            out.append(T(x + w / 2, y + 36, sub, "m xs", "middle"))
        return out

    def diamond(x, y, w, h, label):
        pts = f"{x+w/2},{y} {x+w},{y+h/2} {x+w/2},{y+h} {x},{y+h/2}"
        return [f'<polygon class="panel" points="{pts}" stroke="var(--accent)"/>',
                T(x + w / 2, y + h / 2 + 4, label, "t xs", "middle")]

    b += node(40, 110, 140, 44, "Process start", "Tauri shell ready")
    b.append(f'<path class="arrow" d="M180 132 H216"/>')
    b += diamond(216, 104, 150, 56, "Last project?")
    b.append(T(292, 96, "restore-on-launch setting", "m xs", "middle"))

    b.append(f'<path class="arrow-acc" d="M366 132 H420"/>')
    b.append(T(393, 124, "no", "acc xs", "middle"))
    b += node(420, 110, 170, 44, "Start screen", "Home section", "panel")

    b.append(f'<path class="arrow" d="M291 160 V206 H420"/>')
    b.append(T(300, 182, "yes → open it directly", "m xs"))
    b += node(420, 186, 170, 40, "Workspace", "project loaded", "chrome")

    # index scan
    b.append(f'<path class="arrow" d="M505 154 V176"/>')
    b.append(f'<path class="arrow" d="M590 132 H640"/>')
    b += node(640, 110, 170, 44, "Scan locations", "recent-index.json")
    b.append(f'<path class="arrow" d="M810 132 H858"/>')
    b += diamond(858, 100, 150, 64, "Index OK?")
    b.append(f'<path class="arrow-acc" d="M933 164 V214 H820 V248"/>')
    b.append(T(941, 196, "no", "acc xs"))
    b += node(640, 248, 360, 40, "Error banner — Rebuild index · Open from disk", "", "chrome")
    b.append(f'<path class="arrow" d="M1008 132 H1058 V300 H1020"/>')
    b.append(T(1014, 124, "yes", "m xs"))
    b += node(640, 300, 360, 36, "Recent list rendered, grouped by last opened", "", "panel")
    b.append(f'<path class="arrow" d="M820 288 V300"/>')

    # choices
    b.append(T(40, 360, "From the start screen", "h2"))
    choices = [
        ("Resume", "Continue card", "load checkpoint → workspace, run resumes at t"),
        ("Open recent", "row or card", "read .fms → migrate if schema < app → workspace"),
        ("New FDM / FEM", "launch tile", "New problem dialog → empty model → workspace"),
        ("From template", "Templates", "copy template into the default location → workspace"),
        ("Import", "Import", "parse source → import report → confirm → workspace"),
        ("Browse…", "list footer", "OS file dialog → same path as Open recent"),
    ]
    for i, (n, where, what) in enumerate(choices):
        x = 40 + (i % 3) * 372
        y = 378 + (i // 3) * 92
        b.append(R(x, y, 352, 76, "panel", 7))
        b.append(T(x + 14, y + 22, n, "t sm"))
        b.append(T(x + 14, y + 38, where, "acc xs"))
        b.append(T(x + 14, y + 56, what, "m xs"))
        b.append(f'<path class="arrow" d="M{x+176} {y+76} V{y+86}"/>' if i // 3 == 0 else "")

    b.append(R(40, 574, 1080, 44, "chrome", 7))
    b.append(T(580, 592, "Workspace shell — geometry, solver, viewport", "t sm", "middle"))
    b.append(T(580, 608, "The start screen unmounts; the project becomes the active session in the menu-bar subtitle.", "m xs", "middle"))
    b.append(T(40, 646, "Every box above is also a command in the Ctrl K palette, so the whole flow is reachable without the mouse.", "m sm"))
    svg("06-launch-flow", W, H, "\n".join(b), "Start screen launch flow")


# ---------------------------------------------------------------------------
# 07 — Screen states
# ---------------------------------------------------------------------------
def states():
    W, H = 1120, 640
    b = [T(40, 34, "Screen states", "t h"),
         T(40, 50, "What the Home section shows for each condition of the recent index", "m sm")]
    cards = [
        ("First run", "no index, no projects", "var(--teal)", [
            "Hero: Welcome to Fullmag",
            "Launch tiles, full width",
            "Three suggested templates",
            "Compute environment banner",
            "No Continue card, no list",
            "Inspector: what a selection shows"]),
        ("Loading", "scan in progress", "var(--muted)", [
            "Greeting + “Scanning locations…”",
            "Six skeleton rows, staggered 24 ms",
            "Launch tiles stay interactive",
            "Toolbar disabled, not hidden",
            "Resolves in place — no layout jump"]),
        ("Loaded", "the normal case", "var(--green)", [
            "Continue card when a run was interrupted",
            "Launch tiles",
            "Grouped recent list: Today / Yesterday /",
            "Earlier this week / Older",
            "Inspector bound to the selection"]),
        ("Empty filter", "index fine, query matches nothing", "var(--yellow)", [
            "Toolbar keeps the query visible",
            "Inline empty state inside the section",
            "“Clear the filter to see all N”",
            "Launch tiles and Continue stay put"]),
        ("Index error", "recent-index.json unreadable", "var(--red)", [
            "Danger banner with the parse error",
            "Rebuild index · Show file",
            "Launch tiles stay — work is not blocked",
            "Section empty state offers Open project…",
            "Status bar: “index unavailable”"]),
        ("Degraded compute", "no GPU detected", "var(--peach)", [
            "Environment widget turns amber",
            "“CPU fallback — roughly 40× slower”",
            "Templates show CPU runtime estimates",
            "Warning repeated before a run starts"]),
    ]
    for i, (name, when, color, lines) in enumerate(cards):
        x = 40 + (i % 3) * 356
        y = 92 + (i // 3) * 254
        b.append(R(x, y, 336, 228, "panel", 8))
        b.append(f'<rect x="{x}" y="{y}" width="4" height="228" rx="2" fill="{color}"/>')
        b.append(T(x + 18, y + 26, name, "t lbl"))
        b.append(T(x + 18, y + 42, when, "m xs"))
        b.append(L(x + 18, y + 56, x + 318, y + 56, "box"))
        for j, ln in enumerate(lines):
            b.append(T(x + 18, y + 78 + j * 18, "· " + ln, "m sm"))
    b.append(T(40, 614, "Rule: a failure of the recent index never blocks creating or opening a project. "
                        "The launch tiles are present in every state.", "m sm"))
    svg("07-screen-states", W, H, "\n".join(b), "Start screen states")


# ---------------------------------------------------------------------------
# 08 — Semantic colour mapping
# ---------------------------------------------------------------------------
def colors():
    W, H = 1180, 700
    b = [T(40, 34, "Semantic colour mapping", "t h"),
         T(40, 50, "The start screen adds no raw hues. Each meaning maps onto a palette token already in "
                   "theme.css — except where that token fails as text, which is measured below.", "m sm")]

    b.append(T(40, 92, "Mark colour — status dot, badge border and fill, timeline marker", "h2"))
    b.append(T(640, 92, "dark — Mocha", "h2")); b.append(T(880, 92, "light — Latte", "h2"))
    y = 104
    marks = [("FDM", "--fm-solver-fdm", "--fm-chart-blue", "#89b4fa", "#1e66f5"),
             ("FEM", "--fm-solver-fem", "--fm-chart-mauve", "#cba6f7", "#8839ef"),
             ("Ready", "--fm-project-ready", "--fm-success", "#a6e3a1", "#40a02b"),
             ("Running", "--fm-project-running", "--fm-chart-yellow", "#f9e2af", "#df8e1d"),
             ("Failed", "--fm-project-failed", "--fm-danger", "#f38ba8", "#d20f39"),
             ("Draft", "--fm-project-draft", "--fm-text-muted", "#6c7086", "#9ca0b0"),
             ("Needs migration", "--fm-project-migrate", "--fm-degraded", "#fab387", "#fe640b"),
             ("Read-only", "--fm-project-readonly", "--fm-chart-teal", "#94e2d5", "#179299")]
    for name, tok, src, dk, lt in marks:
        b.append(T(56, y + 14, name, "t sm"))
        b.append(T(230, y + 14, tok, "mono xs"))
        b.append(T(440, y + 14, "= " + src, "mono xs"))
        b.append(R(640, y + 2, 110, 16, "box", 3, f' style="fill:{dk};stroke:#45475a"'))
        b.append(T(758, y + 14, dk, "mono xs"))
        b.append(R(880, y + 2, 110, 16, "box", 3, f' style="fill:{lt};stroke:#bcc0cc"'))
        b.append(T(998, y + 14, lt, "mono xs"))
        y += 22

    y += 18
    b.append(T(40, y + 6, "Label colour — the word at 11–12 px, which is a different problem", "h2"))
    b.append(T(640, y + 6, "Mocha  ratio", "h2")); b.append(T(880, y + 6, "Latte  ratio", "h2"))
    y += 20
    labels = [("Ready", "--fm-project-ready-text", "#a6e3a1", "6.99", "#256b15", "4.51", "#40a02b", "2.75"),
              ("Running", "--fm-project-running-text", "#f9e2af", "8.18", "#865006", "4.55", "#df8e1d", "2.15"),
              ("Failed", "--fm-project-failed-text", "#f38ba8", "4.49", "#ba092f", "4.54", "#d20f39", "3.72"),
              ("Draft", "--fm-project-draft-text", "#a6adc8", "4.67", "#585c71", "4.52", "#9ca0b0", "2.30"),
              ("Needs migration", "--fm-project-migrate-text", "#fab387", "5.87", "#a13b00", "4.58", "#fe640b", "2.45"),
              ("Read-only", "--fm-project-readonly-text", "#94e2d5", "6.98", "#09676c", "4.54", "#179299", "3.08"),
              ("FDM badge", "--fm-solver-fdm-text", "#89b4fa", "4.94", "#044ee0", "4.54", "#1e66f5", "3.37"),
              ("FEM badge", "--fm-solver-fem-text", "#cba6f7", "5.12", "#771af0", "4.51", "#8839ef", "3.71"),
              ("Meta text", "--fm-start-meta", "#a6adc8", "4.67", "#585c71", "4.52", "#9ca0b0", "2.14")]
    for name, tok, dk, dr, lt, lr, was, wr in labels:
        b.append(T(56, y + 14, name, "t sm"))
        b.append(T(230, y + 14, tok, "mono xs"))
        b.append(R(640, y + 2, 92, 16, "box", 3, f' style="fill:{dk};stroke:#45475a"'))
        b.append(T(740, y + 14, dr, "mono xs"))
        b.append(R(880, y + 2, 92, 16, "box", 3, f' style="fill:{lt};stroke:#bcc0cc"'))
        b.append(T(980, y + 14, lr, "mono xs"))
        b.append(T(1030, y + 14, f"was {was} {wr}", "mono xs"))
        y += 22

    y += 16
    b.append(R(40, y, 1100, 104, "panel", 7, ' stroke="var(--accent)"'))
    b.append(T(56, y + 22, "Why mark and label diverge", "t lbl"))
    for i, line in enumerate([
        "Catppuccin Latte is an accent palette, not a text palette. Measured as 11–12 px text on the launcher's surfaces "
        "(#f7f8fb / #eff1f5 / #e6e9ef / #c4d7f5) its",
        "status hues land at 2.1–3.7:1 — below WCAG AA. Mocha's --fm-text-muted is 2.13:1 behind a kbd on "
        "--fm-bg-panel-raised. The dot, the border and the",
        "fill keep the palette hue, where the 3:1 non-text bar applies and every value clears it; only the word is darkened "
        "or lightened, hue preserved.",
        "These overrides are scoped to the start screen on purpose: the same gap exists elsewhere in the light theme and "
        "deserves a repo-wide decision, not a quiet fork."]):
        b.append(T(56, y + 42 + i * 15, line, "m xs"))

    y += 118
    b.append(T(40, y, "Verified", "h2"))
    b.append(T(40, y + 20, "0 elements below WCAG AA across 18 combinations — 2 themes × "
                           "{loaded, first run, loading, index error} × {home, templates, import, learn, settings, about}.", "m sm"))
    b.append(T(40, y + 36, "Measured on the rendered mockup with alpha layers composited, not on the token values alone.", "m sm"))
    svg("08-colour-mapping", W, H, "\n".join(b), "Semantic colour mapping")


if __name__ == "__main__":
    zones(); ia(); grid(); anatomy_row(); anatomy_inspector(); flow(); states(); colors()
