import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseFiling,
  expiredQualifications,
  rangeCapacity,
  checkFilingRules
} from '../src/filing.js';

const loadFiling = async () =>
  parseFiling(await readFile(new URL('../fixtures/source-filing.json', import.meta.url), 'utf8'));

test('样例报备可解析且资质、批次、发货主体齐全', async () => {
  const filing = await loadFiling();
  assert.equal(filing.listing_version.self_pay, true);
  assert.ok(filing.qualifications.length >= 4);
  assert.ok(filing.purchase_batches.length >= 1);
  assert.ok(filing.shipping_entities.length >= 1);
});

test('样例报备本身不存在规则问题', async () => {
  const filing = await loadFiling();
  assert.deepEqual(checkFilingRules(filing), []);
});

test('到期资质可被识别：Q2 在 2026-08-31 后失效', async () => {
  const filing = await loadFiling();
  assert.deepEqual(expiredQualifications(filing, '2026-09-02'), ['Q2']);
  assert.deepEqual(expiredQualifications(filing, '2026-08-31'), []);
});

test('码段容量按区间长度计算', () => {
  assert.equal(rangeCapacity([{ prefix: 'T', range_start: 1, range_end: 100 }]), 100);
  assert.equal(
    rangeCapacity([
      { prefix: 'T', range_start: 1, range_end: 10 },
      { prefix: 'T', range_start: 21, range_end: 30 }
    ]),
    20
  );
});

test('码段容量不足与同前缀码段重叠会被发现', () => {
  const filing = {
    qualifications: [
      { qual_id: 'Q1', issued_at: '2020-01-01', expires_at: '2030-01-01' }
    ],
    purchase_batches: [
      {
        batch_no: 'BX',
        quantity: 100,
        trace_code_ranges: [{ prefix: 'T', range_start: 1, range_end: 50 }]
      },
      {
        batch_no: 'BY',
        quantity: 5,
        trace_code_ranges: [{ prefix: 'T', range_start: 40, range_end: 44 }]
      }
    ]
  };
  const problems = checkFilingRules(filing);
  assert.ok(problems.some((p) => p.includes('容量 50 小于报备采购数量 100')));
  assert.ok(problems.some((p) => p.includes('重叠')));
});
