import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseReviewCase,
  validateReviewCase,
  maxAllowedLevel,
  assertActionLevelAllowed,
  assertTakedownEvidence,
  checkOrderAgainstFiling,
  findTraceCodeOverlaps,
  affectedOrderIds,
  assertBuyerNoticeScoped,
  isRelistBlocked,
  reviewerVisibleOrderIds,
  assertReviewerOrderAccess,
  traceAction,
} from '../src/review.js';

async function loadCase() {
  const raw = await readFile(new URL('../fixtures/review-case.json', import.meta.url), 'utf8');
  return parseReviewCase(raw);
}

test('案例资料通过结构校验与全部边界规则', async () => {
  const value = await loadCase();
  assert.equal(validateReviewCase(value), true);
});

test('低价或异地发货等弱信号不得升级处置', async () => {
  const value = await loadCase();
  const weakSignals = value.risk_signals.filter((signal) => signal.listing_version_id === 'lv-1001');
  assert.equal(weakSignals.length, 2);
  assert.equal(maxAllowedLevel(weakSignals), 'observe');
  const action = { action_id: 'act-x', level: 'takedown', signal_ids: weakSignals.map((signal) => signal.signal_id) };
  assert.throws(() => assertActionLevelAllowed(action, weakSignals), /弱信号不得升级处置/);
});

test('下架决定必须说明具体证据', async () => {
  const value = await loadCase();
  const tampered = JSON.parse(JSON.stringify(value));
  tampered.enforcement_actions[0].evidence = [];
  assert.throws(() => validateReviewCase(tampered), /必须说明具体证据/);
  assert.doesNotThrow(() => assertTakedownEvidence(value.enforcement_actions[0]));
});

test('履约订单固定页面与批次，未备案批次与代发主体被识别', async () => {
  const value = await loadCase();
  const version = value.listing_versions.find((item) => item.listing_version_id === 'lv-2001');
  const substituted = value.order_snapshots.find((order) => order.order_id === 'o-7004');
  assert.deepEqual(checkOrderAgainstFiling(version, substituted).sort(), ['cross_region_dropship', 'item_substitution']);
  const legitVersion = value.listing_versions.find((item) => item.listing_version_id === 'lv-1001');
  const legitOrder = value.order_snapshots.find((order) => order.order_id === 'o-9001');
  assert.deepEqual(checkOrderAgainstFiling(legitVersion, legitOrder), []);
});

test('不同版本之间重叠的追溯码范围可以被定位', async () => {
  const value = await loadCase();
  const overlaps = findTraceCodeOverlaps(value.listing_versions);
  assert.ok(
    overlaps.some((pair) =>
      pair.some((span) => span.listing_version_id === 'lv-2001') &&
      pair.some((span) => span.listing_version_id === 'lv-3007')),
  );
});

test('处置范围对应受影响批次的实际订单', async () => {
  const value = await loadCase();
  const action = value.enforcement_actions[0];
  assert.deepEqual(affectedOrderIds(action, value.order_snapshots), ['o-7001', 'o-7002', 'o-7004']);
  const tampered = JSON.parse(JSON.stringify(value));
  tampered.enforcement_actions[0].order_scope.order_ids.push('o-7003');
  assert.throws(() => validateReviewCase(tampered), /订单范围/);
});

test('买家告知只覆盖受影响批次的订单', async () => {
  const value = await loadCase();
  const action = value.enforcement_actions[0];
  const stray = {
    event_id: 'evt-x',
    kind: 'buyer_notice',
    action_id: action.action_id,
    order_ids: ['o-7003'],
  };
  assert.throws(() => assertBuyerNoticeScoped(stray, action, value.order_snapshots), /超出受影响批次范围/);
});

test('未解决问题前旧链接不得换版重新上架', async () => {
  const value = await loadCase();
  const candidate = value.listing_versions.find((item) => item.listing_version_id === 'lv-2002');
  assert.equal(isRelistBlocked(candidate, value.listing_versions, value.enforcement_actions), true);
  const resolved = value.enforcement_actions.map((action) => ({ ...action, status: 'resolved' }));
  assert.equal(isRelistBlocked(candidate, value.listing_versions, resolved), false);
  const unrelated = value.listing_versions.find((item) => item.listing_version_id === 'lv-1001');
  assert.equal(isRelistBlocked(unrelated, value.listing_versions, value.enforcement_actions), false);
});

test('普通审核员只能查看处置范围内的买家订单', async () => {
  const value = await loadCase();
  assert.deepEqual([...reviewerVisibleOrderIds(value.enforcement_actions)].sort(), ['o-7001', 'o-7002', 'o-7004']);
  assert.doesNotThrow(() => assertReviewerOrderAccess('o-7001', value.enforcement_actions));
  assert.throws(() => assertReviewerOrderAccess('o-9001', value.enforcement_actions), /无关的买家订单/);
});

test('管理者可以追溯处置的版本、订单范围与恢复条件', async () => {
  const value = await loadCase();
  const trace = traceAction('act-0001', value);
  assert.deepEqual(trace.listing_version_ids, ['lv-2001']);
  assert.deepEqual([...trace.order_ids].sort(), ['o-7001', 'o-7002', 'o-7004']);
  assert.ok(trace.recovery_conditions.length > 0);
  assert.throws(() => traceAction('act-9999', value), /不存在/);
});
