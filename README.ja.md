# 7z Secure Workspace

[English](README.md) | 日本語

暗号化された `.7z` アーカイブを、用途に応じてセキュリティと互換性のトレードオフを明示的に選びながら、VS Code上でワークスペースとして開き、編集するためのWindows向けVS Code拡張機能です。

> **開発:** Nishitoxが、OpenAI GPT-5.6 Solの開発支援を受けて開発しました。

> **ドキュメントについて:** この日本語READMEは利用者向けの便宜的な翻訳です。詳細なセキュリティ、アーキテクチャ、開発仕様については、英語版READMEおよび `docs/` 配下の英語ドキュメントを正本とします。

**Version 1.0.0 は Windows x64 および VS Code 1.136.1 以降を対象としています。** stable 1.0 releaseのregression testはVS Code 1.136.1で実施しました。

## 現在の機能

- VS Codeからローカルの `.7z` を直接開けます。
- Secure Virtual / Standard Virtualでは、アーカイブを専用の仮想ワークスペースとしてマウントします。
- native `7z.dll` bridgeを通してアーカイブ内のmemberを読み書きします。
- Virtual modeでの通常保存時、既存ファイルごとのData Encryption状態を維持します。
- 新しく作成されたnon-empty file dataはデフォルトで暗号化されます。
- 1つのアーカイブ内で暗号化済み・非暗号化のfile dataを混在できます。
- ファイル単位のData Encryptionと、アーカイブ全体のHeader Encryptionを独立して切り替えられます。
- **データ**が非暗号化のファイルにはExplorer上で `🔓` を表示します。
- readおよびcommitの前に外部からのアーカイブ変更を検出します。
- mutationは暗号化candidate archiveを介してtransactionalにcommitします。
- private `CustomDocument` を使うSecure Text Editor経路と、暗号化されたVS Code backup dataを使用します。
- Standard Virtualでは通常のVS Code text editorも利用できます。
- 通常のfilesystem、Git、外部ツールを使うための明示的なMaterialized modeを提供します。
- solid archive、zero-byte file、directory-only archive、および `.7z` の直接Custom Editor openに対応します。

## アーカイブを開く

VS Code Explorerでのダブルクリックや `Ctrl+O` など、通常のVS Codeのファイルオープン操作からローカル `.7z` を開けます。

拡張機能はアーカイブのpassword入力を求め、その後どのsession modeを使用するかを確認します。Command Paletteの `7z Secure: Open Encrypted Archive` も同じmount経路を使用します。

## Session mode

選択したmodeは、そのarchive session中は固定です。modeを変更するには、いったんアーカイブを閉じてから開き直す必要があります。

### Secure Virtual

仮想archive filesystemと、private `CustomDocument` Secure Text Editorを使用します。通常動作ではアーカイブ内のファイル内容を意図的にplaintext fileとしてmaterializeせず、Secure Editorのbackup dataも暗号化されます。

VS Code上のworking-copy exposureを最小化しますが、**完全なsandboxではありません**。使用中のplaintextはprocess memory上に存在し、page file、process dump、clipboard、malware、または他のVS Code extensionから利用可能なあらゆる観測経路に対する保護は保証範囲外です。

### Standard Virtual

仮想archive filesystemと、通常のVS Code `TextDocument` editingを使用します。こちらもアーカイブ内容を意図的にplaintext fileとしてmaterializeしませんが、Secure Virtualより広いVS Code extension / editor surfaceへplaintextが露出します。

### Materialized

通常のfilesystem、Git、外部ツールとの互換性を得るため、extension-ownedのrandomなsystem TEMP working directoryへplaintextを明示的に書き出します。filesystem上の変更は暗号化アーカイブへautosyncされ、manual Syncも明示的なcheckpointとして利用できます。

新しいsessionでは、次の形式のdirectoryを使用します。

```text
%TEMP%\7z-secure-workspace-<random>\
```

TEMP directory名には、意図的にarchive filenameを含めません。`.git` は通常のproject contentとしてworking treeの他の内容とともに同期され、Gitの一時的なlock fileが存在する間はGit metadata更新が終わるまでautosyncを延期します。

Materialized modeでは、実際のworking directoryをsource of truthとして扱います。renameなどの操作はarchive側では `delete + add` として表現される場合があるため、archive itemの完全なidentity保持は保証されません。

- file contentとpathは同期されます
- 同一pathにある既存non-empty itemを編集した場合、現在のData Encryption状態を維持します
- new / recreated / new-path のnon-empty itemにはnew-data defaultが適用され、暗号化されます
- itemが再構築される場合、元のmodified time、Windows attributes、その他のarchive-item metadataの保持はbest-effortです

正常closeでは、plaintextを削除する前にfinal syncを行います。final syncに失敗した場合は、data lossを避けるためworking directoryを削除せずRecovery用に保持します。crash / force kill時のcleanupは保証されず、削除もsecure eraseではありません。

