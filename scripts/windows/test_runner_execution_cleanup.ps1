# Interpret-only proof for unlinking disposable fixture links. No runner data is removed.
param([Parameter(Mandatory = $true)][string]$RepoRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This fixture requires Windows' }
$resolver = Join-Path $RepoRoot 'scripts/fullmag_storage.py'
$raw = & python -B $resolver resolve --repo-root $RepoRoot --profile fdm-cpu-release --format json
if ($LASTEXITCODE -ne 0) { throw 'Storage resolution failed' }
$layout = ($raw -join "`n") | ConvertFrom-Json
$tempRoot = [IO.Path]::GetFullPath([string]$layout.temp_root)
$storageRoot = [IO.Path]::GetFullPath([string]$layout.storage_root).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not $tempRoot.StartsWith($storageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Fixture temp root must remain inside configured storage'
}
$fixtureBase = Join-Path $layout.temp_root 'runner-link-unlink-fixture'
$fixtureRoot = Join-Path $fixtureBase ([guid]::NewGuid().ToString('N'))
for ($ancestor = [IO.Path]::GetFullPath($fixtureBase); $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
  if (Test-Path -LiteralPath $ancestor) {
    $existing = Get-Item -LiteralPath $ancestor -Force
    if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $existing.PSIsContainer) {
      throw 'Fixture parent must be a real directory without reparse traversal'
    }
  }
}
if (Test-Path -LiteralPath $fixtureRoot) { throw 'Fixture must be fresh' }
$null = New-Item -ItemType Directory -Path $fixtureRoot
$execution = Join-Path $fixtureRoot 'execution'
$protected = Join-Path $fixtureRoot 'protected'
$null = New-Item -ItemType Directory -Path $execution
$null = New-Item -ItemType Directory -Path $protected
$sentinel = Join-Path $protected 'keep.txt'
Set-Content -LiteralPath $sentinel -Value 'protected target' -NoNewline
Set-Content -LiteralPath (Join-Path $execution 'target.bin') -Value 'native artifact' -NoNewline
$junction = Join-Path $execution 'junction'
$windowsLink = Join-Path $execution 'windows-file-link'
$linuxLink = Join-Path $execution 'linux-file-link'
$null = New-Item -ItemType Junction -Path $junction -Target $protected
$null = New-Item -ItemType SymbolicLink -Path $windowsLink -Target $sentinel
# Create the exact LX tag found in old execution trees; Docker now creates a
# Windows symlink instead, so it cannot prove LX unlink behavior on this host.
$createLxLink = @'
import ctypes, os, re, struct, sys
from ctypes import wintypes
from pathlib import Path
p = Path(sys.argv[1])
assert os.name == 'nt' and p.is_absolute()
assert p.name == 'linux-file-link' and p.parent.name == 'execution'
assert re.fullmatch('[0-9a-f]{32}', p.parent.parent.name)
assert p.parent.parent.parent.name == 'runner-link-unlink-fixture'
assert (p.parent / 'target.bin').is_file() and not p.exists()
with p.open('xb'): pass
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k.CreateFileW.restype = wintypes.HANDLE
k.DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k.DeviceIoControl.restype = wintypes.BOOL
k.CloseHandle.argtypes = [wintypes.HANDLE]
k.CloseHandle.restype = wintypes.BOOL
h = k.CreateFileW(str(p), 0x40000000, 0, None, 3, 0x00200000, None)
if h == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
try:
    payload = struct.pack('<I', 2) + b'target.bin'
    raw = struct.pack('<IHH', 0xa000001d, len(payload), 0) + payload
    buf = ctypes.create_string_buffer(raw)
    returned = wintypes.DWORD()
    if not k.DeviceIoControl(h, 0x000900a4, buf, len(raw), None, 0, ctypes.byref(returned), None):
        raise ctypes.WinError(ctypes.get_last_error())
finally:
    k.CloseHandle(h)
'@
& python -B -c $createLxLink $linuxLink
if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable LX link fixture' }
$beforeHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
$proof = @()
foreach ($link in @($junction, $windowsLink, $linuxLink)) {
  $absolute = [IO.Path]::GetFullPath($link)
  if (-not $absolute.StartsWith($execution + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Link escaped the disposable execution fixture'
  }
  $item = Get-Item -LiteralPath $absolute -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Expected a reparse fixture' }
  $attributes = [string]$item.Attributes
  $tagOutput = & fsutil reparsepoint query $absolute
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the fixture reparse tag' }
  $tag = [regex]::Match(($tagOutput -join "`n"), '0x[0-9a-fA-F]{8}').Value.ToLowerInvariant()
  $expectedTag = if ($link -eq $junction) { '0xa0000003' } elseif ($link -eq $windowsLink) { '0xa000000c' } else { '0xa000001d' }
  if ($tag -ne $expectedTag) { throw "Unexpected fixture tag: $tag" }
  # Remove only this link entry. Never recurse into it or pass a wildcard.
  Remove-Item -LiteralPath $absolute -Force -Confirm:$false -ErrorAction Stop
  if (Test-Path -LiteralPath $absolute) { throw 'Link entry remains' }
  if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Protected target changed' }
  if (-not (Test-Path -LiteralPath (Join-Path $execution 'target.bin') -PathType Leaf)) { throw 'Native target was removed' }
  $proof += [pscustomobject]@{ name = [IO.Path]::GetFileName($absolute); attributes = $attributes; reparse_tag = $tag; target_preserved = $true }
}
# Recursion is tested only after proving all fixture links have been unlinked.
$remainingLinks = @(Get-ChildItem -LiteralPath $execution -Force -Recurse | Where-Object {
  ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
})
if ($remainingLinks.Count -ne 0) { throw 'Reparse fixture remains before regular-tree removal' }
$resolvedExecution = (Resolve-Path -LiteralPath $execution).ProviderPath
if ($resolvedExecution -ne [IO.Path]::GetFullPath((Join-Path $fixtureRoot 'execution'))) { throw 'Execution containment changed' }
if (($resolvedExecution + [IO.Path]::DirectorySeparatorChar).StartsWith($fixtureRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -ne $true) { throw 'Invalid fixture containment' }
Remove-Item -LiteralPath $resolvedExecution -Recurse -Force -Confirm:$false
if (Test-Path -LiteralPath $execution) { throw 'Disposable execution remains' }
if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Protected target changed after removal' }
$result = [pscustomobject]@{
  schema = 'fullmag.runner-link-unlink-fixture.v1'; fixture_root = $fixtureRoot;
  powershell_version = $PSVersionTable.PSVersion.ToString(); cases = $proof;
  regular_tree_removed = $true; protected_target_preserved = $true;
  production_cleanup = 'NOT PERFORMED'; production_cleanup_qualified = $false
}
$json = $result | ConvertTo-Json -Depth 5
Set-Content -LiteralPath (Join-Path $fixtureRoot 'proof.json') -Value $json -Encoding utf8
$json
