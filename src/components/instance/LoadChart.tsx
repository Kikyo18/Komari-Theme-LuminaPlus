import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import { ArrowDown, ArrowUp, Cpu, Gauge, HardDrive, MemoryStick, Network, RefreshCw, Workflow } from "lucide-react";
import { useLoadRecords } from "@/hooks/useRecords";
import { useNodeMeta, useNodeMetrics } from "@/hooks/useNode";
import { InstancePanel, InstanceChartLoading } from "./InstancePanel";
import {
  buildChartTooltipHooks,
  buildYScale,
  CHART_PALETTE,
  createTimeAxisFormatter,
  formatChartCoverageTime,
  getAxisColors,
  pickAxisDecimals,
  toChartSeconds,
  useResponsiveChartSize,
  type ChartTooltipState,
  type YScaleOptions,
} from "./chartShared";
import { ChartTooltip, SwitchToggle } from "./ChartParts";
import {
  downsampleAligned,
  fillMissingMetricPoints,
  interpolateMetricGaps,
} from "./chartData";
import { formatBytes, formatTrafficRateLabel } from "@/utils/format";
import { historyChartRangeSeconds, historyCoverageLabel } from "@/utils/historyRange";
import { resolveLoadRecordTotals } from "@/utils/loadMetrics";
import { usePreferences } from "@/hooks/usePreferences";
import {
  formatLoadSwapLabel,
  formatLoadUsedLabel,
  loadPointFromNode,
  loadPointFromRecord,
  type LoadChartPoint,
  type LoadChartUnit,
} from "./loadChartPoints";
import type { LoadRecord } from "@/types/komari";

type ChartPoint = LoadChartPoint;

const LOAD_HISTORY_SAMPLE_LIMIT = 360;
const LOAD_HISTORY_RENDER_LIMIT = 720;
const REALTIME_HISTORY_SEED_LIMIT = 120;
const REALTIME_SAMPLE_LIMIT = 600;

const CPU_KEYS = ["cpu"];
const CPU_COLORS = [CHART_PALETTE.cpu];
const MEMORY_KEYS = ["ram", "swap"];
const MEMORY_COLORS = [CHART_PALETTE.memory, CHART_PALETTE.warning];
const DISK_KEYS = ["disk"];
const DISK_COLORS = [CHART_PALETTE.disk];
const NETWORK_KEYS = ["netIn", "netOut"];
const NETWORK_COLORS = [CHART_PALETTE.success, CHART_PALETTE.cpu];
const CONNECTION_KEYS = ["connections", "udp"];
const CONNECTION_COLORS = [CHART_PALETTE.memory, CHART_PALETTE.cpu];
const PROCESS_KEYS = ["process"];
const PROCESS_COLORS = [CHART_PALETTE.warning];
const SERIES_LABELS: Record<string, string> = {
  cpu: "CPU",
  ram: "内存",
  swap: "Swap",
  disk: "磁盘",
  netIn: "下行",
  netOut: "上行",
  connections: "TCP",
  udp: "UDP",
  process: "进程",
};
const LOAD_INTERPOLATE_KEYS = [
  "cpu",
  "ram",
  "swap",
  "disk",
  "netIn",
  "netOut",
  "connections",
  "udp",
  "process",
];

function metricData(points: ChartPoint[], keys: string[]): uPlot.AlignedData {
  const times = points.map((point) => point.time);
  return [times, ...keys.map((key) => points.map((point) => point[key] ?? null))] as uPlot.AlignedData;
}

function getHistoryRenderLimit(hours: number) {
  if (hours <= 4) return LOAD_HISTORY_SAMPLE_LIMIT;
  return LOAD_HISTORY_RENDER_LIMIT;
}

