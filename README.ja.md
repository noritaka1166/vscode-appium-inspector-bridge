# Appium Inspector Bridge

[English README](README.md)

公式 Appium Inspector プラグインのWeb UIを、VS Codeのエディタータブ内で利用する非公式拡張です。独自のInspector実装ではなく、公式UIをそのまま利用します。

## 主な機能

- VS Code内で公式 Appium Inspector を開く
- Inspectorプラグインの導入、ローカルAppium Serverの起動・停止、ログ表示
- Appium・Inspectorプラグイン・ドライバーの起動前チェック
- 環境チェックからのAppium導入、Inspectorプラグイン導入、ドライバー導入コマンド表示
- 接続状態表示と、セッションを作り直さない再接続
- 複数の独立したInspectorタブを開き、Android／iOSセッションを並べて確認
- Android端末とiOSシミュレーターの一覧、およびCapabilities JSONひな形生成
- Capability Sets、接続設定、テーマ、言語、保存済みジェスチャーのSecretStorage保存
- Inspector内のコピー・貼り付け、Selected Elementのコピー連携
- VS Codeの表示言語に応じた日本語・英語UI

## 必要環境

- Appium 3と対象プラットフォーム用ドライバー
- 公式Inspectorプラグイン（`appium plugin install inspector`）
- ローカルHTTPサーバーへ接続できるデスクトップ版VS Code

`appium` コマンドを実行できるPATHでVS Codeを起動してください。対応する接続先は `localhost`、`127.0.0.1`、`::1` です。Remote SSH、ブラウザー版VS Code、コンテナへの自動転送は対象外です。WindowsではAppiumを外部で起動してから **起動済みのInspectorを開く** を使用してください。

## 使い方

1. Activity Barの **Appium Inspector** を開くか、`⌘⌥A`（Windows/Linuxは `Ctrl+Alt+A`）を押します。
2. 初回は **Initial Setup / 初回セットアップ** から公式プラグインを導入します。
3. **Start and Open Official Inspector / 起動して公式 Inspector を開く** を選ぶと、`--use-plugins=inspector` を付けてAppiumを起動し、`/inspector` をエディタータブに開きます。
4. Capabilitiesとセッションの開始・終了は公式Inspector内で操作します。

既存サーバーには **Open Running Inspector / 起動済みのInspectorを開く** で接続できます。`/wd/hub` などのbase pathを使う場合もUIは `/inspector` にあります。実際のbase pathは公式InspectorのServer Detailsに設定してください。

## 端末とCapabilities

**Devices & Capabilities / 端末・Capabilities** で端末一覧を更新し、端末を選ぶと `platformName`、`appium:automationName`、`appium:udid`、`appium:deviceName` を含むJSONを生成できます。公式InspectorのJSON Representationへ貼り付け、対象アプリに応じて次を追加してください。

- Android: `appium:app`、`appium:appPackage`、`appium:appActivity`
- iOS: `appium:app` または `appium:bundleId`

Androidは `adb devices -l`、iOSシミュレーターはmacOSの `xcrun simctl` を使います。この機能が端末を起動したり、アプリをインストールしたりすることはありません。

## 保存と注意点

公式Inspectorの **Save As** で保存したCapability Sets、設定、保存済みジェスチャーは、Server URLごとにVS Code SecretStorageへ保存されます。未保存の編集内容や実行中セッションは復元されません。

Server停止とInspector再読込は確認ダイアログを表示します。再読込ではサーバー側のセッションは終了しないため、必要な設定を保存し、公式UIでセッションを終了してから操作してください。

本拡張はAppiumチームの公式製品ではありません。公式プラグインはApache-2.0、本拡張はMITライセンスです。
