export interface Ticket {
  id: string;
  title: string;
  amount: string;
  owner: string;
}

export const tickets: Ticket[] = [
  { id: 'REQ-42', title: '差旅报销', amount: '¥1,280', owner: '张三' },
  { id: 'REQ-43', title: '服务器续费', amount: '¥6,400', owner: '李四' },
];

export function findTicket(id: string): Ticket | undefined {
  return tickets.find((ticket) => ticket.id === id);
}