const DOWNSAMPLE_KEYS = [
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

// 走与 Ping 图同一套时间分桶保峰降采样:抽点式降采样会随机丢掉桶内尖峰,
// 而负载/网速的瞬时突刺正是最需要保留的信息。
function downsamplePoints(points: ChartPoint[], limit: number) {
  if (points.length <= limit || limit < 2) return points;

  const times = points.map((point) => point.time);
  const perKey = DOWNSAMPLE_KEYS.map((key) => points.map((point) => point[key]));
  const reduced = downsampleAligned(times, perKey, limit, true);
  return reduced.times.map((time, index) => {
    const point: ChartPoint = { time };
    DOWNSAMPLE_KEYS.forEach((key, keyIndex) => {
      point[key] = reduced.perTask[keyIndex][index] ?? null;
    });
    return point;
  });
}

function formatRangeSummary(hours: number) {
  if (hours === 0) return "实时";
  if (hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

function getSeriesLabel(key: string) {
  return SERIES_LABELS[key] ?? key;
}

function formatTooltipValue(key: string, value: number | null | undefined, unit: string) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (key === "netIn" || key === "netOut") return formatTrafficRateLabel(value);
  if (unit === "%") return `${value.toFixed(2)}%`;
  if (unit === "bytes") return formatBytes(value);
  if (key === "process" || key === "connections" || key === "udp") return `${Math.round(value)}`;
  return value.toFixed(2);
}

function formatPercentAxisValue(value: number, min: number, max: number) {
  return `${value.toFixed(pickAxisDecimals(max - min))}%`;
}

function formatNetworkAxisValue(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return formatTrafficRateLabel(value);
}

function formatBytesAxisValue(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return formatBytes(value);
}

function formatCountAxisValue(value: number, min: number, max: number) {
  return value.toFixed(pickAxisDecimals(max - min));
}

// 不含尺寸的配置。width/height 由调用方在另一个 memo 里加上，resize 时只改这两个 key，
// uplot-react 就会调 setSize() 而不是重建整个 chart。(用普通函数而非 hook——它不调任何
// hook；之前的 `use` 前缀会触发 rules-of-hooks lint。)
function buildBaseOptions({
  title,
  keys,
  colors,
  resolvedAppearance,
  rangeHours,
  spanGaps,
  axisKind,
  axisSize = 52,
  xRange,
  yScale,
}: {
  title: string;
  keys: string[];
  colors: string[];
  resolvedAppearance: "light" | "dark";
  rangeHours: number;
  spanGaps?: boolean;
  axisKind: "percent" | "bytes" | "network" | "count";
  axisSize?: number;
  xRange?: [number, number] | null;
  yScale: YScaleOptions;
}): Omit<uPlot.Options, "width" | "height"> {
  const isDark = resolvedAppearance === "dark";
  const { grid, text } = getAxisColors(isDark);

  return {
    padding: [8, 12, 10, 2],
    cursor: { drag: { x: true, y: false } },
    legend: { show: false },
    scales: {
      x: xRange ? { time: true, auto: false, range: () => xRange } : { time: true },
      y: yScale,
    },
    axes: [
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: rangeHours >= 72 ? 38 : 34,
        values: createTimeAxisFormatter(rangeHours),
      },
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: axisSize,
        values: (self, splits) => {
          const min = Number(self.scales.y.min ?? 0);
          const max = Number(self.scales.y.max ?? 0);
          return splits.map((value) => {
            if (value === 0 && axisKind !== "percent") return "";
            if (axisKind === "network") return formatNetworkAxisValue(value);
            if (axisKind === "bytes") return formatBytesAxisValue(value);
            if (axisKind === "percent") return formatPercentAxisValue(value, min, max);
            return formatCountAxisValue(value, min, max);
          });
        },
      },
    ],
    series: [
      { label: "time" },
      ...keys.map((key, index) => ({
        label: key,
        stroke: colors[index] ?? colors[0],
        fill: index === 0 ? `${colors[index] ?? colors[0]}22` : undefined,
        width: 1.6,
        spanGaps: spanGaps ?? false,
        points: { show: false },
      })),
    ],
    hooks: {
      init: [
        (u) => {
          u.root.setAttribute("role", "img");
          u.root.setAttribute("aria-label", title);
        },
      ],
    },
  };
}

