/**
 * 智脑代码日志系统 — 统一日志工具
 * 
 * 替代所有裸 console.* 调用，将日志写入 mainStore.codeLogs，
 * 供设置页「代码日志」弹窗查看。不输出到浏览器控制台。
 */

import { getActivePinia } from 'pinia';
import { useMainStore } from '../stores/mainStore';

// ── 类型 ──

export type LogLevel = 'info' | 'warn' | 'error';

export interface CodeLogEntry {
  id: number;
  timestamp: string;
  module: string;
  level: LogLevel;
  message: string;
  detail?: string;
}

// ── 内部 ──

let _nextId = 1;

/**
 * 把 detail 规范化为字符串。
 * 允许调用方直接传对象/数组（此前签名是 `string`，导致 18 处传对象的调用被 TS 拒绝，
 * 且真传了对象时 `log.detail` 存进去的是对象，面板显示成 [object Object]）。
 */
function normalizeDetail(detail?: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail);
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function push(module: string, level: LogLevel, message: string, detail?: unknown): void {
  try {
    if (!getActivePinia()) return;
    const store = useMainStore();
    store.pushCodeLog({
      id: _nextId++,
      timestamp: new Date().toISOString(),
      module,
      level,
      message,
      detail: normalizeDetail(detail),
    });
  } catch {
    // 日志不能反过来打断脚本初始化。
  }
}

// ── 公开 API ──

/** 记录正常事件 */
export function logInfo(module: string, message: string, detail?: unknown): void {
  push(module, 'info', message, detail);
}

/** 记录警告（降级、重试、非致命问题） */
export function logWarn(module: string, message: string, detail?: unknown): void {
  push(module, 'warn', message, detail);
}

/** 记录错误（失败、异常） */
export function logError(module: string, message: string, detail?: unknown): void {
  push(module, 'error', message, detail);
}