通常のfilesystem / tooling互換性より、archive-nativeなitem identityやmetadata fidelityを重視する場合はSecure VirtualまたはStandard Virtualを使用してください。

## Zero-byte fileとData Encryption

zero-byteの7z memberにはfile-data streamが存在しないため、空の間はファイル単位の**Data Encryption**は適用対象外です。

- empty fileにはData Encryptionの `🔓` badgeを表示しません
- empty fileに対するToggle Data Encryptionはinformation-onlyのno-opです
- 初めて内容を追加した場合、その新しいdataはデフォルトで暗号化されます
- Header Encryptionは独立しており、filenameは引き続き保護できます

## Header Encryptionのedge case

Header Encryptionはdirectory名を含むarchive member nameを保護します。directory-only archiveにも対応します。完全にemptyなarchiveには保護対象となるmember nameがないため、意味のないOFF状態を表示するのではなく、Header Encryptionを **N/A** として扱います。

directory-only実装の詳細およびtransactional temporary-anchor ruleは `docs/ARCHITECTURE.md` と `docs/SECURITY.md` に記載しています。

## VS Code lifecycle

`7z Secure: Close Encrypted Archive` が明示的なclose経路ですが、VS Code標準のclose / reload behaviorにも対応しています。

- Virtual sessionはVS Code restart後にfail closedし、passwordなしの復号済みsessionを暗黙にrestoreしません。
- Materializedのexternal exitではfinal syncとcleanupを試み、final syncに失敗した場合はplaintextとrecovery metadataを保持します。

Extension Development Hostにはdebugger固有のworkspace reload lifecycleがあるため、最終lifecycle regressionはinstalled VSIXで行うことを推奨します。

## Activity Bar UI

拡張機能は **7z Secure** Activity Bar itemを追加します。sessionに応じて利用可能な操作を表示します。

- Open Encrypted Archive
- Close Encrypted Archive
- Virtual sessionでのToggle Header Encryption
- Secure Virtual sessionでのSecure Editor Security Status
- Materialized sessionでのSync Materialized Working Directory

ファイル単位の **Toggle Data Encryption** は選択中のarchive memberを必要とするため、Explorerのfile context menuに残しています。

## インストール

GitHub ReleaseからVSIXをダウンロードし、VS Codeで次の操作を行います。

**Extensions → `...` → Install from VSIX...**

release VSIXにはnative bridgeと `7z.dll` が同梱されているため、end user側で別途native buildやNode.jsを用意する必要はありません。

Repository: https://github.com/Nishitox/7z-Secure-Workspace

## Sourceからbuildする

native bridgeを変更する場合は、Windows x64、CMake、Visual Studio C++ Build Tools、Git、7-Zip 26.03 x64が必要です。

```powershell
cd .\native
.\build-native.ps1
```

JavaScriptのみの変更では、同梱のVS Code Extension Development Host configurationを使用できます。release packagingは次のscriptで行います。

```powershell
.\package-vsix.ps1
```

native release buildではbit7z 4.1.0をpinし、7-Zip 26.03をtargetとしています。native binary hashは生成されたruntime manifestへ記録され、packaging時に再度検証されます。source layout、packaging prerequisite、release provenanceの詳細は `docs/DEVELOPMENT.md` と `docs/RELEASE.md` に記載しています。

## Securityとsupport

canonicalなsecurity intentは [`docs/SECURITY.md`](docs/SECURITY.md) に記載しています。security-sensitiveな問題は、このrepositoryでGitHub **Private vulnerability reporting**が有効な場合、公開Issueではなくそちらから報告してください。実際のpassword、private archive、sensitive plaintextをreportへ添付しないでください。

このprojectは**best-effort**でmaintainされています。response-timeまたはsupport SLAは保証していません。通常の再現可能なbugはGitHub Issuesから報告できます。

## Documentation

詳細な技術・セキュリティ仕様は英語ドキュメントを正本とします。

- [Architecture and mode model](docs/ARCHITECTURE.md)
- [Security model and invariants](docs/SECURITY.md)
- [Regression testing](docs/TESTING.md)
- [Development / contributor guidance](docs/DEVELOPMENT.md)
- [Native bridge protocol](docs/NATIVE_PROTOCOL.md)
- [Release provenance and packaging](docs/RELEASE.md)

Third-party noticesは [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) にあります。

## Projectとlicense

- Publisher: `Nishitox`
- Repository: https://github.com/Nishitox/7z-Secure-Workspace
- Extension source: MIT License, `Copyright (c) 2026 Nishitox`
- Third-party componentsにはそれぞれのupstream licenseが適用されます。詳細は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) およびrelease artifactに同梱されたlicense fileを参照してください。
