// 复核服务的内存状态：采集到的原始事实、复核单历史和最近一次推导结果。
export function createStore() {
  return {
    collections: [], // 每次采集的记录：页码、结果、是否完整
    kits: new Map(), // 'LOCK@3' → 套件销售版本（含各品件整数权重）
    orders: new Map(), // 'west/O32' → { currency, items, refunds, changes, reissues }
    manifest: new Map(), // 封箱实例 → 最新一次可读页上的装箱事实（旧事实保留）
    closeouts: new Map(), // '箱|操作|时间' → 封箱轨迹（拆箱、合箱、重贴、清空）
    handovers: new Map(), // 凭据号 → 货代接收凭据
    sheets: new Map(), // 封箱实例 → 复核单历史（只增不改）
    view: null, // 最近一次采集后推导出的复核视图
  };
}

// 订单接口把订单头、退款、订单更正、补发指示混在一个列表里，按店铺归并。
// 行号只在店铺和订单内有效，键必须带店铺。
export function mergeOrderEntries(store, account, entries) {
  const byOrder = new Map();
  const ensure = (orderId) => {
    if (!byOrder.has(orderId)) {
      byOrder.set(orderId, { account, order: orderId, currency: null, items: [], refunds: [], changes: [], reissues: [] });
    }
    return byOrder.get(orderId);
  };
  for (const entry of entries) {
    const order = ensure(entry.order);
    if (Array.isArray(entry.items)) {
      order.currency = entry.currency ?? order.currency;
      order.items = entry.items;
    } else if (entry.refund) order.refunds.push(entry);
    else if (entry.orderChange) order.changes.push(entry);
    else if (entry.reissue) order.reissues.push(entry);
  }
  for (const key of [...store.orders.keys()]) {
    if (key.startsWith(`${account}/`)) store.orders.delete(key);
  }
  for (const [orderId, order] of byOrder) store.orders.set(`${account}/${orderId}`, order);
}
