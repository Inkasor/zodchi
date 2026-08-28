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
    $archiveAssets = @($release.assets | Where-Object { $_.name -match '^Zodchi-v.+-windows\.zip$' })
    $checksumsAssets = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' })
    $manifestAssets = @($release.assets | Where-Object { $_.name -eq 'zodchi-release-manifest.json' })
    if ($archiveAssets.Count -ne 1 -or $checksumsAssets.Count -ne 1 -or $manifestAssets.Count -ne 1) { throw "Release assets are incomplete or ambiguous: $($release.tag_name)" }
    $archiveAsset = $archiveAssets[0]
    $checksumsAsset = $checksumsAssets[0]
    $manifestAsset = $manifestAssets[0]
    foreach ($asset in @($archiveAsset, $checksumsAsset, $manifestAsset)) {
        if ($asset.uploader.login -ne 'github-actions[bot]') { throw "Release asset was not published by CI: $($asset.name) by $($asset.uploader.login)" }
    }

    $archive = Join-Path $scratch $archiveAsset.name
    $checksums = Join-Path $scratch $checksumsAsset.name
    $manifestFile = Join-Path $scratch $manifestAsset.name
    Invoke-WebRequest -Headers $headers -Uri $archiveAsset.browser_download_url -OutFile $archive
    Invoke-WebRequest -Headers $headers -Uri $checksumsAsset.browser_download_url -OutFile $checksums
    Invoke-WebRequest -Headers $headers -Uri $manifestAsset.browser_download_url -OutFile $manifestFile
    $manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
    if ($manifest.schema_version -ne 1 -or $manifest.tag -ne $release.tag_name -or $manifest.repository -ne $Repository) { throw 'Published release manifest metadata is invalid.' }
    if ($manifest.archive.name -ne $archiveAsset.name -or [int64]$manifest.archive.size -ne [int64]$archiveAsset.size) { throw 'Published release manifest names a different archive.' }
    if ($manifest.checksums.name -ne $checksumsAsset.name) { throw 'Published release manifest names a different checksum file.' }
    if (-not $manifest.workflow_run -or -not $manifest.commit) { throw 'Published release manifest has no workflow provenance.' }
    $checksumFileHash = (Get-FileHash -LiteralPath $checksums -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($checksumFileHash -ne ([string]$manifest.checksums.sha256).ToLowerInvariant()) { throw 'Published checksum file differs from the release manifest.' }
    $expectedLine = Get-Content -LiteralPath $checksums | Where-Object { $_ -match [Regex]::Escape($archiveAsset.name) } | Select-Object -First 1
    if (-not $expectedLine -or $expectedLine -notmatch '^([0-9a-fA-F]{64})\s+') { throw 'Published SHA-256 entry is missing or invalid.' }
    $expected = $Matches[1].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Archive checksum mismatch: expected $expected, got $actual" }
    if ($actual -ne ([string]$manifest.archive.sha256).ToLowerInvariant()) { throw 'Published archive differs from the release manifest.' }

    # The manifest binds the assets to the workflow that built them. A successful build job is not enough:
    # the same workflow also downloads the published assets and runs the post-publish smoke. Installation
    # is allowed only after that whole run reached its successful terminal state.
    $workflow = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/actions/runs/$($manifest.workflow_run)"
    if ($workflow.status -ne 'completed' -or $workflow.conclusion -ne 'success') { throw "Release workflow did not complete successfully: $($manifest.workflow_run)" }
    if ($workflow.head_sha -ne $manifest.commit) { throw 'Release workflow commit differs from the release manifest.' }

    $expanded = Join-Path $scratch 'expanded'
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
    $products = @(Get-ChildItem -LiteralPath $expanded -Recurse -Filter product.json -File)
    if ($products.Count -ne 1) { throw "Expected one Zodchi product root, found $($products.Count)." }
    $source = Split-Path -Parent $products[0].FullName
    $product = Get-Content -Raw -LiteralPath $products[0].FullName | ConvertFrom-Json
    if ("v$($product.version)" -ne $release.tag_name -or $product.version -ne $manifest.product.version) { throw 'Installed product version differs from the release manifest.' }
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
