"""Read-only Windows bind isolation from one registered WSL-native DEV store.

This separate proof does not relax the same-device kernel proof v1. It proves
one exact foreign bind only, never the authority of the foreign application.
"""
from __future__ import annotations

import hashlib
import json
import ntpath
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import subprocess
import sys
import time

from docker_build_control import BuildControlError, bounded_capture, canonical, docker_capture
from docker_compose_identity import compose_project_identity, validate_source_labels

SCHEMA = "fullmag.foreign-windows-bind-disjoint-proof.v2"
NATIVE_SCHEMA = "fullmag.windows-bind-native-identity.v1"
MAX_BYTES = 1024 * 1024
MAX_DESCENDANT_ENTRIES = 100000
DESCENDANT_BUDGET_MS = 15000
INVENTORY_SCHEMA = "fullmag.windows-contained-topology.v2"
MAX_RELATIVE_LINKS = 256
MAX_RELATIVE_LINK_HOPS = 16
SHA = re.compile(r"[0-9a-f]{64}\Z")
CID = re.compile(r"[0-9a-f]{64}\Z")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}\Z")
BACKINGS = {"wsl-current", "wsl-docker-desktop", "docker-desktop-data"}
PROOF_FIELDS = {"schema", "decision", "container_id", "source_sha256",
                "context", "before", "after", "provider_sha256"}
OBSERVATION_FIELDS = {"engine", "backend", "foreign", "linux", "mapping", "native", "contained_links"}


class WindowsBindObservationDrift(BuildControlError):
    """Two individually valid observations differ; no proof was accepted."""

    def __init__(self, differences):
        self.differences = tuple(differences)
        ordinary_inventory = {
            "observation.native.candidate.descendants.entries",
            "observation.native.candidate.descendants.directories",
            "observation.native.candidate.descendants.files",
            "observation.native.candidate.descendants.sha256",
        }
        self.ordinary_inventory_only = bool(self.differences) and set(self.differences) <= ordinary_inventory
        super().__init__("Windows isolation identities drifted: " + ", ".join(self.differences))

