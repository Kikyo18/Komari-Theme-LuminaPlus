import { describe, expect, it } from "vitest";
import {
  buildLoadSeedPoints,
  formatLoadSwapLabel,
  formatLoadUsedLabel,
  loadPointFromNode,
  loadPointFromRecord,
  type NodeLoadSnapshot,
} from "@/components/instance/loadChartPoints";
import type { LoadRecord } from "@/types/komari";

const GIB = 1024 ** 3;

function nodeSnapshot(overrides: Partial<NodeLoadSnapshot> = {}): NodeLoadSnapshot {
  return {
    cpuPct: 12.5,
    ramUsed: 2 * GIB,
    ramTotal: 8 * GIB,
    swapUsed: GIB,
    swapTotal: 2 * GIB,
    diskUsed: 40 * GIB,
    diskTotal: 160 * GIB,
    netDown: 1024,
    netUp: 2048,
    connectionsTcp: 10,
    connectionsUdp: 3,
    process: 42,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function loadRecord(overrides: Partial<LoadRecord> = {}): LoadRecord {
  return {
    cpu: 30,
    gpu: 0,
    ram: 3 * GIB,
    ram_total: 0,
    swap: GIB,
    swap_total: 0,
    load: 1.5,
    temp: 0,
    disk: 80 * GIB,
    disk_total: 0,
    net_in: 4096,
    net_out: 8192,
    net_total_up: 0,
    net_total_down: 0,
    process: 100,
    connections: 20,
    connections_udp: 5,
    time: "2026-01-01T00:00:00Z",
    client: "node-a",
    ...overrides,
  };
}

describe("loadPointFromNode", () => {
  it("computes percentages when the unit is percent", () => {
    const point = loadPointFromNode(nodeSnapshot(), "percent");

    expect(point.time).toBe(1_700_000_000);
    expect(point.cpu).toBe(12.5);
    expect(point.ram).toBeCloseTo(25, 10);
    expect(point.swap).toBeCloseTo(50, 10);
    expect(point.disk).toBeCloseTo(25, 10);
    expect(point.netIn).toBe(1024);
    expect(point.netOut).toBe(2048);
    expect(point.connections).toBe(10);
    expect(point.udp).toBe(3);
    expect(point.process).toBe(42);
  });

  it("keeps raw byte values when the unit is bytes", () => {
    const point = loadPointFromNode(nodeSnapshot(), "bytes");

    expect(point.ram).toBe(2 * GIB);
    expect(point.swap).toBe(GIB);
    expect(point.disk).toBe(40 * GIB);
  });

  it("returns null for absent metrics (no swap) in both units", () => {
    const node = nodeSnapshot({ swapUsed: 0, swapTotal: 0 });

    expect(loadPointFromNode(node, "percent").swap).toBeNull();
    expect(loadPointFromNode(node, "bytes").swap).toBeNull();
  });

  it("keeps used bytes without a known total but cannot compute percent", () => {
    const node = nodeSnapshot({ ramUsed: 2 * GIB, ramTotal: 0 });

    expect(loadPointFromNode(node, "bytes").ram).toBe(2 * GIB);
    expect(loadPointFromNode(node, "percent").ram).toBeNull();
  });

  it("plots genuine zero usage when the metric exists", () => {
    const node = nodeSnapshot({ ramUsed: 0, ramTotal: 8 * GIB });

    expect(loadPointFromNode(node, "bytes").ram).toBe(0);
    expect(loadPointFromNode(node, "percent").ram).toBe(0);
  });
});

describe("loadPointFromRecord", () => {
  it("prefers totals saved in the record for percent conversion", () => {
    const record = loadRecord({ ram_total: 4 * GIB });

    expect(loadPointFromRecord(record, 100, {}, "percent").ram).toBeCloseTo(75, 10);
  });

  it("falls back to node meta totals when the record has none", () => {
    const record = loadRecord({ ram_total: 0 });

    expect(
      loadPointFromRecord(record, 100, { ramTotal: 12 * GIB }, "percent").ram,
    ).toBeCloseTo(25, 10);
  });

  it("returns raw bytes in bytes mode even when totals are missing", () => {
    const point = loadPointFromRecord(loadRecord(), 100, {}, "bytes");

    expect(point.ram).toBe(3 * GIB);
    expect(point.swap).toBe(GIB);
    expect(point.disk).toBe(80 * GIB);
  });

  it("returns null in percent mode when no total is available", () => {
    expect(loadPointFromRecord(loadRecord(), 100, {}, "percent").ram).toBeNull();
  });
});

describe("formatLoadUsedLabel", () => {
  it("shows used/total bytes in bytes mode", () => {
    expect(formatLoadUsedLabel("bytes", 2 * GIB, 8 * GIB)).toBe("2.00 GB / 8.00 GB");
  });

  it("shows usage percent in percent mode and a dash without a total", () => {
    expect(formatLoadUsedLabel("percent", 2 * GIB, 8 * GIB)).toBe("25.00%");
    expect(formatLoadUsedLabel("percent", 2 * GIB, 0)).toBe("—");
  });
});

describe("formatLoadSwapLabel", () => {
  it("reports absent swap", () => {
    expect(formatLoadSwapLabel("bytes", 0, 0)).toBe("Swap 无");
    expect(formatLoadSwapLabel("percent", 0, 0)).toBe("Swap 无");
  });

  it("formats swap in the active unit", () => {
    expect(formatLoadSwapLabel("bytes", GIB, 2 * GIB)).toBe("Swap 1.00 GB / 2.00 GB");
    expect(formatLoadSwapLabel("percent", GIB, 2 * GIB)).toBe("Swap 50.00%");
  });
});

describe("buildLoadSeedPoints", () => {
  const BASE_SEC = 1_800_000_000;
  const at = (offsetSec: number) => new Date((BASE_SEC + offsetSec) * 1000).toISOString();
  const seedRecord = (offsetSec: number, cpu: number): LoadRecord =>
    loadRecord({ cpu, time: at(offsetSec), ram: 4 * GIB, ram_total: 0 });

  const options = (overrides: Partial<Parameters<typeof buildLoadSeedPoints>[1]> = {}) => ({
    rawStartSec: BASE_SEC + 180,
    fallbacks: { ramTotal: 8 * GIB, swapTotal: 2 * GIB, diskTotal: 160 * GIB },
    unit: "bytes" as const,
    maxPoints: 360,
    ...overrides,
  });

  it("合并桶段与原始段,按时间排序且不越段插值", () => {
    const records = [
      seedRecord(0, 10),
      seedRecord(60, 20),
      seedRecord(120, 30),
      seedRecord(185, 40),
      seedRecord(190, 50),
      seedRecord(195, 60),
    ];
    const points = buildLoadSeedPoints(records, options());

    expect(points.map((point) => point.time)).toEqual([
      BASE_SEC,
      BASE_SEC + 60,
      BASE_SEC + 120,
      BASE_SEC + 185,
      BASE_SEC + 190,
      BASE_SEC + 195,
    ]);
    expect(points.map((point) => point.cpu)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("桶段缺失的分钟会被补洞插值桥接,原始段的缺口保持原样", () => {
    const records = [
      seedRecord(0, 10),
      seedRecord(60, 20),
      seedRecord(120, 30),
      seedRecord(240, 50), // 缺 +180 的桶
      seedRecord(305, 60),
      seedRecord(315, 70), // 原始段缺 +310 的样本
    ];
    const points = buildLoadSeedPoints(records, options({ rawStartSec: BASE_SEC + 300 }));

    // 桶段补洞:+180 处被插入并桥接(值在 30 与 50 之间)
    const bridged = points.find((point) => point.time === BASE_SEC + 180);
    expect(bridged).toBeDefined();
    expect(bridged?.cpu).toBeGreaterThan(30);
    expect(bridged?.cpu).toBeLessThan(50);
    // 原始段不补洞:+310 处没有点
    expect(points.some((point) => point.time === BASE_SEC + 310)).toBe(false);
  });

  it("桶段为空时直接使用原始段", () => {
    const points = buildLoadSeedPoints(
      [seedRecord(185, 40), seedRecord(190, 50)],
      options(),
    );

    expect(points.map((point) => point.time)).toEqual([BASE_SEC + 185, BASE_SEC + 190]);
  });

  it("原始段为空时只输出桶段", () => {
    const points = buildLoadSeedPoints(
      [seedRecord(0, 10), seedRecord(60, 20)],
      options(),
    );

    expect(points.map((point) => point.time)).toEqual([BASE_SEC, BASE_SEC + 60]);
  });

  it("rawStartSec 为空时全部按桶段处理(旧后端兼容路径)", () => {
    const points = buildLoadSeedPoints(
      [seedRecord(0, 10), seedRecord(60, 20), seedRecord(120, 30)],
      options({ rawStartSec: null }),
    );

    expect(points).toHaveLength(3);
  });

  it("记录为空时返回空数组", () => {
    expect(buildLoadSeedPoints([], options())).toEqual([]);
  });

  it("超过渲染上限时降采样", () => {
    const records = Array.from({ length: 40 }, (_, index) => seedRecord(index * 5, index));

    expect(buildLoadSeedPoints(records, options({ maxPoints: 8 })).length).toBeLessThanOrEqual(8);
  });
});
