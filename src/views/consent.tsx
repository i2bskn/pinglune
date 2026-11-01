/** @jsxImportSource hono/jsx */
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { Layout } from "./layout";

// Every string in details may come from the client. JSX escapes them.
export function ConsentPage(props: { details: ConsentDescription; handle: string; email: string }) {
  const { details } = props;
  return (
    <Layout title="接続の許可">
      <h1>{details.clientName} からの接続を許可しますか？</h1>
      {details.clientDomain ? (
        <p>
          このアプリは <strong>{details.clientDomain}</strong> が公開しています。
        </p>
      ) : (
        <p>このアプリの名前は確認されていません。</p>
      )}
      <p>
        接続は <strong>{details.redirectHost}</strong> に渡されます。
      </p>
      {details.redirectIsLoopback ? (
        <p role="alert" class="warning">
          <strong>このパソコン上のアプリに接続を渡します。今そのアプリから接続を始めた場合だけ許可してください。</strong>
        </p>
      ) : null}
      <p>ログイン中のユーザー: {props.email}</p>
      {/* TODO: Revisit this description when tools that write data are added. */}
      <p>許可すると、このアプリはあなたとして、Pingluneに保存されたイベントとデータを読み取ります。</p>
      <form method="post" action="/authorize" class="buttons">
        <input type="hidden" name="handle" value={props.handle} />
        <button type="submit" name="decision" value="approve" class="primary">
          許可する
        </button>
        <button type="submit" name="decision" value="deny">
          拒否する
        </button>
      </form>
    </Layout>
  );
}
