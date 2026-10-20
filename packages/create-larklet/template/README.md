# __APP_NAME__

Larklet 机器人（`apps/bot`）和配套网页（`apps/web`）。网页从飞书消息的快捷应用打开，用飞书当前用户身份，把来源卡片发到机器人所在的会话。

```bash
pnpm install
cp .env.example .env
pnpm dev       # 机器人预览 http://127.0.0.1:8787
pnpm dev:web   # 配套网页 http://127.0.0.1:5173
```

网页使用 Semi Design 的飞书 Universe Design 主题。飞书后台把「消息快捷操作」的网页地址指到部署后的 web。应用需要能读取消息、以应用身份发消息，以及让用户授权 `im:message` 与 `im:message.send_as_user`。H5 可信域名要覆盖网页地址。
