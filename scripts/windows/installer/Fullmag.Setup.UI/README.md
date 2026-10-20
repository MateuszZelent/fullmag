# Fullmag Setup UI

This directory contains the modern Avalonia + Fluent wizard for the Windows
installer. The native WiX BA owns the installer process, Burn lifecycle,
source admission, environment transaction, dependency setup, receipt checks and
launch. It starts `FullmagInstallerUi.exe` only after validating the payload and
passes a private inherited stdin/stdout connection to it.

The UI follows the Windows/system light or dark preference through Avalonia's Default requested theme variant. Application-owned surfaces use Light/Dark theme dictionaries and DynamicResource brushes so the sidebar, cards, status panels and text keep contrast when the system theme changes. The managed producer and a rendered Windows check are still required; source checks do not claim visual runtime proof.

The UI is a presentation client. It does not start PowerShell, Git, Burn or a
second broker process; it does not write `.env`, change process-wide
environment variables, edit `PATH`, or decide whether a receipt is valid. The
broker remains authoritative for those operations. Secret field values stay in
this process only until the private command that needs them and never appear in
responses, status text, logs, command-line arguments or error output.

## BA connection protocol

The process must be started by the native BA with redirected private standard
handles. A direct launch without those handles is shown as blocked and never
starts a helper. stdout is reserved for UTF-8 JSON Lines; diagnostics must not
be written there.

The first UI frame is the exact BA handshake:

```json
{"schema":"fullmag.windows-installer-ui.v1","type":"hello","version":"1.0.0","arch":"x64"}
```

The BA then sends an `init` frame. Commands sent by the UI use the same schema,
the exact version `1.0.0`, the current admission generation and a client
revision that increases for every command and terminal shutdown frame:

The `init.payload` is the BA's verified public setup context. It includes
`license_valid: true` with `license_text`, `setup_script` and
`requirements_manifest` provenance objects (`filename` and `sha256`), and
`mode` (`initial-build` or `setup-only`), together with the selected `lane`.
The UI also accepts the equivalent flat `setup_path`, `manifest_path`,
`setup_hash`, `manifest_hash`, and `bootstrap_mode` names. `profile` or
`storage_profile`, plus `receipt_path`, may be supplied when they have already
been validated. These fields contain no secrets; the UI does not infer them
from its own checkout or from an untrusted command line.

```json
{
  "schema":"fullmag.windows-installer-ui.v1",
  "type":"command",
  "version":"1.0.0",
  "request_id":"uuid",
  "generation":3,
  "revision":12,
  "payload":{
    "operation":"preview",
    "session_id":"private-session-id",
    "values":{"PUBLIC_SETTING":"value"}
  }
}
```

The `payload` operation field is combined with the operation-specific fields by
the typed client. Secret values are allowed only in this private request.
Replies use `type: "reply"` with the same `request_id`; an `accepted` reply is
only an acknowledgement and remains pending until a terminal `reply`, `state`
or `burn` frame arrives for that request. `state` is one of the terminal or
in-progress states supplied by the BA. Stale frames with an older
generation/revision are discarded and fail the matching request. An `error`
frame is fail-closed and never contains secret material.

Each frame is bounded to one UTF-8 line of at most 2 MiB, matching the native
BA reader. The client counts encoded bytes while reading, tracks the
BA's `generation` and observed `revision`, routes replies by `request_id`, and sends a
terminal `shutdown` frame before closing. The BA still owns process teardown;
the UI does not kill or restart anything.

The operation mapping is:

| UI operation | BA responsibility |
| --- | --- |
| `preadmission` | Validate the selected checkout, storage, lane and pinned setup inputs. |
| `discover` | Ask the trusted helper for the admitted source and non-secret field metadata. |
| `prerequisites` | Report or prepare the required Git/Python/build tools for the selected lane. |
| `preview` | Return a current redacted environment proposal. |
| `commit` | Revalidate and atomically save the approved environment through the helper. |
| `cancel` | Request cancellation of the current operation and report whether a save was already confirmed. |
| `initial_build` | Run the broker-owned setup/initial-build route and validate its terminal receipt. |
| `launch_ui` | Request the already validated workspace launch without reinstalling or rebuilding. |

The wizard only enables the next page after the corresponding authoritative
reply. A launch reply means that startup was requested; it does not claim that
a browser or workspace has rendered.

## Build input

The project pins the official Avalonia packages `Avalonia`,
`Avalonia.Desktop` and `Avalonia.Themes.Fluent` to **12.1.4**, with .NET SDK
**10.0.402** selected by the adjacent `global.json`. The target is `net10.0`
and the producer publishes a self-contained, single-file `win-x64` payload:

```powershell
dotnet publish .\Fullmag.Setup.UI.csproj -c Release -r win-x64 --self-contained true
```

The managed producer owns restore, publish, payload hashing and Burn staging.
The source-only checks in `test_protocol.py` do not prove a Windows publish,
rendered window, accessibility tree, or clean-host run.

Primary package and SDK references:

- [Avalonia 12.1.4](https://www.nuget.org/packages/Avalonia/12.1.4)
- [Avalonia.Desktop 12.1.4](https://www.nuget.org/packages/Avalonia.Desktop/12.1.4)
- [Avalonia.Themes.Fluent 12.1.4](https://www.nuget.org/packages/Avalonia.Themes.Fluent/12.1.4)
- [Avalonia Fluent theme documentation](https://docs.avaloniaui.net/docs/styling/themes)
- [.NET 10 SDK downloads](https://dotnet.microsoft.com/en-us/download/dotnet/10.0)
