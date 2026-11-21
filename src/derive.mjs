import { allocateMinor } from './allocate.mjs';

// 行号只在店铺和订单内有效，所有行级键都带店铺和订单。
const lineKeyOf = (account, order, line) => `${account}/${order}/${String(line)}`;

const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 封箱轨迹：seal/split/merge/relabel 产生或更新实例，带 from 的操作让来源箱被取代，
// clear（带 cleared）是显式清空撤箱。每个实例保留自己的标签历史。
function buildNodes(store) {
  const nodes = new Map();
  const ensure = (pack) => {
    if (!nodes.has(pack)) {
      nodes.set(pack, {
        pack,
        ops: [],
        tagEvents: [],
        from: [],
        children: [],
        createdAt: null,
        createdOp: null,
        supersededAt: null,
        clearedAt: null,
        lifecycle: 'active',
      });
    }
    return nodes.get(pack);
  };
  const ops = [...store.closeouts.values()].sort((a, b) => compareText(a.at, b.at));
  for (const op of ops) {
    const node = ensure(op.pack);
    node.ops.push(op);
    if (op.operation === 'clear' || op.cleared === true) {
      node.clearedAt ??= op.at;
      continue;
    }
    if (op.tag) node.tagEvents.push({ tag: op.tag, at: op.at });
    node.createdAt ??= op.at;
    node.createdOp ??= op.operation;
    for (const parent of op.from ?? []) {
      const up = ensure(parent);
      up.supersededAt ??= op.at;
      if (!up.children.includes(op.pack)) up.children.push(op.pack);
      up.ops.push({ ...op, as: 'parent' });
    }
    if (Array.isArray(op.from)) node.from = [...op.from];
  }
  return nodes;
}

function tagAt(node, at) {
  let tag = null;
  for (const event of node.tagEvents) {
    if (event.at <= at) tag = event.tag;
    else break;
  }
  return tag;
}

// 货代凭据核定：accepted 的凭据必须在签收时刻对应一个仍有效的封箱实例，
// 且实物标签与该时刻的标签一致，才算该次封箱交运。重贴、拆分之后的新箱
// 不会自动继承原箱的已接收状态；对不上的凭据留作人工核定。
function resolveHandovers(store, nodes) {
  const shipments = new Map();
  const findings = new Map();
  const receipts = [...store.handovers.values()].sort((a, b) => compareText(a.receivedAt ?? '', b.receivedAt ?? ''));
  for (const receipt of receipts) {
    const base = {
      receipt: receipt.receipt,
      pack: receipt.pack,
      tag: receipt.tag ?? null,
      at: receipt.at ?? null,
      receivedAt: receipt.receivedAt ?? null,
      accepted: receipt.accepted === true,
    };
    if (!base.accepted) {
      push(findings, receipt.pack, { ...base, status: 'rejected', note: receipt.reason ?? '货代未接收' });
      continue;
    }
    const node = nodes.get(receipt.pack);
    if (!node || !node.createdAt) {
      push(findings, receipt.pack, { ...base, status: 'unmatched', note: '无对应封箱轨迹，需人工核定' });
      continue;
    }
    if (shipments.has(receipt.pack)) {
      push(findings, receipt.pack, { ...base, status: 'unmatched', note: '该封箱已有有效签收凭据，重复签收需人工核定' });
      continue;
    }
    const live = node.createdAt <= receipt.at
      && (!node.supersededAt || node.supersededAt > receipt.at)
      && (!node.clearedAt || node.clearedAt > receipt.at);
    const tag = tagAt(node, receipt.at);
    if (live && tag === receipt.tag) {
      shipments.set(receipt.pack, { receipt: receipt.receipt, tag: receipt.tag, at: receipt.at, receivedAt: receipt.receivedAt ?? null });
      push(findings, receipt.pack, { ...base, status: 'accepted', note: '凭据与当时的封箱及标签一致，该次封箱已交运' });
    } else {
      const note = !live
        ? '签收时刻该封箱状态已变更，需人工核定'
        : `凭据标签 ${receipt.tag} 与当时标签 ${tag ?? '无'} 不符，需人工核定`;
      push(findings, receipt.pack, { ...base, status: 'unmatched', note });
    }
  }
  return { shipments, findings };
}