const ChartCard = memo(function ChartCard({
  icon,
  title,
  value,
  note,
  uuid,
  points,
  keys,
  colors,
  resolvedAppearance,
  rangeHours,
  unit = "",
  spanGaps,
  axisKind,
  axisSize,
  xRange,
  yFixedMin,
  yFixedMax,
  yAnchorZero,
  yMinSpan,
}: {
  icon: ReactNode;
  title: string;
  value: ReactNode;
  note?: ReactNode;
  uuid: string;
  points: ChartPoint[];
  keys: string[];
  colors: string[];
  resolvedAppearance: "light" | "dark";
  rangeHours: number;
  unit?: string;
  spanGaps?: boolean;
  axisKind: "percent" | "bytes" | "network" | "count";
  axisSize?: number;
  xRange?: [number, number] | null;
  /** Y 轴量程配置;都不传时退化为带边距的 auto 行为。 */
  yFixedMin?: number;
  yFixedMax?: number;
  yAnchorZero?: boolean;
  yMinSpan?: number;
}) {
  const { w, h, ref: chartSizeRef } = useResponsiveChartSize("grid");
  const dataRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<ChartTooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const data = useMemo(() => metricData(points, keys), [points, keys]);
  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);
  const yScale = useMemo<YScaleOptions>(
    () =>
      buildYScale(
        yFixedMin != null && yFixedMax != null
          ? { fixed: [yFixedMin, yFixedMax] }
          : { anchorZero: yAnchorZero, minSpan: yMinSpan },
      ),
    [yFixedMin, yFixedMax, yAnchorZero, yMinSpan],
  );

  const baseOptions = useMemo(
    () =>
      buildBaseOptions({
        title,
        keys,
        colors,
        resolvedAppearance,
        rangeHours,
        spanGaps,
        axisKind,
        axisSize,
        xRange,
        yScale,
      }),
    [
      axisKind,
      axisSize,
      colors,
      keys,
      rangeHours,
      resolvedAppearance,
      spanGaps,
      title,
      xRange,
      yScale,
    ],
  );

  const enhancedOptions = useMemo<Omit<uPlot.Options, "width" | "height">>(() => {
    const tooltip = buildChartTooltipHooks({
      dataRef,
      rangeHours,
      estimatedWidth: 176,
      setTooltip,
      buildRows: (idx) =>
        keys.map((key, keyIndex) => ({
          label: getSeriesLabel(key),
          value: formatTooltipValue(
            key,
            dataRef.current[keyIndex + 1]?.[idx] as number | null | undefined,
            unit,
          ),
          color: colors[keyIndex] ?? colors[0],
        })),
    });
    return {
      ...baseOptions,
      hooks: {
        ...baseOptions.hooks,
        init: [...(baseOptions.hooks?.init ?? []), tooltip.onInit],
        destroy: [...(baseOptions.hooks?.destroy ?? []), tooltip.onDestroy],
        setCursor: [tooltip.onSetCursor],
      },
    };
  }, [colors, keys, baseOptions, rangeHours, unit]);

  const chartOptions = useMemo<uPlot.Options>(
    () => ({ ...enhancedOptions, width: w, height: h }) as uPlot.Options,
    [enhancedOptions, w, h],
  );

  return (
    <div
      className="instance-chart-card"
      style={{ "--chart-accent": colors[0] } as CSSProperties}
    >
      <header className="instance-chart-card-head">
        <div className="instance-panel-subhead">
          {icon}
          <span>{title}</span>
        </div>
        <div className="instance-series-stats">
          <span className="tabular">{value}</span>
          {note != null && <span className="tabular text-[var(--text-tertiary)]">{note}</span>}
        </div>
      </header>
      <div ref={chartSizeRef} className="instance-uplot-wrap">
        <UplotReact
          key={`${uuid}-${rangeHours}`}
          options={chartOptions}
          data={data}
          resetScales={rangeHours === 0}
        />
        <ChartTooltip tooltip={tooltip} />
      </div>
    </div>
  );
});

