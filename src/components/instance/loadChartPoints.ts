import type { LoadRecord, NodeMetrics } from "@/types/komari";
import { formatBytes } from "@/utils/format";
import { resolveLoadRecordTotals, type LoadRecordTotalFallbacks } from "@/utils/loadMetrics";
import { downsampleAligned, fillMissingMetricPoints, interpolateMetricGaps } from "./chartData";
import { toChartSeconds } from "./chartShared";

/** 负载图表内存/磁盘曲线的单位:bytes 为实际用量(默认),percent 为百分比。 */
export type LoadChartUnit = "bytes" | "percent";

export interface LoadChartPoint {
  time: number;
  [key: string]: number | null | undefined;
}

export type NodeLoadSnapshot = Pick<
  NodeMetrics,
  | "cpuPct"
  | "ramUsed"
  | "ramTotal"
  | "swapUsed"
  | "swapTotal"
  | "diskUsed"
  | "diskTotal"
  | "netDown"
  | "netUp"
  | "connectionsTcp"
  | "connectionsUdp"
  | "process"
  | "updatedAt"
>;

/**
 * total 为 0 且 used 为 0 表示该指标不存在(如无 Swap),返回 null 让 uPlot 不画线,
 * 而不是画一条假的 0。百分比模式还需要 total > 0 才能换算;字节模式 used 本身就是
 * 展示值,只要指标存在就直接使用。
 */
function toLoadChartValue(used: number, total: number, unit: LoadChartUnit): number | null {
  if (!Number.isFinite(used)) return null;
  if (used <= 0 && total <= 0) return null;
  if (unit === "percent") {
    return total > 0 ? (used / total) * 100 : null;
  }
  return used;
}

export function loadPointFromNode(node: NodeLoadSnapshot, unit: LoadChartUnit): LoadChartPoint {
  return {
    time: node.updatedAt > 0 ? node.updatedAt / 1000 : Date.now() / 1000,
    cpu: node.cpuPct,
    ram: toLoadChartValue(node.ramUsed, node.ramTotal, unit),
    swap: toLoadChartValue(node.swapUsed, node.swapTotal, unit),
    disk: toLoadChartValue(node.diskUsed, node.diskTotal, unit),
    netIn: node.netDown,
    netOut: node.netUp,
    connections: node.connectionsTcp,
    udp: node.connectionsUdp,
    process: node.process,
  };
}

export function loadPointFromRecord(
  record: LoadRecord,
  time: number,
  fallbacks: LoadRecordTotalFallbacks,
  unit: LoadChartUnit,
): LoadChartPoint {
  const totals = resolveLoadRecordTotals(record, fallbacks);
  return {
    time,
    cpu: record.cpu,
    ram: toLoadChartValue(record.ram, totals.ramTotal, unit),
    swap: toLoadChartValue(record.swap, totals.swapTotal, unit),
    disk: toLoadChartValue(record.disk, totals.diskTotal, unit),
    netIn: record.net_in,
    netOut: record.net_out,
    connections: record.connections,
    udp: record.connections_udp,
    process: record.process,
  };
}

/** 图表卡片头部的“当前值”:百分比模式显示使用率,字节模式显示 已用/总量。 */
export function formatLoadUsedLabel(unit: LoadChartUnit, used: number, total: number): string {
  if (unit === "percent") {
    return total > 0 ? `${((used / total) * 100).toFixed(2)}%` : "—";
  }
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

/** 内存卡片头部的 Swap 备注;total 为 0 视作未配置 Swap。 */
export function formatLoadSwapLabel(unit: LoadChartUnit, used: number, total: number): string {
  if (total <= 0) return "Swap 无";
  if (unit === "percent") {
    return `Swap ${((used / total) * 100).toFixed(2)}%`;
  }
  return `Swap ${formatBytes(used)} / ${formatBytes(total)}`;
}

/** 负载图表全部数值系列的点位键,补洞/插值/降采样共用同一份。 */
export const LOAD_SERIES_KEYS = [
  "cpu",
  "ram",
  "swap",
  "disk",
  "netIn",
  "netOut",
  "connections",
  "udp",
  "process",
] as const;

/**
 * 实时模式的种子点位:20 分钟 1 分钟桶 + 10 分钟原始样本(或旧后端的 1 小时兼容记录)。
 *
 * 两段分开做补洞/插值 —— 桶段 60 秒等距、原始段是 agent 上报频率,混在一起推断间距
 * 会把稀疏段误填成 null。原始段不做补洞插值:样本缺失就是真实的断线/停报,如实断开。
 * 总点数超过 maxPoints 时按时间分桶保峰降采样。
 */
export function buildLoadSeedPoints(
  records: LoadRecord[],
  options: {
    /** 原始样本段起点(秒);null 表示全部记录视为桶段(旧后端兼容路径)。 */
    rawStartSec: number | null;
    fallbacks: LoadRecordTotalFallbacks;
    unit: LoadChartUnit;
    maxPoints: number;
  },
): LoadChartPoint[] {
  const timed = records
    .map((record) => ({ record, time: toChartSeconds(record.time) }))
    .filter((item) => item.time > 0)
    .sort((left, right) => left.time - right.time);
  if (timed.length === 0) return [];

  const toPoints = (list: typeof timed) =>
    list.map(({ record, time }) =>
      loadPointFromRecord(record, time, options.fallbacks, options.unit),
    );

  let combined: LoadChartPoint[];
  if (options.rawStartSec == null) {
    combined = interpolateMetricGaps(
      fillMissingMetricPoints(toPoints(timed)),
      [...LOAD_SERIES_KEYS],
    );
  } else {
    const rawStartSec = options.rawStartSec;
    const bucket = timed.filter((item) => item.time < rawStartSec);
    const raw = timed.filter((item) => item.time >= rawStartSec);
    // 桶段补洞 + 短缺口插值;原始段保持原样。
    const bucketPoints = bucket.length
      ? interpolateMetricGaps(fillMissingMetricPoints(toPoints(bucket)), [...LOAD_SERIES_KEYS])
      : [];
    combined = [...bucketPoints, ...toPoints(raw)];
  }

  if (combined.length <= options.maxPoints || options.maxPoints < 2) return combined;
  const times = combined.map((point) => point.time);
  const perKey = LOAD_SERIES_KEYS.map((key) => combined.map((point) => point[key]));
  const reduced = downsampleAligned(times, perKey, options.maxPoints, true);
  return reduced.times.map((time, index) => {
    const point: LoadChartPoint = { time };
    LOAD_SERIES_KEYS.forEach((key, keyIndex) => {
      point[key] = reduced.perTask[keyIndex][index] ?? null;
    });
    return point;
  });
}
