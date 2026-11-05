import { sceneFromPath } from 'larklet-web/react';

import { MessagePage } from './MessagePage';
import { PlusPage } from './PlusPage';

/**
 * 两个场景就是两个页面：
 *
 * - `/message` 消息快捷操作
 * - `/plus` 聊天框加号菜单
 *
 * 飞书后台给两个场景配这两个路径，客户端会按路径打开。
 */
export function App() {
  const scene = sceneFromPath(window.location.pathname);
  if (scene === 'message') return <MessagePage />;
  if (scene === 'plus') return <PlusPage />;
  return (
    <main className="page">
      <h1>配套网页</h1>
      <p className="muted">飞书里从消息的「…」菜单进入 /message，或从聊天框的「+」菜单进入 /plus。</p>
      <p className="muted">
        开发时可以直接打开 <a href="/message">/message</a> 或 <a href="/plus">/plus</a>。
      </p>
    </main>
  );
}
