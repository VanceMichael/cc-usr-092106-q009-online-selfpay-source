// 来源审查案卷的解析与规则校验。
// 核心约束：下架必须引用具体证据；买家告知只能覆盖所通知批次的实际订单；
// 未解决问题或未满足的恢复条件会阻断旧链接重新上架；普通审核员只能接触处置范围内的买家假名。

export function parseCase(raw) {
  const value = JSON.parse(raw);
  const required = [
    'case_id',
    'listing_id',
    'signals',
    'evidence',
    'dispositions',
    'appeals',
    'reviews',
    'regulator_notifications',
    'buyer_notifications',
    'relist_attempts',
    'unresolved_issues',
    'recovery_conditions',
    'access_log'
  ];
  for (const field of required) {
    if (value[field] === undefined || value[field] === null) {
      throw new Error(`审查案卷缺少必要字段：${field}`);
    }
  }
  return value;
}

const LEVEL_ACTION = { 1: 'observe', 2: 'restrict', 3: 'delist' };

// 案卷内部一致性与处置规则检查，返回问题字符串列表（空列表表示通过）。
export function checkCaseRules(caseRecord, ledger) {
  const problems = [];

  const signals = new Map(caseRecord.signals.map((s) => [s.signal_id, s]));
  const evidence = new Map(caseRecord.evidence.items.map((e) => [e.evidence_id, e]));
  const dispositions = new Map(caseRecord.dispositions.map((d) => [d.disposition_id, d]));
  const appeals = new Map(caseRecord.appeals.map((a) => [a.appeal_id, a]));
  const orderBatch = new Map(ledger.orders.map((o) => [o.order_id, o.locked_batch_no]));
  const orderBuyer = new Map(ledger.orders.map((o) => [o.order_id, o.buyer_ref]));

  for (const ev of caseRecord.evidence.items) {
    if (!signals.has(ev.signal_id)) {
      problems.push(`证据 ${ev.evidence_id} 引用了不存在的信号 ${ev.signal_id}`);
    }
  }

  for (const d of caseRecord.dispositions) {
    if (LEVEL_ACTION[d.level] !== d.action) {
      problems.push(`处置 ${d.disposition_id} 的分级 ${d.level} 与动作 ${d.action} 不匹配`);
    }
    if (d.evidence_ids.length === 0) {
      problems.push(`处置 ${d.disposition_id} 未附具体证据，不得作出处置决定`);
    }
    for (const evidenceId of d.evidence_ids) {
      if (!evidence.has(evidenceId)) {
        problems.push(`处置 ${d.disposition_id} 引用了不存在的证据 ${evidenceId}`);
      }
    }
    // 下架决定必须说明具体证据：至少两条要素——证据本身与逐证据的事实理由（rationale）。
    if (d.action === 'delist') {
      if (d.rationale.trim().length < 10) {
        problems.push(`下架处置 ${d.disposition_id} 的理由说明不具体`);
      }
      const concrete = d.evidence_ids
        .map((id) => evidence.get(id))
        .filter((e) => e && e.source_ref && e.captured_at && e.summary.trim().length > 0);
      if (concrete.length !== d.evidence_ids.length) {
        problems.push(`下架处置 ${d.disposition_id} 存在缺少来源、采集时间或事实描述的证据`);
      }
    }
  }

  for (const appeal of caseRecord.appeals) {
    if (!dispositions.has(appeal.disposition_id)) {
      problems.push(`申诉 ${appeal.appeal_id} 引用了不存在的处置 ${appeal.disposition_id}`);
    }
  }
  for (const review of caseRecord.reviews) {
    if (!appeals.has(review.appeal_id)) {
      problems.push(`复核 ${review.review_id} 引用了不存在的申诉 ${review.appeal_id}`);
    }
    if (review.reviewer_role === 'reviewer') {
      problems.push(`复核 ${review.review_id} 不能由普通审核员完成，须上级角色复核`);
    }
  }

  for (const notice of caseRecord.regulator_notifications) {
    for (const signalId of notice.signal_ids) {
      if (!signals.has(signalId)) {
        problems.push(`监管通知 ${notice.notice_id} 引用了不存在的信号 ${signalId}`);
      }
    }
  }

  // 买家告知只能发给实际购买了所通知批次的订单。
  for (const notice of caseRecord.buyer_notifications) {
    for (const orderId of notice.order_ids) {
      const batch = orderBatch.get(orderId);
      if (!batch) {
        problems.push(`买家告知 ${notice.notice_id} 覆盖了不存在的订单 ${orderId}`);
      } else if (batch !== notice.batch_no) {
        problems.push(
          `买家告知 ${notice.notice_id} 将批次 ${notice.batch_no} 的风险发给了购买批次 ${batch} 的订单 ${orderId}`
        );
      }
    }
  }

  const activeBlocking = caseRecord.dispositions.some(
    (d) => d.action === 'delist' && d.state === 'active'
  );
  const openIssues = caseRecord.unresolved_issues.filter((i) => i.status === 'open');
  const unsatisfied = caseRecord.recovery_conditions.filter((c) => !c.satisfied);

  for (const attempt of caseRecord.relist_attempts) {
    if (attempt.result === 'blocked' && (!attempt.blocking_reasons || attempt.blocking_reasons.length === 0)) {
      problems.push(`重新上架尝试 ${attempt.attempt_id} 标记为阻断但未记录阻断原因`);
    }
    if (attempt.result === 'allowed') {
      const reasons = [];
      if (activeBlocking) reasons.push('存在生效中的下架处置');
      if (openIssues.length > 0) reasons.push('存在未解决问题');
      if (unsatisfied.length > 0) reasons.push('恢复条件未全部满足');
      if (reasons.length > 0) {
        problems.push(`重新上架尝试 ${attempt.attempt_id} 不应放行：${reasons.join('；')}`);
      }
    }
  }

  // 普通审核员可见的买家假名，只能是本案生效处置范围内订单的买家。
  const scopedOrderIds = new Set(
    caseRecord.dispositions
      .filter((d) => d.state === 'active')
      .flatMap((d) => d.scope.order_ids)
  );
  const scopedBuyerRefs = new Set(
    [...scopedOrderIds].map((id) => orderBuyer.get(id)).filter(Boolean)
  );

  for (const entry of caseRecord.access_log) {
    if (entry.buyer_refs_accessed.length > 0 && !entry.case_scoped) {
      problems.push(`访问记录 ${entry.entry_id} 在案卷范围外接触买家信息`);
    }
    if (entry.role === 'reviewer') {
      for (const ref of entry.buyer_refs_accessed) {
        if (!scopedBuyerRefs.has(ref)) {
          problems.push(
            `普通审核员 ${entry.actor_id} 在访问记录 ${entry.entry_id} 中查看了处置范围外的买家 ${ref}`
          );
        }
      }
    }
  }

  return problems;
}

