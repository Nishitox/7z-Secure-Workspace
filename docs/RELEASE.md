# Release provenance and packaging

This file records the release-build inputs that are intentionally fixed before
producing a public VSIX. It is not a substitute for the security model in
`SECURITY.md`.

## Native dependency baseline

### bit7z

- version: 4.1.0
- exact Git commit: `c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742`
- upstream: https://github.com/rikyoz/bit7z
- license: MPL 2.0

`native/CMakeLists.txt` fetches this exact commit. This intentionally makes Git
a native-build prerequisite. `build-native.ps1` checks the resolved FetchContent
checkout with `git rev-parse HEAD` before building.

### 7-Zip

- build/header target: 26.03
- runtime target: 26.03 x64 `7z.dll`
- official release: https://github.com/ip7z/7zip/releases/tag/26.03
- reference package: `7z2603-extra.7z`
- reference package SHA-256:
  `191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f`

bit7z recommends compiling against the same 7-Zip version used by the shared
library at runtime. The build script therefore rejects a runtime DLL whose file
version is not 26.03.

The reference-package hash identifies the upstream package used as the release
reference. The SHA-256 of the exact `7z.dll` copied into a build is separately
recorded in `native/bin/win32-x64/runtime-manifest.json`.

The source build does **not** claim to prove the provenance of any arbitrary DLL
path passed by a release builder. `build-native.ps1` verifies that the selected
DLL reports version 26.03 and records its exact hash; public release builders
must intentionally use the upstream x64 26.03 distribution. `package-vsix.ps1`
then proves that the packaged DLL is the same file that was recorded at build
time.

## Generated runtime release set

`native/build-native.ps1` creates or refreshes:

```text
native/bin/win32-x64/e7z_bridge.exe
native/bin/win32-x64/7z.dll
native/bin/win32-x64/runtime-manifest.json
native/bin/win32-x64/licenses/7zip-LICENSE.txt
native/bin/win32-x64/licenses/bit7z-MPL-2.0.txt
```

The manifest contains no developer-machine paths. It records the pinned
dependency identity and SHA-256 hashes of the two native binaries.

`package-vsix.ps1` recalculates both hashes and refuses to package if either
binary changed after the manifest was generated.

## Git/source policy

Generated native binaries, generated runtime manifest, copied license files,
CMake build state, VSIX files and ZIP release artifacts remain ignored by Git.
The clean source repository contains the build instructions and provenance
records needed to recreate them.

## Project release identity

The public release identity is:

- product name: **7z Secure Workspace**
- extension package name: `7z-secure-workspace`
- publisher: `Nishitox`
- repository: https://github.com/Nishitox/7z-Secure-Workspace
- project source license: MIT (`Copyright (c) 2026 Nishitox`)
- first public pre-release: `0.1.0`
- first stable release: `1.0.0`
- stable 1.0 minimum/tested VS Code: `^1.136.1` / VS Code 1.136.1

The README credits OpenAI GPT-5.6 Sol as development assistance while keeping
Nishitox as the project developer/publisher. OpenAI/GPT branding is not used as
part of the extension name or icon.

Code signing remains intentionally deferred for the 1.0.0 GitHub release.
Native binary hashes remain recorded in the runtime manifest and are rechecked
during VSIX packaging. Signing can be added in a later release without changing
the archive/security model.

