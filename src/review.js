// 自费售药来源审查：案例资料的结构校验与处置边界规则。
// 资料格式见 contracts/source-review.schema.json，示例见 fixtures/review-case.json。

const LEVEL_RANK = { none: 0, observe: 1, restrict: 2, takedown: 3 };

// 弱信号：低价或异地发货本身可能是正常经营，不得据此处置正规药房。
export const WEAK_SIGNAL_TYPES = new Set(['low_price', 'cross_region_shipment']);

// 强信号：追溯码重复、来源证明过期、商品替换、异地代发，可触发分级处置。
export const STRONG_SIGNAL_TYPES = new Set([
  'duplicate_trace_code',
  'expired_source_proof',
  'item_substitution',
  'cross_region_dropship',
]);

// 处于这些状态的处置仍未解决，同一药品不得换链接重新上架。
export const OPEN_ACTION_STATUSES = new Set(['open', 'appealed', 'upheld']);

function requireFields(value, fields, label) {
  for (const field of fields) {
    const fieldValue = value[field];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      throw new Error(`${label}缺少必要字段: ${field}`);
    }
  }
}

function requireArrayField(value, field, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value[field])) {
    throw new Error(`${label}缺少数组字段: ${field}`);
  }
  if (nonEmpty && value[field].length === 0) {
    throw new Error(`${label}数组字段不能为空: ${field}`);
  }
}

export function assertListingVersion(version) {
  requireFields(version, [
    'listing_version_id',
    'merchant_id',
    'product',
    'qualifications',
    'purchase_batches',
    'shipping_entity',
    'temperature_commitment',
    'status',
    'submitted_at',
  ], '在售版本备案');
  requireFields(version.product, ['name', 'spec', 'manufacturer', 'approval_number'], '备案药品');
  requireArrayField(version, 'qualifications', '在售版本备案', { nonEmpty: true });
  for (const qualification of version.qualifications) {
    requireFields(qualification, ['kind', 'number', 'valid_until'], '经营资质');
  }
  requireArrayField(version, 'purchase_batches', '在售版本备案', { nonEmpty: true });
  for (const batch of version.purchase_batches) {
    requireFields(batch, ['batch_id', 'trace_code_range', 'invoice_summary', 'quantity'], '采购批次');
    requireFields(batch.trace_code_range, ['prefix', 'start', 'end'], '追溯码范围');
    requireFields(batch.invoice_summary, ['invoice_number', 'seller', 'amount_yuan', 'issued_at'], '票据摘要');
  }
  requireFields(version.shipping_entity, ['name', 'license_number', 'warehouse_region'], '实际发货主体');
  requireFields(version.temperature_commitment, ['mode', 'range_note'], '温控承诺');
}

export function assertOrderSnapshot(order) {
  requireFields(order, [
    'order_id',
    'listing_version_id',
    'page_snapshot_id',
    'batch_id',
    'buyer_ref',
    'fulfilled_by',
    'ship_from_region',
    'delivery_region',
    'placed_at',
  ], '订单履约快照');
}

export function assertRiskSignal(signal) {
  requireFields(signal, ['signal_id', 'type', 'listing_version_id', 'detected_at', 'evidence_refs'], '风险信号');
  if (!WEAK_SIGNAL_TYPES.has(signal.type) && !STRONG_SIGNAL_TYPES.has(signal.type)) {
    throw new Error(`未知风险信号类型: ${signal.type}`);
  }
}

export function assertEnforcementAction(action) {
  requireFields(action, [
    'action_id',
    'level',
    'listing_version_ids',
    'signal_ids',
    'evidence',
    'order_scope',
    'recovery_conditions',
    'status',
    'decided_by',
    'decided_at',
  ], '处置记录');
  requireArrayField(action, 'listing_version_ids', '处置记录', { nonEmpty: true });
  requireArrayField(action, 'signal_ids', '处置记录', { nonEmpty: true });
  requireArrayField(action, 'evidence', '处置记录');
  requireArrayField(action, 'recovery_conditions', '处置记录', { nonEmpty: true });
  requireFields(action.order_scope, ['batch_ids', 'order_ids'], '处置订单范围');
}

