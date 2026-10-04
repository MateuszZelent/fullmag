# fullmag

Embedded Python DSL and runtime scaffolding for Fullmag.

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