# No Add-Type, compilation, temporary files or candidate contents are used.
# Microsoft: hard links cannot refer to files on different volumes.
# https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions
# Candidate files and same-serial backing files require native NumberOfLinks=1
# on their exact file handle. Different-serial backings retain full identity but
# mark link qualification as unassessed (null); no query failure is reinterpreted.
WINDOWS_PATH_PROVIDER = r"""
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=([Console]::In.ReadToEnd() | ConvertFrom-Json)
function Canonical($value) {
    if ($value.StartsWith('\\?\')) { $value=$value.Substring(4) }
    if ($value -notmatch '^[A-Za-z]:[\\/]' -or $value -match '[\x00-\x1f,]') { throw 'local Windows path required' }
    $path=[IO.Path]::GetFullPath($value)
    if ($path.Substring(2).Contains(':')) { throw 'alternate stream refused' }
    return $path.TrimEnd('\')
}
function NoReparse($path) {
    $cursor=$path
    while ($cursor) {
        # GetFileAttributes reports the link's own attributes, not its target.
        # https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileattributesw
        $attributes=[int][IO.File]::GetAttributes($cursor)
        if (($attributes -band 0x400) -ne 0) { throw 'reparse ancestor refused' }
        $parent=[IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { $cursor=$null } else { $cursor=$parent.FullName }
    }
}
# Metadata-only handles: desired access 0, OPEN_EXISTING, share R/W/delete;
# BACKUP_SEMANTICS opens directories and OPEN_REPARSE_POINT never follows leaf links.
# https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info
# https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info
$idAssemblyName=[Reflection.AssemblyName]::new('FullmagWindowsFileIdentity')
$idAssembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($idAssemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)
$idModule=$idAssembly.DefineDynamicModule('FileIdentity')
$idType=$idModule.DefineType('FullmagWindowsFileIdentity',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$idFlags=[Reflection.MethodAttributes]'Public,Static,PinvokeImpl'
$open=$idType.DefinePInvokeMethod('CreateFileW','kernel32.dll',$idFlags,
    [Reflection.CallingConventions]::Standard,[IntPtr],
    [Type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr]),
    [Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$open.SetImplementationFlags($open.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
$query=$idType.DefinePInvokeMethod('GetFileInformationByHandleEx','kernel32.dll',$idFlags,
    [Reflection.CallingConventions]::Standard,[int],[Type[]]@([IntPtr],[int],[IntPtr],[uint32]),
    [Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$query.SetImplementationFlags($query.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
$closeId=$idType.DefinePInvokeMethod('CloseHandle','kernel32.dll',$idFlags,
    [Reflection.CallingConventions]::Standard,[int],[Type[]]@([IntPtr]),
    [Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$closeId.SetImplementationFlags($closeId.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
$fileMetadata=$idType.CreateType()
function ReadFileIdentity($path) {
    if ($path.IndexOfAny([char[]]'"*?') -ge 0) { throw 'literal metadata path required' }
    $buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    $handle=[IntPtr]::new(-1)
    try {
        $handle=$fileMetadata::CreateFileW(('\\?\'+$path),0,7,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
        if ($handle -eq [IntPtr]::new(-1) -or $handle -eq [IntPtr]::Zero) { throw 'metadata handle unavailable' }
        # Check the opened object itself, rather than relying only on earlier
        # path checks if its leaf was replaced during the observation.
        if ($fileMetadata::GetFileInformationByHandleEx($handle,9,$buffer,8) -eq 0) { throw 'native attributes unavailable' }
        $attributes=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,0)
        if (($attributes -band 0x400) -ne 0) { throw 'opened metadata object is a reparse point' }
        # FILE_ID_INFO: uint64 volume serial, then 16 opaque ID bytes (24 total).
        if ($fileMetadata::GetFileInformationByHandleEx($handle,18,$buffer,24) -eq 0) { throw 'native file ID unavailable' }
        $bytes=[byte[]]::new(16)
        [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($buffer,8),$bytes,0,16)
        $id='0x'+([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
        # FILE_STANDARD_INFO: two int64s, uint32 links, two BOOLEANs, padding.
        if ($fileMetadata::GetFileInformationByHandleEx($handle,1,$buffer,24) -eq 0) { throw 'native link count unavailable' }
        return @{file_id=$id;links=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,16);
            delete_pending=([Runtime.InteropServices.Marshal]::ReadByte($buffer,20) -ne 0);
            directory=([Runtime.InteropServices.Marshal]::ReadByte($buffer,21) -ne 0)}
    } finally {
        try {
            if ($handle -ne [IntPtr]::new(-1) -and $handle -ne [IntPtr]::Zero -and
                $fileMetadata::CloseHandle($handle) -eq 0) { throw 'metadata handle close failed' }
        } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    }
}
function FileId($path) { return (ReadFileIdentity $path).file_id }
"""
WINDOWS_PROVIDER = WINDOWS_PATH_PROVIDER + r"""# FindFirstFile exposes the reparse tag without opening/dereferencing its target.
# https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-tags
$assemblyName=[Reflection.AssemblyName]::new('FullmagWindowsMetadata')
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('Metadata')
$type=$module.DefineType('FullmagWindowsMetadata',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$methodFlags=[Reflection.MethodAttributes]'Public,Static,PinvokeImpl'
$find=$type.DefinePInvokeMethod('FindFirstFileW','kernel32.dll',$methodFlags,
    [Reflection.CallingConventions]::Standard,[IntPtr],[Type[]]@([string],[IntPtr]),
    [Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$find.SetImplementationFlags($find.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
$close=$type.DefinePInvokeMethod('FindClose','kernel32.dll',$methodFlags,
    [Reflection.CallingConventions]::Standard,[int],[Type[]]@([IntPtr]),
    [Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
$close.SetImplementationFlags($close.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
$nativeMetadata=$type.CreateType()
function ReparseTag($path, $expectedAttributes) {
    if ($path -cne (Canonical $path) -or $path.IndexOfAny([char[]]'*?') -ge 0) {
        throw 'literal canonical reparse path required'
    }
    $buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal(1024)
    $handle=[IntPtr]::new(-1)
    try {
        $handle=$nativeMetadata::FindFirstFileW(('\\?\'+$path),$buffer)
        if ($handle -eq [IntPtr]::new(-1) -or $handle -eq [IntPtr]::Zero) {
            throw ('native reparse metadata unavailable: '+$path)
        }
        $attributes=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,0)
        $tag=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,36)
        $name=[Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($buffer,44),260)
        $terminator=$name.IndexOf([char]0)
        if ($terminator -lt 0 -or
            $name.Substring(0,$terminator) -cne [IO.Path]::GetFileName($path) -or
            ($attributes -band 0x410) -ne ($expectedAttributes -band 0x410)) {
            throw ('native reparse enumeration identity drifted: '+$path)
        }
        if ($tag -eq [int]0xa000001d) { return '0xa000001d' }
        if ($tag -eq [int]0xa0000003 -and ($attributes -band 0x10) -ne 0) { return '0xa0000003' }
        if ($tag -eq [int]0xa000000c) { return '0xa000000c' }
        throw ('unknown descendant reparse tag refused: tag='+$tag.ToString('x8')+' path='+$path)
    } finally {
        try {
            if ($handle -ne [IntPtr]::new(-1) -and $handle -ne [IntPtr]::Zero) {
                if ($nativeMetadata::FindClose($handle) -eq 0) { throw 'native enumeration handle close failed' }
            }
        } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    }
}
function DescendantBudget($clock, $entries, $directories, $files, $pending) {
    if ($entries -gt 100000 -or $clock.ElapsedMilliseconds -ge 15000) {
        throw ('descendant inventory fixed budget exceeded: entries={0} directories={1} files={2} pending={3} elapsed_ms={4}' -f
            $entries,$directories,$files,$pending,$clock.ElapsedMilliseconds)
    }
}
function Descendants($root, $serial, $rootFileId) {
    # Observational topology fence, not a handle-atomic namespace operation.
    # Ordinary child directory replacement cannot alias a VHD without reparse;
    # same-volume VHD hardlinks are excluded by the independent backing nlink=1.
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $pendingDirs=New-Object 'System.Collections.Generic.Stack[string]'
    $rows=New-Object 'System.Collections.Generic.List[string]'
    $links=New-Object 'System.Collections.Generic.List[string]'
    $linkKinds=@{}
    $linkTags=@{}
    $linkTargets=@{}
    $pendingDirs.Push($root)
    $entryCount=0
    $directoryCount=0
    $fileCount=0
    while ($pendingDirs.Count -gt 0) {
        DescendantBudget $clock $entryCount $directoryCount $fileCount $pendingDirs.Count
        $currentDir=$pendingDirs.Pop()
        NoReparse $currentDir
        $directory=[IO.DirectoryInfo]::new($currentDir)
        $directoryAttributes=[int][IO.File]::GetAttributes($currentDir)
        if (($directoryAttributes -band 0x10) -eq 0 -or ($directoryAttributes -band 0x400) -ne 0) {
            throw 'descendant directory changed kind or became a reparse point'
        }
        foreach ($entry in $directory.EnumerateFileSystemInfos()) {
            $entryCount++
            if ($entryCount -gt 100000 -or $clock.ElapsedMilliseconds -ge 15000) {
                DescendantBudget $clock $entryCount $directoryCount $fileCount $pendingDirs.Count
            }
            # EnumerateFileSystemInfos supplies attributes from the enumeration.
            # https://learn.microsoft.com/en-us/dotnet/api/system.io.directoryinfo.enumeratefilesysteminfos
            $attributes=[int]$entry.Attributes
            $isLink=($attributes -band 0x400) -ne 0
            if (-not $entry.FullName.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {
                throw 'descendant inventory escaped its canonical root'
            }
            $relative=$entry.FullName.Substring($root.Length+1)
            if (($relative.Split('\')).Length -gt 128) { throw 'descendant inventory depth budget exceeded' }
            if ($isLink) {
                if ($links.Count -ge 256) { throw 'relative LX-link inventory exceeds its fixed bound' }
                $tag=ReparseTag $entry.FullName $attributes
                $target=$null
                if ($tag -ceq '0xa0000003') {
                    $junction=Get-Item -Force -LiteralPath $entry.FullName
                    $targets=@($junction.Target)
                    if ($junction.LinkType -cne 'Junction' -or $targets.Count -ne 1) { throw 'ambiguous directory junction' }
                    $target=Canonical $targets[0]
                    if ($target -ine $root -and
                        -not $target.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {
                        throw 'junction target escapes candidate root'
                    }
                } elseif ($tag -ceq '0xa000000c') {
                    $symbolic=Get-Item -Force -LiteralPath $entry.FullName
                    $targets=@($symbolic.Target)
                    if ($symbolic.LinkType -cne 'SymbolicLink' -or $targets.Count -ne 1) { throw 'ambiguous symbolic link' }
                    $target=[string]$targets[0]
                    if ([IO.Path]::IsPathRooted($target) -or $target.Contains(':') -or
                        $target.IndexOfAny([char[]]'"*?') -ge 0) { throw 'only relative native symbolic links are supported' }
                    $resolved=Canonical (Join-Path ([IO.Directory]::GetParent($entry.FullName).FullName) $target)
                    if ($resolved -ine $root -and
                        -not $resolved.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {
                        throw 'symbolic link target escapes candidate root'
                    }
                }
                $links.Add($relative)
                $linkKinds[$relative]=$(if(($attributes -band 0x10) -ne 0){'directory'}else{'file'})
                $linkTags[$relative]=$tag
                $linkTargets[$relative]=$target
            }
            if (($attributes -band 0x10) -ne 0) {
                $kind=$(if($isLink){'directory-link'}else{'directory'})
                $directoryCount++
                if (-not $isLink) { $pendingDirs.Push($entry.FullName) }
            } else {
                if ($entry -isnot [IO.FileInfo]) { throw 'descendant object kind is unsupported' }
                $kind=$(if($isLink){'file-link'}else{'file'})
                $fileCount++
            }
            # Length-prefix the path so delimiters inside names cannot collide.
            # Only type/reparse attributes participate; content, append length,
            # timestamps and ordinary archive/readonly attribute updates do not.
            $row=$relative.Length.ToString([Globalization.CultureInfo]::InvariantCulture)+':'+
                $relative+':'+$kind+':'+$serial+':'+
                ($attributes -band 0x410).ToString([Globalization.CultureInfo]::InvariantCulture)
            $rows.Add($row)
        }
        NoReparse $currentDir
        $afterAttributes=[int][IO.File]::GetAttributes($currentDir)
        if (($afterAttributes -band 0x10) -eq 0 -or ($afterAttributes -band 0x400) -ne 0) {
            throw 'descendant directory changed kind or became a reparse point'
        }
        DescendantBudget $clock $entryCount $directoryCount $fileCount $pendingDirs.Count
    }
    if ((FileId $root) -ne $rootFileId) { throw 'candidate root identity changed during descendant inventory' }
    DescendantBudget $clock $entryCount $directoryCount $fileCount $pendingDirs.Count
    if ($rows.Count -ne $entryCount -or $directoryCount+$fileCount -ne $entryCount) {
        throw 'descendant inventory is incomplete'
    }
    [string[]]$ordered=@($rows.ToArray())
    [Array]::Sort($ordered,[StringComparer]::Ordinal)
    $bytes=[Text.Encoding]::UTF8.GetBytes([string]::Join(([string][char]10),$ordered))
    $hash=[Security.Cryptography.SHA256]::Create()
    try { $digest=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
    DescendantBudget $clock $entryCount $directoryCount $fileCount $pendingDirs.Count
    [string[]]$orderedLinks=@($links.ToArray())
    [Array]::Sort($orderedLinks,[StringComparer]::Ordinal)
    $linkRecords=@($orderedLinks | ForEach-Object { @{path=$_;tag=$linkTags[$_];kind=$linkKinds[$_];target=$linkTargets[$_]} })
    return @{schema='fullmag.windows-contained-topology.v2';entries=$entryCount;
        directories=$directoryCount;files=$fileCount;sha256=$digest;reparse_points=$links.Count;
        links=$linkRecords;max_entries=100000;budget_ms=15000}
}
function Identity($value, $candidateSerial=$null) {
    $path=Canonical $value
    NoReparse $path
    $item=Get-Item -Force -LiteralPath $path
    $drive=[IO.Path]::GetPathRoot($path).Substring(0,2)
    $volumes=@(Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$drive+"'"))
    if ($volumes.Count -ne 1) { throw 'ambiguous logical disk' }
    $volume=$volumes[0]
    if ([int]$volume.DriveType -ne 3 -or $volume.FileSystem -notin @('NTFS','ReFS') -or
        $volume.VolumeSerialNumber -notmatch '^[0-9A-Fa-f]{8}$') { throw 'fixed native volume required' }
    $fileIdentity=ReadFileIdentity $path
    $fileId=$fileIdentity.file_id
    if ($fileIdentity.delete_pending -or $fileIdentity.directory -ne $item.PSIsContainer) {
        throw 'native file kind changed or deletion is pending'
    }
    $ancestorIds=@()
    $cursor=[IO.Directory]::GetParent($path)
    while ($null -ne $cursor) {
        $ancestorIds+=FileId $cursor.FullName
        $cursor=$cursor.Parent
    }
    $links=@()
    if (-not $item.PSIsContainer) {
        # A different volume cannot hardlink this candidate. On the same volume,
        # NumberOfLinks=1 and the exact canonical handle prove its sole path.
        if ($null -ne $candidateSerial -and
            $volume.VolumeSerialNumber.ToUpperInvariant() -ne $candidateSerial) {
            $links=$null
        } else {
            if ($fileIdentity.links -ne 1 -or (FileId $path) -cne $fileId) { throw 'hardlinked or replaced file refused' }
            $links=@($path)
        }
    }
    $inventory=$null
    if ($item.PSIsContainer) { $inventory=Descendants $path ($volume.VolumeSerialNumber.ToUpperInvariant()) $fileId }
    return @{path=$path;volume=$drive;serial=$volume.VolumeSerialNumber.ToUpperInvariant();
        filesystem=$volume.FileSystem;fixed=$true;no_reparse=$true;
        file_id=$fileId;ancestor_file_ids=$ancestorIds;kind=$(if($item.PSIsContainer){'directory'}else{'file'});
        hardlinks=$links;descendants=$inventory}
}
$entries=@(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath })
$records=@()
foreach ($name in @($request.distro,'docker-desktop')) {
    $found=@($entries | Where-Object { $_.DistributionName -ceq $name })
    if ($found.Count -ne 1) { throw 'required registered WSL distro is absent or ambiguous' }
    $entry=$found[0]
    if ($entry.VhdFileName -notmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]*\.vhdx$') { throw 'unknown WSL VHD filename' }
    $base=Canonical $entry.BasePath
    $records+=@{name=$name;base=$base;filename=$entry.VhdFileName}
}
$settings=Join-Path $env:APPDATA 'Docker\settings-store.json'
$settingsItem=Get-Item -Force -LiteralPath $settings
if ($settingsItem.Length -le 0 -or $settingsItem.Length -gt 1048576) { throw 'settings inventory unavailable' }
NoReparse $settings
$settingsBytes=[IO.File]::ReadAllBytes($settings)
$settingsObject=([Text.Encoding]::UTF8.GetString($settingsBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json)
$known=@('AutoStart','DisplayedOnboarding','EnableDockerAI','EnableIntegrationWithDefaultWslDistro',
    'InferenceCanUseGPUVariant','IntegratedWslDistros','LastContainerdSnapshotterEnable',
    'LicenseTermsVersion','SettingsVersion','UpdateInstallTime','UpdatePreviousVersion','UseContainerdSnapshotter',
    'BackupData','DataFolder','DiskFlush','DiskSizeMiB','DiskStats','DiskTRIM',
    'DockerBinInstallPath','UseResourceSaver','WslDiskCompactionThresholdGb')
[string[]]$keys=@($settingsObject.PSObject.Properties.Name)
[Array]::Sort($keys,[StringComparer]::Ordinal)
# Accept only typed non-location options and the legacy Hyper-V default in an
# explicitly WSL-enabled configuration. Custom data roots remain unsupported;
# the actual standard WSL disk/junction and all three backing IDs are checked.
foreach ($name in @('BackupData','DiskTRIM','UseResourceSaver')) {
    if ($keys -contains $name -and $settingsObject.$name -isnot [bool]) { throw 'invalid boolean resource setting' }
}
foreach ($name in @('DiskSizeMiB','WslDiskCompactionThresholdGb')) {
    if ($keys -contains $name -and
        (($settingsObject.$name -isnot [int] -and $settingsObject.$name -isnot [long]) -or
         $settingsObject.$name -lt 0)) { throw 'invalid numeric resource setting' }
}
if ($keys -contains 'DiskFlush' -and $settingsObject.DiskFlush -cnotin @('','os')) { throw 'unsupported disk flush mode' }
if ($keys -contains 'DiskStats' -and $settingsObject.DiskStats -cne '') { throw 'custom disk stats policy refused' }
if ($keys -contains 'DockerBinInstallPath' -and
    $settingsObject.DockerBinInstallPath -cnotin @('system','user')) { throw 'custom binary location refused' }
if ($keys -contains 'DataFolder') {
    $legacyDefault=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'DockerDesktop\vm-data'
    if ($settingsObject.DataFolder -isnot [string] -or
        $settingsObject.WslEngineEnabled -isnot [bool] -or -not $settingsObject.WslEngineEnabled -or
        (Canonical $settingsObject.DataFolder) -ine (Canonical $legacyDefault)) {
        throw 'custom Desktop data folder is unsupported'
    }
}
foreach ($key in $keys) {
    if ($key -notin $known -and $key -match '(?i)(disk|data|vhd|path|location|folder|resource)') {
        throw 'unsupported Desktop resource path policy'
    }
}
$hash=[Security.Cryptography.SHA256]::Create()
try { $settingsSha=([BitConverter]::ToString($hash.ComputeHash($settingsBytes))).Replace('-','').ToLowerInvariant() }
finally { $hash.Dispose() }
$disk=Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk'
$diskOrigin=Canonical $disk
NoReparse ([IO.Directory]::GetParent($disk).FullName)
$diskItem=Get-Item -Force -LiteralPath $disk
$junction=$null
if (([int]$diskItem.Attributes -band 0x400) -ne 0) {
    $targets=@($diskItem.Target)
    if ($diskItem.LinkType -ne 'Junction' -or $targets.Count -ne 1) { throw 'unsupported Desktop disk reparse' }
    $target=Canonical $targets[0]
    NoReparse $target
    $junction=@{path=(Canonical $disk);target=$target}
    $disk=$target
} else { NoReparse $disk }
$candidate=Identity $request.path
$backings=@{}
$backings['wsl-current']=Identity (Join-Path $records[0].base $records[0].filename) ($candidate.serial)
$backings['wsl-docker-desktop']=Identity (Join-Path $records[1].base $records[1].filename) ($candidate.serial)
$backings['docker-desktop-data']=Identity (Join-Path $disk 'docker_data.vhdx') ($candidate.serial)
@{schema='fullmag.windows-bind-native-identity.v1';distro=$request.distro;candidate=$candidate;
    registry=$records;desktop_disk_origin=$diskOrigin;desktop_disk_root=(Canonical $disk);
    desktop_disk_junction=$junction;settings_sha256=$settingsSha;
    settings_keys=$keys;backings=$backings} | ConvertTo-Json -Depth 12 -Compress
"""


