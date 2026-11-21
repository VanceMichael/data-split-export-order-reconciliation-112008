import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createReviewApp } from '../src/server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(context) {
  const source = createSource();
  const sourceBase = await listen(source);
  const app = createReviewApp({ sourceBase, accounts: ['west', 'south'] });
  const appBase = await listen(app.server);
  context.after(() => {
    source.close();
    app.server.close();
  });
  const get = async (path) => (await fetch(`${appBase}${path}`)).json();
  const step = async (name) => {
    await (await fetch(`${sourceBase}/_source_clock?step=${name}`, { method: 'PUT' })).json();
    return (await fetch(`${appBase}/collect`, { method: 'POST' })).json();
  };
  return { get, step, source, appBase };
}

test('演练全流程：采集、估值、退款、签收核定与更正重出', async (context) => {
  const { get, step } = await setup(context);

  // sale：封箱锁定金额依据，套件跨箱合计等于成交金额，行号按店铺隔离。
  let collection = await step('sale');
  assert.equal(collection.complete, true);
  const b1 = await get('/boxes/B1-0');
  assert.equal(b1.shippable, true);
  assert.deepEqual(b1.values, { USD: 667 });
  assert.equal(b1.deals[0].kit, 'LOCK');
  assert.equal(b1.deals[0].version, '3');
  assert.equal(b1.deals[0].allocation, 'A:west/O32/1@v3:BODY+KEY+PLATE');
  const b2 = await get('/boxes/B2-0');
  assert.deepEqual(b2.values, { USD: 333 });
  assert.equal(b1.values.USD + b2.values.USD, 1000, '套件跨箱的分币合计不得改变成交金额');
  assert.deepEqual((await get('/boxes/B3-0')).values, { USD: 820 });
  const b4 = await get('/boxes/B4-0');
  assert.deepEqual(b4.values, { EUR: 2200 });
  assert.equal(b4.deals[0].account, 'south', '两个店铺都有 O32 的 1 行，不能串');
  assert.deepEqual((await get('/orders/west/O32')).unpacked, []);

  // boxed：空页标记 ≠ 清空，旧装箱事实保留，不当作零件不存在。
  collection = await step('boxed');
  assert.equal(collection.complete, false);
  assert.ok(collection.pages.some((page) => page.outcome === 'blank'));
  const b3Stale = await get('/boxes/B3-0');
  assert.equal(b3Stale.lifecycle, 'active');
  assert.equal(b3Stale.stale, true);
  assert.deepEqual(b3Stale.values, { USD: 820 });
  assert.equal(b3Stale.shippable, false);
  assert.ok(b3Stale.reasons.join('；').includes('旧装箱事实'));
  assert.deepEqual((await get('/boxes/B4-0')).values, { EUR: 2200 });
  assert.deepEqual((await get('/orders/west/O32')).unpacked, [], '缺页时旧事实保留，不能报缺装');

  // split：旧装箱事实按封箱实例保留，新箱有自己的迹线和标签。
  await step('split');
  const b1Split = await get('/boxes/B1-0');
  assert.equal(b1Split.lifecycle, 'superseded');
  assert.deepEqual(b1Split.values, { USD: 667 }, '被拆分的旧箱保留旧装箱事实');
  assert.ok(b1Split.trace.some((op) => op.operation === 'split' && op.as === 'parent'));
  const b11 = await get('/boxes/B1-1');
  assert.equal(b11.shippable, true);
  assert.deepEqual(b11.values, { USD: 334 });
  assert.equal(b11.tag, 'KA6');
  assert.ok(b11.trace.some((op) => op.operation === 'split' && op.from.includes('B1-0')));
  const b5 = await get('/boxes/B5-0');
  assert.deepEqual(b5.values, { USD: 333 });
  assert.equal(b5.tag, 'KA7');

  // partial-refund：指明的退款重新核价未交运箱；归属不唯一的挂起，独立箱不受影响。
  await step('partial-refund');
  const b5r = await get('/boxes/B5-0');
  assert.deepEqual(b5r.values, { USD: 208 });
  assert.equal(b5r.sheetVersion, 2);
  assert.equal(b5r.refunds.applied[0].refund, 'R1');
  assert.equal(b5r.refunds.applied[0].delta, -125);
  const b1r = await get('/boxes/B1-1');
  assert.equal(b1r.shippable, false);
  assert.deepEqual(b1r.refunds.suspended, ['R2']);
  assert.ok(b1r.reasons.join('；').includes('挂起'));
  assert.deepEqual((await get('/boxes/B2-0')).refunds.suspended, ['R2']);
  assert.equal((await get('/boxes/B3-0')).shippable, true, '独立箱保留可复核');
  assert.equal((await get('/boxes/B4-0')).shippable, true);
  const refunds = await get('/refunds');
  assert.equal(refunds.find((r) => r.refund === 'R1').resolution.type, 'reprice');
  assert.equal(refunds.find((r) => r.refund === 'R1').resolution.pack, 'B5-0');
  assert.equal(refunds.find((r) => r.refund === 'R2').resolution.type, 'suspended');

  // late-proof：晚到的旧签收核定出 B1-0 已交运；重贴箱不继承已接收状态。
  await step('late-proof');
  const b1Shipped = await get('/boxes/B1-0');
  assert.equal(b1Shipped.lifecycle, 'shipped');
  assert.equal(b1Shipped.shipment.receipt, 'H9');
  assert.deepEqual(b1Shipped.values, { USD: 667 }, '已交运箱保留旧复核单');
  assert.equal(b1Shipped.refunds.differences[0].refund, 'R1');
  assert.equal(b1Shipped.refunds.differences[0].delta, -125);
  assert.equal(b1Shipped.refunds.differences[0].originalPack, 'B1-0');
  assert.equal(b1Shipped.refunds.differences[0].currentPack, 'B5-0');
  const b5Late = await get('/boxes/B5-0');
  assert.equal(b5Late.goodsShippedWith, 'B1-0');
  assert.equal(b5Late.shipment, null, '重贴之后不自动继承原箱已接收状态');
  assert.equal(b5Late.handovers.find((h) => h.receipt === 'H10').status, 'rejected');
  assert.equal(b5Late.sheetVersion, 2, '实物已随原箱出运后不再出新复核单');
  assert.deepEqual(b5Late.values, { USD: 208 });
  assert.equal((await get('/boxes/B1-1')).goodsShippedWith, 'B1-0');
  const refundsLate = await get('/refunds');
  assert.equal(refundsLate.find((r) => r.refund === 'R1').resolution.type, 'difference');
  assert.equal(refundsLate.find((r) => r.refund === 'R1').resolution.pack, 'B1-0');

  // replacement：订单更正认可替换件，未交运箱重出；显式清空 ≠ 缺页。
  await step('replacement');
  const b2n = await get('/boxes/B2-0');
  assert.equal(b2n.contents[0].sku, 'PLATE-2');
  assert.equal(b2n.contents[0].change, 'C7');
  assert.equal(b2n.contents[0].replacedFrom, 'PLATE');
  assert.equal(b2n.sheetVersion, 2);
  assert.ok(b2n.currentSheet.reason.includes('C7'));
  assert.deepEqual(b2n.values, { USD: 333 });
  const b3n = await get('/boxes/B3-0');
  assert.equal(b3n.lifecycle, 'cleared');
  assert.equal(b3n.shippable, false);
  assert.deepEqual(b3n.values, { USD: 820 }, '清空撤箱后旧事实仍可回查');
  assert.equal((await get('/boxes/B4-0')).shippable, true);
  const unpacked = (await get('/orders/west/O32')).unpacked;
  assert.equal(unpacked.length, 1);
  assert.equal(unpacked[0].sku, 'HOOK');
  assert.ok(unpacked[0].status.includes('清空撤箱'));

  // 历史复核单：能解释为什么和当前金额不同。
  const history = (await get('/boxes/B5-0/history')).sheets;
  assert.equal(history.length, 2);
  assert.equal(history[0].reason, '封箱锁定金额依据');
  assert.ok(history[1].reason.includes('退款 R1'));
  assert.deepEqual(history[1].deltaVsPrevious, { USD: -125 });
  const b2History = (await get('/boxes/B2-0/history')).sheets;
  assert.equal(b2History.length, 2);
  assert.deepEqual(b2History[1].deltaVsPrevious, {}, '更正只换件不改金额');
  assert.equal(b2History[1].lines[0].sku, 'PLATE-2');
});

