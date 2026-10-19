export interface CharacterNameEntry {
  name: string;
  aliases?: string[];
}

export interface CharacterNameIndex {
  entries: CharacterNameEntry[];
  byLookupKey: Map<string, string>;
}

/**
 * 角色名归一化（判重 / 匹配用的 key 口径）。**不用于显示**，只用于比较。
 *
 * 处理三件事：
 *   1. 去零宽字符（AI 输出常夹带不可见字符，会让「同一个名字」变成两个 key）
 *   2. 剥末尾括号注释：半角 () / 全角（）/ 半角 [] / 全角【】
 *      —— AI 常输出「清月（师尊）」「王芳(化名)」这类带注释的名字；
 *         原先只认半角圆括号，导致「王芳（化名）」与「王芳」判成两个角色（重复/认错人）
 *   3. 去首尾空白
 *
 * ⚠️ 空值保护：整个名字被一组括号包住时（如「【清月】」），末尾剥离会得到空串 ——
 *    此时保留原值。否则所有此类名字都会被归一化成空 key，互相判重（原实现有此隐患）。
 */
export function normalizeCharacterName(name?: string): string {
  const raw = String(name || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!raw) return '';
  const stripped = raw
    .replace(/\s*(?:\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】)\s*$/, '')
    .trim();
  return stripped || raw;
}

function lookupKeys(name?: string): string[] {
  const raw = String(name || '').trim();
  const normalized = normalizeCharacterName(raw);
  const lower = raw.toLowerCase();
  const normalizedLower = normalized.toLowerCase();
  return [...new Set([raw, normalized, lower, normalizedLower].filter(Boolean))];
}

export const MEANINGLESS_ALIASES = new Set(['无', '无', 'None', 'none', 'N/A', 'n/a', 'null', 'undefined', '0', '-']);

/**
 * 泛称 / 职位 / 亲属 / 指示词。
 *
 * 用途：这些「别名」不足以唯一指向某个角色——正文里任何一个同职位、同亲属关系的
 * 角色都可能用同一个词。所以它们**不能**作为「别名 → 正式名」的硬映射喂给 AI
 * （否则等于教 AI 把多个角色合并成一个人）。
 *
 * ⚠️ 它们仍保留在归一路径里（resolveKnownCharacterName）：当名册内**唯一命中**时，
 * 泛称依然能正确对上角色。这里只是不让它进 AI 的硬映射列。
 */
const GENERIC_ALIAS_WORDS = new Set([
  // 宫廷 / 官职 / 身份
  '内侍', '宦官', '太监', '宫人', '宫女', '侍卫', '侍女', '丫鬟', '仆人', '下人', '小厮',
  '将军', '大帅', '元帅', '统帅', '宰相', '相爷', '丞相', '中书令', '尚书', '侍郎', '御史',
  '大人', '老爷', '公子', '小姐', '姑娘', '夫人', '娘娘', '殿下', '陛下', '皇上', '圣人', '天子',
  '太医', '御医', '掌柜', '伙计', '小二', '师傅', '师父', '前辈', '长老', '师尊', '先生',
  '师兄', '师姐', '师弟', '师妹', '弟子', '徒弟', '道长', '真人', '方丈', '主持',
  '书生', '剑客', '侠客', '商贾', '船夫', '车夫', '马夫', '猎户', '农户',
  // 使节 / 首领 / 爵位（同职位可能有多人，不能唯一指向）
  '特使', '使者', '使节', '统领', '首领', '族长', '掌门', '帮主', '堡主', '城主',
  '公主', '皇子', '太子', '世子', '郡主', '郡王', '少爷', '太太', '姨太',
  '学弟', '学妹', '同学', '老师', '教授', '嬷嬷',
  // 亲属
  '父亲', '母亲', '爹', '娘', '爹爹', '娘亲', '哥哥', '姐姐', '弟弟', '妹妹', '兄长', '兄台',
  '儿子', '女儿', '叔叔', '婶婶', '伯父', '伯母', '舅舅', '舅母', '姑姑', '姑父',
  '祖父', '祖母', '外公', '外婆', '夫君', '娘子', '相公', '王爷', '王妃',
  // 泛指
  '老者', '老人', '老头', '老夫', '老将', '老将军', '老臣', '少女', '少年', '女子', '男子',
  '那人', '此人', '这人', '众人', '众将', '将士', '士兵', '兵卒', '士卒', '百姓',
  // 指示代词
  '他', '她', '我', '你', '您', '它', '他们', '她们', '我们', '你们',
]);

/**
 * 判断一个别名是否只是「泛称」。
 * 判据：完全等于泛称词，或「小/老/大 + 泛称词」（如老将军、小和尚）。
 */
export function isGenericAlias(alias?: string): boolean {
  const a = normalizeCharacterName(alias);
  if (!a) return false;
  // 超过 6 字基本是专属称呼（"白衣摄陇右防御使"这类），不当泛称
  if (a.length > 6) return false;
  if (GENERIC_ALIAS_WORDS.has(a)) return true;
  if (a.length >= 2 && a.length <= 5 && /^[小老大]$/.test(a[0]) && GENERIC_ALIAS_WORDS.has(a.slice(1))) {
    return true;
  }
  return false;
}

