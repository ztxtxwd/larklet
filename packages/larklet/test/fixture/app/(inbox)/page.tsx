import { Button, Markdown } from '@open-feishu-card/components';

import { getCardState, redirect, setCardState, toast } from '../../../../src/index.js';

export default function Home() {
  const count = getCardState<{ n: number }>()?.n ?? 0;
  return (
    <>
      <Markdown content={`计数 ${count}`} />
      <Button action={inc}>加一</Button>
      <Button action={go}>去详情</Button>
    </>
  );
}

export async function inc() {
  'use server';
  const count = getCardState<{ n: number }>()?.n ?? 0;
  setCardState({ n: count + 1 });
  toast('已加一', 'success');
}

export async function go() {
  'use server';
  redirect('/item/42?from=home');
}
