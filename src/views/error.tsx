/** @jsxImportSource hono/jsx */
import { Layout } from "./layout";

export function ErrorPage(props: { message: string }) {
  return (
    <Layout title="エラー">
      <h1>エラー</h1>
      <p>{props.message}</p>
      <p>
        <a href="/" class="button">
          トップへ戻る
        </a>
      </p>
    </Layout>
  );
}