def require(condition, message):
    if not condition:
        raise BuildControlError(message)


def _sha(value):
    return hashlib.sha256(value).hexdigest()


def _json(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_BYTES, "Windows proof response exceeds its bound")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Windows proof response repeats a JSON key")
            result[key] = value
        return result
    try:
        return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique)
    except (UnicodeError, ValueError) as error:
        raise BuildControlError("Windows proof response is not UTF-8 JSON") from error


def _windows_path(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z]:[\\/].+", value) is not None,
            "Windows bind must be an absolute local non-root path")
    require(not any(ord(char) < 32 or char in ',"*?\x7f' for char in value)
            and ":" not in value[2:] and not any(part in {".", ".."} or part.endswith((" ", "."))
                                                      for part in re.split(r"[\\/]", value)),
            "Windows bind path contains traversal, stream or control syntax")
    normalized = ntpath.normpath(value)
    require(normalized.rstrip("\\") != normalized[:2], "Whole-drive bind cannot be isolated")
    return normalized


def _windows_source_path(value):
    """Translate only Desktop's explicit drive aliases, retaining raw mount pins.

    This is syntax normalization, not isolation evidence. Native Windows IDs,
    reparse/hard-link checks and the independent DrvFs roundtrip remain required.
    WSL hash aliases and whole-drive mounts are never accepted here.
    """
    if isinstance(value, str) and value.startswith("/"):
        matched = re.fullmatch(r"(?:/run/desktop/mnt/host|/host_mnt|/mnt/host)/([A-Za-z])/(.+)", value)
        require(matched is not None and "\\" not in value
                and str(PurePosixPath(value)) == value,
                "Desktop drive bind is not a canonical explicit drive alias")
        value = matched.group(1).upper() + ":\\" + matched.group(2).replace("/", "\\")
    return _windows_path(value)


