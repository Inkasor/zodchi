param(
    [string]$Output = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dist\Zodchi'),
    [string]$GatewaySource = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'AgentGateway'),
    [string]$StageRoot = [IO.Path]::GetTempPath(),
    [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$workflowSource = Split-Path -Parent $PSScriptRoot
$workflowSource = [IO.Path]::GetFullPath($workflowSource)
$repoSource = [IO.Path]::GetFullPath((Split-Path -Parent $workflowSource))
$gatewaySource = [IO.Path]::GetFullPath($GatewaySource)
$outputPath = [IO.Path]::GetFullPath($Output)
$stageBase = [IO.Path]::GetFullPath($StageRoot)

if (-not (Test-Path -LiteralPath $workflowSource -PathType Container)) { throw "Workflow Platform source is missing: $workflowSource" }
if (-not (Test-Path -LiteralPath $gatewaySource -PathType Container)) { throw "AgentGateway source is missing: $gatewaySource" }
if (-not (Test-Path -LiteralPath (Join-Path $repoSource 'product.json') -PathType Leaf)) { throw "Zodchi product metadata is missing: $repoSource" }
if ($outputPath -eq $workflowSource -or $outputPath -eq $gatewaySource) { throw 'Release output must not replace a source repository.' }

New-Item -ItemType Directory -Force -Path $stageBase | Out-Null
$stage = Join-Path $stageBase ("workflow-platform-release-" + [Guid]::NewGuid().ToString('N'))
$stage = [IO.Path]::GetFullPath($stage)
$stagePrefix = $stageBase.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $stage.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe stage path: $stage" }

function Copy-RequiredFile([string]$SourceRoot, [string]$RelativePath, [string]$TargetRoot) {
    $source = Join-Path $SourceRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required source file is missing: $source" }
    $target = Join-Path $TargetRoot $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}

function Copy-RequiredTree([string]$SourceRoot, [string]$RelativePath, [string]$TargetRoot) {
    $source = Join-Path $SourceRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Required source directory is missing: $source" }
    $target = Join-Path $TargetRoot $RelativePath
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $target -Recurse
}

function Copy-FileAs([string]$Source, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Required source file is missing: $Source" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Target
}

function Copy-TreeAs([string]$Source, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Required source directory is missing: $Source" }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Target -Recurse
}

$rollback = $null
$replaced = $false
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $workflowTarget = Join-Path $stage 'WorkflowPlatform'
    $gatewayTarget = Join-Path $stage 'AgentGateway'
    New-Item -ItemType Directory -Path $workflowTarget, $gatewayTarget | Out-Null

    foreach ($file in @('package.json', 'LICENSE', 'CHANGELOG.md')) { Copy-RequiredFile $workflowSource $file $workflowTarget }
    foreach ($tree in @('catalogs', 'contracts', 'migrations', 'src', 'hooks', 'tests', 'packages')) { Copy-RequiredTree $workflowSource $tree $workflowTarget }
    foreach ($script in @('build-starter.ps1', 'generate-bsl-diagnostic-catalog.mjs', 'generate-packages.mjs', 'run-e2e-evidence.mjs', 'run-hook-evidence.mjs', 'run-owner-boundary-evidence.mjs', 'run-package-boundary-evidence.mjs')) { Copy-RequiredFile $workflowSource (Join-Path 'scripts' $script) $workflowTarget }
    Copy-RequiredFile $workflowSource 'config\runtime.example.json' $workflowTarget
    Copy-RequiredFile $workflowSource 'docs\WorkflowPlatform.md' $workflowTarget
    Copy-RequiredFile $workflowSource 'docs\ProjectPackages.md' $workflowTarget

    foreach ($file in @('package.json', 'LICENSE', 'CHANGELOG.md', 'README.md', 'policy.json', 'model-providers.json')) { Copy-RequiredFile $gatewaySource $file $gatewayTarget }
    foreach ($tree in @('migrations', 'src', 'tests')) { Copy-RequiredTree $gatewaySource $tree $gatewayTarget }

    Copy-RequiredTree $repoSource 'configs' $stage
    Copy-RequiredTree $repoSource 'docs' $stage
    foreach ($file in @('README.md', 'QUICKSTART.md', 'ONBOARDING_PROMPT.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'UPDATE.md', 'product.json', 'package.json')) { Copy-RequiredFile $repoSource $file $stage }
    Copy-RequiredFile $repoSource 'scripts\build-release.ps1' $stage
    Copy-RequiredFile $repoSource 'scripts\validate-source.mjs' $stage
    Copy-RequiredFile $repoSource 'tools\install-or-update.ps1' $stage
    Copy-FileAs (Join-Path $workflowSource 'scripts\release-lint.mjs') (Join-Path $stage 'tools\release-lint.mjs')

    $releaseLint = Join-Path $workflowSource 'scripts\release-lint.mjs'
    if (-not (Test-Path -LiteralPath $releaseLint -PathType Leaf)) { $releaseLint = Join-Path $repoSource 'tools\release-lint.mjs' }
    if (-not (Test-Path -LiteralPath $releaseLint -PathType Leaf)) { throw "Release linter is missing." }
    & node $releaseLint $stage --write-manifest
    if ($LASTEXITCODE -ne 0) { throw "release-lint failed with exit code $LASTEXITCODE" }

    if (Test-Path -LiteralPath $outputPath) {
        if (-not $Replace) { throw "Release output already exists: $outputPath. Use -Replace for a recoverable replacement." }
        $rollback = "$outputPath.rollback-" + [Guid]::NewGuid().ToString('N')
        if (Test-Path -LiteralPath $rollback) { throw "Rollback path already exists: $rollback" }
        Move-Item -LiteralPath $outputPath -Destination $rollback
        $replaced = $true
    }
    $outputParent = Split-Path -Parent $outputPath
    if ($outputParent -and -not (Test-Path -LiteralPath $outputParent -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
    }
    Move-Item -LiteralPath $stage -Destination $outputPath
    if ($rollback) {
        $resolvedRollback = [IO.Path]::GetFullPath($rollback)
        $rollbackPrefix = $outputPath + '.rollback-'
        if (-not $resolvedRollback.StartsWith($rollbackPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing unsafe rollback cleanup: $resolvedRollback" }
        Remove-Item -LiteralPath $resolvedRollback -Recurse -Force
        $rollback = $null
    }
    [pscustomobject]@{ status = 'built'; output = $outputPath; previous_release_removed = $replaced; manifest = (Join-Path $outputPath 'bundle-manifest.json') }
}
catch {
    if ($rollback -and -not (Test-Path -LiteralPath $outputPath) -and (Test-Path -LiteralPath $rollback)) {
        Move-Item -LiteralPath $rollback -Destination $outputPath
        $rollback = $null
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        if (-not $resolvedStage.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing unsafe stage cleanup: $resolvedStage" }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
