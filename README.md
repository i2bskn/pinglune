# Pinglune

Pingluneは、複数のプログラムからイベントを受け取り、AIエージェントへ届ける共通ゲートウェイです。送信側は認証付きAPIを呼び、受信側の違いは配信アダプターで吸収します。最初の接続先はdotです。

受付（HTTP APIとService Bindings）、R2への保存と重複排除、MCPの読み取りツール、MCP Eventsの購読と署名付きWebhookによる配信（Queuesによる再送）、管理画面（ログイン、ユーザー管理、送信元、イベント、配信状況）を備えています。

## ドキュメント

- [アーキテクチャとデータフロー](docs/architecture.md)：保存、イベントモデル、配信状態、MCPの読み取りツール、アダプター
- [MCP Eventsと認証](docs/mcp-events.md)：dotへの配信仕様、購読、署名、アクセス制御

設計文書では、「公式仕様」は参照元を確認したプロトコル上の要件、「案」は今後検討する候補を表します。API名・テーブル名・JSON例は、明記した公式フィールドを除き確定した契約ではありません。

公式資料：[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)

## 技術スタック

Cloudflare Workers + Hono + D1（drizzle-orm）+ R2 + Queuesで動き、MCPのOAuthの状態はKVに置きます。言語はTypeScript、パッケージ管理はpnpm、テストは`@cloudflare/vitest-plugin`、Web画面はReact + Viteです。

## 開発

ログイン、ユーザー管理、MCPのOAuth認可サーバーはLibrenoから流用した土台です。

### ローカルで開発する

Node.jsとpnpmが必要です。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # JWT_SECRET を設定する
pnpm db:migrate:local
pnpm dev
```

`pnpm dev`はWeb画面（`client/`）をビルドしてから`wrangler dev`を起動します。`client/`のファイルを変えると自動で再ビルドされます。HMRは無いので、ブラウザを再読み込みしてください。

CookieにSecure属性と`__Host-`接頭辞を使っているので、`http://localhost`ではSafariでログインできません。ChromeかFirefoxを使ってください。

| コマンド | 内容 |
| --- | --- |
| `pnpm test` | テスト |
| `pnpm typecheck` | 型チェック（サーバーとWeb画面） |
| `pnpm build:client` | Web画面を`dist/client`にビルドする |
| `pnpm db:generate` | スキーマからマイグレーションを作る |
| `pnpm db:migrate:local` | ローカルのD1にマイグレーションを適用する |

### デプロイする

**デプロイの前にCloudflareのダッシュボードでR2を有効にしてください（R2のサブスクリプションを追加します）。** 受け取ったイベントの本文と添付の保存にR2を使うので、有効にしていないとデプロイが失敗します。

#### Deploy to Cloudflareボタンでデプロイする

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i2bskn/pinglune)

ボタンを押すと次のことが行われます。

1. このリポジトリがあなたのGitHubに新しいリポジトリとしてコピーされます（forkではありません）。
2. D1データベース、KVネームスペース（MCPの接続情報を保存）、R2バケット（イベントの本文と添付を保存）、Queuesのキュー2つ（配信と、その dead letter queue）が、あなたのCloudflareアカウントに作られてWorkerに紐付きます。
3. Workers Buildsが設定されて、マイグレーションの適用とデプロイが行われます。以降はコピーされたリポジトリへpushするたびにデプロイされます。

セットアップ画面では`JWT_SECRET`を入力します。`openssl rand -hex 32`で生成した値を使ってください。変更すると全員がログアウトします。

#### ダッシュボードでリポジトリを読み込んでデプロイする

forkしたリポジトリなどを、Cloudflareのダッシュボードの「Workers & Pages」→「アプリケーションを作成」から読み込む場合は、セットアップ画面で次のように設定してください。

| 項目 | 値 |
| --- | --- |
| ビルドコマンド | 空のまま（Web画面は`wrangler.jsonc`の`build.command`で`wrangler deploy`の前に自動でビルドされます） |
| デプロイコマンド | `pnpm run deploy`（既定値の`npx wrangler deploy`のままではマイグレーションが適用されません） |
| プレビュービルド | 無効（プレビューにはステージング用のD1などの設定が別に必要です） |

