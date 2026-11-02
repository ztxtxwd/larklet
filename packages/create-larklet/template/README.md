# __APP_NAME__

Larklet 机器人（`apps/bot`）和配套网页（`apps/web`）。网页从飞书消息的快捷应用打开，用飞书当前用户身份，把来源卡片发到机器人所在的会话。

```bash
pnpm install
cp .env.example .env
pnpm dev       # 机器人预览 http://127.0.0.1:8787
pnpm dev:web   # 配套网页 http://127.0.0.1:5173
```

网页使用 Semi Design 的飞书 Universe Design 主题。飞书后台把「消息快捷操作」的网页地址指到部署后的 web。应用需要能读取消息、以应用身份发消息，以及让用户授权 `im:message` 与 `im:message.send_as_user`。H5 可信域名要覆盖网页地址。

## 对话 Agent

`create-larklet <目录> --agent` 会一并生成 `apps/bot/app/agent.ts`。有了它，用户发来没命中任何路由的消息时机器人会回话：私聊直接回，群里 @ 机器人才回；斜杠命令和机器人菜单仍然走卡片路由。

模型走 OpenAI 兼容接口，在 `.env` 里配 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。开放平台要订阅 `im.message.receive_v1`，并开通读单聊消息、读群内 @ 消息、以应用身份发消息、读历史消息这几项权限。

对话 Agent 随 larklet 的新版本提供。npm 上还没有这个版本之前，把 `apps/bot/package.json` 里的 `larklet` 指向本地构建，否则 `pnpm typecheck` 会因为 `defineAgent` 找不到而报错。
