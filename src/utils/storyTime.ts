/**
 * 剧情时间工具
 *
 * 统一格式：X年Y月Z日HH:MM（24小时制，阿拉伯数字）
 * 负责解析、归一化、排序各种剧情时间表达。
 */

export interface StoryTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** 古代时辰 → 代表时刻（取中间值） */
const SHICHEN_MAP: Record<string, string> = {
  '子时': '00:00',
  '丑时': '02:00',
  '寅时': '04:00',
  '卯时': '06:00',
  '辰时': '08:00',
  '巳时': '10:00',
  '午时': '12:00',
  '未时': '14:00',
  '申时': '16:00',
  '酉时': '18:00',
  '戌时': '20:00',
  '亥时': '22:00',
};

/** 旧标准时段 → 代表时刻 */
const PERIOD_MAP: Record<string, string> = {
  '晨': '06:00',
  '上午': '09:00',
  '午': '12:00',
  '下午': '15:00',
  '暮': '18:00',
  '夜': '21:00',
  '深夜': '00:00',
};

function expandTimeSuffix(time: string): string {
  let result = time;

  // 古代时辰
  for (const [sc, hm] of Object.entries(SHICHEN_MAP)) {
    if (result.includes(sc)) {
      result = result.replace(sc, hm);
      break; // 只处理一个时辰
    }
  }

  // 标准时段（仅在没有具体 HH:MM 时才替换）
  if (!/\d{1,2}:\d{2}/.test(result)) {
    for (const [period, hm] of Object.entries(PERIOD_MAP)) {
      if (result.includes(period)) {
        result = result.replace(period, hm);
        break;
      }
    }
  }

  return result;
}

/**
 * 解析剧情时间字符串
 * 支持：2025年2月5日08:30、2025年2月5日子时、2月5日、仅有时辰等
 */
export function parseStoryTime(time: string): StoryTime | null {
  if (!time || typeof time !== 'string') return null;

  const expanded = expandTimeSuffix(time.trim());

  // 尝试匹配 年 月 日 时:分
  const fullMatch = expanded.match(/(\d+)年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (fullMatch) {
    return {
      year: parseInt(fullMatch[1], 10),
      month: parseInt(fullMatch[2], 10),
      day: parseInt(fullMatch[3], 10),
      hour: parseInt(fullMatch[4], 10),
      minute: parseInt(fullMatch[5], 10),
    };
  }

  // 匹配 年 月 日（缺时分）
  const dateMatch = expanded.match(/(\d+)年(\d{1,2})月(\d{1,2})日/);
  if (dateMatch) {
    return {
      year: parseInt(dateMatch[1], 10),
      month: parseInt(dateMatch[2], 10),
      day: parseInt(dateMatch[3], 10),
      hour: 0,
      minute: 0,
    };
  }

  // 兜底：尝试 HH:MM 单独出现（缺日期）
  const hmMatch = expanded.match(/(\d{1,2}):(\d{2})/);
  if (hmMatch) {
    return {
      year: 0,
      month: 1,
      day: 1,
      hour: parseInt(hmMatch[1], 10),
      minute: parseInt(hmMatch[2], 10),
    };
  }

  // 仅有时辰/时段，缺日期
  for (const [sc, hm] of Object.entries(SHICHEN_MAP)) {
    if (expanded.includes(hm) || expanded.includes(sc)) {
      const [h, m] = hm.split(':').map(Number);
      return { year: 0, month: 1, day: 1, hour: h, minute: m };
    }
  }

  return null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** 将 StoryTime 格式化为标准字符串 */
export function formatStoryTime(t: StoryTime): string {
  return `${t.year}年${t.month}月${t.day}日${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * 归一化任意剧情时间字符串为标准格式
 * 解析失败则原样返回（便于排查）
 */
export function normalizeStoryTime(time: string): string {
  const parsed = parseStoryTime(time);
  if (!parsed) return time;
  return formatStoryTime(parsed);
}

/** 把剧情时间转为可比较的数字键 */
function timeKey(t: StoryTime): number {
  return t.year * 100000000 + t.month * 1000000 + t.day * 10000 + t.hour * 100 + t.minute;
}

/** 比较两个剧情时间字符串，用于 Array.sort */
export function compareStoryTime(a: string, b: string): number {
  const ta = parseStoryTime(a);
  const tb = parseStoryTime(b);
  if (!ta && !tb) return a.localeCompare(b);
  if (!ta) return 1;
  if (!tb) return -1;
  return timeKey(ta) - timeKey(tb);
}

/**
 * 判断时间字符串是否有效（能解析出至少日期或时辰）
 */
export function isValidStoryTime(time: string): boolean {
  return parseStoryTime(time) !== null;
}