デプロイが終わったら、Workerの「設定」→「変数とシークレット」で`JWT_SECRET`をシークレットとして追加してください。追加するまでは、APIが「サーバーの設定に誤りがあります」を返します。

#### デプロイしたら

表示されたURLを開くと初期設定画面になり、**最初に登録した人が管理者になります**。URLを知った他人に先に登録されないように、デプロイしたらすぐ登録してください。アカウントはドメインに紐付かないので、あとで独自ドメインを設定しても、同じアカウントでログインし直すだけで使えます。

#### D1の場所

D1データベースは、最初に `wrangler deploy` を実行した場所の近くに作られます。ボタンやWorkers Buildsでは、ビルド環境の場所で決まるので、使う人から遠い地域（例えば日本から使うのにヨーロッパ西部）になることがあります。APIは1回のリクエストでD1に何度か順に問い合わせるので、D1が遠いと画面の表示が1秒以上かかります。

`wrangler.jsonc` でSmart Placementを有効にしているので、WorkerはD1の近くで動き、D1への問い合わせの往復は短くなります。それでも使う人とWorkerの間の往復は1回残ります。D1の場所は `npx wrangler d1 info DB` の `running_in_region` で確認できます。

D1を使う人の近くに置きたい場合は、最初のデプロイの前に、場所を指定してD1を作ってください（`apac` はアジア太平洋。ほかに `weur`、`eeur`、`oc`、`wnam`、`enam`）。名前は `wrangler.jsonc` の `database_name` と同じにします。

```sh
npx wrangler d1 create pinglune --location apac
```

#### デプロイの仕組み

ボタンもWorkers Buildsも、デプロイには `pnpm run deploy`（`scripts/deploy.mjs`）を使います。D1のマイグレーション（`drizzle/migrations`）を本番に適用してから `wrangler deploy` を実行します。新しいコードが動く前にテーブルができているよう、この順にしています（マイグレーションだけなら `pnpm db:migrate:remote`）。

初回のデプロイでD1がまだないときは、順番を入れ替えて `wrangler deploy` を先に実行します。D1・KV・R2・Queuesのキューを自動で作るのは `wrangler deploy` で、`wrangler d1 migrations apply` は既存のD1を探すだけだからです。テーブルができるまでの数秒間、Workerはテーブルのない状態で動きますが、まだ誰も使っていないので影響はありません。

手元から `pnpm run deploy` を実行する場合、Cloudflareのアカウントが複数あると、wranglerがアカウントを選べずに失敗します。`CLOUDFLARE_ACCOUNT_ID` にデプロイ先のアカウントIDを指定してください。

- 配信に使うQueuesのキュー（`pinglune-deliveries` と dead letter queueの `pinglune-deliveries-dlq`）は、存在しなければ `wrangler deploy` が自動で作ります。`wrangler deploy` が自動で作るのはproducerのバインディングがあるキューだけなので、コードでは使わない `DELIVERY_DLQ` をdead letter queueのproducerとして宣言しています。日次Cron（毎日18:00 UTC）も `wrangler.jsonc` の設定で登録されます。
- Workers FreeプランでもQueuesを使えますが、1日1万オペレーションまでです。1件の配信でおよそ3オペレーション（書き込み・読み取り・削除）を使い、再送するとその分増えるので、1日あたりの配信はおよそ3,000件までが目安です。

### 設定（環境変数）