// 已交运的封箱之后才被拆分/重贴时，后续箱的实物视为已随原箱出运。
function resolveGoods(nodes, shipments) {
  const goods = new Map();
  for (const [pack, shipment] of shipments) {
    const node = nodes.get(pack);
    if (!node?.supersededAt || node.supersededAt <= shipment.at) continue;
    const walk = (current) => {
      for (const child of nodes.get(current)?.children ?? []) {
        if (goods.has(child) || shipments.has(child)) continue;
        goods.set(child, pack);
        walk(child);
      }
    };
    walk(pack);
  }
  return goods;
}

// 订单行模型：套件行按销售时的版本取清单权重，订单更正（replaceWith）替换品件并继承权重，
// 补发指示记为订单下的认可。金额按当次品件构成重新分配，分配凭据号随构成变化。
function buildLineModels(store) {
  const models = new Map();
  for (const order of store.orders.values()) {
    for (const item of order.items) {
      const key = lineKeyOf(order.account, order.order, item.line);
      const changes = order.changes.filter((change) => String(change.line) === String(item.line));
      const reissues = order.reissues.filter((entry) => String(entry.line) === String(item.line));
      let parts = null;
      let note = null;
      if (item.kit) {
        const kit = store.kits.get(`${item.kit}@${item.version}`);
        if (!kit) {
          note = `套件 ${item.kit} 版本 ${item.version} 无据`;
        } else {
          parts = kit.parts.map((part) => ({ sku: part.sku, weight: part.weight }));
          for (const change of changes) {
            if (!change.replaceWith) continue;
            const index = parts.findIndex((part) => part.sku === change.sku);
            if (index >= 0) {
              parts[index] = { sku: change.replaceWith, weight: parts[index].weight, replacedFrom: parts[index].sku, change: change.orderChange };
            }
          }
        }
      } else {
        parts = [{ sku: item.sku, weight: 1 }];
      }
      let allocation = null;
      let allocId = null;
      if (parts) {
        allocation = allocateMinor(item.minorAmount, parts);
        allocation.forEach((row, index) => {
          if (parts[index].change) {
            row.replacedFrom = parts[index].replacedFrom;
            row.change = parts[index].change;
          }
        });
        allocId = `A:${key}@${item.kit ? `v${item.version}` : 'sku'}:${parts.map((part) => part.sku).join('+')}`;
      }
      models.set(key, {
        key,
        account: order.account,
        order: order.order,
        line: item.line,
        item,
        currency: order.currency,
        kit: item.kit ?? null,
        version: item.version ?? null,
        allocation,
        allocId,
        changes,
        reissues,
        note,
      });
    }
  }
  return models;
}

// 按装箱事实给每个封箱实例估值：能对应订单行分配的为 ok，
// 补发指示覆盖的为补发件，其余为未获订单认可。
function valueContents(store, lineModels) {
  const valued = new Map();
  for (const [pack, facts] of store.manifest) {
    const lines = facts.contents.map((entry) => {
      const base = { account: entry.account, order: entry.order, line: entry.line, sku: entry.sku };
      const model = lineModels.get(lineKeyOf(entry.account, entry.order, entry.line));
      if (!model) return { ...base, status: '无对应订单行', minorAmount: null, currency: null, allocation: null };
      if (model.note) return { ...base, status: model.note, minorAmount: null, currency: model.currency, allocation: null };
      const row = model.allocation.find((part) => part.sku === entry.sku);
      if (row) {
        return {
          ...base,
          status: 'ok',
          minorAmount: row.minorAmount,
          currency: model.currency,
          allocation: model.allocId,
          kit: model.kit,
          version: model.version,
          replacedFrom: row.replacedFrom ?? null,
          change: row.change ?? null,
        };
      }
      const reissue = model.reissues.find((item) => item.sku === entry.sku);
      if (reissue) {
        return { ...base, status: '补发件', minorAmount: 0, currency: model.currency, allocation: model.allocId, kit: model.kit, version: model.version, reissue: reissue.reissue };
      }
      return { ...base, status: '未获订单认可', minorAmount: null, currency: model.currency, allocation: model.allocId, kit: model.kit, version: model.version };
    });
    valued.set(pack, { lines, collectionId: facts.collectionId, page: facts.page });
  }
  return valued;
}