export function assertAuditEvent(event) {
  requireFields(event, ['event_id', 'kind', 'action_id', 'actor_role', 'created_at', 'summary'], '留痕记录');
}

export function assertReviewCaseShape(value) {
  requireFields(value, [
    'case_id',
    'listing_versions',
    'order_snapshots',
    'risk_signals',
    'enforcement_actions',
    'audit_events',
  ], '案例资料');
  for (const key of ['listing_versions', 'order_snapshots', 'risk_signals', 'enforcement_actions', 'audit_events']) {
    requireArrayField(value, key, '案例资料');
  }
  value.listing_versions.forEach(assertListingVersion);
  value.order_snapshots.forEach(assertOrderSnapshot);
  value.risk_signals.forEach(assertRiskSignal);
  value.enforcement_actions.forEach(assertEnforcementAction);
  value.audit_events.forEach(assertAuditEvent);
}

export function parseReviewCase(raw) {
  const value = JSON.parse(raw);
  assertReviewCaseShape(value);
  return value;
}

// 弱信号只能观察，不得升级为限流或下架，避免误伤正规药房。
export function maxAllowedLevel(signals) {
  if (signals.length === 0) {
    return 'none';
  }
  if (signals.every((signal) => WEAK_SIGNAL_TYPES.has(signal.type))) {
    return 'observe';
  }
  return 'takedown';
}

export function assertActionLevelAllowed(action, signals) {
  const cap = maxAllowedLevel(signals);
  if (LEVEL_RANK[action.level] > LEVEL_RANK[cap]) {
    throw new Error(`处置 ${action.action_id} 级别 ${action.level} 超出信号允许范围: 低价或异地发货等弱信号不得升级处置`);
  }
}

// 下架决定必须说明具体证据。
export function assertTakedownEvidence(action) {
  if (action.level !== 'takedown') {
    return;
  }
  if (!Array.isArray(action.evidence) || action.evidence.length === 0) {
    throw new Error(`下架决定 ${action.action_id} 必须说明具体证据`);
  }
  for (const item of action.evidence) {
    requireFields(item, ['evidence_id', 'kind', 'ref', 'summary'], '处置证据');
  }
}

// 履约订单对照备案：批次未备案视为商品替换，发货主体不符视为异地代发。
export function checkOrderAgainstFiling(version, order) {
  const found = [];
  if (!version.purchase_batches.some((batch) => batch.batch_id === order.batch_id)) {
    found.push('item_substitution');
  }
  if (order.fulfilled_by !== version.shipping_entity.name) {
    found.push('cross_region_dropship');
  }
  return found;
}

// 定位不同在售版本之间重叠的追溯码范围。
export function findTraceCodeOverlaps(versions) {
  const spans = [];
  for (const version of versions) {
    for (const batch of version.purchase_batches) {
      spans.push({
        listing_version_id: version.listing_version_id,
        batch_id: batch.batch_id,
        prefix: batch.trace_code_range.prefix,
        start: batch.trace_code_range.start,
        end: batch.trace_code_range.end,
      });
    }
  }
  const overlaps = [];
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i];
      const b = spans[j];
      const sameVersion = a.listing_version_id === b.listing_version_id;
      if (!sameVersion && a.prefix === b.prefix && a.start <= b.end && b.start <= a.end) {
        overlaps.push([a, b]);
      }
    }
  }
  return overlaps;
}

// 处置范围应对应受影响批次的实际订单。
export function affectedOrderIds(action, orders) {
  const batches = new Set(action.order_scope.batch_ids);
  return orders.filter((order) => batches.has(order.batch_id)).map((order) => order.order_id).sort();
}

function assertOrderScopeMatchesBatches(action, orders) {
  const expected = affectedOrderIds(action, orders);
  const actual = [...action.order_scope.order_ids].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`处置 ${action.action_id} 的订单范围必须对应受影响批次的实际订单`);
  }
}

