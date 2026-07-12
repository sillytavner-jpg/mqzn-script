import type { CharacterProfile } from '../stores/mainStore';
import {
  buildCharacterTagName,
  buildWorldBookBindingId,
  buildWorldTagName,
  type WorldBookTagBinding,
} from './worldBookTags';
import { logError, logInfo } from '../utils/logger';

export interface NpcWorldbookWriteResult {
  bookName: string;
  indexTagName: string;
  profileTagName: string;
  content: string;
  bindings: WorldBookTagBinding[];
}

function getApi(): any {
  const g = globalThis as any;
  return g.TavernHelper || g;
}

export function hasNpcWorldbookApi(): boolean {
  const api = getApi();
  return typeof api.createWorldbookEntries === 'function'
    && (typeof api.getOrCreateChatWorldbook === 'function' || typeof api.createWorldbook === 'function');
}

function clean(text: string | undefined): string {
  return (text || '').trim() || '未明确';
}

function listLines(items: string[] | undefined, fallback = '未明确'): string {
  const values = (items || []).map(item => item.trim()).filter(Boolean);
  if (values.length === 0) return `- ${fallback}`;
  return values.map(item => `- ${item}`).join('\n');
}

export function formatNpcBiographyInterview(npcName: string, profile: CharacterProfile, tagId: number): { tagName: string; content: string } {
  const tagName = buildCharacterTagName(npcName, tagId, '小传采访');
  const cp = profile.corePersonality;
  const refs = profile.literaryReferences || [];
  const lines: string[] = [];

  lines.push(`<${tagName}>`);
  lines.push(`# ${npcName} 小传`);
  lines.push('');
  lines.push('## 基础定位');
  lines.push(`- 身份：${clean(profile.basicInfo.identity)}`);
  lines.push(`- 外貌：${clean(profile.basicInfo.appearance)}`);
  lines.push(`- 背景：${clean(profile.basicInfo.background)}`);
  lines.push(`- 与{{user}}关系：${clean(profile.basicInfo.relationToUser)}`);
  lines.push('');
  lines.push('## 调色盘');
  lines.push(`- 说明：${clean(profile.colorPalette.explanation)}`);
  lines.push(`- 底色：${clean(profile.colorPalette.base)}`);
  lines.push(`- 主色调：${clean(profile.colorPalette.primary)}`);
  if (profile.colorPalette.accents?.length) {
    lines.push(`- 点缀色：${profile.colorPalette.accents.join('、')}`);
  }
  lines.push('');
  lines.push('### 衍生画面');
  lines.push(listLines(profile.colorPalette.derivatives));
  lines.push('');
  lines.push('## 二次解释');
  if (profile.secondaryExplanation?.length) {
    for (const item of profile.secondaryExplanation) {
      lines.push(`- ${clean(item.topic)}：${clean(item.content)}`);
    }
  } else {
    lines.push('- 未明确');
  }

  if (cp) {
    lines.push('');
    lines.push('## 核心人格层');
    lines.push(`- 表层欲望：${clean(cp.surfaceDesire)}`);
    lines.push(`- 深层缺失：${clean(cp.deepLack)}`);
    lines.push(`- 核心恐惧：${clean(cp.coreFear)}`);
    lines.push(`- 防御机制：${clean(cp.defenseMechanism)}`);
    lines.push(`- 核心矛盾：${clean(cp.coreConflict)}`);
    lines.push(`- 道德底线：${clean(cp.moralBottomLine)}`);
    lines.push(`- 自我认知：${clean(cp.selfAwareness)}`);
  }

  if (profile.imagery) {
    lines.push('');
    lines.push('## 意象');
    lines.push(clean(profile.imagery));
  }

  if (refs.length > 0) {
    lines.push('');
    lines.push('## 参考底座');
    for (const ref of refs) {
      lines.push(`- ${clean(ref.character)}《${clean(ref.work)}》：${clean(ref.borrowedTraits)}`);
    }
  }

  lines.push('');
  lines.push(`# ${npcName} 采访`);
  lines.push('');
  lines.push(`Q：你是谁？`);
  lines.push(`A：${clean(profile.basicInfo.identity)}`);
  lines.push('');
  lines.push('Q：最近最改变你的事是什么？');
  lines.push(`A：${clean(profile.basicInfo.background)}`);
  lines.push('');
  lines.push('Q：你平时最容易被看见的样子是什么？');
  lines.push(`A：${clean(profile.colorPalette.primary)}。${profile.colorPalette.derivatives?.[0] || clean(profile.colorPalette.explanation)}`);
  lines.push('');
  lines.push('Q：你和{{user}}之间最具体的画面是什么？');
  lines.push(`A：${clean(profile.basicInfo.relationToUser)}`);
  if (cp) {
    lines.push('');
    lines.push('Q：你在压力下会怎样保护自己？');
    lines.push(`A：${clean(cp.defenseMechanism)}`);
  }
  lines.push(`</${tagName}>`);

  return { tagName, content: lines.join('\n') };
}

