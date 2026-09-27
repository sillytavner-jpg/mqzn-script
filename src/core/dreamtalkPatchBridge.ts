/**
 * patch ↔ 梦呓桥接
 *
 * 梦呓原本输出的是 `---KEY---` 分隔的 7 段自由文本，解析器是一行行抠的。
 * 改成 patch 后，这里**只做「数组/对象 → 中间形状」的搬运，不重写文本解析** ——
 * 行为行（`A = B | C`）原样交给 dreamtalk 现有的 parseEntryLine 处理，零重复实现。
 *
 * 路径设计（中文 key 方便模型书写，本模块负责翻译成内部字段名）：
 *   /dream/playStyle                     → 字符串
 *   /dream/userInfo                      → {基本信息, 外貌特征, 背景设定, 关系设定}
 *   /dream/personality                   → {底色, 主色调, 点缀, 衍生[], 边界}
 *   /dream/bodyContact                   → ["行为 = 含义 | 禁止误读", ...]
 *   /dream/speechStyle                   → 同上
 *   /dream/emotion                       → {开心: "表现 | 禁止误读", ...}
 *   /dream/char/{角色名}                  → ["靠近时: 行为 | 禁止误读", ...]
 *   /dream/roll                          → {不喜欢, 喜欢}
 *
 * 零依赖，可裸测。
 */

export interface PatchLike {
  op: string;
  path: string;
  value?: unknown;
}

export interface DreamtalkPatchParts {
  playStyle?: string;
  userInfo?: { basic?: string; appearance?: string; background?: string; relationship?: string };
  personality?: { baseColor?: string; mainColor?: string; accent?: string; derivations?: string[]; boundary?: string };
  /** 原始文本行，交给 dreamtalk 的 parseEntryLine 复用解析 */
  bodyContact?: string[];
  speechStyle?: string[];
  emotion?: Record<string, string>;
  /** 角色名 → 原始文本行 */
  characters?: Record<string, string[]>;
  roll?: { dislikes?: string; likes?: string };
}

function asObject(v: unknown): Record<string, any> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;
}
function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : null;
}
function isDeleteOp(op: string): boolean {
  const v = String(op || '').trim().toLowerCase();
  return v === 'del' || v === 'delete' || v === 'remove';
}
function pick(obj: Record<string, any>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

export function patchToDreamtalkParts(ops: PatchLike[]): { parts: DreamtalkPatchParts | null; errors: string[] } {
  const parts: DreamtalkPatchParts = {};
  const errors: string[] = [];
  const list = Array.isArray(ops) ? ops : [];
  let hit = 0;

  for (const raw of list) {
    if (!raw || typeof raw.path !== 'string' || isDeleteOp(raw.op)) {
      if (raw && typeof raw.path === 'string' && isDeleteOp(raw.op)) continue;
      errors.push('条目结构非法');
      continue;
    }

    const segs = raw.path.split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length < 2 || segs[0] !== 'dream') {
      errors.push(`非梦呓路径: ${raw.path}`);
      continue;
    }
    const field = segs[1];

    // /dream/char/{角色名}
    if (field === 'char') {
      const who = segs[2];
      if (!who) { errors.push(`缺角色名: ${raw.path}`); continue; }
      const arr = asStringArray(raw.value);
      if (!arr) { errors.push(`角色互动应为字符串数组: ${raw.path}`); continue; }
      parts.characters = parts.characters || {};
      parts.characters[who] = arr;
      hit++;
      continue;
    }

    const obj = asObject(raw.value);

    switch (field) {
      case 'playStyle': {
        const v = typeof raw.value === 'string' ? raw.value : (obj && pick(obj, ['value', '游玩类型']));
        if (!v) { errors.push(`playStyle 应为字符串: ${raw.path}`); continue; }
        parts.playStyle = v;
        hit++;
        break;
      }
      case 'userInfo': {
        if (!obj) { errors.push(`userInfo 应为对象: ${raw.path}`); continue; }
        parts.userInfo = {
          basic: pick(obj, ['基本信息', 'basic']),
          appearance: pick(obj, ['外貌特征', 'appearance']),
          background: pick(obj, ['背景设定', 'background']),
          relationship: pick(obj, ['关系设定', 'relationship']),
        };
        hit++;
        break;
      }
      case 'personality': {
        if (!obj) { errors.push(`personality 应为对象: ${raw.path}`); continue; }
        parts.personality = {
          baseColor: pick(obj, ['底色', 'baseColor']),
          mainColor: pick(obj, ['主色调', 'mainColor']),
          accent: pick(obj, ['点缀', 'accent']),
          derivations: asStringArray(obj['衍生'] || obj['derivations']) || [],
          boundary: pick(obj, ['边界', 'boundary']),
        };
        hit++;
        break;
      }
      case 'bodyContact':
      case 'speechStyle': {
        const arr = asStringArray(raw.value);
        if (!arr) { errors.push(`${field} 应为字符串数组: ${raw.path}`); continue; }
        if (field === 'bodyContact') parts.bodyContact = arr; else parts.speechStyle = arr;
        hit++;
        break;
      }
      case 'emotion': {
        if (!obj) { errors.push(`emotion 应为对象: ${raw.path}`); continue; }
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' && v) map[k] = v;
        }
        parts.emotion = map;
        hit++;
        break;
      }
      case 'roll': {
        if (!obj) { errors.push(`roll 应为对象: ${raw.path}`); continue; }
        parts.roll = { dislikes: pick(obj, ['不喜欢', 'dislikes']), likes: pick(obj, ['喜欢', 'likes']) };
        hit++;
        break;
      }
      default:
        errors.push(`未知梦呓字段: ${raw.path}`);
    }
  }

  return { parts: hit > 0 ? parts : null, errors };
}
