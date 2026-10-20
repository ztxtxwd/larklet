import { Button, Column, ColumnSet, Hr, Markdown, bindAction } from 'larklet/card';
import { getCardState, redirect, setCardState } from 'larklet';

import { CHANNELS, ROLES, guideStep, type AppState } from './state.js';
import { tickets } from './tickets.js';

export default function InboxPage() {
  const state = getCardState<AppState>();
  const comments = state?.comments ?? {};
  const done = guideStep(state) === 4 && state?.guide?.role && state.guide.channel;
  return (
    <>
      <Markdown
        content={
          done
            ? `指引已完成：${ROLES[state.guide?.role ?? ''] ?? ''} · ${CHANNELS[state.guide?.channel ?? ''] ?? ''}`
            : '第一次用？先走完四步指引，再处理下面的单据。'
        }
      />
      <Button type="primary_text" action={openGuide}>
        {done ? '重看指引' : '开始指引'}
      </Button>
      <Hr />
      {tickets.map((ticket) => (
        <ColumnSet key={ticket.id}>
          <Column width="weighted" weight={3}>
            <Markdown content={`**${ticket.title}** \`${ticket.id}\`\n${ticket.owner} · ${ticket.amount}`} />
          </Column>
          <Column width="weighted" weight={1}>
            <Button type="primary" action={bindAction(openTicket, ticket.id)}>
              {comments[ticket.id] ? '已备注' : '处理'}
            </Button>
          </Column>
        </ColumnSet>
      ))}
    </>
  );
}

export async function openTicket(id: string) {
  'use server';
  redirect(`/ticket/${id}`);
}

export async function openGuide() {
  'use server';
  const prev = getCardState<AppState>() ?? {};
  if (prev.guide?.step === 4) {
    setCardState({ ...prev, guide: { ...prev.guide, step: 1 } });
  }
  redirect('/guide');
}
