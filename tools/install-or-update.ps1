param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 or newer is required before Zodchi can be installed.' }
$installer = Join-Path ([IO.Path]::GetFullPath($Source)) 'tools\install.mjs'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Canonical installer is missing: $installer" }
& node $installer update --source ([IO.Path]::GetFullPath($Source)) --destination ([IO.Path]::GetFullPath($Destination))
if ($LASTEXITCODE -ne 0) { throw "Zodchi installer failed with exit code $LASTEXITCODE" }
