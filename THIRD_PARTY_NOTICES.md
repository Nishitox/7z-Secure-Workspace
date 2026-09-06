# Third-party notices

## 7-Zip 26.03

Public release builds are intended to bundle the upstream 7-Zip 26.03 x64 shared
library (`7z.dll`).

- Project: https://www.7-zip.org/
- Release: 26.03
- Reference upstream package: `7z2603-extra.7z`
- Reference package SHA-256: `191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f`
- License information: GNU LGPL plus the additional BSD/unRAR terms described
  by the 7-Zip project.

`build-native.ps1` requires a 26.03 DLL, copies the `License.txt` belonging to
the selected 7-Zip distribution to
`native/bin/win32-x64/licenses/7zip-LICENSE.txt`, and records the SHA-256 of the
exact selected DLL. The build script verifies version and build-to-package hash
consistency; it does not independently prove where an arbitrary caller-supplied
DLL came from. Public release builders must therefore select the upstream 26.03
x64 distribution intentionally. The copied license file is included in the VSIX
beside `7z.dll`.

## bit7z 4.1.0

The native bridge statically links bit7z, a C++ wrapper for 7-Zip shared
libraries.

- Project: https://github.com/rikyoz/bit7z
- Version: 4.1.0
- Exact release commit: `c81c6c1cbf44e148cd4b06f4bb69d7ea1e299742`
- License: Mozilla Public License 2.0

The project does not patch bit7z source files. `build-native.ps1` verifies the
resolved Git commit and copies the upstream `LICENSE` file from that exact source
tree to `native/bin/win32-x64/licenses/bit7z-MPL-2.0.txt`; that file is included
in the VSIX. The exact upstream source can be obtained from the commit above.
