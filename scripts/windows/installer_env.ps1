# Transactional .env editor for the future Windows Burn GUI.
#
# This file is intentionally a dot-sourceable PowerShell module rather than an
# installer or an executable.  The public functions below return plain objects
# so a future Burn bridge can validate, preview, commit, or cancel without
# knowing how dotenv parsing, Git checkout discovery, or storage admission work.
# The selected checkout supplies the versioned template, requirements manifest,
# resolver, and setup source.  The main checkout discovered through Git remains
# the sole owner of .env.  No function sets User/Machine environment variables
# or mutates the process environment of its caller.

$script:FullmagInstallerEnvSessionKey = New-Object byte[] 32
$sessionKeyGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $sessionKeyGenerator.GetBytes($script:FullmagInstallerEnvSessionKey) }
finally { $sessionKeyGenerator.Dispose() }

function Get-FullmagInstallerEnvSecretToken {
  return "<redacted>"
}

function Test-FullmagInstallerEnvSecretKey {
  param([Parameter(Mandatory = $true)][string]$Key)
  return ($Key -match '(?i)(PASSWORD|SECRET|TOKEN|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY)' -or
    $Key -in @("POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"))
}

function Get-FullmagInstallerEnvInheritedSecretNames {
  $names = [System.Collections.Generic.List[string]]::new()
  foreach ($entry in [System.Environment]::GetEnvironmentVariables("Process").GetEnumerator()) {
    $name = [string]$entry.Key
    if ((Test-FullmagInstallerEnvSecretKey -Key $name) -and -not $names.Contains($name)) {
      [void]$names.Add($name)
    }
  }
  return @($names)
}

function Get-FullmagInstallerEnvRedactedValue {
  param(
    # Keep null distinct from an explicitly empty non-secret value. Windows
    # PowerShell coerces a null [string] parameter to an empty string before
    # the body can apply the <unset> marker.
    [Parameter()][AllowNull()][object]$Value,
    [Parameter(Mandatory = $true)][string]$Key
  )
  if (Test-FullmagInstallerEnvSecretKey $Key) {
    if ($null -eq $Value -or [string]::IsNullOrEmpty([string]$Value)) { return "<empty>" }
    return (Get-FullmagInstallerEnvSecretToken)
  }
  if ($null -eq $Value) { return "<unset>" }
  return [string]$Value
}

function Test-FullmagInstallerEnvReparseItem {
  param([Parameter(Mandatory = $true)]$Item)
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    return $true
  }
  # Windows PowerShell reports ordinary hard-linked files as LinkType=HardLink.
  # A hardlink is not a reparse point and is valid for a verified host tool;
  # symbolic links and junctions remain rejected by this guard.
  if ($Item.PSObject.Properties.Name -contains "LinkType" -and
      -not [string]::IsNullOrWhiteSpace([string]$Item.LinkType) -and
      -not [string]::Equals([string]$Item.LinkType, "HardLink",
        [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $false
}

function Assert-FullmagInstallerEnvNoReparse {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter()][string]$Label = "path"
  )

  $candidate = [System.IO.Path]::GetFullPath($Path)
  $probe = $candidate
  while ($true) {
    if (Test-Path -LiteralPath $probe) {
      $item = Get-Item -LiteralPath $probe -Force -ErrorAction Stop
      if (Test-FullmagInstallerEnvReparseItem $item) {
        throw "$Label traverses a symlink or reparse point: $candidate (at $probe)"
      }
    }
    $parent = Split-Path -Parent $probe
    if ([string]::IsNullOrWhiteSpace($parent)) {
      break
    }
    $next = [System.IO.Path]::GetFullPath($parent)
    if ([string]::Equals($next, $probe, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $probe = $next
  }
}

function ConvertTo-FullmagInstallerEnvFullPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter()][string]$Label = "path"
  )
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label must not be empty"
  }
  $candidate = $Path.Trim()
  if ($candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be an absolute local Windows path"
  }
  if ($candidate -match '^(?:\\\\|//)') {
    throw "$Label must not be a UNC or network path"
  }
  if ($candidate -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "$Label must not contain parent traversal"
  }
  if ($candidate -match '[\r\n\0]') {
    throw "$Label contains an invalid character"
  }
  try {
    $full = [System.IO.Path]::GetFullPath($candidate)
  }
  catch {
    throw "$Label is not a valid Windows path"
  }
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) {
    throw "$Label has no local drive root"
  }
  $trimmed = $full.TrimEnd('\', '/')
  if ([string]::Equals($trimmed, $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must not be a drive root"
  }
  Assert-FullmagInstallerEnvNoReparse -Path $full -Label $Label
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
      throw "$Label must identify a directory or a directory that can be created"
    }
  }
  return $trimmed
}

function Assert-FullmagInstallerEnvInside {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter()][string]$Label = "path"
  )
  $candidate = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $base = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if (-not [string]::Equals($candidate, $base, [System.StringComparison]::OrdinalIgnoreCase) -and
      -not $candidate.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must remain inside the main checkout"
  }
  Assert-FullmagInstallerEnvNoReparse -Path $candidate -Label $Label
  return $candidate
}

