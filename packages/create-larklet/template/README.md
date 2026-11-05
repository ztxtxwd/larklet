# __APP_NAME__

Larklet 机器人（`apps/bot`）和配套网页（`apps/web`）。网页从飞书消息的快捷操作打开，也从聊天框加号菜单打开；`larklet-web` 负责场景、鉴权、来源消息和当前会话，界面由你写。

```bash
pnpm install
cp .env.example .env
pnpm dev       # 机器人预览 http://127.0.0.1:8787
pnpm dev:web   # 配套网页 http://127.0.0.1:5173
```

`apps/web/src/App.tsx` 按路径分成两个页面，各自用 `useCompanion()`：

- `MessagePage.tsx`：消息快捷操作（`/message`），看当前用户、来源消息和消息类型。
- `PlusPage.tsx`：加号菜单（`/plus`），看当前会话、当前用户和机器人应用，可以把卡片发到当前会话。

```tsx
// App.tsx
import { sceneFromPath } from 'larklet-web/react';

export function App() {
  const scene = sceneFromPath(window.location.pathname);
  if (scene === 'message') return <MessagePage />;
  if (scene === 'plus') return <PlusPage />;
  return <p>从飞书里打开。</p>;
}
```

`useCompanion()` 提供 `scene`、`inFeishu`、`preview`、`user`、`message`、`chat`、`apps`、`sendingHref` 等状态，以及 `authorizeUser()`、`authorizeMessage()`、`requestUserToken()`、`chooseChat()`、`reloadApps()`、`sendApp()`。完整字段见 larklet 的 README。

飞书后台给网页应用开两个场景：「消息快捷操作」和「聊天框『+』菜单」。桌面端的两个场景都要在会话内打开，AppLink 用 `mode=sidebar`；移动端填网页地址。应用需要能读取消息、以应用身份发消息。

权限分两拨，都在**权限管理 → 用户身份权限**里开通，开完要**重新发布应用**：

- 读消息：默认只要 `im:message`。消息快捷操作**先用机器人身份读**，机器人在那个会话里就不用用户授权。机器人不在的群里（机器人必须在这个群组内），只有用户自己读得到，这时框架才让用户授权，还要开 `im:message.group_msg:get_as_user`（群聊）或 `im:message.p2p_msg:get_as_user`（单聊）。
- 以用户身份发消息：才需要 `im:message.send_as_user`。读消息不会申请它 —— 申请了应用没开通的权限，飞书直接报 `20027`，授权整个中断。

H5 可信域名要覆盖网页地址。

**两个场景配不同的路径**，框架按路径认场景：

| 场景 | AppLink |
| --- | --- |
| 消息快捷操作 | `https://applink.feishu.cn/client/web_app/open?appId=<你的 app_id>&mode=sidebar&path=/message` |
| 聊天框「+」菜单 | `https://applink.feishu.cn/client/web_app/open?appId=<你的 app_id>&mode=sidebar&path=/plus` |

飞书客户端会复用同一个侧边栏页面，两个场景都指向同一个路径时（`reload` 默认 `false`），页面会留着上一次的启动参数：从加号菜单打开过，再从消息的「…」菜单进来，还以为是加号菜单。改完场景要**发布新版本**才生效。

要在网页里显示机器人应用目录、发卡片，直接用 hook 给的状态和动作：

```tsx
const { apps, sendApp, sendingHref } = useCompanion();

// apps: [{ href, title, description }]
// await sendApp('/ticket/REQ-42', { as: 'bot', target: 'current' })
```

应用目录来自 `apps/bot/app/catalog.ts`。`apps/web` 的 `createCompanionApp({ cardRenderUrl })`（或环境变量 `LARKLET_CARD_RENDER_URL`）要指向 Larklet 进程的地址，框架才能按应用路径渲染新卡片。

## 对话 Agent

`create-larklet <目录> --agent` 会一并生成 `apps/bot/app/agent.ts`。有了它，用户发来没命中任何路由的消息时机器人会回话：私聊直接回，群里 @ 机器人才回；斜杠命令和机器人菜单仍然走卡片路由。

模型走 OpenAI 兼容接口，在 `.env` 里配 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。开放平台要订阅 `im.message.receive_v1`，并开通读单聊消息、读群内 @ 消息、以应用身份发消息、读历史消息这几项权限。

对话 Agent 随 larklet 的新版本提供。npm 上还没有这个版本之前，把 `apps/bot/package.json` 里的 `larklet` 指向本地构建，否则 `pnpm typecheck` 会因为 `defineAgent` 找不到而报错。
