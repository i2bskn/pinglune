import { type FormEvent, useState } from "react";
import type { CreateUserResponse, Invitation, User } from "../../../src/api/types";
import {
  type InvitationResult,
  type UserActionResult,
  changeUserRole,
  createUser,
  deleteUser,
  reissueInvitation,
  resetUserMfa,
  resetUserPassword,
  revokeUserSessions,
} from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { type ApiClient, type UsersData, loadUsersView, useView } from "../load";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { CopyableId } from "./DeliveriesView";

type Role = User["role"];
type AuthMode = UsersData["authMode"];
type Operation = "role" | "invitation" | "password" | "mfa" | "logout" | "delete";
// How a user is added in password mode: with an invitation link, or with a password set by the admin.
type CreateMethod = "invitation" | "password";
// An invitation link that was just issued, with the user it is for. The server returns the URL only once.
type IssuedInvitation = { userId: string; email: string; invitation: Invitation };

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
  // The invitation link of the last issue, shown until it is closed or replaced. Kept in memory only: the URL lets
  // its holder set the password of the user, so it is never logged, put in the notice or stored.
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  useDocumentTitle(viewTitle(state, () => "ユーザー"));

  const invitationPanel = issued !== null && <InvitationPanel issued={issued} onClose={() => setIssued(null)} />;

  // The panel is shown in every state, also while the list loads again or fails to load: the URL cannot be shown
  // a second time.
  if (state.kind !== "ready") {
    return (
      <>
        {invitationPanel !== false && <div className="invitation-standalone">{invitationPanel}</div>}
        <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />
      </>
    );
  }
  const { users, authMode } = state.data;

  return (
    <main className="main">
      <header className="page-head">
        <h1>ユーザー</h1>
        <p className="lead">この Pinglune にログインできる人です。管理者は、ユーザーの追加と権限の変更ができます。</p>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {invitationPanel}
      <CreateUserForm
        client={client}
        authMode={authMode}
        onCreated={(user) => {
          setNotice(null);
          if (user.invitation !== null) {
            setIssued({ userId: user.id, email: user.email, invitation: user.invitation });
          }
          reload();
        }}
      />
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
            onInvitation={(invitation) => setIssued({ userId: user.id, email: user.email, invitation })}
            // Deleting the user or setting their password makes the link invalid.
            onInvitationInvalidated={() => setIssued((current) => (current?.userId === user.id ? null : current))}
            onReload={reload}
          />
        ))}
      </ul>
    </main>
  );
}

// An invitation link that was just issued: whose it is, the URL to copy and when it expires. It stays until it is
// closed.
function InvitationPanel({ issued, onClose }: { issued: IssuedInvitation; onClose: () => void }) {
  const { email, invitation } = issued;
  return (
    <section className="issued-key invitation" aria-label="招待リンク">
      <p>
        <strong>{email} の招待リンクを発行しました。</strong>
      </p>
      <CopyableId id={invitation.url} failedMessage="コピーできませんでした。リンクを選択してコピーしてください" />
      <p>
        <time dateTime={new Date(invitation.expires_at).toISOString()}>
          有効期限: {formatDateTime(invitation.expires_at)}
        </time>
      </p>
      <p>このリンクは今だけ表示されます。本人に渡してください。使えるのは1回だけです。</p>
      <button type="button" onClick={onClose}>
        閉じる
      </button>
    </section>
  );
}

