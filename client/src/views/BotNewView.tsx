import { type FormEvent, useState } from "react";
import type { Subscription } from "../../../src/api/types";
import { createBot } from "../actions";
import {
  DELIVERY_KINDS,
  DELIVERY_KIND_DESCRIPTIONS,
  DELIVERY_KIND_LABELS,
  EMPTY_NEW_BOT_FORM,
  type NewBotForm,
  botPath,
  destinationFromQuery,
  newBotRequest,
  sourceChoices,
} from "../bots";
import { setFlash } from "../flash";
import { Link } from "../Link";
import { type ApiClient, type BotsData, loadBotsView, useView } from "../load";
import { navigate, searchParams } from "../router";
import { SourceFields } from "./BotsView";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { ConditionFields } from "./DeliveriesView";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const CONDITIONS_NOTE =
  "条件を指定しないと、受け取る送信元のすべてのイベントが届きます。本文や添付は含まれないので、受け取る側は MCP の read_data で読みます。";

// The creation of a bot with its destination. ?destination= names a webhook destination or a polling queue that no
// bot uses, to make the bot with it; any other value is ignored.
export function BotNewView({ client, path }: { client: ApiClient; path: string }) {
  const [state, reload] = useView(() => loadBotsView(client), "bot-new");
  useDocumentTitle(viewTitle(state, () => "Bot を作成"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const destination = destinationFromQuery(searchParams(path), state.data.subscriptions);
  return <BotNewForm key={destination?.id ?? "new"} client={client} data={state.data} destination={destination} />;
}

function initialForm(destination: Subscription | null): NewBotForm {
  if (destination === null) return EMPTY_NEW_BOT_FORM;
  return {
    ...EMPTY_NEW_BOT_FORM,
    name: destination.name ?? "",
    deliveryKind: destination.kind === "queue" ? "queue" : "webhook",
    destinationId: destination.id,
  };
}

function BotNewForm({
  client,
  data,
  destination,
}: {
  client: ApiClient;
  data: BotsData;
  destination: Subscription | null;
}) {
  // The key of a new webhook destination is kept only in this state.
  const [form, setForm] = useState<NewBotForm>(() => initialForm(destination));
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sources = data.sourcesError === null ? sourceChoices(data.sources) : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = newBotRequest(form, data.sourcesError === null);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const result = await createBot(client, request.value);
    switch (result.kind) {
      case "ok":
        setFlash(
          result.bot.delivery_kind === "queue"
            ? `Bot「${result.bot.name}」を作成しました。AI にはこのページの「配信方式」にあるキュー ID を伝えてください`
            : `Bot「${result.bot.name}」を作成しました`,
        );
        navigate(botPath(result.bot.id));
        return;
      case "notFound":
        setSending(false);
        setFailure("Bot を作れませんでした");
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/bots">Bot</Link>
      </p>
      <header className="page-head">
        <h1>Bot を作成</h1>
        <p className="lead">
          名前と受け取る送信元、配信方式を決めます。Webhook とキューの配信先は Bot と一緒に作られ、Bot の名前が付きます。
        </p>
      </header>
      <form className="folder-form" aria-label="Bot を作成" onSubmit={(event) => void onSubmit(event)}>
        <label>
          名前（64&nbsp;文字以内）
          <input
            type="text"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            autoComplete="off"
            required
            maxLength={64}
            disabled={sending}
          />
        </label>
        <SourceFields
          selected={form.sourceIds}
          onChange={(sourceIds) => setForm({ ...form, sourceIds })}
          sources={sources}
          disabled={sending}
        />
        <fieldset className="participant-fields" disabled={sending}>
          <legend>配信方式</legend>
          {DELIVERY_KINDS.map((kind) => (
            <label key={kind} className="choice">
              <input
                type="radio"
                name="delivery_kind"
                value={kind}
                checked={form.deliveryKind === kind}
                // An existing destination fixes the kind.
                disabled={destination !== null && kind !== form.deliveryKind}
                onChange={() => setForm({ ...form, deliveryKind: kind })}
              />
              <span>
                <span className="choice-title">{DELIVERY_KIND_LABELS[kind]}</span>
                <span className="choice-description">{DELIVERY_KIND_DESCRIPTIONS[kind]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {destination !== null ? (
          <p className="hint">
            既存の配信先を使う: {destination.name ?? "（名前なし）"}
            {destination.callback_host === null ? "" : `（${destination.callback_host}）`}。
            <Link to="/bots/new">新しい配信先で作る</Link>
          </p>
        ) : (
          <DeliveryFields form={form} onChange={setForm} disabled={sending} />
        )}
        <div className="folder-form-actions">
          <button type="submit" disabled={sending}>
            作成
          </button>
          <Link to="/bots" className="button">
            やめる
          </Link>
        </div>
        {failure !== null && <p role="alert">{failure}</p>}
      </form>
    </main>
  );
}

// The fields of the delivery kind chosen: nothing for MCP Event, the URL, the key and the conditions for Webhook, the
// conditions for a queue.
function DeliveryFields({
  form,
  onChange,
  disabled,
}: {
  form: NewBotForm;
  onChange: (next: NewBotForm) => void;
  disabled: boolean;
}) {
  if (form.deliveryKind === "mcp") {
    return (
      <p className="hint">
        AI から Pinglune に接続するときにこの Bot を選ぶと、その AI の購読がこの Bot の配信先になります。ここで入力するものはありません。
      </p>
    );
  }
  return (
    <>
      {form.deliveryKind === "webhook" && <WebhookFields form={form} onChange={onChange} disabled={disabled} />}
      <ConditionFields
        value={form.conditions}
        onChange={(conditions) => onChange({ ...form, conditions })}
        disabled={disabled}
        note={CONDITIONS_NOTE}
      />
    </>
  );
}

// The URL and the Bearer key of a new webhook destination.
export function WebhookFields<T extends { url: string; token: string }>({
  form,
  onChange,
  disabled,
}: {
  form: T;
  onChange: (next: T) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label>
        URL（https のみ）
        <input
          type="text"
          inputMode="url"
          value={form.url}
          onChange={(event) => onChange({ ...form, url: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={2048}
          disabled={disabled}
        />
      </label>
      <label>
        キー（<code>Authorization: Bearer</code> ヘッダーで送ります。登録後は表示されません）
        <input
          type="password"
          value={form.token}
          onChange={(event) => onChange({ ...form, token: event.target.value })}
          autoComplete="off"
          required
          maxLength={1024}
          disabled={disabled}
        />
      </label>
    </>
  );
}
