import type { LoadRecord, NodeMetrics } from "@/types/komari";
import { formatBytes } from "@/utils/format";
import { resolveLoadRecordTotals, type LoadRecordTotalFallbacks } from "@/utils/loadMetrics";

/** 负载图表内存/磁盘曲线的单位:bytes 为实际用量(默认),percent 为百分比。 */
export type LoadChartUnit = "bytes" | "percent";

export interface LoadChartPoint {
  time: number;
  [key: string]: number | null;
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