function Invoke-FullmagInstallerGit {
  param(
    [Parameter(Mandatory = $true)][string]$CheckoutPath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
  if (-not $git) { throw "Git is required to identify the Fullmag checkout" }
  $result = Invoke-FullmagInstallerEnvProcess -FilePath ([string]$git.Source) `
    -Arguments (@("-C", $CheckoutPath) + @($Arguments)) `
    -WorkingDirectory $CheckoutPath
  $output = [string]$result.stdout
  $exitCode = [int]$result.exit_code
  if ($exitCode -ne 0) {
    throw "Git checkout discovery failed with exit code $exitCode"
  }
  return $output.Trim()
}

function Get-FullmagInstallerEnvGitIdentity {
  param([Parameter(Mandatory = $true)][string]$MainCheckout)
  $top = Invoke-FullmagInstallerGit -CheckoutPath $MainCheckout -Arguments @("rev-parse", "--show-toplevel")
  $head = Invoke-FullmagInstallerGit -CheckoutPath $MainCheckout -Arguments @("rev-parse", "HEAD")
  $worktrees = Invoke-FullmagInstallerGit -CheckoutPath $MainCheckout -Arguments @(
    "-c", "core.quotePath=false", "worktree", "list", "--porcelain")
  return [pscustomobject]@{
    top = [System.IO.Path]::GetFullPath(($top -split "`r?`n")[0].Trim('"')).TrimEnd('\', '/')
    head = $head
    worktrees_hash = Get-FullmagInstallerEnvSha256 -Bytes ([System.Text.UTF8Encoding]::new($false).GetBytes($worktrees))
  }
}

function Get-FullmagInstallerEnvMainCheckout {
  param([Parameter(Mandatory = $true)][string]$CheckoutPath)
  $checkout = [System.IO.Path]::GetFullPath($CheckoutPath).TrimEnd('\', '/')
  Assert-FullmagInstallerEnvNoReparse -Path $checkout -Label "checkout"
  if (-not (Test-Path -LiteralPath (Join-Path $checkout ".git"))) {
    throw "Git metadata is missing from the checkout; refusing to create an alternate source"
  }
  $resolved = Invoke-FullmagInstallerGit -CheckoutPath $checkout -Arguments @("rev-parse", "--show-toplevel")
  if ([string]::IsNullOrWhiteSpace($resolved)) {
    throw "Git did not return a checkout root"
  }
  $repo = [System.IO.Path]::GetFullPath(($resolved -split "`r?`n")[0].Trim('"')).TrimEnd('\', '/')
  Assert-FullmagInstallerEnvNoReparse -Path $repo -Label "checkout"
  $worktreeOutput = Invoke-FullmagInstallerGit -CheckoutPath $repo -Arguments @("-c", "core.quotePath=false", "worktree", "list", "--porcelain")
  $first = $null
  foreach ($line in ($worktreeOutput -split "`r?`n")) {
    if ($line -match '^worktree\s+(.+)$') {
      $first = $matches[1].Trim().Trim('"')
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($first)) {
    throw "Git returned no main checkout record"
  }
  $main = [System.IO.Path]::GetFullPath($first).TrimEnd('\', '/')
  Assert-FullmagInstallerEnvNoReparse -Path $main -Label "main checkout"
  if (-not (Test-Path -LiteralPath (Join-Path $main ".git"))) {
    throw "The main checkout has no Git metadata"
  }
  return $main
}

function Get-FullmagInstallerEnvSha256 {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  }
  finally { $sha.Dispose() }
}

function Get-FullmagInstallerEnvSessionCanonicalIdentity {
  param([Parameter(Mandatory = $true)]$Session)
  return (@(
      [string]$Session.schema
      [string]$Session.session_id
      [string]$Session.requested_checkout
      [string]$Session.main_checkout
      [string]$Session.env_path
      [string]$Session.template_path
      [string]$Session.manifest_path
      [string]$Session.resolver_script
      [string]$Session.original_hash
      [string]$Session.template_hash
      [string]$Session.manifest_hash
      [string]$Session.resolver_hash
      [string]$Session.git_top
      [string]$Session.git_head
      [string]$Session.git_worktrees_hash
      [string]$Session.requested_git_top
      [string]$Session.requested_git_head
      [string]$Session.requested_git_worktrees_hash
      [string]$Session.storage_profile
    ) -join "`n")
}

function Get-FullmagInstallerEnvSessionSignature {
  param([Parameter(Mandatory = $true)]$Session)
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($script:FullmagInstallerEnvSessionKey)
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(
      (Get-FullmagInstallerEnvSessionCanonicalIdentity -Session $Session))
    return ([System.BitConverter]::ToString($hmac.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  }
  finally { $hmac.Dispose() }
}

function Get-FullmagInstallerEnvEncoding {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
    return [pscustomobject]@{ Name = "utf-8-bom"; Offset = 3; Encoding = [System.Text.UTF8Encoding]::new($true, $true) }
  }
  if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) {
    return [pscustomobject]@{ Name = "utf-16-le"; Offset = 2; Encoding = [System.Text.UnicodeEncoding]::new($false, $true, $true) }
  }
  if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) {
    return [pscustomobject]@{ Name = "utf-16-be"; Offset = 2; Encoding = [System.Text.UnicodeEncoding]::new($true, $true, $true) }
  }
  return [pscustomobject]@{ Name = "utf-8"; Offset = 0; Encoding = [System.Text.UTF8Encoding]::new($false, $true) }
}

function Read-FullmagInstallerEnvFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter()][switch]$AllowMissing,
    [Parameter()][string]$Label = "file"
  )
  $full = [System.IO.Path]::GetFullPath($Path)
  Assert-FullmagInstallerEnvNoReparse -Path $full -Label $Label
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    if ($AllowMissing) {
      return [pscustomobject]@{
        exists = $false; path = $full; bytes = [byte[]]@(); text = ""; hash = ""
        encoding_name = "utf-8"; encoding = [System.Text.UTF8Encoding]::new($false)
        newline = [Environment]::NewLine; final_newline = $false
      }
    }
    throw "$Label is missing: $full"
  }
  $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -and (Test-FullmagInstallerEnvReparseItem $item)) {
    throw "$Label is a symlink or reparse point: $full"
  }
  if ($item.PSIsContainer) { throw "$Label is a directory: $full" }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $encodingInfo = Get-FullmagInstallerEnvEncoding -Bytes $bytes
  $text = $encodingInfo.Encoding.GetString($bytes, [int]$encodingInfo.Offset, $bytes.Length - [int]$encodingInfo.Offset)
  $newline = if ($text -match "`r`n") { "`r`n" } elseif ($text -match "`n") { "`n" } elseif ($text -match "`r") { "`r" } else { [Environment]::NewLine }
  return [pscustomobject]@{
    exists = $true; path = $full; bytes = $bytes; text = $text
    hash = Get-FullmagInstallerEnvSha256 -Bytes $bytes
    encoding_name = $encodingInfo.Name; encoding = $encodingInfo.Encoding
    newline = $newline; final_newline = ($text.EndsWith($newline))
  }
}

