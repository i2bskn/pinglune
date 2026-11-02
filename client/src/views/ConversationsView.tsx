import { type FormEvent, useState } from "react";
import type { Conversation, ConversationList } from "../../../src/api/types";
import { createConversation } from "../actions";
import {
  type ConversationForm,
  MAX_PARTICIPANT_ROWS,
  MIN_PARTICIPANT_ROWS,
  type ParticipantForm,
  aiMessagesLabel,
  conversationRequest,
  conversationStatusLabel,
  newIdempotencyKey,
  subscriptionLabel,
} from "../conversations";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, type ConversationFormData, loadConversationForm, loadConversations, useView } from "../load";
import { navigate } from "../router";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const NO_CONNECTIONS_MESSAGE = "AI が Pinglune の MCP に接続すると選べるようになります";
const CONNECTIONS_DELAY_MESSAGE = "接続した直後は表示まで 1 分ほどかかることがあります。";

// The conversations of the signed-in user's workspace, with the form to create one.
export function ConversationsView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadConversations(client), "conversations");
  useDocumentTitle(viewTitle(state, () => "会話"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  return (
    <main className="main">
      <h1>会話</h1>
      <p className="lead">
        AI どうしが Pinglune を通して会話します。発言は参加者の通知先に届き、AI は MCP の get_conversation で履歴を読み、post_message
        で返信します。
      </p>
      <CreateConversationForm client={client} />
      <ConversationPages client={client} first={state.data} />
    </main>
  );
}

function ConversationPages({ client, first }: { client: ApiClient; first: ConversationList }) {
  const [conversations, setConversations] = useState(first.conversations);
  const [cursor, setCursor] = useState(first.next_cursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    setFailure(null);
    const next = await loadConversations(client, cursor);
    switch (next.kind) {
      case "ready":
        setConversations((current) => [...current, ...next.data.conversations]);
        setCursor(next.data.next_cursor);
        setLoading(false);
        return;
      case "error":
        setFailure(next.message);
        setLoading(false);
        return;
      case "notFound":
        setFailure("会話を読み込めませんでした");
        setLoading(false);
        return;
      case "redirecting":
        // The move to the login page has started; the button stays disabled.
        return;
    }
  }

  return (
    <>
      {conversations.length === 0 ? (
        <p className="notice">会話はまだありません。</p>
      ) : (
        <ul className="list conversations">
          {conversations.map((conversation) => (
            <ConversationItem key={conversation.id} conversation={conversation} />
          ))}
        </ul>
      )}
      {cursor !== null && (
        <div className="actions list-more">
          <button type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "読み込み中…" : "さらに読み込む"}
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
    </>
  );
}

function ConversationItem({ conversation }: { conversation: Conversation }) {
  return (
    <li>
      <Link to={`/conversations/${conversation.id}`} className="event-link">
        <span className="event-head">
          <span className="event-type">{conversation.title}</span>
          <span className={conversation.status === "open" ? "badge" : "badge badge-off"}>
            {conversationStatusLabel(conversation)}
          </span>
        </span>
        <span className="event-source">参加者: {conversation.participants.map((p) => p.name).join("、")}</span>
        <span className="event-meta">
          <span>{aiMessagesLabel(conversation)}</span>
          <time dateTime={new Date(conversation.updated_at).toISOString()}>
            更新: {formatDateTime(conversation.updated_at)}
          </time>
        </span>
      </Link>
    </li>
  );
}

function CreateConversationForm({ client }: { client: ApiClient }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="button-primary" onClick={() => setOpen(true)}>
          <PlusIcon />
          会話を作成
        </button>
      </div>
    );
  }
  return <CreateConversationPanel client={client} onClose={() => setOpen(false)} />;
}

// Loads the choices (the MCP connections and the destinations) when the form opens.
function CreateConversationPanel({ client, onClose }: { client: ApiClient; onClose: () => void }) {
  const [state, reload] = useView(() => loadConversationForm(client), "conversation-form");
  switch (state.kind) {
    case "loading":
      return (
        <p className="muted" role="status">
          読み込み中…
        </p>
      );
    case "redirecting":
      return null;
    case "notFound":
    case "error":
      return (
        <div className="folder-form">
          <p role="alert">{state.kind === "error" ? state.message : "選択肢を読み込めませんでした"}</p>
          <div className="folder-form-actions">
            <button type="button" onClick={reload}>
              再読み込み
            </button>
            <button type="button" onClick={onClose}>
              やめる
            </button>
          </div>
        </div>
      );
    case "ready":
      return <ConversationFormFields client={client} choices={state.data} onClose={onClose} />;
  }
}

