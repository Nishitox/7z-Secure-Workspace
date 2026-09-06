$ErrorActionPreference = "Stop"

$ExpectedSevenZipMajor = 26
$ExpectedSevenZipMinor = 3
$ExpectedSevenZipVersion = "26.03"
$ExpectedBit7zVersion = "4.1.0"
$ExpectedBit7zCommit = "c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742"

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

$RequiredRuntimeSources = @(
    "extension.js",
    "src\constants.js",
    "src\archive\core.js",
    "src\native\backend.js",
    "src\security\paths.js",
    "src\session\lifecycle.js",
    "src\virtual\virtual-archive.js",
    "src\secure-editor\provider.js",
    "src\direct-open\provider.js",
    "src\ui\activity-bar.js",
    "media\7z-secure.svg",
    "media\icon.png",
    "THIRD_PARTY_NOTICES.md"
)
foreach ($RelativePath in $RequiredRuntimeSources) {
    if (-not (Test-Path (Join-Path $PSScriptRoot $RelativePath))) {
        throw "Required runtime source missing: $RelativePath"
    }
}

$RequiredReleaseFiles = @(
    "README.md",
    "LICENSE"
)
foreach ($RelativePath in $RequiredReleaseFiles) {
    if (-not (Test-Path (Join-Path $PSScriptRoot $RelativePath))) {
        throw "Required release file missing: $RelativePath"
    }
}

$Native = Join-Path $PSScriptRoot "native\bin\win32-x64"
$Bridge = Join-Path $Native "e7z_bridge.exe"
$SevenZipDll = Join-Path $Native "7z.dll"
$ManifestPath = Join-Path $Native "runtime-manifest.json"
$SevenZipLicense = Join-Path $Native "licenses\7zip-LICENSE.txt"
$Bit7zLicense = Join-Path $Native "licenses\bit7z-MPL-2.0.txt"

$RequiredNativeFiles = @(
    $Bridge,
    $SevenZipDll,
    $ManifestPath,
    $SevenZipLicense,
    $Bit7zLicense
)
foreach ($RequiredFile in $RequiredNativeFiles) {
    if (-not (Test-Path $RequiredFile)) {
        throw "Required native release file missing: $RequiredFile`nRun .\native\build-native.ps1 first."
    }
}

$SevenZipVersionInfo = (Get-Item $SevenZipDll).VersionInfo
if (($SevenZipVersionInfo.FileMajorPart -ne $ExpectedSevenZipMajor) -or
    ($SevenZipVersionInfo.FileMinorPart -ne $ExpectedSevenZipMinor)) {
    throw "Bundled 7z.dll is not 7-Zip $ExpectedSevenZipVersion. Rebuild the native runtime."
}

$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
if ($Manifest.schemaVersion -ne 1) {
    throw "Unsupported runtime manifest schema version: $($Manifest.schemaVersion)"
}
if ($Manifest.bit7z.version -ne $ExpectedBit7zVersion -or
    $Manifest.bit7z.commit -ne $ExpectedBit7zCommit) {
    throw "Runtime manifest does not describe the pinned bit7z release. Rebuild the native runtime."
}
if ($Manifest.sevenZip.version -ne $ExpectedSevenZipVersion) {
    throw "Runtime manifest does not describe 7-Zip $ExpectedSevenZipVersion. Rebuild the native runtime."
}

$ActualBridgeSha256 = Get-Sha256 $Bridge
$ActualSevenZipSha256 = Get-Sha256 $SevenZipDll
if ($ActualBridgeSha256 -ne ([string]$Manifest.bridge.sha256).ToLowerInvariant()) {
    throw "e7z_bridge.exe changed after the runtime manifest was generated. Rebuild before packaging."
}
if ($ActualSevenZipSha256 -ne ([string]$Manifest.sevenZip.dllSha256).ToLowerInvariant()) {
    throw "7z.dll changed after the runtime manifest was generated. Rebuild before packaging."
}

$NodeVersionText = (& node --version).Trim()
if (-not $NodeVersionText) {
    throw "Node.js was not found. Node.js is required only to build/package the VSIX, not to use the installed extension."
}

$NodeMajor = [int]($NodeVersionText.TrimStart("v").Split(".")[0])
if ($NodeMajor -lt 22) {
    throw "Current @vscode/vsce requires Node.js 22 or newer. Installed extension users do not need Node.js."
}

$Package = Get-Content (Join-Path $PSScriptRoot "package.json") -Raw | ConvertFrom-Json
if ($Package.name -ne "7z-secure-workspace" -or $Package.publisher -ne "Nishitox") {
    throw "package.json does not contain the expected public extension identity."
}
if ($Package.license -ne "MIT" -or -not $Package.repository) {
    throw "package.json release metadata is incomplete (MIT license/repository required)."
}
$Out = Join-Path $PSScriptRoot ("7z-secure-workspace-v{0}.vsix" -f $Package.version)

npx --yes @vscode/vsce package `
  --no-dependencies `
  --allow-star-activation `
  --out $Out
if ($LASTEXITCODE -ne 0) {
    throw "VSIX packaging failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "Created:"
Write-Host "  $Out"
Write-Host ""
Write-Host "Bundled native hashes:"
Write-Host "  e7z_bridge.exe $ActualBridgeSha256"
Write-Host "  7z.dll          $ActualSevenZipSha256"
Write-Host ""
Write-Host "Install using:"
Write-Host "  Extensions: Install from VSIX..."
