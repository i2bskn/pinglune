import { type FormEvent, useState } from "react";
import type { ConversationDetail, ConversationMessage } from "../../../src/api/types";
import { postConversationMessage, stopConversation } from "../actions";
import {
  aiMessagesLabel,
  conversationStatusLabel,
  newIdempotencyKey,
  participantDestinationLabel,
  participantDestinationStatus,
} from "../conversations";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import {
  type ApiClient,
  type ConversationDetailData,
  loadConversationDetail,
  loadConversationMessages,
  useView,
} from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { UNKNOWN_RESULT_MESSAGE } from "./SourcesView";

const CONVERSATION_GONE_MESSAGE = "この会話は見つかりません";
const STOP_CONFIRMATION =
  "停止すると AI はこの会話に発言できなくなり、まだ届いていない通知も止まります。元に戻せません。";

// One conversation: the messages as a chat, the participants, the form to send a message and the stop button. New
// messages are shown when the screen is loaded again.
export function ConversationDetailView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadConversationDetail(client, id), `conversation:${id}`);
  // The result of the last operation, kept across the reload that follows.
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, (data) => data.conversation.title));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="会話が見つかりません" onReload={reload} />;
  }
  return (
    <ConversationContent
      key={`${state.data.conversation.updated_at}:${state.data.messages.messages.at(-1)?.event_id ?? "empty"}`}
      client={client}
      data={state.data}
      notice={notice}
      onReload={() => {
        setNotice(null);
        reload();
      }}
      onDone={(message) => {
        setNotice(message);
        reload();
      }}
    />
  );
}

function ConversationContent({
  client,
  data,
  notice,
  onReload,
  onDone,
}: {
  client: ApiClient;
  data: ConversationDetailData;
  notice: string | null;
  onReload: () => void;
  onDone: (message: string | null) => void;
}) {
  const { conversation } = data;
  const open = conversation.status === "open";
  return (
    <main className="main">
      <p className="breadcrumb">
        <Link to="/conversations">会話</Link>
      </p>
      <h1 className="event-title">{conversation.title}</h1>
      <p className="conversation-state">
        <span className={open ? "badge" : "badge badge-off"}>{conversationStatusLabel(conversation)}</span>
        <span>{aiMessagesLabel(conversation)}</span>
      </p>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={onReload}>
          読み込み直す
        </button>
        {open && <StopConversation client={client} conversation={conversation} onDone={onDone} />}
      </div>

      <h2>メッセージ</h2>
      <MessageTimeline client={client} conversationId={conversation.id} first={data.messages} />
      {open ? (
        <MessageForm client={client} conversationId={conversation.id} onDone={onDone} />
      ) : (
        <p className="muted">会話は停止しています。発言できません。</p>
      )}

      <h2>参加者</h2>
      <ParticipantList conversation={conversation} />
    </main>
  );
}

