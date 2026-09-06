param(
    [string]$SevenZipDll = "$env:ProgramFiles\7-Zip\7z.dll",
    [string]$SevenZipLicense = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Build = Join-Path $Root "build"
$Out = Join-Path $Root "bin\win32-x64"
$LicenseOut = Join-Path $Out "licenses"

$ExpectedSevenZipMajor = 26
$ExpectedSevenZipMinor = 3
$ExpectedSevenZipVersion = "26.03"
$SevenZipExtraPackage = "7z2603-extra.7z"
$SevenZipExtraSha256 = "191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f"
$Bit7zVersion = "4.1.0"
$Bit7zCommit = "c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742"

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found on PATH."
    }
}

function Assert-LastExitCode([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

Require-Command "cmake"
Require-Command "git"

if (-not (Test-Path $SevenZipDll)) {
    throw @"
7z.dll was not found at:
  $SevenZipDll

Install the x64 7-Zip $ExpectedSevenZipVersion release or pass -SevenZipDll <path>.
For release builds, use an official 7-Zip $ExpectedSevenZipVersion 7z.dll.
"@
}

$SevenZipVersionInfo = (Get-Item $SevenZipDll).VersionInfo
if (($SevenZipVersionInfo.FileMajorPart -ne $ExpectedSevenZipMajor) -or
    ($SevenZipVersionInfo.FileMinorPart -ne $ExpectedSevenZipMinor)) {
    throw @"
The selected 7z.dll does not match the native build target.
Expected: 7-Zip $ExpectedSevenZipVersion
Detected: $($SevenZipVersionInfo.FileVersion)
Path:     $SevenZipDll

Use the official x64 7-Zip $ExpectedSevenZipVersion DLL, or intentionally update both
BIT7Z_7ZIP_VERSION and the release dependency record before rebuilding.
"@
}

if ([string]::IsNullOrWhiteSpace($SevenZipLicense)) {
    $SevenZipLicense = Join-Path (Split-Path -Parent $SevenZipDll) "License.txt"
}
if (-not (Test-Path $SevenZipLicense)) {
    throw @"
7-Zip license information was not found at:
  $SevenZipLicense

Binary redistribution of 7z.dll requires the related license information. Pass
-SevenZipLicense <path> to the License.txt that belongs to the selected 7-Zip distribution.
"@
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null

Write-Host "Configuring native bridge..."
cmake -S $Root -B $Build -A x64 `
    -DCMAKE_BUILD_TYPE=Release `
    -DBIT7Z_BUILD_TESTS=OFF `
    -DBIT7Z_BUILD_DOCS=OFF `
    -DBIT7Z_AUTO_FORMAT=OFF `
    -DBIT7Z_REGEX_MATCHING=OFF `
    -DBIT7Z_USE_PCH=OFF `
    -DBIT7Z_PATH_SANITIZATION=ON `
    -DBIT7Z_USE_NATIVE_STRING=ON `
    -DBIT7Z_AUTO_PREFIX_LONG_PATHS=ON
Assert-LastExitCode "CMake configure"

$Bit7zSource = Join-Path $Build "_deps\bit7z-src"
if (-not (Test-Path $Bit7zSource)) {
    throw "Fetched bit7z source was not found at the expected CMake FetchContent path."
}
$ResolvedBit7zCommit = (& git -C $Bit7zSource rev-parse HEAD).Trim()
Assert-LastExitCode "bit7z commit verification"
if ($ResolvedBit7zCommit -ne $Bit7zCommit) {
    throw "Unexpected bit7z source commit. Expected $Bit7zCommit, got $ResolvedBit7zCommit."
}

Write-Host "Building native bridge..."
cmake --build $Build --config Release --parallel
Assert-LastExitCode "Native bridge build"

$Bridge = Get-ChildItem -Path $Build -Recurse -Filter "e7z_bridge.exe" |
    Where-Object { $_.FullName -match "\\Release\\e7z_bridge\.exe$" } |
    Select-Object -First 1

if (-not $Bridge) {
    $Bridge = Get-ChildItem -Path $Build -Recurse -Filter "e7z_bridge.exe" |
        Select-Object -First 1
}

if (-not $Bridge) {
    throw "e7z_bridge.exe was not found after the build."
}

$BridgeOut = Join-Path $Out "e7z_bridge.exe"
$SevenZipOut = Join-Path $Out "7z.dll"
Copy-Item $Bridge.FullName $BridgeOut -Force
Copy-Item $SevenZipDll $SevenZipOut -Force

$Bit7zLicense = Join-Path $Bit7zSource "LICENSE"
if (-not (Test-Path $Bit7zLicense)) {
    throw "bit7z LICENSE was not found in the pinned source tree."
}

New-Item -ItemType Directory -Force -Path $LicenseOut | Out-Null
Copy-Item $SevenZipLicense (Join-Path $LicenseOut "7zip-LICENSE.txt") -Force
Copy-Item $Bit7zLicense (Join-Path $LicenseOut "bit7z-MPL-2.0.txt") -Force

$BridgeSha256 = Get-Sha256 $BridgeOut
$SevenZipSha256 = Get-Sha256 $SevenZipOut
$ManifestPath = Join-Path $Out "runtime-manifest.json"
$Manifest = [ordered]@{
    schemaVersion = 1
    bit7z = [ordered]@{
        version = $Bit7zVersion
        commit = $Bit7zCommit
    }
    sevenZip = [ordered]@{
        version = $ExpectedSevenZipVersion
        dllSha256 = $SevenZipSha256
        referencePackage = $SevenZipExtraPackage
        referencePackageSha256 = $SevenZipExtraSha256
    }
    bridge = [ordered]@{
        sha256 = $BridgeSha256
    }
}
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $ManifestPath

Write-Host ""
Write-Host "Native backend ready:"
Write-Host "  $BridgeOut"
Write-Host "  $SevenZipOut"
Write-Host ""
Write-Host "Dependency verification:"
Write-Host "  bit7z $Bit7zVersion @ $Bit7zCommit"
Write-Host "  7-Zip $ExpectedSevenZipVersion"
Write-Host "  e7z_bridge.exe SHA-256: $BridgeSha256"
Write-Host "  7z.dll SHA-256:        $SevenZipSha256"
Write-Host "  Runtime manifest:      $ManifestPath"
Write-Host ""
Write-Host "You can now press F5 in the extension project."
