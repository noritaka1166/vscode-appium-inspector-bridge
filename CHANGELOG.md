# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-09-20

Initial public release.

### Added

- Embed the official Appium Inspector plugin UI in a VS Code editor tab.
- Install the Inspector plugin and start or stop an extension-managed local Appium Server.
- Check the local Appium version, Inspector plugin, and installed drivers before starting a server.
- Offer guided remediation for Appium, the Inspector plugin, and platform drivers from Environment Check.
- Show server connection state and reconnect without creating a new session.
- Open multiple independent Inspector tabs for side-by-side sessions.
- List running Appium sessions and attach the selected session in a new Inspector tab.
- List Android devices and iOS simulators, and generate capability JSON templates.
- Persist approved Inspector settings per Server URL in VS Code SecretStorage.
- Bridge copy and paste between VS Code and the embedded Inspector, including Selected Element values.
- Support English and Japanese according to VS Code's display language.
- Require confirmation before stopping a managed server or reloading Inspector.

## 日本語

### [0.1.0] - 2026-09-20

初回の一般公開リリースです。

### 追加

- 公式 Appium Inspector プラグインUIのVS Codeエディタータブ内表示
- Inspectorプラグインの導入と、拡張管理ローカルAppium Serverの起動・停止
- Appium・Inspectorプラグイン・ドライバーの起動前チェック
- 環境チェックからのAppium・Inspectorプラグイン・プラットフォームドライバーの対処導線
- セッションを作り直さない接続状態表示と再接続
- 複数の独立したInspectorタブを開く、セッションの並列確認
- 起動中のAppiumセッション一覧と、選択したセッションへの新しいInspectorタブからのAttach
- Android端末・iOSシミュレーター一覧とCapabilities JSONひな形生成
- Server URL単位で承認済みInspector設定をVS Code SecretStorageへ保存
- Selected Elementを含む、VS Codeと埋め込みInspector間のコピー・貼り付け連携
- VS Codeの表示言語に応じた日本語・英語対応
- 管理中Serverの停止前の確認