// 管理者视角的追溯链：从一次处置追到版本、批次、订单范围、证据、问题与恢复条件。
export function buildCaseTrace(caseRecord) {
  const evidenceById = new Map(caseRecord.evidence.items.map((e) => [e.evidence_id, e]));
  const appealsByDisposition = new Map();
  for (const appeal of caseRecord.appeals) {
    if (!appealsByDisposition.has(appeal.disposition_id)) {
      appealsByDisposition.set(appeal.disposition_id, []);
    }
    appealsByDisposition.get(appeal.disposition_id).push(appeal);
  }
  const reviewsByAppeal = new Map();
  for (const review of caseRecord.reviews) {
    if (!reviewsByAppeal.has(review.appeal_id)) {
      reviewsByAppeal.set(review.appeal_id, []);
    }
    reviewsByAppeal.get(review.appeal_id).push(review);
  }

  return {
    case_id: caseRecord.case_id,
    listing_id: caseRecord.listing_id,
    status: caseRecord.status,
    dispositions: caseRecord.dispositions.map((d) => ({
      disposition_id: d.disposition_id,
      action: d.action,
      level: d.level,
      state: d.state,
      decided_by: d.decided_by,
      rationale: d.rationale,
      scope: d.scope,
      evidence: d.evidence_ids.map((id) => evidenceById.get(id)),
      appeals: (appealsByDisposition.get(d.disposition_id) ?? []).map((a) => ({
        appeal_id: a.appeal_id,
        status: a.status,
        grounds: a.grounds,
        reviews: reviewsByAppeal.get(a.appeal_id) ?? []
      }))
    })),
    open_issues: caseRecord.unresolved_issues.filter((i) => i.status === 'open'),
    recovery_conditions: caseRecord.recovery_conditions,
    regulator_notifications: caseRecord.regulator_notifications,
    buyer_notifications: caseRecord.buyer_notifications,
    relist_attempts: caseRecord.relist_attempts
  };
}