function Assert-FullmagInstallerEnvSession {
  param([Parameter(Mandatory = $true)]$Session)
  if ([string]$Session.schema -ne "fullmag.windows-installer-env-session.v1") {
    throw "Invalid Fullmag installer environment session"
  }
  if ([string]::IsNullOrWhiteSpace([string]$Session.session_signature) -or
      -not [string]::Equals(
        (Get-FullmagInstallerEnvSessionSignature -Session $Session),
        [string]$Session.session_signature,
        [System.StringComparison]::Ordinal)) {
    throw "The installer environment session identity is invalid"
  }
  $requested = [System.IO.Path]::GetFullPath([string]$Session.requested_checkout).TrimEnd('\', '/')
  $main = Get-FullmagInstallerEnvMainCheckout -CheckoutPath $requested
  if (-not [string]::Equals($main, [string]$Session.main_checkout,
      [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The Git main checkout changed after this editor session was opened"
  }
  if (-not [string]::Equals($requested, $main, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath (Join-Path $requested ".env"))) {
    throw "A worktree-local .env is not supported; use the main checkout .env"
  }
  $mainIdentity = Get-FullmagInstallerEnvGitIdentity -MainCheckout $main
  $requestedIdentity = Get-FullmagInstallerEnvGitIdentity -MainCheckout $requested
  foreach ($property in @("top", "head", "worktrees_hash")) {
    $sessionProperty = $Session.PSObject.Properties["git_" + $property]
    if ($null -eq $sessionProperty -or -not [string]::Equals([string]$mainIdentity.$property, [string]$sessionProperty.Value,
        [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Git checkout identity changed after this editor session was opened"
    }
  }
  foreach ($property in @("top", "head", "worktrees_hash")) {
    $sessionProperty = $Session.PSObject.Properties["requested_git_" + $property]
    if ($null -eq $sessionProperty -or -not [string]::Equals([string]$requestedIdentity.$property, [string]$sessionProperty.Value,
        [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The selected source checkout identity changed after this editor session was opened"
    }
  }
  $expectedEnv = [System.IO.Path]::GetFullPath((Join-Path $main ".env")).TrimEnd('\', '/')
  $expectedTemplate = [System.IO.Path]::GetFullPath((Join-Path $requested ".env.example")).TrimEnd('\', '/')
  $expectedManifest = [System.IO.Path]::GetFullPath((Join-Path $requested "windows_build_requirements.json")).TrimEnd('\', '/')
  $expectedResolver = [System.IO.Path]::GetFullPath((Join-Path $requested "scripts\fullmag_storage.py")).TrimEnd('\', '/')
  foreach ($pair in @(
      @($Session.env_path, $expectedEnv, ".env"),
      @($Session.template_path, $expectedTemplate, ".env.example"),
      @($Session.manifest_path, $expectedManifest, "requirements manifest"),
      @($Session.resolver_script, $expectedResolver, "storage resolver")
    )) {
    if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$pair[0]).TrimEnd('\', '/'),
        [string]$pair[1], [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "The session $($pair[2]) path is not bound to the admitted checkout"
    }
  }
  $template = Read-FullmagInstallerEnvFile -Path $expectedTemplate -Label ".env.example"
  $manifest = Read-FullmagInstallerEnvFile -Path $expectedManifest -Label "requirements manifest"
  $resolver = Read-FullmagInstallerEnvFile -Path $expectedResolver -Label "storage resolver"
  foreach ($pair in @(
      @($template.hash, $Session.template_hash, ".env.example"),
      @($manifest.hash, $Session.manifest_hash, "requirements manifest"),
      @($resolver.hash, $Session.resolver_hash, "storage resolver")
    )) {
    if (-not [string]::Equals([string]$pair[0], [string]$pair[1], [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$($pair[2]) changed after this editor session was opened"
    }
  }
  $manifestObject = $manifest.text | ConvertFrom-Json -ErrorAction Stop
  $profile = [string]$manifestObject.storage.setup_profile
  if (-not [string]::Equals($profile, [string]$Session.storage_profile,
      [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The storage profile changed after this editor session was opened"
  }
  return $true
}

function Get-FullmagInstallerEnvPublicIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Session)
  Assert-FullmagInstallerEnvSession -Session $Session | Out-Null
  return [ordered]@{
    requested_checkout = [string]$Session.requested_checkout
    main_checkout = [string]$Session.main_checkout
    template_path = [string]$Session.template_path
    manifest_path = [string]$Session.manifest_path
    resolver_script = [string]$Session.resolver_script
    template_hash = [string]$Session.template_hash
    manifest_hash = [string]$Session.manifest_hash
    resolver_hash = [string]$Session.resolver_hash
    git_top = [string]$Session.git_top
    git_head = [string]$Session.git_head
    git_worktrees_hash = [string]$Session.git_worktrees_hash
    requested_git_top = [string]$Session.requested_git_top
    requested_git_head = [string]$Session.requested_git_head
    requested_git_worktrees_hash = [string]$Session.requested_git_worktrees_hash
  }
}

function Get-FullmagInstallerEnvLineRecords {
  param([Parameter(Mandatory = $true)][string]$Text)
  $records = [System.Collections.Generic.List[object]]::new()
  foreach ($match in [regex]::Matches($Text, '[^\r\n]*(?:\r\n|\n|\r|$)')) {
    if ($match.Length -eq 0) { continue }
    $whole = $match.Value
    $eol = ""
    if ($whole.EndsWith("`r`n")) { $eol = "`r`n" }
    elseif ($whole.EndsWith("`n")) { $eol = "`n" }
    elseif ($whole.EndsWith("`r")) { $eol = "`r" }
    $body = if ($eol) { $whole.Substring(0, $whole.Length - $eol.Length) } else { $whole }
    [void]$records.Add([pscustomobject]@{ body = $body; eol = $eol })
  }
  return @($records)
}

function Get-FullmagInstallerEnvAssignment {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Body)
  $match = [regex]::Match($Body, '^(?<before>\s*(?:export\s+)?)(?<key>[A-Za-z_][A-Za-z0-9_]*)(?<equals>\s*=\s*)(?<value>.*)$')
  if (-not $match.Success) { return $null }
  return $match
}

function Find-FullmagInstallerEnvCommentIndex {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  $quote = [char]0
  for ($i = 0; $i -lt $Value.Length; $i++) {
    $character = $Value[$i]
    if (($character -eq [char]39 -or $character -eq [char]34)) {
      if ($quote -eq [char]0) { $quote = $character }
      elseif ($quote -eq $character) { $quote = [char]0 }
      continue
    }
    if ($character -eq '#' -and $quote -eq [char]0 -and
        ($i -eq 0 -or [char]::IsWhiteSpace($Value[$i - 1]))) {
      $start = $i
      while ($start -gt 0 -and [char]::IsWhiteSpace($Value[$start - 1])) { $start-- }
      return $start
    }
  }
  return -1
}

function ConvertFrom-FullmagInstallerEnvValue {
  # An existing `KEY=` entry is a valid explicit empty value, so preserve it
  # through Windows PowerShell parameter binding.
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  $clean = $Value.Trim()
  $comment = Find-FullmagInstallerEnvCommentIndex -Value $clean
  if ($comment -ge 0) { $clean = $clean.Substring(0, $comment).TrimEnd() }
  if ($clean.Length -ge 2 -and
      (($clean.StartsWith('"') -and $clean.EndsWith('"')) -or
       ($clean.StartsWith("'") -and $clean.EndsWith("'")))) {
    return $clean.Substring(1, $clean.Length - 2)
  }
  return $clean
}

function Get-FullmagInstallerEnvAllowedFields {
  param(
    [Parameter(Mandatory = $true)][string]$TemplatePath,
    [Parameter(Mandatory = $true)][string]$ManifestPath
  )
  $template = Read-FullmagInstallerEnvFile -Path $TemplatePath -Label ".env.example"
  $manifest = Read-FullmagInstallerEnvFile -Path $ManifestPath -Label "requirements manifest"
  try { $manifestObject = $manifest.text | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Requirements manifest is invalid" }
  $keys = [System.Collections.Generic.List[string]]::new()
  foreach ($record in (Get-FullmagInstallerEnvLineRecords -Text $template.text)) {
    $assignment = Get-FullmagInstallerEnvAssignment -Body $record.body
    if ($null -ne $assignment -and -not $keys.Contains([string]$assignment.Groups['key'].Value)) {
      [void]$keys.Add([string]$assignment.Groups['key'].Value)
    }
  }
  if ($null -eq $manifestObject.storage -or $null -eq $manifestObject.storage.env_key) {
    throw "Requirements manifest has no storage.env_key"
  }
  $manifestKeys = @([string]$manifestObject.storage.env_key)
  if ($null -ne $manifestObject.env_keys) { $manifestKeys += @($manifestObject.env_keys | ForEach-Object { [string]$_ }) }
  foreach ($key in $manifestKeys) {
    if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Requirements manifest contains an invalid dotenv field name" }
    if (-not $keys.Contains($key)) { [void]$keys.Add($key) }
  }
  if ($keys.Count -eq 0) { throw ".env.example has no editable fields" }
  return [pscustomobject]@{
    keys = @($keys)
    secret_keys = @($keys | Where-Object { Test-FullmagInstallerEnvSecretKey $_ })
    manifest = $manifestObject
  }
}

function Get-FullmagInstallerEnvValues {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string[]]$AllowedKeys
  )
  $allowed = @{}
  foreach ($key in $AllowedKeys) { $allowed[$key] = $true }
  $values = [ordered]@{}
  foreach ($record in (Get-FullmagInstallerEnvLineRecords -Text $Text)) {
    $assignment = Get-FullmagInstallerEnvAssignment -Body $record.body
    if ($null -eq $assignment) { continue }
    $key = [string]$assignment.Groups['key'].Value
    if (-not $allowed.ContainsKey($key)) { continue }
    if ($values.Contains($key)) { throw "The .env contains duplicate managed field '$key'" }
    $values[$key] = ConvertFrom-FullmagInstallerEnvValue -Value ([string]$assignment.Groups['value'].Value)
  }
  return $values
}

function ConvertTo-FullmagInstallerEnvInputMap {
  param([Parameter()][AllowNull()]$Values)
  $result = [ordered]@{}
  if ($null -eq $Values) { return $result }
  if ($Values -is [System.Collections.IDictionary]) {
    foreach ($key in $Values.Keys) { $result[[string]$key] = $Values[$key] }
    return $result
  }
  foreach ($property in $Values.PSObject.Properties) {
    if ($property.MemberType -match 'Property') { $result[[string]$property.Name] = $property.Value }
  }
  return $result
}

function ConvertTo-FullmagInstallerEnvValueForWrite {
  param(
    [Parameter()][AllowNull()][AllowEmptyString()][string]$Value,
    [Parameter(Mandatory = $true)][string]$Key
  )
  if ($null -eq $Value) { return "" }
  if ($Value.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0) {
    throw "Value for '$Key' contains a newline or NUL"
  }
  if ($Value -notmatch '[\s#"'']') { return $Value }
  if ($Value -notmatch '"') { return "'$Value'" }
  if ($Value -notmatch "'") { return '"' + $Value + '"' }
  throw "Value for '$Key' cannot be represented safely in the dotenv editor"
}

function Get-FullmagInstallerEnvChangedLine {
  param(
    [Parameter(Mandatory = $true)][string]$Body,
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
  )
  $assignment = Get-FullmagInstallerEnvAssignment -Body $Body
  if ($null -eq $assignment -or [string]$assignment.Groups['key'].Value -ne $Key) { return $null }
  $oldValue = [string]$assignment.Groups['value'].Value
  $comment = Find-FullmagInstallerEnvCommentIndex -Value $oldValue
  $suffix = if ($comment -ge 0) { $oldValue.Substring($comment) } else { "" }
  return ([string]$assignment.Groups['before'].Value + $Key + [string]$assignment.Groups['equals'].Value +
    (ConvertTo-FullmagInstallerEnvValueForWrite -Value $Value -Key $Key) + $suffix)
}

function Set-FullmagInstallerEnvText {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Changes,
    [Parameter(Mandatory = $true)][string[]]$AllowedKeys
  )
  $records = Get-FullmagInstallerEnvLineRecords -Text $Snapshot.text
  $seen = @{}
  $output = [System.Text.StringBuilder]::new()
  foreach ($record in $records) {
    $assignment = Get-FullmagInstallerEnvAssignment -Body $record.body
    $body = $record.body
    if ($null -ne $assignment) {
      $key = [string]$assignment.Groups['key'].Value
      if ($Changes.Contains($key)) {
        if ($seen.ContainsKey($key)) { throw "The .env contains duplicate changed field '$key'" }
        $seen[$key] = $true
        $body = Get-FullmagInstallerEnvChangedLine -Body $body -Key $key -Value ([string]$Changes[$key])
      }
    }
    [void]$output.Append($body)
    [void]$output.Append($record.eol)
  }
  $missing = [System.Collections.Generic.List[string]]::new()
  foreach ($key in $AllowedKeys) {
    if ($Changes.Contains($key) -and -not $seen.ContainsKey($key)) { [void]$missing.Add($key) }
  }
  if ($missing.Count -gt 0) {
    $newline = [string]$Snapshot.newline
    $hadContent = $output.Length -gt 0
    $hadFinalNewline = $Snapshot.final_newline
    if ($hadContent -and -not $hadFinalNewline) { [void]$output.Append($newline) }
    foreach ($key in $missing) {
      [void]$output.Append($key)
      [void]$output.Append('=')
      [void]$output.Append((ConvertTo-FullmagInstallerEnvValueForWrite -Value ([string]$Changes[$key]) -Key $key))
      if ($Snapshot.final_newline -or $missing[$missing.Count - 1] -ne $key) { [void]$output.Append($newline) }
    }
  }
  return $output.ToString()
}

function ConvertTo-FullmagInstallerEnvBytes {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $body = $Snapshot.encoding.GetBytes($Text)
  $preamble = $Snapshot.encoding.GetPreamble()
  if ($preamble.Length -eq 0) { return [byte[]]$body }
  $bytes = New-Object byte[] ($preamble.Length + $body.Length)
  [System.Array]::Copy($preamble, 0, $bytes, 0, $preamble.Length)
  [System.Array]::Copy($body, 0, $bytes, $preamble.Length, $body.Length)
  return [byte[]]$bytes
}

function Invoke-FullmagInstallerEnvProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter()][hashtable]$EnvironmentOverrides = @{},
    [Parameter()][string[]]$RemoveEnvironment = @()
  )
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FilePath
  $quoted = [System.Collections.Generic.List[string]]::new()
  foreach ($argument in $Arguments) {
    $safe = ([string]$argument).TrimEnd('\')
    $safe = $safe.Replace('"', '\"')
    [void]$quoted.Add('"' + $safe + '"')
  }
  $info.Arguments = ($quoted -join ' ')
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($name in $RemoveEnvironment) { [void]$info.EnvironmentVariables.Remove($name) }
  foreach ($name in $EnvironmentOverrides.Keys) { $info.EnvironmentVariables[$name] = [string]$EnvironmentOverrides[$name] }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw "Could not start the storage resolver process" }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ exit_code = [int]$process.ExitCode; stdout = $stdout; stderr = $stderr }
  }
  finally { $process.Dispose() }
}

function Invoke-FullmagInstallerStorageResolve {
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter(Mandatory = $true)][string]$StorageRoot
  )
  $python = [string]$Session.python_command
  if ([string]::IsNullOrWhiteSpace($python)) {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $command) { throw "Python is required for read-only storage validation" }
    $python = [string]$command.Source
  }
  $resolver = [string]$Session.resolver_script
  if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) { throw "Fullmag storage resolver is missing" }
  Assert-FullmagInstallerEnvNoReparse -Path $resolver -Label "storage resolver"
  $removed = @(
    (Get-FullmagInstallerEnvInheritedSecretNames),
    "FULLMAG_PROJECT_STORAGE_ROOT", "FULLMAG_STORAGE_PROFILE", "FULLMAG_WINDOWS_VOLATILE_ROOT",
    "FULLMAG_BUILD_ROOT", "FULLMAG_CACHE_ROOT", "FULLMAG_TEMP_ROOT",
    "FULLMAG_WINDOWS_BUILD_ROOT", "FULLMAG_WINDOWS_CACHE_ROOT", "FULLMAG_WINDOWS_TEMP_ROOT",
    "FULLMAG_WINDOWS_TARGET_DIR", "FULLMAG_CARGO_TARGET_DIR", "CARGO_TARGET_DIR",
    "FULLMAG_CARGO_TARGET_ROOT", "CARGO_TARGET_ROOT", "FULLMAG_FDM_NATIVE_BUILD_ROOT",
    "FULLMAG_FRONTEND_ROOT", "FULLMAG_STORAGE_LOCK_TOKEN", "FULLMAG_STORAGE_LOCK_KEY",
    "FULLMAG_BUILD_STORAGE_ROOT", "FULLMAG_MANAGED_NATIVE_ROOT", "FULLMAG_NATIVE_BUILD_IMAGE",
    "FULLMAG_NATIVE_MOUNT_VIEW", "FULLMAG_STORAGE_USE_MANAGED_EXT4",
    "POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"
  ) | Select-Object -Unique
  $result = Invoke-FullmagInstallerEnvProcess -FilePath $python -WorkingDirectory ([string]$Session.requested_checkout) `
    -Arguments @($resolver, "resolve", "--repo-root", [string]$Session.requested_checkout,
      "--profile", [string]$Session.storage_profile, "--format", "json") `
    -EnvironmentOverrides @{ FULLMAG_PROJECT_STORAGE_ROOT = $StorageRoot; PYTHONDONTWRITEBYTECODE = "1" } `
    -RemoveEnvironment $removed
  if ($result.exit_code -ne 0) { throw "Read-only storage resolver rejected the proposed storage configuration" }
  try { $layout = $result.stdout | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Read-only storage resolver returned invalid JSON" }
  if ($null -eq $layout.storage_root -or
      -not [string]::Equals([string]$layout.storage_root, $StorageRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Read-only storage resolver returned a different storage root"
  }
  if (-not [string]::Equals([string]$layout.profile, [string]$Session.storage_profile, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Read-only storage resolver returned a different profile"
  }
  return $layout
}

function Get-FullmagInstallerEnvSession {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$CheckoutPath,
    [Parameter()][string]$TemplatePath,
    [Parameter()][string]$ManifestPath,
    [Parameter()][string]$PythonCommand
  )
  $main = Get-FullmagInstallerEnvMainCheckout -CheckoutPath $CheckoutPath
  $requestedCheckout = [System.IO.Path]::GetFullPath($CheckoutPath).TrimEnd('\', '/')
  if (-not [string]::Equals($requestedCheckout, $main, [System.StringComparison]::OrdinalIgnoreCase)) {
    $localEnv = Join-Path $requestedCheckout ".env"
    if (Test-Path -LiteralPath $localEnv) {
      throw "A worktree-local .env is not supported; use the main checkout .env"
    }
  }
  if (-not $TemplatePath) { $TemplatePath = Join-Path $requestedCheckout ".env.example" }
  if (-not $ManifestPath) { $ManifestPath = Join-Path $requestedCheckout "windows_build_requirements.json" }
  $expectedTemplate = [System.IO.Path]::GetFullPath((Join-Path $requestedCheckout ".env.example")).TrimEnd('\', '/')
  $expectedManifest = [System.IO.Path]::GetFullPath((Join-Path $requestedCheckout "windows_build_requirements.json")).TrimEnd('\', '/')
  if (-not [string]::Equals([System.IO.Path]::GetFullPath($TemplatePath).TrimEnd('\', '/'),
      $expectedTemplate, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "TemplatePath must identify the selected source checkout .env.example"
  }
  if (-not [string]::Equals([System.IO.Path]::GetFullPath($ManifestPath).TrimEnd('\', '/'),
      $expectedManifest, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ManifestPath must identify the selected source checkout requirements manifest"
  }
  $template = Assert-FullmagInstallerEnvInside -Path $expectedTemplate -Root $requestedCheckout -Label ".env.example"
  $manifest = Assert-FullmagInstallerEnvInside -Path $expectedManifest -Root $requestedCheckout -Label "requirements manifest"
  $templateSnapshot = Read-FullmagInstallerEnvFile -Path $template -Label ".env.example"
  $manifestSnapshot = Read-FullmagInstallerEnvFile -Path $manifest -Label "requirements manifest"
  $envPath = Assert-FullmagInstallerEnvInside -Path (Join-Path $main ".env") -Root $main -Label ".env"
  $fields = Get-FullmagInstallerEnvAllowedFields -TemplatePath $template -ManifestPath $manifest
  $snapshot = Read-FullmagInstallerEnvFile -Path $envPath -AllowMissing -Label ".env"
  $values = Get-FullmagInstallerEnvValues -Text $snapshot.text -AllowedKeys $fields.keys
  $python = $PythonCommand
  if (-not $python) {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command python -ErrorAction SilentlyContinue }
    if ($command) { $python = [string]$command.Source }
  }
  $manifestObject = $fields.manifest
  $profile = [string]$manifestObject.storage.setup_profile
  if ([string]::IsNullOrWhiteSpace($profile)) { throw "Requirements manifest has no storage setup profile" }
  $resolver = Join-Path $requestedCheckout "scripts\fullmag_storage.py"
  if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) { throw "Fullmag storage resolver is missing" }
  $gitIdentity = Get-FullmagInstallerEnvGitIdentity -MainCheckout $main
  $requestedGitIdentity = Get-FullmagInstallerEnvGitIdentity -MainCheckout $requestedCheckout
  $session = [pscustomobject][ordered]@{
    schema = "fullmag.windows-installer-env-session.v1"
    session_id = ([guid]::NewGuid().ToString('N'))
    requested_checkout = $requestedCheckout
    main_checkout = $main; env_path = (Join-Path $main ".env")
    template_path = $expectedTemplate; manifest_path = $expectedManifest
    resolver_script = $resolver; python_command = $python; storage_profile = $profile
    original_hash = $snapshot.hash; original_exists = [bool]$snapshot.exists
    encoding = $snapshot.encoding_name; newline = $snapshot.newline
    template_hash = $templateSnapshot.hash; manifest_hash = $manifestSnapshot.hash; resolver_hash = (Read-FullmagInstallerEnvFile -Path $resolver -Label "storage resolver").hash
    git_top = $gitIdentity.top; git_head = $gitIdentity.head; git_worktrees_hash = $gitIdentity.worktrees_hash
    requested_git_top = $requestedGitIdentity.top; requested_git_head = $requestedGitIdentity.head; requested_git_worktrees_hash = $requestedGitIdentity.worktrees_hash
    allowed_fields = @($fields.keys); secret_fields = @($fields.secret_keys); fields = @()
  }
  $session | Add-Member -NotePropertyName session_signature -NotePropertyValue (Get-FullmagInstallerEnvSessionSignature -Session $session)
  $fieldObjects = [System.Collections.Generic.List[object]]::new()
  foreach ($key in $fields.keys) {
    $current = if ($values.Contains($key)) { [string]$values[$key] } else { $null }
    [void]$fieldObjects.Add([pscustomobject][ordered]@{
        key = $key; secret = (Test-FullmagInstallerEnvSecretKey $key)
        present = $values.Contains($key)
        current_value = Get-FullmagInstallerEnvRedactedValue -Value $current -Key $key
      })
  }
  $session.fields = @($fieldObjects)
  return $session
}

function Get-FullmagInstallerEnvSessionChanges {
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter()][AllowNull()]$Values
  )
  if ([string]$Session.schema -ne "fullmag.windows-installer-env-session.v1") { throw "Invalid Fullmag installer environment session" }
  $inputMap = ConvertTo-FullmagInstallerEnvInputMap -Values $Values
  $allowed = @{}
  foreach ($key in @($Session.allowed_fields)) { $allowed[[string]$key] = $true }
  $changes = [ordered]@{}
  foreach ($key in $inputMap.Keys) {
    if (-not $allowed.ContainsKey([string]$key)) { throw "Field '$key' is not declared by .env.example or the requirements manifest" }
    if ($null -eq $inputMap[$key] -and (Test-FullmagInstallerEnvSecretKey ([string]$key))) { continue }
    $value = if ($null -eq $inputMap[$key]) { "" } else { [string]$inputMap[$key] }
    if ((Test-FullmagInstallerEnvSecretKey ([string]$key)) -and
        ($value -eq (Get-FullmagInstallerEnvSecretToken) -or $value -eq "__FULLMAG_KEEP_SECRET__")) { continue }
    if ($value.IndexOfAny([char[]]@("`r", "`n", [char]0)) -ge 0) { throw "Field '$key' contains an invalid newline or NUL" }
    $changes[[string]$key] = $value
  }
  return $changes
}

function Test-FullmagInstallerEnvPathProposal {
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Current,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Effective,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Changes
  )
  $storageKey = "FULLMAG_PROJECT_STORAGE_ROOT"
  $currentStorage = if ($Current.Contains($storageKey)) { [string]$Current[$storageKey] } else { "" }
  $proposedStorage = if ($Effective.Contains($storageKey)) { [string]$Effective[$storageKey] } else { "" }
  if ([string]::IsNullOrWhiteSpace($proposedStorage)) {
    throw "FULLMAG_PROJECT_STORAGE_ROOT must be selected explicitly"
  }
  $storage = ConvertTo-FullmagInstallerEnvFullPath -Path $proposedStorage -Label $storageKey
  if ($Changes.Contains($storageKey) -and -not [string]::IsNullOrWhiteSpace($currentStorage)) {
    $existing = ConvertTo-FullmagInstallerEnvFullPath -Path $currentStorage -Label $storageKey
    if (-not [string]::Equals($existing, $storage, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Existing FULLMAG_PROJECT_STORAGE_ROOT conflicts with the proposed path"
    }
    # A canonically identical path is not an edit. Keep the original line
    # byte-for-byte, including its slash spelling, quoting and whitespace.
    $Changes.Remove($storageKey)
    $Effective[$storageKey] = $currentStorage
  }
  $volatileKey = "FULLMAG_WINDOWS_VOLATILE_ROOT"
  if ($Effective.Contains($volatileKey) -and -not [string]::IsNullOrWhiteSpace([string]$Effective[$volatileKey])) {
    $volatile = ConvertTo-FullmagInstallerEnvFullPath -Path ([string]$Effective[$volatileKey]) -Label $volatileKey
    $projectRoot = [System.IO.Path]::GetFullPath(([string]$Session.main_checkout + "\.." )).TrimEnd('\', '/')
    if ([string]::Equals($volatile, $projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $volatile.StartsWith($projectRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($projectRoot, $volatile, [System.StringComparison]::OrdinalIgnoreCase) -or
        $projectRoot.StartsWith($volatile + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$volatileKey must remain outside the project and checkout roots"
    }
    if ([string]::Equals($volatile, $storage, [System.StringComparison]::OrdinalIgnoreCase) -or
        $volatile.StartsWith($storage + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $storage.StartsWith($volatile + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$volatileKey must remain separate from project storage"
    }
    $Effective[$volatileKey] = $volatile
  }
  $layout = Invoke-FullmagInstallerStorageResolve -Session $Session -StorageRoot $storage
  return [pscustomobject]@{ storage_root = $storage; layout = $layout }
}

function Get-FullmagInstallerEnvProposalInternal {
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter()][AllowNull()]$Values
  )
  Assert-FullmagInstallerEnvSession -Session $Session | Out-Null
  $snapshot = Read-FullmagInstallerEnvFile -Path ([string]$Session.env_path) -AllowMissing -Label ".env"
  if ([string]$snapshot.hash -ne [string]$Session.original_hash) {
    throw "The .env changed after this editor session was opened"
  }
  $current = Get-FullmagInstallerEnvValues -Text $snapshot.text -AllowedKeys @($Session.allowed_fields)
  $changes = Get-FullmagInstallerEnvSessionChanges -Session $Session -Values $Values
  $effective = [ordered]@{}
  foreach ($key in $current.Keys) { $effective[$key] = [string]$current[$key] }
  foreach ($key in $changes.Keys) { $effective[$key] = [string]$changes[$key] }
  $pathValidation = Test-FullmagInstallerEnvPathProposal -Session $Session -Current $current -Effective $effective -Changes $changes
  $newText = Set-FullmagInstallerEnvText -Snapshot $snapshot -Changes $changes -AllowedKeys @($Session.allowed_fields)
  $newBytes = ConvertTo-FullmagInstallerEnvBytes -Snapshot $snapshot -Text $newText
  $newHash = Get-FullmagInstallerEnvSha256 -Bytes $newBytes
  $changedKeys = [System.Collections.Generic.List[string]]::new()
  $diff = [System.Collections.Generic.List[string]]::new()
  foreach ($key in @($Session.allowed_fields)) {
    if (-not $changes.Contains($key)) { continue }
    $old = if ($current.Contains($key)) { [string]$current[$key] } else { $null }
    $new = if ($effective.Contains($key)) { [string]$effective[$key] } else { "" }
    # An absent key and an explicitly empty key stringify identically. Keep
    # the presence transition visible in the preview and hash proposal; only
    # an existing key with the same value is a no-op.
    if ($current.Contains($key) -and [string]$old -eq [string]$new) { continue }
    [void]$changedKeys.Add($key)
    [void]$diff.Add("-$key=" + (Get-FullmagInstallerEnvRedactedValue -Value $old -Key $key))
    [void]$diff.Add("+$key=" + (Get-FullmagInstallerEnvRedactedValue -Value $new -Key $key))
  }
  return [pscustomobject]@{
    snapshot = $snapshot; current = $current; changes = $changes; effective = $effective
    new_text = $newText; new_bytes = $newBytes; new_hash = $newHash
    changed_keys = @($changedKeys); diff = @($diff); storage_root = $pathValidation.storage_root
    layout = $pathValidation.layout; write_required = ($newHash -ne $snapshot.hash)
  }
}

function Convert-FullmagInstallerEnvProposalToPublic {
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter(Mandatory = $true)]$Proposal,
    [Parameter()][bool]$Valid = $true,
    [Parameter()][string[]]$Errors = @(),
    [Parameter()][string]$State = "validated"
  )
  return [pscustomobject][ordered]@{
    schema = "fullmag.windows-installer-env-proposal.v1"
    state = $State; valid = $Valid; can_commit = [bool]$Valid
    write_required = [bool]$Proposal.write_required
    env_path = [string]$Session.env_path; main_checkout = [string]$Session.main_checkout
    storage_profile = [string]$Session.storage_profile; storage_root = [string]$Proposal.storage_root
    runs_root = if ($null -ne $Proposal.layout) { [string]$Proposal.layout.runs_root } else { "" }
    original_hash = [string]$Proposal.snapshot.hash; proposed_hash = [string]$Proposal.new_hash
    changed_fields = @($Proposal.changed_keys); redacted_diff = (@($Proposal.diff) -join "`n")
    errors = @($Errors); backup_path = $null; wrote = $false
  }
}

