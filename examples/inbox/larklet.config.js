/** @type {import('larklet').LarkletConfig} */
const config = {
  /** 飞书事件与卡片回调走长连接。改成 'webhook' 则使用 POST /webhook。 */
  connection: 'websocket',
};

export default config;
