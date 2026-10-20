import { Button, Card, Header, Markdown } from '@open-feishu-card/components';
import type { VNodeChild } from '@open-feishu-card/components';

export default function RootLayout({ children }: { children?: VNodeChild }) {
  return (
    <Card config={{ update_multi: true }} headerTheme="blue">
      <Header title="Larklet" />
      {children}
    </Card>
  );
}