ローカルでは`.dev.vars`に書きます。本番ではCloudflareのダッシュボードの「設定」→「変数とシークレット」で設定します。`wrangler.jsonc`で`keep_vars: true`を指定しているので、ダッシュボードで設定した値は再デプロイしても消えません。変数は「テキスト」の型で設定してください。

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `JWT_SECRET` | シークレット | 必須。32文字以上 |
| `AUTH_MODE` | 変数 | `password`（既定）または`oidc` |
| `APP_ORIGIN` | 変数 | `oidc`のとき必須。ブラウザで開くOrigin（例: `https://pinglune.example.com`） |
| `OIDC_ISSUER` | 変数 | `oidc`のとき必須。IdPのissuer |
| `OIDC_CLIENT_ID` | 変数 | `oidc`のとき必須 |
| `OIDC_CLIENT_SECRET` | シークレット | `oidc`のとき必須 |
| `ALLOWED_EMAILS` | 変数 | `oidc`では実質必須。ログインを許可するメールのドメインと個別のメールアドレス（カンマ区切り）。空なら誰もログインできません。`*`なら全員を許可します |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | 変数 | 任意。`false`にするとIDトークンに`email_verified`が含まれない場合に限ってログインを通します |

設定に誤りがあると、すべてのリクエストが500になります。`ALLOWED_EMAILS`が空なのは設定の誤りとして扱わず、OIDCのログインだけを拒否します。

### OIDC認証にする

OIDC認証では初回ログイン時にユーザーと個人用ワークスペースが自動で作られます。

`ALLOWED_EMAILS`の扱いは次のとおりです。

- 空（未設定、または空白とカンマだけ）：誰もログインできません。ログインしていたユーザーも、Webセッションの更新時に締め出されます。
- `*`だけの項目を含む：全員を許可します。誰がログインできるかをIdP側で絞っている場合に使います。
- それ以外：`@`を含む項目はメールアドレスの完全一致、含まない項目はドメインの完全一致で判定します。サブドメインは一致しません。`*@example.com`のような項目はワイルドカードになりません。

IdPのアカウントを持つ人なら誰でもログインできる構成（Googleの同意画面を「外部」で作った場合など）では、`*`を使わず、ドメインかメールアドレスを指定してください。

`ALLOWED_EMAILS`はOIDCのログインとWebセッションの更新でだけ判定します。MCPのリクエストでは判定しないので、許可リストを絞っても、発行済みのMCPの接続は有効期限（`oidc`では最長24時間）まで使えます。すぐに止めたい場合は、ユーザー管理でそのユーザーを削除するか、ログアウトさせてください。どちらもMCPの接続を取り消します。

IdPにはリダイレクトURLとして`<APP_ORIGIN>/auth/oidc/callback`を設定し、スコープには`openid`と`email`と`profile`を設定します。

Cloudflare Accessを使う場合は、Access for SaaSのOIDCアプリとして登録します（Accessをアプリの前に置く構成には対応していません）。AccessのIDトークンには`email_verified`が含まれないので、`OIDC_REQUIRE_EMAIL_VERIFIED`を`false`にしてください。この設定を使うのは、Accessのログイン方法がすべてメールを検証済みのIdP（Googleなど）である場合だけにしてください。既存のユーザーとはメールアドレスで紐付くので、メールを検証しないログイン方法があると他人のアカウントに入れてしまいます。

### イベントを送る（受付API）

管理画面の「送信元」で送信元を作り、送り方に応じてAPIキーか送信元IDを使います。受け付けたイベントは、その送信元のワークスペースに保存され、管理画面の「イベント」に表示されます。無効にした送信元からは受け付けません。

#### HTTP

`POST /ingest/v1/events` に、送信元の画面で発行したAPIキーを `Authorization: Bearer` ヘッダーで付けて送ります。APIキーの平文は発行時に一度だけ表示されます。クエリ文字列のキーは受け付けません。

添付がなければJSONで送ります。`body` は文字列で、Content-Typeは `body_content_type` で指定します（省略時は `text/plain; charset=utf-8`）。

```sh
curl -X POST https://pinglune.example.com/ingest/v1/events \
  -H "Authorization: Bearer pl_<keyId>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotency_key": "deploy-2026-10-31-001",
    "type": "alert.observed",
    "summary": "疎通確認用の無害なテストイベント",
    "occurred_at": "2026-10-31T12:00:00Z",
    "labels": { "project": "project-a", "env": "staging" },
    "body": "本文のテキスト"
  }'
```

添付があれば `multipart/form-data` で送ります。`metadata` パート（文字列）に `idempotency_key`、`type`、`summary`、`occurred_at`、`labels` のJSONを入れ、本文は `body` ファイルパート（0〜1個）、添付は `attachments` ファイルパート（0〜20個）で送ります。添付の名前はファイル名、Content-Typeはパートのものを使います。

