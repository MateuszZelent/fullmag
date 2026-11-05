[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$builder = Join-Path -Path $PSScriptRoot -ChildPath 'build_presentation.ps1'
$tempRoot = Join-Path -Path ([IO.Path]::GetTempPath()) -ChildPath ("fullmag-bimeron-pptx-validation-$([Guid]::NewGuid().ToString('N'))")
$resultsRoot = Join-Path -Path $tempRoot -ChildPath 'results'
$plotsDirectory = Join-Path -Path $resultsRoot -ChildPath 'images'
$outputPptx = Join-Path -Path $tempRoot -ChildPath 'never-created.pptx'

function Write-TestIndex {
    param($Index, [string] $Path)
    $json = ConvertTo-Json -InputObject $Index -Depth 30
    [IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-ExpectedFailure {
    param([string] $Label, [string] $IndexPath)
    try {
        & $builder -ResultsIndex $IndexPath -ResultsRoot $resultsRoot -OutputPptx $outputPptx -ValidateOnly | Out-Null
    } catch {
        Write-Host "PASS: $Label was rejected ($($_.Exception.Message))"
        return
    }
    throw "FAIL: $Label was accepted."
}

try {
    New-Item -ItemType Directory -Path $plotsDirectory -Force | Out-Null
    $pngBytes = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==')
    [IO.File]::WriteAllBytes((Join-Path $plotsDirectory 'synthetic.png'), $pngBytes)

    $materialData = @{
        current_rdmi = @{ id = 'current_rdmi'; label = 'Synthetic current'; Ms_Apm = 580000; Aex_Jpm = 1.5e-11; Ku_Jpm3 = 663920; D_Jpm2 = 0.004; alpha = 1.0 }
        yig = @{ id = 'yig'; label = 'Synthetic YIG'; Ms_Apm = 140000; Aex_Jpm = 3.5e-12; Ku_Jpm3 = 0; D_Jpm2 = 0; alpha = 0.001 }
        permalloy = @{ id = 'permalloy'; label = 'Synthetic Py'; Ms_Apm = 752000; Aex_Jpm = 1.55e-11; Ku_Jpm3 = 0; D_Jpm2 = 0; alpha = 0.1 }
    }
    $cases = New-Object 'System.Collections.Generic.List[object]'
    foreach ($materialId in @('current_rdmi', 'yig', 'permalloy')) {
        foreach ($film in @('bimeron', 'uniform_plus_x')) {
            foreach ($dot in @(-1, 1)) {
                $caseId = "material_${materialId}__film_${film}__cylinder_$(if ($dot -gt 0) { 'plus_x' } else { 'minus_x' })"
                $cases.Add([pscustomobject] @{
                    case_id = $caseId
                    material = $materialData[$materialId]
                    film_initial = $film
                    dot_mx = $dot
                    run_id = "synthetic-$materialId-$film-$dot"
                    status = 'completed'
                    steps = 15
                    max_steps = 3000
                    converged = $true
                    max_torque_T = 0.0001
                    energies_J = @{ total = -1.0e-18; exchange = 2.0e-19; demag = -1.2e-18 }
                    wall_time_s = 1.0
                    zarr_path = "synthetic/$caseId.zarr"
                    plots = @{ initial_2d = 'images/synthetic.png'; initial_3d = 'images/synthetic.png'; final_2d = 'images/synthetic.png'; final_3d = 'images/synthetic.png' }
                    plot_provenance = @{ kind = 'data_render'; note = 'synthetic validation fixture only' }
                    execution = @{
                        requested = @{ backend = 'fdm'; device = 'gpu'; precision = 'double' }
                        resolved = @{ backend = 'fdm'; device = 'gpu'; precision = 'double' }
                        engine = 'synthetic-validation-only'
                    }
                    source_sha256 = ('a' * 64)
                })
            }
        }
    }
    $index = @{
        schema_version = 'fullmag.bimeron-matrix-results.v1'
        geometry = @{
            film_size_m = @(6.0e-7, 6.0e-7, 1.0e-8)
            cylinder_radius_m = 5.0e-8
            cylinder_height_m = 3.0e-8
            gap_m = 5.0e-9
            cell_m = @(2.5e-9, 2.5e-9, 2.5e-9)
        }
        cases = $cases.ToArray()
    }

    $validIndex = Join-Path -Path $tempRoot -ChildPath 'valid.json'
    Write-TestIndex -Index $index -Path $validIndex
    $result = & $builder -ResultsIndex $validIndex -ResultsRoot $resultsRoot -OutputPptx $outputPptx -ValidateOnly
    if ($result.validation -ne 'passed' -or $result.case_count -ne 12 -or $result.requested_and_resolved_lane -ne 'fdm/gpu') {
        throw 'Valid synthetic fixture did not pass the expected validation contract.'
    }
    Write-Host 'PASS: complete synthetic 12-case matrix validated without COM.'

    $shortIndex = Join-Path -Path $tempRoot -ChildPath 'short.json'
    $short = ConvertFrom-Json (ConvertTo-Json -InputObject $index -Depth 30)
    $short.cases = @($short.cases | Select-Object -First 11)
    Write-TestIndex -Index $short -Path $shortIndex
    Invoke-ExpectedFailure -Label 'missing case' -IndexPath $shortIndex

    $cpuIndex = Join-Path -Path $tempRoot -ChildPath 'cpu.json'
    $cpu = ConvertFrom-Json (ConvertTo-Json -InputObject $index -Depth 30)
    $cpu.cases[0].execution.resolved.device = 'cpu'
    Write-TestIndex -Index $cpu -Path $cpuIndex
    Invoke-ExpectedFailure -Label 'CPU-resolved case' -IndexPath $cpuIndex

    $traversalIndex = Join-Path -Path $tempRoot -ChildPath 'traversal.json'
    $traversal = ConvertFrom-Json (ConvertTo-Json -InputObject $index -Depth 30)
    $traversal.cases[0].plots.initial_2d = '../outside.png'
    Write-TestIndex -Index $traversal -Path $traversalIndex
    Invoke-ExpectedFailure -Label 'upward plot traversal' -IndexPath $traversalIndex

    $missingPngIndex = Join-Path -Path $tempRoot -ChildPath 'missing-png.json'
    Remove-Item -LiteralPath (Join-Path $plotsDirectory 'synthetic.png') -Force
    Write-TestIndex -Index $index -Path $missingPngIndex
    Invoke-ExpectedFailure -Label 'missing plot PNG' -IndexPath $missingPngIndex

    if (Test-Path -LiteralPath $outputPptx) { throw 'Validation-only test unexpectedly created a PPTX.' }
    Write-Host 'PASS: validation-only mode did not create a deck.'
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
