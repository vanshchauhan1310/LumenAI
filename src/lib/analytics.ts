/**
 * Pure analytical math for the Tier-1 analytical tools (compare_periods,
 * explain_change, anomaly_detection, forecast_metric, rank_categories,
 * pivot_cross_tab, correlation_analysis, field_statistics, bucketize_metric,
 * share_of_total, get_summary_table). No Tableau/network calls here — these
 * functions are deterministic and unit-tested in tests/analytics.test.ts.
 *
 * Every series type below is a flat array of { label, value } pairs where
 * `label` is the row's category/time bucket (e.g. a month string or a region
 * name) and `value` is a finite number. Tools translate VDS query rows into
 * this shape, and translate the results back into user-facing output.
 */

const round = (n: number, digits = 2) => {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
};

/** Reads the first finite numeric value out of a VDS OBJECTS-format row. */
export function extractNumericValue(row: Record<string, any>): number | null {
  for (const v of Object.values(row)) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

export interface DiffRow {
  key: string;
  current: number;
  previous: number;
  /** current - previous */
  absChange: number;
  /** absChange / previous, null when previous is 0 */
  pctChange: number | null;
  /**
   * This segment's share of the total absolute change between the periods
   * (|this absChange| / sum of |absChange| across segments). Null for the
   * overall row. Lets the model rank "what drove the change".
   */
  contribution: number | null;
}

/**
 * Computes per-segment change between two periods, plus an overall row.
 *
 * @param currentRows  rows from the current period, [{ key, value }]
 * @param previousRows rows from the previous period, [{ key, value }]
 * @returns { overall, segments } where `segments` is sorted by |absChange| desc.
 */
export function diffAcrossPeriods(
  currentRows: { key: string; value: number }[],
  previousRows: { key: string; value: number }[],
): { overall: DiffRow; segments: DiffRow[] } {
  const prevMap = new Map(previousRows.map((r) => [r.key, r.value]));
  const curMap = new Map(currentRows.map((r) => [r.key, r.value]));

  const allKeys = new Set<string>([...curMap.keys(), ...prevMap.keys()]);
  const totalCurrent = [...curMap.values()].reduce((a, b) => a + b, 0);
  const totalPrevious = [...prevMap.values()].reduce((a, b) => a + b, 0);

  const pct = (cur: number, prev: number): number | null => {
    if (prev === 0) return null;
    return round(((cur - prev) / Math.abs(prev)) * 100);
  };

  const overall: DiffRow = {
    key: "__overall__",
    current: round(totalCurrent),
    previous: round(totalPrevious),
    absChange: round(totalCurrent - totalPrevious),
    pctChange: pct(totalCurrent, totalPrevious),
    contribution: null,
  };

  const segments: DiffRow[] = [...allKeys]
    .map((key) => {
      const current = curMap.get(key) ?? 0;
      const previous = prevMap.get(key) ?? 0;
      return {
        key,
        current: round(current),
        previous: round(previous),
        absChange: round(current - previous),
        pctChange: pct(current, previous),
        contribution: 0,
      } as DiffRow;
    })
    .sort((a, b) => Math.abs(b.absChange) - Math.abs(a.absChange));

  const totalAbsChange = segments.reduce((sum, s) => sum + Math.abs(s.absChange), 0);
  for (const s of segments) {
    s.contribution = totalAbsChange > 0 ? round((Math.abs(s.absChange) / totalAbsChange) * 100) : null;
  }

  return { overall, segments };
}

export interface AnomalyPoint {
  label: string;
  value: number;
  isAnomaly: boolean;
  /** |z| > threshold means anomalous */
  zScore: number | null;
  /** signed deviation from the expectation */
  deviation: number;
}

export interface AnomalyResult {
  method: "zscore";
  threshold: number;
  mean: number | null;
  stddev: number | null;
  points: AnomalyPoint[];
  anomalies: AnomalyPoint[];
}

/**
 * Flags outliers in a time series using the z-score of each point relative to
 * the series' own mean/stddev. Deterministic and simple — good enough to point
 * the model at "this period is unusually high/low", not a statistical product.
 */
export function detectAnomalies(
  series: { key: string; value: number }[],
  threshold = 2.5,
): AnomalyResult {
  const values = series.map((s) => s.value);
  const mean = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const variance =
    mean !== null && values.length > 1
      ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
      : 0;
  const stddev = Math.sqrt(variance);

  const points: AnomalyPoint[] = series.map((s) => {
    const deviation = mean !== null ? s.value - mean : 0;
    const zScore = stddev > 0 ? deviation / stddev : null;
    const isAnomaly = zScore !== null && Math.abs(zScore) > threshold;
    return {
      label: s.key,
      value: round(s.value),
      isAnomaly,
      zScore: zScore !== null ? round(zScore) : null,
      deviation: round(deviation),
    };
  });

  return {
    method: "zscore",
    threshold,
    mean: mean !== null ? round(mean) : null,
    stddev: round(stddev),
    points,
    anomalies: points.filter((p) => p.isAnomaly),
  };
}

export interface ForecastPoint {
  label: string;
  value: number;
  /** true for projected points */
  forecast: boolean;
  lower: number | null;
  upper: number | null;
}

export interface ForecastResult {
  slope: number | null;
  intercept: number | null;
  r2: number | null;
  residualStddev: number | null;
  points: ForecastPoint[];
}

/**
 * Least-squares linear fit over the historical series, then projects forward
 * `periods` points. `nextLabel(i)` turns the projected index into a label
 * (e.g. the next month); if omitted, labels become "t+n". The confidence band
 * is ±1 residual stddev — intentionally naive; forecast_metric's description
 * tells the model to caveat it as an estimate.
 */
export function forecastLinear(
  series: { key: string; value: number }[],
  periods: number,
  nextLabel?: (nextIndex: number) => string,
): ForecastResult {
  if (series.length < 2) {
    return { slope: null, intercept: null, r2: null, residualStddev: null, points: [] };
  }

  const n = series.length;
  const xs = series.map((_, i) => i);
  const ys = series.map((s) => s.value);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;

  const fitted = xs.map((x) => slope * x + intercept);
  const residuals = ys.map((y, i) => y - fitted[i]);
  const residualStddev =
    n > 2 ? Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / (n - 2)) : 0;

  const ssTot = ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0);
  const ssRes = residuals.reduce((sum, r) => sum + r * r, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;

  const points: ForecastPoint[] = series.map((s, i) => ({
    label: s.key,
    value: round(s.value),
    forecast: false,
    lower: round(fitted[i] - residualStddev),
    upper: round(fitted[i] + residualStddev),
  }));

  for (let p = 1; p <= periods; p++) {
    const idx = n - 1 + p;
    const val = slope * idx + intercept;
    const label = nextLabel ? nextLabel(n - 1 + p) : `t+${p}`;
    points.push({
      label,
      value: round(val),
      forecast: true,
      lower: round(val - residualStddev),
      upper: round(val + residualStddev),
    });
  }

  return { slope: round(slope), intercept: round(intercept), r2: r2 !== null ? round(r2) : null, residualStddev: round(residualStddev), points };
}

