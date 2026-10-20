import { Button, Form, Input, Markdown, bindAction } from 'larklet/card';
import { formValue, getCardState, notFound, redirect, setCardState, toast } from 'larklet';

import type { AppState } from '../../state.js';
import { findTicket } from '../../tickets.js';

export const aliases = ['工单'];

export default function TicketPage({ params }: { params: { id: string } }) {
  const ticket = findTicket(params.id);
  if (!ticket) notFound();
  const comment = getCardState<AppState>()?.comments?.[ticket.id] ?? '';
  return (
    <>
      <Markdown content={`**${ticket.title}**\n${ticket.owner} · ${ticket.amount}\n当前备注：${comment || '无'}`} />
      <Form name="comment_form">
        <Input name="comment" placeholder="备注" defaultValue={comment} />
        <Button name="save" type="primary" submit action={bindAction(saveComment, ticket.id)}>
          保存并返回
        </Button>
      </Form>
    </>
  );
}

export async function saveComment(id: string) {
  'use server';
  const form = formValue<{ comment?: string }>();
  const prev = getCardState<AppState>() ?? {};
  setCardState({
    ...prev,
    comments: { ...prev.comments, [id]: String(form.comment ?? '') },
  });
  toast('备注已写进这张卡片', 'success');
  redirect('/');
}
