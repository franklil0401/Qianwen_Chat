import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口号');
const host = process.env.QWEN_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.QWEN_PUBLIC_ORIGIN) throw new Error('监听非本机地址前必须配置 QWEN_PUBLIC_ORIGIN 和 HTTPS 反向代理');
const app = createApp();
const server = app.listen(port, host, () => {
  console.log(`千问服务已启动：http://${host}:${port}`);
  console.log(`模型：${process.env.QWEN_MODEL ?? 'qwen-plus'}；密钥${process.env.Qianwen_api_key ? '已配置' : '未配置'}`);
});
const shutdown = () => { server.close(); server.closeAllConnections(); app.locals.dispose(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
