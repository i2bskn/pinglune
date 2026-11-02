# Pinglune

Pingluneは、複数のプログラムからイベントを受け取り、AIエージェントへ届ける共通ゲートウェイです。送信側は認証付きAPIを呼び、受信側の違いは配信アダプターで吸収します。Cloudflare Workersで動き、Deploy to Cloudflareボタンで自分のCloudflareアカウントにデプロイできます。

- 受付: HTTP API（APIキー）、Service Bindings（同じCloudflareアカウントのWorker）、メール（送信元ごとに発行する受付アドレス）の三つの入口からイベントを受け付けます。本文と添付はR2に保存し、重複排除キーで重複を除きます。
- MCP: OAuthで接続し、読み取り専用のツール（`list_events`、`get_event`、`read_data`）でイベントの本文や添付を読めます。外から呼び出せないAIのために、ポーリング用キューから新着イベントを取り出すツール（`claim_events`、`ack_events`）もあります。
- 配信: MCP Eventsの購読に対して、署名付きWebhookでイベントを届けます。失敗した配信はQueuesで再送します。最初の配信先はdotです。
- 管理画面: ログイン、ユーザー管理、送信元、イベント、配信状況を扱います。

## 必要なもの

- Cloudflareのアカウントが必要です。**デプロイの前にCloudflareのダッシュボードでR2を有効にしてください（R2のサブスクリプションを追加します）。** 受け取ったイベントの本文と添付の保存にR2を使うので、有効にしていないとデプロイが失敗します。
- `JWT_SECRET`は`openssl rand -hex 32`で生成した値を使ってください。変更すると全員がログアウトします。

## 試す（Deploy to Cloudflareボタン）

1. Cloudflareのダッシュボードで R2 を有効にします。
2. 次のボタンを押します。

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i2bskn/pinglune)

3. セットアップ画面で`JWT_SECRET`を入力し、D1データベースとR2バケットの場所のヒントに、使う人に近い地域（日本ならAsia-Pacific (APAC)）を選びます。
4. 表示されたURLを開くと初期設定画面になり、**最初に登録した人が管理者になります**。URLを知った他人に先に登録されないように、デプロイしたらすぐ登録してください。

詳しい手順は[Deploy to Cloudflareボタンでデプロイする](https://pinglune.dev/guides/deploy-button/)を参照してください。

## ドキュメント

### はじめに

- [Pinglune とは](https://pinglune.dev/guides/introduction/)

### 導入

- [導入の前に](https://pinglune.dev/guides/requirements/)
- [Deploy to Cloudflare ボタンでデプロイする](https://pinglune.dev/guides/deploy-button/)
- [ダッシュボードでリポジトリを読み込んでデプロイする](https://pinglune.dev/guides/deploy-dashboard/)
- [D1 と R2 の場所と名前](https://pinglune.dev/guides/storage/)

### 運用

- [設定（環境変数）](https://pinglune.dev/guides/settings/)
- [ログイン方式と OIDC](https://pinglune.dev/guides/login/)

### イベントを送る

- [HTTP でイベントを送る](https://pinglune.dev/guides/http/)
- [Service Bindings でイベントを送る](https://pinglune.dev/guides/service-bindings/)
- [メールでイベントを送る](https://pinglune.dev/guides/email/)

### AI とつなぐ

- [MCP で AI をつなぐ](https://pinglune.dev/guides/mcp/)

## 開発・API

- [開発](docs/development.md): 技術スタック、ローカルで開発する、デプロイの仕組み
- [APIリファレンス](docs/api.md): 受付（HTTP・Service Bindings・メール）、イベントモデル、MCP（OAuth・読み取りツール・ポーリング用キュー・MCP Events）

## ライセンス

[Apache License 2.0](LICENSE)