function Test-FullmagInstallerEnvProposal {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter()][AllowNull()][Alias("Changes")]$Values
  )
  try {
    $proposal = Get-FullmagInstallerEnvProposalInternal -Session $Session -Values $Values
    return Convert-FullmagInstallerEnvProposalToPublic -Session $Session -Proposal $proposal
  }
  catch {
    return [pscustomobject][ordered]@{
      schema = "fullmag.windows-installer-env-proposal.v1"; state = "blocked"; valid = $false; can_commit = $false; write_required = $false
      env_path = [string]$Session.env_path; main_checkout = [string]$Session.main_checkout
      storage_profile = [string]$Session.storage_profile; storage_root = $null; runs_root = $null
      original_hash = [string]$Session.original_hash; proposed_hash = $null; changed_fields = @(); redacted_diff = ""
      errors = @([string]$_.Exception.Message); backup_path = $null; wrote = $false
    }
  }
}

function Get-FullmagInstallerEnvPreview {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter()][AllowNull()][Alias("Changes")]$Values
  )
  return Test-FullmagInstallerEnvProposal -Session $Session -Values $Values
}

function Get-FullmagInstallerEnvLock {
  param([Parameter(Mandatory = $true)][string]$EnvPath)
  $lockPath = $EnvPath + ".fullmag-installer.lock"
  Assert-FullmagInstallerEnvNoReparse -Path $lockPath -Label ".env editor lock"
  try {
    return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  }
  catch { throw "Another .env editor transaction is active" }
}

