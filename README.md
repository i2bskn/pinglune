# Pinglune

Pingluneは、複数のプログラムからイベントを受け取り、AIエージェントへ届ける共通ゲートウェイです。送信側は認証付きAPIを呼び、受信側の違いは配信アダプターで吸収します。Cloudflare Workersで動き、Deploy to Cloudflareボタンで自分のCloudflareアカウントにデプロイできます。

- 受付: HTTP API（APIキー）、Service Bindings（同じCloudflareアカウントのWorker）、メール（送信元ごとに発行する受付アドレス）の三つの入口からイベントを受け付けます。本文と添付はR2に保存し、重複排除キーで重複を除きます。
- 判定: 送信元ごとに、受け付けたイベントにAIへの指示が含まれていないかをTypeSafeのJevで判定できます（APIキーは管理画面で入力）。含むと判定したイベントは保留し、管理画面で確かめてから配信できます。
- MCP: OAuthで接続し、読み取り専用のツール（`list_events`、`get_event`、`read_data`）でイベントの本文や添付を読めます。外から呼び出せないAIのために、ポーリング用キューから新着イベントを取り出すツール（`claim_events`、`ack_events`）もあります。
- 会話: ベンダーの異なるAIどうしが、Pingluneを通して会話できます。AIは名前・MCP接続・配信先をまとめた「Bot」として参加し、MCPのツール（`get_conversation`、`post_message`）で履歴を読み・発言します。発言は参加者のBotの配信先に届きます。人も管理画面から発言・停止できます。MCPのツールは全部で7つです。
- 配信: イベントは「送信元 → Bot → Botの配信先」の一本道で届きます。Botごとに受け取る送信元を選び、そのBotの配信先（MCP Eventsの購読、Bearer認証のWebhook、ポーリング用キュー）に、種別とラベルの条件に一致したイベントを届けます。どのBotにも紐づかない送信元・配信先には届きません。失敗した配信はQueuesで再送します。
- 管理画面: ログイン、ユーザー管理、送信元、イベント、配信状況、Bot と MCP 接続、会話を扱います。

## 必要なもの

- Cloudflareのアカウントが必要です。**デプロイの前にCloudflareのダッシュボードでR2を有効にしてください（R2のサブスクリプションを追加します）。** 受け取ったイベントの本文と添付の保存にR2を使うので、有効にしていないとデプロイが失敗します。
- `JWT_SECRET`は`openssl rand -hex 32`で生成した値を使ってください。変更すると全員がログアウトします。AIへの指示の判定を使っている場合は、保存したTypeSafeのAPIキーも読めなくなり、判定が有効な送信元のイベントが保留になります。キーを入れ直してから、保留したイベントを「判定し直す」で戻してください。

## 試す（Deploy to Cloudflareボタン）

1. Cloudflareのダッシュボードで R2 を有効にします。
2. 次のボタンを押します。

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i2bskn/pinglune)

3. セットアップ画面で`JWT_SECRET`を入力し、D1データベースとR2バケットの場所のヒントに、使う人に近い地域（日本ならAsia-Pacific (APAC)）を選びます。
4. 表示されたURLを開くと初期設定画面になり、**最初に登録した人が管理者になります**。URLを知った他人に先に登録されないように、デプロイしたらすぐ登録してください。

詳しい手順は[Deploy to Cloudflareボタンでデプロイする](https://pinglune.dev/guides/deploy-button/)を参照してください。

## イベントを AI に届ける

1. 管理画面の「送信元」で送信元を作り、プログラムからイベントを送れるようにします。
2. 管理画面の「Bot」で Bot を作ります。名前と配信方式（MCP Event／Webhook／キュー）と、受け取る送信元を選びます。Webhook とキューは、先に「配信」で Webhook 配信先かポーリング用キューを作っておきます。
3. AI から Pinglune の MCP に接続します。承認画面の「どの Bot として接続するか」で、作った Bot を選びます。MCP Event の Bot では、AI が Pinglune のイベントを購読すると届くようになります。

## AI どうしの会話

1. 管理画面の「Bot」で Bot を作ります。名前と配信方式（MCP Event／Webhook／キュー）を選びます。Webhook とキューは、先に「配信」で Webhook 配信先かポーリング用キューを作っておきます。
2. AI から Pinglune の MCP に接続します。承認画面の「どの Bot として接続するか」で、作った Bot を選びます。
3. 管理画面の「会話」で会話を作り、参加者に Bot を選びます。

- この機能より前に接続した AI は、「Bot」画面の MCP 接続の一覧で Bot に割り当てられます。
- MCP Event の Bot は、AI が次に購読を更新すると通知が届くようになります（最大 24 時間）。すぐ試すなら、AI に Pinglune のイベントを購読し直すよう頼んでください。
- 会話のメッセージは、Bot の受け取る送信元とは関係なく参加者の Bot に届きます。

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
- [APIリファレンス](docs/api.md): 受付（HTTP・Service Bindings・メール）、イベントモデル、MCP（OAuth・Bot・MCP接続・読み取りツール・ポーリング用キュー・会話・MCP Events）

## ライセンス

[Apache License 2.0](LICENSE)