// 退款归属：按平台指明的行（和品件）找当前持有该行的封箱，再核定实物所在箱。
// 目标不唯一 → 相关货值挂起；已交运 → 保留旧复核单列差额；未交运 → 重新核价。
function resolveRefunds(store, valued, nodes, shipments, goodsMap) {
  const refunds = [];
  for (const order of store.orders.values()) {
    for (const refund of order.refunds) {
      const lineKey = lineKeyOf(order.account, order.order, refund.line);
      const candidates = [];
      for (const [pack, facts] of valued) {
        const lifecycle = nodes.get(pack)?.lifecycle ?? 'untracked';
        if (lifecycle === 'cleared' || lifecycle === 'superseded') continue;
        const hit = facts.lines.some((line) => lineKeyOf(line.account, line.order, line.line) === lineKey
          && (!refund.sku || line.sku === refund.sku));
        if (hit) candidates.push(pack);
      }
      candidates.sort();
      const physical = [...new Set(candidates.map((pack) => goodsMap.get(pack) ?? pack))].sort();
      let resolution;
      if (candidates.length === 0) {
        resolution = { type: 'pending', note: '没有找到对应的装箱，待核实' };
      } else if (physical.length > 1) {
        resolution = {
          type: 'suspended',
          packs: physical,
          involves: candidates,
          note: `退款目标对应多个封箱（${physical.join('、')}），相关货值挂起，待人工审核`,
        };
      } else {
        const target = physical[0];
        const via = candidates.find((pack) => pack !== target && (goodsMap.get(pack) ?? pack) === target) ?? target;
        if (shipments.has(target)) {
          resolution = { type: 'difference', pack: target, via, note: '原箱已交运，保留旧复核单并列出对应差额和原箱' };
        } else {
          resolution = { type: 'reprice', pack: via, note: '受影响箱子尚未交运，重新核价' };
        }
      }
      refunds.push({
        account: order.account,
        order: order.order,
        refund: refund.refund,
        line: refund.line,
        sku: refund.sku ?? null,
        count: refund.count ?? null,
        minorAmount: refund.minorAmount,
        currency: order.currency,
        candidates,
        resolution,
      });
    }
  }
  return refunds;
}

// 复核单只增不改：首次封箱锁定金额依据；之后装箱事实、订单更正或退款
// 让构成或金额变化时出新版，原因写在单上，历史单可回查差异来源。
function maintainSheets(store, pack, lines, boxAdjustments, totals, reason, triggers, collection) {
  const sheets = store.sheets.get(pack) ?? [];
  const fingerprint = (rows) => JSON.stringify(rows.map((row) => [row.sku, row.minorAmount ?? null, row.allocation ?? null]));
  if (sheets.length === 0) {
    sheets.push({ version: 1, collection: collection.id, at: collection.at, reason: '封箱锁定金额依据', triggers: ['seal'], lines, boxAdjustments, totals });
  } else if (fingerprint(sheets.at(-1).lines) !== fingerprint(lines)) {
    sheets.push({ version: sheets.at(-1).version + 1, collection: collection.id, at: collection.at, reason, triggers, lines, boxAdjustments, totals });
  }
  store.sheets.set(pack, sheets);
}