def _overlap(left, right):
    a, b = ntpath.normcase(left), ntpath.normcase(right)
    return a == b or a.startswith(b.rstrip("\\") + "\\") or b.startswith(a.rstrip("\\") + "\\")


def _native_link_relative(value):
    require(isinstance(value, str) and value and len(value.encode("utf-8")) <= 4096
            and not any(ord(char) < 32 or ord(char) == 127 for char in value)
            and ":" not in value and value == ntpath.normpath(value),
            "Native file-link path is not canonical relative text")
    path = PureWindowsPath(value)
    require(not path.is_absolute() and not path.drive and not path.root
            and all(part not in {".", ".."} for part in path.parts),
            "Native file-link path escapes the candidate")
    return "/".join(path.parts)


def _native_relative_symlink_target(value):
    require(isinstance(value, str) and value and not PureWindowsPath(value).root
            and not PureWindowsPath(value).drive and not any(char in value for char in '"*?'),
            "Native symbolic link must have an exact relative target")
    target = value.replace("\\", "/")
    _relative_link_target(target)
    return target


def _validate_descendants(value):
    require(isinstance(value, dict) and set(value) == {
        "schema", "entries", "directories", "files", "sha256", "reparse_points",
        "links", "max_entries", "budget_ms"} and value["schema"] == INVENTORY_SCHEMA,
        "Directory descendant inventory is incomplete")
    links = value["links"]
    require(isinstance(links, list) and len(links) <= MAX_RELATIVE_LINKS,
            "Directory file-link inventory exceeds its fixed bound")
    paths = []
    for link in links:
        require(isinstance(link, dict) and set(link) == {"path", "tag", "kind", "target"}
                and link["kind"] in {"file", "directory"}
                and ((link["tag"] == "0xa000001d" and link["target"] is None)
                     or (link["tag"] == "0xa0000003" and link["kind"] == "directory"
                         and _windows_path(link["target"]) == link["target"])
                     or (link["tag"] == "0xa000000c"
                         and _native_relative_symlink_target(link["target"]))),
                "Unknown or unqualified descendant reparse tag")
        _native_link_relative(link["path"])
        paths.append(link["path"])
    require(len(paths) == len(set(paths))
            and paths == sorted(paths, key=lambda path: path.encode("utf-16-be")),
            "Directory file-link inventory repeats paths or is not canonical")
    require(all(type(value[key]) is int and value[key] >= 0
                for key in ("entries", "directories", "files", "reparse_points", "max_entries", "budget_ms"))
            and value["entries"] <= MAX_DESCENDANT_ENTRIES
            and value["entries"] == value["directories"] + value["files"]
            and value["reparse_points"] == len(links) <= value["entries"]
            and sum(item["kind"] == "file" for item in links) <= value["files"]
            and sum(item["kind"] == "directory" for item in links) <= value["directories"]
            and value["max_entries"] == MAX_DESCENDANT_ENTRIES
            and value["budget_ms"] == DESCENDANT_BUDGET_MS
            and isinstance(value["sha256"], str) and SHA.fullmatch(value["sha256"]),
            "Directory descendant inventory contains unqualified reparse points or exceeds its fixed bounds")
    return value


def _native_identity(value, *, backing_candidate_serial=None):
    require(isinstance(value, dict) and set(value) == {
        "path", "volume", "serial", "filesystem", "fixed", "no_reparse", "file_id", "ancestor_file_ids", "kind", "hardlinks", "descendants"},
        "Native file identity fields differ")
    path = _windows_path(value["path"])
    require(path == value["path"] and value["volume"].casefold() == path[:2].casefold()
            and value["filesystem"] in {"NTFS", "ReFS"} and value["fixed"] is True
            and value["no_reparse"] is True and re.fullmatch(r"[0-9A-F]{8}", value["serial"]) is not None
            and re.fullmatch(r"0x[0-9a-f]{32}", value["file_id"]) is not None,
            "Native Windows volume/file identity is unqualified")
    ancestors = value["ancestor_file_ids"]
    require(isinstance(ancestors, list) and ancestors and len(ancestors) <= 128
            and all(isinstance(item, str) and re.fullmatch(r"0x[0-9a-f]{32}", item) for item in ancestors)
            and len(ancestors) == len(set(ancestors)) and value["file_id"] not in ancestors,
            "Native ancestor file identity inventory is incomplete or cyclic")
    require(value["kind"] in {"directory", "file"}, "Native Windows object kind is unknown")
    if value["kind"] == "file":
        require(value["descendants"] is None, "File candidate cannot claim a directory inventory")
        if value["hardlinks"] is None:
            require(backing_candidate_serial is not None
                    and backing_candidate_serial != value["serial"],
                    "Candidate or same-volume backing file has unknown hardlinks")
        else:
            require(value["hardlinks"] == [path], "Native Windows file has unknown or multiple hardlinks")
    else:
        require(value["hardlinks"] == [], "Directory hardlink observation is malformed")
        _validate_descendants(value["descendants"])
    return value


