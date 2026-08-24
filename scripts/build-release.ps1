param(
    [string]$Output = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\Zodchi'),
    [string]$StageRoot = [IO.Path]::GetTempPath(),
    [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$builder = Join-Path $repoRoot 'WorkflowPlatform\scripts\build-starter.ps1'
$gateway = Join-Path $repoRoot 'AgentGateway'
if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw "Release builder is missing: $builder" }
& $builder -Output $Output -GatewaySource $gateway -StageRoot $StageRoot -Replace:$Replace
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
