import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocateMinor } from '../src/allocate.mjs';

test('按权重分配：先舍去不足一分，再按余数从大到小，并列按清单顺序', () => {
  const kit = [{ sku: 'BODY', weight: 1 }, { sku: 'KEY', weight: 1 }, { sku: 'PLATE', weight: 1 }];
  assert.deepEqual(allocateMinor(1000, kit), [
    { sku: 'BODY', minorAmount: 334 },
    { sku: 'KEY', minorAmount: 333 },
    { sku: 'PLATE', minorAmount: 333 },
  ]);
  assert.deepEqual(allocateMinor(2200, kit).map((row) => row.minorAmount), [734, 733, 733]);
  assert.deepEqual(allocateMinor(5, kit).map((row) => row.minorAmount), [2, 2, 1]);
  assert.deepEqual(
    allocateMinor(100, [{ sku: 'A', weight: 2 }, { sku: 'B', weight: 1 }, { sku: 'C', weight: 1 }]).map((row) => row.minorAmount),
    [50, 25, 25],
  );
});

test('分币差额不造成总额变化', () => {
  const parts = [{ sku: 'A', weight: 3 }, { sku: 'B', weight: 5 }, { sku: 'C', weight: 8 }, { sku: 'D', weight: 1 }];
  for (const total of [1, 7, 100, 999, 12345, 1000003]) {
    const rows = allocateMinor(total, parts);
    assert.equal(rows.reduce((sum, row) => sum + row.minorAmount, 0), total);
  }
});