def _validate_native(value, source, distro):
    require(isinstance(value, dict) and set(value) == {
        "schema", "distro", "candidate", "registry", "desktop_disk_origin", "desktop_disk_root",
        "desktop_disk_junction", "settings_sha256", "settings_keys", "backings"}, "Native Windows evidence fields differ")
    require(value["schema"] == NATIVE_SCHEMA and value["distro"] == distro
            and isinstance(value["settings_sha256"], str) and SHA.fullmatch(value["settings_sha256"]),
            "Native Windows evidence policy differs")
    require(isinstance(value["settings_keys"], list) and value["settings_keys"]
            and value["settings_keys"] == sorted(set(value["settings_keys"])),
            "Desktop settings keys are missing or ambiguous")
    known_settings = {"AutoStart", "DisplayedOnboarding", "EnableDockerAI",
        "EnableIntegrationWithDefaultWslDistro", "InferenceCanUseGPUVariant", "IntegratedWslDistros",
        "LastContainerdSnapshotterEnable", "LicenseTermsVersion", "SettingsVersion",
        "UpdateInstallTime", "UpdatePreviousVersion", "UseContainerdSnapshotter",
        "BackupData", "DataFolder", "DiskFlush", "DiskSizeMiB", "DiskStats", "DiskTRIM",
        "DockerBinInstallPath", "UseResourceSaver", "WslDiskCompactionThresholdGb"}
    require(all(isinstance(key, str) and (key in known_settings or
                re.search(r"(disk|data|vhd|path|location|folder|resource)", key, re.I) is None)
                for key in value["settings_keys"]), "Unsupported Desktop custom resource path policy")
    require(isinstance(value["backings"], dict) and set(value["backings"]) == BACKINGS,
            "Three protected WSL/Desktop backing files are required")
    origin = _windows_path(value["desktop_disk_origin"])
    disk_root = _windows_path(value["desktop_disk_root"])
    require(origin == value["desktop_disk_origin"] and disk_root == value["desktop_disk_root"]
            and ntpath.normcase(origin).endswith(r"\docker\wsl\disk"),
            "Desktop data backing does not derive from its standard disk root")
    junction = value["desktop_disk_junction"]
    if junction is None:
        require(origin == disk_root, "Desktop disk root changed without an explicit junction")
    else:
        require(isinstance(junction, dict) and set(junction) == {"path", "target"}
                and junction["path"] == origin and junction["target"] == disk_root,
                "Desktop default junction identity differs")
    require(ntpath.normcase(value["backings"]["docker-desktop-data"]["path"]) ==
            ntpath.normcase(ntpath.join(disk_root, "docker_data.vhdx")),
            "Docker data backing does not derive from the qualified default root")
    candidate = _native_identity(value["candidate"])
    require(ntpath.normcase(candidate["path"]) == ntpath.normcase(_windows_source_path(source)),
            "Native Windows identity does not bind the literal Docker source")
    records = value["registry"]
    require(isinstance(records, list) and len(records) == 2
            and [item.get("name") for item in records] == [distro, "docker-desktop"]
            and all(set(item) == {"name", "base", "filename"} for item in records),
            "WSL backing registry inventory is incomplete")
    for record in records:
        _windows_path(record["base"])
        require(re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*\.vhdx", record["filename"]) is not None,
                "Registered WSL backing filename is unsupported")
    require(isinstance(value["backings"], dict) and set(value["backings"]) == BACKINGS,
            "Three protected WSL/Desktop backing files are required")
    for role, backing in value["backings"].items():
        _native_identity(backing, backing_candidate_serial=candidate["serial"])
        require(backing["kind"] == "file", "Protected backing is not a qualified native file")
        require(not _overlap(candidate["path"], backing["path"]),
                "Windows bind overlaps a protected WSL/Desktop backing path")
        # Drive letters are aliases, not physical volume identities. A serial
        # collision may conservatively refuse, but must never skip FileID CAS.
        same_volume = candidate["serial"] == backing["serial"]
        if same_volume:
            require(candidate["file_id"] not in [backing["file_id"], *backing["ancestor_file_ids"]]
                    and backing["file_id"] not in candidate["ancestor_file_ids"],
                    "Windows bind physically aliases a protected backing or ancestor")

    for role, record in zip(("wsl-current", "wsl-docker-desktop"), records):
        require(ntpath.normcase(value["backings"][role]["path"]) ==
                ntpath.normcase(ntpath.join(record["base"], record["filename"])),
                "Protected WSL backing does not derive from the registered distro")
    require(len({(item["serial"], item["file_id"]) for item in value["backings"].values()}) == 3,
            "Protected backing inventory aliases itself")
    return value


def _capture(command, data=None):
    result = bounded_capture(command, data=data, timeout=40, maximum=MAX_BYTES)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace")[-1024:].strip()
        raise BuildControlError("Read-only Windows bind identity command failed: exit_code="
                                + str(result.returncode) + "; " + detail)
    require(isinstance(result.stdout, bytes) and len(result.stdout) <= MAX_BYTES,
            "Read-only Windows bind identity response exceeded its bound")
    return result.stdout


def _native(source, distro):
    powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    raw = _capture([powershell, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROVIDER],
                   canonical({"path": _windows_source_path(source), "distro": distro}))
    return _validate_native(_json(raw), source, distro)


def _canonical_linux(value):
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts and str(path) == os.path.normpath(str(path)),
            "Linux proof root is not canonical")
    for part in (path, *path.parents):
        require(not stat.S_ISLNK(part.lstat().st_mode), "Linux proof root traverses a symlink")
    require(path.resolve(strict=True) == path and path.is_dir(), "Linux proof root is not a real directory")
    return path


def _findmnt(path, recursive=False):
    args = ["findmnt", "--json", "--target", str(path), "--output", "TARGET,SOURCE,FSTYPE,FSROOT,OPTIONS"]
    if recursive:
        args.append("--submounts")
    value = _json(_capture(args))
    rows = value.get("filesystems") if isinstance(value, dict) else None
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict),
            "Kernel mount identity is absent or ambiguous")
    return rows[0]


def _reject_submounts(mount, path):
    children = mount.get("children", [])
    require(isinstance(children, list), "Kernel submount inventory is malformed")
    pending = list(children)
    while pending:
        child = pending.pop()
        require(isinstance(child, dict) and isinstance(child.get("target"), str),
                "Kernel submount identity is malformed")
        child_path = Path(child["target"])
        require(child_path.is_absolute() and ".." not in child_path.parts,
                "Kernel submount path is unsafe")
        require(not (child_path == path or path in child_path.parents),
                "Proof root has nested external mounts")
        descendants = child.get("children", [])
        require(isinstance(descendants, list), "Kernel submount inventory is malformed")
        pending.extend(descendants)


def _linux_identity(source_root, reference_root):
    source, reference = _canonical_linux(source_root), _canonical_linux(reference_root)
    root_mount = _findmnt("/")
    require(root_mount.get("target") == "/" and root_mount.get("fstype") == "ext4"
            and root_mount.get("fsroot") == "/", "Reference requires this WSL distro root ext4")
    for path in (source, reference):
        mount = _findmnt(path, recursive=True)
        _reject_submounts(mount, path)
        require({key: value for key, value in mount.items() if key != "children"} == root_mount
                and path.stat().st_dev == Path("/").stat().st_dev,
                "Source/reference is on an external or different root filesystem")
    from linux_native_host import read_owned_regular, OWNER_NAME
    raw = read_owned_regular(reference / OWNER_NAME)
    marker = _json(raw)
    require(marker.get("storage_profile") == "linux-native-v1"
            and marker.get("host_root") == str(reference) and marker.get("host_filesystem") == "ext4"
            and marker.get("host_device") == reference.stat().st_dev
            and marker.get("host_inode") == reference.stat().st_ino
            and isinstance(marker.get("engine_id"), str) and marker["engine_id"],
            "Reference marker does not attest this exact Linux root")
    return {"source_root": str(source), "reference_root": str(reference),
            "source_inode": source.stat().st_ino, "reference_inode": reference.stat().st_ino,
            "root_device": reference.stat().st_dev, "root_mount": root_mount,
            "marker_sha256": _sha(raw), "engine_id": marker["engine_id"]}