```sh
curl -X POST https://pinglune.example.com/ingest/v1/events \
  -H "Authorization: Bearer pl_<keyId>_<secret>" \
  -F 'metadata={"idempotency_key":"report-001","type":"report.created","summary":"日次レポート"}' \
  -F "body=@report.md;type=text/markdown" \
  -F "attachments=@data.csv;type=text/csv"
```

新しいイベントは201、同じ `idempotency_key` で同じ内容を送り直した場合は200で、どちらも `{ "event_id": "evt_...", "duplicate": false | true }` を返します。エラーは `{ "error": { "code", "message", "fields"? } }` の形です。

| HTTP | 内容 | 再送 |
| --- | --- | --- |
| 400 | 項目の検証エラー、未知の項目（`fields` に項目ごとの理由） | しない |
| 401 | APIキーがない・正しくない・失効済み | しない |
| 403 | 送信元が無効（`source_disabled`） | しない |
| 409 | 同じ `idempotency_key` で内容が違う（`idempotency_conflict`） | しない |
| 413 | 本文と添付の合計が25 MiBを超える | しない |
| 415 | Content-Typeが `application/json` でも `multipart/form-data` でもない | しない |
| 503 | 一時的に保存できない（`temporarily_unavailable`） | 同じ `idempotency_key` で再送する |

項目の制約は[イベントモデル](docs/architecture.md#イベントモデル)を参照してください。

#### Service Bindings

同じCloudflareアカウントのWorkerからは、Service Bindingsで `Intake` エントリポイントを呼びます。送信元は `props` の送信元ID（送信元の画面に表示されます）で決まります。呼び出し側Workerの `wrangler.jsonc` に次のように書きます。

```jsonc
{
  "services": [
    {
      "binding": "PINGLUNE",
      "service": "pinglune",
      "entrypoint": "Intake",
      "props": { "source_id": "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V" }
    }
  ]
}
```

```ts
const result = await env.PINGLUNE.submit({
  idempotency_key: "job-42",
  type: "job.finished",
  summary: "バッチ処理が完了しました",
  labels: { env: "prod" },
  body: { content_type: "text/plain", bytes: new TextEncoder().encode("ログ") },
  attachments: [{ name: "result.json", content_type: "application/json", bytes: jsonBytes }],
});
if (!result.ok && result.error.retryable) {
  // 一時的な失敗。同じ idempotency_key で再送する。
}
```

項目はHTTPと同じです。`bytes` には `Uint8Array` か `ArrayBuffer` を渡します（`ReadableStream` は受け付けません）。`submit` は例外を投げず、成功なら `{ ok: true, event_id, duplicate }`、失敗なら `{ ok: false, error: { code, message, retryable, fields? } }` を返します。`retryable` は `temporarily_unavailable` のときだけ `true` です。

### MCPで読む

`/mcp` はOAuthで認可するMCPサーバーです。MCPクライアントにURL（例: `https://pinglune.example.com/mcp`）を登録すると、ログインと同意の画面が開きます。同意したユーザーの個人用ワークスペースのイベントを、次の読み取り専用のツールで読めます。

| ツール | 内容 |
| --- | --- |
| `list_events` | イベントの一覧（新しい順）。`types`、`sources`、`labels`、`since`（受付時刻）で絞り込み、`next_cursor` を `cursor` に渡して次のページを読みます |
| `get_event` | 1件のイベントと、本文・添付の一覧（`data_ref`、名前、Content-Type、サイズ、テキストとして読めるか） |
| `read_data` | 本文・添付の中身をUTF-8のテキストとして、`offset` と `limit`（バイト）の範囲で読みます。続きは `next_offset` から読みます。バイナリとUTF-8以外の文字コードは中身を返しません |

引数と結果の詳細は[MCPの読み取りツール](docs/architecture.md#mcpの読み取りツール)を参照してください。

## ライセンス

[Apache License 2.0](LICENSE)
