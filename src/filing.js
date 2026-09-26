// 在售版本来源报备的解析与领域规则检查。
// 结构性字段以 contracts/source-filing.schema.json 为准，这里只实现业务规则。

export function parseFiling(raw) {
  const value = JSON.parse(raw);
  const required = [
    'filing_id',
    'merchant',
    'listing_version',
    'qualifications',
    'purchase_batches',
    'shipping_entities',
    'page_snapshot'
  ];
  for (const field of required) {
    if (value[field] === undefined || value[field] === null) {
      throw new Error(`来源报备缺少必要字段：${field}`);
    }
  }
  if (!Array.isArray(value.qualifications) || value.qualifications.length === 0) {
    throw new Error('来源报备缺少经营资质');
  }
  if (!Array.isArray(value.purchase_batches) || value.purchase_batches.length === 0) {
    throw new Error('来源报备缺少采购批次');
  }
  return value;
}

// 截至某日（YYYY-MM-DD 或日期字符串）已过期的资质编号。
export function expiredQualifications(filing, asOfDate) {
  const asOf = new Date(asOfDate);
  return filing.qualifications
    .filter((q) => new Date(q.expires_at) < asOf)
    .map((q) => q.qual_id);
}

// 码段容量（可容纳的追溯码个数）。
export function rangeCapacity(ranges) {
  return ranges.reduce((sum, r) => sum + (r.range_end - r.range_start + 1), 0);
}

// 返回报备本身的问题清单：资质日期倒置、码段倒置、码段容量不足以覆盖采购数量、同前缀码段重叠。
export function checkFilingRules(filing) {
  const problems = [];

  for (const q of filing.qualifications) {
    if (new Date(q.expires_at) < new Date(q.issued_at)) {
      problems.push(`资质 ${q.qual_id} 到期日期早于签发日期`);
    }
  }

  const allRanges = [];
  for (const batch of filing.purchase_batches) {
    for (const range of batch.trace_code_ranges) {
      if (range.range_end < range.range_start) {
        problems.push(`批次 ${batch.batch_no} 的码段 ${range.prefix}[${range.range_start},${range.range_end}] 起止倒置`);
      }
      allRanges.push({ ...range, batch_no: batch.batch_no });
    }
    const capacity = rangeCapacity(batch.trace_code_ranges);
    if (capacity < batch.quantity) {
      problems.push(`批次 ${batch.batch_no} 码段容量 ${capacity} 小于报备采购数量 ${batch.quantity}`);
    }
  }

  for (let i = 0; i < allRanges.length; i += 1) {
    for (let j = i + 1; j < allRanges.length; j += 1) {
      const a = allRanges[i];
      const b = allRanges[j];
      if (a.prefix === b.prefix && a.range_start <= b.range_end && b.range_start <= a.range_end) {
        problems.push(
          `批次 ${a.batch_no} 与 ${b.batch_no} 的追溯码段在 ${a.prefix} 前缀下重叠`
        );
      }
    }
  }

  return problems;
}