test('首次采集遇到空页：待核实的零件不能当作不存在', async (context) => {
  const { get, step } = await setup(context);
  const collection = await step('boxed');
  assert.equal(collection.complete, false);
  const b3 = await get('/boxes/B3-0');
  assert.equal(b3.lifecycle, 'active');
  assert.equal(b3.missing, false);
  assert.equal(b3.shippable, false);
  assert.ok(b3.reasons.join('；').includes('无装箱事实'));
  const order = await get('/orders/west/O32');
  const hook = order.unpacked.find((entry) => entry.sku === 'HOOK');
  assert.ok(hook, '缺页时未见装箱的品件要列出');
  assert.ok(hook.status.includes('待核实'), '采集不完整只能标待核实，不能报缺装');
});

test('来源不可达：采集不完整，旧事实保留', async (context) => {
  const { get, step, source, appBase } = await setup(context);
  await step('sale');
  assert.equal((await get('/boxes/B4-0')).shippable, true);
  source.close();
  source.closeAllConnections();
  const collection = await (await fetch(`${appBase}/collect`, { method: 'POST' })).json();
  assert.equal(collection.complete, false);
  const b4 = await get('/boxes/B4-0');
  assert.equal(b4.stale, true);
  assert.deepEqual(b4.values, { EUR: 2200 });
  assert.equal(b4.shippable, false);
});
