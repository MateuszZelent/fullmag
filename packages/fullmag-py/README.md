# fullmag

Python DSL and API client for [Fullmag](https://github.com/MateuszZelent/fullmag), a
finite-difference (FDM) and finite-element (FEM) micromagnetics platform with CPU and CUDA
backends.

## Installation

```bash
pip install fullmag
# or, with uv
uv add fullmag            # in a uv project
uv pip install fullmag    # in an existing environment
```

Optional extras:

| Extra | Adds | Use for |
| --- | --- | --- |
| `meshing` | gmsh, manifold3d, meshio, scipy, trimesh | FEM geometry and mesh authoring |
| `figures` | Pillow | image-based textures and figures |
| `jupyter` | IPython, matplotlib | notebooks and the live monitor |

```bash
pip install "fullmag[meshing,jupyter]"
```

Python 3.10 or newer is required. The package is pure Python.

## What this package is

`fullmag` is the public scripting surface of Fullmag: you describe geometry, materials,
interactions and stages in Python, and the platform lowers them to its canonical `ProblemIR`.
The solvers themselves (FDM/FEM, CPU/CUDA) are native code and are **not** part of this wheel.

Works with only `pip install fullmag`:

- authoring models with the DSL (`fm.geometry`, materials, textures, stages) and inspecting them;
- mesh authoring with the `meshing` extra;
- the live API client: `fm.connect()` drives a running Fullmag instance over HTTP, and
  `fm.relax()`, `fm.run()` and `fm.field("m").to_numpy()` then execute on that instance.

Needs a Fullmag runtime (the Docker DEV group or a native build from the repository):

- executing any solver stage. Without `fm.connect()` and without the native runner,
  `fm.relax()`/`fm.run()` return a `Result` with `status="not-executable"`, and
  `fm.connect()` to an unreachable URL raises `FullmagConnectionError`;
- the Control Room UI and the `fullmag` command-line launcher.

## Live example

Start a Fullmag instance (see the repository README), then:

```python
import fullmag as fm

fm.connect("http://127.0.0.1:3197")  # or set FULLMAG_URL
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 10e-9)
fm.solver(fix_dt=1e-13)

layer = fm.geometry(fm.Box(200e-9, 100e-9, 10e-9), name="layer")
layer.Ms = 800e3
layer.Aex = 13e-12
layer.alpha = 0.5
layer.m = fm.texture.uniform(1, 1, 0)

result = fm.relax(dt=1e-13, tolT=1e-4, max_steps=1_000)
m = fm.field("m").to_numpy()  # (point_count, 3)
fm.disconnect()
```

More examples: [examples/live](https://github.com/MateuszZelent/fullmag/tree/master/examples/live).
Documentation: <https://fullmag.mzelent.pl>.

## Isolated authoring contexts

The module-level DSL remains compatible with existing scripts. When a process
authors more than one document concurrently, bind each document to its own
context:

```python
import fullmag as fm

with fm.execution_context():
    study = fm.study("document-a")
    body = fm.geometry(fm.Box(100e-9, 100e-9, 5e-9), name="body-a")

with fm.ExecutionContext():
    study = fm.study("document-b")
    body = fm.geometry(fm.Box(100e-9, 100e-9, 5e-9), name="body-b")
```

`ExecutionContext` owns the mutable flat authoring state and restores the
previous binding on exit, including exception paths. Async tasks and threads
must use a separate context for each independent document. Entering a context
does not build a mesh or start a solver.