function Protect-FullmagInstallerEnvBackup {
  param([Parameter(Mandatory = $true)][string]$Path)
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $currentSid, $fullControl, $inheritance, $propagation, $allow))
  foreach ($sidValue in @("S-1-5-18", "S-1-5-32-544")) {
    try {
      $account = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
      [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
          $account, $fullControl, $inheritance, $propagation, $allow))
    }
    catch { throw "Could not secure the .env backup ACL" }
  }
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Test-FullmagInstallerEnvPrivateAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) { return $false }
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowedSids = @($currentSid, "S-1-5-18", "S-1-5-32-544")
    $seenSids = @{}
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    foreach ($rule in @($acl.Access)) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
          $rule.IsInherited -or
          $rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None -or
          $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
          (([int]$rule.FileSystemRights -band [int]$fullControl) -ne [int]$fullControl)) {
        return $false
      }
      try {
        $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      }
      catch { return $false }
      if ($allowedSids -notcontains $sid) { return $false }
      $seenSids[$sid] = $true
    }
    foreach ($sid in $allowedSids) {
      if (-not $seenSids.ContainsKey($sid)) { return $false }
    }
    return $true
  }
  catch { return $false }
}

function Assert-FullmagInstallerEnvPrivateAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter()][string]$Label = "backup"
  )
  if (-not (Test-FullmagInstallerEnvPrivateAcl -Path $Path)) {
    Protect-FullmagInstallerEnvBackup -Path $Path
  }
  if (-not (Test-FullmagInstallerEnvPrivateAcl -Path $Path)) {
    throw "$Label does not have a private ACL"
  }
}

