# Appium Inspector Lite

公式 Appium Inspector プラグインの Web UI を、VS Code のエディタータブ内で使う非公式の拡張です。v0.3.3から独自の簡易UIを廃止し、公式UIに一本化しています。

## 公式 Inspector の使い方

1. ローカルに Appium 3 と対象ドライバーを用意します。
2. Activity Bar の Appium Inspector を開きます。
3. 初回は「初回セットアップ」→「公式プラグインをインストール」を押します（`appium plugin install inspector` を現在の Appium 環境で実行）。
4. 「起動して公式 Inspector を開く」を押します。サーバーを `--use-plugins=inspector` 付きで起動し、`/inspector` をエディター領域に表示します。
5. Capabilities、セッション開始／終了、Source、Commands、Gestures、Recorderは公式UIで操作します。

既存サーバーにも「起動済みの Inspector を開く」で接続できます。プラグイン無しで起動済みの場合は、停止してからプラグイン有効で再起動してください。`/wd/hub` 等のbase pathがあってもUIは `/inspector` にあります。公式画面側のServer Detailsには実際のAppium base pathを設定してください。

VS CodeデスクトップのローカルHTTP接続（localhost / 127.0.0.1 / ::1）を対象としています。Remote SSH / コンテナ内への自動転送、vscode.devは対象外です。Appiumを実行できるPATHでVS Codeを起動してください。Windowsのnpm `.cmd` ランチャーによる起動は未対応で、外部でサーバーを起動して接続してください。

公式UIのセッションは公式UIで管理されます。タブを閉じるだけではセッションは終了しません。Server停止・VS Code終了の前に公式UIのセッション終了操作を行ってください。

Inspector本体はVSIXに同梱せず、インストールした公式プラグインから配信します。表示機能はプラグインのバージョンに従います。ブラウザー版のためElectron専用のメニュー・OS連携は含まれず、クリップボードやダウンロードの可否はWebviewの制約を受けます。

参照: [公式プラグイン](https://github.com/appium/appium-inspector/tree/main/plugins) / [導入手順](https://appium.github.io/appium-inspector/latest/quickstart/installation/)。本拡張はAppiumチームの公式製品ではありません。公式プラグインはApache-2.0、本拡張のコードはMITです。

## macOS のコピー・貼り付け

v0.3.2ではSelected Elementの属性・locator行など、公式UIが `navigator.clipboard.writeText()` で行うコピーもVS Code経由に変更しました。クリップボードへの書き込みが完了してから公式UIへ完了を返します。

v0.3.1でVS Code内のiframeに対するクリップボード仲介を追加しました。JSONの鉛筆アイコンを押し、入力欄をクリックしてから `⌘V` を使えます。ショートカットが他の拡張に奪われる場合は、タブ上部の「全選択」「貼り付け」を使ってください。「コピー」ボタンも使用できます。

公式プラグインのファイルは変更せず、一時的なローカル中継を経由して表示します。公式画面のRemote Portには中継ポートが自動設定されます。タブを閉じると中継が停止するため、先にセッションを終了してください。

## 起動前の環境チェック

サイドバーの「環境チェック」で、VS Code が使用する Appium のバージョン、Inspector プラグイン、導入済みドライバーを確認できます。不足・確認失敗の場合は対処方法を表示し、詳細を「ログ」に出力します。

- ローカルサーバーを新規起動する前にも自動チェックします。Appium・Inspector が不足している場合や確認に失敗した場合は起動を止めます。
- ドライバー未導入は警告です。Inspector は開けますが、セッション開始には対象ドライバーを導入してください。Android は `appium driver install uiautomator2`、iOS は macOS 上で `appium driver install xcuitest` が例です。
- チェックは導入状況のみです。SDK・端末接続・ドライバーとOSの互換性までは検証しません。必要な変更やインストールを勝手に行うことはありません。
- 起動済みサーバーに接続する場合はローカルCLIチェックを省略します。外部サーバーが使用する Appium 環境は、その起動元で確認してください。
- チェックには信頼済みワークスペースが必要です。各コマンドは15秒でタイムアウトします。権限エラーでは `APPIUM_HOME` の場所・アクセス権、コマンド未検出ではPATHを確認してください。

## Capabilities・設定の保存

v0.3.4から、公式UIの「Save As」で保存したCapability Sets、テーマ・言語、保存済みジェスチャー、接続設定などをVS CodeのSecretStorageにも保存します。同じServer URLで開き直すと、中継ポートの変更やVS Codeの再起動後も、公式UIの起動前に復元します。保存済み接続先の中継ポートも更新します。

- Capabilitiesは「Save As」で名前を付けて保存し、次回は「Saved Capability Sets」から選択してください。未保存の編集内容や実行中セッションは復元しません。
- 保存先はこの拡張のSecretStorageです。リポジトリ内のファイルには書き出しません。認証情報を含む場合もあるため、不要になったセットは公式UIから削除してください。
- 設定はServer URL（base pathを含む）ごとに分離します。localhostと127.0.0.1は別扱いです。同じURLを複数ウィンドウで同時編集すると最後の保存が優先されます。
- 旧版の一時ポート上に残っていた設定は自動移行しません。旧版で保存した内容は事前に公式UIからエクスポートしてください。
- 保存失敗時はVS Codeにエラーを表示します。SecretStorageが利用可能か確認し、保存操作をやり直してください。保存上限は約5 MBです。

## 開発・検証

```bash
npm install
npm run compile
npm test
```

VS Code でこのフォルダを開き、`F5` で **Appium Inspector Lite をデバッグ起動** を選ぶと、ビルド後に Extension Development Host が起動します。

Extension Development Host 上では、`⌘⌥A`（Windows / Linux: `Ctrl+Alt+A`）で Inspector を開けます。
