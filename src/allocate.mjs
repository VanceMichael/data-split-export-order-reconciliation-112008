// 按套件清单的整数权重把最小单位金额分配到品件。
// 口径：先舍去不足一分的余数，再按未舍位的余数从大到小分配，
// 仍相同则按套件清单里的品件顺序。分配前后总额不变。
export function allocateMinor(totalMinor, parts) {
  if (!Number.isInteger(totalMinor)) throw new Error('金额必须是币种最小单位的整数');
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('套件清单为空，无法分配');
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  if (!(totalWeight > 0)) throw new Error('套件权重必须为正数');
  const rows = parts.map((part, index) => {
    const numerator = totalMinor * part.weight;
    const base = Math.floor(numerator / totalWeight);
    return { index, sku: part.sku, base, remainder: numerator - base * totalWeight };
  });
  let rest = totalMinor - rows.reduce((sum, row) => sum + row.base, 0);
  const order = [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const row of order) {
    if (rest <= 0) break;
    rows[row.index].base += 1;
    rest -= 1;
  }
  return rows.map((row) => ({ sku: row.sku, minorAmount: row.base }));
}
