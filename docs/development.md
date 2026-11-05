# 開発

Pingluneを開発する場合の、ローカル開発・コマンド・デプロイの仕組みをまとめます。利用者向けの導入手順は[ドキュメント](https://pinglune.dev/guides/introduction/)を参照してください。

## 技術スタック

Cloudflare Workers + Hono + D1（drizzle-orm）+ R2 + Queuesで動き、MCPのOAuthの状態はKVに置きます。言語はTypeScript、パッケージ管理はpnpm、テストは`@cloudflare/vitest-plugin`、Web画面はReact + Viteです。

ログイン、ユーザー管理、MCPのOAuth認可サーバーはLibrenoから流用した土台です。

## ローカルで開発する

Node.jsとpnpmが必要です。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # JWT_SECRET を設定する
pnpm db:migrate:local
pnpm dev
```

ログイン・ユーザー管理・MCPのOAuthには[`@i2bskn/workers-app-core`](https://github.com/i2bskn/workers-app-core)を使っています（`src/core.ts`）。

`pnpm dev`はWeb画面（`client/`）をビルドしてから`wrangler dev`を起動します。`client/`のファイルを変えると自動で再ビルドされます。HMRは無いので、ブラウザを再読み込みしてください。

CookieにSecure属性と`__Host-`接頭辞を使っているので、`http://localhost`ではSafariでログインできません。ChromeかFirefoxを使ってください。

| コマンド | 内容 |
| --- | --- |
| `pnpm test` | テスト |
| `pnpm typecheck` | 型チェック（サーバーとWeb画面） |
| `pnpm build:client` | Web画面を`dist/client`にビルドする |
| `pnpm db:generate` | スキーマからマイグレーションを作る |
| `pnpm db:migrate:local` | ローカルのD1にマイグレーションを適用する |

## デプロイの仕組み

ボタンもWorkers Buildsも、デプロイには `pnpm run deploy`（`scripts/deploy.mjs`）を使います。スクリプトは `wrangler.jsonc` のD1とR2の設定を読み、次の順に実行します。

1. D1データベースが既にあるかを確かめます。
2. `LOCATION_HINT` が設定されていれば、まだないD1とR2をその場所に作ります。作れなかった場合は、別の場所に作られないようにデプロイを止めます。
3. D1のマイグレーション（`drizzle/migrations`）を本番に適用します（マイグレーションだけなら `pnpm db:migrate:remote`）。
4. `wrangler deploy` を実行します。新しいコードが動く前にテーブルができているよう、マイグレーションの後にしています。

`LOCATION_HINT` を設定していない初回のデプロイでD1がまだないときは、3と4を入れ替えて `wrangler deploy` を先に実行します。D1・KV・R2・Queuesのキューを自動で作るのは `wrangler deploy` で、`wrangler d1 migrations apply` は既存のD1を探すだけだからです。テーブルができるまでの数秒間、Workerはテーブルのない状態で動きますが、まだ誰も使っていないので影響はありません。

手元から `pnpm run deploy` を実行する場合、Cloudflareのアカウントが複数あると、wranglerがアカウントを選べずに失敗します。`CLOUDFLARE_ACCOUNT_ID` にデプロイ先のアカウントIDを指定してください。

- 配信に使うQueuesのキュー（`pinglune-deliveries` と dead letter queueの `pinglune-deliveries-dlq`）は、存在しなければ `wrangler deploy` が自動で作ります。`wrangler deploy` が自動で作るのはproducerのバインディングがあるキューだけなので、コードでは使わない `DELIVERY_DLQ` をdead letter queueのproducerとして宣言しています。日次Cron（毎日18:00 UTC）も `wrangler.jsonc` の設定で登録されます。
- Workers FreeプランでもQueuesを使えますが、1日1万オペレーションまでです。1件の配信でおよそ3オペレーション（書き込み・読み取り・削除）を使い、再送するとその分増えるので、1日あたりの配信はおよそ3,000件までが目安です。

