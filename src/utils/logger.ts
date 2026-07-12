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

function push(module: string, level: LogLevel, message: string, detail?: string): void {
  try {
    if (!getActivePinia()) return;
    const store = useMainStore();
    store.pushCodeLog({
      id: _nextId++,
      timestamp: new Date().toISOString(),
      module,
      level,
      message,
      detail,
    });
  } catch {
    // 日志不能反过来打断脚本初始化。
  }
}

// ── 公开 API ──

/** 记录正常事件 */
export function logInfo(module: string, message: string, detail?: string): void {
  push(module, 'info', message, detail);
}

/** 记录警告（降级、重试、非致命问题） */
export function logWarn(module: string, message: string, detail?: string): void {
  push(module, 'warn', message, detail);
}

/** 记录错误（失败、异常） */
export function logError(module: string, message: string, detail?: string): void {
  push(module, 'error', message, detail);
}
