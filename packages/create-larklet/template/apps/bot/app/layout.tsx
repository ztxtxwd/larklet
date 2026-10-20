import { Card, Header } from 'larklet/card';
import type { VNodeChild } from 'larklet/card';

export default function RootLayout({ children }: { children?: VNodeChild }) {
  return (
    <Card config={{ update_multi: true }}>
      <Header title="__APP_NAME__" />
      {children}
    </Card>
  );
}