async function resolveTargetWorldbook(targetBookName?: string): Promise<string> {
  const api = getApi();
  const trimmed = (targetBookName || '').trim();
  if (trimmed) return trimmed;
  if (typeof api.getOrCreateChatWorldbook === 'function') {
    return await api.getOrCreateChatWorldbook('current', '智脑NPC补全');
  }
  if (typeof api.createWorldbook === 'function') {
    await api.createWorldbook('智脑NPC补全', []);
    return '智脑NPC补全';
  }
  throw new Error('当前环境没有可用的聊天世界书创建 API');
}

function baseStrategy(type: 'constant' | 'selective', keys: string[]): any {
  return {
    type,
    keys,
    keys_secondary: { logic: 'and_any', keys: [] },
    scan_depth: 'same_as_global',
  };
}

export async function writeNpcProfileToWorldbook(params: {
  npcName: string;
  profile: CharacterProfile;
  tagId: number;
  targetBookName?: string;
}): Promise<NpcWorldbookWriteResult> {
  const api = getApi();
  if (!hasNpcWorldbookApi()) {
    throw new Error('当前环境没有可用的世界书写入 API');
  }

  const bookName = await resolveTargetWorldbook(params.targetBookName);
  const { tagName: profileTagName, content } = formatNpcBiographyInterview(params.npcName, params.profile, params.tagId);
  const indexTagName = buildWorldTagName(params.tagId, `NPC索引_${params.npcName}`);
  const now = new Date().toISOString();
  const indexEntryName = `智脑NPC索引@${params.npcName}`;
  const profileEntryName = `智脑NPC设定@${params.npcName}`;
  const indexContent = [
    `<${indexTagName}>`,
    `${params.npcName} 已补全小传与采访。`,
    `详细人设条目：<${profileTagName}>。`,
    '扮演该 NPC 时先按这个索引召回，不要把她当作无设定路人处理。',
    `</${indexTagName}>`,
  ].join('\n');

  try {
    const result = await api.createWorldbookEntries(
      bookName,
      [
        {
          name: indexEntryName,
          content: indexContent,
          enabled: true,
          strategy: baseStrategy('constant', [params.npcName]),
          constant: true,
          selective: false,
          keys: [params.npcName],
          position: { type: 'before_character_definition', order: 80, role: 'system', depth: 0 },
          probability: 100,
          recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
          extra: { zhinoNpcProfile: { npcName: params.npcName, role: 'index', tagName: indexTagName, updatedAt: now } },
        },
        {
          name: profileEntryName,
          content,
          enabled: true,
          strategy: baseStrategy('selective', [params.npcName]),
          constant: false,
          selective: true,
          keys: [params.npcName],
          position: { type: 'after_character_definition', order: 100, role: 'system', depth: 0 },
          probability: 100,
          recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
          extra: { zhinoNpcProfile: { npcName: params.npcName, role: 'profile', tagName: profileTagName, updatedAt: now } },
        },
      ],
      { render: 'immediate' },
    );

    const created = result?.new_entries || [];
    const indexCreated = created[0] || {};
    const profileCreated = created[1] || {};
    const indexBinding = buildNpcBinding({
      bookName,
      uid: indexCreated.uid,
      entryName: indexCreated.name || indexEntryName,
      displayKey: indexCreated.name || indexEntryName,
      tagName: indexTagName,
      tagId: params.tagId,
      kind: 'world',
      meaning: `${params.npcName} 的 NPC 小传/采访索引，提示智脑该 NPC 已补全设定。`,
      updatedAt: now,
    });
    const profileBinding = buildNpcBinding({
      bookName,
      uid: profileCreated.uid,
      entryName: profileCreated.name || profileEntryName,
      displayKey: profileCreated.name || profileEntryName,
      tagName: profileTagName,
      tagId: params.tagId,
      kind: 'character',
      characterName: params.npcName,
      meaning: `${params.npcName} 的小传、采访、调色盘、二次解释与核心人格层。`,
      updatedAt: now,
    });

    logInfo('NPC世界书', `已写入 ${params.npcName} 到「${bookName}」`);
    return { bookName, indexTagName, profileTagName, content, bindings: [indexBinding, profileBinding] };
  } catch (error: any) {
    logError('NPC世界书', '写入失败', error);
    throw error;
  }
}

function buildNpcBinding(params: {
  bookName: string;
  uid?: number;
  entryName: string;
  displayKey: string;
  tagName: string;
  tagId: number;
  kind: 'world' | 'character';
  characterName?: string;
  meaning: string;
  updatedAt: string;
}): WorldBookTagBinding {
  const id = buildWorldBookBindingId({
    book: params.bookName,
    uid: params.uid,
    key: params.displayKey,
    entryName: params.entryName,
  });
  return {
    id,
    book: params.bookName,
    uid: params.uid,
    entryName: params.entryName,
    displayKey: params.displayKey,
    kind: params.kind,
    tagId: params.tagId,
    tagLabel: params.kind === 'world' ? 'NPC索引' : '小传采访',
    tagName: params.tagName,
    characterName: params.characterName,
    meaning: params.meaning,
    updatedAt: params.updatedAt,
    lastAppliedAt: params.updatedAt,
  };
}
