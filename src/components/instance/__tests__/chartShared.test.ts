import { describe, expect, it } from "vitest";
import {
  buildLoadTimeRangeOptions,
  buildPingTimeRangeOptions,
  buildYScale,
  pickAxisDecimals,
} from "@/components/instance/chartShared";

describe("detail chart time ranges", () => {
  it("keeps Ping limited to 1h, 4h, 1d and 7d even with 90 days retained", () => {
    expect(buildPingTimeRangeOptions(90 * 24)).toEqual([
      { label: "1 小时", value: 1 },
      { label: "4 小时", value: 4 },
      { label: "1 天", value: 24 },
      { label: "7 天", value: 168 },
    ]);
  });

  it("keeps load history capped at 30 days even with 90 days retained", () => {
    expect(buildLoadTimeRangeOptions(90 * 24)).toEqual([
      { label: "实时", value: 0 },
      { label: "1 小时", value: 1 },
      { label: "4 小时", value: 4 },
      { label: "1 天", value: 24 },
      { label: "7 天", value: 168 },
      { label: "30 天", value: 720 },
    ]);
  });
});

describe("buildYScale", () => {
  it("uses a hard fixed range when provided", () => {
    const scale = buildYScale({ fixed: [0, 100] });

    expect(scale).toEqual({ auto: false, range: [0, 100] });
  });

  it("anchors quasi-static capacity data at zero without padding below", () => {
    const scale = buildYScale({ anchorZero: true });
    const range = scale.auto
      ? scale.range(null as never, 71.527, 71.535)
      : ([0, 0] as [number, number]);

    expect(range[0]).toBe(0);
    // 12% padding 只加在上方,数据保持在 0 基准之上。
    expect(range[1]).toBeCloseTo(71.535 * 1.12, 6);
  });

  it("expands to minSpan toward zero for data hugging the baseline", () => {
    const scale = buildYScale({ anchorZero: true, minSpan: 5 });
    const range = scale.auto
      ? scale.range(null as never, 0.7, 0.8)
      : ([0, 0] as [number, number]);

    expect(range[0]).toBe(0);
    expect(range[1]).toBeCloseTo(5 * 1.12, 6);
  });

  it("expands centered without anchorZero", () => {
    const scale = buildYScale({ minSpan: 10 });
    const range = scale.auto
      ? scale.range(null as never, 104, 106)
      : ([0, 0] as [number, number]);

    expect(range[0]).toBeCloseTo(105 - 5 - 10 * 0.12, 6);
    expect(range[1]).toBeCloseTo(105 + 5 + 10 * 0.12, 6);
  });

  it("keeps data above 100% visible when minSpan is 100", () => {
    const scale = buildYScale({ anchorZero: true, minSpan: 100 });
    const range = scale.auto
      ? scale.range(null as never, 71.5, 71.6)
      : ([0, 0] as [number, number]);

    expect(range[0]).toBe(0);
    expect(range[1]).toBeCloseTo(100 * 1.12, 6);
  });

  it("keeps negative data below zero even with anchorZero", () => {
    const scale = buildYScale({ anchorZero: true });
    const range = scale.auto
      ? scale.range(null as never, -3, 2)
      : ([0, 0] as [number, number]);

    expect(range[0]).toBe(-3);
  });

  it("falls back to a safe range for non-finite inputs", () => {
    const scale = buildYScale({});
    const range = scale.auto
      ? scale.range(null as never, Number.NaN, Number.NaN)
      : ([0, 0] as [number, number]);

    expect(range).toEqual([0, 0]);
  });
});

describe("pickAxisDecimals", () => {
  it("scales decimals down as the span grows", () => {
    expect(pickAxisDecimals(100)).toBe(0);
    expect(pickAxisDecimals(25)).toBe(0);
    expect(pickAxisDecimals(5)).toBe(0);
    expect(pickAxisDecimals(4.9)).toBe(1);
    expect(pickAxisDecimals(0.5)).toBe(1);
    expect(pickAxisDecimals(0.49)).toBe(2);
    expect(pickAxisDecimals(0.05)).toBe(2);
    expect(pickAxisDecimals(0.007)).toBe(3);
  });

  it("treats non-finite spans as tiny", () => {
    expect(pickAxisDecimals(Number.NaN)).toBe(3);
  });
});
