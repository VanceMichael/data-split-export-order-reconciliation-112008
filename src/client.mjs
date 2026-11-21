// 访问合成来源（店铺订单、仓库封箱、货代凭据）的小客户端。
export function createClient(base) {
  const get = async (path) => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`来源 ${path} 返回 ${response.status}`);
    return response.json();
  };
  return {
    kits: () => get('/shops/kits'),
    orders: (account) => get(`/shops/orders?account=${encodeURIComponent(account)}`),
    manifest: (path) => get(path),
    closeouts: () => get('/warehouse/closeouts'),
    handover: () => get('/forwarder/handover'),
  };
}