function Get-FullmagInstallerEnvBackupPath {
  param([Parameter(Mandatory = $true)]$Proposal)
  $storageRoot = [System.IO.Path]::GetFullPath([string]$Proposal.storage_root).TrimEnd('\', '/')
  Assert-FullmagInstallerEnvNoReparse -Path $storageRoot -Label "project storage"
  $parent = Join-Path $storageRoot "tmp\host-config-backups"
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
  }
  Assert-FullmagInstallerEnvNoReparse -Path $parent -Label "host configuration backup directory"
  Assert-FullmagInstallerEnvPrivateAcl -Path $parent -Label "host configuration backup directory"
  foreach ($existing in @(Get-ChildItem -LiteralPath $parent -File -Filter ".env.backup.*" -Force -ErrorAction Stop)) {
    Assert-FullmagInstallerEnvNoReparse -Path $existing.FullName -Label ".env backup"
    Assert-FullmagInstallerEnvPrivateAcl -Path $existing.FullName -Label ".env backup"
  }
  do {
    $name = ".env.backup.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')).$([guid]::NewGuid().ToString('N'))"
    $path = Join-Path $parent $name
  } while (Test-Path -LiteralPath $path)
  Assert-FullmagInstallerEnvNoReparse -Path $path -Label ".env backup"
  return $path
}