export function derive(store, collection) {
  const nodes = buildNodes(store);
  const { shipments, findings } = resolveHandovers(store, nodes);
  const goodsMap = resolveGoods(nodes, shipments);
  for (const node of nodes.values()) {
    node.lifecycle = shipments.has(node.pack) ? 'shipped'
      : node.clearedAt ? 'cleared'
        : node.supersededAt ? 'superseded'
          : 'active';
  }
  const lineModels = buildLineModels(store);
  const valued = valueContents(store, lineModels);
  const refunds = resolveRefunds(store, valued, nodes, shipments, goodsMap);

  const suspended = new Map();
  const adjustments = new Map();
  const differences = new Map();
  for (const refund of refunds) {
    const resolution = refund.resolution;
    if (resolution.type === 'suspended') {
      for (const pack of new Set([...resolution.packs, ...resolution.involves])) push(suspended, pack, refund.refund);
    } else if (resolution.type === 'reprice') {
      push(adjustments, resolution.pack, { refund: refund.refund, sku: refund.sku, delta: -refund.minorAmount, currency: refund.currency });
    } else if (resolution.type === 'difference') {
      push(differences, resolution.pack, {
        refund: refund.refund,
        delta: -refund.minorAmount,
        currency: refund.currency,
        currentPack: resolution.via,
        originalPack: resolution.pack,
        note: resolution.note,
      });
    }
  }

  // 把重新核价的退款并进各行，算各币种合计；活跃箱维护复核单。
  const finalized = new Map();
  for (const [pack, facts] of valued) {
    const packAdjustments = adjustments.get(pack) ?? [];
    const lines = facts.lines.map((line) => {
      if (line.minorAmount == null) return { ...line, base: null, adjustments: [] };
      const mine = packAdjustments.filter((adjustment) => adjustment.sku === line.sku);
      const delta = mine.reduce((sum, adjustment) => sum + adjustment.delta, 0);
      return { ...line, base: line.minorAmount, adjustments: mine, minorAmount: line.minorAmount + delta };
    });
    const boxAdjustments = packAdjustments.filter((adjustment) => !adjustment.sku);
    const totals = {};
    for (const line of lines) {
      if (line.minorAmount == null || !line.currency) continue;
      totals[line.currency] = (totals[line.currency] ?? 0) + line.minorAmount;
    }
    for (const adjustment of boxAdjustments) {
      totals[adjustment.currency] = (totals[adjustment.currency] ?? 0) + adjustment.delta;
    }
    finalized.set(pack, { lines, totals, boxAdjustments, collectionId: facts.collectionId, page: facts.page });

    const lifecycle = nodes.get(pack)?.lifecycle ?? 'untracked';
    if (lifecycle === 'active' && !goodsMap.has(pack) && lines.length > 0) {
      const changeIds = [...new Set(lines.flatMap((line) => (line.change ? [line.change] : [])))];
      const refundIds = [...new Set(packAdjustments.map((adjustment) => adjustment.refund))];
      const reasons = [];
      if (changeIds.length) reasons.push(`订单更正 ${changeIds.join('、')} 重出`);
      if (refundIds.length) reasons.push(`退款 ${refundIds.join('、')} 重新核价`);
      maintainSheets(
        store,
        pack,
        lines,
        boxAdjustments,
        totals,
        reasons.join('；') || '装箱事实变化，重新核价',
        [...changeIds.map((id) => `change:${id}`), ...refundIds.map((id) => `refund:${id}`)],
        collection,
      );
    }
  }

  // 每箱的复核视图：成交版本、装箱迹线、币种货值、可否交运、待核实事项。
  const packs = new Map();
  const allPacks = new Set([...nodes.keys(), ...finalized.keys(), ...findings.keys()]);
  for (const pack of [...allPacks].sort()) {
    const node = nodes.get(pack) ?? null;
    const fin = finalized.get(pack) ?? null;
    const lifecycle = node?.lifecycle ?? (fin ? 'untracked' : 'unknown');
    const goodsElsewhere = goodsMap.get(pack) ?? null;
    const saw = collection.sawPacks.has(pack);
    const hadFacts = store.manifest.has(pack);
    const explained = Boolean(node?.supersededAt || node?.clearedAt || shipments.has(pack));
    const stale = hadFacts && !saw;
    const missing = stale && collection.complete && !explained;
    const susp = [...new Set(suspended.get(pack) ?? [])];
    const sheets = store.sheets.get(pack) ?? [];
    const display = sheets.length > 0
      ? { lines: sheets.at(-1).lines, totals: sheets.at(-1).totals, boxAdjustments: sheets.at(-1).boxAdjustments ?? [] }
      : { lines: fin?.lines ?? [], totals: fin?.totals ?? {}, boxAdjustments: fin?.boxAdjustments ?? [] };
    const bad = display.lines.filter((line) => line.minorAmount == null);
    const reasons = [];
    if (lifecycle === 'shipped') reasons.push(`该次封箱已于 ${shipments.get(pack).at} 由货代签收交运`);
    if (lifecycle === 'cleared') reasons.push('仓库已显式清空撤箱');
    if (lifecycle === 'superseded') reasons.push(`已拆分为 ${node.children.join('、') || '后续封箱'}，保留旧装箱事实`);
    if (lifecycle === 'untracked') reasons.push('有装箱事实但缺少封箱轨迹');
    if (lifecycle === 'unknown') reasons.push('只有货代凭据提到该箱，无封箱与装箱记录');
    if (goodsElsewhere) reasons.push(`实物已随 ${goodsElsewhere} 出运，重贴标签不继承已接收状态`);
    if (missing) reasons.push('完整采集中没有该箱的装箱事实，待核实');
    else if (stale && !explained) reasons.push('最新采集缺页或来源不可达，当前为旧装箱事实，待补页');
    if (susp.length) reasons.push(`退款 ${susp.join('、')} 归属不唯一，相关货值挂起，待人工审核`);
    if (bad.length) reasons.push(`品件 ${[...new Set(bad.map((line) => line.sku))].join('、')}：${bad[0].status}`);
    if (display.lines.length === 0 && (lifecycle === 'active' || lifecycle === 'untracked')) reasons.push('无装箱事实');
    const deals = [];
    const seen = new Set();
    for (const line of display.lines) {
      if (!line.allocation || seen.has(line.allocation)) continue;
      seen.add(line.allocation);
      deals.push({ account: line.account, order: line.order, line: line.line, kit: line.kit ?? null, version: line.version ?? null, allocation: line.allocation, currency: line.currency ?? null });
    }
    packs.set(pack, {
      pack,
      lifecycle,
      shippable: reasons.length === 0 && display.lines.length > 0,
      reasons,
      tag: node?.tagEvents.at(-1)?.tag ?? null,
      tags: node?.tagEvents ?? [],
      trace: node?.ops ?? [],
      goodsShippedWith: goodsElsewhere,
      shipment: shipments.get(pack) ?? null,
      handovers: findings.get(pack) ?? [],
      contents: display.lines,
      boxAdjustments: display.boxAdjustments,
      values: display.totals,
      deals,
      refunds: {
        applied: (adjustments.get(pack) ?? []).map((adjustment) => ({ refund: adjustment.refund, sku: adjustment.sku ?? null, delta: adjustment.delta, currency: adjustment.currency })),
        suspended: susp,
        differences: differences.get(pack) ?? [],
      },
      stale,
      missing,
      factsCollection: fin?.collectionId ?? null,
      sheetVersion: sheets.at(-1)?.version ?? 0,
      currentSheet: sheets.at(-1) ?? null,
      collection: { id: collection.id, complete: collection.complete },
    });
  }

  // 订单视图：成交版本、当次分配凭据、各品件所在箱、缺装或待核实。
  const orders = new Map();
  for (const order of store.orders.values()) {
    const key = `${order.account}/${order.order}`;
    const holdersOf = (line, sku) => {
      const holders = [];
      for (const [pack, fin] of finalized) {
        const hit = fin.lines.some((entry) => lineKeyOf(entry.account, entry.order, entry.line) === lineKeyOf(order.account, order.order, line) && entry.sku === sku);
        if (hit) holders.push(pack);
      }
      return holders.sort();
    };
    const items = order.items.map((item) => {
      const model = lineModels.get(lineKeyOf(order.account, order.order, item.line));
      return {
        line: item.line,
        kit: item.kit ?? null,
        version: item.version ?? null,
        sku: item.sku ?? null,
        count: item.count ?? null,
        minorAmount: item.minorAmount,
        allocation: model?.allocId ?? null,
        parts: model?.allocation?.map((row) => ({ ...row, packs: holdersOf(item.line, row.sku) })) ?? null,
        note: model?.note ?? null,
      };
    });
    const unpacked = [];
    for (const item of order.items) {
      const model = lineModels.get(lineKeyOf(order.account, order.order, item.line));
      if (!model?.allocation) continue;
      for (const row of model.allocation) {
        const holders = holdersOf(item.line, row.sku);
        const live = holders.filter((pack) => nodes.get(pack)?.lifecycle !== 'cleared');
        if (live.length > 0) continue;
        const status = holders.length > 0 ? '所在箱已清空撤箱，待重新装箱'
          : collection.complete ? '缺装，待处理'
            : '采集不完整，待核实';
        unpacked.push({ line: item.line, sku: row.sku, status, packs: holders });
      }
    }
    orders.set(key, {
      account: order.account,
      order: order.order,
      currency: order.currency,
      items,
      refunds: refunds.filter((refund) => refund.account === order.account && refund.order === order.order),
      changes: order.changes,
      reissues: order.reissues,
      unpacked,
    });
  }

  store.view = { collection: { id: collection.id, at: collection.at, complete: collection.complete }, packs, refunds, orders };
}