/** Reads one specific field's numeric value out of a VDS OBJECTS row. */
export function readNumericCell(row: Record<string, any>, caption: string): number | null {
  const v = row?.[caption];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export interface RankedRow {
  key: string;
  value: number;
  rank: number;
  /** value / total * 100 */
  pctOfTotal: number | null;
  /** cumulative share down the ranked list (top-down) */
  cumulativePct: number | null;
}

/**
 * Ranks dimension members by a measure (top or bottom N) and attaches each
 * one's share of the total plus the running cumulative share. Deterministic —
 * feed it rowsToSeries output.
 */
export function rankSeries(
  series: { key: string; value: number }[],
  opts: { direction?: "top" | "bottom"; limit?: number } = {},
): { total: number; rows: RankedRow[] } {
  const direction = opts.direction ?? "top";
  const limit = opts.limit ?? 20;
  const total = series.reduce((sum, s) => sum + s.value, 0);
  const sorted = [...series].sort((a, b) => (direction === "bottom" ? a.value - b.value : b.value - a.value));
  const rows: RankedRow[] = [];
  let running = 0;
  for (const s of sorted.slice(0, limit)) {
    running += s.value;
    rows.push({
      key: s.key,
      value: round(s.value),
      rank: rows.length + 1,
      pctOfTotal: total > 0 ? round((s.value / total) * 100) : null,
      cumulativePct: total > 0 ? round((running / total) * 100) : null,
    });
  }
  return { total: round(total), rows };
}

export interface PivotMatrix {
  /** Column keys in first-appearance order */
  columns: string[];
  rows: { rowKey: string; cells: Record<string, number>; rowTotal: number }[];
  columnTotals: Record<string, number>;
  grandTotal: number;
}

/** Builds a rows x columns pivot from flat { rowKey, colKey, value } triplets. */
export function buildPivotMatrix(triplets: { rowKey: string; colKey: string; value: number }[]): PivotMatrix {
  const columns = [...new Set(triplets.map((t) => t.colKey))];
  const cellsRaw = new Map<string, Map<string, number>>();
  const rowRaw = new Map<string, number>();
  const colRaw = new Map<string, number>();
  let grand = 0;
  for (const t of triplets) {
    if (!cellsRaw.has(t.rowKey)) cellsRaw.set(t.rowKey, new Map());
    const rowCells = cellsRaw.get(t.rowKey)!;
    rowCells.set(t.colKey, (rowCells.get(t.colKey) ?? 0) + t.value);
    rowRaw.set(t.rowKey, (rowRaw.get(t.rowKey) ?? 0) + t.value);
    colRaw.set(t.colKey, (colRaw.get(t.colKey) ?? 0) + t.value);
    grand += t.value;
  }
  const toObj = (m: Map<string, number>) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, round(v)]));
  return {
    columns,
    rows: [...cellsRaw.entries()].map(([rowKey, cells]) => ({
      rowKey,
      cells: toObj(cells),
      rowTotal: round(rowRaw.get(rowKey) ?? 0),
    })),
    columnTotals: toObj(colRaw),
    grandTotal: round(grand),
  };
}