/** 把一个角色的别名拆成「专属称呼」与「泛称」两列（供提示词名册使用） */
export function splitCharacterAliases(aliases?: string[]): { specific: string[]; generic: string[] } {
  const specific: string[] = [];
  const generic: string[] = [];
  const seen = new Set<string>();
  for (const raw of aliases || []) {
    const alias = String(raw || '').trim();
    if (!alias || MEANINGLESS_ALIASES.has(alias)) continue;
    if (isUserMacroName(alias)) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (isGenericAlias(alias) ? generic : specific).push(alias);
  }
  return { specific, generic };
}

/** markdown 表格单元格转义，避免名字里的 `|` 撑破表格 */
function escapeCell(text: string): string {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 玩家宏（{{user}} / <user> / [user]）：不是角色名，不能当别名展示给模型 */
function isUserMacroName(alias: string): boolean {
  return /^[{[<]{1,2}\s*user\s*[}\]>]{1,2}$/i.test(String(alias || '').trim());
}

/**
 * 构建「角色名册」提示词段（大总结 / 角色记忆共用）。
 *
 * 设计动机（2026-10-19）：大总结原先**完全不注入角色名册**，模型只能从正文自由取名，
 * 群像场景下会把多个角色坍缩成一个人（三个角色合成一个），或把同一角色的多个称呼
 * 拆成多人。名册把「谁是正式名、哪些称呼属于他」变成硬锚点。
 *
 * 关键取舍：
 *   - 别名分「专属」「泛称」两列。泛称（内侍/老将/师尊）不足以唯一指向某人，
 *     只提示「需结合上下文判断」，不当作直接映射——否则等于教 AI 合并角色。
 *   - 玩家本人单独标注：让 AI 认识其别名，但铁律禁止写进在场名单。
 *
 * @param entries  角色名册（来自 store.getCharacterNameEntries）
 * @param userName 玩家名（会出现「（玩家本人）」标记）
 * @param options  maxCharacters 角色数上限（默认 60）/ maxAliases 每人每列别名上限（默认 8）
 * @returns 空名册返回空串（调用方直接拼接即可）
 */
export function buildCharacterRosterSection(
  entries: CharacterNameEntry[],
  userName: string,
  options: { maxCharacters?: number; maxAliases?: number } = {},
): string {
  const maxCharacters = options.maxCharacters ?? 60;
  const maxAliases = options.maxAliases ?? 8;
  const cleaned = (entries || [])
    .map(entry => ({
      name: String(entry.name || '').trim(),
      aliases: (entry.aliases || []).map(a => String(a || '').trim()).filter(Boolean),
    }))
    .filter(entry => entry.name);

  if (cleaned.length === 0) return '';

  const lines: string[] = [
    '## 角色名册（本聊天已确立的角色）',
    '',
    '| 正式名 | 专属称呼（可直接对上） | 泛称/职位（需结合上下文判断） |',
    '|---|---|---|',
  ];

  let shown = 0;
  for (const entry of cleaned) {
    if (shown >= maxCharacters) break;
    const { specific, generic } = splitCharacterAliases(entry.aliases);
    let spec = specific.slice(0, maxAliases).join('、') || '—';
    let gen = generic.slice(0, maxAliases).join('、') || '—';
    if (spec.length > 120) spec = spec.slice(0, 118) + '…';
    if (gen.length > 80) gen = gen.slice(0, 78) + '…';
    const nameCell = entry.name === userName ? `${entry.name}（玩家本人）` : entry.name;
    lines.push(`| ${escapeCell(nameCell)} | ${escapeCell(spec)} | ${escapeCell(gen)} |`);
    shown++;
  }
  if (cleaned.length > shown) {
    lines.push('');
    lines.push(`（另有 ${cleaned.length - shown} 个角色未列出，未列出的按新角色处理，不要硬套。）`);
  }

  lines.push('');
  lines.push('**辨识铁律**：');
  lines.push('1. 名册里每个正式名代表**一个独立的人**。不同角色永远不能合并成同一个名字，也不能把 A 的行为写成 B 的。');
  lines.push('2. 正文出现「专属称呼」→ 一律改写成对应正式名。');
  lines.push('3. 正文只出现「泛称/职位」→ 先看该事件上下文里是否只有一个名册角色符合；能确定就写正式名，不能确定就不写进在场名单，**禁止猜**。');
  lines.push('4. 名册里没有的名字 = 新角色，**原样保留**，禁止硬套到名册里的某个人。');
  lines.push('5. 名字相近的两个角色（如「林星汐 / 林昭羽」）必须分别写，禁止因为像就当成一个人。');
  lines.push('');

  return lines.join('\n');
}

export function cleanCharacterAliases(aliases: string[] | undefined, characterName: string): string[] {
  const canonical = normalizeCharacterName(characterName);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of aliases || []) {
    const alias = String(raw || '').trim();
    if (!alias) continue;
    if (MEANINGLESS_ALIASES.has(alias)) continue;
    if (alias === characterName || normalizeCharacterName(alias) === canonical) continue;
    const key = normalizeCharacterName(alias).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(alias);
  }
  return result;
}

