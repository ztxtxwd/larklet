import { feishuCredentials, operator } from 'larklet';
import { Card, Header } from 'larklet/card';
import type { VNodeChild } from 'larklet/card';

export default function RootLayout({ children }: { children?: VNodeChild }) {
  const appId = feishuCredentials()?.appId;
  const who = operator();
  const subtitle = who?.name ? `${who.name} · ${who.openId ?? ''}` : (appId ?? '未配置 APP_ID');
  return (
    <Card config={{ update_multi: true }} headerTheme="blue">
      <Header title="审批收件箱" subtitle={subtitle} icon="approval_outlined" />
      {children}
    </Card>
  );
}
