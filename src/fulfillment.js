// 订单履约留痕与来源报备的比对。
// 低价、异地发货只记录为观察项：只要发货主体在报备清单内，就不产生风险信号。

export function parseLedger(raw) {
  const value = JSON.parse(raw);
  if (!Array.isArray(value.orders) || value.orders.length === 0) {
    throw new Error('履约留痕缺少订单数据');
  }
  return value;
}

// 追溯码由字母前缀与数字序号组成，如 T1001。
export function parseTraceCode(code) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(code);
  if (!match) {
    return null;
  }
  return { prefix: match[1], seq: Number(match[2]) };
}

function codeInRanges(code, ranges) {
  const parsed = parseTraceCode(code);
  if (!parsed) {
    return false;
  }
  return ranges.some(
    (r) => r.prefix === parsed.prefix && parsed.seq >= r.range_start && parsed.seq <= r.range_end
  );
}

function batchByNo(filing) {
  const map = new Map();
  for (const batch of filing.purchase_batches) {
    map.set(batch.batch_no, batch);
  }
  return map;
}

// 比对报备与履约订单，返回 findings（风险信号）与 cleanOrderIds（无信号订单）。
export function evaluateFulfillment(filing, ledger) {
  const findings = [];
  const batches = batchByNo(filing);
  const filedEntityIds = new Set(filing.shipping_entities.map((e) => e.entity_id));
  const filedAddresses = new Set(
    filing.shipping_entities.flatMap((e) => e.warehouse_addresses)
  );

  const codeUses = new Map();
  for (const order of ledger.orders) {
    for (const code of order.trace_codes) {
      if (!codeUses.has(code)) {
        codeUses.set(code, []);
      }
      codeUses.get(code).push(order.order_id);
    }
  }
  for (const [code, orderIds] of codeUses) {
    if (orderIds.length > 1) {
      findings.push({
        type: 'duplicate_trace_code',
        code,
        order_ids: orderIds,
        summary: `追溯码 ${code} 在多个订单重复出现：${orderIds.join('、')}`
      });
    }
  }

  for (const order of ledger.orders) {
    // 商品替换：履约时锁定的版本或买家所见页面与备案不一致。
    if (
      order.locked_version_id !== filing.listing_version.version_id ||
      order.page_view.listing_hash !== filing.page_snapshot.listing_hash
    ) {
      findings.push({
        type: 'listing_substitution',
        order_ids: [order.order_id],
        summary: `订单 ${order.order_id} 履约页面/版本与备案快照不一致，疑似商品替换`
      });
    }

    const lockedBatch = batches.get(order.locked_batch_no);
    for (const code of order.trace_codes) {
      if (!lockedBatch) {
        findings.push({
          type: 'trace_code_out_of_range',
          order_ids: [order.order_id],
          code,
          reason: 'unknown_batch',
          summary: `订单 ${order.order_id} 锁定批次 ${order.locked_batch_no} 未报备`
        });
        continue;
      }
      if (!codeInRanges(code, lockedBatch.trace_code_ranges)) {
        const belongsElsewhere = filing.purchase_batches.some(
          (b) => b.batch_no !== lockedBatch.batch_no && codeInRanges(code, b.trace_code_ranges)
        );
        findings.push({
          type: 'trace_code_out_of_range',
          order_ids: [order.order_id],
          code,
          reason: belongsElsewhere ? 'wrong_batch' : 'no_filed_range',
          summary: belongsElsewhere
            ? `订单 ${order.order_id} 追溯码 ${code} 不属于锁定批次 ${lockedBatch.batch_no} 的报备码段`
            : `订单 ${order.order_id} 追溯码 ${code} 不在任何报备码段内`
        });
      }
    }

    // 异地代发以“是否报备”为准，不以发货地与买家所在地是否跨省为准。
    if (
      !filedEntityIds.has(order.shipment.shipping_entity_id) ||
      !filedAddresses.has(order.shipment.warehouse_address)
    ) {
      findings.push({
        type: 'unreported_shipping',
        order_ids: [order.order_id],
        shipping_entity_id: order.shipment.shipping_entity_id,
        summary: `订单 ${order.order_id} 由未报备主体 ${order.shipment.shipping_entity_id} 自 ${order.shipment.warehouse_address} 发货`
      });
    }
  }

  const flaggedOrderIds = new Set(findings.flatMap((f) => f.order_ids));
  const cleanOrderIds = ledger.orders
    .map((o) => o.order_id)
    .filter((id) => !flaggedOrderIds.has(id));

  return { findings, cleanOrderIds };
}