export function LoadChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const queryHours = hours === 0 ? 1 : hours;
  const { data, isError, isFetching, isLoading, refetch } = useLoadRecords(
    uuid,
    queryHours,
    active,
  );
  const isRealtime = hours === 0;
  const node = useNodeMetrics(uuid, isRealtime && active);
  const meta = useNodeMeta(uuid);
  const { resolvedAppearance } = usePreferences();
  const [realtimePoints, setRealtimePoints] = useState<ChartPoint[]>([]);
  const [connectNulls, setConnectNulls] = useState(false);
  // 默认按实际用量(字节)画内存/磁盘曲线;打开后换算成百分比。
  const [showPercent, setShowPercent] = useState(false);
  const loadUnit: LoadChartUnit = showPercent ? "percent" : "bytes";
  const totalFallbacks = useMemo(
    () => ({
      ramTotal: meta?.mem_total,
      swapTotal: meta?.swap_total,
      diskTotal: meta?.disk_total,
    }),
    [meta?.disk_total, meta?.mem_total, meta?.swap_total],
  );

  useEffect(() => {
    if (!active || !isRealtime || !node) return;
    const point = loadPointFromNode(node, loadUnit);
    setRealtimePoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.abs(last.time - point.time) < 1) return prev;
      return [...prev, point].slice(-REALTIME_SAMPLE_LIMIT);
    });
  }, [active, isRealtime, node, loadUnit]);

  useEffect(() => {
    setRealtimePoints([]);
  }, [hours, uuid, loadUnit]);

  const historyRecords = useMemo<Array<{ record: LoadRecord; time: number }>>(
    () =>
      (data?.records ?? [])
        .map((record) => ({ record, time: toChartSeconds(record.time) }))
        .filter(({ time }) => time > 0)
        .sort((left, right) => left.time - right.time),
    [data],
  );

  const historyPoints = useMemo<ChartPoint[]>(() => {
    const rawPoints = historyRecords.map(({ record, time }) =>
      loadPointFromRecord(record, time, totalFallbacks, loadUnit),
    );
    const sampled = downsamplePoints(rawPoints, getHistoryRenderLimit(hours));
    const filled = fillMissingMetricPoints(sampled);
    return interpolateMetricGaps(filled, LOAD_INTERPOLATE_KEYS) as ChartPoint[];
  }, [historyRecords, hours, totalFallbacks, loadUnit]);

  const points = useMemo<ChartPoint[]>(() => {
    if (isRealtime) {
      const initial = historyPoints.slice(-REALTIME_HISTORY_SEED_LIMIT);
      const merged = [...initial, ...realtimePoints].sort((a, b) => a.time - b.time);
      const deduped = merged.filter((point, index, arr) => {
        const next = arr[index + 1];
        return !next || Math.abs(next.time - point.time) >= 1;
      });
      return deduped.slice(-REALTIME_SAMPLE_LIMIT);
    }
    return historyPoints;
  }, [historyPoints, isRealtime, realtimePoints]);

  const rangeSummary = formatRangeSummary(hours);
  // API 各回退路径不保证返回顺序,最新值必须取自按时间排好序的 historyRecords。
  const latestHistoryRecord = historyRecords[historyRecords.length - 1]?.record;
  const latestHistoryTotals = latestHistoryRecord
    ? resolveLoadRecordTotals(latestHistoryRecord, totalFallbacks)
    : null;
  const sourceRecordCount = historyRecords.length;
  const wasDownsampled = !isRealtime && sourceRecordCount > getHistoryRenderLimit(hours);
  const sampleSummary = isRealtime
    ? `${points.length} 个点`
    : wasDownsampled
      ? `${points.length} / ${sourceRecordCount} 个点`
      : `${points.length} 个点`;
  const coverageSummary = points.length
    ? `${formatChartCoverageTime(points[0].time)} - ${formatChartCoverageTime(points[points.length - 1].time)}`
    : "—";
  const requestedXRange = useMemo(
    () => (isRealtime ? null : historyChartRangeSeconds(data)),
    [data, isRealtime],
  );
  const coverageLabel = useMemo(
    () =>
      isRealtime
        ? null
        : historyCoverageLabel(data, points[0]?.time, points[points.length - 1]?.time),
    [data, isRealtime, points],
  );
  // 磁盘字节模式用容量做固定量程(0 基准);拿不到总量时退回 0 基准 auto。
  const diskTotalForAxis = latestHistoryTotals?.diskTotal || totalFallbacks.diskTotal || 0;
  // 内存/磁盘是容量指标:百分比模式固定 0-100,避免 auto 轴把零点几个百分点的波动
  // 放大成整幅图(刻度文字也会随之重合);字节模式用 0 基准,磁盘再以容量封顶。
  const memoryYProps = showPercent
    ? { yFixedMin: 0, yFixedMax: 100 }
    : { yAnchorZero: true };
  const diskYProps = showPercent
    ? { yFixedMin: 0, yFixedMax: 100 }
    : diskTotalForAxis > 0
      ? { yFixedMin: 0, yFixedMax: diskTotalForAxis }
      : { yAnchorZero: true };

  if (isLoading) {
    return <InstanceChartLoading title="负载图表" />;
  }

  if (isError && !points.length) {
    return (
      <InstancePanel title="负载图表">
        <div className="instance-empty">
          <span>负载历史加载失败</span>
          <button
            type="button"
            className="instance-toggle-button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            {isFetching ? "重试中" : "重试"}
          </button>
        </div>
      </InstancePanel>
    );
  }

  if (!points.length) {
    return (
      <InstancePanel title="负载图表">
        <div className="instance-empty">暂无负载历史数据</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel
      title="负载图表"
      aside={
        <div className="instance-chart-headmeta">
          <div className="instance-chart-meta" aria-label="图表数据范围">
            <span title={coverageSummary}>
              <strong>{coverageLabel ?? `覆盖 ${coverageSummary}`}</strong>
            </span>
            <span>
              采样 <strong>{sampleSummary}</strong>
            </span>
          </div>
          <SwitchToggle
            label="断点连线"
            active={connectNulls}
            onToggle={() => setConnectNulls((value) => !value)}
          />
          <SwitchToggle
            label="内存/磁盘百分比"
            title="开启后内存与磁盘曲线按百分比显示,关闭时按实际用量(字节)显示"
            active={showPercent}
            onToggle={() => setShowPercent((value) => !value)}
          />
          <button
            type="button"
            className="instance-toggle-button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            <RefreshCw size={14} aria-hidden />
            {isFetching ? "刷新中" : "刷新"}
          </button>
          <span className="instance-chart-range-chip">{rangeSummary}</span>
        </div>
      }
      className="instance-chart-panel"
    >
      <div className="instance-chart-grid">
        <ChartCard
          icon={<Cpu size={13} />}
          title="CPU"
          uuid={uuid}
          value={
            isRealtime && node
              ? `${node.cpuPct.toFixed(2)}%`
              : `${(points[points.length - 1]?.cpu ?? 0).toFixed(2)}%`
          }
          note="使用率"
          points={points}
          keys={CPU_KEYS}
          colors={CPU_COLORS}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
          xRange={requestedXRange}
          yAnchorZero
          yMinSpan={5}
        />
        <ChartCard
          key={`memory-${uuid}-${hours}-${showPercent ? "percent" : "bytes"}`}
          icon={<MemoryStick size={13} />}
          title="内存"
          uuid={uuid}
          value={
            isRealtime && node
              ? formatLoadUsedLabel(loadUnit, node.ramUsed, node.ramTotal)
              : latestHistoryRecord && latestHistoryTotals
                ? formatLoadUsedLabel(loadUnit, latestHistoryRecord.ram, latestHistoryTotals.ramTotal)
                : "—"
          }
          note={
            isRealtime && node
              ? formatLoadSwapLabel(loadUnit, node.swapUsed, node.swapTotal)
              : latestHistoryRecord && latestHistoryTotals
                ? formatLoadSwapLabel(loadUnit, latestHistoryRecord.swap, latestHistoryTotals.swapTotal)
                : "Swap 无"
          }
          points={points}
          keys={MEMORY_KEYS}
          colors={MEMORY_COLORS}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit={showPercent ? "%" : "bytes"}
          spanGaps={connectNulls}
          axisKind={showPercent ? "percent" : "bytes"}
          axisSize={showPercent ? undefined : 78}
          xRange={requestedXRange}
          {...memoryYProps}
        />
        <ChartCard
          key={`disk-${uuid}-${hours}-${showPercent ? "percent" : "bytes"}`}
          icon={<HardDrive size={13} />}
          title="磁盘"
          uuid={uuid}
          value={
            isRealtime && node
              ? formatLoadUsedLabel(loadUnit, node.diskUsed, node.diskTotal)
              : latestHistoryRecord && latestHistoryTotals
                ? formatLoadUsedLabel(loadUnit, latestHistoryRecord.disk, latestHistoryTotals.diskTotal)
                : "—"
          }
          note="已用空间"
          points={points}
          keys={DISK_KEYS}
          colors={DISK_COLORS}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit={showPercent ? "%" : "bytes"}
          spanGaps={connectNulls}
          axisKind={showPercent ? "percent" : "bytes"}
          axisSize={showPercent ? undefined : 78}
          xRange={requestedXRange}
          {...diskYProps}
        />
        <ChartCard
          icon={<Network size={13} />}
          title="网络"
          uuid={uuid}
          value={
            isRealtime && node
              ? `${formatTrafficRateLabel(node.netDown)} / ${formatTrafficRateLabel(node.netUp)}`
              : latestHistoryRecord
                ? `${formatTrafficRateLabel(latestHistoryRecord.net_in ?? 0)} / ${formatTrafficRateLabel(latestHistoryRecord.net_out ?? 0)}`
                : "—"
          }
          note={
            <span className="instance-overview-multi">
              <span className="inline-flex items-center gap-1"><ArrowDown size={11} />{isRealtime && node ? formatBytes(node.trafficDown) : latestHistoryRecord ? formatBytes(latestHistoryRecord.net_total_down ?? 0) : "—"}</span>
              <span className="inline-flex items-center gap-1"><ArrowUp size={11} />{isRealtime && node ? formatBytes(node.trafficUp) : latestHistoryRecord ? formatBytes(latestHistoryRecord.net_total_up ?? 0) : "—"}</span>
            </span>
          }
          points={points}
          keys={NETWORK_KEYS}
          colors={NETWORK_COLORS}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="network"
          axisSize={78}
          xRange={requestedXRange}
          yAnchorZero
        />
        <ChartCard
          icon={<Workflow size={13} />}
          title="连接数"
          uuid={uuid}
          value={
            isRealtime && node
              ? `TCP ${node.connectionsTcp} / UDP ${node.connectionsUdp}`
              : latestHistoryRecord
                ? `TCP ${Math.round(latestHistoryRecord.connections ?? 0)} / UDP ${Math.round(latestHistoryRecord.connections_udp ?? 0)}`
                : "—"
          }
          note="连接"
          points={points}
          keys={CONNECTION_KEYS}
          colors={CONNECTION_COLORS}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="count"
          xRange={requestedXRange}
          yAnchorZero
        />
        <ChartCard
          icon={<Gauge size={13} />}
          title="进程"
          uuid={uuid}
          value={
            isRealtime && node
              ? node.process.toString()
              : latestHistoryRecord
                ? Math.round(latestHistoryRecord.process ?? 0).toString()
                : "—"
          }
          note={
            isRealtime && node
              ? `负载 ${node.load1.toFixed(2)} | ${node.load5.toFixed(2)} | ${node.load15.toFixed(2)}`
              : latestHistoryRecord
                ? `负载 ${(latestHistoryRecord.load ?? 0).toFixed(2)}`
                : "—"
          }
          points={points}
          keys={PROCESS_KEYS}
          colors={PROCESS_COLORS}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="count"
          xRange={requestedXRange}
          yAnchorZero
        />
      </div>
    </InstancePanel>
  );
}
