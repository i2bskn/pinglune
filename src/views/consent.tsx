/** @jsxImportSource hono/jsx */
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { Layout } from "./layout";

// Every string in details may come from the client. JSX escapes them.
// Bot names come from the user. bots are the user's bots, by name; selectedBotId is preselected; sharedBotNames are the
// bots that the same app is connected as, when there are two or more.
export function ConsentPage(props: {
  details: ConsentDescription;
  handle: string;
  email: string;
  bots: { id: string; name: string }[];
  selectedBotId: string | null;
  sharedBotNames: string[];
}) {
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
      <form method="post" action="/authorize">
        <input type="hidden" name="handle" value={props.handle} />
        {props.bots.length === 0 ? (
          <input type="hidden" name="bot_id" value="" />
        ) : (
          <>
            {props.sharedBotNames.length > 0 ? (
              <p>
                このアプリは複数の Bot（{props.sharedBotNames.join("、")}
                ）で使われています。どの Bot として接続するか選んでください。
              </p>
            ) : null}
            <label>
              どの Bot として接続するか
              <select name="bot_id">
                <option value="" selected={props.selectedBotId === null}>
                  Bot に割り当てない
                </option>
                {props.bots.map((bot) => (
                  <option value={bot.id} selected={bot.id === props.selectedBotId}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <p>
          Bot を選ぶと、この接続がその Bot として会話に参加します。その Bot の以前の接続は切断されます。Bot は管理画面の『Bot』で作れます。
        </p>
        <div class="buttons">
          <button type="submit" name="decision" value="approve" class="primary">
            許可する
          </button>
          <button type="submit" name="decision" value="deny">
            拒否する
          </button>
        </div>
      </form>
    </Layout>
  );
}
