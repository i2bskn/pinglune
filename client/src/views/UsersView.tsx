import { type FormEvent, useState } from "react";
import type { User } from "../../../src/api/types";
import {
  type UserActionResult,
  changeUserRole,
  createUser,
  deleteUser,
  resetUserPassword,
  revokeUserSessions,
} from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { type ApiClient, type UsersData, loadUsersView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";

type Role = User["role"];
type AuthMode = UsersData["authMode"];
type Operation = "role" | "password" | "logout" | "delete";

const ROLE_LABELS: Record<Role, string> = { admin: "管理者", member: "一般" };
const GONE_MESSAGE = "このユーザーは見つかりません。削除された可能性があります";
const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";

// The screen for admins to manage users. The server checks the role again; a member who opens the URL
// sees its 403 message. currentUserId is the signed-in user, who cannot delete or sign out themselves here.
export function UsersView({ client, currentUserId }: { client: ApiClient; currentUserId: string }) {
  const [state, reload] = useView(() => loadUsersView(client), "users");
  // The result of the last operation, shown above the list until the next one. It stays across the reload
  // that follows, which may remove the row the operation was opened from.
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(viewTitle(state, () => "ユーザー管理"));

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const { users, authMode } = state.data;

  return (
    <main className="main">
      <h1>ユーザー管理</h1>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {authMode === "password" && (
        <CreateUserForm
          client={client}
          onCreated={() => {
            setNotice(null);
            reload();
          }}
        />
      )}
      <ul className="users">
        {users.map((user) => (
          <UserRow
            key={user.id}
            client={client}
            user={user}
            authMode={authMode}
            isCurrentUser={user.id === currentUserId}
            isLastAdmin={user.role === "admin" && users.filter((other) => other.role === "admin").length === 1}
            onNotice={setNotice}
            onReload={reload}
          />
        ))}
      </ul>
    </main>
  );
}

function CreateUserForm({ client, onCreated }: { client: ApiClient; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");

  function openForm() {
    setOpen(true);
    setFailure(null);
    setEmail("");
    setName("");
    setPassword("");
    setRole("member");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    // A blank name is sent as null; the server also treats it as no name.
    const result = await createUser(client, { email, name: name.trim() === "" ? null : name, password, role });
    switch (result.kind) {
      case "ok":
        setSending(false);
        setOpen(false);
        onCreated();
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

  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="button-primary" onClick={openForm}>
          <PlusIcon />
          ユーザーを追加
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="ユーザーを追加" onSubmit={(event) => void onSubmit(event)}>
      <label>
        メールアドレス
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="off"
          required
          disabled={sending}
        />
      </label>
      <label>
        名前（省略可）
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} disabled={sending} />
      </label>
      <label>
        パスワード（12&nbsp;文字以上）
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          disabled={sending}
        />
      </label>
      <label>
        ロール
        <select value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={sending}>
          <option value="member">{ROLE_LABELS.member}</option>
          <option value="admin">{ROLE_LABELS.admin}</option>
        </select>
      </label>
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          追加
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

// One user with the operations on them. One operation is open at a time.
function UserRow({
  client,
  user,
  authMode,
  isCurrentUser,
  isLastAdmin,
  onNotice,
  onReload,
}: {
  client: ApiClient;
  user: User;
  authMode: AuthMode;
  isCurrentUser: boolean;
  // The server refuses to make the last admin a member, so the button is not shown for them.
  isLastAdmin: boolean;
  onNotice: (notice: string | null) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<Operation | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const newRole: Role = user.role === "admin" ? "member" : "admin";
  // Resetting another user's password is for password mode only; the current user changes their own
  // password elsewhere.
  const operations: Operation[] = [
    ...(isLastAdmin ? [] : (["role"] as const)),
    ...(authMode === "password" && !isCurrentUser ? (["password"] as const) : []),
    ...(isCurrentUser ? [] : (["logout", "delete"] as const)),
  ];

  function openOperation(operation: Operation) {
    setOpen(operation);
    setFailure(null);
    setPassword("");
    setConfirmation("");
  }

  async function run(operation: Operation, call: () => Promise<UserActionResult>) {
    setSending(true);
    setFailure(null);
    onNotice(null);
    const result = await call();
    switch (result.kind) {
      case "ok":
        // The screen is for admins only and the signed-in user is loaded once, so start again from the top.
        if (operation === "role" && isCurrentUser && newRole === "member") {
          location.assign("/");
          return;
        }
        setSending(false);
        setOpen(null);
        onNotice(SUCCESS_MESSAGES[operation]?.(userLabel(user)) ?? null);
        onReload();
        return;
      case "notFound":
        setSending(false);
        setOpen(null);
        onNotice(GONE_MESSAGE);
        onReload();
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

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    switch (open) {
      case "role":
        void run("role", () => changeUserRole(client, user.id, newRole));
        return;
      case "password":
        void run("password", () => resetUserPassword(client, user.id, password));
        return;
      case "logout":
        void run("logout", () => revokeUserSessions(client, user.id));
        return;
      case "delete":
        if (confirmation !== user.email) return;
        void run("delete", () => deleteUser(client, user.id));
        return;
      case null:
        return;
    }
  }

  const operationLabel = (operation: Operation) =>
    operation === "role" ? (newRole === "admin" ? "管理者にする" : "一般に戻す") : OPERATION_LABELS[operation];

  return (
    <li>
      <div className="user-head">
        <span className="user-name">
          {user.name ?? <span className="user-unnamed">名前未設定</span>}
          {isCurrentUser && "（自分）"}
        </span>
        <span className="user-role">{ROLE_LABELS[user.role]}</span>
      </div>
      <div className="user-detail">
        <span>{user.email}</span>
        <time dateTime={new Date(user.created_at).toISOString()}>作成: {formatDateTime(user.created_at)}</time>
        {user.last_login_at === null ? (
          <span>最終ログイン: 未ログイン</span>
        ) : (
          <time dateTime={new Date(user.last_login_at).toISOString()}>
            最終ログイン: {formatDateTime(user.last_login_at)}
          </time>
        )}
      </div>
      <div className="actions">
        {operations.map((operation) => (
          <button
            key={operation}
            type="button"
            // Deleting cannot be undone: it is set apart from the other operations.
            className={operation === "delete" ? "button-danger-outline" : undefined}
            onClick={() => openOperation(operation)}
            disabled={sending}
          >
            {operationLabel(operation)}
          </button>
        ))}
      </div>
      {open !== null && (
        <form className="folder-form" aria-label={operationLabel(open)} onSubmit={onSubmit}>
          {open === "role" && (
            <p>
              {newRole === "admin"
                ? `${userLabel(user)} を管理者にします。`
                : `${userLabel(user)} を一般に戻します。最後の管理者は戻せません。`}
              {isCurrentUser && newRole === "member" && "自分を一般に戻すと、この画面は使えなくなります。"}
            </p>
          )}
          {open === "password" && (
            <>
              <label>
                新しいパスワード（12&nbsp;文字以上）
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={sending}
                />
              </label>
              <p>このユーザーはすべての端末でログアウトし、MCP&nbsp;の接続も切れます。登録したWebhook配信先も止まります。</p>
            </>
          )}
          {open === "logout" && (
            <p>このユーザーをすべての端末でログアウトさせます。MCP&nbsp;の接続も切れ、登録したWebhook配信先も止まります。</p>
          )}
          {open === "delete" && (
            <>
              <p>
                {userLabel(user)} と、その個人ワークスペースのデータを削除します。元に戻せません。
              </p>
              {authMode === "oidc" && (
                <p>
                  IdP でこの人のログインを止めるか、ALLOWED_EMAILS
                  から外さない限り、この人は再びログインでき、新しいユーザーとして作られます。
                </p>
              )}
              <label>
                確認のため、このユーザーのメールアドレスを入力してください
                <input
                  type="text"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  disabled={sending}
                />
              </label>
            </>
          )}
          <div className="folder-form-actions">
            <button
              type="submit"
              className={open === "delete" ? "button-danger" : undefined}
              disabled={sending || (open === "delete" && confirmation !== user.email)}
            >
              {SUBMIT_LABELS[open]}
            </button>
            <button type="button" onClick={() => setOpen(null)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
    </li>
  );
}

function userLabel(user: User): string {
  return user.name === null ? user.email : `${user.name}（${user.email}）`;
}

const OPERATION_LABELS: Record<Exclude<Operation, "role">, string> = {
  password: "パスワードを再設定",
  logout: "ログアウトさせる",
  delete: "削除",
};

const SUBMIT_LABELS: Record<Operation, string> = {
  role: "変更",
  password: "再設定",
  logout: "ログアウトさせる",
  delete: "削除",
};

// The notice after an operation whose result does not show in the list.
const SUCCESS_MESSAGES: Partial<Record<Operation, (label: string) => string>> = {
  password: (label) => `${label} のパスワードを再設定しました`,
  logout: (label) => `${label} をログアウトさせました`,
  delete: (label) => `${label} を削除しました`,
};