function Write-FullmagInstallerEnvTransaction {
  param(
    [Parameter(Mandatory = $true)]$Proposal,
    [Parameter(Mandatory = $true)][string]$EnvPath
  )
  if (-not $Proposal.write_required) {
    return [pscustomobject]@{ wrote = $false; backup_path = $null }
  }
  $parent = Split-Path -Parent $EnvPath
  Assert-FullmagInstallerEnvNoReparse -Path $parent -Label ".env parent"
  $temp = Join-Path $parent (".env.tmp." + [guid]::NewGuid().ToString('N'))
  Assert-FullmagInstallerEnvNoReparse -Path $temp -Label ".env temporary file"
  $backup = $null
  $replaced = $false
  $concurrentMutation = $false
  try {
    $stream = [System.IO.File]::Open($temp, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $stream.Write($Proposal.new_bytes, 0, $Proposal.new_bytes.Length)
      $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    $beforeReplace = Read-FullmagInstallerEnvFile -Path $EnvPath -AllowMissing -Label ".env"
    if ([string]$beforeReplace.hash -ne [string]$Proposal.snapshot.hash) {
      throw "The .env changed while the transaction was being admitted"
    }
    if ($null -ne $script:FullmagInstallerEnvBeforeReplaceHook) {
      & $script:FullmagInstallerEnvBeforeReplaceHook $EnvPath | Out-Null
    }
    $atReplace = Read-FullmagInstallerEnvFile -Path $EnvPath -AllowMissing -Label ".env"
    if ([bool]$atReplace.exists -ne [bool]$Proposal.snapshot.exists -or
        [string]$atReplace.hash -ne [string]$Proposal.snapshot.hash) {
      $concurrentMutation = $true
      throw "The .env changed at the replacement boundary; latest content was preserved"
    }
    if ($atReplace.exists) {
      $backup = Get-FullmagInstallerEnvBackupPath -Proposal $Proposal
      [System.IO.File]::Replace($temp, $EnvPath, $backup, $true)
      $replaced = $true
      Assert-FullmagInstallerEnvNoReparse -Path $backup -Label ".env backup"
      Assert-FullmagInstallerEnvPrivateAcl -Path $backup -Label ".env backup"
    }
    else {
      [System.IO.File]::Move($temp, $EnvPath)
      $replaced = $true
    }
    if ($null -ne $script:FullmagInstallerEnvAfterReplaceHook) {
      & $script:FullmagInstallerEnvAfterReplaceHook $EnvPath | Out-Null
    }
    $target = Read-FullmagInstallerEnvFile -Path $EnvPath -Label ".env"
    if ($target.hash -ne $Proposal.new_hash) {
      $concurrentMutation = $true
      throw "The .env changed concurrently; latest content was preserved"
    }
    if ($backup) {
      $backupSnapshot = Read-FullmagInstallerEnvFile -Path $backup -Label ".env backup"
      if ($backupSnapshot.hash -ne $Proposal.snapshot.hash) {
        $concurrentMutation = $true
        throw "The .env changed concurrently; latest content was preserved"
      }
    }
    $finalTarget = Read-FullmagInstallerEnvFile -Path $EnvPath -Label ".env"
    if ($finalTarget.hash -ne $Proposal.new_hash) {
      $concurrentMutation = $true
      throw "The .env changed concurrently; latest content was preserved"
    }
    return [pscustomobject]@{ wrote = $true; backup_path = $backup }
  }
  catch {
    if ($concurrentMutation) {
      $currentAfterFailure = Read-FullmagInstallerEnvFile -Path $EnvPath -AllowMissing -Label ".env"
      if ($backup -and (Test-Path -LiteralPath $backup -PathType Leaf) -and
          [string]$currentAfterFailure.hash -eq [string]$Proposal.new_hash) {
        $backupSnapshot = Read-FullmagInstallerEnvFile -Path $backup -Label ".env backup"
        if ([string]$backupSnapshot.hash -ne [string]$Proposal.snapshot.hash) {
          throw "The .env changed concurrently; automatic recovery is ambiguous and manual recovery is required"
        }
        $restoreTemp = Join-Path $parent (".env.recovery." + [guid]::NewGuid().ToString('N'))
        $restored = $false
        $recoveryMessage = $null
        try {
          # Stage a verified original beside the destination. The final
          # replacement is guarded by a fresh hash read and remains bounded by
          # the cooperative .env lock contract; no File.Copy overwrites .env.
          Assert-FullmagInstallerEnvNoReparse -Path $restoreTemp -Label ".env recovery temporary file"
          [System.IO.File]::Copy($backup, $restoreTemp, $false)
          Assert-FullmagInstallerEnvNoReparse -Path $restoreTemp -Label ".env recovery temporary file"
          Assert-FullmagInstallerEnvPrivateAcl -Path $restoreTemp -Label ".env recovery temporary file"
          $beforeRecovery = Read-FullmagInstallerEnvFile -Path $EnvPath -Label ".env"
          if ([string]$beforeRecovery.hash -ne [string]$Proposal.new_hash) {
            throw "The .env changed concurrently; current content was preserved and automatic recovery was skipped"
          }
          [System.IO.File]::Replace($restoreTemp, $EnvPath, $null, $true)
          $restoredSnapshot = Read-FullmagInstallerEnvFile -Path $EnvPath -Label ".env"
          $restored = [string]$restoredSnapshot.hash -eq [string]$backupSnapshot.hash
        }
        catch { $recoveryMessage = [string]$_.Exception.Message }
        finally {
          if (Test-Path -LiteralPath $restoreTemp) {
            Remove-Item -LiteralPath $restoreTemp -Force -ErrorAction SilentlyContinue
          }
        }
        if ($restored) {
          throw "The .env changed concurrently; latest content was restored from the verified backup"
        }
        if ($recoveryMessage -match "current content was preserved") { throw $recoveryMessage }
        throw "The .env changed concurrently; automatic recovery is ambiguous and manual recovery is required"
      }
      throw "The .env changed concurrently; latest content was preserved and automatic recovery was skipped"
    }
    if ($replaced -and $backup -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
      $rollback = Join-Path $parent (".env.rollback." + [guid]::NewGuid().ToString('N'))
      try {
        $backupSnapshot = Read-FullmagInstallerEnvFile -Path $backup -Label ".env backup"
        if ([string]$backupSnapshot.hash -ne [string]$Proposal.snapshot.hash) {
          throw "The .env transaction failed; the verified backup is unavailable for rollback"
        }
        Assert-FullmagInstallerEnvNoReparse -Path $rollback -Label ".env rollback temporary file"
        [System.IO.File]::Copy($backup, $rollback, $false)
        Assert-FullmagInstallerEnvNoReparse -Path $rollback -Label ".env rollback temporary file"
        Assert-FullmagInstallerEnvPrivateAcl -Path $rollback -Label ".env rollback temporary file"
        $beforeRollback = Read-FullmagInstallerEnvFile -Path $EnvPath -Label ".env"
        if ([string]$beforeRollback.hash -ne [string]$Proposal.new_hash) {
          throw "The .env transaction failed; current content changed and manual recovery is required"
        }
        [System.IO.File]::Replace($rollback, $EnvPath, $null, $true)
      }
      catch { throw "The .env transaction failed; automatic rollback was not completed and manual recovery is required" }
      finally {
        if (Test-Path -LiteralPath $rollback) {
          Remove-Item -LiteralPath $rollback -Force -ErrorAction SilentlyContinue
        }
      }
    }
    throw
  }
  finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
}

function Commit-FullmagInstallerEnvProposal {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Session,
    [Parameter()][AllowNull()][Alias("Changes")]$Values
  )
  $lock = $null
  $lockAcquired = $false
  try {
    $lock = Get-FullmagInstallerEnvLock -EnvPath ([string]$Session.env_path)
    $lockAcquired = $true
    $proposal = Get-FullmagInstallerEnvProposalInternal -Session $Session -Values $Values
    $write = Write-FullmagInstallerEnvTransaction -Proposal $proposal -EnvPath ([string]$Session.env_path)
    $result = Convert-FullmagInstallerEnvProposalToPublic -Session $Session -Proposal $proposal
    $result.state = if ($write.wrote) { "committed" } else { "unchanged" }
    $result.can_commit = $false
    $result.backup_path = $write.backup_path
    $result.wrote = [bool]$write.wrote
    return $result
  }
  finally {
    if ($null -ne $lock) { $lock.Dispose() }
    $lockPath = ([string]$Session.env_path) + ".fullmag-installer.lock"
    if ($lockAcquired -and (Test-Path -LiteralPath $lockPath)) {
      Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Cancel-FullmagInstallerEnvProposal {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Session)
  Assert-FullmagInstallerEnvSession -Session $Session | Out-Null
  return [pscustomobject][ordered]@{
    schema = "fullmag.windows-installer-env-proposal.v1"; state = "canceled"; valid = $true; can_commit = $false; write_required = $false
    env_path = [string]$Session.env_path; main_checkout = [string]$Session.main_checkout
    original_hash = [string]$Session.original_hash; changed_fields = @(); redacted_diff = ""; errors = @(); wrote = $false
  }
}
