import { useState } from 'react';
import { useCompanion } from 'larklet-web/react';

import { Button, Row } from './ui';

/** 加号菜单：从聊天框的「+」菜单进入，看当前会话、当前用户与机器人应用。 */
export function PlusPage() {
  const {
    ready,
    inFeishu,
    preview,
    error,
    user,
    chat,
    apps,
    appsLoading,
    appsError,
    sendingHref,
    authorizeUser,
    sendApp,
  } = useCompanion();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  if (!ready) {
    return (
      <main className="page">
        <p className="muted">加载中…</p>
      </main>
    );
  }

  const userLabel = user.name || user.openId || (user.authorized ? '已授权' : '未授权');
  const canSend = inFeishu || preview;

  async function send(href: string, title: string) {
    setFeedback(null);
    const result = await sendApp(href, { as: 'bot', target: 'current' });
    setFeedback({
      ok: result.ok,
      text: result.ok ? `已把「${title}」发到当前会话` : result.error,
    });
  }

  return (
    <main className="page">
      <h1>加号菜单</h1>
      {error ? <p className="error">{error}</p> : null}
      {!inFeishu && !preview ? <p className="muted">请在飞书里从聊天框的「+」菜单进入。</p> : null}

      <section className="card">
        <h2>当前会话</h2>
        <Row label="会话 ID" value={chat.chatId || '—'} sub={chat.error || chat.name} />
        <Row label="当前用户" value={userLabel} sub={user.error} />
        {user.authorized ? null : (
          <Button disabled={!inFeishu || user.authorizing} onClick={() => void authorizeUser()}>
            {user.authorizing ? '授权中…' : '授权后显示用户信息'}
          </Button>
        )}
      </section>

      <section className="card">
        <h2>应用</h2>
        {appsLoading ? <p className="muted">读取中…</p> : null}
        {appsError ? <p className="error">{appsError}</p> : null}
        {!appsLoading && !appsError && apps.length === 0 ? <p className="muted">还没有可发送的应用</p> : null}
        <div className="app-list">
          {apps.map((app) => (
            <div key={app.href} className="app">
              <div className="app-info">
                <span className="app-title">{app.title}</span>
                {app.description ? <span className="app-desc">{app.description}</span> : null}
              </div>
              <Button disabled={!canSend || Boolean(sendingHref)} onClick={() => void send(app.href, app.title)}>
                {sendingHref === app.href ? '发送中…' : '发送'}
              </Button>
            </div>
          ))}
        </div>
        {feedback ? <p className={feedback.ok ? 'ok' : 'error'}>{feedback.text}</p> : null}
      </section>
    </main>
  );
}
