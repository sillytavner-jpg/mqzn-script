import { ref } from 'vue';

// 单例：基于宿主酒馆窗口宽度判断移动端，与 App.vue 的 isMobile 口径一致（<=768）。
// 脚本运行在 iframe 沙箱里，但面板 fixed 在 window.parent 上，故用宿主窗口的 matchMedia。
const isMobile = ref(false);
let initialized = false;

function ensureInit() {
  if (initialized) return;
  initialized = true;
  const host = typeof window !== 'undefined' && window.parent ? window.parent : window;
  if (!host.matchMedia) return;
  const mql = host.matchMedia('(max-width: 768px)');
  isMobile.value = mql.matches;
  const handler = (e: MediaQueryListEvent) => { isMobile.value = e.matches; };
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', handler);
  else (mql as any).addListener(handler);
}

export function useIsMobile() {
  ensureInit();
  return isMobile;
}
