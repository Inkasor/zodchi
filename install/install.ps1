# zodchi installer for Windows. Usage: .\install\install.ps1 [-Domains web-apps,gamedev-unity|all] [-Project <repo>] [-NoBuild] [-NoPlugins] [-GatewayCli <cli.mjs>] [-NoCodexSkill] [-Dev] [-Force] [-DryRun] [-Uninstall]
param(
  [string]$Domains,
  [string]$Project,
  [string]$GatewayCli,
  [switch]$Force,
  [switch]$Dev,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$NoBuild,
  [switch]$NoPlugins,
  [switch]$NoCodexSkill,
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required: https://nodejs.org' }
$argsList = @("$PSScriptRoot\install.mjs")
if ($Domains) { $argsList += @('--domains', $Domains) }
if ($Project) { $argsList += @('--project', $Project) }
if ($GatewayCli) { $argsList += @('--gateway-cli', $GatewayCli) }
if ($Force) { $argsList += '--force' }
if ($Dev) { $argsList += '--dev' }
if ($DryRun) { $argsList += '--dry-run' }
if ($Uninstall) { $argsList += '--uninstall' }
if ($NoBuild) { $argsList += '--no-build' }
if ($NoPlugins) { $argsList += '--no-plugins' }
if ($NoCodexSkill) { $argsList += '--no-codex-skill' }
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
