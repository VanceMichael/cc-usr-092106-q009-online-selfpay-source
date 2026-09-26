import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFiling } from '../src/filing.js';
import { parseLedger, evaluateFulfillment, parseTraceCode } from '../src/fulfillment.js';

const load = async () => {
  const [filingRaw, ledgerRaw] = await Promise.all([
    readFile(new URL('../fixtures/source-filing.json', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/fulfillment-ledger.json', import.meta.url), 'utf8')
  ]);
  return {
    filing: parseFiling(filingRaw),
    ledger: parseLedger(ledgerRaw)
  };
};

const findingsOfType = (result, type) => result.findings.filter((f) => f.type === type);

test('追溯码可解析为前缀与序号', () => {
  assert.deepEqual(parseTraceCode('T1001'), { prefix: 'T', seq: 1001 });
  assert.equal(parseTraceCode('无码'), null);
});

test('低价且异地发货的正规授权订单不产生任何信号', async () => {
  const { filing, ledger } = await load();
  const result = evaluateFulfillment(filing, ledger);
  const clean = result.cleanOrderIds;
  // O-1002 由已报备的跨省授权仓 E-02 发货且价格更低，不应被误伤；O-1001 为普通正常订单。
  assert.ok(clean.includes('O-1001'), 'O-1001 应无信号');
  assert.ok(clean.includes('O-1002'), '低价+异地但已报备的 O-1002 不应被误伤');
});

test('发现跨订单重复追溯码', async () => {
  const { filing, ledger } = await load();
  const duplicates = findingsOfType(evaluateFulfillment(filing, ledger), 'duplicate_trace_code');
  const hit = duplicates.find((f) => f.code === 'T1003');
  assert.ok(hit);
  assert.deepEqual(hit.order_ids.sort(), ['O-1003', 'O-1005']);
});

test('发现页面替换', async () => {
  const { filing, ledger } = await load();
  const substitutions = findingsOfType(evaluateFulfillment(filing, ledger), 'listing_substitution');
  assert.deepEqual(substitutions.flatMap((f) => f.order_ids), ['O-1004']);
});

test('发现越界追溯码并区分错批次与无归属', async () => {
  const { filing, ledger } = await load();
  const outOfRange = findingsOfType(evaluateFulfillment(filing, ledger), 'trace_code_out_of_range');
  const t9999 = outOfRange.find((f) => f.code === 'T9999');
  assert.ok(t9999);
  assert.equal(t9999.reason, 'no_filed_range');
  const wrongBatch = outOfRange.find((f) => f.code === 'T1003' && f.reason === 'wrong_batch');
  assert.ok(wrongBatch, 'T1003 出现在锁定 08B 批次的订单上应判定为错批次');
});

test('发现未报备主体异地代发，而已报备的异地仓不算', async () => {
  const { filing, ledger } = await load();
  const unreported = findingsOfType(evaluateFulfillment(filing, ledger), 'unreported_shipping');
  const orderIds = unreported.flatMap((f) => f.order_ids);
  assert.deepEqual(orderIds, ['O-1006']);
  assert.equal(unreported[0].shipping_entity_id, 'E-99');
});