def _mapping(source):
    source = _windows_source_path(source)
    translated = _capture(["wslpath", "-u", source]).decode("utf-8", "strict").strip()
    path = Path(translated)
    require(path.is_absolute() and str(path) == os.path.normpath(str(path))
            and ".." not in path.parts, "wslpath returned an unsafe path")
    for part in (path, *path.parents):
        require(not stat.S_ISLNK(part.lstat().st_mode), "Translated Windows path traverses a symlink")
    require(path.resolve(strict=True) == path, "Translated Windows path is not canonical")
    back = _capture(["wslpath", "-w", translated]).decode("utf-8", "strict").strip()
    require(ntpath.normcase(_windows_path(back)) == ntpath.normcase(_windows_path(source)),
            "Official WSL path roundtrip differs")
    mount = _findmnt(path, recursive=True)
    require(mount.get("fstype") in {"9p", "drvfs"} and mount.get("fsroot") == "/"
            and ntpath.normcase(str(mount.get("source"))) == ntpath.normcase(source[:2] + "\\"),
            "Translated source is not the exact native Windows drive mapping")
    target = Path(mount.get("target", ""))
    require(target.is_absolute() and (path == target or target in path.parents),
            "DrvFs mount does not contain the translated source")
    _reject_submounts(mount, path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),
            "Translated candidate is not a file or directory")
    require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1,
            "Translated candidate has multiple hardlinks")
    return {"path": translated, "roundtrip": back, "mount": mount,
            "device": info.st_dev, "inode": info.st_ino, "mode": info.st_mode, "nlink": info.st_nlink}


def _validate_engine(value):
    keys = ("ID", "Name", "OperatingSystem", "OSType", "KernelVersion")
    require(isinstance(value, dict) and set(value) == set(keys)
            and all(isinstance(value.get(key), str) and value[key] for key in keys),
            "Docker engine identity is incomplete")
    require(value["OSType"] == "linux" and "docker desktop" in value["OperatingSystem"].lower()
            and "microsoft" in value["KernelVersion"].lower() and "wsl" in value["KernelVersion"].lower(),
            "Windows isolation proof requires the current Docker Desktop WSL Linux engine")
    return value


def _engine():
    value = _json(docker_capture("info", "--format", "{{json .}}", timeout=40).stdout)
    keys = ("ID", "Name", "OperatingSystem", "OSType", "KernelVersion")
    return _validate_engine({key: value.get(key) for key in keys})


def _inspect(identifier):
    require(isinstance(identifier, str) and CID.fullmatch(identifier), "Full container ID required")
    value = _json(docker_capture("inspect", identifier, timeout=40).stdout)
    require(isinstance(value, list) and len(value) == 1 and value[0].get("Id") == identifier,
            "Fresh exact container inspection failed")
    return value[0]


def _container_pin(value):
    require(isinstance(value, dict) and CID.fullmatch(str(value.get("Id", "")))
            and IMAGE.fullmatch(str(value.get("Image", ""))), "Container identity is incomplete")
    require(all(isinstance(value.get(key), dict) for key in ("Config", "HostConfig", "State", "NetworkSettings"))
            and isinstance(value.get("Mounts"), list), "Container critical inspection is incomplete")
    fields = ("Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "Pid",
              "ExitCode", "StartedAt", "FinishedAt", "Error")
    state = value["State"]
    require(all(key in state for key in fields), "Container lifecycle evidence is incomplete")
    networks = value["NetworkSettings"].get("Networks")
    require(isinstance(networks, dict), "Container network identity is absent")
    mounts = value["Mounts"]
    require(all(isinstance(item, dict) and isinstance(item.get("Destination"), str)
                and item["Destination"] for item in mounts),
            "Container mount destination is absent or malformed")
    destinations = [item["Destination"] for item in mounts]
    require(len(destinations) == len(set(destinations)), "Container mount destinations are duplicated")
    # Docker inspect may reorder Mounts. Destination identifies each mount;
    # retain every field and nested option while normalizing only this list.
    ordered_mounts = sorted(mounts, key=lambda item: item["Destination"])
    # Hash configuration rather than copying environment values or secrets.
    return {"id": value["Id"], "image": value["Image"],
            "config_sha256": _sha(canonical(value["Config"])),
            "host_config_sha256": _sha(canonical(value["HostConfig"])),
            "mounts_sha256": _sha(canonical(ordered_mounts)),
            "networks_sha256": _sha(canonical(networks)),
            "state": {key: state[key] for key in fields}}


def _mount(container, target):
    items = [item for item in container["Mounts"] if item.get("Destination") == target]
    require(len(items) == 1, "Selected backend mount identity is ambiguous: " + target)
    return items[0]


