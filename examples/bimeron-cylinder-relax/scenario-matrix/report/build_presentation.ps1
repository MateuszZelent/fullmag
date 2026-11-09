[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ResultsIndex,

    [Parameter(Mandatory = $true)]
    [string] $ResultsRoot,

    [Parameter(Mandatory = $true)]
    [string] $OutputPptx,

    [Parameter()]
    [string] $ExportSlidesDirectory,

    [Parameter()]
    [switch] $ValidateOnly,

    [Parameter()]
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ComRefs = New-Object 'System.Collections.Generic.List[object]'
$script:Colors = @{
    Navy      = '18324B'
    Blue      = '2C5D7C'
    Teal      = '287D7D'
    Ink       = '172B3A'
    Muted     = '5F7180'
    Line      = 'D8E1E8'
    Panel     = 'F4F7F9'
    White     = 'FFFFFF'
    Good      = '287A55'
    Caution   = 'A76719'
}

function Get-JsonValue {
    param(
        [Parameter(Mandatory = $true)] $Object,
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string] $Context
    )
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "${Context}: missing required field '$Name'."
    }
    return $property.Value
}

function Get-RequiredText {
    param($Object, [string] $Name, [string] $Context)
    $value = Get-JsonValue -Object $Object -Name $Name -Context $Context
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
        throw "$Context.$Name must be a non-empty string."
    }
    return $value
}

function Test-FiniteNumber {
    param($Value)
    if ($null -eq $Value -or $Value -is [bool]) { return $false }
    $parsed = 0.0
    $style = [System.Globalization.NumberStyles]::Float
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    if (-not [double]::TryParse([string] $Value, $style, $culture, [ref] $parsed)) { return $false }
    return -not ([double]::IsNaN($parsed) -or [double]::IsInfinity($parsed))
}

function Assert-NullableNumber {
    param($Value, [string] $Context)
    if ($null -ne $Value -and -not (Test-FiniteNumber $Value)) {
        throw "$Context must be a finite number or null."
    }
}

function Assert-NumericEqual {
    param($Actual, [double] $Expected, [string] $Context)
    if (-not (Test-FiniteNumber $Actual)) { throw "$Context must be numeric." }
    $actualNumber = [double] $Actual
    $tolerance = [Math]::Max(1.0e-30, [Math]::Abs($Expected) * 1.0e-9)
    if ([Math]::Abs($actualNumber - $Expected) -gt $tolerance) {
        throw "$Context must equal $Expected; got $actualNumber."
    }
}

function Test-PathWithinRoot {
    param([string] $Root, [string] $Candidate)
    $rootPrefix = $Root.TrimEnd([char[]] @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
    $prefix = $rootPrefix + [IO.Path]::DirectorySeparatorChar
    $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') {
        [StringComparison]::OrdinalIgnoreCase
    } else {
        [StringComparison]::Ordinal
    }
    return $Candidate.Equals($rootPrefix, $comparison) -or $Candidate.StartsWith($prefix, $comparison)
}

function Assert-NoReparsePointBelowRoot {
    param([string] $Root, [string] $FilePath, [string] $Context)
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "${Context}: ResultsRoot itself is a symlink, junction, or reparse point."
    }

    $rootPrefix = $Root.TrimEnd([char[]] @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
    $relative = $FilePath.Substring(($rootPrefix + [IO.Path]::DirectorySeparatorChar).Length)
    $cursor = $rootPrefix
    foreach ($part in ($relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($part)) { continue }
        $cursor = Join-Path -Path $cursor -ChildPath $part
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "${Context}: reparse point is not allowed in plot path '$cursor'."
            }
        }
    }
}

function Get-BigEndianUInt32 {
    param([byte[]] $Bytes, [int] $Offset)
    return [uint32] (([uint64] $Bytes[$Offset] * 16777216) +
        ([uint64] $Bytes[$Offset + 1] * 65536) +
        ([uint64] $Bytes[$Offset + 2] * 256) +
        [uint64] $Bytes[$Offset + 3])
}

function Resolve-PlotPath {
    param([string] $Root, [string] $RelativePath, [string] $Context)
    if ([string]::IsNullOrWhiteSpace($RelativePath)) { throw "$Context must be a relative PNG path." }
    if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "$Context must not be rooted or traverse upward: '$RelativePath'."
    }
    if ([IO.Path]::GetExtension($RelativePath) -ine '.png') { throw "$Context must use a .png file." }

    $candidate = [IO.Path]::GetFullPath((Join-Path -Path $Root -ChildPath $RelativePath))
    if (-not (Test-PathWithinRoot -Root $Root -Candidate $candidate)) {
        throw "$Context resolves outside ResultsRoot: '$RelativePath'."
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Context PNG does not exist: '$candidate'."
    }
    Assert-NoReparsePointBelowRoot -Root $Root -FilePath $candidate -Context $Context

    $bytes = [IO.File]::ReadAllBytes($candidate)
    $signature = [byte[]] @(137, 80, 78, 71, 13, 10, 26, 10)
    if ($bytes.Length -lt 24) { throw "$Context is not a complete PNG file." }
    for ($i = 0; $i -lt $signature.Length; $i++) {
        if ($bytes[$i] -ne $signature[$i]) { throw "$Context does not have a PNG signature." }
    }
    $width = Get-BigEndianUInt32 -Bytes $bytes -Offset 16
    $height = Get-BigEndianUInt32 -Bytes $bytes -Offset 20
    if ($width -lt 1 -or $height -lt 1 -or $width -gt 50000 -or $height -gt 50000) {
        throw "$Context has invalid PNG dimensions ($width x $height)."
    }
    return [pscustomobject] @{ Path = $candidate; Width = [double] $width; Height = [double] $height }
}

function Compare-MaterialValues {
    param($Existing, $Incoming, [string] $Context)
    foreach ($name in @('label', 'Ms_Apm', 'Aex_Jpm', 'Ku_Jpm3', 'D_Jpm2', 'alpha')) {
        $left = Get-JsonValue -Object $Existing -Name $name -Context "$Context existing material"
        $right = Get-JsonValue -Object $Incoming -Name $name -Context "$Context repeated material"
        if ($null -eq $left -or $null -eq $right) {
            if ($null -ne $left -or $null -ne $right) { throw "$Context has inconsistent material field '$name'." }
        } elseif ($left -is [string] -or $right -is [string]) {
            if ([string] $left -cne [string] $right) { throw "$Context has inconsistent material field '$name'." }
        } elseif ([double] $left -ne [double] $right) {
            throw "$Context has inconsistent material field '$name'."
        }
    }
}

