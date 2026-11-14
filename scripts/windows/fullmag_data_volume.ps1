param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Plan', 'Create', 'Attach', 'Inspect')]
    [string]$Mode,
    [Parameter(Mandatory = $true)][string]$RequestFile,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$RequestSha256,
    [string]$CreatedReceiptSha256 = ''
)

# This helper never deletes a file or formats a Windows disk. Its only data
# write on the backing drive is New-VHD without an overwrite/force option.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-Sha256([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Read-Request {
    $raw = [IO.File]::ReadAllBytes($RequestFile)
    if ($raw.Length -gt 65536 -or (Get-Sha256 $raw) -cne $RequestSha256) {
        throw 'Provision request bytes or digest differ'
    }
    $value = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
    $keys = @('schema', 'volume_id', 'backing_root_windows', 'backing_file_windows',
              'backing_file_wsl', 'capacity_bytes', 'wsl_distro', 'storage_root_wsl',
              'result_directory_windows')
    if (@(Compare-Object ($keys | Sort-Object) ($value.PSObject.Properties.Name | Sort-Object)).Length -ne 0) {
        throw 'Provision request fields differ from the closed contract'
    }
    if ($value.schema -cne 'fullmag.wsl-data-volume-provision.v1' -or
        $value.volume_id -cnotmatch '^[0-9a-f]{32}$' -or $value.volume_id -ceq ('0' * 32) -or
        $value.wsl_distro -cnotmatch '^[A-Za-z0-9_-]{1,80}$') {
        throw 'Provision request identity differs'
    }
    if (($value.capacity_bytes -isnot [long] -and $value.capacity_bytes -isnot [int]) -or
        $value.capacity_bytes -lt 1073741824 -or $value.capacity_bytes -gt 1099511627776) {
        throw 'Provision capacity must be an integer between 1 GiB and 1 TiB'
    }
    foreach ($path in @($value.backing_root_windows, $value.backing_file_windows)) {
        if ($path -isnot [string] -or $path -cnotmatch '^[A-Za-z]:\\' -or
            $path -match '[\x00-\x1f]' -or $path.Contains('/') -or
            -not [string]::Equals([IO.Path]::GetFullPath($path), $path, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Backing path must be a canonical local-drive path'
        }
        foreach ($component in $path.Substring(3).Split('\')) {
            if (-not $component -or $component -in @('.', '..') -or
                $component.EndsWith('.') -or $component.EndsWith(' ') -or
                $component.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
                $component -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') {
                throw 'Backing path component is invalid'
            }
        }
    }
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($value.backing_file_windows),
                             $value.backing_root_windows, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetExtension($value.backing_file_windows).ToLowerInvariant() -cne '.vhdx') {
        throw 'Only one new VHDX directly beneath the approved backing root is allowed'
    }
    $mapped = '/mnt/' + $value.backing_file_windows.Substring(0, 1).ToLowerInvariant() +
              '/' + $value.backing_file_windows.Substring(3).Replace('\', '/')
    if ($mapped -cne $value.backing_file_wsl) { throw 'Windows/WSL backing paths differ' }
    if ($value.storage_root_wsl -isnot [string] -or
        $value.storage_root_wsl -cnotmatch '^/[A-Za-z0-9_./-]+$' -or
        $value.storage_root_wsl -match '(^|/)(\.|\.\.)(/|$)' -or
        $value.storage_root_wsl.EndsWith('/') -or $value.storage_root_wsl.Contains('//') -or
        $value.storage_root_wsl -cnotmatch '^/(home|srv)/' -or
        -not $value.storage_root_wsl.EndsWith('/storage')) {
        throw 'Operational storage must be a canonical WSL path'
    }
    $expectedResult = '\\wsl.localhost\' + $value.wsl_distro +
        $value.storage_root_wsl.Replace('/', '\') + '\migrations\data-volumes\' + $value.volume_id
    if ($value.result_directory_windows -cne $expectedResult) {
        throw 'Result files must remain under the exact WSL operational migration root'
    }
    return $value
}

function Assert-NoReparse([string]$Path) {
    $current = Get-Item -LiteralPath $Path -Force
    while ($null -ne $current) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Backing path traverses a reparse point'
        }
        if ($current -is [IO.FileInfo]) { $current = $current.Directory }
        elseif ($current -is [IO.DirectoryInfo]) { $current = $current.Parent }
        else { throw 'Backing item is not a regular file or directory' }
    }
}

function Write-ResultOnce([string]$Name, $Value) {
    $path = Join-Path $script:request.result_directory_windows $Name
    $raw = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress) + "`n")
    $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($raw, 0, $raw.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}

