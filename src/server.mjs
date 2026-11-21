import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createClient } from './client.mjs';
import { runCollection } from './collect.mjs';
import { createStore } from './store.mjs';

const send = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};

const summarize = (view) => ({
  pack: view.pack,
  lifecycle: view.lifecycle,
  shippable: view.shippable,
  values: view.values,
  stale: view.stale,
  missing: view.missing,
  suspended: view.refunds.suspended,
  reasons: view.reasons,
});

// 历史复核单：逐版列出原因和与上一版的币种差额，解释为什么和当前金额不同。
const sheetHistory = (sheets) => sheets.map((sheet, index) => {
  const previous = sheets[index - 1];
  const delta = {};
  if (previous) {
    const currencies = new Set([...Object.keys(sheet.totals), ...Object.keys(previous.totals)]);
    for (const currency of currencies) {
      const change = (sheet.totals[currency] ?? 0) - (previous.totals[currency] ?? 0);
      if (change !== 0) delta[currency] = change;
    }
  }
  return { ...sheet, deltaVsPrevious: delta };
});

export function createReviewApp({ sourceBase = 'http://127.0.0.1:4173', accounts = ['west', 'south'] } = {}) {
  const store = createStore();
  const client = createClient(sourceBase);
  const collect = () => runCollection(store, client, accounts);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/health') return send(response, 200, { status: 'ok' });
      if (request.method === 'POST' && path === '/collect') {
        const collection = await collect();
        return send(response, 200, { id: collection.id, at: collection.at, complete: collection.complete, pages: collection.pages, packs: collection.sawPacks.size });
      }
      if (request.method === 'GET' && path === '/collections') {
        return send(response, 200, store.collections.map((c) => ({ id: c.id, at: c.at, complete: c.complete, pages: c.pages, packs: c.sawPacks.size })));
      }
      if (request.method === 'GET' && path === '/boxes') {
        return send(response, 200, store.view ? [...store.view.packs.values()].map(summarize) : []);
      }
      const boxMatch = path.match(/^\/boxes\/([^/]+)(\/history)?$/);
      if (request.method === 'GET' && boxMatch) {
        const pack = decodeURIComponent(boxMatch[1]);
        const view = store.view?.packs.get(pack);
        if (!view) return send(response, 404, { error: `未知封箱 ${pack}` });
        if (boxMatch[2]) return send(response, 200, { pack, sheets: sheetHistory(store.sheets.get(pack) ?? []) });
        return send(response, 200, view);
      }
      if (request.method === 'GET' && path === '/refunds') {
        return send(response, 200, store.view?.refunds ?? []);
      }
      if (request.method === 'GET' && path === '/orders') {
        return send(response, 200, store.view ? [...store.view.orders.values()] : []);
      }
      const orderMatch = path.match(/^\/orders\/([^/]+)\/([^/]+)$/);
      if (request.method === 'GET' && orderMatch) {
        const key = `${decodeURIComponent(orderMatch[1])}/${decodeURIComponent(orderMatch[2])}`;
        const order = store.view?.orders.get(key);
        if (!order) return send(response, 404, { error: `未知订单 ${key}` });
        return send(response, 200, order);
      }
      return send(response, 404, { error: '本地复核服务没有这条路径' });
    } catch (error) {
      return send(response, 500, { error: '本地复核服务出错', detail: String(error?.message ?? error) });
    }
  });

  return { server, store, collect };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.APP_PORT ?? 4174);
  const app = createReviewApp({
    sourceBase: process.env.SOURCE_BASE ?? 'http://127.0.0.1:4173',
    accounts: (process.env.ACCOUNTS ?? 'west,south').split(',').map((account) => account.trim()).filter(Boolean),
  });
  app.server.listen(port, '127.0.0.1', async function () {
    process.stdout.write(`复核服务 http://127.0.0.1:${this.address().port}\n`);
    try {
      await app.collect();
    } catch {
      // 来源未就绪时先启动，稍后 POST /collect 再采集。
    }
  });
}