/**
 * Pearson correlation coefficient over paired points. Returns null when there
 * are fewer than 2 points or either variable is constant (zero variance).
 */
export function pearson(points: { x: number; y: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return round(num / Math.sqrt(dx2 * dy2), 4);
}

/** Spearman rank correlation: pearson over the tied-average ranks. */
export function spearman(points: { x: number; y: number }[]): number | null {
  if (points.length < 2) return null;
  const rank = (arr: number[]) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array(arr.length);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[sorted[k].i] = avgRank;
      i = j + 1;
    }
    return out;
  };
  const rx = rank(points.map((p) => p.x));
  const ry = rank(points.map((p) => p.y));
  return pearson(points.map((_, i) => ({ x: rx[i], y: ry[i] })));
}

/** Coarse verbal label for |r| — strong / moderate / weak / negligible. */
export function correlationLabel(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.8) return "strong";
  if (a >= 0.5) return "moderate";
  if (a >= 0.2) return "weak";
  return "negligible";
}

/** Linear-interpolated percentile from a sorted ascending array. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = ((sortedAsc.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round(sortedAsc[lo]);
  return round(sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo]));
}

export interface HistogramBin {
  label: string;
  min: number;
  max: number;
  count: number;
  /** count / total * 100 */
  pct: number | null;
}

export interface HistogramResult {
  min: number | null;
  max: number | null;
  binWidth: number;
  total: number;
  bins: HistogramBin[];
}

