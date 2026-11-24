# Build a portable Zodchi distribution from this checkout.
param(
  [Parameter(Mandatory = $true)]
  [string]$Out,
  [switch]$Archive
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
& cargo build --release --locked --manifest-path (Join-Path $source 'rust/Cargo.toml')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$releaseArgs = @('release', 'build', '--source', $source, '--out', $Out)
if ($Archive) { $releaseArgs += '--archive' }
& (Join-Path $source 'rust/target/release/zodchi.exe') @releaseArgs
exit $LASTEXITCODE