// 买家告知只覆盖受影响批次的订单，不得打扰无关买家。
export function assertBuyerNoticeScoped(event, action, orders) {
  if (event.kind !== 'buyer_notice') {
    return;
  }
  const allowed = new Set(affectedOrderIds(action, orders));
  for (const orderId of event.order_ids ?? []) {
    if (!allowed.has(orderId)) {
      throw new Error(`买家告知 ${event.event_id} 超出受影响批次范围: ${orderId}`);
    }
  }
}

// 存在未解决处置时，同一商家同一药品不得换链接重新上架。
export function isRelistBlocked(candidate, versions, actions) {
  const openVersionIds = new Set(
    actions
      .filter((action) => OPEN_ACTION_STATUSES.has(action.status))
      .flatMap((action) => action.listing_version_ids),
  );
  return versions.some(
    (version) =>
      openVersionIds.has(version.listing_version_id) &&
      version.merchant_id === candidate.merchant_id &&
      version.product.approval_number === candidate.product.approval_number,
  );
}

// 普通审核员只能查看未解决处置范围内的买家订单。
export function reviewerVisibleOrderIds(actions) {
  const visible = new Set();
  for (const action of actions) {
    if (!OPEN_ACTION_STATUSES.has(action.status)) {
      continue;
    }
    for (const orderId of action.order_scope.order_ids) {
      visible.add(orderId);
    }
  }
  return visible;
}

export function assertReviewerOrderAccess(orderId, actions) {
  if (!reviewerVisibleOrderIds(actions).has(orderId)) {
    throw new Error(`普通审核员不得查看与处置无关的买家订单: ${orderId}`);
  }
}

// 管理者从一次处置追到相关商品版本、订单范围和恢复条件。
export function traceAction(actionId, reviewCase) {
  const action = reviewCase.enforcement_actions.find((item) => item.action_id === actionId);
  if (!action) {
    throw new Error(`处置记录不存在: ${actionId}`);
  }
  return {
    action_id: action.action_id,
    level: action.level,
    status: action.status,
    listing_version_ids: [...action.listing_version_ids],
    order_ids: [...action.order_scope.order_ids],
    recovery_conditions: [...action.recovery_conditions],
  };
}

// 整案校验：结构 + 引用完整 + 全部处置边界规则。
export function validateReviewCase(value) {
  assertReviewCaseShape(value);
  const versionsById = new Map(value.listing_versions.map((version) => [version.listing_version_id, version]));
  const signalsById = new Map(value.risk_signals.map((signal) => [signal.signal_id, signal]));
  const actionsById = new Map(value.enforcement_actions.map((action) => [action.action_id, action]));

  for (const order of value.order_snapshots) {
    if (!versionsById.has(order.listing_version_id)) {
      throw new Error(`订单 ${order.order_id} 引用了不存在的在售版本`);
    }
  }
  for (const signal of value.risk_signals) {
    if (!versionsById.has(signal.listing_version_id)) {
      throw new Error(`风险信号 ${signal.signal_id} 引用了不存在的在售版本`);
    }
  }
  for (const action of value.enforcement_actions) {
    for (const versionId of action.listing_version_ids) {
      if (!versionsById.has(versionId)) {
        throw new Error(`处置 ${action.action_id} 引用了不存在的在售版本`);
      }
    }
    const signals = action.signal_ids.map((signalId) => {
      const signal = signalsById.get(signalId);
      if (!signal) {
        throw new Error(`处置 ${action.action_id} 引用了不存在的风险信号: ${signalId}`);
      }
      return signal;
    });
    assertActionLevelAllowed(action, signals);
    assertTakedownEvidence(action);
    assertOrderScopeMatchesBatches(action, value.order_snapshots);
  }
  for (const event of value.audit_events) {
    const action = actionsById.get(event.action_id);
    if (!action) {
      throw new Error(`留痕 ${event.event_id} 引用了不存在的处置记录`);
    }
    assertBuyerNoticeScoped(event, action, value.order_snapshots);
  }
  return true;
}