/**
 * Equal-width histogram buckets over the given numeric values. When there's
 * only one distinct value (span 0), a single bin spans that value ±1 so the
 * value isn't dropped.
 */
export function histogram(
  values: number[],
  opts: { bucketCount?: number; min?: number; max?: number } = {},
): HistogramResult {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: null, max: null, binWidth: 0, total: 0, bins: [] };
  const bucketCount = Math.max(1, Math.floor(opts.bucketCount ?? 5));
  const dataMin = Math.min(...finite);
  const dataMax = Math.max(...finite);
  const min = opts.min !== undefined ? opts.min : dataMin;
  const max = opts.max !== undefined ? opts.max : dataMax;
  const span = max - min;
  const binWidth = span > 0 ? span / bucketCount : 1;
  const bins: HistogramBin[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = min + i * binWidth;
    const hi = i === bucketCount - 1 ? max : lo + binWidth;
    bins.push({ label: `${round(lo)} - ${round(hi)}`, min: round(lo), max: round(hi), count: 0, pct: 0 });
  }
  for (const v of finite) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].count += 1;
  }
  const total = finite.length;
  for (const b of bins) b.pct = total > 0 ? round((b.count / total) * 100) : null;
  return { min: round(min), max: round(max), binWidth: round(binWidth), total, bins };
}

export interface ShareRow {
  key: string;
  value: number;
  /** value / total * 100 */
  pctOfTotal: number | null;
  /** cumulative share down the ranked list */
  cumulativePct: number | null;
  baselineValue: number | null;
  /** the member's share in the baseline period */
  baselinePct: number | null;
  /** percentage-point change in share vs baseline (now - baseline) */
  shareDeltaPts: number | null;
  /** value now - value in baseline */
  valueChange: number | null;
}

/**
 * Ranks members by share of total and (optionally) compares each member's
 * current share against a baseline period, reporting the percentage-point
 * change in share. Sorted by value descending.
 */
export function shareOfTotal(
  series: { key: string; value: number }[],
  baselineSeries?: { key: string; value: number }[],
): { total: number; baselineTotal: number | null; rows: ShareRow[] } {
  const total = series.reduce((sum, s) => sum + s.value, 0);
  const baselineMap = new Map((baselineSeries ?? []).map((r) => [r.key, r.value]));
  const baselineTotal = baselineSeries ? baselineSeries.reduce((sum, r) => sum + r.value, 0) : null;
  const sorted = [...series].sort((a, b) => b.value - a.value);
  const rows: ShareRow[] = [];
  let running = 0;
  for (const s of sorted) {
    running += s.value;
    const baselineValue = baselineMap.get(s.key) ?? 0;
    const baselinePct = baselineTotal && baselineTotal > 0 ? (baselineValue / baselineTotal) * 100 : null;
    const shareNow = total > 0 ? (s.value / total) * 100 : null;
    rows.push({
      key: s.key,
      value: round(s.value),
      pctOfTotal: shareNow !== null ? round(shareNow) : null,
      cumulativePct: total > 0 ? round((running / total) * 100) : null,
      baselineValue: baselineSeries ? round(baselineValue) : null,
      baselinePct: baselinePct !== null ? round(baselinePct) : null,
      shareDeltaPts: shareNow !== null && baselinePct !== null ? round(shareNow - baselinePct) : null,
      valueChange: baselineSeries ? round(s.value - baselineValue) : null,
    });
  }
  return {
    total: round(total),
    baselineTotal: baselineTotal !== null ? round(baselineTotal) : null,
    rows,
  };
}

/**
 * Builds a VDS QUANTITATIVE_DATE filter object for a date field. start/end
 * are inclusive ISO dates (YYYY-MM-DD); VDS accepts them as strings.
 */
export function buildDateFilter(fieldCaption: string, start: string, end: string) {
  return {
    field: { fieldCaption },
    filterType: "QUANTITATIVE_DATE",
    min: start,
    max: end,
  };
}
