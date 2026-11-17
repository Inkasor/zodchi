# zodchi installer for Windows. Usage: .\install\install.ps1 [-Domains web-apps,gamedev-unity|all] [-Project <repo>] [-GatewayCli <cli.mjs>] [-Force] [-DryRun] [-Uninstall]
param(
  [string]$Domains,
  [string]$Project,
  [string]$GatewayCli,
  [switch]$Force,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required: https://nodejs.org' }
$argsList = @("$PSScriptRoot\install.mjs")
if ($Domains) { $argsList += @('--domains', $Domains) }
if ($Project) { $argsList += @('--project', $Project) }
if ($GatewayCli) { $argsList += @('--gateway-cli', $GatewayCli) }
if ($Force) { $argsList += '--force' }
if ($DryRun) { $argsList += '--dry-run' }
if ($Uninstall) { $argsList += '--uninstall' }
& node @argsList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $DryRun -and -not $Uninstall -and -not $NoPath) {
  $zhome = if ($env:ZODCHI_HOME) { $env:ZODCHI_HOME } else { Join-Path $HOME '.zodchi' }
  $bin = Join-Path $zhome 'bin'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $bin)) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
    Write-Host "Added $bin to your user PATH. Open a new terminal to use 'zodchi'."
  }
}
