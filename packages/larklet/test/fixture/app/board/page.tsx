import { Button, Markdown } from '@open-feishu-card/components';

import { messageContext, sendCard, toast, updateCard } from '../../../../src/index.js';

export default function Board() {
  return (
    <>
      <Markdown content="棋盘" />
      <Button action={publish}>发到群里</Button>
      <Button action={refreshHere}>刷新这张</Button>
      <Button action={refreshOther}>刷新另一张</Button>
    </>
  );
}

export async function publish() {
  'use server';
  const { messageId } = await sendCard('/board/note', { userState: { label: '新的一局' } });
  toast(messageId ?? '未发出', 'success');
}

export async function refreshHere() {
  'use server';
  const id = messageContext().openMessageId ?? '';
  await updateCard(id, '/board/note', { userState: { label: '当前这张' } });
  toast('已刷新', 'info');
}

export async function refreshOther() {
  'use server';
  await updateCard('om_other', '/board/note', { userState: { label: '另一张' } });
  toast('已刷新另一张', 'info');
}
