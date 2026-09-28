import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口号');
const server = createApp().listen(port, '127.0.0.1', () => {
  console.log(`千问本地服务已启动：http://127.0.0.1:${port}`);
  console.log(`模型：${process.env.QWEN_MODEL ?? 'qwen-plus'}；密钥${process.env.Qianwen_api_key ? '已配置' : '未配置'}`);
});
const shutdown = () => { server.close(); server.closeAllConnections(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
