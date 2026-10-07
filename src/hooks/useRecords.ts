import { useQuery } from "@tanstack/react-query";
import { getLoadRealtimeSeed, getLoadRecords, getPingRecords } from "@/services/api";

const RECORD_QUERY_OPTIONS = {
  staleTime: 300_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function useLoadRecords(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "load", uuid, hours],
    queryFn: ({ signal }) => getLoadRecords(uuid, hours, { signal }),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}

// 实时模式种子:20 分钟 1 分钟桶 + 10 分钟原始样本。打开页面时取一次,
// 之后曲线由 wsStore 的瞬时点接续;手动刷新(按钮)会重新拉取窗口。
export function useLoadRealtimeSeed(uuid: string, enabled = true) {
  return useQuery({
    queryKey: ["records", "load-realtime-seed", uuid],
    queryFn: ({ signal }) => getLoadRealtimeSeed(uuid, { signal }),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}

// stats 已并入 getPingRecords 的同一次请求(response.stats),不再单独发起查询。
export function usePingRecords(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "ping", uuid, hours],
    queryFn: ({ signal }) => getPingRecords(uuid, hours, { signal }),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}
