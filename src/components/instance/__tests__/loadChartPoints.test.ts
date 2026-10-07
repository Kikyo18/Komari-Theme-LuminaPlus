import { describe, expect, it } from "vitest";
import {
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