function Get-ImageMetadata {
    Assert-NoReparse $script:request.backing_file_windows
    $image = Get-VHD -Path $script:request.backing_file_windows -ErrorAction Stop
    $file = Get-Item -LiteralPath $script:request.backing_file_windows -Force
    if ($image.VhdFormat -ne 'VHDX' -or $image.VhdType -ne 'Dynamic' -or
        $image.Size -ne $script:request.capacity_bytes -or
        -not [string]::Equals($image.Path, $script:request.backing_file_windows, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Observed VHDX identity, format or capacity differs'
    }
    return @{ path = $file.FullName; disk_identifier = $image.DiskIdentifier.ToString().ToLowerInvariant();
              capacity_bytes = [long]$image.Size; creation_utc_ticks = $file.CreationTimeUtc.Ticks;
              file_size_bytes = [long]$file.Length }
}

try {
    $script:request = Read-Request
    $common = @{ schema = 'fullmag.wsl-data-volume-platform-result.v1';
                 volume_id = $request.volume_id; request_sha256 = $RequestSha256 }
    if ($Mode -eq 'Plan') {
        $value = $common.Clone()
        $value.state = 'planned-read-only'; $value.mutated = $false
        $value.backing_file_windows = $request.backing_file_windows
        $value.capacity_bytes = $request.capacity_bytes
        $value.allowed_image_operations = @('create-new', 'inspect', 'attach')
        $value | ConvertTo-Json -Depth 10 -Compress
        exit 0
    }
    if ($Mode -eq 'Inspect') {
        $value = $common.Clone(); $value.state = 'observed-read-only'; $value.mutated = $false
        $value.image = Get-ImageMetadata
        $value | ConvertTo-Json -Depth 10 -Compress
        exit 0
    }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Creating or attaching the new VHDX requires an elevated operator process'
    }
    Assert-NoReparse $request.backing_root_windows
    if (-not [IO.Directory]::Exists($request.result_directory_windows)) {
        throw 'The registered WSL result directory must already exist'
    }
    if ($Mode -eq 'Create') {
        if (Test-Path -LiteralPath $request.backing_file_windows) {
            throw 'Image already exists; create-new refuses to overwrite or adopt it'
        }
        $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($request.backing_file_windows))
        if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -notin @('NTFS', 'ReFS') -or
            $drive.AvailableFreeSpace -lt ($request.capacity_bytes + 107374182400)) {
            throw 'Backing drive must be fixed NTFS/ReFS with full capacity plus 100 GiB headroom'
        }
        $prepared = $common.Clone(); $prepared.state = 'prepared-create-new'
        Write-ResultOnce 'prepared.json' $prepared
        $null = New-VHD -Path $request.backing_file_windows -Dynamic -SizeBytes $request.capacity_bytes -ErrorAction Stop
        $created = $common.Clone(); $created.state = 'created'; $created.image = Get-ImageMetadata
        Write-ResultOnce 'created.json' $created
        $created | ConvertTo-Json -Depth 10 -Compress
        exit 0
    }
    if ($CreatedReceiptSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Attach requires the exact create receipt' }
    $createdRaw = [IO.File]::ReadAllBytes((Join-Path $request.result_directory_windows 'created.json'))
    if ((Get-Sha256 $createdRaw) -cne $CreatedReceiptSha256) { throw 'Create receipt digest differs' }
    $created = [Text.Encoding]::UTF8.GetString($createdRaw) | ConvertFrom-Json
    $observed = Get-ImageMetadata
    if ($created.schema -cne $common.schema -or $created.state -cne 'created' -or
        $created.volume_id -cne $request.volume_id -or $created.request_sha256 -cne $RequestSha256 -or
        $created.image.disk_identifier -cne $observed.disk_identifier -or
        $created.image.creation_utc_ticks -ne $observed.creation_utc_ticks -or
        $created.image.capacity_bytes -ne $observed.capacity_bytes -or
        -not [string]::Equals($created.image.path, $observed.path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Attach image no longer matches the owned create receipt'
    }
    if (Test-Path -LiteralPath (Join-Path $request.result_directory_windows 'attached.json')) {
        throw 'Attach receipt already exists; inspect/recover instead of replaying'
    }
    $wslExe = Join-Path $env:SystemRoot 'System32\wsl.exe'
    $nativeOutput = & $wslExe '--mount' $request.backing_file_windows '--vhd' '--bare' 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('WSL attach failed: ' + ($nativeOutput -join ' ')) }
    $attached = $common.Clone(); $attached.state = 'attached-not-formatted'; $attached.image = $observed
    $attached.create_receipt_sha256 = $CreatedReceiptSha256
    Write-ResultOnce 'attached.json' $attached
    $attached | ConvertTo-Json -Depth 10 -Compress
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