function Read-AndValidateIndex {
    param([string] $IndexPath, [string] $RootPath)
    if (-not (Test-Path -LiteralPath $IndexPath -PathType Leaf)) {
        throw "ResultsIndex does not exist: '$IndexPath'."
    }
    $indexItem = Get-Item -LiteralPath $IndexPath -Force
    if (($indexItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'ResultsIndex must not be a symlink, junction, or reparse point.'
    }
    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
        throw "ResultsRoot does not exist or is not a directory: '$RootPath'."
    }
    $rootItem = Get-Item -LiteralPath $RootPath -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'ResultsRoot must not be a symlink, junction, or reparse point.'
    }

    try {
        $index = Get-Content -LiteralPath $IndexPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Could not parse ResultsIndex JSON: $($_.Exception.Message)"
    }
    $schema = Get-RequiredText -Object $index -Name 'schema_version' -Context 'ResultsIndex'
    if ($schema -cne 'fullmag.bimeron-matrix-results.v1') {
        throw "Unsupported ResultsIndex schema '$schema'."
    }

    $geometry = Get-JsonValue -Object $index -Name 'geometry' -Context 'ResultsIndex'
    $filmSize = @(Get-JsonValue -Object $geometry -Name 'film_size_m' -Context 'geometry')
    if ($filmSize.Count -ne 3) { throw 'geometry.film_size_m must contain three values.' }
    Assert-NumericEqual $filmSize[0] 6.0e-7 'geometry.film_size_m[0]'
    Assert-NumericEqual $filmSize[1] 6.0e-7 'geometry.film_size_m[1]'
    Assert-NumericEqual $filmSize[2] 1.0e-8 'geometry.film_size_m[2]'
    Assert-NumericEqual (Get-JsonValue $geometry 'cylinder_radius_m' 'geometry') 5.0e-8 'geometry.cylinder_radius_m'
    Assert-NumericEqual (Get-JsonValue $geometry 'cylinder_height_m' 'geometry') 3.0e-8 'geometry.cylinder_height_m'
    Assert-NumericEqual (Get-JsonValue $geometry 'gap_m' 'geometry') 5.0e-9 'geometry.gap_m'
    $cell = @(Get-JsonValue -Object $geometry -Name 'cell_m' -Context 'geometry')
    if ($cell.Count -ne 3) { throw 'geometry.cell_m must contain three values.' }
    foreach ($axis in 0..2) { Assert-NumericEqual $cell[$axis] 2.5e-9 "geometry.cell_m[$axis]" }

    $cases = @(Get-JsonValue -Object $index -Name 'cases' -Context 'ResultsIndex')
    if ($cases.Count -ne 12) { throw "ResultsIndex must contain exactly 12 cases; found $($cases.Count)." }

    $requiredMaterials = @('current_rdmi', 'yig', 'permalloy')
    $requiredFilmInitials = @('bimeron', 'uniform_plus_x')
    $requiredDotDirections = @(-1, 1)
    $seenCombos = @{}
    $seenCaseIds = @{}
    $seenRunIds = @{}
    $materials = @{}
    $imageCache = @{}
    $validated = New-Object 'System.Collections.Generic.List[object]'

    foreach ($case in $cases) {
        $context = "case[$(Get-RequiredText $case 'case_id' 'case')]"
        $caseId = Get-RequiredText $case 'case_id' $context
        if ($seenCaseIds.ContainsKey($caseId)) { throw "Duplicate case_id '$caseId'." }
        $seenCaseIds[$caseId] = $true

        $material = Get-JsonValue -Object $case -Name 'material' -Context $context
        $materialId = Get-RequiredText $material 'id' "$context.material"
        if ($requiredMaterials -cnotcontains $materialId) { throw "$context uses unsupported material '$materialId'." }
        [void] (Get-RequiredText $material 'label' "$context.material")
        foreach ($field in @('Ms_Apm', 'Aex_Jpm', 'Ku_Jpm3', 'D_Jpm2', 'alpha')) {
            Assert-NullableNumber (Get-JsonValue -Object $material -Name $field -Context "$context.material") "$context.material.$field"
        }
        if ($materials.ContainsKey($materialId)) {
            Compare-MaterialValues -Existing $materials[$materialId] -Incoming $material -Context "material '$materialId'"
        } else {
            $materials[$materialId] = $material
        }

        $filmInitial = Get-RequiredText $case 'film_initial' $context
        if ($requiredFilmInitials -cnotcontains $filmInitial) { throw "$context has unsupported film_initial '$filmInitial'." }
        $dotDirection = Get-JsonValue -Object $case -Name 'dot_mx' -Context $context
        if (-not (Test-FiniteNumber $dotDirection) -or @(-1, 1) -notcontains [int] $dotDirection -or [double] $dotDirection -ne [int] $dotDirection) {
            throw "$context.dot_mx must be -1 or 1."
        }
        $comboKey = "$materialId|$filmInitial|$([int] $dotDirection)"
        if ($seenCombos.ContainsKey($comboKey)) { throw "Duplicate scenario combination '$comboKey'." }
        $seenCombos[$comboKey] = $true

        $runId = Get-RequiredText $case 'run_id' $context
        if ($seenRunIds.ContainsKey($runId)) { throw "Duplicate run_id '$runId'." }
        $seenRunIds[$runId] = $true

        if ((Get-RequiredText $case 'status' $context) -cne 'completed') {
            throw "$context is not completed; no partial deck is created."
        }
        $steps = Get-JsonValue -Object $case -Name 'steps' -Context $context
        if (-not (Test-FiniteNumber $steps) -or [double] $steps -lt 0 -or [Math]::Floor([double] $steps) -ne [double] $steps) {
            throw "$context.steps must be a non-negative integer."
        }
        $maxSteps = Get-JsonValue -Object $case -Name 'max_steps' -Context $context
        Assert-NumericEqual $maxSteps 3000 "$context.max_steps"
        if ([double] $steps -gt [double] $maxSteps) { throw "$context.steps exceeds max_steps." }
        $converged = Get-JsonValue -Object $case -Name 'converged' -Context $context
        if ($converged -isnot [bool]) { throw "$context.converged must be an explicit Boolean." }
        Assert-NullableNumber (Get-JsonValue -Object $case -Name 'max_torque_T' -Context $context) "$context.max_torque_T"
        Assert-NullableNumber (Get-JsonValue -Object $case -Name 'wall_time_s' -Context $context) "$context.wall_time_s"
        $zarrPath = Get-RequiredText $case 'zarr_path' $context

        $execution = Get-JsonValue -Object $case -Name 'execution' -Context $context
        foreach ($modeName in @('requested', 'resolved')) {
            $mode = Get-JsonValue -Object $execution -Name $modeName -Context "$context.execution"
            $backend = Get-RequiredText $mode 'backend' "$context.execution.$modeName"
            $device = Get-RequiredText $mode 'device' "$context.execution.$modeName"
            if ($backend -cne 'fdm' -or $device -cne 'gpu') {
                throw "$context.execution.$modeName must explicitly be backend='fdm', device='gpu'; got '$backend'/'$device'."
            }
        }

        $energies = Get-JsonValue -Object $case -Name 'energies_J' -Context $context
        $null = Get-JsonValue -Object $energies -Name 'total' -Context "$context.energies_J"
        foreach ($energy in $energies.PSObject.Properties) {
            Assert-NullableNumber $energy.Value "$context.energies_J.$($energy.Name)"
        }

        $plots = Get-JsonValue -Object $case -Name 'plots' -Context $context
        foreach ($plotName in @('initial_2d', 'initial_3d', 'final_2d', 'final_3d')) {
            $relative = Get-RequiredText $plots $plotName "$context.plots"
            $cacheKey = $relative.Replace('\', '/')
            if (-not $imageCache.ContainsKey($cacheKey)) {
                $imageCache[$cacheKey] = Resolve-PlotPath -Root $RootPath -RelativePath $relative -Context "$context.plots.$plotName"
            }
        }
        $provenance = Get-JsonValue -Object $case -Name 'plot_provenance' -Context $context
        $plotKind = Get-RequiredText $provenance 'kind' "$context.plot_provenance"
        if (@('ui_capture', 'data_render') -cnotcontains $plotKind) {
            throw "$context.plot_provenance.kind must be 'ui_capture' or 'data_render'."
        }

        $sourceSha = Get-RequiredText $case 'source_sha256' $context
        if ($sourceSha -cnotmatch '^[0-9a-fA-F]{64}$') { throw "$context.source_sha256 must be a 64-character SHA-256." }
        $validated.Add([pscustomobject] @{
            Case = $case
            MaterialId = $materialId
            FilmInitial = $filmInitial
            DotDirection = [int] $dotDirection
            Images = @{
                initial_3d = $imageCache[$plots.initial_3d.Replace('\', '/')]
                initial_2d = $imageCache[$plots.initial_2d.Replace('\', '/')]
                final_3d = $imageCache[$plots.final_3d.Replace('\', '/')]
                final_2d = $imageCache[$plots.final_2d.Replace('\', '/')]
            }
            PlotKind = $plotKind
        })
    }

    $expectedComboCount = $requiredMaterials.Count * $requiredFilmInitials.Count * $requiredDotDirections.Count
    if ($seenCombos.Count -ne $expectedComboCount) {
        throw "Scenario matrix is incomplete: expected $expectedComboCount unique combinations; found $($seenCombos.Count)."
    }
    foreach ($materialId in $requiredMaterials) {
        if (-not $materials.ContainsKey($materialId)) { throw "Scenario matrix is missing material '$materialId'." }
    }

    $sortedCases = @($validated | Sort-Object MaterialId, FilmInitial, DotDirection)
    return [pscustomobject] @{
        Index = $index
        IndexPath = $IndexPath
        RootPath = $RootPath
        Cases = $sortedCases
        Materials = $materials
        ImageCount = $imageCache.Count
        IndexSha256 = (Get-FileHash -LiteralPath $IndexPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Add-ComRef {
    param($Value)
    if ($null -eq $Value -or -not [Runtime.InteropServices.Marshal]::IsComObject($Value)) { return }
    foreach ($existing in $script:ComRefs) {
        if ([object]::ReferenceEquals($existing, $Value)) { return }
    }
    $script:ComRefs.Add($Value)
}

function Release-ComRefs {
    for ($i = $script:ComRefs.Count - 1; $i -ge 0; $i--) {
        $value = $script:ComRefs[$i]
        try {
            if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
                [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)
            }
        } catch { }
    }
    $script:ComRefs.Clear()
}

function Release-OneComRef {
    param($Value)
    if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
        try { [void] [Runtime.InteropServices.Marshal]::ReleaseComObject($Value) } catch { }
    }
}

function Convert-HexColor {
    param([string] $Hex)
    $red = [Convert]::ToInt32($Hex.Substring(0, 2), 16)
    $green = [Convert]::ToInt32($Hex.Substring(2, 2), 16)
    $blue = [Convert]::ToInt32($Hex.Substring(4, 2), 16)
    return [int] ($red + ($green * 256) + ($blue * 65536))
}

function Add-Rect {
    param($Slide, [double] $X, [double] $Y, [double] $Width, [double] $Height, [string] $Fill, [string] $Line = '')
    $shape = $Slide.Shapes.AddShape(1, $X, $Y, $Width, $Height)
    $shape.Fill.ForeColor.RGB = Convert-HexColor $Fill
    if ([string]::IsNullOrEmpty($Line)) {
        $shape.Line.Visible = 0
    } else {
        $shape.Line.Visible = -1
        $shape.Line.ForeColor.RGB = Convert-HexColor $Line
        $shape.Line.Weight = 0.8
    }
    Release-OneComRef $shape
}

function Add-Text {
    param(
        $Slide, [string] $Text, [double] $X, [double] $Y, [double] $Width, [double] $Height,
        [double] $FontSize, [string] $Color, [switch] $Bold, [int] $Alignment = 1,
        [string] $FontName = 'Arial'
    )
    $shape = $Slide.Shapes.AddTextbox(1, $X, $Y, $Width, $Height)
    $frame = $shape.TextFrame
    $frame.MarginLeft = 1
    $frame.MarginRight = 1
    $frame.MarginTop = 0
    $frame.MarginBottom = 0
    $frame.WordWrap = -1
    $frame.AutoSize = 0
    $frame.VerticalAnchor = 3
    $range = $frame.TextRange
    $range.Text = $Text
    $range.Font.Name = $FontName
    $range.Font.Size = $FontSize
    $range.Font.Bold = [bool] $Bold
    $range.Font.Color.RGB = Convert-HexColor $Color
    $range.ParagraphFormat.Alignment = $Alignment
    Release-OneComRef $shape
}

function Add-NoteJson {
    param($Slide, [string] $Heading, $Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 40
    $noteText = "$Heading`r`n$json"
    $notesPage = $Slide.NotesPage
    $notesShapes = $notesPage.Shapes
    $placeholders = $notesShapes.Placeholders
    $body = $placeholders.Item(2)
    $body.TextFrame.TextRange.Text = $noteText
    $body.TextFrame.TextRange.Font.Name = 'Consolas'
    $body.TextFrame.TextRange.Font.Size = 8
    Release-OneComRef $body
    Release-OneComRef $placeholders
    Release-OneComRef $notesShapes
    Release-OneComRef $notesPage
}

function Add-Footer {
    param($Slide, [int] $Number, [string] $Section)
    Add-Rect -Slide $Slide -X 34 -Y 519 -Width 892 -Height 1 -Fill $script:Colors.Line
    Add-Text -Slide $Slide -Text "Fullmag · bimeron/cylinder · $Section" -X 36 -Y 522 -Width 620 -Height 13 -FontSize 8.5 -Color $script:Colors.Muted -Alignment 1
    Add-Text -Slide $Slide -Text ("{0:D2} / 16" -f $Number) -X 850 -Y 522 -Width 74 -Height 13 -FontSize 8.5 -Color $script:Colors.Muted -Alignment 3
}

function Add-NewSlide {
    param($Presentation, $SlidesCollection, [int] $Number, [string] $Section)
    $slide = $SlidesCollection.Add($Number, 12)
    Add-ComRef $slide
    $slide.FollowMasterBackground = 0
    $slide.Background.Fill.ForeColor.RGB = Convert-HexColor $script:Colors.White
    Add-Footer -Slide $slide -Number $Number -Section $Section
    return $slide
}

function Format-Scientific {
    param($Value, [string] $Unit = '')
    if ($null -eq $Value) { return 'n/d' }
    if (-not (Test-FiniteNumber $Value)) { return 'n/d' }
    $formatted = ([double] $Value).ToString('0.###E+0', [Globalization.CultureInfo]::InvariantCulture)
    if ([string]::IsNullOrEmpty($Unit)) { return $formatted }
    return "$formatted $Unit"
}

function Get-MaterialLabel {
    param([string] $MaterialId, $Material)
    $idSuffix = switch ($MaterialId) {
        'current_rdmi' { 'current rDMI' }
        'yig' { 'YIG' }
        'permalloy' { 'Permalloy (Py)' }
        default { $MaterialId }
    }
    return "$($Material.label) · $idSuffix"
}

function Get-FilmInitialLabel {
    param([string] $FilmInitial)
    if ($FilmInitial -eq 'bimeron') { return 'bimeron' }
    return 'jednorodny +x'
}

function Get-DotLabel {
    param([int] $Direction)
    if ($Direction -gt 0) { return '+x' }
    return '−x'
}

function Get-PlotKindLabel {
    param([string] $Kind)
    if ($Kind -eq 'ui_capture') { return 'zrzut widoku UI' }
    return 'render z zapisanych danych'
}

function Add-ImagePanel {
    param($Slide, [string] $Title, $Image, [double] $X, [double] $Y, [double] $Width, [double] $Height)
    Add-Rect -Slide $Slide -X $X -Y $Y -Width $Width -Height $Height -Fill $script:Colors.Panel -Line $script:Colors.Line
    Add-Text -Slide $Slide -Text $Title -X ($X + 10) -Y ($Y + 5) -Width ($Width - 20) -Height 18 -FontSize 11 -Color $script:Colors.Ink -Bold

    $innerX = $X + 9
    $innerY = $Y + 26
    $innerWidth = $Width - 18
    $innerHeight = $Height - 33
    $scale = [Math]::Min(($innerWidth / $Image.Width), ($innerHeight / $Image.Height))
    $imageWidth = $Image.Width * $scale
    $imageHeight = $Image.Height * $scale
    $left = $innerX + (($innerWidth - $imageWidth) / 2)
    $top = $innerY + (($innerHeight - $imageHeight) / 2)
    $picture = $Slide.Shapes.AddPicture($Image.Path, 0, -1, $left, $top, $imageWidth, $imageHeight)
    Release-OneComRef $picture
}

function Add-CoverSlide {
    param($Presentation, $Slides, $Validated)
    $slide = Add-NewSlide $Presentation $Slides 1 'wyniki'
    Add-Text -Slide $slide -Text 'RELaksacja FDM GPU' -X 52 -Y 48 -Width 850 -Height 24 -FontSize 13 -Color $script:Colors.Teal -Bold
    Add-Text -Slide $slide -Text 'Film bimeronowy i walec ferromagnetyczny' -X 52 -Y 104 -Width 850 -Height 76 -FontSize 31 -Color $script:Colors.Navy -Bold
    Add-Text -Slide $slide -Text 'Macierz materiału, stanu filmu i początkowej polaryzacji cylindra' -X 54 -Y 190 -Width 820 -Height 42 -FontSize 19 -Color $script:Colors.Ink

    Add-Rect -Slide $slide -X 52 -Y 276 -Width 856 -Height 112 -Fill $script:Colors.Panel -Line $script:Colors.Line
    Add-Text -Slide $slide -Text '3 materiały  ×  2 stany filmu  ×  2 kierunki cylindra' -X 76 -Y 300 -Width 808 -Height 28 -FontSize 19 -Color $script:Colors.Navy -Bold
    $convergedCount = @($Validated.Cases | Where-Object { $_.Case.converged -eq $true }).Count
    Add-Text -Slide $slide -Text "12/12 ukończonych wpisów · FDM GPU żądane i rozwiązane · zbieżność jawnie potwierdzona w $convergedCount/12 przypadkach" -X 76 -Y 340 -Width 812 -Height 27 -FontSize 12 -Color $script:Colors.Ink

    Add-Text -Slide $slide -Text 'PG-BB · maks. 3000 kroków · komórka 2,5 nm · brak fizycznego czasu relaksacji' -X 54 -Y 428 -Width 840 -Height 25 -FontSize 14 -Color $script:Colors.Muted
    Add-Text -Slide $slide -Text "Źródło: $($Validated.IndexSha256) · schema fullmag.bimeron-matrix-results.v1" -X 54 -Y 461 -Width 840 -Height 22 -FontSize 9 -Color $script:Colors.Muted
    Add-NoteJson -Slide $slide -Heading 'FULLMAG_BIMERON_MATRIX_INDEX_METADATA_JSON' -Value $Validated.Index
    return $slide
}

function Add-ParametersSlide {
    param($Presentation, $Slides, $Validated)
    $slide = Add-NewSlide $Presentation $Slides 2 'konfiguracja'
    Add-Text -Slide $slide -Text 'Konfiguracja wspólna i warianty materiału' -X 38 -Y 30 -Width 880 -Height 34 -FontSize 23 -Color $script:Colors.Navy -Bold

    Add-Rect -Slide $slide -X 38 -Y 86 -Width 316 -Height 382 -Fill $script:Colors.Panel -Line $script:Colors.Line
    Add-Text -Slide $slide -Text 'Geometria i metoda' -X 56 -Y 101 -Width 280 -Height 25 -FontSize 15 -Color $script:Colors.Navy -Bold
    $geometryText = @(
        'Film: 600 × 600 × 10 nm',
        'Walec: R = 50 nm, h = 30 nm',
        'Szczelina: 5 nm',
        'Komórka: 2,5 nm (x, y, z)',
        '',
        'Silnik: FDM GPU',
        'Relaksacja: projected-gradient BB',
        'Budżet: do 3000 kroków',
        'Czas fizyczny: 0 (metoda relaksacyjna)',
        '',
        'Stany filmu: bimeron / jednorodny +x',
        'Początkowy mx walca: +1 / −1'
    ) -join "`r`n"
    Add-Text -Slide $slide -Text $geometryText -X 56 -Y 139 -Width 282 -Height 276 -FontSize 13 -Color $script:Colors.Ink

    $materialX = 374
    $materialWidth = 548
    $materialY = 86
    $cardHeight = 117
    $materialOrder = @('current_rdmi', 'yig', 'permalloy')
    for ($i = 0; $i -lt $materialOrder.Count; $i++) {
        $materialId = $materialOrder[$i]
        $material = $Validated.Materials[$materialId]
        $y = $materialY + ($i * ($cardHeight + 13))
        Add-Rect -Slide $slide -X $materialX -Y $y -Width $materialWidth -Height $cardHeight -Fill $script:Colors.White -Line $script:Colors.Line
        Add-Rect -Slide $slide -X $materialX -Y $y -Width 6 -Height $cardHeight -Fill $(if ($i -eq 0) { $script:Colors.Teal } elseif ($i -eq 1) { $script:Colors.Blue } else { $script:Colors.Navy })
        Add-Text -Slide $slide -Text (Get-MaterialLabel $materialId $material) -X ($materialX + 18) -Y ($y + 12) -Width ($materialWidth - 32) -Height 23 -FontSize 15 -Color $script:Colors.Navy -Bold
        $values = "Ms $(Format-Scientific $material.Ms_Apm 'A/m')    Aex $(Format-Scientific $material.Aex_Jpm 'J/m')`r`nKu $(Format-Scientific $material.Ku_Jpm3 'J/m³')    D $(Format-Scientific $material.D_Jpm2 'J/m²')`r`nα $(Format-Scientific $material.alpha)"
        Add-Text -Slide $slide -Text $values -X ($materialX + 18) -Y ($y + 41) -Width ($materialWidth - 34) -Height 62 -FontSize 11.5 -Color $script:Colors.Ink -FontName 'Consolas'
    }

    Add-Text -Slide $slide -Text 'Parametry materialu pochodzą z indexu wyników; n/d oznacza jawne null.' -X 40 -Y 481 -Width 875 -Height 22 -FontSize 10 -Color $script:Colors.Muted
    Add-NoteJson -Slide $slide -Heading 'FULLMAG_BIMERON_MATRIX_GEOMETRY_AND_MATERIALS_JSON' -Value ([pscustomobject] @{
        schema_version = $Validated.Index.schema_version
        geometry = $Validated.Index.geometry
        materials = $Validated.Materials
        execution = @($Validated.Cases | ForEach-Object { $_.Case.execution })
        method = 'FDM GPU; PG-BB relaxation; no physical time'
        results_index_sha256 = $Validated.IndexSha256
    })
    return $slide
}

function Add-CaseSlide {
    param($Presentation, $Slides, $ValidatedCase, [int] $SlideNumber)
    $case = $ValidatedCase.Case
    $material = $case.material
    $materialLabel = Get-MaterialLabel $ValidatedCase.MaterialId $material
    $filmLabel = Get-FilmInitialLabel $ValidatedCase.FilmInitial
    $dotLabel = Get-DotLabel $ValidatedCase.DotDirection
    $plotLabel = Get-PlotKindLabel $ValidatedCase.PlotKind
    $slide = Add-NewSlide $Presentation $Slides $SlideNumber 'przypadki'

    Add-Text -Slide $slide -Text "$($material.label) · film $filmLabel · walec $dotLabel" -X 35 -Y 17 -Width 890 -Height 31 -FontSize 21 -Color $script:Colors.Navy -Bold
    Add-Text -Slide $slide -Text "$($ValidatedCase.MaterialId)  |  $plotLabel  |  run: $($case.run_id)" -X 37 -Y 52 -Width 886 -Height 19 -FontSize 9 -Color $script:Colors.Muted

    $left = 35.0
    $right = 483.0
    $panelWidth = 442.0
    $panelHeight = 177.0
    Add-ImagePanel -Slide $slide -Title 'Początek · 3D' -Image $ValidatedCase.Images.initial_3d -X $left -Y 78 -Width $panelWidth -Height $panelHeight
    Add-ImagePanel -Slide $slide -Title 'Początek · 2D' -Image $ValidatedCase.Images.initial_2d -X $right -Y 78 -Width $panelWidth -Height $panelHeight
    Add-ImagePanel -Slide $slide -Title 'Koniec · 3D' -Image $ValidatedCase.Images.final_3d -X $left -Y 263 -Width $panelWidth -Height $panelHeight
    Add-ImagePanel -Slide $slide -Title 'Koniec · 2D' -Image $ValidatedCase.Images.final_2d -X $right -Y 263 -Width $panelWidth -Height $panelHeight

    $statusLabel = if ($case.converged) { 'zbieżność: tak' } else { 'zbieżność: nie' }
    $statusColor = if ($case.converged) { $script:Colors.Good } else { $script:Colors.Caution }
    $parameters = "Ms $(Format-Scientific $material.Ms_Apm 'A/m')   ·   Aex $(Format-Scientific $material.Aex_Jpm 'J/m')   ·   Ku $(Format-Scientific $material.Ku_Jpm3 'J/m³')   ·   D $(Format-Scientific $material.D_Jpm2 'J/m²')"
    Add-Rect -Slide $slide -X 35 -Y 450 -Width 890 -Height 60 -Fill $script:Colors.Panel -Line $script:Colors.Line
    Add-Text -Slide $slide -Text $parameters -X 47 -Y 457 -Width 866 -Height 19 -FontSize 10.5 -Color $script:Colors.Ink -FontName 'Consolas'
    $metrics = "walec $dotLabel   ·   krok $($case.steps)/$($case.max_steps)   ·   $statusLabel   ·   τmax $(Format-Scientific $case.max_torque_T 'T')   ·   E $(Format-Scientific $case.energies_J.total 'J')"
    Add-Text -Slide $slide -Text $metrics -X 47 -Y 482 -Width 866 -Height 19 -FontSize 10.5 -Color $statusColor -Bold

    $slideMetadata = [pscustomobject] @{
        case = $case
        material_display = $materialLabel
        film_initial_display = $filmLabel
        cylinder_initial_mx = $ValidatedCase.DotDirection
        plot_label = $plotLabel
        index_sha256 = $Validated.IndexSha256
    }
    Add-NoteJson -Slide $slide -Heading 'FULLMAG_BIMERON_MATRIX_CASE_METADATA_AND_PROVENANCE_JSON' -Value $slideMetadata
    return $slide
}

function Add-SummarySlide {
    param($Presentation, $Slides, $Validated)
    $slide = Add-NewSlide $Presentation $Slides 15 'podsumowanie'
    Add-Text -Slide $slide -Text 'Zestawienie wszystkich przypadków' -X 37 -Y 26 -Width 880 -Height 34 -FontSize 23 -Color $script:Colors.Navy -Bold
    Add-Text -Slide $slide -Text 'Wartości pochodzą bezpośrednio z indexu; n/d zachowuje jawne null.' -X 39 -Y 62 -Width 880 -Height 20 -FontSize 10.5 -Color $script:Colors.Muted

    $columns = @(
        @{ Name = 'Materiał · film · walec'; X = 40.0; Width = 382.0; Align = 1 },
        @{ Name = 'Kroki'; X = 424.0; Width = 82.0; Align = 2 },
        @{ Name = 'Zbieżność'; X = 510.0; Width = 94.0; Align = 2 },
        @{ Name = 'τmax [T]'; X = 608.0; Width = 144.0; Align = 2 },
        @{ Name = 'Ecałk. [J]'; X = 756.0; Width = 164.0; Align = 2 }
    )
    Add-Rect -Slide $slide -X 39 -Y 96 -Width 882 -Height 30 -Fill $script:Colors.Navy
    foreach ($column in $columns) {
        Add-Text -Slide $slide -Text $column.Name -X $column.X -Y 103 -Width $column.Width -Height 16 -FontSize 10 -Color $script:Colors.White -Bold -Alignment $column.Align
    }
    $rowTop = 128.0
    $rowHeight = 28.6
    for ($i = 0; $i -lt $Validated.Cases.Count; $i++) {
        $item = $Validated.Cases[$i]
        $case = $item.Case
        $rowY = $rowTop + ($i * $rowHeight)
        if (($i % 2) -eq 0) { Add-Rect -Slide $slide -X 39 -Y $rowY -Width 882 -Height $rowHeight -Fill $script:Colors.Panel }
        $materialTitle = switch ($item.MaterialId) {
            'current_rdmi' { 'rDMI' }
            'yig' { 'YIG' }
            'permalloy' { 'Py' }
        }
        $scenario = "$materialTitle · $(Get-FilmInitialLabel $item.FilmInitial) · $((Get-DotLabel $item.DotDirection))"
        $convergence = if ($case.converged) { 'tak' } else { 'nie' }
        $convergenceColor = if ($case.converged) { $script:Colors.Good } else { $script:Colors.Caution }
        $rowValues = @(
            @{ Text = $scenario; X = 43.0; Width = 376.0; Align = 1; Color = $script:Colors.Ink },
            @{ Text = "$($case.steps)/$($case.max_steps)"; X = 424.0; Width = 82.0; Align = 2; Color = $script:Colors.Ink },
            @{ Text = $convergence; X = 510.0; Width = 94.0; Align = 2; Color = $convergenceColor },
            @{ Text = (Format-Scientific $case.max_torque_T); X = 608.0; Width = 144.0; Align = 2; Color = $script:Colors.Ink },
            @{ Text = (Format-Scientific $case.energies_J.total); X = 756.0; Width = 164.0; Align = 2; Color = $script:Colors.Ink }
        )
        foreach ($entry in $rowValues) {
            Add-Text -Slide $slide -Text $entry.Text -X $entry.X -Y ($rowY + 7) -Width $entry.Width -Height 15 -FontSize 9.5 -Color $entry.Color -Alignment $entry.Align
        }
    }

    $summaryMetadata = @($Validated.Cases | ForEach-Object { $_.Case })
    Add-NoteJson -Slide $slide -Heading 'FULLMAG_BIMERON_MATRIX_ALL_CASES_JSON' -Value $summaryMetadata
    return $slide
}

function Add-LimitationsSlide {
    param($Presentation, $Slides, $Validated)
    $slide = Add-NewSlide $Presentation $Slides 16 'zakres i ograniczenia'
    Add-Text -Slide $slide -Text 'Zakres i ograniczenia interpretacji' -X 38 -Y 29 -Width 882 -Height 34 -FontSize 23 -Color $script:Colors.Navy -Bold
    $convergedCount = @($Validated.Cases | Where-Object { $_.Case.converged -eq $true }).Count
    $items = @(
        "Ukończony run nie oznacza zbieżności: tylko jawne pole converged=true; tutaj: $convergedCount/12.",
        '3000 kroków to budżet obliczeń. Osiągnięcie limitu nie jest interpretowane jako zbieżność.',
        'PG-BB wykonuje relaksację; wall_time_s jest czasem zegarowym obliczeń. Symulacja nie ma fizycznego czasu dynamiki.',
        'Wyniki opisują wyłącznie wskazane 12 konfiguracji i wykonanie FDM GPU; nie dowodzą parytetu CPU/FEM ani walidacji eksperymentalnej.',
        'Obrazy są podpisane według plot_provenance.kind: zrzut widoku UI albo render z zapisanych danych. Render danych nie jest zrzutem ekranu UI.',
        'Zbieżność i energie pozostają wartościami z indexu wyników; deck nie wylicza ich ponownie z obrazów.'
    )
    $y = 88.0
    foreach ($item in $items) {
        Add-Rect -Slide $slide -X 46 -Y $y -Width 868 -Height 51 -Fill $script:Colors.Panel -Line $script:Colors.Line
        Add-Rect -Slide $slide -X 46 -Y $y -Width 5 -Height 51 -Fill $script:Colors.Teal
        Add-Text -Slide $slide -Text $item -X 66 -Y ($y + 8) -Width 830 -Height 35 -FontSize 13 -Color $script:Colors.Ink
        $y += 62
    }
    Add-Text -Slide $slide -Text "Index SHA-256: $($Validated.IndexSha256)" -X 47 -Y 471 -Width 865 -Height 18 -FontSize 9 -Color $script:Colors.Muted -FontName 'Consolas'
    Add-NoteJson -Slide $slide -Heading 'FULLMAG_BIMERON_MATRIX_SCOPE_AND_PROVENANCE_JSON' -Value ([pscustomobject] @{
        results_index_sha256 = $Validated.IndexSha256
        schema_version = $Validated.Index.schema_version
        converged_cases = $convergedCount
        case_count = $Validated.Cases.Count
        plot_kinds = @($Validated.Cases | ForEach-Object { $_.PlotKind } | Sort-Object -Unique)
        physical_time_s = 0
        interpretation = 'PG-BB relaxation; wall_time_s is wall-clock time, not simulated physical time.'
    })
    return $slide
}

function Assert-PptxArchive {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "PowerPoint did not create staging file '$Path'." }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName })
        foreach ($required in @('[Content_Types].xml', 'ppt/presentation.xml')) {
            if ($entries -cnotcontains $required) { throw "Staging PPTX is missing '$required'." }
        }
        $slideParts = @($entries | Where-Object { $_ -match '^ppt/slides/slide[0-9]+\.xml$' })
        $noteParts = @($entries | Where-Object { $_ -match '^ppt/notesSlides/notesSlide[0-9]+\.xml$' })
        $mediaParts = @($entries | Where-Object { $_ -match '^ppt/media/' })
        if ($slideParts.Count -ne 16) { throw "Expected 16 slide parts; found $($slideParts.Count)." }
        if ($noteParts.Count -ne 16) { throw "Expected 16 speaker-note parts with metadata; found $($noteParts.Count)." }
        if ($mediaParts.Count -lt 48) { throw "Expected at least 48 embedded image parts; found $($mediaParts.Count)." }
    } finally {
        $archive.Dispose()
    }
}

function Assert-ExportedSlides {
    param([string] $Directory)
    $slides = @(Get-ChildItem -LiteralPath $Directory -Filter 'slide-*.png' -File)
    if ($slides.Count -ne 16) { throw "Expected 16 exported slide PNGs; found $($slides.Count)." }
    foreach ($slide in $slides) {
        $bytes = [IO.File]::ReadAllBytes($slide.FullName)
        if ($bytes.Length -lt 24 -or $bytes[0] -ne 137 -or $bytes[1] -ne 80 -or $bytes[2] -ne 78 -or $bytes[3] -ne 71) {
            throw "Exported slide is not a PNG: '$($slide.FullName)'."
        }
    }
}

function Move-FileIntoPlace {
    param([string] $Staging, [string] $Target, [switch] $Replace)
    if (Test-Path -LiteralPath $Target) {
        if (-not $Replace) { throw "Output appeared during generation; refusing to overwrite '$Target'." }
        $targetItem = Get-Item -LiteralPath $Target -Force
        if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to replace reparse-point output '$Target'."
        }
        [IO.File]::Replace($Staging, $Target, $null)
    } else {
        [IO.File]::Move($Staging, $Target)
    }
}

function Move-DirectoryIntoPlace {
    param([string] $Staging, [string] $Target, [switch] $Replace)
    if (Test-Path -LiteralPath $Target) {
        if (-not $Replace) { throw "Export directory appeared during generation; refusing to overwrite '$Target'." }
        $targetItem = Get-Item -LiteralPath $Target -Force
        if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to replace reparse-point export directory '$Target'."
        }
        $backup = "$Target.codex-backup-$([Guid]::NewGuid().ToString('N'))"
        [IO.Directory]::Move($Target, $backup)
        try {
            [IO.Directory]::Move($Staging, $Target)
        } catch {
            [IO.Directory]::Move($backup, $Target)
            throw
        }
        Remove-Item -LiteralPath $backup -Recurse -Force
    } else {
        [IO.Directory]::Move($Staging, $Target)
    }
}

$fullIndex = [IO.Path]::GetFullPath($ResultsIndex)
$fullRoot = [IO.Path]::GetFullPath($ResultsRoot)
$fullOutput = [IO.Path]::GetFullPath($OutputPptx)
$fullSlides = if ([string]::IsNullOrWhiteSpace($ExportSlidesDirectory)) { $null } else { [IO.Path]::GetFullPath($ExportSlidesDirectory) }
$stagingPptx = $null
$stagingSlides = $null
$powerpoint = $null
$presentation = $null
$slidesCollection = $null
$ownedPresentation = $false
$ownedApplication = $false
$outputReady = $false

try {
    $validated = Read-AndValidateIndex -IndexPath $fullIndex -RootPath $fullRoot
    if ($ValidateOnly) {
        Write-Output ([pscustomobject] @{
            validation = 'passed'
            case_count = $validated.Cases.Count
            unique_image_count = $validated.ImageCount
            requested_and_resolved_lane = 'fdm/gpu'
            results_index_sha256 = $validated.IndexSha256
        })
        return
    }

    if ([IO.Path]::GetExtension($fullOutput) -ine '.pptx') { throw 'OutputPptx must have a .pptx extension.' }
    if ([string]::Equals($fullOutput, $fullIndex, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'OutputPptx must not overwrite ResultsIndex.'
    }
    foreach ($entry in $validated.Cases) {
        foreach ($image in $entry.Images.Values) {
            if ([string]::Equals($fullOutput, $image.Path, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'OutputPptx must not overwrite a plot image.'
            }
        }
    }
    if ((Test-Path -LiteralPath $fullOutput) -and -not $Force) {
        throw "OutputPptx already exists; pass -Force to replace it: '$fullOutput'."
    }
    if ((Test-Path -LiteralPath $fullOutput) -and (Test-Path -LiteralPath $fullOutput -PathType Container)) {
        throw "OutputPptx points to a directory: '$fullOutput'."
    }
    if ($null -ne $fullSlides) {
        if ([string]::Equals($fullSlides, [IO.Path]::GetDirectoryName($fullOutput), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'ExportSlidesDirectory must not be the same directory as the PPTX parent.'
        }
        if ((Test-Path -LiteralPath $fullSlides) -and -not $Force) {
            throw "ExportSlidesDirectory already exists; pass -Force to replace it: '$fullSlides'."
        }
        if ((Test-Path -LiteralPath $fullSlides) -and (Test-Path -LiteralPath $fullSlides -PathType Leaf)) {
            throw "ExportSlidesDirectory points to a file: '$fullSlides'."
        }
    }

    $outputDirectory = [IO.Path]::GetDirectoryName($fullOutput)
    if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    }
    if ($null -ne $fullSlides) {
        $slideParent = [IO.Path]::GetDirectoryName($fullSlides)
        if (-not (Test-Path -LiteralPath $slideParent -PathType Container)) {
            New-Item -ItemType Directory -Path $slideParent -Force | Out-Null
        }
    }

    $pptxToken = [Guid]::NewGuid().ToString('N')
    $stagingPptx = Join-Path -Path $outputDirectory -ChildPath (".$([IO.Path]::GetFileNameWithoutExtension($fullOutput)).$pptxToken.staging.pptx")
    if ($null -ne $fullSlides) {
        $slidesParent = [IO.Path]::GetDirectoryName($fullSlides)
        $stagingSlides = Join-Path -Path $slidesParent -ChildPath (".$([IO.Path]::GetFileName($fullSlides)).$pptxToken.staging")
        [IO.Directory]::CreateDirectory($stagingSlides) | Out-Null
    }

    $existingPowerPoint = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
    if ($existingPowerPoint.Count -gt 0) {
        throw 'PowerPoint is already running. Close it before building so this script cannot affect an existing user window.'
    }
    $powerpoint = New-Object -ComObject PowerPoint.Application
    Add-ComRef $powerpoint
    $ownedApplication = $true
    $startedProcesses = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
    if ($startedProcesses.Count -ne 1) {
        $ownedApplication = $false
        throw "Could not prove ownership of exactly one PowerPoint process (found $($startedProcesses.Count)); refusing to close or quit it."
    }
    $powerpoint.Visible = 0
    $presentations = $powerpoint.Presentations
    Add-ComRef $presentations
    $presentation = $presentations.Add()
    Add-ComRef $presentation
    $ownedPresentation = $true
    $presentation.PageSetup.SlideSize = 16
    $slidesCollection = $presentation.Slides
    Add-ComRef $slidesCollection

    [void] (Add-CoverSlide -Presentation $presentation -Slides $slidesCollection -Validated $validated)
    [void] (Add-ParametersSlide -Presentation $presentation -Slides $slidesCollection -Validated $validated)
    $slideNumber = 3
    foreach ($entry in $validated.Cases) {
        [void] (Add-CaseSlide -Presentation $presentation -Slides $slidesCollection -ValidatedCase $entry -SlideNumber $slideNumber)
        $slideNumber++
    }
    [void] (Add-SummarySlide -Presentation $presentation -Slides $slidesCollection -Validated $validated)
    [void] (Add-LimitationsSlide -Presentation $presentation -Slides $slidesCollection -Validated $validated)
    if ($slidesCollection.Count -ne 16) { throw "Presentation has $($slidesCollection.Count) slides; expected 16." }

    $presentation.SaveAs($stagingPptx, 24)
    if ($null -ne $stagingSlides) {
        for ($i = 1; $i -le $slidesCollection.Count; $i++) {
            $slide = $slidesCollection.Item($i)
            Add-ComRef $slide
            $exportPath = Join-Path -Path $stagingSlides -ChildPath ("slide-{0:D2}.png" -f $i)
            $slide.Export($exportPath, 'PNG', 1600, 900)
            Release-OneComRef $slide
        }
    }

    $presentation.Close()
    $ownedPresentation = $false
    if ($ownedApplication) {
        $powerpoint.Quit()
        $ownedApplication = $false
    }
    Release-ComRefs
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()

    Assert-PptxArchive -Path $stagingPptx
    if ($null -ne $stagingSlides) { Assert-ExportedSlides -Directory $stagingSlides }
    Move-FileIntoPlace -Staging $stagingPptx -Target $fullOutput -Replace:$Force
    $stagingPptx = $null
    if ($null -ne $stagingSlides) {
        Move-DirectoryIntoPlace -Staging $stagingSlides -Target $fullSlides -Replace:$Force
        $stagingSlides = $null
    }
    $outputReady = $true
    Write-Output ([pscustomobject] @{
        output_pptx = $fullOutput
        slide_count = 16
        embedded_case_images = 48
        exported_slide_directory = $fullSlides
        results_index_sha256 = $validated.IndexSha256
        convergence_true_count = @($validated.Cases | Where-Object { $_.Case.converged -eq $true }).Count
    })
} catch {
    if ($ownedPresentation -and $null -ne $presentation) {
        try { $presentation.Close() } catch { }
        $ownedPresentation = $false
    }
    if ($ownedApplication -and $null -ne $powerpoint) {
        try { $powerpoint.Quit() } catch { }
        $ownedApplication = $false
    }
    Release-ComRefs
    throw
} finally {
    if ($null -ne $stagingPptx -and (Test-Path -LiteralPath $stagingPptx)) {
        Remove-Item -LiteralPath $stagingPptx -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $stagingSlides -and (Test-Path -LiteralPath $stagingSlides)) {
        Remove-Item -LiteralPath $stagingSlides -Recurse -Force -ErrorAction SilentlyContinue
    }
    Release-ComRefs
}