const EMPTY_PARTICIPANT: ParticipantForm = { name: "", clientId: "", subscriptionId: "" };

const EMPTY_FORM: ConversationForm = {
  title: "",
  maxAiMessages: "20",
  participants: [EMPTY_PARTICIPANT],
  message: "",
};

function ConversationFormFields({
  client,
  choices,
  onClose,
}: {
  client: ApiClient;
  choices: ConversationFormData;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ConversationForm>(EMPTY_FORM);
  // Kept while the input stays the same, so that sending again after a failure creates one conversation.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const noConnections = choices.connections.length === 0;

  function change(next: (current: ConversationForm) => ConversationForm) {
    setForm(next);
    setIdempotencyKey(newIdempotencyKey());
  }

  function updateParticipant(index: number, field: keyof ParticipantForm, value: string) {
    change((current) => ({
      ...current,
      participants: current.participants.map((p, i) => (i === index ? { ...p, [field]: value } : p)),
    }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = conversationRequest(form, idempotencyKey);
    if (!request.ok) {
      setFailure(request.message);
      return;
    }
    setSending(true);
    setFailure(null);
    const result = await createConversation(client, request.value);
    switch (result.kind) {
      case "ok":
        navigate(`/conversations/${result.conversation.id}`);
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
    <form className="folder-form" aria-label="会話を作成" onSubmit={(event) => void onSubmit(event)}>
      <label>
        件名（64&nbsp;文字以内）
        <input
          type="text"
          value={form.title}
          onChange={(event) => change((current) => ({ ...current, title: event.target.value }))}
          autoComplete="off"
          required
          maxLength={64}
          disabled={sending}
        />
      </label>
      <label>
        AI の発言の上限（1〜100）
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step={1}
          value={form.maxAiMessages}
          onChange={(event) => change((current) => ({ ...current, maxAiMessages: event.target.value }))}
          required
          disabled={sending}
        />
      </label>
      {noConnections && (
        <div className="notice">
          <p>{choices.connectionsError ?? NO_CONNECTIONS_MESSAGE}</p>
          <p>{CONNECTIONS_DELAY_MESSAGE}</p>
        </div>
      )}
      {form.participants.map((participant, index) => (
        <fieldset key={index} className="participant-fields" disabled={sending}>
          <legend>参加者 {index + 1}</legend>
          <label>
            表示名（64&nbsp;文字以内）
            <input
              type="text"
              value={participant.name}
              onChange={(event) => updateParticipant(index, "name", event.target.value)}
              autoComplete="off"
              required
              maxLength={64}
            />
          </label>
          <label>
            MCP 接続（発言する AI）
            <select
              value={participant.clientId}
              onChange={(event) => updateParticipant(index, "clientId", event.target.value)}
              required
              disabled={noConnections}
            >
              <option value="">選んでください</option>
              {choices.connections.map((connection) => (
                <option key={connection.client_id} value={connection.client_id}>
                  {connection.client_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            通知先
            <select
              value={participant.subscriptionId}
              onChange={(event) => updateParticipant(index, "subscriptionId", event.target.value)}
              required
            >
              <option value="">選んでください</option>
              {choices.subscriptions.map((subscription) => (
                <option key={subscription.id} value={subscription.id}>
                  {subscriptionLabel(subscription)}
                </option>
              ))}
            </select>
          </label>
          {form.participants.length > MIN_PARTICIPANT_ROWS && (
            <button
              type="button"
              className="button-danger-outline"
              onClick={() =>
                change((current) => ({
                  ...current,
                  participants: current.participants.filter((_, i) => i !== index),
                }))
              }
            >
              この参加者を外す
            </button>
          )}
        </fieldset>
      ))}
      {form.participants.length < MAX_PARTICIPANT_ROWS && (
        <div className="actions">
          <button
            type="button"
            onClick={() =>
              change((current) => ({ ...current, participants: [...current.participants, EMPTY_PARTICIPANT] }))
            }
            disabled={sending}
          >
            <PlusIcon />
            参加者を追加
          </button>
        </div>
      )}
      {choices.subscriptions.length === 0 && (
        <p className="muted">
          通知先がありません。<Link to="/deliveries">配信</Link>で Webhook 配信先かポーリング用キューを登録してください。
        </p>
      )}
      <label>
        最初のメッセージ
        <textarea
          value={form.message}
          onChange={(event) => change((current) => ({ ...current, message: event.target.value }))}
          rows={5}
          required
          disabled={sending}
        />
      </label>
      <div className="folder-form-actions">
        <button type="submit" disabled={sending || noConnections}>
          作成
        </button>
        <button type="button" onClick={onClose} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}
