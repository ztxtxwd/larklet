import { messageTypeLabel, useCompanion } from 'larklet-web/react';

import { Button, Row } from './ui';

/** 消息快捷操作：从消息的「…」菜单进入，看当前用户与来源消息。 */
export function MessagePage() {
  const { ready, inFeishu, preview, error, user, message, authorizeMessage } = useCompanion();

  if (!ready) {
    return (
      <main className="page">
        <p className="muted">加载中…</p>
      </main>
    );
  }

  const userLabel = user.name || user.openId || (user.authorized ? '已授权' : '未授权');

  return (
    <main className="page">
      <h1>消息快捷操作</h1>
      {error ? <p className="error">{error}</p> : null}
      {!inFeishu && !preview ? <p className="muted">请在飞书里从消息的「…」菜单进入。</p> : null}

      <section className="card">
        <Row label="当前用户" value={userLabel} sub={user.error} />
        <Row label="当前消息" value={message.messageId || '—'} />
        <Row
          label="消息类型"
          value={message.msgType ? messageTypeLabel(message.msgType) : message.reading ? '读取中…' : '—'}
          sub={message.error}
        />
        {message.needUserAuth ? (
          <Button disabled={!inFeishu || user.authorizing} onClick={() => void authorizeMessage()}>
            {user.authorizing ? '授权中…' : '授权后读取这条消息'}
          </Button>
        ) : null}
      </section>
    </main>
  );
}
