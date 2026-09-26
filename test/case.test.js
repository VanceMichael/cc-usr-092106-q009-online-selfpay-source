import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFiling } from '../src/filing.js';
import { parseLedger } from '../src/fulfillment.js';
import { parseCase, checkCaseRules, buildCaseTrace } from '../src/case.js';

const load = async () => {
  const [filingRaw, ledgerRaw, caseRaw] = await Promise.all([
    readFile(new URL('../fixtures/source-filing.json', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/fulfillment-ledger.json', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/review-case.json', import.meta.url), 'utf8')
  ]);
  return {
    filing: parseFiling(filingRaw),
    ledger: parseLedger(ledgerRaw),
    caseRecord: parseCase(caseRaw)
  };
};

const clone = (value) => structuredClone(value);

test('样例案卷通过全部规则检查', async () => {
  const { caseRecord, ledger } = await load();
  assert.deepEqual(checkCaseRules(caseRecord, ledger), []);
});

test('无具体证据的下架决定必须被拒绝', async () => {
  const { caseRecord, ledger } = await load();
  const mutated = clone(caseRecord);
  mutated.dispositions[1].evidence_ids = [];
  const problems = checkCaseRules(mutated, ledger);
  assert.ok(problems.some((p) => p.includes('D-2') && p.includes('证据')));
});

test('下架证据缺少来源或采集时间时不通过', async () => {
  const { caseRecord, ledger } = await load();
  const mutated = clone(caseRecord);
  delete mutated.evidence.items[0].source_ref;
  const problems = checkCaseRules(mutated, ledger);
  assert.ok(problems.some((p) => p.includes('D-2') && p.includes('来源')));
});

test('买家告知扩大到非该批次订单时不通过', async () => {
  const { caseRecord, ledger } = await load();
  const mutated = clone(caseRecord);
  // O-1001 购买的是 B2026-07A，却被塞进 08B 的告知。
  mutated.buyer_notifications[1].order_ids.push('O-1001');
  const problems = checkCaseRules(mutated, ledger);
  assert.ok(problems.some((p) => p.includes('BN-2') && p.includes('O-1001')));
});

test('存在未解决问题时放行重新上架不通过，阻断留痕则通过', async () => {
  const { caseRecord, ledger } = await load();
  const allowed = clone(caseRecord);
  allowed.relist_attempts[0].result = 'allowed';
  delete allowed.relist_attempts[0].blocking_reasons;
  const problems = checkCaseRules(allowed, ledger);
  assert.ok(problems.some((p) => p.includes('RA-1') && p.includes('不应放行')));

  const blocked = clone(caseRecord);
  assert.ok(!checkCaseRules(blocked, ledger).some((p) => p.includes('RA-1')));
});

test('普通审核员查看处置范围外买家信息被拒绝', async () => {
  const { caseRecord, ledger } = await load();
  const mutated = clone(caseRecord);
  // B-ALPHA 对应 O-1001，不在 D-2 处置范围内。
  mutated.access_log[0].buyer_refs_accessed.push('B-ALPHA');
  const problems = checkCaseRules(mutated, ledger);
  assert.ok(problems.some((p) => p.includes('B-ALPHA')));
});

test('案卷范围外的买家信息访问一律拒绝', async () => {
  const { caseRecord, ledger } = await load();
  const mutated = clone(caseRecord);
  mutated.access_log[1].buyer_refs_accessed = ['B-ALPHA'];
  const problems = checkCaseRules(mutated, ledger);
  assert.ok(problems.some((p) => p.includes('案卷范围外')));
});

test('复核不能由普通审核员完成', async () => {
  const { caseRecord, ledger } = await load();
  const mutated = clone(caseRecord);
  mutated.reviews[0].reviewer_role = 'reviewer';
  const problems = checkCaseRules(mutated, ledger);
  assert.ok(problems.some((p) => p.includes('RV-1')));
});

test('追溯链可从下架处置追到版本、批次、订单范围、证据与恢复条件', async () => {
  const { caseRecord } = await load();
  const trace = buildCaseTrace(caseRecord);
  const delist = trace.dispositions.find((d) => d.action === 'delist');
  assert.equal(delist.state, 'active');
  assert.deepEqual(delist.scope.version_ids, ['lv-700123-01']);
  assert.deepEqual(delist.scope.batch_nos.sort(), ['B2026-07A', 'B2026-08B']);
  assert.deepEqual(
    delist.scope.order_ids.sort(),
    ['O-1003', 'O-1004', 'O-1005', 'O-1006']
  );
  assert.equal(delist.evidence.length, 5);
  assert.equal(delist.appeals[0].reviews[0].conclusion, 'adjust');
  assert.equal(trace.open_issues.length, 4);
  assert.ok(trace.recovery_conditions.some((c) => c.condition_id === 'RC-4' && c.satisfied));
  assert.ok(trace.relist_attempts[0].blocking_reasons.length >= 3);
});
