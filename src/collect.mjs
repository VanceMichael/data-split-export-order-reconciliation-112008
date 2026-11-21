import { derive } from './derive.mjs';
import { mergeOrderEntries } from './store.mjs';

const MAX_PAGES = 50;

// 跑一轮采集：店铺订单与套件版本、仓库装箱分页、封箱轨迹、货代凭据。
// 分页缺片、来源空页标记、明确清空是三种不同结果：
//  - 抓取失败或 blank 空页 → 本轮不完整，保留旧装箱事实，不当作零件不存在；
//  - closeouts 里带 cleared 的显式清空 → 该箱已撤；
//  - 完整采集后某箱没有事实且无轨迹解释 → 标记缺失待核实。
export async function runCollection(store, client, accounts) {
  const id = store.collections.length + 1;
  const at = new Date().toISOString();
  const pages = [];
  const sawPacks = new Set();

  const attempt = async (url, load) => {
    try {
      const value = await load();
      pages.push({ url, outcome: 'ok' });
      return value;
    } catch (error) {
      pages.push({ url, outcome: 'failed', error: String(error?.message ?? error) });
      return undefined;
    }
  };

  const kits = await attempt('/shops/kits', () => client.kits());
  if (Array.isArray(kits)) for (const kit of kits) store.kits.set(`${kit.kit}@${kit.version}`, kit);

  for (const account of accounts) {
    const entries = await attempt(`/shops/orders?account=${account}`, () => client.orders(account));
    if (Array.isArray(entries)) mergeOrderEntries(store, account, entries);
  }

  let url = '/warehouse/manifest?page=1';
  const fresh = new Map();
  const packPage = new Map();
  for (let guard = 0; url && guard < MAX_PAGES; guard += 1) {
    const current = url;
    let page;
    try {
      page = await client.manifest(current);
    } catch (error) {
      pages.push({ url: current, outcome: 'failed', error: String(error?.message ?? error) });
      break;
    }
    if (page?.blank === true) {
      pages.push({ url: current, outcome: 'blank' });
      break;
    }
    pages.push({ url: current, outcome: 'ok' });
    for (const entry of page?.entries ?? []) {
      if (!fresh.has(entry.pack)) fresh.set(entry.pack, []);
      fresh.get(entry.pack).push(entry);
      sawPacks.add(entry.pack);
      packPage.set(entry.pack, current);
    }
    url = page?.next ?? null;
  }
  for (const [pack, contents] of fresh) {
    store.manifest.set(pack, { contents, collectionId: id, page: packPage.get(pack) ?? null });
  }

  const closeouts = await attempt('/warehouse/closeouts', () => client.closeouts());
  if (Array.isArray(closeouts)) {
    for (const op of closeouts) store.closeouts.set(`${op.pack}|${op.operation}|${op.at}`, op);
  }

  const handover = await attempt('/forwarder/handover', () => client.handover());
  if (Array.isArray(handover)) for (const receipt of handover) store.handovers.set(receipt.receipt, receipt);

  const complete = pages.every((page) => page.outcome === 'ok');
  const collection = { id, at, pages, complete, sawPacks };
  store.collections.push(collection);
  derive(store, collection);
  return collection;
}