/** 归一化 lookup key（与 registry 的 normKey 口径一致：去括号 + lowercase） */
export function characterReservedKey(name?: string): string {
  return normalizeCharacterName(name).trim().toLowerCase();
}

/**
 * 防「认错人合并」守卫：从候选别名里剔除「已被其它独立角色占用的主名」。
 *
 * 动机（2026-10-06 玩家反馈的死锁）：
 *   本系统以「名字字符串」为主键。AI 偶发把两个不同角色当成同一人的别名，
 *   写成 `{ name: "甲", aliases: ["乙"] }`。这个名字一旦被吸收成别名：
 *     · 角色列表只渲染主名 → 玩家看不到它（以为角色消失）
 *     · 新建查重连别名一起匹配 → 拒绝创建（提示「名称或别名已存在」）
 *   而 registry 是名字解析的最高优先级且只在改名/合并时更新，配合起来会彻底锁死。
 *   本函数在**写入前**拦掉「把已确立的独立角色主名当别名吸收」这一个动作。
 *   非独立角色主名的普通别名（如「师尊」「月儿」）原样保留，不影响正常别名功能。
 *
 * @param aliases       候选别名（原值，未归一化）
 * @param selfName      当前条目自身的主名（永不被剔除）
 * @param reservedNames 已确立的独立角色主名 key 集合（由 characterReservedKey 生成）
 * @returns kept=保留的别名；stripped=被拦下的「实为独立角色」的别名
 */
export function stripReservedAliases(
  aliases: string[] | undefined,
  selfName: string,
  reservedNames?: Set<string>,
): { kept: string[]; stripped: string[] } {
  const list = (aliases || []).map(a => String(a || '').trim()).filter(Boolean);
  if (!reservedNames || reservedNames.size === 0) return { kept: list, stripped: [] };
  const self = characterReservedKey(selfName);
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const alias of list) {
    const key = characterReservedKey(alias);
    if (key && key !== self && reservedNames.has(key)) {
      stripped.push(alias);
      continue;
    }
    kept.push(alias);
  }
  return { kept, stripped };
}

export function buildCharacterNameIndex(entries: CharacterNameEntry[]): CharacterNameIndex {
  const cleanedEntries = entries
    .map(entry => ({
      name: String(entry.name || '').trim(),
      aliases: cleanCharacterAliases(entry.aliases || [], entry.name),
    }))
    .filter(entry => entry.name);

  const byLookupKey = new Map<string, string>();
  for (const entry of cleanedEntries) {
    for (const value of [entry.name, ...(entry.aliases || [])]) {
      for (const key of lookupKeys(value)) {
        if (!byLookupKey.has(key)) byLookupKey.set(key, entry.name);
      }
    }
  }

  return { entries: cleanedEntries, byLookupKey };
}

export function resolveCharacterName(
  rawName: string | undefined,
  entries: CharacterNameEntry[],
  fallbackToNormalized = false,
): string {
  const raw = String(rawName || '').trim();
  if (!raw) return '';
  const index = buildCharacterNameIndex(entries);
  for (const key of lookupKeys(raw)) {
    const resolved = index.byLookupKey.get(key);
    if (resolved) return resolved;
  }
  return fallbackToNormalized ? normalizeCharacterName(raw) : raw;
}

export function scanCharacterNamesFromContent(
  content: string,
  knownCharacterNames: string[],
  characterEntries?: CharacterNameEntry[],
): string[] {
  const text = content || '';
  const entries = characterEntries && characterEntries.length > 0
    ? characterEntries
    : knownCharacterNames.map(name => ({ name, aliases: [] }));
  const index = buildCharacterNameIndex(entries);
  const matched = new Set<string>();

  for (const entry of index.entries) {
    const terms = [entry.name, normalizeCharacterName(entry.name), ...(entry.aliases || [])]
      .map(term => String(term || '').trim())
      .filter(term => term.length >= 2);
    if (terms.some(term => text.includes(term))) {
      matched.add(entry.name);
    }
  }

  return [...matched];
}

/**
 * 构建提示词中的「黑名单角色」提醒段（按分析类型定制话术）。
 * 黑名单角色已从智脑中移除，AI 在正文里可能仍看到其名字——按本次分析职责提醒其不要输出相关内容。
 * 无黑名单时返回空串（调用方直接拼接即可）。
 * @param blacklistedNames 黑名单角色名列表
 * @param hint 定制话术（不带角色名，如「本次不要生成以下角色的记忆」）
 */
export function buildBlacklistReminder(blacklistedNames: string[] | undefined, hint: string): string {
  const names = (blacklistedNames || []).filter(Boolean);
  if (names.length === 0) return '';
  return [
    '## 黑名单角色（已从智脑中移除）',
    `${hint}：${names.join('、')}`,
    '',
    '---',
    '',
  ].join('\n');
}