function StopConversation({
  client,
  conversation,
  onDone,
}: {
  client: ApiClient;
  conversation: ConversationDetail;
  onDone: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await stopConversation(client, conversation.id);
    switch (result.kind) {
      case "ok":
        onDone("会話を停止しました");
        return;
      case "notFound":
        onDone(CONVERSATION_GONE_MESSAGE);
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
        return;
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="button-danger-outline"
        onClick={() => {
          setConfirming(true);
          setFailure(null);
        }}
      >
        停止
      </button>
    );
  }
  return (
    <form className="folder-form conversation-stop" aria-label="会話を停止" onSubmit={(event) => void onSubmit(event)}>
      <p>{STOP_CONFIRMATION}</p>
      <div className="folder-form-actions">
        <button type="submit" className="button-danger" disabled={sending}>
          停止する
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function MessageTimeline({
  client,
  conversationId,
  first,
}: {
  client: ApiClient;
  conversationId: string;
  first: ConversationDetailData["messages"];
}) {
  const [messages, setMessages] = useState(first.messages);
  const [cursor, setCursor] = useState(first.older_cursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function loadOlder() {
    if (cursor === null) return;
    setLoading(true);
    setFailure(null);
    const older = await loadConversationMessages(client, conversationId, cursor);
    switch (older.kind) {
      case "ready":
        setMessages((current) => [...older.data.messages, ...current]);
        setCursor(older.data.older_cursor);
        setLoading(false);
        return;
      case "error":
        setFailure(older.message);
        setLoading(false);
        return;
      case "notFound":
        setFailure("メッセージを読み込めませんでした");
        setLoading(false);
        return;
      case "redirecting":
        // The move to the login page has started; the button stays disabled.
        return;
    }
  }

  return (
    <>
      {cursor !== null && (
        <div className="actions list-more">
          <button type="button" onClick={() => void loadOlder()} disabled={loading}>
            {loading ? "読み込み中…" : "以前のメッセージを読み込む"}
          </button>
          {failure !== null && <p role="alert">{failure}</p>}
        </div>
      )}
      {messages.length === 0 ? (
        <p className="notice">メッセージはまだありません。</p>
      ) : (
        <ol className="chat" aria-label="メッセージ">
          {messages.map((message) => (
            <ChatMessage key={message.event_id} message={message} />
          ))}
        </ol>
      )}
    </>
  );
}

// The text is rendered as text (React escapes it), with its line breaks kept by CSS.
function ChatMessage({ message }: { message: ConversationMessage }) {
  return (
    <li className={message.is_user ? "chat-message chat-message-user" : "chat-message"}>
      <span className="chat-head">
        <span className="chat-sender">
          {message.sender}
          {message.is_user && <span className="chat-sender-kind">（あなた）</span>}
        </span>
        <time dateTime={new Date(message.created_at).toISOString()}>{formatDateTime(message.created_at)}</time>
      </span>
      <span className="chat-text">{message.text}</span>
    </li>
  );
}

function MessageForm({
  client,
  conversationId,
  onDone,
}: {
  client: ApiClient;
  conversationId: string;
  onDone: (message: string | null) => void;
}) {
  const [text, setText] = useState("");
  // Kept while the text stays the same, so that sending again after a failure adds one message.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    const result = await postConversationMessage(client, conversationId, { text, idempotency_key: idempotencyKey });
    switch (result.kind) {
      case "ok":
        onDone(null);
        return;
      case "notFound":
        onDone(CONVERSATION_GONE_MESSAGE);
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
        return;
    }
  }

  return (
    <form className="folder-form chat-form" aria-label="メッセージを送る" onSubmit={(event) => void onSubmit(event)}>
      <label>
        メッセージ（すべての AI に届きます）
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setIdempotencyKey(newIdempotencyKey());
          }}
          rows={4}
          required
          disabled={sending}
        />
      </label>
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          送信
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

function ParticipantList({ conversation }: { conversation: ConversationDetail }) {
  return (
    <ul className="list subscriptions">
      {conversation.participants.map((participant) => {
        const active = participant.destination?.status === "active";
        const bot = participant.bot;
        return (
          <li key={participant.name} className="subscription">
            <span className="delivery-head">
              <span className="delivery-host">{participant.name}</span>
              {bot?.deleted === true && <span className="badge badge-off">削除済み</span>}
              <span className={active ? "badge" : "badge badge-off"}>
                通知先: {participantDestinationStatus(participant)}
              </span>
            </span>
            {bot !== null && bot.name !== participant.name && (
              <span className="delivery-conditions">Bot: {bot.name}</span>
            )}
            {bot === null && <span className="delivery-conditions">以前の参加者（Bot ではありません）</span>}
            <span className="delivery-conditions">
              MCP 接続: {participant.connection_client_name ?? "なし"}
            </span>
            <span className="delivery-conditions">通知先: {participantDestinationLabel(participant)}</span>
          </li>
        );
      })}
    </ul>
  );
}
