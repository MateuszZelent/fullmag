# Fullmag WiX 3 bootstrapper application

This directory contains the production native BA DLL used by a WiX 3 Burn
bundle. It is a real Win32 application: it renders the license and checkout
workflow, keeps an unelevated PowerShell helper alive over private JSON
stdin/stdout, shows only redacted helper replies, and drives Burn
detection/plan/apply progress. The release MSI route checks WebView2 before
launching the installed `fullmag-ui.exe`; the source-first route runs the
verified environment helper and, after a completed launch-capable
`initial-build` receipt, invokes its `launch-ui` mode for the browser
workspace. The BA itself is a native Win32 client and does not require
WebView2 for source-first setup.

The BA never serializes the helper session object. The session stays in the
PowerShell child process. Secret values are sent only in a request on the
redirected stdin pipe; they are not command-line arguments, Burn log entries,
stdout replies, or GUI summary text. The helper owns Git main-checkout
discovery, template/manifest field admission, storage resolver validation,
optimistic concurrency, backup, and atomic `.env` replacement.

Before invoking the accepted setup script, the helper removes inherited
generic secret-key variables from its own process environment. Nonsecret
storage and tool configuration variables remain available to the setup route,
while Python and other children do not inherit ambient credentials.

The GUI invalidates the admitted environment whenever the checkout or an
editable field changes. A successful `.env` commit creates a fresh helper
session bound to the new file hash; dependency setup must use that committed
session, its committed storage root/profile, and the canonical setup-script
hash. Immediately before launching the setup child, the helper revalidates
the Git identity, template/manifest/resolver hashes, `.env` hash, and
read-only storage resolution, then accepts only a report with the same
storage root/profile. A stale or edited session blocks setup.

## Production build inputs

The target consumes the actual WiX 3 Burn headers selected by CMake. It does
not vendor or recreate `IBootstrapperApplication` or `IBootstrapperEngine`.
WiX 3 Burn custom BA exports are kept undecorated by the module definition
file. The target rejects x64 and is intended for a Visual Studio **Win32/x86**
configuration because the WiX 3 BA ABI and bundled `balutil.lib` are x86.

The pinned source asset inspected for this task is the WiX 3.14.1 release
archive:

```text
https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip
SHA-256 (locally computed): 6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31
```

The hash above is an input record, not a publisher signature. The managed
packaging recipe must acquire and verify the approved archive, expose its
actual `inc`/Burn header directory as `WIX3_SDK_ROOT` or
`WIX3_SDK_INCLUDE_DIR`, and use the same WiX 3 `candle.exe`, `light.exe`, and
`WixBalExtension` when authoring the bundle.

This DLL has no Rust, Cargo, MFEM, CUDA, product MSI, or FEM runtime build
dependency. Building the BA source is therefore a separate x86/MSVC/WiX SDK
step. The public source-first route is the supported Burn chain: it carries the
environment helper and prepares `.env` plus the first managed build from an
admitted checkout. It does not require a product MSI or an already installed
Fullmag. Historical MSI wrapping remains an internal, fail-closed variant until
its all-capability contract is qualified.

## Payload contract

The BA expects Burn to materialize these common payloads beside the loaded BA
DLL:

* `installer_env.ps1` — the transactional helper;
* the approved license text (`LICENSE.txt`, `license.txt`, `LICENSE`, or
  `Fullmag-LICENSE.txt`);
* `fullmag-installer-provenance.json` — the source and route provenance input.

The source-first chain additionally supplies `setup_build_environment.ps1`,
`windows_build_requirements.json`, and `fullmag-installer-environment.exe`.
The historical MSI route supplies `fullmag-msi-stage-manifest.json` instead of
the source-first environment helper. The source-first chain also receives the
persisted Burn variables `FullmagStorageProfile`, `FullmagBootstrapMode`, and
`FullmagReceiptPath`.

Source-first admission has one fixed installation scope, `all`, covering FDM
CPU, FDM GPU, FEM CPU, and FEM GPU. The BA never asks the operator to choose
`native`, `fem-cpu`, or `fem-gpu`. The editor and preadmission session use the
`windows-setup` profile for Git/Python prerequisite handling. After the
checkout is admitted, the setup report and the Burn `FullmagStorageProfile`
use the physical superset profile `windows-native-fem-gpu`; its terminal
receipt must be bound to the aggregate
`windows-full-runtime/build-manifest.json` with all four component proofs.
`windows-installer-source` is only the managed producer's storage/lease
profile, not a runtime choice.

Immediately before Burn planning the BA binds `FullmagSourceCheckout`,
`FullmagStorageRoot`, `FullmagStorageProfile`, `FullmagBootstrapMode`, and
`FullmagReceiptPath` from the committed admission, and requires the receipt
path to remain below the resolver-owned `runs_root` for the committed storage
layout. After Apply it accepts the source-first route only when the helper
receipt has the expected schema, state, fixed `all` scope, physical superset
profile, aggregate proofs, storage identity, and sanitized-output marker. The
source-first payload therefore does not depend on the release MSI or an
installed product.

The BA fails closed when the license, helper, setup input, or provenance
payload is missing; when the admitted main checkout or setup script changes;
or when the source-first report, provenance, and receipt disagree about the
fixed `all` scope, the physical superset profile, storage identity, or
aggregate proofs. On the historical release MSI route it also fails closed
when WebView2 or the installed UI executable cannot be verified. The
source-first route requires its admitted environment helper and a matching
completed setup receipt before it can launch the browser workspace.
The BA does not invoke WSL, set User/Machine environment variables, or modify
`PATH`.

## Verification boundary

`test_protocol.py` is an interpreted source/protocol check. It verifies the
real export names, x86/SDK guards, persistent JSON bridge markers, redaction
boundary, and no-WSL/no-shell escape invariants. A native CMake configure and
MSVC compile/link of the BA have passed for a frozen source snapshot. WiX
authoring, Burn execution, clean install, WebView2 runtime proof, the
source-first environment/helper runtime, and FEM qualification remain
unverified.
