param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Zodchi'),
    [string]$Repository = 'Inkasor/zodchi'
)

$ErrorActionPreference = 'Stop'
$headers = @{ 'User-Agent' = 'Zodchi-Installer' }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("zodchi-install-" + [Guid]::NewGuid().ToString('N'))
$scratch = [IO.Path]::GetFullPath($scratch)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempPrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $scratch.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe temporary path: $scratch" }

try {
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $releases = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases?per_page=20"
    $release = $releases | Where-Object { -not $_.draft } | Select-Object -First 1
    if (-not $release) { throw "No published release found for $Repository" }
    $archiveAsset = $release.assets | Where-Object { $_.name -match '^Zodchi-v.+-windows\.zip$' } | Select-Object -First 1
    $checksumsAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
    if (-not $archiveAsset -or -not $checksumsAsset) { throw "Release assets are incomplete: $($release.tag_name)" }

    $archive = Join-Path $scratch $archiveAsset.name
    $checksums = Join-Path $scratch $checksumsAsset.name
    Invoke-WebRequest -Headers $headers -Uri $archiveAsset.browser_download_url -OutFile $archive
    Invoke-WebRequest -Headers $headers -Uri $checksumsAsset.browser_download_url -OutFile $checksums
    $expectedLine = Get-Content -LiteralPath $checksums | Where-Object { $_ -match [Regex]::Escape($archiveAsset.name) } | Select-Object -First 1
    if (-not $expectedLine -or $expectedLine -notmatch '^([0-9a-fA-F]{64})\s+') { throw 'Published SHA-256 entry is missing or invalid.' }
    $expected = $Matches[1].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Archive checksum mismatch: expected $expected, got $actual" }

    $expanded = Join-Path $scratch 'expanded'
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
    $products = @(Get-ChildItem -LiteralPath $expanded -Recurse -Filter product.json -File)
    if ($products.Count -ne 1) { throw "Expected one Zodchi product root, found $($products.Count)." }
    $source = Split-Path -Parent $products[0].FullName
    $installer = Join-Path $source 'tools\install-or-update.ps1'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Release installer is missing: $installer" }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Source $source -Destination $Destination
    if ($LASTEXITCODE -ne 0) { throw "Zodchi installer failed with exit code $LASTEXITCODE" }
    [pscustomobject]@{ status = 'installed'; version = $release.tag_name; destination = [IO.Path]::GetFullPath($Destination); checksum = $actual }
}
finally {
    if (Test-Path -LiteralPath $scratch) {
        $resolved = [IO.Path]::GetFullPath($scratch)
        if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing unsafe cleanup: $resolved" }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