def _context(control, backend, container, source, reference_root):
    require(sys.platform.startswith("linux") and os.name != "nt", "Windows bind proof requires Linux/WSL")
    identity = control.identity
    from docker_development_inputs import select_checkout
    import fullmag_storage as storage
    selected = select_checkout(Path(__file__).resolve().parents[1], Path(identity["source_root"]))
    require(compose_project_identity(storage.resolve_layout(selected)) == identity,
            "Proof context is not the exact registered source/group")
    require(control.project == identity["project_name"],
            "Windows proof requires the selected registered BuildControl group")
    validate_source_labels(backend, identity)
    labels = backend["Config"].get("Labels", {})
    require(labels.get("com.docker.compose.project") == control.project
            and labels.get("com.docker.compose.service") == "backend", "Backend group differs")
    require(container.get("Id") != backend.get("Id")
            and container.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project,
            "Selected group cannot be qualified as a foreign Windows consumer")
    require(any(item.get("Type") == "bind" and item.get("Source") == source for item in container["Mounts"]),
            "Literal Windows source is absent from the exact foreign Mounts")
    from docker_linux_native_readmission import live_bind_path
    require(live_bind_path(_mount(backend, "/opt/fullmag/source")["Source"]) == Path(identity["source_root"])
            and live_bind_path(_mount(backend, "/state")["Source"]) == Path(reference_root),
            "Backend canonical source/reference mount binding differs")
    control_mount, ledger = _mount(backend, "/opt/fullmag/control"), _mount(backend, "/host-ledger")
    require(control_mount.get("Type") == "volume" and control_mount.get("Name") == control.volume
            and ledger.get("Type") == "volume" and isinstance(ledger.get("Name"), str) and ledger["Name"],
            "Selected group control/ledger identity is unresolved")
    require(not any(item.get("Type") == "volume" and item.get("Name") in {control.volume, ledger["Name"]}
                    for item in container["Mounts"]), "Foreign consumer shares selected control/ledger")
    distro = os.environ.get("WSL_DISTRO_NAME")
    require(isinstance(distro, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", distro)
            and distro != "docker-desktop", "Current WSL distro identity is unavailable")
    return {"identity": dict(identity), "project": control.project, "control_volume": control.volume,
            "control_namespace": control.namespace, "ledger_volume": ledger["Name"], "distro": distro,
            "source_root": identity["source_root"], "reference_root": str(reference_root)}


def _link_paths(native):
    inventory = native["candidate"]["descendants"]
    if inventory is None:
        return []
    _validate_descendants(inventory)
    return [(item["path"], _native_link_relative(item["path"]), item)
            for item in inventory["links"]]


def _relative_link_target(value):
    require(isinstance(value, str) and value and len(value.encode("utf-8")) <= 4096
            and not value.startswith("/") and "\\" not in value and ":" not in value
            and not any(ord(char) < 32 or ord(char) == 127 for char in value),
            "Link target must be contained POSIX relative text")
    ordinary = False
    for part in value.split("/"):
        require(part not in {"", "."}, "Link target contains ambiguous segments")
        require(part != ".." or not ordinary, "Link target has non-leading parent traversal")
        ordinary = ordinary or part != ".."
    return PurePosixPath(value)


def _resolve_link_target(relative, target):
    parts = list(PurePosixPath(relative).parent.parts)
    for part in _relative_link_target(target).parts:
        if part == "..":
            require(parts, "Relative link target escapes its candidate root")
            parts.pop()
        else:
            parts.append(part)
    return "/".join(parts) or "."


def _resolve_qualified_link(relative, target, record, mapping, native):
    if record["tag"] == "0xa000001d":
        return _resolve_link_target(relative, target)
    if record["tag"] == "0xa000000c":
        require(target == _native_relative_symlink_target(record["target"]),
                "Native symbolic target differs from its exact relative DrvFs target")
        return _resolve_link_target(relative, target)
    # Only a native-attested directory junction may have an absolute DrvFs
    # target. It must map exactly to its Windows target inside this same root.
    require(record["tag"] == "0xa0000003" and record["kind"] == "directory",
            "Unknown qualified reparse tag")
    root = PureWindowsPath(_windows_path(native["candidate"]["path"]))
    destination = PureWindowsPath(_windows_path(record["target"]))
    require(destination == root or root in destination.parents, "Junction escapes native candidate root")
    suffix = destination.relative_to(root)
    mapped = Path(mapping["path"]).joinpath(*suffix.parts)
    require(isinstance(target, str) and target == str(mapped),
            "Native junction target differs from its exact contained DrvFs target")
    return "/".join(suffix.parts) or "."


def _file_identity(path):
    metadata = path.lstat()
    return {"device": metadata.st_dev, "inode": metadata.st_ino, "mode": metadata.st_mode}


def _link_parent_directories(root, path, device):
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise BuildControlError("Relative file link escaped its candidate root") from error
    cursor = root
    for part in ("", *relative.parts[:-1]):
        if part:
            cursor = cursor / part
        metadata = cursor.lstat()
        require(stat.S_ISDIR(metadata.st_mode) and metadata.st_dev == device,
                "File link has a symlink, non-directory or external-filesystem parent")


def _validate_link_evidence(value, mapping, native):
    expected = _link_paths(native)
    require(isinstance(value, list) and len(value) == len(expected),
            "Qualified file-link list does not cover the exact native inventory")
    allowed = {relative: record for _, relative, record in expected}
    identity_fields = {"path", "device", "inode", "mode"}
    for entry, (windows_path, relative, record) in zip(value, expected):
        kind = record["kind"]
        require(isinstance(entry, dict) and set(entry) == {"path", "native_entry_kind", "target_kind", "hops", "final"}
                and entry["path"] == windows_path and entry["native_entry_kind"] == kind
                and entry["target_kind"] in {"file", "directory"} and isinstance(entry["hops"], list)
                and 1 <= len(entry["hops"]) <= MAX_RELATIVE_LINK_HOPS,
                "Qualified file-link identity or hop bound differs")
        seen = set()
        for hop in entry["hops"]:
            require(isinstance(hop, dict) and set(hop) == identity_fields | {"target", "native_entry_kind", "native_reparse_tag"}
                    and hop["path"] == relative and relative in allowed
                    and hop["native_entry_kind"] == allowed[relative]["kind"]
                    and hop["native_reparse_tag"] == allowed[relative]["tag"] and relative not in seen
                    and type(hop["device"]) is int and hop["device"] == mapping["device"]
                    and type(hop["inode"]) is int and hop["inode"] > 0
                    and type(hop["mode"]) is int and stat.S_ISLNK(hop["mode"]),
                    "File-link hop is absent from native LX_SYMLINK inventory or lacks exact identity")
            seen.add(relative)
            relative = _resolve_qualified_link(relative, hop["target"], allowed[relative], mapping, native)
        final = entry["final"]
        require(isinstance(final, dict) and set(final) == identity_fields
                and final["path"] == relative and relative not in allowed
                and type(final["device"]) is int and final["device"] == mapping["device"]
                and type(final["inode"]) is int and final["inode"] > 0
                and type(final["mode"]) is int
                and ((entry["target_kind"] == "file" and stat.S_ISREG(final["mode"]))
                     or (entry["target_kind"] == "directory" and stat.S_ISDIR(final["mode"]))),
                "Relative link does not end in a contained ordinary object of its qualified target kind on the same DrvFs")
        require(not any(hop["native_reparse_tag"] == "0xa0000003" for hop in entry["hops"])
                or entry["target_kind"] == "directory", "Directory junction does not end at an ordinary directory")
        require(record["tag"] != "0xa000000c" or entry["target_kind"] == record["kind"],
                "Native symbolic link target kind differs from its native entry")
    return value


def _qualify_links(mapping, native):
    expected = _link_paths(native)
    allowed = {relative: record for _, relative, record in expected}
    root = Path(mapping["path"])
    deadline = time.monotonic() + DESCENDANT_BUDGET_MS / 1000
    result = []
    for windows_path, initial_relative, record in expected:
        kind = record["kind"]
        relative = initial_relative
        hops = []
        seen = set()
        for _ in range(MAX_RELATIVE_LINK_HOPS + 1):
            require(time.monotonic() < deadline, "Relative file-link qualification exceeded its time bound")
            require(relative not in seen, "Relative file-link chain contains a cycle")
            seen.add(relative)
            current = root.joinpath(*PurePosixPath(relative).parts)
            _link_parent_directories(root, current, mapping["device"])
            before = _file_identity(current)
            require(before["device"] == mapping["device"], "File link escaped the candidate DrvFs")
            if stat.S_ISREG(before["mode"]) or stat.S_ISDIR(before["mode"]):
                require(hops and relative not in allowed,
                        "Native LX_SYMLINK inventory is not a Linux file symlink")
                require(_file_identity(current) == before, "File-link final identity drifted")
                result.append({"path": windows_path, "native_entry_kind": kind,
                               "target_kind": "directory" if stat.S_ISDIR(before["mode"]) else "file",
                               "hops": hops, "final": {"path": relative, **before}})
                break
            require(stat.S_ISLNK(before["mode"]) and relative in allowed
                    and len(hops) < MAX_RELATIVE_LINK_HOPS,
                    "Relative LX-link hop is unknown or exceeds its bound")
            target = os.readlink(current)
            require(_file_identity(current) == before and os.readlink(current) == target,
                    "File-link identity or raw target drifted during qualification")
            _link_parent_directories(root, current, mapping["device"])
            record = allowed[relative]
            hops.append({"path": relative, "native_entry_kind": record["kind"],
                         "native_reparse_tag": record["tag"], "target": target, **before})
            relative = _resolve_qualified_link(relative, target, record, mapping, native)
        else:
            raise BuildControlError("Relative file-link chain exceeds its fixed hop bound")
    require(not expected or time.monotonic() < deadline,
            "Relative file-link qualification exceeded its time bound")
    return _validate_link_evidence(result, mapping, native)


def _observation(context, backend, foreign, source):
    linux = _linux_identity(context["source_root"], context["reference_root"])
    engine = _engine()
    require(engine["ID"] == linux["engine_id"], "Docker engine differs from the reference admission")
    mapping = _mapping(source)
    native = _native(source, context["distro"])
    return {"engine": engine, "backend": _container_pin(backend), "foreign": _container_pin(foreign),
            "linux": linux, "mapping": mapping, "native": native,
            "contained_links": _qualify_links(mapping, native)}


def _observation_differences(left, right, prefix="observation", depth=0):
    if left == right:
        return []
    if isinstance(left, dict) and isinstance(right, dict) and depth < 5:
        changed = []
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                changed.append(prefix + "." + key)
            else:
                changed.extend(_observation_differences(left[key], right[key], prefix + "." + key, depth + 1))
            if len(changed) >= 16:
                break
        return changed[:16]
    return [prefix]


def validate_windows_bind_disjoint_proof(proof, *, source, container_id):
    require(isinstance(proof, dict) and set(proof) == PROOF_FIELDS
            and proof["schema"] == SCHEMA and proof["decision"] == "disjoint"
            and proof["container_id"] == container_id and CID.fullmatch(str(container_id))
            and proof["source_sha256"] == _sha(source.encode("utf-8"))
            and proof["provider_sha256"] == _sha(WINDOWS_PROVIDER.encode("utf-8")),
            "Windows isolation proof schema/source/consumer differs")
    context = proof["context"]
    require(isinstance(context, dict) and set(context) == {
        "identity", "project", "control_volume", "control_namespace", "ledger_volume", "distro",
        "source_root", "reference_root"} and isinstance(context.get("distro"), str),
        "Windows isolation context is absent")
    identity = context["identity"]
    require(isinstance(identity, dict) and identity.get("project_name") == context["project"]
            and identity.get("source_root") == context["source_root"]
            and identity.get("checkout_kind") in {"main-checkout", "worktree"}
            and all(isinstance(context.get(key), str) and context[key]
                    for key in ("project", "control_volume", "ledger_volume", "source_root", "reference_root"))
            and isinstance(context["control_namespace"], str),
            "Windows isolation registered group binding is incomplete")
    for observed in (proof["before"], proof["after"]):
        _validate_windows_bind_observation(observed, context, source=source, container_id=container_id)
    if proof["before"] != proof["after"]:
        raise WindowsBindObservationDrift(_observation_differences(proof["before"], proof["after"]))
    return proof


def _validate_windows_bind_observation(observed, context, *, source, container_id):
    require(isinstance(observed, dict) and set(observed) == OBSERVATION_FIELDS,
            "Windows isolation observation is incomplete")
    _validate_engine(observed["engine"])
    require(observed["foreign"].get("id") == container_id
            and observed["linux"].get("reference_root") == context.get("reference_root")
            and observed["linux"].get("source_root") == context.get("source_root")
            and observed["engine"].get("ID") == observed["linux"].get("engine_id"),
            "Windows isolation observation does not bind its context")
    for pin in (observed["foreign"], observed["backend"]):
        require(isinstance(pin, dict) and set(pin) == {"id", "image", "config_sha256",
                "host_config_sha256", "mounts_sha256", "networks_sha256", "state"}
                and CID.fullmatch(str(pin["id"])) and IMAGE.fullmatch(str(pin["image"]))
                and isinstance(pin["state"], dict)
                and all(isinstance(pin[key], str) and SHA.fullmatch(pin[key])
                        for key in ("config_sha256", "host_config_sha256", "mounts_sha256", "networks_sha256")),
                "Windows isolation critical container pin is malformed")
    require(observed["backend"]["id"] != container_id, "Own backend cannot be the foreign consumer")
    linux = observed["linux"]
    require(isinstance(linux, dict) and linux.get("root_mount", {}).get("target") == "/"
            and linux["root_mount"].get("fstype") == "ext4" and linux["root_mount"].get("fsroot") == "/"
            and type(linux.get("root_device")) is int and linux["root_device"] > 0
            and all(type(linux.get(key)) is int and linux[key] > 0 for key in ("source_inode", "reference_inode"))
            and isinstance(linux.get("marker_sha256"), str) and SHA.fullmatch(linux["marker_sha256"]),
            "Windows isolation reference is not pinned to WSL root ext4")
    _validate_native(observed["native"], source, context["distro"])
    mapping = observed["mapping"]
    require(isinstance(mapping, dict) and mapping.get("mount", {}).get("fstype") in {"9p", "drvfs"}
            and mapping["mount"].get("fsroot") == "/"
            and ntpath.normcase(str(mapping["mount"].get("source"))) == ntpath.normcase(_windows_source_path(source)[:2] + chr(92))
            and ntpath.normcase(_windows_path(mapping.get("roundtrip"))) == ntpath.normcase(_windows_source_path(source))
            and type(mapping.get("device")) is int and type(mapping.get("inode")) is int
            and mapping["inode"] > 0 and type(mapping.get("mode")) is int,
            "Windows isolation native/DrvFs mapping is malformed")
    expected_kind = observed["native"]["candidate"]["kind"]
    require((expected_kind == "file" and stat.S_ISREG(mapping["mode"]) and mapping.get("nlink") == 1)
            or (expected_kind == "directory" and stat.S_ISDIR(mapping["mode"])),
            "Windows and WSL candidate object types differ")
    require(observed["mapping"]["device"] != observed["linux"]["root_device"],
            "DrvFs mapping is not physically separate from the WSL-native root")
    target, path = Path(mapping["mount"].get("target", "")), Path(mapping.get("path", ""))
    require(target.is_absolute() and path.is_absolute()
            and ".." not in target.parts and ".." not in path.parts
            and (path == target or target in path.parents),
            "Windows proof mount does not contain its translated candidate")
    _validate_link_evidence(observed["contained_links"], mapping, observed["native"])


def prove_windows_bind_disjoint(control, backend, container, source, reference_root):
    """Prove and archive one exact literal Windows bind, without entering a container."""
    _windows_source_path(source)
    first_backend, first_foreign = _inspect(backend["Id"]), _inspect(container["Id"])
    require(_container_pin(first_backend) == _container_pin(backend)
            and _container_pin(first_foreign) == _container_pin(container),
            "Consumer changed before Windows isolation proof")
    context = _context(control, first_backend, first_foreign, source, reference_root)
    before = _observation(context, first_backend, first_foreign, source)
    after_backend, after_foreign = _inspect(backend["Id"]), _inspect(container["Id"])
    require(_context(control, after_backend, after_foreign, source, reference_root) == context,
            "Registered proof context changed")
    after = _observation(context, after_backend, after_foreign, source)
    final_backend, final_foreign = _inspect(backend["Id"]), _inspect(container["Id"])
    require(_container_pin(final_backend) == after["backend"]
            and _container_pin(final_foreign) == after["foreign"] and _engine() == after["engine"],
            "Consumer or engine changed after native Windows identity observation")
    proof = {"schema": SCHEMA, "decision": "disjoint", "container_id": container["Id"],
             "source_sha256": _sha(source.encode("utf-8")), "context": context,
             "provider_sha256": _sha(WINDOWS_PROVIDER.encode("utf-8")), "before": before, "after": after}
    validate_windows_bind_disjoint_proof(proof, source=source, container_id=container["Id"])
    from docker_bind_overlap_probe import _archive_foreign_proof
    # Read-only preflight has no lease. The repeated destructive-boundary
    # observation is archived by the existing active-operation publisher.
    _archive_foreign_proof(control, proof)
    return proof
