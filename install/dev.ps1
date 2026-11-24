# Build and select the checked-out commit for local use.
param([switch]$RegisterClients)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $source
try {
  $changes = git status --porcelain
  if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Commit the DEV revision before building it.' }
  $commit = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & node scripts/check.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & cargo test --workspace --locked --manifest-path rust/Cargo.toml
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $packages = Join-Path $source '.agent-tmp/dev-builds'
  $output = Join-Path $packages $commit
  $null = New-Item -ItemType Directory -Path $packages -Force
  $staging = Join-Path $packages ('.prepare-' + [Guid]::NewGuid().ToString('N'))
  if (-not (Test-Path -LiteralPath $output)) {
    $null = New-Item -ItemType Directory -Path $staging
    $bundle = & (Join-Path $PSScriptRoot 'install.ps1') -Out (Join-Path $staging 'bundle') -Archive | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $record = Get-Content -Raw -LiteralPath (Join-Path $bundle.root 'marketplace/plugins/zodchi/zodchi-build.json') | ConvertFrom-Json
    if ($record.sourceCommit -cne $commit) { throw 'The checkout changed while building.' }
    $archiveName = Split-Path -Leaf $bundle.archive
    [System.IO.File]::WriteAllText((Join-Path $staging 'archive-name.txt'), $archiveName)
    $stagePath = (Resolve-Path -LiteralPath $staging).Path
    $packagesPrefix = (Resolve-Path -LiteralPath $packages).Path + [System.IO.Path]::DirectorySeparatorChar
    if (-not $stagePath.StartsWith($packagesPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not $output.StartsWith($packagesPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected DEV build location.' }
    [System.IO.Directory]::Move($stagePath, $output)
  }
  $archiveName = (Get-Content -Raw -LiteralPath (Join-Path $output 'archive-name.txt')).Trim()
  if ($archiveName -notmatch '^zodchi-win32-[a-z0-9_-]+\.bundle\.json\.gz$') { throw 'Unexpected DEV archive name.' }
  $archive = Join-Path $output $archiveName
  $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  $bootstrap = Join-Path $output 'bundle/bin/zodchi.exe'
  $selected = & $bootstrap release dev --archive $archive --sha256 $digest | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  if ($RegisterClients) {
    $null = & $selected.cli release register --clients 'codex,claude'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  $selected | ConvertTo-Json
} finally {
  Pop-Location
}
