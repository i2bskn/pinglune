# APIリファレンス

イベントの受付（HTTP、Service Bindings、メール）、イベントモデル、MCP（OAuth、読み取りツール、MCP Eventsによる配信）の仕様をまとめます。導入と設定の手順は[ドキュメント](https://pinglune.dev/guides/introduction/)を参照してください。

## 受付

### 入口

受付はHTTP API、Service Bindings、メールの三つの入口を持ちます。入口の役割は送信元を認証して確定することだけで、イベントの検証・保存・配信登録はすべての入口から呼ぶ共通の受付処理で行います。

| 入口 | 想定する送信元 | 送信元の確定方法 |
| --- | --- | --- |
| HTTP API（`POST /ingest/v1/events`） | Cloudflare外のプログラム、別アカウントのWorker | `Authorization: Bearer` ヘッダーのAPIキー |
| Service Bindings（RPC） | 同じCloudflareアカウントのWorker | 呼び出し側のバインディング設定の `props` に書いた送信元ID |
| メール（Email Workers） | メールを送れるシステム（監視・SaaSの通知など） | 宛先アドレスのランダムなローカル部 |

Pingluneは送信元をワークスペースに登録します。送信元は名前と有効・無効の状態を持ち、受け付けたイベントはその送信元が属するワークスペースに保存します。Service Bindingsのpropsには送信元IDだけを置きます。送信元はイベントから参照されるため削除できず、止めるときは無効にします。

プログラムごとに送信元を分けるか、まとめるかは利用側が決めます。

### HTTP

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

項目の制約は[イベントモデル](#イベントモデル)を参照してください。

### Service Bindings

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

### メール

設定の手順は[メールでイベントを送る](https://pinglune.dev/guides/email/)を参照してください。

メールの経路では、Email Routingのcatch-allルールで `EMAIL_DOMAIN` 宛てのメールをすべてWorkerの `email` ハンドラーに渡します。

- 受付アドレスは `<ローカル部>@<EMAIL_DOMAIN>` で、ローカル部は送信元ごとに発行する20文字の `[a-z0-9]`（約2^103通り）です。推測できないことを認証の代わりにし、漏れたら無効にして発行し直します。1つの送信元は複数のアドレス（有効なものは10個まで）を持てます。ドメインは保存しないので、`EMAIL_DOMAIN` を変えてもローカル部はそのまま使えます。From・SPF・DKIMによる送信者の確認はしません。
- 宛先はエンベロープのRCPT TOで判定し、ドメインとローカル部を小文字にして完全一致で照合します。`+` のサブアドレスは扱いません。
- メールは次のイベントに変換します。type は `email.received`、summary は件名（1行にして2,000文字まで、空なら `(件名なし)`）、`occurred_at` は `Date` ヘッダー（解釈できなければ受付時刻）、`labels.from` はFromの最初のアドレス（送信者の自己申告で、偽装できる）。本文は主なヘッダー（From・To・Cc・Reply-To・Subject・Date・Message-ID）とテキストの本文をまとめたUTF-8のテキストで、HTMLの本文は `body.html`、メールの添付はそのまま添付にします。添付が20個を超えたら先頭の20個を残し、残りの名前を本文に書きます。メールの原文（.eml）は保存しません。
- `idempotency_key` は `email:` に、変換後のイベントの中身（summary、occurred_at、labels、本文と添付のハッシュ）の正規化JSONのSHA-256を付けたものです。原文のハッシュを使わないのは、再送で経路のトレースヘッダー（Received、ARC-* など）が変わっても重複として扱い、未配信の配信を入れ直すためです。Message-IDのないメールは、定型の通知が黙って1件にまとまらないよう受付時刻もキーに含め、届くたびに別のイベントにします。この場合、一時的な失敗のあとの再送では最初のイベントの配信が未配信のまま残ることがあります。
- 恒久的な拒否（未設定、未登録・無効化済みのアドレス、無効な送信元、サイズ超過、解析できないメール）は `setReject` でSMTPのエラーを返します。D1・R2・キューの失敗や `EMAIL_DOMAIN` の誤りなどの一時的な失敗は、送信側が再送できるよう例外を投げます。
- `EMAIL_DOMAIN` は `loadConfig` で検証しません。任意の機能の設定ミスで、HTTPの受付・MCP・配信・Cronまで止めないためです。

## イベントモデル

MCPで購読するイベント名と、業務上の種別（type）は分けます。MCPのイベント定義は `pinglune.event` の1種類とし、typeとラベルを購読フィルターで絞ります。

### 送信元が渡す項目

| 項目 | 必須 | 内容と制約 |
| --- | --- | --- |
| `idempotency_key` | 必須 | 重複排除キー。1〜255文字の印字可能なASCII。送信元ごとに一意 |
| `type` | 必須 | 業務上の種別。小文字英数字・`_`・`-` からなる語をドットで区切った形（例：`alert.observed`）で、最大100文字。`pinglune.` で始まる種別はPingluneが予約する |
| `summary` | 必須 | 概要のプレーンテキスト。最大2,000文字 |
| `occurred_at` | 任意 | 発生時刻（RFC 3339）。省略時は受付時刻 |
| `labels` | 任意 | 分類用のキーと値。値は文字列のみで、入れ子にしない。最大16個 |
| `body` | 任意 | 原文。テキストまたはバイナリと、そのContent-Type |
| `attachments` | 任意 | 添付ファイル。名前、Content-Type、中身。最大20個 |

ラベルのキーは小文字英数字で始まり、小文字英数字・`_`・`.`・`-` からなる最大63文字とします。値は最大256文字です。ラベルは送信元の自己申告です。認証で確定するのは `source`（送信元）だけで、ラベルの値によって権限を与えません。

`body` と `attachments` はR2に保存し、それぞれにdata_refを割り当てます。1リクエストの合計サイズの上限は25 MiBです。

### Pingluneが付与する項目

| 項目 | 内容 |
| --- | --- |
| `event_id` | `evt_` + ULID。時刻順に並ぶため、`list_events` のcursorにも使う |
| `workspace_id` | 送信元が属するワークスペース |
| `source` | 認証で確定した送信元のIDと名前。名前はワークスペース内で一意 |
| `received_at` | 受付時刻 |
| `data` | `body` と添付の一覧（data_ref、名前、Content-Type、サイズ）。data_refは `dat_` + ULID |

### 入力形式

- HTTP：添付がなければ `application/json`、添付があれば `multipart/form-data`（メタデータのJSONパートと、原文・添付のファイルパート）で送る。それ以外のContent-Typeは415で拒否する。
  - JSONでは `body` を文字列で渡し、Content-Typeを `body_content_type` で指定する（省略時は `text/plain; charset=utf-8`）。添付はJSONでは送れない。
  - 未知の項目は400で拒否する。
- Service Bindings（RPC）：同じ項目をオブジェクトで渡す。`body` と添付の中身は `Uint8Array` または `ArrayBuffer` で渡す。サイズ上限の確認とR2への保存を単純にするため、`ReadableStream` は受け付けない。
- 0バイトの `body` は拒否する。本文がなければ `body` を省略する。添付は0バイトでもよい。
- メール：受信したメールをイベントの項目に変換する（変換の内容は[メール](#メール)を参照）。
- どの入口も、検証済みの同じ形に変換してから共通の受付処理に渡す。

### 重複排除

- 重複排除キーの範囲は送信元ごととし、`(送信元, idempotency_key)` で一意にする。イベントを保持している間は有効とする。
- 同じキーで同じ内容が届いたら、既存の `event_id` を返し、未配信の配信をキューへ入れ直す。HTTPでは新規を201、重複を200で返す。
- 同じキーで内容が違う場合は、送信元の不具合とみなして409で拒否する。内容の比較には、正規化した項目と添付のハッシュを使う。

### 受付のエラー

| 状況 | HTTP | 送信元が再送してよいか |
| --- | --- | --- |
| 項目の検証エラー、未知の項目 | 400（項目ごとの理由を返す） | しない |
| 認証の失敗 | 401 | しない |
| 送信元が無効 | 403 | しない |
| 重複排除キーの内容不一致 | 409 | しない |
| サイズ超過 | 413 | しない |
| Content-Typeが対応外 | 415 | しない |
| 保存・キュー投入の失敗 | 503 | する（同じ重複排除キーで） |

RPCでは同じ分類のエラーを、種類を判別できる形で返します。

## MCP

### 認証

`/mcp` はOAuthで認可するMCPサーバーです。MCP認可仕様に沿ったOAuth 2.1の認可サーバーをPinglune自身が持ち、DCR、CIMD、PKCE（S256）、保護リソースメタデータ、認可サーバーメタデータ、RFC 9207のissパラメータに対応します。クライアント、grant、トークンはKVに保存します。CIMDには互換フラグ `global_fetch_strictly_public` が必要です。

| エンドポイント | 内容 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` | 保護リソースメタデータ。`resource` は `<origin>/mcp`、`authorization_servers` は `<origin>` |
| `GET /.well-known/oauth-authorization-server` | 認可サーバーメタデータ |
| `POST /oauth/register` | 動的クライアント登録（DCR） |
| `GET /authorize` | 認可要求。ログインと同意の画面を表示します |
| `POST /oauth/token` | トークンの発行と更新 |

- スコープは `mcp` の1つです。
- アクセストークンの有効期間は12時間、リフレッシュトークンは30日です（`AUTH_MODE=oidc` では24時間）。
- ユーザーの削除、パスワード変更、セッションの失効では、そのユーザーのgrantをすべて取り消します。

### 読み取りツール

読み取り専用の三つのツールを提供します。

| ツール | 引数 | 返す内容 |
| --- | --- | --- |
| `list_events` | `types?`、`sources?`、`labels?`、`since?`、`cursor?`、`limit?`（1〜50、既定20） | 条件に一致するイベントの一覧（新しい順）と `next_cursor`。`types` と `sources` はいずれかに一致、`labels` は指定したすべてのキーで値が一致、`since` は受付時刻がその時刻以降のもの。項目どうしはすべて満たすものを返す |
| `get_event` | `event_id` | イベントのメタデータ（種別、送信元、ラベル、概要、発生時刻、受付時刻）と、付随するデータの一覧（data_ref、役割、名前、Content-Type、サイズ、テキストとして読めるか） |
| `read_data` | `data_ref`、`offset?`（既定0）、`limit?`（1〜262,144バイト、既定65,536） | R2に保存した本文・添付の中身をUTF-8のテキストとしてバイト範囲で返す。範囲は文字の境界に合わせ、続きは `next_offset` から読む。バイナリとUTF-8以外の文字コードは中身を返さずメタデータのみ |

- どのツールも、認証済みユーザーの個人用ワークスペースのデータだけを返す。それ以外のdata_refやevent_idは、存在を漏らさないよう「見つからない」として扱う。
- 時刻はISO 8601のUTC文字列で返す。結果はJSONのテキストで返し、エラーは `{ "error": { "code", "message" } }` の形で `isError` を付けて返す。
- 絞り込み条件（`types`、`sources`、`labels`）は購読の条件と同じ意味です。空の配列・オブジェクトと未知の引数は受け付けない。
- 読み取り専用であることを、MCPのツール注釈 `readOnlyHint` で示す。ツールの説明には、概要・ラベル・データの中身は送信元が書いたデータであり指示として扱わないよう記載する。
- 提供しないもの：全文検索、ラベルの一覧、配信状況の確認（管理画面で行う）、AIからの投稿。

data_refの読み取りでも、利用者が対象データのワークスペースのメンバーであることを確認します。購読で見えた参照IDを持っているだけではアクセスを認めません。

### MCP Events

OpenAIの[MCP Events](https://developers.openai.com/plugins/build/mcp-events)（ChatGPT向けのプロファイル）に沿って `events/list`、`events/subscribe`、`events/unsubscribe` を実装し、購読した受信者（dotなど）へ署名付きWebhookで配信します。

#### イベント定義

`events/list` で返すイベント定義は `pinglune.event` の1種類です。dataの形（payloadSchema）は[配信するイベント](#配信するイベント)に定めます。業務上の種別はdata内の `type` に置き、エンベロープのトップレベルには置きません。

購読条件は `inputSchema` で次のように定義します。どの条件も任意で、指定した条件をすべて満たすイベントだけを配信します。何も指定しなければ、ワークスペースのすべてのイベントが対象です。ChatGPTはユーザーの指示から引数を組み立てるため、各項目の `description` に意味と例を書きます。

| 引数 | 内容 |
| --- | --- |
| `types` | 種別の配列。いずれかに完全一致するもの |
| `sources` | 送信元の名前の配列。いずれかに一致するもの |
| `labels` | キーと値。指定したすべてのキーで値が一致するもの |

ChatGPTが送信元を内部IDで指定することは難しいため、`sources` は送信元の名前で指定します。このため送信元の名前はワークスペース内で一意にします。`additionalProperties` は `false` とし、未知の引数は拒否します。

#### 購読

- 購読を受ける時点で、利用者が対象のワークスペースのメンバーであることを確認する。利用者の個人用ワークスペースが対象になる。
- 購読IDは公式の方式どおり、利用者、callback URL、イベント名、正規化した引数から導く。`sub_` に、これらを正規化したJSONのSHA-256の先頭32桁を付けた値とする。同じIDの購読は更新として扱い、期限と署名secretを更新する。引数の配列の順序と重複は正規化しないため、順序が違えば別の購読になる。
- 購読の寿命は、`ttlMs` を5分以上24時間以下に丸めた値とする。省略時と `ttlMs: null` は24時間。応答の `refreshBefore` は受付時刻にこの寿命を足した時刻で、購読はさらに1時間の猶予の後に期限切れになる。更新が少し遅れても、検証のやり直しや取りこぼしが起きないようにするため。
- callback検証は、新しい購読と、終了済み・期限切れの購読を復活させるときだけ行う。有効な購読の更新では検証しない（公式の「成功を一定期間キャッシュしてよい」に当たる）。
- 更新で署名secretが変わったときは、前のsecretを1時間だけ残し、その間は配信で新旧両方の鍵で署名する。終了済み・期限切れの購読を復活させるときは前のsecretを残さない。
- 署名secretは配信のたびに必要なため、ハッシュではなく暗号化して保存する。AES-GCM（256ビット）で暗号化し、購読IDを追加認証データにして、別の購読の行へ暗号文を移しても復号できないようにする。鍵は新しい設定を増やさずに `JWT_SECRET` からHKDF-SHA256で導出し、JWTの署名鍵とは分ける。このため `JWT_SECRET` を変えると、保存済みのsecretは復号できなくなる。ChatGPTは期限（最長24時間）の前に同じ購読を更新してsecretを渡し直すので、その時点で新しい鍵で保存し直され、配信が回復する。それまでの間、その購読への配信はできない。
- secretは平文でログ、応答、エラーに出さない。
- 履歴の再開（replay）には対応せず、`cursor: null`、`truncated: false` を返す。
- `events/unsubscribe` は冪等で、該当する購読がなくても空の `result` を返す。購読IDに利用者が含まれるうえ、終了する行も利用者で絞るため、他の利用者の購読は終了できない。引数は購読時のスキーマでは検証しない。スキーマを後から狭めても、以前の購読を解除できるようにするため。
- 購読は削除せず、終了時刻を記録して止める（配信の記録から参照するため）。ユーザーを削除したときだけ、購読の行も削除する。パスワード変更、管理者によるパスワード再設定、セッションの失効では、grantの取り消しと合わせてそのユーザーの購読をすべて終了する。
- 配信の直前に、購読が有効で期限内であること、利用者がワークスペースのメンバーであることを確認し、満たさなければ送らない。

#### 配信するイベント

公式エンベロープの `eventId` には `event_id` を入れ、再送でも変えません。`name` は `pinglune.event` です。`data` は次の形とし、payloadSchemaとして公開します。原文や添付の中身は含めず、data_refで参照します。

```json
{
  "event_id": "evt_01JC9Z8Q4R6T2V7W3X5Y1A0B2C",
  "type": "alert.observed",
  "source": { "id": "src_01JC9Z7H2K4M6N8P0Q2R4S6T8V", "name": "example-app" },
  "labels": { "project": "project-a", "env": "staging" },
  "occurred_at": "2026-10-31T12:00:00Z",
  "received_at": "2026-10-31T12:00:03Z",
  "summary": "疎通確認用の無害なテストイベント",
  "data": [
    { "data_ref": "dat_01JC9Z8Q5A7B9C1D3E5F7G9H1J", "name": "body", "content_type": "text/plain", "size": 1234 }
  ]
}
```

各項目の上限により、dataは公式の上限（本文全体で256 KiB）を大きく下回ります。エンベロープの `timestamp` には `occurred_at`（発生時刻）を入れます。履歴の再開（replay）に対応しないため、`cursor` は `null` です。購読条件（type、送信元、ラベル）は `events/subscribe` の `arguments` で受け取ります（[イベント定義](#イベント定義)）。

data_refは権限確認付き読み取りツールで解決する識別子で、R2の資格情報や誰でも読めるURLを配るものではありません。署名secretはイベントに含めません。

- エンベロープは `{ "eventId", "name": "pinglune.event", "timestamp": 発生時刻, "data": get_eventの結果, "cursor": null }`。`webhook-id` はイベントIDで、再送でも変えない。本文が256 KiBを超えるイベントは送らずに失敗とする。
- `X-MCP-Subscription-Id` ヘッダーに購読IDを入れる。
- 配信先の応答が2xxなら成功、410と413は再送せず失敗として記録する。410でも購読は止めない（ドラフト仕様では410は購読に影響しない。購読はChatGPTの更新が止まれば期限で終わる）。宛先の遮断（`blocked_destination`）も再送しない。それ以外の失敗（5xx、他の4xx、タイムアウト、接続失敗、名前解決の失敗、リダイレクト）は、30秒から倍々に5回（30・60・120・240・480秒、合計約15分）再送する。6回目の試行で失敗なら失敗とする。
- 2xxを受けた後にD1の更新が失敗すると、同じイベントがもう一度送られる。少なくとも1回の配信として許容し、受信側は `webhook-id`（イベントID）で重複を除く。
- 配信の順序は保証しない。

#### callbackへの送信

検証用通信と配信の両方に同じ制限を適用します。送信のたびに次を確認します。

- URLはHTTPSで、ユーザー名・パスワード、443以外のポート、フラグメントを含まず、2,048文字以下。
- ホストがIPアドレスなら遮断する（Workersの `fetch()` はIPアドレス宛てに送れないため、公開アドレスでも一律に拒否する）。`localhost`、`.localhost`・`.local`・`.internal`・`.home.arpa`・`.lan` で終わる名前、ドットを含まない名前、Pinglune自身のホスト（リクエストのホストと `APP_ORIGIN` のホスト）も遮断する。
- DNS over HTTPS（`cloudflare-dns.com`）でAとAAAAを引き、1つでも公開でないアドレスがあれば遮断する。IPv4はプライベート、ループバック、リンクローカル、CGNAT、文書用、マルチキャスト、予約済みなどの範囲を遮断する。IPv6はグローバルユニキャスト（`2000::/3`）だけを許し、その中の特殊用途・文書用・6to4の範囲も遮断する。名前を解決できないときは送らない。
- リダイレクトには従わず、3xxは失敗とする。タイムアウトはDNS over HTTPSが5秒、送信が10秒。応答本文は4 KiBまで読む。

#### エラー

JSON-RPCのエラーはChatGPTの記載に合わせます。引数の誤り（未知のイベント名、`webhook` 以外の配信方式、不正なURLやsecret、購読条件の誤りなど）は `-32602`（`Invalid params`）、callbackの宛先が遮断対象・到達できない・検証に失敗した場合は `-32015`（`CallbackEndpointError`）、想定外のエラーは `-32603`（`Internal error`）です。`-32602` と `-32015` では `data.reason` に理由（例：`invalid_url`、`blocked_destination`、`challenge_failed`）を入れます。ドラフト仕様本体のエラーコードは暫定のため使いません。

### 既知の制限

- 公式は「接続時に宛先を解決して検証し、検証したアドレスへ接続する」ことを求めていますが、Workersの `fetch()` には接続先のIPアドレスを固定する手段がありません。このため事前にDNS over HTTPSで検証し、そのあとホスト名のまま `fetch()` します。事前の名前解決と `fetch()` 自身の名前解決の間にDNSの答えを変えられると（DNS rebinding）、検証を通った後に非公開のアドレスへ送られる可能性が残ります。互換フラグ `global_fetch_strictly_public` は自分のゾーン宛ての送信をセキュリティ設定に通すためのもので、非公開アドレス宛ての遮断にはなりません。接続先IPを固定するには `connect()` と自前のTLSなどが必要になるため、行っていません。
- grantの取り消しはKVで行い、KVは結果整合性のため、取り消しの後も約60秒は古いアクセストークンで `events/subscribe` を呼べることがある。このとき購読は再び有効になる。
- 明示的な取り消し（ユーザー削除、パスワード変更、セッションの失効）以外でアクセス権を失った場合（トークンの期限切れなど）は、購読は期限（最長25時間）まで残る。ユーザーが削除されていれば、配信の直前の確認で送らない。
