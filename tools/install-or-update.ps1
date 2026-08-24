param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
$sourcePath = [IO.Path]::GetFullPath($Source)
$destinationPath = [IO.Path]::GetFullPath($Destination)
$sourceRoot = [IO.Path]::GetPathRoot($sourcePath)
$destinationRoot = [IO.Path]::GetPathRoot($destinationPath)

if ($sourcePath -eq $sourceRoot -or $destinationPath -eq $destinationRoot) { throw 'Source and destination must be specific folders, not drive roots.' }
if ($sourcePath -eq $destinationPath) { throw 'Source and destination must be different folders.' }
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw "Source release is missing: $sourcePath" }
if (Test-Path -LiteralPath (Join-Path $sourcePath '.git')) { throw 'Use an extracted release, not a Git working tree.' }

$lint = Join-Path $sourcePath 'tools\release-lint.mjs'
if (-not (Test-Path -LiteralPath $lint -PathType Leaf)) { throw "Release linter is missing: $lint" }
& node $lint $sourcePath
if ($LASTEXITCODE -ne 0) { throw "Release validation failed with exit code $LASTEXITCODE" }

$hookCandidates = @('WorkflowPlatform\hooks\user-prompt-submit.mjs', 'WorkflowPlatform\hooks\codex-user-prompt-submit.mjs')
function Get-HookHash([string]$Root) {
    foreach ($relative in $hookCandidates) {
        $file = Join-Path $Root $relative
        if (Test-Path -LiteralPath $file -PathType Leaf) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
    }
    return $null
}
$oldHookHash = Get-HookHash $destinationPath
$newHookHash = Get-HookHash $sourcePath
if ($null -eq $newHookHash) { throw "Release hook entry is missing: $($hookCandidates[0])" }

$parent = Split-Path -Parent $destinationPath
if (-not $parent) { throw 'Destination must have a parent folder.' }
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$stage = Join-Path $parent ('.zodchi-install-' + [Guid]::NewGuid().ToString('N'))
$rollback = $destinationPath + '.rollback-' + [Guid]::NewGuid().ToString('N')
$parentPrefix = $parent.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
foreach ($candidate in @($stage, $rollback)) {
    $resolved = [IO.Path]::GetFullPath($candidate)
    if (-not $resolved.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe working path: $resolved" }
}

$movedOld = $false
try {
    Copy-Item -LiteralPath $sourcePath -Destination $stage -Recurse
    & node (Join-Path $stage 'tools\release-lint.mjs') $stage
    if ($LASTEXITCODE -ne 0) { throw 'Staged release validation failed.' }
    if (Test-Path -LiteralPath $destinationPath) {
        Move-Item -LiteralPath $destinationPath -Destination $rollback
        $movedOld = $true
    }
    Move-Item -LiteralPath $stage -Destination $destinationPath
    if ($movedOld -and (Test-Path -LiteralPath $rollback)) { Remove-Item -LiteralPath $rollback -Recurse -Force }
    [pscustomobject]@{
        status = 'installed'
        destination = $destinationPath
        hook_changed = ($oldHookHash -ne $null -and $oldHookHash -ne $newHookHash)
        hook_trust_required = ($oldHookHash -ne $null -and $oldHookHash -ne $newHookHash)
        local_data_changed = $false
    }
}
catch {
    if ($movedOld -and -not (Test-Path -LiteralPath $destinationPath) -and (Test-Path -LiteralPath $rollback)) {
        Move-Item -LiteralPath $rollback -Destination $destinationPath
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