// Adds a user. In OIDC mode the user is registered by email and can then sign in with the IdP. In password mode the
// admin chooses between an invitation link (the user sets their own password) and a password set here.
function CreateUserForm({
  client,
  authMode,
  onCreated,
}: {
  client: ApiClient;
  authMode: AuthMode;
  onCreated: (user: CreateUserResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [method, setMethod] = useState<CreateMethod>("invitation");
  // A password is sent only when the admin chose to set one, in password mode.
  const withPassword = authMode === "password" && method === "password";

  function openForm() {
    setOpen(true);
    setFailure(null);
    setEmail("");
    setName("");
    setPassword("");
    setRole("member");
    setMethod("invitation");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    // A blank name is sent as null; the server also treats it as no name.
    const result = await createUser(client, {
      email,
      name: name.trim() === "" ? null : name,
      ...(withPassword ? { password } : {}),
      role,
    });
    switch (result.kind) {
      case "ok":
        setSending(false);
        setOpen(false);
        // The password is not needed any more.
        setPassword("");
        onCreated(result.user);
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
      {authMode === "oidc" && <p>登録したメールアドレスの人だけがログインできます。</p>}
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
      {authMode === "password" && (
        <fieldset className="participant-fields" disabled={sending}>
          <legend>追加の方法</legend>
          {CREATE_METHODS.map((value) => (
            <label key={value} className="choice">
              <input
                type="radio"
                name="create_method"
                value={value}
                checked={method === value}
                onChange={() => setMethod(value)}
              />
              <span className="choice-title">{CREATE_METHOD_LABELS[value]}</span>
            </label>
          ))}
        </fieldset>
      )}
      {withPassword && (
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
      )}
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
  onInvitation,
  onInvitationInvalidated,
  onReload,
}: {
  client: ApiClient;
  user: User;
  authMode: AuthMode;
  isCurrentUser: boolean;
  // The server refuses to make the last admin a member, so the button is not shown for them.
  isLastAdmin: boolean;
  onNotice: (notice: string | null) => void;
  // A new invitation link was issued for this user.
  onInvitation: (invitation: Invitation) => void;
  // The invitation link of this user, if one is shown, does not work any more.
  onInvitationInvalidated: () => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<Operation | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const newRole: Role = user.role === "admin" ? "member" : "admin";
  // Reissuing an invitation link, resetting another user's password and resetting their MFA are for password mode
  // only; the current user changes their own password and factors elsewhere. An invited user has no password yet:
  // an admin can still set one, which consumes the invitation. Only a user with a password can have MFA.
  const othersInPasswordMode = authMode === "password" && !isCurrentUser;
  const operations: Operation[] = [
    ...(isLastAdmin ? [] : (["role"] as const)),
    ...(othersInPasswordMode && user.status === "invited" ? (["invitation"] as const) : []),
    ...(othersInPasswordMode ? (["password"] as const) : []),
    ...(othersInPasswordMode && user.status === "active" ? (["mfa"] as const) : []),
    ...(isCurrentUser ? [] : (["logout", "delete"] as const)),
  ];

  function openOperation(operation: Operation) {
    setOpen(operation);
    setFailure(null);
    setPassword("");
    setConfirmation("");
  }

  async function run(operation: Operation, call: () => Promise<UserActionResult | InvitationResult>) {
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
        if ("invitation" in result) onInvitation(result.invitation);
        if (operation === "password" || operation === "delete") onInvitationInvalidated();
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
      case "invitation":
        void run("invitation", () => reissueInvitation(client, user.id));
        return;
      case "password":
        void run("password", () => resetUserPassword(client, user.id, password));
        return;
      case "mfa":
        void run("mfa", () => resetUserMfa(client, user.id));
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
        {user.status === "invited" && <span className="badge">招待中</span>}
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
          {open === "invitation" && <p>新しい招待リンクを発行します。前のリンクは使えなくなります。</p>}
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
              <p>このユーザーはすべての端末でログアウトし、MCP&nbsp;の接続も切れます。登録した Webhook 配信先・ポーリング用キュー・メールの配信先も止まります。</p>
            </>
          )}
          {open === "mfa" && (
            <>
              <p>
                このユーザーのパスキー・認証アプリ・リカバリーコードをすべて削除します。パスワードは変わりません。このユーザーはすべての端末でログアウトし、MCP&nbsp;の接続も切れます。登録した
                Webhook 配信先・ポーリング用キュー・メールの配信先も止まります。
              </p>
              <p>
                リセット後は、パスワードだけで新しい認証方法を登録できます。本人であることを確かめてからリセットし、すぐにログインして登録し直してもらってください。
              </p>
            </>
          )}
          {open === "logout" && (
            <p>このユーザーをすべての端末でログアウトさせます。MCP&nbsp;の接続も切れ、登録した Webhook 配信先・ポーリング用キュー・メールの配信先も止まります。</p>
          )}
          {open === "delete" && (
            <>
              <p>
                {userLabel(user)} と、その個人ワークスペースのデータを削除します。元に戻せません。
              </p>
              {authMode === "oidc" && (
                <p>
                  削除すると、この人はログインできなくなります。もう一度ログインできるようにするには、ユーザーを追加し直してください。
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

const CREATE_METHODS: CreateMethod[] = ["invitation", "password"];

const CREATE_METHOD_LABELS: Record<CreateMethod, string> = {
  invitation: "招待リンクを発行する",
  password: "パスワードを設定する",
};

const OPERATION_LABELS: Record<Exclude<Operation, "role">, string> = {
  invitation: "招待リンクを再発行",
  password: "パスワードを再設定",
  mfa: "多要素認証をリセット",
  logout: "ログアウトさせる",
  delete: "削除",
};

const SUBMIT_LABELS: Record<Operation, string> = {
  role: "変更",
  invitation: "再発行",
  password: "再設定",
  mfa: "リセット",
  logout: "ログアウトさせる",
  delete: "削除",
};

// The notice after an operation whose result does not show in the list.
const SUCCESS_MESSAGES: Partial<Record<Operation, (label: string) => string>> = {
  password: (label) => `${label} のパスワードを再設定しました`,
  mfa: (label) => `${label} の多要素認証をリセットしました`,
  logout: (label) => `${label} をログアウトさせました`,
  delete: (label) => `${label} を削除しました`,
};
